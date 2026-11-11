#!/usr/bin/env bash
# The (iv) node-read PROBE POD (analyst ruling 2026-11-12): the only party-credential way to read a Paladin node's RPC (party-admin has no pods/exec,
# pods/portforward or services/proxy). Created by that party's party-admin in its own ns; read the result with pods/log under the same credential; delete the pod after.
#   render.sh <bi|bank-a|bank-b|bank-c> --image REF@sha256:<64 hex> [--mode count|jq] [--method M] [--params JSON]
#   render.sh <party> negative --image REF@sha256:<64 hex> --target IPv4:PORT [--target …]   R17 negative probe: Pod egress-negative-probe (app=paladin, never Ready) that must print T<n> BLOCKED for each target and CONTROL OPEN (paladin-pg:5432)
#   render.sh <party> lbpath --image REF@sha256:<64 hex> --target <peer LB IPv4>:PORT --via ipblock|selector [--peer-ns rd-zeto-<other party>]   R17: Pod lb-path-probe-<via> + ONE NetworkPolicy (the single rule under test) -> prints TARGET OPEN|REFUSED|BLOCKED + CONTROL BLOCKED
# Pod `node-probe`: label rd/egress-locked=true (allow-dns-egress excludes it, so its own NetworkPolicy is the only egress policy: R17-0 must be live first; quote the
# union of ALL selecting Egress policies before relying on it), image by digest, no ServiceAccount token, no Secret/env/volume, runAsNonRoot, RO rootfs, drop ALL,
# deadline 60 s. NetworkPolicy node-probe: egress only to paladin-node<N>:8548 of its own ns + kube-dns 53 (a Service name is used); ingress none.
# NetworkPolicy node-probe-to-paladin: the node's 8548 admits the probe pod too (paladin-ingress admits bank-gw only). NOT via the gateway/OPA door: the
# pending read is a node-admin RPC, not on the Lensa allow-list.
# --mode count (default, image with busybox wget, e.g. busybox): prints ONLY `0` (result is []), `NONZERO` or `ERROR`, never the body.
# --mode jq (image with curl + jq): prints ONLY `jq '.result | length'`. --method/--params default: ptx_queryPendingTransactions [{"limit":20},false].
# Parameterised for the Paladin pending [] gate now; Iroha / stealth RPC reads reuse the pattern with their own Service and port (a new render).
set -euo pipefail
die() { echo "render.sh: $*" >&2; exit 2; }
party="${1:-}"; case "$party" in bi) n=1 ;; bank-a) n=2 ;; bank-b) n=3 ;; bank-c) n=4 ;; *) die "usage: render.sh <bi|bank-a|bank-b|bank-c> --image REF@sha256:<64 hex> [--mode count|jq] [--method M] [--params JSON]" ;; esac
shift; img=""; mode=count; method=ptx_queryPendingTransactions; params='[{"limit":20},false]'; negative=0; lbpath=0; besu=0; op=""; vaddr=""; vdir=""; targets=(); via=""; peerns=""; txhash=""; zetotokens=""
[[ "${1:-}" == negative ]] && { negative=1; shift; }
[[ "${1:-}" == lbpath ]] && { lbpath=1; shift; }
[[ "${1:-}" == besu ]] && { besu=1; shift; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) targets+=("${2:-}"); shift 2 ;;
    --via) via="${2:-}"; shift 2 ;;
    --peer-ns) peerns="${2:-}"; shift 2 ;;
    --tx-hash) txhash="${2:-}"; shift 2 ;;
    --op) op="${2:-}"; shift 2 ;;
    --address) vaddr="${2:-}"; shift 2 ;;
    --drop|--add) [[ -z "$vdir" ]] || die "give --drop OR --add, not both"; vdir="${1#--}"; shift ;;
    --zeto-token) [[ "${2:-}" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "--zeto-token must be a 0x<40 hex> address"; zetotokens+="${zetotokens:+,}${2}"; shift 2 ;;
    --image) img="${2:-}"; shift 2 ;;
    --mode) mode="${2:-}"; shift 2 ;;
    --method) method="${2:-}"; shift 2 ;;
    --params) params="${2:-}"; shift 2 ;;
    *) die "unknown argument '$1'" ;;
  esac
