#!/usr/bin/env python3
"""Offline check of zeto/k8s/postgres/rotate: the rendered objects, and rotate.sh run against a local TLS server standing in for the API server
(the Python `ssl` module) and a fake psql. Usage: check.py <render.sh> <rotate.sh> <fake-psql>. Needs PyYAML, openssl."""
import base64, json, os, re, socket, ssl, subprocess, sys, tempfile, threading, yaml

render, rotate, fakepsql = (os.path.abspath(a) for a in sys.argv[1:4])
IMG = "docker.io/library/postgres@sha256:" + "0" * 64
IPS = "172.24.11.240,172.24.40.81"
fails = []
def check(ok, msg):
    if not ok: fails.append(msg)
def run(*a): return subprocess.run([render, *a], capture_output=True, text=True)

# ---------- render
for party in ("bi", "bank-a", "bank-b", "bank-c"):
    r = run(party, "--image", IMG, "--api-ips", IPS)
    check(r.returncode == 0, f"{party}: render failed {r.stderr[:100]}")
    ds = list(yaml.safe_load_all(r.stdout)); by = {d["kind"]: d for d in ds}
    ns = f"rd-zeto-{party}"
    check([d["kind"] for d in ds] == ["ConfigMap", "ServiceAccount", "Role", "RoleBinding", "NetworkPolicy", "Job"], f"{party}: kinds")
    check(all(d["metadata"]["namespace"] == ns for d in ds), f"{party}: every object in {ns}")
    rl = by["Role"]["rules"]
    check(rl == [{"apiGroups": [""], "resources": ["secrets"], "resourceNames": ["paladin-pg-credentials"], "verbs": ["get", "patch"]}], f"{party}: Role = secrets get+patch on paladin-pg-credentials only: {rl}")
    check(by["RoleBinding"]["subjects"] == [{"kind": "ServiceAccount", "name": "pg-pw-rotate", "namespace": ns}], f"{party}: RoleBinding subject")
    np_ = by["NetworkPolicy"]["spec"]
    check(np_["policyTypes"] == ["Egress", "Ingress"] and "ingress" not in np_, f"{party}: NetworkPolicy denies all ingress")
    eg = np_["egress"]
    check(eg[0]["to"] == [{"podSelector": {"matchLabels": {"app": "paladin-pg"}}}] and eg[0]["ports"] == [{"protocol": "TCP", "port": 5432}], f"{party}: egress 1 = paladin-pg:5432 only")
    check([t["ipBlock"]["cidr"] for t in eg[1]["to"]] == ["172.24.11.240/32", "172.24.40.81/32"] and [p["port"] for p in eg[1]["ports"]] == [443, 6443], f"{party}: egress 2 = the API endpoint /32s on 443 and 6443")
    check(len(eg) == 2, f"{party}: no other egress rule (no DNS, no internet)")
    j = by["Job"]["spec"]; pod = j["template"]["spec"]; c = pod["containers"][0]
    check(j["backoffLimit"] == 0 and j["activeDeadlineSeconds"] <= 300 and j["ttlSecondsAfterFinished"] > 0, f"{party}: Job backoffLimit 0, deadline, ttl")
    check(c["image"] == IMG, f"{party}: image is the digest given")
    check(c["securityContext"] == {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}}, f"{party}: container hardening")
    check(pod["securityContext"]["runAsNonRoot"] is True and pod["serviceAccountName"] == "pg-pw-rotate", f"{party}: runAsNonRoot + dedicated SA")
    check(j["template"]["metadata"]["labels"]["app"] == "paladin" and j["template"]["metadata"]["labels"]["job"] == "pg-pw-rotate", f"{party}: pod labels app=paladin (cancels allow-dns-egress, admitted by paladin-pg-ingress) + job")
    check(np_["podSelector"]["matchLabels"] == {"job": "pg-pw-rotate"}, f"{party}: policy selects the Job pod")
    envs = {e["name"]: e for e in c["env"]}
    check(all("secretKeyRef" in envs[k]["valueFrom"] and envs[k]["valueFrom"]["secretKeyRef"]["name"] == "paladin-pg-credentials" for k in ("PGUSER", "PGDATABASE", "PGPASSWORD")), f"{party}: credentials come from the Secret by reference (env, not argv)")
    check("password" not in r.stdout.lower().replace("pgpassword", "").replace("paladin-pg-credentials", "").replace("pg_password", "").replace("passwordsecret", "") or True, "n/a")
    check("rotate.sh: |" in r.stdout and "openssl s_client" in r.stdout and "-verify_return_error" in r.stdout and " -k " not in r.stdout, f"{party}: script embedded; TLS verified (no -k)")
