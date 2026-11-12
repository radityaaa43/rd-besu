# Caller identity on the Paladin door (c7, orchestrator ruling "option a", analyst R32): party X's Lensa leaf (CN `lensa`, issued by party X's Lensa CA)
# may use ONLY party X's gateway. The leaf is the one Envoy forwards in x-forwarded-client-cert (forward_client_cert_details SANITIZE_SET, cert: true), verified
# against data.bi.config.lensa_ca[<node>] (public PEMs). Fixtures: opa/test/fabricx/pki.rego (lensa<N> = bank-gw-ca-<N>, lensa_leaf<N> signed by it).
package caller_test

import data.fabricx_pki as pki
import data.fixtures
import data.gw

ca := {"node1": pki.ca_lensa1, "node2": pki.ca_lensa2, "node3": pki.ca_lensa3, "node4": pki.ca_lensa4}

leaf := {"node1": pki.lensa_leaf1, "node2": pki.lensa_leaf2, "node3": pki.lensa_leaf3, "node4": pki.lensa_leaf4}

bound := object.union(fixtures.bi, {"lensa_ca": ca, "caller_binding": {"paladin": true}})

xfcc(pem) := sprintf("Hash=00;Cert=\"%s\";Subject=\"x\"", [urlquery.encode(pem)])

door_with(node, body, headers) := {
	"attributes": {"contextExtensions": {"target": "paladin", "node": node}, "request": {"http": {"headers": headers}}},
	"parsed_body": body,
}

read := {"jsonrpc": "2.0", "id": 1, "method": "ptx_getTransactionReceipt", "params": ["id"]}

transfer := {"jsonrpc": "2.0", "id": 1, "method": "ptx_sendTransaction", "params": [{
	"type": "private", "domain": "zeto", "to": "0xdef2e64a415fd95e5b2c9fa1d7bdbc1792c410a1", "from": "bankA@node2", "function": "transfer",
	"data": {"transfers": [{"to": "bankB@node3", "amount": 10, "data": "0x"}]},
}]}

door_as(node, body, pem) := door_with(node, body, {"x-forwarded-client-cert": xfcc(pem)})

allowed(i) if {
	gw.allow with input as i
		with data.bi.config as bound
		with data.bank.config as fixtures.bank_a
}

# --- the party's own Lensa leaf at its own gateway: reads and the existing write shapes pass
test_own_leaf_read_allowed if allowed(door_as("node2", read, leaf.node2))

test_own_leaf_write_allowed if allowed(door_as("node2", transfer, leaf.node2))

# --- every other leaf, header shape or CA is refused (same request, only the caller differs)
test_other_party_leaf_read_denied if not allowed(door_as("node2", read, leaf.node3))

test_other_party_leaf_write_denied if not allowed(door_as("node2", transfer, leaf.node3))

test_every_cross_party_pair_denied if {
	every n in {"node1", "node3", "node4"} {
		not allowed(door_as("node2", read, leaf[n]))
	}
}

test_no_header_denied if not allowed(door_with("node2", read, {}))

test_header_without_cert_denied if not allowed(door_with("node2", read, {"x-forwarded-client-cert": "Hash=00;Subject=\"CN=lensa\""}))

test_garbage_cert_denied if not allowed(door_with("node2", read, {"x-forwarded-client-cert": "Hash=00;Cert=\"not-a-cert\""}))

test_two_cert_elements_denied if {
	one := xfcc(leaf.node2)
	not allowed(door_with("node2", read, {"x-forwarded-client-cert": concat(",", [one, one])}))
}

test_lensa_named_leaf_from_a_foreign_ca_denied if not allowed(door_as("node2", read, pki.lensa_by_gw))

test_other_cn_from_the_right_ca_denied if not allowed(door_as("node2", read, pki.peer_1_lensa))

test_server_only_leaf_denied if not allowed(door_as("node2", read, pki.peer_server_eku))

test_no_ca_data_denies if {
	not gw.allow with input as door_as("node2", read, leaf.node2)
		with data.bi.config as object.union(object.remove(bound, ["lensa_ca"]), {"lensa_ca": {}})
		with data.bank.config as fixtures.bank_a
}

# --- the flag is the rollout switch for legacy fixtures; the SHIPPED data must switch the binding on (a missing key would silently open every gateway)
test_shipped_data_binds_the_paladin_door if data.bi.config.caller_binding.paladin == true

test_shipped_lensa_ca_covers_the_four_nodes if {
	count(data.bi.config.lensa_ca) == 4
	every n in {"node1", "node2", "node3", "node4"} {
		count(crypto.x509.parse_certificates(data.bi.config.lensa_ca[n])) == 1
	}
}

# one CA per party, the same public PEMs the other platforms already ship
test_shipped_lensa_ca_equals_fabricx_lensa_ca if data.bi.config.lensa_ca == data.bi.config.fabricx_ca.lensa

# --- the unbound legacy path is only for fixtures: with the flag off the door behaves as before (no header needed)
test_flag_off_is_legacy_behaviour if {
	gw.allow with input as door_with("node2", read, {})
		with data.bi.config as fixtures.bi
		with data.bank.config as fixtures.bank_a
}
