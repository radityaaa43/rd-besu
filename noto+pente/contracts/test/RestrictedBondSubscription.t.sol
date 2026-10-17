// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {RestrictedBondSubscription} from "../src/RestrictedBondSubscription.sol";
import {RestrictedAtom} from "../src/RestrictedAtom.sol";
import {RestrictedAtomFactory} from "../src/RestrictedAtomFactory.sol";
import {MockLockable} from "./RestrictedAtom.t.sol";

interface Vm {
    function prank(address) external;
    function addr(uint256 privateKey) external returns (address);
    function expectRevert() external;
    function expectRevert(bytes calldata) external;
    function recordLogs() external;

    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function getRecordedLogs() external returns (Log[] memory);
}

// The forked primary-sale path: RestrictedBondSubscription.distribute() asks the (Pente-side)
// RestrictedAtomFactory for an atom. `_relay` replays that PenteExternalCall against a real
// factory as the privacy group would, so these tests exercise the atom the issuance really
// gets: only the investor, the custodian (BI's bond custodian, also the executor) may cancel,
// a stranger may not, and a cancel releases both delegated legs.
contract RestrictedBondSubscriptionTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 constant PENTE_EXTERNAL_CALL_TOPIC = keccak256("PenteExternalCall(address,bytes)");
    bytes32 constant ATOM_DEPLOYED_TOPIC = keccak256("AtomDeployed(address)");

    address investor = vm.addr(1);
    address custodian = vm.addr(2);
    address group = vm.addr(3);
    address stranger = vm.addr(4);

    bytes32 bondLock = keccak256("bond-lock");
    bytes32 cashLock = keccak256("cash-lock");

    MockLockable bondToken;
    MockLockable cashToken;
    RestrictedAtomFactory factory;
    RestrictedBondSubscription sub;

    function _setUp() internal {
        bondToken = new MockLockable();
        cashToken = new MockLockable();
        factory = new RestrictedAtomFactory();
        vm.prank(investor);
        sub = new RestrictedBondSubscription(address(bondToken), 10, custodian, address(factory));
    }

    function _unlockCall(bytes32 id) internal pure returns (bytes memory) {
        return abi.encodeCall(MockLockable.returnNonBoolWord, (id));
    }

    function _cancelCall(bytes32 id) internal pure returns (bytes memory) {
        return abi.encodeCall(MockLockable.cancelLock, (id, "", ""));
    }

    function _prepare() internal {
        vm.prank(investor);
        sub.preparePayment(address(cashToken), _unlockCall(cashLock), cashLock, _cancelCall(cashLock));
        vm.prank(custodian);
        sub.prepareBond(address(bondToken), _unlockCall(bondLock), bondLock, _cancelCall(bondLock));
    }

    // distribute() then run the PenteExternalCall it emitted against the factory, as the group.
    function _distribute() internal returns (RestrictedAtom atom) {
        vm.recordLogs();
        vm.prank(custodian);
        sub.distribute();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes memory call;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(sub) && logs[i].topics[0] == PENTE_EXTERNAL_CALL_TOPIC) {
                // the event's target is the factory
                assert(address(uint160(uint256(logs[i].topics[1]))) == address(factory));
                call = abi.decode(logs[i].data, (bytes));
            }
        }
        assert(call.length > 0);
        vm.recordLogs();
        vm.prank(group);
        (bool ok, ) = address(factory).call(call);
        assert(ok);
        logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(factory) && logs[i].topics[0] == ATOM_DEPLOYED_TOPIC) {
                atom = RestrictedAtom(abi.decode(logs[i].data, (address)));
            }
        }
        assert(address(atom) != address(0));
    }

    // Both legs delegated to the atom, as the delegateLock steps do before execute.
    function _delegateBoth(RestrictedAtom atom) internal {
        bondToken.setLock(bondLock, address(atom), true, true);
        cashToken.setLock(cashLock, address(atom), true, true);
    }

    function testAtomIsRestrictedToInvestorCustodianAndExecutor() external {
        _setUp();
        _prepare();
        RestrictedAtom atom = _distribute();

        assert(atom.executor() == custodian);
        address[] memory parties = atom.getParties();
        assert(parties.length == 2);
        assert(parties[0] == investor);
        assert(parties[1] == custodian);

        RestrictedAtom.Operation[] memory ops = atom.getOperations();
        assert(ops.length == 2);
        assert(ops[0].contractAddress == address(bondToken)); // bond leg first, as upstream
        assert(ops[1].contractAddress == address(cashToken));

        RestrictedAtom.CancelOperation[] memory cops = atom.getCancelOperations();
        assert(cops.length == 2);
        assert(cops[0].lockId == bondLock && cops[0].contractAddress == address(bondToken));
        assert(cops[1].lockId == cashLock && cops[1].contractAddress == address(cashToken));
    }

    function testNonPartyCancelRevertsAndLegsStayLocked() external {
        _setUp();
        _prepare();
        RestrictedAtom atom = _distribute();
        _delegateBoth(atom);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(RestrictedAtom.NotAParty.selector, stranger));
        atom.cancel();

        assert(uint8(atom.status()) == uint8(RestrictedAtom.Status.Pending));
        (, bool bondActive, ) = bondToken.locks(bondLock);
        (, bool cashActive, ) = cashToken.locks(cashLock);
        assert(bondActive && cashActive);
    }

    function testInvestorCancelReleasesBothDelegatedLegs() external {
        _setUp();
        _prepare();
        RestrictedAtom atom = _distribute();
        _delegateBoth(atom);

        vm.prank(investor);
        atom.cancel();

        assert(uint8(atom.status()) == uint8(RestrictedAtom.Status.Cancelled));
        (, bool bondActive, ) = bondToken.locks(bondLock);
        (, bool cashActive, ) = cashToken.locks(cashLock);
        assert(!bondActive && !cashActive);
    }

    function testCustodianCancelWorks() external {
        _setUp();
        _prepare();
        RestrictedAtom atom = _distribute();
        _delegateBoth(atom);

        vm.prank(custodian);
        atom.cancel();
        assert(uint8(atom.status()) == uint8(RestrictedAtom.Status.Cancelled));
    }

    function testOnlyCustodianExecutesAndInvestorCannot() external {
        _setUp();
        _prepare();
        RestrictedAtom atom = _distribute();
        _delegateBoth(atom);

        vm.prank(investor);
        vm.expectRevert(abi.encodeWithSelector(RestrictedAtom.NotExecutor.selector, investor));
        atom.execute();

        vm.prank(custodian);
        atom.execute();
        assert(uint8(atom.status()) == uint8(RestrictedAtom.Status.Executed));
    }

    function testDistributeRequiresCancelRecordsForBothLegs() external {
        _setUp();
        // Bond leg prepared with an empty cancelCall: must not build an atom with an
        // unprotected (non-releasable) leg.
        vm.prank(investor);
        sub.preparePayment(address(cashToken), _unlockCall(cashLock), cashLock, _cancelCall(cashLock));
        vm.prank(custodian);
        sub.prepareBond(address(bondToken), _unlockCall(bondLock), bondLock, "");
        vm.prank(custodian);
        vm.expectRevert(bytes("Bond cancel call has not been prepared"));
        sub.distribute();

        // Payment leg missing its lockId.
        vm.prank(custodian);
        sub.prepareBond(address(bondToken), _unlockCall(bondLock), bondLock, _cancelCall(bondLock));
        vm.prank(investor);
        sub.preparePayment(address(cashToken), _unlockCall(cashLock), bytes32(0), _cancelCall(cashLock));
        vm.prank(custodian);
        vm.expectRevert(bytes("Payment cancel call has not been prepared"));
        sub.distribute();
    }

    function testUpstreamGatesAreKept() external {
        _setUp();
        vm.prank(stranger);
        vm.expectRevert();
        sub.preparePayment(address(cashToken), _unlockCall(cashLock), cashLock, _cancelCall(cashLock));
        vm.prank(investor);
        vm.expectRevert(bytes("Sender is not custodian"));
        sub.prepareBond(address(bondToken), _unlockCall(bondLock), bondLock, _cancelCall(bondLock));
        vm.prank(investor);
        vm.expectRevert(bytes("Sender is not custodian"));
        sub.distribute();
        vm.prank(custodian);
        vm.expectRevert(bytes("Bond transfer has not been prepared"));
        sub.distribute();
    }
}
