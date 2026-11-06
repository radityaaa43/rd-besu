package check_test

import data.bank.check as bank_check
import data.bi.check as bi_check
import data.fixtures

# The helpers patch the Zeto document; the Noto ones (bi_errors_noto, bank_errors_noto) patch the Noto document and leave
# the Zeto one valid, the way the Lensa server composes a draft of one platform with the current document of the other.
bi_errors(patch) := e if {
	e := bi_check.errors with data.bi.config as fixtures.bi_with("zeto", patch)
}

bi_errors_noto(patch) := e if {
	e := bi_check.errors with data.bi.config as fixtures.bi_with("noto", patch)
}

# paths are relative to the Zeto document
bi_errors_without(paths) := e if {
	e := bi_check.errors with data.bi.config as json.remove(fixtures.bi, [concat("/", ["policy/zeto", x]) | some x in paths])
}

bank_errors(patch) := e if {
	e := bank_check.errors with data.bank.config as fixtures.bank_with("zeto", patch)
		with data.bi.config as fixtures.bi
}

bank_errors_noto(patch) := e if {
	e := bank_check.errors with data.bank.config as fixtures.bank_with("noto", patch)
		with data.bi.config as fixtures.bi
}

bank_errors_with_bi(patch, bi_patch) := e if {
	e := bank_check.errors with data.bank.config as fixtures.bank_with("zeto", patch)
		with data.bi.config as fixtures.bi_with("zeto", bi_patch)
}

test_seed_documents_valid if {
	count(bi_check.errors) == 0 with data.bi.config as fixtures.bi
	count(bank_check.errors) == 0 with data.bank.config as fixtures.bank_a
		with data.bi.config as fixtures.bi
}

# BI document

test_bi_amount_not_positive_integer if {
	bi_errors({"max_per_tx": {"RD": 0}}) == {"Limit per transaksi RD: harus bilangan bulat positif"}
	bi_errors({"max_per_tx": {"DFABI": -5}}) == {"Limit per transaksi DFABI: harus bilangan bulat positif"}
	bi_errors({"max_per_tx": {"RD": 1.5}}) == {"Limit per transaksi RD: harus bilangan bulat positif"}
	bi_errors({"max_per_tx": {"RD": "100"}}) == {"Limit per transaksi RD: harus bilangan bulat positif"}
	bi_errors({"max_mint_per_tx": {"DFABI": 0}}) == {"Limit penerbitan DFABI: harus bilangan bulat positif"}
}

test_bi_amount_missing if {
	bi_errors_without(["max_mint_per_tx/RD"]) == {"Limit penerbitan RD: harus bilangan bulat positif"}
	bi_errors_without(["max_per_tx"]) == {
		"Limit per transaksi RD: harus bilangan bulat positif",
		"Limit per transaksi DFABI: harus bilangan bulat positif",
	}
}

test_bi_amount_too_large if {
	bi_errors({"max_per_tx": {"RD": 1000000000000001}}) == {"Limit per transaksi RD: melebihi 1.000.000.000.000.000"}
	bi_errors({"max_mint_per_tx": {"RD": 1000000000000001}}) == {"Limit penerbitan RD: melebihi 1.000.000.000.000.000"}
	count(bi_errors({"max_per_tx": {"RD": 1000000000000000}})) == 0
}

test_bi_hours_format if {
	bi_errors({"hours": {"RD": {"open": "9:00"}}}) == {"Jam RD: format harus JJ:MM"}
	bi_errors({"hours": {"RD": {"open": "24:00"}}}) == {"Jam RD: format harus JJ:MM"}
	bi_errors({"hours": {"DFABI": {"close": "12:60"}}}) == {"Jam DFABI: format harus JJ:MM"}
	bi_errors({"hours": {"DFABI": {"close": "25:00"}}}) == {"Jam DFABI: format harus JJ:MM"}
	bi_errors({"hours": {"DFABI": {"open": 900}}}) == {"Jam DFABI: format harus JJ:MM"}
	count(bi_errors({"hours": {"DFABI": {"open": "00:00", "close": "24:00"}}})) == 0
	count(bi_errors({"hours": {"DFABI": {"open": "23:59", "close": "24:00"}}})) == 0
}

test_bi_hours_open_before_close if {
	bi_errors({"hours": {"RD": {"open": "18:00", "close": "06:00"}}}) == {"Jam RD: jam buka harus sebelum jam tutup"}
	bi_errors({"hours": {"RD": {"open": "08:00", "close": "08:00"}}}) == {"Jam RD: jam buka harus sebelum jam tutup"}
}

