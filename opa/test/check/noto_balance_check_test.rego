# Validation of BI's Noto balance controls (bundles/bi/bi/check/noto_balance.rego); helpers are check_test.rego's.
package check_test

test_noto_controls_absent_valid if count(bi_errors({})) == 0

test_noto_controls_valid if count(bi_errors({"noto": {
	"max_balance": {"RD": 1000, "DFABI": 50},
	"min_balance": {"RD": 10},
	"max_supply": {"RD": 1000000000000000},
}})) == 0

test_noto_controls_not_positive_integer if {
	bi_errors({"noto": {"max_balance": {"RD": 0}}}) == {"Saldo maksimal RD: harus bilangan bulat positif"}
	bi_errors({"noto": {"min_balance": {"DFABI": -1}}}) == {"Saldo minimal DFABI: harus bilangan bulat positif"}
	bi_errors({"noto": {"max_supply": {"RD": 1.5}}}) == {"Suplai maksimal RD: harus bilangan bulat positif"}
	bi_errors({"noto": {"max_supply": {"DFABI": "9"}}}) == {"Suplai maksimal DFABI: harus bilangan bulat positif"}
}

test_noto_controls_too_large if bi_errors({"noto": {"max_balance": {"RD": 1000000000000001}}}) == {"Saldo maksimal RD: melebihi 1.000.000.000.000.000"}

test_noto_min_not_below_max if {
	bi_errors({"noto": {"min_balance": {"RD": 100}, "max_balance": {"RD": 100}}}) == {"Saldo minimal RD: harus lebih kecil dari saldo maksimal"}
	bi_errors({"noto": {"min_balance": {"RD": 101}, "max_balance": {"RD": 100}}}) == {"Saldo minimal RD: harus lebih kecil dari saldo maksimal"}
	count(bi_errors({"noto": {"min_balance": {"RD": 99}, "max_balance": {"RD": 100}}})) == 0
	count(bi_errors({"noto": {"min_balance": {"RD": 500}, "max_balance": {"DFABI": 100}}})) == 0
}
