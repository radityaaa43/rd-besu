// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {InstrumentRegistry} from "../src/InstrumentRegistry.sol";

interface Vm {
    function expectEmit(bool, bool, bool, bool) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function prank(address) external;
    function warp(uint256) external;
}

contract InstrumentRegistryTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    event InstrumentRegistered(
        address indexed token,
        bytes32 indexed kind,
        uint256 version,
        string primaryId,
        bytes32 dataHash,
        string dataUri,
        address registrant
    );
    event RegistrarSet(address indexed registrar, bool allowed);

    address constant OWNER = address(0x0111);
    address constant BI = address(0xB1);
    address constant CUSTODIAN = address(0xC057);
    address constant STRANGER = address(0x5712A);
    address constant RD = address(uint160(0xDA1D));
    address constant BOND = address(uint160(0xDFAB));
    bytes32 constant KIND_RD = bytes32("RD");
    bytes32 constant KIND_DFABI = bytes32("DFABI");
    bytes32 constant H1 = bytes32(uint256(0xAA01));
    bytes32 constant H2 = bytes32(uint256(0xAA02));

    InstrumentRegistry reg;

    function setUp() public {
        vm.warp(1_000_000);
        vm.prank(OWNER);
        reg = new InstrumentRegistry();
        vm.prank(OWNER);
        reg.setRegistrar(BI, true);
        vm.prank(OWNER);
        reg.setRegistrar(CUSTODIAN, true);
    }

    function test_owner_is_the_deployer_and_only_the_owner_sets_registrars() public {
        require(reg.owner() == OWNER, "owner");
        vm.prank(STRANGER);
        vm.expectRevert(InstrumentRegistry.NotOwner.selector);
        reg.setRegistrar(STRANGER, true);
        vm.prank(BI); // a registrar is not the owner
        vm.expectRevert(InstrumentRegistry.NotOwner.selector);
        reg.setRegistrar(STRANGER, true);
        require(reg.isRegistrar(BI) && reg.isRegistrar(CUSTODIAN) && !reg.isRegistrar(STRANGER), "allow-list");
    }

    function test_setRegistrar_emits_and_can_remove() public {
        vm.expectEmit(true, false, false, true);
        emit RegistrarSet(STRANGER, true);
        vm.prank(OWNER);
        reg.setRegistrar(STRANGER, true);
        vm.prank(OWNER);
        reg.setRegistrar(STRANGER, false);
        vm.prank(STRANGER);
        vm.expectRevert(InstrumentRegistry.NotRegistrar.selector);
        reg.register(RD, KIND_RD, "1", "IDR", H1, "ipfs://rd");
    }

    function test_register_is_registrar_only() public {
        vm.prank(STRANGER);
        vm.expectRevert(InstrumentRegistry.NotRegistrar.selector);
        reg.register(RD, KIND_RD, "1", "IDR", H1, "ipfs://rd");
        vm.prank(OWNER); // the owner is not a registrar unless the owner adds itself
        vm.expectRevert(InstrumentRegistry.NotRegistrar.selector);
        reg.register(RD, KIND_RD, "1", "IDR", H1, "ipfs://rd");
        vm.prank(STRANGER);
        vm.expectRevert(InstrumentRegistry.NotRegistrar.selector);
        reg.registerVersion(RD, KIND_RD, "1", "IDR", H2, "ipfs://rd2");
    }

    function test_register_stores_version_1_and_emits() public {
        vm.expectEmit(true, true, false, true);
        emit InstrumentRegistered(RD, KIND_RD, 1, "IDR", H1, "ipfs://rd", BI);
        vm.prank(BI);
        reg.register(RD, KIND_RD, "1", "IDR", H1, "ipfs://rd");

        InstrumentRegistry.Instrument memory i = reg.getInstrument(RD);
        require(i.token == RD && i.kind == KIND_RD, "token and kind");
        require(keccak256(bytes(i.profileVersion)) == keccak256("1"), "profile version");
        require(keccak256(bytes(i.primaryId)) == keccak256("IDR"), "primary id");
        require(i.dataHash == H1 && keccak256(bytes(i.dataUri)) == keccak256("ipfs://rd"), "hash and uri");
        require(i.registrant == BI && i.registeredAt == 1_000_000 && i.version == 1, "registrant, time, version");
        require(reg.versionCount(RD) == 1, "count");
        require(reg.isRegistered(RD) && !reg.isRegistered(BOND), "isRegistered");
    }

    function test_register_twice_for_the_same_token_reverts() public {
        vm.prank(BI);
        reg.register(RD, KIND_RD, "1", "IDR", H1, "ipfs://rd");
        vm.prank(BI);
        vm.expectRevert(InstrumentRegistry.AlreadyRegistered.selector);
        reg.register(RD, KIND_RD, "1", "IDR", H2, "ipfs://other");
        vm.prank(CUSTODIAN); // not even another registrar can overwrite
        vm.expectRevert(InstrumentRegistry.AlreadyRegistered.selector);
        reg.register(RD, KIND_RD, "1", "IDR", H2, "ipfs://other");
        require(reg.getInstrument(RD).dataHash == H1 && reg.versionCount(RD) == 1, "unchanged");
    }

    function test_registerVersion_appends_and_never_overwrites() public {
        vm.prank(CUSTODIAN);
        reg.register(BOND, KIND_DFABI, "1", "IDDFA0000013", H1, "ipfs://v1");
        vm.warp(2_000_000);
        vm.expectEmit(true, true, false, true);
        emit InstrumentRegistered(BOND, KIND_DFABI, 2, "IDDFA0000013", H2, "ipfs://v2", BI);
        vm.prank(BI); // a different registrar may append a correction
        reg.registerVersion(BOND, KIND_DFABI, "2", "IDDFA0000013", H2, "ipfs://v2");

        require(reg.versionCount(BOND) == 2, "two versions");
        InstrumentRegistry.Instrument memory latest = reg.getInstrument(BOND);
        require(latest.version == 2 && latest.dataHash == H2 && latest.registrant == BI && latest.registeredAt == 2_000_000, "latest is v2");
        require(keccak256(bytes(latest.profileVersion)) == keccak256("2"), "v2 profile version");
        InstrumentRegistry.Instrument memory v1 = reg.getInstrumentVersion(BOND, 1);
        require(v1.version == 1 && v1.dataHash == H1 && v1.registrant == CUSTODIAN && v1.registeredAt == 1_000_000, "v1 untouched");
        require(keccak256(bytes(v1.dataUri)) == keccak256("ipfs://v1"), "v1 uri untouched");
    }

    function test_registerVersion_needs_an_existing_entry_and_the_same_kind_and_primary_id() public {
        vm.prank(BI);
        vm.expectRevert(InstrumentRegistry.NotRegisteredYet.selector);
        reg.registerVersion(BOND, KIND_DFABI, "1", "IDDFA0000013", H1, "ipfs://v1");

        vm.prank(BI);
        reg.register(BOND, KIND_DFABI, "1", "IDDFA0000013", H1, "ipfs://v1");
        vm.prank(BI);
        vm.expectRevert(InstrumentRegistry.IdentityChanged.selector);
        reg.registerVersion(BOND, KIND_RD, "1", "IDDFA0000013", H2, "ipfs://v2"); // kind may not change
        vm.prank(BI);
        vm.expectRevert(InstrumentRegistry.IdentityChanged.selector);
        reg.registerVersion(BOND, KIND_DFABI, "1", "IDDFA0000014", H2, "ipfs://v2"); // primary id may not change
        require(reg.versionCount(BOND) == 1, "nothing appended");
    }

    function test_unknown_token_reads() public {
        require(reg.versionCount(BOND) == 0 && !reg.isRegistered(BOND), "empty");
        vm.expectRevert(InstrumentRegistry.UnknownInstrument.selector);
        reg.getInstrument(BOND);
        vm.expectRevert(InstrumentRegistry.UnknownInstrument.selector);
        reg.getInstrumentVersion(BOND, 1);
        vm.prank(BI);
        reg.register(RD, KIND_RD, "1", "IDR", H1, "ipfs://rd");
        vm.expectRevert(InstrumentRegistry.UnknownInstrument.selector);
        reg.getInstrumentVersion(RD, 0);
        vm.expectRevert(InstrumentRegistry.UnknownInstrument.selector);
        reg.getInstrumentVersion(RD, 2);
    }

    function test_the_registry_accepts_any_new_kind() public {
        bytes32 frn = bytes32("TEST-FRN");
        vm.prank(BI);
        reg.register(address(uint160(0xF12)), frn, "1", "XS2524143554", H1, "ipfs://frn");
        require(reg.getInstrument(address(uint160(0xF12))).kind == frn, "new kind stored");
    }

    function test_rejects_empty_inputs() public {
        vm.prank(BI);
        vm.expectRevert(InstrumentRegistry.EmptyInput.selector);
        reg.register(address(0), KIND_RD, "1", "IDR", H1, "ipfs://rd");
        vm.prank(BI);
        vm.expectRevert(InstrumentRegistry.EmptyInput.selector);
        reg.register(RD, bytes32(0), "1", "IDR", H1, "ipfs://rd");
        vm.prank(BI);
        vm.expectRevert(InstrumentRegistry.EmptyInput.selector);
        reg.register(RD, KIND_RD, "", "IDR", H1, "ipfs://rd");
        vm.prank(BI);
        vm.expectRevert(InstrumentRegistry.EmptyInput.selector);
        reg.register(RD, KIND_RD, "1", "", H1, "ipfs://rd");
        vm.prank(BI);
        vm.expectRevert(InstrumentRegistry.EmptyInput.selector);
        reg.register(RD, KIND_RD, "1", "IDR", bytes32(0), "ipfs://rd");
        vm.prank(BI);
        vm.expectRevert(InstrumentRegistry.EmptyInput.selector);
        reg.register(RD, KIND_RD, "1", "IDR", H1, "");
        require(reg.versionCount(RD) == 0, "nothing stored");
    }

    function test_ownership_transfers_to_a_new_owner_only() public {
        vm.prank(STRANGER);
        vm.expectRevert(InstrumentRegistry.NotOwner.selector);
        reg.transferOwnership(STRANGER);
        vm.prank(OWNER);
        vm.expectRevert(InstrumentRegistry.EmptyInput.selector);
        reg.transferOwnership(address(0));
        vm.prank(OWNER);
        reg.transferOwnership(BI);
        require(reg.owner() == BI, "new owner");
        vm.prank(OWNER);
        vm.expectRevert(InstrumentRegistry.NotOwner.selector);
        reg.setRegistrar(STRANGER, true);
    }
}
