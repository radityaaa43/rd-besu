# BI rules for target `stealth_viewcopy` (S11 rework): BI's stealth gateway st-gw-1, SNI viewcopy-1 on the door :8550 -> BI's signer `PUT /viewcopy/<id>`
# (context_extensions {target: "stealth_viewcopy", node}). A bank pushes ITS OWN view-key copy there with its signer's mTLS client certificate, and may
# write exactly its own slot: PUT /viewcopy/<its id>. Another bank's slot, /viewcopy/bi, an unknown id, any other method or path, a Lensa cert and a
# missing certificate are denied. The caller is attributes.source.principal ("CN=<name>"): it is the subject only because our client certs carry no SAN.
# OPA checks method, path and subject only; the body (the view key) is NOT sent to OPA by Envoy on this chain and is never read here: the signer
# checks the copy itself. A query string, a trailing slash or another case is a different path and is denied (default false).
# The bank bundle has its own copy of this file (bank.platform.stealth_viewcopy): it must build alone (gw needs both to allow).
package bi.platform.stealth_viewcopy

http := input.attributes.request.http

caller := input.attributes.source.principal

signers := {"CN=bank-a-signer": "bank-a", "CN=bank-b-signer": "bank-b", "CN=bank-c-signer": "bank-c"}

default allow := false

allow if {
	http.method == "PUT"
	id := signers[caller]
	http.path == concat("/", ["/viewcopy", id])
}
