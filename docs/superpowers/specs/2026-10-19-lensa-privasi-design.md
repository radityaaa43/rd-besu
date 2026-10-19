# Lensa Privasi: privacy demo and TPS comparison web app

Date: 2026-10-19
Status: approved 2026-10-19
Approved prototype: `besu/.superpowers/brainstorm/3698152-1792377493/content/app-v6.html` (open it; it is the visual and interaction reference for everything below)

## 1. Intent

Bank Indonesia management needs to see, live, that on the shared Besu network a privacy-enabled transaction can be read in full by exactly three parties (sending bank, receiving bank, BI) and by nobody else, and how the three privacy models in this repo (Zeto, Noto, Stealth) differ in what they hide and how fast they run.

The app is a presenter-driven demo. One presenter clicks; management watches a projector. It drives the existing projects in `besu/zeto`, `besu/noto+pente` and `besu/stealth-address` against the running cluster. Nothing on the screen is invented: every number, hash and "who can read it" verdict comes from a real call to the chain or to a party's own node.

### Goals

1. **Demo transaction screen.** Pick network, privacy model, flow and acting party; send one live transaction; see the request, the response, the processing steps with real timings, and the same transaction viewed from each party's own node or keys.
2. **Stress test screen.** Pick which models to test, a small set of load settings, run them one after another, watch progress live, and get a side-by-side TPS and latency comparison with a CSV download.

### Non-goals

- Production security: no login, no multi-user, no TLS. Runs on the ops host and is opened through an SSH tunnel.
- Fabric-X: shown as a disabled "segera" option only.
- New privacy features in the three projects. The only additions are those listed in section 7 (needed so every model can run the same flows).
- Mobile layout beyond "does not break". The target is a 1440 px projector screen.

### Anti-goals (failure even if it technically works)

- **Fabricated lens panels.** A panel that says "Tersegel" must be the result of that party's node or keys actually failing to read the transaction, not a hard-coded string.
- **Overstating Stealth.** Stealth amounts and tokens are public on chain. The UI must show this (amber "Sebagian" panel), never present Stealth as hiding the amount.
- **Killing the cluster during the demo.** Zeto proving has OOM/liveness-killed Paladin nodes before (exit 137). The stress test must default to safe settings and warn before unsafe ones.
- **Sending a public transaction straight to a Zeto contract.** This poison-pills the Paladin node (crash loop). The backend must never do it.

## 2. Parties and network mapping

The cluster has 4 Besu validators and 4 Paladin nodes (verified running in k8s namespaces `besu` and `paladin`). BI is one of the four.

| Party | Display name | Paladin node | Notes |
|---|---|---|---|
| BI | Bank Indonesia | node1 | Issuer of RD and DFABI, Noto notary, Zeto BI reporting identity, Stealth view-key holder |
| Bank A | Bank Mandala | node2 | |
| Bank B | Bank Nusantara | node3 | |
| Bank C | Bank Sejahtera | node4 | |

Bank names are fictional on purpose (no real bank is named). They live in one config map so they can be renamed.

Per model, a party is:

- **Zeto / Noto:** a Paladin identity `<name>@nodeN` on its own node. Reads go to that node's JSON-RPC.
- **Stealth:** a Besu account plus a stealth meta-address (spend key, view key) plus an identity key that signs memos. Stealth uses Besu RPC only. BI holds every bank's view key.

Because Paladin stores private state per node, not per identity, each bank must be the only party on its node. BI alone on node1 is what makes "the third bank sees nothing" true.

## 3. Screens (as in the prototype)

### 3.1 Demo transaction

Left sidebar, numbered top to bottom:

