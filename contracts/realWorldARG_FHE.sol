pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract RealWorldARG_FHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Batch {
        bool exists;
        bool closed;
    }
    uint256 public currentBatchId;
    mapping(uint256 => Batch) public batches;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address account);
    event Unpaused(address account);
    event CooldownSecondsUpdated(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event TaskSubmitted(address indexed provider, uint256 indexed batchId, uint256 encryptedTaskId, bytes32 encryptedClue);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 taskId, uint256 clueValue, bool taskCompleted);

    error NotOwner();
    error NotProvider();
    error PausedError();
    error CooldownActive();
    error BatchClosedOrDoesNotExist();
    error InvalidBatch();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedError();
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        emit ProviderAdded(owner);
        currentBatchId = 1;
        _openBatch(currentBatchId);
        cooldownSeconds = 60; // Default cooldown
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        uint256 oldCooldownSeconds = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsUpdated(oldCooldownSeconds, newCooldownSeconds);
    }

    function openNewBatch() external onlyOwner {
        currentBatchId++;
        _openBatch(currentBatchId);
    }

    function _openBatch(uint256 batchId) internal {
        if (batches[batchId].exists) revert InvalidBatch();
        batches[batchId] = Batch({ exists: true, closed: false });
        emit BatchOpened(batchId);
    }

    function closeBatch(uint256 batchId) external onlyOwner {
        if (!batches[batchId].exists || batches[batchId].closed) revert BatchClosedOrDoesNotExist();
        batches[batchId].closed = true;
        emit BatchClosed(batchId);
    }

    function submitTask(
        uint256 batchId,
        euint32 encryptedTaskId,
        euint32 encryptedClue,
        euint32 encryptedCompletionThreshold
    ) external onlyProvider whenNotPaused {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (!batches[batchId].exists || batches[batchId].closed) {
            revert BatchClosedOrDoesNotExist();
        }
        _requireInitialized(address(encryptedTaskId));
        _requireInitialized(address(encryptedClue));
        _requireInitialized(address(encryptedCompletionThreshold));

        // Store encrypted task data (example: taskId -> clue, completionThreshold)
        // In a real implementation, this would be a more complex mapping
        // For this example, we'll just emit the submission
        emit TaskSubmitted(msg.sender, batchId, uint256(encryptedTaskId), encryptedClue.toBytes32());

        lastSubmissionTime[msg.sender] = block.timestamp;
    }

    function requestTaskCompletionVerification(
        uint256 batchId,
        euint32 encryptedTaskId,
        euint32 encryptedPlayerProgress
    ) external whenNotPaused {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (!batches[batchId].exists || batches[batchId].closed) {
            revert BatchClosedOrDoesNotExist();
        }
        _requireInitialized(address(encryptedTaskId));
        _requireInitialized(address(encryptedPlayerProgress));

        // Retrieve encrypted clue and threshold for the task (example values)
        // In a real system, these would be fetched from storage based on encryptedTaskId
        euint32 encryptedClue = FHE.asEuint32(100); // Placeholder
        euint32 encryptedCompletionThreshold = FHE.asEuint32(5); // Placeholder
        _initIfNeeded(address(encryptedClue));
        _initIfNeeded(address(encryptedCompletionThreshold));

        // Perform encrypted comparison: playerProgress >= completionThreshold
        ebool encryptedIsCompleted = encryptedPlayerProgress.ge(encryptedCompletionThreshold);

        // Prepare ciphertexts for decryption
        // Order: taskId, clue, isCompleted
        euint32[] memory ciphertextsToDecrypt = new euint32[](3);
        ciphertextsToDecrypt[0] = encryptedTaskId;
        ciphertextsToDecrypt[1] = encryptedClue;
        ciphertextsToDecrypt[2] = encryptedIsCompleted.toEuint32(); // Convert ebool to euint32 for consistent decryption

        bytes32 stateHash = _hashCiphertexts(ciphertextsToDecrypt);
        uint256 requestId = FHE.requestDecryption(ciphertextsToDecrypt, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: batchId,
            stateHash: stateHash,
            processed: false
        });
        emit DecryptionRequested(requestId, batchId);

        lastDecryptionRequestTime[msg.sender] = block.timestamp;
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        DecryptionContext storage ctx = decryptionContexts[requestId];

        // Replay guard
        if (ctx.processed) revert ReplayAttempt();

        // State verification
        // Rebuild ciphertexts in the exact same order as during requestTaskCompletionVerification
        // This is a simplified example; a real implementation would fetch the original
        // encryptedTaskId, encryptedClue, and recompute encryptedIsCompleted
        // For this example, we'll assume these are available or can be reconstructed.
        // If they cannot be perfectly reconstructed, state verification becomes harder.
        // The contract must store or be able to deterministically recompute the ciphertexts
        // that were part of the state hash.
        // For this example, we'll use dummy ciphertexts to illustrate the flow.
        // A real implementation MUST ensure the `cts` array here matches the one used for `stateHash` creation.
        euint32[] memory cts = new euint32[](3);
        cts[0] = FHE.asEuint32(0); // Placeholder for original encryptedTaskId
        cts[1] = FHE.asEuint32(0); // Placeholder for original encryptedClue
        cts[2] = FHE.asEuint32(0); // Placeholder for original encryptedIsCompleted.toEuint32()
        // _initIfNeeded would be called for these if they were real ciphertexts

        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != ctx.stateHash) {
            revert StateMismatch();
        }

        // Proof verification
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert InvalidProof();
        }

        // Decode cleartexts
        // Order: taskId, clue, isCompleted
        uint256 taskId = abi.decode(cleartexts.slice(0, 32), (uint256));
        uint256 clueValue = abi.decode(cleartexts.slice(32, 32), (uint256));
        uint256 isCompletedRaw = abi.decode(cleartexts.slice(64, 32), (uint256));
        bool taskCompleted = isCompletedRaw != 0;

        ctx.processed = true;
        emit DecryptionCompleted(requestId, ctx.batchId, taskId, clueValue, taskCompleted);

        // Further logic based on taskCompleted can be added here
    }

    function _hashCiphertexts(euint32[] memory cts) internal pure returns (bytes32) {
        bytes32[] memory ctsBytes = new bytes32[](cts.length);
        for (uint i = 0; i < cts.length; i++) {
            ctsBytes[i] = cts[i].toBytes32();
        }
        return keccak256(abi.encode(ctsBytes, address(this)));
    }

    function _initIfNeeded(address cipher) internal {
        if (!FHE.isInitialized(cipher)) {
            FHE.asEuint32(0); // Initialize if not already, using a default value
        }
    }

    function _requireInitialized(address cipher) internal view {
        if (!FHE.isInitialized(cipher)) {
            revert NotInitialized();
        }
    }
}