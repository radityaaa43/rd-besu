#!/usr/bin/env python3
"""Offline check of stealth S17 gateway manifests (final-design/stealth/PLAN.md S17, stealth-address/k8s/S17.md).
Usage: check.py <render.sh>. Exit 0 = all assertions hold; 1 = failures on stderr. Needs PyYAML; no cluster."""
import os, subprocess, sys, tempfile, yaml

render = os.path.abspath(sys.argv[1])
PARTIES = {"bi": 1, "bank-a": 2, "bank-b": 3, "bank-c": 4}
ACL, CIDR = "acl-d9ji5nwbqutwulof33ydb", "8.215.62.92/32"
fails = []


def check(ok, msg):
    if not ok:
        fails.append(msg)


def run(*a):
    try:
        return subprocess.run([render, *a], capture_output=True, text=True)
    except FileNotFoundError as e:
        return subprocess.CompletedProcess(a, 127, "", str(e))


def docs(*a):
    r = run(*a)
    if r.returncode != 0:
        fails.append(f"render.sh {' '.join(a)} exited {r.returncode}: {r.stderr.strip()[:200]}")
        return []
    return [d for d in yaml.safe_load_all(r.stdout) if d]


def by(ds, kind, name):
    return next((d for d in ds if d["kind"] == kind and d["metadata"]["name"] == name), None)


def envoy(ds, n):
    cm = by(ds, "ConfigMap", f"st-gw-{n}-envoy")
    return yaml.safe_load(cm["data"]["envoy.yaml"]) if cm else {}


