#!/usr/bin/env bash
# Narrow egress per stealth workload (R17-stealth gate), SELECTOR FORM. Prints one NetworkPolicy (or one probe Pod) to stdout. Never talks to a cluster.
#   render.sh signer <bi|bank-a|bank-b|bank-c> [--cert-lb-ip IPv4]   stealth-signer-egress: besu-rpc 8545 (own ns), the BI cert door st-gw-1:8550, kube-dns 53
#                                                                    bank-c (cluster 2) reaches the door only through the st-gw-1-ext LB: --cert-lb-ip is REQUIRED there and refused elsewhere
#   render.sh signer bi --kube-api-ip IPv4 [--kube-api-ip ...]      (S11 rework) adds ONE rule: ipBlock <IP>/32 TCP 6443 per kube API ENDPOINT IP (kubectl get endpoints kubernetes at apply time; the Service
#                                                                    ClusterIP and pod IPs are CLOSED on this CNI) so the BI signer can patch its one Secret. The BI signer only; the form without the option is unchanged.
#   render.sh viewpush <bank-a|bank-b|bank-c> [--cert-lb-ip IPv4]    stealth-viewpush-egress (S11 rework, the one-off view-key push Job): ONLY the own-ns bank signer :8080, the BI door st-gw-1:8550 (like the signer: bank-c
#                                                                    through the LB, --cert-lb-ip REQUIRED there and refused elsewhere), kube-dns 53. No besu-rpc, no kube API. bi has no push Job.
#   render.sh custodian bi                                           stealth-custodian-egress: besu-rpc 8545, kube-dns 53
#   render.sh compare bi                                             stealth-viewkey-egress (the S11 CronJob): besu-rpc 8545, kube-dns 53
#   render.sh gateway <bi|bank-a|bank-b|bank-c>                      st-gw-egress: the signer :8080 (bi also the custodian :9443), bundle-server of the party's zeto ns :8080, kube-dns 53
#   render.sh besu-rpc <party> [--multi-peer --other-cluster-lb IPv4...]
#                                                                    besu-rpc-egress (R17-zeto-other; selects the live label app.kubernetes.io/name=besu-rpc, no pod change): p2p 30303 to the OWN party's zeto validator
#                                                                    (namespace rd-zeto-<party> + pod name=besu-validator; bank-c's own is on its cluster 2 too), kube-dns 53. --multi-peer (the catch-up phase,
#                                                                    README "Initial sync") = every zeto validator: same cluster by namespace + pod, the other cluster by LB /32: --other-cluster-lb exactly
#                                                                    1 for bi|bank-a|bank-b (bank-c's besu-p2p LB), exactly 3 for bank-c (the cluster-1 besu-p2p LBs)
#   render.sh vault <bi|bank-a|bank-b|bank-c> --kube-api-ip IPv4 [--kube-api-ip ...]
#                                                                    vault-egress (R17-zeto-other; selects the live chart pod label app.kubernetes.io/name=vault, no pod change): ONLY the kube API endpoint IPs
#                                                                    ipBlock <IP>/32 TCP 6443 (kubernetes auth: Vault calls TokenReview; 1 to 8 IPs, required, no duplicate; same as 'signer bi') + kube-dns 53.
#                                                                    File storage, no outbound, no peers. The Vault pod holds the keys at rest and a ServiceAccount token.
#   render.sh baseline <party>                                       the EDITED allow-dns-egress of rd-stealth-<party> (templates/party.yaml: it no longer selects besu-rpc or vault); apply it only after besu-rpc-egress / vault-egress + their probes
#   render.sh probe <workload> <party> --image REF@sha256:<64 hex> --target IPv4:PORT [--target ...] --control HOST:PORT
#                                                                    Pod egress-negative-probe: labelled rd/egress-locked=true + rd/egress=<profile> so the policy above selects it; never Ready, so never an
#                                                                    endpoint; prints T<n> BLOCKED|OPEN per target and CONTROL OPEN|BLOCKED (the control is a destination the policy ALLOWS)
# Form rule (orchestrator 2026-11-12; probe proof: ipBlock <same-cluster address>/32 is CLOSED on this CNI): same-cluster peers by exact namespaceSelector + podSelector, ipBlock /32 ONLY for the other
# cluster, DNS by the kube-dns selector, no wildcard namespaceSelector, no podSelector {}. The kube API is in NONE of these (no workload mounts a ServiceAccount token), except signer bi --kube-api-ip.
# Workload pods carry rd/egress-locked=true (so allow-dns-egress, templates/party.yaml, does not select them: policies are additive) and rd/egress=<profile> (the label these policies select).
# A pod with the first label and no policy is NOT locked down (no Egress policy selecting it = open): apply the policy, prove the union, THEN start the pod.
# Needs bash only.
set -euo pipefail
die() { echo "render.sh: $*" >&2; exit 2; }
parties="bi bank-a bank-b bank-c"
party_ok() { [[ " $parties " == *" $1 "* ]] || die "unknown party '$1' (allowed: $parties)"; }
lbl() { # lbl <party> : metadata labels (cluster 2 for bank-c)
  if [[ "$1" == bank-c ]]; then echo "{part-of: rd-stealth, party: bank-c, cluster: \"2\"}"; else echo "{part-of: rd-stealth, party: $1}"; fi
}
dns() { cat <<'YAML'
    - to:
        - namespaceSelector:
            matchLabels: {kubernetes.io/metadata.name: kube-system}
          podSelector:
            matchLabels: {k8s-app: kube-dns}
      ports:
        - {protocol: UDP, port: 53}
        - {protocol: TCP, port: 53}
YAML
}
rpc() { cat <<'YAML'
    - to:
        - podSelector:
            matchLabels: {app.kubernetes.io/name: besu-rpc}
      ports:
        - {protocol: TCP, port: 8545}
YAML
}
gwrpc() { # gwrpc <party>: S17 2026-11-12 topology, the party's own bank-gw Besu door (mTLS + OPA method allowlist) replaces the besu-rpc JWT node
  cat <<YAML
    - to:
        - namespaceSelector:
            matchLabels: {kubernetes.io/metadata.name: rd-zeto-$1}
          podSelector:
            matchLabels: {app: bank-gw}
      ports:
        - {protocol: TCP, port: 8545}
YAML
}
header() { # header <policy name> <profile> <party>
  cat <<YAML
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: $1
  namespace: rd-stealth-$3
  labels: $(lbl "$3")
spec:
  podSelector:
    matchLabels: $(pol_sel "$2")
  policyTypes: [Egress]
  egress:
YAML
}
pol_sel() { # pol_sel <profile> : the flow map the policy selects (besu-rpc and vault keep their live label; the others carry rd/egress)
  if [[ "$1" == besu-rpc || "$1" == vault ]]; then echo "{app.kubernetes.io/name: $1}"; else echo "{rd/egress: $1}"; fi
}
ipv4() { local o; [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1; for o in ${1//./ }; do (( 10#$o <= 255 )) || return 1; done; }

profile_of() { case "$1" in besu-rpc) echo besu-rpc ;; vault) echo vault ;; signer) echo stealth-signer ;; custodian) echo stealth-custodian ;; compare) echo stealth-viewkey ;; gateway) echo st-gw ;; viewpush) echo stealth-viewpush ;; *) die "unknown workload '$1' (allowed: besu-rpc vault signer custodian compare gateway viewpush)" ;; esac; }

