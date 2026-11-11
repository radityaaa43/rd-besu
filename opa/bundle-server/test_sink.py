"""Token check of the sink (python3 -m unittest test_sink). Standard library only."""
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import sink

STATUS = {"labels": {"gateway": "bank-gw-1"}, "bundles": {"bi": {"active_revision": "r1", "code": "", "message": ""}}}


def call(port, method, path, body=None, token=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=None if body is None else json.dumps(body).encode(), method=method)
    if token is not None:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


class TokenCheck(unittest.TestCase):
    def serve(self, token):
        sink.Handler.token = token
        sink.STATUS.clear()
        server = ThreadingHTTPServer(("127.0.0.1", 0), sink.Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        self.addCleanup(server.server_close)
        return server.server_address[1]

    def test_post_without_or_with_wrong_token_is_rejected_and_stores_nothing(self):
        port = self.serve("s3cret")
        self.assertEqual(call(port, "POST", "/status", STATUS), 401)
        self.assertEqual(call(port, "POST", "/status", STATUS, token="wrong"), 401)
        self.assertEqual(call(port, "POST", "/logs", [{"decision_id": "d"}]), 401)
        self.assertEqual(sink.STATUS, {})

    def test_post_with_the_token_is_accepted(self):
        port = self.serve("s3cret")
        self.assertEqual(call(port, "POST", "/status", STATUS, token="s3cret"), 200)
        self.assertIn("bank-gw-1", sink.STATUS)
        self.assertEqual(call(port, "POST", "/logs", [{"decision_id": "d"}], token="s3cret"), 200)

    def test_get_status_needs_no_token(self):
        # Lensa reads it through the API-server service proxy, which cannot add the header (README, bundle-server hardening)
        port = self.serve("s3cret")
        self.assertEqual(call(port, "GET", "/status"), 200)

    def test_no_token_configured_means_open_as_before(self):
        port = self.serve(None)
        self.assertEqual(call(port, "POST", "/status", STATUS), 200)

    def test_token_file_is_read_and_trimmed_and_an_empty_file_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "token")
            with open(path, "w") as f:
                f.write("abc123\n")
            self.assertEqual(sink.read_token(path), "abc123")
            open(path, "w").close()
            with self.assertRaises(SystemExit):
                sink.read_token(path)
            self.assertIsNone(sink.read_token(None))


if __name__ == "__main__":
    unittest.main()
