# The SHIPPED bundles/bi/bi/config/data.json (no `with` override): a bank may report to BI only over its own {bank, BI} group, and the ids there
# must be the ones S21 layer 5b created on the NEW Paladin nodes (2026-11-12 05:03 CST). The old ids (old nodes) must be denied.
package shipped_report_groups_test

import data.bi.paladin

report(node, group) := {
	"attributes": {"contextExtensions": {"target": "paladin", "node": node}},
	"parsed_body": {"jsonrpc": "2.0", "id": 1, "method": "pgroup_sendMessage", "params": [{"domain": "pente", "group": group, "topic": "zeto-report-v1", "data": {}}]},
}

new_ids := {
	"node2": "0xee0dc11a32f1ee053753e76aba245bcd236eac832d93922bf10f9aaf9d6066ab",
	"node3": "0x1e3ffdf54d7f67b1040c3a364e56b82b1c34edfa60036aad15de3888f41ad208",
	"node4": "0x3f98399991bacbd12b35ef1f991be004f31cd485202a3d5570453790cbae9903",
}

old_ids := {
	"node2": "0xec8979f57a1802f45b61ce7aa2c657111090576dc1f9d97c5ad0265f259a703d",
	"node3": "0xd0fe12c1e4515b331e7e512c5b2a64c651438b04082463def82c27a73aa8f901",
	"node4": "0xed8b8ff405ac48fe3530cf636a1b3fc3d30c58ea48b59e5700e6b07bec00a9c5",
}

test_report_over_the_new_group_allowed if {
	every node, id in new_ids {
		paladin.allow with input as report(node, id)
	}
}

test_report_over_the_old_group_denied if {
	every node, id in old_ids {
		not paladin.allow with input as report(node, id)
	}
}

test_report_over_another_banks_new_group_denied if {
	not paladin.allow with input as report("node2", new_ids.node3)
	not paladin.allow with input as report("node3", new_ids.node4)
	not paladin.allow with input as report("node4", new_ids.node2)
}
