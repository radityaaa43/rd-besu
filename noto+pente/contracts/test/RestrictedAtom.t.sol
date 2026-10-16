// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {RestrictedAtom} from "../src/RestrictedAtom.sol";
import {RestrictedAtomFactory} from "../src/RestrictedAtomFactory.sol";
import {ILockableCapability} from "paladin-domains/interfaces/ILockableCapability.sol";

// Minimal inline cheatcode interface -- deliberately NOT importing forge-std/Test.sol.
// forge-std is not installed anywhere in this task's scope (Paladin/contracts,
// Paladin/spikes, docs/) and fetching it would be a new dependency, one of the lead's
// named stop-and-report conditions. The cheatcode precompile at this fixed address
// ("hevm cheat code") is wired into forge's EVM regardless of whether forge-std is
// imported -- forge-std's Test.sol is just a friendlier wrapper around the same address.
interface Vm {
    function expectRevert() external;
    function prank(address) external;
    function addr(uint256 privateKey) external returns (address);
}

/// A harmless target contract for the atom's operations, so execute() has something
/// real to call -- standing in for a Noto spendLock/cancelLock call in production.
contract RecordingTarget {
    uint256 public calls;

    function ping() external {
        calls += 1;
    }

    /// Mimics a legacy ERC20-style function that signals failure by returning false
    /// instead of reverting.
    function pingWithResult(bool succeed) external returns (bool) {
        if (succeed) {
            calls += 1;
        }
        return succeed;
    }
}

/// Task #8: a minimal ILockableCapability stand-in for Noto, so cancel()'s per-leg release
/// logic (getLock precheck + cancelLock attempt) can be unit-tested without a live Noto
/// deployment. `setSpender`/`setActive`/`setCancelShouldSucceed` let a test set up each lock
/// independently of any real lock/delegate flow (that end-to-end proof is the live test).
contract MockLockable {
    struct MockLock {
        address spender;
        bool active;
        bool cancelShouldSucceed;
    }

    mapping(bytes32 => MockLock) public locks;

    function setLock(bytes32 lockId, address spender, bool active, bool cancelShouldSucceed) external {
        locks[lockId] = MockLock({spender: spender, active: active, cancelShouldSucceed: cancelShouldSucceed});
    }

    function getLock(bytes32 lockId) external view returns (ILockableCapability.LockInfo memory info) {
        MockLock memory l = locks[lockId];
        if (!l.active) revert ILockableCapability.LockNotActive(lockId);
        return ILockableCapability.LockInfo({owner: address(0), spender: l.spender, spendCommitment: bytes32(0), cancelCommitment: bytes32(0)});
    }

    function cancelLock(bytes32 lockId, bytes calldata, bytes calldata) external {
        require(locks[lockId].active, "lock not active");
        require(locks[lockId].cancelShouldSucceed, "mock cancel failure");
        locks[lockId].active = false;
    }

    /// Audit fix regression test helper: a successful call returning an arbitrary 32-byte word
    /// that is NOT a canonical bool (0 or 1). Before the fix, RestrictedAtom's
    /// `abi.decode(ret, (bool))` would PANIC on this and revert the whole cancel() transaction.
    function returnNonBoolWord(bytes32 word) external pure returns (bytes32) {
        return word;
    }
}

