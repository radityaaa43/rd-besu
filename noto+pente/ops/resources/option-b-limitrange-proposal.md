# Option (b) proposal: LimitRange + priorityClassName-only patch

Read-only analysis, nothing applied. Follows node4's real rollout result: the operator
reverts `resources`/`env` on every reconcile (confirmed: new StatefulSet generation after a
no-op CR annotation, both fields back to empty) but leaves `priorityClassName` alone
(confirmed: survived).

## Files

- `limitrange.yaml` -- new namespace-scoped `LimitRange paladin-defaults`. Dry-run (server):
  accepted, would create cleanly.
- `patch-priorityclass-only.yaml` -- same `priorityClassName` field as before, nothing else.
  For node1-3 only (node4 already has it live). Dry-run (server) against node1: confirmed
  it would set `priorityClassName` to `paladin-high-priority` (node1 currently has none).

## Why a LimitRange survives where the StatefulSet patch didn't

A LimitRange is a separate object in the `paladin` namespace -- the operator doesn't own or
reconcile it, so there's nothing for it to revert. It works by filling in `default`/
`defaultRequest` resources for any container that specifies none of its own (both `postgres`
and `paladin` containers currently have `resources: {}}`, exactly the condition it targets).

**Real limitation, not glossed over**: the LimitRange API has no per-container-NAME targeting,
only per-container-TYPE -- the SAME default applies to both `postgres` and `paladin`. postgres
needs far less (measured idle: 66-220Mi) than paladin's JVM. This proposal accepts a generous,
mostly-unused ceiling on postgres as harmless rather than solving per-container
differentiation, which would need a mutating admission webhook (Kyverno -- not installed,
same gap already flagged in the original task #16 proposal's option (b)/(c)).

**Real limitation, applies to new pods only**: a LimitRange's defaults apply at pod ADMISSION,
not retroactively. Every existing `paladin-nodeN-0` pod still needs one planned restart (same
node4->3->2->1 order, same pre/post-check discipline as the original runbook) before it takes
effect -- this does not avoid the restart, only avoids the operator fighting the result
afterward.

## The memory number, verified live, not guessed

Exec'd into `paladin-node3-0` and read the JVM's own real ergonomic defaults:
```
openjdk version "21.0.4" 2024-07-16 LTS (Temurin)
MaxRAMPercentage = 25.000000 {product} {default}
UseContainerSupport = true {product} {default}
MaxHeapSize = 1753219072 {ergonomic}  (~1673MiB, today -- 25% of the NODE's visible ~6.5-7GiB,
                                       since there is no container limit yet; this is exactly
                                       the danger task #16 started from)
```
A LimitRange cannot set an environment variable (`JDK_JAVA_OPTIONS`), so there is no way to set
an explicit `-Xmx` through this mechanism. Instead, this proposal picks the memory LIMIT so the
JVM's own 25%-of-limit default lands close to the earlier explicit recommendation of a 1Gi
heap: `4096Mi * 0.25 = 1024Mi`. A smaller limit (e.g. 2560Mi -> 640Mi heap) risks being too
tight: measured idle/light RSS on this cluster already ranges 167-865Mi per paladin container
(heap+off-heap combined, not heap alone), so a heap-only ceiling below ~1Gi leaves little
margin before a real GC/heap-pressure incident -- a different failure mode from the
container-level OOM this task started from, but still worth avoiding.

## Proposed values

```yaml
defaultRequest: { cpu: 200m, memory: 768Mi }
default (limit): { cpu: "1", memory: 4096Mi }
```
No `min`/`max` set -- only fills in defaults for a container with none, never rejects or caps
a future pod spec that sets its own resources explicitly.

## Rollout, if approved

Same order and discipline as the original runbook (`README.md`): node4 is already live with
`priorityClassName` and will pick up the LimitRange's resource defaults on its NEXT restart
(not required immediately, but worth doing once to get it onto the same resource footing as
1-3). For node1-3: apply `limitrange.yaml` once (namespace-scoped, not per-node), then per
node: pre-check -> `kubectl patch statefulset paladin-node<N> --patch-file
patch-priorityclass-only.yaml` -> pod restarts, picks up BOTH the patched
`priorityClassName` AND the LimitRange's resource defaults in the same restart -> post-check
(confirm `priorityClassName` AND `resources` both non-empty on the pod this time, since the
LimitRange-sourced resources have nothing to be reverted BY).
