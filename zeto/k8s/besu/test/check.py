#!/usr/bin/env python3
"""Offline check of zeto S3/S4 Besu node manifests (final-design/zeto/PLAN.md S3, S4). No cluster. Needs PyYAML.
Usage: check.py <besu dir>"""
import json, os, subprocess, sys, tempfile, yaml

base = sys.argv[1]
render = os.path.join(base, "render.sh")
static = os.path.join(base, "static-nodes.sh")
fx = os.path.join(base, "test", "fixtures")
fails = []

def check(ok, msg):
    if not ok:
        fails.append(msg)

def run(script, *args, **kw):
    try:
        return subprocess.run([script, *args], capture_output=True, text=True, **kw)
    except FileNotFoundError as e:
        fails.append(f"missing: {e}")
        return subprocess.CompletedProcess(args, 127, "", str(e))

def docs(*args):
    r = run(render, *args)
    if r.returncode != 0:
        fails.append(f"render.sh {' '.join(args)} exited {r.returncode}: {r.stderr.strip()[:200]}")
        return []
    return [d for d in yaml.safe_load_all(r.stdout) if d]

def of(ds, kind):
    return [d for d in ds if d["kind"] == kind]

ENODE_A = "enode://" + "a" * 128 + "@10.1.2.3:30303?discport=0"
ENODE_B = "enode://" + "b" * 128 + "@47.1.2.3:30303?discport=0"
tmp = tempfile.mkdtemp()
sn = os.path.join(tmp, "static-nodes.json")
json.dump([ENODE_A, ENODE_B], open(sn, "w"))

# ---- static-nodes.sh: IPs only, live format ----
out = run(static, "--peer", ENODE_A, "--peer", ENODE_B)
check(out.returncode == 0 and json.loads(out.stdout or "null") == [ENODE_A, ENODE_B], f"static-nodes.sh --peer must echo a JSON list of the enodes: {out.stdout[:100]} {out.stderr[:100]}")
bad = run(static, "--peer", "enode://" + "c" * 128 + "@besu-node-validator-1-0.besu.svc:30303")
check(bad.returncode != 0, "static-nodes.sh must refuse a DNS name in an enode (Xdns is early access)")
conv = run(static, "--old-peers", os.path.join(fx, "old-peers.json"), "--pod-ips", os.path.join(fx, "old-pod-ips.txt"))
got = json.loads(conv.stdout or "[]")
check(len(got) == 2 and got[0].endswith("@10.20.0.11:30303?discport=0") and got[1].endswith("@10.20.0.12:30303?discport=0"), f"static-nodes.sh must replace the old DNS hosts by the pod IPs: {got}")
check(got and got[0].startswith("enode://aaaa") and got[1].startswith("enode://bbbb"), "static-nodes.sh must keep the node ids")
miss = run(static, "--old-peers", os.path.join(fx, "old-peers.json"), "--pod-ips", os.path.join(fx, "old-pod-ips-missing.txt"))
check(miss.returncode != 0, "static-nodes.sh must fail when a pod IP is missing")

# ---- config template: exactly two lines differ from the live snapshot ----
live = open(os.path.join(fx, "live-config.toml")).read().splitlines()
tpl = open(os.path.join(base, "templates", "config.toml")).read().splitlines() if os.path.exists(os.path.join(base, "templates", "config.toml")) else []
diff = [(a, b) for a, b in zip(live, tpl) if a != b]
check(len(live) == len(tpl) and diff == [("discovery-enabled=true", "discovery-enabled=false"), ('p2p-host="0.0.0.0"', 'p2p-host="${P2P_HOST}"')], f"config template must equal the live config except discovery-enabled=false and p2p-host: {diff}")

