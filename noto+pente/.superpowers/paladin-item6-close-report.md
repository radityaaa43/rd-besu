# BACKLOG #6 close report — round-0 stale semantics (condition 2)

Date: 2026-10-08. Lead-ratified option (i): no-prepare settle = round-0 stale.

## Test

- Name: `testCustodianSettleWithoutPrepareIsRoundZeroStaleNonSale`
- Location: `/home/ecs-user/alibaba-kube/Paladin/contracts/test/BondTracker.t.sol:1334`
- Drive: fresh contract -> onMint(1000) -> beginDistribution(1,1) (round 1, `_roundSeq`=1)
  -> investor1 registered -> `onLock(custodian, lockId, custodian, 600)` with NO
  `onPrepareUnlock` (`_lockRound[lockId]` unstamped = 0) -> custodian `onUnlock` 600 to
  investor1.
- Assertions: no revert; `onStaleLockSettled(bytes32,uint256,uint256)` emitted with
  (lockId, 0, 600) via the existing `recordLogs`/`_lastExternalCallTo` keccak-compare
  pattern (copied from `testStaleLockDirectSettleAccountedAsRoundTaggedNonSale` :1253);
  `balanceOf(investor1)==600`, `balanceOf(custodian)==400` (real transfer stands);
  `availableUnitsPrivate()==1000` unchanged (non-sale, no decrement, no onDistribute).
- No contract change (`src/` untouched); the behavior is what the D36 stale branch already
  does: unstamped lock reads `_lockRound==0`, `0 != _roundSeq(1)` -> stale branch.

## Forge result (verbatim)

```
Ran 5 test suites in 11.92ms (45.56ms CPU time): 122 tests passed, 0 failed, 0 skipped (122 total tests)
EXIT=0
```

Suites: Agreement, BondSeriesRegistry, BondTracker, BondTrackerPublic, RestrictedAtom — all 0 failed.

## Doc lines

- `/home/ecs-user/alibaba-kube/Paladin/BACKLOG.md:136-138` — appended at the end of the
  "Exact gate/revert conditions" section (under the #6 design note):
  "Round 0 stamp means "never prepared" and is deliberately a NON-SALE (no decrement, no
  onDistribute) -- do not "fix" this into a sale; a sale is only ever counted through a
  prepare (lead-ratified 2026-10-08)."
- `/home/ecs-user/alibaba-kube/Paladin/common/paladin-client/CHANGELOG.md:30-31` — in the
  0.6.11 entry, after the "Ratified consequence" bullet:
  "Round 0 = never-prepared, deliberately non-sale (backend reads round 0 in
  onStaleLockSettled as "never prepared, not a sale")."

## Files touched

- test/BondTracker.t.sol (one test added)
- BACKLOG.md (one clause)
- common/paladin-client/CHANGELOG.md (one clause)
- Nothing else: no src/, no abis/, no cluster, no git, no new deps.
