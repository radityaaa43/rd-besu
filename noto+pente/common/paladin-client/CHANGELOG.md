# Changelog

All notable changes to `paladin-client`. Each release is published as a tarball under
`releases/` (`npm pack --pack-destination releases/`); a released tarball is never overwritten.
WIP changes `src/`/`build/` freely between releases -- consumers only ever see a tarball.

## 0.7.0 (2026-10-17, status-only public tracker: no sale/supply/burn amounts on the public chain)

**Why**: platform objective -- only BI, the sender and the receiver see amounts. Upstream
examples/bond publishes every primary sale (`onDistribute(amount)` into a `TokenDistribution`),
`totalSupply` and burns on the public tracker (BondTrackerPublic.sol, TokenDistribution.sol @
Paladin v1.0.0). Lead-approved deviation, 2026-10-17.

**Contracts now carried by the bundled bytecode** (new series only; D33):
- `BondTrackerPublic`: status transitions only. `onDistribute`, `onBurn`, `onStaleLockSettled`,
  `totalSupply`, `availableUnits`, `distribution` and `TokenDistribution` are gone;
  `onIssue(custodian)`, `beginDistribution()`, `onDistributionComplete()` (new), `schema()` (new,
  returns `"status-only-v1"`). `TrancheIssued(trancheNo)` has no amount.
- `BondTracker`: sole owner of the unsold counter; tells the public side only when a round sells
  out (`onDistributionComplete()`, once). New views `discountPrice()`, `minimumDenomination()`,
  `lockedBalanceOf()`; `StaleLockSettled` is now a private event. Also carries the DvP-cancel fix
  (`handleDelegateUnlock` accepts the Noto lock-cancel outcome).

**Client**:
- `getDistributionState` / `getPrice` route by the public tracker's `schema()` (cached per
  address; `detectPublicTrackerSchema`). Legacy series (no `schema()`, answer `distribution()`)
  keep the old public path via `src/abis/BondTrackerPublicLegacy.json`.
- Status-only series: public fields (status, trancheCount) for everyone; `availableUnits`,
  `purchasePrice`, `minimumDenomination`, `paymentToken` only for a client holding the series
  context (BI), read from the private tracker through the privacy group. An investor can no longer
  read the price on-chain; BI must supply it.
- **Type change**: `DistributionState.availableUnits` is now optional (always set for legacy
  series). New error codes `PD_CLIENT_UNKNOWN_TRACKER_SCHEMA`, `PD_CLIENT_INVALID_DENOMINATION`.
- `package.json` depends on the published `@lfdecentralizedtrust/paladin-sdk` 1.0.0 instead of a
  local `file:` path.

**ABIs**: `BondTracker.json` and `BondTrackerPublic.json` re-copied from `contracts/out/`
(forge 1.7.1, shanghai); the other 7 are unchanged in ABI and code (only the compiler metadata
hash differs because the vendored import paths changed), so they were not re-copied.

**Tests**: forge 136 passed / 0 failed (6 suites); vitest 113 (+7: one case per tracker schema,
schema detection errors, price rule).

## 0.6.13 (2026-10-08, artifact re-bundle: D37 settle-outside-round reporting + export doc)

**Context**: review finding F2 (paladin, 2026-10-08), confirmed by the lead against
`BondTracker.sol:330-361`: the settle-time accounting block (stale branch included) was gated
entirely on `_status == DISTRIBUTION_STARTED`, so a custodian-originated settle landing after
`forceCompleteDistribution`/`closeDistribution` (status CLOSED, or ACTIVE) reported NOTHING --
neither `onDistribute` nor `onStaleLockSettled` -- although the units really moved. Lead
approved the widening below (D37) and the one-line export-contract comment (F1).

