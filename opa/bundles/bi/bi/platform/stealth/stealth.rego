# BI rules for target `stealth` (S17): the stealth gateway st-gw-<N>'s door :8550 -> the party's signer (context_extensions {target: "stealth", node}).
# Lensa (relay and read model, no keys) may call exactly these routes, and only with its own mTLS client certificate:
#   POST /intent    build + sign + submit (kinds rd-transfer, bond-transfer, dvp-leg; the signer refuses a `from` that is not its party)
#   GET  /holdings  own stealth holdings (no private keys)
#   GET  /history   own received payments
#   GET  /health    liveness (no key, no chain call)
# /cert is not here and never will be: it is TLS passthrough (SNI custodian-1, tcp_proxy) to the custodian pod, outside OPA, and a Lensa client
# must not ask for certificates. The caller is attributes.source.principal: Envoy sets it from the client certificate ("CN=<name>": our client
# certs carry no SAN, opa/mtls/gen-party-certs.sh); the cert's CA is the party's own, so another party's cert never gets this far.
# OPA checks method, path and subject only; the body is not read (the signer checks `from`, kind and amount). A query string, a trailing slash or
# another case is a different path and is denied (default false).
# The bank bundle has its own copy of this file (bank.platform.stealth): it must build alone.
package bi.platform.stealth

http := input.attributes.request.http

caller := input.attributes.source.principal

lensa := {"CN=lensa", "CN=lensa-bi", "CN=lensa-bank-a", "CN=lensa-bank-b", "CN=lensa-bank-c"}

routes := {["POST", "/intent"], ["GET", "/holdings"], ["GET", "/history"], ["GET", "/health"]}

default allow := false

allow if {
	caller in lensa
	[http.method, http.path] in routes
}
