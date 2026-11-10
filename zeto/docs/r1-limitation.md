# Zeto R1 is partial: accepted limitation

Status: accepted by the project (option A, 2026-11-10). The running Paladin fork stays. No new Paladin patch, forked circuit, forked contract or bank-side workaround queue is added for this.

**R1** = BI, the sender and the receiver see the full transaction; every other bank sees nothing useful. For Zeto, R1 is met only through the sending bank's report. R2 (BI offline) and R3 (atomic DvP) hold for settlement.

## What the official software does not provide

Paladin `v1.0.0` (`LFDT-Paladin/paladin`; `v1.0.1-rc.1` has the same code plus 4 chore commits) pins Zeto `v0.2.2` and offers no way for a third party such as BI to read a Zeto transfer from chain data:

- **No authority variant.** The supported tokens are `Zeto_Anon, Zeto_AnonEnc, Zeto_AnonNullifier, Zeto_AnonNullifierKyc, Zeto_NfAnon, Zeto_NfAnonNullifier`; there is no `Zeto_AnonEncNullifierNonRepudiation` (`paladin@v1.0.0:domains/zeto/pkg/constants/constants.go:26-32`). The upstream request is `LFDT-Paladin/paladin#610` "Observer Role to be supported by Paladin in Zeto Domain": OPEN, labels `enhancement` and `stale`, created 2025-03-27, last update 2025-04-27.
- **No extra recipient in the API.** A transfer entry is `{to, amount, data}` (`paladin@v1.0.0:domains/zeto/pkg/types/abi.go:74-78`).
- **States go to the parties only.** Output coins are distributed to their owner (`paladin@v1.0.0:domains/zeto/internal/zeto/fungible/states.go:62`), the transfer info state to `[From, To]` (`paladin@v1.0.0:domains/zeto/internal/zeto/fungible/handler_transfer.go:180`). On Zeto_AnonNullifier a transfer spends nullifiers that only the owner can compute, so BI cannot name the sender from chain data (`besu/zeto/src/bi-report.ts:211-216`).
- **No lock path for the authority variant.** Zeto `v0.5.1` marks Locking as ":soon:" for `Zeto_AnonEncNullifierNonRepudiation` and `Zeto_AnonEncNullifier` (`LFDT-Paladin/zeto@1b895de:doc-site/docs/implementations/index.md:10-15`). The NR contract has no lockable base, and the v0.5.1 release has no locked-transfer proving key for it. There is no upstream issue for it (searched 2026-11-10).
- **Reports over privacy-group messages are not durable.** `pgroup_sendMessage` checks that the target node is reachable before it stores the message (`paladin@v1.0.0:core/go/internal/groupmgr/manager.go:157-172`, `messages.go:111`).

## Our live R2 test (2026-11-10, RD `0x0b91f511…`)

BI's Paladin node (node1) was scaled to 0 for 300 s. Settlement worked: an RD transfer between two banks took 5 s and a DvP (1 DFABI against 1,000,000 RD) took 23 s, both with receipts on sender and receiver. Every one of the 6 bank reports failed after about 20 s with `PD011206 TRANSPORT grpc` / `PD030015` (dial timeout to `paladin-node1:9000`) and was not stored on the bank node. After BI came back (Ready in 25 s, chain caught up at once) no report arrived, and the BI lens shows both transactions as `sealed`. A BI-to-bank and a bank-to-bank control transfer after the outage worked (no SMT divergence, no coordinator wedge). Summary only; the full report is local evidence outside this repository.

## Other official domains do not meet R1 + R2 + R3 either

Both facts re-checked against the `v1.0.0` tag on 2026-11-10:

- **Pente** requires every group member to endorse every transaction: "Note the threshold is 100% right now" (`paladin@v1.0.0:domains/pente/src/main/java/io/kaleido/paladin/pente/domain/PenteDomain.java:102`). With BI as a member, BI offline stops settlement (R2).
- **Noto** has the notary submit the transaction: "Uses the notary account to submit `TX1` to the blockchain" (`paladin@v1.0.0:doc-site/docs/architecture/noto.md:569`, and `:580` for TX2). With BI as notary, BI offline stops settlement (R2).
- Consequence drawn by the orchestrator, not tested by us on every combination: no official Paladin domain at v1.0.0 gives R1 + R2 + R3 together. [unverified as a general statement]

## Accepted behaviour

- BI names the sender and receiver of a Zeto transaction **from the sending bank's report** (reporter = sender; the receiver and amount come from the reported outputs, verified against the chain commitments). This is a bank self-claim.
- A transaction that settles while BI is down is **not reported to BI** and stays `sealed` in the BI lens. The same holds for any bank-to-bank transaction whose report was never sent. BI detects unreported outputs on chain but cannot name their sender (`unknown-input-owner`).
- Settlement, atomicity (R3) and the privacy of outsider banks are unaffected.

## What we do about it

- Upstream status is monitored; no request filed (user decision 2026-11-10).
- A design with a separate disclosure proof was considered and rejected by project rule (no custom circuits or contracts); the spike is kept outside the repository.
- The fork commits we carry are tracked in `fork-commits.md`.
