# Zeto RD + DFABI exploration (Paladin on Besu)

This is a standalone exploration of Paladin's `zeto` domain for RD (cash) and DFABI (bond). It
runs on the Alibaba ACK Paladin cluster (platform below) (`paladin-node1..4`, namespace `paladin`). It is
not integrated with the Noto+Pente backend in `platform-rd-dfabi`.

## Platform

- Paladin: upstream `main` at 559567e38 merged with upstream PR #1189 "Zeto V1 support with multi-version support" (merge commit 82fbd49ce), worktree `/home/ecs-user/eksplorasi-paladin/build-v1/paladin` (branch `build-main-zeto-v1`). All platform facts below are read from there.
- Zeto contracts v0.5.1, V1 axis: tokens are deployed with `tokenName: "Zeto_AnonNullifier"` (since the 2026-11-09 nullifier switch below; earlier V1 tokens used `Zeto_Anon_V1`), `domainConfigSchema: "v1"`, `zetoVariant: 1`, `factoryVersion: 1` (`ZETO_V1` in `src/zeto-v1.ts`, copied from `examples/swap/src/index.ts:136-143`). A pool left on the V0 axis reverts on its first proving call.
- Gas (2026-11-09): Paladin gives every Zeto base-ledger tx the domain's `defaultGasLimit` and never estimates (default 4,000,000). A `Zeto_AnonNullifier` mint or transfer inserts its outputs into the on-chain SMT, and that cost grows with the tree: a 5-output mint took 2.70M gas on an empty tree and needed 5.36M at 5 leaves, so the old limit ran out of gas. Operator v1.0.0 rebuilds a CR-defined domain wholesale and cannot set the limit, so the `zeto` domain is now defined statically in each `Paladin` CR (`node1..4` `spec.config.domains.zeto`, `defaultGasLimit: 30000000`), and the `zeto` label selector was removed from `spec.domains`. **A change to the zeto domain config (for example a new implementation row) must now be made in all four `Paladin` CRs. Editing the `PaladinDomain` `configJSON` no longer reaches the nodes.** Patch and backups: `/home/ecs-user/eksplorasi-paladin/build-v1/v1-manifests/nullifier/` (`paladin-cr-static-zeto-gas.patch.json`, `gas-backup-*/`). The operator rolls each StatefulSet itself after a CR change.
- Nullifier switch (2026-11-09, applied; Lensa RD `0x0b91f511…` (redeployed 2026-11-09 after the SMT divergence; the first nullifier RD was `0x08106229…`), DFABI `0x374725a4…`; smoke `spike-nullifier-smoke.ts`): new tokens are `Zeto_AnonNullifier` v0.5.1 (`ZETO_V1.tokenName`). The name must be exact: Paladin's `IsNullifiersToken()` matches that string, so a `_V1` suffix would silently drop nullifiers and the SMT. Registering it overwrites the retired v0.2.2 `Zeto_AnonNullifier` entry in the shared factory (existing clones are unaffected). CRs and the domain config: `/home/ecs-user/eksplorasi-paladin/build-v1/v1-manifests/nullifier/` (`gen_v1_nullifier_manifests.py`, per upstream `config-for-deploy-fungible-v1.yaml`: lock settle uses `Groth16Verifier_Anon` and circuit `anon`). After the switch, the V0 rollback below must NOT be re-applied: its `Zeto_AnonNullifier` row would deploy v0.5.1 clones with V0 circuits. Impact on BI: a transfer's on-chain inputs are nullifiers, so BI cannot name the sender of an unreported bank-to-bank output (`senderOf` returns `unknown-input-owner`); reported outputs and the Lensa views, which name the sender from the reporter, are unchanged.
- V0 retired (2026-10-21; the V1 row was renamed `Zeto_AnonNullifier` on 2026-11-09): the `zeto` PaladinDomain config then listed only `Zeto_Anon_V1`, so a V0 deploy (`Zeto_Anon`, `Zeto_AnonEnc`, `Zeto_AnonNullifier`, `Zeto_AnonNullifierKyc`) is refused with `PD210000`. The v0.2.2 contracts and old V0 tokens stay on chain (immutable) and are unused; the factory proxy is shared with V1 and must stay. Backup of the old config and rollback input: `out/domain-v0-removal-backup-20261021/` (re-apply `configJSON.live.json`, then restart the four pods one at a time, since the operator updates the ConfigMap without rolling the StatefulSets).
- Proving keys: the zeto domain loads the zeto v0.5.1 *test* proving keys (`zeto-test-proving-keys.tar.gz`, `domains/zeto/build.gradle:64-67` in the paladin fork), made without a trusted-setup ceremony. Accepted PoC limit; `zeto@v0.5.1:README.md:28` says production proving keys must come from a documented, decentralized ceremony or one trusted party.
- Prover: rapidsnark `main`, which is thread-safe. The earlier concurrent "Invalid proof" reverts (multi-token stress, V0 section below) were caused by the non-thread-safe rapidsnark v0.0.7 ThreadPool.
- Topology: node1 = BI (`bi`, `cashIssuer`, `bondIssuer`, `bondCustodian` are all BI), node2-4 = banks (`investor2@node2`, `investor3@node3`, `investor4@node4`). node4 is no longer BI.
- Everything written before this section about v1.0.0 (KYC tokens, `lock` / `prepareTransferLocked`, the poison pill, node4 as BI) is kept as history and is marked "V0 / Paladin v1.0.0".
- Typecheck: the SDK's generated ABI JSONs (`sdk/typescript/src/domains/abis/`) only exist after the gradle build, which has not run. `npm run typecheck:v1` (`tsconfig.check-v1.json`) typechecks against the merged SDK sources; its only errors are the missing generated `./abis/*.json` imports. `npm run typecheck` uses `node_modules/@lfdecentralizedtrust/paladin-sdk`, which resolves to the old v1.0.0-era checkout until `npm install` is re-run against the new path in `package.json`.


