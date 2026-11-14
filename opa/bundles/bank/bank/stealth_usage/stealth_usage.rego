# Today's stealth outflow of this gateway's party (2026-11-14, daily limit): GET /outflow on its own signer, same namespace as the st-gw pod
# (http://stealth-signer:8080). A package of its own because bank.platform.stealth has a rule named `http`, which hides the http.send builtin there.
package bank.stealth_usage

# Today 00:00 WIB (UTC+7, no DST) as unix seconds. BI's clock is read as data.
day_start_s := (time.parse_ns("2006-01-02", data.bi.clock.today) - 25200000000000) / 1000000000

# Complete rule: one http.send per request. {RD, DFABI} decimal strings; undefined when the answer cannot be trusted (fails closed upstream).
today := resp.body if {
	resp := http.send({
		"method": "GET",
		"url": sprintf("http://stealth-signer:8080/outflow?since=%d", [day_start_s]),
		"timeout": "1500ms",
		"cache": false,
		"raise_error": false,
	})
	resp.status_code == 200
}