done
[[ "$img" =~ ^[A-Za-z0-9._/:-]+@sha256:[0-9a-f]{64}$ ]] || die "--image must be digest-pinned (REF@sha256:<64 lowercase hex>)"
[[ "$mode" == count || "$mode" == jq || "$mode" == ids || "$mode" == shape || "$mode" == schemas ]] || die "--mode must be count, jq, ids, shape or schemas"
if [[ "$mode" == shape || "$mode" == schemas ]]; then [[ "$txhash" =~ ^0x[0-9a-f]{64}$ ]] || die "--mode shape/schemas needs --tx-hash 0x<64 hex>"; else [[ -z "$txhash" ]] || die "--tx-hash only with --mode shape or schemas"; fi
if [[ $besu == 1 ]]; then
  # S5b / R9: the party's OWN validator RPC (Service besu-rpc:8545 in its ns), QBFT reads and votes. Output: addresses, counts, booleans only.
  case "$op" in read|pending) [[ -z "$vaddr" && -z "$vdir" ]] || die "--op $op takes no --address/--drop/--add" ;;
    propose) [[ "$vaddr" =~ ^0x[0-9a-fA-F]{40}$ && ( "$vdir" == drop || "$vdir" == add ) ]] || die "--op propose needs --address 0x<40 hex> and --drop or --add" ;;
    discard) [[ "$vaddr" =~ ^0x[0-9a-fA-F]{40}$ && -z "$vdir" ]] || die "--op discard needs --address 0x<40 hex> (no --drop/--add)" ;;
    *) die "--op must be read, pending, propose or discard" ;; esac
  head="import json,urllib.request
u='http://besu-rpc:8545'
def rpc(m,p):
    r=urllib.request.Request(u,json.dumps({'jsonrpc':'2.0','id':1,'method':m,'params':p}).encode(),{'content-type':'application/json'})
    return json.load(urllib.request.urlopen(r,timeout=10))
"
  case "$op" in
    read) body="try:
    v=rpc('qbft_getValidatorsByBlockNumber',['latest'])['result']; h=int(rpc('eth_blockNumber',[])['result'],16); pc=int(rpc('net_peerCount',[])['result'],16)
    w=2*len(v); m=rpc('qbft_getSignerMetrics',[hex(max(h-w+1,0)),hex(h)])['result']
    print('height %d'%h); print('validators %d: %s'%(len(v),','.join(v))); print('peers %d'%pc)
    print('signers(last %d blocks): %s'%(w,' '.join('%s=%d'%(x['address'],int(x['proposedBlockCount'],16)) for x in m)))
except Exception: print('ERROR')
" ;;
    pending) body="try:
    r=rpc('qbft_getPendingVotes',[])
    if 'error' in r: print('ERROR')
    else: print('pending %d: %s'%(len(r['result']),' '.join('%s=%s'%(a[:10],'add' if t else 'drop') for a,t in sorted(r['result'].items()))))
except Exception: print('ERROR')
" ;;
    propose) body="try:
    r=rpc('qbft_proposeValidatorVote',['$vaddr',$([[ $vdir == add ]] && echo True || echo False)])
    print('ERROR' if 'error' in r else 'VOTE $vdir %s %s'%('${vaddr:0:10}',str(r['result']).lower()))
except Exception: print('ERROR')
" ;;
    discard) body="try:
    r=rpc('qbft_discardValidatorVote',['$vaddr'])
    print('ERROR' if 'error' in r else 'DISCARD %s %s'%('${vaddr:0:10}',str(r['result']).lower()))
except Exception: print('ERROR')
" ;;
  esac
  ns="rd-zeto-$party"
  cat <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: besu-probe
  namespace: $ns
  labels: {"rd/egress-locked": "true", app: besu-probe, part-of: rd-zeto, party: $party}
spec:
  restartPolicy: Never
  activeDeadlineSeconds: 60
  automountServiceAccountToken: false
  securityContext: {runAsNonRoot: true, runAsUser: 65534, runAsGroup: 65534, seccompProfile: {type: RuntimeDefault}}
  containers:
    - name: probe
      image: $img
      command: [sh, -c, "echo $(printf '%s' "$head$body" | base64 -w0) | base64 -d | python3 -"]
      securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: [ALL]}}
      resources: {requests: {cpu: 10m, memory: 16Mi}, limits: {memory: 64Mi}}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: besu-probe
  namespace: $ns
  labels: {part-of: rd-zeto, party: $party}
