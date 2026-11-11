#!/usr/bin/env python3 -I
"""Reads a Paladin Postgres password on stdin, exits 0 only if it is 24+ characters of [A-Za-z0-9]; never prints it.
Why: Paladin puts the password into postgres://user:PASSWORD@host unescaped (templates/paladin.yaml dsn), so `+`, `/`, `=` break the node start (S21 attempt 2).
Check a live Secret without showing it:
  kubectl -n rd-zeto-<p> get secret paladin-pg-credentials -o jsonpath='{.data.password}' | base64 -d | zeto/k8s/postgres/check-pg-password.py"""
import re, sys
pw = sys.stdin.read()
ok = re.fullmatch(r"[A-Za-z0-9]{24,}", pw) is not None
print("ok: password is 24+ alphanumeric characters" if ok else "FAIL: password must be 24+ characters of [A-Za-z0-9] (no + / = or other URL characters)")
sys.exit(0 if ok else 1)
