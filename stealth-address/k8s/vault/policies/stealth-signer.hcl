# Vault policy `stealth-signer` (stealth S7): the signer reads its party's keys, nothing else. The operator writes them with its own token.
path "secret/data/stealth-keys" {
  capabilities = ["read"]
}
