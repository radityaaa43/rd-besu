#!/usr/bin/env bash
# Render the stealth S17 gateway manifests (final-design/stealth/PLAN.md S17, ../S17.md) to stdout. Never talks to a cluster.
#   render.sh <bi|bank-a|bank-b|bank-c> [--opa-config FILE] [--acl-id acl-X --external-cidr CIDR...]
#   render.sh envoy <party>          the Envoy config only (CI runs `envoy --mode validate` on it)
#   render.sh bundle-access <party>  NetworkPolicy bundle-server-from-stealth in rd-zeto-<party> (the only object outside rd-stealth-<party>)
# Per party in rd-stealth-<party>: ConfigMaps st-gw-<N>-envoy and st-gw-opa, Deployment st-gw-<N> (envoy + OPA, labels app=st-gw,node=node<N>), Service st-gw-<N>
# (ClusterIP 8550), NetworkPolicies st-gw-ingress, stealth-signer-ingress.
#   --opa-config   OPA config from FILE instead of opa/opa.yaml (the party's opa-config.yaml = opa.yaml + the public keys, from opa/keys.sh). It is rewritten for
#                  this gateway: bundles come from bundle-server.rd-zeto-<party> (zeto S17), the sink service, its bearer token, status and decision-log service are
#                  dropped (a gateway without a token cannot write to a sink; decisions go to the console).
# The st-gw OPA pulls bi/latest.tar.gz and bank/latest.tar.gz (signing key id = the party). NOT rendered: the besu read door (S17.md: the RPC node needs a JWT).
# bi only: SNI passthrough chain custodian-1 -> Service stealth-custodian (ClusterIP 9443) + NetworkPolicy stealth-custodian-ingress. The pod terminates mTLS itself,
# so the signer sees the bank's client cert (S8 verdict rule a); OPA is not in that path.
# R1 (bank-c's /cert reach): `bi --acl-id ... --external-cidr ...` adds Service st-gw-1-ext, a NEW LoadBalancer with the EXISTING ACL id annotated in the first apply
# (never loadbalancer-id: no shared CLB). Without the flags no external Service exists.
# NOT rendered: the Secrets (the parties create st-gw-<N>-mtls and the signer secrets).
# bi=1 bank-a=2 bank-b=3 bank-c=4. Needs bash.
set -euo pipefail
die() { echo "render.sh: $*" >&2; exit 2; }
parties="bi bank-a bank-b bank-c"
num() { case "$1" in bi) echo 1 ;; bank-a) echo 2 ;; bank-b) echo 3 ;; bank-c) echo 4 ;; *) die "unknown party '$1' (allowed: $parties)" ;; esac; }
indent() { sed 's/^/    /'; }

