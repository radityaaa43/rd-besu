# gw/allow for deploying a Noto platform (bi.notosetup): shapes as bond/src/index.ts sends them, issuer node only.
package gw_test

ns_ctor := {"type": "constructor", "inputs": []}

ns_group(members) := {"domain": "pente", "name": "g", "members": members, "configuration": {"evmVersion": "shanghai", "externalCallsEnabled": "true"}}

ns_pente_deploy(from) := {"domain": "pente", "group": "0x01", "from": from, "input": {}, "bytecode": "0x6080", "function": ns_ctor}

ns_noto_deploy(from, notary, mode) := {
	"type": "private", "domain": "noto", "abi": [ns_ctor], "function": "", "from": from,
	"data": {"name": "CASH", "symbol": "CASH", "notary": notary, "notaryMode": mode, "options": {"hooks": {}}},
}

ns_public_deploy(from) := {"type": "public", "abi": [ns_ctor], "bytecode": "0x6080", "function": "", "from": from, "data": {}}

# --- pgroup_createGroup

test_setup_group_on_issuer_allowed if allowed(rpc("node1", "pgroup_createGroup", [ns_group(["cashIssuer@node1"])]))

test_setup_group_two_members_on_issuer_allowed if allowed(rpc("node1", "pgroup_createGroup", [ns_group(["bondIssuer@node1", "bondCustodian@node1"])]))

test_setup_group_on_bank_denied if not allowed(rpc("node2", "pgroup_createGroup", [ns_group(["investor1@node2"])]))

test_setup_group_with_foreign_member_denied if not allowed(rpc("node1", "pgroup_createGroup", [ns_group(["bondIssuer@node1", "investor1@node2"])]))

test_setup_group_without_members_denied if not allowed(rpc("node1", "pgroup_createGroup", [ns_group([])]))

# --- deploy inside a Pente group

test_setup_pente_deploy_on_issuer_allowed if allowed(rpc("node1", "pgroup_sendTransaction", [ns_pente_deploy("bondIssuer@node1")]))

test_setup_pente_deploy_on_bank_denied if not allowed(rpc("node2", "pgroup_sendTransaction", [ns_pente_deploy("investor1@node2")]))

test_setup_pente_deploy_from_other_node_denied if not allowed(rpc("node1", "pgroup_sendTransaction", [ns_pente_deploy("investor1@node2")]))

test_setup_pente_call_into_unknown_group_denied if not allowed(rpc("node1", "pgroup_sendTransaction", [object.union(ns_pente_deploy("bondIssuer@node1"), {"to": "0x900bb5b2043366f2bb3ee1e7c79a0eef793ae284"})]))

test_setup_pente_deploy_without_bytecode_denied if not allowed(rpc("node1", "pgroup_sendTransaction", [object.remove(ns_pente_deploy("bondIssuer@node1"), ["bytecode"])]))

# --- Noto deploy

test_setup_noto_deploy_on_issuer_allowed if allowed(send("node1", ns_noto_deploy("cashIssuer@node1", "cashIssuer@node1", "hooks")))

test_setup_noto_deploy_on_bank_denied if not allowed(send("node2", ns_noto_deploy("bankA@node2", "bankA@node2", "hooks")))

test_setup_noto_deploy_foreign_notary_denied if not allowed(send("node1", ns_noto_deploy("cashIssuer@node1", "bankA@node2", "hooks")))

test_setup_noto_deploy_basic_mode_denied if not allowed(send("node1", ns_noto_deploy("cashIssuer@node1", "cashIssuer@node1", "basic")))

# --- public deploy

test_setup_public_deploy_on_issuer_allowed if allowed(send("node1", ns_public_deploy("bondIssuer@node1")))

test_setup_public_deploy_on_bank_denied if not allowed(send("node2", ns_public_deploy("bankA@node2")))

test_setup_public_deploy_from_other_node_denied if not allowed(send("node1", ns_public_deploy("bankA@node2")))

test_setup_public_deploy_without_bytecode_denied if not allowed(send("node1", object.remove(ns_public_deploy("bondIssuer@node1"), ["bytecode"])))

# --- nothing else opens: a Noto call into a contract data.json does not know stays denied, also on the issuer node

test_setup_noto_mint_on_unknown_contract_denied if not allowed(send("node1", {"type": "private", "to": "0x00000000000000000000000000000000000000cc", "from": "cashIssuer@node1", "function": "mint", "data": {"to": "investor1@node2", "amount": "5", "data": "0x"}}))