spec:
  podSelector:
    matchLabels: {"rd/egress-locked": "true", app: besu-probe}
  policyTypes: [Egress, Ingress]
  egress:
    - to:
        - podSelector:
            matchLabels: {app.kubernetes.io/name: besu-validator}
      ports:
        - {protocol: TCP, port: 8545}
    - to:
        - namespaceSelector:
            matchLabels: {kubernetes.io/metadata.name: kube-system}
          podSelector:
            matchLabels: {k8s-app: kube-dns}
      ports:
        - {protocol: UDP, port: 53}
        - {protocol: TCP, port: 53}
YAML
  exit 0
fi
if [[ $lbpath == 1 ]]; then
  [[ ${#targets[@]} == 1 && "${targets[0]}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}:[0-9]{1,5}$ ]] || die "lbpath needs exactly one --target IPv4:PORT (the peer's transport LB IP)"
  tip="${targets[0]%%:*}"; tport="${targets[0]##*:}"
  case "$via" in
    ipblock) [[ -z "$peerns" ]] || die "--via ipblock takes no --peer-ns"; rule="        - ipBlock: {cidr: $tip/32}" ;;
    selector) [[ "$peerns" =~ ^rd-zeto-(bi|bank-a|bank-b|bank-c)$ && "$peerns" != "rd-zeto-$party" ]] || die "--via selector needs --peer-ns rd-zeto-<another party>"
      rule="        - namespaceSelector:
            matchLabels: {kubernetes.io/metadata.name: $peerns}
          podSelector:
            matchLabels: {app: paladin}" ;;
    *) die "--via must be ipblock or selector" ;;
  esac
  ns="rd-zeto-$party"
  cmd="t0=\$(date +%s); if nc -w 3 $tip $tport </dev/null >/dev/null 2>&1; then echo TARGET OPEN; elif [ \$((\$(date +%s)-t0)) -lt 2 ]; then echo TARGET REFUSED; else echo TARGET BLOCKED; fi; if nc -w 3 1.1.1.1 443 </dev/null >/dev/null 2>&1; then echo CONTROL OPEN; else echo CONTROL BLOCKED; fi"
  cat <<YAML
# R17 same-cluster LB path: does this CNI match the policy rule below for the peer's transport LB IP? OPEN = yes, BLOCKED = no, REFUSED = reached but nothing listens.
# The control (1.1.1.1:443) must print BLOCKED: it proves this pod's only egress policy is enforced. Pod is never Ready and no Service selects its labels.
apiVersion: v1
kind: Pod
metadata:
  name: lb-path-probe-$via
  namespace: $ns
  labels: {"rd/egress-locked": "true", app: lb-path-probe, probe: lb-path-$via, part-of: rd-zeto, party: $party}
spec:
  restartPolicy: Never
  activeDeadlineSeconds: 60
  automountServiceAccountToken: false
  securityContext: {runAsNonRoot: true, runAsUser: 65534, runAsGroup: 65534, seccompProfile: {type: RuntimeDefault}}
  containers:
    - name: probe
      image: $img
      command: [sh, -c, "$cmd"]
      readinessProbe: {exec: {command: ["false"]}, periodSeconds: 5}
      securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: [ALL]}}
      resources: {requests: {cpu: 10m, memory: 16Mi}, limits: {memory: 64Mi}}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: lb-path-probe-$via
  namespace: $ns
  labels: {part-of: rd-zeto, party: $party}
spec:
  podSelector:
    matchLabels: {probe: lb-path-$via}
  policyTypes: [Egress]
  egress:
    - to:
$rule
      ports:
        - {protocol: TCP, port: $tport}
YAML
  exit 0
