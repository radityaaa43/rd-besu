#!/usr/bin/env python3
"""Offline test of zeto/k8s/besu/vote.sh (PLAN S5a) against fake QBFT JSON-RPC servers. No cluster, stdlib only.
Usage: vote_test.py <vote.sh>   Exit 0 = all assertions hold."""
import http.server, json, subprocess, sys, threading, time

vote = sys.argv[1]
OLD = ["0x" + c * 40 for c in "abcd"]
NEW = "0x" + "e" * 40
fails = []


def check(ok, msg):
    if not ok:
        fails.append(msg)


class Chain:
    def __init__(self, validators, stall=False):
        self.validators = list(validators)
        self.votes = {}  # target -> set(voter index)
        self.calls = []  # (method, voter index, params)
        self.stall = stall
        self.t0 = time.time()
        self.dead = set()

    def block(self):
        return 1000 + int((time.time() - self.t0) * 20)


def serve(chain, idx):
    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            req = json.loads(self.rfile.read(int(self.headers["content-length"])))
            m, p = req["method"], req.get("params", [])
            if m.startswith("qbft_") and m != "qbft_getValidatorsByBlockNumber":
                chain.calls.append((m, idx, p))
            res = None
            if m == "eth_blockNumber":
                res = hex(chain.block())
            elif m == "qbft_getValidatorsByBlockNumber":
                res = list(chain.validators)
            elif m == "qbft_proposeValidatorVote":
                chain.votes.setdefault(p[0], set()).add(idx)
                if not chain.stall and len(chain.votes[p[0]]) >= len(chain.validators) // 2 + 1 and p[0] not in chain.validators:
                    chain.validators.append(p[0])
                res = True
            elif m == "qbft_discardValidatorVote":
                chain.votes.setdefault(p[0], set()).discard(idx)
                res = True
            body = json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": res}).encode()
            self.send_response(200)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    s = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s


def run(chain, *extra, dead=()):
    olds = [serve(chain, i) for i in range(4)]
    new = serve(chain, 9)
    urls = [f"http://127.0.0.1:{s.server_address[1]}" for s in olds]
    for d in dead:
        urls[d] = "http://127.0.0.1:1"
    args = [vote]
    for u in urls:
        args += ["--old", u]
    args += ["--new-rpc", f"http://127.0.0.1:{new.server_address[1]}", "--poll-interval", "0.2", "--rise-window", "1"]
    args += list(extra)
    r = subprocess.run(args, capture_output=True, text=True, timeout=60)
    for s in olds + [new]:
        s.shutdown()
    return r


def writes(chain, kind):
    return [(m, i) for m, i, p in chain.calls if m == kind]


# 1. happy path n=4: propose from exactly 3 of the 4 old, then discard from the same 3, set grows to 5
c = Chain(OLD)
r = run(c, "--address", NEW, "--timeout", "10")
check(r.returncode == 0, f"happy path exit {r.returncode}: {r.stderr[-300:]}")
check(sorted(i for m, i in writes(c, "qbft_proposeValidatorVote")) == [0, 1, 2], f"n=4 must vote from the first 3 old: {writes(c, 'qbft_proposeValidatorVote')}")
check(sorted(i for m, i in writes(c, "qbft_discardValidatorVote")) == [0, 1, 2], "discard must run on the same 3")
check(NEW in c.validators and len(c.validators) == 5, f"set must hold the new address: {c.validators}")
check(all(p[0] == NEW and p[1] is True for m, i, p in c.calls if m == "qbft_proposeValidatorVote"), "propose must be (NEW, true)")
check("quorum" in r.stdout.lower() and "n=5" in r.stdout, "output must print the quorum table")

# 2. dry run: prints the calls, performs no write
c = Chain(OLD)
r = run(c, "--address", NEW, "--dry-run")
check(r.returncode == 0 and not c.calls, f"dry-run must not write: {c.calls}")
check("qbft_proposeValidatorVote" in r.stdout and "qbft_discardValidatorVote" in r.stdout and NEW in r.stdout, "dry-run must print the exact calls")

# 3. votes needed = floor(n/2)+1: n=5 -> 3, n=6 -> 4
for extra, want in ((1, 3), (2, 4)):
    c = Chain(OLD + ["0x" + str(k) * 40 for k in range(5, 5 + extra)])
    r = run(c, "--address", NEW, "--timeout", "10")
    got = len(writes(c, "qbft_proposeValidatorVote"))
    check(r.returncode == 0 and got == want, f"n={4 + extra}: want {want} votes, got {got} (exit {r.returncode})")

# 4. stop A: vote never lands -> exit 3, NO discard, address not added
c = Chain(OLD, stall=True)
r = run(c, "--address", NEW, "--timeout", "1")
check(r.returncode == 3 and "STOP A" in r.stdout + r.stderr, f"stop A exit {r.returncode}")
check(not writes(c, "qbft_discardValidatorVote"), "stop A must not discard (operator decides; --withdraw is the rollback)")

# 5. refusals: address already in set, bad address, a dead old endpoint, fewer than 4 --old
c = Chain(OLD + [NEW])
check(run(c, "--address", NEW).returncode != 0 and not c.calls, "address already in set must be refused")
c = Chain(OLD)
check(run(c, "--address", "0x1234").returncode != 0 and not c.calls, "malformed address must be refused")
c = Chain(OLD)
r = run(c, "--address", NEW, dead=(3,))
check(r.returncode != 0 and not c.calls, "an unreachable old validator endpoint must stop before any write")

# 6. --withdraw: discard on all 4 old, nothing else
c = Chain(OLD, stall=True)
r = run(c, "--address", NEW, "--withdraw")
check(r.returncode == 0 and sorted(i for m, i in writes(c, "qbft_discardValidatorVote")) == [0, 1, 2, 3] and not writes(c, "qbft_proposeValidatorVote"), "withdraw = discard on all 4, no propose")

if fails:
    print("\n".join("FAIL " + f for f in fails), file=sys.stderr)
    sys.exit(1)
print("OK vote.sh: all assertions hold")
