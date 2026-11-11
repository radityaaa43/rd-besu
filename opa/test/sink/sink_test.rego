# Target `sink` (zeto S17): the party gateway's door to its bundle-server (GET /sink/status, POST /sink/bundles/<name>). Both
# packages (bi.platform.sink, bank.platform.sink) must allow, as gw dispatches every target but paladin and besu. The caller is
# the mTLS client certificate Envoy reports as attributes.source.principal ("CN=<name>": client certs carry no SAN). The bearer
# token of the POST is not checked here: bundle-server's sink.py does that (401).
package sink_test

import data.bank.platform.sink as bank
import data.bi.platform.sink as bi
import data.gw

req(node, who, method, path) := {"attributes": {
	"contextExtensions": {"target": "sink", "node": node},
	"source": {"principal": who},
	"request": {"http": {"method": method, "path": path}},
}}

# the gateway's decision, and each side alone
allowed(i) if gw.allow with input as i

bi_allows(i) if bi.allow with input as i

bank_allows(i) if bank.allow with input as i

lensa := ["CN=lensa", "CN=lensa-bi", "CN=lensa-bank-a", "CN=lensa-bank-b", "CN=lensa-bank-c"]

nodes := ["node1", "node2", "node3", "node4"]

# --- Lensa publisher: status and upload, any gateway, both sides

test_lensa_status_allowed if {
	every who in lensa {
		every n in nodes {
			allowed(req(n, who, "GET", "/sink/status"))
		}
	}
}

test_lensa_upload_allowed if {
	every who in lensa {
		every n in nodes {
			allowed(req(n, who, "POST", "/sink/bundles/bank"))
			allowed(req(n, who, "POST", "/sink/bundles/bi"))
			allowed(req(n, who, "POST", "/sink/bundles/bank-a-zeto"))
		}
	}
}

test_each_package_allows_lensa_alone if {
	i := req("node2", "CN=lensa", "GET", "/sink/status")
	bi_allows(i)
	bank_allows(i)
}

# --- BI's publisher-role cert: only the forward of its signed bundle, only at a bank gateway

test_bi_publisher_may_forward_bi_bundle_to_banks if {
	every n in ["node2", "node3", "node4"] {
		allowed(req(n, "CN=bi-publisher", "POST", "/sink/bundles/bi"))
	}
}

test_bi_publisher_not_at_bi_own_gateway if not allowed(req("node1", "CN=bi-publisher", "POST", "/sink/bundles/bi"))

test_bi_publisher_nothing_else if {
	not allowed(req("node2", "CN=bi-publisher", "POST", "/sink/bundles/bank"))
	not allowed(req("node2", "CN=bi-publisher", "POST", "/sink/bundles/bi-x"))
	not allowed(req("node2", "CN=bi-publisher", "GET", "/sink/bundles/bi"))
	not allowed(req("node2", "CN=bi-publisher", "GET", "/sink/status"))
}

# --- everyone else is denied

test_bank_client_cert_denied if {
	every who in ["CN=bank-a", "CN=bank-b", "CN=bank-c", "CN=bank-gw-2", "CN=paladin-node2", "CN=bi"] {
		not allowed(req("node2", who, "GET", "/sink/status"))
		not allowed(req("node2", who, "POST", "/sink/bundles/bank"))
		not allowed(req("node2", who, "POST", "/sink/bundles/bi"))
	}
}

test_no_cert_denied if {
	not allowed({"attributes": {
		"contextExtensions": {"target": "sink", "node": "node2"},
		"request": {"http": {"method": "GET", "path": "/sink/status"}},
	}})
	not allowed(req("node2", "", "GET", "/sink/status"))
}

test_subject_must_match_exactly if {
	every who in ["CN=lensa-x", "CN=Lensa", "lensa", "CN=lensa,O=x", "CN=bi-publisher-2", "CN=xlensa", "CN=lensa-bank-d"] {
		not allowed(req("node2", who, "GET", "/sink/status"))
	}
}

# --- only the two documented routes and methods

test_other_paths_and_methods_denied if {
	every who in ["CN=lensa", "CN=bi-publisher"] {
		not allowed(req("node2", who, "POST", "/sink/status"))
		not allowed(req("node2", who, "DELETE", "/sink/status"))
		not allowed(req("node2", who, "GET", "/sink/bundles/bank"))
		not allowed(req("node2", who, "PUT", "/sink/bundles/bank"))
		not allowed(req("node2", who, "POST", "/sink/bundles"))
		not allowed(req("node2", who, "POST", "/sink/bundles/"))
		not allowed(req("node2", who, "POST", "/sink/logs"))
		not allowed(req("node2", who, "POST", "/sink/"))
		not allowed(req("node2", who, "GET", "/sink/status/"))
		not allowed(req("node2", who, "GET", "/sink/status?x=1"))
	}
}

test_upload_name_is_one_path_segment if {
	every p in ["/sink/bundles/../status", "/sink/bundles/a/b", "/sink/bundles/A", "/sink/bundles/-a", "/sink/bundles/a.b", "/sink/bundles/a%2fb", "/sink/bundles/bank?x=1", "/sink/bundles/bank "] {
		not allowed(req("node2", "CN=lensa", "POST", p))
	}
}

# --- the target comes only from Envoy; another target never reaches these rules

test_not_the_sink_target if {
	i := object.union(req("node2", "CN=lensa", "GET", "/sink/status"), {"attributes": {"contextExtensions": {"target": "stub"}}})
	not allowed(i)
}

test_sink_target_cannot_open_paladin_or_besu_paths if {
	not allowed(req("node2", "CN=lensa", "POST", "/"))
	not allowed(req("node2", "CN=lensa", "POST", "/sink/../"))
}
