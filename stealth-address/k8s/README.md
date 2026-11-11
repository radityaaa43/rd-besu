# stealth-address/k8s: per-party namespaces (final-design/stealth/PLAN.md S1, L0)

Manifests only. Nothing here talks to a cluster; applying them is a separate, approved CLUSTER-OP.

| File | What |
|---|---|
| `templates/party.yaml` | Namespace `rd-stealth-<party>` (labels `part-of=rd-stealth`, `party=<party>`), NetworkPolicies `default-deny-ingress`, `allow-same-namespace`, `allow-dns-egress`, ServiceAccount + Role + RoleBinding `party-admin` |
| `render.sh` | `render.sh [-o DIR] <bi\|bank-a\|bank-b\|all>` |
| `test.sh`, `test/check.py` | Offline assertions on the rendered output (names, labels, verbs, no cluster-scoped RBAC); needs bash + python3 + PyYAML |

Parties: `bi`, `bank-a`, `bank-b` (cluster 1). `bank-c` is cluster 2 and `render.sh` refuses it.

## Policy semantics
Stealth has no Paladin node, so there is no rehearsal egress policy and no probe. Egress stays open (Besu p2p to the validators, JWT RPC reads, DNS):
`allow-dns-egress` selects all pods with an allow-all rule. Ingress is denied except from the same namespace; later steps add the gateway and p2p rules.

## `party-admin`
`secrets`: `create`, `update`, `patch` only (never get/list/watch). Workloads, services, configmaps, PVCs, networkpolicies, pods, `pods/log` as in zeto S1, plus
`batch` jobs and cronjobs (the S11 view-key compare CronJob in `rd-stealth-bi`). Not granted: `pods/portforward`, `pods/exec`, anything cluster-scoped.
