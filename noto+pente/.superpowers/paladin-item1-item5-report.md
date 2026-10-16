# Paladin subagent report: BACKLOG #1 + BACKLOG #5

Date: 2026-10-08
Scope touched (only these): `src/BondTracker.sol`, `test/BondTracker.t.sol`.
NOT touched: `src/BondTrackerPublic.sol`, `test/BondTrackerPublic.t.sol` (Item A blocked, see below), BACKLOG.md, abis, TS, cluster.

## Item A — BACKLOG #1 (BondTrackerPublic.onIssue status gate): BLOCKED

Blocked on the lead's own stop condition: "does the public lifecycle ever legitimately hit onIssue in a status other than INITIALIZED/ACTIVE ... If you find a legitimate path that would revert with the gate (e.g. status DISTRIBUTION_COMPLETE), STOP and report BLOCKED." I found exactly that. No code was changed for Item A.

Evidence — onIssue IS legitimately called at DISTRIBUTION_COMPLETE in this fork's documented reopening design:

1. `src/BondTrackerPublic.sol:116-126` (beginDistribution's gate comment) documents the design property: "onDistribute already flips `_status` to DISTRIBUTION_COMPLETE the instant availableUnits() hits zero, so a round that's fully sold but not yet formally closed via closeDistribution/setActive still reopens immediately, same as before (see testBeginDistributionAllowsNewRoundOnceThePreviousIsFullySold)." Reopening in that flow goes through onIssue — which the proposed gate (`INITIALIZED || ACTIVE`) would revert at DISTRIBUTION_COMPLETE.
2. `test/BondTrackerPublic.t.sol:99-117` `testBeginDistributionAllowsNewRoundOnceThePreviousIsFullySold`: calls `t.onIssue(custodian, 500)` at line 109 while `_status == DISTRIBUTION_COMPLETE` (set by `onDistribute(1000)` at line 106 → `src/BondTrackerPublic.sol:155-158`). The gate reverts this test.
3. `test/BondTrackerPublic.t.sol:182-200` `testBeginDistributionSucceedsAfterForceCompleteWithRemainder`: calls `t.onIssue(custodian, 500)` at line 196 while `_status == DISTRIBUTION_COMPLETE` (set by `forceCompleteDistribution()` at line 193 → `src/BondTrackerPublic.sol:166-173`). The gate reverts this test too.
4. The existing `FLAGGED FOR THE LEAD` comment (`test/BondTrackerPublic.t.sol:71-83`) already documents that onIssue's lack of a status gate was the deliberate counterweight to the `_status`-based beginDistribution gate — the two gates were designed as a pair in task #7. Gating onIssue alone flips that tradeoff and silently kills the "reopens immediately without close/setActive" property in point 1.

Also checked (per the lead's questions) and confirmed safe/clean:
- No OTHER path into onIssue exists: it is `external onlyOwner`, no internal callers anywhere in the contract (`src/BondTrackerPublic.sol:90`). Production caller is only BondTracker.onMint's PenteExternalCall (`src/BondTracker.sol`, onMint emit `onIssue(address,uint256)`), and the private-side gate there is INITIALIZED || ACTIVE, mirrored by the public side — so production reachability is fine.
- The legitimate-conflict paths above are the DISTRIBUTION_COMPLETE reopening paths only. Tests that run the full cycle to ACTIVE before re-issuing (`testTrancheIssuedEventNumbersAreOneIndexedAndSequential` :119, `testForceCompleteDistributionWritesOffStuckRemainder` :153) would pass the gate fine.

Decision needed from the lead (pick one):
- (a) Add the gate AND redefine the reopening contract: reopening now requires closeDistribution() + setActive() to reach ACTIVE first (update the two tests above + rewrite the :116-126 comment). This is a documented-design change, hence the stop.
- (b) Narrow the gate to also allow DISTRIBUTION_COMPLETE (e.g. `INITIALIZED || DISTRIBUTION_COMPLETE || ACTIVE`) — preserves today's reopening semantics exactly, still blocks the ISSUED/DISTRIBUTION_STARTED/DISTRIBUTION_CLOSED holes (the ones the FLAG comment at :71-83 identified as the actual bug).
- Recommendation: (b) — it fixes the flagged gap without changing any documented behavior.

## Item B — BACKLOG #5 (onCreateTransferLock missing _checkSaleAllowed): DONE

Diff summary, `src/BondTracker.sol`, inside `onCreateTransferLock` (function was :371-383, now :371-402):
- Inserted 16 lines after `_checkTransfers(sender, from, recipients);` (was line 380) and before `_locks.onLock(lockId, from, amount);`:
  - A comment block mirroring the file's style, pointing at the onPrepareUnlock mirror (Task #24) and the BACKLOG #5 rationale (dead path — zero createTransferLock usages — fixed for correctness of the abstract surface).
  - `if (_status == Status.DISTRIBUTION_STARTED && from == _custodian) { ... }` — quantity loop summing `recipients[i].amount` where `recipients[i].to != _custodian` (refund exclusion, same as onPrepareUnlock :349-356), then `_checkSaleAllowed(quantity);` (re-uses `from`, no re-lookup). Identical gate/loop/arithmetic to `onPrepareUnlock` (:339-360).

Diff summary, `test/BondTracker.t.sol`:
- 3 new tests inserted after `testOnCreateTransferLockToUnregisteredNonCustodianReverts` (was :539-553), before the onCreateMintLock section:
  1. `testOnCreateTransferLockFromCustodianDuringDistributionSucceeds` — positive: onMint 1000, beginDistribution(1,1), investor registered, onCreateTransferLock(custodian, lockId, custodian, 400, _one(investor1, 400)) must not revert; asserts prepare-only (balances unmoved, availableUnitsPrivate() == 1000).
  2. `testOnCreateTransferLockExceedingAvailableUnitsReverts` — negative: quantity 1001 > 1000 available; `vm.expectRevert(bytes("Sale would exceed this round's available units"))`; asserts nothing locked.
  3. `testOnCreateTransferLockInvalidDenominationReverts` — negative: beginDistribution(3,2), quantity 1 (1*3 % 2 != 0); `vm.expectRevert(bytes("Sale amount is not a valid denomination multiple"))`; asserts nothing locked.
- Reused existing helpers/conventions: `_one()`, `vm.prank`, `expectRevert(bytes)` overload already declared in the file's inline Vm interface (:15).

Existing tests verified unaffected: the 3 pre-existing onCreateTransferLock tests (:497, :520, :539) never call beginDistribution, so the new gate (DISTRIBUTION_STARTED only) does not fire for them — all still pass.

## forge results (verbatim, full suite from /home/ecs-user/alibaba-kube/Paladin/contracts)

- `forge build`: clean (exit 0; only pre-existing forge-lint unsafe-typecast notes).
- `Ran 5 test suites in 10.51ms (32.47ms CPU time): 111 tests passed, 0 failed, 0 skipped (111 total tests)`
- Per-suite (all "Suite result: ok. ... 0 failed"):
  - test/RestrictedAtom.t.sol: 19 passed; 0 failed
  - test/BondSeriesRegistry.t.sol: 12 passed; 0 failed
  - test/BondTrackerPublic.t.sol: 10 passed; 0 failed (unchanged file, confirms no collateral damage)
  - test/Agreement.t.sol: 30 passed; 0 failed
  - test/BondTracker.t.sol: 40 passed; 0 failed (was 37; +3 new)

## Tests added (Item B only)

- testOnCreateTransferLockFromCustodianDuringDistributionSucceeds
- testOnCreateTransferLockExceedingAvailableUnitsReverts
- testOnCreateTransferLockInvalidDenominationReverts

No tests added for Item A (blocked before implementation).

---

# Item A (resumed per D35): DONE

D35 approved option (b): gate onIssue on `INITIALIZED || DISTRIBUTION_COMPLETE || ACTIVE`. Item B files untouched during the resume (verified: the only edits below are in src/BondTrackerPublic.sol and test/BondTrackerPublic.t.sol).

## Diff summary

`src/BondTrackerPublic.sol` — in `onIssue` (function head now :90, previously :90):
- Inserted a lead-mandated comment block naming all 6 statuses with the D35 rationale per status (INITIALIZED / DISTRIBUTION_COMPLETE / ACTIVE allowed; ISSUED / DISTRIBUTION_STARTED / DISTRIBUTION_CLOSED rejected, each with the reason: nothing-sold-yet supply outside a round / actively-selling round = the pre-D35 hole where onIssue reset _status to ISSUED / D34 ordering requires close then setActive before mintTranche), plus the defense-in-depth framing (onlyOwner = privacy group's own address per client.ts deploy, only reachable via BondTracker.onMint's PenteExternalCall).
- Inserted the gate require as the first statement of onIssue (gate require spans :111-117; the revert string is `"Bond must be either unissued, fully sold out, or fully active to issue more supply"`).
- No 0-amount guard added (explicitly out of scope).

`test/BondTrackerPublic.t.sol`:
- 5 new tests appended after testStatusAndAvailableUnitsForGetDistributionState (new tests start :229, after the D35 section comment). Plain `vm.expectRevert()` used (this file's inline Vm interface has no expectRevert(bytes) overload, unlike BondTracker.t.sol; per instruction, used the existing convention).
- 1 pre-existing test adapted: `testTrancheIssuedEventNumbersAreOneIndexedAndSequential` (was :119-142, now :120-154) — it used to mint twice back-to-back, its second mint from ISSUED, which the D35 gate rejects BY DESIGN. That test was NOT in the protected list (:99-109 and :182+), and its own invariant (1-indexed sequential trancheCount) is orthogonal to the double-mint, so it now drives a full cycle (begin -> fully sold -> close -> setActive) between the 2nd and 3rd mints, with a comment noting why. This is the one deviation from the coordinator's test list and should be reviewed by the lead.

## Tests added (Item A)

Negatives (each drives to the named status, then expects revert):
1. testOnIssueRejectedAtIssued (onIssue twice back-to-back)
2. testOnIssueRejectedAtDistributionStarted (onIssue -> beginDistribution -> onIssue)
3. testOnIssueRejectedAtDistributionClosed (onIssue -> begin -> onDistribute(full) -> closeDistribution -> onIssue)
Positives:
4. testOnIssueSucceedsAtDistributionComplete (fully-sold round; asserts onIssue succeeds, _status becomes ISSUED, trancheCount == 2)
5. testOnIssueSucceedsAtActive (full cycle to ACTIVE; asserts _status ISSUED and _pendingTrancheAmount replaced — proven via the next round's distribution().totalUnits() == 500, not 1500)

Protected tests verified UNTOUCHED and passing: testBeginDistributionAllowsNewRoundOnceThePreviousIsFullySold (:99-117) and testBeginDistributionSucceedsAfterForceCompleteWithRemainder (:182-200).

## forge results (verbatim, full suite from /home/ecs-user/alibaba-kube/Paladin/contracts)

- `forge build`: exit 0 (only pre-existing forge-lint unsafe-typecast notes).
- `Ran 5 test suites in 9.07ms (30.76ms CPU time): 116 tests passed, 0 failed, 0 skipped (116 total tests)`
- Per-suite (all "Suite result: ok. ... 0 failed"):
  - test/BondSeriesRegistry.t.sol: 12 passed; 0 failed
  - test/BondTrackerPublic.t.sol: 15 passed; 0 failed (was 10; +5 new)
  - test/Agreement.t.sol: 30 passed; 0 failed
  - test/BondTracker.t.sol: 40 passed; 0 failed (Item B, unchanged this resume)
  - test/RestrictedAtom.t.sol: 19 passed; 0 failed
