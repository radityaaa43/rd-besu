# The real `bi` bundle data (bi/config/data.json, not the test fixtures): Besu door method list, S20 Besu network view.
package besu_methods_test

import data.gw

call(m) := {"jsonrpc": "2.0", "id": 1, "method": m, "params": []}

door(body) := {"attributes": {"contextExtensions": {"target": "besu", "node": "node2"}}, "parsed_body": body}

test_net_peercount_allowed if gw.allow with input as door(call("net_peerCount"))

test_eth_syncing_allowed if gw.allow with input as door(call("eth_syncing"))

test_eth_blocknumber_still_allowed if gw.allow with input as door(call("eth_blockNumber"))

test_network_view_batch_allowed if gw.allow with input as door([call("net_peerCount"), call("eth_syncing"), call("eth_blockNumber")])

# a method not on the list stays denied, alone or in a batch with the new ones
test_unlisted_methods_denied if {
	every m in ["admin_peers", "net_listening", "eth_subscribe", "eth_sendTransaction", "debug_traceTransaction", "txpool_content", "net_peerCountX"] {
		not gw.allow with input as door(call(m))
		not gw.allow with input as door([call("net_peerCount"), call(m)])
	}
}
