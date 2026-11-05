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
| Paladin, Zeto | `mint` (issuer node only), `transfer`, `createLock`, `spendLock`, `delegateLock`, `cancelLock` on the RD/DFABI contracts; `from` must be the node's own identity | outputs to the 4 participants, amount > 0; transfers and locks capped per tx (sum) |
| Paladin, public | `create` on the Zeto/Noto Atom factories; `execute`/`cancel` on any other address | an Atom's address is known only on chain |
| Paladin, Zeto, limits | BI: `max_per_tx`, `max_mint_per_tx`, `hours` per token, `holidays`, `frozen`; bank: `max_per_tx`, `hours`, `daily_limit` (never looser than BI) | the daily limit asks the bank's own Paladin node for today's total (`ptx_queryTransactionsFull`, domain `zeto`, `created` from 00:00 WIB as UTC, no `from` filter, functions `transfer` and `createLock`), `http.send` timeout 2s, fails closed (no answer, a JSON-RPC error, non-200 or a full page of 1000 denies); counted on submit and without a lock |
| Identities | compared by node (`name@node`, exactly one `@`, both parts non-empty) | a bank is its node: `stress-n2-00@node2` is bank A; freezing `bankC@node4` freezes every `*@node4`; counterparties and participants match by node |
| Paladin, reports | `pgroup_sendMessage` topic `zeto-report-v1` on the node's own {bank, BI} group | |
| Paladin, Noto/Pente | passes unscoped | not ruled yet, so the gateway does not break those flows |
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
- **Not done yet:** live publishing. It needs the approval of the node2 dry-run below first.

## Test

```
opa check --strict bundles/bi bundles/bank test
opa test --coverage bundles/bi bundles/bank test
regal lint bundles test
opa build -b bundles/bi -o /dev/null && opa build -b bundles/bank -o /dev/null   # each bundle must build alone
```

## Deploy node2 in dry-run (needs approval: writes to the live cluster)

`opa.yaml` has `dry-run: true` and `envoy/node2.yaml` has `failure_mode_allow: true`: every request passes and
OPA logs what it would have decided. Keep `failure_mode_allow: true` only while dry-run: when enforcing it must be `false`.
The Paladin `ext_authz` timeout (3s) must stay above the Rego `http.send` timeout of the daily limit (2s).

```
npm run policy:build -w server -- 2 <outdir>   # from frontend/; writes <outdir>/bi.tar.gz and bank.tar.gz with the current policy values
kubectl -n paladin create configmap bank-gw-2-envoy --from-file=envoy.yaml=envoy/node2.yaml
kubectl -n paladin create configmap bank-gw-opa --from-file=opa.yaml
kubectl -n paladin create configmap bank-gw-2-bundles --from-file=<outdir>/bi.tar.gz --from-file=<outdir>/bank.tar.gz
kubectl apply -f k8s/bank-gw-2.yaml
```

Then point `lensa-pf@paladin-node2` (`frontend/deploy/forwards.conf`) at `svc/bank-gw-2` and read would-deny decisions:

```
kubectl -n paladin logs deploy/bank-gw-2 -c opa | grep '"result":false'
```

Rollback: point the forward back at `svc/paladin-node2`, then
`kubectl -n paladin delete -f k8s/bank-gw-2.yaml` and the three ConfigMaps.

## Enforce (later, separate approval)

1. `dry-run: false` in `opa.yaml`, `failure_mode_allow: false` in `envoy/node2.yaml` (both ext_authz filters; keep the Paladin timeout 3s > 2s).
2. mTLS for Lensa (Envoy `DownstreamTlsContext`, Lensa client cert via `PaladinConfig.requestConfig`).
3. NetworkPolicy so `paladin-node2:8548/8549` and `besu-node-validator-2:8545/8546` are reachable only from the
   gateway, Paladin itself and the operator. Allow the kubelet probe (`tcpSocket 8548`). Note that
   `kubectl port-forward` straight to a pod bypasses NetworkPolicy.
4. Production: signed bundles from each owner's bundle server (`opa build --signing-key`, `persist: true`).