envoy() { # envoy <party>
  local p="$1" n ns; n="$(num "$p")"; ns="rd-stealth-$p"
  cat <<YAML
# Envoy for st-gw-$n (stealth gateway of $p). Door :8550 -> signer, checked by the OPA sidecar (gRPC 127.0.0.1:9191, target stealth). Fail closed.
static_resources:
  listeners:
  - name: signer
    address: {socket_address: {address: 0.0.0.0, port_value: 8550}}
    listener_filters:
    - name: envoy.filters.listener.tls_inspector
      typed_config:
        "@type": type.googleapis.com/envoy.extensions.filters.listener.tls_inspector.v3.TlsInspector
    filter_chains:
YAML
  if [[ "$p" == bi ]]; then cat <<YAML
    # /cert passthrough: SNI custodian-1 is NOT terminated here. The custodian pod does the mTLS, so it sees the bank signer's client cert.
    - filter_chain_match: {server_names: ["custodian-1"]}
      filters:
      - name: envoy.filters.network.tcp_proxy
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy
          stat_prefix: custodian
          cluster: custodian
YAML
  fi
  cat <<YAML
    # default chain: Lensa's mTLS door (client cert from the party CA, Secret st-gw-$n-mtls at /mtls), then OPA.
    - transport_socket:
        name: envoy.transport_sockets.tls
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
          require_client_certificate: true
          common_tls_context:
            tls_params: {tls_minimum_protocol_version: TLSv1_2}
            tls_certificates:
            - certificate_chain: {filename: /mtls/tls.crt}
              private_key: {filename: /mtls/tls.key}
            validation_context: {trusted_ca: {filename: /mtls/ca.crt}}
      filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          stat_prefix: signer
          route_config:
            virtual_hosts:
            - name: signer
              domains: ["*"]
              routes:
              - match: {prefix: "/"}
                route: {cluster: signer, timeout: 60s}
                typed_per_filter_config:
                  envoy.filters.http.ext_authz:
                    "@type": type.googleapis.com/envoy.extensions.filters.http.ext_authz.v3.ExtAuthzPerRoute
                    check_settings:
                      context_extensions: {target: stealth, node: node$n}
          http_filters:
          - name: envoy.filters.http.ext_authz
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.filters.http.ext_authz.v3.ExtAuthz
              transport_api_version: V3
              with_request_body: {max_request_bytes: 1048576, allow_partial_message: false}
              failure_mode_allow: false
              grpc_service: {envoy_grpc: {cluster_name: opa}, timeout: 2s}
          - name: envoy.filters.http.router
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
  clusters:
  - name: signer
    type: STRICT_DNS
    connect_timeout: 2s
    load_assignment:
      cluster_name: signer
      endpoints:
      - lb_endpoints:
        - endpoint: {address: {socket_address: {address: stealth-signer.$ns.svc.cluster.local, port_value: 8080}}}
YAML
  if [[ "$p" == bi ]]; then cat <<YAML
  - name: custodian
    type: STRICT_DNS
    connect_timeout: 2s
    load_assignment:
      cluster_name: custodian
      endpoints:
      - lb_endpoints:
        - endpoint: {address: {socket_address: {address: stealth-custodian.$ns.svc.cluster.local, port_value: 9443}}}
YAML
  fi
  cat <<YAML
  - name: opa
    type: STATIC
    connect_timeout: 1s
    typed_extension_protocol_options:
      envoy.extensions.upstreams.http.v3.HttpProtocolOptions:
        "@type": type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions
        explicit_http_config: {http2_protocol_options: {}}
    load_assignment:
      cluster_name: opa
      endpoints:
      - lb_endpoints:
        - endpoint: {address: {socket_address: {address: 127.0.0.1, port_value: 9191}}}
admin:
  address: {socket_address: {address: 127.0.0.1, port_value: 9901}}
YAML
}

opaconf() { # opaconf <party> : $CFG rewritten for the stealth gateway
  awk -v url="http://bundle-server.rd-zeto-$1" '
    /^    url: http:\/\/bundle-server$/ { print "    url: " url; next }
    /^  sink:$/ { skip = 1; next }
    skip && /^    / { next }
    { skip = 0 }
    /^  service: sink$/ { next }
    /^# bundle status/ { next }
    /^status:$/ { next }
    { print }' "$CFG"
}