## Setup

1. Start the port-forwards to the four Paladin nodes on 127.0.0.1:31548, 31648, 31748 and 31848,
   as listed in `config.json`. The script that does this is `alibaba-kube/Paladin/scripts/port-forward-start.sh`.
2. Run `npm install`. The SDK is resolved from the local Paladin source at
   `/home/ecs-user/eksplorasi-paladin/build-v1/paladin/sdk/typescript`.
3. Run `npm run typecheck`.

All three scripts are dry-run by default. Pass `--execute` to send transactions.

| Script | What it does |
|---|---|
| `bootstrap-zeto.ts` | Phase 1. Deploys RD-Zeto and DFABI-Zeto as Zeto V1 `Zeto_Anon` tokens backed by an ERC20 (V1 constructor params from `examples/swap`), both owned by BI on node1. Writes `out/zeto-contract-data.json`, gitignored. |
| `smoke-zeto.ts` | Makes a 1-unit private transfer and a withdraw on each token. |
| `spike-zeto-dvp-zz.ts` | Runs the full lifecycle with both tokens on V1 `Zeto_Anon` and no Noto: issuance, private transfer, Zeto-vs-Zeto DvP with the V1 lock lifecycle (`createLock`, `prepareSpendLock`, `delegateLockV1`, Atom) and withdraw. See "Zeto-vs-Zeto DvP". |
| `spike-bi-messaging.ts` | Option A step 1: tests the Pente privacy-group channel {bank, bi@node1}, including the case where BI's node (node1) is down (M1-M5). |
| `spike-zeto-bi.ts` | Option A: banks (node2-4) report to BI (`bi@node1`) over `{bank, bi@node1}` groups, BI verifies against the chain and its own state store, and flags a rogue unreported bank-to-bank transfer. See "Option A on the V1 topology". |
| `spike-zeto-bi-offline.ts` | BI-offline test: node1 (BI) goes down, banks node2 <-> node3 keep settling, queued reports are verified when node1 returns. Deletes a pod only with `--delete-pod`. |
| `spike-zeto-e2e.ts` | Happy and negative path per feature (groups via `--only=`); writes `docs/e2e-report-v1.md`. |
| `spike-private-mint.ts` | BI privately `mint`s RD to a bank, the bank reports, BI verifies. |
| `stress-zeto-tps.ts` | TPS stress of private RD transfers on a V1 token; BI mints, banks (node2-4) send. See "Stress". |
| `spike-zeto-instrument.ts` | Instrument-data registry check (needs `out/zeto-contract-data.json`). |

Run a script like this: `npx ts-node spike-zeto-dvp-zz.ts --execute`.

The Noto-vs-Zeto DvP spike was removed on 2026-10-16 (user decision: Zeto-only; Noto needs the
notary online). It is in git history before this commit.