test_bi_hours_days if {
	bi_errors({"hours": {"RD": {"days": [0, 1]}}}) == {"Jam RD: hari harus 1 (Senin) sampai 7 (Minggu)"}
	bi_errors({"hours": {"RD": {"days": [8]}}}) == {"Jam RD: hari harus 1 (Senin) sampai 7 (Minggu)"}
	bi_errors({"hours": {"RD": {"days": []}}}) == {"Jam RD: hari harus 1 (Senin) sampai 7 (Minggu)"}
	bi_errors({"hours": {"RD": {"days": ["1"]}}}) == {"Jam RD: hari harus 1 (Senin) sampai 7 (Minggu)"}
	bi_errors({"hours": {"RD": {"days": [1.5]}}}) == {"Jam RD: hari harus 1 (Senin) sampai 7 (Minggu)"}
}

# An hours object missing a part is closed at runtime, so the draft must be rejected.
test_bi_hours_missing_parts if {
	bi_errors_without(["hours/RD/days"]) == {"Jam RD: hari harus 1 (Senin) sampai 7 (Minggu)"}
	bi_errors_without(["hours/RD/open"]) == {"Jam RD: format harus JJ:MM"}
	bi_errors_without(["hours/DFABI/close"]) == {"Jam DFABI: format harus JJ:MM"}
	bi_errors_without(["hours/DFABI"]) == {
		"Jam DFABI: hari harus 1 (Senin) sampai 7 (Minggu)",
		"Jam DFABI: format harus JJ:MM",
	}
}

test_bi_holiday_date_invalid if {
	bi_errors({"holidays": [{"date": "2026-02-30", "name": "x"}]}) == {"Hari libur 2026-02-30: tanggal tidak valid"}
	bi_errors({"holidays": [{"date": "2026-2-3", "name": "x"}]}) == {"Hari libur 2026-2-3: tanggal tidak valid"}
	bi_errors({"holidays": [{"date": "25-12-2026", "name": "x"}]}) == {"Hari libur 25-12-2026: tanggal tidak valid"}
	bi_errors({"holidays": [{"name": "x"}]}) == {"Hari libur : tanggal tidak valid"}
	count(bi_errors({"holidays": [{"date": "2028-02-29", "name": "kabisat"}]})) == 0
}

test_bi_holiday_duplicate if {
	bi_errors({"holidays": [
		{"date": "2026-12-25", "name": "Natal"},
		{"date": "2026-12-25", "name": "Natal lagi"},
	]}) == {"Hari libur 2026-12-25: tercatat dua kali"}
}

test_bi_holidays_not_list if {
	bi_errors({"holidays": {}}) == {"Hari libur: harus berupa daftar"}
	bi_errors_without(["holidays"]) == {"Hari libur: harus berupa daftar"}
}

test_bi_frozen_not_participant if {
	bi_errors({"frozen": ["bankZ@node9"]}) == {"Pembekuan: bankZ@node9 bukan peserta"}
	count(bi_errors({"frozen": ["bankC@node4"]})) == 0
}

test_bi_frozen_self if {
	bi_errors({"frozen": ["bi@node1"]}) == {"Pembekuan: BI tidak dapat membekukan dirinya sendiri"}
}

test_bi_frozen_missing_or_not_list if {
	bi_errors_without(["frozen"]) == {"Pembekuan: harus berupa daftar"}
	bi_errors({"frozen": "bankC@node4"}) == {"Pembekuan: harus berupa daftar"}
}

test_frozen_on_bi_node_is_self_freeze if {
	bi_errors({"frozen": ["ops@node1"]}) == {"Pembekuan: BI tidak dapat membekukan dirinya sendiri"}
}

# Bank document

test_bank_counterparty_not_participant if {
	bank_errors({"counterparties": ["bankB@node3", "bankZ@node9"]}) == {"Counterparty: bankZ@node9 bukan peserta"}
}

test_counterparty_unknown_node_error if {
	bank_errors({"counterparties": ["eve@node9"]}) == {"Counterparty: eve@node9 bukan peserta"}
	bank_errors({"counterparties": ["node3"]}) == {"Counterparty: node3 bukan peserta"}
	bank_errors({"counterparties": ["x@node3@node2"]}) == {"Counterparty: x@node3@node2 bukan peserta"}
}

test_bank_counterparties_missing if {
	bank_check.errors == {"Counterparty: harus berupa daftar"} with data.bank.config as {"policy": {"zeto": {}, "noto": fixtures.bank_doc, "fabricx": fixtures.bank_doc, "iroha3": fixtures.bank_doc}}
		with data.bi.config as fixtures.bi
}