**Contract change now carried by the bundled bytecode** (forge-tested, lead-approved, this
release's only ABI-visible change is bytecode, not ABI):
- `BondTracker.onUnlock` and `handleDelegateUnlock`: settle accounting restructured to
  `if (lockFrom == _custodian) { total = non-custodian recipients; if (STARTED && stamp == _roundSeq) { decrement + onDistribute } else if (total > 0) { onStaleLockSettled(lockId, stamp, total) } }`.
  Round stamp carried verbatim; event-only, never a revert (delegate-path desync rule intact);
  `total == 0` (pure custodian refund) reports nothing. Both hooks kept logically identical.
- Applies to newly deployed series only (D33).

**Tests**: forge 124 passed / 0 failed (5 suites; +2: settle-after-close with current round
stamp, settle-at-ACTIVE-after-reopen carrying the old round; existing D27/D36 tests unchanged).

**Client**: `src/index.ts` export comment now documents that `findReceiptByIdempotencyKey`
throws `PD_CLIENT_RECEIPT_TIMEOUT` when a tx exists but its receipt is pending (returns
undefined only when no tx exists) -- F1, comment-only, no behaviour change.

**D32**: all 8 ABIs re-copied from `contracts/out/` and verified md5-identical; 7 unchanged vs
0.6.12, `BondTracker.json` changed by the D37 bytecode (md5 `4651f8d6d0bf1e29e0cebe13947b8468`).

## 0.6.12 (2026-10-08, additive export: `findReceiptByIdempotencyKey` at the package root)

**Context**: BACKLOG #9 recovery. The backend's `PaladinPort` needs to look up a transaction's
receipt by idempotency key (recovery of an orphaned approval), but `build/index.d.ts` only
re-exported types/errors/connect helpers -- the function existed and was used internally
(`client.ts`), just not reachable as public API. Lead approved the additive export; the
deep-path import alternative was rejected to avoid pinning consumers to the internal layout.

**Change**: `src/index.ts` now re-exports `findReceiptByIdempotencyKey` from `./client`.
One line, no behaviour change; no contract/ABI change, so all 8 bundled ABIs were re-copied
from `contracts/out/` and verified md5-identical to 0.6.11 (D32 discipline).

**Tests**: `tsc --noEmit` clean; vitest 106/106.

## 0.6.11 (2026-10-08, artifact re-bundle: BACKLOG #6 round-stamped locks)

**Context**: BACKLOG #6 (D36, option (b) approved) landed in the contracts AFTER 0.6.10's
re-copy -- D32 re-triggered again. Re-copied all 8 ABIs from `contracts/out/<Contract>.sol/`
and verified md5 equality per file; INoto.json untouched. No `src/*.ts` logic changes.

**Contract changes now carried by the bundled bytecode** (forge-tested, lead-approved):
- `BondTracker`: new `_roundSeq` (incremented in `beginDistribution`) + `_lockRound[lockId]`
  stamped in `onPrepareUnlock` and `onCreateTransferLock` prepare hooks. Both settle paths
  (`onUnlock`, `handleDelegateUnlock`) gained an IDENTICAL stale branch: a lock prepared
  under a previous round settles as a round-tagged non-sale -- NO revert (delegate path
  revert after the real transfer = private/public desync, BondTracker.sol:436-443), no
  decrement of the new round's `_availableUnitsPrivate`, no `onDistribute`; instead emits
  `onStaleLockSettled(bytes32,uint256,uint256)` (lockId, stampedRound, total) to the public
  tracker. Unknown/released lockIds revert exactly as before (D28 regression test).
- `BondTrackerPublic`: new receiver `onStaleLockSettled` (`onlyOwner`, emits
  `StaleLockSettled` event, no status/counter change). Receiver must exist wherever the
  stale branch can fire -- PenteExternalCall to a missing function reverts the whole
  transition (PentePrivacyGroup.sol:291-298, lead-verified); the branch only fires where a
  stamp was written, i.e. new-series trackers (D33: existing series un-stamped).
- Ratified consequence: a custodian lock settled with NO prepare is accounted as a round-0
  stale non-sale in any round (design literal, 5 existing direct-path tests gained an
  additive prepare step).
- Round 0 = never-prepared, deliberately non-sale (backend reads round 0 in
  onStaleLockSettled as "never prepared, not a sale").

**Tests**: forge 121 passed / 0 failed (5 suites; +5 from 116). Client vitest 106/106;
`tsc --noEmit` clean.

## 0.6.10 (2026-10-08, artifact re-bundle again: onIssue gate + transfer-lock sale check)

**Context**: #5's gate landed in `BondTracker.sol` AFTER the 0.6.9 re-copy, then #1's gate
landed in `BondTrackerPublic.sol` -- so the bundled deploy bytecode was stale again (D32
re-triggered by the lead). Re-copied all 8 ABIs byte-for-byte from the current forge
artifacts and verified md5 equality per file (Agreement, BondSeriesRegistry, BondTracker,
BondTrackerPublic, InvestorList, RestrictedAtomFactory, RestrictedAtom, TokenDistribution);
INoto.json untouched as before. No `src/*.ts` logic changes in this release.

**Contract changes now carried by the bundled bytecode** (forge-tested, lead-approved):
- BACKLOG #1 / D35: `BondTrackerPublic.onIssue` now has its own `_status` gate --
  `INITIALIZED || DISTRIBUTION_COMPLETE || ACTIVE` allowed; ISSUED, DISTRIBUTION_STARTED,
  DISTRIBUTION_CLOSED rejected ("Bond must be either unissued, fully sold out, or fully
  active to issue more supply"). Inline comment names all 6 statuses with reasons.
- BACKLOG #5: `BondTracker.onCreateTransferLock` now mirrors `onPrepareUnlock`'s
  quantity/denomination sale check (`_checkSaleAllowed`, quantity excludes custodian
  refunds, gated `DISTRIBUTION_STARTED && from == _custodian`) before `_locks.onLock`.

**Tests**: forge full suite 116 passed / 0 failed (5 suites; was 108 pre-#3/#4+D21, 111
after #5, 116 after #1); client vitest 106/106; `tsc --noEmit` clean.

## 0.6.9 (2026-10-08, artifact re-bundle: BondTracker burn-on-reopen + D21 gate)

**Context**: 0.6.8 (16:11) bundled `abis/BondTracker.json` copied 2026-10-07 00:52 -- BEFORE
the 16:18 contract changes in `Paladin/contracts/src/BondTracker.sol`. Bytecode differed
(client copy 62,258 vs rebuilt 66,402 bytes for the `bytecode.object`). `client.ts:2198`
deploys with `bondTrackerArtifact.bytecode.object`, so every new series deployed through
0.6.8 still got the OLD tracker: no burn-on-reopen (#3 private status advance, #4 onBurn
gate) and no D21 gate (option (b) `_issuer || _custodian` + recipient cross-check). ABI
arrays were already identical (38 entries both sides) -- only the deploy bytecode was stale.

**Fix**: re-copied all 8 bundled ABIs byte-for-byte from the current forge artifacts
(`contracts/out/<Contract>.sol/<Contract>.json` -> `src/abis/`): Agreement,
BondSeriesRegistry, BondTracker, BondTrackerPublic, InvestorList, RestrictedAtomFactory,
RestrictedAtom, TokenDistribution. Verified `cmp` clean on each. `INoto.json` untouched (no
forge artifact; comes from upstream source). No `src/*.ts` logic changes in this release.

**Contract changes now carried by the bundled bytecode** (implemented + forge-tested in
`Paladin/contracts`, lead-approved; redeploy of existing trackers still needs explicit user
GO): forceCompleteDistribution advances private `_status` to DISTRIBUTION_CLOSED (#3); onBurn
gate `amount <= _availableUnitsPrivate` in BOTH DISTRIBUTION_STARTED and DISTRIBUTION_CLOSED
(#4, burn-on-reopen flow); handleDelegateUnlock gated `_issuer || _custodian` with
order-independent per-recipient cross-check against `NotoLocks.getLock` (D21 option (b)).

**Tests**: forge full suite 108 passed / 0 failed (5 suites, `forge test` in
`Paladin/contracts`); client vitest 106/106; `tsc --noEmit` clean.

## 0.6.8 (2026-10-07, BACKLOG #10: pre-flight registry encoding in issueSeries)

**Context**: `issueSeries` deployed the privacy group, public tracker, private tracker and
Noto token BEFORE assembling the `registerSeries` payload, where the 6 registry-field
encodings (`toFixedBytes` x3, `toUnixSeconds` x2, `toBytes32Hash`) lived. A bad ISIN (>12
bytes), unparseable date or malformed termsHash threw `PD_CLIENT_ENCODING_FAILED` only at
that late point -- after all four deploys had confirmed -- orphaning them (two real
orphaned-approval incidents: tx cc982051, 5bf41ebf).

**Fix**: new exported `encodeSeriesFields(p)` in `src/client.ts` performs all 6 encodings in
one place. `issueSeries` calls it as the first statement (before `newPrivacyGroup`), so bad
input fails fast with zero on-chain side effects; the deploy payloads reuse the pre-encoded
values instead of re-encoding, so there is no drift between the two encode sites.

**Tests**: new `encodeSeriesFields` describe block in `test/client.test.ts` (valid round-trip
+ it.each over >12-byte ISIN / bad issueDate / bad maturityDate / bad termsHash, all asserting
`PD_CLIENT_ENCODING_FAILED`). 106/106 pass (was 101), tsc clean.

## 0.6.7 (2026-10-07, D31: presence check without revert-as-signal)

**Context**: guard-check logs this session repeatedly showed a `transaction reverted` +
`PD011206` ERROR pair from `backend/shared/src/events/atomParties.ts:17` --
`paladin.getAgreement(groupId, agreementAddress, "onboard-presence-probe")`, a deliberately
bogus tradeId relying on `Agreement.getAgreement`'s own "TradeNotFound"-style revert to signal
"group/contract present" on an exception. Correct behavior, but a real ERROR line on every
single happy-path call -- costs guard-check signal (every occurrence needs to be manually
told apart from a genuine revert).

**Fix**: new `agreementExists(groupId, agreementAddress): Promise<boolean>` -- calls
`Agreement.sol:75`'s public immutable view `bi()` instead. `"no contract deployed"` (the
group/address genuinely has no Agreement) resolves `false`; a successful call resolves `true`;
anything else throws, same as every other method here. No revert-as-signal, no ERROR log on
the happy path.

**Tests**: no new standalone pure function (this is a `PaladinClientImpl` method, needs a live
SDK, untested per this package's convention -- same as `getAgreement`/`recordLeg`). 101/101
existing vitest still pass, tsc clean.

## 0.6.6 (2026-10-07, real incident: unrecorded leg's "0x" unlockCall read as truthy)

**Incident (task #27/#27b)**: a redemption trade's cash leg was never locked or recorded
(`recordLeg` never ran for it -- confirmed zero such transactions on node1, ever, for this
leg). Backend's redemption handler checked `if (!cashLeg.unlockCall)` against `getAgreement`'s
result to decide whether the leg was already prepared -- an un-prepared leg's `unlockCall`
comes back as the literal string `"0x"` (Solidity's empty-bytes encoding), which is TRUTHY in
JS, so the check silently treated the un-prepared leg as prepared and `lockId: bytes32(0)` got
written into backend's own `trade_legs` table as if it were real. Root cause confirmed by
backend directly, fixed on their side. Not a paladin-client bug -- traced every path in
`prepareTradeLeg`/`prepareUnlock`/`decodePrepareUnlockReceipt`/`recordLeg` and none of them can
return a zero lockId or empty unlockCall/cancelCall without throwing first.

**Fix (defensive-in-depth, lead-required)**: `recordLeg` was never actually called in this
incident (the "0x" truthy check above skipped prepare+record entirely), so this fix doesn't
correct that path -- it keeps the same chain sentinel values from ever reaching the chain
through `recordLeg`, whatever upstream mistake produces them. `recordLeg` now rejects a
zero/empty `lockId`, `unlockCall`, or `cancelCall` (new `PD_CLIENT_PREPARE_FAILED`) BEFORE
submitting anything. `getAgreement`'s `AgreementLeg` now also
carries `prepared: boolean` (true only when `preparedStateId` is non-zero), so a caller no
longer has to infer recorded-ness from another field's truthiness -- the exact mistake that
caused this incident.

**Tests (2 new, 101/101 vitest pass)**: new exported `isZeroHex(value)` -- true for
`undefined`/`""`/`"0x"`/an all-zero bytes32, false for any real hex value (case-insensitive).
Used by both `recordLeg`'s guard and `getAgreement`'s `prepared` computation. `recordLeg` and
`getAgreement` themselves are `PaladinClientImpl` methods -- never unit-tested per this
package's convention (need a live SDK); the pure `isZeroHex` function is what's covered.

## 0.6.5 (2026-10-07, real incident: prepareTradeLeg orphaned 3 bond-leg locks, unregistered investor)

**Incident (task #25)**: 3 bond-leg `prepareTradeLeg` calls on BI's client succeeded at
`lockToken` then reverted at `prepareUnlock` with "Investor is not registered" -- the
recipient investor was never added to the series' InvestorList. This left 3 orphaned locks
with no record anywhere the backend could find without a direct DB query.

**Root cause**: `prepareTradeLeg` called `lockToken` first and only discovered the recipient
wasn't whitelisted when `prepareUnlock` reverted on-chain -- by which point the lock already
existed. `BondTracker`'s own `_checkTransfer` enforces the same InvestorList rule on-chain
(with D20's `to == _custodian` exemption), but nothing in the client checked it before
creating the lock, and nothing recovered the lock after the revert.

**Fix**:
- New private `checkInvestorWhitelistForLock` (`src/client.ts`) runs the same InvestorList
  `isRegistered` check `BondTracker` enforces on-chain, called at the start of
  `prepareTradeLeg` right after `requireLegRecipientMatch`, before `lockToken` is ever called.
  Skips tokens with no cached `SeriesContext` (cash legs, or a bond this client process hasn't
  loaded) -- same behavior as today, no regression. Throws new
  `PD_CLIENT_INVESTOR_NOT_REGISTERED` (`src/errors.ts`) with no lock created.
- If `prepareUnlock` still fails for any other reason after `lockToken` already succeeded,
  `prepareTradeLeg` now attempts a compensating `releaseLock` back to the lock's own owner
  before re-throwing, so a failure never again leaves a lock nobody can find. The error thrown
  is a new `lockRecoveryError` (`src/errors.ts`) carrying `lockId`/`lockReleased`/`tokenAddress`
  so the caller can recover without a DB query; `lockReleased` is `false` when the compensating
  release itself failed, so the caller knows manual recovery is still needed. `PaladinClientError`
  gained these three new optional fields (appended after `txId`, no existing call site breaks).
- `prepareTradeLegAs` forwards to `prepareTradeLeg` unchanged and picks up both fixes for free.

**Tests (3 new, 99/99 vitest pass)**: `lockRecoveryError` builds a `PaladinClientError` with
`code`/`message`/`cause`/`lockId`/`lockReleased`/`tokenAddress` set and `retryable`/`txId`
left `undefined`; `PD_CLIENT_INVESTOR_NOT_REGISTERED` is exported as that exact string; and
`toPaladinClientError` passes a `lockRecoveryError`-produced error through unchanged,
preserving `lockId`/`lockReleased`/`tokenAddress` -- the thing that makes the recovery info
actually reach the caller through `prepareTradeLeg`'s outer `catch (err) { throw
toPaladinClientError(err); }`. `prepareTradeLeg` itself is not unit-tested (needs a live SDK,
same as every other `PaladinClientImpl` method in this file).

## 0.6.4 (2026-10-07, real incident: receipt wait hung 3.5 minutes with no error, no deadline)

**Incident**: a backend real-mode `issueSeries` call hung for 3.5 minutes with no error
logged, until an external process restart killed it.

**Root cause** (confirmed by reading the upstream SDK directly): the SDK's own
`pollForReceipt` (`sdk/typescript/src/paladin.ts:128-137`) loops on a plain counter
(`for (let i = 0; i < waitMs; i += POLL_INTERVAL_MS)`), NOT `Date.now()` -- if a single
underlying HTTP call inside that loop hangs, the function never gets back to checking
`i < waitMs` and blocks forever, regardless of `waitMs`. Made worse by
`paladin.ts:56-59`'s axios instance having NO `timeout` configured, and this package's
own SDK construction never passing one either -- so nothing bounded how long a single
stalled HTTP request could hang. Neither is fixed here (upstream SDK is out of scope for
this package -- see `BACKLOG.md` items #7 and #8 for reporting upstream).

**Fix (defensive outer bound, this package only)**:
- `connect`'s `requestConfig` now always sets `timeout: 30000` on the SDK's axios
  instance, auth or not (previously `requestConfig` was `undefined` with no
  `rpcAuth` configured, so nothing bounded a single request either way).
- New exported `withReceiptDeadline` (`src/errors.ts`) races any receipt-wait promise
  against a REAL `setTimeout`-based deadline via `Promise.race`, rejecting with the
  existing `receiptTimeoutError` (retryable, carries `txId`) if the deadline wins. Wired
  into the only 2 places in this package that call the SDK's `pollForReceipt` directly:
  `resolveIdempotentFuture` and `findReceiptByIdempotencyKey`. Every other receipt-wait
  in this package goes through one of these two, so this covers all of them. Our own
  code can no longer hang past `waitMs` even if the SDK call underneath never resolves.

**Tests (3 new, 96/96 vitest pass)**: `withReceiptDeadline` resolves normally when the
wrapped promise settles first; rejects with `PD_CLIENT_RECEIPT_TIMEOUT`
(retryable, correct `txId`) within a bounded time if the wrapped promise never resolves.
A regression test on `resolveIdempotentFuture` mocks `sdk.pollForReceipt` to never
resolve (the exact shape of the production hang) and confirms it rejects with the
timeout error within `waitMs`, instead of hanging. The existing PD012220-collision test
(0.5.3) already proves a retry with the SAME idempotencyKey recovers the ORIGINAL
transaction regardless of why the first attempt ended (timeout or otherwise) --
`resolveIdempotentFuture`'s recovery path only looks at the collision on retry, not at
how the prior attempt finished, so no new test was needed for that specific claim.

**Not re-approved**: the specific incident (`issueSeries` approval
`cc982051-19cc-43d2-9db9-6de7eddd822a`) stays orphaned. `newPrivacyGroup` (the first step
of `issueSeries`) has no idempotency key support at all, so a retry would create a
mismatched state rather than a clean resume -- see `BACKLOG.md` item #9.

## 0.6.3 (2026-10-07, contracts: BondTracker fund-safety fix for sales exceeding availableUnits/denomination)

**Incident (task #24, lead-approved fund-safety fix)**: `TokenDistribution.purchase()` (the
PUBLIC side, `solidity/contracts/shared/TokenDistribution.sol`) reverts if
`quantity > availableUnits` or `(quantity * purchasePrice) % minimumDenomination != 0`.
`BondTracker.onPrepareUnlock` (the PRIVATE side) enforced neither rule before a lock was
prepared. For a non-delegated `onUnlock`, a revert in the matching public notification is
harmless (same transaction, fully atomic, nothing real has moved). But `handleDelegateUnlock`
fires in its OWN, LATER transaction, strictly AFTER the real base-ledger token transfer has
already confirmed (see that function's own "KNOWN RESIDUAL RISK" comment) -- so a revert there
desyncs the public `availableUnits()`/private ledger from the real, already-moved funds,
permanently.

**Root cause**: a private Pente contract cannot read a public contract's state (`eth_call`
isn't available to it), so `BondTracker` had no way to check `TokenDistribution.purchase`'s 2
rules before preparing a lock.

**Fix**: `BondTracker` now keeps its own private-side mirror of the values `onPrepareUnlock`
needs -- 4 new storage fields (`_pendingTrancheAmount`, `_discountPrice`,
`_minimumDenomination`, `_availableUnitsPrivate`), set from the same inputs
`BondTrackerPublic`/`TokenDistribution` use (`onMint`'s `amount` parameter,
`beginDistribution`'s `discountPrice`/`minimumDenomination` parameters). A new
`_checkSaleAllowed(quantity)` helper mirrors `TokenDistribution.purchase`'s 2 revert conditions
exactly, and `onPrepareUnlock` now calls it for any custodian-originated sale BEFORE the lock is
prepared. The mirror is decremented at the same 3 places `onDistribute` is already notified
(`onTransfer`, `onUnlock`, `handleDelegateUnlock`), so it stays in sync with what the public
side will ALSO decrement if it succeeds.

**Residual limitation (flagged, not solved here, documented in the contract)**: this fix
eliminates the revert-after-settlement problem for the common case (one sale prepared, then
settled, with nothing else racing against the same tranche in between). It does NOT fully
eliminate it for two legs BOTH prepared concurrently before either settles -- the second one to
actually settle could still find insufficient units at that point against the
not-yet-decremented mirror. Fully closing that needs a "reserve at prepare, release on cancel"
pattern, not possible today because Noto's `cancelLock` has no hook back into this contract at
all. The lead confirmed this race is already mitigated at the backend's own application layer
(a Postgres advisory lock serializes custodian-leg preparation), so this is defense-in-depth,
not an open contract-level risk in practice.

**Tests (6 new forge tests)**: (1) a sale quantity exceeding `_availableUnitsPrivate` reverts at
`onPrepareUnlock`, before any state change, and the same lock settles cleanly afterward once
corrected; (2) a quantity whose price doesn't divide evenly by `minimumDenomination` reverts the
same way; (3) a valid quantity passes `onPrepareUnlock` and the full path through to `onUnlock`
also settles; (4) the private mirror (exposed via a new test-only `availableUnitsPrivate()`
getter) actually decrements after a real sale settles; (5) a quantity that was fine before a
prior sale consumed units is no longer fine afterward (sequential consumption, not just a
single-sale snapshot); (6) `beginDistribution`'s mirror fields are plain overwrites, not
accumulated, across a reopened tranche -- a second tranche with a different amount/price/
denomination reflects only the new tranche's values, proven by a quantity that is valid under
the new denomination but would have been invalid under the old one (and vice versa).

**Applies only to series issued with a `BondTracker` deployed from this version or later** --
no proxy/upgrade path, so existing series keep their already-deployed bytecode.
`abis/BondTracker.json` rebuilt via `forge build` and copied in. `forge test`: 99 passed, 0
failed, 0 skipped (93 pre-existing + 6 new).

## 0.6.2 (2026-10-07, contracts: onCreateTransferLock whitelist bypass + reopening DoS)

**Bug #1 (lead-confirmed)**: `BondTracker.sol` overrode `onMint`/`onTransfer`/`onUnlock`/
`onPrepareUnlock`/`handleDelegateUnlock`/`onBurn`, but not `onCreateTransferLock` -- so it fell
through to upstream's default (`NotoTrackerERC20.sol:194-205`), which calls the INTERNAL
`_onPrepareUnlock` helper directly, bypassing this contract's own CHECKED `onPrepareUnlock`
override (and its `_checkTransfers` whitelist call) entirely. Gated only by
`onlySelf(sender, from)` -- any investor holder could create a transfer-lock to an
unregistered address with zero whitelist enforcement.

**Fix**: `onCreateTransferLock` now calls `_checkTransfers(sender, from, recipients)` (the same
call `onPrepareUnlock`/`onUnlock` already make -- the task #20 custodian exemption applies
automatically, no special-casing needed), then does exactly what upstream's own default body
does (`_locks.onLock` + `_onPrepareUnlock`), matching this file's established pattern of
calling the internal `_on*`/`_locks.on*` helpers directly rather than `super.x()`.

**Same-session audit of every other V1 lock-creation/preparation hook** (lead's own
instruction), against this contract's actual rules:
- `onCreateMintLock`/`onPrepareMintUnlock` (mint-shaped, like `onMint`): fell through to
  upstream's default completely unchecked -- any recipient could be set on a mint-lock, not
  just the custodian. **Fixed**: added `_checkMintRecipients`, requiring every recipient's
  `to == _custodian`, mirroring `onMint`'s own `require(to == _custodian, ...)`.
- `onCreateBurnLock`/`onPrepareBurnUnlock` (burn-shaped): upstream's default has no recipients
  parameter at all and is gated by `onlySelf(sender, from)` -- same security model as `onBurn`
  ("sender can only burn its OWN already-received balance"), so there is nothing to
  whitelist-check. **No fix needed.**
- `onDelegateLock`: takes no recipients -- it only authorizes a delegate to execute a lock
  whose recipients were already pinned into `_locks[lockId].recipients` by an earlier
  `onPrepareUnlock`/`onCreateTransferLock`/`onCreateMintLock` call (all three of which now run
  through a whitelist-or-custodian check after this release). Same shape of protection as
  `handleDelegateUnlock`'s own already-assessed false positive -- the recipient is
  cryptographically pinned before delegation, not reachable through this hook. **No fix
  needed.**
- `DISTRIBUTION_STARTED` sale-accounting (`BondTracker.sol`'s `onTransfer`/`onUnlock`/
  `handleDelegateUnlock`): none of the above apply. Mint-lock hooks exempt for the same reason
  `onMint` itself carries no sale accounting (minting isn't a sale); burn-lock hooks for the
  same reason `onBurn` carries none (redemption only happens after a round is closed);
  `onCreateTransferLock` for the same reason `onPrepareUnlock` carries none (a
  prepared-but-never-executed unlock must not count toward the sale -- `onCreateTransferLock`
  also only prepares, via `_onPrepareUnlock`, never executes). **No fix needed anywhere.**

**Bug #2 (lead-approved)**: `BondTrackerPublic.sol`'s `beginDistribution` gated reopening on
`address(distribution) == address(0) || distribution.availableUnits() == 0`.
`forceCompleteDistribution` only ever flipped `_status`, never touched `distribution` -- so
after a force-completion with units still outstanding, `availableUnits()` stayed permanently
non-zero and every future `beginDistribution()` reverted forever.

**Fix (lead decision, corrected mid-implementation from an earlier `distribution =
address(0)` proposal)**: gate on `_status != Status.DISTRIBUTION_STARTED` instead of
`availableUnits() == 0`. No regression for the fully-sold case: `onDistribute` already flips
`_status` to `DISTRIBUTION_COMPLETE` the instant `availableUnits()` hits zero, so a round
that's fully sold but not yet formally closed via `closeDistribution`/`setActive` still
reopens immediately, same as before.

**Flagged to the lead, not fixed in this release**: switching the gate from `availableUnits()`
to `_status` opens a narrower, different gap than the one it closes. `onIssue` unconditionally
overwrites `_status` to `ISSUED` with no gate of its own (by design -- the real block is meant
to be `BondTracker`'s own `onMint` gate on the PRIVATE side, a separate `_status` variable).
Found by running the existing regression test for this exact scenario
(`testBeginDistributionRejectsReopeningWhilePreviousRoundStillOpen`): calling `onIssue` for a
hypothetical second tranche while round 1 is only half sold now silently defeats
`beginDistribution`'s own gate, even though `availableUnits()` is still non-zero -- a call
sequence the old `availableUnits()`-based gate was immune to, since it never looked at
`_status` at all. Not reachable through the real multi-contract call chain (confirmed: private
and public `_status` normally move in lockstep via the `PenteExternalCall` chain, and
`BondTracker.onMint` blocks re-minting while its own `_status` is `DISTRIBUTION_STARTED`), but
this contract no longer backstops that itself in isolation the way it used to. Test adjusted to
drop the now-incompatible intervening `onIssue` call and keep testing its one literal,
required invariant; the gap itself is documented in the test file for the lead's call on
whether it needs a separate fix.

Forge (93/93 pass, up from 85/85 before this release): 3 positive/negative pairs for
`onCreateTransferLock` (registered investor succeeds, custodian succeeds without
registration, unregistered non-custodian reverts), 2 positive/negative pairs for
`onCreateMintLock`/`onPrepareMintUnlock` (custodian succeeds, non-custodian reverts), 1 new
test proving a second `beginDistribution()` succeeds right after a force-completion with a
remainder (the exact scenario Bug #2 broke).

**Applies only to series issued with a `BondTracker`/`BondTrackerPublic` deployed from this
version or later** -- no proxy/upgrade path for either contract, so existing series keep their
already-deployed bytecode. `abis/BondTracker.json` and `abis/BondTrackerPublic.json` rebuilt via
`forge build` and copied in.

## 0.6.1 (2026-10-06, backend-reported gap on redemption's cash leg)

**Incident**: the backend team reported being blocked on redemption -- the cash leg is owned
by `bondIssuer@node1`, but BI's own client is usually connected as `bondCustodian`.
`prepareTradeLeg(..., asIdentity: "bondIssuer")` (0.6.0) already worked for that leg, but the
SAME leg also needs `recordLeg`, `delegateTradeLeg`, and (on a rollback path) `releaseLock` --
none of which took `asIdentity` yet, so each would have signed as the client's own default
identity instead of the leg's actual owner and failed on-chain.

**Fix**: `recordLeg`, `delegateTradeLeg`, and `releaseLock` all gain the same optional trailing
`asIdentity?: "bondIssuer" | "bondCustodian" | "cashIssuer"` param as `lockToken`/
`prepareUnlock`/`prepareTradeLeg`, resolving `signer = asIdentity ? requireIdentityVerifier(asIdentity)
: this.verifier` and using `signer` everywhere `this.verifier` was previously used as a
transaction signer or in an ownership check. `delegateTradeLeg` threads its `asIdentity`
through to its internal `delegateLock` call -- `delegateLock` itself also gained the param,
since its own on-chain owner check requires the signer to be the lock's actual owner.
`releaseLock` threads its `signer` through to its internal prepareUnlock-to-self and
delegateLock-to-atom calls (both have an on-chain owner check too), but deliberately leaves its
`createAtom`/`executeAtom` calls on `this.verifier` -- those pick who is allowed to EXECUTE the
single-leg self-release atom, which is independent of who owns the lock being released (the
atom acts with its own delegated authority once executed), so there is no owner check there
`asIdentity` needs to satisfy. Omitting `asIdentity` preserves prior behavior exactly on every
existing call site for all three methods -- not a breaking change.

**Also in this release (parent session)**: a new exported `receiptFailureError` helper
(`src/errors.ts`) is now used by `transferCash`/`fundIssuer`/`burnBond`, so their thrown
error's `.code` surfaces Paladin's own real failure code (e.g. `PD200005` for insufficient
funds) instead of a generic fallback code.

Vitest (93/93 pass, up from 90/90 in 0.6.0 via the parent session's `receiptFailureError`
tests): no new tests added for the `asIdentity` additions in this entry -- same
`requireIdentityVerifier` reuse already covered by 0.6.0's `lockToken`/`prepareUnlock`/
`prepareTradeLeg` tests, live-verified only per this codebase's established convention for
`PaladinClientImpl`'s identity-signing methods.

## 0.6.0 (2026-10-06, task #19 -- coupon / imbalan payment and redemption maturity)

Adds the paladin-layer capabilities the coupon/redemption design doc needs
(`docs/superpowers/sdd/2026-10-06-coupon-redemption.md`), aligned directly with the backend's
own `CouponPaladinPort` stub (`backend/shared/src/coupons/contract.ts`) during implementation.

**`getHolders(token)`**: every holder of a bond token, as seen from THIS node. BI-only in
practice -- throws `PD_CLIENT_WRONG_ROLE` if the caller's own identity isn't the configured
`bondCustodian` (same hard gate as `deployAgreement`), since any other node only sees its own
states and would otherwise return a silently incomplete result. Sums `NotoCoin` (-> `available`)
and `NotoLockedCoin` (-> `locked`) separately, both queried with status "available" so
spent/superseded states are never double-counted -- confirmed this is the right status choice
against `balances()`'s own precedent, not `verifyDelegatedLeg`'s "all" (which exists there for a
different reason: telling "not yet propagated" apart from "belongs to someone else", not summing
balances). A locked state's `owner` is still the lock OWNER, not the pending recipient, so an
in-flight trade at the snapshot doesn't lose the holder their coupon. `blockHeight` read after
both queries. New `getCoinSchemaId()` helper, mirrors the existing `getLockedSchemaId()`'s
caching shape.

**`resolveAddress(lookup)`**: `name@node` -> address, normalized the same way `getHolders`' `owner`
is.

**Act-as-identity (`asIdentity`)**: `lockToken`/`prepareUnlock`/`prepareTradeLeg` all gain an
optional trailing `asIdentity?: "bondIssuer" | "bondCustodian" | "cashIssuer"` param -- lets a
client sign as a DIFFERENT configured same-node identity than its own connection default (e.g.
BI's client, connected as `bondCustodian`, preparing the coupon/redemption cash leg owned by
`bondIssuer`). Reuses `requireIdentityVerifier`'s existing same-node-only check unchanged
(extended its key union to add `"cashIssuer"`, alongside a new `identities.cashIssuer?: string`
config field). Omitting it preserves prior behavior exactly (signs as the client's own identity)
-- not a breaking change to any existing call site. `prepareTradeLegAs(identity, ...)` is a thin
wrapper matching the backend's exact stub shape, with the identity moved to a required
positional argument instead of a trailing optional one.

**`transferCash(fromIdentity, toLookup, amount, idempotencyKey)` / `fundIssuer(amount,
idempotencyKey)`**: plain Noto transfer/mint on the RD cash token (notaryMode "basic", no hooks,
no whitelist -- confirmed via every live-check spike that deploys it), signed as a configured
identity. Both return `{txId}` (the pending transaction's id, captured before the receipt is
awaited) to match the backend's exact expected shape.

**`cashBalanceOf(identity)`**: RD balance of an arbitrary BI-hosted identity. Takes no token
param by design -- reads `config.contractData.cashToken` internally (new `requireCashToken`
helper), confirmed directly with the backend that this deployment only ever has one RD cash
token.

**`burnBond(token, amount, idempotencyKey)`**: burn by the custodian. Noto has no on-chain `burn`
function -- it's a domain-level verb implemented in Go (`INotoPrivate.sol`'s own doc comment:
"implemented in Go, never expected to be implemented in a smart contract"), called through the
SDK the same shape as `mint`/`transfer`. `onBurn` is `onlySelf`-gated (inherited unmodified from
`NotoTrackerERC20`): the custodian can only ever burn its OWN already-received balance, never an
arbitrary holder's directly -- for redemption, the bond leg (holder -> custodian) MUST settle
before this is called, confirmed as the exact ordering the backend already built against.

**Contracts (forge 85/85 pass, full suite): `BondTrackerPublic.totalSupply` now learns about
burns.** `BondTracker.sol` never overrode `onBurn`, so the public tracker's own separate
`totalSupply` counter (incremented on `onIssue`, via a `PenteExternalCall`) was never notified of
a burn and would drift permanently stale after every redemption. Fixed: `BondTracker.sol` now
overrides `onBurn` (keeping the inherited `onlySelf` gate), additionally emitting a
`PenteExternalCall` to the public tracker; `BondTrackerPublic.sol` gained a matching
`onBurn(uint256) onlyOwner` that decrements `totalSupply` (Solidity ^0.8.20's own underflow
revert is sufficient, no extra guard needed). 3 new forge tests: a burn notifies the public
tracker AND decrements its `totalSupply`; the private tracker's own ERC20 `totalSupply()` also
still decrements correctly (regression guard); a non-holder's burn attempt still reverts (the
`onlySelf` gate still holds). Applies only to series issued with a `BondTracker` deployed from
this version or later, same as every other change to this private contract -- `abis/
BondTracker.json` and `abis/BondTrackerPublic.json` rebuilt and copied in.

Vitest (90/90 pass): `requireCashToken` (set / `PD_CLIENT_MISSING_CONFIG` when missing).
`PaladinClientImpl`'s new methods stay live-verified only, per this codebase's established
convention.

## 0.5.4 (2026-10-06, task #20 -- contracts: custodian may receive bond without InvestorList registration)

**Incident**: BI's own `releaseLock`-to-self for its bond leg reverted "Investor is not
registered" (`PD012616`). Traced from source (`/home/ecs-user/eksplorasi-paladin/paladin` +
our own contracts, no skills): `Noto.prepareUnlock` -> `onPrepareUnlock` -> our
`BondTracker._checkTransfers` -> `InvestorList.checkTransfer` (upstream
`solidity/contracts/private/InvestorList.sol:54-61`) only ever checks `to`, with no exemption
for the custodian -- and the custodian is never itself registered as an investor on its own
series. The SAME path blocks redemption's holder->custodian bond leg (`prepareTradeLeg` ->
`prepareUnlock`), confirmed before this fix shipped.

Mapped every Noto path to its hook, to find every affected flow: `transfer`->`onTransfer`,
`unlock`->`onUnlock`, `prepareUnlock`->`onPrepareUnlock` all call `_checkTransfer(s)`;
`spendLock`/`cancelLock` (what an Atom calls to execute/cancel) call NO hook at all (confirmed
reading `Noto.sol:594-660` directly); `handleDelegateUnlock` (fires after an Atom-delegated
unlock executes) calls no `_checkTransfers` by interface contract (`INotoHooks.sol`'s own doc:
"should never revert"); `onBurn` (inherited unmodified, `onlySelf` only) has no investor check
at all. Only 2 real flows broke, both at `onPrepareUnlock`: releaseLock-to-self, and
redemption's bond leg.

**Fix**: `BondTracker.sol`'s `_checkTransfer`/`_checkTransfers` now exempt `to == _custodian`
from `InvestorList.checkTransfer` -- scoped narrowly to the custodian only, every other
recipient still goes through the real whitelist unchanged. Grepped every use of
`investorList`/`isRegistered`/`listInvestors` in our contracts -- these 2 functions are the
only call sites, so the fix has no other surface.

**Post-fix solidity-auditor delta on `BondTracker.sol` found a second, related bug** (11/12
agents converged): `onTransfer`'s sale-notification (`if (_status == DISTRIBUTION_STARTED &&
from == _custodian) { emit onDistribute(amount) }`) had no `to != _custodian` exclusion, unlike
`onUnlock`'s equivalent check which already excludes `to == _custodian` ("a refund is not a
sale", task #6b). Before this release, a custodian self-transfer during an active distribution
round could never reach this code at all -- the (unintentional) whitelist bug blocked it,
because `to` (the custodian) wasn't registered. This release's own exemption would have made
that self-transfer newly reachable, letting the custodian report a fake sale
(`onDistribute(amount)` with zero real sale, zero payment) to the public tracker. Fixed in the
same release: `onTransfer` now also excludes `to == _custodian`, mirroring `onUnlock`.

Forge (13/13 in `BondTracker.t.sol`, full suite green): 3 positive (transfer/unlock/
prepareUnlock to the custodian succeed without registration), 3 regression (the same 3 paths to
a genuinely unregistered non-custodian address still revert "Investor is not registered"), 1 new
regression for the self-transfer fix (no `PenteExternalCall` to the public tracker on a
custodian self-transfer during an active distribution).

**Applies only to series issued with a `BondTracker` deployed from this version or later** --
no proxy/upgrade path for this private contract, so existing series keep their already-deployed
bytecode. `abis/BondTracker.json` rebuilt via `forge build` and copied in.

**Separately flagged, NOT fixed in this release** (pre-existing, not caused by this fix, under
investigation): `handleDelegateUnlock` (the real Atom-delegated settlement path) has no
`_checkTransfers` call and no caller-authentication modifier at all. Verifying reachability
before proposing a fix.

## 0.5.3 (2026-10-06, task #17 -- a retry with the same idempotencyKey must recover, not error)

**Incident**: with 0.5.2 live, the investor's cash leg prepared fine via `prepareTradeLeg`. The
new blocker was on BI's side: its "subscription-leg-recorded" handler prepares its own bond leg,
then calls `getAgreement` to confirm -- but indexer lag meant it wasn't `LEGS_PREPARED` yet, so the
handler threw, the message got redelivered, and the retry called `prepareTradeLeg` again with the
SAME idempotencyKey. That hit `prepareUnlock`'s `PD_CLIENT_LOCK_ALREADY_PREPARED` guard and
dead-lettered.

**Root cause** (lead's own diagnosis, confirmed by reading the code): `resolveIdempotentFuture`
only recovers a PD012220 thrown AT SEND TIME. `prepareUnlock` has a client-side PRE-submit guard
(`isLockPrepared`) that runs BEFORE any send is attempted -- a retry with the same key never
reaches the send at all, because the guard sees the first attempt's own effect already landed and
rejects immediately. The client's idempotency was not actually end-to-end for any method with a
pre-submit guard.

**Checked every other submit path** the lead asked about (`lockToken`, `recordLeg`, `recordAtom`,
`acceptAgreement`, `confirmSettled`, `markFailed`): none of them have a pre-submit guard of this
shape -- they all go straight to `submitIdempotent`/`resolveIdempotentFuture`, which already
recovers a same-key retry correctly via the existing PD012220 path. Only `prepareUnlock` (and by
extension `prepareTradeLeg`, which just calls it) had the bug. No code change was needed for the
others.

**Fix** (no signature change): `prepareUnlock` now looks up a PRIOR transaction for the given
`idempotencyKey` (`findReceiptByIdempotencyKey`, new exported function) BEFORE the
`isLockPrepared` guard runs. A hit returns the exact original result (`decodePrepareUnlockReceipt`,
also extracted and shared between the recovery path and the fresh-submit path, so they can never
decode a receipt differently) -- no guard, no new transaction. The guard now only ever fires for a
genuine re-prepare: no `idempotencyKey` at all, or a call with a DIFFERENT key on an
already-prepared lock.

Vitest (88/88 pass): `findReceiptByIdempotencyKey` (no prior tx -> undefined without polling;
prior tx -> its receipt; prior tx with no receipt yet -> `PD_CLIENT_RECEIPT_TIMEOUT`, retryable)
and `decodePrepareUnlockReceipt` (happy path, case-insensitive owner match, failed receipt, no
matching preparedOutputs entry) -- both standalone exported functions, per this codebase's
convention that only `PaladinClientImpl`'s own methods stay live-verified.

**Live check** (`spikes/prepare-trade-leg-live-check/retry-idempotency-live-check.ts`, fresh
ephemeral identities/group/Noto token, only node1 touched, did not touch bank1/bank2's active
run): `prepareTradeLeg` called twice with the SAME idempotencyKey returns the IDENTICAL
lockId/unlockCall/cancelCall/preparedStateId both times, and node1's own DB confirms exactly ONE
transaction exists for each of the `:lock` and `:prepare` sub-keys before and after the retry (no
new tx created). A separate call to `prepareUnlock` on the SAME already-prepared lock with a
GENUINELY DIFFERENT key is still correctly rejected with `PD_CLIENT_LOCK_ALREADY_PREPARED`. The 2
`ERROR`-level log lines seen on node1 during the check are lockToken's own expected PD012220
rejection on the `:lock` sub-key (the pre-existing, already-correct recovery path) -- not a fault.

## 0.5.2 (2026-10-06, task #15 -- the backend must never handle an Agreement leg's raw address)

**Incident**: the 0.5.1 fix unblocked BI's side of the real run, but the investor then hit a new
wall: `getAgreement` correctly returns a leg's `to` as an on-chain ADDRESS (D2 -- `proposeAgreement`
resolves a lookup to an address once, at propose time; the contract only ever stores addresses).
The backend read that address and passed it straight into `prepareUnlock(asset, lockId,
[{to: leg.to}])` -- `requireLookup` rightly rejected it (`PD_CLIENT_INVALID_RECIPIENT`, got
`0xbbab6f95...`). Separately, BI's own message showed a leg's `asset` as `98143f4b...`, missing its
`0x`.

**Root cause, part 1 (address loses its "0x")**: `getAgreement`'s own local `norm` helper added
back a missing `"0x"` but never lowercased -- Paladin's ABI decode of a `pgroup_call` result is
inconsistent about BOTH the prefix and the case (the same quirk already found and fixed for
`executor()` in `_checkAtomMatchesLeg` and for `readDistributionAddress`), so two addresses that
are the SAME on-chain value could still fail a strict string-equality check purely over case.
Consolidated into one shared, exported `normAddr(a) = (a.startsWith("0x") ? a : "0x"+a).toLowerCase()`,
now used everywhere an address comes back from a contract call (`getAgreement`,
`_checkAtomMatchesLeg`) instead of two independent local copies that could drift.

**Root cause, part 2 (the real blocker)**: the backend was never supposed to see a leg's raw
address at all. D2's own contract is "the backend hands over identities, the client resolves
addresses" -- `proposeAgreement` already follows it on write, `getAgreement` necessarily returns
addresses on read (no on-chain reverse lookup exists), but there was no client method to go from
"I have an identity lookup and a leg index" to "the leg is ready to delegate" without the caller
ever touching the address in between.

**Fix**: new `prepareTradeLeg(groupId, agreementAddress, tradeId, legIndex, recipientLookup,
idempotencyKey?)`. Reads the leg from the chain, asserts the CALLER is the leg's recorded owner
(`requireLegOwner` -- throws `PD_CLIENT_WRONG_ROLE` otherwise), resolves `recipientLookup` to an
address and asserts it is EXACTLY the chain's own recorded `leg.to` (`requireLegRecipientMatch` --
throws `PD_CLIENT_LEG_MISMATCH` otherwise, never silently substitutes the resolved address for
what the chain already committed to), then locks `leg.asset` for `leg.amount` and prepares the
unlock to `recipientLookup`, reusing the existing `lockToken`/`prepareUnlock` primitives (and their
own PD012220 recovery) rather than duplicating them. The backend now calls this ONE method with
only identities -- never `lockToken`/`prepareUnlock` directly for an Agreement leg, never an
address.

Idempotency note: `leg.lockId`/`leg.unlockCall` are always empty before `recordLeg` (Agreement.sol's
one-shot guard keys on `unlockCall.length`, set only by `recordLeg` itself), so there is no on-chain
signal yet to resume a partial `prepareTradeLeg` from -- retry-safety comes entirely from threading
`idempotencyKey` into the two sub-calls, which already recover a PD012220 themselves.

Vitest (81/81 pass): `normAddr` (missing prefix, mixed case, already-normalized); `requireLegOwner`
(match, mismatch -> `PD_CLIENT_WRONG_ROLE`); `requireLegRecipientMatch` (match, mismatch ->
`PD_CLIENT_LEG_MISMATCH`) -- each a standalone exported function, per this codebase's convention
that only `PaladinClientImpl`'s own methods stay live-verified (never mocked).

**Live check** (`spikes/prepare-trade-leg-live-check/live-check.ts`, fresh ephemeral
identities/group/Noto token -- does not touch bank1/bank2's active real-mode run, cluster
discipline before/after, only node1 touched): seller proposes a leg, buyer accepts, seller calls
`prepareTradeLeg(..., buyerLookup)` with ONLY the identity lookup, and `recordLeg` accepts the
result -- trade advances to `LEGS_PREPARED`, the on-chain `leg.unlockCall`/`leg.lockId` match what
`prepareTradeLeg` returned. A second trade proves the mismatch guard: `prepareTradeLeg` with a
`recipientLookup` that resolves to a DIFFERENT address than the chain's recorded `leg.to` is
refused with `PD_CLIENT_LEG_MISMATCH` before any lock is taken.

(On-call note, unrelated to this fix: during this task's pre-check, found node4 had been
Kubernetes-preempted and node2's paladin container had exited 137, both ~25 minutes earlier, both
already self-healed and healthy by the time of this check -- reported to the lead separately as
on-call observation, not investigated further here since it didn't block this task.)

## 0.5.1 (2026-10-06, task #14 -- BREAKING: fix GroupMessage.sender, which never existed on the wire)

**Incident**: the backend's real-mode run (bank1+bank2) stuck a trade at PROPOSED. Lead's own
Paladin-source diagnosis: `pldapi.PrivacyGroupMessage` (sdk/go/pkg/pldapi/privacy_group.go:47-62)
has no identity-level sender field, only `Node` -- and on receive, `msg.Node` is OVERWRITTEN by
the transport with the authenticated mTLS peer node
(core/go/internal/transportmgr/reliable_msg_handler.go:526), making `node` authenticated at the
node level. `paladin-client`'s `GroupMessage.sender` ("verifier lookup of the sender") was never
backed by anything Paladin actually sends -- confirmed undefined on the real raw payload (checked
via `pgroup_queryMessages` on node1). Every backend check comparing `message.sender === ...`
silently dropped every message in real mode.

Checked every other place in this SDK that assumes an identity-level sender for group messages
(grep across `src/`): none -- the only other `.sender` hit in `client.ts` is an unrelated comment
about a simulated EVM call's `msg.sender`, not group messages.

**Fix** (BREAKING on the `GroupMessage` type): removed `sender`; added `node: string` (the real,
authenticated sending node) and `sent`/`received` (ISO timestamps, present on the real payload,
previously discarded). `onGroupMessage` no longer casts the raw WS batch straight to
`GroupMessage[]` -- new exported `toGroupMessage(raw: IPrivacyGroupMessage): GroupMessage` maps it
explicitly. That mapping also fixes a second latent mismatch found while reading the SDK's actual
wire type: the raw field is `group`, not `groupId` -- `message.groupId` would have been `undefined`
at runtime too, on every message, even before this incident.

Vitest: `toGroupMessage` against the exact raw shape the backend reported (`id`, `localSequence`,
`sent`, `received`, `node`, `correlationId`, `domain`, `group`, `topic`, `data`) -- asserts the
`group` -> `groupId` rename, `node` preserved, and no `sender` field on the mapped result.

**Live check** (`spikes/group-message-node-live-check/live-check.ts`, fresh ephemeral
group/identities -- does not touch bank1/bank2's active real-mode run or any existing group,
cluster discipline before/after): investorA (node2) sends a real group message on a fresh group,
investorB (node3) receives it through the fixed `onGroupMessage`/`toGroupMessage` path. Confirmed
live: `message.node === "node2"` (the real, Paladin-authenticated sending node), no `sender` field
on the received object at all, and `message.groupId` correctly mapped from the raw `group` field.

## 0.5.0 (2026-10-06, task #13 -- BREAKING: fix Agreement contract-address collisions across privacy groups)

**Incident**: the backend found 6 onboarding agreements (3 primary groups + 3 outright pairs, 6
different groups) that ALL reported `agreementAddress` `0x1d42fff0...`. `ptx_getTransactionByIdempotencyKey`
returned 6 DIFFERENT transaction ids for them (correct, no 0.4.2 regression), but
`ptx_getTransactionReceiptFull`'s `domainReceipt.receipt.contractAddress` was identical across all 6.

**Root cause** (confirmed against the `paladin-architecture` skill and Pente's own deploy semantics,
not assumed): a Pente private contract's address is scoped to its deploying privacy group, not
global -- each group is its own EVM, and the same deployer identity + the same deployment nonce in
two different groups produces the identical address for two completely unrelated contract
instances. This is normal Pente behaviour. The bug was entirely client-side: `paladin-client`'s
`agreements` cache was `Map<address, {group, agreement}>`, keyed by `agreementAddress` ALONE. Two
different groups' Agreement contracts sharing an address silently overwrote each other's cache
entry, so an operation meant for one group's trade could resolve against a different group's
contract instance instead -- a fund-safety bug, not a cosmetic one.

Checked the same pattern against every other Pente private contract this SDK manages
(`seriesContexts` for private BondTracker/investorList, `outrightGroups`): both already key by
group identity, not address alone -- confirmed safe, not touched.

**Fix** (BREAKING -- every Agreement method signature changed): new composite cache key
`agreementCacheKey(groupId, agreementAddress) = \`${groupId}:${agreementAddress.toLowerCase()}\`` --
lowercases the address, does NOT normalize `groupId` (an opaque Paladin-assigned id, case-sensitive).
Every Agreement-related method on `PaladinClient` now takes `groupId` as a required first/second
param (no fallback lookup by address alone -- an ambiguous call throws
`PD_CLIENT_UNKNOWN_AGREEMENT`): `deployAgreement`, `resumeAgreement` (param order swapped, now
`(groupId, agreementAddress)`), `proposeAgreement`, `acceptAgreement`, `recordLeg`, `recordAtom`,
`confirmSettled`, `markFailed`, `cancelAgreement`, `getAgreement`, `delegateTradeLeg` (resolves its
atom/asset via `getAgreement(groupId, ...)`, unaffected otherwise -- atom/asset addresses are
globally unique, not group-scoped).

Vitest: 2 new tests for `agreementCacheKey` against the EXACT real colliding address
(`0x1d42fff0...`) -- different groups produce different keys with independent lookups; address
lowercased, groupId not normalized. `PaladinClientImpl`'s methods stay live-verified only, per this
codebase's established convention.

**Live check** (`spikes/agreement-isolation-live-check/live-check.ts`, full cluster discipline
before/after): resumed the SAME colliding address under both bank2-primary's and bank3-primary's
real groupIds (found directly in node1's DB -- the actual bank2/bank3/bank4 onboarding deploys),
proposed a real trade on bank2-primary's agreement, confirmed `getAgreement` sees it under
bank2-primary's groupId, then confirmed `getAgreement` under bank3-primary's groupId for the SAME
address gets a genuine on-chain revert -- decoded the revert data to `TradeNotFound("isolation-check:...")`
(`Agreement.sol:88,376`), i.e. bank3-primary's distinct contract instance genuinely has no record of
bank2's trade. Not a client-cache miss: both groups were explicitly `resumeAgreement`'d first, so
the only way to get this result is that the two on-chain contract instances are actually isolated.

## 0.4.2 (2026-10-06, task #12 -- fix idempotencyKey retries on a deploy throwing instead of recovering)

**Bug**: the backend got `PD012220: idempotencyKey already used ... onboard-primary:bank2:deploy-agreement`
when BI booted after a DB reset. `deployAgreement` called `group.deploy({...}, { idempotencyKey })
.waitForDeploy(...)` as a raw chain with no PD012220 recovery -- unlike every other submit-style
method in this file, which already routes through `submitIdempotent`. A redelivered idempotencyKey
(the whole point of passing one -- the backend calls Paladin inside a DB transaction, and a commit
failure after Paladin already succeeded means a redelivery repeats the call) must get back the
SAME result, not an error and not a second deploy.

**Fix**: new standalone exported `resolveIdempotentFuture(sdk, txId, idempotencyKey, waitMs, full?)`
-- the same PD012220-recovery logic `submitIdempotent` already had (catch PD012220, look up the
original transaction via `ptx.getTransactionByIdempotencyKey`, poll its receipt, return that
instead of throwing), pulled out so it can also be used directly against a
`TransactionFuture`/`PentePrivateDeployFuture`'s `.id` (not just the `ptx.sendTransaction`-shaped
calls `submitIdempotent` was written for). Confirmed against the real Paladin Go source that this
recovery mechanism needs NO modification for Pente-group operations: `pgroup_sendTransaction`
ultimately calls the exact same shared `txManager.SendTransactions` that `ptx_sendTransaction`
does -- one transactions table, one idempotencyKey uniqueness constraint, same PD012220 on reuse,
and `ptx_getTransactionByIdempotencyKey`'s lookup has no domain/type filter, so it finds
group-originated transactions too. `submitIdempotent` itself is now a thin wrapper around this.

Applied to the exactly 3 call sites that needed it (confirmed by grepping and tracing every
single `.waitForDeploy(` in the file -- everything else, including `propose`/`accept`/
`recordLeg`/`recordAtom`/`confirmSettled`/`markFailed`/`cancelAgreement`/`mintTranche`/
`sendBondTrackerTx`/`lockToken`/`prepareUnlock`/`delegateLock`/`mintToken`/`addInvestor`, was
already correctly routed through `submitIdempotent` and needed no change):
- `deployAgreement`'s Agreement deploy (Pente group deploy -- address recovered from
  `receipt.domainReceipt.receipt.contractAddress`, `full=true`).
- `issueSeries`'s private BondTracker deploy (same Pente-group shape).
- `issueSeries`'s Noto bond token deploy (a `ptx_sendTransaction` PRIVATE deploy, not a Pente
  group deploy -- address is top-level `receipt.contractAddress`, `full=false`/default).

`PenteFactory.newPrivacyGroup(...)` (group CREATION itself, as opposed to a deploy into an
already-existing group) is unaffected and out of scope -- it has no idempotencyKey support in
this SDK wrapper at all, already documented where it's used.

Vitest: 7 new tests for `resolveIdempotentFuture` (happy path, PD012220 recovery, PD012220 with
no key, PD012220 with a failed lookup, a non-PD012220 error, a receipt-poll timeout, and `full`
forwarding) -- `deployAgreement`/`issueSeries`/`submitIdempotent` themselves stay live-verified
only, per this codebase's established convention.

**Live check** (`spikes/idempotent-deploy-live-check/live-check.ts`, full cluster discipline
before/after): called `deployAgreement` with the EXACT idempotencyKey
(`onboard-primary:bank2:deploy-agreement`) and groupId a real prior backend call had already used
on node1 (confirmed directly against the node's own DB) -- returned the ORIGINAL agreement
address both times it was called, zero new transactions for that key (DB-verified: still exactly
1 row), with the real server-side PD012220 collision visible in node1's logs both times (expected,
correctly recovered from, not a failure). A brand-new idempotencyKey on the same group still
produced a genuinely new, different deploy.

## 0.4.1 (2026-10-06, task #11 -- fix PD_CLIENT_UNKNOWN_SERIES across processes/nodes)

**Root cause**: `SeriesContext` (populated only in-memory by `issueSeries`) never survived a
process restart or crossed a process/node boundary -- a different process (an investor's own
client on a different node) could never call `getDistributionState`/`getPrice` for a token it
didn't personally `issueSeries`, and BI itself lost this bookkeeping after a restart. Confirmed
independently by this session's own solidity-auditor economic-security pass on
`BondSeriesRegistry` v2.

**BondSeriesRegistry v2** (redeployed, 1 tx from `bondCustodian@node1`; the old v1 registry and
any series registered on it are orphaned, not migrated): `registerSeries` gains a trailing
`address publicTracker` param, `Series`/`getSeries` return it too. Also fixes a solidity-auditor
FINDING found on the v2 diff (2 agents independently, "lost-historical-anchor"): `registerSeries`
now also emits `TermsUpdated(token, termsHash, 1)` -- previously `SeriesRegistered` never carried
`termsHash`/`termsVersion`, and `TermsUpdated`'s first-ever emission was already version 2, so an
off-chain consumer reconstructing hash history purely from events permanently skipped version 1
the moment a second revision happened.

**paladin-client**:
- `getDistributionState`/`getPrice` now resolve the public tracker address via
  `getSeries(token).publicTracker` (public on-chain, works from ANY process/node) instead of the
  in-memory `SeriesContext` cache -- this is the actual fix.
- `SeriesContext` no longer carries `publicTrackerAddress` at all (removed, not just unused --
  it never needed to be a client-side secret).
- New `resumeSeries(token, groupId, privateTrackerAddress): Promise<void>` -- rebuilds the
  remaining BI-private half of `SeriesContext` (the issuer+custodian Pente group and its private
  tracker) after BI's own process restart. `groupId`/`privateTrackerAddress` MUST come from BI's
  own DB -- specifically, persisted from the original `issueSeries` call's returned
  `IssueSeriesResult` (`groupId`, `privateTracker`) -- because neither value is derivable from
  any on-chain state Paladin exposes (no mapping from a Noto token to the Pente group hosting its
  hooks, no way to enumerate a group's deployed contracts from its id alone). `publicTracker` is
  deliberately NOT a `resumeSeries` param -- that's the whole point of v2, it's derivable via
  `getSeries` instead.
- `SeriesRegistryEntry` gained `publicTracker: string`. `SeriesRegistrationParams`/
  `IssueSeriesResult` unchanged.
- **BREAKING**: `issueSeries`'s `registerSeries` call now sends 11 fields, not 10 -- it will
  revert against the OLD v1 registry ABI/bytecode. Every `contract-data-bank{1..4}.json`'s
  `identities.registryAddress` must point at the v2 deploy.

**Live proof** (`spikes/registry-v2-live-proof/live-proof.ts`, full cluster discipline
before/after): (a) `issueSeries` on v2 from node1 (BI) -> `getSeries` from node2 (investor2's own
separate client instance, which never called `issueSeries` for this token) returns
`publicTracker`; (b) that same investor2 client calls `getDistributionState` + `getPrice`
successfully with no `SeriesContext` of its own for this token; (c) BI-restart simulation -- a
brand-new client instance (fresh `connect()`, empty `seriesContexts`) calls `resumeSeries` using
only what the original `issueSeries` call returned, then sends a REAL private transaction
(`beginDistribution`) into the issuer+custodian group it never personally deployed.

**Not fixed here (flagged to the lead for backend-layer routing)**: the solidity-auditor
economic-security pass also found that the real DvP settlement path
(`backend/shared/src/events/primaryFlow.ts`) sources `currencyToken` from Postgres
(investor-supplied, never diffed against `registry.getSeries(token).currencyToken`), so the
on-chain registry's `currencyToken` field is architecturally bypassed by the live settlement
path. This is backend code, out of this package's scope.

## 0.4.0 (2026-10-06, architecture review Phase 1 -- unify primary + outright onto Agreement+RestrictedAtom)

**BREAKING**:
- Removed `BondSubscription`/the upstream unrestricted `Atom`/`AtomFactory` from the platform
  path entirely (D1). Removed methods: `createSubscription`, `resumeSubscription`,
  `preparePayment`, `prepareBond`, `distributeSubscription`, `getOrDeployAtomFactory`. The
  primary subscription now goes through the SAME generic Agreement + RestrictedAtom mechanism
  outright already used (task #8) -- `productType = "PRIMARY"`, 2 legs (cash: investor ->
  custodian; bond: custodian -> investor), via the new `ensurePrimaryGroup()`. Live-proven:
  `spikes/agreement-primary-0.4.0/live-proof.ts`.
- `createAtom`'s `parties`/`executor` and `proposeAgreement`'s `legs[].from/to` are now
  LOOKUPS (`name@node`), not raw addresses -- resolved internally via `getVerifiers` (D2).
- `verifyDelegatedLeg` gained a new REQUIRED `atomAddress` param (D7) and now returns
  `VerifyResult` (`{ok, code?, reason?, outputs?}`), not the old bare `{ok, reason?,
  outputs?}` shape. `verifyCancelCall` also now returns `VerifyResult`.
- `SeriesRegistrationParams`/`SeriesRegistryEntry` gained `instrumentType`/`seriesCode` (now
  round-tripped, previously silently dropped) and `SeriesRegistryEntry` gained `termsVersion`.
- `getOrDeployRestrictedAtomFactory` is no longer async-lazy-deploy -- it's a plain getter that
  throws `PD_CLIENT_MISSING_CONFIG` if `contractData.restrictedAtomFactoryAddress` is absent.
  The factory is deployed ONCE by the bootstrap, never by a client at runtime (lead decision --
  the old deploy-at-runtime branch was dead code; `validateClientConfig` already required this
  field, so `configured` was always truthy in practice).
- `deployAgreement` now requires the calling client's own identity to equal the configured
  `bondCustodian` (throws `PD_CLIENT_WRONG_ROLE` otherwise) -- only BI's own client may set
  itself as the Agreement's trusted `bi` role (closes the solidity-auditor finding below).

**Solidity-auditor delta pass on `Agreement.sol`** (12-agent pass, 5 findings fixed, 70->75
forge tests): (1) `recordLeg`'s one-shot guard and its `allPrepared` completion check used
different sentinels (`unlockCall.length` vs `preparedStateId == 0`) -- a leg owner could submit
`preparedStateId=0` and permanently brick the trade; now both `preparedStateId` and
`unlockCall` are required non-degenerate on every `recordLeg` call. (2) `propose()`'s
anti-squat check was bypassed by a self-dealing leg (`from == to`) -- now rejected
(`SelfDealingLeg`). (3) the constructor's `bi` (trusted-role singleton) had zero validation --
now `require(bi_ != address(0))`, plus `deployAgreement`'s client-side `isBI` gate above. (4)
unbounded `legs[]` enabled O(N) gas griefing on every `accept`/`cancel`/`recordLeg` call -- now
capped at `MAX_LEGS = 8`. (5) `recordLeg`'s declared `amount`/`asset` was never cross-checked
against the real locked value on-chain -- closed via `verifyDelegatedLeg`'s existing
`AMOUNT_MISMATCH` check (callers MUST pass `trade.legs[i].amount` as `expected.amount`).

**New**: `findGroupsWithMembers(memberLookups)` and `ensureInvestorCustodianGroup
(investorLookup)` -- investor+custodian group discovery for the backend (BI creates if absent;
an investor finds the existing one or gets `PD_CLIENT_GROUP_NOT_FOUND` to retry). `onAtomStatusChanged
(listenerName, handler, options?)` (D5) -- ONE listener covers every RestrictedAtom instance
(no address filter); `options.startFromLatest` (default false, same pattern as `onOwnReceipt`)
-- a brand-new listener otherwise replays `AtomStatusChanged` from the chain's earliest history
(confirmed live: a backlog of historical atoms took over 120s to drain before a just-created
one surfaced). `delegateTradeLeg(agreementAddress, tradeId, legIndex)` (D6) -- reads the real
atom from `getAgreement`, verifies its on-chain `operations`/`cancelOperations`/`executor`
against the recorded leg before ever delegating; refuses (`PD_CLIENT_ATOM_MISMATCH`) on a
mismatch -- live-proven. `PD_CLIENT_RECEIPT_TIMEOUT` (retryable, carries `txId` -- a receipt
poll timing out is NOT the same as a genuinely failed transaction). `PD_CLIENT_WRONG_ROLE` (a
BI-only method called by a client whose identity lives on a different node, or isn't BI).
`VerifyResult`/`VerifyCode`: every `verifyDelegatedLeg`/`verifyCancelCall`/`delegateTradeLeg`
rejection now carries a stable `code` (`NOT_DELEGATED` | `SPENDER_NOT_ATOM` | `LOCKID_MISMATCH`
| `COMMITMENT_MISMATCH` | `AMOUNT_MISMATCH` | `RECIPIENT_MISMATCH` | `FOREIGN_OUTPUT` |
`STATE_NOT_FOUND`) instead of a free-text `reason` a backend would otherwise have to
pattern-match. `NOT_DELEGATED`/`STATE_NOT_FOUND` are TRANSIENT (eventual consistency -- nack
and retry); every other code is DEFINITE (cancel the leg/trade, mark FAILED). `toFixedBytes`/
`fromFixedBytes`/`toUnixSeconds`/`fromUnixSeconds`/`toBytes32Hash` (D3) -- `issueSeries`/
`getSeries` now actually encode/decode `instrumentType`/`seriesCode`/`isin`/dates/`termsHash`
instead of trusting raw caller bytes. Registry writes (`registerSeries`/`setSeriesStatus`/
`updateTerms`) now signed by `bondCustodian`, the registry's real `onlyOwner`, not
`bondIssuer` (D4); the bootstrap now writes `identities.bondIssuer`.

**Fixed, found only by the live proof** (none of these were catchable by vitest mocks):
- `issueSeries`'s `BondTrackerPublic` deploy call passed raw ISO date strings for
  `issueDate_`/`maturityDate_` instead of unix seconds -- reverted on every real call
  (`FF22088: Invalid integer string`); the sibling `registerSeries` call a few lines later had
  the correct D3 encoding, this earlier one didn't.
- `findGroupsWithMembers`'s `pgroup_queryGroupsWithMember(member, {})` call -- unlike
  `pstate_queryContractStates`, this RPC method rejects an empty query object outright
  (`PD010721: limit is required on all queries`); now passes `{ limit: 100 }`.
- `ensureInvestorCustodianGroup` and `ensurePrimaryGroup`'s `getOrCreateInvestorCustodianGroup`
  both called `requireIdentityVerifier("bondCustodian")` just to READ the configured lookup
  string for comparison/group-membership purposes -- this incorrectly rejected a cross-node
  caller (an investor's own client, on a different node than `bondCustodian`) with
  `PD_CLIENT_WRONG_ROLE`, even though no signing as `bondCustodian` happens in that branch. New
  internal `configuredIdentityLookup(key)` reads the config value without the same-node
  signing assertion; `requireIdentityVerifier` (used only where a method actually signs as that
  identity) is unaffected.
- `delegateTradeLeg`'s executor check compared a contract-call result against an address from
  `getVerifiers().address()` without normalizing the "0x" prefix on the former -- the two were
  often the SAME address, textually different, and the check failed every real call.
- D7's originally-planned step 4 of `verifyDelegatedLeg` -- simulating the atom's own
  `spendLock` call with `from: atomAddress` to bind verification to the lock's real
  EIP-712 commitment -- is REMOVED. Confirmed against the real cluster and Paladin's Go source
  (`core/go/internal/txmgr/transaction_submission.go`'s `callTransactionPublic`,
  `core/go/internal/keymanager/manager.go:241-264`) that `ptx.call`'s `from` is ALWAYS resolved
  through the key manager's identity derivation -- a contract address is not a resolvable
  signing identity, so this simulation reverted on every call regardless of whether the real
  commitment matched, making the check a permanent false reject rather than the intended
  proof. Not a reopened gap: the `spender == atomAddress` check (a real read, not a
  simulation), `delegateTradeLeg`'s on-chain operations check (D6), and `recordLeg`'s one-shot
  guard (the solidity-auditor fix above) together already pin the exact bytes that will run at
  `executeAtom` time before this check ever runs.

**Live proof** (`spikes/agreement-e2e/live-proof.ts` + `spikes/agreement-primary-0.4.0/live-proof.ts`,
full cluster discipline, bootstrap still NOT `--execute`): (a) primary subscription through
Agreement+RestrictedAtom -> SETTLED, with a REAL hooked bond token (BondTracker/InvestorList)
confirming the whitelist hook still runs for the bond leg; (b) outright -> SETTLED, plus the
pre-existing buyer-attack-rejection/delegate-abandon-recover/releaseLock scenarios re-confirmed
against 0.4.0; (c) `onAtomStatusChanged` receiving both `Executed` and `Cancelled`; (d) a
registry write by `bondCustodian` round-tripped exactly through `getSeries`; (e)
`delegateTradeLeg` refusing to delegate against an atom whose operations don't match the
recorded leg; (f) BI creates an investor+custodian group, the investor (node2) independently
finds the SAME groupId via `ensureInvestorCustodianGroup`.

## 0.3.2 (2026-10-05, task #9 -- config seam fix, cash notary separated from BI)

**New**: `loadClientConfigFile(filePath, { nodeUrl, wsUrl?, rpcAuth? }) -> PaladinClientConfig`
and `validateClientConfig(cfg)`, both exported from `./index`. Closes the 0.3.0/0.3.1 "known
gap": the backend's own contract-data file shape had drifted from what `client.ts` actually
reads (`identities.registryAddress`/`bondCustodian`, `contractData.restrictedAtomFactoryAddress`
-- different field, different key names than the backend's `{cashToken, registry, atomFactory,
groupIds}`). Lead decision: paladin-client is the single source of truth for this shape now --
the backend must call `loadClientConfigFile` only, never build or map this shape itself again.
`validateClientConfig` throws `PD_CLIENT_MISSING_CONFIG` naming the exact missing field, before
any connection is attempted. Required fields (confirmed by reading every real call site, not
guessed): `nodeId`, `identity`, `identities.registryAddress`, `identities.bondCustodian`,
`contractData.restrictedAtomFactoryAddress`. Deliberately NOT required (optional/lazy in the
real code): `identities.bondIssuer` (BI-only), `identities.investorCustodianGroupId` (lazily
created), `contractData.atomFactoryAddress` (lazily deployed). 9 new vitest tests.

**Design decision recorded (not a code change)**: the cash (RD) Noto token's notary is a
SEPARATE identity, `cashIssuer@node1`, never `bondCustodian@node1` -- separation of roles
between the RD issuer and the DFABI custodian/executor. Confirmed nothing in `client.ts`
assumes otherwise: every cash-token interaction (`lockToken`/`prepareUnlock`/`delegateLock`)
only cares about `tokenAddress`, never about who that token's notary is, and
`verifyDelegatedLeg`/`verifyCancelCall`'s state reads use `this.verifier.lookup` purely as the
`from` on a read-only call -- since `cashIssuer` and `bondCustodian` are both node1 identities,
BI's own client sees the same local state store regardless of which of its node1 identities is
used for the read.

**Updated**: `Paladin/scripts/bootstrap-platform.ts` now deploys the cash token with
`cashIssuer@node1` as notary (not `bondCustodian`), writes each `contract-data-<bank>.json` in
the new `loadClientConfigFile`-compatible shape, round-trips every written file through
`loadClientConfigFile` as a sanity check before declaring success, and the dry run now prints
the full file content each bank would get (addresses as `"<tbd>"`) alongside the numbered plan.
Still dry-run by default; still not executed against the cluster.

## 0.3.1 (2026-10-05, 2 blockers found matching 0.3.0 against the real backend)

**Fixed (`sendGroupMessage`, the last PD_NOT_IMPLEMENTED stub)**: implemented via
`pgroup_sendMessage`. The whole backend outbox flow (primary + outright) depends on it; in real
mode every message would have thrown. `idempotencyKey` is accepted for signature consistency
but NOT forwarded anywhere -- found LIVE (not just from the type def) that `correlationId`,
the only related wire field, is validated server-side as a real UUID
(`PD020704: invalid UUID length` on a `tradeId:topic`-style string), not free-form metadata, so
a caller's own key can never safely go there. The receiver remains the real dedup boundary (it
must dedupe by `tradeId:topic` itself) -- unchanged from the original design. 1 new vitest
test. Live-proven: `Paladin/spikes/agreement-e2e/ensure-outright-group-proof.ts` -- investorA
(node2) sends via the real `sendGroupMessage`, investorB (node3) receives via the real
`onGroupMessage` on the same (resumed) group.

**Fixed (fund safety, FALSE NEGATIVE)**: `verifyDelegatedLeg`'s `expected.recipient`/
`expected.owner` and `verifyCancelCall`'s `owner` only ever accepted a raw address, compared
directly against NotoCoin's stored owner field -- but the real backend always passes a
Paladin LOOKUP (`name@node`) there (`primaryFlow.ts:317`, `outrightFlow.ts:526`), which a raw
address field never matches. In real mode this failed CLOSED: every subscription and every
outright trade would have been incorrectly rejected as invalid. Fixed: both now accept either
form via a new `resolveToAddress` helper -- a raw address is used as-is, anything else is
resolved to an address via `getVerifiers` on the node doing the verifying (local/deterministic
resolution, safe regardless of which node is actually verifying). 2 new vitest tests (one per
function) proving a lookup and its equivalent raw address produce an identical result.

**Fixed (test fixtures)**: several existing test address constants were 38 hex chars, not 40 --
harmless where compared only to each other, but would have silently matched `requireLookup`'s
raw-address check as "not an address" once the 0.3.0 fund-safety guard landed. Corrected to
real 40-hex-char addresses.

## 0.3.0 (2026-10-05, task #8 -- generic Agreement contract + outright trading)

**New (Agreement.sol lifecycle, all live-proven)**: `deployAgreement`, `ensureOutrightGroup`
(see below), `proposeAgreement`, `resumeAgreement`, `acceptAgreement`, `recordLeg`,
`recordAtom`, `confirmSettled`, `markFailed`, `cancelAgreement`, `getAgreement`. Also
`createAtom` (now takes `cancelOperations` too, matching `RestrictedAtomFactory.create`'s new
param) and `cancelAtom` -- all were `PD_NOT_IMPLEMENTED` stubs before this release.

**New**: `getDistributionState` now also returns `purchasePrice`/`minimumDenomination`/
`paymentToken` (from the public `TokenDistribution` behind `BondTrackerPublic.distribution()`),
plus a new `getPrice(token, units)` -- so an investor can read the distribution price
trustlessly on-chain before locking the right amount.

**New**: `ensureOutrightGroup(bankALookup, bankBLookup, knownGroupId?)`. A real privacy group
id can't be computed in advance -- confirmed by reading Paladin's own
`groupmgr.CreateGroup` (`core/go/internal/groupmgr/manager.go:252-255`): the genesis salt is
ALWAYS randomly generated server-side on every call, with no input field to override it, so
identical members+name never produces the same group id twice and re-creating is never
idempotent. This method creates (or resumes, given a known id) a 3-party group for a bank
pair + this client's own identity, caching it in-memory for the process.

**Fixed**: `preparePayment`/`prepareBond` only returned `{preparedStateId, lockId}`/`{lockId}`,
forcing a caller to re-call `prepareUnlock` to get `unlockCall`/`cancelCall` -- but re-preparing
(allowed pre-delegation) changes the lock's spendCommitment, silently invalidating the
already-recorded unlockCall/cancelCall from the FIRST prepare. Both now return
`{..., unlockCall, cancelCall}` from their single internal prepare call.

**New**: `PD_CLIENT_LOCK_ALREADY_PREPARED` guard on `prepareUnlock` (closes the bug above at the
client layer for every caller, not just preparePayment/prepareBond) -- throws BEFORE sending
anything if the lock already has a prepared unlock; `{ allowRePrepare: true }` opts out for an
intentional re-prepare (e.g. `releaseLock`'s own prepare-to-self recovery path).

**New**: `verifyCancelCall` (mirrors `verifyDelegatedLeg` for the cancel path -- all outputs
must belong to the single owner), `releaseLock` (undelegated-lock recovery via
prepare-to-self + single-leg cancel atom), `health()`, `isLockDelegated`/`isLockPrepared`
(exported standalone helpers).

**Changed (lead-decided reorder, 2026-10-05)**: `recordAtom` now runs right after `createAtom`,
BEFORE any leg delegates -- not after, as task #8's original design had it. Closes a real gap
(Agreement.cancel() can never release a leg delegated before recordAtom, since Agreement is
never the Noto lock's spender) by construction: every delegation now happens strictly inside
ATOM_CREATED, where cancel() is already unreachable. `verifyCancelCall` no longer requires the
lock to already be delegated (safe without it: cancelCall only ever returns a leg's own funds
to its own owner, so a stale cancelCall after re-prepare is self-harm, not exploitable against
a counterparty) -- `verifyDelegatedLeg` keeps its delegation-gated check, since unlockCall
moves funds to the counterparty.

**Security (solidity-auditor, 12-agent pass on Agreement.sol/RestrictedAtom.sol/
RestrictedAtomFactory.sol, all fixed + regression-tested, 70/70 forge tests)**:
- `Agreement.recordLeg` let a leg owner overwrite an already-prepared leg while
  `state == LEGS_PREPARED` (6/12 agents converged) -- guard narrowed to `ACCEPTED` only, plus a
  one-shot `preparedStateId != 0` check.
- `RestrictedAtom.cancel()` had no retry if a leg's release call genuinely failed -- `status`
  is terminal once `Cancelled`, so that leg was stuck forever with zero recourse. Added
  `retryRelease(index)`.
- `Agreement.propose()` had no caller-authorization check -- any privacy-group member could
  squat a `tradeId` with bogus/empty legs and permanently burn it. Fixed: `propose()` now
  requires `msg.sender` be a party to one of the legs.
- `RestrictedAtom.execute`/`simulate`/`cancel` used `abi.decode(ret,(bool))` to check a call's
  return value, which PANICS on any non-canonical 32-byte return -- in `cancel()`'s loop this
  wasn't try/catch-wrapped, so it could revert the whole transaction and re-strand every leg.
  Fixed: raw word check (`uint256(bytes32(ret)) != 0`) instead.

**Live proof** (`Paladin/spikes/agreement-e2e/live-proof.ts`, real Alibaba cluster, mandatory
pods/receiptless/ERROR discipline before+after, all clean): 23/23 checks across the 4 required
scenarios -- honest 2-party outright to SETTLED; a buyer-attack (worse-terms re-prepare before
delegating) correctly rejected by `verifyDelegatedLeg` before `executeAtom`; delegate-then-
abandon-then-recover via the atom's own `cancel()` (`Agreement.cancelAgreement` confirmed
unreachable once `ATOM_CREATED`, proving the reorder invariant live); `releaseLock` on an
undelegated lock (restores balance) vs. a delegated one (throws, no tx sent). Also live-
confirmed `getAgreement` round-trips a leg's `cancelCall` exactly.

**Fixed (fund safety, lead-required)**: a raw 0x address passed where a Paladin lookup
(`name@node`) was expected used to silently resolve to a DIFFERENT, unrelated identity via
`sdk.getVerifiers()` -- found live writing the task #8 proof (a prepared output ended up owned
by neither party). New `requireLookup` guard throws `PD_CLIENT_INVALID_RECIPIENT` BEFORE
sending anything if a lookup-typed parameter looks like a raw address instead -- applied to
every caller-supplied lookup resolved this way: `prepareUnlock`'s `recipients[].to`,
`mintToken`'s `to`, `createPrivacyGroup`'s `members[]`, `ensureOutrightGroup`'s bank lookups,
and `addInvestor`/`setInvestorStatus`'s `lookup`. This is the opposite convention from
`AgreementLeg.from`/`to` and `delegateLock`'s `delegateAddress`, which DO take raw addresses --
those are unaffected (not resolved via `getVerifiers`, so there was never a misdirection risk,
only a fail-closed mismatch). 2 new vitest tests for `requireLookup` directly.

## 0.2.3 (2026-10-05, task #6c -- productizing #5b)

**New**: `verifyDelegatedLeg(tokenAddress, lockId, unlockCall, {recipient, amount, owner}) ->
{ok, reason?, outputs?}`. Productizes the binding check proven live in task #5b
(`Paladin/spikes/binding-5b/spike.ts`) so the backend doesn't hand-rewrite it per call site.
Checks, in order: (1) the lock is ALREADY DELEGATED (`getLock(lockId).spender != owner`) --
calling this on a not-yet-delegated lock returns `ok: false, reason: "not yet delegated"`
rather than a false pass, since re-prepareUnlock is impossible once delegated
(`Noto.sol:478-479`'s `LockImmutable`) and that's what makes a post-delegation check
trustworthy no matter when it runs. (2) decodes `unlockCall` as `spendLock(lockId, spendArgs,
data)` and confirms the embedded lockId matches `lockId` (catches a swapped-in unrelated lock's
call). (3) decodes `spendArgs` as `NotoSpendLockArgs` for the real, enforced `outputs`, reads
each from this node, and requires total-to-`recipient` == `amount` and every other output
belongs only to `owner` (legitimate change), never a third party. Exported as a pure function
(`verifyDelegatedLeg`, mocked-sdk testable, same pattern as `verifyLockOwner`) and wrapped as a
`PaladinClient` method. 5 new vitest tests using REAL ABI-encoded fixtures (ethers), not stubbed
strings -- not-delegated, honest-accept, wrong-lockId-reject, wrong-amount-reject (the #5b
attack shape), third-party-output-reject. 25/25 total pass. Live-verified by reusing the #5b
scenario through the real method (not just the spike's inline check) -- see progress.md's task
#6c entry.
**Reason this exists**: the primary-subscription flow needs it too, not just outright trading --
BI must verify the investor's cash leg after `preparePayment`'s delegate step and before
`executeAtom` (recipient = custodian, amount = price x units, owner = investor).

## 0.2.2 (2026-10-05, task #5)

**Fixed (bug in 0.2.1's own fix)**: `toPaladinClientError` did not pass through an
already-constructed `PaladinClientError` -- it only recognized Paladin's own raw
`"PDxxxxxx: message"` RPC error format, so ANY custom-coded error (`PD_CLIENT_LOCK_OWNER_MISMATCH`,
`PD_CLIENT_UNKNOWN_SERIES`, `PD_CLIENT_MISSING_CONFIG`, etc.) thrown inside a method whose own
`catch` block re-wraps via `toPaladinClientError(err)` -- which is nearly every method in this
file -- was silently downgraded to generic `PD_CLIENT_UNKNOWN`, losing the specific code and
discoverable only by string-matching the message. Found live while verifying the 0.2.1
ownership guard in task #5's binding spike: `delegateLock` from the wrong identity threw
`PD_CLIENT_UNKNOWN` instead of the guard's own `PD_CLIENT_LOCK_OWNER_MISMATCH`. Fixed with an
`instanceof PaladinClientError` passthrough check at the top of `toPaladinClientError`. 3 new
vitest tests. 20/20 total pass. Live-verified in the binding spike after the fix (see
progress.md's task #5 entry) -- the guard now throws the correct code and no transaction reaches
the node.

## 0.2.1 (2026-10-05, incident response)

**Fixed (safety)**: `delegateLock` and `prepareUnlock` now refuse client-side, before submitting
anything, if the lock's actual on-chain owner does not match the calling identity. Root cause of
a live incident: a script called `delegateLock` as one identity ("bi") to delegate a lock that
was actually created as a DIFFERENT identity ("bondCustodian"). Paladin's endorsement rejected it
(`PD200018: State ... is not owned by ...`) but the coordinator retried that endorsement
indefinitely instead of failing the transaction outright, and the accumulated backlog from a few
such stuck calls exhausted node1's resources into a `CrashLoopBackOff`. New exported
`verifyLockOwner(sdk, domain, tokenAddress, lockId, expectedOwnerAddress, callerName)` queries
the lock's current owner via the `NotoLockInfo_V1` state schema (`pstate_listSchemas` +
`pstate_queryContractStates`, filtered on `lockId`, reading `data.owner`) and throws
`PD_CLIENT_LOCK_OWNER_MISMATCH` before any `ptx_sendTransaction`/`pgroup_sendTransaction` call.
4 new vitest tests (owner match, mismatch, lock not found, schema not found) -- unit-tested only
with a mocked SDK; **NOT live-verified against the cluster**, which was frozen (no transactions)
for this incident at the time this was written. Live verification is pending the freeze lifting.

## 0.2.0 (2026-10-05, task #6b)

No prior release exists to diff against (this package was never packed/released before; 0.0.1
was WIP-only, consumed by the backend directly from `build/` via `file:`, which is exactly the
untracked-breakage problem this versioning process now fixes). This is the first release.

**Implemented** (previously typed-only, throwing `PD_NOT_IMPLEMENTED`):
- Phase 2: `lockToken`, `prepareUnlock`, `delegateLock`, `mintToken`, `createPrivacyGroup`,
  `resumePrivacyGroup`, `executeAtom`.
- Phase 3 (new): `issueSeries`, `mintTranche`, `beginDistribution`, `closeDistribution`,
  `setActive`, `forceCompleteDistribution`, `getSeries`, `setSeriesStatus`, `updateTerms`,
  `getDistributionState`, `addInvestor`, `setInvestorStatus`, `createSubscription`,
  `resumeSubscription` (new, not originally specified -- see below), `preparePayment`,
  `prepareBond`, `distributeSubscription`.

**Still typed-only** (`PD_NOT_IMPLEMENTED`): `sendGroupMessage`, `proposeAgreement`,
`acceptAgreement`, `recordLeg`, `createAtom`, `cancelAtom` -- the generic Agreement-contract
lifecycle, out of #6b's scope.

**Breaking type changes** from the 0.0.1 WIP shapes agreed earlier in task #6b's design pass:
- `createSubscription` returns `{ subscriptionAddress, groupId }`, not just `{ subscriptionAddress }`.
- `preparePayment` returns `{ preparedStateId, lockId }`, not just `{ preparedStateId }`.
- `prepareBond` returns `{ lockId }`, not `void`.
- New method `resumeSubscription(subscriptionAddress, groupId, bondAddress, investorLookup)`:
  found live while building the subscription flow -- `prepareBond`/`distributeSubscription` only
  take `subscriptionAddress`, but that address lives inside a Pente privacy group paladin-client
  has no way to discover from the address alone (confirmed live: `domain_getSmartContract
  ByAddress` returns PD011609 "not yet indexed" for a contract deployed inside a group, not at
  the base ledger). BI's client is a different identity than the investor's that called
  `createSubscription`, so it never saw that result. The backend must persist
  `createSubscription`'s `groupId` and forward it to BI (realistically via the group's own
  `pgroup_sendMessage` -- `sendGroupMessage`/`onGroupMessage`, already typed) before calling
  `resumeSubscription` once, then `prepareBond`/`distributeSubscription` as normal.
- `SeriesRegistrationParams` gained `transferRestricted: boolean` (needed by
  `BondSeriesRegistry.registerSeries`'s real signature; omitted from the original gaps.ts draft).
- `registerSeries` was dropped entirely -- split into `issueSeries` (one-time deploy) +
  `mintTranche`/`beginDistribution`/`closeDistribution`/`setActive`/`forceCompleteDistribution`
  (repeatable lifecycle steps), per the lead's explicit decision: "registerSeries is too fat."
- `PaladinClientConfig` gained `identities: { registryAddress?, bondIssuer?, bondCustodian?,
  investorCustodianGroupId? }`. `bondIssuer`/`bondCustodian` are FULL lookups (`name@nodeId`),
  not bare local names -- an earlier draft of this doc wrongly assumed same-node resolution,
  caught and corrected while writing the live proof (BI's identities live on BI's own node
  regardless of which client, investor or BI, is calling).

**New: idempotencyKey on every submit-style method** (lead requirement, task #6b): the backend
calls Paladin inside a DB transaction; a commit failure after Paladin already succeeded means a
redelivery repeats the call. Paladin rejects a reused key (`PD012220`) rather than returning the
original transaction -- `client.ts`'s `submitIdempotent` helper resolves that rejection to the
ORIGINAL transaction's receipt via `ptx_getTransactionByIdempotencyKey`, so a redelivery is
idempotent end-to-end. Multi-step methods (`issueSeries`, `preparePayment`, `prepareBond`) derive
a key per substep (`${key}:deploy-token`, etc.). Proven live: calling `prepareBond` twice with
the same key resolves to the same `lockId` (1 transaction on-chain), not two.
**Known gap**: group creation (`createPrivacyGroup`'s underlying `PenteFactory.newPrivacyGroup`
SDK wrapper) does not support idempotencyKey -- not in the lead's explicit method list for this
requirement, left unfixed.

**Fixed**: packaging bug found while rebuilding for this release -- `client.ts` imported contract
artifact JSON files via relative paths reaching OUTSIDE this package (`../../../contracts/out/
...`, `../../../bond/src/abis/...`). This broke `tsc`'s flat `build/` output (nested
`build/bond/`, `build/contracts/` instead of `build/client.js`) because those external files
entered `tsc`'s `rootDir` inference, and would have broken the backend's `file:` consumption
entirely (those sibling package directories aren't guaranteed to exist relative to an installed
copy). Fixed by copying the needed artifacts into `src/abis/` (same pattern `bond/src/abis/`
already uses) -- re-copy from `Paladin/contracts/out/` after any
BondTracker/BondTrackerPublic/BondSeriesRegistry/InvestorList rebuild.

**Known limitation** (flagged, not engineered around): `seriesContexts`/`subscriptions` (the
token/subscriptionAddress -> Pente group + contract mapping `issueSeries`/`createSubscription`
populate) are in-memory only on the `PaladinClientImpl` instance -- they do NOT survive a backend
process restart. The lead's confirmed method shapes (bare `token`/`subscriptionAddress`, no
groupId/tracker params on most calls) put this resolution inside paladin-client, not the caller.
For now, the caller must keep calling through the SAME client instance for a series' whole
lifecycle (or use `resumeSubscription`/`resumePrivacyGroup` to rehydrate after a restart, given
the underlying addresses persisted elsewhere, e.g. the backend's own DB).

## 0.1.0

Not released as a tarball -- see the 0.2.0 entry above for why. If a true phase-1-only snapshot
is ever needed (e.g. a consumer wants the pre-#6b surface specifically), it is NOT reconstructed
here; this package has no git history to recover it from.
