#!/usr/bin/env bash
# Render the zeto S17 bundle-server of one party (final-design/zeto/PLAN.md S17) to stdout:
#   render.sh <bi|bank-a|bank-b|bank-c> --sink-image REF [--storage-class NAME] [--pull-secret NAME]
# ns rd-zeto-<party>: ConfigMap bundle-server-conf (nginx.conf of opa/bundle-server), PVC bundle-store (1Gi), Deployment bundle-server
# (nginx + sink, sink = opa/bundle-server/sink.py), Service bundle-server (ClusterIP), NetworkPolicy (ingress only from app=bank-gw pods of this ns).
# NOT rendered (the party creates them in its own ns, the key never leaves it): Secret opa-bundle-signing-<party> (key `key.pem`, RSA private key)
# and Secret bundle-sink-token (key `token`, same Secret the gateway mounts).
# --sink-image: an image holding python3, sink.py and the opa binary (Dockerfile next to this script); required, the stock python image has no opa.
# --storage-class: required for bank-c (cluster 2 has no default class; the class must be WaitForFirstConsumer), optional on cluster 1 (default class).
#   render.sh fabricx-access <bi|bank-a|bank-b|bank-c>
# prints the one NetworkPolicy bundle-server-from-fabricx (S16): the Fabric-X gateway fx-gw-<N> of ns rd-fabricx-<party> may read the signed bundles
# (TCP 8080; never the 8081 sink). It is additive to the bundle-server NetworkPolicy above and applies in the same cluster as the bundle-server.
#   render.sh iroha3-access <bi|bank-a|bank-b|bank-c>
# prints the one NetworkPolicy bundle-server-from-iroha3: the iroha3 gateway (pod label app.kubernetes.io/name=gateway) of ns rd-iroha3-<party>
# may read the signed bundles (TCP 8080 = the POD port the policy sees; the gateway dials the Service port 80, never :8080, never the 8081 sink). Additive, same cluster as the bundle-server.
# Needs bash + sed only. Never talks to a cluster.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
die() { echo "render.sh: $*" >&2; exit 2; }

if [[ "${1:-}" == fabricx-access ]]; then
  [[ $# -eq 2 ]] || die "usage: render.sh fabricx-access <bi|bank-a|bank-b|bank-c>"
  case "$2" in bi) n=1 ;; bank-a) n=2 ;; bank-b) n=3 ;; bank-c) n=4 ;; *) die "unknown party '$2' (allowed: bi bank-a bank-b bank-c)" ;; esac
  cat <<YAML
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: bundle-server-from-fabricx
  namespace: rd-zeto-$2
  labels: {app: bundle-server, part-of: rd-fabricx}
spec:
  podSelector:
    matchLabels: {app: bundle-server}
  policyTypes: [Ingress]
  ingress:
  - from:
    - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: rd-fabricx-$2}}
      podSelector: {matchLabels: {app.kubernetes.io/name: fx-gw-$n}}
    ports: [{protocol: TCP, port: 8080}]
YAML
  exit 0
fi

if [[ "${1:-}" == iroha3-access ]]; then
  [[ $# -eq 2 ]] || die "usage: render.sh iroha3-access <bi|bank-a|bank-b|bank-c>"
  case "$2" in bi|bank-a|bank-b|bank-c) ;; *) die "unknown party '$2' (allowed: bi bank-a bank-b bank-c)" ;; esac
  cat <<YAML
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: bundle-server-from-iroha3
  namespace: rd-zeto-$2
  labels: {app: bundle-server, part-of: rd-iroha3}
spec:
  podSelector:
    matchLabels: {app: bundle-server}
  policyTypes: [Ingress]
  ingress:
  - from:
    - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: rd-iroha3-$2}}
      podSelector: {matchLabels: {app.kubernetes.io/name: gateway}}
    ports: [{protocol: TCP, port: 8080}]
YAML
  exit 0
fi

party="${1:-}"; [[ $# -gt 0 ]] && shift
image="" class="" pull=""
while [[ $# -gt 0 ]]; do case "$1" in
  --sink-image) image="${2:?--sink-image needs a value}"; shift 2 ;;
  --storage-class) class="${2:?--storage-class needs a value}"; shift 2 ;;
  --pull-secret) pull="${2:?--pull-secret needs a value}"; shift 2 ;;
  *) die "unknown option $1" ;; esac; done
case "$party" in
  bi) own="bi,bank" keyid=bi ;;   # BI's server signs its `bi` bundle and its own `bank` bundle (node 1's bank bundle is BI's, key bi: opa/keys.sh:2)
  bank-a|bank-b|bank-c) own=bank keyid="$party" ;;
  *) die "usage: render.sh <bi|bank-a|bank-b|bank-c> --sink-image REF [--storage-class NAME] [--pull-secret NAME]" ;;
esac
[[ -n "$image" ]] || die "--sink-image is required"
[[ "$image" =~ ^[A-Za-z0-9._/:@-]+$ ]] || die "--sink-image '$image' is not an image reference"
[[ -z "$pull" || "$pull" =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]] || die "--pull-secret '$pull' is not a Secret name"
[[ -z "$class" || "$class" =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]] || die "--storage-class '$class' is not a valid name"
[[ "$party" != bank-c || -n "$class" ]] || die "bank-c is on cluster 2: --storage-class is required (and must be WaitForFirstConsumer)"
ns="rd-zeto-$party"
sc=""; [[ -z "$class" ]] || sc="  storageClassName: $class"$'\n'