1. **Network:** Besu (active), Fabric-X (disabled, "segera").
2. **Model privasi:** Zeto, Noto, Stealth, with a one-line tagline per model.
3. **Alur**, grouped by asset:
   - Rupiah Digital (RD): Penerbitan RD, Transfer RD
   - Obligasi DFABI: Penerbitan seri DFABI, Transfer DFABI (no payment leg, in every model)
   - Penyelesaian DvP: DvP DFABI ↔ RD

   A flow a model cannot run is shown disabled with the reason (from the backend's capability list, section 5.2).
4. **Jalankan sebagai:** Bank Mandala, Bank Nusantara, Bank Sejahtera, Bank Indonesia. Invalid choices are disabled with a one-line reason (issuance: BI only; transfers: a bank).

Main area:

- **Compose card.** Breadcrumb, flow title, one-sentence description, counterparty select, amount input with the amount in words, primary button whose label names the action ("Kirim", "Terbitkan", "Jalankan DvP"). Right half: Request / Response tabs showing the actual JSON the browser sent to the backend and the backend's response.
- **Processing timeline.** The model's steps, each with a spinner then a check and the measured duration. Steps are reported by the backend as they happen (section 5.3).
- **Lens panels.** "Transaksi yang sama, dilihat dari tiap pihak", split into "Pihak dalam transaksi" and "Bank lain di network yang sama". Each panel shows what that party actually read: amount (or a redaction bar), counterparty line, on-chain artefacts (commitment, nullifier, state hash, memo ciphertext), and a verdict (Terbaca utuh / Laporan terverifikasi / Ditandatangani BI / Dipetakan via view key / Sebagian / Tersegel). Clicking a panel opens "Cara <pihak> membaca transaksi ini" (the function used) and "Yang tercatat di chain".

### 3.2 Stress test TPS

Left sidebar:

1. **Model yang diuji:** checkboxes Zeto, Noto, Stealth.
2. **Alur:** fixed to Transfer RD between banks, so the comparison is fair.
3. **Beban:** preset 50 / 200 / 500 transactions per model, or a custom number; parallel senders 1 / 2 / 4 / 8; time limit 2 / 5 / 10 minutes per model. A model stops at the transaction count or the time limit, whichever comes first.
4. Warning shown when Zeto is selected with more than 2 parallel senders.
5. Start button, which becomes "Hentikan" while running.

Main area:

- **Proses:** one row per model; the models run one after another. Each row shows status, a live per-second TPS sparkline, a progress bar, ok/failed counts, elapsed seconds, current TPS, average TPS and p50 latency.
- **Hasil perbandingan** (after the run): a one-sentence conclusion, horizontal bars of average TPS, a table (avg TPS, peak TPS, p50, p95, ok, failed, duration), a CSV download, and the footnote defining TPS and stating this is the demo cluster, not production capacity.

### 3.3 Visual system

Taken from the prototype; do not restyle:

- Font: IBM Plex Sans; IBM Plex Mono for hashes and JSON.
- Colours: navy `#0E2A52`, background `#F4F6F9`, white cards, line `#DCE2EA`.
- Verdict colours: clear `#0F7B5F`, partial `#9A5B00`, sealed `#9F1D2E` (with a hatched background).
- Model series colours: Zeto `#0E2A52`, Noto `#2F80ED`, Stealth `#8A6BD1`.
- Light theme only, tabular numbers, visible focus rings, `prefers-reduced-motion` respected.
- All UI copy is Indonesian.

## 4. Architecture

```
besu/lensa-privasi/
  server/   Fastify + TypeScript; one process; talks to Paladin nodes and Besu RPC
  web/      React + Vite + TypeScript; static build served by the server in demo mode
```

- **Browser ↔ server:** HTTP JSON for commands. Server-Sent Events for progress (transaction steps, stress-test ticks).
- **Server ↔ chain:**
  - Zeto and Noto: Paladin JSON-RPC on the existing port-forwards (`127.0.0.1:31548/31648/31748/31848`, from `alibaba-kube/Paladin/scripts/port-forward-start.sh`) through the same local Paladin SDK the projects use.
  - Stealth: Besu RPC `127.0.0.1:8545`, through ethers 6.17.0 as in `stealth-address`.
- **Reuse, don't fork.** The server imports the projects' existing library modules:
  - `zeto/src/*`: `bi-report`, `atom`, `instrument`, `common`
  - `noto+pente/bond/src/lib/*`: `loadPlatform`, `executeOutright`, `reconcile`, `helpers`
  - `stealth-address/ts/*`: `stealth`, `memo`, `bond`, `instrument`

  Where flow logic currently lives only inside a script (`zeto/spike-zeto-e2e.ts` helpers, `stealth-address/script/e2e.ts` chain helpers, `noto+pente` `main()` monoliths), the plan extracts it into an importable module inside that project, keeping the script working by calling the new module. Do not copy-paste the logic into the server.
- **Deployment state.** Each model has a one-time `bootstrap` (deploy contracts, create identities and privacy groups, register stealth keys, fund banks) that writes its addresses and keys to `lensa-privasi/server/state/<model>.json` (git-ignored). Normal runs load this file and never redeploy. The UI shows a per-model "siap / belum di-bootstrap" status.

## 5. Backend contract

### 5.1 Model adapter

Each model implements one interface:

```ts
interface ModelAdapter {
  id: 'zeto' | 'noto' | 'stealth';
  capabilities(): Record<FlowId, { enabled: true } | { enabled: false; reason: string }>;
  health(): Promise<{ ready: boolean; detail: string }>;
  run(flow: FlowId, req: FlowRequest, onStep: (s: StepEvent) => void): Promise<FlowResult>;
  lens(result: FlowResult, party: PartyId): Promise<LensView>;   // read from THAT party's node/keys
  transferForLoad(from: PartyId, to: PartyId, amount: bigint): Promise<{ submittedAt: number; confirmedAt: number }>;
}
```

`FlowId` is one of: `rd-issue`, `rd-transfer`, `dfabi-issue`, `dfabi-transfer`, `dvp`. Redeem/withdraw flows are out of scope for the first version (user decision: their semantics differ per model, Zeto `withdraw` exits to public ERC20). Add later as "return to BI".

### 5.2 Capability matrix (initial)

| Flow | Zeto | Noto | Stealth |
|---|---|---|---|
| rd-issue | yes (mint) | yes | yes (`mintStealth`) |
| rd-transfer | yes | **added** (section 7) | yes (`sendStealth`) |
| dfabi-issue | yes | yes (series issuance) | yes (`issueByPartitionStealth`) |
| dfabi-transfer | yes | **added**: plain bond transfer, no payment leg (section 7) | yes (`transferByPartitionStealth` + certificate) |
| dvp | yes (Atom swap) | yes (`executeOutright`: bond leg + cash leg settled through a RestrictedAtom) | yes (DvP escrow; `settle` without waiting for expiry) |

### 5.3 Steps reported per model

Each step is reported with its measured wall-clock duration:

- **Zeto:** Bangun bukti ZK → Kirim ke node Paladin → Masuk block Besu → Laporan BI terverifikasi
- **Noto:** Notary BI memeriksa → Kirim ke node Paladin → Masuk block Besu → State dibagikan ke pihak terkait
- **Stealth:** Alamat stealth & enkripsi memo → Tanda tangan bank → Masuk block Besu → BI memindai dengan view key

Where the SDK does not expose a boundary separately (for example proving inside a Paladin `sendTransaction`), the adapter reports the closest measurable boundary and the step label says so. Never synthesise a split.

### 5.4 How each lens is read (must be real)

- **Zeto:**
  - Sender and receiver: `pstate.queryContractStates` / `balanceOf` on their own node.
  - BI: `BiLedger.pollReports` + `scanChain` on node1.
  - Other bank: the same queries on its node, returning 0 states.
  - On-chain artefacts: `bidx.decodeTransactionEvents`.
- **Noto:**
  - Sender and receiver: private state on their node.
  - BI: the notary's copy on node1.
  - Other bank: the read is refused or empty (as in `bond/src/tests/live-verify-privacy.ts`).
  - On-chain: state hashes and events.
- **Stealth:**
  - Receiver: `scan` with its own view key, then `openMemo`.
  - BI: `scanAll` + `openMemo`.
  - Sender: the data it built.
  - Other bank: `scanView` with its own view key gives 0 matches and `openMemo` gives null. Its panel is amber because amount and token are read from the raw log.

## 6. Stress test semantics

- **One model at a time,** in the order checked. Before each model, the server checks `health()`. An unready model is skipped with the reason shown.
- **Load shape:** a fixed pool of N parallel senders (1/2/4/8). Each sender loops `transferForLoad` between bank pairs (rotating A→B, B→C, C→A so no single UTXO set or nonce is hot) until the transaction count or the time limit is reached.
- **Measurements:**
  - Each transaction counts once its receipt is confirmed.
  - Average TPS = confirmed / (time of last confirmation − time of first submission).
  - Per-second TPS = confirmations in each 1 s bucket.
  - Latency = confirmed − submitted; report p50 and p95.
  - Failures are counted, and the first error message is shown.
- **Pre-funding:** before the timed window, the bootstrap/preflight ensures each bank holds enough balance and, for Zeto, enough unspent UTXOs for the planned count, so the run measures transfers, not minting. Preflight time is not counted.
- **Safety:**
  - The default is 200 tx with 2 senders.
  - Zeto with more than 2 senders requires the warning to be visible. It is not blocked, the presenter decides.
  - "Hentikan" stops new submissions immediately and waits for in-flight receipts up to 30 s.
  - Any receipt-poll call has a timeout, because of the known SDK hang risk in `BACKLOG.md`.
- **Hard rule:** the Zeto adapter only ever goes through Paladin private transactions, never a direct public call to the Zeto contract.
- **Output:** results are kept in memory for the session and downloadable as CSV. No database.

## 7. Changes needed in the existing projects

1. **Noto: RD and DFABI plain transfer.** Add a bank-to-bank transfer using the Noto SDK `transfer` for both the cash and the bond token. The hook exists but no script calls it (`docs/architecture-brief.md:318`). This also enables Noto in the stress test.
2. **Zeto: no change to the project's scripts.** The app's own bootstrap creates BI on node1 and banks on node2..4 (section 7a.6). Any flow helper the app needs is extracted into a new module without changing existing call sites.
3. **Noto: party mapping.** Already BI on node1 and investors on node2..4. Keep it.
4. **Stealth: persistent keys and addresses.** e2e generates random keys per run. Bootstrap must persist bank keys and contract addresses to state. Also give BI the bond view keys, so BI sees DFABI recipients (the custodian caveat in the stealth brief).
5. Every extraction keeps the project's existing e2e script passing.

## 7a. Settled implementation calls (from the builder check)

1. **Stealth banks spend from their stealth addresses, never from a normal account.**
   - Signing from a normal account would reveal the sender and break the amber panel's claim.
   - The adapter picks one received stealth address whose balance covers the amount. If none does, it refuses with "Saldo di satu alamat stealth tidak cukup", and does not split the amount.
   - For the stress test, preflight funds one stealth address per sender and bank pair.
2. **Zeto transactions in the stress test include the BI report** (`buildReport` + `pgroup.sendMessage`).
   - Without the report, BI cannot read the transaction, and the comparison would count transfers BI cannot see.
   - A transaction counts once its receipt is confirmed AND its report message has been accepted by the node.
   - BI's verification (`pollReports`) stays asynchronous and is not counted in TPS.
3. **Zeto issuance:**
   - A spike on the cluster tries the SDK's private `mint` first.
   - If the spike passes, issuance is private.
   - If it fails, issuance uses the existing public mint + deposit, and the other banks' panels are amber with "Nominal dan penerima terlihat saat penerbitan". The panel is never sealed in that case.
4. **Paladin SDK copies:**
   - Each adapter imports its own project's modules, so Zeto uses its local SDK build and Noto uses the npm 1.0.0 release.
   - Client objects never cross adapters.
   - Receipt timeouts are applied in the adapters by wrapping calls with a deadline, not by patching either SDK.
5. **Stress-test funding happens before the meeting.**
   - `npm run preflight -- --prepare 500` funds every model for up to 500 transactions per model.
   - The UI shows "Kapasitas siap: N tx" per model and caps the presets and the custom number at N.
   - Clicking Start never waits on funding.
6. **The Zeto BI move to node1 lives only in this app's bootstrap.**
   - The app creates its own identities (`bi@node1`, `bankA@node2`, `bankB@node3`, `bankC@node4`), tokens and privacy groups.
   - The `zeto` project's own scripts and `bi@node4` stay untouched, because other sessions are working on that project.
   - The same applies to Noto and Stealth: the app deploys its own instances and does not change shared deployments.

## 8. Testing

- **Server:** vitest.
  - Unit tests for the stress-test statistics (average TPS, buckets, p50/p95), the capability matrix, and request validation.
  - One live smoke test per adapter, run manually against the cluster: one `rd-transfer` plus all lenses, asserting that the third bank's lens is sealed (or partial for Stealth).
- **Web:** vitest for the amount formatting and state logic, plus one Playwright smoke test that loads the app with a mocked backend and clicks through send and stress test.
- **Before any demo:** a preflight command (`npm run preflight`) checks the port-forwards, the health of all three adapters, and the balances.

## 9. Known risks

- **Paladin node restart under Zeto proving.** Mitigations: the 2-sender default, the warning, and the 3-CPU limit already applied.
- **Paladin sequencer stall** (no receipt for more than 10 min). Mitigation: receipt timeouts; a failed transaction shows its reason in the response panel.
- **Zeto N6 duplicate-input bug** when transferring more than the unlocked balance. Mitigation: check balance before every transfer.
- **Besu `eth_getLogs` range cap.** Stealth scans start from a recent `fromBlock` stored in state.
- **Port-forward drops.** The header connection dots come from a real health poll every 5 s, so they turn red when a link drops.

## 10. Decisions made in brainstorming

Decisions by the user:

- The audience is BI management.
- The core message is that only the sender bank, the receiver bank and BI see a transaction in full.
- The app runs live against this repo's projects.
- Layout B (single screen) was chosen, kept intuitive, interactive and simple-professional.
- 4 Paladin nodes, BI included.
- Flows are split into RD and DFABI.
- The stress test compares the models side by side, with a small but effective set of settings, a live progress view, and results.

Decisions by Claude, open to review:

- Redeem flows dropped from v1 (user decision).
- Fictional bank names.
- IBM Plex type.
- Light theme.
- Stealth panel shown amber, not sealed.
- The stress test uses only the Transfer RD flow.
- Models run sequentially.
- The definition of TPS.
- The stack is React + Vite and Fastify, with SSE for progress.
- Zeto BI moves to node1.
- Noto RD transfer is added.

## 11. Left to the builder

- Component breakdown, file layout inside `server/` and `web/`, and the state management approach. Plain React state is likely enough; don't add a library without need.
- Exact JSON shapes beyond the interface in section 5.
- The CSV column order.
- How extraction modules are named inside each project.
