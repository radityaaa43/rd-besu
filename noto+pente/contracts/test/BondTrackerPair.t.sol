// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {BondTracker} from "../src/BondTracker.sol";
import {BondTrackerPublic} from "../src/BondTrackerPublic.sol";
import {INotoHooks} from "paladin-domains/interfaces/INotoHooks.sol";
import {InvestorList} from "paladin-private/InvestorList.sol";

// The private BondTracker and the public BondTrackerPublic together. In production Pente runs
// each PenteExternalCall the private side emits against the public contract, with the privacy
// group as msg.sender (= the public contract's owner). `_relay` does the same here, so these
// tests prove the PUBLIC status follows the private flow end to end although no amount is ever
// sent to it: normal sell-out, and force-complete + burn-on-reopen (D36/D37).
interface Vm {
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

contract BondTrackerPairTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 constant PENTE_EXTERNAL_CALL_TOPIC = keccak256("PenteExternalCall(address,bytes)");

    address issuer = vm.addr(1);
    address custodian = vm.addr(2);
    address group = vm.addr(3); // the privacy group: owner of the public tracker
    address investor1 = vm.addr(4);

    INotoHooks.PreparedTransaction empty = INotoHooks.PreparedTransaction({contractAddress: address(0), encodedCall: ""});

    BondTracker t;
    BondTrackerPublic pub;
    uint256 lockSeq;

    function _setUp() internal {
        pub = new BondTrackerPublic(group, 1000, 2000, vm.addr(5), 1);
        vm.prank(issuer);
        t = new BondTracker("PAIR", "PR", custodian, address(pub));
        InvestorList list = t.investorList();
        vm.prank(custodian);
        list.addInvestor(investor1);
        vm.recordLogs();
    }

