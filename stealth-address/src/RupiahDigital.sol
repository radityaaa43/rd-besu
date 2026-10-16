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
    error MemoTooLong();

    /// Upper bound for the opaque sender memo appended to the announcement metadata.
    uint256 public constant MAX_MEMO = 256;

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

    function mintStealth(
        address stealthAddress,
        uint256 amount,
        bytes calldata ephemeralPubKey,
        bytes1 viewTag,
        bytes calldata memo
    )
        external
    {
        if (msg.sender != issuer) revert OnlyIssuer();
        _mint(stealthAddress, amount);
        _announce(stealthAddress, amount, ephemeralPubKey, viewTag, memo);
    }

    function sendStealth(
        address stealthAddress,
        uint256 amount,
        bytes calldata ephemeralPubKey,
        bytes1 viewTag,
        bytes calldata memo
    )
        external
    {
        _transfer(msg.sender, stealthAddress, amount);
        _announce(stealthAddress, amount, ephemeralPubKey, viewTag, memo);
    }

    /// EIP-5564 ERC-20 metadata: viewTag (1) | transfer selector (4) | token (20) | amount (32) = 57 bytes,
    /// then the opaque `memo` (an encrypted sender memo; never validated here, only bounded).
    function _announce(
        address stealthAddress,
        uint256 amount,
        bytes calldata ephemeralPubKey,
        bytes1 viewTag,
        bytes calldata memo
    ) private
    {
        if (ephemeralPubKey.length != 33) revert InvalidEphemeralPubKey();
        if (amount == 0) revert ZeroAmount();
        if (memo.length > MAX_MEMO) revert MemoTooLong();
        announcer.announce(
            1,
            stealthAddress,
            ephemeralPubKey,
            abi.encodePacked(viewTag, bytes4(0xa9059cbb), address(this), amount, memo)
        );
    }
}
