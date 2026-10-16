#!/usr/bin/env bash
set -euo pipefail

PID_FILE="/tmp/claude-1000/-home-ecs-user-alibaba-kube/2842999d-aaed-4566-8cd6-712ab1589582/scratchpad/paladin-port-forward.pids"

# Lead decision 2026-10-08: attribute every kill we cause. Before killing a pid, append a
# STOP marker to THAT PORT's log, so a later `EXIT ... code=143` preceded by a STOP marker is
# definitively ours (stop-all cycle), while 143 WITHOUT a STOP marker is an external SIGTERM.
# Port is resolved from the live socket (pidfile holds only pids, no port map); a pid that is
# already dead has nothing to claim -- its wrapper logged its own EXIT at death time.
declare -A LOGF=(
  [31548]=/tmp/pf-paladin-node1.log [31549]=/tmp/pf-paladin-node1-ws.log
  [31648]=/tmp/pf-paladin-node2.log [31649]=/tmp/pf-paladin-node2-ws.log
  [31748]=/tmp/pf-paladin-node3.log [31749]=/tmp/pf-paladin-node3-ws.log
  [31848]=/tmp/pf-paladin-node4.log [31849]=/tmp/pf-paladin-node4-ws.log
)

if [[ ! -f "$PID_FILE" ]]; then
  echo "No PID file found at $PID_FILE — nothing to stop."
  exit 0
fi

while read -r pid; do
  if kill -0 "$pid" 2>/dev/null; then
    port=$(ss -ltnp 2>/dev/null | grep "pid=${pid}," | sed -nE 's/.*:(3(15|16|17|18)4[89]) .*/\1/p' | head -1)
    if [[ -n "${port:-}" && -n "${LOGF[$port]:-}" ]]; then
      echo "=== $(date +%FT%T.%3N%z) STOP port ${port} (stop-script) ===" >> "${LOGF[$port]}"
    fi
    kill "$pid"
    echo "Stopped pid $pid"
  fi
done < "$PID_FILE"

rm -f "$PID_FILE"
