#!/usr/bin/env python3 -I
"""Offline self-test of candidate-verdict.py with a SYNTHETIC candidate built from this repo (all rego files + data.json + synthetic Kebijakan documents):
the complete candidate must pass, a missing file / a changed byte / a missing document must fail. Run from the opa directory: python3 -I tools/test_candidate_verdict.py"""
import io, json, os, subprocess, sys, tarfile, tempfile
here = os.path.dirname(os.path.abspath(__file__)); opa = os.path.join(here, ".."); repo = os.path.abspath(os.path.join(opa, ".."))
sha = subprocess.run(["git", "-C", repo, "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
fails = []
def check(ok, msg):
    if not ok: fails.append(msg)
bi_doc = {"max_per_tx": {"RD": 2000000000, "DFABI": 1000}, "max_mint_per_tx": {"RD": 10**15, "DFABI": 10**15},
          "hours": {t: {"days": [1, 2, 3, 4, 5, 6, 7], "open": "00:00", "close": "24:00"} for t in ("RD", "DFABI")}, "holidays": [], "frozen": []}
policy = {p: bi_doc for p in ("zeto", "noto", "fabricx", "iroha3")}
cp = {"bank-a": ["bi@node1", "bankB@node3", "bankC@node4"], "bank-b": ["bi@node1", "bankA@node2", "bankC@node4"], "bank-c": ["bi@node1", "bankA@node2", "bankB@node3"], "bank-bi": ["bankA@node2", "bankB@node3", "bankC@node4"]}
def tar(path, kind, data, drop=None, flip=None):
    base = os.path.join(opa, "bundles", kind)
    with tarfile.open(path, "w:gz") as t:
        def add(name, b):
            ti = tarfile.TarInfo(name); ti.size = len(b); t.addfile(ti, io.BytesIO(b))
        add("/data.json", json.dumps(data).encode())
        for dp, _, fn in os.walk(base):
            for f in fn:
                if not f.endswith(".rego"): continue
                rel = os.path.relpath(os.path.join(dp, f), base)
                if rel == drop: continue
                b = open(os.path.join(dp, f), "rb").read()
                if rel == flip: b += b"\n# changed\n"
                add(f"/tmp/lensa-bundle-x/{kind}/{rel}", b)
        add("/.manifest", b'{"revision":"synthetic","roots":["gw","bi","system"]}')
def build(d, drop=None, flip=None, nodoc=False):
    bi = json.load(open(os.path.join(opa, "bundles/bi/bi/config/data.json")))
    if not nodoc: bi["policy"] = policy; bi["platforms"] = list(policy)
    for n, name in ((1, "bank-bi"), (2, "bank-a"), (3, "bank-b"), (4, "bank-c")):
        os.makedirs(f"{d}/node{n}", exist_ok=True)
        tar(f"{d}/node{n}/bi.tar.gz", "bi", {"bi": {"config": bi}}, drop=drop, flip=flip)
        tar(f"{d}/node{n}/bank.tar.gz", "bank", {"bank": {"config": {"policy": {p: {"counterparties": cp[name]} for p in policy}}}}, drop=drop and "x", flip=None)
def verdict(d, ref, extra=()):
    return subprocess.run([sys.executable, "-I", f"{here}/candidate-verdict.py", d, "--repo", repo, "--sha", sha, "--ref", ref, *extra], capture_output=True, text=True)
tmp = tempfile.mkdtemp()
good = f"{tmp}/good"; build(good)
refdir = f"{tmp}/refsrc"; os.makedirs(refdir)
names = {"old-1-bi.tar.gz": f"{good}/node1/bi.tar.gz", "old-1-bank.tar.gz": f"{good}/node1/bank.tar.gz", "old-2-bank.tar.gz": f"{good}/node2/bank.tar.gz", "old-3-bank.tar.gz": f"{good}/node3/bank.tar.gz", "old-4-bank.tar.gz": f"{good}/node4/bank.tar.gz"}
for k, v in names.items(): os.symlink(v, f"{refdir}/{k}")
ref = f"{tmp}/ref.json"
open(ref, "w").write(subprocess.run([sys.executable, "-I", f"{here}/policy-docs.py", "ref", *[f"{refdir}/{k}" for k in names]], capture_output=True, text=True, check=True).stdout)
r = verdict(good, ref); check(r.returncode == 0 and "VERDICT: PASS" in r.stdout, f"a complete synthetic candidate must PASS: {r.stdout[-400:]} {r.stderr[-200:]}")
bad = f"{tmp}/missing"; build(bad, drop="bi/platform/sink/sink.rego")
r = verdict(bad, ref, ("--no-doors",)); check(r.returncode == 1 and "missing ['bi/platform/sink/sink.rego']" in r.stdout, f"a candidate without sink.rego must FAIL naming it: {r.stdout[-300:]}")
bad = f"{tmp}/flip"; build(bad, flip="bi/zeto/zeto.rego")
r = verdict(bad, ref, ("--no-doors",)); check(r.returncode == 1 and "different ['bi/zeto/zeto.rego']" in r.stdout, f"a changed byte must FAIL naming the file: {r.stdout[-300:]}")
bad = f"{tmp}/nodoc"; build(bad, nodoc=True)
r = verdict(bad, ref, ("--no-doors",)); check(r.returncode == 1 and "Kebijakan documents DIFFER" in r.stdout, f"a candidate without the documents must FAIL: {r.stdout[-300:]}")

# ---- --source: fe's SOURCE tars (relative names, tree of opa/bundles/<kind> + <kind>/config/data.json + .manifest)
sys.path.insert(0, here)
import source_tar
def build_src(d, mutate=None, nodoc=False):
    bi = json.load(open(os.path.join(opa, "bundles/bi/bi/config/data.json")))
    if not nodoc: bi["policy"] = policy; bi["platforms"] = list(policy)
    for n, name in ((1, "bank-bi"), (2, "bank-a"), (3, "bank-b"), (4, "bank-c")):
        os.makedirs(f"{d}/node{n}", exist_ok=True)
        for kind, data in (("bi", bi), ("bank", {"policy": {p: {"counterparties": cp[name]} for p in policy}})):
            files = source_tar.source_files(os.path.join(opa, "bundles", kind), json.dumps(data).encode(), "synthetic-rev")
            if kind == "bank": files = {k: v for k, v in files.items()}
            if mutate and n == 1: mutate(kind, files)
            open(f"{d}/node{n}/{kind}.tar.gz", "wb").write(source_tar.make_tar(files))
def src(d, extra=("--no-doors",)): return verdict(d, ref, ("--source", *extra))
goods = f"{tmp}/goods"; build_src(goods)
r = src(goods, ()); check(r.returncode == 0 and "VERDICT: PASS" in r.stdout, f"--source: a complete source candidate must PASS (with doors): {r.stdout[-500:]} {r.stderr[-200:]}")
def mut(f):
    def m(kind, files):
        if kind == "bi": f(files)
    return m
for label, fn, want in (
    ("missing .manifest", lambda f: f.pop(".manifest"), "missing"),
    ("wrong roots", lambda f: f.__setitem__(".manifest", b'{"revision":"x","roots":["bi"]}'), "roots"),
    ("no revision", lambda f: f.__setitem__(".manifest", b'{"roots":["gw","bi","system"]}'), "revision"),
    ("changed rego byte", lambda f: f.__setitem__("bi/zeto/zeto.rego", f["bi/zeto/zeto.rego"] + b"\n# x\n"), "different"),
    ("missing rego", lambda f: f.pop("bi/platform/sink/sink.rego"), "missing"),
    ("extra file", lambda f: f.__setitem__("bi/extra.txt", b"x"), "extra"),
    ("rooted name", lambda f: f.__setitem__("/bi/atom/atom.rego", f.pop("bi/atom/atom.rego")), "unsafe"),
    ("dotdot name", lambda f: f.__setitem__("bi/../x.rego", b"x"), "unsafe")):
    dd = f"{tmp}/src-{label.replace(' ', '-')}"; build_src(dd, mut(fn))
    r = src(dd); check(r.returncode == 1 and want in r.stdout, f"--source: {label} must FAIL mentioning {want!r}: {r.stdout[-300:]}")
dd = f"{tmp}/src-nodoc"; build_src(dd, nodoc=True)
r = src(dd); check(r.returncode == 1 and "Kebijakan documents DIFFER" in r.stdout, f"--source: no documents must FAIL: {r.stdout[-300:]}")
if fails:
    print("\n".join("FAIL " + f for f in fails), file=sys.stderr); sys.exit(1)
print("OK candidate-verdict: complete candidate passes; missing file / changed byte / missing documents fail")