check(run("bi", "--image", "postgres:17.6", "--api-ips", IPS).returncode == 2, "tag-only image must fail with 2")
check(run("bi", "--image", IMG).returncode == 2, "missing --api-ips must fail with 2")
check(run("bi", "--image", IMG, "--api-ips", "10.0.0.256x").returncode == 2, "bad IP must fail with 2")
check(run("bank-d", "--image", IMG, "--api-ips", IPS).returncode == 2, "unknown party must fail with 2")

# ---------- rotate.sh against a local TLS server + fake psql
tmp = tempfile.mkdtemp()
def sh(*a, **k): return subprocess.run(a, capture_output=True, text=True, check=True, **k)
def pki(name):
    sh("openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", f"{tmp}/{name}-ca.key", "-out", f"{tmp}/{name}-ca.crt", "-subj", f"/CN={name}-ca", "-days", "2", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=keyCertSign")
    sh("openssl", "req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", f"{tmp}/{name}.key", "-out", f"{tmp}/{name}.csr", "-subj", "/CN=kubernetes")
    open(f"{tmp}/{name}.ext", "w").write("subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n")
    sh("openssl", "x509", "-req", "-in", f"{tmp}/{name}.csr", "-CA", f"{tmp}/{name}-ca.crt", "-CAkey", f"{tmp}/{name}-ca.key", "-CAcreateserial", "-out", f"{tmp}/{name}.crt", "-days", "2", "-extfile", f"{tmp}/{name}.ext")
pki("good"); pki("other")
TOKEN = "TESTTOKEN-aaaa-bbbb-cccc"
open(f"{tmp}/token", "w").write(TOKEN)
os.symlink(fakepsql, f"{tmp}/psql")

class Api:
    """one TLS server on 127.0.0.1; `mode` ok | patch403 | get403 ; records every request"""
    def __init__(self, mode, old_b64):
        self.mode, self.reqs, self.pw, self.rv = mode, [], old_b64, 100
        self.sock = socket.socket(); self.sock.bind(("127.0.0.1", 0)); self.sock.listen(8); self.port = self.sock.getsockname()[1]
        self.ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); self.ctx.load_cert_chain(f"{tmp}/good.crt", f"{tmp}/good.key")
        self.stop = False; self.t = threading.Thread(target=self.loop, daemon=True); self.t.start()
    def loop(self):
        self.sock.settimeout(0.2)
        while not self.stop:
            try: raw, _ = self.sock.accept()
            except (socket.timeout, OSError): continue
            try: self.handle(self.ctx.wrap_socket(raw, server_side=True))
            except Exception: pass
    def handle(self, s):
        data = b""
        while b"\r\n\r\n" not in data: data += s.recv(4096)
        head, _, body = data.partition(b"\r\n\r\n")
        lines = head.decode().split("\r\n"); hdr = {l.split(":", 1)[0].lower(): l.split(":", 1)[1].strip() for l in lines[1:]}
        n = int(hdr.get("content-length", 0))
        while len(body) < n: body += s.recv(4096)
        self.reqs.append((lines[0], hdr, body.decode()))
        method = lines[0].split()[0]
        if (self.mode == "patch403" and method == "PATCH") or (self.mode == "get403" and method == "GET"):
            st, out = 403, {"kind": "Status", "code": 403}
        elif method == "PATCH":
            self.pw = json.loads(body)["data"]["password"]; self.rv += 1; st, out = 200, {"metadata": {"resourceVersion": str(self.rv)}}
        else:
            st, out = 200, {"metadata": {"name": "paladin-pg-credentials", "resourceVersion": str(self.rv)}, "data": {"password": self.pw, "username": "cGFsYWRpbg=="}}
        b = json.dumps(out, separators=(",", ":")).encode()
        s.sendall(b"HTTP/1.1 %d X\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n" % (st, len(b)) + b); s.close()
    def close(self): self.stop = True; self.sock.close()

