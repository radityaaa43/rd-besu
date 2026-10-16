# Zeto RD + DFABI exploration (Paladin on Besu)

This is a standalone exploration of Paladin's `zeto` domain for RD (cash) and DFABI (bond). It
runs on the Alibaba ACK Paladin v1.0.0 cluster (`paladin-node1..4`, namespace `paladin`). It is
not integrated with the Noto+Pente backend in `platform-rd-dfabi`.

## Setup

1. Start the port-forwards to the four Paladin nodes on 127.0.0.1:31548, 31648, 31748 and 31848,
   as listed in `config.json`. The script that does this is `alibaba-kube/Paladin/scripts/port-forward-start.sh`.
2. Run `npm install`. The SDK is resolved from the local Paladin source at
   `/home/ecs-user/eksplorasi-paladin/paladin/sdk/typescript`.
3. Run `npm run typecheck`.

All three scripts are dry-run by default. Pass `--execute` to send transactions.

| Script | What it does |
|---|---|
| `bootstrap-zeto.ts` | Phase 1. Deploys RD-Zeto and DFABI-Zeto. Both are `Zeto_AnonNullifierKyc` tokens backed by an ERC20, following Paladin's `examples/private-stablecoin`. Writes `out/zeto-contract-data.json`, which is gitignored. |
| `smoke-zeto.ts` | Makes a 1-unit private transfer and a withdraw on each token. |
| `spike-zeto-dvp-zz.ts` | Option A. Runs the full lifecycle with both tokens on Zeto_Anon and no Noto: issuance, private transfer, Zeto-vs-Zeto DvP and withdraw. See "Zeto-vs-Zeto DvP" below. |
| `spike-bi-messaging.ts` | Option A step 1: tests the Pente privacy-group channel {bank, bi@node4}, including the case where BI's node is down (M1-M5). |
| `spike-zeto-bi.ts` | Option A steps 3-4: runs the lifecycle with each bank reporting to BI, BI verifying against chain, and BI flagging a rogue unreported transfer. See "Option A: BI reporting". |

Run a script like this: `npx ts-node spike-zeto-dvp-zz.ts --execute`.

The Noto-vs-Zeto DvP spike was removed on 2026-10-16 (user decision: Zeto-only; Noto needs the
notary online). It is in git history before this commit.

## Layout

- `src/common.ts` is a minimal stand-in for Paladin's `examples/common`.
- `src/atom.ts` and the Atom ABIs in `abis/` are copied from `examples/swap`.
- `ops/backup-pld-node*-1792061433.yaml` holds the `pld` CRs as they were before the Zeto domain
  install. They are the rollback artifacts.

## Zeto domain install (2026-10-15)

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

## DvP findings

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

## Poison-pill bug (v1.0.0)

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

## Zeto-vs-Zeto DvP (option A)

`npx ts-node spike-zeto-dvp-zz.ts --execute` runs the whole lifecycle for both tokens on
`Zeto_Anon`, with no Noto. Each step and the upstream code it follows:

1. Issuance: deploy a Zeto_Anon token plus an ERC20, link them with `setERC20`, then do the
   public mint, approve, and deposit into the private side. This is `examples/private-stablecoin`
   at v1.0.0 without the KYC registration.
2. A 1-unit private transfer of each token.
3. DvP: S1 (happy path), P (privacy), N1-N4 (negative cases), F1a/F1b/F2 (aborts and a cancelled
   Atom) and C (4 parallel swaps). Both legs are the Zeto leg
   of `examples/swap` at v1.0.0: lock, then prepareTransferLocked, then a re-encoded
   transferLocked inside the Atom, then delegateLock to the Atom, then execute. Upstream has no
   Zeto-for-Zeto example; `pvp_test.go` has only `TestNotoForNoto`, `TestNotoForNotoWithHooks`
   and `TestNotoForZeto`.
4. Withdraw to ERC20: RD is cashed out by the seller, and DFABI is redeemed by the buyer.

Results on the ACK cluster (2026-10-16):

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

## Option A: BI reporting

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
