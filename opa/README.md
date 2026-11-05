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
```

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

- **Turn on:** set `OPA_BIN=/home/ecs-user/.local/bin/opa` in `~/.config/lensa/lensa.env` and restart `lensa.service`. Without it, or when setup fails, every `/api/policy*` route answers 501 and the rest of Lensa works.
- **State:** `frontend/server/state/policy/<owner>/` holds `v<N>.json`, `pending.json` and `audit.jsonl`. Version 1 is the file in `seeds/`.
- **Check before a draft is stored:** the `check` packages of both bundles (shape, ranges, bank not looser than BI, identities: exactly one `@`) and `opa test`; a failure answers 422 with the messages ("Kebijakan tidak valid" for a check error, "Uji kebijakan gagal" when any `opa test` case fails). A validator that returns no list at all (for example a renamed package) is a server error, never "valid".
- **Publish** (after approval), one gateway at a time, for the gateways whose Deployment `bank-gw-<node>` exists (BI's change: all four, a bank's: its own node):
  1. `opa build -b` for `bi` and `bank` (the bank bundle builds alone and reads BI's values as data only);
  2. apply ConfigMap `bank-gw-<node>-bundles` (`bi.tar.gz`, `bank.tar.gz`);
  3. set the pod-template annotations `policy.lensa/bi` and `policy.lensa/bank` to the version numbers, which rolls the Deployment;
  4. wait for the rollout (120 s). On failure the previous ConfigMap and annotations are put back and the change shows "Gagal diterbitkan" with "Terbitkan ulang".
- **Guard:** the kube module refuses any name outside `bank-gw-[1-4]` and `bank-gw-[1-4]-bundles`.
- **Build only, no cluster:** `npm run policy:build -w server -- <node> <outdir>` (from `frontend/`).
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

Install or rebuild one node (N = 1..4; the screen's publish does the bundle part itself):

```
npm run policy:build -w server -- N <outdir>   # from frontend/; current policy values
kubectl -n paladin create configmap bank-gw-N-envoy --from-file=envoy.yaml=envoy/nodeN.yaml
kubectl -n paladin create configmap bank-gw-opa --from-file=opa.yaml          # shared, once
kubectl -n paladin create configmap bank-gw-N-bundles --from-file=<outdir>/bi.tar.gz --from-file=<outdir>/bank.tar.gz
kubectl apply -f k8s/bank-gw-N.yaml
```

Read denials: `kubectl -n paladin logs deploy/bank-gw-N -c opa | grep '"result":false'`.
Back to dry-run: set `dry-run: true` and `failure_mode_allow: true`, re-apply the ConfigMaps, `kubectl rollout restart`.
Remove a gateway: point its forward back at `svc/paladin-nodeN`, `kubectl delete -f k8s/bank-gw-N.yaml` and its ConfigMaps.

Not in front of the gateway: Lensa's Besu forward on 127.0.0.1:8545 is held by another (non-Lensa) port-forward
straight to `besu-node-validator-1`; the Besu door is live on every gateway (`svc/bank-gw-N:8545`) but Lensa's Besu
traffic does not pass it until that forward is replaced.

## Not done (production hardening)

1. mTLS for Lensa (Envoy `DownstreamTlsContext`, Lensa client cert via `PaladinConfig.requestConfig`).
2. NetworkPolicy so `paladin-node2:8548/8549` and `besu-node-validator-2:8545/8546` are reachable only from the
   gateway, Paladin itself and the operator. Allow the kubelet probe (`tcpSocket 8548`). Note that
   `kubectl port-forward` straight to a pod bypasses NetworkPolicy.
3. Production: signed bundles from each owner's bundle server (`opa build --signing-key`, `persist: true`).
