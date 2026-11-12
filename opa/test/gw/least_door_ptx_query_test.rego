# Least door for the ptx_query* reads, on the SHIPPED data (no override): the pending/prepared lists are not reachable through
# the gateway any more (node-admin reads, done with the probe pod); the three kept list queries need an explicit limit of 1..100.
package least_door_ptx_query_test

import data.gw

door(node, method, params) := {
	"attributes": {"contextExtensions": {"target": "paladin", "node": node}},
	"parsed_body": {"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
}

# gw/allow with the shipped documents of both bundles
allowed(i) if gw.allow with input as i

kept := ["ptx_queryTransactions", "ptx_queryTransactionsFull", "ptx_queryTransactionReceipts"]

test_pending_and_prepared_lists_are_not_shipped_read_methods if {
	not "ptx_queryPendingTransactions" in data.bi.config.paladin.read_methods
	not "ptx_queryPreparedTransactions" in data.bi.config.paladin.read_methods
}

test_pending_and_prepared_lists_are_denied_on_every_node if {
	every n in ["node1", "node2", "node3", "node4"] {
		not allowed(door(n, "ptx_queryPendingTransactions", [{"limit": 20}, false]))
		not allowed(door(n, "ptx_queryPreparedTransactions", [{"limit": 20}]))
	}
}

test_kept_list_queries_are_still_read_methods if {
	every m in kept {
		m in data.bi.config.paladin.read_methods
	}
}

test_kept_list_queries_pass_with_a_limit_of_1_to_100 if {
	every m in kept {
		allowed(door("node2", m, [{"limit": 1}]))
		allowed(door("node2", m, [{"limit": 20, "sort": ["created DESC"]}]))
		allowed(door("node2", m, [{"limit": 100}]))
	}
}

test_kept_list_queries_are_denied_without_a_usable_limit if {
	every m in kept {
		not allowed(door("node2", m, [{"limit": 101}]))
		not allowed(door("node2", m, [{"limit": 0}]))
		not allowed(door("node2", m, [{"limit": -5}]))
		not allowed(door("node2", m, [{"limit": 20.5}]))
		not allowed(door("node2", m, [{"limit": "20"}]))
		not allowed(door("node2", m, [{}]))
		not allowed(door("node2", m, []))
		not allowed(door("node2", m, ["limit"]))
		not allowed(door("node2", m, [{"limit": null}]))
	}
}

test_single_reads_and_other_methods_are_not_affected if {
	allowed(door("node2", "ptx_getTransactionReceipt", ["id"]))
	allowed(door("node2", "ptx_getTransaction", ["id"]))
	not allowed(door("node2", "keymgr_sign", []))
}

# The decision log keeps what the review needs: the method and the limit (params/0 stays, only params/0/data is masked) and the caller's
# certificate header (x-forwarded-client-cert); the authorization header and the raw body are masked.
test_decision_log_mask_keeps_method_limit_and_caller_identity if {
	m := data.system.log.mask
	not "/input/parsed_body/params/0/limit" in m
	not "/input/parsed_body/method" in m
	not "/input/attributes/request/http/headers/x-forwarded-client-cert" in m
	"/input/attributes/request/http/headers/authorization" in m
	"/input/attributes/request/http/body" in m
}
