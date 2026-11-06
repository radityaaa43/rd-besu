# gw/allow for a target other than paladin or besu: a platform passes only when both its packages allow, and `target`
# is read only from Envoy's context_extensions. The stub packages are in platform_stub*.rego (test-only).
package gw_platform_test

import data.fixtures
import data.gw

allowed(i) if gw.allow with input as i with data.bi.config as fixtures.bi with data.bank.config as fixtures.bank_a

call(method) := {"jsonrpc": "2.0", "id": 1, "method": method, "params": []}

door(target, node, body) := {
	"attributes": {"contextExtensions": {"target": target, "node": node}},
	"parsed_body": body,
}

stub(i, bi, bank) := object.union(i, {"stub": {"bi": bi, "bank": bank}})

read := call("ptx_getTransactionReceipt")

# --- a platform passes only when BOTH of its packages allow

test_platform_both_allow if allowed(stub(door("stub", "node2", read), true, true))

test_platform_bi_denies if not allowed(stub(door("stub", "node2", read), false, true))

test_platform_bank_denies if not allowed(stub(door("stub", "node2", read), true, false))

test_platform_neither_allows if not allowed(stub(door("stub", "node2", read), false, false))

# --- a target without packages is denied, registered or not

test_unregistered_target_denied if not allowed(stub(door("nope", "node2", read), true, true))

# fabricx and iroha3 are registered platforms with no rego packages yet (bundles/*/platform/ has none)
test_registered_target_without_packages_denied if {
	not allowed(stub(door("fabricx", "node2", read), true, true)) with data.bi.platform as {} with data.bank.platform as {}
	not allowed(stub(door("iroha3", "node2", read), true, true)) with data.bi.platform as {} with data.bank.platform as {}
}

# the plain case, no mocking: the stub id is the only package, so fabricx has none
test_registered_target_not_covered_by_the_stub if not allowed(stub(door("fabricx", "node2", read), true, true))

# one package is not enough: the other side must exist too
test_registered_target_with_one_package_denied if {
	not allowed(door("fabricx", "node2", read)) with data.bi.platform as {"fabricx": {"allow": true}} with data.bank.platform as {}
	not allowed(door("fabricx", "node2", read)) with data.bi.platform as {} with data.bank.platform as {"fabricx": {"allow": true}}
}

# a real package for a registered platform is honoured the same way (mocked here, so no stub merges with a future package)
test_registered_target_with_both_packages_allowed if {
	allowed(door("fabricx", "node2", read)) with data.bi.platform as {"fabricx": {"allow": true}} with data.bank.platform as {"fabricx": {"allow": true}}
}

test_target_names_cannot_reach_other_data if {
	not allowed(door("config", "node2", read))
	not allowed(door("../config", "node2", read))
	not allowed(door("", "node2", read))
	not allowed(door(1, "node2", read))
	not allowed(door(["stub"], "node2", read))
	not allowed(door({"stub": true}, "node2", read))
}

# --- the target is read only from context_extensions

test_target_in_body_or_header_ignored if {
	i := {
		"attributes": {
			"contextExtensions": {"node": "node2"},
			"request": {"http": {"headers": {"x-target": "stub", "target": "stub"}}},
		},
		"parsed_body": object.union(read, {"target": "stub"}),
		"target": "stub",
		"stub": {"bi": true, "bank": true},
	}
	not allowed(i)
}

# Envoy says "nope"; the client says paladin or stub in every place it can write
test_client_cannot_override_the_envoy_target if {
	i := {
		"attributes": {
			"contextExtensions": {"target": "nope", "node": "node2"},
			"request": {"http": {"headers": {"x-target": "paladin", "target": "stub"}}},
		},
		"parsed_body": object.union(read, {"target": "paladin"}),
		"stub": {"bi": true, "bank": true},
	}
	not allowed(i)
}

# --- paladin and besu are unchanged by the dispatch

test_paladin_unchanged if {
	allowed(stub(door("paladin", "node2", read), false, false))
	not allowed(stub(door("paladin", "node2", call("keymgr_sign")), true, true))
	not allowed(stub(door("paladin", "node9", read), true, true))
}

test_besu_unchanged if {
	allowed(door("besu", "node2", call("eth_blockNumber")))
	not allowed(stub(door("besu", "node2", call("eth_sendTransaction")), true, true))
}

# a package named after a built-in door cannot take it over: paladin and besu keep their own rules
test_builtin_doors_not_hijacked_by_platform_packages if {
	not allowed(door("paladin", "node2", call("keymgr_sign"))) with data.bi.platform as {"paladin": {"allow": true}} with data.bank.platform as {"paladin": {"allow": true}}
	not allowed(door("besu", "node2", call("eth_sendTransaction"))) with data.bi.platform as {"besu": {"allow": true}} with data.bank.platform as {"besu": {"allow": true}}
}
