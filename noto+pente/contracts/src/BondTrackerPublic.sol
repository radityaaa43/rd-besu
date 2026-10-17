// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * Public half of a bond series: lifecycle STATUS only. Derived from upstream
 * examples/bond BondTrackerPublic (solidity/contracts/shared/BondTrackerPublic.sol at tag v1.0.0).
 *
 * DEVIATION from upstream, on purpose: upstream publishes every sale to this contract
 * (onDistribute(amount) into a TokenDistribution holding totalUnits, price and availableUnits),
 * plus totalSupply and burns. On a public chain that discloses every primary-sale and
 * redemption amount. Platform objective: only BI, the sender and the receiver see amounts. So
 * this contract carries NO amount, price, quantity or supply -- no function argument, no event
 * field, no getter. All of that accounting lives in the private BondTracker (inside the Pente
 * group); it tells this contract only that a status transition happened:
 *   onIssue(custodian)        INITIALIZED/COMPLETE/ACTIVE -> ISSUED
 *   beginDistribution()       -> DISTRIBUTION_STARTED
 *   onDistributionComplete()  STARTED -> COMPLETE   (private counter reached zero: sold out)
 *   forceCompleteDistribution() STARTED -> COMPLETE (custodian writes off the unsold remainder)
 *   closeDistribution()       COMPLETE -> CLOSED
 *   setActive()               CLOSED -> ACTIVE
 * test/BondTrackerPublic.t.sol walks this contract's ABI and fails if an amount-like field ever
 * reappears.
 *
 * Instrument terms (issue/maturity date, face value, currency token) are deliberately public:
 * they are the bond's published terms, not holdings.
 */
contract BondTrackerPublic is Ownable {
    /// @notice This DISTRIBUTION cycle status only -- deliberately independent of
    /// any series-lifecycle status kept elsewhere (ACTIVE/MATURED/REDEEMED/SUSPENDED): this enum
    /// is never derived from, or mapped onto, such a status.
    enum Status {
        INITIALIZED,
        ISSUED,
        DISTRIBUTION_STARTED,
        DISTRIBUTION_COMPLETE,
        DISTRIBUTION_CLOSED,
        ACTIVE
    }

    event StatusChanged(Status newStatus);
    event CustodianChanged(address indexed newCustodian);
    event BondDetailsChanged(
        uint256 issueDate,
        uint256 maturityDate,
        uint256 faceValue,
        address currencyToken
    );
    // 1-indexed. No amount: how many units a tranche has is private.
    event TrancheIssued(uint256 trancheNo);

    address public custodian;
    address public currencyToken;
    // 1-indexed count of tranches issued so far.
    uint256 public trancheCount;

    Status internal _status;
    uint256 internal _issueDate;
    uint256 internal _maturityDate;
    uint256 internal _faceValue;

    constructor(
        address owner,
        uint256 issueDate_,
        uint256 maturityDate_,
        address currencyToken_,
        uint256 faceValue_
    ) Ownable(owner) {
        require(
            maturityDate_ > issueDate_,
            "Maturity date must be after issue date"
        );
        currencyToken = currencyToken_;
        _status = Status.INITIALIZED;
        _issueDate = issueDate_;
        _maturityDate = maturityDate_;
        _faceValue = faceValue_;
        emit StatusChanged(_status);
        emit BondDetailsChanged(
            issueDate_,
            maturityDate_,
            faceValue_,
            currencyToken
        );
    }

    // `to` is always the custodian: BondTracker.onMint requires `to == _custodian` before it
    // emits the PenteExternalCall that lands here, and this contract's owner is the privacy
    // group's own address, so nothing else can call it. It is what sets the public custodian().
    function onIssue(address to) external onlyOwner {
        // D35 status gate (defense in depth): production reachability is already gated by
        // BondTracker.onMint (INITIALIZED || ACTIVE). Here: INITIALIZED (first tranche),
        // DISTRIBUTION_COMPLETE (previous round fully sold or force-completed, burn-on-reopen)
        // and ACTIVE are the only states a tranche may follow. ISSUED is rejected (a second mint
        // before any round started), DISTRIBUTION_STARTED (a round is selling) and
        // DISTRIBUTION_CLOSED (D34 ordering: closeDistribution + setActive come before mintTranche).
        require(
            _status == Status.INITIALIZED ||
                _status == Status.DISTRIBUTION_COMPLETE ||
                _status == Status.ACTIVE,
            "Bond must either be unissued, fully sold out, or fully active to issue more supply"
        );
        custodian = to;
        trancheCount += 1;
        _status = Status.ISSUED;
        emit StatusChanged(_status);
        emit CustodianChanged(to);
        emit TrancheIssued(trancheCount);
    }

    function beginDistribution() external onlyOwner {
        // A round that is still selling blocks a new one. A fully sold (COMPLETE) round that is not
        // yet formally closed may reopen immediately. Price and denomination are private.
        require(
            _status != Status.DISTRIBUTION_STARTED,
            "Previous distribution round not finished"
        );
        _status = Status.DISTRIBUTION_STARTED;
        emit StatusChanged(_status);
    }

    // Sent by the private BondTracker, once, when its private unsold counter reaches zero.
    function onDistributionComplete() external onlyOwner {
        require(
            _status == Status.DISTRIBUTION_STARTED,
            "No distribution round in progress"
        );
        _status = Status.DISTRIBUTION_COMPLETE;
        emit StatusChanged(_status);
    }

    // A tranche that cannot be cleanly divided into valid purchase quantities (or a buyer who
    // declines the last lot) can strand the private counter above zero forever; the custodian
    // writes off the remainder and completes the round anyway (then burns the unsold units).
    function forceCompleteDistribution() external onlyOwner {
        require(
            _status == Status.DISTRIBUTION_STARTED,
            "No distribution round in progress"
        );
        _status = Status.DISTRIBUTION_COMPLETE;
        emit StatusChanged(_status);
    }

    function closeDistribution() external onlyOwner {
        require(
            _status == Status.DISTRIBUTION_COMPLETE,
            "Distribution is not complete"
        );
        _status = Status.DISTRIBUTION_CLOSED;
        emit StatusChanged(_status);
    }

    function setActive() external onlyOwner {
        require(
            _status == Status.DISTRIBUTION_CLOSED,
            "Bond is not ready to be activated"
        );
        _status = Status.ACTIVE;
        emit StatusChanged(_status);
    }

    // Marker for clients: a series whose public tracker answers this is status-only (no
    // amounts here, so price/units live in the private BondTracker). Trackers deployed before
    // this version have no such function and are the legacy upstream-shaped pair.
    function schema() external pure returns (string memory) {
        return "status-only-v1";
    }

    function status() external view returns (Status) {
        return _status;
    }
}
