#!/usr/bin/env python3
"""Offline check of zeto S16 (final-design/zeto/PLAN.md S16: gateway per party, own mTLS CA).
Usage: check.py <render.sh> <gen-party-certs.sh>   Exit 0 = all assertions hold; 1 = failures on stderr.
Needs PyYAML + openssl; no cluster. The handshake test binds 127.0.0.1 on a free port for a moment."""
import os, re, socket, subprocess, sys, tempfile, time, yaml

render, gen = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
repo = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", ".."))
PARTIES = {"bi": 1, "bank-a": 2, "bank-b": 3, "bank-c": 4}
fails = []


def check(ok, msg):
    if not ok:
        fails.append(msg)


def run(*args, **kw):
    try:
        return subprocess.run([render, *args], capture_output=True, text=True, **kw)
    except FileNotFoundError as e:
        return subprocess.CompletedProcess(args, 127, "", str(e))


def docs(*args):
    r = run(*args)
    if r.returncode != 0:
        fails.append(f"render.sh {' '.join(args)} exited {r.returncode}: {r.stderr.strip()[:200]}")
        return []
    return [d for d in yaml.safe_load_all(r.stdout) if d]


def of(ds, kind):
    return [d for d in ds if d["kind"] == kind]


def by_name(ds, kind):
    return {d["metadata"]["name"]: d for d in of(ds, kind)}


def existing(n):
    return [d for d in yaml.safe_load_all(open(os.path.join(repo, "opa", "k8s", f"bank-gw-{n}.yaml"))) if d]


