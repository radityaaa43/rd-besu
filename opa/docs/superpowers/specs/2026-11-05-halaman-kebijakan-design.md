# Halaman Kebijakan: editing off-chain policy (OPA) in Lensa — design

Date: 2026-11-05. Status: draft for approval.
Scope: Besu track, Zeto model first. Off-chain policy only (the OPA gateway in `besu/opa/`).
Mockup (approved by the user): https://claude.ai/artifact/F7AYzEZBgJS2BY5v5Eurv6
Doc language: English. Every string shown to users is Indonesian and quoted verbatim.

## 1. Intent

BI sets policy for the whole network; each bank sets policy for itself only (the user's words: "BI mengatur policy
untuk semua yang ada di jaringan, masing-masing bank mengatur policy masing-masing bank nya, contoh limit harian").
Today those rules live in `besu/opa/bundles/*/…/data.json` and change only by editing files and redeploying.
This adds a **"Kebijakan"** screen to Lensa where BI and each bank view and change their own parameters, every change
goes through a second person (maker-checker, the user's explicit choice), and an approved change reaches the gateways.

The split of who sets what follows BI's own Proyek Garuda PoC report (Dec 2024, §3.1.2 "System Policy"): limits set by
BI as regulator apply to every participant; limits a participant sets apply to itself and may not be looser than BI's;
BI also freezes/unfreezes participants ("Fitur Administrasi"). BIS CPMI (wholesale tokens, Q1) adds operating hours.

## 2. Goals

1. BI edits network policy: per-token limits, per-token operating hours, BI holiday dates, participant freeze.
2. Each bank edits its own policy: per-token per-tx limit, per-token **daily** limit, counterparty whitelist,
   per-token operating hours (narrower than BI only).
3. Maker-checker on every change: the maker submits with a reason, a different person of the same party approves or
   rejects; nothing changes on the gateways before approval.
4. Every version is kept with maker, checker, time, reason, old and new values; rollback is a new draft (same approval).
5. The screen shows which version each gateway is actually running, so "approved" never silently means "not applied".

## 3. Non-goals (this round)

- On-chain policy (contracts, Besu permissioning). Shown on screen as "Belum tersedia".
- Balance caps (saldo maksimal/minimal) and total-circulation limit: Zeto seals other parties' balances and the total
  supply, so an off-chain gateway cannot evaluate them. They stay listed as "Belum tersedia di Zeto (off-chain)".
- Rules for Noto, Pente and Stealth. They keep passing the gateway unscoped (current Rego).
- Real login/authentication, and one Lensa instance per institution (see §9 for what production needs).
- Signed bundles (research cluster: writing the ConfigMap already needs cluster-admin). Listed in §9.

## 4. Anti-goals (would be a failure even if it works)

- A change shows as active while a gateway still runs the old version.
- Any path that changes a gateway's policy without a second person's approval.
- A bank seeing another bank's policy, or a bank editing BI's.
- A bank's own setting loosening a BI rule.
- Network traffic depending on BI being online (requirement R2): publishing needs BI's Lensa, enforcing never does.

## 5. Parameters (decided with the user)

### 5.1 BI document (`bi`, applies to every gateway)

| Parameter | Shape | Enforced how |
|---|---|---|
| Max transfer per tx, per token | `zeto.max_per_tx.{RD,DFABI}` int | exists today; sum of outputs of `transfer` / `createLock` |
| Max issuance per tx, per token | `zeto.max_mint_per_tx.{RD,DFABI}` int | new; sum of `mints` on `mint` |
| Operating hours, per token | `hours.{RD,DFABI} = {days:[1..7], open:"HH:MM", close:"HH:MM"}` | new; WIB; `close` exclusive |
| Holidays | `holidays = [{date:"YYYY-MM-DD", name}]` | new; every token closed all day |
| Frozen participants | `frozen = ["bankC@node4", …]` | new |
| Participants | `participants` (exists) | onboarding/off-boarding stays a file edit this round |

### 5.2 Bank document (`bank-a`, … applies to that bank's gateway only)

| Parameter | Shape | Enforced how |
|---|---|---|
| Max per tx, per token | `max_per_tx.{RD,DFABI}` int, optional | ≤ BI value; both rules apply (AND) |
| Daily outgoing limit, per token | `daily_limit.{RD,DFABI}` int, optional | new; see §6.3 |
| Counterparty whitelist | `counterparties` (exists) | exists today |
| Operating hours, per token | same shape as BI, optional (absent = follow BI) | must lie inside BI's window; both apply |

Units: RD in whole rupiah (decimals 0), DFABI in units, as in `frontend/server/src/domain.ts`.

Hours: `close` may be `"24:00"` (end of day), so a full day is `00:00`–`24:00`. Windows never cross midnight
(`open < close`); wholesale settlement has no overnight window, so this is not needed. *(writer's call)*

### 5.3 What Lensa owns, and the version 1 seeds *(writer's call)*

Lensa versions hold **only the editable keys** above. Structural keys (`nodes`, `participants`, `paladin.read_methods`,
`atom.factories`, Zeto contract addresses) stay in git under `besu/opa/bundles/`. A bundle is always built as: the repo's
bundle source, with the editable keys overlaid from the Lensa version. A later git edit to `participants` is therefore
never overwritten by an older Lensa snapshot.

Version 1 keeps today's behaviour, so nothing that works now (Lensa flows, TPS stress, e2e) starts failing:

| Owner | Seed |
|---|---|
| `bi` | `max_per_tx` as today (RD 1.000.000.000, DFABI 1.000); `max_mint_per_tx` = `MAX_AMOUNT` (10^15, no practical cap); hours RD and DFABI 00:00–24:00 every day; no holidays; nothing frozen |
| `bank-a` | counterparties as today; no per-tx, daily limit or hours (follow BI) |
| `bank-b`, `bank-c` | new bundles like `bank-a`; counterparties = every other participant; nothing else |
| `bank-bi` | new: BI's own bank bundle for node1's gateway (allow-all), because `gw.allow` needs `data.bank.paladin.allow` |

BI then sets real hours, holidays and limits through the screen, with approval, like any other change.

## 6. Enforcement rules (Rego, `besu/opa/bundles/`)

### 6.1 Time

WIB is a fixed UTC+7 with no DST, so the Rego computes local time as `time.now_ns() + 7h` read in UTC instead of
relying on tz data in the OPA image. Tests pin time with `with time.now_ns as …`.

A token is **open** when the local weekday is in `days`, the date is not in `holidays`, and `open ≤ now < close`.
A bank window applies on top of BI's (both must be open).

### 6.2 Which operations are gated (decided with the user)

| Operation | Hours | Frozen | Limits |
|---|---|---|---|
| `mint` | token open | recipient not frozen | `max_mint_per_tx` |
| `transfer` | token open | sender's node and every recipient not frozen | per-tx (BI and bank), daily (bank) |
| `createLock` (DvP leg) | **both RD and DFABI open** | same as transfer | per-tx, daily |
| `spendLock`, `delegateLock`, `cancelLock`, Atom `create` | always allowed | always allowed | none |
| Atom `execute` / `cancel` | always allowed | always allowed | none |

Finishing or unwinding a DvP that already started is never blocked, so no funds stay locked overnight.
Atom `create` is allowed always because it carries no amount; the locks it references were gated when created.

"Sender's node frozen" is checked by the frozen bank's own gateway (its `node.identities`); every other gateway blocks
transfers *to* a frozen bank. Freezing is itself a BI change and goes through approval.

### 6.3 Daily limit

OPA keeps no state, and Zeto hides amounts on chain. The bank's gateway therefore asks **its own Paladin node** for the
day's outgoing total before deciding: one `http.send` (no cache, short timeout) to `paladin-nodeN:8548`
`ptx_queryTransactionsFull` filtered on `from` = the node's identity, `domain = zeto`, `created ≥ today 00:00 WIB`,
then sums the amounts of `transfer` and `createLock` per token contract, plus the request's own amount.

- Fails closed: Paladin unreachable, a non-200 reply, or a full page (more rows than the page size) → deny.
- Known ceiling: two requests in the same instant can both pass (no lock). Accepted for this round; noted in the UI hint.
- Counted on submit, not on success (failed txs still count). Conservative on purpose.
- Only value leaving the bank counts: `ptx_sendTransaction` of `transfer` and `createLock`. `ptx_prepareTransaction`
  (`spendLock`) does not count, its lock was counted when created. A lock later cancelled still counts. A request the
  gateway allowed that never reached Paladin is naturally not counted. *(writer's call)*
- The Lensa server runs the same query to show "Terpakai hari ini" on the bank screen.
- **Builder must verify** that Paladin v1.0.0 query JSON supports `greaterThan` on `created` and returns `data` in
  `ptx_queryTransactionsFull`, against node2, before relying on it. If not, stop and bring it back (do not invent a
  workaround that keeps state in the gateway).

**Verified 2026-11-05 against node2 and node3 (read-only, via the Lensa forwards):**

- Working query: `ptx_queryTransactionsFull` with
  `{"limit":1000,"eq":[{"field":"domain","value":"zeto"}],"greaterThan":[{"field":"created","value":"<today 00:00 WIB as UTC RFC3339, e.g. 2026-11-04T17:00:00Z>"}]}`.
- A node returns only the transactions it submitted (every `from` ends in that node), so **no `from` filter**: the
  daily total covers every identity of the bank's node.
- `function` holds the full ABI signature (`transfer((string,uint256,bytes)[])`,
  `createLock(string,(string,uint256,bytes)[],bytes,bytes)`); match on the name before `(`. Amounts are strings.
- A bank's node submits from several identities (`bankA@node2`, `stress-n2-00@node2` … for the TPS stress test,
  `investor2@node2`). Identity rules are therefore node-scoped: a bank is its node, and `participants`, `frozen` and
  `counterparties` entries are compared by their node part. *(controller ruling during implementation)*

### 6.4 Automatic checks before a draft can be submitted

`opa test` covers the logic and must not depend on live values: move the existing tests to fixture data
(`with data.bi.config as …`). Draft values are checked by a Rego validator (`bi.check.errors`, `bank.check.errors`)
evaluated with `opa eval` against the draft plus the current BI document:

- every number a positive integer; times `HH:MM`; `open < close`; dates valid and unique; days in 1..7
- bank per-tx ≤ BI per-tx; bank hours inside BI hours; counterparties ⊆ participants
- frozen ⊆ participants, and BI cannot freeze itself

A BI change that lowers a limit below some bank's own value is allowed (BI wins at runtime); the draft screen lists the
banks whose setting becomes inactive. The check list shown in the mockup ("Uji kebijakan otomatis: 54 dari 54 lolos")
is the `opa test` result of the bundle code plus the validator result for the draft.

## 7. Lensa: storage, workflow, publishing

### 7.1 Who is who (research setup)

Lensa has no login. The party pill (`PartySwitcher`) is the acting party, and the user types a display name once
("Masuk sebagai"), kept in `localStorage`. The server records names as given. Maker ≠ checker compares names. This is
enough to demonstrate the flow and is clearly not access control (§9).

Scoping is enforced server-side by owner: party BI may write only `bi`; bank party X only `bank-x`. BI may read every
bank document (R1: BI sees everything); a bank reads `bi` and its own document only.

### 7.2 Storage

Files under the existing Lensa state dir (`frontend/server/state/policy/`, created 0700 like `writeState`):
`<owner>/v<N>.json` (immutable published versions, with maker, checker, times, reason), `<owner>/pending.json`
(at most one pending change per owner), `<owner>/audit.jsonl` (append-only: submitted, approved, rejected, cancelled,
published, publish-failed). Version 1 of each owner is seeded from the current `data.json`.

A pending draft records the version it was based on. If another change publishes first, approving the stale draft is
refused ("Kebijakan sudah berubah sejak draf ini dibuat. Buat draf baru.").

### 7.3 Publishing to the gateways

Gateways run in the cluster, Lensa on the host at 127.0.0.1, so OPA cannot poll Lensa. On approval the server:

1. copies the bundle source, writes the new `data.json`, runs `opa build --revision <owner>-v<N>`;
2. for each affected gateway (BI change: all four; bank change: that bank's), replaces ConfigMap
   `bank-gw-N-bundles` (both tarballs) with `kubectl apply`, and sets pod-template annotations
   `policy.lensa/bi` and `policy.lensa/bank` to the revisions, which rolls the Deployment (old pod serves until the
   new one is Ready);
3. waits for each rollout (timeout 120 s); a gateway counts as running version N only when its ready pod carries the
   annotation;
4. on a failed or timed-out rollout, re-applies that gateway's **previous ConfigMap content and annotations** (kept
   with version N−1; `kubectl rollout undo` alone would not restore the ConfigMap, and a restarted pod would load the
   new bundle), and records `publish-failed`; the status card then shows e.g. "3 dari 4" and a retry button
   ("Terbitkan ulang").

The gateway Deployment keeps `RollingUpdate` (`maxSurge 1, maxUnavailable 0`), so it never goes down during a publish;
the price is one extra pod slot for a few seconds. If the cluster has no free slot, the rollout times out and becomes
`publish-failed` with the old version still serving. *(writer's call: no outage beats a guaranteed publish)*

Publishing writes to the live cluster with the kubeconfig Lensa already uses. All kubectl calls sit behind one module
so tests run against a fake; the first live publish happens only in §8 step 5.

If no gateway is deployed yet (today), approval still creates version N and the card says
"Belum diterapkan: gateway belum terpasang". This lets the UI and Rego be built and tested before the live dry-run.

The `opa` binary is the pinned static release v1.21.1 (same version as the gateway image), installed at
`~/.local/bin/opa` after checking its published sha256; its path goes in Lensa's env (`~/.config/lensa/lensa.env`,
`OPA_BIN`), like `KUBECONFIG` today. Docker is not used for it: the server calls it per draft and tests call it too.
*(writer's call)*

### 7.4 Screen

Where it shows *(writer's call)*: the route is `/besu/zeto/kebijakan`. On Noto and Stealth the sidebar item is
disabled with the reason "Kebijakan saat ini hanya untuk Zeto"; on Fabric-X and Iroha 3 with "Belum tersedia di
platform ini", following the existing `reasonOf` pattern.

As in the mockup: sidebar item "Kebijakan" in the "Alat" group, header with the party pills, three
status cards ("Versi berlaku", "Gateway memakai versi ini", "Menunggu persetujuan"), tabs "Kebijakan berlaku",
"Ubah kebijakan", "Persetujuan", "Riwayat versi". Follows `frontend/DESIGN.md` v2.1 tokens and rules (sealed vs empty,
no new npm dependency, native controls). "Ubah kebijakan" edits every parameter of the acting party's document in one
form; the diff in "Persetujuan" lists only changed values.

## 8. Order of work and dependencies

1. Rego: fixtures for existing tests; time, holidays, frozen, mint limit, bank per-tx/hours; validators. `opa test`.
2. Rego: daily limit via `http.send` (after the §6.3 verification on node2, read-only RPC).
3. Lensa server: policy store, endpoints, validation via `opa eval`, approval flow, publish (with "no gateway" mode).
4. Lensa web: the screen. Built and e2e-tested outside the main checkout (Lensa rule: never build `web/dist` where
   `lensa.service` serves it); deployed with `frontend/deploy/update.sh`.
5. Live: needs the user's separate approval of the node2 dry-run (step 2 of `besu/opa/README.md`), then publishing
   to that gateway.

Plan: `besu/opa/docs/superpowers/plans/2026-11-05-halaman-kebijakan.md`.

## 9. Production gaps (stated, not built)

Real authentication and per-person roles (maker, checker) per institution; one policy admin per institution so a bank's
policy never passes through BI's systems; signed bundles (`opa build --signing-key`, OPA `verification-key` per owner);
each owner's own bundle server with `persist: true`; an atomic daily-limit counter if the race in §6.3 matters.

## 10. Left to the builder

Endpoint names and payload shapes; component split in `web/src/screens/`; exact page size and timeout for the §6.3
query; how the "Masuk sebagai" name is entered; how many holidays the BI form shows before "+ N tanggal lain".
