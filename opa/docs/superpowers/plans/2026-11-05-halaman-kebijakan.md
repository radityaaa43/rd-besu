# Halaman Kebijakan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** BI and each bank view and change their off-chain (OPA) policy in a new Lensa "Kebijakan" screen, with maker-checker approval, version history, and publishing to the gateways.

**Architecture:** Rego in `besu/opa/` gains hours, holidays, freeze, mint and bank limits, a daily limit (via the bank's own Paladin node) and draft validators. The Lensa server (`frontend/server/src/policy/`) stores versions as files, validates drafts with the `opa` binary, and publishes approved versions as gateway ConfigMaps plus a rolling restart. The web app adds the screen (`frontend/web/src/screens/Policy.tsx`).

**Tech Stack:** OPA/Rego v1 (`opa` 1.21.1), Node 22 + Fastify 5 + vitest (server), React 18 + vitest + Playwright (web), kubectl.

**Spec:** `besu/opa/docs/superpowers/specs/2026-11-05-halaman-kebijakan-design.md` (approved 2026-11-05). Mockup: https://claude.ai/artifact/F7AYzEZBgJS2BY5v5Eurv6

## Global Constraints

- `opa` is v1.21.1 static, at `~/.local/bin/opa` (sha256-checked); the server reads it from env `OPA_BIN`. Tests that need it are skipped (and reported as skipped) when `OPA_BIN` is unset, never silently passed.
- No new npm dependency (DESIGN.md §1.7). Native controls. DESIGN.md v2.1 tokens.
- Every user-facing string is Indonesian; strings quoted in the spec are used verbatim.
- WIB = fixed UTC+7, no tz data. Days are ints 1..7, Monday = 1. Times `HH:MM`, `close` exclusive, `"24:00"` allowed, no overnight windows.
- Amounts are JSON integers, `0 < n ≤ 10^15` (`MAX_AMOUNT` in `frontend/server/src/domain.ts`). RD whole rupiah, DFABI units.
- Editable keys live only in Lensa; structural keys stay in git (spec §5.3). Version 1 = `besu/opa/seeds/*.json` and keeps today's behaviour.
- Never write `frontend/web/dist` in the main checkout and never run `npm run e2e -w web` there (`lensa.service` serves it). Web build and e2e run in a worktree.
- No cluster writes in any task. Task 9 runs one read-only RPC against node2. Live publishing is spec §8 step 5 and needs the user's separate approval.
- Commits only when the user says so (user rule). Each task's last step lists the files to commit.

## Review Focus

1. **Same person, two spellings.** A maker approving as " rina " after submitting as "Rina" must be refused → Task 6 `approve rejects maker under another spelling`.
2. **Double-click on "Setujui dan terbitkan".** Two approvals of one pending change must not publish twice or skip a version → Task 6 `concurrent approvals publish once`.
3. **Server restarts mid-publish.** A pending change left in "publishing" must come back as `publish-failed` with "Terbitkan ulang" available → Task 7 `restart marks interrupted publish failed`.
4. **Indonesian number input.** "2.000.000.000" parses to 2000000000; "2,5", "-1", "0", "1e3" and a value over 10^15 are rejected with a message → Task 11 `parseAmount`.
5. **WIB day boundaries.** 16:59:59 UTC is still the previous WIB day and 17:00 UTC rolls it; exactly `close` is closed; a holiday matches the WIB date, not the UTC date → Task 2 tests.

---

## File map

```
besu/opa/
  bundles/bi/bi/config/data.json      structural only (editable keys move to seeds/bi.json); + nodes.nodeN.paladin_url
  bundles/bi/bi/clock/clock.rego      NEW package bi.clock
  bundles/bi/bi/zeto/zeto.rego        hours, freeze, mint cap
  bundles/bi/bi/check/check.rego      NEW package bi.check
  bundles/bank/                       RENAMED from bundles/bank-a (code only, no data)
  bundles/bank/bank/paladin/paladin.rego   per-tx, hours, daily limit
  bundles/bank/bank/check/check.rego  NEW package bank.check
  seeds/{bi,bank-a,bank-b,bank-c,bank-bi}.json   NEW: version 1 of each editable document
  test/fixtures.rego                  NEW package fixtures
  test/gw/gw_test.rego, test/clock/clock_test.rego, test/check/check_test.rego
frontend/server/src/policy/{types,store,opa,workflow,kube,publish,routes,usage}.ts
frontend/server/src/cli/policy-build.ts
frontend/server/test/policy-*.test.ts
frontend/web/src/app/{route,Sidebar}.ts(x), App.tsx, api.ts
frontend/web/src/screens/Policy.tsx
frontend/web/src/policy/{PolicyView,DraftForm,Approval,VersionHistory}.tsx, form.ts, form.test.ts
frontend/web/e2e/policy.spec.ts
```

Shared names used across tasks:

```ts
// frontend/server/src/policy/types.ts
export type Token = 'RD' | 'DFABI';
export type Owner = 'bi' | 'bank-a' | 'bank-b' | 'bank-c';            // editable documents
export interface Hours { days: number[]; open: string; close: string }
export interface BiPolicy { max_per_tx: Record<Token, number>; max_mint_per_tx: Record<Token, number>;
  hours: Record<Token, Hours>; holidays: { date: string; name: string }[]; frozen: string[] }
export interface BankPolicy { counterparties: string[]; max_per_tx?: Partial<Record<Token, number>>;
  daily_limit?: Partial<Record<Token, number>>; hours?: Partial<Record<Token, Hours>> }
export type PolicyDoc = BiPolicy | BankPolicy;
export interface Version { owner: Owner; n: number; doc: PolicyDoc; maker: string; checker: string; reason: string;
  note: string; submittedAt: string; approvedAt: string }
export interface Checks { errors: string[]; tests: { passed: number; total: number }; inactiveBanks: string[] }
export interface Pending { owner: Owner; base: number; doc: PolicyDoc; maker: string; reason: string; submittedAt: string;
  state: 'waiting' | 'publishing' | 'publish-failed'; checks: Checks }
export interface GatewayStatus { node: 1 | 2 | 3 | 4; deployed: boolean; bi: number | null; bank: number | null; ready: boolean }
export class PolicyError extends Error { constructor(readonly status: 400 | 403 | 409 | 422 | 501 | 502, reason: string, readonly errors?: string[]) }
export const OWNER_OF_PARTY = { BI: 'bi', A: 'bank-a', B: 'bank-b', C: 'bank-c' } as const;
export const BANK_BUNDLE_OF_NODE = { 1: 'bank-bi', 2: 'bank-a', 3: 'bank-b', 4: 'bank-c' } as const;
```

In the BI document the two limits sit under `zeto` in Rego (`data.bi.config.zeto.max_per_tx`); `Opa.assemble` maps
`BiPolicy.max_per_tx` / `max_mint_per_tx` there and the other editable keys (`hours`, `holidays`, `frozen`) to the top
of `data.bi.config`. `data.bank.config` is the bank document as is.

---

### Task 1: Tests on fixtures, seeds, single bank bundle

Behaviour does not change; this frees the tests from live values and introduces the seeds.

**Files:**
- Create: `besu/opa/test/fixtures.rego`, `besu/opa/seeds/{bi,bank-a,bank-b,bank-c,bank-bi}.json`
- Move: `besu/opa/bundles/bank-a/` → `besu/opa/bundles/bank/` (its `bank/config/data.json` moves to `seeds/bank-a.json`)
- Modify: `besu/opa/bundles/bi/bi/config/data.json` (remove `zeto.max_per_tx`; add `nodes.nodeN.paladin_url` = `http://paladin-nodeN.paladin.svc.cluster.local:8548`), `besu/opa/test/gw/gw_test.rego`, `besu/opa/README.md` (layout), `besu/opa/k8s/bank-gw-2.yaml` (strategy `RollingUpdate`, `maxSurge: 1`, `maxUnavailable: 0`)

**Interfaces:**
- Produces: `data.fixtures.bi` (complete `bi.config`: today's structural keys + seed values) and `data.fixtures.bank_a`; tests evaluate through one helper `allowed(i) if gw.allow with input as i with data.bi.config as fixtures.bi with data.bank.config as fixtures.bank_a`, and tests that need other values override with `object.union`.
- Seeds (spec §5.3): `seeds/bi.json` = `{"max_per_tx":{"RD":1000000000,"DFABI":1000},"max_mint_per_tx":{"RD":1000000000000000,"DFABI":1000000000000000},"hours":{"RD":{"days":[1,2,3,4,5,6,7],"open":"00:00","close":"24:00"},"DFABI":{"days":[1,2,3,4,5,6,7],"open":"00:00","close":"24:00"}},"holidays":[],"frozen":[]}`; `bank-a.json` = today's counterparties; `bank-b.json` / `bank-c.json` / `bank-bi.json` = `{"counterparties":[every participant except the bank's own identity]}`.

- [ ] **Step 1:** Rewrite `gw_test.rego` on `allowed(i)`; write `fixtures.rego`.
- [ ] **Step 2:** `opa test bundles/bi bundles/bank-a test` → FAIL (`bundles/bank` paths and fixture keys do not exist yet).
- [ ] **Step 3:** Move the bank bundle, write the seeds, trim `bi/config/data.json`.
- [ ] **Step 4:** `opa check --strict bundles/bi bundles/bank test && opa test bundles/bi bundles/bank test && regal lint bundles test` → `PASS: 54/54`, no lint findings.
- [ ] **Step 5:** Commit `besu/opa/`.

### Task 2: Clock and operating hours

**Files:**
- Create: `besu/opa/bundles/bi/bi/clock/clock.rego`, `besu/opa/test/clock/clock_test.rego`
- Modify: `besu/opa/bundles/bi/bi/zeto/zeto.rego`, `besu/opa/bundles/bank/bank/paladin/paladin.rego`, `besu/opa/test/gw/gw_test.rego`

**Interfaces:**
- Produces (package `bi.clock`): `local_ns := time.now_ns() + 25200000000000`; `today` (WIB `"YYYY-MM-DD"`); `open(hours)` true when the WIB weekday int ∈ `hours.days`, `today` is not a `data.bi.config.holidays[_].date`, and `hours.open ≤ "HH:MM" < hours.close` (string compare, so `"24:00"` works); `token_open(token) := open(data.bi.config.hours[token])`.
- Gating per spec §6.2: `mint`, `transfer` need `token_open(token)`; `createLock` needs both `token_open("RD")` and `token_open("DFABI")`; `spendLock`, `delegateLock`, `cancelLock` and the Atom rules stay ungated. Bank: when `data.bank.config.hours[token]` exists it must also be `open`.

- [ ] **Step 1: Failing tests** (`with time.now_ns as …`; hours RD Mon–Fri 06:30–18:00, DFABI 08:00–16:00, holiday `2026-12-25`):
  - `test_today_rolls_at_1700_utc`: 2026-11-05T16:59:59Z → `"2026-11-05"`; 2026-11-05T17:00:00Z → `"2026-11-06"`.
  - `test_close_is_exclusive`: RD closed at 2026-11-05T11:00:00Z (18:00 WIB), open at 10:59:59Z.
  - `test_weekend_closed`: 2026-11-07T03:00:00Z (Saturday 10:00 WIB) → RD closed.
  - `test_holiday_uses_wib_date`: 2026-12-24T17:30:00Z closed; 2026-12-24T09:30:00Z open (Thursday 16:30 WIB is after close for DFABI, so use RD).
  - `test_full_day_24`: hours 00:00–24:00 open at 2026-11-05T16:59:00Z.
  - gw: `test_transfer_after_hours_denied`, `test_create_lock_needs_both_open` (2026-11-05T10:00:00Z = 17:00 WIB: RD open, DFABI closed → denied), `test_spend_lock_after_hours_allowed`, `test_atom_execute_after_hours_allowed`, `test_bank_hours_narrower_denied` (bank RD 07:00–17:00 at 17:30 WIB → denied while BI is open).
- [ ] **Step 2:** `opa test bundles/bi bundles/bank test` → FAIL (`bi.clock` undefined).
- [ ] **Step 3:** Implement. Weekday from `time.weekday(local_ns)` mapped `{"Monday":1,…,"Sunday":7}`; date and clock from `time.date` / `time.clock` on `local_ns`.
- [ ] **Step 4:** Same → PASS (other tests keep passing because fixtures default to 24h).
- [ ] **Step 5:** Commit `besu/opa/`.

### Task 3: Freeze, mint cap, bank per-tx limit

**Files:** Modify `besu/opa/bundles/bi/bi/zeto/zeto.rego`, `besu/opa/bundles/bank/bank/paladin/paladin.rego`, `besu/opa/test/gw/gw_test.rego`

**Interfaces:**
- Consumes: `bi.clock.token_open` (Task 2).
- Produces: BI `frozen_ok(outs)`: no `o.to` in `data.bi.config.frozen` and no identity of the requesting node in it; applied to `transfer`, `createLock`, and to `mint` recipients. `mint`: sum of `mints` ≤ `data.bi.config.zeto.max_mint_per_tx[token]`. Bank: when `data.bank.config.max_per_tx[token]` exists, the sum of outputs ≤ it (BI's cap still applies).

- [ ] **Step 1: Failing tests:** `test_transfer_to_frozen_denied`, `test_frozen_sender_own_gateway_denied` (node4 sending with `frozen = ["bankC@node4"]`), `test_frozen_sender_cancel_lock_allowed`, `test_mint_over_cap_denied` (cap RD 100, mint 101), `test_mint_to_frozen_denied`, `test_bank_per_tx_stricter_denied` (bank RD 500, BI 1000, amount 600), `test_bank_per_tx_looser_still_bi_capped` (bank 5000, BI 1000, amount 1500 → denied).
- [ ] **Step 2:** `opa test …` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `opa test …` → PASS; `regal lint bundles test` clean.
- [ ] **Step 5:** Commit `besu/opa/`.

### Task 4: Draft validators

**Files:**
- Create: `besu/opa/bundles/bi/bi/check/check.rego`, `besu/opa/bundles/bank/bank/check/check.rego`, `besu/opa/test/check/check_test.rego`

**Interfaces:**
- Produces: `data.bi.check.errors`, `data.bank.check.errors`: sets of Indonesian strings, empty when valid. Rules per spec §6.4. Messages, verbatim with `<…>` filled:
  `"<parameter>: harus bilangan bulat positif"`, `"<parameter>: melebihi 1.000.000.000.000.000"`, `"Jam <token>: format harus JJ:MM"`, `"Jam <token>: jam buka harus sebelum jam tutup"`, `"Jam <token>: hari harus 1 (Senin) sampai 7 (Minggu)"`, `"Hari libur <tanggal>: tanggal tidak valid"`, `"Hari libur <tanggal>: tercatat dua kali"`, `"Pembekuan: <id> bukan peserta"`, `"Pembekuan: BI tidak dapat membekukan dirinya sendiri"`, `"Limit per transaksi <token>: tidak boleh lebih longgar dari batas BI"`, `"Jam <token>: harus di dalam jam operasional BI"`, `"Counterparty: <id> bukan peserta"`.

- [ ] **Step 1: Failing tests:** one per message, each with a minimal bad document via `object.union(fixtures.bi, …)` / `fixtures.bank_a`; plus `test_seed_documents_valid` (fixtures give empty `errors`).
- [ ] **Step 2:** `opa test …` → FAIL.
- [ ] **Step 3:** Implement. Date validity: `time.parse_ns("2006-01-02", d)` succeeds and `time.format` gives `d` back.
- [ ] **Step 4:** `opa test …` → PASS.
- [ ] **Step 5:** Commit `besu/opa/`.

### Task 5: Server policy store and opa wrapper

**Files:**
- Create: `frontend/server/src/policy/types.ts` (as in File map), `frontend/server/src/policy/store.ts`, `frontend/server/src/policy/opa.ts`, `frontend/server/test/policy-store.test.ts`, `frontend/server/test/policy-opa.test.ts`
- Setup (folded in): install `opa` v1.21.1 to `~/.local/bin/opa` after checking the release's `.sha256`; add `OPA_BIN=$HOME/.local/bin/opa` to `~/.config/lensa/lensa.env` (keep mode 600).

**Interfaces:**
- Produces:
  - `class PolicyStore { constructor(dir: string, seedsDir: string); current(owner: Owner): Version; history(owner: Owner): Version[] /* newest first */; pending(owner: Owner): Pending | null; savePending(p: Pending | null): void; saveVersion(v: Version): void; audit(owner: Owner, e: { at: string; event: 'submitted'|'approved'|'rejected'|'cancelled'|'published'|'publish-failed'; by: string; n?: number; note?: string }): void }` — layout of spec §7.2 under `dir/<owner>/`; dirs 0700, files 0600 (pattern of `writeState` in `src/state.ts`); `current` writes `v1.json` from `seedsDir/<owner>.json` (maker and checker `"seed"`) when the owner has no version.
  - `class Opa { constructor(bin: string, opaRoot: string); assemble(node: 1|2|3|4, bi: BiPolicy, bank: BankPolicy, outDir: string): void; check(owner: Owner, doc: PolicyDoc, bi: BiPolicy): Promise<string[]>; test(): Promise<{ passed: number; total: number }>; build(bundleDir: string, revision: string, outFile: string): Promise<void> }` — `assemble` copies `bundles/bi` and `bundles/bank` and overlays the editable keys (mapping in File map); `check` assembles a temp dir and runs `opa eval` on `data.bi.check.errors` / `data.bank.check.errors`; `test` runs `opa test --format json` on `bundles/bi bundles/bank test`.
  - `export const POLICY_STATE_DIR = join(STATE_DIR, 'policy')`, `export const OPA_ROOT` (`besu/opa`), `export const SEEDS_DIR` (`besu/opa/seeds`), resolved like `STATE_DIR`.

- [ ] **Step 1: Failing tests:** `store seeds v1 from seeds dir`, `store writes files 0600 in 0700 dirs`, `history newest first`, `audit appends jsonl`; with `OPA_BIN` (skipped otherwise): `check returns no errors for the seed`, `check returns the Indonesian error for bad hours`, `test reports no failures`, `assemble keeps git participants and overlays editable keys`.
- [ ] **Step 2:** `npm test -w server -- policy-` → FAIL.
- [ ] **Step 3:** Implement with `execFile` (no shell) and `mkdtempSync` temp dirs.
- [ ] **Step 4:** `OPA_BIN=$HOME/.local/bin/opa npm test -w server -- policy-` → PASS; `npm run typecheck -w server` clean.
- [ ] **Step 5:** Commit `frontend/server/src/policy/{types,store,opa}.ts` and the tests.

### Task 6: Workflow: submit, approve, reject, cancel

**Files:** Create `frontend/server/src/policy/workflow.ts`, `frontend/server/test/policy-workflow.test.ts`

**Interfaces:**
- Consumes: `PolicyStore`, `Opa` (Task 5); `publish: (owner: Owner, n: number) => Promise<void>` (Task 7 provides it; tests pass a fake).
- Produces: `class PolicyWorkflow { constructor(store: PolicyStore, opa: Opa, publish); submit(owner, { by, reason, doc }): Promise<Pending>; approve(owner, { by, note }): Promise<Version>; reject(owner, { by, note }): Promise<void>; cancel(owner, { by }): Promise<void>; republish(owner, { by }): Promise<void> }`, throwing `PolicyError`. Rules, reasons verbatim:
  - submit: a pending exists → 409 `"Masih ada perubahan yang menunggu persetujuan"`; empty reason → 400 `"Alasan perubahan wajib diisi"`; doc equal to current → 400 `"Tidak ada nilai yang berubah"`; validator errors → 422 `"Kebijakan tidak valid"` with `errors`. Stores `checks` (`Opa.check`, `Opa.test`, and for BI drafts `inactiveBanks` = display names of banks whose `max_per_tx` or `hours` are looser than the draft).
  - approve: normalized `by` (`trim().toLowerCase()`) equals the maker's → 403 `"Pembuat tidak dapat menyetujui perubahannya sendiri"`; `pending.base !== current.n` → 409 `"Kebijakan sudah berubah sejak draf ini dibuat. Buat draf baru."`; state not `waiting` → 409 `"Perubahan ini sedang diterbitkan"`. Then: save `v<N+1>`, set `publishing`, `await publish`, clear pending (audit `published`) or set `publish-failed` (audit `publish-failed`, rethrow).
  - reject: empty note → 400 `"Catatan wajib diisi bila menolak"`. cancel: `by` not the maker (normalized) → 403 `"Hanya pembuat yang dapat membatalkan draf"`. republish: only from `publish-failed`.
  - One in-process mutex per owner around every method.

- [ ] **Step 1: Failing tests:** one per rule, plus `approve rejects maker under another spelling` ("Rina" vs " rina ") and `concurrent approvals publish once` (two un-awaited `approve` calls → one `publish` call, the other 409).
- [ ] **Step 2:** `npm test -w server -- policy-workflow` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS.
- [ ] **Step 5:** Commit.

### Task 7: Publishing to the gateways

**Files:**
- Create: `frontend/server/src/policy/kube.ts`, `frontend/server/src/policy/publish.ts`, `frontend/server/src/cli/policy-build.ts`, `frontend/server/test/policy-publish.test.ts`
- Modify: `frontend/server/package.json` (script `"policy:build": "tsx src/cli/policy-build.ts"`), `besu/opa/README.md` (build tarballs with `npm run policy:build -w server -- <node> <outdir>`)

**Interfaces:**
- Consumes: `Opa`, `PolicyStore` (Task 5).
- Produces:
  - `interface Kube { deploymentExists(name: string): Promise<boolean>; getConfigMap(name: string): Promise<Record<string, Buffer> | null>; applyConfigMap(name: string, files: Record<string, Buffer>): Promise<void>; templateAnnotations(deploy: string): Promise<Record<string, string>>; setTemplateAnnotations(deploy: string, a: Record<string, string>): Promise<void>; waitRollout(deploy: string, timeoutS: number): Promise<boolean>; readyPodAnnotations(deploy: string): Promise<Record<string, string> | null> }`; `kubectlKube(env)` implements it with `execFile('kubectl', …)` in namespace `paladin`.
  - `class Publisher { constructor(kube: Kube, opa: Opa, store: PolicyStore); publish(owner: Owner, n: number): Promise<void>; status(): Promise<GatewayStatus[]>; recoverInterrupted(): void }`. Targets: `bi` → nodes 1–4, `bank-x` → its node. Per node: build `bi.tar.gz` (revision `bi-v<N>`) and `bank.tar.gz` (revision `<bank>-v<N>`; node 1 always from `seeds/bank-bi.json`), keep the previous ConfigMap and annotations, apply ConfigMap `bank-gw-<node>-bundles`, set annotations `policy.lensa/bi` and `policy.lensa/bank` to the version numbers on Deployment `bank-gw-<node>`, `waitRollout(…, 120)`. On false: restore the previous ConfigMap and annotations for that node, continue with the others, then throw `PolicyError(502, "Gagal terbit ke gateway <nodes>")`. A missing Deployment is skipped (`deployed: false`), not a failure.
  - `recoverInterrupted()`: every pending in `publishing` becomes `publish-failed` (audit `publish-failed`, note `"Server berhenti saat menerbitkan"`).
  - CLI `policy-build <node> <outdir>`: writes both tarballs for that node from the store's current versions.

- [ ] **Step 1: Failing tests** (in-memory `Kube`): `bi change goes to every deployed gateway`, `bank change goes to its gateway only`, `failed rollout restores previous configmap and annotations`, `missing gateway reported not deployed`, `status reads ready pod annotations`, `restart marks interrupted publish failed`.
- [ ] **Step 2:** `npm test -w server -- policy-publish` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test -w server` → PASS. No cluster write: `npm run policy:build -w server -- 2 /tmp/pb && tar tzf /tmp/pb/bi.tar.gz | grep bi/config/data.json`.
- [ ] **Step 5:** Commit.

