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

# ---- static-nodes.sh --new-validators/--party: the 3 OTHER new validators only, never an old pod IP (repoint BI/A/B off the old ns besu) ----
nv = os.path.join(fx, "new-validators.json")
ORDER = ["bi", "bank-a", "bank-b", "bank-c"]
allnew = json.load(open(nv))
old_ips = {l.split()[1] for l in open(os.path.join(fx, "old-pod-ips.txt")) if l.strip()}
for me in ORDER:
    r = run(static, "--new-validators", nv, "--party", me)
    want = [allnew[p] for p in ORDER if p != me]
    got = json.loads(r.stdout or "null") if r.returncode == 0 else None
    check(got == want, f"static-nodes.sh --party {me} must list exactly the other 3 new validators in order bi,bank-a,bank-b,bank-c: {got} {r.stderr.strip()[:100]}")
    check(got is not None and not any(ip in e for e in got for ip in old_ips) and allnew[me] not in got, f"static-nodes.sh --party {me}: no old pod IP, no self")
check(run(static, "--new-validators", nv, "--party", "nobody").returncode != 0, "static-nodes.sh --party must refuse an unknown party")
check(run(static, "--new-validators", nv).returncode != 0, "static-nodes.sh --new-validators needs --party")
check(run(static, "--party", "bi").returncode != 0, "static-nodes.sh --party needs --new-validators")
dns = os.path.join(tmp, "dns-validators.json")
json.dump({**allnew, "bank-a": "enode://" + "2" * 128 + "@besu-node-validator-1-0.besu.svc:30303"}, open(dns, "w"))
check(run(static, "--new-validators", dns, "--party", "bi").returncode != 0, "static-nodes.sh --new-validators must refuse a DNS enode")
short = os.path.join(tmp, "short-validators.json")
json.dump({k: v for k, v in allnew.items() if k != "bank-c"}, open(short, "w"))
check(run(static, "--new-validators", short, "--party", "bi").returncode != 0, "static-nodes.sh --new-validators must refuse a file missing one of the 4 parties")

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
        # rule 0: p2p 30303 from the other new validators only (ns part-of=rd-zeto); the old ns besu and the stealth RPC nodes are gone
        check(len(ing) == 2, f"{party}: two ingress rules (p2p, then RPC from the own gateway and Paladin): {len(ing)}")
        p2p = ing[0] if ing else {}
        check([(p["port"], p["protocol"]) for p in p2p.get("ports", [])] == [(30303, "TCP")], f"{party}: rule 0 opens only TCP 30303")
        check(p2p.get("from") == [{"namespaceSelector": {"matchExpressions": [{"key": "part-of", "operator": "In", "values": ["rd-zeto"]}]}}],
              f"{party}: 30303 only from ns part-of=rd-zeto (no ns besu, no rd-stealth-*): {p2p.get('from')}")
        check("rd-stealth" not in json.dumps(ing) and '"besu"' not in json.dumps(ing), f"{party}: no stale selector for ns besu or rd-stealth-*")
        # rule 1: JSON-RPC 8545/8546 only from the SAME namespace's bank-gw and Paladin pods (stealth reaches the validator through bank-gw)
        rpc = ing[1] if len(ing) > 1 else {}
        check(rpc == {"from": [{"podSelector": {"matchExpressions": [{"key": "app", "operator": "In", "values": ["bank-gw", "paladin"]}]}}],
                      "ports": [{"protocol": "TCP", "port": 8545}, {"protocol": "TCP", "port": 8546}]},
              f"{party}: rule 1 must open 8545/8546 to same-ns app in (bank-gw, paladin) only: {rpc}")
    for d in net:
        check(d["metadata"].get("namespace") == ns, f"{party} net: {d['kind']}/{d['metadata']['name']} not in {ns}")
    ext = docs("net", party, "--external-cidr", "203.0.113.7/32")
    check("203.0.113.7/32" in json.dumps(ext), f"{party}: --external-cidr must add an ipBlock")
    # live state (rd-zeto-bi 2026-11-11): CLB ACL annotations + eni backends + source ranges, and the CLB health-check source CIDR as a second rule
    plain = json.dumps(net)
    check("alibaba-cloud-loadbalancer" not in plain and "backend-type" not in plain and "loadBalancerSourceRanges" not in plain and "100.64.0.0/10" not in plain, f"{party}: without --acl-id / --clb-health-cidr nothing cloud-specific is rendered")
    live = docs("net", party, "--external-cidr", "203.0.113.7/32", "--acl-id", "acl-test123", "--clb-health-cidr", "100.64.0.0/10")
    lsvc = {d["metadata"]["name"]: d for d in of(live, "Service")}["besu-p2p"]
    ann = lsvc["metadata"].get("annotations", {})
    check(ann == {"service.beta.kubernetes.io/alibaba-cloud-loadbalancer-acl-status": "on", "service.beta.kubernetes.io/alibaba-cloud-loadbalancer-acl-type": "white",
                  "service.beta.kubernetes.io/alibaba-cloud-loadbalancer-acl-id": "acl-test123", "service.beta.kubernetes.io/backend-type": "eni"}, f"{party}: ACL annotations {ann}")
    check(lsvc["spec"].get("loadBalancerSourceRanges") == ["203.0.113.7/32"], f"{party}: loadBalancerSourceRanges must equal the --external-cidr list: {lsvc['spec'].get('loadBalancerSourceRanges')}")
    ling = of(live, "NetworkPolicy")[0]["spec"]["ingress"]
    check(len(ling) == 3 and ling[2] == {"from": [{"ipBlock": {"cidr": "100.64.0.0/10"}}], "ports": [{"protocol": "TCP", "port": 30303}]}, f"{party}: third ingress rule must be the CLB health CIDR on TCP 30303: {ling[2:]}")
    check({"ipBlock": {"cidr": "203.0.113.7/32"}} in ling[0]["from"], f"{party}: --external-cidr lands in the p2p rule only")
    check(run(render, "net", party, "--acl-id", "bad id").returncode != 0 and run(render, "net", party, "--acl-id", "acl-x").returncode != 0, f"{party}: --acl-id must match acl-[a-z0-9]+ and needs at least one --external-cidr")
    # stage nodeinfo
    ni = docs("nodeinfo", party)
    job = of(ni, "Job")
    check(len(job) == 1 and job[0]["metadata"]["namespace"] == ns, f"{party}: one Job besu-nodeinfo in {ns}")
    if job:
        check(job[0]["spec"]["template"]["spec"].get("enableServiceLinks") is False, f"{party}: nodeinfo Job needs enableServiceLinks: false")
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
        check("sync-min-peers" not in cfg, f"{party}: sync-min-peers is ignored in FULL sync (Besu BesuCommand.java:1996-1998 @26.8.1): not set")
    if "besu-static-nodes" in cms:
        check(json.loads(cms["besu-static-nodes"]["data"]["static-nodes.json"]) == [ENODE_A, ENODE_B], f"{party}: static-nodes ConfigMap content")
    sts = of(nd, "StatefulSet")
    check(len(sts) == 1 and sts[0]["metadata"]["name"] == "besu-validator" and sts[0]["metadata"]["namespace"] == ns, f"{party}: one StatefulSet besu-validator in {ns}")
    if sts:
        s = sts[0]["spec"]
        pod = s["template"]["spec"]
        c = pod["containers"][0]
        check(c["image"] == "hyperledger/besu:26.8.1@sha256:6f3f21ce533383fcc8db3bce02252b59d5a9e776b72b5a1c8ecd2db011600042" and s["replicas"] == 1, f"{party}: image hyperledger/besu:26.8.1, 1 replica")
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
        # R22 (analyst GAP): the anti-affinity selects the shared label rd/role=besu-validator (the same label the pod carries), required, hostname topology, across part-of=rd-zeto namespaces.
        tl = s["template"]["metadata"]["labels"]
        check(tl.get("rd/role") == "besu-validator", f"{party}: R22 pod label rd/role=besu-validator: {tl}")
        paa = (pod.get("affinity", {}).get("podAntiAffinity") or {}).get("requiredDuringSchedulingIgnoredDuringExecution") or []
        check(paa == [{"labelSelector": {"matchLabels": {"rd/role": "besu-validator"}}, "namespaceSelector": {"matchLabels": {"part-of": "rd-zeto"}}, "topologyKey": "kubernetes.io/hostname"}], f"{party}: R22 required podAntiAffinity on rd/role=besu-validator: {paa}")
        if party != "bank-c":
            check("member-16033-node" in aff and "member-16034-node" in aff and "NotIn" in aff, f"{party}: nodeAffinity keeps the pod off member-16033/16034")
            check(res["requests"] == {"cpu": "500m", "memory": "2500M"} and res["limits"] == {"cpu": "3", "memory": "5G"}, f"{party}: cluster-1 requests 500m / 2500M (resize 2026-11-12: CPU 1 -> 500m, memory unchanged), limits unchanged 3 / 5G")
        else:
            check(res["requests"] == {"cpu": "250m", "memory": "1500M"} and res["limits"] == {"cpu": "2", "memory": "3G"}, f"{party}: bank C validator untouched by the resize (250m / 1500M, limits 2 / 3G)")
            na = pod["affinity"].get("nodeAffinity", {})
            pref = na.get("preferredDuringSchedulingIgnoredDuringExecution", [])
            check("requiredDuringSchedulingIgnoredDuringExecution" not in na, f"{party}: no REQUIRED nodeAffinity on cluster 2 (the Immediate PV zone fixes the pod zone; a hard selector can deadlock)")
            check(len(pref) == 1 and pref[0]["preference"]["matchExpressions"] == [{"key": "topology.kubernetes.io/zone", "operator": "In", "values": ["ap-southeast-1a"]}], f"{party}: PREFERRED zone ap-southeast-1a only: {pref}")
        check(pod.get("enableServiceLinks") is False, f"{party}: enableServiceLinks must be false (Service besu-p2p injects BESU_P2P_PORT=tcp://..., which Besu reads as --p2p-port)")
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
