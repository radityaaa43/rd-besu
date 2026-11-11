#!/usr/bin/env python3
"""Offline check of the rendered zeto S17 bundle-server manifests (final-design/zeto/PLAN.md S17: bundle-server per party namespace).
Usage: check.py <render.sh>   Exit 0 = all assertions hold; 1 = list of failures on stderr. Needs PyYAML only; no cluster."""
import os, subprocess, sys, yaml

render = sys.argv[1]
here = os.path.dirname(os.path.abspath(__file__))
NGINX = open(os.path.join(here, "..", "..", "..", "..", "opa", "bundle-server", "nginx.conf")).read()
IMG = "registry.example/bundle-server@sha256:" + "0" * 64
# party -> (PARTY_BUNDLE, signing key id): BI's server signs `bi` and `bank` (node 1's bank bundle is BI's, key bi: opa/keys.sh:2)
PARTIES = {"bi": ("bi,bank", "bi"), "bank-a": ("bank", "bank-a"), "bank-b": ("bank", "bank-b"), "bank-c": ("bank", "bank-c")}
fails = []


def check(ok, msg):
    if not ok:
        fails.append(msg)


def run(*args):
    return subprocess.run([render, *args], capture_output=True, text=True)


def docs(*args):
    out = run(*args)
    if out.returncode != 0:
        fails.append(f"render.sh {' '.join(args)} exited {out.returncode}: {out.stderr.strip()[:200]}")
        return []
    return [d for d in yaml.safe_load_all(out.stdout) if d]


