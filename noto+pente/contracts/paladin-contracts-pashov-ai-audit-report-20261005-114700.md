# 🔐 Security Review — RestrictedAtom / RestrictedAtomFactory

---

## Scope

|                                  |                                                        |
| -------------------------------- | ------------------------------------------------------ |
| **Mode**                         | explicit path: `/home/ecs-user/alibaba-kube/Paladin/contracts/src` |
| **Files reviewed**               | `RestrictedAtom.sol` · `RestrictedAtomFactory.sol`    |
| **Confidence threshold (1-100)** | 80                                                      |

12 specialty agents (math-precision, access-control, economic-security, execution-trace, invariant, periphery, first-principles, asymmetry, boundary, numerical-gap, trust-gap, flow-gap), model: sonnet.

**Note:** findings 1 and 2 below were fixed in-tree during this review (see "Status" on each) and re-verified with new unit tests before this report was finalized — not merely diagnosed.

Completeness: 8 unique (Contract, function, bug-class) groups identified across the 12 raw agent passes, 8 covered in this report (3 as scored findings, 5 as leads).

---

## Findings

[90] **1. `execute()`/`simulate()` treated a low-level call to a codeless address, or one that returns `false` instead of reverting, as a successful settlement leg**

`RestrictedAtom.execute` / `RestrictedAtom.simulate` · Confidence: 90

**Description**

Upstream `Atom.sol` routes every call through OpenZeppelin's `Address.functionCall`, which reverts if the target has no deployed code; this fork's bare `op.contractAddress.call(op.callData)` dropped that check to avoid the OpenZeppelin dependency (a real regression introduced by the fork, not inherited), and upstream never checked for a `false`-instead-of-revert return either — so a leg whose target is a wrong/not-yet-deployed address, or a legacy ERC20-style function that signals failure by returning `false`, silently "succeeds" while a genuine counterparty leg in the same atom actually moves value, with `status` left permanently `Executed` and no recourse (`cancel()` requires `Pending`). 4 independent agents (boundary, economic-security, flow-gap, trust-gap) reached this with concrete traces.

**Status: FIXED.** `_effectiveSuccess()` now requires `target.code.length > 0` and, when the call returns exactly one word, requires it decodes to `true`. `execute()` reverts (`TargetHasNoCode`/`OperationReturnedFalse`) instead of silently continuing; `simulate()`'s reported `success` now reflects the same stricter rule. New tests: `testExecuteRevertsOnCodelessTarget`, `testExecuteRevertsOnFalseReturn`, `testExecuteSucceedsOnTrueReturn` (all pass).

**Fix**

```diff
+    error TargetHasNoCode(address target);
+    error OperationReturnedFalse(uint256 index);
+
+    function _effectiveSuccess(address target, bool ok, bytes memory ret) private view returns (bool) {
+        if (!ok) return false;
+        if (target.code.length == 0) return false;
+        if (ret.length == 32) return abi.decode(ret, (bool));
+        return true;
+    }
     for (uint256 i = 0; i < _operations.length; i++) {
         Operation storage op = _operations[i];
         (bool ok, bytes memory ret) = op.contractAddress.call(op.callData);
         if (!ok) {
             ... // unchanged revert-bubbling
         }
+        if (op.contractAddress.code.length == 0) {
+            revert TargetHasNoCode(op.contractAddress);
+        }
+        if (ret.length == 32 && !abi.decode(ret, (bool))) {
+            revert OperationReturnedFalse(i);
+        }
     }
```

---

[85] **2. `simulate()` had no access control, unlike `execute()`/`cancel()`**

`RestrictedAtom.simulate` · Confidence: 85

**Description**

The fork's whole point is restricting who can touch a pending multi-bank atom — `execute()` is gated to `executor`, `cancel()` to `_parties` — but `simulate()` runs the exact same real external calls to the exact same leg contracts and was left open to any address. Since the function always reverts at the end, nothing it does persists on-chain, but the real `returnData`/success of every leg is still handed back to the caller (free, repeatable, via a plain `eth_call`) — a confidentiality leak on a settlement system where legs likely represent bank balances/positions. Found independently by the asymmetry agent with a full proof (direct `eth_call`, no tx needed).

