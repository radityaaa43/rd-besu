# Paladin resources/priorityClass rollout (task #16/#18)

User-approved option (a): patch the operator-generated StatefulSets directly, since the
`paladins.core.paladin.io` CRD (v1alpha1) has no field for container resources, env vars, or
`priorityClassName` anywhere in its schema (confirmed by recursively walking the full CRD
OpenAPI schema -- the only `resources` fields in the whole CRD are the two PVC templates'
storage requests/limits).

**DO NOT APPLY until the lead signals Gate 3 has passed.** The backend's real run is in
progress; a node restart now would break it. This directory only prepares and
server-side-dry-run-validates the manifests -- nothing in this directory has been applied.

## What changes

- New cluster-scoped `PriorityClass paladin-high-priority` (value 10000) -- `priorityclass.yaml`.
- Per-node strategic-merge patch (`patch-node{1..4}.yaml`, byte-identical content except the
  comment header) adding, to the StatefulSet's pod template:
  - `postgres` container: requests `100m`/`256Mi`, limits `500m`/`512Mi`.
  - `paladin` container: requests `250m`/`768Mi`, limits `1`/`2560Mi` CPU/memory, env
    `JDK_JAVA_OPTIONS=-Xmx1g -Xms256m -XX:MaxMetaspaceSize=256m`.
  - Pod spec: `priorityClassName: paladin-high-priority`.
- The 2560Mi/`-Xmx1g` pairing is the operating-paladin skill's own measured number for a
  **non-Zeto** deployment (this cluster's CRs only configure `noto`+`pente`, confirmed via
  `kubectl get pld -o yaml`) -- the skill's "well beyond 2560m for batch circuits" caveat is a
  Zeto-only concern and doesn't apply here.
- Verified diff (server-side dry-run against the live StatefulSet, all 4 nodes identical in
  shape): adds `resources`/`env`/`priorityClassName` only -- no other field changes except the
  StatefulSet's own `generation` counter bump, which is an unavoidable side effect of any patch.

## Why this order: node4 -> node3 -> node2 -> node1

node1 is the bond issuer/custodian (`bondIssuer`/`bondCustodian` identities) -- the BI side the
backend's real run depends on most heavily and last to touch. node4 was already preempted once
today (task #16) and is the least central identity in the current real run, so it's the
cheapest place to discover a problem with this rollout. One node at a time, never parallel --
this is the SAME "one subagent/one cluster-write-at-a-time" rule the project's CLAUDE.md already
requires.

## Per-node rollout steps

Repeat for each node in the order above. **Do not start the next node until the current one's
post-check and operator-revert test both pass.**

1. **Pre-check** (cluster discipline, same as every live check this session):
   ```bash
   export KUBECONFIG=/home/ecs-user/alibaba-kube/alibaba.yaml
   kubectl get pods -n paladin -l app=paladin --no-headers
   kubectl exec -n paladin paladin-node<N>-0 -c postgres -- psql -U postgres -d postgres -tAc \
     "select count(*) from transactions t where not exists (select 1 from transaction_receipts r where r.transaction = t.id) and t.created < (extract(epoch from now())*1000000000)::bigint - 120000000000"
   kubectl logs -n paladin paladin-node<N>-0 -c paladin --since=5m | grep -c ' ERROR '
   ```
   Expect: this node's pod `2/2 Running`, 0 receiptless, no unexplained `ERROR` lines. If not
   clean, STOP -- do not patch a node that is already unhealthy or has in-flight work.

2. **Snapshot the live StatefulSet** (this IS the rollback artifact -- take it fresh, every
   time, never reuse an old one):
   ```bash
   kubectl get statefulset paladin-node<N> -n paladin -o yaml > backup-node<N>-$(date +%s).yaml
   ```

3. **Apply the PriorityClass** (once only, before the first node -- it's cluster-scoped, not
   per-node):
   ```bash
   kubectl apply -f priorityclass.yaml
   ```

4. **Patch this node**:
   ```bash
   kubectl patch statefulset paladin-node<N> -n paladin --type strategic --patch-file patch-node<N>.yaml
   ```
   This rolls the StatefulSet's single pod (`replicas: 1`, `OrderedReady`/`RollingUpdate`
   partition 0) -- expect it to terminate and recreate once.

