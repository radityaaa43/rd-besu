# D21 gate live-sender verification (2026-10-07, paladin agent -- BLOCKING FINDING)

Lead asked: is the LIVE sender of the `handleDelegateUnlock` hook tx == `_issuer` (deployer)?
Answer: **NO -- it is the token's NOTARY.** Evidence (upstream source):

- `domains/noto/internal/noto/events.go:199` `handleNotaryPrivateUnlock` -- code path fired
  when a delegate (Atom) executes an already-prepared unlock. At `events.go:258-266` it builds
  the hook tx via `n.Callbacks.SendTransaction(...)` with `From: domainConfig.NotaryLookup`
  (events.go:264). The hook tx is submitted FROM the notary's identity, always -- regardless
  of who the delegate was.
- `NotaryLookup` derived from the token's configured notary at deploy:
  `domains/noto/internal/noto/noto.go:611-622` (`params.Notary` fully-qualified).
- Our bond token's notary = **bondCustodian** (`paladin-client/src/client.ts:2219`,
  `notary: bondCustodian` in the per-series `newNoto` call).
- `BondTracker._issuer` = the account that DEPLOYED the tracker = **bondIssuer**
  (constructor `_issuer = msg.sender`, BondTracker.sol:78; tracker deployed via bondIssuer).

Consequence: the D21 gate `require(msg.sender == _issuer)` (BondTracker.sol:433) WILL REVERT
on every real production delegate unlock -- live `msg.sender` on the hook call is the
NOTARY's derived identity (bondCustodian side), not `_issuer` (bondIssuer). Forge tests pass
because they prank `issuer` directly; that sender shape never occurs live.

Fix options (lead decides before ANY redeploy):
(a) gate on `_custodian` instead of `_issuer` (custodian = notary = live sender), or
(b) allow BOTH `_issuer` and `_custodian`, or
(c) drop the sender gate, keep only the recipient cross-check (sender-independent, still
closes the "arbitrary recipients" half of the gap).

**DECISION (lead, 2026-10-07): option (b) -- `require(msg.sender == _issuer ||
msg.sender == _custodian)`.** Custodian = legitimate live sender (notary); issuer = deployer;
both trusted BI-side roles; investors can be neither. (c) rejected as looser than needed,
(a) would break the deployer's direct path. Redeploy still gated on lead's GO with user.

Until decided: DO NOT redeploy BondTracker to the cluster -- live distribution settlement
would break. Recipient cross-check alone is safe and live-neutral.

# Burn-on-reopen design note (Priority 1, 2026-10-07 -- sent to lead for approval before code)