## Layout

- `src/common.ts` is a minimal stand-in for Paladin's `examples/common`.
- `src/atom.ts` and the Atom ABIs in `abis/` are copied from `examples/swap`.
- `src/zeto-v1.ts` is the V1 lock lifecycle (`createLock`, `prepareSpend`, `delegateLock`, `cancelLock`, `tamperedCall`) shared by the scripts and `src/flows.ts`; `abis/ZetoV1Events.json` holds the V1 Zeto events (hand-written from zeto-contracts v0.5.1, because the Paladin repo only generates them at gradle build time).
- `ops/backup-pld-node*-1792061433.yaml` holds the `pld` CRs as they were before the Zeto domain
  install. They are the rollback artifacts.

## Zeto domain install (2026-10-15, V0 / Paladin v1.0.0)

The cluster runs `zeto` alongside `noto` and `pente`. The steps were applied in this order, after
a clean pre-check on all 4 nodes:

1. `kubectl apply -n paladin` every `~/paladin-v1/core_v1alpha1_*zeto*.yaml`. This covers the
   PaladinDomain `zeto`, 24 SmartContractDeployments and 4 `registerImplementation` TransactionInvokes.
2. The 4 invokes reverted with `OwnableUnauthorizedAccount`. The samples send from `zeto.operator`,
   but the factory's owner is the proxy deployer. The fix was
   `kubectl patch transactioninvoke <name> --type merge -p '{"spec":{"from":"zeto_factory_proxy.operator"}}'`.
3. `{labelSelector: {matchLabels: {paladin.io/domain-name: zeto}}}` was added to `pld node4`,
   then to node3, node2 and node1 (JSON patch `add /spec/domains/-`). Each pod restarts once and
   logs `Domain plugin registered name=zeto address=0x753a64ea...`.

Rollback: remove the zeto entry from each `pld` `spec.domains`. The on-chain Zeto contracts
stay but are unused.

The log line `PD210102: Not implemented. See state receipt for coin transfers` is known noise.
The v1.0.0 Zeto domain has no domain receipt, so it is harmless.

## DvP findings (V0 / Paladin v1.0.0)

- KYC tokens cannot do DvP. Upstream (`domains/integration-test/zeto_fungible_test.go:264` at
  v1.0.0) supports lock and transferLocked only on `Zeto_Anon`, and the v1.0.0 image ships no KYC
  transferLocked circuit (`build.gradle:266-272` at v1.0.0).
- A locked Zeto UTXO cannot be reclaimed once `prepareTransferLocked` has run. The
  reclaim fails with `PD210134: Failed to query states by IDs`
  (`domains/zeto/internal/zeto/fungible/handler_transferLocked.go:325` at v1.0.0), because the
  UTXO is no longer available to the reclaim. This is observed in test F1b; the root cause was
  not traced in the source.
- `Atom.cancel()` has no access control. If anyone cancels an Atom after both legs are delegated,
  both locks are stuck permanently. To avoid that, create the Atom, delegate both legs and execute
  in one step.

## Poison-pill bug (V0 / Paladin v1.0.0, fixed upstream on main)

A PUBLIC tx sent to a Zeto contract (in this repo, only `setERC20`) can crash the Paladin node
that sent it. The pod then goes into CrashLoopBackOff. This was seen on `paladin-node1` on
2026-10-16.

How it happens:

1. The sequencer's resume loop, `core/go/internal/sequencer/sequencer.go:160-200`, runs at
   startup and then every 5 minutes (`transactionResumePollInterval`).
2. It picks up every tx without a receipt. The query at
   `core/go/internal/txmgr/transaction_query.go:206-208` does not filter on tx type, so PUBLIC
   txs are included.
3. Each one is passed to the domain's `InitTransaction`. The Zeto `GetHandler`
   (`domains/zeto/internal/zeto/zeto.go:338-364`) has no case for `setERC20` and returns nil.
4. The `IsNil` check at `zeto.go:435` then panics:
   `reflect: call of reflect.Value.IsNil on zero Value`.

The crash is a race. It only fires if the 5-minute tick lands while a `setERC20` is still waiting
for its receipt. After the first crash it repeats on every boot.

Recovery (dev cluster, approved by the user):

1. Back up the rows, then delete the tx's `transaction_history` and `transactions` rows in the
   node's postgres. Keep `public_txns` and its binding, so the nonce accounting stays intact.
