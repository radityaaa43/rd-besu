#!/usr/bin/env python3 -I
"""S21 cutover layers (zeto PLAN S21, text 1 v3). One subcommand per layer, each stops at the first error and prints what it proved.
  record    read-only: pending [] x4 + verifier addresses of the old nodes -> backup dir (run BEFORE the freeze; resolveVerifier of existing identities writes nothing)
  pre       read-only: pending [] x4, replicas, netpol, dump files present
  l1        restore the host dumps into the NEW paladin-pg x4 (parallel), row counts equal the old counts (analyst C2 files)
  c2        re-read the OLD DB row counts, must equal the dump-time counts (any change = re-dump that node first)
  l1b       scale the OLD paladin operator to 0 (analyst C1)
  l2        scale the OLD paladin-node<N> StatefulSets to 0 (x4), kubectl wait --for=delete; the analyst C1 check (two reads) runs before each new node in l3/l4
  l3        banks A, B, C in parallel: delete NetworkPolicy rehearsal-no-9000-egress, scale new paladin-node<N> to 1, wait Ready
  l4        BI last: the same for rd-zeto-bi
  gate      analyst C3/C4 per new node: Ready, pending [], same verifier addresses as old, restored counts = dump counts; any mismatch prints ROLLBACK REQUIRED and exits 1
  rollback  new nodes to 0, old operator to 1, old nodes to 1 (Lensa/#44 revert is fe's)
  l5        S11 republish x4 (setIdentityProperty transport.grpc from each node's registry key), then verify through another node  [first NEW-node tx: point of no return]
  g1        live 4/4 read for G1 (namespace + cluster + Running per party)
Holds /tmp/lensa-paladin.lock for the whole run of a mutating subcommand (flock around each kubectl write). Never prints a key."""
import concurrent.futures as cf, json, os, re, signal, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from s21lib import *

cmd = sys.argv[1]
SPEC = {n: (p, cfg) for n, p, cfg in NODES}
REG = '0x99f3326e056b418e40c62bbbd2ffdafd48bd7874'
OWNER_KEY = {n: f'registry.node{n}' for n in (1, 2, 3, 4)}
SET_PROP_ABI = [{'type': 'function', 'name': 'setIdentityProperty', 'stateMutability': 'nonpayable', 'outputs': [], 'inputs': [
    {'name': 'identityHash', 'type': 'bytes32'}, {'name': 'name', 'type': 'string'}, {'name': 'value', 'type': 'string'}]}]


def locked(cfg, *a):
    # S21_HELD=1: this window's holder process already owns /tmp/lensa-paladin.lock for the WHOLE window (analyst Q14): no per-command flock
    pre = [] if os.environ.get('S21_HELD') == '1' else ['flock', '-w', '120', '/tmp/lensa-paladin.lock']
    r = subprocess.run([*pre, 'kubectl', '--kubeconfig', cfg, *a], capture_output=True, text=True)
    if r.returncode: stop(f'kubectl {" ".join(a[:5])}: {r.stderr.strip()[:200]}')
    return r.stdout.strip()


def counts_old(n, dest):
    with open(f'{PG}/counts.sql', 'rb') as sql, open(dest, 'wb') as out:
        r = subprocess.run(['kubectl', '--kubeconfig', C1, '-n', 'paladin', 'exec', '-i', f'paladin-node{n}-0', '-c', 'postgres', '--', 'psql', '-At', '-U', 'postgres', 'postgres'], stdin=sql, stdout=out, stderr=subprocess.PIPE)
    if r.returncode: stop(f'node{n}: old counts failed: {r.stderr.decode()[:150]}')


def counts_new(n, dest):
    p, cfg = SPEC[n]
    with open(f'{PG}/counts.sql', 'rb') as sql, open(dest, 'wb') as out:
        r = subprocess.run(['kubectl', '--kubeconfig', cfg, '-n', f'rd-zeto-{p}', 'exec', '-i', 'paladin-pg-0', '--', 'sh', '-c', 'psql -At -U "$POSTGRES_USER" "$POSTGRES_DB"'], stdin=sql, stdout=out, stderr=subprocess.PIPE)
    if r.returncode: stop(f'node{n}: new counts failed: {r.stderr.decode()[:150]}')