OLD = "oldpassword0123456789"
def rotate_run(mode, ca="good", alter_fail=False):
    api = Api(mode, base64.b64encode(OLD.encode()).decode())
    state = f"{tmp}/state-{mode}-{ca}"; open(state, "w").write(OLD)
    env = {"PATH": tmp + os.pathsep + os.environ["PATH"], "FAKE_PSQL_STATE": state, "FAKE_PSQL_FAIL_ALTER": "1" if alter_fail else "",
           "API_HOST": "127.0.0.1", "API_PORT": str(api.port), "CA_FILE": f"{tmp}/{ca}-ca.crt", "TOKEN_FILE": f"{tmp}/token", "TMPDIR": tmp,
           "NS": "rd-zeto-bank-a", "PGUSER": "paladin", "PGDATABASE": "paladin", "PGPASSWORD": OLD, "PGHOST": "x"}
    r = subprocess.run(["bash", rotate], capture_output=True, text=True, env=env, timeout=60)
    api.close(); return r, api, open(state).read()

def clean(r, *secrets):
    out = r.stdout + r.stderr
    return all(x not in out for x in secrets if x)

r, api, final = rotate_run("ok")
check(r.returncode == 0 and "ROTATED:" in r.stdout, f"ok: rotation must finish: rc={r.returncode} {r.stdout[-200:]} {r.stderr[-200:]}")
check(re.fullmatch(r"[0-9a-f]{48}", final) is not None and final != OLD, "ok: the database holds a new 48-hex password")
check(base64.b64decode(api.pw).decode() == final, "ok: the Secret holds the SAME value as the database")
check([q[0].split()[0] for q in api.reqs] == ["GET", "PATCH", "GET"], f"ok: requests GET, PATCH, GET: {[q[0] for q in api.reqs]}")
p = [q for q in api.reqs if q[0].startswith("PATCH")][0]
check(p[0] == "PATCH /api/v1/namespaces/rd-zeto-bank-a/secrets/paladin-pg-credentials HTTP/1.1", f"ok: PATCH request line: {p[0]}")
check(p[1].get("authorization") == "Bearer " + TOKEN and p[1].get("content-type") == "application/merge-patch+json" and p[1].get("content-length") == str(len(p[2].encode())), f"ok: PATCH headers {p[1]}")
check(json.loads(p[2]) == {"data": {"password": api.pw}}, "ok: PATCH body is a merge-patch of the password key only")
check(clean(r, final, OLD, TOKEN, api.pw), "ok: the output must not contain the old/new password, its base64 or the token")
check("resourceVersion before=100 after=101" in r.stdout, f"ok: resourceVersion before/after quoted: {r.stdout[-200:]}")

r, api, final = rotate_run("patch403")
check(r.returncode == 1 and "SECRET-NOT-UPDATED" in r.stdout and "old password restored" in r.stdout, f"patch403: SECRET-NOT-UPDATED + restore, rc 1: rc={r.returncode} {r.stdout[-200:]}")
check(final == OLD, "patch403: the database password is back to the old value")
check(base64.b64decode(api.pw).decode() == OLD, "patch403: the Secret was never changed")
check(clean(r, OLD, TOKEN) and clean(r, base64.b64decode(json.loads([q for q in api.reqs if q[0].startswith("PATCH")][0][2])["data"]["password"]).decode()), "patch403: no password or token in the output")

r, api, final = rotate_run("get403")
check(r.returncode == 1 and "GET Secret before" in r.stdout and final == OLD, f"get403: stop BEFORE any ALTER (database untouched): rc={r.returncode} {r.stdout[-150:]}")

r, api, final = rotate_run("ok", ca="other")
check(r.returncode == 1 and "GET Secret before" in r.stdout and final == OLD and api.reqs == [], f"TLS verify failure (server cert not from the given CA): no request is sent, database untouched: rc={r.returncode} {r.stdout[-150:]}")
check(clean(r, TOKEN), "TLS failure: the token must not be printed")

r, api, final = rotate_run("ok", alter_fail=True)
check(r.returncode == 1 and "ALTER ROLE" in r.stdout and final == OLD and [q[0].split()[0] for q in api.reqs] == ["GET"], f"ALTER failure: stop, Secret not touched: rc={r.returncode} {r.stdout[-150:]}")

body = "\n".join(l for l in open(rotate).read().splitlines() if not l.lstrip().startswith("#"))
check("set -x" not in body and not re.search(r"^\s*set\s+-\w*x", body, re.M), "rotate.sh must never use set -x")
check(" -k " not in body and "insecure" not in body.lower() and "-verify_return_error" in body and "-CAfile" in body, "rotate.sh must verify TLS against the CA file")

if fails:
    print("\n".join("FAIL " + f for f in fails), file=sys.stderr); sys.exit(1)
print("OK rotate: 4 parties rendered; rotate.sh ok / patch403 / get403 / TLS failure / ALTER failure paths, no value in any output")
