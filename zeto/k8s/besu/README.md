# zeto/k8s/besu: Besu node per party (final-design/zeto/PLAN.md S3 cluster 1, S4 bank C)

Manifests, helper scripts and an offline test. Nothing here talks to a cluster; applying is a separate approved CLUSTER-OP (L1 GO: spend = 3 LoadBalancers, 3 x 40Gi PVCs,
plus 1 LoadBalancer and 1 PVC on cluster 2; the one added rule in the old ns `besu` is a change to the old stack).

| File | What |
|---|---|
| `render.sh net\|nodeinfo\|node <party>` | stage objects: Services + NetworkPolicy, key-info Job, ConfigMaps + StatefulSet. Parties `bi`, `bank-a`, `bank-b`, `bank-c` |
| `templates/config.toml` | the live validator `config.toml` (snapshot in `test/fixtures/live-config.toml`) with exactly four changes: `discovery-enabled=false`, `p2p-host="${P2P_HOST}"`, `rpc-http-api` narrowed to ETH/NET/WEB3/QBFT/ADMIN, `rpc-ws-api` to ETH/NET/WEB3 (2026-11-12) |
| `genesis.sh <party>` | ConfigMap `besu-genesis`, `data` copied from ns `besu` (admin read), so it is byte-identical to the live chain config |
| `nodekey.sh <party>` | Secret `besu-nodekey`: `openssl rand -hex 32` piped into `kubectl create secret`, never written, never printed (run with the party kubeconfig) |
| `static-nodes.sh` | IP-only `static-nodes.json`; converts the live `besu-peers` DNS entries to old pod IPs; `--new-validators FILE --party P` prints the other 3 new validators only (repoint, below) |
| `old-netpol-patch.sh` | prints (APPLY=1 runs) the four add-only patches for TCP 30303 from `rd-zeto-*` / `rd-stealth-*` on the old `besu-node-validator-N-ingress` |
| `../test-besu.sh`, `test/check.py` | offline assertions; needs bash, python3, PyYAML |

## Order (per party; cluster 1 first, bank C after S2 and the three cluster-1 LB IPs)
1. `./genesis.sh <p> | kubectl apply -f -` (admin) and `KUBECONFIG=<party kubeconfig> ./nodekey.sh <p>`.
2. `./render.sh net <p> | kubectl apply -f -`; read the LB address: `kubectl -n rd-zeto-<p> get svc besu-p2p -o jsonpath='{.status.loadBalancer.ingress[0].ip}'`.
3. `./render.sh nodeinfo <p> | kubectl apply -f -`; `kubectl -n rd-zeto-<p> logs job/besu-nodeinfo`: public key (enode id = without `0x`) and address (for the S5a vote).
4. Old pod IPs and the live peers (admin): `kubectl -n besu get cm besu-peers -o jsonpath='{.data.static-nodes\.json}' > old-peers.json`;
   `for n in 1 2 3 4; do echo "$n $(kubectl -n besu get pod besu-node-validator-$n-0 -o jsonpath='{.status.podIP}')"; done > old-pod-ips.txt`.
   `./static-nodes.sh --old-peers old-peers.json --pod-ips old-pod-ips.txt --peer enode://<other new id>@<other LB IP>:30303 ... > static-nodes.json`.
5. `./render.sh node <p> --p2p-host <LB IP> --static-nodes static-nodes.json | kubectl apply -f -` (bank C: add `--storage-class` of cluster 2).
6. `./old-netpol-patch.sh` (print), then `APPLY=1 ./old-netpol-patch.sh` in the GO window. Cross-cluster only: `net bank-a --external-cidr <bank C egress IP>/32` once that IP is known.

Other new nodes are only reachable after their own steps 2-3; start with the old validators in `static-nodes.json` and re-render the ConfigMap (and restart the pod) when a peer's enode becomes known.
The old pod IPs last only while the old pods live (PLAN S3 interim): re-run step 4-5 after an old-pod restart.

