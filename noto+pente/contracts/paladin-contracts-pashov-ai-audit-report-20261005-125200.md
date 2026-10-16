# 🔐 Security Review — RestrictedAtom / RestrictedAtomFactory (delta, task #3)

---

## Scope

|                                  |                                                        |
| -------------------------------- | ------------------------------------------------------ |
| **Mode**                         | delta — only the 3 changes made for task #3            |
| **Files reviewed**               | `RestrictedAtom.sol` · `RestrictedAtomFactory.sol`    |
| **Confidence threshold (1-100)** | 80                                                      |

3 specialty agents (access-control, asymmetry, execution-trace), model: sonnet, scoped to exactly the three deltas below rather than a from-scratch 12-agent pass (per the lead's "delta only" instruction). The full 12-agent pass from task #2 is unchanged and still applies to everything not listed here.

**Deltas reviewed:**
1. `cancel()` now also allows `executor`, not just `parties` (lead decision 5b / backend spec F5 — BI must be able to clean up a stuck trade).
2. `simulate()`'s access gate reclassified: it is a UX guard only, not a confidentiality boundary (correction below).
3. Switched from task #2's plain `new RestrictedAtom(...)` constructor deploy back to OpenZeppelin's `Initializable` + `Clones.clone()` + `ReentrancyGuardUpgradeable`, per the lead's "USE OPENZEPPELIN" decision. Dependency installed via npm (`Paladin/contracts/package.json`, pinned to the exact version upstream's own `solidity/package-lock.json` resolves to — 5.4.0 — not a floating `^5.1.0` range, so this fork tracks exactly what upstream itself builds against), **not** `forge install`: this workspace (`Paladin/`) must not become a git repository (a hard constraint from the start of this whole effort), and `forge install` defaults to git submodules.

---

## Correction withdrawn from the previous report

**"`simulate()`'s missing access control is a confidentiality leak" (previous report, finding 2, confidence 85) — the confidentiality framing was wrong, per the lead's review.** `eth_call`'s `from` field is not authenticated, so the party/executor check could always be bypassed for free by any caller. More fundamentally, `getOperations()` already exposes every operation's target+callData with no gate at all, so nothing simulate() reveals is reconstructible-but-gated — a caller can `eth_call` the target directly (`from` spoofed to the atom's own address) and get the identical result without touching this contract. 2 of the 3 delta agents independently confirmed this with a full adversarial trace (initialization-hijack-style reasoning applied to the gate itself) and found no other effect beyond "an honest caller's tooling fails fast with a named error instead of a generic one." The gate is **kept in the code** (cheap, harmless, occasionally useful UX), but is no longer claimed to protect anything.

---

## Findings

No findings at or above the confidence threshold for this delta. All three changes were adversarially tested and held up:
- `cancel()` + executor: the executor already held strictly greater power via `execute()` (executor-only, irreversible, moves funds); granting it `cancel()` too is a subset of power it already had, not a new escalation. Matches the "admin doing admin things within its documented trust model" exclusion.
- `simulate()`'s gate: verified harmless in both directions — no confidentiality property to lose (see correction above), and no way to abuse the gate itself (it never runs on a persisting state change; `simulate()` unconditionally reverts).
- `Initializable`/`Clones` pattern: both classic clone-pattern bugs — implementation-contract takeover and front-running a clone's own `initialize()` — were traced end-to-end by 2 of the 3 agents and closed. `constructor() { _disableInitializers(); }` permanently blocks `initialize()` on the `logic` contract; `Clones.clone(logic)` and `RestrictedAtom(instance).initialize(...)` execute in the same call frame of `RestrictedAtomFactory.create()` with no attacker-reachable code in between, so there is no interleaving window for a third party to initialize a fresh clone first.

---

## Leads

_Not scored — see the main report (task #2) for the full methodology note._

- **`cancel()` lacked `nonReentrant`, unlike `execute()`/`simulate()`** — `RestrictedAtom.cancel` — Code smells: the other two Pending-gated mutators both guard against reentrancy; `cancel()` relied on *their* internal ordering (execute() flips status before external calls; simulate() unconditionally reverts) to stay safe, rather than guarding itself. Not exploitable today — both of those invariants independently hold — but a landmine if either changes later. **Fixed**: added `nonReentrant` to `cancel()` for defense-in-depth, zero behavioral change, confirmed by re-running all 13 tests after the change (still 13/13 pass).
- **`execute()`'s NatSpec comment described `cancel()`'s access model, not `execute()`'s own** (copy-paste error introduced while writing the task-#3 changes) — `RestrictedAtom.execute` — a doc-only bug, but on a fund-moving function; left uncorrected it could mislead a future maintainer into loosening `execute()`'s actual executor-only gate to match the wrong comment. **Fixed**: comment corrected to describe `execute()`'s real, unchanged executor-only gate.
- **`simulate()`'s comment named the wrong mechanism for its own correction** (said "the two public getters" make the gate pointless; the agents found the more precise mechanism is `getOperations()` plus a separate `from`-spoofed `eth_call` directly at the target, not the getters alone) — **fixed**: comment tightened to name the actual reconstruction path.

---

## Test results

`forge test` after all task #3 changes (OpenZeppelin migration, executor-can-cancel, simulate access-control reclassification + comment fixes, `cancel()` reentrancy guard): **13/13 PASS** (1 test replaced: `testExecutorCannotCancel` → `testExecutorCanCancel`, per the corrected access model; all others unchanged and still passing).