deployment() { # deployment <party>
  local p="$1" n ns; n="$(num "$p")"; ns="rd-stealth-$p"
  cat <<YAML
apiVersion: apps/v1
kind: Deployment
metadata:
  name: st-gw-$n
  namespace: $ns
  labels: {app: st-gw, node: node$n, part-of: rd-stealth, party: $p}
spec:
  replicas: 1
  strategy: {type: RollingUpdate, rollingUpdate: {maxSurge: 1, maxUnavailable: 0}}
  selector:
    matchLabels: {app: st-gw, node: node$n}
  template:
    metadata:
      labels: {app: st-gw, node: node$n, rd/egress-locked: "true", rd/egress: st-gw} # own narrow egress (egress/render.sh gateway): not selected by allow-dns-egress
    spec:
      automountServiceAccountToken: false
      securityContext: {runAsNonRoot: true, runAsUser: 10001, seccompProfile: {type: RuntimeDefault}}
      containers:
      - name: envoy
        image: envoyproxy/envoy:v1.38.9@sha256:b1f389c3a6148e85e9de364cb867aa2e5802153abb37ad80f1f2241d693da32a
        args: ["-c", "/config/envoy.yaml", "--log-level", "warn"]
        ports:
        - {name: door, containerPort: 8550}
        readinessProbe: {tcpSocket: {port: 8550}, periodSeconds: 5}
        resources:
          requests: {cpu: 20m, memory: 32Mi}
          limits: {memory: 128Mi}
        securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: [ALL]}}
        volumeMounts:
        - {name: envoy, mountPath: /config, readOnly: true}
        - {name: mtls, mountPath: /mtls, readOnly: true} # empty until Secret st-gw-$n-mtls exists (the party creates it)
      - name: opa
        image: openpolicyagent/opa:1.21.1-envoy-1-static@sha256:c1f40d815a15c4ca0ccbdf300e0a3515fccf1d30fbd92e69917ab96bad83811d
        args:
        - run
        - --server
        - --addr=localhost:8181
        - --diagnostic-addr=0.0.0.0:8282
        - --authorization=basic
        - --config-file=/config/opa.yaml
        - --set=labels.gateway=st-gw-$n
        - --set=bundles.bi.resource=bi/latest.tar.gz
        - --set=bundles.bank.resource=bank/latest.tar.gz
        - --set=bundles.bank.signing.keyid=$p
        readinessProbe: {httpGet: {path: "/health?plugins&bundles", port: 8282}, periodSeconds: 5}
        livenessProbe: {httpGet: {path: /health, port: 8282}, periodSeconds: 10}
        resources:
          requests: {cpu: 20m, memory: 64Mi}
          limits: {memory: 256Mi}
        securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: [ALL]}}
        volumeMounts:
        - {name: opa, mountPath: /config, readOnly: true}
      volumes:
      - {name: envoy, configMap: {name: st-gw-$n-envoy}}
      - {name: mtls, secret: {secretName: st-gw-$n-mtls, optional: true, defaultMode: 292}} # 0444: envoy runs as uid 10001
      - {name: opa, configMap: {name: st-gw-opa}}
YAML
}

netpol() { # netpol <name> <ns> <party> <selector-yaml (indented 4)> <ingress-yaml (indented 2)>
  cat <<YAML
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: $1
  namespace: $2
  labels: {part-of: rd-stealth, party: $3}
spec:
  podSelector:
$4
  policyTypes: [Ingress]
  ingress:
$5
YAML
}

party() { # party <party> [acl cidr...]
  local p="$1" acl="${2:-}"; shift; [[ -z "$acl" ]] || shift
  local n ns; n="$(num "$p")"; ns="rd-stealth-$p"
  cat <<YAML
apiVersion: v1
kind: ConfigMap
metadata:
  name: st-gw-$n-envoy
  namespace: $ns
  labels: {part-of: rd-stealth, party: $p}
data:
  envoy.yaml: |
$(envoy "$p" | indent)
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: st-gw-opa
  namespace: $ns
  labels: {part-of: rd-stealth, party: $p}
data:
  opa.yaml: |
$(opaconf "$p" | indent)
---
$(deployment "$p")
---
apiVersion: v1
kind: Service
metadata:
  name: st-gw-$n
  namespace: $ns
  labels: {app: st-gw, part-of: rd-stealth, party: $p}
spec:
  selector: {app: st-gw}
  ports:
  - {name: door, port: 8550, targetPort: 8550}
YAML
  if [[ "$p" == bi ]]; then cat <<YAML
---
apiVersion: v1
kind: Service
metadata:
  name: stealth-custodian
  namespace: $ns
  labels: {app: stealth-signer, role: custodian, part-of: rd-stealth, party: $p}
spec:
  selector: {app: stealth-signer, role: custodian}
  ports:
  - {name: mtls, port: 9443, targetPort: 9443}
YAML
  fi
  if [[ -n "$acl" ]]; then
    local c
    cat <<YAML
---
# R1: bank-c's /cert reach. A NEW LoadBalancer (own CLB), the EXISTING ACL id annotated here in the first apply. Traffic is TLS passthrough (SNI custodian-1), mTLS is the gate.
apiVersion: v1
kind: Service
metadata:
  name: st-gw-$n-ext
  namespace: $ns
  labels: {app: st-gw, part-of: rd-stealth, party: $p}
  annotations:
    service.beta.kubernetes.io/alibaba-cloud-loadbalancer-acl-status: "on"
    service.beta.kubernetes.io/alibaba-cloud-loadbalancer-acl-type: white
    service.beta.kubernetes.io/alibaba-cloud-loadbalancer-acl-id: $acl
spec:
  type: LoadBalancer
  externalTrafficPolicy: Cluster
  loadBalancerSourceRanges:
YAML
    for c in "$@"; do printf '  - %s\n' "$c"; done
    cat <<YAML
  selector: {app: st-gw}
  ports:
  - {name: door, port: 8550, targetPort: 8550}
YAML
  fi
  netpol st-gw-ingress "$ns" "$p" "    matchLabels: {app: st-gw}" "    - ports: [{protocol: TCP, port: 8550}]"
  netpol stealth-signer-ingress "$ns" "$p" $'    matchLabels: {app: stealth-signer}\n    matchExpressions:\n    - {key: role, operator: In, values: [bank, bi]}' $'    - from:\n      - podSelector: {matchLabels: {app: st-gw}}\n      ports: [{protocol: TCP, port: 8080}]'
  if [[ "$p" == bi ]]; then
    netpol stealth-custodian-ingress "$ns" "$p" "    matchLabels: {app: stealth-signer, role: custodian}" $'    - from:\n      - podSelector: {matchLabels: {app: st-gw}}\n      ports: [{protocol: TCP, port: 9443}]'
  fi
}

