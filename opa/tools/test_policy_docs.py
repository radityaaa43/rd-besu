#!/usr/bin/env python3 -I
"""Offline test of policy-docs.py with synthetic bundles in OPA's signed format (RS256 JWT over canonical file hashes). Needs python3 + openssl."""
import base64, hashlib, io, json, os, subprocess, sys, tarfile, tempfile
here = os.path.dirname(os.path.abspath(__file__)); tool = os.path.join(here, "policy-docs.py")
tmp = tempfile.mkdtemp(); fails = []
def check(ok, msg):
    if not ok: fails.append(msg)
def sh(*a, **k): return subprocess.run(a, capture_output=True, text=True, **k)
def key(name):
    sh("openssl", "genrsa", "-out", f"{tmp}/{name}.pem", "2048"); sh("openssl", "rsa", "-in", f"{tmp}/{name}.pem", "-pubout", "-out", f"{tmp}/{name}.pub")
key("bi"); key("other")
b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
canon = lambda o: json.dumps(o, sort_keys=True, separators=(",", ":")).encode()
def bundle(name, data, signer="bi", tamper=False):
    rego = b"package x\nallow := true\n"
    files = {"/data.json": canon(data), "/src/x.rego": rego, "/.manifest": canon({"revision": "t.1", "roots": ["x"]})}
    signed = [{"name": "data.json", "hash": hashlib.sha256(files["/data.json"]).hexdigest(), "algorithm": "SHA-256"},
              {"name": "src/x.rego", "hash": hashlib.sha256(rego).hexdigest(), "algorithm": "SHA-256"},
              {"name": ".manifest", "hash": hashlib.sha256(canon({"revision": "t.1", "roots": ["x"]})).hexdigest(), "algorithm": "SHA-256"}]
    h = b64(json.dumps({"alg": "RS256", "kid": signer, "typ": "JWT"}).encode()); p = b64(json.dumps({"files": signed, "keyid": signer}).encode())
    open(f"{tmp}/m", "w").write(f"{h}.{p}")
    sig = subprocess.run(["openssl", "dgst", "-sha256", "-sign", f"{tmp}/{signer}.pem", f"{tmp}/m"], capture_output=True).stdout
    files["/.signatures.json"] = json.dumps({"signatures": [f"{h}.{p}.{b64(sig)}"]}).encode()
    if tamper: files["/data.json"] = canon({**data, "tampered": 1})
    path = f"{tmp}/{name}.tar.gz"
    with tarfile.open(path, "w:gz") as t:
        for n, b in files.items():
            ti = tarfile.TarInfo(n); ti.size = len(b); t.addfile(ti, io.BytesIO(b))
    return path
def run(*a, env=None): return subprocess.run([sys.executable, "-I", tool, *a], capture_output=True, text=True, env=env)

doc = {"bi": {"config": {"policy": {"zeto": {"hours": {"RD": {"open": "00:00", "close": "24:00"}}, "max_per_tx": {"RD": 2000000000}}, "noto": {"x": 1}}, "platforms": ["zeto", "noto"]}}}
good = bundle("good", doc)
r = run("verify", good, "--pub", f"{tmp}/bi.pub"); check(r.returncode == 0 and "OK signature kid=bi" in r.stdout, f"verify good: {r.stdout}{r.stderr}")
r = run("verify", good, "--pub", f"{tmp}/other.pub"); check(r.returncode != 0 and "FAIL" in (r.stdout + r.stderr), "verify with the wrong public key must fail")
r = run("verify", bundle("tampered", doc, tamper=True), "--pub", f"{tmp}/bi.pub"); check(r.returncode != 0 and "hash mismatch" in (r.stdout + r.stderr), "a data.json changed after signing must fail")
check(run("verify", good).returncode != 0, "verify without --pub must fail")

d1 = json.loads(run("docs", good).stdout); d2 = json.loads(run("docs", bundle("good2", doc)).stdout)
check(d1 == d2 and set(d1) == {"policy", "policy.zeto", "policy.noto", "platforms"} and all(len(v) == 64 for v in d1.values()), f"docs hashes stable and complete: {d1}")
ref = f"{tmp}/ref.json"; open(ref, "w").write(run("ref", good).stdout)
r = run("diff", good, ref); check(r.returncode == 0 and "DIFFERENT" not in r.stdout and "missing" not in r.stdout, f"diff equal: {r.stdout}")
changed = json.loads(json.dumps(doc)); changed["bi"]["config"]["policy"]["zeto"]["max_per_tx"]["RD"] = 2000000001
r = run("diff", bundle("changed", changed), ref); check(r.returncode == 1 and "policy.zeto: DIFFERENT" in r.stdout and "policy.noto: equal" in r.stdout, f"diff must name the changed document: {r.stdout}")
nodoc = {"bi": {"config": {"nodes": {}}}}
r = run("diff", bundle("nodoc", nodoc), ref); check(r.returncode == 1 and "policy: missing" in r.stdout and "platforms: missing" in r.stdout, f"a candidate WITHOUT the documents (the S17 bundle) must fail with missing: {r.stdout}")

live = json.load(open(os.path.join(here, "live-docs-2026-11-12.json")))
check(sorted(live) == ["old-1-bank.tar.gz", "old-1-bi.tar.gz", "old-2-bank.tar.gz", "old-3-bank.tar.gz", "old-4-bank.tar.gz"], "reference holds the 5 old live bundles")
check(all(len(h) == 64 for e in live.values() for h in e["docs"].values()) and all(e["kind"] in ("bi", "bank") for e in live.values()), "reference holds sha256 only")
check("policy" in live["old-1-bi.tar.gz"]["docs"] and "platforms" in live["old-1-bi.tar.gz"]["docs"], "reference BI entry has policy and platforms")
if fails:
    print("\n".join("FAIL " + f for f in fails), file=sys.stderr); sys.exit(1)
print("OK policy-docs: verify (good / wrong key / tampered), docs hashes, diff (equal / changed / missing), reference file")