Flow (user-decided order), signer per step:
1. `forceCompleteDistribution` -- custodian (BondTracker.sol:109). #3 fix: private side ALSO
   advances its own `_status = DISTRIBUTION_CLOSED` (1 line) alongside the existing public
   `PenteExternalCall` -- public side already flips to `DISTRIBUTION_COMPLETE` itself, and
   public `closeDistribution`'s gate (`== DISTRIBUTION_COMPLETE`) stays satisfied. This closes
   the stale-sale-check window (#3) instead of inventing a private DISTRIBUTION_COMPLETE state.
2. `burn(unsold)` -- custodian, via `burnBond` (Noto burn path, hook = `onBurn`). #4 fix = the
   burn itself: burning ALL unsold units drives the custodian's bond balance to 0 before the
   next mint, so `beginDistribution`'s existing `_availableUnitsPrivate = _pendingTrancheAmount`
   sizing becomes exactly right -- no new carried-over sizing logic needed. Gate (lead-corrected:
   covers BOTH pre-close statuses, since forceComplete now flips private to DISTRIBUTION_CLOSED
   before the burn runs): `if (_status == Status.DISTRIBUTION_STARTED || _status ==
   Status.DISTRIBUTION_CLOSED) require(amount <= _availableUnitsPrivate, "burn > unsold")`.
   Redemption burns run in ACTIVE, unaffected.
3. `closeDistribution` -- custodian. 4. `setActive` -- issuer. 5. `mintTranche` -- issuer.
6. `beginDistribution` -- custodian, unchanged.
Events: existing `StatusChanged` / `TrancheIssued` / `PenteExternalCall` only; no new events.
Forge: positive (reopen after burn -> burned, totalSupply = sold + new tranche), negative
(force-complete with no round active reverts; burn > unsold reverts in BOTH pre-close statuses
-- DISTRIBUTION_STARTED and after forceComplete DISTRIBUTION_CLOSED), regression D27 sell-out.

# Design note (Priority item #6, 2026-10-08 -- sent to lead for approval before code)

Problem: every lock settles against whatever the CURRENT round slots hold
(`_availableUnitsPrivate`/`_discountPrice`/`_minimumDenomination`, BondTracker.sol:50-53; public
`distribution`, BondTrackerPublic.sol:47). A lock prepared under tranche N but settled after a
`beginDistribution()` reopen decrements tranche N+1's counter with NO cap/denomination re-check
(handleDelegateUnlock BondTracker.sol:497-506; direct-transfer sale check only exists at
prepare, BondTracker.sol:357/:395) -- or underflows at :506 AFTER the real base-ledger transfer
confirmed, the exact desync the residual-risk comment at :436-443 warns about.

## Design options considered

(a) Snapshot (price, denomination, availableUnits) per lock at prepare. Storage: 3 slots per
lock in a new BondTracker mapping keyed by lockId. Failure mode left open: settlement never
consumes price (it is a prepare-time check only, BondTracker.sol:185-188), and a snapshot
`availableUnits` cannot be kept consistent without reserve-at-prepare/release-on-cancel --
impossible today because cancelLock has no hook into this contract (BondTracker.sol:48-49).
Stores state nothing reads back.
(b) Stamp a round id only: new `_roundSeq` (incremented in beginDistribution, BondTracker.sol:84)
plus `mapping(bytes32 => uint256) _lockRound`, written in the prepare hooks, compared at
settlement. Storage: 1 global + 1 per lock. Failure mode left open: a stale lock's REAL
transfer still completes (unavoidable on the delegate path), but it is accounted explicitly as
a stale settlement instead of silently hitting the new round. RECOMMENDED: the only fact
settlement needs is "under which round did this lock's prepare-time sale check run"
(BondTracker.sol:357/:395); price/denomination snapshots add storage with no settlement-time
consumer, and the round id is the minimal sufficient stamp.
(c) Reject/void open custodian locks at beginDistribution. NOT implementable without new
infrastructure: NotoLocks has no lock enumeration (mapping only, NotoLocks.sol:11), so
beginDistribution cannot discover open lock ids; and voiding the tracker-side record would not
release the real base-ledger lock (lockedBalance stays encumbered, NotoLocks.sol:37).
Voiding would desync more than it fixes.

DECISION: option (b).

## Flow with signer per step

1. Prepare (stamping): custodian (bondCustodian, live hook sender = token notary -- BACKLOG
   "D21 gate live-sender verification") submits lockToken + prepareUnlock; hook tx hits
   `onPrepareUnlock` (gate `onlyLockOwner`, BondTracker.sol:345). Stamp
   `_lockRound[lockId] = _roundSeq` next to the existing `_checkSaleAllowed(quantity)`
   (:357). Re-prepare overwrites recipients (NotoLocks.sol:61-66), so the stamp refreshes on
   every prepare -- a cross-round re-prepare re-checks against the NEW round and re-stamps.
2. Prepare via lock creation: `onCreateTransferLock` (BondTracker.sol:371-399, #5's gate at
   :386-396) is structurally the same prepare (`_onPrepareUnlock`, :398) -- stamp there too
   (:395 vicinity), same round value.
3. Mint-shaped locks (`onCreateMintLock` :406, `onPrepareMintUnlock` :418): recipients are
   custodian-only (`_checkMintRecipients`), so they are never sales (custodian recipients
   excluded from sale totals at :353/:502) -- no stamp needed.
4. Settle, production DvP path: delegate (Atom) executes the prepared unlock; the notary
   submits the `handleDelegateUnlock` hook (gate :463-466; runs AFTER the real base-ledger
   unlock confirmed, :436-443). At BondTracker.sol:497: if
   `_lockRound[lockId] == _roundSeq`, behave exactly as today (decrement :506 + onDistribute
   :507-510); if STALE, do NOT touch `_availableUnitsPrivate` and do NOT emit the new round's
   `onDistribute` -- emit instead a round-tagged notification,
   `PenteExternalCall(_publicTracker, "onStaleLockSettled(bytes32,uint256,uint256)", lockId,
   stampedRound, total)` at the same spot (:506), so backend/BI reconcile the sale to its own
   round. The `_transfer` mirror (:495) and `_locks.handleDelegateUnlock` (:493) run
   unchanged either way.
5. Settle, direct path: `onUnlock` (BondTracker.sol:302-337, decrement :331) -- same
   stamped-vs-current branch at :322, same stale behavior as step 4 (kept identical across
   both settle paths on purpose; onUnlock COULD revert safely since it is atomic with the
   real movement (:437-438), but one behavior is easier to reason about than two).

## Exact gate/revert conditions

- Prepare, current round: unchanged -- `_checkSaleAllowed` (:185-188) as today.
- Settle, stale lock: NO revert on either settle path. Reverting is only safe on the direct
  path; on the delegate path a revert after the real transfer = private/public desync
  (:436-443), strictly worse than the bug. Stale settle = real transfer stands, new round's
  counter untouched (cap cannot be oversold -- stale settle decrements nothing), sale accounted
  via the round-tagged event only.
- Interaction with `_availableUnitsPrivate` invariants: set at beginDistribution =
  `_pendingTrancheAmount` (BondTracker.sol:92), decremented on sale paths :294/:331/:506. The
  stale branch skips the decrement, so a reopened round's sizing (and the burn gate's
  `require(amount <= _availableUnitsPrivate, "burn > unsold")`, :266) stay exact for the NEW
  round.
