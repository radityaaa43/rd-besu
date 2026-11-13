#!/usr/bin/env bash
# Render the stealth signer Deployments (signer/SPEC.md "Placement (binding)", ../S17.md) to stdout. Never talks to a cluster; the live apply needs its own GO.
#   render.sh <bank-a|bank-b|bank-c> --image REF --chain-env FILE --cert-url URL [--pull-secret NAME]
#   render.sh bi --image REF --chain-env FILE --cert-url URL [--pull-secret NAME]
#   render.sh custodian --image REF --chain-env FILE --bank-signers "CN=a,CN=b" [--pull-secret NAME]
#   render.sh compare --image REF --chain-env FILE --registry 0xADDR [--pull-secret NAME]
#   render.sh viewpush <bank-a|bank-b|bank-c> --image REF --door-url URL [--pull-secret NAME]
#   render.sh bi ... [--viewcopy-store]
# bank-<x> -> ns rd-stealth-bank-<x> (PARTY=A|B|C): Deployment + Service stealth-signer (ClusterIP 8080), role bank.
# custodian -> ns rd-stealth-bi (PARTY=BI): Deployment stealth-custodian (mTLS 9443), role custodian, NO Service.
# bi -> ns rd-stealth-bi (PARTY=BI): Deployment + Service stealth-signer (ClusterIP 8080), role bi. Reaches the custodian /cert door through the BI gateway like the banks.
#   --image       must be digest pinned (...@sha256:<64 hex>).
#   --chain-env   KEY=VALUE lines (blank lines and # comments allowed). EXACTLY: CHAIN_ID, FROM_BLOCK (digits); RD, BOND, ANNOUNCER, VALIDATOR, DVP_FACTORY
#                 (0x + 40 hex). No other key is accepted, so nothing secret can be smuggled into a plain env value.
#   --cert-url    bank and bi (required): https://host[:port] of the custodian /cert door (the BI gateway, SNI custodian-1 passthrough).
#   --bank-signers custodian only: the registered bank signer client-cert subjects.
# compare -> ns rd-stealth-bi: CronJob stealth-viewkey-compare (every 5 min, same image, command signer/src/compareMain.ts once), S11 detective compare of the registered viewing keys.
#   Pod labels app=stealth-viewkey role=compare (NOT app=stealth-signer: it serves no port and is not admitted by the signer NetworkPolicy). Only CHAIN_ID is read from --chain-env
#   (the same exactly-7-keys file serves every stage). --registry (required, compare only): the ERC-6538 registry, 0x + 40 hex.
# viewpush -> ns rd-stealth-bank-x: Job stealth-viewpush (S11 rework: the bank pushes ITS OWN view key + meta-address to BI's gateway, SNI viewcopy-1, signer/src/pushViewCopy.ts, same image). backoffLimit 0,
#   ttlSecondsAfterFinished 600, no SA token. Pod labels app=stealth-viewpush role=viewpush (NOT app=stealth-signer) + rd/egress-locked=true + rd/egress=stealth-viewpush (egress/render.sh viewpush).
#   Mounts stealth-keys with items [viewKey] ONLY (spendKey and identityKey never enter the pod) and stealth-signer-mtls (client cert). --door-url (required): https://host[:port] of the BI door st-gw-1:8550.
# bi --viewcopy-store: ServiceAccount stealth-bi-signer with the token mounted (the signer patches Secret stealth-bi-viewcopies through the kube API; the Role is rbac/render.sh viewcopies, the egress is
#   egress/render.sh signer bi --kube-api-ip). Without the flag the bi render is unchanged (no SA token).
# Secrets are created by the party operator and NEVER rendered (names + exact key names the pods mount, all 0440):
#   bank      stealth-keys (spendKey, viewKey, identityKey) -> /keys | stealth-signer-mtls (client.key, client.crt, ca.crt) -> /tls (also the RPC client cert: signed by the party's
#             bank-gw CA, ca.crt = own CA + BI CA; RPC_URL = own bank-gw-N door :8545, S17 2026-11-12 topology, no JWT)
#   bi        stealth-bi-keys (issuerKey, spendKey, viewKey) -> /keys | stealth-bi-viewcopies (OPTIONAL; every key of it, <id>.viewKey + <id>.metaAddress, S11 fills it) -> /viewcopies
#             (env VIEWCOPIES_DIR) | stealth-signer-mtls (client.key, client.crt, ca.crt; the client cert CN must be in the custodian's BANK_SIGNERS list and be its BI_SIGNER) -> /tls
#   compare   stealth-compare-jwt (token: a READ-ONLY JWT, eth:call/blockNumber/chainId, minted by signer/src/mintCompareToken.ts; NOT the node key) -> /rpc-jwt (env RPC_TOKEN_FILE=/rpc-jwt/token)
#             | stealth-bi-viewcopies (OPTIONAL; <id>.viewKey, <id>.metaAddress, <id>.identityAddress for bi bank-a bank-b bank-c) -> /viewcopies (env VIEWCOPIES_DIR). Never the node key, any issuer/spend/cert key or a client cert.
#   custodian stealth-cert-key (certKey) -> /keys | stealth-custodian-mtls (server.key, server.crt, ca.crt = the four party CAs) -> /tls, and server.key/.crt again as
#             client.key/.crt at /rpc-tls (RPC to bank-gw-1) | --bi-signer CN=...: the only caller of /escrow-certs
# A bank pod never references stealth-cert-key; the bi pod never references stealth-cert-key or stealth-keys; the custodian pod never references stealth-keys;
# the compare pod references only stealth-compare-jwt and stealth-bi-viewcopies.
# gateway/render.sh expects: Service stealth-signer:8080 (pod labels app=stealth-signer role=bank) and Service stealth-custodian:9443 (role=custodian, rendered there); its stealth-signer-ingress selects role In [bank, bi].
set -euo pipefail
die() { echo "render.sh: $*" >&2; exit 2; }
usage="usage: render.sh <bank-a|bank-b|bank-c|bi> --image REF --chain-env FILE --cert-url URL [--pull-secret NAME] | render.sh custodian --image REF --chain-env FILE --bank-signers \"CN=a,CN=b\" [--pull-secret NAME] | render.sh compare --image REF --chain-env FILE --registry 0xADDR [--pull-secret NAME] | render.sh viewpush <bank-a|bank-b|bank-c> --image REF --door-url URL [--pull-secret NAME]"

