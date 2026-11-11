# zeto S9: Paladin node per party (rehearsal copy, scaled to 0)

`final-design/zeto/PLAN.md` S9. AFTER: `ARCHITECTURE-zeto` 2a "one Paladin node per bank" + lead decision "static config, contracts unchanged".
Renders, per party, the namespaced Paladin operator (SA, Role, RoleBinding, ConfigMap, Deployment), a paused StatefulSet stub `paladin-node<N>` (replicas 0) and one `Paladin` CR `node<N>`
(bi=node1, bank-a=node2, bank-b=node3, bank-c=node4: the node number is the Zeto owner key name `bi@node1`).

```
./render.sh [-o DIR] <bi|bank-a|bank-b|bank-c|all>   # stdout, or DIR/rd-zeto-<p>-paladin.yaml
./test.sh                                            # offline: bash + python3 + PyYAML, no cluster
```

## DELTA against PLAN S9 (and why)

| PLAN says | This render | Why / source |
|---|---|---|
| PaladinDomain CRs + PaladinRegistry `evm-registry` | `noto`, `pente`, `zeto` domains and `evm-registry` are static in `spec.config`, with the four live addresses | A PaladinDomain/PaladinRegistry takes its address from a `SmartContractDeployment`, i.e. the operator would deploy NEW factory/registry contracts in the new ns. Contracts stay unchanged (CONTRACTS.md). "A domain is either wholely defined in the static config of the node, or wholely defined by reference to the CR ... We do not attempt to merge": paladin@v1.0.0:operator/internal/controller/paladin_controller.go:1194-1196. `test/check.py` compares the block with the config the live operator generated for node1 (`test/fixtures/live-domains-registries.json`). |
| Helm `paladin-operator` per ns | the chart's operator templates rendered by hand with the live values | chart needs `helm dependency build` (crd + prometheus subcharts): offline `helm template` fails. Image pinned to the digest the live pod runs. No Service (unused), no cluster-scoped object. |
| CRD chart installed once on cluster 2 (user-only) | **no CRD install** | Named reads 2026-11-11: cluster 2 already has all 8 `*.core.paladin.io` CRDs, `paladin-operator-crd-1.0.0` (release `paladin-crds`, ns `privacydev`), created 2026-07-29, same chart version as cluster 1. They are another owner's: we do not apply, patch or delete them. |
| `database.mode preConfigured` | plus `db.type: postgres`, DSN and `dsnParams.database` in `spec.config` | `preConfigured` sets neither type nor DSN (paladin_controller.go:1041-1080); `passwordSecret` mounts the Secret at `/db-creds` and adds `username`/`password` params only, so the DB name is read from the same Secret (key `database`, S8) via `dsnParams.database`. |

Known upstream behaviour: Paladin v1.0.0 logs the fully templated DSN, password included, at WARN on start (`core/go/pkg/persistence/gorm.go:133`, `REMOVE: DSN=`). The old nodes do the same. Never paste or ship Paladin pod logs; no custom Paladin code (user rule), so this is documented, not patched.
The Role is the chart's verbatim, so it keeps the cert-manager `certificates` rule; S9 renders no tls (S10 adds `transports[0].tls` from our own script, no cert-manager).

## Prerequisites (all must hold before the apply)

S5a, S6 (Secret `node<N>.keys` in the ns), S8 (Postgres restored, row counts equal, Secret `paladin-pg-credentials` with `username`/`password`/`database`), S1 egress proof (probe to another party's 9000 fails), and
`ptx_queryPendingTransactions` -> `[]` on all 4 OLD nodes (a restored Prepared tx would be re-dispatched with the same signer keys: nonce clash). bank-c also needs its own Postgres (S8 renders cluster 1 only).

## Paused start (orchestrator deviation: no rehearsal start; replicas-0 stub as the config proof)
Rule: no Paladin node process runs with the real `node<N>.keys` before S21. The `Paladin` CR has **no replicas field** (CRD spec: authConfig, baseLedgerEndpoint, besuNode, config, database, domains,
logPersistence, registries, rpcAuth, secretBackedSigners, service, signingModules, transports; paladin@v1.0.0:operator/config/crd/bases/core.paladin.io_paladins.yaml). The operator creates its StatefulSet only if
none exists (paladin_controller.go:287-292) and on update touches only containers, volumes and template annotations/labels (:297-306), never replicas. So the render carries a StatefulSet stub `paladin-node<N>`
with `replicas: 0` and the exact name, selector and labels the operator would use; it is applied BEFORE the CR. The operator then finds it, merges its template and generates the `pldconf.paladin.yaml` ConfigMap; no pod ever starts.
The stub has no ownerReference: **deleting the CR does not delete the stub** (rollback deletes both explicitly). The CRD also requires `domains`, `registries`, `transports` in the spec: the first S9 render (#28) omitted the first two and was rejected by
`kubectl apply --dry-run=server` (nothing had been applied); now `domains: []`, `registries: []` and `test/check.py` checks the render against the CRD fields in `test/fixtures/paladin-crd-spec.json`.

## Apply (CLUSTER-OP, per party, admin kubeconfig, named ns only; cluster 2 = `alibaba-sg.yaml`)

1. `./render.sh <party> > /tmp/p.yaml` from the merged sha (quote it); `kubectl apply --dry-run=server -f /tmp/p.yaml`.
2. `kubectl apply -f /tmp/p.yaml` (document order: operator objects, stub StatefulSet, CR). Wait `deploy/paladin-operator` Available.
3. Self-checks (all must hold): Deployment Available; `kubectl -n <ns> get paladin node<N>` present; ConfigMap `paladin-node<N>` has key `pldconf.paladin.yaml`; `get sts paladin-node<N>` replicas 0; `get pods -l app=paladin` none.
   Compare the generated `pldconf.paladin.yaml` with the PLAN S9 row: domains noto/pente/zeto + registry addresses, `blockchain` URLs = own `besu-rpc`, `db` type/DSN shape, `keyManager.disableSignRPC: true`, wallets from `node<N>.keys`.
4. Real start (S21 only, with the old node scaled to 0 first): `kubectl -n rd-zeto-<p> scale sts paladin-node<N> --replicas=1`.

## Proofs left for S21 (need a running node)
- tx id list from the new node (`ptx_queryTransactionsFull`, limit 60) equals the old node's saved list; `bi@node1` (known names only) resolves to `owners.BI` of `state/zeto.json` / eth address `0xc77e80b8878c2509552b16336d5fc9bb0dc415a9`; `keymgr_sign` -> RPC error; connect to another party's 9000 fails.

Rollback: delete the Paladin CR, then the StatefulSet stub, then the operator objects of the ns; the Postgres copy and the old nodes are untouched.