fi
if [[ $negative == 1 ]]; then
  [[ ${#targets[@]} -ge 1 && ${#targets[@]} -le 4 ]] || die "negative needs 1-4 --target IPv4:PORT"
  nc_cmd=""; i=0
  for t in "${targets[@]}"; do
    [[ "$t" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}:[0-9]{1,5}$ ]] || die "--target '$t' must be IPv4:PORT"
    i=$((i+1)); nc_cmd+="if nc -w 3 ${t%%:*} ${t##*:} </dev/null >/dev/null 2>&1; then echo T$i OPEN; else echo T$i BLOCKED; fi; "
  done
  nc_cmd+="if nc -w 3 paladin-pg 5432 </dev/null >/dev/null 2>&1; then echo CONTROL OPEN; else echo CONTROL BLOCKED; fi"
  ns="rd-zeto-$party"
  cat <<YAML
# The paladin-egress policy is the policy under test: this pod carries app=paladin so that it is SELECTED by it. It must never become a Service endpoint:
# readiness probe that never passes + no Service selector is a subset of its labels. Read the endpoints of every paladin Service before and after the run.
apiVersion: v1
kind: Pod
metadata:
  name: egress-negative-probe
  namespace: $ns
  labels: {app: paladin, probe: egress-negative, part-of: rd-zeto, party: $party}
spec:
  restartPolicy: Never
  activeDeadlineSeconds: 60
  automountServiceAccountToken: false
  securityContext: {runAsNonRoot: true, runAsUser: 65534, runAsGroup: 65534, seccompProfile: {type: RuntimeDefault}}
  containers:
    - name: probe
      image: $img
      command: [sh, -c, "$nc_cmd"]
      readinessProbe: {exec: {command: ["false"]}, periodSeconds: 5}
      securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: [ALL]}}
      resources: {requests: {cpu: 10m, memory: 16Mi}, limits: {memory: 64Mi}}
YAML
  exit 0
