# stealth-address/k8s/rpc: JWT RPC node per party (final-design/stealth/PLAN.md S4 cluster 1, S5 bank C)

Manifests, helper scripts and an offline test. Nothing here talks to a cluster; applying is a separate approved CLUSTER-OP (L1 bundle B: spend = 3 + 1 PVC of 40Gi).

| File | What |
|---|---|
| `render.sh [--cluster 2] net\|node <party>` | Services `besu-rpc` (ClusterIP 8545) and `besu-rpc-hs`, NetworkPolicy `besu-rpc-ingress`; ConfigMaps `besu-rpc-config`, `besu-static-nodes`, StatefulSet `besu-rpc`. bank-c only with `--cluster 2` |
| `templates/config.toml` | the live validator `config.toml` with the S4 changes only (asserted against `test/fixtures/live-config.toml`): `rpc-http-api=["ETH","NET","WEB3"]`, JWT on, public key `/jwt/public.pem`, `host-allowlist`, no CORS, no WebSocket, `metrics-host="127.0.0.1"`, `discovery-enabled=false` |
| `genesis.sh`, `nodekey.sh` | ConfigMap `besu-genesis` (byte-identical copy from ns `besu`, admin) and Secret `besu-rpc-nodekey` (generated in the namespace, never written or printed) |
| `jwt.sh` | RS256 keypair generated into Secret `stealth-rpc-jwt` through a 077 tmpfs dir removed by trap; only `public.pem` is mounted into the pod |
| `mint-token.sh` | one-off short-lived token (`exp`, max 3600 s, permissions `eth\|net\|web3` groups only, `*:*` refused); the long-lived minter is signer code (S9) |
| `static-nodes.sh` | IP-only `static-nodes.json` (the zeto `besu-p2p` LB IPs; DNS names refused) |
| `../test-rpc.sh`, `rpc/test/check.py` | offline assertions; needs bash, python3, PyYAML, openssl |
S1 change in this PR: `templates/party.yaml` `allow-same-namespace` is `NotIn [vault, besu-rpc]` (the Vault exclusion from #15 plus this node; policies are additive, without them the two ingress policies restrict nothing). It changes a live object: re-apply S1 rendered from merged main only, in the three namespaces first (`../render.sh <party> | kubectl apply -f -`). VERIFY row: `kubectl -n rd-stealth-<p> get networkpolicy allow-same-namespace -o jsonpath='{.spec.podSelector}'` lists both values in all 3 namespaces.

## Order (per party; bank C after the zeto S4 LB IPs, with `--cluster 2` and the cluster-2 credential)
1. `./genesis.sh <p> | kubectl apply -f -` (admin); `KUBECONFIG=<party kubeconfig> ./nodekey.sh <p>`; `KUBECONFIG=<party kubeconfig> ./jwt.sh <p>`.
2. `./render.sh net <p> | kubectl apply -f -`.
3. `./static-nodes.sh --peer enode://<id of the OWN party's zeto besu-validator-0>@<its pod IP>:30303 > static-nodes.json` (exactly ONE entry, user decision 2026-11-11: each bank's RPC node peers only with that bank's own zeto node; `render.sh node` refuses any other count; bank C: its own zeto pod in `rd-zeto-bank-c`).
4. `./render.sh node <p> --static-nodes static-nodes.json [--storage-class C] | kubectl apply -f -` (bank C: `--cluster 2 ... bank-c` and the cluster-2 storage class).
5. Proofs (PLAN S4 RED), admin kubeconfig, port-forward. Interim only (S9 re-generates the pair inside the namespace): in ONE step, `umask 077; kubectl -n rd-stealth-<p> get secret stealth-rpc-jwt -o jsonpath='{.data.private\.pem}' | base64 -d > /dev/shm/k.pem; T=$(./mint-token.sh --key-file /dev/shm/k.pem --ttl 600 --permissions 'eth:*,net:*,web3:*'); rm -f /dev/shm/k.pem` (the key never leaves `/dev/shm`, never reaches disk or the chat). Then `eth_chainId` with `$T` -> `0x539`, without -> 401, `admin_peers` with `$T` -> not enabled.

## Initial sync and long-outage resync (runbook)
Initial sync or a long-outage resync of a `besu-rpc` node uses TEMPORARY multi-peer static-nodes (the 3 zeto nodes of cluster 1, from `static-nodes.sh --peer` x3) and `sync-min-peers=3`, switched to the own-party single peer (one enode, `sync-min-peers=1`, as rendered by `render.sh node`) once the node is at head (within 2 blocks of its own zeto node).
Why (observed 2026-11-11, rd-stealth-bi): on ONE peer the replay fell from ~1.5k blocks/s to a stall at block 1965409, log `PipelineChainDownloader | Chain download failed. Restarting after short delay.` / `Unable to retrieve blocks for block numbers: 1965410 to 1965478` every ~2.5 s. A node already at head follows one peer fine [expected, to be confirmed by the revert-then-own run]. The merged render therefore models the STEADY state; the temporary multi-peer file is applied by the operator for the catch-up (render the config with `sed 's/^sync-min-peers=1$/sync-min-peers=3/'` and a 3-entry static-nodes JSON; `render.sh node` itself refuses more than one entry by design).

## Choices to read
- `host-allowlist` is `["besu-rpc","besu-rpc.<ns>.svc.cluster.local","st-gw","localhost","127.0.0.1"]`: PLAN S4 lists `st-gw` and `besu-rpc` only, but the S4 RED proof goes by port-forward (Host `127.0.0.1`/`localhost`) and in-namespace callers use the Service DNS name; none of them is `*`.
- Liveness is `tcpSocket :8545`, not `httpGet /liveness` as on the validators: with JWT on, `/liveness` may answer 401 [unverified] and the kubelet would restart the pod in a loop.
- The node is kept off `member-16033-node` and `member-16034-node` (CURRENT section 12). Requests 500m / 1500M, limits 2 / 3G on cluster 1; bank C 250m / 1G, limits 1 / 2G (first guesses [unverified]).
- PVC 40Gi class `alicloud-essd-wffc` (PLAN says `alicloud-essd`; wffc follows the pod, as in the other PRs); the StatefulSet keeps PVCs on delete/scale.
- Not exposed: P2P (the node only dials out), metrics, WebSocket. The zeto validator policy already admits `rd-stealth-*` on 30303 (zeto PR #18).
