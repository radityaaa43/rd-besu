// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/// @notice ERC-5564 Announcer. No storage, no access control: the standard requires it to be open.
contract ERC5564Announcer {
    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed caller,
        bytes ephemeralPubKey,
        bytes metadata
    );

    function announce(uint256 schemeId, address stealthAddress, bytes memory ephemeralPubKey, bytes memory metadata)
        external
    {
        emit Announcement(schemeId, stealthAddress, msg.sender, ephemeralPubKey, metadata);
    }
}
