#!/usr/bin/env python3 -I
"""Offline test: every container image in the renders / manifests of zeto, stealth-address and opa/k8s is pinned BY DIGEST (name[:tag]@sha256:<64 hex>).
Rule (orchestrator 2026-11-12): pods pin by digest, a mutable upstream tag is not a version. A reference that is a shell/template variable ($IMAGE, ${image}) is
validated where it is passed (render.sh --image checks the digest). Throwaway probe images and images not deployed yet are listed in ALLOW with the reason.
Usage: test-image-pins.py <repo root>"""
import os, re, sys
root = sys.argv[1]
DIRS = ["zeto/k8s", "stealth-address/k8s", "opa/k8s"]
ALLOW = {  # reference -> reason
    "python:3.12-alpine": "throwaway S1 probes (zeto/k8s/probe) and the legacy sink of the old stack (opa/k8s/bundle-server.yaml); deleted by label / with the old namespace",
    "hashicorp/vault:2.0.4": "stealth Vault is not deployed yet; the digest is pinned at its first apply (stealth PLAN S9)",
}
SKIP_PARTS = ("/test/", "node_modules", "/docs/", "__pycache__")
img_line = re.compile(r"^\s*(?:-\s*)?(?:image:|(?:IMAGE|image)=)\s*[\"']?([^\s\"']+)", re.I)
pinned = re.compile(r"@sha256:[0-9a-f]{64}$")
fails = []; seen = 0
for d in DIRS:
    for dp, dn, fn in os.walk(os.path.join(root, d)):
        dn[:] = [x for x in dn if x not in ("node_modules", "__pycache__", "test")]
        for f in fn:
            if not f.endswith((".sh", ".yaml", ".yml")) or f.startswith("test"): continue
            path = os.path.join(dp, f)
            if any(p in path for p in SKIP_PARTS): continue
            for i, line in enumerate(open(path, errors="ignore"), 1):
                m = img_line.match(line)
                if not m: continue
                ref = m.group(1).rstrip(",")
                if ref.startswith(("$", "{{", "REF", "<")) or ref in ("null",): continue
                seen += 1
                if pinned.search(ref) or ref in ALLOW: continue
                fails.append(f"{os.path.relpath(path, root)}:{i}: image '{ref}' is not pinned by digest (name[:tag]@sha256:<64 hex>)")
if seen < 15: fails.append(f"scan found only {seen} image references: the scan is broken")
if fails:
    print("\n".join("FAIL " + f for f in fails), file=sys.stderr); sys.exit(1)
print(f"OK image pins: {seen} image references, all by digest or allow-listed ({len(ALLOW)})")
