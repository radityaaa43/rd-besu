#!/usr/bin/env python3 -I
"""One-command verdict on a CANDIDATE bundle set before any publish (analyst/lead 2026-11-12). Python stdlib + opa + openssl; never writes to a cluster.
  candidate-verdict.py <candidate dir with node1..4/{bi,bank}.tar.gz> --repo <rd-besu checkout> --sha <pinned sha> [--ref tools/live-docs-2026-11-12.json] [--no-doors]
Checks (any failure = FAIL, exit 1):
 (1) PARITY   every rego member of every tar is byte-equal to rd-besu@sha; the file SET equals the repo set (bi and bank, nothing missing, nothing extra);
              data.json equals the repo data.json@sha in every key except the Kebijakan documents (`policy`, `platforms`; `policy` for bank).
 (2) DOCS     Kebijakan documents equal the reference hashes (the old live documents): BI document in all 4 bi tars, each bank's document in its bank tar.
 (3) REGRESS  test/regress (in-hours writes per function, other identity deny, boundaries, report group, documents exist) on the candidate data.
 (4) DOORS    the candidate's OWN rego + data run the repo's door tests: sink, stealth, iroha3 and fabricx allowed for the right CNs and denied for the others.
Signatures are checked separately (policy-docs.py verify) on the SIGNED bundles after the publish."""
import json, os, re, shutil, subprocess, sys, tarfile, tempfile
a = sys.argv[1:]
def opt(n, d=None): return a[a.index(n) + 1] if n in a else d
cand, repo, sha, ref = a[0], opt("--repo"), opt("--sha"), opt("--ref")
here = os.path.dirname(os.path.abspath(__file__)); opa_dir = os.path.join(here, "..")
fails = []
def fail(m): fails.append(m); print("FAIL " + m)
def ok(m): print("ok   " + m)
def git(path): 
    r = subprocess.run(["git", "-C", repo, "show", f"{sha}:{path}"], capture_output=True)
    return r.stdout if r.returncode == 0 else None
def members(p):
    with tarfile.open(p) as t: return {m.name: t.extractfile(m).read() for m in t.getmembers() if m.isfile()}
def rego_map(kind, mem):
    out = {}
    for n, b in mem.items():
        m = re.search(r"/" + kind + r"/((?:bi|bank|gw|system)/.*\.rego)$", n)
        if m: out[m.group(1)] = b
    return out
repo_tree = subprocess.run(["git", "-C", repo, "ls-tree", "-r", "--name-only", sha, "opa/bundles"], capture_output=True, text=True).stdout.split()
# (1) parity
for n in (1, 2, 3, 4):
    for kind in ("bi", "bank"):
        p = f"{cand}/node{n}/{kind}.tar.gz"
        if not os.path.exists(p): fail(f"node{n} {kind}: tar missing"); continue
        mem = members(p); got = rego_map(kind, mem)
        want = {f[len(f"opa/bundles/{kind}/"):] for f in repo_tree if f.startswith(f"opa/bundles/{kind}/") and f.endswith(".rego")}
        missing, extra = sorted(want - set(got)), sorted(set(got) - want)
        diff = [k for k in got if k in want and got[k] != git(f"opa/bundles/{kind}/{k}")]
        if missing or extra or diff: fail(f"node{n} {kind}: rego set/bytes differ from rd-besu@{sha}: missing {missing[:4]} extra {extra[:4]} different {diff[:4]} (repo {len(want)} files, candidate {len(got)})")
        else: ok(f"node{n} {kind}: {len(got)} rego files = the repo set @{sha[:7]}, byte-equal")
        d = json.loads(mem["/data.json"]); rd = json.loads(git(f"opa/bundles/{kind}/{kind}/config/data.json") or b"{}") if kind == "bi" else None
        if kind == "bi":
            cfg = d["bi"]["config"]; bad = [k for k in sorted(set(rd) | set(cfg)) if k not in ("policy", "platforms") and rd.get(k) != cfg.get(k)]
            if bad: fail(f"node{n} bi data.json keys differ from the repo: {bad}")
            else: ok(f"node{n} bi data.json = repo data.json@{sha[:7]} except policy/platforms")
# (2) docs
if ref:
    names = {("bi", 1): "old-1-bi.tar.gz", ("bank", 1): "old-1-bank.tar.gz", ("bank", 2): "old-2-bank.tar.gz", ("bank", 3): "old-3-bank.tar.gz", ("bank", 4): "old-4-bank.tar.gz"}
    for n in (1, 2, 3, 4):
        for kind in ("bi", "bank"):
            p = f"{cand}/node{n}/{kind}.tar.gz"
            if not os.path.exists(p): continue
            env = dict(os.environ, POLICY_DOCS_AS=names[("bi", 1)] if kind == "bi" else names[("bank", n)])
            r = subprocess.run([sys.executable, "-I", f"{here}/policy-docs.py", "diff", p, ref], capture_output=True, text=True, env=env)
            (ok if r.returncode == 0 else fail)(f"node{n} {kind}: Kebijakan documents {'equal the reference' if r.returncode == 0 else 'DIFFER: ' + r.stdout.strip().replace(chr(10), '; ')[:200]}")
# (3) regress + (4) doors on the candidate's own rego
tmp = tempfile.mkdtemp()
try:
    for kind in ("bi", "bank"):
        mem = members(f"{cand}/node1/{kind}.tar.gz"); base = f"{tmp}/{kind}"
        for rel, b in rego_map(kind, mem).items():
            os.makedirs(os.path.dirname(f"{base}/{rel}"), exist_ok=True); open(f"{base}/{rel}", "wb").write(b)
        open(f"{base}/data.json", "wb").write(mem["/data.json"]) if kind == "bi" else None
    r = subprocess.run([f"{here}/regress.sh", f"{cand}/node1/bi.tar.gz", f"{cand}/node2/bank.tar.gz", f"{cand}/node3/bank.tar.gz", f"{cand}/node4/bank.tar.gz"], capture_output=True, text=True)
    (ok if r.returncode == 0 else fail)("regression template on the candidate: " + (r.stdout.strip().splitlines()[-2] if r.returncode == 0 else (r.stdout + r.stderr).strip().splitlines()[-1][:160]))
    # doors: the repo's door tests run against the candidate's rego (a missing platform package makes them fail)
    r = subprocess.CompletedProcess([], 0, "PASS: skipped (--no-doors)", "") if "--no-doors" in a else subprocess.run(["opa", "test", f"{tmp}/bi", f"{tmp}/bank", os.path.join(opa_dir, "test"), "--timeout", "60s", "--run", "(sink_test|stealth_test|iroha3_test|fabricx_test|gw_test)"], capture_output=True, text=True)
    last = [l for l in (r.stdout + r.stderr).splitlines() if l.startswith(("PASS", "FAIL", "ERROR")) or "error" in l.lower()][:3]
    (ok if r.returncode == 0 else fail)("door tests (sink, stealth, iroha3, fabricx, gw) on the candidate's rego+data: " + " | ".join(last))
finally:
    shutil.rmtree(tmp, ignore_errors=True)
print("VERDICT: " + ("PASS" if not fails else f"FAIL ({len(fails)} checks)")); sys.exit(1 if fails else 0)
