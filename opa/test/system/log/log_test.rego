package system.log_test

import rego.v1

import data.system.log

test_mask_drops_both_body_forms if {
	"/input/attributes/request/http/body" in log.mask
	"/input/attributes/request/http/rawBody" in log.mask
}
