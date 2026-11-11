"""Sink for the gateways' OPA: decision logs and bundle status. Standard library only.

POST /logs...    one JSON line per decision on stdout (already masked by OPA's system.log.mask):
                 kubectl -n paladin logs deploy/bundle-server -c sink
POST /status...  keeps the last bundle status per gateway label
GET  /status     {gateway: {age_s, bundles: {name: {revision, code, message}}}}  (Lensa reads this to confirm a publish)

Token: when SINK_TOKEN_FILE names a file, both POST routes need `Authorization: Bearer <file content>` (401 otherwise): without it
anyone in the cluster could post fake decision logs or a fake bundle status that Lensa would then trust. GET /status stays open: Lensa
reads it through the API-server service proxy, which cannot carry the header (k8s RBAC on services/proxy guards it). No SINK_TOKEN_FILE:
no check, as before (the manifest always sets it).
"""
import hmac
import os
import gzip
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATUS = {}  # ponytail: in memory, gone on restart; gateways report again on their next bundle event


def read_token(path):
    """None when no path is set; the stripped file content otherwise. An empty file is refused: it would accept `Bearer ` for free."""
    if not path:
        return None
    token = open(path).read().strip()
    if not token:
        sys.exit(f"sink: token file {path} is empty")
    return token


class Handler(BaseHTTPRequestHandler):
    token = None  # set in main from SINK_TOKEN_FILE

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

    def do_POST(self):
        if not self.authorized():
            return self.reply(401)
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
    if Handler.token is None:
        print("sink: SINK_TOKEN_FILE not set, POST routes are open", file=sys.stderr, flush=True)
    ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1]) if len(sys.argv) > 1 else 8081), Handler).serve_forever()
