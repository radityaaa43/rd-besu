#!/usr/bin/env python3
"""Offline check of stealth S4/S5 Besu JWT RPC node manifests (final-design/stealth/PLAN.md S4, S5). No cluster. Needs PyYAML + openssl.
Usage: check.py <rpc dir>"""
import base64, json, os, re, subprocess, sys, tempfile, yaml

base = sys.argv[1]
render = os.path.join(base, "render.sh")
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

ENODE = "enode://" + "a" * 128 + "@10.1.2.3:30303?discport=0"
tmp = tempfile.mkdtemp()
sn = os.path.join(tmp, "static-nodes.json")
json.dump([ENODE], open(sn, "w"))

# ---- config template: live config with exactly the S4 changes ----
live = open(os.path.join(fx, "live-config.toml")).read().splitlines()
tpath = os.path.join(base, "templates", "config.toml")
tpl = open(tpath).read().splitlines() if os.path.exists(tpath) else []
def keys(lines):
    return {l.split("=", 1)[0]: l for l in lines if "=" in l and not l.lstrip().startswith("#")}
lk, tk = keys(live), keys(tpl)
changed = {k for k in lk if k in tk and lk[k] != tk[k]}
removed = {k for k in lk if k not in tk}
added = {k for k in tk if k not in lk}
check(changed == {"discovery-enabled", "rpc-http-api", "rpc-http-authentication-enabled", "host-allowlist", "rpc-ws-enabled", "metrics-host"}, f"config: changed keys {sorted(changed)}")
check(removed == {"rpc-http-cors-origins", "rpc-ws-host", "rpc-ws-port", "rpc-ws-api", "rpc-ws-authentication-enabled"}, f"config: removed keys {sorted(removed)}")
check(added == {"rpc-http-authentication-jwt-public-key-file"}, f"config: added keys {sorted(added)} (sync-min-peers is ignored in FULL sync, Besu BesuCommand.java:1996-1998 @26.8.1: not set)")
g = lambda k: tk.get(k, "")
check(g("rpc-http-api") == 'rpc-http-api=["ETH","NET","WEB3"]', f"config: rpc-http-api {g('rpc-http-api')}")
check(g("rpc-http-authentication-enabled") == "rpc-http-authentication-enabled=true", "config: JWT authentication must be enabled")
check(g("rpc-http-authentication-jwt-public-key-file") == 'rpc-http-authentication-jwt-public-key-file="/jwt/public.pem"', "config: jwt public key path /jwt/public.pem")
check(g("rpc-ws-enabled") == "rpc-ws-enabled=false" and g("metrics-host") == 'metrics-host="127.0.0.1"' and g("discovery-enabled") == "discovery-enabled=false", "config: ws off, metrics on 127.0.0.1, discovery off")
check(g("sync-mode") == 'sync-mode="FULL"' and g("static-nodes-file") == 'static-nodes-file="/config/static/static-nodes.json"' and g("node-private-key-file") == 'node-private-key-file="/keys/nodekey"', "config: sync FULL, static-nodes path and node key path kept")
al = g("host-allowlist")
for h in ("besu-rpc", "st-gw", "localhost", "127.0.0.1"):
    check(f'"{h}"' in al, f"config: host-allowlist must contain {h}: {al}")
check('"*"' not in al, "config: host-allowlist must not be *")