contract RestrictedAtomTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address partyA = vm.addr(1);
    address partyB = vm.addr(2);
    address executor = vm.addr(3);
    address stranger = vm.addr(4);

    RecordingTarget target;
    RestrictedAtomFactory factory;

    function _freshAtom() internal returns (RestrictedAtom) {
        target = new RecordingTarget();
        factory = new RestrictedAtomFactory();

        RestrictedAtom.Operation[] memory ops = new RestrictedAtom.Operation[](1);
        ops[0] = RestrictedAtom.Operation({contractAddress: address(target), callData: abi.encodeCall(RecordingTarget.ping, ())});

        address[] memory parties = new address[](2);
        parties[0] = partyA;
        parties[1] = partyB;

        RestrictedAtom.CancelOperation[] memory cancelOps = new RestrictedAtom.CancelOperation[](0);
        address atomAddr = factory.create(ops, cancelOps, parties, executor);
        return RestrictedAtom(atomAddr);
    }

    /// (i) a non-party cancel -> revert
    function testNonPartyCancelReverts() external {
        RestrictedAtom atom = _freshAtom();
        vm.prank(stranger);
        vm.expectRevert();
        atom.cancel();
        assert(uint8(atom.status()) == uint8(RestrictedAtom.Status.Pending));
    }

    /// (ii) a party cancel -> Cancelled
    function testPartyCancelSucceeds() external {
        RestrictedAtom atom = _freshAtom();
        vm.prank(partyA);
        atom.cancel();
        assert(uint8(atom.status()) == uint8(RestrictedAtom.Status.Cancelled));
    }

    /// (iii) a non-executor execute -> revert
    function testNonExecutorExecuteReverts() external {
        RestrictedAtom atom = _freshAtom();
        vm.prank(stranger);
        vm.expectRevert();
        atom.execute();
        assert(uint8(atom.status()) == uint8(RestrictedAtom.Status.Pending));
        assert(target.calls() == 0);
    }

    /// (iv) the executor execute -> Executed, and the operation actually ran
    function testExecutorExecuteSucceeds() external {
        RestrictedAtom atom = _freshAtom();
        vm.prank(executor);
        atom.execute();
        assert(uint8(atom.status()) == uint8(RestrictedAtom.Status.Executed));
        assert(target.calls() == 1);
    }

    /// (v) cancel after Executed -> revert (a party trying to cancel a done atom)
    function testCancelAfterExecutedReverts() external {
        RestrictedAtom atom = _freshAtom();
        vm.prank(executor);
        atom.execute();

        vm.prank(partyA);
        vm.expectRevert();
        atom.cancel();
        assert(uint8(atom.status()) == uint8(RestrictedAtom.Status.Executed));
    }

    // Extra, not in the lead's list but caught while writing these: a party should not be
    // able to call execute() even though they CAN cancel -- the two roles are disjoint.
    function testPartyCannotExecute() external {
        RestrictedAtom atom = _freshAtom();
        vm.prank(partyA);
        vm.expectRevert();
        atom.execute();
        assert(uint8(atom.status()) == uint8(RestrictedAtom.Status.Pending));
    }

    // Task #3 correction (lead, decision 5b / backend spec F5): BI is the settlement agent and
    // must be able to cancel a stuck trade, not just the trade's own parties. The task-#2 test
    // this replaces (testExecutorCannotCancel) asserted the opposite and was wrong.
    function testExecutorCanCancel() external {
        RestrictedAtom atom = _freshAtom();
        vm.prank(executor);
        atom.cancel();
        assert(uint8(atom.status()) == uint8(RestrictedAtom.Status.Cancelled));
    }

    // Found by the solidity-auditor pass (boundary/economic-security/flow-gap/trust-gap agents,
    // merged finding): a leg whose target has no deployed code must not be treated as a
    // successful settlement. Upstream Atom.sol avoided this via OpenZeppelin's
    // Address.functionCall; this fork's bare `.call()` had dropped that check.
    function testExecuteRevertsOnCodelessTarget() external {
        target = new RecordingTarget();
        factory = new RestrictedAtomFactory();
        RestrictedAtom.Operation[] memory ops = new RestrictedAtom.Operation[](2);
        ops[0] = RestrictedAtom.Operation({contractAddress: address(target), callData: abi.encodeCall(RecordingTarget.ping, ())});
        ops[1] = RestrictedAtom.Operation({contractAddress: address(0xDEAD), callData: abi.encodeCall(RecordingTarget.ping, ())});
        address[] memory parties = new address[](2);
        parties[0] = partyA;
        parties[1] = partyB;
        RestrictedAtom.CancelOperation[] memory cancelOps = new RestrictedAtom.CancelOperation[](0);
        RestrictedAtom atom = RestrictedAtom(factory.create(ops, cancelOps, parties, executor));

        vm.prank(executor);
        vm.expectRevert();
        atom.execute();
        // Neither leg's effect should be visible as "settled": status must not have advanced,
        // so a retry or cancel is still possible -- it must NOT be stuck Executed with one leg
        // silently skipped.
        assert(uint8(atom.status()) == uint8(RestrictedAtom.Status.Pending));
    }

    // Found by the same audit pass: a call that returns `false` instead of reverting (legacy
    // ERC20-style failure signalling) must also not be treated as success.
    function testExecuteRevertsOnFalseReturn() external {
        target = new RecordingTarget();
        factory = new RestrictedAtomFactory();
        RestrictedAtom.Operation[] memory ops = new RestrictedAtom.Operation[](1);
        ops[0] = RestrictedAtom.Operation({contractAddress: address(target), callData: abi.encodeCall(RecordingTarget.pingWithResult, (false))});
        address[] memory parties = new address[](2);
        parties[0] = partyA;
        parties[1] = partyB;
        RestrictedAtom.CancelOperation[] memory cancelOps = new RestrictedAtom.CancelOperation[](0);
        RestrictedAtom atom = RestrictedAtom(factory.create(ops, cancelOps, parties, executor));

        vm.prank(executor);
        vm.expectRevert();
        atom.execute();
        assert(target.calls() == 0);
        assert(uint8(atom.status()) == uint8(RestrictedAtom.Status.Pending));
    }

    // A leg that genuinely succeeds (deployed target, returns true) must still pass.
    function testExecuteSucceedsOnTrueReturn() external {
        target = new RecordingTarget();
        factory = new RestrictedAtomFactory();
        RestrictedAtom.Operation[] memory ops = new RestrictedAtom.Operation[](1);
        ops[0] = RestrictedAtom.Operation({contractAddress: address(target), callData: abi.encodeCall(RecordingTarget.pingWithResult, (true))});
        address[] memory parties = new address[](2);
        parties[0] = partyA;
        parties[1] = partyB;
        RestrictedAtom.CancelOperation[] memory cancelOps = new RestrictedAtom.CancelOperation[](0);
        RestrictedAtom atom = RestrictedAtom(factory.create(ops, cancelOps, parties, executor));

        vm.prank(executor);
        atom.execute();
        assert(target.calls() == 1);
        assert(uint8(atom.status()) == uint8(RestrictedAtom.Status.Executed));
    }

    // Found by the asymmetry agent: simulate() ran the exact same external-call surface as
    // execute()/cancel() but, unlike them, had no access restriction at all. simulate() always
    // reverts by design (to discard side effects), so these tests use a raw low-level call and
    // check the revert's error selector, to tell "rejected before running" (NotAParty) apart
    // from "ran, then did its normal always-revert exit" (ExecutionResult).
    function _simulateRevertSelector(address caller) internal returns (bytes4 selector) {
        vm.prank(caller);
        (bool ok, bytes memory ret) = address(_atom).call(abi.encodeCall(RestrictedAtom.simulate, ()));
        assert(!ok);
        assert(ret.length >= 4);
        assembly {
            selector := mload(add(ret, 32))
        }
    }

    RestrictedAtom private _atom;

    function testSimulateRejectsNonParty() external {
        _atom = _freshAtom();
        assert(_simulateRevertSelector(stranger) == RestrictedAtom.NotAParty.selector);
    }

    function testSimulateAllowsParty() external {
        _atom = _freshAtom();
        assert(_simulateRevertSelector(partyA) == RestrictedAtom.ExecutionResult.selector);
    }

    function testSimulateAllowsExecutor() external {
        _atom = _freshAtom();
        assert(_simulateRevertSelector(executor) == RestrictedAtom.ExecutionResult.selector);
    }

    // Task #8, lead requirement #4 (test 1 of 2): a 2-leg cancel where ONE leg's cancelCall
    // fails (mismatched/malicious cancelArgs, simulated here as the mock simply refusing) must
    // NOT hold the other, good leg hostage -- the good leg still gets released, and the bad one
    // surfaces as its own LegReleaseFailed event, not a revert of the whole cancel() call.
    function testCancelIsolatesOneFailingLegFromTheOther() external {
        MockLockable lockable = new MockLockable();
        factory = new RestrictedAtomFactory();
        RestrictedAtom.Operation[] memory ops = new RestrictedAtom.Operation[](0);
        address[] memory parties = new address[](2);
        parties[0] = partyA;
        parties[1] = partyB;
        RestrictedAtom.CancelOperation[] memory cancelOps = new RestrictedAtom.CancelOperation[](2);
        bytes32 goodLockId = keccak256("good-lock");
        bytes32 badLockId = keccak256("bad-lock");
        cancelOps[0] = RestrictedAtom.CancelOperation({contractAddress: address(lockable), lockId: goodLockId, callData: abi.encodeCall(MockLockable.cancelLock, (goodLockId, "", ""))});
        cancelOps[1] = RestrictedAtom.CancelOperation({contractAddress: address(lockable), lockId: badLockId, callData: abi.encodeCall(MockLockable.cancelLock, (badLockId, "", ""))});
        RestrictedAtom atom = RestrictedAtom(factory.create(ops, cancelOps, parties, executor));

        // Both legs delegated to this atom; only the "good" one's cancelLock is set to succeed.
        lockable.setLock(goodLockId, address(atom), true, true);
        lockable.setLock(badLockId, address(atom), true, false);

        vm.prank(executor);
        atom.cancel();

        assert(uint8(atom.status()) == uint8(RestrictedAtom.Status.Cancelled));
        (address goodSpender, bool goodActive,) = lockable.locks(goodLockId);
        (, bool badActive,) = lockable.locks(badLockId);
        assert(goodActive == false); // released
        assert(goodSpender == address(atom));
        assert(badActive == true); // still stuck -- but visible via LegReleaseFailed, not silently lost or blocking the good leg
    }

    // Task #8, lead requirement #4 (test 2 of 2): when only ONE of two legs was ever delegated
    // to this atom, cancel() must touch only that one -- the never-delegated leg is skipped
    // silently (its owner already has full, undelegated control; nothing to release).
    function testCancelOnlyTouchesTheDelegatedLeg() external {
        MockLockable lockable = new MockLockable();
        factory = new RestrictedAtomFactory();
        RestrictedAtom.Operation[] memory ops = new RestrictedAtom.Operation[](0);
        address[] memory parties = new address[](2);
        parties[0] = partyA;
        parties[1] = partyB;
        RestrictedAtom.CancelOperation[] memory cancelOps = new RestrictedAtom.CancelOperation[](2);
        bytes32 delegatedLockId = keccak256("delegated-lock");
        bytes32 neverDelegatedLockId = keccak256("never-delegated-lock");
        cancelOps[0] = RestrictedAtom.CancelOperation({contractAddress: address(lockable), lockId: delegatedLockId, callData: abi.encodeCall(MockLockable.cancelLock, (delegatedLockId, "", ""))});
        cancelOps[1] = RestrictedAtom.CancelOperation({contractAddress: address(lockable), lockId: neverDelegatedLockId, callData: abi.encodeCall(MockLockable.cancelLock, (neverDelegatedLockId, "", ""))});
        RestrictedAtom atom = RestrictedAtom(factory.create(ops, cancelOps, parties, executor));

        lockable.setLock(delegatedLockId, address(atom), true, true);
        // Spender is partyB's own address (e.g. the owner), never delegated to this atom.
        lockable.setLock(neverDelegatedLockId, partyB, true, true);

        vm.prank(executor);
        atom.cancel();

        assert(uint8(atom.status()) == uint8(RestrictedAtom.Status.Cancelled));
        (, bool delegatedActive,) = lockable.locks(delegatedLockId);
        (address neverSpender, bool neverActive,) = lockable.locks(neverDelegatedLockId);
        assert(delegatedActive == false); // released
        assert(neverActive == true); // untouched -- was never this atom's to release
        assert(neverSpender == partyB);
    }

    // Audit fix regression (solidity-auditor, agents 6/7 as FINDING): cancel()'s per-leg
    // release used to decode a successful call's return value with `abi.decode(ret,(bool))`,
    // which PANICS (reverts) on any 32-byte word that isn't exactly 0 or 1. Before the fix, a
    // leg whose release call returns such a word would revert the WHOLE cancel() transaction,
    // undoing the Cancelled status write and blocking every other leg's release too. The fixed
    // version must not revert at all.
    function testCancelDoesNotRevertOnNonBoolReturn() external {
        MockLockable lockable = new MockLockable();
        factory = new RestrictedAtomFactory();
        RestrictedAtom.Operation[] memory ops = new RestrictedAtom.Operation[](0);
        address[] memory parties = new address[](2);
        parties[0] = partyA;
        parties[1] = partyB;
        RestrictedAtom.CancelOperation[] memory cancelOps = new RestrictedAtom.CancelOperation[](1);
        bytes32 lockId = keccak256("garbage-return-lock");
        cancelOps[0] = RestrictedAtom.CancelOperation({
            contractAddress: address(lockable),
            lockId: lockId,
            callData: abi.encodeCall(MockLockable.returnNonBoolWord, (bytes32(uint256(42))))
        });
        RestrictedAtom atom = RestrictedAtom(factory.create(ops, cancelOps, parties, executor));
        lockable.setLock(lockId, address(atom), true, true);

        vm.prank(executor);
        atom.cancel(); // must not revert -- pre-fix, this would panic on abi.decode

        assert(uint8(atom.status()) == uint8(RestrictedAtom.Status.Cancelled));
    }

    // Audit fix regression (solidity-auditor, agents 5/8 as FINDING): a leg whose release call
    // legitimately failed (not skipped as not-delegated/inactive) used to have zero recourse,
    // since cancel()'s status is terminal and no function could call Noto for that lock again.
    // retryRelease() must be able to release it once the underlying condition resolves.
    function testRetryReleaseSucceedsAfterInitialFailure() external {
        MockLockable lockable = new MockLockable();
        factory = new RestrictedAtomFactory();
        RestrictedAtom.Operation[] memory ops = new RestrictedAtom.Operation[](0);
        address[] memory parties = new address[](2);
        parties[0] = partyA;
        parties[1] = partyB;
        RestrictedAtom.CancelOperation[] memory cancelOps = new RestrictedAtom.CancelOperation[](1);
        bytes32 lockId = keccak256("retry-lock");
        cancelOps[0] = RestrictedAtom.CancelOperation({contractAddress: address(lockable), lockId: lockId, callData: abi.encodeCall(MockLockable.cancelLock, (lockId, "", ""))});
        RestrictedAtom atom = RestrictedAtom(factory.create(ops, cancelOps, parties, executor));

        // First attempt: still delegated and active, but the mock's own release call is set to
        // fail (simulates e.g. a stale cancelCommitment on the real Noto side).
        lockable.setLock(lockId, address(atom), true, false);
        vm.prank(executor);
        atom.cancel();
        (, bool activeAfterFirstAttempt,) = lockable.locks(lockId);
        assert(activeAfterFirstAttempt == true); // still stuck -- first attempt failed
        assert(uint8(atom.status()) == uint8(RestrictedAtom.Status.Cancelled)); // but status is terminal already

        // The underlying condition resolves; retryRelease() must now succeed without needing
        // status back at Pending (which is impossible by construction once Cancelled).
        lockable.setLock(lockId, address(atom), true, true);
        vm.prank(executor);
        atom.retryRelease(0);
        (, bool activeAfterRetry,) = lockable.locks(lockId);
        assert(activeAfterRetry == false); // released on retry
    }

    function testRetryReleaseRevertsIfNotCancelled() external {
        RestrictedAtom atom = _freshAtom(); // Pending
        vm.prank(executor);
        vm.expectRevert();
        atom.retryRelease(0);
    }

    function testRetryReleaseRevertsForNonPartyNonExecutor() external {
        MockLockable lockable = new MockLockable();
        factory = new RestrictedAtomFactory();
        RestrictedAtom.Operation[] memory ops = new RestrictedAtom.Operation[](0);
        address[] memory parties = new address[](2);
        parties[0] = partyA;
        parties[1] = partyB;
        RestrictedAtom.CancelOperation[] memory cancelOps = new RestrictedAtom.CancelOperation[](1);
        bytes32 lockId = keccak256("retry-auth-lock");
        cancelOps[0] = RestrictedAtom.CancelOperation({contractAddress: address(lockable), lockId: lockId, callData: abi.encodeCall(MockLockable.cancelLock, (lockId, "", ""))});
        RestrictedAtom atom = RestrictedAtom(factory.create(ops, cancelOps, parties, executor));
        lockable.setLock(lockId, address(atom), true, false);
        vm.prank(executor);
        atom.cancel();

        vm.prank(stranger);
        vm.expectRevert();
        atom.retryRelease(0);
    }
}
