# Iroha 3 has no bank-specific rule yet. This package exists because gw requires both data.bi.platform.<target>.allow and
# data.bank.platform.<target>.allow for every platform target. All iroha3 rules are in bi.platform.iroha3.
package bank.platform.iroha3

default allow := true
