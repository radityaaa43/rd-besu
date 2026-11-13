# Publish regression (every bundle publish; S17 lesson 2026-11-12)
The first bundle (S17) shipped without the Kebijakan documents and passed a regression that tested only reads and denies; every mint, transfer and lock was then "closed".
Rule: **a publish is not done until an in-hours WRITE per function passes under the party's own identity.**

Before (offline, on the candidate tar.gz files, nothing published):
1. `opa/tools/regress.sh <bi.tar.gz> <bank-a.tar.gz> <bank-b.tar.gz> <bank-c.tar.gz> --pub-dir <dir with the PUBLIC keys> --ref opa/tools/live-docs-2026-11-13.json`
   = signatures verify with the public keys, the Kebijakan documents equal the reference hashes (`policy-docs.py diff`), and `test/regress/regression_test.rego` passes against the candidate data: in-hours write per function with the own identity (transfer, createLock, spendLock via ptx_prepareTransaction, public delegateLock, cancelLock; mint by BI only), another party's identity = deny, `max_per_tx` exact = allow and +1 = deny, a non-participant recipient = deny, the report group of the own node = allow and another node's = deny, unknown function / contract = deny, the documents exist.
After (live, each quoted with a host `date`):
2. The new revision is active on all 4 gateways (OPA status / decision log: revision = the sink's published hash, no signature error), bank-c on cluster 2 included.
3. The same write cases through the party's own cert (in-namespace test Job with the egress-locked pattern, or Lensa's party certs and then say R1 interim): allow for each function, another party's CN = deny.
4. Boundaries live: `max_per_tx` exactly = allow, +1 = deny; a mint by a bank = deny; a transfer to a non-counterparty = deny.
5. Outsider C sealed on a Zeto transfer (no state for the outsider).
6. A transfer's report lands in the NEW report group of the sender and BI sees it.
7. Live 4/4 read unchanged.