### Task 8: HTTP routes, scoping, wiring

**Files:**
- Create: `frontend/server/src/policy/routes.ts`, `frontend/server/test/policy-routes.test.ts`
- Modify: `frontend/server/src/app.ts:89` (`buildApp` opts gain `policy?: PolicyDeps`, register routes when set), `frontend/server/src/main.ts` (with `OPA_BIN` set: build `PolicyStore`, `Opa`, `Publisher(kubectlKube)`, `PolicyWorkflow`, call `recoverInterrupted()` before `listen`; without it the routes answer 501 `"Kebijakan belum tersedia: OPA_BIN belum diatur"`)

**Interfaces:**
- Consumes: `PolicyWorkflow` (Task 6), `PolicyStore` (Task 5), `Publisher.status` (Task 7).
- Produces `type PolicyDeps = { store: PolicyStore; workflow: PolicyWorkflow; status: () => Promise<GatewayStatus[]>; usage?: (party: 'A'|'B'|'C') => Promise<Record<Token, { used: number; limit: number | null }>> }` and routes (`pihak` in the query on GET, in the body on POST; `by` required on writes, 1–60 chars):
  - `GET /api/policy?pihak=X` → `{ network: VersionView, own: VersionView | null, banks: VersionView[] | null, gateways: GatewayStatus[] }`, `VersionView = { owner: Owner; current: Version; pending: Pending | null }`; `banks` only for BI (R1); `own` null for BI.
  - `GET /api/policy/:owner/history?pihak=X` → `Version[]`.
  - `POST /api/policy/:owner/drafts` `{ pihak, by, reason, doc }` · `/approve` `{ pihak, by, note }` · `/reject` `{ pihak, by, note }` · `/cancel` `{ pihak, by }` · `/republish` `{ pihak, by }`.
  - Writes only to `OWNER_OF_PARTY[pihak]`, and a bank reads only `bi` and its own owner → otherwise 403 `"Pihak ini tidak dapat mengubah kebijakan tersebut"`. `PolicyError` → its status with `{ reason, errors? }`.

