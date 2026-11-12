# Target `stealth_viewcopy` (S11 rework): a bank pushes ITS OWN view-key copy to BI's stealth gateway (st-gw-1, SNI viewcopy-1, door :8550) and the
# request lands on BI's signer `PUT /viewcopy/<id>`. Both packages (bi.platform.stealth_viewcopy, bank.platform.stealth_viewcopy) must allow, as
# gw dispatches every target but paladin and besu. The caller is the bank signer's mTLS client certificate Envoy reports as
# attributes.source.principal ("CN=<name>", no SAN). A bank CN may write exactly its own slot: PUT /viewcopy/<its id>, nothing else.
# The request body is NOT sent to OPA (Envoy disables buffering on that chain) and OPA never reads it.
package stealth_viewcopy_test

import data.bank.platform.stealth_viewcopy as bank
import data.bi.platform.stealth_viewcopy as bi
import data.gw

req(target, node, who, method, path) := {"attributes": {
	"contextExtensions": {"target": target, "node": node},
	"source": {"principal": who},
	"request": {"http": {"method": method, "path": path}},
}}

vc(who, method, path) := req("stealth_viewcopy", "node1", who, method, path)

allowed(i) if gw.allow with input as i

bi_allows(i) if bi.allow with input as i

bank_allows(i) if bank.allow with input as i

# CN -> the one id that CN may write
slots := {"CN=bank-a-signer": "bank-a", "CN=bank-b-signer": "bank-b", "CN=bank-c-signer": "bank-c"}

ids := ["bank-a", "bank-b", "bank-c"]

lensa := ["CN=lensa", "CN=lensa-bi", "CN=lensa-bank-a", "CN=lensa-bank-b", "CN=lensa-bank-c"]

test_each_bank_may_write_only_its_own_slot_both_sides_and_gw if {
	every who, id in slots {
		i := vc(who, "PUT", concat("/", ["/viewcopy", id]))
		allowed(i)
		bi_allows(i)
		bank_allows(i)
	}
}

test_every_cross_slot_is_denied if {
	every who, own in slots {
		every id in {x | some x in ids; x != own} {
			i := vc(who, "PUT", concat("/", ["/viewcopy", id]))
			not allowed(i)
			not bi_allows(i)
			not bank_allows(i)
		}
	}
}

test_no_bank_may_write_the_bi_slot_or_an_unknown_id if {
	every who in object.keys(slots) {
		every id in ["bi", "bank-d", "bank-aa", "bank-", "", "bank-a-signer", "node1", "*", "bank-a,bank-b"] {
			not allowed(vc(who, "PUT", concat("/", ["/viewcopy", id])))
		}
	}
}

test_unknown_signer_cn_denied_on_every_slot if {
	every who in ["CN=bank-d-signer", "CN=bi-signer", "CN=bank-a", "CN=bank-a-signer-2", "CN=Bank-A-Signer", "CN=BANK-A-SIGNER", "CN=bank-a-signer,O=x", "bank-a-signer", "CN=bank-a-signer ", "CN=custodian", "CN=bi-publisher", "CN=stealth-signer-bank-a"] {
		every id in array.concat(ids, ["bi", "bank-d"]) {
			not allowed(vc(who, "PUT", concat("/", ["/viewcopy", id])))
		}
	}
}

test_wrong_method_denied_on_own_slot if {
	every who, id in slots {
		every m in ["GET", "POST", "DELETE", "PATCH", "HEAD", "OPTIONS", "put", "Put", ""] {
			not allowed(vc(who, m, concat("/", ["/viewcopy", id])))
		}
	}
}