- Round 0 stamp means "never prepared" and is deliberately a NON-SALE (no decrement, no
  onDistribute) -- do not "fix" this into a sale; a sale is only ever counted through a
  prepare (lead-ratified 2026-10-08).

## Forge cases (one line each; helpers `_fresh` :42, `_one` :48)

- Positive (current round unchanged): prepare under round 1, delegate-settle via
  handleDelegateUnlock -- decrement + onDistribute exactly as testHandleDelegateUnlock...:260.
- Positive (stale, delegate): prepare under tranche 1, forceComplete+burn+reopen to tranche 2
  (round 2), settle the round-1 lock -- no revert, `_availableUnitsPrivate` unchanged, no
  onDistribute, stale event emitted.
- Positive (stale, direct): same via onUnlock -- same expected.
- Positive (re-prepare): stale lock re-prepared under round 2 -- stamp refreshes,
  `_checkSaleAllowed` runs against round 2, settle then decrements round 2 normally.
- Negative (regression D27): sell-out reopen flow still green --
  testBeginDistributionResetsMirrorForNewTrancheNotAccumulated (:862) and
  testBurnOnReopenFlowEndToEnd (:1010) pass unchanged (stamping adds no same-round behavior).
- Negative (regression D28 -- "a leg lock never outlives a failed prepare",
  2026-10-05-architecture-review.md:261): a lock whose prepare failed then was compensated
  (released, paladin-client 0.6.5) can never settle -- assert settle-after-release reverts on
  unknown lock as today; the stamp entry for a dead lockId is unreachable dead weight only.

## Cost/risk

- Storage: `_roundSeq` + `_lockRound` appended in BondTracker only. BondTracker is deployed
  fresh per series via constructor (BondTracker.sol:71-82), not a proxy -- no live storage
  compatibility issue; EXISTING deployed series keep today's un-stamped behavior until
  re-issued (same accepted pattern as D34's "existing series keep D27's behaviour",
  2026-10-05-backend-rest-api.md:397). Redeploying BondTracker is routine -- issueSeries
  deploys it for every new series; NO new user-level redeploy decision needed for future
  series.
- NotoLocks is UNCHANGED (upstream remapping, BondTracker.sol:10-13) -- option (b) touches no
  upstream file, so no NotoLocks redeploy and no LockDetail (NotoLocks.sol:19-23) storage
  question. If the lead ever wanted the stamp INSIDE LockDetail, that forks upstream and
  changes the struct for live deployed instances -- explicitly a user-level decision, not
  required by this design.
