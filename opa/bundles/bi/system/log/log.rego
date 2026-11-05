# Decision-log mask: keep method, domain, function, from and to; drop amounts, recipients and the raw body.
package system.log

mask contains "/input/attributes/request/http/body"

mask contains "/input/attributes/request/http/headers/authorization"

mask contains "/input/parsed_body/params/0/data"
