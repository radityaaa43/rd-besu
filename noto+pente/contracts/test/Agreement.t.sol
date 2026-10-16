// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {Agreement} from "../src/Agreement.sol";

// Minimal inline cheatcode interface -- same reasoning as RestrictedAtom.t.sol: no forge-std
// in scope, the cheatcode precompile works regardless of whether Test.sol wraps it.
interface Vm {
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function prank(address) external;
    function addr(uint256 privateKey) external returns (address);
}

contract AgreementTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address bi = vm.addr(1);
    address bank1 = vm.addr(2); // proposer, owns the bond leg
    address bank2 = vm.addr(3); // counterparty, owns the cash leg
    address stranger = vm.addr(4);
    address bondToken = vm.addr(5);
    address cashToken = vm.addr(6);
    address atomStandIn = vm.addr(7);

    bytes32 productType = keccak256("outright");

    function _freshAgreement() internal returns (Agreement) {
        return new Agreement(bi);
    }

    function _twoLegs() internal view returns (Agreement.LegProposal[] memory legs) {
        legs = new Agreement.LegProposal[](2);
        legs[0] = Agreement.LegProposal({asset: bondToken, from: bank1, to: bank2, amount: 100});
        legs[1] = Agreement.LegProposal({asset: cashToken, from: bank2, to: bank1, amount: 50});
    }

    function _proposed(string memory tradeId) internal returns (Agreement) {
        Agreement a = _freshAgreement();
        vm.prank(bank1);
        a.propose(tradeId, productType, _twoLegs());
        return a;
    }

    function _accepted(string memory tradeId) internal returns (Agreement) {
        Agreement a = _proposed(tradeId);
        vm.prank(bank2);
        a.accept(tradeId);
        return a;
    }

    function _legsPrepared(string memory tradeId) internal returns (Agreement) {
        Agreement a = _accepted(tradeId);
        vm.prank(bank1);
        a.recordLeg(tradeId, 0, keccak256("lock0"), keccak256("prepared0"), "unlock0", "cancel0");
        vm.prank(bank2);
        a.recordLeg(tradeId, 1, keccak256("lock1"), keccak256("prepared1"), "unlock1", "cancel1");
        return a;
    }

    function _atomCreated(string memory tradeId) internal returns (Agreement) {
        Agreement a = _legsPrepared(tradeId);
        vm.prank(bi);
        a.recordAtom(tradeId, atomStandIn);
        return a;
    }

    // --- constructor ---

    // Solidity-auditor fix (2026-10-05, agent 2, FINDING "unchecked-trusted-role-param"): bi
    // is immutable with no setter, so a zero value would permanently brick every onlyBI
    // function for this contract instance's lifetime, with no recovery path.
    function testConstructorRejectsZeroBI() external {
        vm.expectRevert();
        new Agreement(address(0));
    }

    // --- propose ---

    function testProposeSetsPendingState() external {
        Agreement a = _proposed("trade-1");
        Agreement.Trade memory t = a.getAgreement("trade-1");
        assert(uint8(t.state) == uint8(Agreement.State.PROPOSED));
        assert(t.legs.length == 2);
        assert(t.legs[0].asset == bondToken);
        assert(t.proposer == bank1);
    }

    function testProposeDuplicateOnSameContractReverts() external {
        Agreement a = _proposed("trade-1");
        vm.prank(bank1);
        vm.expectRevert();
        a.propose("trade-1", productType, _twoLegs());
    }

    // --- accept ---

    function testAcceptByProposerReverts() external {
        Agreement a = _proposed("trade-1");
        vm.prank(bank1);
        vm.expectRevert();
        a.accept("trade-1");
    }

    function testAcceptByNonPartyReverts() external {
        Agreement a = _proposed("trade-1");
        vm.prank(stranger);
        vm.expectRevert();
        a.accept("trade-1");
    }

    function testAcceptByCounterpartySucceeds() external {
        Agreement a = _accepted("trade-1");
        Agreement.Trade memory t = a.getAgreement("trade-1");
        assert(uint8(t.state) == uint8(Agreement.State.ACCEPTED));
    }

    // --- recordLeg ---

    function testRecordLegBeforeAcceptReverts() external {
        Agreement a = _proposed("trade-1");
        vm.prank(bank1);
        vm.expectRevert();
        a.recordLeg("trade-1", 0, keccak256("lock0"), keccak256("prepared0"), "unlock0", "cancel0");
    }

    function testRecordLegByNonOwnerReverts() external {
        Agreement a = _accepted("trade-1");
        vm.prank(bank2); // leg 0's owner is bank1, not bank2
        vm.expectRevert();
        a.recordLeg("trade-1", 0, keccak256("lock0"), keccak256("prepared0"), "unlock0", "cancel0");
    }

    function testRecordLegOutOfRangeReverts() external {
        Agreement a = _accepted("trade-1");
        vm.prank(bank1);
        vm.expectRevert();
        a.recordLeg("trade-1", 2, keccak256("lock0"), keccak256("prepared0"), "unlock0", "cancel0");
    }

    // Solidity-auditor fix (2026-10-05, 9 of 12 agents, FINDING "sentinel-desync-dos" et al):
    // a zero preparedStateId used to pass the one-shot guard (keyed on unlockCall.length) while
    // never counting as prepared (allPrepared is keyed on preparedStateId), permanently
    // stranding the trade in ACCEPTED. Now rejected outright.
    function testRecordLegZeroPreparedStateIdReverts() external {
        Agreement a = _accepted("trade-1");
        vm.prank(bank1);
        vm.expectRevert();
        a.recordLeg("trade-1", 0, keccak256("lock0"), bytes32(0), "unlock0", "cancel0");
    }

    // Inverse of the above: an empty unlockCall used to leave the one-shot guard permanently
    // open (same legIndex re-submittable indefinitely), contradicting the "recorded once, by
    // construction" invariant. Now rejected outright.
    function testRecordLegEmptyUnlockCallReverts() external {
        Agreement a = _accepted("trade-1");
        vm.prank(bank1);
        vm.expectRevert();
        a.recordLeg("trade-1", 0, keccak256("lock0"), keccak256("prepared0"), "", "cancel0");
    }

    function testRecordLegAdvancesOnlyOnceAllLegsPrepared() external {
        Agreement a = _accepted("trade-1");
        vm.prank(bank1);
        a.recordLeg("trade-1", 0, keccak256("lock0"), keccak256("prepared0"), "unlock0", "cancel0");
        Agreement.Trade memory mid = a.getAgreement("trade-1");
        assert(uint8(mid.state) == uint8(Agreement.State.ACCEPTED)); // not yet LEGS_PREPARED

        vm.prank(bank2);
        a.recordLeg("trade-1", 1, keccak256("lock1"), keccak256("prepared1"), "unlock1", "cancel1");
        Agreement.Trade memory done = a.getAgreement("trade-1");
        assert(uint8(done.state) == uint8(Agreement.State.LEGS_PREPARED));
        assert(done.legs[0].lockId == keccak256("lock0"));
        assert(done.legs[1].cancelCall.length > 0);
    }

    // --- recordAtom ---

    function testRecordAtomByNonBIReverts() external {
        Agreement a = _legsPrepared("trade-1");
        vm.prank(bank1);
        vm.expectRevert();
        a.recordAtom("trade-1", atomStandIn);
    }

    function testRecordAtomBeforeLegsPreparedReverts() external {
        Agreement a = _accepted("trade-1");
        vm.prank(bi);
        vm.expectRevert();
        a.recordAtom("trade-1", atomStandIn);
    }

    function testRecordAtomSucceeds() external {
        Agreement a = _atomCreated("trade-1");
        Agreement.Trade memory t = a.getAgreement("trade-1");
        assert(uint8(t.state) == uint8(Agreement.State.ATOM_CREATED));
        assert(t.atomAddress == atomStandIn);
    }

    // --- confirmSettled / markFailed ---

    function testConfirmSettledByNonBIReverts() external {
        Agreement a = _atomCreated("trade-1");
        vm.prank(bank1);
        vm.expectRevert();
        a.confirmSettled("trade-1");
    }

    function testConfirmSettledSucceeds() external {
        Agreement a = _atomCreated("trade-1");
        vm.prank(bi);
        a.confirmSettled("trade-1");
        Agreement.Trade memory t = a.getAgreement("trade-1");
        assert(uint8(t.state) == uint8(Agreement.State.SETTLED));
    }

    function testMarkFailedSucceeds() external {
        Agreement a = _atomCreated("trade-1");
        vm.prank(bi);
        a.markFailed("trade-1");
        Agreement.Trade memory t = a.getAgreement("trade-1");
        assert(uint8(t.state) == uint8(Agreement.State.FAILED));
    }

    function testMarkFailedBeforeAtomCreatedReverts() external {
        Agreement a = _legsPrepared("trade-1");
        vm.prank(bi);
        vm.expectRevert();
        a.markFailed("trade-1");
    }

    // --- cancel ---

    function testCancelByLegPartyWhileProposedSucceeds() external {
        Agreement a = _proposed("trade-1");
        vm.prank(bank1);
        a.cancel("trade-1");
        Agreement.Trade memory t = a.getAgreement("trade-1");
        assert(uint8(t.state) == uint8(Agreement.State.CANCELLED));
    }

    function testCancelByBIWhileLegsPreparedSucceeds() external {
        Agreement a = _legsPrepared("trade-1");
        vm.prank(bi);
        a.cancel("trade-1");
        Agreement.Trade memory t = a.getAgreement("trade-1");
        assert(uint8(t.state) == uint8(Agreement.State.CANCELLED));
    }

    function testCancelByNonPartyNonBIReverts() external {
        Agreement a = _proposed("trade-1");
        vm.prank(stranger);
        vm.expectRevert();
        a.cancel("trade-1");
    }

    function testCancelAfterAtomCreatedReverts() external {
        Agreement a = _atomCreated("trade-1");
        vm.prank(bi);
        vm.expectRevert();
        a.cancel("trade-1");
    }

    // --- getAgreement ---

    function testGetAgreementUnknownTradeReverts() external {
        Agreement a = _freshAgreement();
        vm.expectRevert();
        a.getAgreement("no-such-trade");
    }

    // --- audit fix regressions (solidity-auditor, 2026-10-05) ---

    // 6 of 12 audit agents independently found the same bug: recordLeg's old state guard
    // accepted LEGS_PREPARED too, letting a leg owner overwrite an already-prepared leg
    // (desyncing trade.state from the real per-leg data) after BI may have already verified
    // it. Fixed by narrowing the guard to ACCEPTED only -- this must now revert.
    function testRecordLegCannotOverwriteAfterLegsPrepared() external {
        Agreement a = _legsPrepared("trade-1");
        vm.prank(bank1);
        vm.expectRevert();
        a.recordLeg("trade-1", 0, keccak256("new-lock0"), bytes32(0), "new-unlock0", "new-cancel0");
    }

    // Agent 9 (boundary) FINDING: propose() had no check that msg.sender is a party to any
    // leg, letting any privacy-group member squat a tradeId with bogus/empty legs.
    function testProposeByNonPartyReverts() external {
        Agreement a = _freshAgreement();
        vm.prank(stranger);
        vm.expectRevert();
        a.propose("trade-1", productType, _twoLegs());
    }

    // Same fix also closes the empty-legs lockout LEAD (agents 7/9/11): no address can be "a
    // party" of zero legs, so propose() with legs=[] now reverts for everyone instead of
    // silently creating a trade nobody but BI could ever cancel.
    function testProposeWithEmptyLegsReverts() external {
        Agreement a = _freshAgreement();
        Agreement.LegProposal[] memory empty = new Agreement.LegProposal[](0);
        vm.prank(bank1);
        vm.expectRevert();
        a.propose("trade-1", productType, empty);
    }

    // Solidity-auditor fix (2026-10-05, agents 2/7/12, FINDING "tradeid-squat(ting)-dos" et
    // al): a self-dealing leg (from == to) trivially satisfies the "caller is a leg party"
    // check, letting any privacy-group member squat a victim's tradeId permanently (no
    // function ever resets a tradeId back to State.NONE). Now rejected outright.
    function testProposeWithSelfDealingLegReverts() external {
        Agreement a = _freshAgreement();
        Agreement.LegProposal[] memory legs = new Agreement.LegProposal[](1);
        legs[0] = Agreement.LegProposal({asset: bondToken, from: stranger, to: stranger, amount: 0});
        vm.prank(stranger);
        vm.expectRevert();
        a.propose("trade-1", productType, legs);
    }

    // Solidity-auditor fix (2026-10-05, agents 4/6, FINDING "unbounded-array-gas-dos" et al):
    // propose() had no cap on legs.length, letting a proposer size a trade such that every
    // later accept()/cancel()/recordLeg() call (each an O(legs.length) scan) becomes
    // disproportionately expensive for every other party. MAX_LEGS caps this.
    function testProposeAboveMaxLegsReverts() external {
        Agreement a = _freshAgreement();
        Agreement.LegProposal[] memory legs = new Agreement.LegProposal[](a.MAX_LEGS() + 1);
        for (uint256 i = 0; i < legs.length; i++) {
            legs[i] = Agreement.LegProposal({asset: bondToken, from: bank1, to: bank2, amount: 1});
        }
        vm.prank(bank1);
        vm.expectRevert();
        a.propose("trade-1", productType, legs);
    }

    // Lead decision (2026-10-05): the Agreement.cancel() gap (it can never release a delegated
    // leg, since this contract is never a Noto lock's spender) is closed by ORDER, not by a new
    // contract function -- recordAtom must run before any leg delegates, so every delegation
    // happens strictly inside ATOM_CREATED, where cancel() is already unreachable. This test
    // documents and locks in the invariant the whole reorder relies on: once recordAtom has
    // run (the point after which a real backend would start delegating), cancel() is gone.
    function testCancelUnreachableAfterRecordAtomSoDelegationWindowIsAlwaysSafe() external {
        Agreement a = _atomCreated("trade-1");
        // By the required order, no leg delegates until THIS point -- and cancel() is already
        // blocked here, so there is no window in which a delegated leg could be stranded by it.
        vm.prank(bank1);
        vm.expectRevert();
        a.cancel("trade-1");
        vm.prank(bi);
        vm.expectRevert();
        a.cancel("trade-1");
    }
}