def _load(p):
    d = {}
    for l in open(p):
        l = l.strip()
        if l:
            k, v = l.rsplit('|', 1); d[k] = int(v)
    return d


def compare(a, b):
    """RECORDED REFINEMENT OF C2 (orchestrator, 03:10 CST): public.indexed_blocks may only GROW (the old node keeps indexing chain blocks while Lensa is frozen); EVERY other table must be equal.
    Every use logs the old/new heights and states indexed_transactions / indexed_events explicitly (equal = the new block rows carry no Paladin transaction or event)."""
    r = subprocess.run([f'{PG}/compare-counts.py', a, b], capture_output=True, text=True)
    lines = [l for l in r.stdout.splitlines() if l.strip()]
    ok = 0; bad = []
    for l in lines:
        if l.endswith('|ok'): ok += 1; continue
        parts = l.split('|')
        if len(parts) >= 4 and parts[0].endswith('indexed_blocks') and parts[1].isdigit() and parts[2].isdigit() and int(parts[2]) >= int(parts[1]):
            ok += 1; continue
        bad.append(l)
    try:
        A, B = _load(a), _load(b)
        pick = lambda d, s: next((v for k, v in d.items() if k.endswith(s)), None)
        ib, ie, it = [(pick(A, s), pick(B, s)) for s in ('indexed_blocks', 'indexed_events', 'indexed_transactions')]
        log(f'    indexed_blocks old {ib[0]} -> new {ib[1]} ({"grew by " + str(ib[1] - ib[0]) if ib[0] is not None and ib[1] is not None and ib[1] != ib[0] else "equal"}); indexed_transactions {it[0]} vs {it[1]} {"EQUAL" if it[0] == it[1] else "DIFFERENT"}; indexed_events {ie[0]} vs {ie[1]} {"EQUAL" if ie[0] == ie[1] else "DIFFERENT"}')
        if it[0] != it[1] or ie[0] != ie[1]: bad.append('indexed_transactions/indexed_events differ: a Paladin tx or event arrived')
    except Exception as e:
        bad.append(f'could not read counts files: {e}')
    return (0 if not bad else 1), ok, len(lines), bad[:5]


def sts_replicas(cfg, ns, name): return kc(cfg, '-n', ns, 'get', 'sts', name, '-o', 'jsonpath={.spec.replicas}').stdout.strip()
def pod_exists(cfg, ns, name): return kc(cfg, '-n', ns, 'get', 'pod', name, '--ignore-not-found', '-o', 'name').stdout.strip() != ''


def wait_ready(cfg, ns, pod, secs):
    """kubectl wait for the Ready condition: a state check with a failure bound, no sleep loop"""
    return kc(cfg, '-n', ns, 'wait', '--for=condition=Ready', f'pod/{pod}', f'--timeout={secs}s').returncode == 0


BAD_WAIT = {'ImagePullBackOff', 'ErrImagePull', 'CrashLoopBackOff', 'CreateContainerConfigError', 'CreateContainerError', 'InvalidImageName', 'RunContainerError'}


