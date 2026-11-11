#!/usr/bin/env python3
"""Offline check of stealth S17 gateway manifests (final-design/stealth/PLAN.md S17, stealth-address/k8s/S17.md).
Usage: check.py <render.sh>. Exit 0 = all assertions hold; 1 = failures on stderr. Needs PyYAML; no cluster."""
import os, subprocess, sys, yaml

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
    check(bool(sin) and sin["spec"]["ingress"] == [{"from": [{"podSelector": {"matchLabels": {"app": "st-gw"}}}], "ports": [{"protocol": "TCP", "port": 8080}]}]
          and sin["spec"]["podSelector"] == {"matchLabels": {"app": "stealth-signer"}, "matchExpressions": [{"key": "role", "operator": "In", "values": ["bank", "bi"]}]}, f"{p}: signer ingress only from st-gw on 8080")
    gin = by(ds, "NetworkPolicy", "st-gw-ingress")
    check(gin and gin["spec"]["podSelector"]["matchLabels"] == {"app": "st-gw"} and gin["spec"]["ingress"] == [{"ports": [{"protocol": "TCP", "port": 8550}]}], f"{p}: st-gw-ingress 8550 from any source (mTLS is the gate)")
    # envoy subcommand = the same config, bare
    r = run("envoy", p)
    check(r.returncode == 0 and yaml.safe_load(r.stdout) == env, f"{p}: `envoy {p}` equals the ConfigMap content")

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
for bad in (["bank-a", "--acl-id", ACL, "--external-cidr", CIDR], ["bi", "--acl-id", ACL], ["bi", "--external-cidr", CIDR], ["bi", "--acl-id", "x", "--external-cidr", CIDR], ["bi", "--acl-id", ACL, "--external-cidr", "nope"], ["nope"], ["envoy", "nope"]):
    check(run(*bad).returncode != 0, f"refused: {' '.join(bad)}")

if fails:
    print("FAIL:\n- " + "\n- ".join(fails), file=sys.stderr)
    sys.exit(1)
print("ok: stealth gateway render checks passed")
