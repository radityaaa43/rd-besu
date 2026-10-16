// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {NotoTrackerERC20} from "paladin-private/NotoTrackerERC20.sol";
import {NotoLocks} from "paladin-private/NotoLocks.sol";
import {InvestorList} from "paladin-private/InvestorList.sol";

/**
 * Fork of upstream BondTracker.sol (solidity/contracts/private/BondTracker.sol), for lead
 * task #7 -- reopening (tap issuance) support. Depends on the UNCHANGED private contracts
 * NotoTrackerERC20/InvestorList/NotoLocks and interfaces INotoHooks/IPenteExternalCall/
 * ITransferPolicy via the `paladin-private/` remapping (Paladin/contracts/remappings.txt), not
 * copied -- same read-only-dependency pattern as every TS package's SDK `file:` dependency.
 *
 * ONE change from upstream. Originally proposed as two (see
 * docs/superpowers/sdd/2026-10-05-bond-tracker-reopening-fork-proposal.md), but that proposal
 * had a sequencing error, caught while writing this fork, not by the lead's review: onMint()
 * ALWAYS sets `_status = Status.ISSUED` on exit, regardless of whether it ran from INITIALIZED
 * or ACTIVE, and nothing else touches `_status` in between onMint() and beginDistribution() --
 * so beginDistribution()'s existing `_status == Status.ISSUED` gate is ALREADY satisfied for a
 * reopened tranche without any change. Only onMint()'s own gate needs relaxing.
 */