- Risk 1: stale settlement is accounted via an event, not state -- backend must consume
  `onStaleLockSettled` (cross-layer follow-up for backend/REST docs).
- Risk 2 (adjacent, NOT fixed by this design): the burn of unsold units includes
  lock-encumbered units (prepare does not reserve, :44-49) -- burning under an open lock
  strands it (later settle reverts on insufficient balance). Same root as the documented
  no-reserve limitation.
  ACCEPTED ADJACENT LIMITATION (lead, 2026-10-08): the stale branch does NOT fix this -- burning
  lock-encumbered units strands the lock (later settle reverts on insufficient balance, no
  enumeration to detect it). Operational answer is the backend's LOCKED-leg pre-check being
  added as part of D34 (lead-approved, backend [431e1e] implementing): a primary trade's lock
  must not be open across a reopen. D23 remains narrowing only (D36 item 4 rewrite).

# Post-E2E backlog (paladin contracts)

Findings confirmed real from source during the 0.6.2/0.6.3 audit passes, deferred per lead
decision D22 (2026-10-06) because they don't affect the E2E flows (E2 issuance, E3 reopening,
E5 primary, E7 cancel, E9 redemption+burn) on their normal paths. Not fixed, not forgotten.

## Priorities (set by lead, 2026-10-07 -- E1-E10 all pass in real mode)

1. **#3 + #4 below** -- force-complete + burn of unsold units at reopening. The user decided
   unsold units at reopening get BURNED post-E2E
   (`forceCompleteDistribution -> burn -> closeDistribution -> setActive -> mintTranche ->
   beginDistribution`), which exercises exactly the force-complete branch #3/#4 live on. E3
   itself was redesigned (tranche 1 = 1 lot, sold out by 1 investor) specifically so
   force-complete was NOT needed during the E2E -- so this was never ON the E2E's own critical
   path, but it's the top item now that E2E has passed.
2. **`handleDelegateUnlock` access-control gap** -- see its own section near the bottom (tracked
   as D21, accepted risk during E2E). Add the `msg.sender == the deployer` gate +
   cross-check recipients against `lock.recipients`.
3. **#10 below** -- `issueSeries` pre-flight encoding validation, so a bad ISIN/date/hash never
   orphans a group + 2 trackers + a Noto token again.
4. **New (D31, 2026-10-07)**: the D30 presence-probe pattern (`onboard-presence-probe`, seen
   repeatedly in guard-check logs this session as a `transaction reverted` + `PD011206` ERROR
   pair) is a deliberate existence check, not a failure -- but it logs a real ERROR line every
   time it runs, costing guard-check signal (every occurrence has to be manually distinguished
   from a genuine revert). Found the call site: `backend/shared/src/events/atomParties.ts:17`
   -- `paladin.getAgreement(groupId, agreementAddress, "onboard-presence-probe")`, a bogus
   tradeId that deliberately never exists, relying on `Agreement.getAgreement`'s own
   "TradeNotFound"-style revert to distinguish "group/contract present" from "missing". This is
   backend's own code calling an EXISTING `paladin-client` method in a revert-as-signal way, not
   a bug in `getAgreement` itself. Fix belongs on either side: (a) backend-side, replace the
   probe with a Noto/Pente existence check that doesn't synthesize a guaranteed-revert call
   (e.g. check group membership/contract code presence some other way); or (b) paladin-client
   adds a dedicated `agreementExists(groupId, agreementAddress)` helper that does the same
   presence check via a path that returns false instead of reverting. Not sized/assigned yet --
   whoever picks this up should agree the approach with the other layer first, since it's a
   genuine cross-layer call.

## 1. `BondTrackerPublic.onIssue` has no local `_status` gate

