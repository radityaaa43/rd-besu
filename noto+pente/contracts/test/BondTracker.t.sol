// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {BondTracker} from "../src/BondTracker.sol";
import {INotoHooks} from "paladin-domains/interfaces/INotoHooks.sol";
import {InvestorList} from "paladin-private/InvestorList.sol";

// Same minimal inline cheatcode pattern as the other tests here -- no forge-std import.
// BondTracker is Pente-hosted in production, but every hook is a plain external function that
// takes `sender` explicitly, so it's directly callable in a bare forge test too -- no privacy
// group needed to exercise the hook logic itself (only the PenteExternalCall -> base-ledger
// side-effect requires Pente, which is why task #7's decisive test was a live proof, not this).
interface Vm {
    function expectRevert() external;
    function expectRevert(bytes calldata) external;
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

contract BondTrackerTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address issuer = vm.addr(1);
    address custodian = vm.addr(2);
    address publicTracker = vm.addr(3);
    address investor1 = vm.addr(4);

    bytes32 constant PENTE_EXTERNAL_CALL_TOPIC = keccak256("PenteExternalCall(address,bytes)");

    INotoHooks.PreparedTransaction empty =
        INotoHooks.PreparedTransaction({contractAddress: address(0), encodedCall: ""});

    function _fresh() internal returns (BondTracker) {
        vm.prank(issuer);
        return new BondTracker("REOPENBOND", "RPB", custodian, publicTracker);
    }

    // One-recipient helper for the tests below.
    function _one(address to, uint256 amount)
        internal
        view
        returns (INotoHooks.UnlockRecipient[] memory r)
    {
        r = new INotoHooks.UnlockRecipient[](1);
        r[0] = INotoHooks.UnlockRecipient({to: to, amount: amount});
    }

    // Decodes the LAST PenteExternalCall log addressed to `to`, or reverts if none found.
    function _lastExternalCallTo(Vm.Log[] memory logs, address to) internal pure returns (bytes memory) {
        for (uint256 i = logs.length; i > 0; i--) {
            Vm.Log memory log = logs[i - 1];
            if (log.topics.length > 0 && log.topics[0] == PENTE_EXTERNAL_CALL_TOPIC) {
                address contractAddress = address(uint160(uint256(log.topics[1])));
                if (contractAddress == to) {
                    return abi.decode(log.data, (bytes));
                }
            }
        }
        revert("no PenteExternalCall to that address found");
    }

