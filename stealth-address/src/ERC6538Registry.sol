// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @notice ERC-6538 stealth meta-address registry, full interface: `registerKeys`, `registerKeysOnBehalf`
/// (EIP-712 signature, EOA or ERC-1271), `incrementNonce`, `DOMAIN_SEPARATOR` and the entry type hash.
/// @dev Behaviour follows ScopeLift/stealth-address-erc-contracts. Two differences: signatures are checked with
/// OpenZeppelin `ECDSA` plus an ERC-1271 call (the logic of OZ `SignatureChecker`, inlined because OZ 5.4's
/// `SignatureChecker` needs Cancun's `mcopy` and this repo compiles for shanghai), so a bad signature from an EOA registrant reverts with
/// `ERC6538Registry__InvalidSignature` (ScopeLift reverts with empty data) and high-s signatures are rejected; and
/// scheme-1 meta-addresses must be exactly 66 bytes (stricter than the EIP, which does no validation), in both
/// `registerKeys` and `registerKeysOnBehalf`.
contract ERC6538Registry {
    error InvalidMetaAddressLength();
    error ERC6538Registry__InvalidSignature();

    event StealthMetaAddressSet(address indexed registrant, uint256 indexed schemeId, bytes stealthMetaAddress);
    event NonceIncremented(address indexed registrant, uint256 newNonce);

    mapping(address => mapping(uint256 => bytes)) public stealthMetaAddressOf;
    mapping(address => uint256) public nonceOf;

    bytes32 public constant ERC6538REGISTRY_ENTRY_TYPE_HASH =
        keccak256("Erc6538RegistryEntry(uint256 schemeId,bytes stealthMetaAddress,uint256 nonce)");

    uint256 internal immutable INITIAL_CHAIN_ID;
    bytes32 internal immutable INITIAL_DOMAIN_SEPARATOR;

    constructor() {
        INITIAL_CHAIN_ID = block.chainid;
        INITIAL_DOMAIN_SEPARATOR = _computeDomainSeparator();
    }

    function registerKeys(uint256 schemeId, bytes calldata stealthMetaAddress) external {
        _checkLength(schemeId, stealthMetaAddress);
        stealthMetaAddressOf[msg.sender][schemeId] = stealthMetaAddress;
        emit StealthMetaAddressSet(msg.sender, schemeId, stealthMetaAddress);
    }

    function incrementNonce() external {
        emit NonceIncremented(msg.sender, ++nonceOf[msg.sender]);
    }

    /// @dev The nonce is consumed before the check; a failed check reverts the whole call, so it is only spent on success.
    function registerKeysOnBehalf(
        address registrant,
        uint256 schemeId,
        bytes memory signature,
        bytes calldata stealthMetaAddress
    ) external {
        _checkLength(schemeId, stealthMetaAddress);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        ERC6538REGISTRY_ENTRY_TYPE_HASH, schemeId, keccak256(stealthMetaAddress), nonceOf[registrant]++
                    )
                )
            )
        );
        if (!_isValidSignature(registrant, digest, signature)) {
            revert ERC6538Registry__InvalidSignature();
        }
        stealthMetaAddressOf[registrant][schemeId] = stealthMetaAddress;
        emit StealthMetaAddressSet(registrant, schemeId, stealthMetaAddress);
    }

    function _isValidSignature(address registrant, bytes32 digest, bytes memory signature) private view returns (bool) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == registrant) return true;
        if (registrant.code.length == 0) return false;
        (bool ok, bytes memory ret) =
            registrant.staticcall(abi.encodeCall(IERC1271.isValidSignature, (digest, signature)));
        return ok && ret.length >= 32 && abi.decode(ret, (bytes32)) == bytes32(IERC1271.isValidSignature.selector);
    }

    /// @dev Recomputed when the chain id changes (chain fork), so signatures cannot be replayed across forks.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == INITIAL_CHAIN_ID ? INITIAL_DOMAIN_SEPARATOR : _computeDomainSeparator();
    }

    function _computeDomainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ERC6538Registry"),
                keccak256("1.0"),
                block.chainid,
                address(this)
            )
        );
    }

    /// Scheme 1 meta-address = 33-byte spend pubkey || 33-byte view pubkey.
    function _checkLength(uint256 schemeId, bytes calldata stealthMetaAddress) private pure {
        if (schemeId == 1 && stealthMetaAddress.length != 66) revert InvalidMetaAddressLength();
    }
}