PARTIES = {"bi": "rd-zeto-bi", "bank-a": "rd-zeto-bank-a", "bank-b": "rd-zeto-bank-b", "bank-c": "rd-zeto-bank-c"}
for party, ns in PARTIES.items():
    # stage net: LoadBalancer first, so the IP exists before the node is configured
    net = docs("net", party)
    svc = {d["metadata"]["name"]: d for d in of(net, "Service")}
    check(set(svc) == {"besu-p2p", "besu-validator", "besu-rpc"}, f"{party} net: Services {sorted(svc)}")
    if "besu-p2p" in svc:
        s = svc["besu-p2p"]["spec"]
        check(s["type"] == "LoadBalancer" and [(p["port"], p["protocol"]) for p in s["ports"]] == [(30303, "TCP")], f"{party}: besu-p2p must be LoadBalancer TCP 30303 only (no UDP): {s['ports']}")
    if "besu-validator" in svc:
        check(svc["besu-validator"]["spec"].get("clusterIP") == "None", f"{party}: besu-validator must be headless")
    if "besu-rpc" in svc:
        check(svc["besu-rpc"]["spec"].get("type", "ClusterIP") == "ClusterIP" and {p["port"] for p in svc["besu-rpc"]["spec"]["ports"]} == {8545, 8546}, f"{party}: besu-rpc ClusterIP 8545/8546")
    np = of(net, "NetworkPolicy")
    check([n["metadata"]["name"] for n in np] == ["besu-validator-ingress"], f"{party}: one NetworkPolicy besu-validator-ingress")
    if np:
        ing = np[0]["spec"]["ingress"]
        check(all([p["port"] for p in r["ports"]] == [30303] and r["ports"][0]["protocol"] == "TCP" for r in ing), f"{party}: policy opens only TCP 30303")
        frm = json.dumps(ing)
        check("rd-zeto" in frm and "rd-stealth" in frm and "besu" in frm, f"{party}: 30303 allowed from rd-zeto-*, rd-stealth-* and ns besu")
    for d in net:
        check(d["metadata"].get("namespace") == ns, f"{party} net: {d['kind']}/{d['metadata']['name']} not in {ns}")
    ext = docs("net", party, "--external-cidr", "203.0.113.7/32")
    check("203.0.113.7/32" in json.dumps(ext), f"{party}: --external-cidr must add an ipBlock")
    # stage nodeinfo
    ni = docs("nodeinfo", party)
    job = of(ni, "Job")
    check(len(job) == 1 and job[0]["metadata"]["namespace"] == ns, f"{party}: one Job besu-nodeinfo in {ns}")
    if job:
        cmd = json.dumps(job[0]["spec"]["template"]["spec"]["containers"][0])
        check("public-key export" in cmd and "export-address" in cmd and "besu-nodekey" in json.dumps(job[0]), f"{party}: nodeinfo prints public key and address from Secret besu-nodekey")
        check("nodekey" not in cmd.replace("--node-private-key-file=/keys/nodekey", "").replace("/keys/nodekey", ""), f"{party}: nodeinfo must not echo the key")
    # stage node
    nd = docs("node", party, "--p2p-host", "10.9.8.7", "--static-nodes", sn)
    cms = {d["metadata"]["name"]: d for d in of(nd, "ConfigMap")}
    check(set(cms) == {"besu-config", "besu-static-nodes"}, f"{party}: ConfigMaps {sorted(cms)} (genesis is copied by genesis.sh)")
    if "besu-config" in cms:
        cfg = cms["besu-config"]["data"]["config.toml"]
        check('p2p-host="10.9.8.7"' in cfg and "discovery-enabled=false" in cfg and "${P2P_HOST}" not in cfg, f"{party}: config has the LB IP, discovery off, no placeholder")
        check('static-nodes-file="/config/static/static-nodes.json"' in cfg and 'node-private-key-file="/keys/nodekey"' in cfg, f"{party}: config keeps static-nodes-file and node-private-key-file paths")
    if "besu-static-nodes" in cms:
        check(json.loads(cms["besu-static-nodes"]["data"]["static-nodes.json"]) == [ENODE_A, ENODE_B], f"{party}: static-nodes ConfigMap content")
    sts = of(nd, "StatefulSet")
    check(len(sts) == 1 and sts[0]["metadata"]["name"] == "besu-validator" and sts[0]["metadata"]["namespace"] == ns, f"{party}: one StatefulSet besu-validator in {ns}")
    if sts:
        s = sts[0]["spec"]
        pod = s["template"]["spec"]
        c = pod["containers"][0]
        check(c["image"] == "hyperledger/besu:26.8.1" and s["replicas"] == 1, f"{party}: image hyperledger/besu:26.8.1, 1 replica")
        argv = " ".join(c["args"] if "args" in c else []) + " ".join(c.get("command", []))
        check("--Xdns" not in argv and "--nat-method=NONE" in argv and "--min-gas-price=0" in argv, f"{party}: args: no Xdns, nat NONE, min-gas-price 0: {argv}")
        check({p["name"] for p in c["ports"]} == {"json-rpc", "ws", "rlpx", "metrics"} and all(p["protocol"] == "TCP" for p in c["ports"]), f"{party}: ports TCP only (no UDP discovery)")
        check(c["livenessProbe"]["httpGet"]["path"] == "/liveness" and c["livenessProbe"]["initialDelaySeconds"] == 180, f"{party}: liveness as live (/liveness, 180 s)")
        res = c["resources"]
        check(res.get("requests", {}).get("cpu") and res["requests"].get("memory") and res.get("limits", {}).get("memory"), f"{party}: requests and limits set")
        vol = {v["name"]: v for v in pod["volumes"]}
        check(vol["besu-keys"]["secret"]["secretName"] == "besu-nodekey", f"{party}: node key from Secret besu-nodekey")
        check(vol["genesis"]["configMap"]["name"] == "besu-genesis" and vol["besu-config"]["configMap"]["name"] == "besu-config" and vol["static-nodes"]["configMap"]["name"] == "besu-static-nodes", f"{party}: volumes map to besu-genesis, besu-config, besu-static-nodes")
        vct = s["volumeClaimTemplates"][0]
        check(vct["spec"]["resources"]["requests"]["storage"] == "40Gi", f"{party}: PVC 40Gi")
        check(s["serviceName"] == "besu-validator", f"{party}: serviceName besu-validator")
        aff = json.dumps(pod.get("affinity", {}))
        check("podAntiAffinity" in aff and "namespaceSelector" in aff, f"{party}: anti-affinity across the rd-zeto namespaces (namespaceSelector)")
        if party != "bank-c":
            check("member-16033-node" in aff and "member-16034-node" in aff and "NotIn" in aff, f"{party}: nodeAffinity keeps the pod off member-16033/16034")
            check(res["requests"]["cpu"] == "1" and res["requests"]["memory"] == "2500M", f"{party}: cluster-1 requests as the live validators (1 CPU, 2500M)")
        else:
            check(res["requests"]["memory"] != "2500M", f"{party}: bank C requests must be smaller (cluster 2 memory is tight)")
        init = pod["initContainers"][0]
        check("chown" in " ".join(init["command"]), f"{party}: init container chowns /data like live")
    # refusals
    check(run(render, "node", party, "--static-nodes", sn).returncode != 0, f"{party}: node without --p2p-host must fail")
    check(run(render, "node", party, "--p2p-host", "besu.example.com", "--static-nodes", sn).returncode != 0, f"{party}: node with a DNS --p2p-host must fail (IP only)")
    check(run(render, "node", party, "--p2p-host", "10.9.8.7").returncode != 0, f"{party}: node without --static-nodes must fail")
    check(run(render, "node", party, "--p2p-host", "10.9.8.7", "--static-nodes", os.path.join(tmp, "nope.json")).returncode != 0, f"{party}: node with a missing static-nodes file must fail")
