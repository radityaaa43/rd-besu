# stealth-address/k8s/vault: per-party key store (final-design/stealth/PLAN.md S7)

README decision 28 chose Vault (product and spend confirmed by the user before the CLUSTER-OP). Manifests, values for the pinned upstream chart, render script,
offline test and runbook snippets. Nothing here talks to a cluster and no key material is in git; applying is a separate approved CLUSTER-OP (S7 window).
Stacked on #14 (stealth L0 namespaces); retarget to `main` after #14 merges.

| File | What |
|---|---|
| `values.yaml` | values for chart `hashicorp/vault` **0.34.1** (Vault **2.0.4**): standalone, file storage on a 20Gi PVC of class `rd-retain-essd`, injector/csi/ui off, `fullnameOverride: vault`, own NetworkPolicy and auth-delegator |
| `templates/access.yaml` | ServiceAccount `stealth-signer` (token on) + NetworkPolicy `vault-ingress` (only pods `app=stealth-signer` of the same namespace, TCP 8200) |
| `templates/auth-delegator.yaml` | the only cluster-scoped object: ClusterRoleBinding `vault-auth-delegator-<ns>` (`system:auth-delegator` for SA `vault`), applied by the cluster operator |
| `templates/storage.yaml`, `templates/snapshot.yaml` | cluster-scoped StorageClass `rd-retain-essd` (cloud_essd, **Retain**, WaitForFirstConsumer) + VolumeSnapshotClass `rd-retain-snapshot` (Retain); `render.sh snapshot <party> <tag>` = VolumeSnapshot of `data-vault-0` |
| `policies/stealth-signer.hcl` | the signer reads exactly `secret/data/stealth-keys` |
| `render.sh` | `<bi\|bank-a\|bank-b\|all>`, `values <party>`, `cluster <party\|all>`, `storage`, `snapshot <party> <tag>`, `probe <own> <other>`; `bank-c` (cluster 2) is refused |
| `test.sh`, `test/check.py` | offline assertions; `VAULT_CHART_DIR=<unpacked chart 0.34.1>` also renders the real chart with helm (else SKIP is printed) |

