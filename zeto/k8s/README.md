# zeto/k8s: per-party namespaces (final-design/zeto/PLAN.md S1)

Manifests only. Nothing here talks to a cluster; applying them is a separate, approved CLUSTER-OP (S1 window).

| File | What |
|---|---|
| `templates/party.yaml` | Namespace `rd-zeto-<party>` (labels `part-of=rd-zeto`, `party=<party>`), NetworkPolicies `default-deny-ingress`, `allow-same-namespace`, `allow-dns-egress`, `rehearsal-no-9000-egress`, ServiceAccount + Role + RoleBinding `party-admin` |
| `templates/lensa-publisher.yaml` | `bi` only, INTERIM until S20: ServiceAccount + Role + RoleBinding `lensa-publisher` (`get services/proxy` on `bundle-server`) |
| `probe/listeners.yaml`, `probe/probe-pod.yaml` | Throwaway egress proof (PLAN S1 RED). All objects carry `throwaway=zeto-s1-probe` |
| `render.sh` | `render.sh [-o DIR] <bi\|bank-a\|bank-b\|all>`, `render.sh probe <own> <other>` |
| `test.sh`, `test/check.py` | Offline assertions on the rendered output (names, labels, verbs, port ranges); needs bash + python3 + PyYAML |

Parties: `bi`, `bank-a`, `bank-b` (cluster 1). `bank-c` is cluster 2 (S2) and `render.sh` refuses it.

## Policy semantics
NetworkPolicies are additive per pod. Egress stays open (PLAN S1), so `allow-dns-egress` selects only pods WITHOUT `app=paladin`;
`rehearsal-no-9000-egress` selects `app=paladin` and allows TCP 1-8999 and 9001-65535 plus UDP (DNS 53 is inside). Lifted in S21 by deleting that object.

## Probe (run in the S1 window, then delete by label)
```
./render.sh probe bank-a bank-b | kubectl apply -f -
kubectl -n rd-zeto-bank-a logs probe-paladin probe-control      # expected lines are in probe/probe-pod.yaml
./render.sh probe bank-a bank-b | kubectl delete -f -
```

## Not granted to `party-admin` (extended in the S9 PR)
`pods/portforward`, `pods/exec` (S5 votes, S9 psql), Paladin CRs, cert-manager Certificates, anything cluster-scoped.