workload_ok() { # workload_ok <workload> <party> : custodian and compare exist in rd-stealth-bi only
  party_ok "$2"
  case "$1" in custodian|compare) [[ "$2" == bi ]] || die "$1 exists in rd-stealth-bi only" ;; viewpush) [[ "$2" != bi ]] || die "viewpush exists in the bank namespaces only" ;; esac
}

zeto_peer() { # zeto_peer <party> : the new validator of that party (same cluster: namespace + pod)
  cat <<YAML
        - namespaceSelector:
            matchLabels: {kubernetes.io/metadata.name: rd-zeto-$1}
          podSelector:
            matchLabels: {app.kubernetes.io/name: besu-validator}
YAML
}

policy() { # policy <workload> <party> [--cert-lb-ip IP] [--kube-api-ip IP]... [--multi-peer] [--other-cluster-lb IP]...
  local w="$1" p="$2" lb="" kips=() k multi=0 lbs=() ip; shift 2
  workload_ok "$w" "$p"
  while [[ $# -gt 0 ]]; do case "$1" in
    --cert-lb-ip) lb="${2:-}"; shift 2 ;;
    --kube-api-ip) [[ $# -ge 2 ]] || die "--kube-api-ip needs an IPv4"; kips+=("$2"); shift 2 ;;
    --multi-peer) multi=1; shift ;;
    --other-cluster-lb) lbs+=("${2:-}"); shift 2 ;;
    *) die "unknown option '$1'" ;; esac; done
  if [[ ${#kips[@]} -gt 0 ]]; then
    [[ ( "$w" == signer && "$p" == bi ) || "$w" == vault ]] || die "--kube-api-ip is for 'signer bi' and 'vault <party>' only (no other workload mounts a ServiceAccount token)"
    for k in "${kips[@]}"; do ipv4 "$k" || die "bad --kube-api-ip '$k' (an endpoint IPv4)"; done
  fi
  if [[ "$w" == vault ]]; then
    [[ ${#kips[@]} -ge 1 && ${#kips[@]} -le 8 ]] || die "vault needs 1-8 --kube-api-ip (the kube API endpoint IPs, kubectl get endpoints kubernetes)"
    [[ "$(printf '%s\n' "${kips[@]}" | sort | uniq -d)" == "" ]] || die "duplicate --kube-api-ip"
  fi
  if [[ "$w" == besu-rpc && $multi == 1 ]]; then
    local want=1; [[ "$p" == bank-c ]] && want=3
    [[ ${#lbs[@]} == $want ]] || die "besu-rpc $p --multi-peer needs exactly $want --other-cluster-lb (the besu-p2p LB of each zeto validator on the other cluster)"
    for ip in "${lbs[@]}"; do ipv4 "$ip" || die "'$ip' is not an IPv4 address"; done
    [[ "$(printf '%s\n' "${lbs[@]}" | sort | uniq -d)" == "" ]] || die "duplicate --other-cluster-lb"
  else [[ $multi == 0 && ${#lbs[@]} == 0 ]] || die "--multi-peer / --other-cluster-lb are for 'besu-rpc <party> --multi-peer' only"; fi
  if [[ ( "$w" == signer || "$w" == viewpush ) && "$p" == bank-c ]]; then ipv4 "$lb" || die "$w bank-c needs --cert-lb-ip <IPv4> (the st-gw-1-ext LB: bank-c is on cluster 2)"
  else [[ -z "$lb" ]] || die "--cert-lb-ip is for 'signer bank-c' and 'viewpush bank-c' only (same-cluster peers go by selector)"; fi
  case "$w" in
    besu-rpc)
      header besu-rpc-egress besu-rpc "$p"
      echo "    - to:"
      if [[ $multi == 1 ]]; then
        if [[ "$p" == bank-c ]]; then zeto_peer bank-c; else for k in bi bank-a bank-b; do zeto_peer "$k"; done; fi
        echo "      ports:"; echo "        - {protocol: TCP, port: 30303}"
        echo "    - to:"; for ip in "${lbs[@]}"; do echo "        - ipBlock: {cidr: $ip/32}"; done
      else zeto_peer "$p"; fi
      echo "      ports:"; echo "        - {protocol: TCP, port: 30303}"
      dns ;;
    signer|viewpush)
      if [[ "$w" == signer ]]; then header stealth-signer-egress stealth-signer "$p"; gwrpc "$p"
      else header stealth-viewpush-egress stealth-viewpush "$p"; cat <<'YAML'
    - to:
        - podSelector:
            matchLabels: {app: stealth-signer, role: bank}
      ports:
        - {protocol: TCP, port: 8080}
YAML
      fi
      if [[ "$p" == bi ]]; then cat <<'YAML'
    - to:
        - podSelector:
            matchLabels: {app: st-gw, node: node1}
      ports:
        - {protocol: TCP, port: 8550}
YAML
      elif [[ "$p" == bank-c ]]; then cat <<YAML
    - to:
        - ipBlock: {cidr: $lb/32}
      ports:
        - {protocol: TCP, port: 8550}
YAML
      else cat <<'YAML'
    - to:
        - namespaceSelector:
            matchLabels: {kubernetes.io/metadata.name: rd-stealth-bi}
          podSelector:
            matchLabels: {app: st-gw, node: node1}
      ports:
        - {protocol: TCP, port: 8550}
YAML
      fi
      if [[ ${#kips[@]} -gt 0 ]]; then
        echo "    - to:"
        for k in "${kips[@]}"; do echo "        - ipBlock: {cidr: $k/32}"; done
        printf '      ports:\n        - {protocol: TCP, port: 6443}\n'
      fi
      dns ;;
    vault)
      header vault-egress vault "$p"
      echo "    - to:"
      for k in "${kips[@]}"; do echo "        - ipBlock: {cidr: $k/32}"; done
      printf '      ports:\n        - {protocol: TCP, port: 6443}\n'
      dns ;;
    custodian) header stealth-custodian-egress stealth-custodian "$p"; gwrpc "$p"; dns ;;
    compare) header stealth-viewkey-egress stealth-viewkey "$p"; rpc; dns ;;
    gateway)
      header st-gw-egress st-gw "$p"
      cat <<'YAML'
    - to:
        - podSelector:
            matchLabels: {app: stealth-signer}
            matchExpressions:
              - {key: role, operator: In, values: [bank, bi]}
      ports:
        - {protocol: TCP, port: 8080}
YAML
      if [[ "$p" == bi ]]; then cat <<'YAML'
    - to:
        - podSelector:
            matchLabels: {app: stealth-signer, role: custodian}
      ports:
        - {protocol: TCP, port: 9443}
YAML
      fi
      cat <<YAML
    - to:
        - namespaceSelector:
            matchLabels: {kubernetes.io/metadata.name: rd-zeto-$p}
          podSelector:
            matchLabels: {app: bundle-server}
      ports:
        - {protocol: TCP, port: 8080}
YAML
      dns ;;
  esac
}

probe() { # probe <workload> <party> --image REF --target IP:PORT... --control HOST:PORT
  local w="$1" p="$2" img="" control="" targets=() t; shift 2
  workload_ok "$w" "$p"
  while [[ $# -gt 0 ]]; do case "$1" in
    --image) img="${2:-}"; shift 2 ;;
    --target) targets+=("${2:-}"); shift 2 ;;
    --control) control="${2:-}"; shift 2 ;;
    *) die "unknown option '$1'" ;; esac; done
  [[ "$img" =~ ^[A-Za-z0-9._/:-]+@sha256:[0-9a-f]{64}$ ]] || die "--image must be digest-pinned (REF@sha256:<64 lowercase hex>)"
  [[ ${#targets[@]} -ge 1 && ${#targets[@]} -le 4 ]] || die "probe needs 1-4 --target IPv4:PORT"
  [[ "$control" =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?:[0-9]{1,5}$ ]] || die "--control must be HOST:PORT (a destination the policy allows)"
  local cmd="" i=0
  for t in "${targets[@]}"; do
    [[ "$t" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}:[0-9]{1,5}$ ]] && ipv4 "${t%%:*}" || die "--target '$t' must be IPv4:PORT"
    i=$((i+1)); cmd+="if nc -w 3 ${t%%:*} ${t##*:} </dev/null >/dev/null 2>&1; then echo T$i OPEN; else echo T$i BLOCKED; fi; "
  done
  cmd+="if nc -w 3 ${control%%:*} ${control##*:} </dev/null >/dev/null 2>&1; then echo CONTROL OPEN; else echo CONTROL BLOCKED; fi"
  local prof; prof="$(profile_of "$w")" cl="" pl="rd/egress: $prof"
  [[ "$w" != besu-rpc && "$w" != vault ]] || pl="app.kubernetes.io/name: $w"   # the live pod has no rd/egress label; the policy selects its identity label.
  # vault: ONLY that label (not instance/component), so the chart StatefulSet selector (name+instance+component) never adopts the probe and no chart Service selects it
  [[ "$p" != bank-c ]] || cl=', cluster: "2"'
  cat <<YAML
# The egress policy under test selects this pod by ${pl}. It must never become a Service endpoint: its readiness probe never passes, and it carries neither app=stealth-signer, app=st-gw
# nor any other label a real Service selects. Read the endpoints of the stealth Services before and after the run.
apiVersion: v1
kind: Pod
metadata:
  name: egress-negative-probe
  namespace: rd-stealth-$p
  labels: {rd/egress-locked: "true", $pl, app: egress-negative-probe, probe: egress-negative, part-of: rd-stealth, party: $p$cl}
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
YAML
}

[[ $# -ge 2 ]] || die "usage: render.sh <besu-rpc|vault|signer|custodian|compare|gateway|viewpush> <party> [--cert-lb-ip IPv4] | render.sh probe <workload> <party> --image REF@sha256:.. --target IPv4:PORT... --control HOST:PORT"
if [[ "$1" == baseline ]]; then
  [[ $# == 2 ]] || die "usage: render.sh baseline <party>"; party_ok "$2"
  c2=(); [[ "$2" == bank-c ]] && c2=(--cluster 2)
  "$(cd "$(dirname "$0")" && pwd)/../render.sh" "${c2[@]}" "$2" | awk '/^---$/ { if (doc ~ /\n  name: allow-dns-egress\n/) printf "%s", doc; doc = ""; next } { doc = doc $0 "\n" } END { if (doc ~ /\n  name: allow-dns-egress\n/) printf "%s", doc }'
  exit 0
fi
if [[ "$1" == probe ]]; then shift; [[ $# -ge 2 ]] || die "probe needs <workload> <party>"; profile_of "$1" >/dev/null; probe "$@"; exit 0; fi
profile_of "$1" >/dev/null
policy "$@"
