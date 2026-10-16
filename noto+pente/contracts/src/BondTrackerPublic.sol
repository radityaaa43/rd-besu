// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {TokenDistribution} from "paladin-shared/TokenDistribution.sol";

/**
 * Fork of upstream BondTrackerPublic.sol (solidity/contracts/shared/BondTrackerPublic.sol),
 * for lead task #7 -- reopening (tap issuance) support. `TokenDistribution` is UNCHANGED,
 * imported via the `paladin-shared/` remapping (Paladin/contracts/remappings.txt), not copied.
 *
 * Two bugs the lead found that block reopening, confirmed by reading this file directly:
 * 1. onIssue() OVERWRITES totalSupply (`= amount`) instead of accumulating it -- after a
 *    reopening, totalSupply would report only the latest tranche, not the series total.
 * 2. beginDistribution() requires `address(distribution) == address(0)` -- blocks ANY second
 *    distribution round outright, regardless of whether the first one finished.
 *
 * Both fixed below, plus the tranche counter/event the lead asked for.
 */
contract BondTrackerPublic is Ownable {
    /// @notice This is the DISTRIBUTION cycle status only -- it is deliberately independent of
    /// `BondSeriesRegistry.Status` (ACTIVE/MATURED/REDEEMED/SUSPENDED), which tracks the
    /// series' lifecycle instead and is set directly by BI, never derived from this enum.
    /// Lead decision, intentional, no mirroring between the two: see
    /// docs/superpowers/sdd/2026-10-05-bond-data-model.md, section "paladin #7".
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
        uint256 indexed issueDate,
        uint256 indexed maturityDate,
        uint256 indexed faceValue,
        address currencyToken
    );
    // NEW (task #7): one per tranche, 1-indexed.
    event TrancheIssued(uint256 trancheNo, uint256 amount);
    // NEW (BACKLOG #6, D36): round-tagged stale-settle notification from BondTracker.
    event StaleLockSettled(bytes32 indexed lockId, uint256 round, uint256 amount);

    address public custodian;
    TokenDistribution public distribution;
    address public currencyToken;
    // CHANGED (task #7): now the CUMULATIVE total across every tranche, not just the latest one.
    uint256 public totalSupply;

    // NEW (task #7): 1-indexed count of tranches issued so far.
    uint256 public trancheCount;
    // NEW (task #7): the amount of the CURRENT tranche awaiting its own distribution round --
    // separate from `totalSupply` because a reopening's distribution must only offer the NEW
    // tranche's units, not re-offer the whole cumulative supply (which would let tranche 1's
    // already-distributed units be "purchased" a second time).
    uint256 internal _pendingTrancheAmount;

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

    function onIssue(address to, uint256 amount) external onlyOwner {
        // D35 status gate (defense-in-depth, BACKLOG #1): production reachability is already
        // gated by BondTracker.onMint's own gate (the onlyOwner here is the privacy group's
        // own address per client.ts deploy, so only a PenteExternalCall from onMint lands
        // here), but this contract must backstop it in isolation too. One rule per status:
        // INITIALIZED allowed (first ever mint, nothing distributed yet);
        // DISTRIBUTION_COMPLETE allowed (a fully-sold round reopens immediately -- documented
        // in beginDistribution's comment and exercised by
        // testBeginDistributionAllowsNewRoundOnceThePreviousIsFullySold, and
        // testBeginDistributionSucceedsAfterForceCompleteWithRemainder's force-complete path);
        // ACTIVE allowed (formally closed + setActive -- the D34 burn-on-reopen flow mints
        // tranche 2 here); ISSUED rejected (a second mint before ANY distribution round ever
        // started -- nothing could have sold out in between, so re-minting here would silently
        // add supply outside a round); DISTRIBUTION_STARTED rejected (a round is actively
        // selling -- the pre-D35 hole: without this gate, onIssue silently reset _status to
        // ISSUED and began a new round on top of an open one); DISTRIBUTION_CLOSED rejected
        // (round finished but not yet setActive -- D34 ordering requires closeDistribution
        // then setActive BEFORE mintTranche; minting in CLOSED would skip that ordering
        // check).
        require(
            _status == Status.INITIALIZED ||
                _status == Status.DISTRIBUTION_COMPLETE ||
                _status == Status.ACTIVE,
            "Bond must be either unissued, fully sold out, or fully active to issue more supply"
        );
        custodian = to;
        // CHANGED: was `totalSupply = amount;` (overwrite).
        totalSupply += amount;
        _pendingTrancheAmount = amount;
        trancheCount += 1;
        _status = Status.ISSUED;
        emit StatusChanged(_status);
        emit CustodianChanged(to);
        emit TrancheIssued(trancheCount, amount);
    }

    // NEW: BondTracker (private) never notified this contract on burn, so totalSupply drifted
    // stale after every redemption -- only incremented, never decremented. Mirrors onIssue's
    // access control exactly. No event: unlike onIssue, a burn doesn't also change custodian/
    // status/trancheCount, so there's nothing else here worth a StatusChanged-style signal.
    // Solidity ^0.8.20's built-in underflow revert on `-=` already makes an over-burn
    // impossible to apply silently, so no extra `require` is needed.
    function onBurn(uint256 amount) external onlyOwner {
        totalSupply -= amount;
    }

    function beginDistribution(
        uint256 discountPrice,
        uint256 minimumDenomination
    ) external onlyOwner {
        // CHANGED (lead decision, supersedes the `availableUnits() == 0` gate this replaced):
        // forceCompleteDistribution only ever flipped `_status`, never touched `distribution` --
        // so after a force-completion with units still outstanding, `availableUnits()` stayed
        // permanently non-zero and every future beginDistribution() reverted forever. Gating on
        // `_status != DISTRIBUTION_STARTED` instead covers that gap, and any other way
        // `availableUnits()` could get stuck non-zero, not just the force-complete path
        // specifically. No regression for the fully-sold case: onDistribute already flips
        // `_status` to DISTRIBUTION_COMPLETE the instant availableUnits() hits zero, so a round
        // that's fully sold but not yet formally closed via closeDistribution/setActive still
        // reopens immediately, same as before (see
        // testBeginDistributionAllowsNewRoundOnceThePreviousIsFullySold).
        require(
            address(distribution) == address(0) || _status != Status.DISTRIBUTION_STARTED,
            "Previous distribution round is not finished"
        );
        // Audit finding (economic-security agent): minimumDenomination == 0 makes
        // TokenDistribution.getPrice's `% minimumDenomination` panic on every purchase,
        // bricking the round (and, under task #7, every future reopening) immediately.
        require(minimumDenomination > 0, "minimumDenomination must be greater than zero");
        // CHANGED: was `totalSupply` (the whole cumulative amount) -- using the cumulative
        // value here would re-offer every prior tranche's already-distributed units for
        // purchase again. Only this tranche's own amount is available in this round.
        distribution = new TokenDistribution(
            address(this),
            _pendingTrancheAmount,
            currencyToken,
            discountPrice,
            minimumDenomination
        );
        _status = Status.DISTRIBUTION_STARTED;
        emit StatusChanged(_status);
    }

    function onDistribute(uint256 amount) external onlyOwner {
        require(
            address(distribution) != address(0),
            "Distribution has not been initialized"
        );
        distribution.purchase(amount);
        if (distribution.availableUnits() == 0) {
            _status = Status.DISTRIBUTION_COMPLETE;
            emit StatusChanged(_status);
        }
    }

    // Audit finding (periphery/flow-gap agents): a tranche amount that can't be cleanly
    // divided into valid purchase quantities under `discountPrice`/`minimumDenomination` (or a
    // buyer simply declining the last valid lot) can strand `distribution.availableUnits()`
    // above zero forever -- nothing else can ever set DISTRIBUTION_COMPLETE. Writes off the
    // remainder directly, without requiring TokenDistribution.purchase() to reach exactly zero.
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

    // NEW (task #6b): read-only accessors for paladin-client's getDistributionState, the
    // pre-trade guard the lead specified (bond-data-model.md, "paladin #6b: distribution
    // guard") -- BI must check a subscription's units against this before preparing the bond
    // leg / creating the atom, not rely on TokenDistribution.purchase()'s revert.
    function status() external view returns (Status) {
        return _status;
    }

    // Safe even before any round has started: distribution is address(0) until
    // beginDistribution's first call, and distribution.availableUnits() would revert on a
    // zero-address call otherwise.
    function availableUnits() external view returns (uint256) {
        return address(distribution) == address(0) ? 0 : distribution.availableUnits();
    }

    // NEW (BACKLOG #6, D36): receiver for BondTracker's stale-lock settle branch
    // (onUnlock/handleDelegateUnlock when the lock's prepare-time round stamp is older than
    // the current round). Notification only -- reconciles the sale to its own round; no
    // status, no counters.
    // MUST exist wherever the stale branch can fire: the PenteExternalCall side effect is a
    // plain base-ledger call (PentePrivacyGroup.sol:291-298 contractAddress.functionCall, no
    // try/catch), so a missing function here reverts the whole transition. The branch only
    // fires where a stamp was written, i.e. trackers deployed with this bytecode (D33:
    // existing series keep un-stamped behavior).
    // onlyOwner = the privacy group's own address (same access control as onIssue/onBurn --
    // only a PenteExternalCall dispatched by the private side lands here).
    function onStaleLockSettled(bytes32 lockId, uint256 round, uint256 amount) external onlyOwner {
        emit StaleLockSettled(lockId, round, amount);
    }
}
