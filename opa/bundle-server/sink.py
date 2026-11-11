"""Sink for the gateways' OPA: decision logs and bundle status. Standard library only.

POST /logs...    one JSON line per decision on stdout (already masked by OPA's system.log.mask):
                 kubectl -n paladin logs deploy/bundle-server -c sink
POST /status...  keeps the last bundle status per gateway label
GET  /status     {gateway: {age_s, bundles: {name: {revision, code, message}}}}  (Lensa reads this to confirm a publish)
POST /bundles/<name>  a bundle archive (tar.gz) into the bundle store that nginx serves (needs the token and BUNDLE_STORE):
                 - <name> is one of this party's own bundles (env PARTY_BUNDLE, comma list, e.g. `bank` or `bi,bank`): the body is the UNSIGNED
                   rego/data source; it is built with `opa build` and signed with SIGNING_KEY_FILE / SIGNING_KEYID (the party's own key);
                 - any other name (e.g. `bi` on a bank's server): the body must be an already signed bundle (it carries .signatures.json); it is
                   stored AS-IS, never re-signed. Unsigned for a foreign name, or signed for an own name: 422.
                 Written append-only as <name>/<revision>.tar.gz + <name>/<revision>.signatures.json, revision = UTC timestamp + "-" + sha256 of
                 the uploaded body; an existing file is never replaced (409). <name>/latest.tar.gz and latest.signatures.json are symlinks to the
                 newest revision: OPA's `bundles.<name>.resource` is `<name>/latest.tar.gz`. Body limit MAX_BUNDLE_BYTES (default 10 MiB): 413.

Token: when SINK_TOKEN_FILE names a file, both POST routes need `Authorization: Bearer <file content>` (401 otherwise): without it
anyone in the cluster could post fake decision logs or a fake bundle status that Lensa would then trust. GET /status stays open: Lensa
reads it through the API-server service proxy, which cannot carry the header (k8s RBAC on services/proxy guards it). No SINK_TOKEN_FILE:
no check, as before (the manifest always sets it).
"""
import datetime
import hashlib
import hmac
import io
import os
import gzip
import json
import re
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

NAME = re.compile(r"^[a-z0-9][a-z0-9-]*$")
MAX_FILES, MAX_UNPACKED = 2000, 50 * 1024 * 1024  # a source archive with more files or more bytes unpacked is refused (zip bomb)
STORE_LOCK = threading.Lock()  # ponytail: one lock for all names; uploads are rare (a publish a few times a day)
STATUS = {}  # ponytail: in memory, gone on restart; gateways report again on their next bundle event


def read_token(path):
    """None when no path is set; the stripped file content otherwise. An empty file is refused: it would accept `Bearer ` for free."""
    if not path:
        return None
    token = open(path).read().strip()
    if not token:
        sys.exit(f"sink: token file {path} is empty")
    return token


