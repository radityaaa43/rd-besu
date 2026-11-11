# zeto S16: gateway per party, own mTLS CA

Repo-only render + offline tests for `final-design/zeto/PLAN.md` S16. Nothing here talks to a cluster.

## What it renders
`./render.sh [-o DIR] <bi|bank-a|bank-b|bank-c|all> [--lensa-cidr CIDR]... [--opa-config FILE]`, per party in `rd-zeto-<party>` (never `paladin`).
N = 1 BI, 2 A, 3 B, 4 C; names `bank-gw-<N>`, node label `node<N>`.

| Object | Source |
|---|---|
| Deployment + Service `bank-gw-<N>` (ClusterIP 8548, 8545) | `opa/k8s/bank-gw-<N>.yaml`, only the namespace lines change (test: pod spec identical) |
| Service `bank-gw-<N>-ext` | NodePort (bi, bank-a, bank-b; cluster 1), LoadBalancer (bank-c; cluster 2); no annotations, no fixed nodePort |
| ConfigMap `bank-gw-<N>-envoy` (key `envoy.yaml`) | `opa/envoy/node<N>.yaml` + `opa/mtls/envoy-mtls.sh`; upstreams `paladin-node<N>.<ns>.svc.cluster.local:8548`, `besu-rpc.<ns>.svc.cluster.local:8545` |
| ConfigMap `bank-gw-opa-v2` (key `opa.yaml`) | `opa/opa.yaml`, or `--opa-config FILE` (opa.yaml + public keys, see Open questions) |
| NetworkPolicy `paladin-ingress` | Paladin 8548 only from `app=bank-gw` and the operator (8549 operator only); 6100 from the namespace |
| NetworkPolicy `bank-gw-ingress` | gateway pods: only 8548/8545; any source, or `--lensa-cidr` ipBlocks |
| NetworkPolicy `allow-same-namespace` | replaces S1's object of the same name: same shape, selector also excludes `app=paladin` |

Not rendered: Secret `bank-gw-<N>-mtls` (keys `ca.crt`, `tls.crt`, `tls.key`), Secret `bundle-sink-token`, namespace (S1), Ingress.

## Own CA per party
`OPA_MTLS_DIR=<new absolute dir outside the repo> ../../../opa/mtls/gen-party-certs.sh <party> [--lensa-client-from lensa.csr]`
creates CA, `gw-<N>` server cert and a Lensa client cert signed by that CA only (dir 700, files 600, no key printed; refuses repo paths and existing dirs).
With `--lensa-client-from` Lensa keeps its key: the CSR is signed, no `lensa.key` is written.

## Apply order (party applies in its own namespace; GO per party)
1. S1 namespace objects exist (applied earlier). 2. `gen-party-certs.sh <party>`, then create Secret `bank-gw-<N>-mtls` and `bundle-sink-token` (command in the script header).
3. `render.sh <party> --opa-config <party opa-config.yaml> | kubectl apply -f -`. 4. Lensa gets `ca.crt` + `lensa.crt/key` of THAT party only.
Re-applying the S1 render afterwards re-opens Paladin 8548 (it restores the old `allow-same-namespace`): apply S1 first, S16 last.
Rollback (PLAN): delete Deployment, Services, ConfigMaps, Secrets in `rd-zeto-<party>`; re-apply S1's `allow-same-namespace`.

## Self-checks
Offline: `./test.sh` (render shape, cert chains, a real TLS 1.2 handshake on 127.0.0.1: A's Lensa cert is refused by B's gateway, B's is served).
PLAN RED proof on the cluster (S16 VERIFY, not run here): party B's client cert, `curl --cert ... https://127.0.0.1:<fwd bank-gw-2> -d '{"method":"transport_nodeName"}'`
-> TLS handshake failure; party A's cert -> `"node2"` (call must be allowed by the bank bundle: unverified). Before: one shared Lensa cert opens all four.

## Assumptions
- Besu upstream is `besu-rpc.<ns>` (zeto/k8s/besu/render.sh Service), not `besu-node-validator-<N>.besu` of the old envoy files.
- Gateway pod spec, images, `--set=bundles.*.resource=<N>/...` and `bundle-server` URLs are copied unchanged (S17 may change them; bundle-server is in the same namespace).
- NetworkPolicies only add, so Paladin 8548 can be closed only by narrowing S1's `allow-same-namespace` (replacement object above).
- Operator keeps 8548/8549 as in `opa/k8s/networkpolicy.yaml`; other same-namespace pods (psql jobs, probes) lose Paladin 8548/8549 access.
- NodePort/LB traffic source is not known (CNI SNAT unverified): default is any source on 8548/8545, mTLS is the gate. Narrow with `--lensa-cidr`.
- Secret name `bundle-sink-token` as in `opa/k8s/bank-gw-1.yaml:61` (the task text said `sink-token`, that is the volume name).

## Open questions
- Lensa reaches `https://<NodePort/LB IP>:<port>`: the server cert has no IP SAN, so Lensa must set the TLS servername to `bank-gw-<N>` (or the cert needs the LB IP, known only after the LB exists).
- `--opa-config` file (public keys of bundle owners) is produced by `opa/keys.sh` outside the repo; per-party bundle keys are S17.
- Cloud annotations/ACL for the bank-c LoadBalancer (spend, S19) are not rendered.
- `allow-same-namespace`: fold the `paladin` exclusion into the S1 template instead? (changes S1 tests, lead decides)
