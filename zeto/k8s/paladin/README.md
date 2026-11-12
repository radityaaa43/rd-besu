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

## S10: transport endpoint per node (PLAN S10; orchestrator "GO S10b", per-node CA, existing ACL ids only)
Repo parts: `render.sh transport <party> ...`, `render.sh <party> --transport-host <LB IP>`, `gen-certs.sh`, `render.sh probe-listener|probe-client`. Nothing here talks to a cluster.
Facts that shaped it (paladin@v1.0.0): the published endpoint is `dns:///<externalHostname>:9000` (`grpc_transport.go:105,337`), a peer dials that target (`outbound_conn.go:61`) and verifies by cert CN = node name and the registry `issuers` only, with no SAN/hostname check (`grpc_transport.go:136`, `tls_verifier.go:138-195`), so `externalHostname` = the node's own LB IP and the SAN is hygiene.
Jakarta pods reach a Jakarta LB IP inside the cluster (kube-proxy), so the ACL only has to admit the OTHER cluster's egress (the three Jakarta zeto validators already peer that way through their p2p LB IPs). **PLAN deviation:** the CRD requires `transports[].tls.certName` as well as `secretName` (server dry-run rejected secretName only), so the CR sets both to `paladin-node<N>-mtls` and NO issuer; the operator creates a Certificate only if the Secret is missing (`paladin_controller.go:1352-1360`), so the Secret must exist first.

Order per party (bi, bank-a, bank-b, then bank-c; stop at the first error; admin kubeconfig, named ns):
1. `render.sh transport <p> --external-cidr <other cluster egress /32> --acl-id <the party's p2p ACL id>` (cluster 1: acl-d9ji5nwbqutwulof33ydb + 47.237.84.150/32; bank-c: the cluster-2 ACL + 8.215.62.92/32): server dry-run, apply, read the new LB IP, verify the ACL on the listener. Only then (opt-in) re-render with `--clb-health-cidr 100.64.0.0/10`.
2. `PALADIN_MTLS_DIR=/dev/shm/paladin-mtls-<p> ./gen-certs.sh <p> <LB IP>`; create Secret `paladin-node<N>-mtls` (tls.crt, tls.key, ca.crt) and Secret `paladin-ca-node<N>` (ca.key, ca.crt) by `kubectl create secret generic ... --from-file=<file>` from that dir, then `shred -u` every file and remove the dir; quote `ls /dev/shm/paladin-mtls-<p>` -> No such file.
3. `render.sh <p> --transport-host <LB IP>` and apply (the operator regenerates `pldconf.paladin.yaml` with `transports.grpc`; the stub stays replicas 0). Self-checks: `get svc paladin-transport` EXTERNAL-IP; both Secrets by name; ConfigMap has `transports.grpc` (externalHostname = LB IP, port 9000, tls enabled, clientAuth true, cert paths); sts replicas 0; 0 paladin pods.
4. Probes, before S21: `render.sh probe-listener <p>` (nc listener with the node's labels, no Paladin process) in the target ns, then `render.sh probe-client <client party> <name> <LB IP>` from every other party's ns (positives: Jakarta -> every Jakarta LB and -> the bank-c LB; bank-c -> the 3 Jakarta LBs), then the hosted-runner negative (`lb-external-probe` workflow: refusal expected). Delete all probe pods (`throwaway=zeto-s10-probe`). A failed positive = stop, no ACL change.

### S10b run notes (2026-11-11, sha 795a1d0)
Applied on the four parties, LB IPs bi 8.215.50.4, bank-a 8.215.7.78, bank-b 8.215.47.22, bank-c 47.84.72.91. Disclosed script bug of the operator run (no write happened before it was fixed): the external CIDR for `--external-cidr` was first read from `besu-p2p` `spec.loadBalancerSourceRanges`, which only bi has. **Live drift between the p2p Services:** bi `besu-p2p` has `backend-type: eni`, `externalTrafficPolicy: Cluster` and `loadBalancerSourceRanges`; bank-a and bank-b have the ACL annotations only, `externalTrafficPolicy: Local`, no eni, no source ranges (bank-c has eni + Cluster). The transport Services are uniform (eni, Cluster, ranges = the other cluster's egress), the CIDR comes from the `besu-validator-ingress` ipBlock (47.237.84.150/32 for cluster 1, 8.215.62.92/32 for bank-c). Aligning the three p2p Services is a separate, later change (`render.sh net --acl-id`, zeto/k8s/besu #30). The cutover request text is in `S21.md`.

### Re-applying the CR after S10b
The live CR carries the transport (applied with `--transport-host <LB IP>`); a plain `render.sh <p>` has no transport and would REVERT it (server dry-run shows "configured"). Always re-apply with the same `--transport-host` (bi 8.215.50.4, bank-a 8.215.7.78, bank-b 8.215.47.22, bank-c 47.84.72.91). LimitRange `paladin-defaults` gives the paused node's future pod its requests/limits (operator sets none: only PVC sizes are set in paladin_controller.go; the stub's containers are replaced at :297-306).
Clock: times in the run notes are the host `date` (CST = UTC+8; 15:09 UTC = 23:09 CST on 2026-11-11).

### Placement (R22): what the operator config does and does not do (2026-11-12, move-1 attempt)
`render.sh` puts `paladin.labels = {app, rd/role: paladin-node}` and a required `podAntiAffinity` (rd/role=paladin-node, namespaces part-of=rd-zeto, topologyKey hostname) into the ConfigMap `paladin-operator` key `config.json`. Live finding with operator v1.0.0 (LFDT-Paladin/paladin@6d4b91343426d17d713a0d61dfbcb2e262cb346d, `operator/internal/controller/paladin_controller.go`):
- `generateStatefulSetTemplate` (line 463) copies `config.Paladin.Affinity` into a NEW StatefulSet only. For an EXISTING StatefulSet the update path (lines 295-300, "Only update safe things") copies only containers, volumes, template annotations and template labels. So the labels reach the node pod (and roll it), the affinity does NOT. Observed on node2: label `rd/role` copied within seconds, `spec.template.spec.affinity` stayed empty after more than 2 minutes, the pod rolled and landed on the same worker again. Rolled back; the config in the repo is unchanged.
- Consequence: the anti-affinity in `config.json` only takes effect for a StatefulSet the operator creates. For the existing four it needs a direct patch of the StatefulSet's `spec.template.spec.affinity` (the operator does not overwrite that field), which is a separate, approved step.
- A pod with no requests (BestEffort) fits any worker, so placement is the scheduler's choice until an affinity is on the StatefulSet.
