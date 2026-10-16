#!/usr/bin/env bash
# End-to-end test against the live cluster: fresh cash+bond series, outright trading
# (happy path, rejections, rollback, concurrency, tamper), Noto-Noto swap, cluster health.
# Usage: scripts/e2e.sh   (uses its own empty data dir; existing bond/data is not touched)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Always the Alibaba cluster: the user shell may export a different KUBECONFIG.
export KUBECONFIG=/home/ecs-user/alibaba-kube/alibaba.yaml
D="${E2E_DIR:-$(mktemp -d /tmp/paladin-e2e.XXXXXX)}"
LOGS="$D/logs"; mkdir -p "$LOGS"
PASS=0; FAIL=0; N=0
ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }
phase(){ echo; echo "== $1"; }
# run <name> <expected-exit> <cmd...>: logs to $LOGS/<name>.log
run() {
  local name=$1 want=$2; shift 2; N=$((N+1))
  "$@" > "$LOGS/$name.log" 2>&1; local got=$?
  if [ "$got" = "$want" ]; then ok "$name (exit $got)"; else bad "$name (exit $got, want $want; see $LOGS/$name.log)"; fi
}
# has <name> <regex>: log must contain regex
has() { if grep -qE -- "$2" "$LOGS/$1.log"; then ok "$1: /$2/"; else bad "$1: missing /$2/"; fi; }
bond() { (cd "$ROOT/bond" && npx ts-node "$@" --cache "$D"); }
# Fails closed: prints nothing unless all 4 paladin nodes are listed.
restarts() { kubectl get pods -n paladin --no-headers 2>/dev/null | awk '/^paladin-node/ {n++; s+=$4} END {if (n==4) print s}'; }

echo "E2E data dir: $D"
trap '"$ROOT/scripts/port-forward-stop.sh" >/dev/null 2>&1' EXIT

phase "0. Offline: typecheck, unit test, build"
for p in common bond swap-noto; do run "tsc-$p" 0 bash -c "cd '$ROOT/$p' && npx tsc --noEmit"; done
run unit-consideration 0 bash -c "cd '$ROOT/bond' && npm test"
run build-bond 0 bash -c "cd '$ROOT/bond' && npm run build"
run build-swap 0 bash -c "cd '$ROOT/swap-noto' && npm run build"
run bad-issuance-flags 1 bond ./src/index.ts --units-per-investor 400