5. **Wait for Running + a healthy indexer** (don't just wait for `Running` -- confirm the
   paladin process is actually caught up, per the operating-paladin skill's own health checks):
   ```bash
   kubectl rollout status statefulset/paladin-node<N> -n paladin --timeout=180s
   kubectl get pods -n paladin paladin-node<N>-0 --no-headers   # expect 2/2 Running, 0 restarts
   # then, via the node's own RPC (port-forward or exec), compare bidx_getConfirmedBlockHeight
   # (hex) against eth_blockNumber on its paired besu node -- must not be stalled behind.
   ```

6. **Post-check** (repeat step 1's three checks). Also confirm the new settings actually landed
   on the running pod:
   ```bash
   kubectl get pod -n paladin paladin-node<N>-0 -o jsonpath='{range .spec.containers[*]}{.name}: requests={.resources.requests} limits={.resources.limits}{"\n"}{end}'
   kubectl get pod -n paladin paladin-node<N>-0 -o jsonpath='{.spec.priorityClassName}{"\n"}'
   ```

7. **Operator-revert test** (the single most important check -- this is what tells us whether
   option (a) is viable at all, or whether we need (b)/(c) instead):
   ```bash
   kubectl annotate pld node<N> -n paladin ops.alibaba-kube/revert-test="$(date +%s)" --overwrite
   sleep 10   # give the operator's reconcile loop time to fire
   kubectl get statefulset paladin-node<N> -n paladin -o jsonpath='{.spec.template.spec.priorityClassName}{"\n"}'
   kubectl get pod -n paladin paladin-node<N>-0 -o jsonpath='{range .spec.containers[*]}{.name}: requests={.resources.requests}{"\n"}{end}'
   ```
   - **If the patch is still there**: option (a) is confirmed viable. Continue to the next node.
   - **If the operator reverted it** (resources/priorityClassName back to empty): **STOP
     immediately.** Do not patch the remaining nodes. Report to the lead that option (a) does
     not survive reconciliation -- the user needs to choose (b) (a mutating admission webhook,
     e.g. Kyverno -- not installed today) or (c) (patch the operator itself to add a
     pod-template override field to the CRD) instead. The node(s) already patched can stay as
     they are (the settings are still a strict improvement over BestEffort/no-limit) or be
     rolled back per the Rollback section below -- ask the user which.

## Rollback

**Primary method: `kubectl rollout undo`.** Confirmed viable before writing this: every node's
StatefulSet already has ControllerRevision history (`revisionHistoryLimit: 10`, currently 4
revisions stored for node1, checked via `kubectl get controllerrevision -n paladin -l
app.kubernetes.io/instance=node<N>`). This is the native, purpose-built rollback for a
StatefulSet's pod template, not a hand-reconstructed patch:

```bash
kubectl rollout undo statefulset/paladin-node<N> -n paladin
kubectl rollout status statefulset/paladin-node<N> -n paladin --timeout=180s
```

Without `--to-revision`, this reverts to the revision immediately before the current one -- i.e.
exactly the pre-patch state, since the patch itself created the newest revision. If more than one
change happened since (e.g. the operator's own revert during step 7's test also created a
revision), check `kubectl rollout history statefulset/paladin-node<N> -n paladin` first and pass
`--to-revision=<N>` explicitly rather than assuming "one step back" is the right target.

**Fallback, only if revision history was somehow lost** (rotated past the limit, or the
StatefulSet was deleted and recreated outside this runbook): restore from the snapshot taken in
step 2. A raw `kubectl replace -f backup-node<N>-<timestamp>.yaml --force` will be REJECTED by the
API server unless the snapshot's server-managed fields are stripped first (`metadata.resourceVersion`,
`metadata.uid`, `metadata.creationTimestamp`, `metadata.managedFields`, and the whole `status`
block) -- these are stamped fresh by the server on every object and a stale value makes `replace`
conflict (no `yq` on this box -- confirmed; use `python3`'s stdlib-adjacent `yaml` module, already
available, confirmed):
```bash
python3 -c "
import yaml
with open('backup-node<N>-<timestamp>.yaml') as f:
    doc = yaml.safe_load(f)
for k in ('resourceVersion', 'uid', 'creationTimestamp', 'managedFields'):
    doc['metadata'].pop(k, None)
doc.pop('status', None)
with open('backup-node<N>-<timestamp>.yaml', 'w') as f:
    yaml.safe_dump(doc, f)
"
kubectl replace --force -f backup-node<N>-<timestamp>.yaml
```
`--force` deletes and recreates the StatefulSet object itself. **Data safety, confirmed by
reading the live spec, not assumed**: this StatefulSet has NO `volumeClaimTemplates` at all
(`kubectl get statefulset paladin-node<N> -o jsonpath='{.spec.volumeClaimTemplates}'` returns
empty) -- the postgres data volume is a statically-named PVC (`paladin-node<N>-pgdata`) referenced
by `volumes[].persistentVolumeClaim.claimName`, and that PVC's `ownerReferences` points at the
**Paladin CR**, not at the StatefulSet. Deleting or recreating the StatefulSet object therefore
cannot touch the PVC either way -- there is no owner-reference chain from StatefulSet to PVC for
`--force` (or even a plain `kubectl delete statefulset`) to cascade through.

Either method: run the Pre-check steps immediately after to confirm the node comes back healthy.

To remove the PriorityClass (only once ALL nodes have been rolled back, since the patches
reference it by name):
```bash
kubectl delete priorityclass paladin-high-priority
```

## Dry-run validation already performed (read-only, nothing applied)

- `kubectl apply --dry-run=server -f priorityclass.yaml` -- accepted, schema-valid, would create
  `priorityclass.scheduling.k8s.io/paladin-high-priority`.
- `kubectl patch statefulset paladin-node{1..4} --type strategic --patch-file patch-node{1..4}.yaml --dry-run=server` --
  accepted for all 4, schema-valid.
- Diffed the dry-run result against each live StatefulSet: for all 4 nodes, the ONLY changes are
  the intended `resources`/`env`/`priorityClassName` additions plus the StatefulSet's own
  `generation` counter bump (an unavoidable side effect of any patch, not a sign of drift).
- `kubectl rollout undo statefulset/paladin-node1 -n paladin --dry-run=server` -- accepted
  ("rolled back (server dry run)"), confirming `rollout undo` is actually supported for this
  StatefulSet/kubectl version, not just assumed from general k8s behavior.