def wait_ready_failfast(cfg, ns, pod, secs):
    """Ready wait (failure bound secs) plus a state watch on the container waiting reasons: a reason in BAD_WAIT ends the wait at once (no 900 s hang on ImagePullBackOff). Returns (ok, why)."""
    wp = subprocess.Popen(['kubectl', '--kubeconfig', cfg, '-n', ns, 'wait', '--for=condition=Ready', f'pod/{pod}', f'--timeout={secs}s'], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, start_new_session=True)
    # the pod may not exist yet when the watch starts: -w on a missing pod fails, so wait for the object first (kubectl wait --for=create)
    kc(cfg, '-n', ns, 'wait', '--for=create', f'pod/{pod}', '--timeout=120s')
    sp = subprocess.Popen(['kubectl', '--kubeconfig', cfg, '-n', ns, 'get', 'pod', pod, '-w', '-o', 'jsonpath={.status.containerStatuses[*].state.waiting.reason}{"\\n"}'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, start_new_session=True)
    hit = []
    def watch():
        for line in sp.stdout:
            bad = BAD_WAIT & set(line.split())
            if bad: hit.append(sorted(bad)[0]); os.killpg(wp.pid, signal.SIGTERM); return
    th = threading.Thread(target=watch, daemon=True); th.start()
    wp.wait()
    try: os.killpg(sp.pid, signal.SIGTERM)
    except ProcessLookupError: pass
    sp.wait(); th.join(5)
    if hit: return False, f'container waiting reason {hit[0]}'
    return wp.returncode == 0, (wp.stderr.read().strip()[:120] if wp.returncode else '')


def safe_logs(cfg, ns, pod, tail=4):
    """last log lines of a Paladin pod WITHOUT the fork's `REMOVE: DSN=...` line (it prints the DB password); also drops any postgres:// URL"""
    out = kc(cfg, '-n', ns, 'logs', pod, '-c', 'paladin', '--tail=60').stdout.splitlines()
    keep = [re.sub(r'postgres://\S+', 'postgres://<dropped>', l) for l in out if 'DSN=' not in l]
    return ' | '.join(l[-160:] for l in keep[-tail:])


def proof3(cfg, ns, pod):
    """R14 proof 3 (counts only, no log output): the new node's log has no postgres://user:password@ and no `REMOVE: DSN` line."""
    out = kc(cfg, '-n', ns, 'logs', pod, '-c', 'paladin').stdout
    a = len(re.findall(r'postgres://[^@\s]*:[^@\s]*@', out)); b = out.count('REMOVE: DSN')
    log(f'PROOF3 {ns}/{pod}: log lines with postgres://..:..@ = {a}; "REMOVE: DSN" lines = {b} (counts only, log not printed)')
    if a or b: stop(f'{pod}: the log shows the DSN (proof 3 failed): stop, rollback')


def c1_read(n):
    """ANALYST C1 (timers deleted): ONE read of the old side for node n: operator spec/status replicas 0 and no operator pod, StatefulSet spec/status replicas 0, pod NotFound."""
    ds = kc(C1, '-n', 'paladin', 'get', 'deploy', 'paladin-operator', '-o', 'jsonpath={.spec.replicas}/{.status.replicas}').stdout.strip()
    sel = ','.join(f'{k}={v}' for k, v in json.loads(kc(C1, '-n', 'paladin', 'get', 'deploy', 'paladin-operator', '-o', 'jsonpath={.spec.selector.matchLabels}').stdout).items())
    opods = kc(C1, '-n', 'paladin', 'get', 'pods', '-l', sel, '--no-headers', '--ignore-not-found').stdout.strip()
    ss = kc(C1, '-n', 'paladin', 'get', 'sts', f'paladin-node{n}', '-o', 'jsonpath={.spec.replicas}/{.status.replicas}').stdout.strip()
    pod = pod_exists(C1, 'paladin', f'paladin-node{n}-0')
    ok = ds in ('0/', '0/0') and opods == '' and ss in ('0/', '0/0') and not pod
    log(f'C1 read node{n}: old operator spec/status replicas {ds or "?"} operator pods {"none" if not opods else opods[:60]}; sts paladin-node{n} spec/status replicas {ss or "?"}; pod paladin-node{n}-0 {"EXISTS" if pod else "NotFound"} -> {"OK" if ok else "NOT OK"}')
    return ok


if cmd == 'record':
    os.makedirs(BK, mode=0o700, exist_ok=True); out = {}
    for n, p, cfg in NODES:
        with old_pf(n, 19460 + n) as pf:
            pe = pending(pf.local)
            if pe != []: stop(f'old node{n}: pending is not []')
            out[str(n)] = {l: verifier(pf.local, l) for l in IDENT[n]}
            log(f'old node{n}: pending [] ; verifiers ' + ' '.join(f'{k}={v}' for k, v in out[str(n)].items()))
    fd = os.open(f'{BK}/old-verifiers.json', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f: json.dump(out, f)
    log(f'recorded {BK}/old-verifiers.json'); sys.exit(0)

if cmd == 'pre':
    for n, p, cfg in NODES:
        with old_pf(n, 19470 + n) as pf: pe = pending(pf.local)
        log(f'node{n} ({p}): old pending {json.dumps(pe)}; old sts replicas {sts_replicas(C1, "paladin", f"paladin-node{n}")}; new sts replicas {sts_replicas(cfg, f"rd-zeto-{p}", f"paladin-node{n}")}; rehearsal netpol {"present" if kc(cfg, "-n", f"rd-zeto-{p}", "get", "netpol", "rehearsal-no-9000-egress", "--ignore-not-found", "-o", "name").stdout.strip() else "ABSENT"}; dump {"present" if os.path.exists(f"{BK}/paladin-node{n}-pgdata.dump") else "MISSING"}')
        if pe != []: stop(f'node{n}: pending is not []')
    sys.exit(0)

if cmd == 'c2':
    for n, p, cfg in NODES:
        cur = f'{BK}/old-counts-node{n}-c2.txt'; counts_old(n, cur)
        rc, ok, tot, bad = compare(f'{BK}/old-counts-node{n}.txt', cur)
        log(f'C2 node{n}: old DB row counts vs dump-time counts: {ok}/{tot} tables equal {"" if rc == 0 else "DIFF " + str(bad)}')
        if rc != 0: stop(f'node{n}: old DB changed since the dump: re-dump that node first')
    log('C2 OK'); sys.exit(0)

if cmd == 'l1':
    def one(item):
        n, p, cfg = item; ns = f'rd-zeto-{p}'; dump = f'{BK}/paladin-node{n}-pgdata.dump'
        if sts_replicas(cfg, ns, f'paladin-node{n}') != '0': stop(f'node{n}: new node is not at 0 replicas')
        with open(dump, 'rb') as f:
            r = subprocess.run(['kubectl', '--kubeconfig', cfg, '-n', ns, 'exec', '-i', 'paladin-pg-0', '--', 'sh', '-c', 'pg_restore --clean --if-exists --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"'], stdin=f, capture_output=True, text=True)
        if r.returncode: stop(f'node{n}: pg_restore rc={r.returncode} {r.stderr.strip()[:200]}')
        new = f'{BK}/new-counts-node{n}.txt'; counts_new(n, new)
        rc, ok, tot, bad = compare(f'{BK}/old-counts-node{n}.txt', new)
        log(f'L1 node{n} ({p}): restored into the new paladin-pg, row counts old vs new {ok}/{tot} tables equal {"EQUAL" if rc == 0 else "DIFF " + str(bad)}')
        if rc != 0: stop(f'node{n}: counts differ')
    with cf.ThreadPoolExecutor(4) as ex: list(ex.map(one, NODES))
    log('L1 DONE x4'); sys.exit(0)

if cmd == 'l1b':
    out = locked(C1, '-n', 'paladin', 'scale', 'deploy/paladin-operator', '--replicas=0'); log(f'L1b old operator: {out}')
    sel = ','.join(f'{k}={v}' for k, v in json.loads(kc(C1, '-n', 'paladin', 'get', 'deploy', 'paladin-operator', '-o', 'jsonpath={.spec.selector.matchLabels}').stdout).items())
    r = kc(C1, '-n', 'paladin', 'wait', '--for=delete', 'pod', '-l', sel, '--timeout=300s')
    if r.returncode and 'no matching resources' not in r.stderr: stop(f'old operator pod did not go away: {r.stderr.strip()[:150]}')
    log('L1b old operator: spec/status replicas ' + (kc(C1, '-n', 'paladin', 'get', 'deploy', 'paladin-operator', '-o', 'jsonpath={.spec.replicas}/{.status.replicas}').stdout or '?')); sys.exit(0)

if cmd == 'l2':
    for n in (1, 2, 3, 4): log(f'L2 {locked(C1, "-n", "paladin", "scale", "sts", f"paladin-node{n}", "--replicas=0")}')
    for n in (1, 2, 3, 4):
        r = kc(C1, '-n', 'paladin', 'wait', '--for=delete', f'pod/paladin-node{n}-0', '--timeout=300s')
        if r.returncode and 'NotFound' not in r.stderr: stop(f'old paladin-node{n}-0 still there: {r.stderr.strip()[:150]}')
    log('L2 old nodes scaled to 0, pods deleted (the C1 two-read check runs right before each new node starts)'); sys.exit(0)

if cmd in ('l3', 'l4'):
    group = [(n, p, cfg) for n, p, cfg in NODES if (n != 1 if cmd == 'l3' else n == 1)]
    def up(item):
        n, p, cfg = item; ns = f'rd-zeto-{p}'
        if not c1_read(n): stop(f'node{n}: ANALYST C1 read 1 not OK, refusing to start the new node')
        if not c1_read(n): stop(f'node{n}: ANALYST C1 immediate re-read not OK, refusing to start the new node')
        sa = kc(cfg, '-n', ns, 'get', 'sa', 'default', '-o', 'jsonpath={.imagePullSecrets[*].name}').stdout.split()
        log(f'{cmd.upper()} node{n}: default SA imagePullSecrets {" ".join(sa)} -> {"ghcr-pull present" if "ghcr-pull" in sa else "ghcr-pull MISSING"}')
        if 'ghcr-pull' not in sa: stop(f'node{n}: default SA has no ghcr-pull (ACK helper rewrote it?), refusing to start the new node')
        d = kc(cfg, '-n', ns, 'get', 'netpol', 'rehearsal-no-9000-egress', '--ignore-not-found', '-o', 'name').stdout.strip()
        if d: log(f'{cmd.upper()} node{n}: delete {locked(cfg, "-n", ns, "delete", "netpol", "rehearsal-no-9000-egress")}')
        log(f'{cmd.upper()} node{n}: {locked(cfg, "-n", ns, "scale", "sts", f"paladin-node{n}", "--replicas=1")}')
        ok, why = wait_ready_failfast(cfg, ns, f'paladin-node{n}-0', 900)
        if not ok: stop(f'node{n}: new pod not Ready: {why}; last log lines (DSN line dropped): {safe_logs(cfg, ns, f"paladin-node{n}-0")}')
        log(f'{cmd.upper()} node{n} ({p}): ' + kc(cfg, '-n', ns, 'get', 'pod', f'paladin-node{n}-0', '--no-headers', '-o', 'wide').stdout.split('\n')[0][:150])
        proof3(cfg, ns, f'paladin-node{n}-0')
    with cf.ThreadPoolExecutor(3) as ex: list(ex.map(up, group))
    log(f'{cmd.upper()} DONE {len(group)} node(s)'); sys.exit(0)

if cmd == 'proof3':
    for n, p, cfg in NODES:
        if pod_exists(cfg, f'rd-zeto-{p}', f'paladin-node{n}-0'): proof3(cfg, f'rd-zeto-{p}', f'paladin-node{n}-0')
    sys.exit(0)

if cmd == 'gate':
    old = json.load(open(f'{BK}/old-verifiers.json')); bad = []
    for n, p, cfg in NODES:
        ns = f'rd-zeto-{p}'
        if not wait_ready(cfg, ns, f'paladin-node{n}-0', 30): bad.append(f'node{n} not Ready')
        with new_pf(n, p, cfg, 19480 + n) as pf:
            pe = pending(pf.local); log(f'GATE node{n} ({p}): new pending {json.dumps(pe)}')
            if pe != []: bad.append(f'node{n} pending not []')
            for l in IDENT[n]:
                v = verifier(pf.local, l); same = v.lower() == old[str(n)][l].lower()
                log(f'GATE node{n}: verifier {l} new {v} old {old[str(n)][l]} {"SAME" if same else "DIFFERENT"}')
                if not same: bad.append(f'node{n} {l} address differs')
        cur = f'{BK}/gate-counts-node{n}.txt'; counts_new(n, cur)
        rc, ok, tot, d = compare(f'{BK}/old-counts-node{n}.txt', cur)
        log(f'GATE node{n}: restored row counts vs dump {ok}/{tot} equal {"" if rc == 0 else "DIFF " + str(d)}')
        if rc != 0: bad.append(f'node{n} counts differ')
    if bad: log('GATE FAIL: ' + '; '.join(bad)); log('ROLLBACK REQUIRED (analyst C3/C4): new 0, old 1, operator 1, revert #44'); sys.exit(1)
    log('GATE OK x4 (C3, C4): all 4 new nodes Ready, pending [], same addresses, counts equal'); sys.exit(0)

if cmd == 'rollback':
    for n, p, cfg in NODES:
        log(f'ROLLBACK new node{n}: {locked(cfg, "-n", f"rd-zeto-{p}", "scale", "sts", f"paladin-node{n}", "--replicas=0")}')
    for n, p, cfg in NODES:
        kc(cfg, '-n', f'rd-zeto-{p}', 'wait', '--for=delete', f'pod/paladin-node{n}-0', '--timeout=300s')
    log(f'ROLLBACK old operator: {locked(C1, "-n", "paladin", "scale", "deploy/paladin-operator", "--replicas=1")}')
    for n in (1, 2, 3, 4): log(f'ROLLBACK old node{n}: {locked(C1, "-n", "paladin", "scale", "sts", f"paladin-node{n}", "--replicas=1")}')
    for n in (1, 2, 3, 4): log(f'ROLLBACK old node{n} Ready: {wait_ready(C1, "paladin", f"paladin-node{n}-0", 600)}')
    log('ROLLBACK DONE on the cluster side; fe reverts #44, restores lensa.env, restarts Lensa on the OLD pointers'); sys.exit(0)

if cmd == 'l5':
    for n, p, cfg in NODES:
        with new_pf(n, p, cfg, 19490 + n) as pf:
            name = rpc(pf.local, 'transport_nodeName', []); details = rpc(pf.local, 'transport_localTransportDetails', ['grpc'])
            ent = rpc(pf.local, 'reg_queryEntries', ['evm-registry', {'eq': [{'field': '.name', 'value': name}], 'null': [{'field': '.parentId'}], 'limit': 1}, 'active'])
            if len(ent) != 1: stop(f'node{n}: registry entry for {name} not found')
            owner = rpc(pf.local, 'reg_queryEntriesWithProps', ['evm-registry', {'eq': [{'field': '.name', 'value': name}], 'null': [{'field': '.parentId'}], 'limit': 1}, 'active'])[0]['properties']['$owner']
            key_addr = verifier(pf.local, OWNER_KEY[n])
            if owner.lower() != key_addr.lower(): stop(f'node{n}: registry $owner {owner} != {OWNER_KEY[n]} address {key_addr}: the owner check would revert')
            ep = json.loads(details)['endpoint']
            log(f'L5 node{n} ({name}): setIdentityProperty transport.grpc endpoint {ep} from {OWNER_KEY[n]} ({key_addr})')
            tx = {'type': 'public', 'from': OWNER_KEY[n], 'to': REG, 'function': 'setIdentityProperty', 'abi': SET_PROP_ABI, 'data': {'identityHash': ent[0]['id'], 'name': 'transport.grpc', 'value': details}}
            txid = rpc(pf.local, 'ptx_sendTransaction', [tx]); log(f'L5 node{n}: tx id {txid}')
            end = time.time() + 180; rec = None
            while time.time() < end:
                rec = rpc(pf.local, 'ptx_getTransactionReceipt', [txid])
                if rec: break
                time.sleep(3)
            if not rec or rec.get('success') is not True: stop(f'node{n}: republish tx failed: {json.dumps(rec)[:200]}')
            log(f'L5 node{n}: receipt success, block {rec.get("blockNumber")}')
    # verify through another node (node1 reads node2..4, node2 reads node1)
    for reader, target in ((1, 2), (1, 3), (1, 4), (2, 1)):
        rp, rcfg = SPEC[reader]
        with new_pf(reader, rp, rcfg, 19500 + reader) as pf:
            time.sleep(5)
            e = rpc(pf.local, 'reg_queryEntriesWithProps', ['evm-registry', {'eq': [{'field': '.name', 'value': f'node{target}'}], 'null': [{'field': '.parentId'}], 'limit': 1}, 'active'])
            val = json.loads(e[0]['properties']['transport.grpc'])['endpoint']
            log(f'L5 verify: node{reader} reads node{target} endpoint {val} ' + ('(NEW, not the in-cluster name)' if 'svc.cluster.local' not in val else 'STILL OLD'))
            if 'svc.cluster.local' in val: stop(f'node{target} endpoint not updated as seen from node{reader} (index may need a moment: rerun the verify)')
    log('L5 DONE x4'); sys.exit(0)

if cmd == 'g1':
    for n, p, cfg in NODES:
        cl = 'cluster 2' if cfg == C2 else 'cluster 1'
        log(f'G1 {p}: ns rd-zeto-{p} {cl}: ' + kc(cfg, '-n', f'rd-zeto-{p}', 'get', 'pod', f'paladin-node{n}-0', '--no-headers', '-o', 'wide').stdout.split('\n')[0][:140])
    log('G1 old ns paladin: ' + kc(C1, '-n', 'paladin', 'get', 'sts', '--no-headers').stdout.replace('\n', '; ')[:200]); sys.exit(0)

stop(f'unknown subcommand {cmd}')