    // Runs every PenteExternalCall to the public tracker emitted since the last relay, as the
    // group. Returns how many there were and how many were onDistributionComplete().
    function _relay() internal returns (uint256 calls, uint256 completes) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (
                logs[i].emitter == address(t) &&
                logs[i].topics.length > 1 &&
                logs[i].topics[0] == PENTE_EXTERNAL_CALL_TOPIC &&
                address(uint160(uint256(logs[i].topics[1]))) == address(pub)
            ) {
                bytes memory call = abi.decode(logs[i].data, (bytes));
                calls++;
                if (keccak256(call) == keccak256(abi.encodeWithSignature("onDistributionComplete()"))) completes++;
                vm.prank(group);
                (bool ok, ) = address(pub).call(call);
                assert(ok);
            }
        }
    }

    function _one(address to, uint256 amount) internal pure returns (INotoHooks.UnlockRecipient[] memory r) {
        r = new INotoHooks.UnlockRecipient[](1);
        r[0] = INotoHooks.UnlockRecipient({to: to, amount: amount});
    }

    function _mint(uint256 amount) internal {
        vm.prank(issuer);
        t.onMint(issuer, custodian, amount, "", empty);
        _relay();
    }

    function _begin() internal {
        vm.prank(custodian);
        t.beginDistribution(1, 1);
        _relay();
    }

    function _lockAndPrepare(uint256 amount) internal returns (bytes32 lockId) {
        lockId = keccak256(abi.encode("pairLock", lockSeq++));
        vm.prank(custodian);
        t.onLock(custodian, lockId, custodian, amount, "", empty);
        vm.prank(custodian);
        t.onPrepareUnlock(custodian, lockId, _one(investor1, amount), "", empty);
    }

    // The delegate (Atom) settled a prepared unlock; Noto's hook arrives from the notary.
    function _settle(bytes32 lockId, uint256 amount) internal returns (uint256 calls, uint256 completes) {
        vm.prank(custodian);
        t.handleDelegateUnlock(custodian, lockId, _one(investor1, amount), "");
        return _relay();
    }

    function _sell(uint256 amount) internal returns (uint256 calls, uint256 completes) {
        return _settle(_lockAndPrepare(amount), amount);
    }

    function _status() internal view returns (BondTrackerPublic.Status) {
        return pub.status();
    }

    function testRoundTermsAreReadableOnlyFromThePrivateTracker() external {
        _setUp();
        _mint(1000);
        vm.prank(custodian);
        t.beginDistribution(7, 3);
        _relay();
        assert(t.discountPrice() == 7);
        assert(t.minimumDenomination() == 3);
        assert(t.availableUnitsPrivate() == 1000);
    }

    // ---- normal sell-out ----

    function testSellOutCompletesPublicRoundExactlyOnceAndWithoutAmounts() external {
        _setUp();
        _mint(1000);
        assert(_status() == BondTrackerPublic.Status.ISSUED);
        _begin();
        assert(_status() == BondTrackerPublic.Status.DISTRIBUTION_STARTED);

        (uint256 calls, uint256 completes) = _sell(400); // partial: the public side hears nothing
        assert(calls == 0 && completes == 0);
        assert(_status() == BondTrackerPublic.Status.DISTRIBUTION_STARTED);
        assert(t.availableUnitsPrivate() == 600);

        (calls, completes) = _sell(600); // sold out
        assert(calls == 1 && completes == 1);
        assert(_status() == BondTrackerPublic.Status.DISTRIBUTION_COMPLETE);
        assert(t.availableUnitsPrivate() == 0);

        vm.prank(custodian);
        t.closeDistribution();
        _relay();
        assert(_status() == BondTrackerPublic.Status.DISTRIBUTION_CLOSED);
        vm.prank(issuer);
        t.setActive();
        _relay();
        assert(_status() == BondTrackerPublic.Status.ACTIVE);
        assert(t.balanceOf(investor1) == 1000);
    }

    function testSecondTrancheSellOutAlsoCompletes() external {
        _setUp();
        _mint(1000);
        _begin();
        _sell(1000);
        vm.prank(custodian);
        t.closeDistribution();
        _relay();
        vm.prank(issuer);
        t.setActive();
        _relay();

        _mint(500);
        assert(pub.trancheCount() == 2);
        _begin();
        (uint256 calls, uint256 completes) = _sell(500);
        assert(calls == 1 && completes == 1);
        assert(_status() == BondTrackerPublic.Status.DISTRIBUTION_COMPLETE);
    }

    // ---- force-complete + burn-on-reopen (D36/D37) ----

    function testForceCompleteBurnReopenKeepsPublicStatusInStep() external {
        _setUp();
        _mint(1000);
        _begin();
        _sell(400);
        // a lock prepared in round 1 and left open across the force-complete (D36 stale lock)
        bytes32 stale = _lockAndPrepare(100);

        vm.prank(custodian);
        t.forceCompleteDistribution();
        (uint256 calls, uint256 completes) = _relay();
        assert(calls == 1 && completes == 0); // forceCompleteDistribution(), not onDistributionComplete()
        assert(_status() == BondTrackerPublic.Status.DISTRIBUTION_COMPLETE);

        // D37: a round-1 lock settling after the round closed is a private, event-only non-sale;
        // it must not reach the public tracker (and must not re-complete a completed round).
        (calls, completes) = _settle(stale, 100);
        assert(calls == 0 && completes == 0);
        assert(_status() == BondTrackerPublic.Status.DISTRIBUTION_COMPLETE);

        // burn the unsold remainder (1000 - 400 sold - 100 stale-settled leaves 500 with the custodian)
        vm.prank(custodian);
        t.onBurn(custodian, custodian, 500, "", empty);
        (calls, ) = _relay();
        assert(calls == 0); // a burn amount never reaches the public tracker
        assert(t.totalSupply() == 500);

        vm.prank(custodian);
        t.closeDistribution();
        _relay();
        vm.prank(issuer);
        t.setActive();
        _relay();
        assert(_status() == BondTrackerPublic.Status.ACTIVE);

        _mint(300); // tranche 2 on top of the burned remainder
        assert(pub.trancheCount() == 2);
        _begin();
        assert(t.availableUnitsPrivate() == 300);
        (calls, completes) = _sell(300);
        assert(calls == 1 && completes == 1);
        assert(_status() == BondTrackerPublic.Status.DISTRIBUTION_COMPLETE);
        assert(t.balanceOf(investor1) == 800); // 400 + 100 + 300
    }
}