- [ ] **Step 1: Failing tests** (`app.inject`, pattern of `server/test/app.test.ts`): `bank cannot write bi`, `bank cannot read other bank history`, `BI sees banks`, `bank sees bi and own only`, `submit then approve by another name publishes v2`, `422 carries errors list`, `501 without OPA_BIN`.
- [ ] **Step 2:** `npm test -w server -- policy-routes` → FAIL.
- [ ] **Step 3:** Implement with Fastify JSON schemas (`additionalProperties: false`, as `txBody` in `app.ts`).
- [ ] **Step 4:** `npm test -w server` → PASS; `npm run typecheck -w server` clean.
- [ ] **Step 5:** Commit.

### Task 9: Verify the Paladin query (read-only; gate for Task 10)

**Files:** `besu/opa/docs/superpowers/specs/2026-11-05-halaman-kebijakan-design.md` (dated note in §6.3)

- [ ] **Step 1:** Through the existing forward `127.0.0.1:31648` (node2), call `ptx_queryTransactionsFull` with `{"limit":5,"eq":[{"field":"from","value":"bankA@node2"},{"field":"domain","value":"zeto"}],"greaterThan":[{"field":"created","value":"<today 00:00 WIB, RFC3339>"}]}`.
- [ ] **Step 2:** Expected: HTTP 200 and rows carrying `function`, `to` and `data.transfers[].amount` / `data.recipients[].amount`. If `greaterThan` on `created` is rejected or `data` is missing, **stop** and report to the user (spec §6.3); do not start Task 10 on another approach.
- [ ] **Step 3:** Write the working query into the spec note; commit the spec.