`onIssue` unconditionally overwrites `_status = Status.ISSUED` with no precondition of its own
-- relies entirely on `BondTracker.onMint`'s own gate (`_status == INITIALIZED || ACTIVE`,
private side) to never call it at the wrong time. Confirmed not independently reachable:
`onIssue` is `onlyOwner` where owner = the privacy group's own address (`client.ts:2097`,
`owner: group.address`), so it can only ever be invoked via a `PenteExternalCall` emitted from
inside that group -- the only contract in the group that ever constructs that exact call is
`BondTracker.onMint` itself (checked `InvestorList.sol`/`NotoLocks.sol`, neither does). Not
exploitable today; a defense-in-depth gap only if `onMint`'s own gate is ever weakened.
Fix size: ~1 line (`require(_status == Status.INITIALIZED || _status == Status.ACTIVE, ...)`
mirroring BondTracker's own gate) if ever prioritized.

## 2. Mint-lock finalization (`onCreateMintLock`/`onPrepareMintUnlock` -> `handleDelegateUnlock`) always reverts

Neither hook calls `_locks.onLock`, so `lock.amount`/`lock.from` stay `0`/`address(0)`
forever -- resolving the lock via `handleDelegateUnlock` always underflows or hits a
zero-address revert, AFTER the real base-ledger mint is already confirmed (same timing
concern as the already-fixed sale-denomination issue). Confirmed NOT reachable for this
platform: grepped `common/paladin-client/src/client.ts` and every bond/swap-noto example for
`createMintLock`/`prepareMintUnlock` -- zero usages anywhere. Issuance (E2) always uses plain
`mint`, never a mint-lock. Real bug in the abstract contract, not exercised by anything we run.
NOT dead upstream (upstream-tickets.md, 2026-10-08): upstream's own example
`examples/spend-lock-tokens/src/create-mint-lock.ts:95-196` is a real call site that would hit
the same revert. Upstream ticket written (`Paladin/upstream-tickets.md`).
`backend/shared/src/paladin/gaps.ts` also marks the broader
mint-lock surface as an acknowledged gap already.

## 3. `BondTracker.forceCompleteDistribution` never advances the PRIVATE `_status`

Only the public side's `_status` flips to `DISTRIBUTION_COMPLETE`; the private side's own
`_status` stays `DISTRIBUTION_STARTED` until `closeDistribution` is separately called. A
transfer of the force-completed remainder in that window still fires a stale sale-notification
against the already-complete public distribution and reverts. Only matters on the
force-complete branch specifically -- `E3`'s reopening test follows the normal path
(sell out, or `closeDistribution`/`setActive`), never `forceCompleteDistribution`
(`shared/src/paladin/gaps.ts:36` marks force-complete as an acknowledged backend gap, not
exposed to users). Fix size: ~1 line, advance `_status` to a matching private state inside
`forceCompleteDistribution` -- needs a design decision on which private `Status` value is
correct (there's no private-side analog to `DISTRIBUTION_COMPLETE` today, only
`DISTRIBUTION_CLOSED`/`ACTIVE`, both of which currently require `closeDistribution`/
`setActive` to have been called first -- introducing a bypass state needs its own look before
treating this as a 1-liner in practice).

## 4. Reopening can undersize the new round vs. the custodian's real leftover balance

After `forceCompleteDistribution` + a reopen, the custodian's real token balance (old
leftover + new tranche) can exceed the new round's `availableUnits()`, so an otherwise
legitimate, whitelist-passing transfer of the OLD leftover can still revert against the NEW
round's distribution object. Same branch as #3 (force-complete path only) -- not reachable by
E3 as currently scoped. Fix size: not a 1-liner -- needs a design decision on whether a
reopened round's `availableUnits` should account for carried-over leftover inventory, or
whether leftover inventory should be excluded from sale entirely until manually re-offered.

## 5. `onCreateTransferLock` doesn't enforce the quantity/denomination sale check (0.6.3's `_checkSaleAllowed`)

0.6.3 added `_checkSaleAllowed` (quantity <= available units, valid denomination) to
`onPrepareUnlock` only, deliberately excluding `onCreateTransferLock` (which also calls the
internal `_onPrepareUnlock` helper, so it has the same structural exposure). Confirmed NOT
reachable for this platform: grepped `common/paladin-client/src/client.ts` and every
bond/swap-noto example for `createTransferLock` -- zero usages anywhere, same as backlog item
#2's mint-lock reasoning. Real gap in the abstract contract, dead code path for us. Fix size:
~3 lines, duplicate `onPrepareUnlock`'s quantity-computation + `_checkSaleAllowed` call.

