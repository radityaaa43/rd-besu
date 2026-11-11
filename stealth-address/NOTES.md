# Stealth-address notes

## Memo encryption is not part of EIP-5564

The stealth address derivation follows EIP-5564 (secp256k1 ECDH, view tag). The encrypted memo does not: it is an application extension
(`ts/memo.ts:6-9,41-42`). The key is `keccak256("RD-memo-v1" || ECDH point)`, the cipher is AES-256-GCM, and the nonce is deterministic:
the first 12 bytes of `keccak256("RD-memo-nonce" || ephemeralPubKey)`. EIP-5564 does not standardize any of this, so a standard EIP-5564
scanner cannot decode these memos. A different key schedule (HKDF) or a standard scheme (ECIES) would be a cryptographic change and needs a
review before anyone makes it; it is not planned here.
