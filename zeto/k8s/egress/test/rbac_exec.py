#!/usr/bin/env python3
"""Repo-wide RBAC exec rule (offline): no Role/ClusterRole bound to a ServiceAccount may grant pods/exec, pods/attach, pods/portforward, pods/* or * (any verbs).
Automation sessions mint ServiceAccount tokens, so a session must never be able to exec into a key holder; exec belongs to a human User/Group only (stealth vault/render.sh operator-exec).
Scans every Role/ClusterRole and its bindings in the output of the render scripts below (usual arguments), and fails if a checked-in file that defines one is not covered.
A Role bound ONLY to User/Group subjects is allowed; an exec-capable Role with no binding in the output is flagged too (cannot prove who gets it).
Usage: rbac_exec.py (run from anywhere). Exit 0 = holds; 1 = failures on stderr. Needs PyYAML + bash; no cluster."""
import os, re, subprocess, sys, yaml

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
ZETO, STEALTH = f"{ROOT}/zeto/k8s", f"{ROOT}/stealth-address/k8s"
IMG = "postgres@sha256:" + "0" * 64
# every file that defines a Role/ClusterRole/binding; a new one must be added here AND rendered below
SOURCES = {
    "stealth-address/k8s/keygen/render.sh", "stealth-address/k8s/rbac/render.sh", "stealth-address/k8s/templates/party.yaml", "stealth-address/k8s/vault/templates/auth-delegator.yaml",
    "stealth-address/k8s/vault/templates/operator-exec.yaml", "zeto/k8s/paladin/templates/paladin.yaml", "zeto/k8s/postgres/rotate/render.sh",
    "zeto/k8s/templates/lensa-publisher.yaml", "zeto/k8s/templates/party.yaml",
}
# built-in ClusterRoles that grant exec (they are not rendered here)
BUILTIN_EXEC = {"cluster-admin", "admin", "edit"}
SUBRES = {"exec", "attach", "portforward", "*"}


def grants_exec(rules):
    return sorted({x for r in rules for x in r.get("resources", []) if x == "*" or (x.split("/")[0] in ("pods", "*") and x.split("/")[-1] in SUBRES and "/" in x)})


def scan(ds):
    """-> (violations, names of scanned Roles/ClusterRoles)"""
    roles = {(d["kind"], d["metadata"].get("namespace", ""), d["metadata"]["name"]): d for d in ds if d["kind"] in ("Role", "ClusterRole")}
    subj = {}  # role key -> subjects of every binding that points at it
    for d in ds:
        if d["kind"] not in ("RoleBinding", "ClusterRoleBinding"):
            continue
        ref = d["roleRef"]
        ns = d["metadata"].get("namespace", "") if ref["kind"] == "Role" else ""
        subj.setdefault((ref["kind"], ns, ref["name"]), []).extend(d.get("subjects") or [])
    bad = []
    for (kind, ns, name), d in roles.items():
        g = grants_exec(d.get("rules", []))
        sa = [s for s in subj.get((kind, ns, name), []) if s["kind"] == "ServiceAccount"]
        if g and (sa or (kind, ns, name) not in subj):
            bad.append(f"{kind} {ns}/{name} grants {g} " + (f"and is bound to ServiceAccount {[s['name'] for s in sa]}" if sa else "with no binding in the output"))
    for (kind, ns, ref), ss in subj.items():
        if ref in BUILTIN_EXEC and any(s["kind"] == "ServiceAccount" for s in ss):
            bad.append(f"built-in {kind} {ref} (grants exec) is bound to a ServiceAccount")
    return bad, sorted({k[2] for k in roles})


def role(name, resources):
    return {"kind": "Role", "metadata": {"name": name, "namespace": "ns"}, "rules": [{"apiGroups": [""], "resources": resources, "verbs": ["get"]}]}


def binding(name, kind, ref="Role"):
    return {"kind": "RoleBinding", "metadata": {"name": name, "namespace": "ns"}, "roleRef": {"kind": ref, "name": name}, "subjects": [{"kind": kind, "name": "x"}]}


fails = []
# built-in fixture: the scanner must catch the SA-bound cases and pass the User/Group-bound exec Role
for res in (["pods/exec"], ["pods/attach"], ["pods/portforward"], ["pods/*"], ["*"], ["pods", "pods/log", "pods/exec"]):
    if not scan([role("r", res), binding("r", "ServiceAccount")])[0]:
        fails.append(f"fixture: SA-bound Role with {res} must be flagged")
