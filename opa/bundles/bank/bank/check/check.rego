# Checks on a draft of a bank's documents (data.bank.config.policy.zeto and .noto, one per platform), run by the Lensa
# server with `opa eval` before the draft can be submitted for approval. Messages are shown to users as they are, and
# do not name the platform (the server composes the config so that only the draft can fail).
# Each document is compared with BI's document of the same platform. BI's values are read as data (data.bi.config); this bundle never calls a function of the BI bundle, so it
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

# Both platforms need a document (a missing one denies everything on that platform at runtime).
errors contains $"Kebijakan {p}: dokumen tidak ada" if {
	some p in ["zeto", "noto"]
	not data.bank.config.policy[p]
}

# Amounts: optional, an absent token follows BI. Keyed by [platform, name].
amounts[[p, name]] := v if {
	some p, doc in data.bank.config.policy
	some t in tokens
	some spec in [
		{"key": "max_per_tx", "label": "Limit per transaksi"},
		{"key": "daily_limit", "label": "Limit harian"},
	]
	name := $"{spec.label} {t}"
	v := doc[spec.key][t]
}

# Hours: optional (absent follows BI); present, they need days, open and close, as in bi.check.
bank_hours[[p, t]] := h if {
	some p, doc in data.bank.config.policy
	some t in tokens
	h := doc.hours[t]
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
	some _, doc in data.bank.config.policy
	not is_array(object.get(doc, "counterparties", null))
}

errors contains $"Counterparty: {id} bukan peserta" if {
	some _, doc in data.bank.config.policy
	some id in doc.counterparties
	not ident.participant(id)
}

errors contains $"{name}: harus bilangan bulat positif" if {
	some k, v in amounts
	name := k[1]
	not pos_int(v)
}

errors contains $"{name}: melebihi 1.000.000.000.000.000" if {
	some k, v in amounts
	name := k[1]
	pos_int(v)
	v > max_amount
}

errors contains $"Limit per transaksi {t}: tidak boleh lebih longgar dari batas BI" if {
	some p, doc in data.bank.config.policy
	some t in tokens
	v := doc.max_per_tx[t]
	pos_int(v)
	v > data.bi.config.policy[p].max_per_tx[t]
}

errors contains $"Jam {t}: hari harus 1 (Senin) sampai 7 (Minggu)" if {
	some k, h in bank_hours
	t := k[1]
	not valid_days(h)
}

errors contains $"Jam {t}: format harus JJ:MM" if {
	some k, h in bank_hours
	t := k[1]
	not valid_open(h)
}

errors contains $"Jam {t}: format harus JJ:MM" if {
	some k, h in bank_hours
	t := k[1]
	not valid_close(h)
}

errors contains $"Jam {t}: jam buka harus sebelum jam tutup" if {
	some k, h in bank_hours
	t := k[1]
	valid_open(h)
	valid_close(h)
	h.open >= h.close
}

errors contains $"Jam {t}: harus di dalam jam operasional BI" if {
	some k, h in bank_hours
	t := k[1]
	well_formed(h)
	not inside(h, data.bi.config.policy[k[0]].hours[t])
}