### Task 10: Daily limit (gateway) and usage (screen)

**Files:**
- Modify: `besu/opa/bundles/bank/bank/paladin/paladin.rego`, `besu/opa/test/gw/gw_test.rego`, `frontend/server/src/main.ts` (pass `usage`), `frontend/server/src/policy/routes.ts` (add the route)
- Create: `frontend/server/src/policy/usage.ts`, `frontend/server/test/policy-usage.test.ts`

**Interfaces:**
- Consumes: the query from Task 9; `data.bi.config.nodes[node].paladin_url` (Task 1); `bi.clock.today` (Task 2); `PolicyDeps.usage` (Task 8).
- Produces: Rego `used_today(token)` = sum over rows with `function in {"transfer","createLock"}` and `lower(to)` equal to the token's contract, of `data.transfers[].amount` / `data.recipients[].amount`; deny when `used_today + request > data.bank.config.daily_limit[token]`; deny when `http.send` errors, status ≠ 200, or returns `limit` rows (page 1000; `timeout: "2s"`, `cache: false`, `raise_error: false`); no query when the bank has no `daily_limit` for that token. TS `usage(party, rpc = jsonRpc): Promise<Record<Token, { used: number; limit: number | null }>>` with the same query and sum (`jsonRpc` from `adapters/besu-network.ts`); route `GET /api/policy/usage?pihak=A|B|C` (BI → 403).

