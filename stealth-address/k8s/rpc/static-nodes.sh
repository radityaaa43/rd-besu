#!/usr/bin/env bash
# Build a Besu static-nodes.json (JSON list on stdout) for the stealth RPC nodes (final-design/stealth/PLAN.md S4/S5): the zeto besu-p2p LB IPs, IP only.
#   static-nodes.sh [--peer enode://<id>@<ip>:30303[?discport=0]]... [--old-peers FILE --pod-ips FILE]
#   --peer       a new node's enode, IP only (the live nodes use DNS names with --Xdns-enabled; the new ones never do, README)
#   --old-peers  the live ConfigMap besu-peers static-nodes.json (DNS hosts), --pod-ips: lines "<N> <pod IP>" for besu-node-validator-N-0
#                (accepted interim: an in-cluster pod IP is an IP, it changes when the old pod restarts, see PLAN S3)
# Entries without a query get ?discport=0 (discovery is off), exactly like the live file. Needs python3.
set -euo pipefail
exec python3 -I - "$@" <<'PY'
import json, re, sys

IP_ENODE = re.compile(r"^enode://([0-9a-f]{128})@((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})(\?discport=\d+)?$")
OLD_HOST = re.compile(r"^besu-node-validator-(\d+)-0\.")
out, args = [], sys.argv[1:]
old_peers = pod_ips = None

def die(msg):
    print("static-nodes.sh: " + msg, file=sys.stderr); sys.exit(2)

def norm(e):
    m = IP_ENODE.match(e)
    if not m:
        die(f"not an IP enode (DNS names are refused): {e[:60]}...")
    return f"enode://{m.group(1)}@{m.group(2)}:{m.group(3)}{m.group(4) or '?discport=0'}"

i = 0
while i < len(args):
    a = args[i]
    if a == "--peer" and i + 1 < len(args): out.append(norm(args[i + 1])); i += 2
    elif a == "--old-peers" and i + 1 < len(args): old_peers = args[i + 1]; i += 2
    elif a == "--pod-ips" and i + 1 < len(args): pod_ips = args[i + 1]; i += 2
    else: die("usage: static-nodes.sh [--peer ENODE]... [--old-peers FILE --pod-ips FILE]")
if (old_peers is None) != (pod_ips is None):
    die("--old-peers and --pod-ips go together")
if old_peers:
    ips = {}
    for line in open(pod_ips):
        if line.strip():
            n, ip = line.split()
            ips[n] = ip
    for e in json.load(open(old_peers)):
        m = re.match(r"^enode://([0-9a-f]+)@([^:]+):(\d+)(\?discport=\d+)?$", e)
        if not m: die(f"unreadable old enode: {e[:60]}...")
        h = OLD_HOST.match(m.group(2))
        if not h or h.group(1) not in ips: die(f"no pod IP for old host {m.group(2)}")
        out.append(f"enode://{m.group(1)}@{ips[h.group(1)]}:{m.group(3)}{m.group(4) or '?discport=0'}")
        if not IP_ENODE.match(out[-1]) and len(m.group(1)) == 128: die("bad IP in pod-ips file")
if not out:
    die("no peers given")
print(json.dumps(out, indent=2))
PY
