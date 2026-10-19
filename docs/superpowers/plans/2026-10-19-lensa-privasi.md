# Lensa Privasi Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Skills to load while implementing:**
> - Server tasks: `fastify-best-practices`, `vitest`, `superpowers:test-driven-development`.
> - Web tasks: `vercel-react-best-practices`, `frontend-design`, `ui-ux-pro-max:ui-ux-pro-max`.
> - Task 12: `playwright-best-practices`.

**Goal:** A presenter-driven web app that sends live Zeto, Noto and Stealth transactions on the Besu/Paladin cluster. It shows each party's real view of the same transaction, and compares the three models' TPS in a sequential stress test.

**Architecture:**
- One Fastify/TypeScript server (`besu/lensa-privasi/server`) runs under `tsx`. It owns three model adapters. Each adapter imports its own project's modules from `besu/zeto`, `besu/noto+pente` and `besu/stealth-address`, so each resolves its own `node_modules` and its own Paladin SDK copy.
- The browser (`besu/lensa-privasi/web`, React + Vite) sends commands over JSON and receives progress over Server-Sent Events.
- In demo mode the server serves the built web app.

**Tech Stack:**
- Node 22.23.3, TypeScript 5.9, tsx.
- Server: Fastify 5, `@fastify/static`, vitest.
- Web: React 18.3.1, Vite.
- Chain libraries, as each project already uses them: ethers (6.17.0 in stealth, 6.13.4 in zeto) and `@lfdecentralizedtrust/paladin-sdk` (local build in zeto, 1.0.0 in noto).
- Playwright via `playwright-core` with the cached Chromium.

**Spec:** `besu/docs/superpowers/specs/2026-10-19-lensa-privasi-design.md` (approved). Visual and interaction reference: `besu/.superpowers/brainstorm/3698152-1792377493/content/app-v6.html`. Read both before starting any task.

## Global Constraints

**Parties and network**
- Parties are fixed:
  - `BI` = Bank Indonesia, Paladin node1
  - `A` = Bank Mandala, node2
  - `B` = Bank Nusantara, node3
  - `C` = Bank Sejahtera, node4
- Display names live only in `server/src/domain.ts`, and the web gets them from `GET /api/meta`.
- Endpoints:
  - Paladin JSON-RPC: `http://127.0.0.1:31548`, `:31648`, `:31748`, `:31848` (node1..4), through the existing port-forwards.
  - Besu RPC: `http://127.0.0.1:8545`.

**Flows**
- Flows in v1 are exactly `rd-issue`, `rd-transfer`, `dfabi-issue`, `dfabi-transfer`, `dvp`. There are no redeem or withdraw flows.
- `dfabi-transfer` has no payment leg in every model. `dvp` is DFABI for RD at `PRICE_PER_UNIT = 1_000_000n` Rupiah per unit.
- Amounts travel as decimal integer strings and are `bigint` on the server. Valid range: `1 ≤ amount ≤ 10n**15n`.

**Hard safety rules**
- Never send a PUBLIC transaction to a Zeto contract address. This poison-pills the Paladin node.
- Never fabricate a lens. Every `LensView` comes from a read made with that party's node or keys.
- Stealth banks sign only with keys recovered from their own received stealth addresses, never with a normal account.
- Do not edit existing scripts in `zeto/`, `noto+pente/` or `stealth-address/` beyond the extractions named in Tasks 6–8. Their existing e2e and test commands must still pass.

**Deployment state**
- The app uses its own deployments, stored in `lensa-privasi/server/state/` (git-ignored).
- Zeto identities are `bi@node1`, `bankA@node2`, `bankB@node3`, `bankC@node4`.

**Stress test**
- Defaults: 200 tx per model, 2 senders, 5 min limit.
- Presets: 50, 200, 500.
- Senders: 1, 2, 4, 8.
- Time limits: 120, 300, 600 s.
- Models run sequentially.
- Every chain wait has a deadline. Defaults: 120 s per transaction, 30 s drain on stop.

**UI**
- All copy is in Indonesian and is taken verbatim from the prototype.
- Light theme only.
- IBM Plex Sans and IBM Plex Mono.
- Colour tokens copied from the prototype's `:root`.

## Review Focus

