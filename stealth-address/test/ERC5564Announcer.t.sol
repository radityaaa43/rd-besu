// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {ERC5564Announcer} from "../src/ERC5564Announcer.sol";

interface Vm {
    function expectEmit(bool, bool, bool, bool) external;
    function prank(address) external;
}

contract ERC5564AnnouncerTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed caller,
        bytes ephemeralPubKey,
        bytes metadata
    );

    ERC5564Announcer a;

    function setUp() public {
        a = new ERC5564Announcer();
    }

    function test_announce_emits_with_msg_sender_as_caller() public {
        address stealth = address(0xBEEF);
        address sender = address(0xCAFE);
        bytes memory eph = hex"02aa";
        bytes memory meta = hex"20";
        vm.expectEmit(true, true, true, true);
        emit Announcement(1, stealth, sender, eph, meta);
        vm.prank(sender);
        a.announce(1, stealth, eph, meta);
    }

    // Anyone may announce anything, including empty metadata (the standard requires it to be open).
    function test_announce_accepts_empty_metadata() public {
        vm.expectEmit(true, true, true, true);
        emit Announcement(1, address(0xBEEF), address(this), hex"02", "");
        a.announce(1, address(0xBEEF), hex"02", "");
    }
}