test_bank_amounts if {
	bank_errors({"max_per_tx": {"RD": 0}}) == {"Limit per transaksi RD: harus bilangan bulat positif"}
	bank_errors({"daily_limit": {"DFABI": 2.5}}) == {"Limit harian DFABI: harus bilangan bulat positif"}
	bank_errors({"daily_limit": {"RD": 1000000000000001}}) == {"Limit harian RD: melebihi 1.000.000.000.000.000"}
	count(bank_errors({"daily_limit": {"RD": 5000000000}, "max_per_tx": {"DFABI": 1000}})) == 0
}

test_bank_per_tx_looser_than_bi if {
	bank_errors({"max_per_tx": {"RD": 1000000001}}) == {"Limit per transaksi RD: tidak boleh lebih longgar dari batas BI"}
	bank_errors({"max_per_tx": {"DFABI": 1001}}) == {"Limit per transaksi DFABI: tidak boleh lebih longgar dari batas BI"}
	count(bank_errors({"max_per_tx": {"RD": 1000000000}})) == 0
}

# A per-tx over the 10^15 bound is also looser than the BI cap, so both messages show.
test_bank_per_tx_too_large if {
	bank_errors({"max_per_tx": {"RD": 1000000000000001}}) == {
		"Limit per transaksi RD: melebihi 1.000.000.000.000.000",
		"Limit per transaksi RD: tidak boleh lebih longgar dari batas BI",
	}
}

test_bank_hours_format_and_order if {
	bank_errors({"hours": {"RD": {"days": [1], "open": "9:00", "close": "17:00"}}}) == {"Jam RD: format harus JJ:MM"}
	bank_errors({"hours": {"RD": {"days": [1], "open": "17:00", "close": "09:00"}}}) == {"Jam RD: jam buka harus sebelum jam tutup"}
	bank_errors({"hours": {"RD": {"days": [8], "open": "09:00", "close": "17:00"}}}) == {"Jam RD: hari harus 1 (Senin) sampai 7 (Minggu)"}
	bank_errors({"hours": {"RD": {"open": "09:00", "close": "17:00"}}}) == {"Jam RD: hari harus 1 (Senin) sampai 7 (Minggu)"}
}

test_bank_hours_inside_bi if {
	bi_hours := {"hours": {"RD": {"days": [1, 2, 3, 4, 5], "open": "06:00", "close": "18:00"}}}
	count(bank_errors_with_bi({"hours": {"RD": {"days": [1, 2], "open": "06:00", "close": "18:00"}}}, bi_hours)) == 0
	bank_errors_with_bi({"hours": {"RD": {"days": [1, 6], "open": "08:00", "close": "17:00"}}}, bi_hours) == {"Jam RD: harus di dalam jam operasional BI"}
	bank_errors_with_bi({"hours": {"RD": {"days": [1], "open": "05:59", "close": "17:00"}}}, bi_hours) == {"Jam RD: harus di dalam jam operasional BI"}
	bank_errors_with_bi({"hours": {"RD": {"days": [1], "open": "08:00", "close": "18:01"}}}, bi_hours) == {"Jam RD: harus di dalam jam operasional BI"}
}

test_bank_hours_full_day_default_bi if {
	count(bank_errors({"hours": {"DFABI": {"days": [1, 7], "open": "00:00", "close": "24:00"}}})) == 0
}

# Per platform: every document is checked, a missing one is an error, and a bank document is compared with BI's document
# of the same platform.

test_bi_checks_every_platform if {
	bi_errors({"max_per_tx": {"RD": 0}}) == {"Limit per transaksi RD: harus bilangan bulat positif"}
	bi_errors_noto({"max_per_tx": {"RD": 0}}) == {"Limit per transaksi RD: harus bilangan bulat positif"}
	bi_errors_noto({"frozen": ["bankZ@node9"]}) == {"Pembekuan: bankZ@node9 bukan peserta"}
	bi_errors_noto({"hours": {"RD": {"open": "9:00"}}}) == {"Jam RD: format harus JJ:MM"}
	bi_errors_noto({"holidays": [{"date": "2026-02-30", "name": "x"}]}) == {"Hari libur 2026-02-30: tanggal tidak valid"}
}

test_bi_missing_platform_document if {
	bi_check.errors == {"Kebijakan noto: dokumen tidak ada"} with data.bi.config as json.remove(fixtures.bi, ["policy/noto"])
	bi_check.errors == {"Kebijakan zeto: dokumen tidak ada"} with data.bi.config as json.remove(fixtures.bi, ["policy/zeto"])
}

