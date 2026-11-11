#!/usr/bin/env bash
# Render the zeto S8 manifests (final-design/zeto/PLAN.md S8: Postgres per party) to stdout, or to DIR/<ns>-pg.yaml with -o.
#   render.sh [-o DIR] <bi|bank-a|bank-b|all>   Service + StatefulSet + NetworkPolicy paladin-pg (no Secret: created by the party, README)
#   render.sh probe <own> <other>               throwaway proof pods (psql select 1 from a Paladin pod; blocked from a control pod and from the other ns)
#   render.sh scratch <party>                   throwaway Postgres for the restore test (emptyDir)
#   render.sh --cluster 2 bank-c [--storage-class NAME]   the same for bank C on cluster 2 (StorageClass alicloud-essd, no cluster-1 node names, affinity limited to rd-zeto-bank-c)
# Needs bash + sed only. Never talks to a cluster. bank-c needs --cluster 2 and is not part of `all`.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
parties="bi bank-a bank-b"

die() { echo "render.sh: $*" >&2; exit 2; }
valid() { [[ " $parties " == *" $1 "* ]] || die "unknown party '$1' (allowed: $parties)"; }
subst() {
  if [[ "$1" == bank-c ]]; then
    # cluster 2: only StorageClass alicloud-essd, no cluster-1 hostnames, and no namespaceSelector (foreign namespaces live there)
    sed -e "s/\${PARTY}/$1/g" -e "s/\${NS}/rd-zeto-$1/g" -e 's/alicloud-essd-wffc .*/alicloud-essd/' -e '/member-16033 (97%/d' -e '/read from the live node labels by besu/d' \
        -e '/^        nodeAffinity:/,/^        podAntiAffinity:/{/^        podAntiAffinity:/!d}' \
        -e "s/namespaceSelector: {}/namespaces: [rd-zeto-$1]/" "$here/templates/$2"
  else
    sed -e "s/\${PARTY}/$1/g" -e "s/\${NS}/rd-zeto-$1/g" "$here/templates/$2"
  fi
}

if [[ "${1:-}" == --cluster ]]; then
  [[ "${2:-}" == 2 ]] || die "--cluster supports only 2"; shift 2
  [[ "${1:-}" == bank-c ]] || die "--cluster 2 renders bank-c only"; shift
  sc=alicloud-essd
  if [[ "${1:-}" == --storage-class ]]; then sc="${2:?--storage-class needs a name}"; [[ "$sc" =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]] || die "--storage-class must be a DNS-1123 name"; shift 2; fi
  [[ $# == 0 ]] || die "--cluster 2 bank-c [--storage-class NAME]"
  subst bank-c postgres.yaml | sed -e "s/storageClassName: alicloud-essd$/storageClassName: $sc/"; exit 0
fi

# tcp probe of paladin-pg in $2 from pod $1: OPEN, BLOCKED (timeout = policy drop), REFUSED (not a result)
tcp_probe() {
  local pod="$1" ns="$2" app="$3" target="$4"
  cat <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: $pod
  namespace: $ns
  labels: {throwaway: zeto-s8-probe, app: $app}
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  securityContext: {runAsNonRoot: true, runAsUser: 999, runAsGroup: 999}
  containers:
    - name: probe
      image: postgres:17.6@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929
      securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: [ALL]}}
      resources:
        requests: {cpu: 10m, memory: 32Mi}
        limits: {cpu: 100m, memory: 64Mi}
      command:
        - bash
        - -c
        - |
          r=ERROR
          for i in 1 2 3; do
            timeout 5 bash -c '</dev/tcp/paladin-pg.$target/5432' 2>/dev/null; rc=\$?
            if [ \$rc = 0 ]; then r=OPEN; break; fi
            if [ \$rc = 124 ]; then r=BLOCKED; else r=REFUSED; fi
            sleep 2
          done
          echo "$pod $target-5432 \$r"
YAML
}

probe() {
  valid "$1"; valid "$2"; [[ "$1" != "$2" ]] || die "probe needs two different parties"
  local own="rd-zeto-$1" other="rd-zeto-$2"
  cat <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: pgprobe-paladin
  namespace: $own
  labels: {throwaway: zeto-s8-probe, app: paladin}
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  securityContext: {runAsNonRoot: true, runAsUser: 999, runAsGroup: 999}
  containers:
    - name: probe
      image: postgres:17.6@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929
      securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: [ALL]}}
      resources:
        requests: {cpu: 10m, memory: 32Mi}
        limits: {cpu: 100m, memory: 64Mi}
      env:
        - {name: PGCONNECT_TIMEOUT, value: "5"}
        - name: PGUSER
          valueFrom: {secretKeyRef: {name: paladin-pg-credentials, key: username}}
        - name: PGPASSWORD
          valueFrom: {secretKeyRef: {name: paladin-pg-credentials, key: password}}
        - name: PGDATABASE
          valueFrom: {secretKeyRef: {name: paladin-pg-credentials, key: database}}
      command:
        - bash
        - -c
        - |
          r=ERROR
          for i in 1 2 3; do
            r=\$(psql -h paladin-pg -tAc 'select 1' 2>&1) && break
            sleep 2
          done
          echo "pgprobe-paladin select1 \$r"
YAML
  echo '---'; tcp_probe pgprobe-control "$own" pgprobe-control "$own"
  echo '---'; tcp_probe pgprobe-other "$other" paladin "$own"
}

emit_all() { local first=1 p; for p in $parties; do [[ $first == 1 ]] || echo '---'; first=0; subst "$p" postgres.yaml; done; }

out=""
if [[ "${1:-}" == -o ]]; then out="${2:?-o needs a directory}"; shift 2; fi
case "${1:-}" in
  probe)   shift; [[ $# == 2 ]] || die "usage: render.sh probe <own-party> <other-party>"; probe "$@" ;;
  scratch) shift; [[ $# == 1 ]] || die "usage: render.sh scratch <party>"; valid "$1"; subst "$1" pg-scratch.yaml ;;
  all)
    if [[ -n "$out" ]]; then mkdir -p "$out"; for p in $parties; do subst "$p" postgres.yaml > "$out/rd-zeto-$p-pg.yaml"; done
    else emit_all; fi ;;
  "") die "usage: render.sh [-o DIR] <bi|bank-a|bank-b|all> | probe <own> <other> | scratch <party>" ;;
  *)
    valid "$1"; [[ $# == 1 ]] || die "unexpected arguments after $1 (--storage-class only with --cluster 2 bank-c)"
    if [[ -n "$out" ]]; then mkdir -p "$out"; subst "$1" postgres.yaml > "$out/rd-zeto-$1-pg.yaml"; else subst "$1" postgres.yaml; fi ;;
esac
