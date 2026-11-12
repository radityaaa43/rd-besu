#!/usr/bin/env python3
"""R17-zeto-other GATE (offline): no pod template that holds key material may be selected by an allow-all egress policy (`egress: [{}]`) of its own namespace.
Key material = a Secret volume, a secretKeyRef/secretRef env, a projected Secret, or a mounted ServiceAccount token (serviceAccountName set, automount not false).
Policies come from the party baselines (zeto/k8s/templates/party.yaml, stealth-address/k8s/templates/party.yaml); pods from the existing workload renders.
Usage: gate.py (run from anywhere). Exit 0 = gate holds; 1 = failures on stderr. Needs PyYAML + bash; no cluster.
Second rule: every key holder must be selected by at least one Egress policy (a pod no Egress policy selects has OPEN egress) - the narrow policies come from zeto/k8s/egress and
stealth-address/k8s/egress. Also proves the gate can fail: the PRE-R17 baselines (inlined below) must flag the known key holders, and every known holder must have been collected."""
import json, os, subprocess, sys, tempfile, yaml

HERE = os.path.dirname(os.path.abspath(__file__))
ZETO = os.path.abspath(os.path.join(HERE, "..", ".."))
STEALTH = os.path.abspath(os.path.join(ZETO, "..", "..", "stealth-address", "k8s"))
SHA = "0" * 64
IMG = f"registry.example/img@sha256:{SHA}"
fails, tmp = [], tempfile.mkdtemp()
sn = os.path.join(tmp, "static-nodes.json")
json.dump(["enode://" + "a" * 128 + "@203.0.113.1:30303?discport=0"], open(sn, "w"))
chain = os.path.join(tmp, "chain.env")
open(chain, "w").write("".join(f"{k}={v}\n" for k, v in {"CHAIN_ID": "1337", "RD": "0x" + "1" * 40, "BOND": "0x" + "2" * 40, "ANNOUNCER": "0x" + "3" * 40, "VALIDATOR": "0x" + "4" * 40, "DVP_FACTORY": "0x" + "5" * 40, "FROM_BLOCK": "1"}.items()))
CERT = "https://st-gw-1.rd-stealth-bi.svc.cluster.local:8550"


def docs(*cmd):
    r = subprocess.run(["bash", *cmd], capture_output=True, text=True)
    if r.returncode != 0:
        fails.append(f"{' '.join(os.path.relpath(c) if os.path.exists(c) else c for c in cmd)[:120]} exited {r.returncode}: {r.stderr.strip()[:160]}")
        return []
    return [d for d in yaml.safe_load_all(r.stdout) if d]


def templates(ds):
    """(kind/name, namespace, pod template) for every workload doc."""
    for d in ds:
        k, name, ns = d["kind"], d["metadata"]["name"], d["metadata"].get("namespace")
        if k in ("Deployment", "StatefulSet", "DaemonSet", "Job"):
            yield f"{k}/{name}", ns, d["spec"]["template"]
        elif k == "CronJob":
            yield f"{k}/{name}", ns, d["spec"]["jobTemplate"]["spec"]["template"]
        elif k == "Pod":
            yield f"{k}/{name}", ns, d


def key_material(t):
    """Why this pod template holds key material ('' = it does not)."""
    spec = t["spec"]
    for v in spec.get("volumes", []):
        if "secret" in v or any("secret" in s for s in v.get("projected", {}).get("sources", [])):
            return f"Secret volume {v['name']}"
    for c in spec.get("containers", []) + spec.get("initContainers", []):
        if any("secretKeyRef" in e.get("valueFrom", {}) for e in c.get("env", [])) or any("secretRef" in e for e in c.get("envFrom", [])):
            return f"Secret env of {c['name']}"
    if spec.get("serviceAccountName") and spec.get("automountServiceAccountToken") is not False:
        return f"ServiceAccount token ({spec['serviceAccountName']})"
    return ""


