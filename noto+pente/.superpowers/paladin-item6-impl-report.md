# BACKLOG #6 implementation report (option (b), D36) -- paladin, 2026-10-08

## Diff summary per item

**src/BondTracker.sol**

1. Storage (:55-58, after the mirror fields block): `uint256 internal _roundSeq;` +
   `mapping(bytes32 => uint256) internal _lockRound;` with the D36 comment (stamped at
   prepare, compared at settle; stale locks settle as round-tagged non-sales).
2. beginDistribution (:94-96): `_roundSeq++;` immediately after the `_status == Status.ISSUED`
   gate passes, alongside the other slot writes; comment: every reopen opens a new round.
3. onUnlock (:339-362): sale block replaced with the stamped-vs-current branch --
   `if (_lockRound[lockId] == _roundSeq)` keeps today's decrement + `onDistribute(uint256)`;
   `else` emits `PenteExternalCall(_publicTracker, "onStaleLockSettled(bytes32,uint256,uint256)",
   lockId, _lockRound[lockId], total)`. NO revert in the stale branch. Existing loop comments
   (task #6b custodian-refund exclusion) kept intact.
4. onPrepareUnlock (:383-385): `_lockRound[lockId] = _roundSeq;` inside the existing
   `_status == DISTRIBUTION_STARTED && lockFrom == _custodian` gate block, after
   `_checkSaleAllowed(quantity)`; comment notes re-prepare refreshes the stamp.
5. onCreateTransferLock (:424-426): same stamp in its gate block, after
   `_checkSaleAllowed(quantity)`, before `_locks.onLock`.
6. onCreateMintLock (:444) and onPrepareMintUnlock (:457): one-line comment each, no stamp --
   custodian-only recipients per `_checkMintRecipients`, never sales (excluded from sale
   totals :353/:502).
7. handleDelegateUnlock (:539-562): identical stale branch to onUnlock (verified byte-identical
   by diff of the two excerpts; only the excerpt's trailing window differs). The real
   base-ledger transfer (:528-530 `_locks.handleDelegateUnlock` + `_transfer` loop) runs
   unchanged before the branch either way.

**src/BondTrackerPublic.sol**

- Event `StaleLockSettled(bytes32 indexed lockId, uint256 round, uint256 amount)` at :45-46
  (with the other events).
- Receiver `onStaleLockSettled(bytes32,uint256,uint256) external onlyOwner` at :245-247,
  notification only (no status, no counters). Comment documents: onlyOwner = the privacy
  group's own address (same as onIssue/onBurn); receiver MUST exist wherever the stale branch
  can fire (PentePrivacyGroup.sol:291-298 `contractAddress.functionCall`, no try/catch);
  branch only fires where a stamp was written, i.e. trackers with this bytecode (D33:
  existing series keep un-stamped behavior).

**test/BondTracker.t.sol**

- New section at :1178+: helper `_reopenWithStaleLock` (:1185) driving the full D34 reopen
  (mint tranche 1 -> beginDistribution round 1 -> addInvestor -> onLock+onPrepareUnlock
  [stamp round 1] -> forceComplete -> burn UNENCUMBERED remainder only -> close -> setActive
  -> mint tranche 2 -> beginDistribution round 2), plus four new tests:
  - testStaleLockDelegateSettleAccountedAsRoundTaggedNonSale (:1222)
  - testStaleLockDirectSettleAccountedAsRoundTaggedNonSale (:1253)
  - testStaleLockRepreparedUnderNewRoundSettlesNormally (:1283)
  - testSettleUnknownLockReverts (:1309) -- D28 regression: settle of a never-created/
    released lockId reverts on BOTH paths (onlyLockOwner on empty ownerOf; delegate
    recipients-mismatch on empty getLock).
- Existing-test adjustments, see Deviations.

**test/BondTrackerPublic.t.sol**

- Local Vm interface extended with `recordLogs`/`getRecordedLogs` + `Log` struct (:11-25),
  same shape as BondTracker.t.sol's, needed for event assertion.
- New test testStaleLockSettledReceiverEmitsAndChangesNothing (:347): prank owner, call
  onStaleLockSettled(lockId, 1, 600), assert the `StaleLockSettled` event (topics[1] = lockId,
  data decodes round == 1, amount == 600) AND that `_status` stays INITIALIZED,
  `distribution` stays address(0), totalSupply/trancheCount stay 0.

**BACKLOG.md** (the single permitted edit): Risk 2's last sentence replaced by the lead's
"ACCEPTED ADJACENT LIMITATION (lead, 2026-10-08)" paragraph verbatim. Nothing else changed.

## Stale-event assertion method

Existing convention reused: `vm.recordLogs()` -> settle call -> `vm.getRecordedLogs()` ->
`_lastExternalCallTo(logs, publicTracker)` decodes the LAST `PenteExternalCall` event aimed at
the public tracker, then compares `keccak256` against the expected
`abi.encodeWithSignature("onStaleLockSettled(bytes32,uint256,uint256)", lockId, 1, 600)`.
This is the same mock/anvil pattern (recorded event, no real Pente call) as
testHandleDelegateUnlockNotifiesPublicTrackerOnRealDvPPath -- no real public tracker wired.

## Forge result (verbatim)

```
Ran 12 tests for test/BondSeriesRegistry.t.sol:BondSeriesRegistryTest
Suite result: ok. 12 passed; 0 failed; 0 skipped; finished in 6.09ms (2.97ms CPU time)
Ran 30 tests for test/Agreement.t.sol:AgreementTest
Suite result: ok. 30 passed; 0 failed; 0 skipped; finished in 7.45ms (13.43ms CPU time)
Ran 19 tests for test/RestrictedAtom.t.sol:RestrictedAtomTest
Suite result: ok. 19 passed; 0 failed; 0 skipped; finished in 7.48ms (9.03ms CPU time)
Ran 16 tests for test/BondTrackerPublic.t.sol:BondTrackerPublicTest
Suite result: ok. 16 passed; 0 failed; 0 skipped; finished in 7.48ms (4.03ms CPU time)
Ran 44 tests for test/BondTracker.t.sol:BondTrackerTest
Suite result: ok. 44 passed; 0 failed; 0 skipped; finished in 7.50ms (32.25ms CPU time)
Ran 5 test suites in 10.72ms (36.00ms CPU time): 121 tests passed, 0 failed, 0 skipped (121 total tests)
EXIT=0
```

Baseline before the change was 116 passed / 0 failed; +5 new tests = 121. Mandated D27/D28
regressions pass: testBeginDistributionResetsMirrorForNewTrancheNotAccumulated,
testBurnOnReopenFlowEndToEnd, testSettleUnknownLockReverts (new).

## Deviations (2, both flagged for lead)

1. Five existing tests adjusted to prepare before an `onUnlock` settle. The approved design
   stamps only in onPrepareUnlock/onCreateTransferLock, but NotoLocks.onLock does NOT prepare
   (upstream NotoLocks.sol:33-38 -- creation only), and the direct path legitimately settles
   locks that were never prepared (`_lockRound == 0`). Under the literal design those settles
   flip from sale to stale, breaking 5 existing direct-path tests that assert the
   decrement/onDistribute. Fix: added the real-flow `onPrepareUnlock` step (2-3 lines each,
   with a one-line D36 comment) before the settle in:
   - testOnUnlockExecutionNotifiesPublicTrackerWhenCustodianDistributes (:89-92)
   - testOnUnlockExcludesCustodianRecipientFromSaleTotal (:167-170)
   - testAvailableUnitsPrivateDecrementsAfterSettlement (:825-828)
   - testOnPrepareUnlockRevertsAfterPriorSaleConsumedUnits (:856-859)
   - testBeginDistributionResetsMirrorForNewTrancheNotAccumulated (:900-903) -- a mandated
     "pass unchanged" regression; the edit is additive (prepare call added, all original
     assertions untouched).
   Alternative rejected: also stamping in the plain `onLock` hook would have kept all tests
   untouched but extends the stamp's documented meaning ("round of the prepare-time sale
   check") beyond the approved design into production semantics.
   Consequence the lead should know: a custodian lock settled WITHOUT any prepare is now
   accounted as a round-0 stale non-sale (no decrement, no onDistribute, stale event with
   round == 0) even in the same round, where today it decremented. Balances still move (never
   revert). If that is not wanted, the stamp must move into `onLock` instead.
2. The comment above the sale-total loops is the pre-existing two-line task-#6b comment (kept
   intact per instructions), not the one-line truncated form shown in the delegation snippet.
