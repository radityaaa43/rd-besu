// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/// @notice ERC-6538 stealth meta-address registry, partial implementation.
/// @dev `registerKeysOnBehalf` (EIP-712) is not implemented, so `DOMAIN_SEPARATOR()`,
/// `ERC6538REGISTRY_ENTRY_TYPE_HASH()` and the `ERC6538Registry__InvalidSignature` error are absent too.
/// `nonceOf`/`incrementNonce` exist for interface shape only; there is no signature to cancel.
/// The scheme-1 66-byte length check in `registerKeys` is stricter than the EIP, which does no validation.
/// Tools that look for the full ERC-6538 interface will not detect this contract, and a wallet or
/// relayer cannot register on a user's behalf. Add `registerKeysOnBehalf` when a compliance claim is needed.
contract ERC6538Registry {
    error InvalidMetaAddressLength();

    event StealthMetaAddressSet(address indexed registrant, uint256 indexed schemeId, bytes stealthMetaAddress);
    event NonceIncremented(address indexed registrant, uint256 newNonce);

    mapping(address => mapping(uint256 => bytes)) public stealthMetaAddressOf;
    mapping(address => uint256) public nonceOf;

    function registerKeys(uint256 schemeId, bytes calldata stealthMetaAddress) external {
        // Scheme 1 meta-address = 33-byte spend pubkey || 33-byte view pubkey.
        if (schemeId == 1 && stealthMetaAddress.length != 66) revert InvalidMetaAddressLength();
        stealthMetaAddressOf[msg.sender][schemeId] = stealthMetaAddress;
        emit StealthMetaAddressSet(msg.sender, schemeId, stealthMetaAddress);
    }

    function incrementNonce() external {
        emit NonceIncremented(msg.sender, ++nonceOf[msg.sender]);
    }
}