## 6. Cross-tranche stale-lock settlement (private mirror has no tranche/round id)

`_availableUnitsPrivate`/`_discountPrice`/`_minimumDenomination` (and the pre-existing public
`distribution`/`availableUnits()`) are single global slots with no tranche/round tag. A
custodian lock prepared under tranche N but left open across a `beginDistribution()` reopen
(task #7) settles against tranche N+1's price/denomination/cap instead of the one it was
actually prepared under -- silently wrong accounting, not a revert. This is NOT new in 0.6.3 --
the SAME pattern already existed on the public side (`onDistribute`/`distribution` is the same
kind of single global "current round" reference) before this task; 0.6.3's private mirror just
inherits the identical limitation. First surfaced in task #20's original audit (finding #5,
2 agents) and independently rediscovered during 0.6.3's audit (3 agents) -- confirmed real both
times, never previously logged here. Fix needs a tranche/round id stamped onto each lock at
creation time and checked at settlement -- not a small change, needs its own design pass.

## 7. Report upstream: `pollForReceipt`'s counter-based loop

`sdk/typescript/src/paladin.ts:128-137`'s `pollForReceipt` loops on a plain counter
(`for (let i = 0; i < waitMs; i += POLL_INTERVAL_MS)`), NOT `Date.now()` -- if a single
underlying HTTP call inside that loop hangs, the function never gets back to checking
`i < waitMs` and blocks forever, regardless of its own `waitMs` argument. Confirmed root
cause of a real 3.5-minute production hang on a backend real-mode `issueSeries` call (no
error logged, until an external process restart killed it). NOT fixed here -- out of
scope for `paladin-client` (the upstream SDK, `/home/ecs-user/eksplorasi-paladin`, is
untouched by design). 0.6.4 only adds a defensive outer bound in this package
(`withReceiptDeadline` in `src/errors.ts`, wired into both of our own direct
`pollForReceipt` call sites) so OUR code can't hang past `waitMs` even though the SDK
itself still can. Recommend reporting this to the upstream Paladin project.

## 8. Report upstream: no axios request timeout configured

