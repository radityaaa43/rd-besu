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
| Paladin, Zeto, limits | BI: `max_per_tx`, `max_mint_per_tx`, `hours` per token, `holidays`, `frozen`; bank: `max_per_tx`, `hours`, `daily_limit` (never looser than BI) | the daily limit asks the bank's own Paladin node for today's total (`ptx_queryTransactionsFull`, domain `zeto`, `created` from 00:00 WIB as UTC, no `from` filter, functions `transfer` and `createLock`), `http.send` timeout 2s, fails closed (no answer, a JSON-RPC error, non-200 or a full page of 1000 denies); counted on submit and without a lock |
| Identities | compared by node (`name@node`, exactly one `@`, both parts non-empty) | a bank is its node: `stress-n2-00@node2` is bank A; freezing `bankC@node4` freezes every `*@node4`; counterparties and participants match by node |
| Paladin, reports | `pgroup_sendMessage` topic `zeto-report-v1` on the node's own {bank, BI} group | |
| Paladin, Noto/Pente | any private tx that is not Zeto passes unscoped | not ruled yet, so the gateway does not break those flows |
| Besu | method allowlist, every call in a batch | `admin_*`, `qbft_*`, `perm_*`, `debug_*`, `txpool_*` denied |

Not covered: the duty to report to BI after a bank-to-bank transfer (BI's reconciliation flags `unreported`),
and whether `delegateLock` hands a lock to a legitimate Atom.

**Placeholders:** `max_per_tx` (`RD: 1000000000`, `DFABI: 1000`) in `seeds/bi.json` until BI sets the real limits.

## Lensa: Halaman Kebijakan

Lensa edits the two kinds of document (BI's `bi`, each bank's `bank-a|b|c`) on the screen **Kebijakan**
(`/besu/zeto/kebijakan`, Zeto only; disabled with a reason on Noto, Stealth, Fabric-X and Iroha 3). A change is drafted by one
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
```

## Live state (2026-11-05)

All four gateways `bank-gw-1..4` run in namespace `paladin`, **enforcing** (`opa.yaml` `dry-run: false`,
`envoy/nodeN.yaml` `failure_mode_allow: false`, fail closed). Lensa's Paladin forwards (`frontend/deploy/forwards.conf`)
go through them. The Paladin `ext_authz` timeout (3s) must stay above the Rego `http.send` timeout of the daily limit (2s).
Each gateway rollout drops that node's Lensa forward for about 5 s; systemd restarts it.

**Status of the signed-bundle change:** in git only. The cluster still runs the file-mounted, unsigned gateways (`bank-gw-opa`, publish by
annotation and rollout) until the steps below are done.

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

Not in front of the gateway: Lensa's Besu forward on 127.0.0.1:8545 is held by another (non-Lensa) port-forward
straight to `besu-node-validator-1`; the Besu door is live on every gateway (`svc/bank-gw-N:8545`) but Lensa's Besu
traffic does not pass it until that forward is replaced.

## Not done (production hardening)

1. mTLS for Lensa (Envoy `DownstreamTlsContext`, Lensa client cert via `PaladinConfig.requestConfig`).
2. NetworkPolicy so `paladin-node2:8548/8549` and `besu-node-validator-2:8545/8546` are reachable only from the
   gateway, Paladin itself and the operator. Allow the kubelet probe (`tcpSocket 8548`). Note that
   `kubectl port-forward` straight to a pod bypasses NetworkPolicy.
3. Bundles are signed per owner now, but custody is not separated yet: all four private keys sit in one directory on the Lensa host. In production each owner signs on its own side and publishes to its own bundle server.
4. `bundle-server` is one replica without authentication, and no NetworkPolicy: anyone inside the cluster can post fake decision logs or a fake bundle status (Lensa could then confirm a publish that no gateway loaded; it cannot make a gateway load an unsigned bundle). A restarted gateway cannot become Ready while the bundle server is down (`persist` is off: no PVC); running gateways keep their bundles.