2. On restart, the block indexer writes the receipt again from the chain. On chain the tx had succeeded.

Mitigation in `spike-zeto-dvp-zz.ts`: every token set is deployed and linked with `setERC20` in
one up-front phase, and each call is awaited before any other tx. This is a mitigation, not a
fix. It only makes the window smaller. Any app that calls `setERC20` on v1.0.0 has the same risk.

**Status on Paladin main:** fixed upstream, the sequencer resume query now filters `type = private`.
The up-front `setERC20` phase is therefore now optional. The scripts keep it and say so in a comment.

## Zeto-vs-Zeto DvP

`npx ts-node spike-zeto-dvp-zz.ts --execute` runs the whole lifecycle for both tokens on V1
`Zeto_Anon`, with no Noto. BI (node1) owns the tokens and is the bond seller; the buyers are banks
on node2-4. Each step and the upstream code it follows:

1. Issuance: deploy a V1-axis `Zeto_Anon` (`ZETO_V1`) plus an ERC20, link them with `setERC20`,
   then do the public mint, approve, and deposit into the private side
   (`examples/private-stablecoin`, no KYC). Private `mint` by the token owner is the other path.
2. A 1-unit private transfer of each token.
3. DvP: S1 (happy path), P (privacy), N1-N4 (negative cases), F1a/F1b/F2 (aborts and a cancelled
   Atom) and C (4 parallel swaps). Both legs are the cash leg of `examples/swap` after PR #1189,
   applied to both tokens. V1 call sequence per leg (`src/zeto-v1.ts`):
   1. `createLock` by the owner, naming the spend recipient and amount (pinned now, not at spend time).
   2. Read the `lockId` from the lock-info state in the `getStateReceipt` of that tx.
   3. `prepareSpendLock` (a prepared, unsent tx), re-encode `spendLock(lockId, spendArgs, data)` for the Atom.
   4. Create one Atom holding both legs' `spendLock` calls.
   5. `delegateLockV1` on each pool, `newSpender = Atom` (public tx from the lock's creator).
   6. `Atom.execute`, which calls `spendLock` on both pools atomically.
   Reclaim is `cancelLock` (spender only). Upstream still has no Zeto-for-Zeto example.
4. Withdraw to ERC20: RD is cashed out by the seller, and DFABI is redeemed by the buyer.

**V1 vs V0, what changed for DvP.**

- Recipient and amount are pinned at `createLock`; the Atom still does not compare them to the agreed terms (finding D9 stays).
- A tampered output now reverts with `InvalidUnlockHash` (the pool compares keccak of the outputs to the
  `spendCommitment` fixed at `createLock` before it verifies the proof); V0 reverted with `Invalid proof`.
- `delegateLockV1` and `cancelLock` only work for the current spender. Once a lock is delegated to an Atom,
  the owner cannot `cancelLock` it, so a third-party `Atom.cancel()` still strands both locks.
- The V0 finding "a locked UTXO cannot be reclaimed once prepared (PD210134)" came from the V0
  `transferLocked` handler reading its inputs as available states. The V1 handlers read locked coins by id
  (`domains/zeto/internal/zeto/fungible/states.go:234`), so the mechanism is gone. Whether the sequencer still
  holds the coins for a prepared tx is not known from source: the F1b scenario (`spike-zeto-dvp-zz.ts`) and group `f1b` (`spike-zeto-e2e.ts`) **record** the outcome on the next live run.
  No V1 result exists yet; the V0 results below are history.

### V0 / Paladin v1.0.0 results

Results on the ACK cluster (2026-10-16, V0 / Paladin v1.0.0, KYC baseline and `lock` / `transferLocked`):

- The DvP-only run passed all 30 checks.
- The first full-lifecycle run stopped at 27/31 when node1 crashed (see "Poison-pill bug").
- After the up-front `setERC20` phase was added, the full-lifecycle run passed all 36 checks:
  - I x2, T x2: issuance and transfer.
  - S1, P x2, N1 x4, N3 x2, N2 x4, N4 x2: the swap, privacy and negative cases.
  - F1a x3, F1b x5, F2 x5: aborts and the cancelled Atom.
  - C x2: 4 parallel swaps, which settled in 16s.
  - W x2: withdraw. The seller cashed out 10 RD and the buyer redeemed 100 DFABI, and private
    balance, public balance and Zeto escrow all moved by exactly that amount.

  node1 did not restart during the run.

Findings, on both legs this time:

- A locked UTXO cannot be reclaimed once `prepareTransferLocked` has run (`PD210134`).
- A third party can call `Atom.cancel()`, and both locks then stay stuck.
- A tampered output on either leg makes execute revert with `Invalid proof`, and nothing moves.

| | KYC baseline (`bootstrap-zeto.ts`, `smoke-zeto.ts`) | All Zeto_Anon (`spike-zeto-dvp-zz.ts`) |
|---|---|---|
| Token | `Zeto_AnonNullifierKyc` | `Zeto_Anon` |
| Issuance (ERC20 deposit) | yes | yes |
| Private transfer | yes | yes |
| Withdraw to ERC20 | yes | yes |
| DvP through an Atom | not possible on v1.0.0: no KYC lock/transferLocked circuit | yes, both legs |
| KYC (only registered identities can hold) | yes | no: anyone can receive |
| Nullifiers (spent UTXOs unlinkable) | yes | no: spends are linkable on chain |

## Option A on the V1 topology (BI on node1)

BI moved from node4 to node1, the node that also hosts `cashIssuer`, `bondIssuer` and `bondCustodian`
(all of them ARE BI). Banks are node2-4. Reporting is unchanged for banks and cheaper for BI:

- Every bank has a Pente group `{bank, bi@node1}` and reports each tx it sends or receives (`zeto-report-v1`).
- BI-originated transactions (issuance by cashIssuer/bondIssuer, BI's own DvP leg, bondCustodian transfers
  and withdraws) need no report: BI's node1 already holds those states. `BiLedger.adoptOwnStates()`
  (`src/bi-report.ts`) reads node1's state store, recomputes each commitment and, if it is an output on
  chain, marks it verified with reporter `bi-own-state`. `scanChain()` calls it.
- Bank-to-bank outputs (node2 <-> node3 ...) exist only on the banks' nodes. Without a bank report BI
  cannot adopt them, so they are still flagged `unreported` after the grace period (scripts `spike-zeto-bi.ts` step R
  and `spike-zeto-e2e.ts` B6 send a rogue investor2 -> investor3 transfer without a report).
- Privacy checks: the two DvP parties see states of the swap; a non-party bank (node3 before it
  receives anything, node4) holds no states and no report messages.
- BI offline now means node1 down, which also stops the issuers: banks keep trading with the balances they
  already hold, but no mint/deposit by BI and no BI legs (`spike-zeto-bi-offline.ts`, see its header).
- V1 lock txs: `createLock` and `spendLock` are signed by the lock owner's own key, not a one-time key
  (`RequiredSigner` in `handler_create_lock.go:493`, `handler_spend_lock.go:377`), so the base-ledger signer of a lock tx
  does name the party. Plain `transfer`/`mint`/`deposit` still use the sequencer's one-time key. The BI attribution
  code still goes through the spent inputs for all of them.
- Event decoding uses the V1 ABI (`abis/ZetoV1Events.json`): `ZetoLockCreated`, `ZetoLockSpent`,
  `ZetoLockCancelled` replace `UTXOsLocked`.

The sections below are the **V0 / Paladin v1.0.0** results of the same design with BI on node4.

## Option A: BI reporting (V0 / Paladin v1.0.0 results, BI on node4)

Plan: `docs/plans/2026-10-16-option-a-bi-reporting.md`. Aim: BI (`bi@node4`) sees every Zeto tx
in full (amount and parties). Other banks see nothing. Txs keep working when BI's node is down,
and DvP stays atomic. Only official v1.0.0 components are used: no image patch and no custom circuit.

Zeto sends a state only to its owner (`domains/zeto/internal/zeto/fungible/states.go:62` at
v1.0.0), so BI is never sent anything by the protocol. Option A closes the gap off-chain:

- **Channel.** Each bank has one Pente privacy group with BI, `{bank, bi@node4}`, created once at
  onboarding. After each tx the bank sends a `pgroup_sendMessage` with topic `zeto-report-v1`.
  It carries each output's plaintext amount, salt and owner, plus the commitment.
- **Verification.** BI recomputes `Poseidon(amount, salt, owner.x, owner.y)`
  (`domains/zeto/pkg/types/states.go:66-80`). It then matches the result against the outputs the
  tx emitted on chain, decoded from node4's own block indexer
  (`bidx_decodeTransactionEvents`). The events come from the v1.0.0 Zeto ABIs: `UTXOMint`,
  `UTXOTransfer`, `UTXOTransferWithEncryptedValues`, `UTXOWithdraw`, `UTXOBurn` and
  `UTXOsLocked` (outputs plus lockedOutputs). The code is in `src/bi-report.ts`.
- **Unreported detection.** BI also scans every Zeto output on the contracts it supervises.
  After a grace period, any output without a verified report is flagged `unreported`.
- **Who reports.**
  - Deposits are reported by the depositor, and transfers and withdraws by the sender.
  - In a DvP, each locker reports its lock. The seller reports both legs and the buyer reports
    the cash leg. BI merges duplicate reports by commitment.

Run it: `npx ts-node spike-bi-messaging.ts --execute [--no-restart]`, then
`npx ts-node spike-zeto-bi.ts --execute`.

Results on ACK (2026-10-16):

- **Messaging, M1-M4 PASS.**
  - The group was created and node4 read back its members and contract.
  - A report reached node4 0.25 s after it was sent, and node3 saw nothing.
  - While node4 was down (pod deleted at 11:55:14Z), investor2's 3 sends were all accepted.
    All 3 reached node4 at 11:55:46Z, after the restart, in send order.
- **Messaging, M5.** `createGroup` while node4 was down waited until node4 came back, then
  completed after 38 s. That is acceptable, because groups are only created at onboarding.
- **Reporting, 16/16 PASS.**
  - BI verified every output of I, T, S1 and W: 20 outputs.
  - mismatch = 0.
  - The DvP cash leg was reported twice and merged once.
  - investor3 held no reports and no states at any step.
  - Reports with a wrong amount, salt or owner were rejected as `mismatch`.
  - BI's own chain scan matched all 20 outputs.
  - A rogue transfer sent without a report had both of its outputs flagged `unreported` after
    20 s, attributed to investor2.

Findings:

- **The base-ledger signer is a one-time key.** Paladin signs Zeto txs as
  `domains.<contract>.submit.<uuid>` (`core/go/internal/sequencer/coordinator/coordinating.go:411`
  at v1.0.0). The event `submitter` and `tx.from` therefore never name the bank. BI attributes a
  tx through the inputs it spends instead: those are UTXOs BI already verified, and only their
  owner can spend them. If an input was never reported, the sender shows as `unknown-input-owner`.
- **Group names.** A group name may not contain `@` (`PD020005`,
  `core/go/internal/groupmgr/manager.go:234`).
- **Ordering.** The docs say private messages carry no ordering or non-repudiation guarantee
  (`doc-site/docs/architecture/pente.md:130-134`). The order observed in the test is not a
  guarantee, and that is why verification against the chain is mandatory.

Limits:

1. BI visibility is enforced by procedure plus detection, not by the protocol. A bank can
   withhold a report, but it cannot hide that the tx happened.
2. Attribution comes from the spent inputs, so it only works if those inputs were reported.
   After a chain of unreported txs, the sender shows as `unknown-input-owner`, but the outputs
   are still flagged.
3. BI cannot prove that a reported receiver key belongs to the bank it claims. That relies on
   the KYC key registry built at onboarding.
4. Private group messages carry no ordering or non-repudiation guarantee
   (`doc-site/docs/architecture/pente.md:130-134`), so chain verification is mandatory.
5. DvP stays on Zeto_Anon: no token-level KYC, and spends are linkable. The v1.0.0 poison-pill
   and `Atom.cancel()` issues above still apply.
6. Creating a group needs BI online. In M5 it blocked until node4 was reachable again.

BI totals for the 16/16 run: verified = 20, mismatch = 0, unreported = 2 (the rogue tx's two
outputs), duplicates merged = 1.

| | Stealth on Besu (`../stealth-address`) | Zeto Option A (Zeto_Anon + BI reports) | KYC baseline (`Zeto_AnonNullifierKyc`) |
|---|---|---|---|
| Other banks see the amount | yes (public) | no | no |
| Other banks see the sender | yes (public) | no (the signer is a one-time key) | no |
| Other banks see the receiver | no (stealth address) | no | no |
| How BI sees txs | the view key each bank hands BI at onboarding; BI scans every announcement | a verified report from each bank, checked against chain; unreported outputs are flagged | not covered (only the owner gets states) |
| Can a bank withhold from BI? | no | yes, but it is detected and attributed through the spent inputs | n/a |
| Works with BI's node down | yes | yes; reports queue and arrive later (M4) | yes |
| Atomic DvP | yes, see `../stealth-address` DvP design | yes, through an Atom (36/36) | not possible on v1.0.0 |
| Token-level KYC | custodian certificate | no | yes |
| Official components only | own contracts on Besu (no Paladin) | yes: Paladin v1.0.0 Zeto, Pente and Atom, unpatched | yes |

## Stress

`npm run stress -- --execute` (`stress-zeto-tps.ts`) deploys a V1 `Zeto_Anon`, `cashIssuer@node1` (BI) privately
`mint`s to the sender identities, and the banks send 1-unit transfers. `--sender-nodes` defaults to `2,3,4`
(banks). All monitoring (pods, CPU, restarts, stop rules) is unchanged. Earlier numbers (about 18.5 TPS on 4
nodes with 1 token; multi-token and batch broke) are **V0 / Paladin v1.0.0**; multi-token is expected to work
on rapidsnark main and has not been re-measured.

## Instrument data (RD and DFABI)

`src/instrument.ts` builds the RD record and the DFABI record for the Zeto tokens. The shape,
the field catalog and the rules are shared with the stealth track
(`../docs/instrument-data-spec.md`, `../docs/instrument-data/bdt-v1.2.catalog.json`). The DFABI
record uses only the ICMA BDT v1.2 fields the user approved (42 catalog ids), and RD is a short
cash record in `extensions.cash`. Only the Zeto values live in this builder: DLT Platform
Information (Name `Paladin zeto domain`, Smart Contract = the Zeto token) and the token addresses.
Validation and the hash rule are the stealth track's `validateRecord` and `recordHash`, reached
through `src/stealth-check.mjs`, because that module is native-TypeScript ESM and this package is
CommonJS. The sample inputs in `docs/samples/` are test data with valid ISIN and LEI check digits.

`abis/InstrumentRegistry.json` (abi and bytecode) is copied from stealth-address 8a89bc3.

Run: `npx ts-node spike-zeto-instrument.ts --execute`. It deploys the registry with a Paladin
PUBLIC tx, allow-lists the two issuers, registers RD (by cashIssuer) and DFABI (by bondIssuer),
reads both back, and matches each on-chain `dataHash` with `recordHash` of the stored JSON. It also
registers a corrected DFABI record as version 2 and checks that a non-registrar is rejected.

Result on ACK (2026-10-16): 8/8 checks pass. The registry is not a Zeto contract, so the
v1.0.0 poison-pill does not apply. The PUBLIC-tx read-back returns `bytes32` without a `0x` prefix.

## Lock check (S21 gate)

`lock-check.ts` runs the V1 lock lifecycle for ONE party on its own node, through that party's own gateway and identity:
`createLock` -> `delegateLock` (to the owner's own eth address, so it can still cancel) -> `cancelLock`. It does NOT run `prepareSpendLock`: a prepared spend keeps the locked coin reserved in the coordinator until a node restart, so a later `cancelLock` of that lock fails with `PD011615 Input state 0 not found` (live 2026-11-12). Any failure after `createLock` prints `LOCK LEFT OPEN lockId=...` and stops (no cleanup cancel).
It prints the balance after each step and exits 1 on any failed step (with a best-effort cleanup `cancelLock` if a lock exists).
It runs against the LIVE node: it moves 1 unit into a lock and cancels it, net zero.

```bash
LENSA_GW_MTLS_DIR=<dir with ca.crt, lensa.crt, lensa.key> \
LOCK_CHECK_URL=https://<party gateway>:8548 \
LOCK_CHECK_TOKEN=<RD Zeto token address> \
LOCK_CHECK_OWNER=bankA@node2 LOCK_CHECK_TO=bankB@node3 LOCK_CHECK_AMOUNT=1 \
npm run lock-check
```

`LOCK_CHECK_OWNER`, `LOCK_CHECK_TO` and `LOCK_CHECK_AMOUNT` show their defaults. `LOCK_CHECK_TO` is resolved through the owner's
node, so it also proves cross-node identity resolution. `LOCK_CHECK_SERVERNAME` sets the TLS servername only if the gateway cert needs it.
Expected last line: `L6 zeto LOCK: PASS`. A failure prints `L6 zeto LOCK: FAIL <step>: <message>`.
