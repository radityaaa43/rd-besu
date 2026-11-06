"""Sink for the gateways' OPA: decision logs and bundle status. Standard library only.

POST /logs...    one JSON line per decision on stdout (already masked by OPA's system.log.mask):
                 kubectl -n paladin logs deploy/bundle-server -c sink
POST /status...  keeps the last bundle status per gateway label
GET  /status     {gateway: {age_s, bundles: {name: {revision, code, message}}}}  (Lensa reads this to confirm a publish)
"""
import gzip
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATUS = {}  # ponytail: in memory, gone on restart; gateways report again on their next bundle event


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, body=b""):
        self.send_response(code)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
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
    ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1]) if len(sys.argv) > 1 else 8081), Handler).serve_forever()