check("sync-min-peers" not in g("sync-min-peers"), "config: sync-min-peers must not be set (ignored in FULL sync-mode, Besu logs a WARN)")
check(g("discovery-enabled") == "discovery-enabled=false", "config: discovery-enabled=false (static peer only)")
NETPOLS_ALL = ["bi", "bank-a", "bank-b"]
PARTIES = {"bi": "rd-stealth-bi", "bank-a": "rd-stealth-bank-a", "bank-b": "rd-stealth-bank-b"}
for party, ns in PARTIES.items():
    net = docs("net", party)
    svc = {d["metadata"]["name"]: d for d in of(net, "Service")}
    check(set(svc) == {"besu-rpc", "besu-rpc-hs"}, f"{party}: Services {sorted(svc)}")
    if "besu-rpc" in svc:
        s = svc["besu-rpc"]["spec"]
        check(s.get("type", "ClusterIP") == "ClusterIP" and [p["port"] for p in s["ports"]] == [8545], f"{party}: besu-rpc ClusterIP 8545 only")
    if "besu-rpc-hs" in svc:
        check(svc["besu-rpc-hs"]["spec"].get("clusterIP") == "None", f"{party}: besu-rpc-hs headless")
    np = of(net, "NetworkPolicy")
    check([n["metadata"]["name"] for n in np] == ["besu-rpc-ingress"], f"{party}: one NetworkPolicy besu-rpc-ingress")
    if np:
        spec = np[0]["spec"]
        check(spec["podSelector"] == {"matchLabels": {"app.kubernetes.io/name": "besu-rpc"}} and spec["policyTypes"] == ["Ingress"], f"{party}: policy selects the besu-rpc pod, Ingress")
        txt = json.dumps(spec["ingress"])
        check(len(spec["ingress"]) == 1 and [(p["port"], p["protocol"]) for p in spec["ingress"][0]["ports"]] == [(8545, "TCP")], f"{party}: only TCP 8545")
        check("st-gw" in txt and "stealth-signer" in txt and "stealth-viewkey" in txt and "namespaceSelector" not in txt, f"{party}: 8545 only from pods app=st-gw, app=stealth-signer and app=stealth-viewkey (the S11 compare Job reads eth_call/blockNumber) of this namespace: {txt}")
        check(spec["ingress"][0]["from"] == [{"podSelector": {"matchExpressions": [{"key": "app", "operator": "In", "values": ["st-gw", "stealth-signer", "stealth-viewkey"]}]}}], f"{party}: from is exactly one podSelector with app In [st-gw, stealth-signer, stealth-viewkey]")
    check(all(d["metadata"].get("namespace") == ns for d in net), f"{party}: net objects in {ns}")
    nd = docs("node", party, "--static-nodes", sn)
    cms = {d["metadata"]["name"]: d for d in of(nd, "ConfigMap")}
    check(set(cms) == {"besu-rpc-config", "besu-static-nodes"}, f"{party}: ConfigMaps {sorted(cms)}")
    if "besu-rpc-config" in cms:
        c = cms["besu-rpc-config"]["data"]["config.toml"]
        check('rpc-http-authentication-jwt-public-key-file="/jwt/public.pem"' in c and 'rpc-http-api=["ETH","NET","WEB3"]' in c and f"{ns}.svc.cluster.local" in c, f"{party}: rendered config has JWT, API list and the namespace service host")
        check("sync-min-peers" not in c and "\ndiscovery-enabled=false\n" in c, f"{party}: rendered config has no sync-min-peers (no-op in FULL sync) and discovery-enabled=false")
    sts = of(nd, "StatefulSet")
    check(len(sts) == 1 and sts[0]["metadata"]["name"] == "besu-rpc" and sts[0]["metadata"]["namespace"] == ns, f"{party}: one StatefulSet besu-rpc in {ns}")
    if sts:
        s = sts[0]["spec"]
        pod = s["template"]["spec"]
        c = pod["containers"][0]
        check(c["image"] == "hyperledger/besu:26.8.1@sha256:6f3f21ce533383fcc8db3bce02252b59d5a9e776b72b5a1c8ecd2db011600042" and s["replicas"] == 1 and s["serviceName"] == "besu-rpc-hs", f"{party}: image, replicas, serviceName")
        check(s["template"]["metadata"]["labels"].get("app.kubernetes.io/name") == "besu-rpc", f"{party}: pod label app.kubernetes.io/name=besu-rpc")
        argv = " ".join(c.get("args", [])) + " ".join(c.get("command", []))
        check("--Xdns" not in argv and "--nat-method=NONE" in argv and "--min-gas-price=0" in argv, f"{party}: args {argv}")
        check([(p["name"], p["protocol"]) for p in c["ports"]] == [("json-rpc", "TCP")] , f"{party}: only the json-rpc port is exposed: {c['ports']}")
        vol = {v["name"]: v for v in pod["volumes"]}
        check(vol["jwt"]["secret"]["secretName"] == "stealth-rpc-jwt" and vol["jwt"]["secret"]["items"] == [{"key": "public.pem", "path": "public.pem"}], f"{party}: only public.pem of Secret stealth-rpc-jwt is mounted")
        check("private" not in json.dumps(pod), f"{party}: the private key must not appear in the pod spec")
        check(vol["besu-keys"]["secret"]["secretName"] == "besu-rpc-nodekey" and vol["genesis"]["configMap"]["name"] == "besu-genesis" and vol["besu-config"]["configMap"]["name"] == "besu-rpc-config", f"{party}: node key, genesis and config volumes")
        check(s["volumeClaimTemplates"][0]["spec"]["resources"]["requests"]["storage"] == "40Gi", f"{party}: PVC 40Gi")
        aff = json.dumps(pod.get("affinity", {}))
        check("member-16033-node" in aff and "member-16034-node" in aff and "NotIn" in aff, f"{party}: kept off member-16033-node / member-16034-node")
        res = c["resources"]
        check(res.get("requests", {}).get("cpu") and res["requests"].get("memory") and res.get("limits", {}).get("memory"), f"{party}: requests and limits set")
        check(res["requests"] == {"cpu": "100m", "memory": "768Mi"} and res["limits"] == {"cpu": "2", "memory": "3G"}, f"{party}: besu-rpc requests 100m / 768Mi (resize 2026-11-12), limits unchanged 2 / 3G")
    check(run(render, "node", party).returncode != 0, f"{party}: node without --static-nodes must fail")
    check(run(render, "node", party, "--static-nodes", os.path.join(tmp, "nope.json")).returncode != 0, f"{party}: missing static-nodes file must fail")
