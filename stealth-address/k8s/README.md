# stealth-address/k8s: per-party namespaces (final-design/stealth/PLAN.md S1, L0)

Manifests only. Nothing here talks to a cluster; applying them is a separate, approved CLUSTER-OP.

| File | What |
|---|---|
| `templates/party.yaml` | Namespace `rd-stealth-<party>` (labels `part-of=rd-stealth`, `party=<party>`), NetworkPolicies `default-deny-ingress`, `allow-same-namespace`, `allow-dns-egress`, ServiceAccount + Role + RoleBinding `party-admin` |
| `render.sh` | `render.sh [-o DIR] <bi\|bank-a\|bank-b\|all>` |
| `test.sh`, `test/check.py` | Offline assertions on the rendered output (names, labels, verbs, no cluster-scoped RBAC); needs bash + python3 + PyYAML |

Parties: `bi`, `bank-a`, `bank-b` (cluster 1). `bank-c` is cluster 2 and `render.sh` refuses it unless `--cluster 2` is given.

## Cluster 2 (PLAN S2, L0-SG)
`render.sh --cluster 2 --ns-only bank-c` = the Namespace doc alone, label `cluster="2"` (GO 1). `render.sh --cluster 2 bank-c` = the same objects as cluster 1
(3 policies, `party-admin`), every object labelled `cluster="2"` (GO 2). `--cluster 2` accepts `bank-c` only; `all`, other parties and `bank-c` without the flag are refused.
No probe (stealth has no Paladin node). Apply with a variable, never a path: `render.sh --cluster 2 --ns-only bank-c | kubectl --kubeconfig "$KUBECONFIG_C2" apply -f -`.
Never `kubectl get ns` without a name on cluster 2.

## Policy semantics
Stealth has no Paladin node, so there is no rehearsal egress policy and no probe. Egress stays open (Besu p2p to the validators, JWT RPC reads, DNS):
`allow-dns-egress` selects all pods with an allow-all rule. Ingress is denied except from the same namespace; later steps add the gateway and p2p rules.

## `party-admin`
`secrets`: `create`, `update`, `patch` only (never get/list/watch). Workloads, services, configmaps, PVCs, networkpolicies, pods, `pods/log` as in zeto S1, plus
`batch` jobs and cronjobs (the S11 view-key compare CronJob in `rd-stealth-bi`). Not granted: `pods/portforward`, `pods/exec`, anything cluster-scoped.