**Status: FIXED.** `simulate()` now requires `msg.sender == executor || _isParty(msg.sender)`, same as the other two entry points. New tests: `testSimulateRejectsNonParty`, `testSimulateAllowsParty`, `testSimulateAllowsExecutor` (all pass, distinguishing "rejected before running" from "ran, then always-reverts" by checking the revert's error selector).

**Fix**

```diff
     function simulate() external nonReentrant returns (OperationResult[] memory results) {
         if (status != Status.Pending) {
             revert AtomNotPending();
         }
+        if (msg.sender != executor && !_isParty(msg.sender)) {
+            revert NotAParty(msg.sender);
+        }
```

---

[75] **3. `RestrictedAtomFactory.create()` has no access control, letting any caller name arbitrary `parties`/`executor`**

`RestrictedAtomFactory.create` · Confidence: 75

**Description**

5 agents (access-control, economic-security, execution-trace, periphery, first-principles) independently flagged that `create()` is fully permissionless and passes `parties`/`executor` straight through with no checks — any address can deploy a `RestrictedAtom` naming real banks as `parties` and itself as `executor`, or naming a legitimate executor (BI) while supplying a bogus operation list. Whether this is exploitable depends on an off-chain trust assumption none of the 12 agents could verify from these two files alone: does BI's executor service ever call `execute()` on an atom it did not itself create via `create()`? If BI only ever executes atoms it deployed itself (consistent with the design direction already discussed — "BI creates the Atom after verifying"), this has no reachable victim. If any future code path lets BI discover and execute an atom from an `AtomDeployed` event without checking provenance, this becomes a live confused-deputy / decoy-atom risk. Gated at confidence 75 (multi-agent convergence, partial/unverified exploit chain) rather than higher, and left **unfixed** — restricting `create()` is a design decision (who may propose a trade at all: any bank? only BI?) outside this task's explicit ask ("implement access control for cancel/execute"), and is carried into the Part B design doc instead of being decided unilaterally here.

---

## Findings List

| # | Confidence | Title |
|---|---|---|
| 1 | [90] | Unchecked low-level call result lets a leg silently no-op (codeless target / false return) — **fixed** |
| 2 | [85] | `simulate()` missing access control — **fixed** |
| 3 | [75] | `RestrictedAtomFactory.create()` unrestricted — **not fixed, design decision deferred to Part B** |

---

## Leads

_Vulnerability trails with concrete code smells where the full exploit path could not be completed in one analysis pass. These are not false positives — they are high-signal leads for manual review. Not scored._

- **Constructor accepts an unvalidated `parties`/`executor`** — `RestrictedAtom.constructor` — Code smells: no `parties.length > 0` or `executor_ != address(0)` check; an atom created with either left at its zero value is permanently stuck `Pending` (no cancel, no execute, no sweep). 4 agents converged (invariant, boundary, first-principles, access-control). Gated as self-harm-only (the caller of `create()` bricks their own atom; no attacker-distinct victim demonstrated), so not promoted to a finding — but cheap to guard defensively.
- **`cancel()` has no `nonReentrant` guard** — `RestrictedAtom.cancel` — Code smells: `execute()`/`simulate()` both carry `nonReentrant`, `cancel()` doesn't, even though it's reachable (with `status` still `Pending`) from inside `simulate()`'s external-call loop if an operation's target calls back in. 3 agents converged (execution-trace, invariant, access-control). Currently inert — `simulate()`'s unconditional trailing `revert ExecutionResult(...)` unwinds any such nested write — so this is a landmine for a future change to `simulate()`'s always-revert behavior, not a live exploit today. Cheap to add defensively.
- **`simulate()`'s reported per-leg results can diverge from what `execute()` would actually do** — `RestrictedAtom.simulate` — Code smells: `simulate()` never stops at the first failing leg (it records every leg's outcome and only reverts once, at the end), while `execute()` reverts the whole atom the instant any single leg fails; a caller using `simulate()`'s output to decide whether to call `execute()` could be misled about what partial state would actually result. Decision-quality risk for the executor's own tooling, not a third-party exploit — not promoted.
- **No fund-rescue path once `status` leaves `Pending`** — `RestrictedAtom.execute` / `cancel` — Code smells: neither function nor any other in the contract can act once `Executed`/`Cancelled`; any token pushed directly to the atom's own address (rather than pulled via a pre-granted allowance/lock, which is how the current Noto-based callers work) before cancellation would be permanently stranded. Not demonstrated reachable from in-scope code alone.
- **`parties` is never checked against which addresses the `operations` actually move funds for** — `RestrictedAtom.cancel` / `RestrictedAtomFactory.create` — Code smells: the two arrays (`_operations`, `_parties`) are independently supplied with no on-chain link; a bank with a genuine leg in the deal could be left out of `_parties` (accidentally or by a malicious proposer, given finding 3), leaving it unable to `cancel()` an atom that does move its funds. Requires visibility into the off-chain allowance/lock-granting sequence that is out of scope for these two files.