fi
[[ "$method" =~ ^[a-z]+_[A-Za-z]+$ ]] || die "--method must look like ptx_queryPendingTransactions"
[[ "$params" =~ ^[][{}\",:\ 0-9A-Za-z._-]+$ ]] || die "--params may only contain JSON-safe characters (no quotes ' ; \$ \` etc.)"
ns="rd-zeto-$party"; url="http://paladin-node$n:8548"
body="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":$params}"
# ids / shape: python3 (the pinned rd-bundle-sink image: python:3.12-alpine). The script travels as base64 inside ONE shell line (no file, no heredoc, read-only rootfs is fine).
py_head="import json,re,urllib.request
u='$url'
def rpc(m,p):
    r=urllib.request.Request(u,json.dumps({'jsonrpc':'2.0','id':1,'method':m,'params':p}).encode(),{'content-type':'application/json'})
    return json.load(urllib.request.urlopen(r,timeout=10))
"
if [[ "$mode" == ids ]]; then
  # The pending SET: COUNT n IDS <8-char ids sorted>. Bank A keeps ONE known prepare-only tx pending (no receipt, ever), so the gate compares the set, not 0.
  py="${py_head}try:
    r=rpc('ptx_queryPendingTransactions',[{'limit':100},False]); res=r.get('result')
    if 'error' in r or not isinstance(res,list): print('ERROR')
    else:
        ids=sorted(str(t.get('id',''))[:8] for t in res)
        print('COUNT %d IDS %s'%(len(ids),','.join(ids) or '-'))
except Exception: print('ERROR')
"
  script="echo $(printf '%s' "$py" | base64 -w0) | base64 -d | python3 -"
elif [[ "$mode" == shape ]]; then
  # STRUCTURE of the receipt(s) of one chain tx hash on THIS node, never values: the PD code + the first 60 chars of the domain error (after 0x-hex is masked), domainReceipt yes/no,
  # (a) the counts in states.confirmed/spent/read/info, (b) the counts in states.unavailable.*, (c) data:yes/no for ANY state entry, (d) unavailable-nil yes/no (pldapi/states.go:141-172), (e) the error code + domainReceipt yes/no.
  # R1-FINDING is appended when an entry carries data OR `unavailable` is nil while confirmed is non-empty.
  py="${py_head}try:
    f=rpc('ptx_queryTransactionReceipts',[{'limit':10,'eq':[{'field':'transactionHash','value':'$txhash'}]}])
    if 'error' in f or not isinstance(f.get('result'),list): print('ERROR'); raise SystemExit
    print('receipts %d'%len(f['result']))
    for i,rc in enumerate(f['result'],1):
        g=rpc('ptx_getTransactionReceiptFull',[rc['id']])
        if 'error' in g or not isinstance(g.get('result'),dict): print('receipt %d: ERROR'%i); continue
        x=g['result']; e=x.get('domainReceiptError')
        em='none' if not e else '%s %r'%((re.search(r'PD[0-9]{6}',e) or [None])[0] or 'unknown', re.sub(r'0x[0-9a-fA-F]{8,}','0x<h>',e)[:60])
        st=x.get('states') if isinstance(x.get('states'),dict) else {}
        un=st.get('unavailable') if isinstance(st.get('unavailable'),dict) else None
        cnt=lambda d,k: len(d.get(k) or []) if isinstance(d,dict) and isinstance(d.get(k) or [],list) else 0
        K=('confirmed','spent','read','info')
        dat=any(isinstance(y,dict) and 'data' in y for k in K if isinstance(st.get(k),list) for y in st[k])
        bad=dat or (un is None and cnt(st,'confirmed')>0)
        print('receipt %d: states %s | unavailable %s | unavailable-nil:%s | data:%s | domainReceiptError %s | domainReceipt %s%s'%(i,' '.join('%s=%d'%(k,cnt(st,k)) for k in K),' '.join('%s=%d'%(k,cnt(un,k)) for k in K),'yes' if un is None else 'no','yes' if dat else 'no',em,'yes' if x.get('domainReceipt') else 'no',' R1-FINDING' if bad else ''))
except SystemExit: pass
except Exception: print('ERROR')
"
  script="echo $(printf '%s' "$py" | base64 -w0) | base64 -d | python3 -"
elif [[ "$mode" == schemas ]]; then
  # Per receipt of one chain tx hash on THIS node, STRUCTURE only: the domainReceipt KEY names; for each of confirmed/spent/read/info the state entries grouped by schema (name from
  # pstate_listSchemas + 8-char schema id) split into data-carrying (a non-null, non-empty `data`) / without data (absent, null or empty), whether the entry's contractAddress is one of the given --zeto-token addresses (zeto/other/absent);
  # the 4 unavailable counts. Verdict: COIN-DATA = a data-carrying entry in a coin/lock schema (analyst STOP RULE, R1 break), OTHER-DATA = data in any other non-MerkleTree schema
  # (reported, not a break by itself), OK = data only in MerkleTree schemas. No state id, hash, amount, owner or data value is ever printed.
  py="${py_head}ZT=set(a.lower() for a in '$zetotokens'.split(',') if a)
try:
    f=rpc('ptx_queryTransactionReceipts',[{'limit':10,'eq':[{'field':'transactionHash','value':'$txhash'}]}])
    if 'error' in f or not isinstance(f.get('result'),list): print('ERROR'); raise SystemExit
    print('receipts %d'%len(f['result']))
    names={}
    for i,rc in enumerate(f['result'],1):
        g=rpc('ptx_getTransactionReceiptFull',[rc['id']])
        if 'error' in g or not isinstance(g.get('result'),dict): print('receipt %d: ERROR'%i); continue
        x=g['result']; dom=x.get('domain') or 'zeto'
        if dom not in names:
            l=rpc('pstate_listSchemas',[dom])
            if 'error' in l or not isinstance(l.get('result'),list): print('ERROR'); raise SystemExit
            names[dom]={str(s.get('id','')):str((s.get('definition') or {}).get('name') or 'unknown') for s in l['result']}
        st=x.get('states') if isinstance(x.get('states'),dict) else {}
        un=st.get('unavailable') if isinstance(st.get('unavailable'),dict) else {}
        dr=x.get('domainReceipt')
        dsc=lambda k,v: k+'{'+','.join(sk+':'+('filled' if sv else 'empty') for sk,sv in sorted(v.items()))+'}' if isinstance(v,dict) and v else k+':'+('filled' if v else 'empty')
        keys=','.join(dsc(k,v) for k,v in sorted(dr.items())) if isinstance(dr,dict) and dr else 'none'   # key names + nested key names, each only filled/empty, never a value
        coin=other=False; parts=[]
        for k in ('confirmed','spent','read','info'):
            wd={}; nd={}; ad={}
            for y in (st.get(k) if isinstance(st.get(k),list) else []):
                if not isinstance(y,dict): continue
                sid=str(y.get('schema','')); nm=names[dom].get(sid,'unknown'); lab='%s(%s)'%(nm,sid[2:10])
                has=y.get('data') not in (None,'',{},[])   # the key can be present as null/{} on an id-only stub: that carries NO data
                d=wd if has else nd
                d[lab]=d.get(lab,0)+1
                ca=y.get('contractAddress'); ad[lab]=('zeto' if str(ca).lower() in ZT else 'other') if ca else 'absent'
                if has and not nm.startswith('MerkleTree'):
                    if re.search('coin|lock',nm,re.I) or nm=='unknown': coin=True
                    else: other=True
            fmt=lambda d:' '.join('%s=%d'%kv for kv in sorted(d.items())) or 'none'
            parts.append('%s: data[%s] nodata[%s] addr[%s]'%(k,fmt(wd),fmt(nd),' '.join('%s=%s'%kv for kv in sorted(ad.items())) or 'none'))
        ucnt=' '.join('%s=%d'%(k,len(un.get(k) or []) if isinstance(un.get(k) or [],list) else 0) for k in ('confirmed','spent','read','info'))
        print('receipt %d: domain %s domainReceipt keys %s | %s | unavailable %s | %s'%(i,dom,keys,' | '.join(parts),ucnt,'COIN-DATA' if coin else 'OTHER-DATA' if other else 'OK'))
except SystemExit: pass
except Exception: print('ERROR')
"
  script="echo $(printf '%s' "$py" | base64 -w0) | base64 -d | python3 -"
elif [[ "$mode" == jq ]]; then
  script="curl -sS -m 10 -H 'content-type: application/json' -d '$body' $url | jq -r '.result | length'"
else
  script="R=\$(wget -q -T 10 -O - --header 'content-type: application/json' --post-data '$body' $url) || { echo ERROR; exit 1; }; case \"\$R\" in *'\"error\"'*) echo ERROR ;; *'\"result\":[]'*) echo 0 ;; *'\"result\":'*) echo NONZERO ;; *) echo ERROR ;; esac"
fi
sel='{rd/egress-locked: "true", app: node-probe}'
node="{app: paladin, app.kubernetes.io/name: paladin-node$n}"
cat <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: node-probe
  namespace: $ns
  labels: {"rd/egress-locked": "true", app: node-probe, part-of: rd-zeto, party: $party}
spec:
  restartPolicy: Never
  activeDeadlineSeconds: 60
  automountServiceAccountToken: false
  securityContext: {runAsNonRoot: true, runAsUser: 65534, runAsGroup: 65534, seccompProfile: {type: RuntimeDefault}}
  containers:
    - name: probe
      image: $img
      command: [sh, -c, "$(printf '%s' "$script" | sed 's/\\/\\\\/g; s/"/\\"/g')"]
      securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: [ALL]}}
      resources: {requests: {cpu: 10m, memory: 16Mi}, limits: {memory: 64Mi}}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: node-probe
  namespace: $ns
  labels: {part-of: rd-zeto, party: $party}
spec:
  podSelector:
    matchLabels: {"rd/egress-locked": "true", app: node-probe}
  policyTypes: [Egress, Ingress]
  egress:
    - to:
        - podSelector:
            matchLabels: $node
      ports:
        - {protocol: TCP, port: 8548}
    - to:
        - namespaceSelector:
            matchLabels: {kubernetes.io/metadata.name: kube-system}
          podSelector:
            matchLabels: {k8s-app: kube-dns}
      ports:
        - {protocol: UDP, port: 53}
        - {protocol: TCP, port: 53}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: node-probe-to-paladin
  namespace: $ns
  labels: {part-of: rd-zeto, party: $party}
spec:
  podSelector:
    matchLabels: $node
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels: {"rd/egress-locked": "true", app: node-probe}
      ports:
        - {protocol: TCP, port: 8548}
YAML