check(run(render, "net", "bank-d").returncode != 0, "unknown party must fail")

# ---- helper scripts exist and parse ----
for name in ("nodekey.sh", "genesis.sh", "old-netpol-patch.sh"):
    p = os.path.join(base, name)
    check(os.path.exists(p) and subprocess.run(["bash", "-n", p]).returncode == 0, f"{name} must exist and pass bash -n")
nk = open(os.path.join(base, "nodekey.sh")).read() if os.path.exists(os.path.join(base, "nodekey.sh")) else ""
check("besu-nodekey" in nk and "openssl rand -hex 32" in nk and "echo" not in nk.replace("echo \"nodekey.sh:", ""), "nodekey.sh creates Secret besu-nodekey from openssl rand -hex 32 and never echoes the key")
op = run(os.path.join(base, "old-netpol-patch.sh"))
lines = [l for l in op.stdout.splitlines() if l.startswith("kubectl")]
check(op.returncode == 0 and len(lines) == 4 and all("besu-node-validator-%d-ingress" % i in lines[i - 1] and '"op":"add"' in lines[i - 1] and "/spec/ingress/-" in lines[i - 1] for i in range(1, 5)), f"old-netpol-patch.sh must print 4 add-only patch commands (default: print, not run): {op.stdout[:200]}")

if fails:
    print("\n".join("FAIL " + f for f in fails), file=sys.stderr)
    sys.exit(1)
print("OK all zeto S3/S4 Besu manifest assertions hold")