for party, (own, keyid) in PARTIES.items():
    ns = f"rd-zeto-{party}"
    args = [party, "--sink-image", IMG] + (["--storage-class", "csi-x"] if party == "bank-c" else [])
    ds = docs(*args)
    check(bool(ds), f"{party}: no objects rendered")
    if not ds:
        continue
    check(sorted(d["kind"] for d in ds) == ["ConfigMap", "Deployment", "NetworkPolicy", "PersistentVolumeClaim", "Service"], f"{party}: kinds {sorted(d['kind'] for d in ds)} (no Secret, no cluster-scoped object)")
    for d in ds:
        check(d["metadata"].get("namespace") == ns, f"{party}: {d['kind']}/{d['metadata']['name']} not in {ns}")
    by = {d["kind"]: d for d in ds}
    if len(by) != len(ds):
        continue

    pvc = by["PersistentVolumeClaim"]
    check(pvc["metadata"]["name"] == "bundle-store" and pvc["spec"]["resources"]["requests"]["storage"] == "1Gi" and pvc["spec"]["accessModes"] == ["ReadWriteOnce"], f"{party}: PVC bundle-store 1Gi RWO: {pvc['spec']}")
    check(pvc["spec"].get("storageClassName") == ("csi-x" if party == "bank-c" else None), f"{party}: storageClassName {pvc['spec'].get('storageClassName')!r}")

    dep = by["Deployment"]
    check(dep["metadata"]["name"] == "bundle-server" and dep["spec"]["replicas"] == 1 and dep["spec"]["strategy"] == {"type": "Recreate"}, f"{party}: bundle-server, 1 replica, Recreate (RWO volume cannot be attached twice)")
    pod = dep["spec"]["template"]["spec"]
    check(dep["spec"]["selector"]["matchLabels"] == {"app": "bundle-server"} and dep["spec"]["template"]["metadata"]["labels"] == {"app": "bundle-server"}, f"{party}: selector/labels app=bundle-server")
    sc = pod.get("securityContext", {})
    check(sc.get("runAsNonRoot") is True and sc.get("runAsUser") == 10001 and sc.get("fsGroup") == 10001, f"{party}: pod must run as 10001 non-root with fsGroup 10001 (PVC and key readable)")
    cs = {c["name"]: c for c in pod["containers"]}
    check(set(cs) == {"nginx", "sink"}, f"{party}: containers {sorted(cs)}")
    if set(cs) != {"nginx", "sink"}:
        continue
    for c in cs.values():
        s = c["securityContext"]
        check(s.get("allowPrivilegeEscalation") is False and s.get("readOnlyRootFilesystem") is True and s["capabilities"] == {"drop": ["ALL"]}, f"{party}: {c['name']} securityContext")
    check(cs["sink"]["image"] == IMG, f"{party}: sink image must be the --sink-image value")
    env = {e["name"]: e.get("value") for e in cs["sink"]["env"]}
    want = {"PARTY_BUNDLE": own, "SIGNING_KEYID": keyid, "SIGNING_KEY_FILE": "/signing/key.pem", "BUNDLE_STORE": "/bundle-store", "SINK_TOKEN_FILE": "/sink-token/token", "MAX_BUNDLE_BYTES": "10485760"}
    for k, v in want.items():
        check(env.get(k) == v, f"{party}: env {k}={env.get(k)!r}, want {v!r}")
    check(not any("valueFrom" in e for e in cs["sink"]["env"]), f"{party}: no secret value in env (files only)")
    vols = {v["name"]: v for v in pod["volumes"]}
    check(vols.get("bundle-store", {}).get("persistentVolumeClaim") == {"claimName": "bundle-store"}, f"{party}: volume bundle-store must be the PVC")
    check(vols.get("signing", {}).get("secret", {}).get("secretName") == f"opa-bundle-signing-{party}" and not vols["signing"]["secret"].get("optional"), f"{party}: signing volume = Secret opa-bundle-signing-{party}, not optional")
    check(vols.get("signing", {}).get("secret", {}).get("defaultMode") == 0o440, f"{party}: signing key mode 0440 (fsGroup reads it, no other)")
    check(vols.get("sink-token", {}).get("secret", {}).get("secretName") == "bundle-sink-token" and not vols["sink-token"]["secret"].get("optional"), f"{party}: sink-token volume = Secret sink-token, not optional")
    check(not any("configMap" in v and v["configMap"]["name"].endswith("-bundles") for v in vols.values()), f"{party}: no ConfigMap bundle mounts any more")
    mounts = lambda n: {m["mountPath"]: m for m in cs[n]["volumeMounts"]}
    check(mounts("sink").get("/bundle-store", {}).get("name") == "bundle-store" and not mounts("sink")["/bundle-store"].get("readOnly"), f"{party}: sink writes /bundle-store")
    check(mounts("nginx").get("/srv", {}).get("name") == "bundle-store" and mounts("nginx")["/srv"].get("readOnly") is True, f"{party}: nginx serves the PVC read-only at /srv")
    check("/signing" not in mounts("nginx"), f"{party}: nginx must not see the signing key")
    check(mounts("sink").get("/signing", {}).get("readOnly") is True, f"{party}: sink mounts the key read-only")
    check(vols.get("conf", {}).get("configMap", {}).get("name") == "bundle-server-conf", f"{party}: nginx conf from ConfigMap bundle-server-conf")

    cm = by["ConfigMap"]
    check(cm["metadata"]["name"] == "bundle-server-conf" and cm["data"].get("nginx.conf") == NGINX, f"{party}: ConfigMap nginx.conf must equal opa/bundle-server/nginx.conf")

    svc = by["Service"]
    check(svc["metadata"]["name"] == "bundle-server" and svc["spec"].get("type", "ClusterIP") == "ClusterIP" and svc["spec"]["selector"] == {"app": "bundle-server"}, f"{party}: Service ClusterIP bundle-server")
    check([(p["port"], p["targetPort"]) for p in svc["spec"]["ports"]] == [(80, 8080), (8081, 8081)], f"{party}: Service ports 80->8080, 8081")

    np = by["NetworkPolicy"]["spec"]
    check(np["podSelector"] == {"matchLabels": {"app": "bundle-server"}} and np["policyTypes"] == ["Ingress"], f"{party}: NetworkPolicy selects bundle-server, Ingress")
    ing = np["ingress"]
    check(len(ing) == 1 and ing[0]["from"] == [{"podSelector": {"matchLabels": {"app": "bank-gw"}}}], f"{party}: ingress only from app=bank-gw of this ns (no namespaceSelector, no ipBlock): {ing}")
    check(ing and [p["port"] for p in ing[0]["ports"]] == [8080, 8081], f"{party}: ingress ports 8080, 8081")