def sel(s, lab):
    if s is None:
        return True
    if any(lab.get(k) != v for k, v in s.get("matchLabels", {}).items()):
        return False
    for e in s.get("matchExpressions", []):
        k, op, vals = e["key"], e["operator"], e.get("values", [])
        has = k in lab
        if (op == "In" and not (has and lab[k] in vals)) or (op == "NotIn" and has and lab[k] in vals) or (op == "Exists" and not has) or (op == "DoesNotExist" and has):
            return False
    return True


def allow_all(p):
    return p["kind"] == "NetworkPolicy" and "Egress" in p["spec"].get("policyTypes", []) and p["spec"].get("egress") == [{}]


def union_of(policies, ns, lab):
    return [p["metadata"]["name"] for p in policies if p["kind"] == "NetworkPolicy" and "Egress" in p["spec"].get("policyTypes", []) and p["metadata"]["namespace"] == ns and sel(p["spec"].get("podSelector"), lab)]


def gate(holders, policies):
    """holders: [(tag, ns, labels, why)]; policies: NetworkPolicy docs. Returns the 'tag: selected by <policy>' offences."""
    out = []
    for tag, ns, lab, why in holders:
        for p in policies:
            if allow_all(p) and p["metadata"]["namespace"] == ns and sel(p["spec"].get("podSelector"), lab):
                out.append(f"{tag} in {ns} ({why}) labels {lab} is selected by {p['metadata']['name']} (egress [{{}}]) = OPEN egress")
    return out


# PRE-R17 baselines (main a4dc20a), the RED fixture: what the gate must catch.
OLD_ZETO = {"matchExpressions": [{"key": "app", "operator": "NotIn", "values": ["paladin"]}, {"key": "rd/egress-locked", "operator": "DoesNotExist"}]}
OLD_STEALTH = {"matchExpressions": [{"key": "rd/egress-locked", "operator": "DoesNotExist"}]}


def old(ns, s):
    return {"kind": "NetworkPolicy", "metadata": {"name": "allow-dns-egress", "namespace": ns}, "spec": {"podSelector": s, "policyTypes": ["Egress"], "egress": [{}]}}


holders, pols, narrow = [], [], []  # pols: the CURRENT baselines; narrow: the per-workload policies
EXEMPT = {  # one-off key readers that are not R17 workloads; named here so the exemption is visible, never silent
    "Job/besu-nodeinfo": "one-off Job (ttl 1 h) printing the PUBLIC node key from Secret besu-nodekey; no pod runs it normally",
}
exempt_seen = []


def add(ds, ns=None):
    for tag, wns, t in templates(ds):
        why = key_material(t)
        if why:
            lab = t["metadata"].get("labels", {})
            if tag in EXEMPT:
                exempt_seen.append(f"{tag} in {wns}: {EXEMPT[tag]}")
            else:
                holders.append((tag, wns, lab, why))


for p in ("bi", "bank-a", "bank-b", "bank-c"):
    c2 = ["--cluster", "2"] if p == "bank-c" else []
    z = docs(f"{ZETO}/render.sh", *c2, p)
    s = docs(f"{STEALTH}/render.sh", *c2, p)
    pols += [d for d in z + s if d["kind"] == "NetworkPolicy"]
    sc = ["--storage-class", "sc"] if p == "bank-c" else []
    add(docs(f"{ZETO}/gateway/render.sh", p))
    add(docs(f"{ZETO}/bundle-server/render.sh", p, "--sink-image", IMG, *(["--storage-class", "sc"] if p == "bank-c" else [])))
    add(docs(f"{ZETO}/besu/render.sh", "node", p, "--p2p-host", "203.0.113.1", "--static-nodes", sn))
    add(docs(f"{ZETO}/besu/render.sh", "nodeinfo", p))
    add(docs(f"{ZETO}/paladin/render.sh", p))
    add(docs(f"{ZETO}/postgres/render.sh", *(["--cluster", "2", "bank-c", *sc] if p == "bank-c" else [p])))
    add(docs(f"{STEALTH}/rpc/render.sh", *c2, "node", p, "--static-nodes", sn))
    add(docs(f"{STEALTH}/gateway/render.sh", p))
    add(docs(f"{STEALTH}/signer/render.sh", p, "--image", IMG, "--chain-env", chain, "--cert-url", CERT))