test_bank_checks_every_platform if {
	bank_errors_noto({"counterparties": ["bankZ@node9"]}) == {"Counterparty: bankZ@node9 bukan peserta"}
	bank_errors_noto({"daily_limit": {"RD": 0}}) == {"Limit harian RD: harus bilangan bulat positif"}
	bank_errors_noto({"hours": {"RD": {"days": [1], "open": "9:00", "close": "17:00"}}}) == {"Jam RD: format harus JJ:MM"}
}

test_bank_missing_platform_document if {
	bank_check.errors == {"Kebijakan noto: dokumen tidak ada"} with data.bank.config as json.remove(fixtures.bank_a, ["policy/noto"])
		with data.bi.config as fixtures.bi
}

# The bank's Noto document is compared with BI's Noto document, not the Zeto one.
test_bank_compares_with_same_platform if {
	bi := fixtures.bi_with("noto", {"max_per_tx": {"RD": 500}, "hours": {"RD": {"days": [1], "open": "06:00", "close": "18:00"}}})
	bank_check.errors == {"Limit per transaksi RD: tidak boleh lebih longgar dari batas BI"} with data.bank.config as fixtures.bank_with("noto", {"max_per_tx": {"RD": 501}})
		with data.bi.config as bi
	bank_check.errors == {"Jam RD: harus di dalam jam operasional BI"} with data.bank.config as fixtures.bank_with("noto", {"hours": {"RD": {"days": [1, 2], "open": "08:00", "close": "17:00"}}})
		with data.bi.config as bi

	# the same values are fine for Zeto, where BI's cap is 1bn and hours are all day
	count(bank_check.errors) == 0 with data.bank.config as fixtures.bank_with("zeto", {"max_per_tx": {"RD": 501}, "hours": {"RD": {"days": [1, 2], "open": "08:00", "close": "17:00"}}})
		with data.bi.config as bi
}

# Every registered platform is validated like zeto and noto, and a missing document is named for each of them.
test_bi_missing_document_for_every_registered_platform if {
	bi_check.errors == {"Kebijakan fabricx: dokumen tidak ada"} with data.bi.config as json.remove(fixtures.bi, ["policy/fabricx"])
	bi_check.errors == {"Kebijakan iroha3: dokumen tidak ada"} with data.bi.config as json.remove(fixtures.bi, ["policy/iroha3"])
}

test_bank_missing_document_for_every_registered_platform if {
	bank_check.errors == {"Kebijakan fabricx: dokumen tidak ada"} with data.bank.config as json.remove(fixtures.bank_a, ["policy/fabricx"])
		with data.bi.config as fixtures.bi
	bank_check.errors == {"Kebijakan iroha3: dokumen tidak ada"} with data.bank.config as json.remove(fixtures.bank_a, ["policy/iroha3"])
		with data.bi.config as fixtures.bi
}

test_bi_and_bank_check_fabricx_and_iroha3_documents if {
	bi_check.errors == {"Limit per transaksi RD: harus bilangan bulat positif"} with data.bi.config as fixtures.bi_with("fabricx", {"max_per_tx": {"RD": 0}})
	bi_check.errors == {"Pembekuan: bankZ@node9 bukan peserta"} with data.bi.config as fixtures.bi_with("iroha3", {"frozen": ["bankZ@node9"]})
	bank_check.errors == {"Counterparty: bankZ@node9 bukan peserta"} with data.bank.config as fixtures.bank_with("fabricx", {"counterparties": ["bankZ@node9"]})
		with data.bi.config as fixtures.bi
	bank_check.errors == {"Limit harian RD: harus bilangan bulat positif"} with data.bank.config as fixtures.bank_with("iroha3", {"daily_limit": {"RD": 0}})
		with data.bi.config as fixtures.bi
}

# The list of platforms is data: a platform the registry adds later needs a document without any change to the rules.
test_registered_platforms_come_from_data if {
	bi_check.errors == {"Kebijakan baru: dokumen tidak ada"} with data.bi.config as object.union(fixtures.bi, {"platforms": ["zeto", "baru"]})
	bank_check.errors == {"Kebijakan baru: dokumen tidak ada"} with data.bank.config as fixtures.bank_a
		with data.bi.config as object.union(fixtures.bi, {"platforms": ["zeto", "baru"]})
	count(bi_check.errors) == 0 with data.bi.config as object.union(fixtures.bi, {"platforms": ["zeto"]})
}