# fabricx-access <party>: the S16 gateway fx-gw-<N> of rd-fabricx-<party> reads the signed bundles (port 8080 only, never the 8081 sink)
for n, party in enumerate(PARTIES, 1):
    ds = docs("fabricx-access", party)
    check(len(ds) == 1 and ds[0]["kind"] == "NetworkPolicy", f"fabricx-access {party}: exactly one NetworkPolicy, got {[d['kind'] for d in ds]}")
    if len(ds) != 1:
        continue
    d = ds[0]
    check(d["metadata"]["name"] == "bundle-server-from-fabricx" and d["metadata"].get("namespace") == f"rd-zeto-{party}", f"fabricx-access {party}: name/namespace {d['metadata']}")
    sp = d["spec"]
    check(sp["podSelector"] == {"matchLabels": {"app": "bundle-server"}} and sp["policyTypes"] == ["Ingress"], f"fabricx-access {party}: selects bundle-server, Ingress only")
    frm = [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": f"rd-fabricx-{party}"}}, "podSelector": {"matchLabels": {"app.kubernetes.io/name": f"fx-gw-{n}"}}}]
    check(len(sp["ingress"]) == 1 and sp["ingress"][0]["from"] == frm, f"fabricx-access {party}: one source, namespace rd-fabricx-{party} AND pod app.kubernetes.io/name=fx-gw-{n}: {sp['ingress']}")
    check(sp["ingress"] and sp["ingress"][0]["ports"] == [{"protocol": "TCP", "port": 8080}], f"fabricx-access {party}: TCP 8080 only (never the 8081 sink): {sp['ingress']}")
    check("8081" not in run("fabricx-access", party).stdout, f"fabricx-access {party}: 8081 must not appear")
check(run("fabricx-access", "bank-d").returncode == 2, "fabricx-access with an unknown party must fail with 2")
check(run("fabricx-access").returncode == 2, "fabricx-access without a party must fail with 2")

# iroha3-access <party>: the iroha3 gateway (app.kubernetes.io/name=gateway) of rd-iroha3-<party> reads the signed bundles (8080 only, never the 8081 sink)
for party in PARTIES:
    ds = docs("iroha3-access", party)
    check(len(ds) == 1 and ds[0]["kind"] == "NetworkPolicy", f"iroha3-access {party}: exactly one NetworkPolicy, got {[d['kind'] for d in ds]}")
    if len(ds) != 1:
        continue
    d = ds[0]
    check(d["metadata"]["name"] == "bundle-server-from-iroha3" and d["metadata"].get("namespace") == f"rd-zeto-{party}", f"iroha3-access {party}: name/namespace {d['metadata']}")
    check(d["metadata"].get("labels") == {"app": "bundle-server", "part-of": "rd-iroha3"}, f"iroha3-access {party}: labels {d['metadata'].get('labels')}")
    sp = d["spec"]
    check(sp["podSelector"] == {"matchLabels": {"app": "bundle-server"}} and sp["policyTypes"] == ["Ingress"], f"iroha3-access {party}: selects bundle-server, Ingress only")
    frm = [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": f"rd-iroha3-{party}"}}, "podSelector": {"matchLabels": {"app.kubernetes.io/name": "gateway"}}}]
    check(len(sp["ingress"]) == 1 and sp["ingress"][0]["from"] == frm, f"iroha3-access {party}: one source, namespace rd-iroha3-{party} AND pod app.kubernetes.io/name=gateway: {sp['ingress']}")
    check(sp["ingress"] and sp["ingress"][0]["ports"] == [{"protocol": "TCP", "port": 8080}], f"iroha3-access {party}: TCP 8080 only (never the 8081 sink): {sp['ingress']}")
    check("8081" not in run("iroha3-access", party).stdout, f"iroha3-access {party}: 8081 must not appear")
check(run("iroha3-access", "bank-d").returncode == 2, "iroha3-access with an unknown party must fail with 2")
check(run("iroha3-access").returncode == 2, "iroha3-access without a party must fail with 2")

# arguments
pull = docs("bi", "--sink-image", IMG, "--pull-secret", "ghcr-pull")
pod = [d for d in pull if d["kind"] == "Deployment"][0]["spec"]["template"]["spec"]
check(pod.get("imagePullSecrets") == [{"name": "ghcr-pull"}], f"--pull-secret must set imagePullSecrets: {pod.get('imagePullSecrets')}")
nopull = [d for d in docs("bi", "--sink-image", IMG) if d["kind"] == "Deployment"][0]["spec"]["template"]["spec"]
check("imagePullSecrets" not in nopull, "no imagePullSecrets without --pull-secret")
check(run("bi", "--sink-image", IMG, "--pull-secret", "Bad Name").returncode == 2, "invalid pull secret name must fail with 2")
check(run("bank-c", "--sink-image", IMG).returncode == 2, "bank-c without --storage-class must fail with 2 (cluster 2 has no default class)")
check(run("bi", "--sink-image", IMG, "--storage-class", "x").returncode == 0, "cluster 1 party may pass --storage-class")
check(run("bi").returncode == 2, "--sink-image is required (the stock python image has no opa)")
check(run("bank-d", "--sink-image", IMG).returncode == 2, "unknown party must fail with 2")
check(run("bi", "--sink-image", "bad image").returncode == 2, "sink image with a space must fail with 2")
check(run("bi", "--sink-image", IMG, "--storage-class", "A_b").returncode == 2, "invalid storage class name must fail with 2")
check(run().returncode == 2, "no argument must fail with 2")

# Service `bundle-server` exposes 80 -> 8080 (bundles) and 8081 -> 8081 (sink): a client URL with the pod port 8080 has no Service port and fails.
# NetworkPolicies use 8080 on purpose (they see the pod port); URLs never may. Scan every file of this repo that can carry a bundle-server URL.
import re
root = os.path.abspath(os.path.join(here, "..", "..", "..", ".."))
bad_url = re.compile(r"bundle-server[\w.-]*:8080")
for top in ("zeto", "opa", "stealth-address"):
    for dp, dn, fn in os.walk(os.path.join(root, top)):
        dn[:] = [d for d in dn if d not in ("node_modules", ".git")]
        for f in fn:
            if f == "check.py" or not f.endswith((".sh", ".yaml", ".yml", ".md", ".rego", ".json", ".py", ".ts", ".conf")):
                continue
            path = os.path.join(dp, f)
            for i, line in enumerate(open(path, errors="ignore"), 1):
                check(not bad_url.search(line), f"{os.path.relpath(path, root)}:{i}: bundle-server URL with the pod port 8080 (Service ports are 80 and 8081)")
# Standing lesson (S21 attempt 1: ImagePullBackOff): an image from ghcr.io is private for this account, so the render REFUSES it without --pull-secret,
# and with one every pod spec of the Deployment carries imagePullSecrets.
GH = "ghcr.io/radityaaa43/rd-bundle-server@sha256:" + "0" * 64
check(run("bi", "--sink-image", GH).returncode == 2, "ghcr.io --sink-image without --pull-secret must fail with 2")
gh = run("bi", "--sink-image", GH, "--pull-secret", "ghcr-pull")
check(gh.returncode == 0 and "imagePullSecrets" in gh.stdout and "name: ghcr-pull" in gh.stdout, "ghcr.io --sink-image with --pull-secret ghcr-pull must render imagePullSecrets")

if fails:
    print("\n".join("FAIL: " + f for f in fails), file=sys.stderr)
    sys.exit(1)
print(f"ok: {len(PARTIES)} parties rendered and checked")
