# Platform bootstrap runbook

`../scripts/bootstrap-platform.ts` deploys the base contracts the backend needs before any
real-mode flow can run: the cash Noto token (RD, hooks mode), `BondSeriesRegistry`,
`RestrictedAtomFactory`, one investor+custodian Agreement group per investor, and an initial
cash mint to each investor. It writes one `contract-data-<bank>.json` per bank into `out/`.

**Safe by default**: the script is a dry run unless `--execute` is passed. A dry run prints the
full numbered transaction plan, the exact content every `contract-data-<bank>.json` would get
(addresses as `"<tbd>"`), and runs every file's shape through paladin-client's
`validateClientConfig` -- nothing is sent, nothing is written.

**Idempotent**: if `out/contract-data-bank1.json` already exists, `--execute` is a no-op (skips
and exits 0, prints why). It is never a re-deploy. Delete every `contract-data-*.json` in
`out/` to force a fresh run.

## Pre-checks (run before `--execute`)

Port-forward to all 4 nodes first (`../scripts/port-forward-start.sh`), then:

```bash
export KUBECONFIG=/home/ecs-user/alibaba-kube/alibaba.yaml

# 1. All 4 nodes healthy, 0 restarts.
kubectl get pods -n paladin --no-headers

# 2. 0 receiptless transactions older than 2 minutes, on every node -- a non-zero count here
#    means something is already stuck; stop and investigate before adding more load.
NOW_NS=$(($(date +%s%N)))
for n in 1 2 3 4; do
  echo -n "node${n}: "
  kubectl exec -n paladin paladin-node${n}-0 -c postgres -- psql -U postgres -d postgres -t -c \
    "select count(*) from transactions t where not exists (select 1 from transaction_receipts r where r.transaction = t.id) and t.created < ${NOW_NS} - 120000000000;"
done

# 3. Baseline ERROR count per node (so you can tell a NEW error from pre-existing noise after
#    --execute). Logs use " ERROR " (with spaces) -- a bare "error" grep gives a false clean pass.
for n in 1 2 3 4; do
  echo -n "node${n}: "
  kubectl logs -n paladin paladin-node${n}-0 -c paladin --since=10m 2>/dev/null | grep -c ' ERROR '
done
```

All 4 pods must be `Running` with 0 restarts, receiptless must be 0 on every node. A nonzero
ERROR baseline is fine (note the count, compare the delta after `--execute`, not the raw
number) -- only escalate on `PD011513` (revert) or anything naming a contract this script
touches.

Run the dry run and read the plan + per-bank file content it prints. Confirm:
- the transaction count matches what you expect (currently 11: 3 cash-token setup + registry +
  factory + 3 mints + 3 investor-group creates),
- every file ends with `-> validateClientConfig: OK`,
- `out/` has no `contract-data-*.json` yet (if it does, this run would be the idempotent skip,
  not a real execute).

## `--execute`

Only after explicit user approval (this is Phase 1's lead-gated step -- the lead asks the user,
never runs this unprompted).

```bash
cd /home/ecs-user/alibaba-kube/Paladin/scripts
NODE_PATH=../bond/node_modules:../swap-noto/node_modules ../bond/node_modules/.bin/ts-node bootstrap-platform.ts --execute
# optional: --initial-cash=<amount> (default 1000000)
```

Watch the numbered log lines as they print (`1. Creating cashIssuer-only cash privacy
group...` through the per-investor group creates) -- each one blocks on its own receipt before
moving to the next, so the first failure is also the last line printed. On failure: nothing
written to `out/` yet if the failure was before the final per-bank file-write loop (every
deploy/mint/group-create runs first; files are written only once everything above succeeded),
so it's safe to fix the root cause and run `--execute` again — no partial contract-data file is
ever left behind to trip the idempotent skip.

## Post-checks

```bash
export KUBECONFIG=/home/ecs-user/alibaba-kube/alibaba.yaml

# Pods still healthy, 0 NEW restarts.
kubectl get pods -n paladin --no-headers

# Still 0 receiptless on every node.
NOW_NS=$(($(date +%s%N)))
for n in 1 2 3 4; do
  echo -n "node${n}: "
  kubectl exec -n paladin paladin-node${n}-0 -c postgres -- psql -U postgres -d postgres -t -c \
    "select count(*) from transactions t where not exists (select 1 from transaction_receipts r where r.transaction = t.id) and t.created < ${NOW_NS} - 120000000000;"
done

# ERROR delta vs the pre-check baseline, per node -- investigate anything beyond the baseline.
for n in 1 2 3 4; do
  echo -n "node${n}: "
  kubectl logs -n paladin paladin-node${n}-0 -c paladin --since=10m 2>/dev/null | grep -c ' ERROR '
done
```

Then confirm the real artifacts:
- `out/contract-data-bank{1,2,3,4}.json` all exist, every address field is a real `0x...`
  value (no `"<tbd>"` left anywhere), `contract-data-bank1.json`'s `contractData.groupIds` has
  one real group id per investor bankId, and each investor's own file has a real
  `identities.investorCustodianGroupId`.
- each file still passes `loadClientConfigFile`/`validateClientConfig` (the script already
  does this as its last step per file, logged as it runs -- if `--execute` reached "Bootstrap
  complete.", every file already passed).
- the backend can load every file and connect (its own smoke check, not this script's job).

Stop port-forwards when done (`../scripts/port-forward-stop.sh`), then confirm the ports are
actually closed (`ss -ltnp | grep -E ':3154|:3164|:3174|:3184'` should print nothing).

## Rollback

**There is no in-place rollback.** This script only ever creates new contracts and groups --
it never modifies or deletes anything that existed before it ran, and a Noto token / registry
/ factory / Pente group is not upgradeable once deployed. If something is wrong after
`--execute`:

1. **Do not try to "fix" the deployed contracts.** There's nothing to patch -- the only way to
   change deployed bytecode is to deploy new instances.
2. **The old series/contracts are untouched and still valid.** Nothing about re-running this
   script (or a future, corrected version of it) invalidates or affects contracts already
   deployed by a previous run -- they just become orphaned, unreferenced addresses if nobody's
   `contract-data-*.json` points at them anymore.
3. To actually start over: delete every `out/contract-data-*.json` (this is what makes the
   script idempotent-skip; deleting them is what un-skips it) and re-run `--execute`. This
   deploys a **complete new set** of contracts (new cash token, new registry, new factory, new
   groups) -- it does NOT reuse or migrate anything from the previous run. Any bond series
   already registered in the OLD registry, and any balances on the OLD cash token, are not
   carried over; they simply become unreachable from the new `contract-data-*.json` files
   (the old registry/token contracts still exist on-chain, inert, not deleted).
4. If only ONE bank's file is wrong (e.g. wrong nodeId) and the rest are fine: do not delete
   the other banks' files or re-run `--execute` (it would try to redeploy everything, since the
   idempotent check only looks at bank1's file). Fix that one bank's JSON file by hand against
   the addresses the other files already show, then re-run that bank's own
   `loadClientConfigFile`/`validateClientConfig` check manually to confirm the fix.
