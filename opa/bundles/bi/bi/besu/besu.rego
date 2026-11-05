# BI rules for a bank's Besu RPC: a method allowlist. ethers batches calls into a JSON array, so every
# call in the batch must be allowed. Zeto txs reach Besu only through Paladin, which does not use this door.
package bi.besu

calls := input.parsed_body if is_array(input.parsed_body)

calls := [input.parsed_body] if is_object(input.parsed_body)

default allow := false

allow if {
	count(calls) > 0
	every c in calls {
		c.method in data.bi.config.besu.methods
	}
}
