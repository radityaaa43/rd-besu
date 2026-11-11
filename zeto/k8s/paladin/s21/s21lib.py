"""S21 helpers: JSON-RPC to Paladin nodes through short-lived port-forwards (timeout + process-group kill). No secret printed."""
import json, os, re, signal, socket, subprocess, time, urllib.request
R = os.environ.get('S21_ROOT', '/home/ecs-user/project/rd/platform-ekplorasi')  # S21_ROOT: offline test only
C1, C2 = f'{R}/alibaba.yaml', f'{R}/alibaba-sg.yaml'
PG = os.environ.get('S21_PG') or f'{R}/besu/.worktrees/own-apply/zeto/k8s/postgres'
BK = os.environ.get('S21_BK') or os.path.expanduser('~/backups/zeto-s21-2026-11-12')
NODES = [(1, 'bi', C1), (2, 'bank-a', C1), (3, 'bank-b', C1), (4, 'bank-c', C2)]
IDENT = {1: ['bi@node1', 'registry.node1'], 2: ['bankA@node2', 'registry.node2'], 3: ['bankB@node3', 'registry.node3'], 4: ['bankC@node4', 'registry.node4']}


def ts(): return time.strftime('%H:%M:%SZ', time.gmtime()) + '/' + time.strftime('%H:%M:%S')
REDACT = re.compile(r'postgres://[^\s\'"]*')  # R14: a Paladin DSN carries the DB password
def log(m): print(ts() + ' ' + REDACT.sub('postgres://<redacted>', str(m)), flush=True)
def stop(m): log('STOP: ' + m); raise SystemExit(1)
def kc(cfg, *a, **kw): return subprocess.run(['kubectl', '--kubeconfig', cfg, *a], capture_output=True, text=True, **kw)


class PF:
    """port-forward under timeout, killed as a process group on exit"""
    def __init__(self, cfg, ns, target, local, remote, secs=120):
        self.p = subprocess.Popen(['timeout', str(secs), 'kubectl', '--kubeconfig', cfg, '-n', ns, 'port-forward', target, f'{local}:{remote}', '--address', '127.0.0.1'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        self.local = local
    def __enter__(self):
        for _ in range(40):
            try: socket.create_connection(('127.0.0.1', self.local), 1).close(); return self
            except OSError: time.sleep(1)
        self.__exit__(); stop(f'port-forward {self.local} not listening')
    def __exit__(self, *a):
        try: os.killpg(self.p.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        self.p.wait()


def rpc(port, method, params):
    r = urllib.request.Request(f'http://127.0.0.1:{port}', json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode(), {'content-type': 'application/json'})
    d = json.load(urllib.request.urlopen(r, timeout=30))
    if 'error' in d: raise RuntimeError(f"{method}: {json.dumps(d['error'])[:200]}")
    return d['result']


def old_pf(n, port): return PF(C1, 'paladin', f'pod/paladin-node{n}-0', port, 8548)
def new_pf(n, p, cfg, port): return PF(cfg, f'rd-zeto-{p}', f'svc/paladin-node{n}', port, 8548)
def pending(port): return rpc(port, 'ptx_queryPendingTransactions', [{'limit': 20}, False])
def verifier(port, lookup): return rpc(port, 'ptx_resolveVerifier', [lookup, 'ecdsa:secp256k1', 'eth_address'])
