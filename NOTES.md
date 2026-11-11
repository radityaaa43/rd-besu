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

## Besu validators and Paladin registry (added 2026-11-11, from the analyst reviews)

1. Validator PVC fill, measured 2026-11-11 with the kubelet stats of each validator's node
   (`kubectl get --raw /api/v1/nodes/<node>/proxy/stats/summary`, volume `data`, ns `besu`; `KUBECONFIG=besu/zeto/alibaba.yaml`):

   | Pod | Node | Used / capacity |
   |-----|------|-----------------|
   | `besu-node-validator-1-0` | `member-16032-node` | 3.92 / 39.08 GiB (10.0%) |
   | `besu-node-validator-2-0` | `member-16044-node` | 3.92 / 39.08 GiB (10.0%) |
   | `besu-node-validator-3-0` | `member-16033-node` | 3.92 / 39.08 GiB (10.0%) |
   | `besu-node-validator-4-0` | `member-16034-node` | 3.93 / 39.08 GiB (10.1%) |

   The four PVCs are 40Gi and 20 days old (`kubectl get pvc -n besu`). Mean growth since creation: about 0.2 GiB/day
   (3.92 GiB / 20 d, assumes an empty start; one reading, no trend yet). Open risk from the analyst
   (`agents/analyst/reports/2026-11-11-network.md:11-14`): Bonsai trie logs are unbounded with `sync-mode=FULL`; the trie-log share was not measured (no exec).
   Re-measure monthly (see "Monthly checks").
2. Registry and factory owners, read 2026-11-11 (`eth_call owner()` via the Besu door `127.0.0.1:38545`; the registry has no `owner()`, so
   `getRootIdentity()`; deploy tx `from` via `eth_getTransactionByHash`). Each contract is owned by its own operator key on BI's node1
   (the `SmartContractDeployment` CRs say `node: node1`, `from: <name>.operator`; the key-to-node link is from the CR spec, not from the keystore):
   - `registry` (IdentityRegistry `0x99f3326e056b418e40c62bbbd2ffdafd48bd7874`): root identity owner `0xf4048D7Ecc106Da399734492B20bDF0fB10EA11b`, equal to its deploy tx `from` (not rootless; `solidity/contracts/registry/IdentityRegistry.sol:45-47` in paladin@v1.0.0).
   - `noto-factory-proxy` (`0x1419f612c603466f254ca71e78a324c0d922daf3`): `0x3a4c07fc90001fbbe93fe3679b1e24d4e1aa78bf`.
   - `pente-factory-proxy` (`0x199804944e574c6f726f5aa13b343c6cd2c73254`): `0xb39cf645b06edad2024eabcbba31cb6e7f121fe1`.
   - `zeto-factory-proxy` (`0x753a64eac771adff2ff9d879585fa3bdde76cf91`): `0xc196d2301da56df921732244e1a6d940b8196629`.
   - The implementation factories `noto-factory` (`0x5aeb…`), `pente-factory` (`0x6ce8…`) and `zeto-factory` (`0x3ed8…`) report owner `0x0`.

## Monthly checks (first on 2026-12-06)

1. Validator PVC fill: the command in item 1 above, for the four nodes. Report the four numbers to `lead`.
2. Gateway certificates (`gw-1..4`, `fx-gw-1..4`, `lensa`) expire on 2027-11-06, the CA on 2031-11-05 (read 2026-11-11):
   `for f in ~/.opa-mtls/*.crt; do echo -n "$f "; openssl x509 -in "$f" -noout -enddate; done`. Re-issue steps: `opa/README.md`, step 3.
3. Review date of the public Paladin ingress decision (`opa/README.md`, "Public ingress bypass"): 2026-12-06.

