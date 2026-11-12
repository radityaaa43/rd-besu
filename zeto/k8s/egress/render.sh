#!/usr/bin/env bash
# Narrow egress per zeto key-holding workload (R17-zeto-other), SELECTOR FORM. Prints one NetworkPolicy / one Pod / the baseline to stdout. Never talks to a cluster.
#   render.sh workload <bank-gw|bundle-server|besu-validator|paladin-pg|paladin-operator> <party> [--kube-api-ip IPv4]... [--other-cluster-lb IPv4]...
#       one NetworkPolicy <workload>-egress in rd-zeto-<party>, selecting the workload by its identity label (matchLabels only):
#       bank-gw           app=bank-gw         paladin-node<N> pod 8548, besu-validator pod 8545, bundle-server pod 8080 + 8081, kube-dns 53        (no option)
#       bundle-server     app=bundle-server   kube-dns 53 only (the sink signs locally with the opa binary)                                          (no option)
#       paladin-pg        app=paladin-pg      kube-dns 53 only                                                                                       (no option)
#       paladin-operator  name=paladin-operator  the kube API ENDPOINT IPs /32 :6443 (--kube-api-ip, repeatable, REQUIRED) + kube-dns 53
#       besu-validator    name=besu-validator    p2p 30303 to the other new validators: same cluster by namespace + pod, the old validators (ns besu), the other cluster by LB /32
#                         (--other-cluster-lb = the besu-p2p LB of each OTHER-cluster validator: exactly 1 for bi|bank-a|bank-b (bank-c), exactly 3 for bank-c) + kube-dns 53
#   render.sh baseline <party>
#       the EDITED allow-dns-egress of rd-zeto-<party> (what ../templates/party.yaml now renders): it no longer selects the five workloads above. Apply it only after the
#       workload policies exist and the probe has run: until then the old baseline keeps the union OPEN (policies are additive).
#   render.sh probe <workload> <party> --image REF@sha256:<64 hex> --target IPv4:PORT [--target ...] --control HOST:PORT
#       Pod egress-negative-probe: carries the policy's selector label + rd/egress-locked=true (the baseline, old and new, does not select it, so ONLY <workload>-egress applies to it,
#       even before the baseline edit); never Ready, so never an endpoint; prints T<n> BLOCKED|OPEN per target and CONTROL OPEN|BLOCKED (the control is a destination the policy ALLOWS).
# bank-c is cluster 2: it is its own cluster, so it dials the three cluster-1 validators by their LB IPs (3 x --other-cluster-lb); the cluster-1 parties dial bank-c by its LB IP (1 x).
# Form rule (orchestrator 2026-11-12; probe proof: ipBlock <same-cluster address>/32 is CLOSED on this CNI): same-cluster peers by exact namespaceSelector + podSelector, ipBlock /32 ONLY for the
# other cluster and the kube API endpoints, DNS by the kube-dns selector, no wildcard namespaceSelector, no podSelector {}.
# Pod labels are NOT changed by anything here (no restart): the policies select the labels the pods already carry. Needs bash + awk only.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
die() { echo "render.sh: $*" >&2; exit 2; }
parties="bi bank-a bank-b bank-c"
workloads="bank-gw bundle-server besu-validator paladin-pg paladin-operator"
party_ok() { [[ " $parties " == *" $1 "* ]] || die "unknown party '$1' (allowed: $parties)"; }
workload_ok() { [[ " $workloads " == *" $1 "* ]] || die "unknown workload '$1' (allowed: $workloads)"; }
num() { case "$1" in bi) echo 1 ;; bank-a) echo 2 ;; bank-b) echo 3 ;; bank-c) echo 4 ;; esac; }
ipv4() { local o; [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1; for o in ${1//./ }; do (( 10#$o <= 255 )) || return 1; done; }
lbl() { # lbl <party> : metadata labels (cluster 2 for bank-c)
  if [[ "$1" == bank-c ]]; then echo "{part-of: rd-zeto, party: bank-c, cluster: \"2\"}"; else echo "{part-of: rd-zeto, party: $1}"; fi
}
selector_of() { # the identity label of each workload = the label the baseline excludes
  case "$1" in
    bank-gw) echo "{app: bank-gw}" ;; bundle-server) echo "{app: bundle-server}" ;; paladin-pg) echo "{app: paladin-pg}" ;;
    besu-validator) echo "{app.kubernetes.io/name: besu-validator}" ;; paladin-operator) echo "{app.kubernetes.io/name: paladin-operator}" ;;
  esac
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
peer() { # peer <ns> <matchLabels flow map> : one namespace + pod destination
  cat <<YAML
        - namespaceSelector:
            matchLabels: {kubernetes.io/metadata.name: $1}
          podSelector:
            matchLabels: $2
YAML
}
rule() { # rule <ports flow list> : the "to:" list is read from stdin
  echo "    - to:"; cat; echo "      ports: [$1]"
}