test_odd_paths_denied if {
	every who, id in slots {
		every p in [
			concat("/", ["/viewcopy", id, ""]),
			concat("", ["/viewcopy/", id, "?x=1"]),
			concat("", ["/viewcopy/", id, "#x"]),
			concat("", ["/viewcopy/", upper(id)]),
			concat("", ["/VIEWCOPY/", id]),
			concat("", ["/Viewcopy/", id]),
			concat("", ["//viewcopy/", id]),
			concat("", ["/viewcopy//", id]),
			concat("", [" /viewcopy/", id]),
			concat("", ["/viewcopy/", id, " "]),
			concat("", ["/viewcopy/", id, "%2F"]),
			concat("", ["/viewcopy/", id, "/../bank-b"]),
			concat("", ["/viewcopy/./", id]),
			concat("", ["/viewcopy/bank-d/../", id]),
			concat("", ["/x/viewcopy/", id]),
			"/viewcopy/../intent",
			"/viewcopy/../../cert",
			"/viewcopy/..",
			"/viewcopy/",
			"/viewcopy",
			"/viewcopy/*",
			"/",
			"",
		] {
			not allowed(vc(who, "PUT", p))
		}
	}
}

test_no_other_stealth_route_for_a_bank_cn if {
	every who in object.keys(slots) {
		every c in [
			["POST", "/intent"], ["PUT", "/intent"], ["GET", "/holdings"], ["GET", "/history"], ["GET", "/health"], ["GET", "/ledger"],
			["GET", "/cert"], ["POST", "/cert"], ["PUT", "/cert"], ["GET", "/meta-address"], ["PUT", "/sink/bundles/bi"], ["POST", "/rpc"],
		] {
			not allowed(vc(who, c[0], c[1]))
			not bi_allows(vc(who, c[0], c[1]))
			not bank_allows(vc(who, c[0], c[1]))
		}
	}
}

test_lensa_cns_denied_on_the_viewcopy_target if {
	every who in lensa {
		every id in array.concat(ids, ["bi"]) {
			not allowed(vc(who, "PUT", concat("/", ["/viewcopy", id])))
			not bi_allows(vc(who, "PUT", concat("/", ["/viewcopy", id])))
			not bank_allows(vc(who, "PUT", concat("/", ["/viewcopy", id])))
		}
	}
}

test_empty_or_missing_principal_denied if {
	every who in ["", "CN=", "CN", "lensa", "URI:spiffe://x/bank-a-signer"] {
		not allowed(vc(who, "PUT", "/viewcopy/bank-a"))
	}
	not allowed({"attributes": {
		"contextExtensions": {"target": "stealth_viewcopy", "node": "node1"},
		"request": {"http": {"method": "PUT", "path": "/viewcopy/bank-a"}},
	}})
	not allowed({"attributes": {
		"contextExtensions": {"target": "stealth_viewcopy", "node": "node1"},
		"source": {},
		"request": {"http": {"method": "PUT", "path": "/viewcopy/bank-a"}},
	}})
}

# a bank signer CN is not a Lensa caller: the Lensa target `stealth` stays closed to it (its routes, any node)
test_bank_signer_cn_denied_on_the_lensa_target if {
	every who in object.keys(slots) {
		every n in ["node1", "node2", "node3", "node4"] {
			every c in [["POST", "/intent"], ["GET", "/holdings"], ["GET", "/history"], ["GET", "/health"], ["PUT", "/viewcopy/bank-a"], ["PUT", "/viewcopy/bank-b"], ["PUT", "/viewcopy/bank-c"]] {
				not allowed(req("stealth", n, who, c[0], c[1]))
			}
		}
	}
}

# and a Lensa cert does not reach the viewcopy route through the other target either
test_viewcopy_route_is_not_a_lensa_route if {
	every who in lensa {
		not allowed(req("stealth", "node1", who, "PUT", "/viewcopy/bank-a"))
	}
}

test_one_side_alone_is_not_enough if {
	i := vc("CN=bank-a-signer", "PUT", "/viewcopy/bank-a")
	allowed(i)
	not gw.allow with input as i with data.bank.platform.stealth_viewcopy.allow as false
	not gw.allow with input as i with data.bi.platform.stealth_viewcopy.allow as false
}

test_default_is_deny_without_input if {
	not bi.allow with input as {}
	not bank.allow with input as {}
}