class Refused(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code, self.msg = code, msg


def revision_id(data):
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + "-" + hashlib.sha256(data).hexdigest()


def read_archive(data, rooted=False):
    """{name: bytes} of a tar.gz; only plain files and directories, no `..` names (Refused 400 otherwise). opa writes its bundles with
    a leading `/` on every name: that is accepted only with rooted=True (and stripped); a source archive must have plain relative names."""
    files, total = {}, 0
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as t:
            for m in t:
                name = m.name[2:] if m.name.startswith("./") else m.name
                if not (m.isreg() or m.isdir()):
                    raise Refused(400, f"member {m.name!r} is not a plain file or directory")
                if name.startswith("/") and rooted:
                    name = name.lstrip("/")
                if not name or name.startswith("/") or "\\" in name or "\0" in name or ".." in name.split("/"):
                    raise Refused(400, f"unsafe member name {m.name!r}")
                if m.isdir():
                    continue
                total += m.size
                if len(files) >= MAX_FILES or total > MAX_UNPACKED:
                    raise Refused(400, "archive has too many files or is too large unpacked")
                files[name] = t.extractfile(m).read()
    except (tarfile.TarError, OSError, EOFError) as e:
        raise Refused(400, f"not a tar.gz archive: {e}")
    if not files:
        raise Refused(400, "empty archive")
    return files


def sign_source(files, revision, key_file, key_id, opa_bin):
    """opa build + sign (the way the Lensa Publisher builds, README): returns (bundle tar.gz bytes, its .signatures.json bytes)."""
    with tempfile.TemporaryDirectory() as tmp:
        src, out = os.path.join(tmp, "src"), os.path.join(tmp, "out.tar.gz")
        for name, data in files.items():
            path = os.path.join(src, name)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as f:
                f.write(data)
        cmd = [opa_bin, "build", "-b", src, "-o", out, "--signing-key", key_file, "--signing-alg", "RS256", "--verification-key-id", key_id]
        if ".manifest" not in files:  # Lensa's status check reads the revision from the manifest
            cmd += ["--revision", revision]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise Refused(422, "opa build failed: " + r.stderr.strip()[-500:])
        data = open(out, "rb").read()
    return data, read_archive(data, rooted=True)[".signatures.json"]


def store(root, name, revision, bundle, signatures):
    """Append-only: link() fails when the file exists, so a revision is never replaced. latest.* are the only files that move."""
    d = os.path.join(root, name)
    os.makedirs(d, exist_ok=True)
    with STORE_LOCK:
        for suffix, data in ((".tar.gz", bundle), (".signatures.json", signatures)):
            tmp = os.path.join(d, f".{revision}{suffix}.tmp")
            with open(tmp, "wb") as f:
                f.write(data)
            try:
                os.link(tmp, os.path.join(d, revision + suffix))
            except FileExistsError:
                raise Refused(409, f"revision {revision} already exists")
            finally:
                os.unlink(tmp)
        for suffix in (".signatures.json", ".tar.gz"):  # the tarball last: it is what OPA polls
            link = os.path.join(d, f".latest{suffix}.tmp")
            if os.path.lexists(link):
                os.unlink(link)
            os.symlink(revision + suffix, link)
            os.replace(link, os.path.join(d, "latest" + suffix))


class Handler(BaseHTTPRequestHandler):
    token = None  # set in main from SINK_TOKEN_FILE
    store = None  # BUNDLE_STORE: directory nginx serves; None = POST /bundles is off (404)
    own = set()  # PARTY_BUNDLE: bundle names this server signs itself
    key_file = key_id = None  # SIGNING_KEY_FILE, SIGNING_KEYID
    opa_bin = "opa"  # OPA_BIN
    max_bytes = 10 * 1024 * 1024  # MAX_BUNDLE_BYTES

    def authorized(self):
        if self.token is None:
            return True
        sent = self.headers.get("Authorization", "")
        return sent.startswith("Bearer ") and hmac.compare_digest(sent[7:].encode(), self.token.encode())

    def reply(self, code, body=b""):
        self.send_response(code)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def post_bundle(self):
        m = re.fullmatch(r"/bundles/([a-z0-9][a-z0-9-]*)", self.path)
        if not m:
            return self.reply(400, b"bad bundle name")
        if not self.store:
            return self.reply(404)
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return self.reply(411)
        if length > self.max_bytes:
            left = min(length, 4 * self.max_bytes)  # drain a bounded amount so the sender can read the answer, then close
            while left > 0 and self.rfile.read(min(left, 65536)):
                left -= 65536
            self.close_connection = True
            return self.reply(413, f"body over {self.max_bytes} bytes".encode())
        name, body = m.group(1), self.rfile.read(length)
        try:
            signed = ".signatures.json" in read_archive(body, rooted=True)  # a signed opa bundle has rooted names
            files = read_archive(body, rooted=signed)  # an unsigned source must not
            revision = revision_id(body)
            if name in self.own:
                if signed:
                    raise Refused(422, f"{name} is this server's own bundle: upload the unsigned source, it is signed here")
                bundle, signatures = sign_source(files, revision, self.key_file, self.key_id, self.opa_bin)
            else:
                if not signed:
                    raise Refused(422, f"{name} is not this server's bundle: only an already signed bundle is stored")
                bundle, signatures = body, files[".signatures.json"]
            store(self.store, name, revision, bundle, signatures)
        except Refused as e:
            return self.reply(e.code, e.msg.encode())
        except Exception as e:  # signer missing, disk full: tell the sender, never the details
            print(f"sink: {self.path}: {e!r}", file=sys.stderr, flush=True)
            return self.reply(500)
        print(f"sink: stored {name}/{revision} signed_here={name in self.own}", file=sys.stderr, flush=True)
        self.reply(201, json.dumps({"bundle": name, "revision": revision, "signed_here": name in self.own}).encode())

    def do_POST(self):
        if not self.authorized():
            return self.reply(401)
        if self.path.startswith("/bundles/"):
            return self.post_bundle()
        try:
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            if self.headers.get("Content-Encoding") == "gzip":
                body = gzip.decompress(body)
            data = json.loads(body)
            if self.path.startswith("/logs"):
                for event in data:
                    print(json.dumps(event, separators=(",", ":")), flush=True)
            elif self.path.startswith("/status"):
                STATUS[data["labels"]["gateway"]] = {"at": time.time(), "bundles": data.get("bundles", {})}
            else:
                return self.reply(404)
        except Exception as e:  # bad body: tell the sender, keep serving
            print(f"sink: {self.path}: {e!r}", file=sys.stderr, flush=True)
            return self.reply(400)
        self.reply(200)

    def do_GET(self):
        m = re.fullmatch(r"/bundles/([a-z0-9][a-z0-9-]*)/latest", self.path)
        if m:  # relay: the newest stored (signed) bundle, byte-identical; signed public data, so no token
            if not self.store:
                return self.reply(404)
            path = os.path.join(self.store, m.group(1), "latest.tar.gz")
            try:
                with open(path, "rb") as f:
                    data = f.read()
            except OSError:
                return self.reply(404)
            self.send_response(200)
            self.send_header("Content-Type", "application/gzip")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if self.path != "/status":
            return self.reply(404)
        now = time.time()
        out = {
            gw: {
                "age_s": int(now - s["at"]),
                "bundles": {
                    n: {"revision": b.get("active_revision"), "code": b.get("code"), "message": b.get("message")}
                    for n, b in s["bundles"].items()
                },
            }
            for gw, s in list(STATUS.items())
        }
        self.reply(200, json.dumps(out).encode())

    def log_message(self, *args):  # no per-request access log: stdout is the decision log
        pass


if __name__ == "__main__":
    Handler.token = read_token(os.environ.get("SINK_TOKEN_FILE"))
    Handler.store = os.environ.get("BUNDLE_STORE")
    Handler.own = {n for n in os.environ.get("PARTY_BUNDLE", "").split(",") if NAME.match(n)}
    Handler.key_file, Handler.key_id = os.environ.get("SIGNING_KEY_FILE"), os.environ.get("SIGNING_KEYID")
    Handler.opa_bin = os.environ.get("OPA_BIN", "opa")
    Handler.max_bytes = int(os.environ.get("MAX_BUNDLE_BYTES", Handler.max_bytes))
    if Handler.token is None:
        print("sink: SINK_TOKEN_FILE not set, POST routes are open", file=sys.stderr, flush=True)
    ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1]) if len(sys.argv) > 1 else 8081), Handler).serve_forever()
