# Port-forward observations (2026-10-08)

Context for `port-forward-watchdog.sh` / `port-forward-start.sh`. Transport only, no cluster writes.

## kubectl client

`kubectl version --client -o json` (2026-10-08, lead-requested baseline):
`v1.36.3+k3s1` (gitCommit `5aed4d7beddeb3e67120da477c876ac9efd70318`, go1.26.5, linux/amd64).

## Watchdog restarts per hour (2026-10-08, from /tmp/paladin-pf-watchdog.log)

| Hour (UTC) | RESTART events |
|---|---|
| 08 | 9 |
| 09 | 20 |
| 10 | 3 |
| 11 | 2 |
| 12 | 1 (lead-approved manual test of the append-log change) |

Burst 08:00-09:59 (29 of 35 events) — individual forwards dying every 1-5 minutes,
rotating across all eight ports; the watchdog restored each within ~35s. The burst
correlates with the period several agent sessions were running heavy work; quieter
after 10:00. Death reason was NOT retained before the append-log change
(`port-forward-start.sh` used `>` and overwrote /tmp/pf-*.log on every restart) —
that is exactly what the append change fixes; the next death now leaves its
stderr/exit output after a `=== <date> start port <N> ===` marker.

## Restore mechanism (unchanged, lead decision 2026-10-08)

Watchdog detects a missing listener, runs `port-forward-stop.sh` (kills all tracked
pids) then `port-forward-start.sh` (starts all eight). One port dying cycles all
eight (~5s). Per-port restore is on HOLD: trigger is >5 deaths/day AFTER the
append-log change is in effect (so the stop-all/start-all cycle itself can be
ruled in or out as noise).

## Death-cause hypothesis (lead, 2026-10-08; recorded, not investigated further)

- Resource-pressure candidate: the 08:00-09:59Z burst is 29 of 35 events. Check
  whether that window coincides with heavy LOCAL load (forge/vitest/E2E runs by the
  agent sessions on this host). If yes, local resource pressure is the candidate,
  not network.
- Discriminator for the next death (now that stderr is retained): a killed-by-signal
  kubectl (OOM-killer, external cleanup) dies SILENTLY -- marker with no stderr
  between it and the next start marker. A network/pod-side failure prints its own
  error first. So: silent death = external signal; stderr present = transport error.
- UPGRADE (lead, 2026-10-08 later): the real discriminator is the EXIT CODE, not
  stderr presence -- kubectl can self-exit (0/1) without stderr when the upstream
  stream drops. Each start now logs `=== <date> EXIT port <N> ... code=<rc> ===`
  when its kubectl dies. Reading: 143 = SIGTERM (external), 137 = SIGKILL/OOM,
  0/1 = self-exit (stream/k3s side). Verified live: manual SIGTERM produced
  `code=143`.
- Instrumentation gotcha (observed, then fixed): under the script's `set -e`, a bare
  `wait "$c"` returns nonzero when kubectl is SIGTERM'd and errexit killed the
  wrapper subshell BEFORE it could write the EXIT marker -- first instrumented
  generation left no marker at all. Fixed with `rc=0; wait "$c" || rc=$?`.
- journalctl -k check (`--since 13:00 | grep -ic 'killed process'`): 0 matches,
  journal not readable from this account -- OOM NOT confirmed by kernel log, and
  absence of evidence is not evidence of absence here.

## Attribution scheme (lead, 2026-10-08 late; this is the binding read)

- All markers now carry millisecond timestamps (`date +%FT%T.%3N%z`).
- `port-forward-stop.sh` appends `=== <ts> STOP port <N> (stop-script) ===` to that
  port's log immediately BEFORE killing it.
- READ RULE (binding): `EXIT ... code=143` PRECEDED by a STOP marker = our own
  stop-all cycle. 143 WITHOUT a STOP marker = external SIGTERM. 137 = SIGKILL/OOM.
  0/1 = self-exit (stream/k3s side). The victim port is ALWAYS the one named in the
  watchdog log's `RESTART missing ports:` line -- per-port EXIT markers never
  determine who died first (stop-all cycles all eight).
- Verified live 2026-10-08/09: manual kill of :31648 produced
  `01:22:05.178+0800 EXIT port 31648 code=143` with no STOP before it; the following
  watchdog cycle wrote ms STOP markers for the other seven (01:21:37.18x-37x) and the
  victim's earlier EXIT stayed un-attributed. Discriminator works.
- All deaths observed so far = 143 (SIGTERM). None have been 137/0/1.

## Raw records (passive mode, lead 2026-10-08: collect, do not act unless >5 deaths/day or 137/0/1)

