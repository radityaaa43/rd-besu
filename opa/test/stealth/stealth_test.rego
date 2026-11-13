# Target `stealth` (S17): the stealth gateway st-gw-<N>, Envoy door :8550 -> the party's signer. Both packages (bi.platform.stealth,
# bank.platform.stealth) must allow, as gw dispatches every target but paladin and besu. The caller is the mTLS client certificate
# Envoy reports as attributes.source.principal ("CN=<name>", no SAN). Only Lensa's cert, only the four signer routes for Lensa.
# /cert is NEVER allowed here: it travels as TLS passthrough (SNI custodian-1) straight to the custodian pod, never through OPA, and
# a Lensa client must not ask for certificates. The request body is not read: the signer checks `from`, kind and amount itself.
package stealth_test

import data.bank.platform.stealth as bank
import data.bi.platform.stealth as bi
import data.gw

req(node, who, method, path) := {"attributes": {
	"contextExtensions": {"target": "stealth", "node": node},
	"source": {"principal": who},
	"request": {"http": {"method": method, "path": path}},
}}

# the caller-leaf check (opa/test/caller) is out of scope here: these inputs carry the Envoy principal only
allowed(i) if gw.allow with input as i with data.bi.config.caller_binding as {}

bi_allows(i) if bi.allow with input as i

bank_allows(i) if bank.allow with input as i

lensa := ["CN=lensa", "CN=lensa-bi", "CN=lensa-bank-a", "CN=lensa-bank-b", "CN=lensa-bank-c"]

nodes := ["node1", "node2", "node3", "node4"]

# S17 2026-11-13: + meta-address, BI ledger (exact query), DvP orchestration (the signer enforces role and party)
routes := [
	["POST", "/intent"], ["GET", "/holdings"], ["GET", "/history"], ["GET", "/health"], ["GET", "/meta-address"],
	["GET", "/ledger?kind=rd"], ["GET", "/ledger?kind=bond"],
	["POST", "/dvp/offer"], ["POST", "/dvp/bid"], ["POST", "/dvp/escrow"], ["POST", "/dvp/settle"], ["POST", "/dvp/cancel"],
]

test_lensa_routes_allowed_on_every_gateway_by_both_sides if {
	every who in lensa {
		every n in nodes {
			every r in routes {
				allowed(req(n, who, r[0], r[1]))
				bi_allows(req(n, who, r[0], r[1]))
				bank_allows(req(n, who, r[0], r[1]))
			}
		}
	}
}

test_cert_never_allowed if {
	every who in array.concat(lensa, ["CN=stealth-signer-bank-a", "CN=stealth-signer-bank-c", "CN=bi-publisher", "CN=custodian"]) {
		every n in nodes {
			every m in ["GET", "POST", "PUT"] {
				not allowed(req(n, who, m, "/cert"))
				not bi_allows(req(n, who, m, "/cert"))
				not bank_allows(req(n, who, m, "/cert"))
				not allowed(req(n, who, m, "/escrow-certs"))
				not bi_allows(req(n, who, m, "/escrow-certs"))
				not bank_allows(req(n, who, m, "/escrow-certs"))
				not allowed(req(n, who, m, "/ledger?kind=rd&x=1"))
			}
		}
	}
}

test_other_callers_denied if {
	every who in ["CN=stealth-signer-bank-a", "CN=bi-publisher", "CN=lensa-evil", "CN=", "lensa", "URI:spiffe://x/lensa", ""] {
		every r in routes {
			not allowed(req("node2", who, r[0], r[1]))
		}
	}
}

test_no_client_cert_denied if {
	every r in routes {
		not allowed({"attributes": {
			"contextExtensions": {"target": "stealth", "node": "node2"},
			"request": {"http": {"method": r[0], "path": r[1]}},
		}})
	}
}

test_wrong_method_or_path_denied if {
	every c in [
		["GET", "/intent"], ["PUT", "/intent"], ["POST", "/holdings"], ["POST", "/history"], ["DELETE", "/holdings"], ["POST", "/health"],
		["POST", "/intent/"], ["POST", "/Intent"], ["POST", "//intent"], ["POST", "/intent/../cert"], ["GET", "/holdings?x=1"], ["POST", "/intent?x=1"],
		["GET", "/history/"], ["GET", "/"], ["GET", "/sink/status"], ["POST", "/sink/bundles/bi"], ["POST", "/rpc"],
	] {
		every n in nodes {
			not allowed(req(n, "CN=lensa", c[0], c[1]))
		}
	}
}

test_one_side_alone_is_not_enough if {
	i := req("node2", "CN=lensa", "GET", "/holdings")
	not gw.allow with input as i with data.bank.platform.stealth.allow as false
	not gw.allow with input as i with data.bi.platform.stealth.allow as false
}