two = os.path.join(tmp, "two.json"); json.dump([ENODE, "enode://" + "b" * 128 + "@10.1.2.4:30303?discport=0"], open(two, "w"))
zero = os.path.join(tmp, "zero.json"); json.dump([], open(zero, "w"))
for party in PARTIES:
    mp = run(render, "node", party, "--static-nodes", two, "--allow-multi-peer")
    check(mp.returncode == 0 and mp.stdout.count("enode://") == 2, f"{party}: --allow-multi-peer must accept 2 entries (catch-up phase only): rc={mp.returncode} {mp.stderr[:80]}")
    check(run(render, "node", party, "--static-nodes", zero, "--allow-multi-peer").returncode != 0, f"{party}: --allow-multi-peer must still refuse an empty list")
    check(run(render, "node", party, "--static-nodes", two).returncode != 0, f"{party}: static-nodes with 2 entries must be refused (the RPC node peers ONLY with its own party's zeto node)")
    check(run(render, "node", party, "--static-nodes", zero).returncode != 0, f"{party}: static-nodes with 0 entries must be refused")
# cluster 2: bank-c only behind --cluster 2
for stage, extra in (("net", []), ("node", ["--static-nodes", sn])):
    ds = docs("--cluster", "2", stage, "bank-c", *extra)
    check(bool(ds) and all(d["metadata"].get("namespace") == "rd-stealth-bank-c" for d in ds), f"cluster 2 {stage}: objects in rd-stealth-bank-c")
    check(all(d["metadata"].get("labels", {}).get("cluster") == "2" for d in ds), f"cluster 2 {stage}: every object labelled cluster=2")
    if stage == "node" and ds:
        cfgc = {d["metadata"]["name"]: d for d in of(ds, "ConfigMap")}["besu-rpc-config"]["data"]["config.toml"]
        check("sync-min-peers" not in cfgc and "\ndiscovery-enabled=false\n" in cfgc, "cluster 2: no sync-min-peers, discovery off")
        st = of(ds, "StatefulSet")[0]
        aff = json.dumps(st["spec"]["template"]["spec"].get("affinity", {}))
        check("member-16033-node" not in aff, "cluster 2: the cluster-1 node exclusion must not be copied")
        check(st["spec"]["template"]["spec"]["containers"][0]["resources"] == {"requests": {"cpu": "100m", "memory": "640Mi"}, "limits": {"cpu": "1", "memory": "2G"}}, "cluster 2: besu-rpc requests 100m / 640Mi (resize 2026-11-12), limits unchanged 1 / 2G")
for args in (["net", "bank-c"], ["--cluster", "2", "net", "bi"], ["--cluster", "1", "net", "bank-c"], ["--cluster", "2"], ["net", "bank-d"]):
    check(run(render, *args).returncode != 0, f"render.sh {' '.join(args)} must be refused")

