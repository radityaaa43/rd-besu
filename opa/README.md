# OPA gateway for Paladin + Besu (Zeto first)

Each bank runs its own gateway `bank-gw-N`: one pod with Envoy and OPA (`ext_authz`) in front of the bank's
Paladin RPC (`:8548`) and Besu RPC (`:8545`). OPA loads two bundles and a Paladin request passes only when both allow:

- `bundles/bi`: BI's rules, the same for every bank (entrypoint `gw/allow`, Zeto, Atom, Besu methods, log mask, OPA API lock).
- `bundles/bank`: each bank's own rules, code only (here: Zeto outputs only to its counterparties). The bank's data is a `seeds/bank-*.json` document.
- `seeds/`: first version of each editable document: `bi.json` (limits, hours, holidays, frozen) and `bank-a`, `bank-b`, `bank-c`, `bank-bi` (counterparties).

```
Lensa ──pf──▶ bank-gw-N ─ Envoy :8548 ─ext_authz(target=paladin)─▶ paladin-nodeN:8548
                        ─ Envoy :8545 ─ext_authz(target=besu)────▶ besu-node-validator-N:8545
paladin-nodeN ──direct──▶ besu-node-validator-N   (not through the gateway)

bank-gw-N OPA ──poll 5-15 s──▶ bundle-server :80  /N/bi.tar.gz, /N/bank.tar.gz   (nginx; ConfigMap bank-gw-N-bundles)
              ──decision logs, bundle status──▶ bundle-server :8081  (sink: logs to stdout, last status per gateway)
Lensa Publisher ── kubectl apply ConfigMap bank-gw-N-bundles ──▶ (no restart) ── reads the sink status until the new revision shows
```

The gateway does not read bundle files any more: its OPA pulls **signed** bundles from `bundle-server` (ns `paladin`, no PVC) and activates a
bundle only when its signature verifies. Keys are per owner (`keys.sh`): `bi.tar.gz` must verify with BI's key (`bi`), and `bank.tar.gz`
with the key of that gateway's bank (`bank-a|b|c`; node 1's bank bundle is BI's, key `bi`). The OPA ConfigMap holds all four public keys, but
each gateway pins the key per bundle (`--set=bundles.bank.signing.keyid=...` in `k8s/bank-gw-N.yaml`), so a bank's key cannot sign another bank's
bundle, and an unsigned or wrongly signed bundle keeps the old one running. Private keys live outside the repo (`OPA_KEYS_DIR`, default `~/.opa-keys`, mode 600).

## What the rules cover

