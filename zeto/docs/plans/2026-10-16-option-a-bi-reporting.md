# Option A: BI sees every Zeto transaction through verified Paladin reports

Date: 2026-10-16. Status: approved by the user, in execution.

## Goal

Meet the user's three requirements using official Paladin v1.0.0 components only (no image patch, no custom circuit):

- R1: only BI, the sender and the receiver see a transaction in full (amount, parties) for RD, DFABI and DvP.
- R2: transactions keep working while BI's node is down.
- R3: DvP is atomic.

Zeto already gives R2 and R3 (`spike-zeto-dvp-zz.ts`, 36/36) and hides everything from other banks. BI is the missing piece: Zeto distributes state only to the owner (`domains/zeto/internal/zeto/fungible/states.go:62` at v1.0.0). Option A closes the gap without modifying Paladin. After every transaction, the sending bank's app reports the plaintext to BI over a Pente privacy-group message (`pgroup_sendMessage`). BI then verifies each report against the chain.

## Design

- **Identities.** `bi@node4` is BI. Banks: `bondCustodian@node1` (seller), `investor2@node2` (buyer), `investor3@node3` (third bank, must see nothing). node4 is BI's node, so restarting node4 for the offline test does not touch node1 (cashIssuer, bondIssuer, backend identities).
- **Channel.** One Pente privacy group per bank, `{bank, bi@node4}`, created once at onboarding (BI must be online then). Reports go via `pgroup_sendMessage`. Paladin stores the message locally (`core/go/internal/groupmgr/messages.go:89-105`) and delivers it to each remote member node as a reliable message (`messages.go:110-125`) over the gRPC transport (port 9000). It is off chain and costs no gas.
- **Report payload** (JSON, topic `zeto-report-v1`): `txId`, `kind` (`deposit|transfer|withdraw|lock|dvp`), `token` (contract address), `tokenRole` (`RD|DFABI`), `from`, `to[]`, for each output UTXO `{owner (BabyJubJub pubkey), amount, salt}`, for each input `{nullifier or commitment}`, and for DvP `atomAddress` plus both legs.
- **BI verification** (no trust in the report alone). For every output, BI recomputes `Poseidon(amount, salt, ownerPub.x, ownerPub.y)` (`domains/zeto/pkg/types/states.go:66-80`). It then checks that commitment against the UTXO outputs that the chain event for `txId` carries. Status: `verified`, `mismatch` or `pending`.
- **Unreported-tx detection.** BI watches every UTXO event of the RD and DFABI contracts. An output commitment with no verified report after a grace period becomes `unreported`, attributed to the tx sender.
- **BI offline.** Zeto txs do not involve BI. Messages queue on the sender node and arrive when node4 is back. Verification then catches up.

Known limits, to state in the README:

- BI visibility is enforced by procedure plus detection, not by the protocol. A bank can withhold a report but cannot hide that it did.
- The docs say private messages carry "no ordering or non-repudiation guarantees" (`doc-site/docs/architecture/pente.md:130-134`), which is why verification against the chain is mandatory.
- DvP stays on Zeto_Anon (no token KYC, linkable spends).
- The v1.0.0 poison-pill and `Atom.cancel()` issues remain.

## Steps

All steps run in `besu/zeto/`. Scripts are dry-run by default and act only with `--execute`.

1. **Messaging spike** (`spike-bi-messaging.ts`), 1-2 h. Prove these, each as a PASS/FAIL check:
   - M1: create group `{investor2@node2, bi@node4}`. Read back `members` and `contractAddress`.
   - M2: send a message; BI receives it, via `pgroup_queryMessages` on node4 or a WebSocket listener on 31849.
   - M3: an investor3@node3 query does not see the group or the message.
   - M4 (offline test): the lead scales nothing. The lead deletes pod `paladin-node4-0` once (user approved one restart). While node4 is down, investor2 sends 3 messages; the calls must succeed. When node4 is Ready, all 3 arrive in order of sending, or the order seen is recorded.
   - M5: try `createGroup` while node4 is down. Record the behaviour (expected: blocks or fails; acceptable, because it is onboarding only).
   - The pod restart in M4 and M5 is done by the lead, not the script. The script pauses and prints "ready for node4 restart".
2. **Report and verifier library** (`src/bi-report.ts`), about 1 day. Covers the payload builder, a Poseidon commitment recompute (circomlibjs, already a dependency), and a chain matcher that reads UTXO events from the token contracts over the node's eth RPC. Unit checks: a correct report gives `verified`; a wrong amount, salt or owner gives `mismatch`.
3. **Integrate into the lifecycle and DvP** (`spike-zeto-bi.ts`, reusing the `spike-zeto-dvp-zz.ts` flow), about 1 day. After every I, T, S1 and W step, the sending bank reports and BI verifies. Assert after each step: BI has a `verified` report for every output; investor3 has neither the report nor the states.
4. **Unreported detection**, about half a day. One "rogue" transfer is sent without a report; after the grace period BI flags it as `unreported` with the right sender.
5. **README section** "Option A: BI reporting". It covers how to run, results, the limits above, and a table comparing it with stealth and with the KYC baseline.

## Done when

- M1-M5 recorded, with M2-M4 PASS.
- The lifecycle + DvP run passes with BI `verified` on every output, zero `mismatch`, and the rogue transfer flagged.
- typecheck passes; commits are on master (explicit paths under `besu/zeto/`, not pushed).

## Out of scope

Patching Paladin, custom circuits, KYC on the DvP leg, production key management for BI, sanctions for withheld reports.
