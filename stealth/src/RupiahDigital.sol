// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC5564Announcer} from "./ERC5564Announcer.sol";

/// @notice Rupiah Digital: whole-rupiah ERC-20 whose stealth mint and send announce the stealth recipient
/// (ERC-5564 scheme 1) in the same transaction. This contract is the Announcement `caller`, so a scanner
/// that filters on `caller == address(this)` can trust the metadata. A plain `transfer` to a stealth
/// address still works but announces nothing; wallets must use `sendStealth`.
contract RupiahDigital is ERC20, ERC20Burnable {
    error OnlyIssuer();
    error InvalidEphemeralPubKey();
    error ZeroAmount();

    address public immutable issuer;
    ERC5564Announcer public immutable announcer;

    constructor(address issuer_, address announcer_) ERC20("Rupiah Digital", "RD") {
        issuer = issuer_;
        announcer = ERC5564Announcer(announcer_);
    }

    function decimals() public pure override returns (uint8) {
        return 0;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != issuer) revert OnlyIssuer();
        _mint(to, amount);
    }

    function mintStealth(address stealthAddress, uint256 amount, bytes calldata ephemeralPubKey, bytes1 viewTag)
        external
    {
        if (msg.sender != issuer) revert OnlyIssuer();
        _mint(stealthAddress, amount);
        _announce(stealthAddress, amount, ephemeralPubKey, viewTag);
    }

    function sendStealth(address stealthAddress, uint256 amount, bytes calldata ephemeralPubKey, bytes1 viewTag)
        external
    {
        _transfer(msg.sender, stealthAddress, amount);
        _announce(stealthAddress, amount, ephemeralPubKey, viewTag);
    }

    /// EIP-5564 ERC-20 metadata: viewTag (1) | transfer selector (4) | token (20) | amount (32) = 57 bytes.
    function _announce(address stealthAddress, uint256 amount, bytes calldata ephemeralPubKey, bytes1 viewTag)
        private
    {
        if (ephemeralPubKey.length != 33) revert InvalidEphemeralPubKey();
        if (amount == 0) revert ZeroAmount();
        announcer.announce(
            1, stealthAddress, ephemeralPubKey, abi.encodePacked(viewTag, bytes4(0xa9059cbb), address(this), amount)
        );
    }
}
