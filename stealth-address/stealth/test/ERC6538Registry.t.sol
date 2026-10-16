// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {ERC6538Registry} from "../src/ERC6538Registry.sol";

interface Vm {
    function expectEmit(bool, bool, bool, bool) external;
    function expectRevert(bytes4) external;
    function prank(address) external;
}

contract ERC6538RegistryTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    event StealthMetaAddressSet(address indexed registrant, uint256 indexed schemeId, bytes stealthMetaAddress);
    event NonceIncremented(address indexed registrant, uint256 newNonce);

    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);

    ERC6538Registry r;

    function setUp() public {
        r = new ERC6538Registry();
    }

    function _meta(uint8 fill, uint256 len) internal pure returns (bytes memory m) {
        m = new bytes(len);
        for (uint256 i; i < len; i++) m[i] = bytes1(fill);
    }

    function test_registerKeys_stores_and_emits() public {
        bytes memory m = _meta(0x02, 66);
        vm.expectEmit(true, true, false, true);
        emit StealthMetaAddressSet(ALICE, 1, m);
        vm.prank(ALICE);
        r.registerKeys(1, m);
        require(keccak256(r.stealthMetaAddressOf(ALICE, 1)) == keccak256(m), "stored");
    }

    function test_registerKeys_scheme1_wrong_length_reverts() public {
        vm.expectRevert(ERC6538Registry.InvalidMetaAddressLength.selector);
        r.registerKeys(1, _meta(0x02, 65));
    }

    // Review focus 4: non-scheme-1 ids accept any length.
    function test_registerKeys_other_scheme_accepts_any_length() public {
        bytes memory m = _meta(0x07, 3);
        vm.prank(ALICE);
        r.registerKeys(2, m);
        require(keccak256(r.stealthMetaAddressOf(ALICE, 2)) == keccak256(m), "stored");
    }

    // Review focus 4: re-registering overwrites, and another registrant is untouched.
    function test_register_overwrites_and_isolates_registrants() public {
        bytes memory first = _meta(0x02, 66);
        bytes memory second = _meta(0x03, 66);
        vm.prank(ALICE);
        r.registerKeys(1, first);
        vm.prank(BOB);
        r.registerKeys(1, first);
        vm.prank(ALICE);
        r.registerKeys(1, second);
        require(keccak256(r.stealthMetaAddressOf(ALICE, 1)) == keccak256(second), "alice overwritten");
        require(keccak256(r.stealthMetaAddressOf(BOB, 1)) == keccak256(first), "bob untouched");
    }

    // Review focus 4: nonces are per registrant.
    function test_incrementNonce_is_per_registrant() public {
        require(r.nonceOf(ALICE) == 0, "starts at 0");
        vm.expectEmit(true, false, false, true);
        emit NonceIncremented(ALICE, 1);
        vm.prank(ALICE);
        r.incrementNonce();
        require(r.nonceOf(ALICE) == 1, "alice 1");
        require(r.nonceOf(BOB) == 0, "bob 0");
    }
}