# ---------------- render.sh ----------------
opa_plain = yaml.safe_load(open(os.path.join(repo, "opa", "opa.yaml")))
for party, n in PARTIES.items():
    ns, gw, node = f"rd-zeto-{party}", f"bank-gw-{n}", f"node{n}"
    ds = docs(party)
    check(bool(ds), f"{party}: no objects rendered")
    if not ds:
        continue
    kinds = sorted(d["kind"] for d in ds)
    check(kinds == ["ConfigMap", "ConfigMap", "Deployment", "NetworkPolicy", "NetworkPolicy", "Service", "Service"], f"{party}: kinds {kinds}")
    for d in ds:
        check(d["metadata"].get("namespace") == ns, f"{party}: {d['kind']}/{d['metadata']['name']} not in {ns}")
    text = run(party).stdout
    check(not re.search(r"namespace: paladin\b", text) and not re.search(r"\.paladin\.svc", text), f"{party}: output still refers to namespace paladin")
    check("besu.svc" not in text and "besu-node-validator" not in text, f"{party}: output still points at the old besu namespace/validator service")
    check(not any(k in kinds for k in ("Secret", "Ingress", "Namespace")), f"{party}: must not render Secret/Ingress/Namespace")

    # Deployment: same pod spec as opa/k8s/bank-gw-N.yaml (images, args, probes, securityContext, volumes), pod labels exactly app+node
    dep = by_name(ds, "Deployment").get(gw)
    check(dep is not None, f"{party}: Deployment {gw} missing")
    if dep:
        lab = {"app": "bank-gw", "node": node}
        check(dep["spec"]["template"]["metadata"]["labels"] == lab, f"{party}: pod labels {dep['spec']['template']['metadata']['labels']}")
        check(dep["spec"]["selector"]["matchLabels"] == lab and dep["metadata"]["labels"] == lab, f"{party}: selector/labels")
        old = existing(n)[0]
        check(dep["spec"] == old["spec"], f"{party}: Deployment spec differs from opa/k8s/bank-gw-{n}.yaml")
        cs = {c["name"]: c for c in dep["spec"]["template"]["spec"]["containers"]}
        check(set(cs) == {"envoy", "opa"}, f"{party}: containers {sorted(cs)}")
        check(cs["envoy"]["image"] == "envoyproxy/envoy:v1.38.9" and cs["opa"]["image"] == "openpolicyagent/opa:1.21.1-envoy-1-static", f"{party}: images")
        check([p["containerPort"] for p in cs["envoy"]["ports"]] == [8548, 8545], f"{party}: envoy ports")
        check("--diagnostic-addr=0.0.0.0:8282" in cs["opa"]["args"], f"{party}: opa diagnostic 8282")
        vols = {v["name"]: v for v in dep["spec"]["template"]["spec"]["volumes"]}
        check(vols["mtls"]["secret"]["secretName"] == f"{gw}-mtls" and vols["envoy"]["configMap"]["name"] == f"{gw}-envoy" and vols["opa"]["configMap"]["name"] == "bank-gw-opa-v2", f"{party}: volume names")

    # Services
    svc = by_name(ds, "Service")
    check(set(svc) == {gw, f"{gw}-ext"}, f"{party}: Services {sorted(svc)}")
    sel = {"app": "bank-gw", "node": node}
    if gw in svc:
        s = svc[gw]["spec"]
        check(s.get("type", "ClusterIP") == "ClusterIP" and s["selector"] == sel and [(p["port"], p["targetPort"]) for p in s["ports"]] == [(8548, 8548), (8545, 8545)], f"{party}: Service {gw} shape")
    if f"{gw}-ext" in svc:
        e = svc[f"{gw}-ext"]
        s = e["spec"]
        want = "NodePort"  # LoadBalancer only behind --acl-id (below)
        check(s.get("type") == want, f"{party}: {gw}-ext type {s.get('type')} != {want}")
        check(s["selector"] == sel and sorted(p["port"] for p in s["ports"]) == [8545, 8548], f"{party}: {gw}-ext selector/ports")
        check(not e["metadata"].get("annotations") and "loadBalancerSourceRanges" not in s, f"{party}: {gw}-ext must carry no cloud annotations or source ranges")

    # ConfigMaps
    cm = by_name(ds, "ConfigMap")
    check(set(cm) == {f"{gw}-envoy", "bank-gw-opa-v2"}, f"{party}: ConfigMaps {sorted(cm)}")
    if f"{gw}-envoy" in cm:
        check(list(cm[f"{gw}-envoy"]["data"]) == ["envoy.yaml"], f"{party}: envoy CM key")
        env = yaml.safe_load(cm[f"{gw}-envoy"]["data"]["envoy.yaml"])
        sr = env["static_resources"]
        addr = {c["name"]: c["load_assignment"]["endpoints"][0]["lb_endpoints"][0]["endpoint"]["address"]["socket_address"] for c in sr["clusters"] if c["name"] in ("paladin", "besu")}
        check(addr.get("paladin") == {"address": f"paladin-{node}.{ns}.svc.cluster.local", "port_value": 8548}, f"{party}: paladin upstream {addr.get('paladin')}")
        check(addr.get("besu") == {"address": f"besu-rpc.{ns}.svc.cluster.local", "port_value": 8545}, f"{party}: besu upstream {addr.get('besu')}")
        ls = {l["name"]: l for l in sr["listeners"]}
        check({k: v["address"]["socket_address"]["port_value"] for k, v in ls.items()} == {"paladin": 8548, "besu": 8545}, f"{party}: listener ports")
        for k, l in ls.items():
            fc = l["filter_chains"][0]
            tc = fc.get("transport_socket", {}).get("typed_config", {})
            check(tc.get("require_client_certificate") is True and tc["common_tls_context"]["validation_context"]["trusted_ca"]["filename"] == "/mtls/ca.crt", f"{party}: listener {k} must require a client cert signed by /mtls/ca.crt")
            hcm = fc["filters"][0]["typed_config"]
            ce = hcm["route_config"]["virtual_hosts"][0]["routes"][0]["typed_per_filter_config"]["envoy.filters.http.ext_authz"]["check_settings"]["context_extensions"]
            check(ce == {"target": k, "node": node}, f"{party}: listener {k} context_extensions {ce}")
            check(hcm["http_filters"][0]["typed_config"]["failure_mode_allow"] is False, f"{party}: listener {k} must fail closed")
    if "bank-gw-opa-v2" in cm:
        check(list(cm["bank-gw-opa-v2"]["data"]) == ["opa.yaml"] and yaml.safe_load(cm["bank-gw-opa-v2"]["data"]["opa.yaml"]) == opa_plain, f"{party}: bank-gw-opa-v2 must carry opa/opa.yaml unchanged")

    # NetworkPolicy
    np = by_name(ds, "NetworkPolicy")
    check(set(np) == {"paladin-ingress", "bank-gw-ingress"}, f"{party}: NetworkPolicies {sorted(np)} (allow-same-namespace is the S1 object now)")
    if "paladin-ingress" in np:
        sp = np["paladin-ingress"]["spec"]
        check(sp["podSelector"] == {"matchLabels": {"app": "paladin"}} and sp["policyTypes"] == ["Ingress"], f"{party}: paladin-ingress selects app=paladin, Ingress only")
        peers8548 = []
        for r in sp["ingress"]:
            ports = {p["port"] for p in r.get("ports", [])}
            if not r.get("ports") or 8548 in ports:
                peers8548 += r.get("from", ["ANY"])
        check(peers8548 == [{"podSelector": {"matchLabels": {"app": "bank-gw"}}}, {"podSelector": {"matchLabels": {"app.kubernetes.io/name": "paladin-operator"}}}],
              f"{party}: 8548 reachable only from app=bank-gw and the operator (same namespace, no namespaceSelector/ipBlock): {peers8548}")
        check(not any("namespaceSelector" in f or "ipBlock" in f for r in sp["ingress"] for f in r.get("from", [])), f"{party}: paladin-ingress must be same-namespace only")
    if "bank-gw-ingress" in np:
        sp = np["bank-gw-ingress"]["spec"]
        check(sp["podSelector"] == {"matchLabels": {"app": "bank-gw"}} and sp["policyTypes"] == ["Ingress"], f"{party}: bank-gw-ingress selector")
        check(len(sp["ingress"]) == 1 and [p["port"] for p in sp["ingress"][0]["ports"]] == [8548, 8545] and "from" not in sp["ingress"][0], f"{party}: bank-gw-ingress must open only 8548/8545 (any source by default): {sp['ingress']}")

    # bank-c LoadBalancer only behind --acl-id + --external-cidr (lead decision: no public LB without an ACL)
    if party == "bank-c":
        lb = docs("bank-c", "--acl-id", "acl-gs5m5o9vb3olr19484tyg", "--external-cidr", "8.215.62.92/32")
        e = {d["metadata"]["name"]: d for d in lb if d["kind"] == "Service"}["bank-gw-4-ext"]
        check(e["spec"]["type"] == "LoadBalancer" and e["spec"].get("externalTrafficPolicy") == "Cluster" and e["spec"].get("loadBalancerSourceRanges") == ["8.215.62.92/32"], f"bank-c: ext LoadBalancer shape {e['spec']}")
        check(e["metadata"]["annotations"] == {"service.beta.kubernetes.io/alibaba-cloud-loadbalancer-acl-status": "on", "service.beta.kubernetes.io/alibaba-cloud-loadbalancer-acl-type": "white",
              "service.beta.kubernetes.io/alibaba-cloud-loadbalancer-acl-id": "acl-gs5m5o9vb3olr19484tyg", "service.beta.kubernetes.io/backend-type": "eni"}, "bank-c: ACL annotations")
        check(run("bank-c", "--acl-id", "acl-x").returncode != 0 and run("bank-c", "--external-cidr", "8.215.62.92/32").returncode != 0, "bank-c: --acl-id and --external-cidr only together")
    else:
        check(run(party, "--acl-id", "acl-x", "--external-cidr", "1.2.3.4/32").returncode != 0, f"{party}: LoadBalancer flags are for bank-c only")

    # determinism
    check(run(party).stdout == run(party).stdout, f"{party}: render not deterministic")

