# Operational notes (moved from agents/blockchain/NOTES.md, 2026-11-11)

## Paladin (ns paladin), updated 2026-11-03 04:10Z

1. RESOLVED 2026-11-03 04:19Z (S8): the paladin-operator is back at 1 replica. ConfigMap `paladin-operator`
   `paladin.image` = `ghcr.io/radityaaa43/paladin@sha256:6f113f3829fefd7f954d3377935d7613ab78a90ba89c6af8e79159617b339f71`,
   byte-identical to all 4 StatefulSets; the 5-min watch showed no pod restart and no StatefulSet update. Operator v1.0.0
   copies that string verbatim into every StatefulSet on reconcile, so any future image change goes ConfigMap first
   (byte-identical string), or the operator is paused (scale 0) before a per-node `set image`. CM backups:
   besu/zeto/out/s8-20261103T041331Z/.
2. RESOLVED 2026-11-03: mixed fleet. node1 moved to the digest at 04:05Z (node2/3/4 earlier), so all 4 nodes run prepfix2.
3. Ceiling with prepfix2: a prepare-only transaction (Zeto prepareSpendLock, any submitMode external) stays in the
   coordinator's memory until the pod restarts. About 500 (`maxInflightTransactions`) per (node, token contract) per pod
   lifetime; after that the node rejects new transactions for that token (PD012642) until a restart. Each Zeto DvP adds one
   on the seller's DFABI coordinator and one on the buyer's RD coordinator. Every restart or image rollout resets it.
4. RESOLVED 2026-11-03: node1's 7 old spike rows (6 external spendLock + createLock 66f4043e, bondCustodian@node1,
   10-21) were backed up to besu/zeto/out/stuck-tx-backup-20261103T040501Z/ (gitignored) and deleted (6/6/7, history
   cascade). Restore only with a new GO.
5. Restart rule: restart a Paladin node only when no node has an in-flight transaction. A node that resumes a transaction
   needing a remote verifier right after start can lose the ResolveVerifier response (PD030015, no retry); the transaction
   then stays `Resolving` and blocks later ones on the same contract.