[[ $# -ge 1 ]] || die "$usage"
sel="$1"; shift
VP=0
if [[ "$sel" == viewpush ]]; then
  [[ $# -ge 1 ]] || die "$usage"
  sel="$1"; shift; VP=1
  case "$sel" in bank-a|bank-b|bank-c) ;; *) die "viewpush is for bank-a bank-b bank-c only" ;; esac
fi
case "$sel" in
  bank-a) party=A; ns=rd-stealth-bank-a; lp=bank-a ;;
  bank-b) party=B; ns=rd-stealth-bank-b; lp=bank-b ;;
  bank-c) party=C; ns=rd-stealth-bank-c; lp=bank-c ;;
  custodian) party=BI; ns=rd-stealth-bi; lp=bi ;;
  bi) party=BI; ns=rd-stealth-bi; lp=bi ;;
  compare) party=BI; ns=rd-stealth-bi; lp=bi ;;
  *) die "unknown party '$sel' (allowed: bank-a bank-b bank-c bi custodian compare)" ;;
esac

IMAGE=""; CHAINENV=""; CERT=""; SIGNERS=""; BISIGNER=""; PULL=""; REGISTRY=""; HAVE_CERT=0; HAVE_SIGNERS=0; HAVE_REGISTRY=0; HAVE_DOOR=0; DOOR=""; STORE=0
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --viewcopy-store ]]; then STORE=1; shift; continue; fi
  [[ $# -ge 2 ]] || die "option $1 needs a value"
  case "$1" in
    --image) IMAGE="$2" ;;
    --chain-env) CHAINENV="$2" ;;
    --cert-url) CERT="$2"; HAVE_CERT=1 ;;
    --bank-signers) SIGNERS="$2"; HAVE_SIGNERS=1 ;;
    --bi-signer) BISIGNER="$2" ;;
    --pull-secret) PULL="$2"; HAVE_PULL=1 ;;
    --registry) REGISTRY="$2"; HAVE_REGISTRY=1 ;;
    --door-url) DOOR="$2"; HAVE_DOOR=1 ;;
    *) die "unknown option $1" ;;
  esac
  shift 2