| Door | Allowed | Notes |
|---|---|---|
| Paladin | reads from `bi/config/data.json` `paladin.read_methods` | any other method is denied (`keymgr_sign`, `pstate_storeState`, batches, ...) |
| Paladin, Zeto | a private tx is Zeto when `domain` is `zeto` or `to` is an RD/DFABI contract in `zeto.contracts` (the SDK sends writes without `domain`; only deploys carry it). `mint` (issuer node only), `transfer`, `createLock`, `spendLock`, `delegateLock`, `cancelLock` on the RD/DFABI contracts; `from` must be the node's own identity | outputs to the 4 participants, amount > 0; transfers and locks capped per tx (sum) |
| Paladin, public | `create` on the Zeto/Noto Atom factories; `execute`/`cancel` on any other address | an Atom's address is known only on chain |
| Paladin, Zeto, limits | BI: `max_per_tx`, `max_mint_per_tx`, `hours` per token, `holidays`, `frozen`; bank: `max_per_tx`, `hours`, `daily_limit` (never looser than BI) | BI's caps are top-level `bi.config.max_per_tx` / `max_mint_per_tx` (they apply to Zeto and Noto alike); the daily limit is one per token for Zeto and Noto together: it asks the bank's own Paladin node for today's total with two queries (`ptx_queryTransactionsFull`, domain `zeto` and domain `noto`, `created` from 00:00 WIB as UTC, no `from` filter), counting Zeto `transfer` and `createLock` plus Noto `transfer` and `prepareUnlock` (except a rollback to the sender), `http.send` timeout 2s each, fails closed (for either query: no answer, a JSON-RPC error, non-200 or a full page of 1000 denies); counted on submit and without a lock |
| Identities | compared by node (`name@node`, exactly one `@`, both parts non-empty) | a bank is its node: `stress-n2-00@node2` is bank A; freezing `bankC@node4` freezes every `*@node4`; counterparties and participants match by node |
| Paladin, reports | `pgroup_sendMessage` topic `zeto-report-v1` on the node's own {bank, BI} group | |
| Paladin, Noto | a private tx is Noto when `domain` is `noto` or `to` is in `noto.contracts` (Zeto wins if both). `mint` (issuer node only), `burn` (issuer node only, its own holdings: token open, 0 < amount <= `max_mint_per_tx`; a bank's burn is denied), `transfer` ({to, amount}), `lock` ({amount}), `prepareUnlock` (recipients), `delegateLock`; `from` must be the node's own identity; anything else (`burnFrom`, `transferFrom`, deploys, unknown contract) is denied | same per-token policy as Zeto (caps in `max_per_tx`/`max_mint_per_tx`, hours, frozen, the bank's counterparties, `max_per_tx`, `daily_limit`); `lock` and `prepareUnlock` need both tokens open; a `prepareUnlock` whose recipients are only the sender (DvP rollback) and `delegateLock` are never blocked; the daily limit is the same combined one (Noto `transfer` and `prepareUnlock` except rollbacks count with Zeto's); a burn sends nothing out, so no bank rule applies to it |
| Paladin, Pente | `pgroup_sendTransaction` only into a group in `pente.groups` (the Noto hooks' cash and issuer-custodian groups) | membership itself is Paladin's; any other private domain is denied |
| Besu | method allowlist, every call in a batch | `admin_*`, `qbft_*`, `perm_*`, `debug_*`, `txpool_*` denied |

Not covered: the duty to report to BI after a bank-to-bank transfer (BI's reconciliation flags `unreported`),
and whether `delegateLock` hands a lock to a legitimate Atom.

**Placeholders:** `max_per_tx` (`RD: 1000000000`, `DFABI: 1000`) in `seeds/bi.json` until BI sets the real limits.

## Lensa: Halaman Kebijakan

Lensa edits the two kinds of document (BI's `bi`, each bank's `bank-a|b|c`) on the screen **Kebijakan**
(`/besu/zeto/kebijakan` and `/besu/noto/kebijakan`, one policy for both rails; disabled with a reason on Stealth, Fabric-X and Iroha 3). A change is drafted by one
person, approved by a different one, then published to the gateways. Design: `docs/superpowers/specs/2026-11-05-halaman-kebijakan-design.md`;
plan: `docs/superpowers/plans/2026-11-05-halaman-kebijakan.md`; routes and state: `frontend/ARCHITECTURE.md` section 8.

- **Turn on:** set `OPA_BIN=/home/ecs-user/.local/bin/opa` and `OPA_KEYS_DIR=/home/ecs-user/.opa-keys` in `~/.config/lensa/lensa.env` and restart `lensa.service`. Without either, or when setup fails, every `/api/policy*` route answers 501 and the rest of Lensa works.
- **State:** `frontend/server/state/policy/<owner>/` holds `v<N>.json`, `pending.json` and `audit.jsonl`. Version 1 is the file in `seeds/`.
- **Check before a draft is stored:** the `check` packages of both bundles (shape, ranges, bank not looser than BI, identities: exactly one `@`) and `opa test`; a failure answers 422 with the messages ("Kebijakan tidak valid" for a check error, "Uji kebijakan gagal" when any `opa test` case fails). A validator that returns no list at all (for example a renamed package) is a server error, never "valid".
- **Publish** (after approval), one gateway at a time, for the gateways whose Deployment `bank-gw-<node>` exists (BI's change: all four, a bank's: its own node):
  1. `opa build -b --signing-key` for `bi` (BI's key) and `bank` (the bank's key) (the bank bundle builds alone and reads BI's values as data only);
  2. apply ConfigMap `bank-gw-<node>-bundles` (`bi.tar.gz`, `bank.tar.gz`). No Deployment is touched, nothing restarts, Lensa's port-forward stays up;
  3. wait (180 s) until the gateway reports `bi-v<n>` and `<bank>-v<n>` as active revisions to the sink (the kubelet refreshes the mounted ConfigMap in up to about 90 s, then OPA polls within 15 s). A bundle that fails verification is never activated, so it never reports. If the sink cannot be read, that counts as not confirmed (fail closed);
  4. on failure the previous ConfigMap is put back and the change shows "Gagal diterbitkan" with "Terbitkan ulang".
- **Guard:** the kube module refuses any name outside `bank-gw-[1-4]` and `bank-gw-[1-4]-bundles`; its only other call is a read of the sink status.
- **Status on the screen:** the revisions a gateway last reported (a report older than 60 s counts as not ready). Raw: `kubectl get --raw /api/v1/namespaces/paladin/services/bundle-server:sink/proxy/status` (per gateway: `age_s` and, per bundle, `revision`, `code`, `message`; `code: bundle_error` with a message such as `failed to verify JWT signature` is a refused bundle).
- **Build only, no cluster:** `OPA_KEYS_DIR=~/.opa-keys npm run policy:build -w server -- <node> <outdir>` (from `frontend/`; unsigned when `OPA_KEYS_DIR` is not set, which the gateways refuse).
- **Live:** first publishes ran 2026-11-05 (BI v3, v4) to all four gateways from the screen.

## Test

```
opa check --strict bundles/bi bundles/bank test
opa test --coverage bundles/bi bundles/bank test
regal lint bundles test
opa build -b bundles/bi -o /dev/null && opa build -b bundles/bank -o /dev/null   # each bundle must build alone
for f in k8s/*.yaml; do kubectl apply --dry-run=client -f $f; done                # manifests (client side only)
(cd ../../frontend/server && npx vitest run test/gateway-mtls.test.ts)            # mTLS client paths against a cert-requiring server
```

## Live state (2026-11-06)

All four gateways `bank-gw-1..4` run in namespace `paladin`, **enforcing** (`opa.yaml` `dry-run: false`,
`envoy/nodeN.yaml` `failure_mode_allow: false`, fail closed). Lensa's Paladin forwards (`frontend/deploy/forwards.conf`)
go through them. The Paladin `ext_authz` timeout (3s) must stay above the Rego `http.send` timeout of the daily limit (2s).
A gateway rollout drops that node's Lensa forward for 1 to 2 minutes; systemd restarts it.

Deployed 2026-11-06 (every step below was run): signed bundles from `bundle-server` (`bank-gw-opa-v2`; a BI publish reaches all
four gateways in about a minute, no rollout), NetworkPolicy on node1..4 plus `paladin-rpc-from-ingress-nginx` (the public
Ingress still points at the nodes, by decision), mTLS on both doors (`bank-gw-N-mtls`, Lensa `LENSA_GW_MTLS_DIR`), and Lensa's
Besu traffic through bank-gw-1 on 38545 (`LENSA_BESU_RPC`). Scenarios S1 to S6 passed (44/44) before the deploy.

### Deploy the bundle server and signed bundles (ordered; one-time migration of the live gateways)

Run from `besu/opa` (`npm` from `frontend/`) with `export KUBECONFIG=~/.kube/alibaba.yaml`. Do not publish from the Kebijakan screen between step 5 and 6.

1. **Keys:** `bash keys.sh`. Creates `~/.opa-keys/{bi,bank-a,bank-b,bank-c}.pem` (private, mode 600, never overwritten) and `.pub`, and renders
   `~/.opa-keys/opa-config.yaml` (`opa.yaml` plus the public keys). Back up the `.pem` files outside the host; never commit them.
2. **Signed bundles into the existing ConfigMaps** (current policy values, one per node; same names the old file mounts use):
   `OPA_BIN=$HOME/.local/bin/opa OPA_KEYS_DIR=$HOME/.opa-keys npm run policy:build -w server -- N /tmp/gw-N` (N = 1..4), then
   `kubectl -n paladin create configmap bank-gw-N-bundles --from-file=/tmp/gw-N/bi.tar.gz --from-file=/tmp/gw-N/bank.tar.gz --dry-run=client -o yaml | kubectl apply -f -`.
3. **Config ConfigMaps:**
   `kubectl -n paladin create configmap bank-gw-opa-v2 --from-file=opa.yaml=$HOME/.opa-keys/opa-config.yaml` (new name, so a gateway still on the old manifest never reads the new config),
   `kubectl -n paladin create configmap bundle-server-conf --from-file=nginx.conf=bundle-server/nginx.conf`,
   `kubectl -n paladin create configmap bundle-server-sink --from-file=sink.py=bundle-server/sink.py`.
4. **Bundle server:** `kubectl apply -f k8s/bundle-server.yaml`, `kubectl -n paladin rollout status deploy/bundle-server`. Check it serves:
   `kubectl get --raw /api/v1/namespaces/paladin/services/bundle-server:bundles/proxy/2/bi.tar.gz | wc -c` (non-zero) and the sink answers `{}`:
   `kubectl get --raw /api/v1/namespaces/paladin/services/bundle-server:sink/proxy/status`.
5. **Roll the gateways one at a time** (2, 3, 4, then 1). Each rollout drops that node's Lensa forward for about 5 s, for the last time:
   `kubectl apply -f k8s/bank-gw-N.yaml`, `kubectl -n paladin rollout status deploy/bank-gw-N`, then the sink status shows `bank-gw-N` with revisions for `bi` and `bank` and no `code`.
   A new pod that cannot verify or download its bundles never becomes Ready (`maxUnavailable: 0` keeps the old pod serving): look at `kubectl -n paladin logs deploy/bank-gw-N -c opa` and the sink status `message`.
6. **Lensa:** deploy this version, add `OPA_KEYS_DIR=/home/ecs-user/.opa-keys` to `~/.config/lensa/lensa.env`, restart `lensa.service`. Publish one harmless change from the screen and watch the gateway
   status turn to the new version without a port-forward drop.
7. **Check decisions:** `kubectl -n paladin logs deploy/bundle-server -c sink | grep '"gateway":"bank-gw-2"' | tail` shows decisions of all four gateways (masked like the console log).

Rebuild one node's gateway later: `kubectl -n paladin create configmap bank-gw-N-envoy --from-file=envoy.yaml=envoy/nodeN.yaml`, then step 2 for N, then `kubectl apply -f k8s/bank-gw-N.yaml`.

Rollback (the old manifests and the old `bank-gw-opa` ConfigMap are untouched, `bank-gw-N-bundles` still holds a valid bundle pair):
- one gateway: `git show 6e7955e:besu/opa/k8s/bank-gw-N.yaml | kubectl apply -f -` (back to file-mounted, unsigned bundles; `bank-gw-opa` is still the old config);
- all: do that for N = 1..4, then `kubectl delete -f k8s/bundle-server.yaml` and `kubectl -n paladin delete configmap bank-gw-opa-v2 bundle-server-conf bundle-server-sink`;
- Lensa: redeploy commit `6e7955e` (its publisher patches annotations and restarts, and writes unsigned bundles, which only the old gateways accept) and remove `OPA_KEYS_DIR`. Never mix: new Lensa with old gateways, or old Lensa with new gateways, does not confirm a publish.
- Rotate a key: delete `<id>.pem`, `bash keys.sh`, recreate `bank-gw-opa-v2` (step 3), re-sign (step 2 or a publish), `kubectl -n paladin rollout restart deploy/bank-gw-N`.

Read denials, all four gateways in one place: `kubectl -n paladin logs deploy/bundle-server -c sink | grep '"result":false'` (each line has `labels.gateway`).
The console log of one gateway still works: `kubectl -n paladin logs deploy/bank-gw-N -c opa | grep '"result":false'`. Request bodies are masked in both (`system.log.mask`).
Back to dry-run: set `dry-run: true` in `opa.yaml` and `failure_mode_allow: true` in `envoy/nodeN.yaml`, re-run `bash keys.sh`, recreate `bank-gw-opa-v2` and the Envoy ConfigMaps, `kubectl rollout restart` the gateways.
Remove a gateway: point its forward back at `svc/paladin-nodeN`, `kubectl delete -f k8s/bank-gw-N.yaml` and its ConfigMaps.

## Closing the bypasses (three steps, each opt-in and reversible)

Written 2026-11-06 from a read-only look at the live cluster. Order: **1 (Besu route), then 2 (NetworkPolicy), then 3 (mTLS)**.
All three are applied live since 2026-11-06 (see Live state); the steps stay here for a rebuild and the rollbacks.

### 1. Lensa's Besu traffic through the gateway

Before: the `besu` forward ran `127.0.0.1:8545` straight to `besu-node-validator-1`, and `127.0.0.1:8545` is held by a foreign
port-forward (never kill it). Now the `besu` line of `frontend/deploy/forwards.conf` is `besu paladin bank-gw-1 38545:8545`.

- Lensa has **one** Besu URL (`BESU_RPC`, the Stealth adapter's provider, the health probe), so all parties go through
  **bank-gw-1's Besu door**. The Besu rules are BI's and identical on every gateway (`bi.besu`: a method allowlist, no party or
  node in it), so routing through one gateway changes no verdict. The only consequence is availability: if bank-gw-1 or
  validator-1 is down, Stealth is down (before: same, validator-1 was the target).
- The env var `LENSA_BESU_RPC` picks the URL; it wins over the URL stored in `state/stealth.json` (`rpcUrl`). Unset, Lensa keeps `127.0.0.1:8545`.
- Rego needed no change. Everything Lensa sends is already allowed (ethers: `eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`,
  `eth_getLogs`, `eth_call`, `eth_estimateGas`, `eth_gasPrice`, `eth_maxPriorityFeePerGas`, `eth_getTransactionCount`,
  `eth_getTransactionReceipt`, `eth_getTransactionByHash`, `eth_getCode`, `eth_sendRawTransaction`; WebSocket and filters are not used).
  `test/gw/gw_test.rego` now pins this set on all four gateways, and that `eth_subscribe`, filters, `eth_sendTransaction`,
  `eth_accounts`, `txpool_*` stay denied. A request body over 1 MiB is refused by Envoy (`max_request_bytes`); a contract deploy is far below it.
- `bootstrap-stealth` (operator CLI) still takes its own `RPC_URL`; it is not routed.

Live steps:

1. Merge/pull on the Lensa host (no restart yet; `forwards.conf` is read when a forward starts).
2. `systemctl --user restart lensa-pf@besu` (it was waiting on 8545; it now forwards `38545` to `svc/bank-gw-1:8545`).
3. Check: `curl -s -XPOST 127.0.0.1:38545 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'` answers a block number; `eth_getBlockByNumber` works; `admin_peers` answers 403.
4. Add `LENSA_BESU_RPC=http://127.0.0.1:38545` to `~/.config/lensa/lensa.env`, `systemctl --user restart lensa.service`.
5. Check Stealth in Lensa (a read, then a payment). Denials: `kubectl -n paladin logs deploy/bank-gw-1 -c opa | grep '"result":false'`.

Rollback: remove `LENSA_BESU_RPC` from `lensa.env`, restart `lensa.service` (back on 8545). The forward on 38545 can stay.

### 2. NetworkPolicy (`k8s/networkpolicy.yaml`)

**The CNI enforces it.** The cluster runs Terway v1.15.0 (`terway-eniip` DaemonSet, containers `terway` + `policy` on all 21 nodes;
`kube-system/eni-config`: `network_policy_provider: ebpf`, `disable_network_policy: "false"`), not Flannel. Namespaces
`fabricx-*`, `iroha3` and `kaleido` already carry policies, including `default-deny-all` (Ingress+Egress) next to Ready pods with
kubelet probes, so node-to-pod probe traffic is not cut by policy here. Namespaces `paladin` and `besu` had **no** policy before.

Ingress only, no egress rule, selects the Paladin and Besu pods only. Every allowed flow and where it comes from:

| To | Port | From | Evidence |
|---|---|---|---|
| `paladin-nodeN` (label `app=paladin`, `app.kubernetes.io/instance=nodeN`) | 8548 | `bank-gw-N` pods (`app=bank-gw,node=nodeN`) | `bank-gw-N-envoy` cluster `paladin-nodeN:8548`; OPA sidecar daily-limit `http.send` to `data.nodes.nodeN.paladin_url` runs in the same pod |
| same | 8548, 8549 | `paladin-operator` | operator in ns `paladin` reconciles the `Paladin` CRs against the node RPC |
| same | 8548, 8549 | ns `dfabi` pods `app=bankN-backend` only | `deploy/bankN-backend` env `PALADIN_NODE_URL=http://paladin-nodeN.paladin.svc.cluster.local:8548`, `PALADIN_WS_URL=ws://...:8549`. The gateway has no WS door, so DFABI cannot be moved behind it |
| same | 9000 | pods `app=paladin` in ns `paladin` | Paladin gRPC transport: `Paladin` CR `transports[grpc]` port 9000, `externalHostname paladin-nodeN.paladin.svc.cluster.local` |
| same | 6100 | anyone | metrics, unchanged |
| `paladin-*` (object `paladin-rpc-from-ingress-nginx`) | 8548 | ns `kube-system`, pods `app=ingress-nginx` and `app.kubernetes.io/name=ack-ingress-nginx-v1` | `Ingress paladin-nodeN` (nginx, basic auth, `paladin-nodeN.apse5.kld.bi-sandbox.com`, public LB 8.215.48.50) points at `svc/paladin-nodeN:8548`. **This is a live bypass of the gateway**; kept so nothing is cut, see below |
| `besu-node-validator-N` (label `app.kubernetes.io/part-of=besu-node-validator-N`) | 8545 | `bank-gw-N` pods (ns `paladin`) | `bank-gw-N-envoy` cluster `besu-node-validator-N.besu.svc.cluster.local:8545` |
| same | 8545, 8546 | `paladin-nodeN` pod (ns `paladin`) | ConfigMap `paladin-nodeN` `blockchain.http.url`/`ws.url` = `besu-node-validator-N...:8545`/`:8546`; `Paladin` CR `baseLedgerEndpoint` |
| same | 30303 TCP+UDP | any pod in ns `besu` | QBFT P2P: ConfigMap `besu-peers` (`static-nodes.json`, `...besu-node-validator-M-0...besu.svc...:30303`), `discovery-enabled=true` |
| same | 9545 | anyone | Besu metrics, unchanged |

Nothing else was found: no workload, Job, CronJob, ConfigMap, Secret or Ingress in any other namespace names these hosts
(searched all namespaces; `kaleido` runs its own nodes). 8547 (GraphQL) is off in `config.toml`. No NodePort or LoadBalancer
exposes Paladin or Besu. Kubelet probes (`tcpSocket 8548` on Paladin, `httpGet /liveness :8545` on Besu) come from the node itself.
Things the policy **cannot** see: `kubectl port-forward` (the kubelet dials the pod from its node, so it bypasses
NetworkPolicy; that is how Lensa and the foreign 8545 forward still reach pods) and anything running as `hostNetwork`.

Live steps (one node at a time, node 4 first; the flows are the same for every node):

1. `kubectl apply -f k8s/networkpolicy.yaml -l node=node4` (two objects: `paladin-node4-ingress`, `besu-node-validator-4-ingress`).
2. Check, one minute apart:
   - `kubectl -n paladin get pods` and `kubectl -n besu get pods`: no restarts, `READY` unchanged (probes).
   - Lensa: a Zeto read and a transfer on node 4 (through `bank-gw-4`); Besu still gives new blocks (`eth_blockNumber` twice on `127.0.0.1:38545`).
   - `kubectl -n dfabi logs deploy/bank4-backend --tail=20`: no connection errors. `kubectl -n paladin get paladin`: the operator still sees the node.
   - Negative, only when you decide to test (it creates a pod): `kubectl -n paladin run np-probe --rm -it --image=busybox:1.36 --restart=Never -- wget -qO- -T3 http://paladin-node4:8548` must time out.
3. Repeat with `-l node=node3`, `node2`, `node1`, then `-l node=all` (the ingress-nginx allowance, needed as long as the public Ingress points at the nodes).

Rollback: `kubectl delete -f k8s/networkpolicy.yaml -l node=node4` (or without `-l` for all); traffic is open again immediately. The Besu liveness
probe waits 180 s then runs every 60 s with 3 failures to restart: if a validator restarts after step 2, delete its object first.

**Public ingress bypass.** `paladin-rpc-from-ingress-nginx` keeps the existing public route working. To put the public route
behind OPA, apply `k8s/ingress-via-gateway.yaml` (same hosts, annotations, TLS secrets; backend `bank-gw-N:8548`), check one
call through `https://paladin-node2.apse5.kld.bi-sandbox.com`, then `kubectl -n paladin delete networkpolicy paladin-rpc-from-ingress-nginx`.
That changes what external callers may do (OPA rules apply: Zeto, and Noto and Pente scoped as in the rules table). It cannot be combined with step 3 (mTLS) unless the
Ingress also gets `backend-protocol: HTTPS` and a client cert (`nginx.ingress.kubernetes.io/proxy-ssl-secret`). Rollback: re-apply the old Ingress
(`kubectl -n paladin get ingress paladin-nodeN -o yaml` saved before, backend `paladin-nodeN:8548`).

### 3. mTLS Lensa to the gateway (`mtls/`)

Envoy requires a client certificate on **both doors** (8548 Paladin, 8545 Besu): `DownstreamTlsContext` with
`require_client_certificate: true`, TLS 1.2+, trusted CA `/mtls/ca.crt`. `mtls/envoy-mtls.sh envoy/nodeN.yaml` prints the
plain `envoy/nodeN.yaml` with that inserted; the plain file stays the source of truth. The readiness probe stays
`tcpSocket 8548` (a TCP connect needs no handshake, verified against a live Envoy). `k8s/bank-gw-N.yaml` mounts the optional Secret
`bank-gw-N-mtls` at `/mtls`; while the Secret does not exist the volume is empty and nothing changes.

Lensa side, opt-in with `LENSA_GW_MTLS_DIR=<dir with ca.crt, lensa.crt, lensa.key>`: gateway URLs turn into `https://`, the Paladin
SDK client gets `requestConfig.httpsAgent` (`besu/zeto/src/common.ts`, `besu/noto+pente/common/src/config.ts`), JSON-RPC calls,
the health probe and the ethers provider use the same agent (`frontend/server/src/gateway.ts`). Set but unreadable: Lensa does
not start (no silent downgrade). Unset: plain http, as now. The server cert has SANs `bank-gw-N[.paladin[.svc[.cluster.local]]]`,
`localhost`, `127.0.0.1`, so the port-forwarded `https://127.0.0.1:315x8` verifies.

Keys are made on the host, outside the repo, and never committed: `mtls/gen-certs.sh` writes `~/.opa-mtls/` (dir 700, files 600;
it refuses a directory inside the repo). CA 5 years, leaf certs 1 year (re-issue with `FORCE=1 mtls/gen-certs.sh`, then redo step 2 and 3 below).

Live steps (the flip is all-or-nothing for Lensa: its env switches every gateway at once, so expect Lensa to be down while the four
rollouts run, about 10 s each plus the forward restart; do it when no stress run is going):

1. `mtls/gen-certs.sh`
2. For N in 1..4: `D=~/.opa-mtls; kubectl -n paladin create secret generic bank-gw-N-mtls --from-file=tls.crt=$D/gw-N.crt --from-file=tls.key=$D/gw-N.key --from-file=ca.crt=$D/ca.crt`
3. For N in 1..4: `kubectl apply -f k8s/bank-gw-N.yaml` (mounts the Secret; envoy config still plain; wait for the rollout).
4. For N in 1..4, one at a time: `mtls/envoy-mtls.sh envoy/nodeN.yaml > /tmp/nodeN.mtls.yaml`; then
   `kubectl -n paladin create configmap bank-gw-N-envoy --from-file=envoy.yaml=/tmp/nodeN.mtls.yaml --dry-run=client -o yaml | kubectl apply -f -`;
   `kubectl -n paladin rollout restart deploy/bank-gw-N`; wait; `rm /tmp/nodeN.mtls.yaml`.
   Direct check through a forward: `curl -s -o /dev/null -w '%{http_code}\n' --cacert ~/.opa-mtls/ca.crt --cert ~/.opa-mtls/lensa.crt --key ~/.opa-mtls/lensa.key https://127.0.0.1:31648/ -d '{"jsonrpc":"2.0","id":1,"method":"transport_nodeName","params":[]}'`
   answers 200; the same without `--cert/--key` fails the handshake.
5. Add `LENSA_GW_MTLS_DIR=/home/ecs-user/.opa-mtls` to `~/.config/lensa/lensa.env`; `systemctl --user restart lensa.service`.
   Step 4 breaks plain-http Lensa, so do 4 and 5 back to back.
6. Check Lensa: network screen shows all Paladin nodes and Besu up, a Zeto transfer, a Stealth read.

Rollback: remove `LENSA_GW_MTLS_DIR` from `lensa.env`; for N in 1..4 re-create `bank-gw-N-envoy` from plain `envoy/nodeN.yaml`
(`kubectl -n paladin create configmap bank-gw-N-envoy --from-file=envoy.yaml=envoy/nodeN.yaml --dry-run=client -o yaml | kubectl apply -f -`),
`rollout restart deploy/bank-gw-N`, restart `lensa.service`. The Secrets can stay.

Not covered: the client cert is not bound to a party (one `lensa` cert for all four doors: it proves "this is Lensa", not
"this is bank A"); cert rotation needs the rollout restart (Envoy reads files at start).

## Not done (production hardening)

1. The public ingress still bypasses the gateway until `k8s/ingress-via-gateway.yaml` is applied (decision above).
2. DFABI `bankN-backend` talks to Paladin directly (needs the WebSocket port, which the gateway does not proxy).
3. Bundles are signed per owner, but custody is not separated yet: all four private keys sit in one directory on the Lensa host. In production each owner signs on its own side and publishes to its own bundle server.
4. `bundle-server` is one replica without authentication, and no NetworkPolicy: anyone inside the cluster can post fake decision logs or a fake bundle status (Lensa could then confirm a publish that no gateway loaded; it cannot make a gateway load an unsigned bundle). A restarted gateway cannot become Ready while the bundle server is down (`persist` is off: no PVC); running gateways keep their bundles.
