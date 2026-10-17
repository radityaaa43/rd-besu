#!/usr/bin/env bash
set -euo pipefail

export KUBECONFIG=/home/ecs-user/alibaba-kube/alibaba.yaml
PID_FILE="/tmp/claude-1000/-home-ecs-user-alibaba-kube/2842999d-aaed-4566-8cd6-712ab1589582/scratchpad/paladin-port-forward.pids"
# pid -> port map (lead, 2026-10-09): this host hides kubectl's argv (/proc/<pid>/cmdline
# reads back as bare "kubectl"), so the watchdog cannot resolve a port to its pid by
# cmdline. The map is the authoritative pid<->port link: full start truncates it, the
# per-port wrapper appends "pid port", the watchdog filters it by liveness.
MAP_FILE="/tmp/claude-1000/-home-ecs-user-alibaba-kube/2842999d-aaed-4566-8cd6-712ab1589582/scratchpad/paladin-port-forward.map"
mkdir -p "$(dirname "$PID_FILE")"

# Lead decision 2026-10-09 (per-port restore): `--only PORT` starts exactly that one
# listener and APPENDS its pid instead of truncating the pidfile -- the watchdog uses
# this to replace a single victim without cycling the healthy seven. Full mode (no
# args) keeps the original behavior: truncate + start all eight.
ONLY_PORT=""
if [ "${1:-}" = "--only" ] && [ -n "${2:-}" ]; then
  ONLY_PORT="$2"
else
  : > "$PID_FILE"
  : > "$MAP_FILE"
fi

declare -A PORTS=(
  [paladin-node1]=31548
  [paladin-node2]=31648
  [paladin-node3]=31748
  [paladin-node4]=31848
)

for svc in "${!PORTS[@]}"; do
  local_port="${PORTS[$svc]}"
  if [ -n "$ONLY_PORT" ] && [ "$local_port" != "$ONLY_PORT" ]; then continue; fi
  # Lead decision 2026-10-08: append + timestamp markers instead of overwriting (`>`), so a
  # forward that dies leaves its exit reason/stderr in the log for diagnosis. A single port
  # dying repeatedly is the pattern this is meant to make visible (see the watchdog's restart
  # history); overwriting erased the evidence every restart.
  logf="/tmp/pf-${svc}.log"
  echo "=== $(date +%FT%T.%3N%z) start port ${local_port} (${svc}) ===" >> "$logf"
  # Exit-code instrumentation (lead, 2026-10-08): the pid written to PID_FILE MUST stay the
  # real kubectl pid -- port-forward-stop.sh kills by pidfile, so a wrapper's pid there would
  # leave an orphan. Shape: subshell backgrounds kubectl, records its pid, and `wait`s on it;
  # when kubectl dies (SIGTERM 143 / SIGKILL-OOM 137 / self-exit 0/1) the subshell writes the
  # EXIT marker into the same log and exits itself. No process outlives its kubectl.
  (
    kubectl port-forward -n paladin "svc/${svc}" "${local_port}:8548" >> "$logf" 2>&1 &
    c=$!
    echo "$c" >> "$PID_FILE"
    echo "$c ${local_port}" >> "$MAP_FILE"
    echo "Forwarding ${svc} -> localhost:${local_port} (pid $c)"
    rc=0
    # `|| rc=$?`: under `set -e`, a bare failing `wait` would exit this subshell BEFORE the
    # EXIT marker is written (observed live: the first kill after this instrumentation left
    # no marker at all) -- the `||` form keeps the subshell alive to log rc.
    # rc captured BEFORE the next echo: $(date ...) in it would clobber $?.
    wait "$c" || rc=$?
    echo "=== $(date +%FT%T.%3N%z) EXIT port ${local_port} (${svc}) code=${rc} ===" >> "$logf"
  ) &
done

# WS (rpc-ws, container port 8549 -- distinct from the HTTP rpc-http port above, confirmed via
# `kubectl get svc paladin-nodeN -o jsonpath='{.spec.ports}'`). Added additively (task #4b): the
# :8548 loop above and its port numbers are unchanged, so anything already depending on this
# script's existing behavior is unaffected. Local WS port = HTTP port + 1 (e.g. node2's HTTP is
# 31648, its WS is 31649) -- SDK callers pass this as `wsUrl`.
for svc in "${!PORTS[@]}"; do
  local_port="$((${PORTS[$svc]} + 1))"
  if [ -n "$ONLY_PORT" ] && [ "$local_port" != "$ONLY_PORT" ]; then continue; fi
  logf="/tmp/pf-${svc}-ws.log"
  echo "=== $(date +%FT%T.%3N%z) start port ${local_port} (${svc} ws) ===" >> "$logf"
  # Same exit-code instrumentation as the HTTP loop above (lead, 2026-10-08).
  (
    kubectl port-forward -n paladin "svc/${svc}" "${local_port}:8549" >> "$logf" 2>&1 &
    c=$!
    echo "$c" >> "$PID_FILE"
    echo "$c ${local_port}" >> "$MAP_FILE"
    echo "Forwarding ${svc} (WS) -> localhost:${local_port} (pid $c)"
    rc=0
    # Same `set -e` guard as the HTTP loop above (`|| rc=$?`).
    wait "$c" || rc=$?
    echo "=== $(date +%FT%T.%3N%z) EXIT port ${local_port} (${svc} ws) code=${rc} ===" >> "$logf"
  ) &
done

sleep 2
echo "PIDs written to $PID_FILE"