## Repoint to the new validators only (ConfigMap `besu-static-nodes`, no old ns `besu` pod IP)
The QBFT set is already the 4 new validators; the old 4 are followers. Input: `new-validators.json` = `{"bi": ENODE, "bank-a": ENODE, "bank-b": ENODE, "bank-c": ENODE}`
(IP enodes: `admin_nodeInfo` id + the `besu-p2p` LB IP, `?discport=0`; see `test/fixtures/new-validators.json`).
`./static-nodes.sh --new-validators new-validators.json --party <p> > static-nodes.json` prints the other 3 in the order bi, bank-a, bank-b, bank-c.
`./render.sh node <p> --p2p-host <LB IP> --static-nodes static-nodes.json` renders `besu-config`, `besu-static-nodes` and the StatefulSet: apply ONLY the `besu-static-nodes` document
(the other two may differ from live), then restart `besu-validator-0` of ONE party at a time. Besu does not reload `static-nodes.json`.
Gate before each restart: other 3 in sync and 4/4 proposers over 20 blocks (`qbft_getSignerMetrics`). Proof after: `admin_peers` of the restarted node = exactly the other 3 new enodes (old nodes may still dial in while ns `besu` runs).
Rollback: re-apply the live `besu-static-nodes` saved before the change and restart that pod again.

## Choices to read
- Config parity with the old live validators except those four lines (no DEBUG/TRACE/TXPOOL/PERM: never called in 16 h of `besu_rpc_request_time`; clients reach 8545 only via bank-gw, which has its own method allowlist); `--Xdns-enabled`/`--Xdns-update-enabled` (live args) are NOT used: new enodes carry IPs.
- Live args kept: `--min-gas-price=0 --nat-method=NONE`; liveness `/liveness` after 180 s; no readiness probe (as live).
- All four validators (2026-11-13): requests 500m / 3Gi, limits 3 CPU / 6Gi (`BESU_OPTS -XX:MaxRAMPercentage=70`: heap up to 4.2Gi). Before: cluster 1
  500m / 2500M, limits 3 / 5G (CPU 1 -> 500m by the 2026-11-12 resize); bank C 250m / 1500M, limits 2 / 3G.
- cluster 1: `nodeAffinity` off `member-16033-node` and `member-16034-node`, required pod anti-affinity among the new validators (`namespaceSelector part-of=rd-zeto`).
- PVC 40Gi, class default `alicloud-essd-wffc` (zone follows the pod; reclaim Delete, but the StatefulSet keeps PVCs on delete/scale), `--storage-class` overrides.
- init container `busybox:1.36` (live uses unpinned `busybox`; the pull is a new image reference on these nodes: [unverified]).
- Not here: S5a/S5b votes beyond the helper `vote.sh` (below; RPC by port-forward with the admin kubeconfig: `party-admin` has no `pods/portforward`), gateway and Paladin pointing at `besu-rpc` (S9, S16).

## S5a validator vote (`vote.sh`) and the n=8 rule
`./vote.sh --old URL x4 --new-rpc URL --address 0x<new> [--dry-run] [--timeout 300] | --withdraw` (test: `../test-vote.sh`). One address per run; order bi, bank-a, bank-b, bank-c; user-only (old-stack consensus), needs an explicit window word.
Done 2026-11-11 22:19-22:26 CST (sha dfd79a4): set 4 -> 5 -> 6 -> 7 -> 8, each new validator sealed >= 1 block within 2n blocks (`qbft_getSignerMetrics`, the gate between votes; "in the set" alone is not enough).
Gate fail = vote the address out at once (`qbft_proposeValidatorVote(X, false)` on more than 50% of the current set) and stop.

**n=8 rule:** the old 4 validators have no path to bank-c (cluster 2); bank-c's three peers bi, bank-a and bank-b relay its QBFT messages (besu 26.8.1: QbftController.java:215-222 gossips every processed message, QbftGossiperImpl.java:80-84 relays except to sender and author,
ValidatorPeers.java:36,79-89 sends only to connected validator peers). While the set is 8 (quorum 6), **at most one of bi, bank-a, bank-b may be down or in maintenance at a time**: two down cut bank-c off and leave the old 4 + 2 = 6, exactly the quorum, with no spare.
