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

if fails:
    print("\n".join("FAIL: " + f for f in fails), file=sys.stderr)
    sys.exit(1)
print(f"ok: {len(PARTIES)} parties rendered and checked")
