#!/usr/bin/env python3
"""zeto S5a: add ONE new validator to the QBFT set, voted by the OLD validators (final-design/zeto/PLAN.md S5a; Besu docs
private-networks/how-to/configure/consensus/qbft "Add and remove validators"). AFTER: ARCHITECTURE-zeto 2a (validator set = the 4 bank validators).
The caller opens the RPC doors (kubectl port-forward to besu-node-validator-N-0 :8545 in ns besu, cluster-admin); this script never talks to a cluster.
  vote.sh --old URL x4 --new-rpc URL --address 0x<new> [--dry-run] [--timeout 300] | --withdraw
Flow: pre-checks (read-only) -> propose(NEW,true) on floor(n/2)+1 old validators -> STOP A (NEW in the set within --timeout, else exit 3,
nothing discarded) -> discard(NEW) on the same ones -> STOP B (NEW still in the set, blocks rising). --withdraw = discard(NEW) on all 4 old (rollback of a stuck vote)."""
import argparse, json, re, sys, time, urllib.request

QUORUM = lambda n: -(-2 * n // 3)  # ceil(2n/3) [derived, Besu source not read: PLAN S5]


def rpc(url, method, params=None):
    req = urllib.request.Request(url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []}).encode(), {"content-type": "application/json"})
    out = json.load(urllib.request.urlopen(req, timeout=10))
    if out.get("error"):
        raise RuntimeError(f"{method}: {out['error']}")
    return out["result"]


def block(url):
    return int(rpc(url, "eth_blockNumber"), 16)


def validators(url):
    return [v.lower() for v in rpc(url, "qbft_getValidatorsByBlockNumber", ["latest"])]


def die(msg, code=2):
    print(msg, file=sys.stderr)
    sys.exit(code)


ap = argparse.ArgumentParser()
ap.add_argument("--old", action="append", default=[], help="RPC URL of an OLD validator (exactly 4)")
ap.add_argument("--new-rpc", help="RPC URL of the NEW node being added (gap check)")
ap.add_argument("--address", required=True)
ap.add_argument("--dry-run", action="store_true")
ap.add_argument("--withdraw", action="store_true")
ap.add_argument("--timeout", type=float, default=300)
ap.add_argument("--poll-interval", type=float, default=5)
ap.add_argument("--rise-window", type=float, default=10)
a = ap.parse_args()

if not re.fullmatch(r"0x[0-9a-fA-F]{40}", a.address):
    die("vote.sh: --address must be a 0x + 40 hex address")
new = a.address.lower()
if len(a.old) != 4:
    die("vote.sh: exactly 4 --old endpoints are needed (the 4 old validators)")

# pre-checks (read-only): every old endpoint answers, all agree on the set, chain advancing
sets = []
try:
    b0 = [block(u) for u in a.old]
    sets = [validators(u) for u in a.old]
except Exception as e:
    die(f"vote.sh: pre-check failed, an old validator endpoint does not answer ({e}); no call made")
if any(sorted(s) != sorted(sets[0]) for s in sets):
    die("vote.sh: the 4 old validators disagree on the validator set; no call made")
cur = sets[0]
n = len(cur)
print(f"set n={n}: {', '.join(v[:10] + '…' for v in cur)}; new={new[:10]}…; block {max(b0)}")
print("quorum ceil(2n/3) [derived]: " + ", ".join(f"n={k}:{QUORUM(k)}" for k in range(4, 9)))

if a.withdraw:
    for i, u in enumerate(a.old):
        print(f"qbft_discardValidatorVote({new}) on old[{i}]" + (" (dry-run)" if a.dry_run else ""))
        if not a.dry_run:
            rpc(u, "qbft_discardValidatorVote", [new])
    sys.exit(0)

if new in cur:
    die("vote.sh: address is already in the validator set; nothing to do")
if n + 1 > 8:
    die("vote.sh: the set would exceed 8 validators")
if a.new_rpc:
    gap = max(b0) - block(a.new_rpc)
    if gap > 2:
        die(f"vote.sh: the new node is {gap} blocks behind (> 2); wait for it to sync")
elif not a.dry_run:
    die("vote.sh: --new-rpc is required for a real run (gap check)")
time.sleep(min(a.rise_window, 2))
if max(block(u) for u in a.old) <= max(b0):
    die("vote.sh: chain is not advancing; no call made")

need = n // 2 + 1  # more than 50% of the CURRENT set, voted by old validators
if need > 4:
    die(f"vote.sh: n={n} needs {need} votes, only 4 old validators vote")
voters = a.old[:need]
print(f"plan: propose on {need} of 4 old validators (more than 50% of n={n}), wait (STOP A), discard on the same, check (STOP B)")
for i in range(need):
    print(f"qbft_proposeValidatorVote({new}, true) on old[{i}]")
for i in range(need):
    print(f"qbft_discardValidatorVote({new}) on old[{i}]")
if a.dry_run:
    sys.exit(0)

for u in voters:
    rpc(u, "qbft_proposeValidatorVote", [new, True])
deadline = time.time() + a.timeout
while new not in validators(a.old[0]):
    if time.time() > deadline:
        die(f"STOP A: {new} not in the validator set after {a.timeout:.0f}s. Votes are still cast; decide: wait, or run again with --withdraw. Nothing discarded.", 3)
    time.sleep(a.poll_interval)
print(f"STOP A passed: {new} is in the set")
for u in voters:
    rpc(u, "qbft_discardValidatorVote", [new])
s = validators(a.old[0])
b1 = block(a.old[0])
time.sleep(a.rise_window)
b2 = block(a.old[0])
if new not in s or b2 - b1 < 3 * a.rise_window / 10:
    die(f"STOP B: set contains new={new in s}, blocks {b1}->{b2} in {a.rise_window:.0f}s (expected >= {3 * a.rise_window / 10:.1f})", 4)
print(f"STOP B passed: n={len(s)}, blocks {b1}->{b2} in {a.rise_window:.0f}s")