phase "1. Cluster reachable"
"$ROOT/scripts/port-forward-start.sh" > "$LOGS/pf.log" 2>&1; sleep 4
for port in 31548 31648 31748 31848; do
  r=$(curl -s -m5 -X POST "http://127.0.0.1:$port" -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","method":"transport_nodeName","params":[],"id":1}')
  echo "$r" | grep -q '"result":"node' && ok "port $port -> $(echo "$r" | grep -o 'node[0-9]')" || bad "port $port unreachable"
done
R0=$(restarts); [ -n "$R0" ] && ok "kubectl sees 4 paladin nodes (restarts $R0)" || bad "kubectl cannot list paladin nodes"

phase "2. Issuance: supply 900, 20000 cash/investor, 150 units/investor, price 2"
run issuance 0 bond ./src/index.ts --supply 900 --cash-per-investor 20000 --units-per-investor 150 --price 2
has issuance "^investor1: 150 bond, 19700 cash"
has issuance "^investor3: 150 bond, 19700 cash"
has issuance "^Custodian: 450 bond, 900 cash"
run verify-after-issuance 0 bond ./src/tests/data-persistence.ts

phase "3. Outright happy path"
run trade1 0 bond ./src/outright.ts --seller investor1 --buyer investor2 --units 50 --price 1.5 --trade-id e2e-t1
has trade1 "SETTLED: 50 bond for 75 cash"
run trade2 0 bond ./src/outright.ts --seller investor3 --buyer investor1 --units 40 --price 2.25 --trade-id e2e-t2
has trade2 "SETTLED: 40 bond for 90 cash"
run verify-after-trades 0 bond ./src/tests/data-persistence.ts

phase "4. Rejections (nothing on-chain, nothing recorded)"
before=$(wc -l < "$D/trades.jsonl")
run rej-oversell    1 bond ./src/outright.ts --seller investor1 --buyer investor2 --units 9999 --price 1
has rej-oversell "REJECTED.*cannot sell 9999"
run rej-self        1 bond ./src/outright.ts --seller investor2 --buyer investor2 --units 1 --price 1
has rej-self "REJECTED.*must differ"
run rej-fraction    1 bond ./src/outright.ts --seller investor1 --buyer investor2 --units 3 --price 1.1
has rej-fraction "REJECTED.*not a whole amount"
run rej-unknown     1 bond ./src/outright.ts --seller investor1 --buyer bank9 --units 1 --price 1
has rej-unknown "REJECTED.*unknown buyer"
run rej-no-cash     1 bond ./src/outright.ts --seller investor1 --buyer investor2 --units 100 --price 500
has rej-no-cash "REJECTED.*needs 50000"
run rej-bad-price   1 bond ./src/outright.ts --seller investor1 --buyer investor2 --units 1 --price=-1
has rej-bad-price "REJECTED.*positive decimal"
run rej-dup-trade   1 bond ./src/outright.ts --seller investor1 --buyer investor2 --units 1 --price 1 --trade-id e2e-t1
has rej-dup-trade "REJECTED.*already recorded"
run rej-missing-arg 1 bond ./src/outright.ts --seller investor1
has rej-missing-arg "usage:"
[ "$(wc -l < "$D/trades.jsonl")" = "$before" ] && ok "no trade records added by rejections" || bad "rejections wrote trade records"

phase "5. Rollback (2 injected failures) + 2 concurrent same-seller trades"
run rollback 0 bond ./src/tests/rollback.ts
has rollback "SUCCESS: rollback checks passed"

phase "6. Final balances vs hand-computed values"
# start 150/19700 each; t1 i1->i2 50@1.5=75; t2 i3->i1 40@2.25=90; concurrent i1->i2 5@2=10, i1->i3 5@2=10
run verify-final 0 bond ./src/tests/data-persistence.ts
has verify-final "OK - investor1@node2 bond: 130$"
has verify-final "OK - investor1@node2 cash: 19705$"
has verify-final "OK - investor2@node3 bond: 205$"
has verify-final "OK - investor2@node3 cash: 19615$"
has verify-final "OK - investor3@node4 bond: 115$"
has verify-final "OK - investor3@node4 cash: 19780$"
has verify-final "OK - custodian bond: 450$"
has verify-final "OK - custodian cash: 900$"
has verify-final "6 outright trade\(s\) recorded, 4 settled"
has verify-final "SUCCESS: Verification completed"

phase "7. Tamper detection"
T="$D/tamper"; mkdir -p "$T"; cp "$D"/contract-data-*.json "$T/"
sed 's/"tradeId":"e2e-t1","\(.*\)"units":"50"/"tradeId":"e2e-t1","\1"units":"60"/' "$D/trades.jsonl" > "$T/trades.jsonl"
run tamper-trade 1 bash -c "cd '$ROOT/bond' && npx ts-node ./src/tests/data-persistence.ts --cache '$T'"
has tamper-trade "ERROR - trade e2e-t1"

phase "8. Noto-Noto atomic swap (both legs hooks)"
run swap-start 0 bash -c "cd '$ROOT/swap-noto' && npm run start"
has swap-start "Asset: I1=900, I2=100, Cash: I1=10, I2=9990"
run swap-verify 0 bash -c "cd '$ROOT/swap-noto' && npm run verify"
has swap-verify "SUCCESS: Verification completed"

phase "9. Cluster health"
for i in 1 2 3 4; do
  L=$(kubectl logs -n paladin "paladin-node$i-0" -c paladin --since=90m 2>&1)
  [ "$(echo "$L" | wc -l)" -gt 100 ] || { bad "node$i: could not read logs"; continue; }
  w=$(echo "$L" | grep -c PD210100); e=$(echo "$L" | grep -ciE 'level=error|\[ERROR\]')
  [ "$w" = 0 ] && [ "$e" = 0 ] && ok "node$i: 0 PD210100, 0 errors" || bad "node$i: PD210100=$w errors=$e"
done
R1=$(restarts); [ -n "$R1" ] && [ "$R1" = "$R0" ] && ok "no pod restarts during run ($R1)" || bad "pod restarts changed $R0 -> $R1"
BP=""; for i in 1 2 3 4; do kubectl port-forward -n besu "svc/besu-node-validator-$i" "3854$i:8545" >/dev/null 2>&1 & BP="$BP $!"; done; sleep 4
for i in 1 2 3 4; do
  q(){ curl -s -m5 -X POST "http://127.0.0.1:$1" -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"method\":\"$2\",\"params\":[],\"id\":1}" | sed -E 's/.*"result":"([^"]*)".*/\1/'; }
  port=$((31448 + i*100))
  bh=$(q "3854$i" eth_blockNumber); ph=$(q "$port" bidx_getConfirmedBlockHeight)
  if [[ ! "$bh" =~ ^0x[0-9a-f]+$ && ! "$bh" =~ ^0x[0-9A-F]+$ ]] || [[ ! "$ph" =~ ^0x[0-9a-fA-F]+$ ]]; then
    bad "node$i: cannot read heights (besu='$bh' paladin='$ph')"; continue
  fi
  b=$((bh)); pi=$((ph)); lag=$((b - pi))
  [ "$b" -gt 0 ] && [ "$lag" -ge 0 ] && [ "$lag" -le 5 ] && ok "node$i indexer lag $lag (besu $b)" || bad "node$i indexer lag $lag (besu $b, paladin $pi)"
done
kill $BP 2>/dev/null

echo
echo "RESULT: $PASS passed, $FAIL failed  (logs: $LOGS)"
[ "$FAIL" = 0 ]