done

[[ "$IMAGE" =~ ^[A-Za-z0-9._/:@-]+$ && "$IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] || die "--image must be digest pinned (REF@sha256:<64 hex>, chars A-Za-z0-9._/:@-)"
if [[ $VP -eq 1 ]]; then
  [[ -z "$CHAINENV" && $HAVE_CERT -eq 0 && $HAVE_SIGNERS -eq 0 && $HAVE_REGISTRY -eq 0 && $STORE -eq 0 ]] || die "viewpush takes only --image, --door-url, --pull-secret"
  [[ $HAVE_DOOR -eq 1 ]] || die "--door-url is required for viewpush"
  [[ "$DOOR" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || die "bad --door-url (https://host[:port], no path)"
  [[ -z "${HAVE_PULL:-}" ]] || [[ "$PULL" =~ ^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || die "bad --pull-secret (DNS-1123 name)"
  vp_pull=""; [[ -z "${HAVE_PULL:-}" ]] || vp_pull=$'      imagePullSecrets:\n      - {name: '"$PULL"$'}'
  cat <<YAML
apiVersion: batch/v1
kind: Job
metadata:
  name: stealth-viewpush
  namespace: $ns
  labels: {app: stealth-viewpush, role: viewpush, part-of: rd-stealth, party: $lp}
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 600
  activeDeadlineSeconds: 120
  template:
    metadata:
      labels: {app: stealth-viewpush, role: viewpush, rd/egress-locked: "true", rd/egress: stealth-viewpush} # own narrow egress (egress/render.sh viewpush): the own signer, the BI door, DNS
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      securityContext: {runAsNonRoot: true, runAsUser: 10001, fsGroup: 10001, seccompProfile: {type: RuntimeDefault}}
$vp_pull
      containers:
      - name: viewpush
        image: "$IMAGE"
        command: ["node","--experimental-transform-types","signer/src/pushViewCopy.ts"]
        env:
        - {name: PARTY, value: "$party"}
        - {name: KEYS_DIR, value: /keys}
        - {name: TLS_DIR, value: /tls}
        - {name: SIGNER_URL, value: "http://stealth-signer:8080"}
        - {name: DOOR_URL, value: "$DOOR"}
        - {name: DOOR_SERVERNAME, value: viewcopy-1}
        resources:
          requests: {cpu: 50m, memory: 128Mi}
          limits: {memory: 256Mi}
        securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: [ALL]}}
        volumeMounts:
        - {name: keys, mountPath: /keys, readOnly: true}
        - {name: tls, mountPath: /tls, readOnly: true}
        - {name: tmp, mountPath: /tmp}
      volumes:
      - name: keys
        secret:
          secretName: stealth-keys
          defaultMode: 288 # 0440
          items:
          - {key: viewKey, path: viewKey} # ONLY the view key: spendKey and identityKey are not projected
      - name: tls
        secret:
          secretName: stealth-signer-mtls
          defaultMode: 288 # 0440
          items:
          - {key: client.key, path: client.key}
          - {key: client.crt, path: client.crt}
          - {key: ca.crt, path: ca.crt}
      - {name: tmp, emptyDir: {}}
YAML
  exit 0
fi
[[ $HAVE_DOOR -eq 0 ]] || die "--door-url is for viewpush only"
[[ $STORE -eq 0 || "$sel" == bi ]] || die "--viewcopy-store is for bi only"
[[ -n "$CHAINENV" ]] || die "--chain-env FILE is required"
[[ -f "$CHAINENV" ]] || die "--chain-env: not a file"
if [[ "$sel" == compare ]]; then
  [[ $HAVE_CERT -eq 0 ]] || die "--cert-url is for banks and bi only"
  [[ $HAVE_SIGNERS -eq 0 ]] || die "--bank-signers is for custodian only"
  [[ $HAVE_REGISTRY -eq 1 ]] || die "--registry is required for compare"
  [[ "$REGISTRY" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "bad --registry (0x + 40 hex)"
elif [[ "$sel" == custodian ]]; then
  [[ $HAVE_REGISTRY -eq 0 ]] || die "--registry is for compare only"
  [[ $HAVE_CERT -eq 0 ]] || die "--cert-url is for banks and bi only"
  [[ $HAVE_SIGNERS -eq 1 ]] || die "--bank-signers is required for custodian"
  [[ "$SIGNERS" =~ ^CN=[A-Za-z0-9._-]+(,CN=[A-Za-z0-9._-]+)*$ ]] || die "bad --bank-signers (comma list of CN=<name>)"
  [[ "$BISIGNER" =~ ^CN=[A-Za-z0-9._-]+$ ]] || die "--bi-signer CN=<name> is required for custodian (the only caller of /escrow-certs)"
else
  [[ $HAVE_REGISTRY -eq 0 ]] || die "--registry is for compare only"
  [[ $HAVE_SIGNERS -eq 0 && -z "$BISIGNER" ]] || die "--bank-signers/--bi-signer are for custodian only"
  [[ $HAVE_CERT -eq 1 ]] || die "--cert-url is required for banks and bi"
  [[ "$CERT" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || die "bad --cert-url (https://host[:port], no path)"
fi
[[ -z "${HAVE_PULL:-}" ]] || [[ "$PULL" =~ ^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || die "bad --pull-secret (DNS-1123 name)"

# chain-env: exactly the seven public chain keys. Only the key name is ever echoed, never a value.
declare -A CH=()
n=0
while IFS= read -r line || [[ -n "$line" ]]; do
  n=$((n + 1))
  [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
  [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || die "--chain-env line $n: expected KEY=VALUE"
  k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]}"
  case "$k" in
    CHAIN_ID|FROM_BLOCK) [[ "$v" =~ ^[0-9]+$ ]] || die "--chain-env: $k must be digits" ;;
    RD|BOND|ANNOUNCER|VALIDATOR|DVP_FACTORY) [[ "$v" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "--chain-env: $k must be 0x + 40 hex" ;;
    *) die "--chain-env: key $k is not allowed (only CHAIN_ID RD BOND ANNOUNCER VALIDATOR DVP_FACTORY FROM_BLOCK)" ;;
  esac
  [[ -z "${CH[$k]+x}" ]] || die "--chain-env: duplicate key $k"
  CH[$k]="$v"
done < "$CHAINENV"
for k in CHAIN_ID RD BOND ANNOUNCER VALIDATOR DVP_FACTORY FROM_BLOCK; do
  [[ -n "${CH[$k]+x}" ]] || die "--chain-env: missing key $k"
done

chainenv() { # the seven public chain constants, quoted (CHAIN_ID would otherwise parse as a number)
  local k
  for k in CHAIN_ID RD BOND ANNOUNCER VALIDATOR DVP_FACTORY FROM_BLOCK; do printf '        - {name: %s, value: "%s"}\n' "$k" "${CH[$k]}"; done
}
pull() { [[ -z "${HAVE_PULL:-}" ]] || printf '      imagePullSecrets:\n      - {name: %s}\n' "$PULL"; }
secret_all() { # secret_all <volume> <secret> : OPTIONAL Secret, every key appears as a readOnly-mounted 0440 file (no items)
  printf '      - name: %s\n        secret:\n          secretName: %s\n          optional: true\n          defaultMode: 288 # 0440\n' "$1" "$2"
}
secret() { # secret <volume> <secret> <key>... : readOnly-mounted 0440 (288) items, nothing else from the Secret
  local v="$1" s="$2" k; shift 2
  printf '      - name: %s\n        secret:\n          secretName: %s\n          defaultMode: 288 # 0440\n          items:\n' "$v" "$s"
  for k in "$@"; do printf '          - {key: %s, path: %s}\n' "$k" "$k"; done
}

if [[ "$sel" == compare ]]; then
  # A batch job: no port, no probe, no Service. Its pod labels differ from the signer's on purpose (no signer NetworkPolicy admission).
  cat <<YAML
apiVersion: batch/v1
kind: CronJob
metadata:
  name: stealth-viewkey-compare
  namespace: $ns
  labels: {app: stealth-viewkey, role: compare, part-of: rd-stealth, party: $lp}
spec:
  schedule: "*/5 * * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 0
      activeDeadlineSeconds: 240 # shorter than the 5 min schedule
      template:
        metadata:
          labels: {app: stealth-viewkey, role: compare, rd/egress-locked: "true", rd/egress: stealth-viewkey} # own narrow egress (egress/render.sh compare)
        spec:
          restartPolicy: Never
          automountServiceAccountToken: false
          securityContext: {runAsNonRoot: true, runAsUser: 10001, fsGroup: 10001, seccompProfile: {type: RuntimeDefault}}
$(pull | sed 's/^/    /')
          containers:
          - name: compare
            image: "$IMAGE"
            command: ["node","--experimental-transform-types","signer/src/compareMain.ts","once"]
            env:
            - {name: RPC_URL, value: "http://besu-rpc:8545"}
            - {name: RPC_TOKEN_FILE, value: /rpc-jwt/token}
            - {name: CHAIN_ID, value: "${CH[CHAIN_ID]}"}
            - {name: REGISTRY, value: "$REGISTRY"}
            - {name: VIEWCOPIES_DIR, value: /viewcopies}
            resources:
              requests: {cpu: 50m, memory: 128Mi}
              limits: {memory: 512Mi}
            securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: [ALL]}}
            volumeMounts:
            - {name: viewcopies, mountPath: /viewcopies, readOnly: true}
            - {name: rpc-jwt, mountPath: /rpc-jwt, readOnly: true}
            - {name: tmp, mountPath: /tmp}
          volumes:
$(secret_all viewcopies stealth-bi-viewcopies | sed 's/^/    /')
$(secret rpc-jwt stealth-compare-jwt token | sed 's/^/    /')
          - {name: tmp, emptyDir: {}}
YAML
  exit 0
fi

mounts=""; sa=""; automount=false
# S17 (2026-11-12 topology): the validator is reached through the party's own bank-gw-N Besu door (mTLS + OPA method allowlist), no JWT node.
case "$lp" in bi) gwn=1 ;; bank-a) gwn=2 ;; bank-b) gwn=3 ;; bank-c) gwn=4 ;; esac
if [[ $STORE -eq 1 ]]; then automount=true; sa=$'\n      serviceAccountName: stealth-bi-signer'; fi
if [[ "$sel" == custodian ]]; then
  name=stealth-custodian; role=custodian; port=9443; pname=mtls; egress=stealth-custodian
  probe='tcpSocket: {port: 9443}' # the https listener demands a client cert, so no httpGet
  roleenv="        - {name: BANK_SIGNERS, value: \"$SIGNERS\"}
        - {name: BI_SIGNER, value: \"$BISIGNER\"}"
  rpctls=/rpc-tls
  # its RPC client cert to bank-gw-1 = its own server cert (BI CA, serverAuth + clientAuth), projected under the client file names
  vols="$(secret keys stealth-cert-key certKey; secret tls stealth-custodian-mtls server.key server.crt ca.crt)
      - name: rpc-tls
        secret:
          secretName: stealth-custodian-mtls
          defaultMode: 288 # 0440
          items:
          - {key: server.key, path: client.key}
          - {key: server.crt, path: client.crt}
          - {key: ca.crt, path: ca.crt}"
  mounts='        - {name: rpc-tls, mountPath: /rpc-tls, readOnly: true}
'
else
  name=stealth-signer; role=bank; port=8080; pname=http; egress=stealth-signer; rpctls=/tls
  probe='httpGet: {path: /health, port: 8080}'
  roleenv="        - {name: CERT_URL, value: \"$CERT\"}
        - {name: CERT_SERVERNAME, value: custodian-1}"
  vols="$(secret keys stealth-keys spendKey viewKey identityKey; secret tls stealth-signer-mtls client.key client.crt ca.crt)"
  if [[ "$sel" == bi ]]; then
    role=bi
    roleenv="$roleenv
        - {name: VIEWCOPIES_DIR, value: /viewcopies}"
    vols="$(secret keys stealth-bi-keys issuerKey spendKey viewKey; secret_all viewcopies stealth-bi-viewcopies; secret tls stealth-signer-mtls client.key client.crt ca.crt)"
    mounts='        - {name: viewcopies, mountPath: /viewcopies, readOnly: true}
'
  fi
fi

cat <<YAML
apiVersion: apps/v1
kind: Deployment
metadata:
  name: $name
  namespace: $ns
  labels: {app: stealth-signer, role: $role, part-of: rd-stealth, party: $lp}
spec:
  replicas: 1
  strategy: {type: Recreate} # keys live in process memory: never two pods
  selector:
    matchLabels: {app: stealth-signer, role: $role}
  template:
    metadata:
      labels: {app: stealth-signer, role: $role, rd/egress-locked: "true", rd/egress: $egress} # own narrow egress (egress/render.sh signer|custodian): not selected by allow-dns-egress
    spec:
      automountServiceAccountToken: $automount$sa
      securityContext: {runAsNonRoot: true, runAsUser: 10001, fsGroup: 10001, seccompProfile: {type: RuntimeDefault}}
$(pull)
      containers:
      - name: signer
        image: "$IMAGE"
        ports:
        - {name: $pname, containerPort: $port}
        env:
        - {name: PARTY, value: "$party"}
        - {name: ROLE, value: $role}
        - {name: PORT, value: "$port"}
        - {name: KEYS_DIR, value: /keys}
        - {name: TLS_DIR, value: /tls}
$roleenv
        - {name: RPC_URL, value: "https://bank-gw-$gwn.rd-zeto-$lp.svc.cluster.local:8545"}
        - {name: RPC_TLS_DIR, value: $rpctls}
        - {name: RPC_SERVERNAME, value: bank-gw-$gwn}
$(chainenv)
        readinessProbe: {$probe}
        livenessProbe: {$probe}
        resources:
          requests: {cpu: 50m, memory: 128Mi}
          limits: {memory: 512Mi}
        securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: [ALL]}}
        volumeMounts:
        - {name: keys, mountPath: /keys, readOnly: true}
${mounts}        - {name: tls, mountPath: /tls, readOnly: true}
        - {name: tmp, mountPath: /tmp}
      volumes:
$vols
      - {name: tmp, emptyDir: {}}
YAML

if [[ "$sel" != custodian ]]; then
  cat <<YAML
---
apiVersion: v1
kind: Service
metadata:
  name: stealth-signer
  namespace: $ns
  labels: {app: stealth-signer, role: $role, part-of: rd-stealth, party: $lp}
spec:
  type: ClusterIP
  selector: {app: stealth-signer, role: $role}
  ports:
  - {name: http, port: 8080, targetPort: 8080}
YAML
fi