if not scan([role("r", ["pods/exec"]), binding("r", "User"), {**binding("r", "Group"), "metadata": {"name": "g", "namespace": "ns"}}])[0] == []:
    fails.append("fixture: User/Group-bound exec Role must pass")
mixed = binding("r", "User"); mixed["subjects"].append({"kind": "ServiceAccount", "name": "s"})
if not scan([role("r", ["pods/exec"]), mixed])[0]:
    fails.append("fixture: Role bound to a User AND a ServiceAccount must be flagged")
if not scan([role("r", ["pods/exec"])])[0]:
    fails.append("fixture: exec Role with no binding must be flagged")
if scan([role("r", ["pods", "pods/log", "secrets"]), binding("r", "ServiceAccount")])[0]:
    fails.append("fixture: SA-bound Role without exec/attach/portforward must pass")
if not scan([binding("edit", "ServiceAccount", "ClusterRole")])[0]:
    fails.append("fixture: SA bound to built-in ClusterRole edit must be flagged")

# repo output
RUNS = []
for p in ("bi", "bank-a", "bank-b"):
    RUNS += [[f"{STEALTH}/render.sh", p], [f"{ZETO}/render.sh", p]]
RUNS += [[f"{STEALTH}/render.sh", "--cluster", "2", "bank-c"], [f"{ZETO}/render.sh", "--cluster", "2", "bank-c"], [f"{STEALTH}/rbac/render.sh", "viewcopies"],
         [f"{STEALTH}/vault/render.sh", "cluster", "all"], [f"{STEALTH}/vault/render.sh", "cluster", "bank-c"]]
RUNS += [[f"{STEALTH}/keygen/render.sh", w, "--image", "ghcr.io/x/y@sha256:" + "a" * 64, "--kube-api-ip", "203.0.113.1"] for w in ("cert", "bi")]
for p in ("bi", "bank-a", "bank-b", "bank-c"):
    RUNS += [[f"{ZETO}/paladin/render.sh", p], [f"{ZETO}/postgres/rotate/render.sh", p, "--image", IMG, "--api-ips", "203.0.113.1"]]
    for k in ("User", "Group"):
        RUNS.append([f"{STEALTH}/vault/render.sh", "operator-exec", p, "--subject-kind", k, "--subject-name", "operator-x"])
ds = []
for cmd in RUNS:
    r = subprocess.run(["bash", *cmd], capture_output=True, text=True)
    if r.returncode != 0:
        fails.append(f"{os.path.relpath(cmd[0], ROOT)} {' '.join(cmd[1:3])} exited {r.returncode}: {r.stderr.strip()[:160]}")
    else:
        ds += [d for d in yaml.safe_load_all(r.stdout) if d]
bad, names = scan(ds)
fails += bad

# completeness: every checked-in file that defines a Role/ClusterRole/binding must be known (and so rendered above)
found = set()
for dp, dn, fn in os.walk(ROOT):
    dn[:] = [d for d in dn if d not in (".git", "node_modules", "test", "docs")]
    for f in fn:
        if f.endswith((".yaml", ".yml", ".sh", ".tpl")) and re.search(r"kind: *\"?(Cluster)?Role(Binding)?\b", open(os.path.join(dp, f), errors="replace").read()):
            found.add(os.path.relpath(os.path.join(dp, f), ROOT))
for f in sorted(found - SOURCES):
    fails.append(f"{f} defines a Role/ClusterRole/binding but is not in SOURCES of rbac_exec.py (add it and render it)")
for f in sorted(SOURCES - found):
    fails.append(f"{f} is in SOURCES of rbac_exec.py but defines no Role/ClusterRole/binding any more")

print(f"scanned {sum(1 for d in ds if d['kind'] in ('Role', 'ClusterRole'))} Role/ClusterRole objects from {len(RUNS)} renders, {len(names)} distinct names: {', '.join(names)}")
if fails:
    print("\n".join("FAIL " + f for f in fails), file=sys.stderr)
    sys.exit(1)
print("OK no ServiceAccount-bound Role/ClusterRole grants pods/exec, pods/attach, pods/portforward, pods/* or *")