# ---- S1 template: the besu-rpc pod is excluded from allow-same-namespace, otherwise besu-rpc-ingress restricts nothing ----
p1 = os.path.join(base, "..", "templates", "party.yaml")
t1 = open(p1).read() if os.path.exists(p1) else ""
m = re.search(r"name: allow-same-namespace.*?(?=\n---|\Z)", t1, re.S)
check(bool(m) and "NotIn" in m.group(0) and re.search(r"values: \[vault, besu-rpc\]", m.group(0)) is not None, "templates/party.yaml: allow-same-namespace must be NotIn [vault, besu-rpc] (both exclusions)")

# ---- jwt.sh / mint-token.sh ----
for name in ("jwt.sh", "mint-token.sh", "nodekey.sh", "genesis.sh", "static-nodes.sh"):
    p = os.path.join(base, name)
    check(os.path.exists(p) and subprocess.run(["bash", "-n", p]).returncode == 0, f"{name} must exist and pass bash -n")
jt = open(os.path.join(base, "jwt.sh")).read() if os.path.exists(os.path.join(base, "jwt.sh")) else ""
check("stealth-rpc-jwt" in jt and "genrsa" in jt and "trap" in jt and "/dev/shm" in jt and "umask 077" in jt, "jwt.sh: RSA keypair into Secret stealth-rpc-jwt via a 077 tmpfs dir removed by trap")
check("cat " not in jt and "echo \"$" not in jt, "jwt.sh must not print key material")
kp = os.path.join(tmp, "k"); os.makedirs(kp)
subprocess.run(["openssl", "genrsa", "-out", os.path.join(kp, "private.pem"), "2048"], capture_output=True)
subprocess.run(["openssl", "rsa", "-in", os.path.join(kp, "private.pem"), "-pubout", "-out", os.path.join(kp, "public.pem")], capture_output=True)
mt = os.path.join(base, "mint-token.sh")
r = run(mt, "--key-file", os.path.join(kp, "private.pem"), "--ttl", "600", "--permissions", "eth:*,net:*,web3:*")
tok = r.stdout.strip()
parts = tok.split(".")
if r.returncode == 0 and len(parts) == 3:
    b64 = lambda s: base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
    hdr, pl = json.loads(b64(parts[0])), json.loads(b64(parts[1]))
    check(hdr.get("alg") == "RS256", f"token header alg {hdr}")
    check(pl.get("permissions") == ["eth:*", "net:*", "web3:*"] and pl.get("exp", 0) - pl.get("iat", 0) == 600, f"token payload {pl}")
    open(os.path.join(tmp, "sig"), "wb").write(b64(parts[2]))
    v = subprocess.run(["openssl", "dgst", "-sha256", "-verify", os.path.join(kp, "public.pem"), "-signature", os.path.join(tmp, "sig")], input=(parts[0] + "." + parts[1]).encode(), capture_output=True)
    check(v.returncode == 0, f"token signature must verify with the public key: {v.stdout[:60]} {v.stderr[:60]}")
else:
    fails.append(f"mint-token.sh must print a 3-part JWT: rc={r.returncode} {r.stderr[:150]}")
check(run(mt, "--key-file", os.path.join(kp, "private.pem"), "--ttl", "99999", "--permissions", "eth:*").returncode != 0, "mint-token.sh: ttl above 3600 must be refused (short-lived tokens)")
check(run(mt, "--key-file", os.path.join(kp, "private.pem"), "--ttl", "60", "--permissions", "*:*").returncode != 0, "mint-token.sh: *:* must be refused (stealth tokens are eth/net/web3 only)")
check(run(mt, "--key-file", os.path.join(tmp, "nope.pem"), "--ttl", "60", "--permissions", "eth:*").returncode != 0, "mint-token.sh: missing key file must fail")

# ---- static-nodes.sh keeps the IP-only rule ----
sns = os.path.join(base, "static-nodes.sh")
out = run(sns, "--peer", ENODE)
check(out.returncode == 0 and json.loads(out.stdout or "null") == [ENODE], "static-nodes.sh --peer echoes the enode list")
check(run(sns, "--peer", "enode://" + "c" * 128 + "@besu-validator-0.example.svc:30303").returncode != 0, "static-nodes.sh refuses a DNS name")

if fails:
    print("\n".join("FAIL " + f for f in fails), file=sys.stderr)
    sys.exit(1)
print("OK all stealth S4/S5 RPC node assertions hold")
