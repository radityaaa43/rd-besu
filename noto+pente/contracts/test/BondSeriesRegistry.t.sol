// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {BondSeriesRegistry} from "../src/BondSeriesRegistry.sol";

// Same minimal inline cheatcode pattern as RestrictedAtom.t.sol -- no forge-std import, see that
// file's comment for why.
interface Vm {
    function expectRevert() external;
    function expectRevert(bytes calldata) external;
    function prank(address) external;
    function addr(uint256 privateKey) external returns (address);
}

contract BondSeriesRegistryTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address bi = vm.addr(1);
    address stranger = vm.addr(2);
    address token = vm.addr(3);
    address currencyToken = vm.addr(4);
    address publicTracker = vm.addr(6);

    BondSeriesRegistry registry;

    function _fresh() internal returns (BondSeriesRegistry) {
        vm.prank(bi);
        return new BondSeriesRegistry(bi);
    }

    function _registerToken(BondSeriesRegistry r, address t) internal {
        vm.prank(bi);
        r.registerSeries(t, bytes32("SRBI"), bytes32("SRBI0001"), bytes12("ID000SRBI01"), currencyToken, 1_000_000, 1000, 2000, false, bytes32("hash-v1"), publicTracker);
    }

    function testRegisterSeriesStoresAllFields() external {
        registry = _fresh();
        _registerToken(registry, token);

        BondSeriesRegistry.Series memory s = registry.getSeries(token);
        assert(s.instrumentType == bytes32("SRBI"));
        assert(s.seriesCode == bytes32("SRBI0001"));
        assert(s.isin == bytes12("ID000SRBI01"));
        assert(s.currencyToken == currencyToken);
        assert(s.faceValue == 1_000_000);
        assert(s.issueDate == 1000);
        assert(s.maturityDate == 2000);
        assert(uint8(s.status) == uint8(BondSeriesRegistry.Status.ACTIVE));
        assert(s.transferRestricted == false);
        assert(s.termsHash == bytes32("hash-v1"));
        assert(s.termsVersion == 1);
        assert(s.publicTracker == publicTracker);
        assert(registry.isRegistered(token) == true);
    }

    function testRegisterSeriesRejectsNonOwner() external {
        registry = _fresh();
        vm.prank(stranger);
        vm.expectRevert();
        registry.registerSeries(token, bytes32("SRBI"), bytes32("X"), bytes12("Y"), currencyToken, 1, 1000, 2000, false, bytes32("h"), publicTracker);
        assert(registry.isRegistered(token) == false);
    }

    function testRegisterSeriesRejectsDoubleRegistration() external {
        registry = _fresh();
        _registerToken(registry, token);

        vm.prank(bi);
        vm.expectRevert();
        registry.registerSeries(token, bytes32("SUN-FR"), bytes32("FR0100"), bytes12("FR0100XXXXX"), currencyToken, 1, 1000, 2000, false, bytes32("h2"), publicTracker);

        // The original registration must be untouched by the rejected second attempt.
        assert(registry.getSeries(token).instrumentType == bytes32("SRBI"));
    }

    function testRegisterSeriesRejectsMaturityBeforeIssue() external {
        registry = _fresh();
        vm.prank(bi);
        vm.expectRevert();
        registry.registerSeries(token, bytes32("SRBI"), bytes32("X"), bytes12("Y"), currencyToken, 1, 2000, 1000, false, bytes32("h"), publicTracker);
        assert(registry.isRegistered(token) == false);
    }

    function testGetSeriesRevertsForUnregisteredToken() external {
        registry = _fresh();
        vm.expectRevert();
        registry.getSeries(token);
    }

    function testSetStatusUpdatesAndEmits() external {
        registry = _fresh();
        _registerToken(registry, token);

        vm.prank(bi);
        registry.setStatus(token, BondSeriesRegistry.Status.MATURED);
        assert(uint8(registry.getSeries(token).status) == uint8(BondSeriesRegistry.Status.MATURED));
    }

    function testSetStatusRejectsNonOwner() external {
        registry = _fresh();
        _registerToken(registry, token);

        vm.prank(stranger);
        vm.expectRevert();
        registry.setStatus(token, BondSeriesRegistry.Status.SUSPENDED);
        // Status must be unchanged.
        assert(uint8(registry.getSeries(token).status) == uint8(BondSeriesRegistry.Status.ACTIVE));
    }

    function testSetStatusRejectsUnregisteredToken() external {
        registry = _fresh();
        vm.prank(bi);
        vm.expectRevert();
        registry.setStatus(token, BondSeriesRegistry.Status.MATURED);
    }

    function testUpdateTermsIncrementsVersionAndEmits() external {
        registry = _fresh();
        _registerToken(registry, token);
        assert(registry.getSeries(token).termsVersion == 1);

        vm.prank(bi);
        registry.updateTerms(token, bytes32("hash-v2"));
        BondSeriesRegistry.Series memory s = registry.getSeries(token);
        assert(s.termsHash == bytes32("hash-v2"));
        assert(s.termsVersion == 2);

        vm.prank(bi);
        registry.updateTerms(token, bytes32("hash-v3"));
        assert(registry.getSeries(token).termsVersion == 3);
    }

    function testUpdateTermsRejectsNonOwner() external {
        registry = _fresh();
        _registerToken(registry, token);

        vm.prank(stranger);
        vm.expectRevert();
        registry.updateTerms(token, bytes32("hash-evil"));
        assert(registry.getSeries(token).termsHash == bytes32("hash-v1"));
    }

    function testIsRegisteredFalseForNeverRegisteredToken() external {
        registry = _fresh();
        assert(registry.isRegistered(token) == false);
    }

    // Two distinct series on the same registry must not interfere with each other.
    function testMultipleSeriesAreIndependent() external {
        registry = _fresh();
        address token2 = vm.addr(5);
        address publicTracker2 = vm.addr(7);
        _registerToken(registry, token);
        vm.prank(bi);
        registry.registerSeries(token2, bytes32("SUN-FR"), bytes32("FR0100"), bytes12("FR0100XXXXX"), currencyToken, 500_000, 3000, 4000, true, bytes32("h2"), publicTracker2);

        vm.prank(bi);
        registry.setStatus(token, BondSeriesRegistry.Status.MATURED);

        assert(uint8(registry.getSeries(token).status) == uint8(BondSeriesRegistry.Status.MATURED));
        assert(uint8(registry.getSeries(token2).status) == uint8(BondSeriesRegistry.Status.ACTIVE));
        assert(registry.getSeries(token2).instrumentType == bytes32("SUN-FR"));
        assert(registry.getSeries(token2).transferRestricted == true);
        assert(registry.getSeries(token).publicTracker == publicTracker);
        assert(registry.getSeries(token2).publicTracker == publicTracker2);
    }
}