### 2026-10-09 05:06:00+0800 (21:06:00Z) -- :31748, NEW failure mode, not a process death

- Watchdog: `RESTART missing ports: 31748` -> restored 05:06:05.
- ALL EIGHT kubectls were ALIVE at stop time: every port (including 31748) logged
  `STOP port N (stop-script)` followed by `EXIT ... code=143` at 05:06:00.5xx-.8xx --
  stop-marked, i.e. killed by our own cycle. No port died on its own (no untagged
  143, no 137/0/1).
- Reading: the :31748 LISTENER had vanished while its kubectl process lived (or the
  probe misdetected it) -- a degraded-listener / probe event, NOT an external kill.
  This is a distinct failure mode from 15:59:46Z (:31848, untagged 143 = external
  SIGTERM).
- Lesson (self-inflicted, recorded so nobody repeats it): `tail` is NOT a safe way to
  read these logs -- the killed generation's STOP/EXIT sit further up, under later
  'Handling connection' lines. Always `grep -E 'start port|STOP port|EXIT port' <log>`.
  An earlier read of this same event wrongly concluded "victim had no EXIT at all".
- Same-day sanity: the 9th `kubectl` process seen at 05:20 was my own guard loop's
  `kubectl get pods` (parent: claude bg-spare), not an intruder.

### 2026-10-09 05:25:09+0800 (21:25:09Z) -- :31748 again, same signature as 05:06

- Watchdog: `RESTART missing ports: 31748` (second time in 19 minutes, same port).
- All eight alive at stop time (all STOP+EXIT code=143, stop-marked; no untagged 143).
- Pattern so far: listener-loss-with-live-process on :31748 twice in 20 min, while the
  only genuine process death today was :31848 at 15:59:46Z (untagged 143). Two events
  is still small; recording only. Local-day death count (Oct 9): 2 events, 0 process
  deaths -- under the >5/day trigger.

### 2026-10-09 07:26:38+0800 (23:26:38Z) -- :31848, same listener-loss class, third today

- Watchdog: `RESTART missing ports: 31848`. All eight alive at stop time (all STOP +
  EXIT code=143, stop-marked). Victim port varies (:31748, :31748, :31848) -- so the
  class, not one bad port. Local-day (Oct 9) tally: 3 events, all listener-loss/
  probe class, 0 real process deaths -- still under the >5/day trigger.

### 2026-10-09 08:56:00+0800 (00:56:00Z) -- TWO ports at once (:31649 + :31748), fourth today

- Watchdog: `RESTART missing ports: 31649 31748` -- first multi-port event. All
  eight alive at stop time (8 stop-markers), so still listener-loss class, but the
  loss was simultaneous on two ports this time.
- Local-day (Oct 9) tally: 4 events (05:06, 05:25, 07:26, 08:56), 0 real process
  deaths. One more event today hits the >5/day trigger and gets reported with raw
  logs per the lead's passive-mode rule.

### 2026-10-09 10:03-10:10+0800 (02:03-02:10Z) -- TRIGGER TRIPPED: events 5-7, rate accelerating

- `02:03:49Z missing 31649 31849`, `02:06:25Z missing 31548`, `02:10:31Z missing 31648`
  -- three events in seven minutes after four in the preceding four hours. Oct-9
  local tally: 7 events. Reported to lead with raw logs (trigger i, >5/day).
- ALL SEVEN are listener-loss class: every cycle shows all eight kubectls ALIVE at
  stop time (stop-marked STOP+EXIT 143). Zero non-143 codes; no untagged 143 since
  2026-10-08 15:59:46Z. The stop-all/start-all churn now cycles all eight ports every
  few minutes -- transport recovers <=5s each time, but the churn itself is now a
  recurring cost. (c) (per-port restore) decision moved to the lead.




## CORRECTION (lead, 2026-10-09): the "all deaths = external SIGTERM" reading is RETRACTED

The earlier conclusion "every death observed = 143 (SIGTERM), therefore an external
killer" is WRONG and is retracted here. Evidence: in the 10:10:31+0800 cycle the port
reported missing (:31648) still had a LIVE kubectl at stop time (it received a
STOP-marked EXIT 143 from our own stop-all). The true class of every event observed
so far is **listener-loss-with-live-process** (kubectl hangs: upstream connection
drops, listener socket is released, the process never exits). Since STOP markers
exist only from 01:21+0800, every 143 ever seen is attributable to OUR cycles; no
unmarked 143 has ever been proven. There is no confirmed external killer.

## Per-port restore (lead GO, 2026-10-09) -- implemented and tested