[[ $# -ge 1 ]] || die "usage: render.sh <bi|bank-a|bank-b|bank-c> [--opa-config FILE] [--acl-id acl-X --external-cidr CIDR...] | render.sh envoy <party> | render.sh bundle-access <party>"
if [[ "$1" == envoy ]]; then [[ $# -eq 2 ]] || die "usage: render.sh envoy <party>"; num "$2" >/dev/null; envoy "$2"; exit 0; fi
if [[ "$1" == bundle-access ]]; then
  [[ $# -eq 2 ]] || die "usage: render.sh bundle-access <party>"; num "$2" >/dev/null
  cat <<YAML
# S17: st-gw of rd-stealth-$2 pulls its signed bundles from bundle-server (port 8080 only; never the 8081 sink). Additive to bundle-server-ingress (zeto).
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: bundle-server-from-stealth
  namespace: rd-zeto-$2
  labels: {app: bundle-server, part-of: rd-stealth}
spec:
  podSelector:
    matchLabels: {app: bundle-server}
  policyTypes: [Ingress]
  ingress:
  - from:
    - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: rd-stealth-$2}}
      podSelector: {matchLabels: {app: st-gw}}
    ports: [{protocol: TCP, port: 8080}]
YAML
  exit 0
fi
sel="$1"; shift; num "$sel" >/dev/null
here="$(cd "$(dirname "$0")" && pwd)"; CFG="$here/../../../opa/opa.yaml"
ACL=""; CIDRS=()
while [[ $# -gt 0 ]]; do case "$1" in
  --opa-config) CFG="${2:?--opa-config needs a file}"; [[ -f "$CFG" ]] || die "--opa-config: $CFG is not a file"; shift 2 ;;
  --acl-id) ACL="${2:?--acl-id needs an ACL id}"; [[ "$ACL" =~ ^acl-[a-z0-9]+$ ]] || die "bad --acl-id"; shift 2 ;;
  --external-cidr) c="${2:?--external-cidr needs a CIDR}"; [[ "$c" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ ]] || die "bad --external-cidr '$c'"; CIDRS+=("$c"); shift 2 ;;
  *) die "unknown option $1" ;; esac; done
if [[ -n "$ACL" || ${#CIDRS[@]} -gt 0 ]]; then
  [[ "$sel" == bi ]] || die "--acl-id/--external-cidr (LoadBalancer) are for bi only (R1: st-gw-1)"
  [[ -n "$ACL" && ${#CIDRS[@]} -gt 0 ]] || die "--acl-id and --external-cidr only together"
fi
party "$sel" "$ACL" "${CIDRS[@]}"
