# zeto/k8s/postgres: Postgres per party (final-design/zeto/PLAN.md S8)

Manifests, render script, offline test and runbook snippets. Nothing here talks to a cluster; applying is a separate approved CLUSTER-OP
(S8 window; README decisions 27 product, 29 PVC spend; S1 namespaces exist). Product per decision 27: sidecar-style Postgres, same image line
as today (`postgres:17.6`), one instance + own PVC per party. A managed service is deferred.

| File | What |
|---|---|
| `templates/postgres.yaml` | Service `paladin-pg` (5432), StatefulSet `paladin-pg` (1 replica, PVC `data` 20Gi `alicloud-essd-wffc`, node/pod anti-affinity, probes, non-root), NetworkPolicy `paladin-pg-ingress` (only `app=paladin` of the same namespace) |
| `templates/pg-scratch.yaml` | throwaway Postgres for the restore test (emptyDir), `throwaway=zeto-s8-scratch` |
| `render.sh` | `render.sh [-o DIR] <bi\|bank-a\|bank-b\|all>`, `render.sh probe <own> <other>`, `render.sh scratch <party>`; `bank-c` (cluster 2) is refused |
| `counts.sql`, `compare-counts.py` | row count per table, side-by-side compare (exit 1 on any difference, 2 on an empty listing) |
| `test.sh`, `test/check.py` | offline assertions (needs bash, python3, PyYAML) |

S1 change in this PR: `zeto/k8s/templates/party.yaml` `allow-same-namespace` now selects pods `app NotIn [paladin-pg]`. NetworkPolicies are additive,
so without it every pod of the namespace could reach the database and `paladin-pg-ingress` would restrict nothing. **This edits the three LIVE S1 policies**
(S1 is applied): it is its own sub-step of the S8 GO, in the cluster-1 window, before the StatefulSet (see "S8 GO sub-steps").

## Who runs what
Everything that uses `kubectl exec` (dump, restore, counts, init of the copy) runs with the **operator's admin kubeconfig**: `party-admin` has no `pods/exec`
(S1 Role). Nothing here runs from Lensa. The StatefulSet is kept off the nodes with hostname labels `member-16033-node` and `member-16034-node` (97% / 85% CPU requests, zeto CURRENT section 12; labels as read by besu;
no cluster read in this PR) and off nodes that already hold another `paladin-pg`; Besu validators are avoided on a best-effort basis (label [unverified]).

## Storage
`alicloud-essd-wffc` (WaitForFirstConsumer: the disk is created in the zone of the node the pod is scheduled on; `alicloud-essd` is Immediate and fixes the zone before scheduling).
Both classes have reclaim policy **Delete**: deleting the PVC (or the namespace) deletes the party database. S22 (decommission) needs a named backup first. The scratch-restore dump of step 7 is not a backup policy.

## S8 GO sub-steps (cluster-1 window, in order)
1. Re-apply S1 `allow-same-namespace` in `rd-zeto-bi`, `rd-zeto-bank-a`, `rd-zeto-bank-b` (`../render.sh <party> | kubectl apply -f -`, live update of 3 policies; check `kubectl -n <ns> get netpol allow-same-namespace -o yaml` shows the `NotIn [paladin-pg]` selector).
2. Create the Secret per namespace (below). 3. Apply `render.sh <party>`. 4. Copy and RED proofs below.

The Secret `paladin-pg-credentials` (keys `username`, `password`, `database`) is not in git. The party creates it; the password never touches argv, a file or the terminal
(`party-admin` has `create` on Secrets; the database name is the one Paladin's `database` config will use [unverified until S9]):
```
kubectl -n rd-zeto-bank-a create secret generic paladin-pg-credentials \
  --from-literal=username=paladin --from-literal=database=paladin \
  --from-file=password=<(openssl rand -hex 24 | tr -d '\n')
```

## RED proofs (PLAN S8), in window order
1. Precondition on the OLD node of the party (Lensa idle, lock held): `ptx_queryPendingTransactions` must return `[]`; quote it.
   `curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"ptx_queryPendingTransactions","params":[{}]}' <old node rpc>`
2. Apply: `./render.sh bank-a | kubectl apply -f -` then `kubectl -n rd-zeto-bank-a rollout status sts/paladin-pg`. Before this step the database does not exist (empty).
3. Copy with the old node UP (scaling its StatefulSet to 0 would stop its sidecar Postgres), operator kubeconfig, **no dump file on the host** (a pipe). Names of the old pod, container and DB:
   `<old-ns>`, `paladin-node<N>-0`, `<postgres container>`, `<db>`, `<user>` [unverified, read them first]. The restore side expands `$POSTGRES_*` inside the pod (single quotes), not in your shell:
   ```
   set -o pipefail
   kubectl -n <old-ns> exec paladin-node<N>-0 -c <postgres container> -- pg_dump -Fc -U <user> <db> \
     | kubectl -n rd-zeto-bank-a exec -i paladin-pg-0 -- sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner'
   echo "pipeline exit: $?"    # 0 required
   ```
   If a file is unavoidable (pg_restore needs a seekable input for a parallel restore): `umask 077` first, write it under a directory only the operator can read, delete it right after the restore and record the deletion in the window log.
   Fallback if the sidecar cannot be reached: a throwaway `postgres:17` pod on the old PVC.
4. Row counts per table, old and new side by side (`compare-counts.py` exits 1 on any difference):
   ```
   kubectl -n <old-ns> exec -i paladin-node<N>-0 -c <postgres container> -- psql -At -U <user> <db> < counts.sql > old-counts.txt
   kubectl -n rd-zeto-bank-a exec -i paladin-pg-0 -- sh -c 'psql -At -U "$POSTGRES_USER" "$POSTGRES_DB"' < counts.sql > new-counts.txt
   ./compare-counts.py old-counts.txt new-counts.txt
   ```
5. Access proof, throwaway pods labelled `throwaway=zeto-s8-probe` (wait ~20 s, 3 attempts 2 s apart):
   ```
   ./render.sh probe bank-a bank-b | kubectl apply -f -
   kubectl -n rd-zeto-bank-a logs pgprobe-paladin pgprobe-control ; kubectl -n rd-zeto-bank-b logs pgprobe-other
   ./render.sh probe bank-a bank-b | kubectl delete -f -
   ```
   Expected: `pgprobe-paladin select1 1`, `pgprobe-control rd-zeto-bank-a-5432 BLOCKED`, `pgprobe-other rd-zeto-bank-a-5432 BLOCKED`. `REFUSED`, `ERROR` are not results.
6. Restart test: `kubectl -n rd-zeto-bank-a delete pod paladin-pg-0`; wait Ready on the same PVC; rerun step 4 against the earlier `new-counts.txt` (equal).
7. Scratch restore (backup is restorable): `./render.sh scratch bank-a | kubectl apply -f -`, wait Ready, `pg_dump -Fc` from `paladin-pg-0` into `pg-scratch`'s `pg_restore`,
   counts via `counts.sql` on `pg-scratch`, `compare-counts.py` equal, then `kubectl -n rd-zeto-bank-a delete pod pg-scratch`.

Rollback (PLAN S8): delete the Service, StatefulSet and PVC `data-paladin-pg-0` of the party (reclaim Delete: this destroys the copy; the old database is only read).
Backup schedule: not defined here (decision 27 picks the product; a managed service would own it); S22 requires a named backup before any delete [open].
Resource sizes (50m / 256Mi requests since the 2026-11-12 resize, from idle samples; 1 CPU / 1Gi limits) and the 20Gi volume are first guesses: today's sidecar usage was not read [unverified].