1. **Bad amount input** (empty, `0`, letters, more than `10^15`, more than the sender's balance). Expect `400` with an Indonesian reason shown in the Response tab, and no transaction sent. An amount above the balance must be refused before submit, because of Zeto bug N6. Tests: Task 4 validation tests, and the balance check in each adapter (Tasks 6–8).
2. **Double-clicking "Kirim", or starting a stress test while a demo transaction runs.** Expect a single in-flight operation server-wide; the second request gets `409 "Transaksi lain sedang diproses"`. Test: Task 4 `rejects a second run while one is active`.
3. **Port-forward or node down mid-demo.** Expect the health dot to turn red within 5 s, and a request to fail fast with `503` naming the model and node instead of hanging. Tests: Task 3 deadline test, Task 4 `returns 503 when adapter not ready`.
4. **Stress count above the prepared capacity.** Expect `400 "Melebihi kapasitas siap (N tx)"`, and the web caps the input. Test: Task 5 `rejects count above capacity`.
5. **Browser refresh or SSE drop during a stress run.** Expect the run to continue server-side; `GET /api/stress` returns the live snapshot, and the page re-subscribes and redraws. Tests: Task 4 `stress snapshot survives subscriber disconnect`, Task 11 reload test.

---

## File map

```
besu/lensa-privasi/
  package.json              npm workspaces: server, web; scripts dev, build, start, test, bootstrap, preflight
  .gitignore                node_modules, dist, server/state
  server/
    package.json  tsconfig.json  vitest.config.ts
    src/domain.ts           ids, parties, flow rules, roleOf, validation (pure)
    src/stats.ts            stress statistics (pure)
    src/deadline.ts         withDeadline (pure)
    src/adapter.ts          ModelAdapter interface + shared result/lens types
    src/stress.ts           StressRun orchestrator
    src/app.ts              buildApp(adapters) -> Fastify instance (routes, SSE, static)
    src/main.ts             loads real adapters, listens on 127.0.0.1:8787
    src/state.ts            read/write state/<model>.json
    src/adapters/stealth.ts  noto.ts  zeto.ts
    src/cli/bootstrap.ts    `npm run bootstrap -- <model>`
    src/cli/preflight.ts    `npm run preflight [-- --prepare N]`
    test/*.test.ts          unit tests; test/live/*.live.ts manual live smokes
  web/
    package.json  vite.config.ts  index.html
    src/styles.css          prototype <style> block, verbatim
    src/api.ts              fetch + EventSource client
    src/format.ts           Rupiah / words / parse helpers (pure)
    src/App.tsx             header, nav, health dots
    src/demo/*.tsx          Sidebar, Compose, Timeline, Lenses
    src/stress/*.tsx        StressConfig, RunRows, Results
    e2e/smoke.spec.ts       Playwright against mocked API
stealth-address/ts/chain.ts           (new) chain helpers extracted from script/e2e.ts
noto+pente/bond/src/lib/transfer.ts   (new) plain Noto transfer
zeto/src/flows.ts                     (new) issue/transfer/report/dvp helpers extracted from spike-zeto-e2e.ts
```

---

### Task 1: Workspace scaffold and domain rules

**Files:**
- Create: `lensa-privasi/package.json`, `lensa-privasi/.gitignore`, `lensa-privasi/server/{package.json,tsconfig.json,vitest.config.ts}`, `lensa-privasi/server/src/domain.ts`
- Test: `lensa-privasi/server/test/domain.test.ts`

**Interfaces:**
- Produces (`domain.ts`):
  ```ts
  export type ModelId = 'zeto' | 'noto' | 'stealth';
  export type FlowId = 'rd-issue' | 'rd-transfer' | 'dfabi-issue' | 'dfabi-transfer' | 'dvp';
  export type PartyId = 'BI' | 'A' | 'B' | 'C';
  export type BankId = Exclude<PartyId, 'BI'>;
  export const PARTIES: Record<PartyId, { name: string; node: 1 | 2 | 3 | 4 }>;
  export const BANKS: BankId[];                       // ['A','B','C']
  export const PRICE_PER_UNIT = 1_000_000n;
  export const MAX_AMOUNT = 10n ** 15n;
  export const FLOWS: Record<FlowId, { asset: 'RD' | 'DFABI'; issuer: boolean; dvp: boolean }>;
  export interface FlowRequest { model: ModelId; flow: FlowId; from: PartyId; to: PartyId; amount: string }
  export type Role = 'sender' | 'receiver' | 'issuer' | 'regulator' | 'outsider';
  export function roleOf(req: FlowRequest, party: PartyId): Role;
  export function validateRequest(req: FlowRequest): { ok: true; amount: bigint } | { ok: false; reason: string };
  ```

- [ ] **Step 1: Scaffold.**
  - Root `package.json`: `{"private":true,"workspaces":["server","web"]}`. Scripts:
    - `dev`: run server and web concurrently, using `npm run dev -w server & npm run dev -w web`
    - `build`: `npm run build -w web`
    - `start`: `npm start -w server`
    - `test`: `npm test -ws`
    - `bootstrap`: `npm run bootstrap -w server --`
    - `preflight`: `npm run preflight -w server --`
  - Server deps: `fastify@^5`, `@fastify/static@^8`. Dev deps: `tsx`, `typescript@^5.9`, `vitest@^2`, `@types/node@^22`.
  - Server tsconfig: `"module":"NodeNext"`, `"moduleResolution":"NodeNext"`, `"allowImportingTsExtensions":true`, `"noEmit":true`, `"strict":true`.
  - `.gitignore`: `node_modules`, `dist`, `server/state`.
  - Run `npm install` in `lensa-privasi/`.

- [ ] **Step 2: Write the failing tests** in `test/domain.test.ts`:
  ```ts
  const t = (o: Partial<FlowRequest>): FlowRequest => ({ model:'zeto', flow:'rd-transfer', from:'A', to:'B', amount:'1000', ...o });
  test('transfer roles', () => {
    expect(roleOf(t({}), 'A')).toBe('sender'); expect(roleOf(t({}), 'B')).toBe('receiver');
    expect(roleOf(t({}), 'BI')).toBe('regulator'); expect(roleOf(t({}), 'C')).toBe('outsider');
  });
  test('issue roles', () => {
    const r = t({ flow:'rd-issue', from:'BI', to:'C' });
    expect(roleOf(r,'BI')).toBe('issuer'); expect(roleOf(r,'C')).toBe('receiver');
    expect(roleOf(r,'A')).toBe('outsider'); expect(roleOf(r,'B')).toBe('outsider');
  });
  test.each([
    [{ amount:'' }, 'Nominal wajib diisi'],
    [{ amount:'0' }, 'Nominal harus lebih dari 0'],
    [{ amount:'12a' }, 'Nominal harus angka bulat'],
    [{ amount:'1000000000000001' }, 'Nominal melebihi batas 1.000.000.000.000.000'],
    [{ to:'A' }, 'Pengirim dan penerima harus berbeda'],
    [{ to:'BI' }, 'Penerima harus bank'],
    [{ flow:'rd-issue', from:'A' }, 'Penerbitan hanya dijalankan BI'],
    [{ flow:'rd-transfer', from:'BI' }, 'Transfer dijalankan oleh bank'],
  ])('rejects %o', (o, reason) => expect(validateRequest(t(o))).toEqual({ ok:false, reason }));
  test('accepts and parses', () => expect(validateRequest(t({ amount:'1000000000' }))).toEqual({ ok:true, amount:1_000_000_000n }));
  ```

- [ ] **Step 3: Run the tests.** Run `npm test -w server`. Expected: FAIL, because `roleOf` is not defined.

- [ ] **Step 4: Implement `domain.ts`** with the interfaces above. The order of the checks in `validateRequest` follows the test table.

- [ ] **Step 5: Run the tests.** Run `npm test -w server`. Expected: PASS.

- [ ] **Step 6: Commit.**
  ```bash
  git add lensa-privasi && git commit -m "feat(lensa): workspace scaffold and domain rules"
  ```

### Task 2: Stress statistics

**Files:**
- Create: `lensa-privasi/server/src/stats.ts`
- Test: `lensa-privasi/server/test/stats.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Sample { submittedAt: number; confirmedAt: number }   // epoch ms
  export interface Summary { ok: number; failed: number; avgTps: number; peakTps: number; p50Ms: number; p95Ms: number; durationS: number; series: number[] }
  export function summarize(samples: Sample[], failed: number): Summary;
  export function toCsv(rows: { model: string; s: Summary }[]): string;
  ```

**Definitions** (spec §6):
- `durationS = (max confirmedAt − min submittedAt) / 1000`.
- `avgTps = ok / durationS`.
- `series[i]` = the number of confirmations in `[t0 + i·1000, t0 + (i+1)·1000)`, where `t0 = min submittedAt`.
- `peakTps = max(series)`.
- Percentile is nearest-rank: `sorted[ceil(p·n) − 1]` over the latencies `confirmedAt − submittedAt`.
- When there are no samples, every field is 0 and `series` is `[]`.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  test('basic', () => {
    const s = summarize([{submittedAt:0,confirmedAt:500},{submittedAt:0,confirmedAt:1500},{submittedAt:1000,confirmedAt:1900},{submittedAt:1000,confirmedAt:2000}], 1);
    expect(s).toEqual({ ok:4, failed:1, avgTps:2, peakTps:2, p50Ms:900, p95Ms:1500, durationS:2, series:[1,2,1] });
  });
  test('empty', () => expect(summarize([], 3)).toEqual({ ok:0, failed:3, avgTps:0, peakTps:0, p50Ms:0, p95Ms:0, durationS:0, series:[] }));
  test('csv', () => expect(toCsv([{ model:'zeto', s: summarize([{submittedAt:0,confirmedAt:1000}],0) }]))
    .toBe('model,tps_avg,tps_peak,p50_s,p95_s,ok,failed,duration_s\nzeto,1.00,1.00,1.00,1.00,1,0,1.0'));
  ```
  Check the `basic` case by hand:
  - The latencies are 500, 1500, 900 and 1000. Sorted, they are 500, 900, 1000, 1500.
  - p50 = `sorted[ceil(0.5·4) − 1] = sorted[1] = 900`.
  - p95 = `sorted[3] = 1500`.
  - The buckets from t0 = 0 are [0, 1000): 1; [1000, 2000): 2 (1500, 1900); [2000, 3000): 1 (2000).

- [ ] **Step 2: Run the tests.** Run `npm test -w server -- stats`. Expected: FAIL.

- [ ] **Step 3: Implement `summarize` and `toCsv`.** Number format in the CSV: TPS and seconds use `toFixed(2)`, duration uses `toFixed(1)`.

- [ ] **Step 4: Run the tests.** Expected: PASS.

- [ ] **Step 5: Commit.** `feat(lensa): stress statistics`

### Task 3: Deadline helper and adapter contract

**Files:**
- Create: `lensa-privasi/server/src/deadline.ts`, `lensa-privasi/server/src/adapter.ts`, `lensa-privasi/server/test/fake-adapter.ts`
- Test: `lensa-privasi/server/test/deadline.test.ts`

**Interfaces:**
- Produces (`deadline.ts`):
  ```ts
  export class DeadlineError extends Error { constructor(public what: string, public ms: number) }  // message: `${what} tidak selesai dalam ${ms/1000} detik`
  export function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T>;
  ```
- Produces (`adapter.ts`), the spec §5 contract made concrete:
  ```ts
  export interface StepEvent { index: number; label: string; ms: number }
  export interface FlowResult { txHash: string; block: number; steps: StepEvent[]; context: unknown }   // context: adapter-private data lens() needs
  export type Verdict = 'clear' | 'reported' | 'notarised' | 'viewkey' | 'partial' | 'sealed';
  export interface LensView { party: PartyId; role: Role; verdict: Verdict; amount: string | null; counterparty: string | null;
                              onChain: { label: string; value: string }[]; method: string }   // amount null => redacted
  export type Capability = { enabled: true } | { enabled: false; reason: string };
  export interface ModelAdapter {
    id: ModelId;
    stepLabels: [string, string, string, string];          // spec §5.3, verbatim
    capabilities(): Record<FlowId, Capability>;
    health(): Promise<{ ready: boolean; detail: string }>;
    balanceOf(party: PartyId, asset: 'RD' | 'DFABI'): Promise<bigint>;
    run(req: FlowRequest, amount: bigint, onStep: (s: StepEvent) => void): Promise<FlowResult>;
    lens(req: FlowRequest, result: FlowResult, party: PartyId): Promise<LensView>;
    loadCapacity(): Promise<number>;
    prepareLoad(n: number): Promise<void>;
    transferForLoad(from: BankId, to: BankId, amount: bigint): Promise<Sample>;
  }
  export const LOAD_AMOUNT = 1000n;
  ```
- `test/fake-adapter.ts` exports `fakeAdapter(id: ModelId, opts?: { ready?: boolean; capacity?: number; tps?: number; failEvery?: number }): ModelAdapter`. It returns deterministic results with no chain access and is used by Tasks 4, 5 and 12.

- [ ] **Step 1: Write the failing tests.**
  - `resolves before deadline`: `withDeadline(Promise.resolve(1), 50, 'x')` resolves to 1.
  - `rejects after deadline`: run with `vi.useFakeTimers()`. Call `withDeadline(new Promise(()=>{}), 1000, 'Receipt')`, then `vi.advanceTimersByTime(1000)`. It rejects with a `DeadlineError` whose message is `'Receipt tidak selesai dalam 1 detik'`.
  - `clears timer on resolve`: after resolving, `vi.getTimerCount()` is 0.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement** `withDeadline`, the types and `fakeAdapter`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(lensa): deadline helper and adapter contract`

### Task 4: HTTP API, single-runner lock, SSE

**Files:**
- Create: `lensa-privasi/server/src/app.ts`, `lensa-privasi/server/src/main.ts`
- Test: `lensa-privasi/server/test/app.test.ts`

**Interfaces:**
- Consumes: `domain.ts`, `adapter.ts`, `deadline.ts`, `StressRun` (Task 5; test with `fakeAdapter`).
- Produces: `buildApp(adapters: Record<ModelId, ModelAdapter>, opts?: { webDist?: string }): FastifyInstance`.

**Routes:**

| Method + path | Behaviour |
|---|---|
| `GET /api/meta` | `{ parties: PARTIES, flows: FLOWS, models: { [id]: { stepLabels, capabilities } } }` |
| `GET /api/health` | `{ models: { [id]: {ready, detail} }, nodes: { besu: boolean, paladin: [b,b,b,b] } }`. Paladin node i is up when JSON-RPC `transport_nodeName` answers within 2 s; Besu is up when `eth_blockNumber` answers within 2 s. |
| `POST /api/tx` | Body is a `FlowRequest`, checked with a Fastify JSON schema and then `validateRequest`. Errors: `400 {reason}`; `409 {reason:'Alur ini tidak tersedia: <capability reason>'}` when the capability is disabled; `503 {reason:'<Model> belum siap: <detail>'}` when the adapter is not ready; `400 {reason:'Saldo <party> tidak cukup'}` when `balanceOf` is below the amount (DvP checks the buyer's RD for `amount × PRICE_PER_UNIT` and the seller's DFABI); `409 {reason:'Transaksi lain sedang diproses'}` while any tx or stress run is active. On success returns `202 {runId}`. |
| `GET /api/tx/:runId/events` | SSE events: `step` (StepEvent), `result` (`{ txHash, block, steps, lenses: LensView[] }` with lenses for all 4 parties, ordered BI, A, B, C), `error` (`{reason}`). Events already emitted are replayed to a late subscriber. |
| `POST /api/stress` | Body is a `StressConfig`. Errors as for tx, plus the Task 5 validation. Returns `202`. |
| `GET /api/stress` | Snapshot. |
| `GET /api/stress/events` | SSE `tick` / `done` carrying snapshots. |
| `POST /api/stress/stop` | Stops the run. |
| `GET /api/stress/csv` | `text/csv` using `toCsv`. |

**Implementation notes:**
- **SSE:** `reply.hijack()`, write `content-type: text/event-stream`, `cache-control: no-cache`, and a `:ok` comment every 15 s. On `request.raw` `close`, remove the listener only; the run keeps going.
- **Lock:** one module-level `busy: 'tx' | 'stress' | null`, released in `finally`.
- **Timeouts:** the whole `run` + lenses is wrapped in `withDeadline(…, 120_000, 'Transaksi')`.
- **`main.ts`:**
  - Builds the real adapters (Tasks 6–8) from `state/`.
  - Serves `../web/dist` when it exists.
  - Listens on `127.0.0.1:8787`.
  - Logs the URL and the SSH tunnel hint `ssh -L 8787:localhost:8787 <host>`.

- [ ] **Step 1: Write the failing tests** with `app.inject` and `fakeAdapter`:
  - `meta lists 3 models with step labels`
  - `400 on bad amount`, with the reason from `validateRequest`
  - `409 on disabled flow`, using a fake with `dfabi-transfer` disabled and reason `'X'`; the reason is `'Alur ini tidak tersedia: X'`
  - `503 when adapter not ready`
  - `400 when balance too low`
  - `202 then SSE delivers 4 steps and result with 4 lenses in order BI,A,B,C`. Start with `app.listen({port:0})` and read the stream with `fetch`.
  - `rejects a second run while one is active` (409)
  - `rejects stress while tx active` (409)
  - `stress snapshot survives subscriber disconnect`: open the events stream, abort it, then `GET /api/stress` still shows `state: 'running'`, and later `'done'`
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement** `app.ts` and `main.ts`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(lensa): HTTP API with SSE progress and single-runner lock`

### Task 5: Stress orchestrator

**Files:**
- Create: `lensa-privasi/server/src/stress.ts`
- Test: `lensa-privasi/server/test/stress.test.ts`

**Interfaces:**
- Consumes: `ModelAdapter.transferForLoad`, `health`, `loadCapacity`, and `summarize`.
- Produces:
  ```ts
  export interface StressConfig { models: ModelId[]; count: number; concurrency: 1 | 2 | 4 | 8; limitS: 120 | 300 | 600 }
  export type ModelRunStatus = 'waiting' | 'running' | 'done' | 'stopped' | 'timeout' | 'skipped';
  export interface StressSnapshot { state: 'running' | 'done' | 'stopped'; config: StressConfig;
    models: Partial<Record<ModelId, { status: ModelRunStatus; reason?: string; firstError?: string; elapsedS: number; summary: Summary }>> }
  export function validateStress(c: StressConfig, capacity: Record<ModelId, number>): { ok: true } | { ok: false; reason: string };
  export class StressRun extends EventEmitter {        // events: 'tick' (snapshot, at most once per second), 'done' (snapshot)
    constructor(cfg: StressConfig, adapters: Record<ModelId, ModelAdapter>, clock?: { now(): number });
    start(): Promise<StressSnapshot>; stop(): void; snapshot(): StressSnapshot;
  }
  ```

**Behaviour:**
- Models run in the order given.
- For each model:
  - If `health().ready` is false, the model is `skipped` with the detail as its reason.
  - Otherwise `concurrency` workers loop. Worker `w` on iteration `k` uses the pair `PAIRS[(w + k) % 3]`, with `PAIRS = [['A','B'],['B','C'],['C','A']]`. Each call is `transferForLoad(from, to, LOAD_AMOUNT)` wrapped in `withDeadline(…, 120_000)`.
  - A worker stops when the total started reaches `count`, when `stop()` is called, or when `elapsed ≥ limitS` (status `timeout`).
  - Thrown errors count as failed, and the first message is kept.
  - After `stop()`, in-flight calls are awaited up to 30 s.
- `validateStress` reasons:
  - `'Pilih minimal satu model'`
  - `'Jumlah transaksi minimal 1'`
  - `'Melebihi kapasitas siap <Model> (<N> tx)'`

- [ ] **Step 1: Write the failing tests** with fakes. A fake with `tps` resolves each call after `1000/tps` ms of fake-timer time.
  - `runs models sequentially`: model 2's first `submittedAt` is at or after model 1's last `confirmedAt`
  - `respects count and concurrency`: count 10, concurrency 2, gives ok 10, and at most 2 calls in flight at any time
  - `rotates pairs`: the first 3 calls of worker 0 are A→B, B→C, C→A
  - `counts failures and keeps first error`: `failEvery: 3`, count 9, gives failed 3 and `firstError` set
  - `time limit gives timeout`
  - `stop gives stopped and drains`
  - `skips unready model with reason`
  - `rejects count above capacity`
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement** `stress.ts`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(lensa): sequential stress orchestrator`

### Task 6: Stealth adapter

**Files:**
- Create: `stealth-address/ts/chain.ts`, `lensa-privasi/server/src/state.ts`, `lensa-privasi/server/src/adapters/stealth.ts`, `lensa-privasi/server/src/cli/bootstrap.ts` (stealth part), `lensa-privasi/server/test/live/stealth.live.ts`
- Modify: `stealth-address/script/e2e.ts`, replacing the inline helpers with imports from `../ts/chain.ts` and nothing else
- Test: `stealth-address/ts/chain.test.ts` (pure parts), `lensa-privasi/server/test/state.test.ts`

**Interfaces:**
- Produces (`stealth-address/ts/chain.ts`). Every function takes its provider, signer and addresses as parameters; there are no module globals.
  ```ts
  export type Deployed = { announcer: string; registry: string; validator: string; bond: string; rd: string; dvpFactory: string; instrumentRegistry: string; fromBlock: number };
  export async function deployAll(deployer: Wallet): Promise<Deployed>;                 // e2e.ts:116-135, incl. wiring
  export async function announcements(p: Provider, d: Deployed, fromBlock: number): Promise<Announcement[]>;  // chunked <= Besu getLogs cap
  export async function pay(...): Promise<TransactionReceipt>;      // e2e.ts:156 signature, parameterised
  export function biRows(anns: Announcement[], holders: ViewKeyHolder[], ctx: ...): { bank: string; amount: bigint; sender: string | null; tx: string }[];  // e2e.ts:169
  export function certFor(...): string;                               // e2e.ts:138
  ```
  Keep the e2e names. Signatures match the current inline helpers plus the explicit context parameters.
- Produces (`state.ts`): `readState<T>(model: ModelId): T | null` and `writeState(model, data)`, at `server/state/<model>.json`. Bigints are serialised as strings.
- Produces: `createStealthAdapter(state: StealthState, rpcUrl = 'http://127.0.0.1:8545'): ModelAdapter`.

**Stealth specifics:**
- **Bootstrap** (`npm run bootstrap -- stealth`):
  - Deploys with `deployAll` using `DEPLOYER_KEY` from `stealth-address/.env.smoke` (this deployer acts as BI).
  - Generates meta-addresses and identity keys for A, B and C.
  - Registers the keys and gives BI the bond view keys.
  - Mints opening balances: RD 10^13 to each bank, and DFABI 10^6 units to each bank.
  - Writes `state/stealth.json`.
- **`run`:**
  - `rd-transfer` / `dfabi-transfer`: the sender selects one received stealth address (found by `scan` with its own keys) whose balance covers the amount. If none does, it throws `'Saldo di satu alamat stealth tidak cukup'`. It signs with that address's recovered key.
  - Issue flows: BI signs.
  - `dvp`: `prepare` → `create` → `fundBond` → `fundRd` → `settle`.
- **Steps:** 1 is derive + memo, 2 is sign, 3 is receipt, 4 is BI `scanAll` over the tx block.
- **`lens`:**
  - Receiver: `scan` + `openMemo`, giving verdict `clear`.
  - BI: `scanAll` + `openMemo`, giving `viewkey`.
  - Sender: rebuilt from `context`, giving `clear`.
  - Outsider: `scanView` with its own key gives 0 matches and `openMemo` gives null, so the verdict is `partial`, with `amount` read from the raw log and `counterparty: null`.
- **`method` strings** name the function used, exactly as in the prototype detail panel.
- **Capabilities:** all five flows are enabled.

- [ ] **Step 1: Extract `chain.ts`.** Move the helpers verbatim and parameterise them. Then run `cd stealth-address && npm test && npm run e2e` against the cluster. Expected: the same pass counts as `docs/e2e-report-2026-10-17.md`.
- [ ] **Step 2: Write `state.test.ts`.** A round-trip of an object with a bigint gives equal values. Run it and see it fail, then implement `state.ts` and see it pass.
- [ ] **Step 3: Implement** the adapter and the bootstrap, then run `npm run bootstrap -- stealth`. Expected: `state/stealth.json` is written and each bank's RD balance is 10^13.
- [ ] **Step 4: Write `test/live/stealth.live.ts`.** It runs `rd-transfer` A→B with 1000 and asserts:
  - lens A is `clear`
  - lens B is `clear` with counterparty Bank Mandala
  - lens BI is `viewkey`
  - lens C is `partial` with `counterparty === null`
  - `transferForLoad('B','C',1000n)` returns `confirmedAt > submittedAt`

  Run with `npx vitest run test/live/stealth.live.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(lensa): stealth adapter with extracted chain helpers`

### Task 7: Noto adapter and plain transfer

**Files:**
- Create: `noto+pente/bond/src/lib/transfer.ts`, `noto+pente/bond/src/lib/issue.ts`, `noto+pente/bond/src/tests/live-transfer.ts`, `lensa-privasi/server/src/adapters/noto.ts`, `lensa-privasi/server/test/live/noto.live.ts`
- Modify: `lensa-privasi/server/src/cli/bootstrap.ts` (noto part)

**Interfaces:**
- Produces (`transfer.ts`):
  ```ts
  export async function transferNoto(p: Platform, token: 'cash' | 'bond', from: Participant, toLookup: string, amount: bigint): Promise<ITransactionReceipt>;
  ```
  It calls `p.notoCash` / `p.notoBond` `.using(from.client).transfer(from.verifier, { to: toLookup, amount, data: '0x' })` and passes the receipt through `requireSuccess`.
- Produces: `createNotoAdapter(dataDir: string): ModelAdapter`, using `loadPlatform(dataDir)` from `bond/src/lib/platform.ts`.

**Noto specifics:**
- **Bootstrap** (`npm run bootstrap -- noto`): runs `npx ts-node src/index.ts --cache <abs path to lensa-privasi/server/state/noto>` with cwd `noto+pente/bond`. This is the project's own fresh deployment: BI identities on node1, investors 1..3 on node2..4. It then records `{ dataDir }` in `state/noto.json`.
- **Party mapping:** A, B and C map to `investors.get('investor1' | 'investor2' | 'investor3')`. BI maps to the node1 identities.
- **Import side effect:** `common/src/config.ts` loads its config on import from argv. The server never passes `--config`, so it uses the default `common/config.json`. Verify this in Step 1.
- **Flows:**
  - `rd-transfer` and `dfabi-transfer` use `transferNoto`.
  - `dvp` uses `executeOutright`.
  - Issue flows use the mint calls from `bond/src/index.ts`. Extract them as `issueCash(p, toLookup, amount)` and `issueBond(...)` into `noto+pente/bond/src/lib/issue.ts`, following the same rule as Task 6.
- **Steps:**
  1. Notary check: the time until the notary-signed `prepare` returns, or the closest boundary the SDK exposes; label accordingly.
  2. Submit.
  3. Receipt.
  4. The receiver's `balanceOf` reflects the new state.
- **`lens`** (pattern from `bond/src/tests/live-verify-privacy.ts:25,61,89-92`):
  - Party nodes read their private state, giving `clear`.
  - BI reads the notary copy, giving `notarised`.
  - The outsider's node read is refused or empty, giving `sealed` with `amount: null`. The on-chain state hashes come from the receipt events.
- **Capabilities:** all five flows are enabled. `dfabi-transfer` may be blocked by the BondTracker hook (an investor whitelist). If Step 2 shows it is, set `{enabled:false, reason:'Transfer DFABI dibatasi hook BondTracker'}` and say so in the commit message.

- [ ] **Step 1: Check the import side effect.** Run `cd lensa-privasi/server && npx tsx -e "await import('../../noto+pente/bond/src/lib/platform.ts'); console.log('ok')"`. Expected: `ok`.
- [ ] **Step 2: Write `live-transfer.ts`.** It mirrors the existing live tests: `transferNoto` cash investor1 → investor2 for 1000, then asserts the balances changed by ±1000 and that investor3's node sees no new state. Run with `npx ts-node src/tests/live-transfer.ts --cache <dir>`. Expected: FAIL, because `transferNoto` is not defined. Then implement `transfer.ts` and see it PASS. Repeat with `'bond'`.
- [ ] **Step 3: Implement** the adapter and the noto bootstrap, then run `npm run bootstrap -- noto`.
- [ ] **Step 4: Write `test/live/noto.live.ts`.** Same shape as Task 6 Step 4, expecting the verdicts `clear`, `clear`, `notarised` and `sealed`. Run it. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(lensa): noto adapter and plain noto transfer`

### Task 8: Zeto adapter

**Files:**
- Create: `zeto/src/flows.ts`, `zeto/spike-private-mint.ts`, `lensa-privasi/server/src/adapters/zeto.ts`, `lensa-privasi/server/test/live/zeto.live.ts`
- Modify: `lensa-privasi/server/src/cli/bootstrap.ts` (zeto part). Do not modify any existing zeto script.

**Interfaces:**
- Produces (`zeto/src/flows.ts`). These are the helpers from `spike-zeto-e2e.ts` (`issueToken` :146, `seed` :159, `transferOf` :251, `lock`/`prepare`/`createAtom`/`delegateBoth`/`swap` :201-232, `report` :267), rewritten to take every dependency as a parameter instead of module globals:
  ```ts
  export type Party = { lookup: string; c: PaladinClient; v: PaladinVerifier };
  export function party(clients: PaladinClient[], lookup: string): Party;
  export async function issueToken(issuer: Party): Promise<{ zeto: ZetoInstance; erc20: string }>;
  export async function seed(issuer: Party, holder: Party, t: { zeto: ZetoInstance; erc20: string }, count: number, amount: bigint): Promise<ITransactionReceipt[]>;
  export async function transfer(from: Party, zeto: ZetoInstance, to: Party, amount: number): Promise<ITransactionReceipt>;
  export async function reportTo(group: string, from: Party, token: 'RD' | 'DFABI', zetoAddress: string, receipt: ITransactionReceipt): Promise<Report>;
  export async function swap(f: AtomFactory, seller: Party, buyer: Party, bond: ZetoInstance, cash: ZetoInstance, units: number, price: number): Promise<ITransactionReceipt>;
  ```
- Produces: `createZetoAdapter(state: ZetoState): ModelAdapter`.

**Zeto specifics:**
- **Private-mint spike** (spec §7a.3): `spike-private-mint.ts` calls the SDK's `zeto.mint(bi.v, { mints: [{ to: bankA.v, amount: 100, data: '0x' }] })` on a fresh Zeto_Anon, then asserts:
  - bankA's `balanceOf` is 100
  - bankC's node has 0 states
  - BI's ledger verifies the report

  If it passes, issue flows use `mint` and the outsider lens is `sealed`. If it fails, issue flows use `seed` (public mint + deposit), and the outsider lens for issue flows is `partial` with the note `'Nominal dan penerima terlihat saat penerbitan'`. Record which path was taken in `state/zeto.json` as `privateMint: boolean`.
- **Bootstrap** (`npm run bootstrap -- zeto`):
  - Identities: `bi@node1`, `bankA@node2`, `bankB@node3`, `bankC@node4`.
  - Two tokens through `issueToken(bi)`: RD and DFABI.
  - One Pente privacy group per bank, each `{bank, bi}`.
  - `BiLedger` setup as in `biSetup` (:253) with the new identities.
  - Opening balances: 5 RD UTXOs of 10^9 per bank, and 5 DFABI UTXOs of 1000 per bank.
  - Writes `state/zeto.json`, including `fromBlock`.
- **`run`:**
  - Before submitting, check `balanceOf(from) ≥ amount`. This guards against bug N6.
  - Every transfer is followed by `reportTo`.
  - Never use `TransactionType.PUBLIC` against a Zeto address. ERC20 calls in `seed` are fine.
- **Steps:**
  1. Proof: the time until the Paladin tx is assembled, or the closest boundary the SDK exposes; label accordingly.
  2. Submit.
  3. Receipt.
  4. BI ledger `pollReports` verifies the outputs of this tx.
- **`lens`:**
  - Sender and receiver: `visibleStates` + `balanceOf` on their own node, giving `clear`.
  - BI: `ledger.verified` contains this tx's outputs, giving `reported`.
  - Outsider: its node has 0 states for this tx, giving `sealed`. `onChain` holds the commitments and nullifiers from `chainIO`.
- **`transferForLoad`:** `transfer` + `reportTo`. The sample's `confirmedAt` is when the report message is accepted (spec §7a.2).
- **Capabilities:** all five flows are enabled.

- [ ] **Step 1: Run the spike.** Run `cd zeto && npx ts-node spike-private-mint.ts`. Record the outcome in the task's commit message.
- [ ] **Step 2: Extract `flows.ts`.** Run `npm run typecheck`. Expected: clean. `spike-zeto-e2e.ts` is unchanged.
- [ ] **Step 3: Implement** the adapter and the zeto bootstrap, then run `npm run bootstrap -- zeto`. Expected: balances as listed above.
- [ ] **Step 4: Write `test/live/zeto.live.ts`.** Same shape as Task 6 Step 4, expecting the verdicts `clear`, `clear`, `reported` and `sealed`. Run it. Expected: PASS. Afterwards, `kubectl get pods -n paladin` shows no new restarts.
- [ ] **Step 5: Commit.** `feat(lensa): zeto adapter with BI on node1`

### Task 9: Preflight and load capacity

**Files:**
- Create: `lensa-privasi/server/src/cli/preflight.ts`
- Modify: `adapters/*.ts`, implementing `loadCapacity` / `prepareLoad`

**Interfaces:**
- Consumes: the adapters, `GET /api/health` logic (extract `probeNodes()` from `app.ts` into `src/health.ts` and use it in both places).

**Behaviour:**
- `npm run preflight` prints one line per check with `OK` or `GAGAL <reason>`:
  - the 4 Paladin nodes
  - Besu
  - each model's `health`
  - each model's `loadCapacity`
- It exits 1 if any check fails.
- `--prepare N` calls `prepareLoad(N)` on every ready model, then prints the new capacity.
- Capacity per model:
  - **Stealth:** the number of transfers the funded per-pair stealth addresses can make at `LOAD_AMOUNT`.
  - **Noto:** the minimum over banks of `floor(balance / LOAD_AMOUNT)`.
  - **Zeto:** the minimum over banks of the count of unspent RD UTXOs ≥ `LOAD_AMOUNT`. `prepareLoad` deposits UTXOs of exactly `LOAD_AMOUNT`, so each transfer consumes one input and leaves no change.

- [ ] **Step 1: Write the failing test** `test/preflight.test.ts`. With fakes (one not ready), the output contains `GAGAL Noto belum siap` and the exit code is 1.
- [ ] **Step 2: Run the test.** Expected: FAIL.
- [ ] **Step 3: Implement** `preflight.ts` and the adapter capacity functions.
- [ ] **Step 4: Run the test.** Expected: PASS. Then run live `npm run preflight -- --prepare 200`. Expected: all `OK`, and every capacity ≥ 200.
- [ ] **Step 5: Commit.** `feat(lensa): preflight and load capacity`

### Task 10: Web app shell and demo screen

**Files:**
- Create: `lensa-privasi/web/{package.json,vite.config.ts,index.html,tsconfig.json}`, `web/src/{main.tsx,App.tsx,styles.css,api.ts,format.ts}`, `web/src/demo/{DemoView,Sidebar,Compose,Timeline,Lenses}.tsx`
- Test: `web/src/format.test.ts`, `web/src/demo/demoState.test.ts`

**Interfaces:**
- Consumes the Task 4 routes and payload types. Import the types from `../server/src/domain.ts` and `../server/src/adapter.ts` with `import type`; do not duplicate them.
- Produces (`format.ts`):
  - `formatRupiah(n: bigint): string`: `'Rp 1.000.000.000'`
  - `formatUnits(n: bigint): string`: `'1.000 unit DFABI'`
  - `amountWords(n: bigint, asset): string`: `'1 miliar rupiah'`, `'1,5 triliun rupiah'`, `'250 juta rupiah'`, `'1.000 unit'`
  - `parseAmountInput(s: string): bigint | null`: removes everything except digits; returns null when the result is empty.
- Produces (`demo/demoState.ts`), a pure reducer:
  ```ts
  export function demoReducer(s: DemoState, a: DemoAction): DemoState;
  ```
  It holds the selection rules from the prototype:
  - Issue flows force `from='BI'`.
  - Picking a bank flow while `from==='BI'` sets `from='A'`.
  - `to` never equals `from` and is never `'BI'`.
  - Changing a model to one where the current flow is disabled selects the first enabled flow.
  - Any selection change clears the result.

**UI:**
- `styles.css` is the prototype's `<style>` block, verbatim.
- Component markup mirrors the prototype's DOM and class names.
- Vite dev proxies `/api` to `http://127.0.0.1:8787`.
- The health dots in the header poll `GET /api/health` every 5 s and turn red (`#C24A4A`) when anything is down.
- The response tab shows the server's `{reason}` on errors.
- The Send button is disabled while a run is in flight.

- [ ] **Step 1: Write the failing tests** for `format.ts`, using the exact strings above plus `parseAmountInput('1.000.000') === 1000000n` and `parseAmountInput('') === null`, and for `demoReducer`, one test per rule above.
- [ ] **Step 2: Run the tests.** Run `npm test -w web`. Expected: FAIL.
- [ ] **Step 3: Implement** `format.ts`, `demoState.ts` and the components.
- [ ] **Step 4: Run the tests.** Expected: PASS. Then run `npm run dev` with the server on the live cluster, and click through Zeto, Noto and Stealth `rd-transfer`. Each shows 4 timed steps and 4 lenses with the verdicts from Tasks 6–8.
- [ ] **Step 5: Commit.** `feat(lensa): web shell and demo screen`

### Task 11: Stress screen

**Files:**
- Create: `web/src/stress/{StressView,StressConfig,RunRows,Results}.tsx`, `web/src/stress/stressForm.ts`
- Test: `web/src/stress/stressForm.test.ts`

**Interfaces:**
- Consumes: `POST/GET /api/stress`, `/api/stress/events`, `/api/stress/stop`, `/api/stress/csv`, and `GET /api/preflight-capacity`. Add that route to `app.ts` in this task, returning `Record<ModelId, number>` from `loadCapacity`, with a test in `app.test.ts`.
- Produces (`stressForm.ts`):
  - `clampCount(n: number, capacity: number): number`
  - `showZetoWarning(models: ModelId[], concurrency: number): boolean`: true when zeto is selected and concurrency > 2
  - `conclusion(rows: { model: ModelId; s: Summary }[]): string`, which gives the prototype sentence:
    - one model: `'<Model>: <avg> TPS rata-rata.'`
    - several models: `'<Best> paling cepat dengan <avg> TPS rata-rata, sekitar <k>× <Worst>.'`, plus `' Zeto lebih lambat karena setiap transaksi harus membangun bukti ZK (~2 detik).'` when the worst is Zeto
    - numbers use the `id-ID` format with 1 decimal, and `k = Math.round(best/worst)`

**UI:**
- The layout, sparkline SVG, bars, table and footnote copy are taken from the prototype.
- Each model's checkbox shows `Kapasitas siap: N tx`.
- The count input is clamped to the smallest capacity among the selected models.
- On mount, `GET /api/stress`; if a run is in progress, subscribe and render it.

- [ ] **Step 1: Write the failing tests** for `stressForm.ts`:
  - `conclusion` for 1 model
  - `conclusion` for 3 models with the worst being Zeto, expecting the exact string with the Zeto sentence
  - `clampCount(500, 200) === 200`
  - `showZetoWarning(['zeto'], 4) === true`
  - `showZetoWarning(['noto'], 8) === false`
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement** `stressForm.ts` and the components.
- [ ] **Step 4: Run the tests.** Expected: PASS. Then live: Light 50 tx with 2 senders, all three models. Rows run one after another, results appear, and the CSV downloads. While Zeto is running, reload the page: the run is still shown and keeps updating.
- [ ] **Step 5: Commit.** `feat(lensa): stress test screen`

### Task 12: Mocked end-to-end smoke and demo packaging

**Files:**
- Create: `lensa-privasi/web/e2e/smoke.spec.ts`, `lensa-privasi/web/playwright.config.ts`, `lensa-privasi/server/src/mock-main.ts`, `lensa-privasi/README.md`

**Interfaces:**
- Consumes: `buildApp`, `fakeAdapter`, and the web build.

**Pieces:**
- `mock-main.ts` serves `buildApp` with three `fakeAdapter`s plus `web/dist` on port 8788.
- The Playwright config starts it as its `webServer`. It uses `playwright-core` and the cached Chromium at `~/.cache/ms-playwright/chromium-1248`.
- `README.md` sections:
  - Prerequisites: port-forwards running, `.env.smoke` for stealth.
  - Bootstrap order: stealth, noto, zeto.
  - `npm run preflight -- --prepare 500` before a meeting.
  - `npm run build && npm start`.
  - The SSH tunnel command.
  - What to do if a Paladin node restarts. Point to `besu/zeto/README.md` for receipt-less transaction cleanup; do not delete anything automatically.

- [ ] **Step 1: Write `smoke.spec.ts`:**
  - Load `/`.
  - Click "Kirim". Expect 4 checked timeline steps, then 4 lens panels, with exactly 1 having class `sealed` for zeto `rd-transfer` A→B.
  - Switch to Stealth, send, and expect 1 `partial` panel.
  - Open "Stress test TPS", select Light, click "Mulai stress test". Expect the "Hasil perbandingan" heading within 20 s and a CSV download whose header line is `model,tps_avg,tps_peak,p50_s,p95_s,ok,failed,duration_s`.
- [ ] **Step 2: Run the test.** Run `npm run build && npx playwright test`. Expected: FAIL until `mock-main.ts` exists.
- [ ] **Step 3: Implement** `mock-main.ts`, the config and the README.
- [ ] **Step 4: Run the test.** Run `npx playwright test`. Expected: PASS. Then run `npm test` at the root. Expected: all unit tests pass.
- [ ] **Step 5: Commit.** `feat(lensa): mocked e2e smoke and demo runbook`
