// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {ILockableCapability} from "paladin-domains/interfaces/ILockableCapability.sol";

// Fork of upstream Atom.sol (solidity/contracts/shared/Atom.sol), for lead task #2/#3/#8.
//
// Lead task #3 revision: back on the upstream pattern (Initializable + ReentrancyGuardUpgradeable
// + Address.functionCall, deployed via Clones by the factory), per the lead's decision after the
// hand-rolled zero-dependency version from task #2 produced one of this fork's own findings
// (execute()/simulate() silently treating a codeless-target call as success -- the exact case
// Address.functionCall already guards against upstream, confirmed by reading
// node_modules/@openzeppelin/contracts/utils/Address.sol:106-121 after installing it: it reverts
// `AddressEmptyCode` when `returndata.length == 0 && target.code.length == 0`).
//
// Address.functionCall does NOT decode a bool return value (same file, same function -- it only
// checks `success` and the codeless-target case). So `OperationReturnedFalse` below -- the
// "false-return instead of revert" half of the original finding -- is still needed on top of it;
// removing it would silently reintroduce that half of the bug.
//
// Upstream Atom.cancel() and Atom.execute() have no access control at all. This fork records
// `parties` (the banks whose legs are in the atom) and `executor` (BI) at construction, and
// restricts cancel()/execute() accordingly.
//
// Lead task #8, post-audit fixes (solidity-auditor, 12-agent pass, 2026-10-05):
// 1. The success check on a leg's call return (`ret.length == 32 && !abi.decode(ret, (bool))`,
//    used by execute()/simulate()/cancel()) used `abi.decode(ret, (bool))`, which REVERTS on any
//    32-byte word that is not exactly 0 or 1. In cancel()'s per-leg loop this is NOT wrapped in
//    try/catch (unlike the getLock() precheck two lines above it) -- a single leg whose call
//    returns such a word reverts the WHOLE cancel() transaction, undoing the `status =
//    Cancelled` write and blocking every OTHER leg's release too, exactly reintroducing the
//    deadlock this file exists to fix (multiple audit agents, converging independently: agents
//    6, 7 as FINDING, agents 1, 9, 10, 12 as LEAD/noting Noto's real lock functions are
//    void-return today so this is latent, not yet live). Fixed by replacing the strict
//    `abi.decode` bool check with a raw reinterpretation of the 32-byte word
//    (`uint256(bytes32(ret)) != 0`) that can never revert, in all three functions.
// 2. cancel() set `status = Cancelled` (terminal -- execute()/cancel() both require Pending)
//    BEFORE attempting any release, with no retry path if a specific leg's release call
//    legitimately failed (e.g. a stale cancelCommitment) rather than being skipped as
//    not-delegated/inactive. That leg's funds were then stuck forever with zero recourse --
//    not even BI -- since no function could ever call Noto for that lock again (confirmed:
//    agents 5 and 8 independently proved this with a full on-chain trace, no off-chain
//    assumption needed). Fixed by extracting the per-leg release into `_attemptRelease` and
//    adding `retryRelease(index)`, callable by executor/party while `status == Cancelled`, so a
//    leg whose first release attempt failed for a transient or now-resolved reason (e.g. the
//    original call was retried on-chain and now succeeds) can be released without redeploying
//    the whole atom.
//
// Lead task #8 addition: a real deadlock, found while designing the Agreement contract's
// recovery path, not inherited from anywhere -- confirmed from source, not assumed. Once a leg's
// Noto lock is delegated to this atom (spender == address(this)), Noto.sol's cancelLock is
// `onlySpender`-gated (Noto.sol:633-644) -- ONLY this atom can ever cancel it, the notary/BI has
// no override. Upstream/task-#2/#3 cancel() only flipped `status`, never touched the delegated
// lock -- so cancelling a partially-delegated atom left the delegated leg's funds stuck forever
// (confirmed: `bond/src/lib/outright.ts`'s own existing rollback() mechanism explicitly refuses
// once a leg is delegated to the TRADE atom -- "rollback is refused" is its own comment -- so
// this was never previously solved, just previously avoided). Fixed: cancel() now also attempts
// to release every leg in `_cancelOperations` via that leg's own `cancelLock`, ISOLATED per leg
// (lead requirement -- one bad/mismatched cancelCall must not hold the others hostage):
//   - skip silently (no event) if this atom never became that lock's spender (nothing to do,
//     the owner already has full control)
//   - skip silently if the lock is no longer active (already spent/cancelled elsewhere)
//   - otherwise attempt the release via a non-reverting low-level call, emitting
//     LegReleased or LegReleaseFailed per leg -- a revert in one leg's cancelLock (e.g. a
//     malicious/wrong cancelCall) never reverts the loop or blocks any other leg's release.
contract RestrictedAtom is Initializable, ReentrancyGuardUpgradeable {
    using Address for address;

    enum Status {
        Pending,
        Executed,
        Cancelled
    }

    struct Operation {
        address contractAddress;
        bytes callData;
    }

    // lockId is carried explicitly (not decoded from callData) so cancel()'s per-leg
    // delegation check (getLock(lockId)) never needs to parse calldata.
    struct CancelOperation {
        address contractAddress;
        bytes32 lockId;
        bytes callData;
    }

    struct OperationResult {
        bool success;
        bytes returnData;
    }

    Status public status;
    address public executor;

    address[] private _parties;
    Operation[] private _operations;
    CancelOperation[] private _cancelOperations;

    event AtomStatusChanged(Status status);
    // Task #8: per-leg cancel-time release outcome, isolated so one leg's failure is visible
    // without being confused with -- or blocking -- any other leg's outcome.
    event LegReleased(uint256 index, address contractAddress, bytes32 lockId);
    event LegReleaseFailed(uint256 index, address contractAddress, bytes32 lockId, bytes reason);

    error AtomNotPending();
    error NotAParty(address caller);
    error NotExecutor(address caller);
    error OperationReturnedFalse(uint256 index);
    error ExecutionResult(OperationResult[] result);

    constructor() {
        _disableInitializers();
    }

    function initialize(
        Operation[] memory operations,
        CancelOperation[] memory cancelOperations,
        address[] memory parties,
        address executor_
    ) external initializer {
        __ReentrancyGuard_init();
        status = Status.Pending;
        for (uint256 i = 0; i < operations.length; i++) {
            _operations.push(operations[i]);
        }
        for (uint256 i = 0; i < cancelOperations.length; i++) {
            _cancelOperations.push(cancelOperations[i]);
        }
        _parties = parties;
        executor = executor_;
        emit AtomStatusChanged(status);
    }

    function _isParty(address addr) internal view returns (bool) {
        for (uint256 i = 0; i < _parties.length; i++) {
            if (_parties[i] == addr) {
                return true;
            }
        }
        return false;
    }

    /// @notice Only `executor` (BI) may execute -- unchanged from task #2. Preserves upstream's
    /// atomicity: status flips to Executed before any external call, so a reentrant call back
    /// into execute() would already see status != Pending even without `nonReentrant`.
    function execute() external nonReentrant {
        if (status != Status.Pending) {
            revert AtomNotPending();
        }
        if (msg.sender != executor) {
            revert NotExecutor(msg.sender);
        }
        status = Status.Executed;

        for (uint256 i = 0; i < _operations.length; i++) {
            Operation storage op = _operations[i];
            bytes memory ret = op.contractAddress.functionCall(op.callData);
            // Audit fix: raw word check, not abi.decode(ret,(bool)) -- the latter reverts on
            // any 32-byte word that isn't exactly 0 or 1, which would brick this function on a
            // perfectly successful call whose return value just isn't a canonical bool.
            if (ret.length == 32 && uint256(bytes32(ret)) == 0) {
                revert OperationReturnedFalse(i);
            }
        }

        emit AtomStatusChanged(status);
    }

    /// @notice Simulates every operation without committing state, same shape as upstream.
    ///
    /// Task #3 correction (lead): the task-#2 party/executor gate on this function does NOT
    /// protect confidentiality and that claim is withdrawn. `eth_call`'s `from` field is
    /// unauthenticated -- any caller can set it to any address, including a party's or the
    /// executor's, and bypass the check trivially. More fundamentally, `getOperations()` already
    /// exposes every operation's target+callData with no gate at all, so a caller can reconstruct
    /// everything this function would reveal with its own, entirely separate `eth_call`
    /// (`{from: <this atom's address>, to: op.contractAddress, data: op.callData}`) straight at
    /// the target, which never touches this contract or its gate (confirmed by audit delta pass
    /// 2026-10-05). The gate below is kept as a UX guard only -- it stops an honest caller's own
    /// tooling from invoking the wrong atom by mistake, or from getting a confusing error on a
    /// trade it was never party to -- not as an access-control or confidentiality boundary; none
    /// exists for this function, by design.
    function simulate() external nonReentrant returns (OperationResult[] memory results) {
        if (status != Status.Pending) {
            revert AtomNotPending();
        }
        if (msg.sender != executor && !_isParty(msg.sender)) {
            revert NotAParty(msg.sender);
        }

        results = new OperationResult[](_operations.length);
        for (uint256 i = 0; i < _operations.length; i++) {
            Operation storage op = _operations[i];
            (bool ok, bytes memory ret) = op.contractAddress.call(op.callData);
            bool effectiveSuccess = ok && op.contractAddress.code.length > 0 && (ret.length != 32 || uint256(bytes32(ret)) != 0);
            results[i] = OperationResult({success: effectiveSuccess, returnData: ret});
        }

        revert ExecutionResult(results);
    }

    /// @notice executor (BI) or any party may cancel a pending atom (task #3 correction, lead
    /// decision 5b / backend spec F5: BI is the settlement agent and must be able to clean up a
    /// stuck trade, not just the trade's own parties). `nonReentrant` added for defense-in-depth
    /// consistency with execute()/simulate() (delta-audit lead, 2026-10-05) -- not exploitable
    /// today (execute() flips status before its external calls; simulate() unconditionally
    /// reverts, unwinding any nested call into this function), but cancel() was the one
    /// Pending-gated mutator relying on those OTHER functions' internal ordering instead of
    /// guarding itself.
    ///
    /// Task #8: status flips to Cancelled unconditionally (recorded regardless of how many legs
    /// actually had anything to release), THEN each leg in `_cancelOperations` is attempted,
    /// isolated (one leg's revert/failure never blocks another's, and never blocks the status
    /// change itself, which already happened).
    function cancel() external nonReentrant {
        if (status != Status.Pending) {
            revert AtomNotPending();
        }
        if (msg.sender != executor && !_isParty(msg.sender)) {
            revert NotAParty(msg.sender);
        }
        status = Status.Cancelled;
        emit AtomStatusChanged(status);

        for (uint256 i = 0; i < _cancelOperations.length; i++) {
            _attemptRelease(i);
        }
    }

    /// @notice Audit fix: cancel()'s per-leg release was one-shot -- a leg whose release call
    /// legitimately failed (as opposed to being skipped as not-delegated/inactive) had no
    /// recourse, since `status` is terminal once Cancelled and no other function could ever
    /// call Noto for that lock again. Callable by executor or any party, same gate as cancel(),
    /// only while `status == Cancelled` (retrying before a cancel makes no sense, and retrying
    /// after Executed is impossible by construction).
    function retryRelease(uint256 index) external nonReentrant {
        if (status != Status.Cancelled) {
            revert AtomNotPending();
        }
        if (msg.sender != executor && !_isParty(msg.sender)) {
            revert NotAParty(msg.sender);
        }
        _attemptRelease(index);
    }

    function _attemptRelease(uint256 index) internal {
        CancelOperation storage op = _cancelOperations[index];

        // Skip silently (no event -- nothing went wrong, there is simply nothing to do)
        // if this atom was never actually delegated this lock, or the lock is no longer
        // active (already spent/cancelled through some other path).
        try ILockableCapability(op.contractAddress).getLock(op.lockId) returns (ILockableCapability.LockInfo memory info) {
            if (info.spender != address(this)) {
                return;
            }
        } catch {
            return;
        }

        (bool ok, bytes memory ret) = op.contractAddress.call(op.callData);
        // Audit fix: raw word check, not abi.decode(ret,(bool)) -- see execute()'s comment.
        // Left uncaught, a non-canonical-bool return would revert this whole cancel()/
        // retryRelease() transaction, undoing the Cancelled status write (on cancel()'s first
        // call) and blocking every other leg's release in the same loop -- exactly the
        // deadlock this file exists to fix.
        bool effectiveSuccess = ok && op.contractAddress.code.length > 0 && (ret.length != 32 || uint256(bytes32(ret)) != 0);
        if (effectiveSuccess) {
            emit LegReleased(index, op.contractAddress, op.lockId);
        } else {
            emit LegReleaseFailed(index, op.contractAddress, op.lockId, ret);
        }
    }

    function getOperationCount() external view returns (uint256) {
        return _operations.length;
    }

    function getOperation(uint256 n) external view returns (Operation memory operation) {
        return _operations[n];
    }

    function getOperations() external view returns (Operation[] memory operations) {
        return _operations;
    }

    function getCancelOperations() external view returns (CancelOperation[] memory cancelOperations) {
        return _cancelOperations;
    }

    function getParties() external view returns (address[] memory parties) {
        return _parties;
    }
}