- [ ] **Step 1: Failing tests:** Rego with `with http.send as …`: `test_daily_limit_sum_denied` (used 4.500.000.000, limit 5.000.000.000, request 600.000.000), `test_daily_limit_within_allowed`, `test_daily_limit_paladin_down_denied`, `test_daily_limit_full_page_denied`, `test_no_daily_limit_no_query`. TS: `usage sums transfer and createLock only`, `usage ignores the other token's contract`, `usage route refuses BI`.
- [ ] **Step 2:** Both suites → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `opa test bundles/bi bundles/bank test` and `npm test -w server` → PASS.
- [ ] **Step 5:** Commit.

### Task 11: Web: route, sidebar, API client, form helpers

**Files:**
- Modify: `frontend/web/src/app/route.ts` (add `'kebijakan'` to `SCREENS`), `frontend/web/src/app/route.test.ts`, `frontend/web/src/app/Sidebar.tsx` (`ICON.kebijakan` = the shield path from the mockup, `LABEL.kebijakan = 'Kebijakan'`, add to `TOOLS` between `lensa` and `tps`; `reasonOf`: non-Besu → `"Belum tersedia di platform ini"`, Besu but not Zeto → `"Kebijakan saat ini hanya untuk Zeto"`), `frontend/web/src/api.ts`
- Create: `frontend/web/src/policy/form.ts`, `frontend/web/src/policy/form.test.ts`

