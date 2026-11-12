# Caller identity of the Lensa client at a gateway door (c7 / R32). `allow` rules say WHAT may be asked; this says WHO asks.
# Envoy (forward_client_cert_details SANITIZE_SET, cert: true) forwards the client leaf it verified in x-forwarded-client-cert; a client cannot inject it.
# XFCC carries no issuer, so the leaf is verified here against the PUBLIC CA data.bi.config.lensa_ca[<node>] (that party's gateway CA, bank-gw mTLS CA <party>):
#   party X's Lensa leaf = CN exactly `lensa`, signed DIRECTLY by X's CA, ClientAuth, not a CA. Party Y's leaf (other CA), another CN, a server-only key usage,
#   a missing / second / malformed Cert element, or no CA data: denied. Nothing else is read from the request (no body, no other header).
# data.bi.config.caller_binding[<target>] == true switches the check on for a door (the SHIPPED data switches it on; opa/test/caller pins that). Fixtures of older tests that
# build inputs without a client leaf run with the key absent.
package bi.caller

# The leaf Envoy forwarded: exactly one Cert element, one certificate in it.
leaf_pem := pem if {
	h := input.attributes.request.http.headers["x-forwarded-client-cert"]
	count(regex.find_all_string_submatch_n(`Cert="`, h, -1)) == 1
	pem := urlquery.decode(regex.find_all_string_submatch_n(`Cert="([^"]+)"`, h, 1)[0][1])
	count(crypto.x509.parse_certificates(pem)) == 1
}

# The leaf, if it verifies directly against `ca` for client auth. Input order [root, leaf]; the result lists the leaf first, and the leaf must not be a CA.
verified(ca) := leaf if {
	[ok, certs] := crypto.x509.parse_and_verify_certificates_with_options(concat("\n", [ca, leaf_pem]), {"KeyUsages": ["KeyUsageClientAuth"]})
	ok == true
	count(certs) == 2
	some leaf in certs
	not leaf.IsCA
}

lensa(node) if verified(data.bi.config.lensa_ca[node]).Subject.CommonName == "lensa"

default bound(_) := false

bound(target) if data.bi.config.caller_binding[target] == true

# A door passes the caller check when its binding is off (legacy fixtures only) or the Lensa leaf of THIS node's party is presented.
ok(target, _) if not bound(target)

ok(target, node) if {
	bound(target)
	lensa(node)
}
