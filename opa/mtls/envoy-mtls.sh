#!/bin/bash
# Print envoy/nodeN.yaml with a DownstreamTlsContext on both doors (8548 Paladin, 8545 Besu): a client cert signed by the
# CA is required. Files come from the Secret bank-gw-N-mtls mounted at /mtls (README, "mTLS"). The plain envoy/nodeN.yaml
# stays the source of truth; this only inserts a transport_socket into each filter chain.
# usage: envoy-mtls.sh envoy/node2.yaml > node2.mtls.yaml
set -euo pipefail
awk '
/^    - filters:$/ {
  print "    - transport_socket:"
  print "        name: envoy.transport_sockets.tls"
  print "        typed_config:"
  print "          \"@type\": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext"
  print "          require_client_certificate: true"
  print "          common_tls_context:"
  print "            tls_params: {tls_minimum_protocol_version: TLSv1_2}"
  print "            tls_certificates:"
  print "            - certificate_chain: {filename: /mtls/tls.crt}"
  print "              private_key: {filename: /mtls/tls.key}"
  print "            validation_context: {trusted_ca: {filename: /mtls/ca.crt}}"
  print "      filters:"
  n++; next
}
{ print }
END { if (n != 2) { print "expected 2 filter chains, found " n+0 > "/dev/stderr"; exit 1 } }
' "$1"