for p, n in PARTIES.items():
    ns = f"rd-stealth-{p}"
    ds = docs(p)
    check(ds and all(d["metadata"].get("namespace") == ns for d in ds), f"{p}: every object is in {ns}")
    check(not any(d["kind"] in ("Secret", "Namespace") for d in ds), f"{p}: no Secret/Namespace rendered (parties create secrets)")
    check("100.64" not in run(p).stdout, f"{p}: no CLB health element in the default render")
    env = envoy(ds, n)
    ls = {l["name"]: l for l in env.get("static_resources", {}).get("listeners", [])}
    sig = ls.get("signer", {})
    check(sig.get("address", {}).get("socket_address", {}).get("port_value") == 8550, f"{p}: listener signer on 8550")
    check([f["name"] for f in sig.get("listener_filters", [])] == ["envoy.filters.listener.tls_inspector"], f"{p}: tls_inspector listener filter")
    chains = sig.get("filter_chains", [])
    clusters = {c["name"]: c for c in env.get("static_resources", {}).get("clusters", [])}
    default = [c for c in chains if "filter_chain_match" not in c]
    check(len(default) == 1, f"{p}: exactly one default (TLS-terminating) chain")
    if default:
        ts = default[0]["transport_socket"]["typed_config"]
        check(ts["require_client_certificate"] is True, f"{p}: default chain requires a client cert")
        hcm = default[0]["filters"][0]["typed_config"]
        check(hcm.get("forward_client_cert_details") == "SANITIZE_SET" and hcm.get("set_current_client_cert_details") == {"cert": True}, f"{p}: the Lensa door must forward the verified client leaf (SANITIZE_SET, cert: true): bi.caller verifies it")
        ea = next(f for f in hcm["http_filters"] if f["name"] == "envoy.filters.http.ext_authz")["typed_config"]
        check(ea["failure_mode_allow"] is False, f"{p}: ext_authz fails closed")
        route = hcm["route_config"]["virtual_hosts"][0]["routes"]
        check(len(route) == 1 and route[0]["route"]["cluster"] == "signer", f"{p}: HTTP door routes only to cluster signer")
    sn = f"stealth-signer.{ns}.svc.cluster.local"
    check(clusters.get("signer", {}).get("load_assignment", {}).get("endpoints", [{}])[0].get("lb_endpoints", [{}])[0].get("endpoint", {}).get("address", {}).get("socket_address") == {"address": sn, "port_value": 8080}, f"{p}: cluster signer -> {sn}:8080")
    check("opa" in clusters, f"{p}: cluster opa")
    pas = [c for c in chains if "filter_chain_match" in c]
    if p == "bi":
        check(len(pas) == 1, "bi: one SNI passthrough chain")
        if pas:
            c = pas[0]
            check(c["filter_chain_match"]["server_names"] == ["custodian-1"], "bi: passthrough matches server_names [custodian-1]")
            check("transport_socket" not in c, "bi: passthrough chain does NOT terminate TLS")
            check([f["name"] for f in c["filters"]] == ["envoy.filters.network.tcp_proxy"] and c["filters"][0]["typed_config"]["cluster"] == "custodian", "bi: passthrough is tcp_proxy to cluster custodian")
        check(clusters.get("custodian", {}).get("load_assignment", {}).get("endpoints", [{}])[0].get("lb_endpoints", [{}])[0].get("endpoint", {}).get("address", {}).get("socket_address") == {"address": "stealth-custodian.rd-stealth-bi.svc.cluster.local", "port_value": 9443}, "bi: cluster custodian -> stealth-custodian:9443")
        cs = by(ds, "Service", "stealth-custodian")
        check(cs and cs["spec"].get("type", "ClusterIP") == "ClusterIP" and cs["spec"]["selector"] == {"app": "stealth-signer", "role": "custodian"} and cs["spec"]["ports"][0]["port"] == 9443, "bi: Service stealth-custodian ClusterIP 9443, selector role custodian")
        cin = by(ds, "NetworkPolicy", "stealth-custodian-ingress")
        check(cin and cin["spec"]["podSelector"]["matchLabels"] == {"app": "stealth-signer", "role": "custodian"} and cin["spec"]["ingress"] == [{"from": [{"podSelector": {"matchLabels": {"app": "st-gw"}}}], "ports": [{"protocol": "TCP", "port": 9443}]}], "bi: custodian ingress only from app=st-gw on 9443")
    else:
        check(not pas and "custodian" not in clusters and by(ds, "Service", "stealth-custodian") is None, f"{p}: no passthrough, no custodian cluster/Service")
    gw = by(ds, "Service", f"st-gw-{n}")
    check(gw and gw["spec"].get("type", "ClusterIP") == "ClusterIP" and gw["spec"]["selector"] == {"app": "st-gw"} and gw["spec"]["ports"][0]["port"] == 8550, f"{p}: Service st-gw-{n} ClusterIP 8550")
    check(by(ds, "Service", f"st-gw-{n}-ext") is None, f"{p}: no external Service by default (no NodePort, no LoadBalancer)")
    sin = by(ds, "NetworkPolicy", "stealth-signer-ingress")
    # S11 live 2026-11-13: a bank's own viewpush Job reads its signer's /meta-address (public) before the push; BI has no viewpush
    src = [{"podSelector": {"matchLabels": {"app": "st-gw"}}}] + ([] if p == "bi" else [{"podSelector": {"matchLabels": {"app": "stealth-viewpush", "role": "viewpush"}}}])
    check(bool(sin) and sin["spec"]["ingress"] == [{"from": src, "ports": [{"protocol": "TCP", "port": 8080}]}]
          and sin["spec"]["podSelector"] == {"matchLabels": {"app": "stealth-signer"}, "matchExpressions": [{"key": "role", "operator": "In", "values": ["bank", "bi"]}]}, f"{p}: signer ingress only from st-gw (+ own viewpush Job for banks) on 8080")
    gin = by(ds, "NetworkPolicy", "st-gw-ingress")
    check(gin and gin["spec"]["podSelector"]["matchLabels"] == {"app": "st-gw"} and gin["spec"]["ingress"] == [{"ports": [{"protocol": "TCP", "port": 8550}]}], f"{p}: st-gw-ingress 8550 from any source (mTLS is the gate)")
    # envoy subcommand = the same config, bare
    r = run("envoy", p)
    check(r.returncode == 0 and yaml.safe_load(r.stdout) == env, f"{p}: `envoy {p}` equals the ConfigMap content")

# Deployment, OPA config, bundle access (S17 second half)
KEYID = {"bi": "bi", "bank-a": "bank-a", "bank-b": "bank-b", "bank-c": "bank-c"}
repo = os.path.abspath(os.path.join(os.path.dirname(render), "..", "..", ".."))
with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
    f.write(open(os.path.join(repo, "opa", "opa.yaml")).read() + "keys:\n  bi:\n    algorithm: RS256\n    key: |\n      PUBKEY-FIXTURE\n")
    cfg = f.name
