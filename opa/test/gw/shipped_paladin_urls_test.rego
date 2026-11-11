# The SHIPPED data.json (no `with` override): each node's paladin_url is its Paladin Service in the node's OWN per-party namespace
# (rd-zeto-<party>), not the old `paladin` namespace. Consumers: the bank daily-limit query (own node) and BI's Noto balance controls (issuer node1);
# both are inactive while no document sets daily_limit / max_balance / min_balance / max_supply.
package shipped_paladin_urls_test

import data.bank.paladin as bank_paladin

expected := {
	"node1": "http://paladin-node1.rd-zeto-bi.svc.cluster.local:8548",
	"node2": "http://paladin-node2.rd-zeto-bank-a.svc.cluster.local:8548",
	"node3": "http://paladin-node3.rd-zeto-bank-b.svc.cluster.local:8548",
	"node4": "http://paladin-node4.rd-zeto-bank-c.svc.cluster.local:8548",
}

test_every_node_url_is_its_own_namespace if {
	every n, url in expected {
		data.bi.config.nodes[n].paladin_url == url
	}
}

test_no_url_points_at_the_old_namespace if {
	every _, node in data.bi.config.nodes {
		not contains(node.paladin_url, ".paladin.svc.")
	}
}

test_daily_limit_query_goes_to_the_gateways_own_node if {
	every n, url in expected {
		bank_paladin.daily_query("zeto").url == url with input as {"attributes": {"contextExtensions": {"node": n, "target": "paladin"}}}
	}
}
