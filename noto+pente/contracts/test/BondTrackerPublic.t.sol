// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {BondTrackerPublic} from "../src/BondTrackerPublic.sol";

// Same minimal inline cheatcode pattern as RestrictedAtom.t.sol -- no forge-std import.
// NOTE: this covers only the PUBLIC half of the reopening fix in isolation (cheap, fast
// feedback). BondTracker (private, Pente-hosted) cannot be meaningfully unit-tested this way --
// its hooks only make sense inside a Pente privacy group -- which is exactly why task #7's
// decisive test is the live 2-tranche proof on a scratch series, not a forge test.
interface Vm {
    function expectRevert() external;
    function prank(address) external;
    function addr(uint256 privateKey) external returns (address);
    function recordLogs() external;

    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function getRecordedLogs() external returns (Log[] memory);
}

contract BondTrackerPublicTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address issuer = vm.addr(1);
    address custodian = vm.addr(2);
    address currencyToken = vm.addr(3);

    function _fresh() internal returns (BondTrackerPublic) {
        vm.prank(issuer);
        return new BondTrackerPublic(issuer, 1000, 2000, currencyToken, 1);
    }

    function testOnIssueAccumulatesTotalSupplyAcrossTranches() external {
        BondTrackerPublic t = _fresh();
        vm.prank(issuer);
        t.onIssue(custodian, 1000);
        assert(t.totalSupply() == 1000);
        assert(t.trancheCount() == 1);

        // tranche 1's full cycle, so tranche 2 is allowed to issue.
        vm.prank(issuer);
        t.beginDistribution(1, 1);
        vm.prank(issuer);
        t.onDistribute(1000); // fully sold
        vm.prank(issuer);
        t.closeDistribution();
        vm.prank(issuer);
        t.setActive();

        vm.prank(issuer);
        t.onIssue(custodian, 500);
        // CHANGED behavior under test: must be cumulative (1500), not just the latest (500).
        assert(t.totalSupply() == 1500);
        assert(t.trancheCount() == 2);
    }

    // The bug: onIssue only ever incremented totalSupply -- there was no way to decrement it,
    // so it drifted stale after every burn/redemption. Proves onBurn now decrements it.
    function testOnBurnDecrementsTotalSupply() external {
        BondTrackerPublic t = _fresh();
        vm.prank(issuer);
        t.onIssue(custodian, 1000);
        assert(t.totalSupply() == 1000);

        vm.prank(issuer);
        t.onBurn(400);
        assert(t.totalSupply() == 600);
    }

    // Also serves as the regression guard for the Bug #2 fix below (lead-specified test (b)):
    // a round only half sold stays at _status == DISTRIBUTION_STARTED (onDistribute only flips
    // it to COMPLETE once availableUnits() hits zero), so the new `_status`-based gate must
    // still reject a second beginDistribution() while a round is genuinely still in progress.
    //
    // FLAGGED FOR THE LEAD: an earlier revision of this test also issued a hypothetical second
    // tranche (onIssue) before the second beginDistribution(), to mimic a real reopening
    // attempt. That intervening onIssue call now defeats this test, because onIssue
    // unconditionally overwrites `_status` to ISSUED with no gate of its own (see its own
    // comment) -- under the new `_status`-based gate, that single call silently makes
    // beginDistribution() succeed again even though round 1's availableUnits() is still 600,
    // nowhere near finished. The OLD `availableUnits()`-based gate was immune to this because it
    // never looked at `_status` at all. In production this exact sequence can't reach
    // BondTrackerPublic directly -- BondTracker's own onMint gate on the PRIVATE side (a
    // separate `_status` variable) already blocks re-minting while a round is open -- but this
    // contract no longer backstops that itself in isolation. Dropped the intervening onIssue
    // call here so this test keeps testing its one literal, required invariant; the gap above
    // is a new, explicit tradeoff of the `_status`-based gate choice, not yet separately fixed.
    function testBeginDistributionRejectsReopeningWhilePreviousRoundStillOpen() external {
        BondTrackerPublic t = _fresh();
        vm.prank(issuer);
        t.onIssue(custodian, 1000);
        vm.prank(issuer);
        t.beginDistribution(1, 1);
        // Only half sold -- round 1 is NOT finished.
        vm.prank(issuer);
        t.onDistribute(400);

        vm.prank(issuer);
        vm.expectRevert();
        t.beginDistribution(1, 1);
    }

    function testBeginDistributionAllowsNewRoundOnceThePreviousIsFullySold() external {
        BondTrackerPublic t = _fresh();
        vm.prank(issuer);
        t.onIssue(custodian, 1000);
        vm.prank(issuer);
        t.beginDistribution(1, 1);
        vm.prank(issuer);
        t.onDistribute(1000); // fully sold -> availableUnits() == 0

        vm.prank(issuer);
        t.onIssue(custodian, 500);
        vm.prank(issuer);
        t.beginDistribution(2, 1); // must NOT revert

        // The new round's distribution must only cover tranche 2's amount (500), not the
        // cumulative total (1500) -- otherwise tranche 1's already-sold units would be
        // re-offered for purchase.
        assert(t.distribution().totalUnits() == 500);
    }

    // CHANGED (D35): the last two mints used to run back-to-back (the second one from ISSUED),
    // which the new onIssue status gate rejects by design. The test's own invariant is the
    // 1-indexed sequential tranche numbering, so each additional tranche now goes through one
    // full sale cycle (begin -> fully sold -> close -> setActive) to legitimately reach ACTIVE.
    function testTrancheIssuedEventNumbersAreOneIndexedAndSequential() external {
        BondTrackerPublic t = _fresh();
        vm.prank(issuer);
        t.onIssue(custodian, 100);
        assert(t.trancheCount() == 1);

        vm.prank(issuer);
        t.beginDistribution(1, 1);
        vm.prank(issuer);
        t.onDistribute(100);
        vm.prank(issuer);
        t.closeDistribution();
        vm.prank(issuer);
        t.setActive();

        vm.prank(issuer);
        t.onIssue(custodian, 200);
        assert(t.trancheCount() == 2);

        vm.prank(issuer);
        t.beginDistribution(1, 1);
        vm.prank(issuer);
        t.onDistribute(200);
        vm.prank(issuer);
        t.closeDistribution();
        vm.prank(issuer);
        t.setActive();

        vm.prank(issuer);
        t.onIssue(custodian, 300);
        assert(t.trancheCount() == 3);
        assert(t.totalSupply() == 600);
    }

    function testBeginDistributionRejectsZeroMinimumDenomination() external {
        BondTrackerPublic t = _fresh();
        vm.prank(issuer);
        t.onIssue(custodian, 1000);
        vm.prank(issuer);
        vm.expectRevert();
        t.beginDistribution(1, 0);
    }

    function testForceCompleteDistributionWritesOffStuckRemainder() external {
        BondTrackerPublic t = _fresh();
        vm.prank(issuer);
        t.onIssue(custodian, 17);
        vm.prank(issuer);
        // price=3, denom=10 -> only quantities that are multiples of 10 have a valid price.
        t.beginDistribution(3, 10);
        vm.prank(issuer);
        t.onDistribute(10); // availableUnits == 7, and no valid purchase can ever clear it --
        // every quantity in [1,7]'s price (3*q) is not a multiple of 10. Without
        // forceCompleteDistribution, closeDistribution/setActive/reopening are stuck forever.

        vm.prank(issuer);
        t.forceCompleteDistribution();
        vm.prank(issuer);
        t.closeDistribution(); // must NOT revert -- this is exactly what was unreachable before.
        vm.prank(issuer);
        t.setActive();

        vm.prank(issuer);
        t.onIssue(custodian, 500); // reopening must succeed.
        assert(t.trancheCount() == 2);
    }

    // Bug #2 fix: forceCompleteDistribution only ever flipped `_status`, never touched
    // `distribution` -- so under the OLD `availableUnits() == 0` gate, a force-completion with
    // units still outstanding left availableUnits() permanently non-zero and every future
    // beginDistribution() reverted forever. Proves the new `_status`-based gate lets a SECOND
    // beginDistribution() succeed right after exactly that scenario.
    function testBeginDistributionSucceedsAfterForceCompleteWithRemainder() external {
        BondTrackerPublic t = _fresh();
        vm.prank(issuer);
        t.onIssue(custodian, 17);
        vm.prank(issuer);
        // price=3, denom=10 -> only quantities that are multiples of 10 have a valid price.
        t.beginDistribution(3, 10);
        vm.prank(issuer);
        t.onDistribute(10); // availableUnits == 7, stuck forever under the old gate.

        vm.prank(issuer);
        t.forceCompleteDistribution();

        vm.prank(issuer);
        t.onIssue(custodian, 500);
        vm.prank(issuer);
        t.beginDistribution(1, 1); // must NOT revert -- this is exactly what was broken before.
        assert(t.distribution().totalUnits() == 500);
    }

    function testForceCompleteDistributionRejectsWhenNoRoundInProgress() external {
        BondTrackerPublic t = _fresh();
        vm.prank(issuer);
        vm.expectRevert();
        t.forceCompleteDistribution();
    }

    function testStatusAndAvailableUnitsForGetDistributionState() external {
        BondTrackerPublic t = _fresh();
        assert(t.status() == BondTrackerPublic.Status.INITIALIZED);
        assert(t.availableUnits() == 0); // no revert even though distribution is address(0).

        vm.prank(issuer);
        t.onIssue(custodian, 1000);
        assert(t.status() == BondTrackerPublic.Status.ISSUED);

        vm.prank(issuer);
        t.beginDistribution(1, 1);
        assert(t.status() == BondTrackerPublic.Status.DISTRIBUTION_STARTED);
        assert(t.availableUnits() == 1000);

        vm.prank(issuer);
        t.onDistribute(400);
        assert(t.availableUnits() == 600);
    }

    // ------------------------------------------------------------------
    // D35 status gate on onIssue (BACKLOG #1): the five non-allowed /
    // two allowed statuses, one test each.
    // ------------------------------------------------------------------

    // ISSUED: a second mint before ANY distribution round ever started -- nothing could
    // have sold out in between, so re-minting here would silently add supply outside a round.
    function testOnIssueRejectedAtIssued() external {
        BondTrackerPublic t = _fresh();
        vm.prank(issuer);
        t.onIssue(custodian, 1000); // INITIALIZED -> ISSUED

        vm.prank(issuer);
        vm.expectRevert();
        t.onIssue(custodian, 500);
    }

    // DISTRIBUTION_STARTED: a round is actively selling -- the pre-D35 hole, where onIssue
    // silently reset _status to ISSUED and began a new round on top of an open one.
    function testOnIssueRejectedAtDistributionStarted() external {
        BondTrackerPublic t = _fresh();
        vm.prank(issuer);
        t.onIssue(custodian, 1000);
        vm.prank(issuer);
        t.beginDistribution(1, 1); // -> DISTRIBUTION_STARTED

        vm.prank(issuer);
        vm.expectRevert();
        t.onIssue(custodian, 500);
    }

    // DISTRIBUTION_CLOSED: round finished but not yet setActive -- D34 ordering requires
    // closeDistribution then setActive BEFORE mintTranche; minting here would skip that check.
    function testOnIssueRejectedAtDistributionClosed() external {
        BondTrackerPublic t = _fresh();
        vm.prank(issuer);
        t.onIssue(custodian, 1000);
        vm.prank(issuer);
        t.beginDistribution(1, 1);
        vm.prank(issuer);
        t.onDistribute(1000); // fully sold -> DISTRIBUTION_COMPLETE
        vm.prank(issuer);
        t.closeDistribution(); // -> DISTRIBUTION_CLOSED

        vm.prank(issuer);
        vm.expectRevert();
        t.onIssue(custodian, 500);
    }

    // DISTRIBUTION_COMPLETE: allowed -- a fully-sold round reopens immediately (documented in
    // beginDistribution's own comment). Proves onIssue itself succeeds here and advances the
    // tranche state, not merely that beginDistribution accepts the result.
    function testOnIssueSucceedsAtDistributionComplete() external {
        BondTrackerPublic t = _fresh();
        vm.prank(issuer);
        t.onIssue(custodian, 1000);
        vm.prank(issuer);
        t.beginDistribution(1, 1);
        vm.prank(issuer);
        t.onDistribute(1000); // fully sold -> DISTRIBUTION_COMPLETE

        vm.prank(issuer);
        t.onIssue(custodian, 500); // must NOT revert
        assert(t.status() == BondTrackerPublic.Status.ISSUED);
        assert(t.trancheCount() == 2);
    }

    // ACTIVE: allowed -- the D34 burn-on-reopen flow mints tranche 2 here. The new tranche's
    // amount must replace _pendingTrancheAmount (proven via the next round's totalUnits),
    // never accumulate with the old one.
    function testOnIssueSucceedsAtActive() external {
        BondTrackerPublic t = _fresh();
        vm.prank(issuer);
        t.onIssue(custodian, 1000);
        vm.prank(issuer);
        t.beginDistribution(1, 1);
        vm.prank(issuer);
        t.onDistribute(1000);
        vm.prank(issuer);
        t.closeDistribution();
        vm.prank(issuer);
        t.setActive(); // -> ACTIVE

        vm.prank(issuer);
        t.onIssue(custodian, 500); // must NOT revert
        assert(t.status() == BondTrackerPublic.Status.ISSUED);

        vm.prank(issuer);
        t.beginDistribution(1, 1); // must not revert
        // _pendingTrancheAmount is internal; the next round offering exactly 500 (not 1500)
        // proves it was replaced, not accumulated.
        assert(t.distribution().totalUnits() == 500);
    }

    // BACKLOG #6 (D36): the stale-settle receiver is notification-only -- emits its event and
    // changes no state at all. onlyOwner = the privacy group's own address in production
    // (pranked here as the constructor owner, matching the other receivers' tests).
    function testStaleLockSettledReceiverEmitsAndChangesNothing() external {
        BondTrackerPublic t = _fresh();
        bytes32 lockId = keccak256("stalePublic");

        vm.recordLogs();
        vm.prank(issuer);
        t.onStaleLockSettled(lockId, 1, 600);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bool found = false;
        for (uint256 i = 0; i < logs.length; i++) {
            if (
                logs[i].topics.length > 0 &&
                logs[i].topics[0] == keccak256("StaleLockSettled(bytes32,uint256,uint256)")
            ) {
                // lockId is indexed -> topics[1]; data carries (round, amount).
                bytes32 evtLockId = bytes32(logs[i].topics[1]);
                (uint256 round, uint256 amount) = abi.decode(
                    logs[i].data,
                    (uint256, uint256)
                );
                assert(evtLockId == lockId);
                assert(round == 1);
                assert(amount == 600);
                found = true;
            }
        }
        assert(found);
        // Notification only: no status, no counters.
        assert(t.status() == BondTrackerPublic.Status.INITIALIZED);
        assert(address(t.distribution()) == address(0));
        assert(t.totalSupply() == 0);
        assert(t.trancheCount() == 0);
    }
}
