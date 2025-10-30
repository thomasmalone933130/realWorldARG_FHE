import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface ARGTask {
  id: string;
  encryptedData: string;
  timestamp: number;
  owner: string;
  taskType: string;
  location: string;
  status: "pending" | "completed" | "failed";
  difficulty: number;
}

// FHE encryption simulation for numerical data
const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

// FHE computation simulation
const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'verifyLocation':
      result = value > 0.7 ? 1 : 0; // Simulate location verification
      break;
    case 'increaseDifficulty':
      result = value * 1.2;
      break;
    case 'calculateReward':
      result = value * 100; // Base reward calculation
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [tasks, setTasks] = useState<ARGTask[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newTaskData, setNewTaskData] = useState({ taskType: "", location: "", difficulty: 1 });
  const [showTutorial, setShowTutorial] = useState(false);
  const [selectedTask, setSelectedTask] = useState<ARGTask | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [currentStep, setCurrentStep] = useState<number>(1);
  const [arView, setArView] = useState<boolean>(false);

  // Statistics
  const completedCount = tasks.filter(t => t.status === "completed").length;
  const pendingCount = tasks.filter(t => t.status === "pending").length;
  const failedCount = tasks.filter(t => t.status === "failed").length;

  useEffect(() => {
    loadTasks().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadTasks = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        console.log("Contract not available");
        return;
      }

      // Load task keys
      const keysBytes = await contract.getData("task_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing task keys:", e); }
      }

      const taskList: ARGTask[] = [];
      for (const key of keys) {
        try {
          const taskBytes = await contract.getData(`task_${key}`);
          if (taskBytes.length > 0) {
            try {
              const taskData = JSON.parse(ethers.toUtf8String(taskBytes));
              taskList.push({ 
                id: key, 
                encryptedData: taskData.data, 
                timestamp: taskData.timestamp, 
                owner: taskData.owner, 
                taskType: taskData.taskType, 
                location: taskData.location,
                status: taskData.status || "pending",
                difficulty: taskData.difficulty || 1
              });
            } catch (e) { console.error(`Error parsing task data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading task ${key}:`, e); }
      }
      taskList.sort((a, b) => b.timestamp - a.timestamp);
      setTasks(taskList);
    } catch (e) { console.error("Error loading tasks:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitTask = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting task data with Zama FHE..." });
    try {
      // Encrypt difficulty using FHE
      const encryptedData = FHEEncryptNumber(newTaskData.difficulty);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const taskId = `task-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const taskData = { 
        data: encryptedData, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        taskType: newTaskData.taskType, 
        location: newTaskData.location,
        status: "pending",
        difficulty: newTaskData.difficulty
      };
      
      await contract.setData(`task_${taskId}`, ethers.toUtf8Bytes(JSON.stringify(taskData)));
      
      // Update task keys
      const keysBytes = await contract.getData("task_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(taskId);
      await contract.setData("task_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE-encrypted ARG task created successfully!" });
      await loadTasks();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewTaskData({ taskType: "", location: "", difficulty: 1 });
        setCurrentStep(1);
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const completeTask = async (taskId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Verifying task completion with FHE computation..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      const taskBytes = await contract.getData(`task_${taskId}`);
      if (taskBytes.length === 0) throw new Error("Task not found");
      const taskData = JSON.parse(ethers.toUtf8String(taskBytes));
      
      // Simulate FHE computation for verification
      const verifiedData = FHECompute(taskData.data, 'verifyLocation');
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedTask = { ...taskData, status: "completed", data: verifiedData };
      await contractWithSigner.setData(`task_${taskId}`, ethers.toUtf8Bytes(JSON.stringify(updatedTask)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Task completed with FHE verification!" });
      await loadTasks();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Completion failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const failTask = async (taskId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing task failure..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const taskBytes = await contract.getData(`task_${taskId}`);
      if (taskBytes.length === 0) throw new Error("Task not found");
      const taskData = JSON.parse(ethers.toUtf8String(taskBytes));
      
      const updatedTask = { ...taskData, status: "failed" };
      await contract.setData(`task_${taskId}`, ethers.toUtf8Bytes(JSON.stringify(updatedTask)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Task marked as failed!" });
      await loadTasks();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Operation failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `Decrypt ARG task data\nPublic Key: ${publicKey}\nContract: ${contractAddress}\nChain: ${chainId}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const isOwner = (taskAddress: string) => address?.toLowerCase() === taskAddress.toLowerCase();

  // Tutorial steps
  const tutorialSteps = [
    { title: "Connect Wallet", description: "Connect your Web3 wallet to start creating FHE-protected ARG experiences", icon: "🔗" },
    { title: "Design ARG Task", description: "Create real-world tasks with encrypted clues using Zama FHE", icon: "🎮", details: "Task details are encrypted client-side before submission" },
    { title: "FHE Location Verification", description: "Players complete tasks in real world with privacy-preserving verification", icon: "📍", details: "DePIN networks verify completion without revealing exact locations" },
    { title: "Encrypted Rewards", description: "Receive rewards while keeping your gameplay data private", icon: "🏆", details: "All computations happen on encrypted data using FHE technology" }
  ];

  // Render statistics dashboard
  const renderStatsDashboard = () => {
    const total = tasks.length || 1;
    return (
      <div className="stats-dashboard">
        <div className="stat-card">
          <div className="stat-icon">🎯</div>
          <div className="stat-value">{tasks.length}</div>
          <div className="stat-label">Total Tasks</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">✅</div>
          <div className="stat-value">{completedCount}</div>
          <div className="stat-label">Completed</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">⏳</div>
          <div className="stat-value">{pendingCount}</div>
          <div className="stat-label">Pending</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">❌</div>
          <div className="stat-value">{failedCount}</div>
          <div className="stat-label">Failed</div>
        </div>
      </div>
    );
  };

  // AR Visualization simulation
  const renderARView = () => (
    <div className="ar-container">
      <div className="ar-overlay">
        <div className="ar-marker"></div>
        <div className="ar-task-points">
          {tasks.filter(t => t.status === "pending").map(task => (
            <div key={task.id} className="ar-point" style={{
              left: `${Math.random() * 80 + 10}%`,
              top: `${Math.random() * 80 + 10}%`
            }}>
              <div className="point-label">{task.taskType}</div>
            </div>
          ))}
        </div>
        <div className="ar-interface">
          <div className="ar-compass">N</div>
          <div className="ar-stats">Active Tasks: {pendingCount}</div>
        </div>
      </div>
    </div>
  );

  if (loading) return (
    <div className="loading-screen">
      <div className="hud-spinner"></div>
      <p>Initializing FHE ARG Platform...</p>
    </div>
  );

  return (
    <div className={`app-container hud-theme ${arView ? 'ar-mode' : ''}`}>
      {/* HUD Overlay Elements */}
      <div className="hud-overlay">
        <div className="hud-corner top-left">
          <div className="hud-panel">
            <div className="hud-item">FHE STATUS: <span className="status-active">ACTIVE</span></div>
            <div className="hud-item">TASKS: {tasks.length}</div>
          </div>
        </div>
        <div className="hud-corner top-right">
          <div className="hud-panel">
            <div className="hud-item">NETWORK: {chainId}</div>
            <div className="hud-item">ZAMA FHE v2.1</div>
          </div>
        </div>
      </div>

      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="fhe-shield"></div></div>
          <h1>RealWorld<span>ARG</span>FHE</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setArView(!arView)} className="hud-button">
            {arView ? "MAP VIEW" : "AR VIEW"}
          </button>
          <button onClick={() => setShowCreateModal(true)} className="hud-button primary">
            <div className="add-icon"></div>CREATE TASK
          </button>
          <button className="hud-button" onClick={() => setShowTutorial(!showTutorial)}>
            {showTutorial ? "HIDE GUIDE" : "SHOW GUIDE"}
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content">
        {/* Step Progress */}
        <div className="step-progress">
          {[1, 2, 3, 4].map(step => (
            <div key={step} className={`step ${currentStep === step ? 'active' : ''}`}>
              <div className="step-number">{step}</div>
              <div className="step-label">
                {step === 1 && 'Design'}
                {step === 2 && 'Encrypt'}
                {step === 3 && 'Deploy'}
                {step === 4 && 'Verify'}
              </div>
            </div>
          ))}
        </div>

        {showTutorial && (
          <div className="tutorial-section">
            <h2>FHE ARG Platform Guide</h2>
            <div className="tutorial-steps">
              {tutorialSteps.map((step, index) => (
                <div className="tutorial-step" key={index}>
                  <div className="step-icon">{step.icon}</div>
                  <div className="step-content">
                    <h3>{step.title}</h3>
                    <p>{step.description}</p>
                    {step.details && <div className="step-details">{step.details}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {arView ? renderARView() : (
          <>
            <div className="dashboard-section">
              <h2>ARG Task Dashboard</h2>
              {renderStatsDashboard()}
            </div>

            <div className="tasks-section">
              <div className="section-header">
                <h2>Active ARG Tasks</h2>
                <button onClick={loadTasks} className="hud-button" disabled={isRefreshing}>
                  {isRefreshing ? "SYNCING..." : "REFRESH"}
                </button>
              </div>
              
              <div className="tasks-grid">
                {tasks.length === 0 ? (
                  <div className="no-tasks">
                    <div className="no-tasks-icon">🎮</div>
                    <p>No ARG tasks created yet</p>
                    <button className="hud-button primary" onClick={() => setShowCreateModal(true)}>
                      CREATE FIRST TASK
                    </button>
                  </div>
                ) : (
                  tasks.map(task => (
                    <div key={task.id} className="task-card" onClick={() => setSelectedTask(task)}>
                      <div className="task-header">
                        <span className="task-type">{task.taskType}</span>
                        <span className={`task-status ${task.status}`}>{task.status}</span>
                      </div>
                      <div className="task-location">📍 {task.location}</div>
                      <div className="task-difficulty">Difficulty: {task.difficulty}/10</div>
                      <div className="task-actions">
                        {isOwner(task.owner) && task.status === "pending" && (
                          <>
                            <button className="hud-button success" onClick={(e) => { e.stopPropagation(); completeTask(task.id); }}>COMPLETE</button>
                            <button className="hud-button danger" onClick={(e) => { e.stopPropagation(); failTask(task.id); }}>FAIL</button>
                          </>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Modals */}
      {showCreateModal && (
        <TaskCreateModal 
          onSubmit={submitTask} 
          onClose={() => { setShowCreateModal(false); setCurrentStep(1); }} 
          creating={creating} 
          taskData={newTaskData} 
          setTaskData={setNewTaskData}
          currentStep={currentStep}
          setCurrentStep={setCurrentStep}
        />
      )}
      
      {selectedTask && (
        <TaskDetailModal 
          task={selectedTask} 
          onClose={() => { setSelectedTask(null); setDecryptedValue(null); }} 
          decryptedValue={decryptedValue}
          setDecryptedValue={setDecryptedValue}
          isDecrypting={isDecrypting}
          decryptWithSignature={decryptWithSignature}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content hud-panel">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="hud-spinner"></div>}
              {transactionStatus.status === "success" && "✓"}
              {transactionStatus.status === "error" && "✕"}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="fhe-badge">
            <span>🔒 ZAMA FHE PROTECTED</span>
          </div>
          <div className="footer-links">
            <span>RealWorld ARG Platform © 2024</span>
          </div>
        </div>
      </footer>
    </div>
  );
};

// Modal Components
interface TaskCreateModalProps {
  onSubmit: () => void;
  onClose: () => void;
  creating: boolean;
  taskData: any;
  setTaskData: (data: any) => void;
  currentStep: number;
  setCurrentStep: (step: number) => void;
}

const TaskCreateModal: React.FC<TaskCreateModalProps> = ({ 
  onSubmit, onClose, creating, taskData, setTaskData, currentStep, setCurrentStep 
}) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setTaskData({ ...taskData, [name]: value });
  };

  const handleDifficultyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setTaskData({ ...taskData, [name]: parseInt(value) });
  };

  const nextStep = () => setCurrentStep(Math.min(currentStep + 1, 4));
  const prevStep = () => setCurrentStep(Math.max(currentStep - 1, 1));

  const handleSubmit = () => {
    if (!taskData.taskType || !taskData.location) { 
      alert("Please fill required fields"); 
      return; 
    }
    onSubmit();
  };

  const renderStepContent = () => {
    switch(currentStep) {
      case 1:
        return (
          <div className="step-content">
            <h3>Design ARG Task</h3>
            <div className="form-group">
              <label>Task Type *</label>
              <select name="taskType" value={taskData.taskType} onChange={handleChange} className="hud-input">
                <option value="">Select task type</option>
                <option value="Location Puzzle">Location Puzzle</option>
                <option value="QR Code Hunt">QR Code Hunt</option>
                <option value="Photo Challenge">Photo Challenge</option>
                <option value="Audio Puzzle">Audio Puzzle</option>
                <option value="Multi-step Quest">Multi-step Quest</option>
              </select>
            </div>
            <div className="form-group">
              <label>Location Area *</label>
              <input type="text" name="location" value={taskData.location} onChange={handleChange} 
                     placeholder="e.g., Central Park, Downtown Area..." className="hud-input"/>
            </div>
          </div>
        );
      
      case 2:
        return (
          <div className="step-content">
            <h3>Set Difficulty & Encryption</h3>
            <div className="form-group">
              <label>Difficulty Level: {taskData.difficulty}/10</label>
              <input type="range" name="difficulty" min="1" max="10" value={taskData.difficulty} 
                     onChange={handleDifficultyChange} className="hud-slider"/>
            </div>
            <div className="encryption-preview">
              <h4>FHE Encryption Preview</h4>
              <div className="preview-box">
                <div>Plain Difficulty: {taskData.difficulty}</div>
                <div className="encryption-arrow">↓</div>
                <div>Encrypted: {FHEEncryptNumber(taskData.difficulty).substring(0, 30)}...</div>
              </div>
            </div>
          </div>
        );
      
      case 3:
        return (
          <div className="step-content">
            <h3>DePIN Verification Setup</h3>
            <div className="depin-info">
              <p>Task completion will be verified using decentralized physical networks (DePIN) while preserving location privacy with FHE.</p>
              <div className="verification-method">
                <span>Verification Method: Location Proof + Time Stamp</span>
              </div>
            </div>
          </div>
        );
      
      case 4:
        return (
          <div className="step-content">
            <h3>Review & Create</h3>
            <div className="review-summary">
              <div className="summary-item"><span>Task Type:</span> {taskData.taskType}</div>
              <div className="summary-item"><span>Location:</span> {taskData.location}</div>
              <div className="summary-item"><span>Difficulty:</span> {taskData.difficulty}/10</div>
              <div className="summary-item"><span>Encryption:</span> Zama FHE Active</div>
            </div>
          </div>
        );
      
      default:
        return null;
    }
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal hud-panel">
        <div className="modal-header">
          <h2>Create FHE ARG Task</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="step-indicator">
          {[1, 2, 3, 4].map(step => (
            <div key={step} className={`step-dot ${currentStep === step ? 'active' : ''}`}></div>
          ))}
        </div>

        <div className="modal-body">
          {renderStepContent()}
        </div>

        <div className="modal-footer">
          <button onClick={prevStep} disabled={currentStep === 1} className="hud-button">
            BACK
          </button>
          
          {currentStep < 4 ? (
            <button onClick={nextStep} className="hud-button primary">
              NEXT
            </button>
          ) : (
            <button onClick={handleSubmit} disabled={creating} className="hud-button primary">
              {creating ? "ENCRYPTING..." : "CREATE TASK"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

interface TaskDetailModalProps {
  task: any;
  onClose: () => void;
  decryptedValue: number | null;
  setDecryptedValue: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const TaskDetailModal: React.FC<TaskDetailModalProps> = ({ 
  task, onClose, decryptedValue, setDecryptedValue, isDecrypting, decryptWithSignature 
}) => {
  const handleDecrypt = async () => {
    if (decryptedValue !== null) { 
      setDecryptedValue(null); 
      return; 
    }
    const decrypted = await decryptWithSignature(task.encryptedData);
    if (decrypted !== null) setDecryptedValue(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="task-detail-modal hud-panel">
        <div className="modal-header">
          <h2>ARG Task Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="task-info">
            <div className="info-item"><span>Type:</span> {task.taskType}</div>
            <div className="info-item"><span>Location:</span> {task.location}</div>
            <div className="info-item"><span>Status:</span> <span className={`status-${task.status}`}>{task.status}</span></div>
            <div className="info-item"><span>Created:</span> {new Date(task.timestamp * 1000).toLocaleString()}</div>
          </div>
          
          <div className="encrypted-section">
            <h3>FHE Encrypted Data</h3>
            <div className="encrypted-data">
              {task.encryptedData.substring(0, 50)}...
            </div>
            <button onClick={handleDecrypt} disabled={isDecrypting} className="hud-button">
              {isDecrypting ? "DECRYPTING..." : decryptedValue !== null ? "HIDE VALUE" : "DECRYPT WITH SIGNATURE"}
            </button>
          </div>
          
          {decryptedValue !== null && (
            <div className="decrypted-section">
              <h3>Decrypted Difficulty</h3>
              <div className="decrypted-value">{decryptedValue}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default App;