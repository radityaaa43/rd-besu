#!/usr/bin/env python3 -I
"""Kebijakan document tooling for bundle publishes (analyst ruling 2026-11-12, option B-interim / R18). Python stdlib + the openssl CLI only; never touches a private key.
  policy-docs.py verify BUNDLE --pub KEY.pub     RS256 signature of /.signatures.json against the PUBLIC key, and every signed file hash against the member bytes
  policy-docs.py docs BUNDLE                     sha256 of each document (canonical JSON: sorted keys, compact) as JSON
  policy-docs.py ref BUNDLE...                   the same for several bundles, keyed by kind (bi, bank-<n>), to commit as a reference (hashes only)
  policy-docs.py diff CANDIDATE REFERENCE.json   candidate docs vs the reference: exit 0 only when every document hash is equal
Documents: BI bundle = data.bi.config.policy (whole, and per platform) and data.bi.config.platforms; bank bundle = data.bank.config.policy (whole, and per platform).
A candidate that carries NO document (the S17 bundle had none) fails `diff` with "missing"."""
import base64, hashlib, json, subprocess, sys, tarfile, tempfile, os

def canon(o): return json.dumps(o, sort_keys=True, separators=(",", ":")).encode()
def sha(b): return hashlib.sha256(b).hexdigest()
def b64d(x): return base64.urlsafe_b64decode(x + "=" * (-len(x) % 4))

def members(path):
    with tarfile.open(path) as t:
        return {m.name: t.extractfile(m).read() for m in t.getmembers() if m.isfile()}

def verify(path, pub):
    mem = members(path)
    sigs = json.loads(mem["/.signatures.json"])
    ok_any = False
    for tok in sigs["signatures"]:
        h, p, s = tok.split(".")
        hdr, pay = json.loads(b64d(h)), json.loads(b64d(p))
        if hdr.get("alg") != "RS256": raise SystemExit(f"FAIL: unsupported alg {hdr.get('alg')}")
        with tempfile.TemporaryDirectory() as d:
            open(f"{d}/m", "wb").write(f"{h}.{p}".encode()); open(f"{d}/s", "wb").write(b64d(s))
            r = subprocess.run(["openssl", "dgst", "-sha256", "-verify", pub, "-signature", f"{d}/s", f"{d}/m"], capture_output=True, text=True)
        if r.returncode: raise SystemExit(f"FAIL: signature does not verify with {pub}: {r.stdout.strip()[:60]}{r.stderr.strip()[:60]}")
        for f in pay["files"]:
            name = f["name"]
            cand = [k for k in mem if k == name or k == "/" + name.lstrip("/") or k.endswith("/" + name.lstrip("/"))]
            if len(cand) != 1: raise SystemExit(f"FAIL: signed file {name} not found exactly once in the bundle")
            data = mem[cand[0]]
            hashes = {sha(data)}
            if cand[0].endswith((".json", ".manifest")):          # OPA hashes JSON members as canonical JSON (sorted keys, compact)
                try: hashes.add(sha(canon(json.loads(data))))
                except ValueError: pass
            if f["hash"] not in hashes: raise SystemExit(f"FAIL: file hash mismatch for {name}")
        unsigned = [k for k in mem if not k.startswith("/.") and not any(k == "/" + f["name"].lstrip("/") or k.endswith("/" + f["name"].lstrip("/")) for f in pay["files"])]
        if unsigned: raise SystemExit(f"FAIL: members not covered by the signature: {unsigned[:3]}")
        ok_any = True
        manifest = json.loads(mem.get("/.manifest", b"{}") or b"{}")
        print(f"OK signature kid={hdr.get('kid')} keyid={pay.get('keyid')} files={len(pay['files'])} revision={manifest.get('revision')}")
    if not ok_any: raise SystemExit("FAIL: no signature")

def docs(path):
    d = json.loads(members(path)["/data.json"])
    out = {}
    if "bi" in d:
        cfg = d["bi"]["config"]; kind = "bi"
        if "policy" in cfg:
            out["policy"] = sha(canon(cfg["policy"]))
            for k, v in sorted(cfg["policy"].items()): out[f"policy.{k}"] = sha(canon(v))
        if "platforms" in cfg: out["platforms"] = sha(canon(cfg["platforms"]))
    elif "bank" in d:
        cfg = d["bank"]["config"]; kind = "bank"
        if "policy" in cfg:
            out["policy"] = sha(canon(cfg["policy"]))
            for k, v in sorted(cfg["policy"].items()): out[f"policy.{k}"] = sha(canon(v))
    else: raise SystemExit("FAIL: data.json has neither bi nor bank")
    return kind, out

def main(a):
    if a[:1] == ["verify"] and len(a) == 4 and a[2] == "--pub": verify(a[1], a[3])
    elif a[:1] == ["docs"] and len(a) == 2: print(json.dumps(docs(a[1])[1], indent=1, sort_keys=True))
    elif a[:1] == ["ref"] and len(a) >= 2:
        ref = {}
        for p in a[1:]:
            kind, d = docs(p); ref[os.path.basename(p)] = {"kind": kind, "docs": d}
        print(json.dumps(ref, indent=1, sort_keys=True))
    elif a[:1] == ["diff"] and len(a) == 3:
        _, cand = docs(a[1]); ref = json.load(open(a[2]))
        bad = 0
        # the reference may hold several bundles; the candidate is compared with the entry whose key is its --as name or, if only one matches its kind, that one
        kind, _ = docs(a[1])
        matches = [e for e in ref.values() if e["kind"] == kind]
        entry = os.environ.get("POLICY_DOCS_AS")
        sel = ref[entry]["docs"] if entry else (matches[0]["docs"] if len(matches) == 1 else None)
        if sel is None: raise SystemExit("FAIL: several reference entries of this kind: set POLICY_DOCS_AS=<entry name>")
        for k in sorted(set(sel) | set(cand)):
            r, c = sel.get(k), cand.get(k)
            state = "equal" if r == c else ("missing" if c is None else ("unexpected" if r is None else "DIFFERENT"))
            print(f"{k}: {state}" + ("" if state == "equal" else f" (reference {str(r)[:12]}, candidate {str(c)[:12]})"))
            bad += state != "equal"
        sys.exit(1 if bad else 0)
    else: raise SystemExit(__doc__)

if __name__ == "__main__": main(sys.argv[1:])