for p, n in PARTIES.items():
    ns = f"rd-stealth-{p}"
    ds = docs(p, "--opa-config", cfg)
    dep = by(ds, "Deployment", f"st-gw-{n}")
    check(dep is not None, f"{p}: Deployment st-gw-{n}")
    if dep:
        pod = dep["spec"]["template"]["spec"]
        check(dep["spec"]["selector"]["matchLabels"] == {"app": "st-gw", "node": f"node{n}"} and dep["spec"]["template"]["metadata"]["labels"] == {"app": "st-gw", "node": f"node{n}", "rd/egress-locked": "true", "rd/egress": "st-gw"}, f"{p}: pod labels app=st-gw,node=node{n} (selected by the Services and policies) + rd/egress-locked=true + rd/egress=st-gw")
        cs = {c["name"]: c for c in pod["containers"]}
        check(set(cs) == {"envoy", "opa"}, f"{p}: containers envoy + opa")
        args = cs["opa"]["args"]
        for a in (f"--set=labels.gateway=st-gw-{n}", "--set=bundles.bi.resource=bi/latest.tar.gz", "--set=bundles.bank.resource=bank/latest.tar.gz", f"--set=bundles.bank.signing.keyid={KEYID[p]}", "--config-file=/config/opa.yaml", "--addr=localhost:8181", "--authorization=basic"):
            check(a in args, f"{p}: opa arg {a}")
        vols = {v["name"]: v for v in pod["volumes"]}
        check(vols["envoy"]["configMap"]["name"] == f"st-gw-{n}-envoy" and vols["opa"]["configMap"]["name"] == "st-gw-opa", f"{p}: ConfigMap volumes")
        check(vols["mtls"]["secret"]["secretName"] == f"st-gw-{n}-mtls" and vols["mtls"]["secret"]["optional"] is True, f"{p}: Secret st-gw-{n}-mtls mounted, optional (the party creates it)")
        check("sink-token" not in vols and not any("sink" in str(v) for v in vols.values()), f"{p}: no sink-token volume (no write path to a bundle-server sink)")
        check(pod["automountServiceAccountToken"] is False and pod["securityContext"]["runAsNonRoot"] is True, f"{p}: no SA token, non-root")
        check(all(c["securityContext"]["readOnlyRootFilesystem"] is True and c["securityContext"]["allowPrivilegeEscalation"] is False and c["securityContext"]["capabilities"] == {"drop": ["ALL"]} for c in cs.values()), f"{p}: hardened containers")
        check(cs["envoy"]["ports"][0]["containerPort"] == 8550, f"{p}: envoy port 8550")
    cm = by(ds, "ConfigMap", "st-gw-opa")
    oc = yaml.safe_load(cm["data"]["opa.yaml"]) if cm else {}
    check(oc.get("services", {}).get("bundle-server", {}).get("url") == f"http://bundle-server.rd-zeto-{p}", f"{p}: OPA pulls bundles from bundle-server.rd-zeto-{p}")
    check("sink" not in oc.get("services", {}) and "token_path" not in (cm["data"]["opa.yaml"] if cm else "") and "service" not in oc.get("decision_logs", {}) and "status" not in oc, f"{p}: OPA config has no sink service, no token, no status/decision-log service")
    check(oc.get("decision_logs", {}).get("console") is True and oc.get("plugins", {}).get("envoy_ext_authz_grpc", {}).get("path") == "gw/allow" and oc["plugins"]["envoy_ext_authz_grpc"].get("dry-run") is False, f"{p}: console decision logs, gw/allow, enforcing")
    check({"bi", "bank"} <= set(oc.get("bundles", {})) and "PUBKEY-FIXTURE" in str(oc.get("keys", {})), f"{p}: bundles bi/bank and the keys block from --opa-config survive")
    ba = docs("bundle-access", p)
    np_ = by(ba, "NetworkPolicy", "bundle-server-from-stealth")
    check(bool(np_) and np_["metadata"]["namespace"] == f"rd-zeto-{p}" and np_["spec"]["podSelector"]["matchLabels"] == {"app": "bundle-server"} and np_["spec"]["ingress"] == [{"from": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": ns}}, "podSelector": {"matchLabels": {"app": "st-gw"}}}], "ports": [{"protocol": "TCP", "port": 8080}]}], f"{p}: bundle-access: only st-gw of rd-stealth-{p} to bundle-server :8080 (not the 8081 sink)")
os.unlink(cfg)

# R1: one CLB for st-gw-1, existing ACL id only, annotations in the first apply
ds = docs("bi", "--acl-id", ACL, "--external-cidr", CIDR)
ext = by(ds, "Service", "st-gw-1-ext")
check(ext is not None, "bi + flags: Service st-gw-1-ext")
if ext:
    a = ext["metadata"].get("annotations", {})
    pre = "service.beta.kubernetes.io/alibaba-cloud-loadbalancer-"
    check(ext["spec"]["type"] == "LoadBalancer" and ext["spec"]["externalTrafficPolicy"] == "Cluster", "ext: LoadBalancer, externalTrafficPolicy Cluster")
    check(a.get(pre + "acl-status") == "on" and a.get(pre + "acl-type") == "white" and a.get(pre + "acl-id") == ACL, "ext: ACL annotations on the Service itself (first apply)")
    check(not any(k.endswith(("loadbalancer-id", "force-override-listeners")) for k in a), "ext: no loadbalancer-id (new CLB, never a shared one)")
    check(ext["spec"]["loadBalancerSourceRanges"] == [CIDR] and ext["spec"]["selector"] == {"app": "st-gw"} and [p["port"] for p in ext["spec"]["ports"]] == [8550], "ext: source range, selector app=st-gw, port 8550")
# S17 2026-11-13: bank-c's st-gw-4 is in cluster 2; the Lensa pod (cluster 1) reaches it through its own CLB, cluster-2 ACL id, cluster-1 egress CIDR
ACL2, CIDR1 = "acl-gs5m5o9vb3olr19484tyg", "8.215.62.92/32"
ext4 = by(docs("bank-c", "--acl-id", ACL2, "--external-cidr", CIDR1), "Service", "st-gw-4-ext")
check(ext4 is not None and ext4["metadata"]["namespace"] == "rd-stealth-bank-c" and ext4["spec"]["type"] == "LoadBalancer"
      and ext4["metadata"]["annotations"].get("service.beta.kubernetes.io/alibaba-cloud-loadbalancer-acl-id") == ACL2
      and ext4["spec"]["loadBalancerSourceRanges"] == [CIDR1] and [p["port"] for p in ext4["spec"]["ports"]] == [8550], "bank-c + flags: Service st-gw-4-ext (own CLB, ACL, source range, 8550)")
for bad in (["bank-a", "--acl-id", ACL, "--external-cidr", CIDR], ["bank-b", "--acl-id", ACL, "--external-cidr", CIDR], ["bi", "--acl-id", ACL], ["bi", "--external-cidr", CIDR], ["bi", "--acl-id", "x", "--external-cidr", CIDR], ["bi", "--acl-id", ACL, "--external-cidr", "nope"], ["nope"], ["envoy", "nope"], ["bundle-access", "nope"], ["bi", "--opa-config", "/nonexistent"]):
    check(run(*bad).returncode != 0, f"refused: {' '.join(bad)}")

# S11 rework (B1/B2): bi only, --signer-ca adds the viewcopy-1 chain (bank-signer CA, OPA target stealth_viewcopy, body never sent to OPA); nothing else changes
PEM = "-----BEGIN CERTIFICATE-----\nZHVtbXktcHVibGljLWNhLWZpeHR1cmU=\n-----END CERTIFICATE-----\n"  # dummy, no real key
with tempfile.NamedTemporaryFile("w", suffix=".crt", delete=False) as f:
    f.write(PEM)
    signer_ca = f.name
base = docs("bi")
vc = docs("bi", "--signer-ca", signer_ca)
env0, env1 = envoy(base, 1), envoy(vc, 1)
ch0 = env0.get("static_resources", {}).get("listeners", [{}])[0].get("filter_chains", [])
ch1 = env1.get("static_resources", {}).get("listeners", [{}])[0].get("filter_chains", [])
check(len(ch1) == len(ch0) + 1, "bi + --signer-ca: exactly one more filter chain")
new_c = [c for c in ch1 if c.get("filter_chain_match", {}).get("server_names") == ["viewcopy-1"]]
check(len(new_c) == 1, "bi + --signer-ca: one chain with server_names [viewcopy-1]")
check([c for c in ch1 if c not in new_c] == ch0, "bi + --signer-ca: the custodian passthrough chain and the Lensa default chain are unchanged")
if new_c:
    c = new_c[0]
    ts = c["transport_socket"]["typed_config"]
    check(ts["require_client_certificate"] is True, "viewcopy chain requires a client cert")
    vctx = ts["common_tls_context"]["validation_context"]["trusted_ca"]["filename"]
    check(vctx == "/signer-ca/ca.crt" and vctx != "/mtls/ca.crt", f"viewcopy chain trusts the bank-signer CA file, not the Lensa CA: {vctx}")
    check(ts["common_tls_context"]["tls_certificates"] == [{"certificate_chain": {"filename": "/mtls/tls.crt"}, "private_key": {"filename": "/mtls/tls.key"}}], "viewcopy chain presents the same server cert as the default chain")
    check(ts["common_tls_context"]["tls_params"] == {"tls_minimum_protocol_version": "TLSv1_2"}, "viewcopy chain: TLS >= 1.2")
    hcm = c["filters"][0]["typed_config"]
    rts = hcm["route_config"]["virtual_hosts"][0]["routes"]
    check(len(rts) == 1 and rts[0]["match"] == {"prefix": "/viewcopy/"}, f"viewcopy chain: ONE route, prefix /viewcopy/ only: {rts}")
    if rts:
        r0 = rts[0]
        check(r0["route"]["cluster"] == "signer" and float(r0["route"]["timeout"].rstrip("s")) <= 10, f"viewcopy route -> cluster signer, timeout <= 10s: {r0['route']}")
        cs = r0["typed_per_filter_config"]["envoy.filters.http.ext_authz"]["check_settings"]
        check(cs["context_extensions"] == {"target": "stealth_viewcopy", "node": "node1"} and cs["disable_request_body_buffering"] is True, f"viewcopy route: target stealth_viewcopy, node node1, request body NOT buffered for OPA: {cs}")
    ea = next(f for f in hcm["http_filters"] if f["name"] == "envoy.filters.http.ext_authz")["typed_config"]
    check(ea["failure_mode_allow"] is False and "with_request_body" not in ea and ea["grpc_service"]["envoy_grpc"]["cluster_name"] == "opa", "viewcopy chain: ext_authz fails closed, no with_request_body at all, same opa cluster")
    check(hcm["http_filters"][-1]["name"] == "envoy.filters.http.router", "viewcopy chain: router last")
check({k: v for k, v in env1.get("static_resources", {}).items() if k != "listeners"} == {k: v for k, v in env0.get("static_resources", {}).items() if k != "listeners"} and bool(env1), "bi + --signer-ca: clusters unchanged (no new upstream; the existing signer cluster is reused)")
cm = by(vc, "ConfigMap", "st-gw-1-signer-ca")
check(cm is not None and cm["metadata"]["namespace"] == "rd-stealth-bi" and cm["data"] == {"ca.crt": PEM}, "bi + --signer-ca: ConfigMap st-gw-1-signer-ca in rd-stealth-bi holds the file content as ca.crt")
check(by(base, "ConfigMap", "st-gw-1-signer-ca") is None, "bi without the option: no st-gw-1-signer-ca ConfigMap")
dep0, dep1 = by(base, "Deployment", "st-gw-1"), by(vc, "Deployment", "st-gw-1")
if dep0 and dep1:
    pod1 = dep1["spec"]["template"]["spec"]
    check({v["name"]: v for v in pod1["volumes"]}.get("signer-ca") == {"name": "signer-ca", "configMap": {"name": "st-gw-1-signer-ca"}}, "bi + --signer-ca: volume signer-ca from the ConfigMap")
    check({"name": "signer-ca", "mountPath": "/signer-ca", "readOnly": True} in pod1["containers"][0]["volumeMounts"], "bi + --signer-ca: envoy mounts /signer-ca read-only")
    strip = lambda d: [dict(v) for v in d["spec"]["template"]["spec"]["volumes"] if v["name"] != "signer-ca"]
    check(strip(dep1) == dep0["spec"]["template"]["spec"]["volumes"] and not any("signer-ca" in str(x) for x in dep0["spec"]["template"]["spec"]["volumes"]), "bi without the option: no signer-ca volume")
    check(pod1["containers"][1] == dep0["spec"]["template"]["spec"]["containers"][1], "bi + --signer-ca: the OPA container is unchanged")
names = lambda ds: sorted((d["kind"], d["metadata"]["name"]) for d in ds)
check([n for n in names(vc) if n not in names(base)] == [("ConfigMap", "st-gw-1-signer-ca")], "bi + --signer-ca: the ONLY new object is ConfigMap st-gw-1-signer-ca (no new Service/LB/NetworkPolicy)")
rest = lambda ds: [d for d in ds if (d["kind"], d["metadata"]["name"]) not in {("ConfigMap", "st-gw-1-envoy"), ("ConfigMap", "st-gw-1-signer-ca"), ("Deployment", "st-gw-1")}]
check(bool(vc) and rest(vc) == rest(base), "bi + --signer-ca: every other object is unchanged")
vx = docs("bi", "--signer-ca", signer_ca, "--acl-id", ACL, "--external-cidr", CIDR)
check(by(vx, "Service", "st-gw-1-ext") == by(docs("bi", "--acl-id", ACL, "--external-cidr", CIDR), "Service", "st-gw-1-ext") and by(vx, "ConfigMap", "st-gw-1-signer-ca") is not None, "--signer-ca composes with --acl-id/--external-cidr (same st-gw-1-ext)")
for p in ("bank-a", "bank-b", "bank-c"):
    check("viewcopy" not in run(p).stdout and "signer-ca" not in run(p).stdout, f"{p}: no viewcopy chain and no signer-ca volume in the bank render")
    check(run(p, "--signer-ca", signer_ca).returncode != 0, f"refused: {p} --signer-ca (bi only)")
envsub = run("envoy", "bi", "--signer-ca", signer_ca)
check(envsub.returncode == 0 and yaml.safe_load(envsub.stdout) == env1, "`envoy bi --signer-ca FILE` equals the ConfigMap content")
bad_key = tempfile.NamedTemporaryFile("w", suffix=".pem", delete=False); bad_key.write(PEM + "-----BEGIN PRIV" + "ATE KEY-----\nAAAA\n-----END PRIV" + "ATE KEY-----\n"); bad_key.close()
not_pem = tempfile.NamedTemporaryFile("w", suffix=".pem", delete=False); not_pem.write("hello\n"); not_pem.close()
for bad in (["bi", "--signer-ca", "/nonexistent"], ["bi", "--signer-ca", bad_key.name], ["bi", "--signer-ca", not_pem.name], ["bi", "--signer-ca"]):
    check(run(*bad).returncode != 0, f"refused: {' '.join(bad[:2])} {'(' + bad[2].split('/')[-1] + ')' if len(bad) > 2 else ''}".strip())
for fn in (signer_ca, bad_key.name, not_pem.name):
    os.unlink(fn)

# analyst condition 3 (R32): st-gw admits only the rd-lensa pods with role=flow on its Lensa door (bank gateways). st-gw-1 (bi) ALSO serves the bank signers (custodian / viewcopy chains)
# on the same port, so the option is refused there until that second source set is ruled.
def stingress(p, *args):
    ds = docs(p, *args)
    return {d["metadata"]["name"]: d for d in ds if d["kind"] == "NetworkPolicy"}["st-gw-ingress"]["spec"]["ingress"]
for p in ("bank-a", "bank-b", "bank-c"):
    default = stingress(p)
    check(default == [{"ports": [{"protocol": "TCP", "port": 8550}]}], f"{p}: default st-gw-ingress unchanged (any source on 8550): {default}")
    ing = stingress(p, "--lensa-pod-role", "flow")
    check(ing == [{"from": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "rd-lensa"}}, "podSelector": {"matchLabels": {"role": "flow"}}}], "ports": [{"protocol": "TCP", "port": 8550}]}],
          f"{p}: --lensa-pod-role flow: 8550 only from rd-lensa role=flow pods: {ing}")
for bad in (["bank-a", "--lensa-pod-role", "server"], ["bank-a", "--lensa-pod-role", "flow", "--lensa-pod-role", "flow"], ["bi", "--lensa-pod-role", "flow"]):
    check(run(*bad).returncode != 0, f"refused: {' '.join(bad)}")

if fails:
    print("FAIL:\n- " + "\n- ".join(fails), file=sys.stderr)
    sys.exit(1)
print("ok: stealth gateway render checks passed")