    function testOnUnlockExecutionNotifiesPublicTrackerWhenCustodianDistributes() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1);
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);

        bytes32 lockId = keccak256("lock1");
        vm.prank(custodian);
        t.onLock(custodian, lockId, custodian, 1000, "", empty);

        INotoHooks.UnlockRecipient[] memory recipients = new INotoHooks.UnlockRecipient[](1);
        recipients[0] = INotoHooks.UnlockRecipient({to: investor1, amount: 1000});

        // BACKLOG #6 (D36): settle keys off the prepare-time round stamp -- prepare first,
        // matching the real lock -> prepare -> unlock flow.
        vm.prank(custodian);
        t.onPrepareUnlock(custodian, lockId, recipients, "", empty);

        vm.recordLogs();
        vm.prank(custodian);
        t.onUnlock(custodian, lockId, recipients, "", empty);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes memory encodedCall = _lastExternalCallTo(logs, publicTracker);
        assert(
            keccak256(encodedCall) == keccak256(abi.encodeWithSignature("onDistribute(uint256)", uint256(1000)))
        );
        assert(t.balanceOf(investor1) == 1000);
        assert(t.balanceOf(custodian) == 0);
    }

    // The bug: onBurn was never overridden, so BondTrackerPublic's totalSupply never learned
    // about redemptions (it only ever grew via onIssue). Proves the private tracker notifies
    // the public tracker on burn, AND that the private tracker's own totalSupply() still
    // decrements correctly (sanity check nothing regressed in the inherited _onBurn/_burn path).
    function testOnBurnNotifiesPublicTrackerAndDecrementsSupply() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        assert(t.totalSupply() == 1000);

        vm.recordLogs();
        vm.prank(custodian);
        t.onBurn(custodian, custodian, 400, "", empty);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes memory encodedCall = _lastExternalCallTo(logs, publicTracker);
        assert(
            keccak256(encodedCall) == keccak256(abi.encodeWithSignature("onBurn(uint256)", uint256(400)))
        );
        assert(t.balanceOf(custodian) == 600);
        assert(t.totalSupply() == 600); // private tracker's own ERC20 totalSupply also decremented
    }

    // Regression guard: onBurn's inherited onlySelf(sender, from) gate must still hold -- only
    // the token holder itself (sender == from) may burn its own balance.
    function testOnBurnByNonHolderReverts() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);

        vm.prank(investor1);
        vm.expectRevert();
        t.onBurn(investor1, custodian, 1000, "", empty);
    }

    // Lead decision (task #6b): a recipient == _custodian (e.g. a refund alongside a real sale
    // in the same unlock) must not count toward the sale total.
    function testOnUnlockExcludesCustodianRecipientFromSaleTotal() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1);
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);
        vm.prank(custodian);
        investorList.addInvestor(custodian); // custodian must itself be registered to receive a refund

        bytes32 lockId = keccak256("lockRefund");
        vm.prank(custodian);
        t.onLock(custodian, lockId, custodian, 1000, "", empty);

        INotoHooks.UnlockRecipient[] memory recipients = new INotoHooks.UnlockRecipient[](2);
        recipients[0] = INotoHooks.UnlockRecipient({to: investor1, amount: 700});
        recipients[1] = INotoHooks.UnlockRecipient({to: custodian, amount: 300}); // refund, not a sale

        // BACKLOG #6 (D36): settle keys off the prepare-time round stamp -- prepare first,
        // matching the real lock -> prepare -> unlock flow.
        vm.prank(custodian);
        t.onPrepareUnlock(custodian, lockId, recipients, "", empty);

        vm.recordLogs();
        vm.prank(custodian);
        t.onUnlock(custodian, lockId, recipients, "", empty);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes memory encodedCall = _lastExternalCallTo(logs, publicTracker);
        assert(
            keccak256(encodedCall) == keccak256(abi.encodeWithSignature("onDistribute(uint256)", uint256(700)))
        );
        assert(t.balanceOf(investor1) == 700);
        assert(t.balanceOf(custodian) == 300);
    }

    function testOnUnlockDoesNotNotifyWhenNotCustodianOriginated() external {
        BondTracker t = _fresh();

        // investor1 receives units directly via mint (not through the custodian), then locks
        // and unlocks their OWN tokens to a third party -- this must never look like a sale.
        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1);
        address investor2 = vm.addr(5);
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);
        vm.prank(custodian);
        investorList.addInvestor(investor2);
        bytes32 custodianLockId = keccak256("lockC");
        vm.prank(custodian);
        t.onLock(custodian, custodianLockId, custodian, 1000, "", empty);
        INotoHooks.UnlockRecipient[] memory toInvestor1 = new INotoHooks.UnlockRecipient[](1);
        toInvestor1[0] = INotoHooks.UnlockRecipient({to: investor1, amount: 1000});
        vm.prank(custodian);
        t.onUnlock(custodian, custodianLockId, toInvestor1, "", empty);

        bytes32 investorLockId = keccak256("lockInv1");
        vm.prank(investor1);
        t.onLock(investor1, investorLockId, investor1, 400, "", empty);
        INotoHooks.UnlockRecipient[] memory toInvestor2 = new INotoHooks.UnlockRecipient[](1);
        toInvestor2[0] = INotoHooks.UnlockRecipient({to: investor2, amount: 400});

        vm.recordLogs();
        vm.prank(investor1);
        t.onUnlock(investor1, investorLockId, toInvestor2, "", empty);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bool foundNotifyToPublicTracker = false;
        for (uint256 i = 0; i < logs.length; i++) {
            if (
                logs[i].topics.length > 0 &&
                logs[i].topics[0] == PENTE_EXTERNAL_CALL_TOPIC &&
                address(uint160(uint256(logs[i].topics[1]))) == publicTracker
            ) {
                foundNotifyToPublicTracker = true;
            }
        }
        assert(!foundNotifyToPublicTracker);
        assert(t.balanceOf(investor2) == 400);
    }

    function testOnPrepareUnlockDoesNotNotifyPublicTracker() external {
        BondTracker t = _fresh();
        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1);
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);
        bytes32 lockId = keccak256("lockPrep");
        vm.prank(custodian);
        t.onLock(custodian, lockId, custodian, 1000, "", empty);

        INotoHooks.UnlockRecipient[] memory recipients = new INotoHooks.UnlockRecipient[](1);
        recipients[0] = INotoHooks.UnlockRecipient({to: investor1, amount: 1000});

        vm.recordLogs();
        vm.prank(custodian);
        t.onPrepareUnlock(custodian, lockId, recipients, "", empty);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == PENTE_EXTERNAL_CALL_TOPIC) {
                address contractAddress = address(uint160(uint256(logs[i].topics[1])));
                assert(contractAddress != publicTracker);
            }
        }
        // A prepared-but-never-executed unlock must not move the balance either.
        assert(t.balanceOf(investor1) == 0);
    }

    // The real production distribution path (BondSubscription.distribute() -> AtomFactory ->
    // Atom.execute()) is a DELEGATE executing an already-prepared unlock, which Noto's domain
    // code dispatches to handleDelegateUnlock, never onUnlock -- confirmed by reading
    // domains/noto/internal/noto/events.go's handleNotaryPrivateUnlock. This is the decisive
    // test: without the fix here, this test fails even though testOnUnlockExecution... above
    // passes, because real distribution never goes through onUnlock directly.
    function testHandleDelegateUnlockNotifiesPublicTrackerOnRealDvPPath() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1);
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);

        bytes32 lockId = keccak256("delegateLock1");
        vm.prank(custodian);
        t.onLock(custodian, lockId, custodian, 1000, "", empty);

        INotoHooks.UnlockRecipient[] memory recipients = new INotoHooks.UnlockRecipient[](1);
        recipients[0] = INotoHooks.UnlockRecipient({to: investor1, amount: 1000});
        vm.prank(custodian);
        t.onPrepareUnlock(custodian, lockId, recipients, "", empty);

        // Simulates Noto's domain code invoking this after the delegate (the Atom) has executed
        // the prepared unlock on the base ledger. D21: the hook tx is submitted by the
        // deployer (issuer), and handleDelegateUnlock now gates on exactly that.
        vm.recordLogs();
        vm.prank(issuer);
        t.handleDelegateUnlock(custodian, lockId, recipients, "");
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes memory encodedCall = _lastExternalCallTo(logs, publicTracker);
        assert(
            keccak256(encodedCall) == keccak256(abi.encodeWithSignature("onDistribute(uint256)", uint256(1000)))
        );
        assert(t.balanceOf(investor1) == 1000);
        assert(t.balanceOf(custodian) == 0);
    }

    function testHandleDelegateUnlockDoesNotNotifyWhenNotCustodianOriginated() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1);
        address investor2 = vm.addr(5);
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);
        vm.prank(custodian);
        investorList.addInvestor(investor2);

        bytes32 custodianLockId = keccak256("delegateLockC");
        vm.prank(custodian);
        t.onLock(custodian, custodianLockId, custodian, 1000, "", empty);
        INotoHooks.UnlockRecipient[] memory toInvestor1 = new INotoHooks.UnlockRecipient[](1);
        toInvestor1[0] = INotoHooks.UnlockRecipient({to: investor1, amount: 1000});
        vm.prank(custodian);
        t.onPrepareUnlock(custodian, custodianLockId, toInvestor1, "", empty);
        vm.prank(issuer); // D21: handleDelegateUnlock is deployer-gated.
        t.handleDelegateUnlock(custodian, custodianLockId, toInvestor1, "");

        bytes32 investorLockId = keccak256("delegateLockInv1");
        vm.prank(investor1);
        t.onLock(investor1, investorLockId, investor1, 1000, "", empty);
        INotoHooks.UnlockRecipient[] memory toInvestor2 = new INotoHooks.UnlockRecipient[](1);
        toInvestor2[0] = INotoHooks.UnlockRecipient({to: investor2, amount: 300});
        vm.prank(investor1);
        t.onPrepareUnlock(investor1, investorLockId, toInvestor2, "", empty);

        vm.recordLogs();
        vm.prank(issuer); // D21: handleDelegateUnlock is deployer-gated.
        t.handleDelegateUnlock(investor1, investorLockId, toInvestor2, "");
        Vm.Log[] memory logs = vm.getRecordedLogs();

        for (uint256 i = 0; i < logs.length; i++) {
            if (
                logs[i].topics.length > 0 &&
                logs[i].topics[0] == PENTE_EXTERNAL_CALL_TOPIC &&
                address(uint160(uint256(logs[i].topics[1]))) == publicTracker
            ) {
                assert(false); // must not notify -- investor1's own unlock is not a custodian sale.
            }
        }
        assert(t.balanceOf(investor2) == 300);
    }

    // Task #20 regression: redemption's holder->custodian leg must succeed even though the
    // custodian is never itself registered on its own series' investor list.
    function testOnTransferToCustodianSucceedsWithoutRegistration() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);

        vm.prank(custodian);
        t.onTransfer(custodian, custodian, investor1, 1000, "", empty);

        vm.prank(investor1);
        t.onTransfer(investor1, investor1, custodian, 1000, "", empty); // custodian never registered

        assert(t.balanceOf(custodian) == 1000);
        assert(t.balanceOf(investor1) == 0);
    }

    // Post-fix auditor delta (solidity-auditor, 11/12 agents): before today's custodian
    // exemption, a custodian self-transfer during an active distribution could never reach
    // onTransfer's sale-notification check at all, because `to` (the custodian) wasn't
    // registered -- the whitelist bug accidentally blocked it. Now that to==_custodian is
    // exempt, a pure self-transfer (net balance unchanged) must NOT be reported to the public
    // tracker as a sale, mirroring onUnlock's existing to!=_custodian exclusion.
    function testOnTransferSelfTransferDuringDistributionDoesNotNotifyPublicTracker() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1);

        vm.recordLogs();
        vm.prank(custodian);
        t.onTransfer(custodian, custodian, custodian, 1000, "", empty); // self-transfer, not a sale
        Vm.Log[] memory logs = vm.getRecordedLogs();

        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == PENTE_EXTERNAL_CALL_TOPIC) {
                address contractAddress = address(uint160(uint256(logs[i].topics[1])));
                assert(contractAddress != publicTracker); // no onDistribute notification at all
            }
        }
        assert(t.balanceOf(custodian) == 1000);
    }

    // Task #20 regression: BI's releaseLock-to-self (recipient == custodian) must succeed even
    // though the custodian is never itself registered on its own series' investor list.
    function testOnUnlockToCustodianSucceedsWithoutRegistration() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1);

        bytes32 lockId = keccak256("lockSelfRelease");
        vm.prank(custodian);
        t.onLock(custodian, lockId, custodian, 1000, "", empty);

        INotoHooks.UnlockRecipient[] memory recipients = new INotoHooks.UnlockRecipient[](1);
        recipients[0] = INotoHooks.UnlockRecipient({to: custodian, amount: 1000});

        vm.prank(custodian);
        t.onUnlock(custodian, lockId, recipients, "", empty); // custodian never registered

        assert(t.balanceOf(custodian) == 1000);
    }

    // Same as above for the prepare-unlock path.
    function testOnPrepareUnlockToCustodianSucceedsWithoutRegistration() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1);

        bytes32 lockId = keccak256("lockPrepSelfRelease");
        vm.prank(custodian);
        t.onLock(custodian, lockId, custodian, 1000, "", empty);

        INotoHooks.UnlockRecipient[] memory recipients = new INotoHooks.UnlockRecipient[](1);
        recipients[0] = INotoHooks.UnlockRecipient({to: custodian, amount: 1000});

        vm.prank(custodian);
        t.onPrepareUnlock(custodian, lockId, recipients, "", empty); // custodian never registered

        assert(t.balanceOf(custodian) == 1000); // prepare never moves balance
    }

    // Regression guard: the fix is scoped to `to == _custodian` only -- every other
    // unregistered recipient must still be rejected by the real whitelist check.
    function testOnTransferToUnregisteredNonCustodianStillReverts() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        address unregistered = vm.addr(6);

        vm.prank(custodian);
        vm.expectRevert();
        t.onTransfer(custodian, custodian, unregistered, 1000, "", empty);
    }

    function testOnUnlockToUnregisteredNonCustodianStillReverts() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1);

        bytes32 lockId = keccak256("lockUnregisteredRecipient");
        vm.prank(custodian);
        t.onLock(custodian, lockId, custodian, 1000, "", empty);

        address unregistered = vm.addr(6);
        INotoHooks.UnlockRecipient[] memory recipients = new INotoHooks.UnlockRecipient[](1);
        recipients[0] = INotoHooks.UnlockRecipient({to: unregistered, amount: 1000});

        vm.prank(custodian);
        vm.expectRevert();
        t.onUnlock(custodian, lockId, recipients, "", empty);
    }

    function testOnPrepareUnlockToUnregisteredNonCustodianStillReverts() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1);

        bytes32 lockId = keccak256("lockPrepUnregisteredRecipient");
        vm.prank(custodian);
        t.onLock(custodian, lockId, custodian, 1000, "", empty);

        address unregistered = vm.addr(6);
        INotoHooks.UnlockRecipient[] memory recipients = new INotoHooks.UnlockRecipient[](1);
        recipients[0] = INotoHooks.UnlockRecipient({to: unregistered, amount: 1000});

        vm.prank(custodian);
        vm.expectRevert();
        t.onPrepareUnlock(custodian, lockId, recipients, "", empty);
    }

    // Bug #1 fix: onCreateTransferLock must run the same whitelist check onPrepareUnlock does --
    // a transfer lock to a registered investor succeeds.
    function testOnCreateTransferLockToRegisteredInvestorSucceeds() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);

        bytes32 lockId = keccak256("createTransferLock1");
        INotoHooks.UnlockRecipient[] memory recipients = new INotoHooks.UnlockRecipient[](1);
        recipients[0] = INotoHooks.UnlockRecipient({to: investor1, amount: 1000});

        vm.prank(custodian);
        t.onCreateTransferLock(custodian, lockId, custodian, 1000, recipients, "", empty);

        // Prepare-only: balance must not move yet.
        assert(t.balanceOf(custodian) == 1000);
        assert(t.balanceOf(investor1) == 0);
    }

    // Task #20's custodian exemption must also cover this hook -- the custodian is never itself
    // registered on its own series' investor list.
    function testOnCreateTransferLockToCustodianSucceedsWithoutRegistration() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);

        bytes32 lockId = keccak256("createTransferLockSelf");
        INotoHooks.UnlockRecipient[] memory recipients = new INotoHooks.UnlockRecipient[](1);
        recipients[0] = INotoHooks.UnlockRecipient({to: custodian, amount: 1000}); // never registered

        vm.prank(custodian);
        t.onCreateTransferLock(custodian, lockId, custodian, 1000, recipients, "", empty);

        assert(t.balanceOf(custodian) == 1000); // prepare never moves balance
    }

    // Bug #1 regression guard: this is the exact bypass the lead found -- before the fix,
    // onCreateTransferLock fell through to upstream's default, which skips the whitelist
    // entirely. A transfer lock to a genuinely unregistered, non-custodian address must revert.
    function testOnCreateTransferLockToUnregisteredNonCustodianReverts() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);

        bytes32 lockId = keccak256("createTransferLockUnregistered");
        address unregistered = vm.addr(6);
        INotoHooks.UnlockRecipient[] memory recipients = new INotoHooks.UnlockRecipient[](1);
        recipients[0] = INotoHooks.UnlockRecipient({to: unregistered, amount: 1000});

        vm.prank(custodian);
        vm.expectRevert();
        t.onCreateTransferLock(custodian, lockId, custodian, 1000, recipients, "", empty);
    }

    // BACKLOG #5: onCreateTransferLock must run the same Task #24 sale check onPrepareUnlock
    // runs -- a custodian-originated transfer-lock during an open round with a valid
    // quantity/denomination succeeds (prepare-only, no balance moves yet).
    function testOnCreateTransferLockFromCustodianDuringDistributionSucceeds() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1);
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);

        bytes32 lockId = keccak256("createTransferLockSale");
        vm.prank(custodian);
        t.onCreateTransferLock(custodian, lockId, custodian, 400, _one(investor1, 400), "", empty);

        // Prepare-only: balance must not move yet, and the mirror must not have decremented.
        assert(t.balanceOf(custodian) == 1000);
        assert(t.balanceOf(investor1) == 0);
        assert(t.availableUnitsPrivate() == 1000);
    }

    // BACKLOG #5, negative #1: a quantity above this round's available units must revert at
    // lock creation, mirroring onPrepareUnlock's Task #24 gate.
    function testOnCreateTransferLockExceedingAvailableUnitsReverts() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1);
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);

        bytes32 lockId = keccak256("createTransferLockTooMuch");
        vm.prank(custodian);
        vm.expectRevert(bytes("Sale would exceed this round's available units"));
        t.onCreateTransferLock(custodian, lockId, custodian, 1001, _one(investor1, 1001), "", empty);

        // Nothing locked by the reverted attempt.
        assert(t.balanceOf(custodian) == 1000);
        assert(t.availableUnitsPrivate() == 1000);
    }

    // BACKLOG #5, negative #2: a quantity whose price doesn't divide evenly into
    // minimumDenomination must also revert at lock creation, mirroring onPrepareUnlock.
    function testOnCreateTransferLockInvalidDenominationReverts() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(3, 2); // price 3, denom 2 -- quantity must be even
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);

        bytes32 lockId = keccak256("createTransferLockBadDenom");
        vm.prank(custodian);
        vm.expectRevert(bytes("Sale amount is not a valid denomination multiple"));
        t.onCreateTransferLock(custodian, lockId, custodian, 1, _one(investor1, 1), "", empty); // 1*3 % 2 != 0

        assert(t.balanceOf(custodian) == 1000);
        assert(t.availableUnitsPrivate() == 1000);
    }

    // V1 lock-hook audit fix: onCreateMintLock must only ever target the custodian, same rule
    // onMint already enforces.
    function testOnCreateMintLockToCustodianSucceeds() external {
        BondTracker t = _fresh();

        bytes32 lockId = keccak256("createMintLock1");
        INotoHooks.UnlockRecipient[] memory recipients = new INotoHooks.UnlockRecipient[](1);
        recipients[0] = INotoHooks.UnlockRecipient({to: custodian, amount: 1000});

        vm.prank(issuer);
        t.onCreateMintLock(issuer, lockId, recipients, "", empty);

        // Prepare-only: nothing has actually been minted yet.
        assert(t.balanceOf(custodian) == 0);
    }

    // Regression guard: a mint-lock recipient that isn't the custodian must revert, mirroring
    // onMint's own require(to == _custodian, ...).
    function testOnCreateMintLockToNonCustodianReverts() external {
        BondTracker t = _fresh();

        bytes32 lockId = keccak256("createMintLockBadRecipient");
        INotoHooks.UnlockRecipient[] memory recipients = new INotoHooks.UnlockRecipient[](1);
        recipients[0] = INotoHooks.UnlockRecipient({to: investor1, amount: 1000});

        vm.prank(issuer);
        vm.expectRevert();
        t.onCreateMintLock(issuer, lockId, recipients, "", empty);
    }

    // Same reasoning as onCreateMintLock, for the matching onPrepareMintUnlock step.
    function testOnPrepareMintUnlockToCustodianSucceeds() external {
        BondTracker t = _fresh();

        bytes32 lockId = keccak256("prepareMintUnlock1");
        INotoHooks.UnlockRecipient[] memory recipients = new INotoHooks.UnlockRecipient[](1);
        recipients[0] = INotoHooks.UnlockRecipient({to: custodian, amount: 1000});

        vm.prank(issuer);
        t.onPrepareMintUnlock(issuer, lockId, recipients, "", empty);

        assert(t.balanceOf(custodian) == 0);
    }

    function testOnPrepareMintUnlockToNonCustodianReverts() external {
        BondTracker t = _fresh();

        bytes32 lockId = keccak256("prepareMintUnlockBadRecipient");
        INotoHooks.UnlockRecipient[] memory recipients = new INotoHooks.UnlockRecipient[](1);
        recipients[0] = INotoHooks.UnlockRecipient({to: investor1, amount: 1000});

        vm.prank(issuer);
        vm.expectRevert();
        t.onPrepareMintUnlock(issuer, lockId, recipients, "", empty);
    }

    // Task #24 fund-safety fix: a custodian-originated sale that would exceed this round's
    // available units must revert at onPrepareUnlock -- BEFORE a lock is ever prepared --
    // instead of surfacing only at settlement (see BondTracker.sol's new _checkSaleAllowed).
    function testOnPrepareUnlockExceedingAvailableUnitsReverts() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1);
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);

        bytes32 lockId = keccak256("lockExceedUnits");
        vm.prank(custodian);
        t.onLock(custodian, lockId, custodian, 1000, "", empty);

        INotoHooks.UnlockRecipient[] memory tooMuch = new INotoHooks.UnlockRecipient[](1);
        tooMuch[0] = INotoHooks.UnlockRecipient({to: investor1, amount: 1001}); // > 1000 available

        vm.prank(custodian);
        vm.expectRevert();
        t.onPrepareUnlock(custodian, lockId, tooMuch, "", empty);

        // Nothing moved from the reverted attempt.
        assert(t.balanceOf(custodian) == 1000);
        assert(t.balanceOf(investor1) == 0);

        // The SAME lock, prepared correctly afterward, must settle for exactly the valid
        // amount -- proving the reverted attempt left no residual prepared-state behind.
        INotoHooks.UnlockRecipient[] memory valid = new INotoHooks.UnlockRecipient[](1);
        valid[0] = INotoHooks.UnlockRecipient({to: investor1, amount: 1000});
        vm.prank(custodian);
        t.onPrepareUnlock(custodian, lockId, valid, "", empty);
        vm.prank(issuer); // D21: handleDelegateUnlock is deployer-gated.
        t.handleDelegateUnlock(custodian, lockId, valid, "");

        assert(t.balanceOf(investor1) == 1000);
        assert(t.balanceOf(custodian) == 0);
        assert(t.availableUnitsPrivate() == 0);
    }

    // Task #24: a sale quantity whose price doesn't divide evenly into minimumDenomination must
    // also revert at onPrepareUnlock, mirroring TokenDistribution.getPrice's own revert rule.
    function testOnPrepareUnlockInvalidDenominationReverts() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(3, 2); // price 3, denom 2 -- quantity must be even
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);

        bytes32 lockId = keccak256("lockBadDenom");
        vm.prank(custodian);
        t.onLock(custodian, lockId, custodian, 1000, "", empty);

        INotoHooks.UnlockRecipient[] memory badDenom = new INotoHooks.UnlockRecipient[](1);
        badDenom[0] = INotoHooks.UnlockRecipient({to: investor1, amount: 1}); // 1*3 % 2 != 0

        vm.prank(custodian);
        vm.expectRevert();
        t.onPrepareUnlock(custodian, lockId, badDenom, "", empty);

        assert(t.balanceOf(custodian) == 1000);
        assert(t.balanceOf(investor1) == 0);

        // The SAME lock, prepared with a valid denomination multiple, settles cleanly.
        INotoHooks.UnlockRecipient[] memory valid = new INotoHooks.UnlockRecipient[](1);
        valid[0] = INotoHooks.UnlockRecipient({to: investor1, amount: 2}); // 2*3 % 2 == 0
        vm.prank(custodian);
        t.onPrepareUnlock(custodian, lockId, valid, "", empty);
        vm.prank(issuer); // D21: handleDelegateUnlock is deployer-gated.
        t.handleDelegateUnlock(custodian, lockId, valid, "");

        assert(t.balanceOf(investor1) == 2);
        assert(t.availableUnitsPrivate() == 998);
    }

    // Task #24: a valid quantity/denomination must pass onPrepareUnlock, and the full path
    // through to onUnlock must also settle without reverting -- confirming the mirror and the
    // real settlement agree.
    function testOnPrepareUnlockValidQuantityThenOnUnlockSucceeds() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1);
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);

        bytes32 lockId = keccak256("lockValidThenUnlock");
        vm.prank(custodian);
        t.onLock(custodian, lockId, custodian, 1000, "", empty);

        INotoHooks.UnlockRecipient[] memory recipients = new INotoHooks.UnlockRecipient[](1);
        recipients[0] = INotoHooks.UnlockRecipient({to: investor1, amount: 400});

        vm.prank(custodian);
        t.onPrepareUnlock(custodian, lockId, recipients, "", empty); // must not revert

        vm.prank(custodian);
        t.onUnlock(custodian, lockId, recipients, "", empty); // real settlement, must not revert

        assert(t.balanceOf(investor1) == 400);
        assert(t.balanceOf(custodian) == 600);
        assert(t.availableUnitsPrivate() == 600);
    }

    // Task #24: confirms the private mirror actually decrements after a real sale settles
    // (via the test-only availableUnitsPrivate() getter).
    function testAvailableUnitsPrivateDecrementsAfterSettlement() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1);
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);
        assert(t.availableUnitsPrivate() == 1000);

        bytes32 lockId = keccak256("lockDecrementCheck");
        vm.prank(custodian);
        t.onLock(custodian, lockId, custodian, 1000, "", empty);

        INotoHooks.UnlockRecipient[] memory recipients = new INotoHooks.UnlockRecipient[](1);
        recipients[0] = INotoHooks.UnlockRecipient({to: investor1, amount: 250});

        // BACKLOG #6 (D36): settle keys off the prepare-time round stamp -- prepare first,
        // matching the real lock -> prepare -> unlock flow.
        vm.prank(custodian);
        t.onPrepareUnlock(custodian, lockId, recipients, "", empty);

        vm.prank(custodian);
        t.onUnlock(custodian, lockId, recipients, "", empty);

        assert(t.availableUnitsPrivate() == 750);
    }

    // Task #24: sequential (not concurrent) sales -- a quantity that was fine BEFORE a prior
    // sale consumed units must revert AFTER it, proving the mirror tracks real cumulative
    // consumption across multiple sales in the same round, not just a single snapshot.
    function testOnPrepareUnlockRevertsAfterPriorSaleConsumedUnits() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1);
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);

        // First sale consumes 700, leaving 300 available.
        bytes32 lock1 = keccak256("lockSeq1");
        vm.prank(custodian);
        t.onLock(custodian, lock1, custodian, 1000, "", empty);
        INotoHooks.UnlockRecipient[] memory firstSale = new INotoHooks.UnlockRecipient[](1);
        firstSale[0] = INotoHooks.UnlockRecipient({to: investor1, amount: 700});
        // BACKLOG #6 (D36): settle keys off the prepare-time round stamp -- prepare first,
        // matching the real lock -> prepare -> unlock flow.
        vm.prank(custodian);
        t.onPrepareUnlock(custodian, lock1, firstSale, "", empty);
        vm.prank(custodian);
        t.onUnlock(custodian, lock1, firstSale, "", empty);
        assert(t.availableUnitsPrivate() == 300);

        // 800 was <= the ORIGINAL 1000 available units, but is no longer fine against the
        // 300 that remain.
        bytes32 lock2 = keccak256("lockSeq2");
        vm.prank(custodian);
        t.onLock(custodian, lock2, custodian, 800, "", empty);
        INotoHooks.UnlockRecipient[] memory secondSale = new INotoHooks.UnlockRecipient[](1);
        secondSale[0] = INotoHooks.UnlockRecipient({to: investor1, amount: 800});

        vm.prank(custodian);
        vm.expectRevert();
        t.onPrepareUnlock(custodian, lock2, secondSale, "", empty);
    }

    // Task #24 (lead-required regression guard): beginDistribution's mirror fields must be
    // plain overwrites (`=`), not accumulated, across tranches -- a reopened round's
    // _availableUnitsPrivate/_discountPrice/_minimumDenomination must reflect ONLY the new
    // tranche, never leftover values from a prior one.
    function testBeginDistributionResetsMirrorForNewTrancheNotAccumulated() external {
        BondTracker t = _fresh();

        // Tranche 1: amount A=1000, price P1=3, denom D1=2 (valid quantities are even).
        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(3, 2);
        assert(t.availableUnitsPrivate() == 1000);
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);

        // Partially sell tranche 1 so leftover units exist when the round closes.
        bytes32 lockT1 = keccak256("lockTranche1");
        vm.prank(custodian);
        t.onLock(custodian, lockT1, custodian, 1000, "", empty);
        INotoHooks.UnlockRecipient[] memory saleT1 = new INotoHooks.UnlockRecipient[](1);
        saleT1[0] = INotoHooks.UnlockRecipient({to: investor1, amount: 400}); // 400*3 % 2 == 0
        // BACKLOG #6 (D36): settle keys off the prepare-time round stamp -- prepare first,
        // matching the real lock -> prepare -> unlock flow.
        vm.prank(custodian);
        t.onPrepareUnlock(custodian, lockT1, saleT1, "", empty);
        vm.prank(custodian);
        t.onUnlock(custodian, lockT1, saleT1, "", empty);
        assert(t.availableUnitsPrivate() == 600); // 1000 - 400

        // Close out round 1 and reactivate, matching this file's reopening pattern.
        vm.prank(custodian);
        t.closeDistribution();
        vm.prank(issuer);
        t.setActive();

        // Tranche 2: DIFFERENT amount B=250 (!= A), DIFFERENT price P2=5 (!= P1), DIFFERENT
        // denom D2=3 (!= D1).
        vm.prank(issuer);
        t.onMint(issuer, custodian, 250, "", empty);
        vm.prank(custodian);
        t.beginDistribution(5, 3);

        // Mirror must reflect ONLY tranche 2 -- NOT accumulated with tranche 1's leftover
        // 600 units (600 + 250 = 850 would be the buggy accumulated value).
        assert(t.availableUnitsPrivate() == 250);

        // Denomination-sensitivity proof #1: quantity 3 is valid under the NEW P2=5/D2=3
        // (3*5=15, 15%3==0) -- must succeed.
        bytes32 lockValid = keccak256("lockTranche2Valid");
        vm.prank(custodian);
        t.onLock(custodian, lockValid, custodian, 250, "", empty);
        INotoHooks.UnlockRecipient[] memory validQty = new INotoHooks.UnlockRecipient[](1);
        validQty[0] = INotoHooks.UnlockRecipient({to: investor1, amount: 3});
        vm.prank(custodian);
        t.onPrepareUnlock(custodian, lockValid, validQty, "", empty); // must not revert

        // Denomination-sensitivity proof #2: quantity 2 WAS valid under the OLD P1=3/D1=2
        // (2*3=6, 6%2==0) but is INVALID under the NEW P2=5/D2=3 (2*5=10, 10%3!=0) -- proves
        // the stale tranche-1 price/denom are really gone, not merely unused.
        bytes32 lockInvalid = keccak256("lockTranche2Invalid");
        vm.prank(custodian);
        t.onLock(custodian, lockInvalid, custodian, 250, "", empty);
        INotoHooks.UnlockRecipient[] memory invalidQty = new INotoHooks.UnlockRecipient[](1);
        invalidQty[0] = INotoHooks.UnlockRecipient({to: investor1, amount: 2});
        vm.prank(custodian);
        vm.expectRevert();
        t.onPrepareUnlock(custodian, lockInvalid, invalidQty, "", empty);
    }

    // ------------------------------------------------------------------
    // Burn-on-reopen design note (BACKLOG Priority 1, items #3 + #4)
    // ------------------------------------------------------------------

    // Fix #3: forceCompleteDistribution must advance the PRIVATE _status to DISTRIBUTION_CLOSED
    // alongside the public PenteExternalCall, so the burn of the unsold remainder (fix #4's
    // gate) runs under a pre-close status the design note covers.
    function testForceCompleteDistributionAdvancesPrivateStatusToClosed() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1);
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);
        vm.prank(custodian);
        t.onLock(custodian, keccak256("saleLock"), custodian, 400, "", empty);
        vm.prank(custodian);
        t.onPrepareUnlock(custodian, keccak256("saleLock"), _one(investor1, 400), "", empty);
        vm.prank(issuer);
        t.handleDelegateUnlock(custodian, keccak256("saleLock"), _one(investor1, 400), "");

        vm.prank(custodian);
        t.forceCompleteDistribution();

        // closeDistribution is the only status() probe besides setActive (there's no getter for
        // the private _status) -- setActive reverts unless _status reached DISTRIBUTION_CLOSED,
        // so this succeeding proves fix #3 landed.
        vm.prank(custodian);
        t.closeDistribution();
        vm.prank(issuer);
        t.setActive(); // must not revert
    }

    // Negative: force-complete with no round active at all.
    function testForceCompleteDistributionRejectsWhenNoRoundInProgress() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        // No beginDistribution call -- still INITIALIZED/ISSUED.

        vm.prank(custodian);
        vm.expectRevert(bytes("No distribution round in progress"));
        t.forceCompleteDistribution();
    }

    // Fix #4 (lead-corrected gate, pre-close status #1): a burn during an OPEN round may only
    // retire the unsold remainder.
    function testBurnExceedingUnsoldRevertsInDistributionStarted() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1);

        vm.prank(custodian);
        vm.expectRevert(bytes("burn > unsold"));
        t.onBurn(custodian, custodian, 1001, "", empty); // unsold = 1000
    }

    // Fix #4 (lead-corrected gate, pre-close status #2 -- the lead's added hole test): the same
    // cap must still hold AFTER forceCompleteDistribution flipped the private side to
    // DISTRIBUTION_CLOSED.
    function testBurnExceedingUnsoldRevertsInDistributionClosed() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1);
        vm.prank(custodian);
        t.forceCompleteDistribution(); // private _status now DISTRIBUTION_CLOSED, unsold = 1000

        vm.prank(custodian);
        vm.expectRevert(bytes("burn > unsold"));
        t.onBurn(custodian, custodian, 1001, "", empty);
    }

    // Positive: the full burn-on-reopen flow -- forceComplete -> burn(unsold) -> close ->
    // setActive -> mintTranche -> beginDistribution. Custodian balance burned to 0 before the
    // new mint, totalSupply ends at sold + new tranche on both sides.
    function testBurnOnReopenFlowEndToEnd() external {
        BondTracker t = _fresh();

        // Tranche 1: mint 1000, sell 600 to investor1 (unsold 400).
        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1);
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);
        bytes32 lockId = keccak256("t1sale");
        vm.prank(custodian);
        t.onLock(custodian, lockId, custodian, 600, "", empty);
        vm.prank(custodian);
        t.onPrepareUnlock(custodian, lockId, _one(investor1, 600), "", empty);
        vm.prank(issuer);
        t.handleDelegateUnlock(custodian, lockId, _one(investor1, 600), "");

        // Reopen flow: force-complete the stranded 400, burn it, finish the cycle.
        vm.prank(custodian);
        t.forceCompleteDistribution();
        vm.prank(custodian);
        t.onBurn(custodian, custodian, 400, "", empty); // the design note's burn of ALL unsold
        assert(t.balanceOf(custodian) == 0); // burned to 0 before the next mint
        vm.prank(custodian);
        t.closeDistribution();
        vm.prank(issuer);
        t.setActive();

        // Tranche 2: mint 500, begin a fresh round.
        vm.prank(issuer);
        t.onMint(issuer, custodian, 500, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1); // must not revert
        assert(t.availableUnitsPrivate() == 500);

        // Private side: totalSupply = sold (600) + new tranche (500).
        assert(t.totalSupply() == 1100);
        assert(t.balanceOf(custodian) == 500);
        assert(t.balanceOf(investor1) == 600);
    }

    // D21 negative #1: a non-deployer (any group member) can no longer resolve an arbitrary
    // lock with arbitrary recipients.
    function testHandleDelegateUnlockByNonDeployerReverts() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);
        bytes32 lockId = keccak256("d21lock");
        vm.prank(custodian);
        t.onLock(custodian, lockId, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.onPrepareUnlock(custodian, lockId, _one(investor1, 1000), "", empty);

        vm.prank(investor1);
        vm.expectRevert(bytes("Caller is not the deployer or the custodian"));
        t.handleDelegateUnlock(custodian, lockId, _one(investor1, 1000), "");

        // Nothing moved by the reverted attempt.
        assert(t.balanceOf(custodian) == 1000);
        assert(t.balanceOf(investor1) == 0);
    }

    // D21 negative #2: even the authorized submitter cannot redirect funds to recipients the
    // prepared unlock didn't name (NotoLocks stores the (to, amount) pairs at prepare time).
    function testHandleDelegateUnlockRecipientMismatchReverts() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);
        bytes32 lockId = keccak256("d21mismatch");
        vm.prank(custodian);
        t.onLock(custodian, lockId, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.onPrepareUnlock(custodian, lockId, _one(investor1, 1000), "", empty);

        address attacker = vm.addr(9);
        vm.prank(issuer);
        vm.expectRevert(bytes("Recipients do not match the prepared unlock"));
        t.handleDelegateUnlock(custodian, lockId, _one(attacker, 1000), "");

        // Split recipients with a matching total still mismatch -- amounts checked per
        // recipient, not just summed.
        INotoHooks.UnlockRecipient[] memory split = new INotoHooks.UnlockRecipient[](2);
        split[0] = INotoHooks.UnlockRecipient({to: investor1, amount: 600});
        split[1] = INotoHooks.UnlockRecipient({to: attacker, amount: 400});
        vm.prank(issuer);
        vm.expectRevert(bytes("Recipients do not match the prepared unlock"));
        t.handleDelegateUnlock(custodian, lockId, split, "");
    }

    // D21 positive: the legit path -- deployer-submitted, recipients exactly matching the
    // prepared unlock -- still settles.
    function testHandleDelegateUnlockByDeployerWithMatchingRecipientsSucceeds() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);
        bytes32 lockId = keccak256("d21ok");
        vm.prank(custodian);
        t.onLock(custodian, lockId, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.onPrepareUnlock(custodian, lockId, _one(investor1, 1000), "", empty);

        vm.prank(issuer);
        t.handleDelegateUnlock(custodian, lockId, _one(investor1, 1000), "");
        assert(t.balanceOf(investor1) == 1000);
        assert(t.balanceOf(custodian) == 0);
    }

    // D21 positive #2 (lead decision 2026-10-07, option b): the LIVE production sender is
    // the token's NOTARY (bondCustodian side; upstream events.go:264 sends the hook tx
    // From domainConfig.NotaryLookup) -- custodian-submitted delegate unlock must settle.
    function testHandleDelegateUnlockByCustodianLiveSenderPathSucceeds() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);
        bytes32 lockId = keccak256("d21live");
        vm.prank(custodian);
        t.onLock(custodian, lockId, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.onPrepareUnlock(custodian, lockId, _one(investor1, 1000), "", empty);

        vm.prank(custodian);
        t.handleDelegateUnlock(custodian, lockId, _one(investor1, 1000), "");
        assert(t.balanceOf(investor1) == 1000);
        assert(t.balanceOf(custodian) == 0);
    }

    // ------------------------------------------------------------------
    // BACKLOG #6 (D36): stale-lock round stamping
    // ------------------------------------------------------------------

    // Drives the full D34 reopen flow from tranche 1 to a round-2 beginDistribution, leaving
    // `lockId` (locked + prepared under round 1 for `lockAmount` to investor1) open across the
    // reopen. Only the UNENCUMBERED remainder is burned, so the lock's units stay spendable
    // (Risk 2: burning lock-encumbered units strands the lock).
    function _reopenWithStaleLock(
        BondTracker t,
        bytes32 lockId,
        uint256 tranche1,
        uint256 lockAmount,
        uint256 tranche2
    ) internal returns (InvestorList) {
        vm.prank(issuer);
        t.onMint(issuer, custodian, tranche1, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1); // round 1
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);
        vm.prank(custodian);
        t.onLock(custodian, lockId, custodian, lockAmount, "", empty);
        vm.prank(custodian);
        t.onPrepareUnlock(custodian, lockId, _one(investor1, lockAmount), "", empty); // stamp: round 1

        vm.prank(custodian);
        t.forceCompleteDistribution();
        vm.prank(custodian);
        t.onBurn(custodian, custodian, tranche1 - lockAmount, "", empty); // unsold remainder only
        vm.prank(custodian);
        t.closeDistribution();
        vm.prank(issuer);
        t.setActive();
        vm.prank(issuer);
        t.onMint(issuer, custodian, tranche2, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1); // round 2 -- the round-1 lock is now stale
        return investorList;
    }

    // BACKLOG #6 (D36) stale case, delegate path: a lock prepared under round 1 and settled
    // after the reopen must NOT decrement round 2's counter and must NOT report onDistribute --
    // it is accounted as a round-tagged non-sale (real transfer still stands; balances move).
    function testStaleLockDelegateSettleAccountedAsRoundTaggedNonSale() external {
        BondTracker t = _fresh();
        bytes32 lockId = keccak256("staleDelegate");
        _reopenWithStaleLock(t, lockId, 1000, 600, 500);
        assert(t.availableUnitsPrivate() == 500); // round 2's counter, untouched so far

        vm.recordLogs();
        vm.prank(custodian); // D21 live-sender path
        t.handleDelegateUnlock(custodian, lockId, _one(investor1, 600), "");
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes memory encodedCall = _lastExternalCallTo(logs, publicTracker);
        assert(
            keccak256(encodedCall) ==
                keccak256(
                    abi.encodeWithSignature(
                        "onStaleLockSettled(bytes32,uint256,uint256)",
                        lockId,
                        uint256(1),
                        uint256(600)
                    )
                )
        );
        // NEVER revert: the real transfer stands, round 2's counter does not move.
        assert(t.balanceOf(investor1) == 600);
        assert(t.balanceOf(custodian) == 500);
        assert(t.availableUnitsPrivate() == 500);
    }

    // BACKLOG #6 (D36) stale case, direct path: same expectations via onUnlock, kept identical
    // to the delegate path on purpose (lead condition #2).
    function testStaleLockDirectSettleAccountedAsRoundTaggedNonSale() external {
        BondTracker t = _fresh();
        bytes32 lockId = keccak256("staleDirect");
        _reopenWithStaleLock(t, lockId, 1000, 600, 500);
        assert(t.availableUnitsPrivate() == 500);

        vm.recordLogs();
        vm.prank(custodian); // onlyLockOwner
        t.onUnlock(custodian, lockId, _one(investor1, 600), "", empty);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes memory encodedCall = _lastExternalCallTo(logs, publicTracker);
        assert(
            keccak256(encodedCall) ==
                keccak256(
                    abi.encodeWithSignature(
                        "onStaleLockSettled(bytes32,uint256,uint256)",
                        lockId,
                        uint256(1),
                        uint256(600)
                    )
                )
        );
        assert(t.balanceOf(investor1) == 600);
        assert(t.balanceOf(custodian) == 500);
        assert(t.availableUnitsPrivate() == 500);
    }

    // BACKLOG #6 (D36) re-prepare: a stale lock re-prepared under the new round re-checks
    // against round 2 and its stamp refreshes -- settle then decrements round 2 normally.
    function testStaleLockRepreparedUnderNewRoundSettlesNormally() external {
        BondTracker t = _fresh();
        bytes32 lockId = keccak256("staleReprepare");
        _reopenWithStaleLock(t, lockId, 1000, 400, 500);
        assert(t.availableUnitsPrivate() == 500);

        vm.prank(custodian);
        t.onPrepareUnlock(custodian, lockId, _one(investor1, 400), "", empty); // stamp -> round 2

        vm.recordLogs();
        vm.prank(custodian);
        t.handleDelegateUnlock(custodian, lockId, _one(investor1, 400), "");
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes memory encodedCall = _lastExternalCallTo(logs, publicTracker);
        assert(
            keccak256(encodedCall) ==
                keccak256(abi.encodeWithSignature("onDistribute(uint256)", uint256(400)))
        );
        assert(t.availableUnitsPrivate() == 100); // 500 - 400: round 2 decremented normally
        assert(t.balanceOf(investor1) == 400);
    }

    // Regression D28: a released (or never-created) lockId can never settle -- ownerOf/getLock
    // on the empty entry reverts exactly as before BACKLOG #6; the stale branch must not mask
    // this (no stamp entry exists for a lockId that was never prepared).
    function testSettleUnknownLockReverts() external {
        BondTracker t = _fresh();
        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1);
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);

        bytes32 unknown = keccak256("neverPrepared");
        vm.prank(custodian);
        vm.expectRevert();
        t.onUnlock(custodian, unknown, _one(investor1, 100), "", empty);

        vm.prank(custodian);
        vm.expectRevert();
        t.handleDelegateUnlock(custodian, unknown, _one(investor1, 100), "");
    }

    // BACKLOG #6, lead-ratified (2026-10-08, option i): an unlock settled WITHOUT any prepare
    // (lock exists but was never stamped) reads _lockRound[lockId] == 0, which is deliberately
    // a NON-SALE: no decrement, no onDistribute, reported as onStaleLockSettled with round 0.
    // The direct-path stale tests above prepare first to get a round-1 stamp -- this is the
    // OPPOSITE: skip onPrepareUnlock so the stamp stays unstamped (0).
    function testCustodianSettleWithoutPrepareIsRoundZeroStaleNonSale() external {
        BondTracker t = _fresh();

        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1); // round 1
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);

        bytes32 lockId = keccak256("lockNeverPrepared");
        vm.prank(custodian);
        t.onLock(custodian, lockId, custodian, 600, "", empty);
        // NO onPrepareUnlock -- _lockRound[lockId] stays 0.
        assert(t.availableUnitsPrivate() == 1000);

        vm.recordLogs();
        vm.prank(custodian); // onlyLockOwner
        t.onUnlock(custodian, lockId, _one(investor1, 600), "", empty);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes memory encodedCall = _lastExternalCallTo(logs, publicTracker);
        assert(
            keccak256(encodedCall) ==
                keccak256(
                    abi.encodeWithSignature(
                        "onStaleLockSettled(bytes32,uint256,uint256)",
                        lockId,
                        uint256(0),
                        uint256(600)
                    )
                )
        );
        // Never revert, real transfer stands, round counter untouched (non-sale).
        assert(t.balanceOf(investor1) == 600);
        assert(t.balanceOf(custodian) == 400);
        assert(t.availableUnitsPrivate() == 1000);
    }

    // D37 (lead decision 2026-10-08, review finding F2), case (a): a lock prepared under round
    // 1 (stamp == _roundSeq, because forceComplete does NOT increment _roundSeq) and settled
    // AFTER the round was closed must still be REPORTED -- onStaleLockSettled carrying round 1
    // -- instead of being silently dropped by the old DISTRIBUTION_STARTED gate. No decrement
    // (the round is closed; its counter is moot), no revert (delegate path = real transfer
    // already confirmed). Delegate path on purpose: that is the production path.
    function testSettleAfterCloseWithCurrentRoundStampStillReports() external {
        BondTracker t = _fresh();
        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1); // round 1
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);

        bytes32 lockId = keccak256("closeStampCurrent");
        vm.prank(custodian);
        t.onLock(custodian, lockId, custodian, 600, "", empty);
        vm.prank(custodian);
        t.onPrepareUnlock(custodian, lockId, _one(investor1, 600), "", empty); // stamp: round 1

        vm.prank(custodian);
        t.forceCompleteDistribution(); // status -> DISTRIBUTION_CLOSED; _roundSeq stays 1

        vm.recordLogs();
        vm.prank(custodian); // D21 live-sender path
        t.handleDelegateUnlock(custodian, lockId, _one(investor1, 600), "");
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes memory encodedCall = _lastExternalCallTo(logs, publicTracker);
        assert(
            keccak256(encodedCall) ==
                keccak256(
                    abi.encodeWithSignature(
                        "onStaleLockSettled(bytes32,uint256,uint256)",
                        lockId,
                        uint256(1),
                        uint256(600)
                    )
                )
        );
        // Never revert, real transfer stands, closed round's counter untouched.
        assert(t.balanceOf(investor1) == 600);
        assert(t.balanceOf(custodian) == 400);
        assert(t.availableUnitsPrivate() == 1000);
    }

    // D37, case (b): the same report must fire when the settle lands at ACTIVE after a FULL
    // reopen cycle (forceComplete -> burn remainder -> close -> setActive) -- the round stamp
    // (1) is carried verbatim in the notification. Direct path (onUnlock) on purpose: the
    // direct/delegate blocks must behave identically (lead condition #2 from D36).
    function testSettleAtActiveAfterReopenCarriesOldRound() external {
        BondTracker t = _fresh();
        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1); // round 1
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);

        bytes32 lockId = keccak256("activeStampOld");
        vm.prank(custodian);
        t.onLock(custodian, lockId, custodian, 600, "", empty);
        vm.prank(custodian);
        t.onPrepareUnlock(custodian, lockId, _one(investor1, 600), "", empty); // stamp: round 1

        vm.prank(custodian);
        t.forceCompleteDistribution();
        vm.prank(custodian);
        t.onBurn(custodian, custodian, 400, "", empty); // unencumbered remainder only
        vm.prank(custodian);
        t.closeDistribution();
        vm.prank(issuer);
        t.setActive(); // status ACTIVE; _roundSeq still 1

        vm.recordLogs();
        vm.prank(custodian); // onlyLockOwner
        t.onUnlock(custodian, lockId, _one(investor1, 600), "", empty);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes memory encodedCall = _lastExternalCallTo(logs, publicTracker);
        assert(
            keccak256(encodedCall) ==
                keccak256(
                    abi.encodeWithSignature(
                        "onStaleLockSettled(bytes32,uint256,uint256)",
                        lockId,
                        uint256(1),
                        uint256(600)
                    )
                )
        );
        assert(t.balanceOf(investor1) == 600);
        assert(t.balanceOf(custodian) == 0); // 1000 - 400 burned - 600 settled
        assert(t.availableUnitsPrivate() == 1000);
    }

    // ---- DvP cancel (audit HIGH #1) ----
    // Noto's NotoLockCancelled event is dispatched to handleDelegateUnlock exactly like
    // NotoLockSpent (domains/noto/internal/noto/events.go@v1.0.0:130-157), with the recipients
    // built from the cancel outputs (:230-240) -- ONE coin, owner = lock owner, amount = the
    // full locked amount (states.go@v1.0.0 prepareOutputs: "Always produce single coin entire
    // output amount"). The base ledger has already returned the funds when this hook runs.

    function _lockedForSale(BondTracker t, bytes32 lockId) internal {
        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1);
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);
        vm.prank(custodian);
        t.onLock(custodian, lockId, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.onPrepareUnlock(custodian, lockId, _one(investor1, 1000), "", empty);
    }

    function testDelegateCancelOutcomeAfterPrepareReleasesLockWithoutSale() external {
        BondTracker t = _fresh();
        bytes32 lockId = keccak256("cancelAfterPrepare");
        _lockedForSale(t, lockId);

        vm.recordLogs();
        vm.prank(issuer);
        t.handleDelegateUnlock(custodian, lockId, _one(custodian, 1000), "");
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // private state == ledger: funds back with the owner, nothing sold, nothing reported
        assert(t.balanceOf(custodian) == 1000);
        assert(t.balanceOf(investor1) == 0);
        assert(t.availableUnitsPrivate() == 1000);
        for (uint256 i = 0; i < logs.length; i++) {
            assert(logs[i].topics.length == 0 || logs[i].topics[0] != PENTE_EXTERNAL_CALL_TOPIC);
        }
        // lock is gone: a second settle/cancel for the same lockId cannot pass the owner gate
        vm.expectRevert();
        vm.prank(custodian);
        t.onPrepareUnlock(custodian, lockId, _one(investor1, 1000), "", empty);
    }

    function testDelegateCancelOutcomeWithoutPrepareReleasesLock() external {
        BondTracker t = _fresh();
        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1);
        bytes32 lockId = keccak256("cancelNoPrepare");
        vm.prank(custodian);
        t.onLock(custodian, lockId, custodian, 1000, "", empty);

        vm.prank(issuer);
        t.handleDelegateUnlock(custodian, lockId, _one(custodian, 1000), "");

        assert(t.balanceOf(custodian) == 1000);
        assert(t.availableUnitsPrivate() == 1000);
    }

    function testDelegateCancelOutcomeInvestorLockReturnsToInvestor() external {
        BondTracker t = _fresh();
        vm.prank(issuer);
        t.onMint(issuer, custodian, 1000, "", empty);
        vm.prank(custodian);
        t.beginDistribution(1, 1);
        InvestorList investorList = t.investorList();
        vm.prank(custodian);
        investorList.addInvestor(investor1);
        address investor2 = vm.addr(5);
        vm.prank(custodian);
        investorList.addInvestor(investor2);
        vm.prank(custodian);
        t.onTransfer(custodian, custodian, investor1, 400, "", empty);

        bytes32 lockId = keccak256("cancelInvestorLock");
        vm.prank(investor1);
        t.onLock(investor1, lockId, investor1, 400, "", empty);
        vm.prank(investor1);
        t.onPrepareUnlock(investor1, lockId, _one(investor2, 400), "", empty);

        vm.prank(issuer);
        t.handleDelegateUnlock(investor1, lockId, _one(investor1, 400), "");

        assert(t.balanceOf(investor1) == 400);
        assert(t.balanceOf(investor2) == 0);
    }

    function testDelegateCancelShapeWrongAmountStillReverts() external {
        BondTracker t = _fresh();
        bytes32 lockId = keccak256("cancelWrongAmount");
        _lockedForSale(t, lockId);

        vm.expectRevert(bytes("Recipients do not match the prepared unlock"));
        vm.prank(issuer);
        t.handleDelegateUnlock(custodian, lockId, _one(custodian, 999), "");
    }

    function testDelegateCancelShapeWrongOwnerStillReverts() external {
        BondTracker t = _fresh();
        bytes32 lockId = keccak256("cancelWrongOwner");
        _lockedForSale(t, lockId);
        address investor2 = vm.addr(5);

        vm.expectRevert(bytes("Recipients do not match the prepared unlock"));
        vm.prank(issuer);
        t.handleDelegateUnlock(custodian, lockId, _one(investor2, 1000), "");
    }

    function testDelegateCancelShapeSplitAcrossTwoRecipientsStillReverts() external {
        BondTracker t = _fresh();
        bytes32 lockId = keccak256("cancelSplit");
        _lockedForSale(t, lockId);
        INotoHooks.UnlockRecipient[] memory split = new INotoHooks.UnlockRecipient[](2);
        split[0] = INotoHooks.UnlockRecipient({to: custodian, amount: 500});
        split[1] = INotoHooks.UnlockRecipient({to: custodian, amount: 500});

        vm.expectRevert(bytes("Recipients do not match the prepared unlock"));
        vm.prank(issuer);
        t.handleDelegateUnlock(custodian, lockId, split, "");
    }

    function testDelegateCancelShapeStillRequiresD21Sender() external {
        BondTracker t = _fresh();
        bytes32 lockId = keccak256("cancelBadSender");
        _lockedForSale(t, lockId);

        vm.expectRevert(bytes("Caller is not the deployer or the custodian"));
        vm.prank(investor1);
        t.handleDelegateUnlock(custodian, lockId, _one(custodian, 1000), "");
    }

    // ---- reconciliation view (audit LOW #6) ----
    function testLockedBalanceOfTracksOpenLockAndClearsOnCancel() external {
        BondTracker t = _fresh();
        bytes32 lockId = keccak256("lockedView");
        _lockedForSale(t, lockId);

        // 1000 held by the custodian, all in the open lock: Noto would show 0 unlocked.
        assert(t.balanceOf(custodian) == 1000);
        assert(t.lockedBalanceOf(custodian) == 1000);

        vm.prank(issuer);
        t.handleDelegateUnlock(custodian, lockId, _one(custodian, 1000), "");
        assert(t.lockedBalanceOf(custodian) == 0);
        assert(t.balanceOf(custodian) == 1000);
    }
}