policy() { # policy <workload> <party> [--kube-api-ip IP]... [--other-cluster-lb IP]...
  local w="$1" p="$2" kube=() lbs=() ip k; shift 2
  workload_ok "$w"; party_ok "$p"
  while [[ $# -gt 0 ]]; do case "$1" in
    --kube-api-ip) kube+=("${2:-}"); shift 2 ;;
    --other-cluster-lb) lbs+=("${2:-}"); shift 2 ;;
    *) die "unknown option '$1'" ;; esac; done
  for ip in "${kube[@]:-}" "${lbs[@]:-}"; do [[ -z "$ip" ]] || ipv4 "$ip" || die "'$ip' is not an IPv4 address"; done
  [[ "$(printf '%s\n' "${kube[@]:-}" "${lbs[@]:-}" | grep -v '^$' | sort | uniq -d)" == "" ]] || die "duplicate IP"
  if [[ "$w" == paladin-operator ]]; then [[ ${#kube[@]} -ge 1 && ${#kube[@]} -le 8 ]] || die "paladin-operator needs 1-8 --kube-api-ip <kube API endpoint IP> (not the Service ClusterIP)"
  else [[ ${#kube[@]} == 0 ]] || die "--kube-api-ip is for paladin-operator only"; fi
  if [[ "$w" == besu-validator ]]; then
    local want=1; [[ "$p" == bank-c ]] && want=3
    [[ ${#lbs[@]} == $want ]] || die "besu-validator $p needs exactly $want --other-cluster-lb (the besu-p2p LB of each validator on the other cluster)"
  else [[ ${#lbs[@]} == 0 ]] || die "--other-cluster-lb is for besu-validator only"; fi
  local ns="rd-zeto-$p"
  cat <<YAML
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: $w-egress
  namespace: $ns
  labels: $(lbl "$p")
spec:
  podSelector:
    matchLabels: $(selector_of "$w")
  policyTypes: [Egress]
  egress:
YAML
  case "$w" in
    bank-gw)
      peer "$ns" "{app: paladin, app.kubernetes.io/name: paladin-node$(num "$p")}" | rule "{protocol: TCP, port: 8548}"
      peer "$ns" "{app.kubernetes.io/name: besu-validator}" | rule "{protocol: TCP, port: 8545}"
      peer "$ns" "{app: bundle-server}" | rule "{protocol: TCP, port: 8080}, {protocol: TCP, port: 8081}"
      dns ;;
    bundle-server|paladin-pg) dns ;;
    paladin-operator)
      for ip in "${kube[@]}"; do echo "        - ipBlock: {cidr: $ip/32}"; done | rule "{protocol: TCP, port: 6443}"
      dns ;;
    besu-validator)
      if [[ "$p" != bank-c ]]; then
        for k in bi bank-a bank-b; do [[ "$k" == "$p" ]] || peer "rd-zeto-$k" "{app.kubernetes.io/name: besu-validator}"; done | rule "{protocol: TCP, port: 30303}"
        # old validators (ns besu, still running as non-validators): ONE matchLabels peer per pod. The matchExpressions `In` form did not match on this CNI (live positive leg BLOCKED 2026-11-12).
        for i in 1 2 3 4; do
          printf '        - namespaceSelector:\n            matchLabels: {kubernetes.io/metadata.name: besu}\n          podSelector:\n            matchLabels: {statefulset.kubernetes.io/pod-name: besu-node-validator-%s-0}\n' "$i"
        done | rule "{protocol: TCP, port: 30303}"
      fi
      for ip in "${lbs[@]}"; do echo "        - ipBlock: {cidr: $ip/32}"; done | rule "{protocol: TCP, port: 30303}"
      dns ;;
  esac
}

baseline() { # the allow-dns-egress object of the party render (templates/party.yaml), nothing else
  local c2=(); [[ "$1" == bank-c ]] && c2=(--cluster 2)
  "$here/../render.sh" "${c2[@]}" "$1" | awk '/^---$/ { if (doc ~ /\n  name: allow-dns-egress\n/) printf "%s", doc; doc = ""; next } { doc = doc $0 "\n" } END { if (doc ~ /\n  name: allow-dns-egress\n/) printf "%s", doc }'
}

probe() { # probe <workload> <party> --image REF --target IP:PORT... --control HOST:PORT
  local w="$1" p="$2" img="" control="" targets=() t; shift 2
  workload_ok "$w"; party_ok "$p"
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
  local sel="" x=""; sel="$(selector_of "$w")"; sel="${sel#\{}"; sel="${sel%\}}"
  [[ "$w" != bank-gw ]] || x=", node: egress-probe"   # the gateway Service/ReplicaSet select app+node=node<N>: this label keeps the probe out of them
  [[ "$p" != bank-c ]] || x+=', cluster: "2"'
  cat <<YAML
# The egress policy under test ($w-egress) selects this pod by its identity label; rd/egress-locked keeps allow-dns-egress (old and new) off it, so $w-egress is the ONLY egress policy
# that applies. It must never become an endpoint: its readiness probe never passes. It is no controller's pod: the name is no <statefulset>-<ordinal>, and it lacks the pod-template-hash
# label every ReplicaSet selector of a Deployment carries. Read the endpoints of the workload's Services before and after the run.
apiVersion: v1
kind: Pod
metadata:
  name: egress-negative-probe
  namespace: rd-zeto-$p
  labels: {$sel, rd/egress-locked: "true", probe: egress-negative, part-of: rd-zeto, party: $p$x}
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

[[ $# -ge 2 ]] || die "usage: render.sh workload <workload> <party> [--kube-api-ip IPv4]... [--other-cluster-lb IPv4]... | render.sh baseline <party> | render.sh probe <workload> <party> --image REF@sha256:.. --target IPv4:PORT... --control HOST:PORT"
cmd="$1"; shift
case "$cmd" in
  workload) [[ $# -ge 2 ]] || die "workload needs <workload> <party>"; policy "$@" ;;
  probe) [[ $# -ge 2 ]] || die "probe needs <workload> <party>"; probe "$@" ;;
  baseline) [[ $# == 1 ]] || die "usage: render.sh baseline <party>"; party_ok "$1"; baseline "$1" ;;
  *) die "unknown command '$cmd' (allowed: workload probe baseline)" ;;
esac