- `port-forward-start.sh --only PORT`: starts exactly one listener, APPENDS pid (and
  map entry) instead of truncating; full mode unchanged.
- `port-forward-watchdog.sh`: per missing port -> (1) connect-test second
  confirmation (`</dev/tcp/127.0.0.1/PORT`): success = PROBE-FALSE, no restart
  (observed working live: `PROBE-FALSE port 31648` after a fresh restore); (2)
  resolve the victim's pid from the pid<->port map; if alive (hung class): dump
  evidence to /tmp/pf-evidence-<port>-<ts>.txt (ss listener/sockets, fd count,
  /proc status, wchan), write a `RESTORE-KILL port N` marker into the port's log,
  TERM then KILL escalate; (3) clean dead entries from pidfile+map by liveness;
  (4) start `--only`; (5) assert pidfile == 8 and log a WARNING otherwise.
- Tests (2026-10-09 10:25/10:26+0800): (A) dead-victim path -- kill :31648 ->
  `no live pid (already exited)` -> per-port restore, pidfile=8, healthy seven keep
  their pids. (B) hung-victim path (spoofed live process mapped to :31849) ->
  evidence dump + `RESTORE-KILL` + kill + per-port restart, pidfile=8, spoof dead.
- Read rule (updated): EXIT 143 preceded by STOP (stop-script) or RESTORE-KILL
  (watchdog) = our kill; 143 with neither = external (none proven yet); listener
  gone with NO EXIT marker at all = class B (hung process) -- resolved by the map.

## Host gotcha discovered during this work (cost one pidfile wipe, recovered)

`/proc/<pid>/cmdline` for the kubectl forwards on this host reads back as bare
`kubectl` -- argv is hidden. A first watchdog revision resolved port->pid by cmdline
matching; it silently matched nothing and cleaned the pidfile down to zero (the
healthy seven were still running, so state was recovered by rebuilding pidfile+map
from `ss -ltnp`). Replacement: `paladin-port-forward.map` (pid port per line,
written by the start wrapper, filtered by liveness) -- never cmdline-based again.

## Hypothesis (d) -- session-scoped cleanup (lead, 2026-10-08; recorded, not a claim)



The pidfile lives under `/tmp/claude-1000/<session-uuid>/scratchpad/`, i.e. inside a
Claude session's scratch path. The harness may reap a session's background process
group when that session ends -- a cheap external candidate for single-port SIGTERMs.
If another death happens, record only whether its timestamp sits close to any
session restart/compaction. (c) stays HOLD; if ms+STOP attribution keeps working,
(c) may never be needed.

## 2026-10-11 -- consolidated flicker tallies (passive mode continues)

- New-label totals in /tmp/paladin-pf-watchdog.log: 86 lines all-time; 24 fall in
  local day 2026-10-09, 62 in local day 2026-10-10 (fully closed, 16:00Z Oct 9 to
  16:00Z Oct 10). The 2026-10-09 consolidated report counted 34 for that day
  (old + new labels; ~10 events ran under the old `PROBE-FALSE` label before the
  rename), so the day-over-day rate roughly doubled on Oct 10.
- Local day 2026-10-10 in full: all 62 are connect-test-success (zero restarts),
  zero LISTENER-LOST, zero RESTORED/WARNING. Distribution: :31649 x16,
  :31748 x13, :31749 x12, :31648 x7, :31849 x4, :31848 x4, :31548 x4, :31549 x2.
  The burst shape persisted all day: 2-4 ports missing simultaneously (never a
  single-port event after ~10:00Z), bursts 15-40 min apart in busy windows,
  long quiet stretches overnight. Closed-day summary sent to lead
  (msg 0e312f19).
- Local day 2026-10-11 (fully closed, 16:00Z Oct 10 to 16:00Z Oct 11): 69
  flickers, all connect-test-success, zero restarts, zero LISTENER-LOST.
  Distribution: :31749 x13, :31748 x11, :31649 x10, :31849 x8, :31648 x8,
  :31848 x7, :31549 x7, :31548 x5. Largest single burst so far: 5 ports at
  once (17:15:15Z Oct 10 UTC, :31649 :31748 :31749 :31848 :31849). Day-over-day:
  34 (Oct 9, mixed labels) -> 62 (Oct 10) -> 69 (Oct 11), still creeping up.
  Closed-day summary sent to lead (msg 0eb6f10f). Local day 2026-10-12 starts
  at 0 events.
- Reading unchanged: transient `ss` probe misses under host load; the connect-test
  gate keeps the watchdog correct (zero wrong restarts to date). No action taken;
  reported to lead.



