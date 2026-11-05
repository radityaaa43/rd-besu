# Checks on a draft of a bank document (data.bank.config), run by the Lensa server with `opa eval` before
# the draft can be submitted for approval. Messages are shown to users as they are.
# BI's values are read as data (data.bi.config); this bundle never calls a function of the BI bundle, so it
# builds alone. The small helpers below are copies of those in bi.check.
package bank.check

import data.bank.ident

tokens := ["RD", "DFABI"]

max_amount := 1000000000000000

time_re := `^([01][0-9]|2[0-3]):[0-5][0-9]$`

pos_int(v) if {
	is_number(v)
	v > 0
	v == floor(v)
}

valid_time(t) if {
	is_string(t)
	regex.match(time_re, t)
}

# Amounts: optional, an absent token follows BI.
amounts[name] := v if {
	some t in tokens
	some spec in [
		{"key": "max_per_tx", "label": "Limit per transaksi"},
		{"key": "daily_limit", "label": "Limit harian"},
	]
	name := $"{spec.label} {t}"
	v := data.bank.config[spec.key][t]
}

# Hours: optional (absent follows BI); present, they need days, open and close, as in bi.check.
bank_hours[t] := h if {
	some t in tokens
	h := data.bank.config.hours[t]
}

valid_days(h) if {
	days := object.get(h, "days", null)
	is_array(days)
	count(days) > 0
	every d in days {
		is_number(d)
		d == floor(d)
		d >= 1
		d <= 7
	}
}

valid_open(h) if valid_time(object.get(h, "open", null))

valid_close(h) if valid_time(object.get(h, "close", null))

valid_close(h) if h.close == "24:00"

well_formed(h) if {
	valid_days(h)
	valid_open(h)
	valid_close(h)
	h.open < h.close
}

# Both windows apply at runtime, so the bank's must lie inside BI's: days, open and close.
inside(h, bi) if {
	every d in h.days {
		d in bi.days
	}
	h.open >= bi.open
	h.close <= bi.close
}

errors contains "Counterparty: harus berupa daftar" if {
	not is_array(object.get(data.bank.config, "counterparties", null))
}

errors contains $"Counterparty: {id} bukan peserta" if {
	some id in data.bank.config.counterparties
	not ident.participant(id)
}

errors contains $"{name}: harus bilangan bulat positif" if {
	some name, v in amounts
	not pos_int(v)
}

errors contains $"{name}: melebihi 1.000.000.000.000.000" if {
	some name, v in amounts
	pos_int(v)
	v > max_amount
}

errors contains $"Limit per transaksi {t}: tidak boleh lebih longgar dari batas BI" if {
	some t in tokens
	v := data.bank.config.max_per_tx[t]
	pos_int(v)
	v > data.bi.config.zeto.max_per_tx[t]
}

errors contains $"Jam {t}: hari harus 1 (Senin) sampai 7 (Minggu)" if {
	some t, h in bank_hours
	not valid_days(h)
}

errors contains $"Jam {t}: format harus JJ:MM" if {
	some t, h in bank_hours
	not valid_open(h)
}

errors contains $"Jam {t}: format harus JJ:MM" if {
	some t, h in bank_hours
	not valid_close(h)
}

errors contains $"Jam {t}: jam buka harus sebelum jam tutup" if {
	some t, h in bank_hours
	valid_open(h)
	valid_close(h)
	h.open >= h.close
}

errors contains $"Jam {t}: harus di dalam jam operasional BI" if {
	some t, h in bank_hours
	well_formed(h)
	not inside(h, data.bi.config.hours[t])
}