# --lensa-cidr narrows the gateway policy to ipBlocks
c = docs("bank-a", "--lensa-cidr", "203.0.113.7/32", "--lensa-cidr", "198.51.100.0/24")
gi = by_name(c, "NetworkPolicy").get("bank-gw-ingress")
check(gi is not None and gi["spec"]["ingress"][0].get("from") == [{"ipBlock": {"cidr": "203.0.113.7/32"}}, {"ipBlock": {"cidr": "198.51.100.0/24"}}], "--lensa-cidr must render ipBlock peers")
check(run("bank-a", "--lensa-cidr", "not-a-cidr").returncode != 0, "--lensa-cidr must reject a bad CIDR")

# --opa-config embeds the keys-augmented config (kept outside the repo by the party)
with tempfile.TemporaryDirectory() as t:
    p = os.path.join(t, "opa-config.yaml")
    open(p, "w").write(open(os.path.join(repo, "opa", "opa.yaml")).read() + "keys:\n  bi:\n    algorithm: RS256\n    key: PUBLIC-ONLY-TEST\n")
    c = docs("bi", "--opa-config", p)
    o = by_name(c, "ConfigMap").get("bank-gw-opa-v2")
    check(o is not None and yaml.safe_load(o["data"]["opa.yaml"]).get("keys", {}).get("bi", {}).get("key") == "PUBLIC-ONLY-TEST", "--opa-config must replace the opa.yaml content")

