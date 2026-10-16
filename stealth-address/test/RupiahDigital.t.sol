// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {ERC5564Announcer} from "../src/ERC5564Announcer.sol";
import {RupiahDigital} from "../src/RupiahDigital.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

interface Vm {
    function expectEmit(bool, bool, bool, bool, address) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function prank(address) external;
}

contract RupiahDigitalTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed caller,
        bytes ephemeralPubKey,
        bytes metadata
    );

    address constant ISSUER = address(0xB1);
    address constant ALICE = address(0xA11CE);
    address constant STEALTH = address(0x57EA17);

    ERC5564Announcer announcer;
    RupiahDigital token;

    function setUp() public {
        announcer = new ERC5564Announcer();
        token = new RupiahDigital(ISSUER, address(announcer));
    }

    // 57-byte EIP-5564 ERC-20 metadata, built independently of the contract's encoding.
    function _meta(bytes1 tag, uint256 amount) internal view returns (bytes memory) {
        return bytes.concat(tag, bytes4(0xa9059cbb), bytes20(address(token)), bytes32(amount));
    }

    function _eph(uint256 len) internal pure returns (bytes memory b) {
        b = new bytes(len);
        for (uint256 i; i < len; i++) b[i] = 0x02;
    }

    function _fund(address to, uint256 amount) internal {
        vm.prank(ISSUER);
        token.mint(to, amount);
    }

    function test_token_identity() public view {
        require(token.decimals() == 0, "decimals");
        require(keccak256(bytes(token.name())) == keccak256("Rupiah Digital"), "name");
        require(keccak256(bytes(token.symbol())) == keccak256("RD"), "symbol");
        require(token.issuer() == ISSUER, "issuer");
    }

    // Review focus 1: only issuer mints.
    function test_non_issuer_cannot_mint() public {
        vm.prank(ALICE);
        vm.expectRevert(RupiahDigital.OnlyIssuer.selector);
        token.mint(ALICE, 1);
    }

    function test_non_issuer_cannot_mintStealth() public {
        vm.prank(ALICE);
        vm.expectRevert(RupiahDigital.OnlyIssuer.selector);
        token.mintStealth(STEALTH, 1, _eph(33), 0x20);
    }

    function test_issuer_mint_adds_balance_and_supply() public {
        _fund(ALICE, 1000);
        require(token.balanceOf(ALICE) == 1000, "balance");
        require(token.totalSupply() == 1000, "supply");
    }

    // Review focus 3: caller is the token, metadata is 57 bytes.
    function test_mintStealth_mints_and_announces() public {
        vm.expectEmit(true, true, true, true, address(announcer));
        emit Announcement(1, STEALTH, address(token), _eph(33), _meta(0x20, 1000));
        vm.prank(ISSUER);
        token.mintStealth(STEALTH, 1000, _eph(33), 0x20);
        require(token.balanceOf(STEALTH) == 1000, "balance");
        require(token.totalSupply() == 1000, "supply");
    }

    // Review focus 3: anyone holding balance can sendStealth; transfers and announces.
    function test_sendStealth_transfers_and_announces() public {
        _fund(ALICE, 1000);
        vm.expectEmit(true, true, true, true, address(announcer));
        emit Announcement(1, STEALTH, address(token), _eph(33), _meta(0x7f, 400));
        vm.prank(ALICE);
        token.sendStealth(STEALTH, 400, _eph(33), 0x7f);
        require(token.balanceOf(STEALTH) == 400, "stealth");
        require(token.balanceOf(ALICE) == 600, "alice");
        require(token.totalSupply() == 1000, "supply");
    }

    // Zero-amount announcements are free spam (gas price 0), so they revert.
    function test_sendStealth_zero_amount_reverts_without_balance() public {
        vm.prank(ALICE);
        vm.expectRevert(RupiahDigital.ZeroAmount.selector);
        token.sendStealth(STEALTH, 0, _eph(33), 0x20);
    }

    function test_mintStealth_zero_amount_reverts() public {
        vm.prank(ISSUER);
        vm.expectRevert(RupiahDigital.ZeroAmount.selector);
        token.mintStealth(STEALTH, 0, _eph(33), 0x20);
    }

    // Review focus 2: ephemeral key must be exactly 33 bytes.
    function test_ephemeral_key_must_be_33_bytes() public {
        _fund(ALICE, 1000);
        uint256[4] memory lens = [uint256(0), 32, 34, 65];
        for (uint256 i; i < lens.length; i++) {
            vm.prank(ALICE);
            vm.expectRevert(RupiahDigital.InvalidEphemeralPubKey.selector);
            token.sendStealth(STEALTH, 1, _eph(lens[i]), 0x20);

            vm.prank(ISSUER);
            vm.expectRevert(RupiahDigital.InvalidEphemeralPubKey.selector);
            token.mintStealth(STEALTH, 1, _eph(lens[i]), 0x20);
        }
        require(token.balanceOf(STEALTH) == 0, "nothing moved");
    }

    // Review focus 6: OpenZeppelin errors, nothing announced.
    function test_zero_recipient_reverts() public {
        _fund(ALICE, 1000);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InvalidReceiver.selector, address(0)));
        token.sendStealth(address(0), 1, _eph(33), 0x20);
    }

    function test_insufficient_balance_reverts() public {
        _fund(ALICE, 100);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, ALICE, 100, 101));
        token.sendStealth(STEALTH, 101, _eph(33), 0x20);
    }

    function test_burn_lowers_supply() public {
        _fund(ALICE, 1000);
        vm.prank(ALICE);
        token.burn(400);
        require(token.balanceOf(ALICE) == 600, "balance");
        require(token.totalSupply() == 600, "supply");
    }
}
