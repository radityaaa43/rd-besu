# The gateway bank's own rules for target `sink` (zeto S17): the party gateway's door to its own bundle-server (Envoy route /sink/ ->
# bundle-server:8081, context_extensions {target: "sink", node}). Only these routes, and only for a named mTLS client:
#   GET  /sink/status          -> GET /status             Lensa publisher (is my bundle active?)
#   GET  /sink/bundles/<name>/latest -> GET /bundles/<name>/latest  Lensa (relay of the newest signed bundle, bytes as stored)
#   POST /sink/bundles/<name>  -> POST /bundles/<name>    Lensa publisher (unsigned source of the party's own bundle)
#   POST /sink/bundles/bi      -> POST /bundles/bi        BI's publisher-role cert, at a bank gateway only (BI's signed bundle, stored as is)
# The caller is attributes.source.principal: Envoy sets it from the client certificate, the SAN if it has one, else the
# subject as "CN=<name>". Our client certs carry no SAN (opa/mtls/gen-certs.sh, gen-party-certs.sh), so it reads "CN=lensa" or
# "CN=lensa-<party>"; a cert with a SAN would not match and is denied. The cert's CA is the party's own (S16), so a cert of
# another party never gets this far. OPA checks only method, path and subject here: the bearer token of the POST (Secret
# bundle-sink-token) is checked by bundle-server's sink.py (401), never by this package, and the request body is not read.
# Anything else, no client cert, a bank's cert, another method or path (also with a query string): denied (default false).
# A copy of bi.platform.sink: this bundle builds alone (gw needs both to allow).
package bank.platform.sink

http := input.attributes.request.http

caller := input.attributes.source.principal

# Lensa publisher: one shared cert (gen-certs.sh) or one per party (gen-party-certs.sh)
lensa := {"CN=lensa", "CN=lensa-bi", "CN=lensa-bank-a", "CN=lensa-bank-b", "CN=lensa-bank-c"}

# BI's publisher-role cert, signed by the bank's CA for BI's publisher; used only on a bank gateway (node2..4)
bi_publisher := "CN=bi-publisher"

bank_nodes := {"node2", "node3", "node4"}

default allow := false

allow if {
	http.method == "GET"
	http.path == "/sink/status"
	caller in lensa
}

allow if {
	http.method == "POST"
	regex.match(`^/sink/bundles/[a-z0-9][a-z0-9-]*$`, http.path)
	caller in lensa
}

# relay: read the newest signed bundle (Lensa copies BI's signed bundle to the bank sinks); read-only, Lensa certs only
allow if {
	http.method == "GET"
	regex.match(`^/sink/bundles/[a-z0-9][a-z0-9-]*/latest$`, http.path)
	caller in lensa
}

allow if {
	http.method == "POST"
	http.path == "/sink/bundles/bi"
	caller == bi_publisher
	input.attributes.contextExtensions.node in bank_nodes
}