contract BondTracker is NotoTrackerERC20 {
    enum Status {
        INITIALIZED,
        ISSUED,
        DISTRIBUTION_STARTED,
        DISTRIBUTION_CLOSED,
        ACTIVE
    }

    Status internal _status;
    address internal _publicTracker;
    address internal _issuer;
    address internal _custodian;
    InvestorList public investorList;

    // Task #24 (lead-approved fund-safety fix): BondTracker cannot read BondTrackerPublic's state
    // (a private Pente contract has no eth_call), so it keeps its own mirror of the values
    // onPrepareUnlock needs to enforce TokenDistribution.purchase's 2 rules BEFORE a lock is even
    // prepared, instead of letting a violation surface only at settlement (see
    // handleDelegateUnlock's own "KNOWN RESIDUAL RISK" comment -- a revert there, after the real
    // token transfer already confirmed, can no longer be undone).
    // KNOWN RESIDUAL LIMITATION (flagged, not engineered around here): this mirror is checked,
    // not reserved, at prepare time. Two legs BOTH prepared concurrently before either settles
    // are both checked against the same not-yet-decremented _availableUnitsPrivate -- the second
    // one to actually settle could still find insufficient units at that point. Fully closing
    // that needs a "reserve at prepare, release on cancel" pattern, not possible today because
    // Noto's cancelLock has no hook back into this contract at all.
    uint256 internal _pendingTrancheAmount;
    uint256 internal _discountPrice;
    uint256 internal _minimumDenomination;
    uint256 internal _availableUnitsPrivate;

    // BACKLOG #6 (D36): round id for stale-lock accounting -- stamped on locks at prepare,
    // compared at settle; stale locks settle as round-tagged non-sales (D36).
    uint256 internal _roundSeq;
    mapping(bytes32 => uint256) internal _lockRound;

    // Test/introspection-only: exposes the private mirror so tests can confirm it tracks real
    // consumption (not part of the fund-safety fix's own logic).
    function availableUnitsPrivate() external view returns (uint256) {
        return _availableUnitsPrivate;
    }

    modifier onlyIssuer(address sender) {
        require(sender == _issuer, "Sender is not bond issuer");
        _;
    }

    modifier onlyCustodian(address sender) {
        require(sender == _custodian, "Sender is not bond custodian");
        _;
    }

    constructor(
        string memory name,
        string memory symbol,
        address custodian,
        address publicTracker
    ) NotoTrackerERC20(name, symbol) {
        _status = Status.INITIALIZED;
        _publicTracker = publicTracker;
        _issuer = msg.sender;
        _custodian = custodian;
        investorList = new InvestorList(custodian);
    }

    function beginDistribution(
        uint256 discountPrice,
        uint256 minimumDenomination
    ) external onlyCustodian(msg.sender) {
        require(_status == Status.ISSUED, "Bond has not been issued");
        // BACKLOG #6 (D36): every reopen opens a new round -- locks prepared before this call
        // are stale the moment it confirms.
        _roundSeq++;
        _status = Status.DISTRIBUTION_STARTED;
        _discountPrice = discountPrice;
        _minimumDenomination = minimumDenomination;
        _availableUnitsPrivate = _pendingTrancheAmount;
        emit PenteExternalCall(
            _publicTracker,
            abi.encodeWithSignature(
                "beginDistribution(uint256,uint256)",
                discountPrice,
                minimumDenomination
            )
        );
    }

    // Audit finding (periphery/flow-gap agents): TokenDistribution.purchase requires every
    // quantity's price to divide evenly by minimumDenomination, so a tranche amount/price/
    // denomination combination that leaves an unpurchasable remainder (or a griefing buyer who
    // declines the last valid lot) can strand availableUnits() above zero forever, with no
    // other way to reach DISTRIBUTION_COMPLETE -- permanently blocking closeDistribution,
    // setActive, and every future reopening. This lets the custodian write off the remainder
    // and finish the round anyway.
    function forceCompleteDistribution() external onlyCustodian(msg.sender) {
        require(
            _status == Status.DISTRIBUTION_STARTED,
            "No distribution round in progress"
        );
        // Burn-on-reopen design note, fix #3: advance the PRIVATE status alongside the public
        // PenteExternalCall (the public side flips itself to DISTRIBUTION_COMPLETE in its own
        // forceCompleteDistribution, whose gate this satisfies). Closes the stale-sale-check
        // window (#3) without inventing a private DISTRIBUTION_COMPLETE state, and puts the
        // burn of the unsold remainder (onBurn's gate, fix #4) under DISTRIBUTION_CLOSED
        // before closeDistribution is separately called.
        _status = Status.DISTRIBUTION_CLOSED;
        emit PenteExternalCall(
            _publicTracker,
            abi.encodeWithSignature("forceCompleteDistribution()")
        );
    }

    function closeDistribution() external onlyCustodian(msg.sender) {
        _status = Status.DISTRIBUTION_CLOSED;
        emit PenteExternalCall(
            _publicTracker,
            abi.encodeWithSignature("closeDistribution()")
        );
    }

    function setActive() external onlyIssuer(msg.sender) {
        require(
            _status == Status.DISTRIBUTION_CLOSED,
            "Bond is not ready to be activated"
        );
        _status = Status.ACTIVE;
        emit PenteExternalCall(
            _publicTracker,
            abi.encodeWithSignature("setActive()")
        );
    }

    // Task #20 (lead report, confirmed by real incident): InvestorList.checkTransfer only ever
    // checks `to` and has no exemption for the custodian -- so releaseLock-to-self (BI
    // releasing its OWN bond leg lock, recipient = custodian) and redemption's holder->custodian
    // leg both reverted "Investor is not registered", since the custodian is never itself added
    // to its own series' investor list. The custodian is the trusted bond-management party by
    // construction (same role already exempted from the sale-total accounting at :209/:266,
    // task #6b) -- always a safe recipient. Scoped to `to == _custodian` only: every other
    // recipient still goes through the real whitelist check, unchanged.
    function _checkTransfer(
        address sender,
        address from,
        address to,
        uint256 amount
    ) internal view {
        if (to == _custodian) return;
        investorList.checkTransfer(sender, from, to, amount);
    }

    function _checkTransfers(
        address sender,
        address from,
        UnlockRecipient[] calldata recipients
    ) internal view {
        for (uint256 i = 0; i < recipients.length; i++) {
            if (recipients[i].to == _custodian) continue;
            investorList.checkTransfer(
                sender,
                from,
                recipients[i].to,
                recipients[i].amount
            );
        }
    }

    // Mirrors TokenDistribution.purchase's own 2 revert conditions exactly (same arithmetic), so
    // a sale that would fail there is rejected HERE first, before any lock is prepared -- see the
    // storage fields' own doc comment above for why this mirror exists.
    function _checkSaleAllowed(uint256 quantity) internal view {
        require(quantity <= _availableUnitsPrivate, "Sale would exceed this round's available units");
        require((quantity * _discountPrice) % _minimumDenomination == 0, "Sale amount is not a valid denomination multiple");
    }

    // V1 lock-hook audit (same session as bug #1 below): mint-shaped lock hooks
    // (onCreateMintLock/onPrepareMintUnlock) prepare recipients for units that will only exist
    // once the lock unlocks -- same rule onMint already enforces (require(to == _custodian,
    // ...)) must hold here too, since neither hook ever calls onMint and nothing else would
    // catch a non-custodian target before that unlock executes.
    function _checkMintRecipients(UnlockRecipient[] calldata recipients) internal view {
        for (uint256 i = 0; i < recipients.length; i++) {
            require(recipients[i].to == _custodian, "Bond must be issued to custodian");
        }
    }

    function onMint(
        address sender,
        address to,
        uint256 amount,
        bytes calldata data,
        PreparedTransaction calldata prepared
    ) external virtual override onlyIssuer(sender) {
        require(to == _custodian, "Bond must be issued to custodian");
        // CHANGED (task #7): was `require(_status == Status.INITIALIZED, ...)`. Reopening
        // (tap issuance) mints more supply on the SAME token once the prior tranche's full
        // cycle has reached ACTIVE -- everything else in this contract (the ERC20 balance via
        // _onMint, the InvestorList whitelist, closeDistribution/setActive) already works
        // correctly across multiple tranches with no change; only this gate blocked it.
        require(
            _status == Status.INITIALIZED || _status == Status.ACTIVE,
            "Bond must be either unissued or fully active to mint more supply"
        );
        // Audit finding (execution-trace/periphery agents): amount == 0 makes the next
        // TokenDistribution report availableUnits()==0 at construction with no sale ever
        // happening, so onDistribute() (the only thing that sets DISTRIBUTION_COMPLETE) never
        // fires -- permanently bricking closeDistribution/setActive/every future reopening.
        require(amount > 0, "Mint amount must be greater than zero");
        _onMint(sender, to, amount, data, prepared);
        _status = Status.ISSUED;
        emit PenteExternalCall(
            _publicTracker,
            abi.encodeWithSignature("onIssue(address,uint256)", to, amount)
        );
        _pendingTrancheAmount = amount;
    }

    // NEW: upstream never overrides onBurn, so BondTrackerPublic was never told about burns --
    // its totalSupply only ever grew, never shrank, drifting stale after every redemption
    // (the final step of a bond's lifecycle, after the holder already received its bond via
    // transfer/unlock). Modifier kept as inherited `onlySelf(sender, from)`, NOT swapped for
    // onlyIssuer/onlyCustodian: burn's security model is "sender can only burn its OWN
    // already-received balance", same as upstream NotoTrackerERC20.onBurn.
    // Calls `_onBurn` directly (not `super.onBurn`) to match onMint/onTransfer/onUnlock's own
    // style here, which all call their internal `_on*` helper rather than `super.on*`.
    // `_onBurn` (NotoTrackerERC20.sol) already emits PenteExternalCall(prepared.contractAddress,
    // prepared.encodedCall) for the real base-ledger burn call -- that's unrelated to and
    // must not be confused with the SEPARATE second PenteExternalCall below, which notifies
    // the public tracker, mirroring onMint's exact pattern.
    // No status gate (unlike onTransfer's DISTRIBUTION_STARTED check, which exists only to
    // exclude self-transfer from the sale-total count during an active distribution round):
    // a burn only happens at bond maturity/redemption, which is necessarily AFTER a
    // distribution round is fully closed, not during one -- there is no analogous
    // sale-counting concern here, so the notification fires unconditionally on every burn.
    function onBurn(
        address sender,
        address from,
        uint256 amount,
        bytes calldata data,
        PreparedTransaction calldata prepared
    ) external virtual override onlySelf(sender, from) {
        // Burn-on-reopen design note, fix #4 (lead-corrected gate, covers BOTH pre-close
        // statuses since forceCompleteDistribution now flips the private side to
        // DISTRIBUTION_CLOSED before the burn runs): a burn during an open distribution
        // round may only retire the round's unsold remainder -- burning more than
        // _availableUnitsPrivate would silently shrink what the round can still sell.
        // Redemption burns run in ACTIVE status and are unaffected.
        if (
            _status == Status.DISTRIBUTION_STARTED ||
            _status == Status.DISTRIBUTION_CLOSED
        ) {
            require(amount <= _availableUnitsPrivate, "burn > unsold");
        }
        _onBurn(sender, from, amount, data, prepared);
        emit PenteExternalCall(
            _publicTracker,
            abi.encodeWithSignature("onBurn(uint256)", amount)
        );
    }

    function onTransfer(
        address sender,
        address from,
        address to,
        uint256 amount,
        bytes calldata data,
        PreparedTransaction calldata prepared
    ) external virtual override onlySelf(sender, from) {
        _checkTransfer(sender, from, to, amount);
        _onTransfer(sender, from, to, amount, data, prepared);
        // Task #20 fix (solidity-auditor, post-fix delta, 11/12 agents converged): this
        // condition used to be accidentally protected by the investor-whitelist bug this same
        // task fixes -- a custodian self-transfer (from==to==_custodian) could never reach here
        // because `to` wasn't registered. Now that `to == _custodian` is exempted from the
        // whitelist, a pure self-transfer (net balance unchanged) would otherwise still report
        // `onDistribute(amount)` to the public tracker as a real sale. Exclude `to == _custodian`
        // the same way `onUnlock`'s sale-total loop already does (a refund/self-move is not a
        // sale).
        if (_status == Status.DISTRIBUTION_STARTED && from == _custodian && to != _custodian) {
            _availableUnitsPrivate -= amount;
            emit PenteExternalCall(
                _publicTracker,
                abi.encodeWithSignature("onDistribute(uint256)", amount)
            );
        }
    }

    function onUnlock(
        address sender,
        bytes32 lockId,
        UnlockRecipient[] calldata recipients,
        bytes calldata data,
        PreparedTransaction calldata prepared
    ) external virtual override onlyLockOwner(sender, lockId) {
        // Lead finding (task #6b): captured BEFORE _onUnlock, which deletes the lock entry once
        // fully unlocked -- _locks.ownerOf(lockId) would read address(0) afterward.
        address lockFrom = _locks.ownerOf(lockId);
        _checkTransfers(sender, lockFrom, recipients);
        _onUnlock(sender, lockId, recipients, data, prepared);
        // CHANGED (task #6b): mirror onTransfer's notification, for a lock owner who unlocks
        // directly (no delegate). NOTE: this is NOT the hook BondSubscription.distribute()'s
        // Atom-delegated execution actually fires -- that path confirmed (reading
        // domains/noto/internal/noto/events.go:handleNotaryPrivateUnlock, which dispatches
        // handleDelegateUnlock, never onUnlock, whenever the unlock was executed by a delegate)
        // to invoke handleDelegateUnlock below instead. Kept here too since onUnlock is still a
        // real, legitimate non-delegated path. Never mirrored in onPrepareUnlock -- a
        // prepared-but-never-executed unlock must not count toward the sale.
        // D37 (lead decision 2026-10-08, review finding F2): the settle-time accounting block
        // used to be gated entirely on DISTRIBUTION_STARTED, so a custodian-originated settle
        // landing while the round was already CLOSED (or the token ACTIVE) reported NOTHING --
        // neither onDistribute nor onStaleLockSettled -- even though the units really moved.
        // Restructured: any custodian-originated settle with a non-custodian recipient is
        // either an in-round sale (STARTED + current-round stamp -> decrement + onDistribute,
        // unchanged) or reported as a round-tagged non-sale (event-only, never a revert; the
        // receiver exists and is onlyOwner). Round stamp N is carried verbatim -- forceComplete
        // does NOT increment _roundSeq, so a round-N lock settled after close still reports N.
        if (lockFrom == _custodian) {
            uint256 total = 0;
            for (uint256 i = 0; i < recipients.length; i++) {
                // Lead decision (task #6b): a recipient == _custodian (e.g. a refund) is not a
                // sale and must not inflate availableUnits' decrement.
                if (recipients[i].to != _custodian) {
                    total += recipients[i].amount;
                }
            }
            if (_status == Status.DISTRIBUTION_STARTED && _lockRound[lockId] == _roundSeq) {
                _availableUnitsPrivate -= total;
                emit PenteExternalCall(
                    _publicTracker,
                    abi.encodeWithSignature("onDistribute(uint256)", total)
                );
            } else if (total > 0) {
                // BACKLOG #6 (D36) + D37: stale lock -- prepared under a previous round, or the
                // round it belongs to is no longer open. NEVER revert: on the delegate path the
                // real base-ledger transfer already confirmed (:436-443 desync risk), so
                // reverting would undo private/public sync, strictly worse than the bug.
                // Account it explicitly: the current round's counter untouched (cap cannot be
                // oversold), sale reported to the public tracker as a round-tagged non-sale.
                emit PenteExternalCall(
                    _publicTracker,
                    abi.encodeWithSignature(
                        "onStaleLockSettled(bytes32,uint256,uint256)",
                        lockId,
                        _lockRound[lockId],
                        total
                    )
                );
            }
        }
    }

    function onPrepareUnlock(
        address sender,
        bytes32 lockId,
        UnlockRecipient[] calldata recipients,
        bytes calldata data,
        PreparedTransaction calldata prepared
    ) external virtual override onlyLockOwner(sender, lockId) {
        address lockFrom = _locks.ownerOf(lockId);
        _checkTransfers(sender, lockFrom, recipients);
        if (_status == Status.DISTRIBUTION_STARTED && lockFrom == _custodian) {
            uint256 quantity = 0;
            for (uint256 i = 0; i < recipients.length; i++) {
                // Same exclusion as onUnlock/onTransfer/handleDelegateUnlock's own sale-total
                // loops -- a recipient == _custodian (a refund) is not a sale.
                if (recipients[i].to != _custodian) {
                    quantity += recipients[i].amount;
                }
            }
            _checkSaleAllowed(quantity);
            // BACKLOG #6 (D36): stamp the round this sale check ran under; re-prepare refreshes
            // the stamp (a cross-round re-prepare re-checks against the new round).
            _lockRound[lockId] = _roundSeq;
        }
        _onPrepareUnlock(sender, lockId, recipients, data, prepared);
    }

    // Bug #1 (lead-confirmed): upstream's onCreateTransferLock calls the INTERNAL
    // _onPrepareUnlock helper directly, bypassing this contract's own CHECKED onPrepareUnlock
    // override above (and its _checkTransfers whitelist call) entirely -- gated only by
    // onlySelf(sender, from), so any investor holder could create a transfer-lock to an
    // unregistered address with zero whitelist enforcement. Fix: run the same _checkTransfers
    // onPrepareUnlock already runs (task #20's custodian exemption applies automatically, no
    // special-casing needed), then do exactly what upstream's own default body does
    // (_locks.onLock + _onPrepareUnlock) -- matching this file's established pattern of calling
    // the internal `_on*`/`_locks.on*` helpers directly rather than `super.x()`.
    function onCreateTransferLock(
        address sender,
        bytes32 lockId,
        address from,
        uint256 amount,
        UnlockRecipient[] calldata recipients,
        bytes calldata data,
        PreparedTransaction calldata prepared
    ) external virtual override onlySelf(sender, from) {
        _checkTransfers(sender, from, recipients);
        // BACKLOG #5: this hook prepares the same unlock as onPrepareUnlock above (it calls the
        // same _onPrepareUnlock helper), but was missing that hook's Task #24 sale check --
        // mirror onPrepareUnlock's quantity/denomination gate exactly (using this hook's `from`
        // as the locked-balance holder). Dead path for this platform today (zero
        // createTransferLock usages), fixed for correctness of the abstract surface.
        if (_status == Status.DISTRIBUTION_STARTED && from == _custodian) {
            uint256 quantity = 0;
            for (uint256 i = 0; i < recipients.length; i++) {
                // Same exclusion as onUnlock/onTransfer/handleDelegateUnlock's own sale-total
                // loops -- a recipient == _custodian (a refund) is not a sale.
                if (recipients[i].to != _custodian) {
                    quantity += recipients[i].amount;
                }
            }
            _checkSaleAllowed(quantity);
            // BACKLOG #6 (D36): same round stamp as onPrepareUnlock (this hook is the same
            // prepare).
            _lockRound[lockId] = _roundSeq;
        }
        _locks.onLock(lockId, from, amount);
        _onPrepareUnlock(sender, lockId, recipients, data, prepared);
    }

    // V1 lock-hook audit: mint-shaped, like onMint -- recipients here are where newly-minted
    // units will land once this lock unlocks, so they must be custodian-only for the same
    // reason onMint requires `to == _custodian`. Upstream's default never checked this at all.
    // Otherwise matches upstream's onCreateMintLock body exactly (no _locks.onLock call -- a
    // mint lock has no existing `from` balance to lock).
    function onCreateMintLock(
        address sender,
        bytes32 lockId,
        UnlockRecipient[] calldata recipients,
        bytes calldata data,
        PreparedTransaction calldata prepared
    ) external virtual override onlyNotary(sender) {
        // BACKLOG #6 (D36): no round stamp -- custodian-only recipients per _checkMintRecipients are never sales (excluded from sale totals :353/:502).
        _checkMintRecipients(recipients);
        _onPrepareUnlock(sender, lockId, recipients, data, prepared);
    }

    // Same reasoning as onCreateMintLock, for the matching prepare-unlock step of a mint lock.
    function onPrepareMintUnlock(
        address sender,
        bytes32 lockId,
        UnlockRecipient[] calldata recipients,
        bytes calldata data,
        PreparedTransaction calldata prepared
    ) external virtual override onlyNotary(sender) {
        // BACKLOG #6 (D36): no round stamp -- custodian-only recipients per _checkMintRecipients are never sales (excluded from sale totals :353/:502).
        _checkMintRecipients(recipients);
        _onPrepareUnlock(sender, lockId, recipients, data, prepared);
    }

    // CHANGED (task #6b): this -- not onUnlock -- is the hook Noto actually calls when a
    // DELEGATE (e.g. the Atom in BondSubscription's DvP flow, the real production distribution
    // path) executes an already-prepared unlock on the base ledger -- confirmed by reading
    // domains/noto/internal/noto/events.go's handleNotaryPrivateUnlock, which dispatches
    // handleDelegateUnlock whenever the unlock was executed by a delegate, never onUnlock.
    // Without this, onUnlock's fix alone does not cover that path, and reopening remains
    // permanently blocked in production despite the forge-level fix.
    // KNOWN RESIDUAL RISK (flagged, not engineered around here): per Noto's own domain code,
    // this hook runs in its OWN transaction, AFTER the real base-ledger unlock has already been
    // confirmed -- unlike onMint/onTransfer/onUnlock, which run atomically WITH the real token
    // movement. If BondTrackerPublic.onDistribute ever reverts here, Pente's atomicity still
    // reverts this hook's own private-state update (the _transfer below), but the real,
    // already-confirmed base-ledger transfer cannot be undone -- a private/public balance
    // desync, not merely a stalled status. onDistribute's only revert condition today
    // (`distribution` uninitialized) should never be true on this path in practice.
    function handleDelegateUnlock(
        address /* sender */,
        bytes32 lockId,
        UnlockRecipient[] calldata recipients,
        bytes calldata /* data */
    ) external virtual override {
        // D21 fix (post-E2E backlog, "handleDelegateUnlock access-control gap"): upstream's
        // handleDelegateUnlock has NO access control at all -- any privacy-group member could
        // resolve an arbitrary lockId with arbitrary recipients and move the private ledger.
        // Gate: live-sender verified against upstream (BACKLOG "D21 gate live-sender
        // verification") -- the production hook tx is submitted FROM the token's NOTARY
        // (domains/noto/internal/noto/events.go:264, `From: domainConfig.NotaryLookup`;
        // our bond token's notary = bondCustodian, paladin-client client.ts:2219), while
        // _issuer is only the deployer. A deployer-only gate reverted every real
        // production delegate unlock. Lead decision 2026-10-07: allow BOTH -- _issuer
        // (deployer) and _custodian (notary/live sender); investors are neither. Also
        // cross-check every recipient against the (to, amount) pairs stored at prepare
        // time (NotoLocks.onPrepareUnlock), so even the authorized submitter cannot
        // redirect funds anywhere the prepared unlock didn't name.
        require(
            msg.sender == _issuer || msg.sender == _custodian,
            "Caller is not the deployer or the custodian"
        );
        NotoLocks.LockDetail memory lock = _locks.getLock(lockId);
        require(
            recipients.length == lock.recipients.length,
            "Recipients do not match the prepared unlock"
        );
        bool[] memory matched = new bool[](lock.recipients.length);
        for (uint256 i = 0; i < recipients.length; i++) {
            bool found = false;
            for (uint256 j = 0; j < lock.recipients.length; j++) {
                if (
                    !matched[j] &&
                    recipients[i].to == lock.recipients[j].to &&
                    recipients[i].amount == lock.recipients[j].amount
                ) {
                    matched[j] = true;
                    found = true;
                    break;
                }
            }
            require(found, "Recipients do not match the prepared unlock");
        }
        // Inlined from NotoTrackerERC20.handleDelegateUnlock (not split into an internal `_`
        // helper upstream, unlike every other hook here, so there's nothing to call via super --
        // external functions aren't reachable through `super` either). lockFrom captured first,
        // same ordering reason as onUnlock.
        address lockFrom = _locks.ownerOf(lockId);
        _locks.handleDelegateUnlock(lockId, recipients);
        for (uint256 i = 0; i < recipients.length; i++) {
            _transfer(lockFrom, recipients[i].to, recipients[i].amount);
        }
        // D37 (lead decision 2026-10-08, review finding F2): identical restructure to onUnlock's
        // block above -- gate on lockFrom == _custodian, report any non-custodian-recipient
        // settle that is not an in-round current-stamp sale as a round-tagged non-sale.
        // MUST stay byte-for-byte equivalent in logic to onUnlock's block (lead condition #2).
        if (lockFrom == _custodian) {
            uint256 total = 0;
            for (uint256 i = 0; i < recipients.length; i++) {
                // Lead decision (task #6b): a recipient == _custodian (e.g. a refund) is not a
                // sale and must not inflate availableUnits' decrement.
                if (recipients[i].to != _custodian) {
                    total += recipients[i].amount;
                }
            }
            if (_status == Status.DISTRIBUTION_STARTED && _lockRound[lockId] == _roundSeq) {
                _availableUnitsPrivate -= total;
                emit PenteExternalCall(
                    _publicTracker,
                    abi.encodeWithSignature("onDistribute(uint256)", total)
                );
            } else if (total > 0) {
                // BACKLOG #6 (D36) + D37: stale lock -- prepared under a previous round, or the
                // round it belongs to is no longer open. NEVER revert: on the delegate path the
                // real base-ledger transfer already confirmed (:436-443 desync risk), so
                // reverting would undo private/public sync, strictly worse than the bug.
                // Account it explicitly: the current round's counter untouched (cap cannot be
                // oversold), sale reported to the public tracker as a round-tagged non-sale.
                emit PenteExternalCall(
                    _publicTracker,
                    abi.encodeWithSignature(
                        "onStaleLockSettled(bytes32,uint256,uint256)",
                        lockId,
                        _lockRound[lockId],
                        total
                    )
                );
            }
        }
    }
}