pullblock=""; [[ -z "$pull" ]] || pullblock=$'      imagePullSecrets:\n      - name: '"$pull"$'\n'
cat <<YAML
apiVersion: v1
kind: ConfigMap
metadata:
  name: bundle-server-conf
  namespace: ${ns}
  labels: {app: bundle-server, part-of: rd-zeto}
data:
  nginx.conf: |
$(sed 's/^/    /' "$here/../../../opa/bundle-server/nginx.conf")
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: bundle-store
  namespace: ${ns}
  labels: {app: bundle-server, part-of: rd-zeto}
spec:
  accessModes: [ReadWriteOnce]
${sc}  resources:
    requests: {storage: 1Gi}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: bundle-server
  namespace: ${ns}
  labels: {app: bundle-server, part-of: rd-zeto}
spec:
  replicas: 1
  strategy: {type: Recreate}  # the PVC is ReadWriteOnce: the old pod must be gone before the new one attaches it
  selector:
    matchLabels: {app: bundle-server}
  template:
    metadata:
      labels: {app: bundle-server}
    spec:
${pullblock}      securityContext: {runAsNonRoot: true, runAsUser: 10001, fsGroup: 10001, seccompProfile: {type: RuntimeDefault}}
      containers:
      - name: nginx
        image: nginx:1.27-alpine
        command: ["nginx", "-g", "daemon off;", "-c", "/etc/nginx/conf/nginx.conf"]
        ports:
        - {name: bundles, containerPort: 8080}
        readinessProbe: {tcpSocket: {port: 8080}, periodSeconds: 5}
        resources:
          requests: {cpu: 10m, memory: 16Mi}
          limits: {memory: 64Mi}
        securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: [ALL]}}
        volumeMounts:
        - {name: conf, mountPath: /etc/nginx/conf, readOnly: true}
        - {name: tmp, mountPath: /tmp}
        - {name: bundle-store, mountPath: /srv, readOnly: true}
      - name: sink
        image: ${image}
        command: ["python", "-u", "/app/sink.py", "8081"]
        env:
        - {name: PYTHONDONTWRITEBYTECODE, value: "1"}
        - {name: SINK_TOKEN_FILE, value: /sink-token/token}
        - {name: BUNDLE_STORE, value: /bundle-store}
        - {name: PARTY_BUNDLE, value: "${own}"}
        - {name: SIGNING_KEY_FILE, value: /signing/key.pem}
        - {name: SIGNING_KEYID, value: ${keyid}}
        - {name: OPA_BIN, value: /usr/local/bin/opa}
        - {name: MAX_BUNDLE_BYTES, value: "10485760"}
        ports:
        - {name: sink, containerPort: 8081}
        readinessProbe: {tcpSocket: {port: 8081}, periodSeconds: 5}
        resources:
          requests: {cpu: 20m, memory: 64Mi}
          limits: {memory: 256Mi}  # opa build runs inside this container
        securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: [ALL]}}
        volumeMounts:
        - {name: bundle-store, mountPath: /bundle-store}
        - {name: signing, mountPath: /signing, readOnly: true}
        - {name: sink-token, mountPath: /sink-token, readOnly: true}
        - {name: work, mountPath: /tmp}
      volumes:
      - {name: conf, configMap: {name: bundle-server-conf}}
      - {name: bundle-store, persistentVolumeClaim: {claimName: bundle-store}}
      - {name: signing, secret: {secretName: opa-bundle-signing-${party}, defaultMode: 288}}  # 0440: the sink (gid 10001 via fsGroup) reads it; not optional
      - {name: sink-token, secret: {secretName: bundle-sink-token, defaultMode: 292}}  # 0444; not optional
      - {name: tmp, emptyDir: {medium: Memory, sizeLimit: 16Mi}}
      - {name: work, emptyDir: {sizeLimit: 128Mi}}  # opa build scratch (a source archive is at most 10 MiB, unpacked at most 50 MiB)
---
apiVersion: v1
kind: Service
metadata:
  name: bundle-server
  namespace: ${ns}
  labels: {app: bundle-server, part-of: rd-zeto}
spec:
  type: ClusterIP
  selector: {app: bundle-server}
  ports:
  - {name: bundles, port: 80, targetPort: 8080}
  - {name: sink, port: 8081, targetPort: 8081}
---
# Only the gateway pods of this ns (OPA: bundle pull, logs, status; envoy: the sink route to POST /bundles). No ipBlock, no other namespace.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: bundle-server-ingress
  namespace: ${ns}
  labels: {app: bundle-server, part-of: rd-zeto}
spec:
  podSelector:
    matchLabels: {app: bundle-server}
  policyTypes: [Ingress]
  ingress:
  - from:
    - podSelector: {matchLabels: {app: bank-gw}}
    ports: [{protocol: TCP, port: 8080}, {protocol: TCP, port: 8081}]
YAML