Changes to stealth L0 (#14) in this PR, both on LIVE objects once L0 is applied:
- `allow-same-namespace` selects `app.kubernetes.io/name NotIn [vault]` (policies are additive; without it `st-gw` and every other pod of the namespace reach the key store).
- the `party-admin` Role gets `pods/exec` + `get`/`create` with `resourceNames: [vault-0]` (init/unseal/configure by the party operator, on the Vault pod only).

## S7 GO sub-steps (cluster-1 window, in this order)
User-only, cluster-scoped, applied by the cluster operator (qa's harness expects exactly these):
1. `./render.sh storage | kubectl apply -f -` : StorageClass `rd-retain-essd`, VolumeSnapshotClass `rd-retain-snapshot` (parameters `cloud_essd`, `performanceLevel: PL0` match the live `alicloud-essd`, read by besu).
2. `./render.sh cluster all | kubectl apply -f -` : exactly three ClusterRoleBindings `vault-auth-delegator-rd-stealth-{bi,bank-a,bank-b}` (`system:auth-delegator` for SA `vault`).
Per namespace (operator):
3. Re-apply the changed live objects of L0: `../render.sh <party> | kubectl apply -f -` (`allow-same-namespace`, `party-admin` Role); verify `kubectl -n <ns> get netpol allow-same-namespace -o yaml` and `kubectl -n <ns> get role party-admin -o yaml`.
4. `./render.sh <party> | kubectl apply -f -` (SA `stealth-signer`, `vault-ingress`), then the chart install below.
5. Window pre-checks, quoted in the window log: `helm show chart hashicorp/vault --version 0.34.1` shows `appVersion: 2.0.4` (checked 2026-11-11), and the registry manifest of `hashicorp/vault:2.0.4` exists (Docker Hub tag API 2026-11-11: tag `2.0.4`, amd64 + arm64 `active`, last updated 2026-08-04).

## Apply (S7 window, operator)
```
./render.sh values bank-a > /tmp/v-bank-a.yaml
helm install vault vault --repo https://helm.releases.hashicorp.com --version 0.34.1 -n rd-stealth-bank-a -f /tmp/v-bank-a.yaml
```
Initialise once per party, by that party's operator (`party-admin` has `pods/exec` on `vault-0` only; run from the operator host). The unseal shares and root token go to
`<operator host>:~/.rd-vault/rd-stealth-bank-a.init`, directory mode 700, file mode 600, holder = that party's operator; never in chat, git, logs or on the Lensa host:
```
umask 077; mkdir -p ~/.rd-vault
kubectl -n rd-stealth-bank-a exec vault-0 -- vault operator init -key-shares=5 -key-threshold=3 > ~/.rd-vault/rd-stealth-bank-a.init
kubectl -n rd-stealth-bank-a exec -it vault-0 -- vault operator unseal         # threshold times, after every pod restart
```
Configure with the operator token (`VAULT_TOKEN` in the pod's env for the exec, never in argv history):
```
vault secrets enable -path=secret kv-v2
vault auth enable kubernetes
vault write auth/kubernetes/config kubernetes_host=https://kubernetes.default.svc
vault policy write stealth-signer - < policies/stealth-signer.hcl
vault write auth/kubernetes/role/stealth-signer bound_service_account_names=stealth-signer \
  bound_service_account_namespaces=rd-stealth-bank-a policies=stealth-signer ttl=15m
vault kv put secret/stealth-keys placeholder=not-a-key     # so vprobe-signer READ-OK has an entry before S9/S10; S9/S10 overwrite it with the real fields
```
Real keys (field names: bank `spendKey viewKey identityKey`; BI `issuerKey custodianKey registryKey biMeta`) enter `secret/stealth-keys` at S9/S10 through a channel the operator chooses.

## Backup (before S9, and after every key change)
The volume is Retain: deleting the PVC or the namespace leaves the disk. In addition, a snapshot: `./render.sh snapshot bank-a pre-s9 | kubectl apply -f -`, then
`kubectl -n rd-stealth-bank-a get volumesnapshot vault-data-pre-s9` must show `READYTOUSE true` (VolumeSnapshotClass `rd-retain-snapshot`, deletionPolicy Retain). Crash-consistent only (file storage, taken while idle right after an unseal).
**Gate for S9 (prerequisite, stealth PLAN S9):** the restore test of the `pre-s9` snapshot has passed: a scratch PVC with `dataSource` = the snapshot (class `rd-retain-essd`), a scratch Vault on it unsealed with the operator's shares, and `secret/stealth-keys` readable (the placeholder entry). S9 does not start without it.
The unseal shares are the operator's own copy; losing them with the pod sealed means the keys are gone, the snapshot cannot be opened without them.

## RED proofs (PLAN S7)
Before: no `vault` StatefulSet in the namespace. After install and configure:
```
./render.sh probe bank-a bank-b | kubectl apply -f -     # wait ~30 s; pods print no secret value
kubectl -n rd-stealth-bank-a logs vprobe-signer vprobe-wrongsa vprobe-gw ; kubectl -n rd-stealth-bank-b logs vprobe-other
./render.sh probe bank-a bank-b | kubectl delete -f -
kubectl -n rd-stealth-bank-a get secret -o name            # no key Secret: only helm release and service-account secrets, none named stealth-keys
```
Expected: `vprobe-signer READ-OK`, `vprobe-wrongsa LOGIN-DENIED`, `vprobe-gw rd-stealth-bank-a-8200 BLOCKED`, `vprobe-other rd-stealth-bank-a-8200 BLOCKED`.
`READ-DENIED`, `REFUSED`, `ERROR`, `LOGIN-OK-UNEXPECTED` are not passes. Rollback: `helm uninstall vault -n <ns>`, delete PVC `data-vault-0` (the PV stays: Retain, release it by hand after the snapshot is verified), SA, NetworkPolicy, ClusterRoleBinding (empty before S9).

## Open / recorded gaps
- **Seal**: Shamir (chart default). After any pod restart the store is sealed and the signer fails until the party operator unseals (recorded open item). Auto-unseal needs a KMS: a separate product and spend, not chosen.
- **TLS**: Vault listens plain HTTP inside the namespace (`vault-ingress` is the only guard). TLS inside the namespace is not planned here.
- **Cluster-scoped binding**: `vault-auth-delegator-<ns>` is the one cluster-scoped grant (TokenReview). Whether kubernetes auth works as configured on ACK is [unverified]; the alternative is AppRole (a Secret again).
- **Probe image applets** (`nc`, `timeout`, exit codes 124/143) in `hashicorp/vault:2.0.4` are [unverified] until the first run; the probe pods print `ERROR` or `REFUSED` if wrong, which is not a result.
- **Hard limit 6** (PLAN): the signer holds the spending key in memory; Vault holds it at rest only. **Licence**: Vault has been under BUSL since 1.16; the licence of 2.0.4 was not read [unverified]; OpenBao is the open fork if that matters [not decided here].
- Sizes (20Gi PVC, 100m/256Mi requests) are a first guess [unverified]; the snapshot restore test is the S9 gate (Backup section).
