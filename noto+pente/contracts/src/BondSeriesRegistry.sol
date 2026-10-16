// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * Public registry of bond/sukuk series metadata, one row per series' Noto token address.
 * Lead task #6, per docs/superpowers/sdd/2026-10-05-bond-data-model.md. Replaces per-series
 * `BondTrackerPublic` metadata (the old design, one public contract deployed per series) with
 * one shared, owned registry keyed by token address -- field names/types/sourcing follow that
 * doc's "On-chain" table exactly (ICMA Bond Data Taxonomy field names where the doc cites one).
 *
 * Owned by BI (node1) -- BI is the platform's sole issuer / issuing-and-auction agent across
 * every instrument family per the doc's Scope section, so a single owner is correct, not a
 * simplification.
 *
 * `instrumentType` is `bytes32` (a hash or short ASCII-packed value, e.g. keccak256("SRBI")),
 * never a Solidity enum -- platform-extensibility binding rule 1
 * (docs/superpowers/sdd/2026-10-05-platform-extensibility.md): a new instrument type must never
 * require a redeploy.
 */
contract BondSeriesRegistry is Ownable {
    /// @notice This is the SERIES lifecycle status only -- it is deliberately independent of
    /// `BondTrackerPublic.Status` (INITIALIZED/.../DISTRIBUTION_STARTED/.../ACTIVE), which
    /// tracks the current tranche's distribution cycle instead. A series can be mid-reopening
    /// (BondTrackerPublic.status == DISTRIBUTION_STARTED) while this stays ACTIVE throughout.
    /// Lead decision, intentional, no mirroring between the two: see
    /// docs/superpowers/sdd/2026-10-05-bond-data-model.md, section "paladin #7".
    enum Status {
        ACTIVE,
        MATURED,
        REDEEMED,
        SUSPENDED
    }

    struct Series {
        bytes32 instrumentType;
        bytes32 seriesCode;
        bytes12 isin;
        address currencyToken;
        uint256 faceValue;
        uint64 issueDate;
        uint64 maturityDate;
        Status status;
        bool transferRestricted;
        bytes32 termsHash;
        // v2 (task #11, 2026-10-06): the public BondTrackerPublic address for this series.
        // Without this, getDistributionState/getPrice could only ever run inside the SAME
        // process that called issueSeries (the in-memory seriesContexts cache populated
        // there) -- a different process/node (an investor's own client, or BI after a
        // restart) had no way to learn this address and got PD_CLIENT_UNKNOWN_SERIES.
        // Public (not BI-private) by design: BondTrackerPublic is itself a public contract,
        // so recording its address here leaks nothing that querying the chain directly
        // wouldn't already reveal.
        address publicTracker;
        // Not one of the lead's named 10 fields -- added because the doc's own event signature
        // for terms amendment, `TermsUpdated(token, newHash, version)`, needs a version counter
        // to live somewhere. Flagged in the task report; happy to move this to a separate
        // `mapping(address => uint256)` instead if the lead would rather keep `Series` at
        // exactly the named 10 fields.
        uint256 termsVersion;
    }

    mapping(address => Series) private _series;
    mapping(address => bool) private _registered;

    event SeriesRegistered(address indexed token, bytes32 indexed instrumentType, bytes32 seriesCode, bytes12 isin, address publicTracker);
    event SeriesStatusChanged(address indexed token, Status status);
    event TermsUpdated(address indexed token, bytes32 newHash, uint256 version);

    error SeriesAlreadyRegistered(address token);
    error SeriesNotRegistered(address token);
    error InvalidMaturityDate(uint64 issueDate, uint64 maturityDate);

    constructor(address owner_) Ownable(owner_) {}

    /// @notice One series = one Noto token. `token` is never re-registrable once set, matching
    /// "1 series = 1 ISIN = 1 Noto token" from the doc's Hierarchy section -- a reopening (tap)
    /// mints more supply on the SAME already-registered token, it never calls this again.
    function registerSeries(
        address token,
        bytes32 instrumentType,
        bytes32 seriesCode,
        bytes12 isin,
        address currencyToken,
        uint256 faceValue,
        uint64 issueDate,
        uint64 maturityDate,
        bool transferRestricted,
        bytes32 termsHash,
        address publicTracker
    ) external onlyOwner {
        if (_registered[token]) revert SeriesAlreadyRegistered(token);
        if (maturityDate <= issueDate) revert InvalidMaturityDate(issueDate, maturityDate);

        _registered[token] = true;
        _series[token] = Series({
            instrumentType: instrumentType,
            seriesCode: seriesCode,
            isin: isin,
            currencyToken: currencyToken,
            faceValue: faceValue,
            issueDate: issueDate,
            maturityDate: maturityDate,
            status: Status.ACTIVE,
            transferRestricted: transferRestricted,
            termsHash: termsHash,
            termsVersion: 1,
            publicTracker: publicTracker
        });

        emit SeriesRegistered(token, instrumentType, seriesCode, isin, publicTracker);
        // Solidity-auditor fix (2026-10-06, agents 5/12 FINDING "lost-historical-anchor"):
        // SeriesRegistered never carried termsHash/termsVersion, and TermsUpdated's first-ever
        // emission was already version 2 -- an off-chain consumer reconstructing hash history
        // purely from events permanently skipped version 1 the moment a second revision
        // happened, breaking this contract's own documented per-version audit-trail guarantee.
        emit TermsUpdated(token, termsHash, 1);
    }

    function setStatus(address token, Status status) external onlyOwner {
        if (!_registered[token]) revert SeriesNotRegistered(token);
        _series[token].status = status;
        emit SeriesStatusChanged(token, status);
    }

    /// @notice `newTermsHash` = sha256(JCS(terms)) of the full ICMA terms JSON held in BI's own
    /// DB (bond_series.terms, per the doc's Off-chain section) -- this contract never sees the
    /// terms themselves, only the anchor hash. History of prior hashes/versions is kept off-chain;
    /// this only needs to prove, on request, that whatever BI currently claims matches what was
    /// anchored on-chain at that version.
    function updateTerms(address token, bytes32 newTermsHash) external onlyOwner {
        if (!_registered[token]) revert SeriesNotRegistered(token);
        Series storage s = _series[token];
        s.termsHash = newTermsHash;
        s.termsVersion += 1;
        emit TermsUpdated(token, newTermsHash, s.termsVersion);
    }

    function getSeries(address token) external view returns (Series memory) {
        if (!_registered[token]) revert SeriesNotRegistered(token);
        return _series[token];
    }

    function isRegistered(address token) external view returns (bool) {
        return _registered[token];
    }
}
