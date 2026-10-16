// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {ERC1400} from "./vendor/universal-token/ERC1400.sol";
import {ERC5564Announcer} from "./ERC5564Announcer.sol";

/// @notice DFABI bond: Consensys UniversalToken ERC-1400 (partitions are tranches) whose stealth issue and
/// transfer functions announce the stealth recipient (ERC-5564 scheme 1) in the same transaction. This
/// contract is the Announcement `caller`, so a scanner that filters on `caller == address(this)` can trust
/// the metadata. The inherited `transferByPartition`, operator and controller transfers announce nothing;
/// wallets must use `transferByPartitionStealth`.
/// @dev Certificate rule: the validator (ERC1400TokensValidator, nonce-based) verifies a custodian
/// signature over the calldata minus its LAST 160 bytes, so `data` (the 97-byte certificate) must stay the
/// last parameter of `transferByPartitionStealth`. The validator is configured in setup, not here.
contract DfabiBond is ERC1400 {
    error InvalidEphemeralPubKey();
    error ZeroAmount();

    ERC5564Announcer public immutable announcer;

    constructor(
        string memory name_,
        string memory symbol_,
        address[] memory controllers_,
        bytes32[] memory defaultPartitions_,
        address announcer_
    ) ERC1400(name_, symbol_, 1, controllers_, defaultPartitions_) {
        announcer = ERC5564Announcer(announcer_);
    }

    /// @notice Minter (the custodian) issues to a stealth address and announces. A certificate signer is
    /// exempt from the certificate check in the validator.
    function issueByPartitionStealth(
        bytes32 partition,
        address stealthAddress,
        uint256 value,
        bytes memory ephemeralPubKey,
        bytes1 viewTag
    ) external onlyMinter isIssuableToken {
        _checkAnnounce(value, ephemeralPubKey);
        _issueByPartition(partition, msg.sender, stealthAddress, value, "");
        _announce(partition, stealthAddress, value, ephemeralPubKey, viewTag);
    }

    /// @notice Holder transfers to a stealth address and announces. `data` is the custodian certificate.
    function transferByPartitionStealth(
        bytes32 partition,
        address stealthAddress,
        uint256 value,
        bytes memory ephemeralPubKey,
        bytes1 viewTag,
        bytes memory data
    ) external {
        _checkAnnounce(value, ephemeralPubKey);
        _transferByPartition(partition, msg.sender, msg.sender, stealthAddress, value, data, "");
        _announce(partition, stealthAddress, value, ephemeralPubKey, viewTag);
    }

    function _checkAnnounce(uint256 value, bytes memory ephemeralPubKey) private pure {
        if (ephemeralPubKey.length != 33) revert InvalidEphemeralPubKey();
        if (value == 0) revert ZeroAmount();
    }

    /// 89 bytes: viewTag (1) | transferByPartition selector (4) | token (20) | amount (32) | partition (32).
    function _announce(bytes32 partition, address stealthAddress, uint256 value, bytes memory ephemeralPubKey, bytes1 viewTag)
        private
    {
        announcer.announce(
            1,
            stealthAddress,
            ephemeralPubKey,
            abi.encodePacked(viewTag, bytes4(0xf3d490db), address(this), value, partition)
        );
    }
}