**Interfaces:**
- Consumes: Task 8 and Task 10 routes; types from `server/src/policy/types.ts` (type-only import, as `api.ts` does for adapter types).
- Produces: in `api.ts`: `getPolicy(party)`, `getPolicyHistory(owner, party)`, `getPolicyUsage(party)`, `submitPolicy(owner, body)`, `approvePolicy(owner, body)`, `rejectPolicy(owner, body)`, `cancelPolicy(owner, body)`, `republishPolicy(owner, body)`, each returning `Reply<T>`. In `form.ts`: `parseAmount(s: string): number | string` (number, or an Indonesian error), `formatAmount(n: number, token: Token): string` (`"Rp 1.000.000.000"`, `"1.000 unit"`), `diffDocs(a: PolicyDoc, b: PolicyDoc): { label: string; from: string; to: string }[]` (only changed values, labels from the mockup), `openNow(h: Hours, holidays: { date: string }[], nowMs: number): { open: boolean; label: string }` (`"Buka · tutup 18:00"`, `"Tutup · buka Jum 08:00"`).

- [ ] **Step 1: Failing tests:** `parseAmount` ("2.000.000.000" → 2000000000; "2,5", "-1", "0", "1e3", "1.000.000.000.000.001" → messages), `diffDocs lists only changed values`, `openNow` mirroring the Task 2 WIB cases, `route parses /besu/zeto/kebijakan`, `sidebar reason on noto and fabricx`.
- [ ] **Step 2:** `npm test -w web` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test -w web` and `npm run typecheck -w web` → PASS.
- [ ] **Step 5:** Commit.

### Task 12: Web: the Kebijakan screen (with mock server support)

**Files:**
- Create: `frontend/web/src/screens/Policy.tsx`, `frontend/web/src/policy/{PolicyView,DraftForm,Approval,VersionHistory}.tsx`, `frontend/web/e2e/policy.spec.ts`
- Modify: `frontend/web/src/App.tsx` (title `"Kebijakan · <pihak>"`, subtitles from the mockup, render `Policy` when `screen === 'kebijakan'`), `frontend/web/src/styles.css` (only what the screen needs, DESIGN.md tokens), `frontend/server/src/mock-main.ts` (policy deps: `PolicyStore` in a temp dir; an in-memory `Kube` with gateway 2 deployed, 1/3/4 missing; real `Opa` when `OPA_BIN` is set, else a stub reporting no errors and `{ passed: 0, total: 0 }`)

**Interfaces:**
- Consumes: Task 11.
- Produces the mockup's screen: status cards "Versi berlaku", "Gateway memakai versi ini" (`"<n> dari <m>"`, or "Belum diterapkan: gateway belum terpasang"), "Menunggu persetujuan"; tabs "Kebijakan berlaku", "Ubah kebijakan", "Persetujuan" (count badge), "Riwayat versi"; "Masuk sebagai" name kept in `localStorage` key `lensa.policy.by` (read/write in try/catch); "Terbitkan ulang" on `publish-failed`; BI sees the banks read-only; the "Belum tersedia di Zeto (off-chain)" block; `Reply` errors in a `role="alert"` region.

- [ ] **Step 1:** Write `policy.spec.ts` against the mock server: BI sets RD per-tx to "2.000.000.000" as "Rina" with a reason → "Menunggu persetujuan"; approving as "rina" shows "Pembuat tidak dapat menyetujui perubahannya sendiri"; approving as "Dimas" → "Versi berlaku" shows v2 and the gateway card "1 dari 1"; as Bank Mandala the Bank Nusantara values are not on the page.
- [ ] **Step 2:** In a worktree: `npm run e2e -w web -- policy` → FAIL.
- [ ] **Step 3:** Implement the components and the mock deps.
- [ ] **Step 4:** Same → PASS; `npm test` (both workspaces) and `npm run typecheck -w web` clean.
- [ ] **Step 5:** Commit.

### Task 13: Docs

**Files:** Modify `frontend/ARCHITECTURE.md` (policy endpoints, state layout), `frontend/DESIGN.md` (Kebijakan screen entry, sidebar item), `besu/opa/README.md` (the screen, publish flow, `OPA_BIN`), spec §8 (link to this plan)

- [ ] **Step 1:** Write the sections; every endpoint and string matches Tasks 8, 10 and 12.
- [ ] **Step 2:** `npm test` (both workspaces) and `opa test bundles/bi bundles/bank test` → PASS (nothing broke since Task 12).
- [ ] **Step 3:** Commit.

---

## After the plan (not tasks)

- Deploy the screen with `frontend/deploy/update.sh` (atomic dist swap) after the user approves.
- Live publishing: spec §8 step 5, after the user approves the node2 dry-run in `besu/opa/README.md`.