ZE, SE = f"{ZETO}/egress/render.sh", f"{STEALTH}/egress/render.sh"
for p in ("bi", "bank-a", "bank-b", "bank-c"):
    lb = ["--other-cluster-lb", "203.0.113.31", "--other-cluster-lb", "203.0.113.32", "--other-cluster-lb", "203.0.113.33"] if p == "bank-c" else ["--other-cluster-lb", "203.0.113.30"]
    for w, a in (("bank-gw", []), ("bundle-server", []), ("paladin-pg", []), ("paladin-operator", ["--kube-api-ip", "198.51.100.11"]), ("besu-validator", lb)):
        narrow += docs(ZE, "workload", w, p, *a)
    narrow += docs(SE, "besu-rpc", p)
    narrow += docs(SE, "signer", p, *(["--cert-lb-ip", "203.0.113.9"] if p == "bank-c" else []))
    narrow += docs(SE, "gateway", p)
for w in ("custodian", "compare"):
    narrow += docs(SE, w, "bi")
add(docs(f"{STEALTH}/signer/render.sh", "custodian", "--image", IMG, "--chain-env", chain, "--bank-signers", "CN=a"))
add(docs(f"{STEALTH}/signer/render.sh", "compare", "--image", IMG, "--chain-env", chain, "--registry", "0x" + "6" * 40))

# collection completeness: the key holders the orchestrator named must have been found (else the gate would pass by looking at nothing)
want = {("Deployment/bank-gw-1", "rd-zeto-bi"), ("Deployment/bank-gw-4", "rd-zeto-bank-c"), ("Deployment/bundle-server", "rd-zeto-bank-a"), ("StatefulSet/besu-validator", "rd-zeto-bank-b"),
        ("Deployment/paladin-operator", "rd-zeto-bi"), ("StatefulSet/paladin-pg", "rd-zeto-bank-c"), ("StatefulSet/besu-rpc", "rd-stealth-bank-c"), ("StatefulSet/besu-rpc", "rd-stealth-bi"),
        ("Deployment/stealth-signer", "rd-stealth-bank-a"), ("Deployment/st-gw-1", "rd-stealth-bi")}
got = {(t, n) for t, n, _, _ in holders}
for w in sorted(want - got):
    fails.append(f"gate collected no key holder {w[0]} in {w[1]} (renders changed? the gate would pass by looking at nothing)")
# RED fixture: against the PRE-R17 baselines the gate must flag the zeto and stealth holders that R17 lists
old_pols = [old(f"rd-zeto-{p}", OLD_ZETO) for p in ("bi", "bank-a", "bank-b", "bank-c")] + [old(f"rd-stealth-{p}", OLD_STEALTH) for p in ("bi", "bank-a", "bank-b", "bank-c")]
red = gate(holders, old_pols)
flagged = {o.split(" in ")[0] for o in red}
for must in ("Deployment/bank-gw-1", "Deployment/bundle-server", "StatefulSet/besu-validator", "Deployment/paladin-operator", "StatefulSet/paladin-pg", "StatefulSet/besu-rpc"):
    if must not in flagged:
        fails.append(f"RED fixture: the PRE-R17 baselines must flag {must}, the gate did not")
if "--show-old" in sys.argv:
    print("PRE-R17 baselines flag:\n  " + "\n  ".join(sorted(red)))
# the real gate
for o in gate(holders, pols):
    fails.append("GATE " + o)
for tag, ns, lab, why in holders:  # no Egress policy at all = open egress
    if not union_of(pols + narrow, ns, lab):
        fails.append(f"COVER {tag} in {ns} ({why}) labels {lab} is selected by NO egress policy = OPEN egress")

for e in exempt_seen[:1]:
    print("EXEMPT " + e)
if fails:
    print("\n".join("FAIL " + f for f in fails), file=sys.stderr)
    sys.exit(1)
print(f"OK gate: {len(holders)} key-holding pod templates, none selected by an egress [{{}}] policy of its namespace, each selected by its narrow policy; PRE-R17 baselines flag {len(red)} of them (RED fixture)")
