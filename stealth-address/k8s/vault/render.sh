#!/usr/bin/env bash
# Render the stealth S7 manifests (final-design/stealth/PLAN.md S7: per-party key store, Vault) to stdout, or to DIR/<ns>-vault.yaml with -o.
#   render.sh [-o DIR] <bi|bank-a|bank-b|all>   ServiceAccount stealth-signer + NetworkPolicy vault-ingress (the Vault server itself = the upstream chart, values below)
#   render.sh values <party>                    values for hashicorp/vault chart 0.34.1 (install command in values.yaml)
#   render.sh cluster <party>                   ClusterRoleBinding vault-auth-delegator-<ns> (cluster operator applies it)
#   render.sh probe <own> <other>               throwaway proof pods (signer reads OK; other pods blocked or login denied), prints no secret value
# Needs bash + sed only. Never talks to a cluster. Cluster 2 (bank-c) is out of scope and refused.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
parties="bi bank-a bank-b"
IMAGE="hashicorp/vault:2.0.4"

die() { echo "render.sh: $*" >&2; exit 2; }
valid() { [[ " $parties " == *" $1 "* ]] || die "unknown party '$1' (allowed: $parties)"; }
subst() { valid "$1"; sed -e "s/\${PARTY}/$1/g" -e "s/\${NS}/rd-stealth-$1/g" "$2"; }

pod_head() { # name ns app serviceAccount
  cat <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: $1
  namespace: $2
  labels: {throwaway: stealth-s7-probe, app: $3}
spec:
  serviceAccountName: $4
  restartPolicy: Never
  securityContext: {runAsNonRoot: true, runAsUser: 100, runAsGroup: 1000}
  containers:
    - name: probe
      image: $IMAGE
      securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: [ALL]}}
      resources:
        requests: {cpu: 10m, memory: 32Mi}
        limits: {cpu: 100m, memory: 128Mi}
      command:
        - sh
        - -c
        - |
YAML
}

login_probe() { # name ns app sa target_ns  (login with the pod's own token, read the path to /dev/null: never prints a value)
  pod_head "$1" "$2" "$3" "$4"
  cat <<YAML
          export VAULT_ADDR=http://vault.$5.svc:8200
          jwt=\$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)
          tok=\$(vault write -field=token auth/kubernetes/login role=stealth-signer jwt="\$jwt" 2>/dev/null) || { echo "$1 LOGIN-DENIED"; exit 0; }
          if [ "$4" = stealth-signer ]; then
            VAULT_TOKEN=\$tok vault kv get secret/stealth-keys >/dev/null 2>&1 && echo "$1 READ-OK" || echo "$1 READ-DENIED"
          else
            echo "$1 LOGIN-OK-UNEXPECTED"
          fi
YAML
}

tcp_probe() { # name ns app target_ns
  pod_head "$1" "$2" "$3" default
  cat <<YAML
          r=ERROR
          for i in 1 2 3; do
            timeout 5 nc -z vault.$4.svc 8200; rc=\$?
            if [ \$rc = 0 ]; then r=OPEN; break; fi
            if [ \$rc = 143 ] || [ \$rc = 124 ]; then r=BLOCKED; else r=REFUSED; fi
            sleep 2
          done
          echo "$1 $4-8200 \$r"
YAML
}

probe() {
  valid "$1"; valid "$2"; [[ "$1" != "$2" ]] || die "probe needs two different parties"
  local own="rd-stealth-$1" other="rd-stealth-$2"
  login_probe vprobe-signer  "$own"   stealth-signer stealth-signer "$own"; echo '---'
  login_probe vprobe-wrongsa "$own"   stealth-signer default        "$own"; echo '---'
  tcp_probe   vprobe-gw      "$own"   st-gw          "$own";                echo '---'
  tcp_probe   vprobe-other   "$other" stealth-signer "$own"
}

emit_all() { local first=1 p; for p in $parties; do [[ $first == 1 ]] || echo '---'; first=0; subst "$p" "$here/templates/access.yaml"; done; }

out=""
if [[ "${1:-}" == -o ]]; then out="${2:?-o needs a directory}"; shift 2; fi
case "${1:-}" in
  values)  shift; [[ $# == 1 ]] || die "usage: render.sh values <party>"; subst "$1" "$here/values.yaml" ;;
  cluster) shift; [[ $# == 1 ]] || die "usage: render.sh cluster <party>"; subst "$1" "$here/templates/auth-delegator.yaml" ;;
  probe)   shift; [[ $# == 2 ]] || die "usage: render.sh probe <own-party> <other-party>"; probe "$@" ;;
  all)
    if [[ -n "$out" ]]; then mkdir -p "$out"; for p in $parties; do subst "$p" "$here/templates/access.yaml" > "$out/rd-stealth-$p-vault.yaml"; done
    else emit_all; fi ;;
  "") die "usage: render.sh [-o DIR] <bi|bank-a|bank-b|all> | values <party> | cluster <party> | probe <own> <other>" ;;
  *)
    if [[ -n "$out" ]]; then mkdir -p "$out"; subst "$1" "$here/templates/access.yaml" > "$out/rd-stealth-$1-vault.yaml"; else subst "$1" "$here/templates/access.yaml"; fi ;;
esac