# all / -o / bad party
al = run("all")
check(al.returncode == 0 and al.stdout == "---\n".join(run(p).stdout for p in PARTIES), "all must equal the four parties joined by ---")
with tempfile.TemporaryDirectory() as t:
    r = run("-o", t, "all")
    check(r.returncode == 0 and sorted(os.listdir(t)) == sorted(f"rd-zeto-{p}-gateway.yaml" for p in PARTIES), f"-o DIR must write one file per party: {sorted(os.listdir(t))}")
check(run("bank-z").returncode == 2, "unknown party must exit 2")
check(run().returncode == 2, "no argument must exit 2")

# ---------------- gen-party-certs.sh ----------------
def ossl(*a):
    return subprocess.run(["openssl", *a], capture_output=True, text=True)


def gen_party(party, d, *extra, env=None):
    e = dict(os.environ, OPA_MTLS_DIR=d)
    if env is not None:
        e = env
    try:
        return subprocess.run([gen, party, *extra], capture_output=True, text=True, env=e)
    except FileNotFoundError as ex:
        return subprocess.CompletedProcess([], 127, "", str(ex))


def mode(p):
    return oct(os.stat(p).st_mode & 0o777)


with tempfile.TemporaryDirectory() as tmp:
    d = {p: os.path.join(tmp, p) for p in PARTIES}
    for p in PARTIES:
        r = gen_party(p, d[p])
        check(r.returncode == 0, f"gen-party-certs {p} exited {r.returncode}: {r.stderr.strip()[:200]}")
        check("PRIVATE KEY" not in r.stdout + r.stderr, f"gen-party-certs {p} printed key material")
    if all(os.path.isdir(x) for x in d.values()):
        for p, n in PARTIES.items():
            files = sorted(os.listdir(d[p]))
            check(files == sorted(["ca.crt", "ca.key", f"gw-{n}.crt", f"gw-{n}.key", "lensa.crt", "lensa.key"]), f"{p}: files {files}")
            check(mode(d[p]) == "0o700", f"{p}: dir mode {mode(d[p])}")
            check(all(mode(os.path.join(d[p], f)) == "0o600" for f in files), f"{p}: file modes {[mode(os.path.join(d[p], f)) for f in files]}")
            ca = os.path.join(d[p], "ca.crt")
            check(ossl("verify", "-CAfile", ca, "-purpose", "sslserver", os.path.join(d[p], f"gw-{n}.crt")).returncode == 0, f"{p}: server cert must verify against own CA")
            check(ossl("verify", "-CAfile", ca, "-purpose", "sslclient", os.path.join(d[p], "lensa.crt")).returncode == 0, f"{p}: Lensa cert must verify against own CA")
            txt = ossl("x509", "-in", os.path.join(d[p], f"gw-{n}.crt"), "-noout", "-ext", "subjectAltName").stdout
            for want in (f"bank-gw-{n}", f"bank-gw-{n}.rd-zeto-{p}", f"bank-gw-{n}.rd-zeto-{p}.svc", f"bank-gw-{n}.rd-zeto-{p}.svc.cluster.local", f"bank-gw-{n}-ext.rd-zeto-{p}.svc.cluster.local", "localhost", "127.0.0.1"):
                check(want in txt, f"{p}: SAN lacks {want}")
            check(".paladin" not in txt.replace("rd-zeto", ""), f"{p}: SAN still names namespace paladin")
            for other in PARTIES:
                if other == p:
                    continue
                oc = os.path.join(d[other], "ca.crt")
                check(open(ca).read() != open(oc).read(), f"{p} and {other} share a CA")
                check(ossl("verify", "-CAfile", oc, os.path.join(d[p], "lensa.crt")).returncode != 0, f"client cert of {p} must NOT verify against the CA of {other}")
                check(ossl("verify", "-CAfile", oc, os.path.join(d[p], f"gw-{n}.crt")).returncode != 0, f"server cert of {p} must NOT verify against the CA of {other}")

        # the PLAN RED proof offline: real TLS 1.2 handshake, gateway of B requires a client cert signed by B's CA
        def handshake(server, client):
            s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
            sn = PARTIES[server]
            srv = subprocess.Popen(["openssl", "s_server", "-accept", f"127.0.0.1:{port}", "-tls1_2", "-www", "-Verify", "1", "-verify_return_error", "-CAfile", os.path.join(d[server], "ca.crt"),
                                    "-cert", os.path.join(d[server], f"gw-{sn}.crt"), "-key", os.path.join(d[server], f"gw-{sn}.key")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                for _ in range(50):
                    try:
                        socket.create_connection(("127.0.0.1", port), 0.2).close(); break
                    except OSError:
                        time.sleep(0.1)
                c = subprocess.run(["openssl", "s_client", "-connect", f"127.0.0.1:{port}", "-tls1_2", "-CAfile", os.path.join(d[server], "ca.crt"), "-verify_hostname", f"bank-gw-{sn}",
                                    "-cert", os.path.join(d[client], "lensa.crt"), "-key", os.path.join(d[client], "lensa.key"), "-quiet"],
                                   input="GET / HTTP/1.0\r\n\r\n", capture_output=True, text=True, timeout=20)
                return c.stdout + c.stderr
            finally:
                srv.kill(); srv.wait()
        ok = handshake("bank-b", "bank-b")
        bad = handshake("bank-b", "bank-a")
        check("HTTP/1.0 200" in ok, f"B client cert at B gateway must be served: {ok[-200:]}")
        check("HTTP/1.0 200" not in bad and ("alert" in bad.lower() or "error" in bad.lower()), f"A client cert at B gateway must fail the handshake: {bad[-200:]}")

        # --lensa-client-from: Lensa keeps its key, the party signs the CSR (no lensa.key written)
        csrdir = os.path.join(tmp, "csr"); os.mkdir(csrdir)
        ossl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", os.path.join(csrdir, "k.pem"))
        ossl("req", "-new", "-key", os.path.join(csrdir, "k.pem"), "-subj", "/CN=lensa-own-key", "-out", os.path.join(csrdir, "lensa.csr"))
        dd = os.path.join(tmp, "withcsr")
        r = gen_party("bank-a", dd, "--lensa-client-from", os.path.join(csrdir, "lensa.csr"))
        check(r.returncode == 0 and sorted(os.listdir(dd)) == ["ca.crt", "ca.key", "gw-2.crt", "gw-2.key", "lensa.crt"], f"--lensa-client-from: files {sorted(os.listdir(dd)) if os.path.isdir(dd) else r.stderr[:200]}")
        if os.path.exists(os.path.join(dd, "lensa.crt")):
            check(ossl("verify", "-CAfile", os.path.join(dd, "ca.crt"), "-purpose", "sslclient", os.path.join(dd, "lensa.crt")).returncode == 0, "CSR-signed Lensa cert must verify against own CA")
            check(ossl("x509", "-in", os.path.join(dd, "lensa.crt"), "-noout", "-pubkey").stdout == ossl("pkey", "-in", os.path.join(csrdir, "k.pem"), "-pubout").stdout, "CSR-signed Lensa cert must carry the CSR public key")

    # refusals
    here_repo = os.path.join(repo, "zeto-s16-must-not-exist")
    r = gen_party("bi", here_repo)
    check(r.returncode != 0 and not os.path.exists(here_repo), "must refuse a directory inside the repo")
    r = gen_party("bi", d["bi"])
    check(r.returncode != 0, "must refuse an existing directory")
    r = gen_party("bank-z", os.path.join(tmp, "zz"))
    check(r.returncode != 0 and not os.path.exists(os.path.join(tmp, "zz")), "must refuse an unknown party")
    env = {k: v for k, v in os.environ.items() if k != "OPA_MTLS_DIR"}
    check(gen_party("bi", "", env=env).returncode != 0, "must refuse when OPA_MTLS_DIR is unset (no default directory)")
    check(gen_party("bi", "relative/dir").returncode != 0, "must refuse a relative OPA_MTLS_DIR")
    check(gen_party("bi", os.path.join(tmp, "x"), "--lensa-client-from", os.path.join(tmp, "nope.csr")).returncode != 0 and not os.path.exists(os.path.join(tmp, "x")), "must refuse a missing CSR before creating anything")

if fails:
    print("\n".join("FAIL " + f for f in fails), file=sys.stderr)
    sys.exit(1)
print("OK all zeto S16 gateway assertions hold")
