# Decision-log mask vs a view-key push (S11 rework): the viewcopy chain does not send the request body to OPA, and the mask drops it anyway if a
# body ever reaches the input (defence in depth). The fixture holds a FAKE key string; every place it sits in the input must be under a masked
# pointer (the pointer itself or a parent), so it can never reach the console decision log. Paladin's method and limit stay readable.
package system.log_mask_test

fake := "00000000000000000000000000000000000000000000000000000000000fa4e1"

fixture := {"attributes": {
	"contextExtensions": {"target": "stealth_viewcopy", "node": "node1"},
	"source": {"principal": "CN=bank-a-signer"},
	"request": {"http": {
		"method": "PUT",
		"path": "/viewcopy/bank-a",
		"headers": {"x-forwarded-client-cert": "Subject=\"CN=bank-a-signer\""},
		"body": sprintf("{\"viewKey\":\"%s\"}", [fake]),
	}},
}, "parsed_body": {"viewKey": fake, "metaAddress": "st:eth:0xabc", "identityAddress": "0x1"}}

pointer(path) := concat("/", array.concat(["", "input"], [sprintf("%v", [k]) | some k in path]))

masked(p) if p in data.system.log.mask

masked(p) if {
	some m in data.system.log.mask
	startswith(p, concat("", [m, "/"]))
}

leaks := {p |
	walk(fixture, [path, v])
	is_string(v)
	contains(v, fake)
	p := pointer(path)
	not masked(p)
}

test_fake_key_is_under_a_masked_pointer_everywhere if count(leaks) == 0

test_pointer_helper_sees_the_nested_leaf if {
	pointer(["attributes", "request", "http", "body"]) == "/input/attributes/request/http/body"
}

test_mask_still_keeps_caller_identity_and_target if {
	not masked("/input/attributes/source/principal")
	not masked("/input/attributes/contextExtensions/target")
	not masked("/input/attributes/request/http/path")
}
