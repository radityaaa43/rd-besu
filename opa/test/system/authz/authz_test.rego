package system.authz_test

import data.system.authz

test_health_open if authz.allow with input as {"method": "GET", "path": ["health"]}

test_data_api_closed if not authz.allow with input as {"method": "GET", "path": ["v1", "data"]}

test_policy_upload_closed if not authz.allow with input as {"method": "PUT", "path": ["v1", "policies", "x"]}
