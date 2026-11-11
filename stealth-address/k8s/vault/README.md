# stealth-address/k8s/vault: per-party key store (final-design/stealth/PLAN.md S7)

README decision 28 chose Vault (product and spend confirmed by the user before the CLUSTER-OP). Manifests, values for the pinned upstream chart, render script,
offline test and runbook snippets. Nothing here talks to a cluster and no key material is in git; applying is a separate approved CLUSTER-OP (S7 window).
Stacked on #14 (stealth L0 namespaces); retarget to `main` after #14 merges.

| File | What |
|---|---|
| `values.yaml` | values for chart `hashicorp/vault` **0.34.1** (Vault **2.0.4**): standalone, file storage on a 20Gi `alicloud-essd` PVC, injector/csi/ui off, `fullnameOverride: vault`, own NetworkPolicy and auth-delegator |
| `templates/access.yaml` | ServiceAccount `stealth-signer` (token on) + NetworkPolicy `vault-ingress` (only pods `app=stealth-signer` of the same namespace, TCP 8200) |
| `templates/auth-delegator.yaml` | the only cluster-scoped object: ClusterRoleBinding `vault-auth-delegator-<ns>` (`system:auth-delegator` for SA `vault`), applied by the cluster operator |
| `policies/stealth-signer.hcl` | the signer reads exactly `secret/data/stealth-keys` |
| `render.sh` | `<bi\|bank-a\|bank-b\|all>`, `values <party>`, `cluster <party>`, `probe <own> <other>`; `bank-c` (cluster 2) is refused |
| `test.sh`, `test/check.py` | offline assertions; `VAULT_CHART_DIR=<unpacked chart 0.34.1>` also renders the real chart with helm (else SKIP is printed) |

Stealth S1 change in this PR: `allow-same-namespace` now selects `app.kubernetes.io/name NotIn [vault]` (policies are additive; without it `st-gw` and every other pod of the namespace reach the key store).

## Apply (S7 window, operator)
```
./render.sh bank-a | kubectl apply -f -                                   # SA stealth-signer + vault-ingress
./render.sh cluster bank-a | kubectl apply -f -                           # cluster operator only
./render.sh values bank-a > /tmp/v-bank-a.yaml
helm install vault vault --repo https://helm.releases.hashicorp.com --version 0.34.1 -n rd-stealth-bank-a -f /tmp/v-bank-a.yaml
```
Initialise once per party, by that party's operator, shares and root token never in chat, git or logs (`-key-shares`/`-key-threshold` are the party's call):
```
kubectl -n rd-stealth-bank-a exec vault-0 -- vault operator init -key-shares=5 -key-threshold=3 > <operator-only file>
kubectl -n rd-stealth-bank-a exec -it vault-0 -- vault operator unseal         # threshold times, after every pod restart
```
Configure with the operator token (`VAULT_TOKEN` in the operator's shell; `kubectl exec` into `vault-0`):
```
vault secrets enable -path=secret kv-v2
vault auth enable kubernetes
vault write auth/kubernetes/config kubernetes_host=https://kubernetes.default.svc
vault policy write stealth-signer - < policies/stealth-signer.hcl
vault write auth/kubernetes/role/stealth-signer bound_service_account_names=stealth-signer \
  bound_service_account_namespaces=rd-stealth-bank-a policies=stealth-signer ttl=15m
```
Keys enter `secret/stealth-keys` (field names: bank `spendKey viewKey identityKey`; BI `issuerKey custodianKey registryKey biMeta`; S9/S10 move them) through a channel the operator chooses.

## RED proofs (PLAN S7)
Before: no `vault` StatefulSet in the namespace. After install and configure:
```
./render.sh probe bank-a bank-b | kubectl apply -f -     # wait ~30 s; pods print no secret value
kubectl -n rd-stealth-bank-a logs vprobe-signer vprobe-wrongsa vprobe-gw ; kubectl -n rd-stealth-bank-b logs vprobe-other
./render.sh probe bank-a bank-b | kubectl delete -f -
kubectl -n rd-stealth-bank-a get secret -o name            # no key Secret: only helm release and service-account secrets, none named stealth-keys
```
Expected: `vprobe-signer READ-OK`, `vprobe-wrongsa LOGIN-DENIED`, `vprobe-gw rd-stealth-bank-a-8200 BLOCKED`, `vprobe-other rd-stealth-bank-a-8200 BLOCKED`.
`READ-DENIED`, `REFUSED`, `ERROR`, `LOGIN-OK-UNEXPECTED` are not passes. Rollback: `helm uninstall vault -n <ns>`, delete PVC `data-vault-0`, SA, NetworkPolicy, ClusterRoleBinding (empty before S9).

## Open / recorded gaps
- **Seal**: Shamir (chart default). After any pod restart the store is sealed and the signer fails until the operator unseals. Auto-unseal needs a KMS: a separate product and spend, not chosen.
- **TLS**: Vault listens plain HTTP inside the namespace (`vault-ingress` is the only guard). TLS inside the namespace is not planned here.
- **Cluster-scoped binding**: `vault-auth-delegator-<ns>` is the one cluster-scoped grant (TokenReview). Whether kubernetes auth works as configured on ACK is [unverified]; the alternative is AppRole (a Secret again).
- **Probe image applets** (`nc`, `timeout`, exit codes 124/143) in `hashicorp/vault:2.0.4` are [unverified] until the first run; the probe pods print `ERROR` or `REFUSED` if wrong, which is not a result.
- **Hard limit 6** (PLAN): the signer holds the spending key in memory; Vault holds it at rest only. **Licence**: Vault has been under BUSL since 1.16; the licence of 2.0.4 was not read [unverified]; OpenBao is the open fork if that matters [not decided here].
- Sizes (20Gi PVC, 100m/256Mi requests) are a first guess [unverified]; backup of the store = Raft/file snapshot policy is not defined (product decision).