`sdk/typescript/src/paladin.ts:56-59`'s axios instance has no `timeout` configured, so
nothing bounds how long a single stalled HTTP request can hang underneath
`pollForReceipt` (see #7) or any other SDK call. NOT fixed here, same reasoning as #7 --
0.6.4 sets `timeout: 30000` on OUR OWN `requestConfig` when constructing the SDK
(`client.ts`'s `connect`), which is the only lever this package has; the SDK's internal
axios instance itself is untouched. Recommend reporting this to the upstream Paladin
project.

## 9. Incident `issueSeries` approval `cc982051-19cc-43d2-9db9-6de7eddd822a` stays orphaned

The specific approval that hung for 3.5 minutes stays orphaned, NOT re-approved/retried.
`newPrivacyGroup` (the first step of `issueSeries`) has no idempotency key support at all
-- see `client.ts`'s own comment at the top of `issueSeries` ("Group creation does not
support idempotencyKey through this SDK wrapper (PenteFactory.newPrivacyGroup never
forwards transactionOptions)"). A retry would create a brand-new group rather than
resuming the original one, while the already-deployed public/private tracker and token
substeps (which DO use idempotencyKey) would resolve via their OWN keys back to the
ORIGINAL group's addresses -- a mismatched state (new group, old tracker/token pointing
at the old group), not a clean resume. Needs its own fix (idempotency support for group
creation, or a recovery path that re-derives/reuses the original group) before this
approval can be safely retried.

## 10. `issueSeries` doesn't validate registry-field encodings before the first deploy (D26)

Turned out to be the REAL cause of both orphaned approvals above (not a hang, confirmed by
backend): `toFixedBytes(isin, 12)` (`client.ts:91`, called at `:2161` for `registerSeries`'s
`isin` field) throws `PD_CLIENT_ENCODING_FAILED` when the ISIN is longer than 12 bytes --
both `cc982051` (`isin: "IDE2E1791307391894"`, 18 chars) and `5bf41ebf`
(`"IDE2E1791307779634"`, 18 chars) hit exactly this, AFTER the group + both trackers + the
Noto token had already deployed successfully. The encoding/validation (`toFixedBytes` x3 for
`instrumentType`/`seriesCode`/`isin`, `toUnixSeconds` x2 for `issueDate`/`maturityDate`,
`toBytes32Hash` for `termsHash`) all happen late, right before the `registerSeries` call
(`client.ts:2155-2171`) -- by which point 3 real deploys are already orphaned if any of them
throws. Fix: run all 6 encodings up front, before `newPrivacyGroup` is ever called, so bad
input fails fast with zero on-chain side effects. Backend will also add submit-time
validation on their side independently -- this fix is about not leaving orphans on OUR side
even if a bad payload somehow gets past that.

**Second orphaned approval, same root cause**: `5bf41ebf-...` (17:29:40 UTC) also stays
orphaned, same reasoning as `cc982051` above (its own public/private tracker/token deploys
succeeded, `registerSeries` never got far enough to submit).

## `handleDelegateUnlock` access-control gap (tracked separately, not a BACKLOG item)

Already corrected and tracked as D21 (not here): any privacy-group member can call
`handleDelegateUnlock` directly with arbitrary recipients, moving `BondTracker`'s own private
ledger balance (not the real Noto token, which stays hash-bound at the base layer). Accepted
risk for now -- group membership is BI-only (bondIssuer+bondCustodian), no investor can reach
it. Post-E2E: gate on `msg.sender == the deployer` + cross-check recipients against
`lock.recipients`.

---

Revisit #1/#3/#4 together whenever `forceCompleteDistribution`/force-complete reopening
actually gets exposed to users (today it's `backend/shared/src/paladin/gaps.ts`'s own
acknowledged gap, not wired to any endpoint). #5 and #6 are independent of that and can be
picked up separately.

# Follow-up after paladin-client 0.7.0 (2026-10-17): public tracker is status-only

For NEW series `BondTrackerPublic` no longer carries units, price, supply or burns, and
`DistributionState.availableUnits` is optional. `availableUnits`/`purchasePrice`/`minimumDenomination`
are filled only for a client holding the series context (BI, after `issueSeries`/`resumeSeries`);
an investor client gets status + trancheCount only. Legacy series behave as before. Backend and
frontend are NOT changed by this task. Consumers to adapt (paths under /home/ecs-user/alibaba-kube):

- `backend/shared/src/bondSeries/distribution.ts:12-17` copies `state.availableUnits` into the
  distribution view; handle undefined, make sure BI resumes the series before calling.
- `backend/bi/src/bondSeries/handler.ts:289-302` burns `BigInt(state.availableUnits)` on reopen:
  must not run with undefined (fail closed if the series context is missing).
- `backend/bi/src/allocations/validate.ts:41,86` types and compares `availableUnits` as a required string.
- `backend/bi/src/bondSeries/routes.ts:144` `trancheBlockedReason(getDistributionState(...))`.
- `backend/shared/src/paladin/fake.ts:946-1095` and `backend/shared/test/primaryHarness.ts:35,157`
  model public `availableUnits` and the public TokenDistribution price; update the fake.
- Investor side: `frontend-v2/packages/shared/src/types.ts:102-104` and
  `frontend-v2/apps/investor/src/screens/marketplace/canSubscribe.ts:29-42` take price/units from the
  chain-derived distribution state. An investor can no longer read the price on-chain (that is the
  point); BI's REST API must expose price/minimumDenomination/availableUnits to authenticated
  investors instead.

Not covered by the audit fixes (decision needed):
- `bond/src/index.ts` issuance still distributes through upstream `BondSubscription` and the upstream
  `AtomFactory`/`Atom` (cancel open to anyone), and `swap-noto/` uses upstream `Atom` too. Only
  `bond/src/lib/outright.ts` moved to `RestrictedAtom`. Replacing the BondSubscription path means
  forking that contract.
- Deployed series keep the old public+private pair (upstream-shaped, amounts public); only newly
  issued series are status-only.
