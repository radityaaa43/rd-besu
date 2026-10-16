#!/usr/bin/env bash
# Watchdog for the eight paladin port-forward listeners (4 nodes x HTTP+WS).
#
# Restore strategy (lead decision 2026-10-09, option (c)): PER-PORT.
#   Every observed incident so far is the "listener-loss-with-live-process" class --
#   kubectl hangs (upstream dropped, listener released, process never exits). The
#   victim therefore cannot be found by socket resolution (it owns no listening
#   socket); it is found BY PID in the pidfile via /proc/<pid>/cmdline, evidence is
#   dumped BEFORE the kill, it is killed (TERM, then KILL), its pid is removed from
#   the pidfile, and only that one port is restarted (`port-forward-start.sh --only N`,
#   which appends instead of truncating). The pidfile must always end at exactly eight.
#
#   A second confirmation runs first: a successful TCP connect means the probe was
#   wrong (listener is alive) and NOTHING is restarted.
#
# Stop: touch ${PF_WATCHDOG_STOP:-/tmp/paladin-pf-watchdog.stop}
# Env:  PF_WATCHDOG_INTERVAL (default 30)
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STOP_FILE="${PF_WATCHDOG_STOP:-/tmp/paladin-pf-watchdog.stop}"
INTERVAL="${PF_WATCHDOG_INTERVAL:-30}"
PORTS=(31548 31549 31648 31649 31748 31749 31848 31849)
PID_FILE="/tmp/claude-1000/-home-ecs-user-alibaba-kube/2842999d-aaed-4566-8cd6-712ab1589582/scratchpad/paladin-port-forward.pids"
# pid<->port map (lead, 2026-10-09): this host hides kubectl's argv (/proc/<pid>/cmdline
# reads back as bare "kubectl"), so port->pid resolution cannot use cmdline. The map is
# written by port-forward-start.sh's wrapper ("pid port" per line) and filtered here by
# liveness; a hung victim is found through it even though it owns no listening socket.
MAP_FILE="/tmp/claude-1000/-home-ecs-user-alibaba-kube/2842999d-aaed-4566-8cd6-712ab1589582/scratchpad/paladin-port-forward.map"

declare -A LOGF=(
  [31548]=/tmp/pf-paladin-node1.log [31549]=/tmp/pf-paladin-node1-ws.log
  [31648]=/tmp/pf-paladin-node2.log [31649]=/tmp/pf-paladin-node2-ws.log
  [31748]=/tmp/pf-paladin-node3.log [31749]=/tmp/pf-paladin-node3-ws.log
  [31848]=/tmp/pf-paladin-node4.log [31849]=/tmp/pf-paladin-node4-ws.log
)

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }
ts()  { date +%FT%T.%3N%z; }

missing() {
  local m=() p
  for p in "${PORTS[@]}"; do
    ss -ltn 2>/dev/null | grep -q ":$p " || m+=("$p")
  done
  echo "${m[*]}"
}

# Resolve which pid currently forwards $1, via the pid<->port map.
pid_for_port() {
  local want="$1"
  [ -f "$MAP_FILE" ] || return 1
  awk -v p="$want" '$2==p {print $1; exit}' "$MAP_FILE"
}

# Drop entries whose process is gone from both files. Liveness-based (kill -0), NOT
# cmdline-based -- argv is hidden on this host, so a cmdline filter would wipe every
# good entry (observed 2026-10-09: pidfile briefly reduced to 0 and rebuilt from ss).
clean_stale() {
  local tmp p port
  if [ -f "$PID_FILE" ]; then
    tmp=$(mktemp)
    while read -r p; do
      [ -n "$p" ] || continue
      kill -0 "$p" 2>/dev/null && echo "$p" >> "$tmp"
    done < "$PID_FILE"
    mv "$tmp" "$PID_FILE"
  fi
  if [ -f "$MAP_FILE" ]; then
    tmp=$(mktemp)
    while read -r p port; do
      [ -n "$p" ] || continue
      kill -0 "$p" 2>/dev/null && echo "$p $port" >> "$tmp"
    done < "$MAP_FILE"
    mv "$tmp" "$MAP_FILE"
  fi
}

restore_port() {
  local port="$1" pid ev
  # Connect-test FIRST (lead 2026-10-09, diagnosis patch): a successful connect means the
  # ss probe missed a live listener -- that is a probe-flicker, NOT a listener loss. Log it
  # as its own class and never restart. The restart gate is unchanged: restart only runs
  # when this connect test FAILS.
  if timeout 2 bash -c "</dev/tcp/127.0.0.1/$port" 2>/dev/null; then
    log "probe-flicker port $port (probe missed, connect ok, no restart)"
    return 0
  fi
  log "LISTENER-LOST port $port -> per-port restore"

  pid=$(pid_for_port "$port") || pid=""
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    # Victim alive but not listening (the hung class): dump evidence BEFORE the kill.
    ev="/tmp/pf-evidence-${port}-$(date +%Y%m%dT%H%M%S%z).txt"
    {
      echo "=== evidence port $port pid $pid at $(date -Is) ==="
      echo "--- ss -ltnp | grep :$port ---"; ss -ltnp 2>/dev/null | grep ":$port" || echo "(no listener)"
      echo "--- ss -tanp | grep pid=$pid ---"; ss -tanp 2>/dev/null | grep "pid=$pid," || echo "(no sockets)"
      echo "--- fd count (/proc/$pid/fd) ---"; ls "/proc/$pid/fd" 2>/dev/null | wc -l
      echo "--- /proc/$pid/status State/Threads ---"; grep -E '^State|^Threads' "/proc/$pid/status" 2>/dev/null
      echo "--- /proc/$pid/wchan ---"; cat "/proc/$pid/wchan" 2>/dev/null; echo
    } > "$ev" 2>&1
    echo "=== $(ts) RESTORE-KILL port $port (watchdog per-port; pid $pid; evidence $(basename "$ev")) ===" >> "${LOGF[$port]}"
    kill "$pid" 2>/dev/null
    sleep 2
    if kill -0 "$pid" 2>/dev/null; then
      echo "=== $(ts) RESTORE-KILL-ESCALATE port $port SIGKILL ===" >> "${LOGF[$port]}"
      kill -9 "$pid" 2>/dev/null
      sleep 1
    fi
    log "restored-per-port: killed hung pid $pid for port $port (evidence $ev)"
  else
    log "restored-per-port: port $port has no live pid (already exited)"
  fi

  clean_stale
  "$DIR/port-forward-start.sh" --only "$port" >/dev/null 2>&1 || true

  # Exactly-eight check (lead constraint): count after the append; log if wrong.
  local n=0
  [ -f "$PID_FILE" ] && n=$(grep -c . "$PID_FILE")
  if [ "$n" -eq 8 ]; then
    log "RESTORED port $port (pidfile=8)"
  else
    log "RESTORED port $port WARNING pidfile=$n (expected 8)"
  fi
}

log "watchdog start (per-port restore; interval=${INTERVAL}s, stop file=$STOP_FILE)"
while true; do
  if [ -e "$STOP_FILE" ]; then
    log "watchdog stop (stop file present)"
    exit 0
  fi
  m="$(missing)"
  for port in $m; do
    restore_port "$port"
  done
  sleep "$INTERVAL"
done
