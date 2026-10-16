// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/// @notice On-chain index of instrument data. The full record is off chain (JSON, see ts/instrument.ts); this contract
/// stores, per token, the hash of the canonical JSON and where to fetch it, so anyone can check that a record is the
/// one that was registered. Instrument terms are public by nature; privacy covers holdings and transfers, not terms.
/// @dev One registry per network, shared by the stealth and the Zeto tracks. `kind` is a free bytes32 (an instrument type
/// such as RD or DFABI, or any later one): the contract has no instrument list, so a new instrument type needs no
/// change here. Registration is by an allow-listed registrar set by the owner. An entry is never overwritten:
/// a correction is a new version, so the whole history stays readable.
contract InstrumentRegistry {
    error NotOwner();
    error NotRegistrar();
    error AlreadyRegistered();
    error NotRegisteredYet();
    error IdentityChanged();
    error UnknownInstrument();
    error EmptyInput();

    struct Instrument {
        address token;
        bytes32 kind;
        string profileVersion; // version of the profile the record was validated against, as in the record
        string primaryId; // ISIN for a bond, ISO 4217 code for cash
        bytes32 dataHash; // keccak256 of the canonical JSON (sorted keys, no whitespace)
        string dataUri;
        address registrant;
        uint256 registeredAt;
        uint256 version; // 1 for the first entry, then 2, 3, ...
    }

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
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    address public owner;
    mapping(address => bool) public isRegistrar;
    mapping(address => Instrument[]) private _versions; // index = version - 1

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyRegistrar() {
        if (!isRegistrar[msg.sender]) revert NotRegistrar();
        _;
    }

    function setRegistrar(address registrar, bool allowed) external onlyOwner {
        isRegistrar[registrar] = allowed;
        emit RegistrarSet(registrar, allowed);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert EmptyInput();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// Creates version 1 for a token. Reverts if the token already has an entry.
    function register(
        address token,
        bytes32 kind,
        string calldata profileVersion,
        string calldata primaryId,
        bytes32 dataHash,
        string calldata dataUri
    ) external onlyRegistrar {
        if (_versions[token].length != 0) revert AlreadyRegistered();
        _append(token, kind, profileVersion, primaryId, dataHash, dataUri);
    }

    /// Appends the next version (a correction or an update). `kind` and `primaryId` must equal those of version 1:
    /// they identify what the token is and cannot be rewritten. Earlier versions stay readable and unchanged.
    function registerVersion(
        address token,
        bytes32 kind,
        string calldata profileVersion,
        string calldata primaryId,
        bytes32 dataHash,
        string calldata dataUri
    ) external onlyRegistrar {
        Instrument[] storage v = _versions[token];
        if (v.length == 0) revert NotRegisteredYet();
        if (v[0].kind != kind || keccak256(bytes(v[0].primaryId)) != keccak256(bytes(primaryId))) revert IdentityChanged();
        _append(token, kind, profileVersion, primaryId, dataHash, dataUri);
    }

    /// The latest entry. Reverts `UnknownInstrument` for a token that was never registered.
    function getInstrument(address token) external view returns (Instrument memory) {
        Instrument[] storage v = _versions[token];
        if (v.length == 0) revert UnknownInstrument();
        return v[v.length - 1];
    }

    /// One entry by version (1-based).
    function getInstrumentVersion(address token, uint256 version) external view returns (Instrument memory) {
        Instrument[] storage v = _versions[token];
        if (version == 0 || version > v.length) revert UnknownInstrument();
        return v[version - 1];
    }

    /// Number of versions; 0 for a token that was never registered.
    function versionCount(address token) external view returns (uint256) {
        return _versions[token].length;
    }

    function isRegistered(address token) external view returns (bool) {
        return _versions[token].length != 0;
    }

    function _append(
        address token,
        bytes32 kind,
        string calldata profileVersion,
        string calldata primaryId,
        bytes32 dataHash,
        string calldata dataUri
    ) private {
        if (
            token == address(0) || kind == bytes32(0) || bytes(profileVersion).length == 0 || bytes(primaryId).length == 0
                || dataHash == bytes32(0) || bytes(dataUri).length == 0
        ) revert EmptyInput();
        uint256 version = _versions[token].length + 1;
        _versions[token].push(
            Instrument(token, kind, profileVersion, primaryId, dataHash, dataUri, msg.sender, block.timestamp, version)
        );
        emit InstrumentRegistered(token, kind, version, primaryId, dataHash, dataUri, msg.sender);
    }
}
