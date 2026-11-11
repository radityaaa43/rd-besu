# stealth-signer: SPEC (PLAN step S8)

Sources: PLAN = `final-design/stealth/PLAN.md` ("### S8" line 87-95, "### S7" line 77-85); ARCH = `agents/analyst/design/ARCHITECTURE-stealth.md`; `ts/` = `stealth-address/ts/`.

## Purpose
One HTTP service per party (bank, later BI). It holds that party's spend, view and identity keys in memory, turns an unsigned intent into a signed raw transaction, submits it to the party's own RPC node, and scans `Announcement` logs with the party's own view key. Lensa sends public data only (meta-address, amount), never a key (PLAN:90).

## AFTER row served
- DELTA 1: "Bank client signs and submits; Lensa builds unsigned intents" (PLAN:88; ARCH:103-104, 184).
- DELTA 2: "Bank scanner with own viewing key" (PLAN:88; ARCH:181: reads `Announcement` logs from own RPC, view tag first).
- DELTA 4: bank cert request (sender, payload, expiry) to the custodian (PLAN:88; ARCH:104, 182).

## Per-party config (`SignerConfig`, `src/types.ts`)
| Field | Meaning | Source |
|---|---|---|
| `party` | the one party served ("A"); an intent with another `from` is refused | PLAN:90 |
| `role` | `bank` or `custodian`; `/cert` answers only for `custodian` | PLAN:90 |
| `chainId`, `rd`, `bond`, `fromBlock` | chain constants; scan start block (Besu caps `eth_getLogs` at 1000 blocks) | `ts/chain.ts:15,90-104` |
| own RPC URL + JWT | the party's own Besu RPC node, read-only token from Secret `stealth-rpc-jwt`; file path in the deployment config (S9) | PLAN:72, ARCH:180 |
| `certUrl` | custodian `/cert` base URL (mTLS), bank role only | PLAN:90 |
| keys | files `spendKey`, `viewKey`, `identityKey` of the S7 mount `stealth-keys`; read once at start, kept in memory | PLAN:81 |

Code boundary: `createSigner(cfg, deps)` takes `deps = { keys, chain: ChainPort, log, cert? }`. `ChainPort` is the only RPC surface (announcements, balanceOf, nonce, gasPrice, estimateGas, now, sendRawTransaction). Production adapts ethers `JsonRpcProvider` (`ts/chain.ts:11`); tests use an in-memory fake.

## API
| Route | Who | Does |
|---|---|---|
| `POST /intent` | Lensa gateway | builds, signs, submits; kinds `rd-transfer`, `bond-transfer`, `dvp-leg` |
| `GET /holdings` | gateway | own stealth addresses with token and amounts: `scan()` result without private keys |
| `GET /history` | gateway | own received payments, newest last, with authenticated sender when the memo opens |
| `POST /cert` | other banks' signers, role `custodian` only | custodian signs a certificate (enabled by S12; S8 ships the route returning 403 `role_forbidden` for role `bank`) |
| `GET /health` | kubelet | 200 `{"ok":true}`; no key, no chain call |

### Intent handling (all kinds)
1. Validate JSON, `kind`, `from === cfg.party`, `amount`.
2. `scan(announcements, viewKey, spendKey)` (`ts/stealth.ts:58`); pick the first holding whose on-chain balance is at least `amount` (one address, one transfer, as in `frontend@28c8bdb:server/src/adapters/stealth.ts:405-411`).
3. Derive the receiver address and memo with `pay()` using `identityKey` as sender key (`ts/chain.ts:107-112`).
4. Encode calldata, sign with the stealth private key (`(spendKey + h) mod n`, `ts/stealth.ts:62`), legacy tx with chain gas price (0 on this chain, `docs/architecture-brief.md:103`), submit `eth_sendRawTransaction`. Besu has no `eth_sendTransaction` (PLAN:95).
5. Bond calls need a certificate (`ts/bond.ts:38-48`): encode with a 97-byte placeholder, take `payloadWithoutCertificate`, call the custodian with (sender = stealth address, token, payload, expiry = chain now + 600 s, `ts/chain.ts:82`), put the returned certificate as the LAST argument.

| kind | Extra fields | Chain call from the stealth address |
|---|---|---|
| `rd-transfer` | `to.metaAddress` | `RupiahDigital.sendStealth(receiver, amount, ephPub, viewTag, memo)` (`src/RupiahDigital.sol:52`), no cert |
| `bond-transfer` | `to.metaAddress`, optional `partition` (default TRANCHE-A) | `DfabiBond.transferByPartitionStealth(partition, receiver, amount, ephPub, viewTag, memo, cert)` (`src/DfabiBond.sol:51`) |
| `dvp-leg` | `leg` = `bond` or `rd`, `escrow` address | bond: `DfabiBond.transferByPartition(TRANCHE-A, escrow, amount, cert)`; rd: `RupiahDigital.transfer(escrow, amount)` (funding calls, `frontend@28c8bdb:server/src/adapters/stealth.ts:382-386`); escrow creation stays with the custodian (`src/DvPFactory.sol:30`) |

### Schemas
`POST /intent` request: `{ "kind": "rd-transfer", "from": "A", "to": { "metaAddress": "0x<66 bytes hex>" }, "amount": "100" }`. `amount` is a decimal string, whole units (RD decimals 0, `src/RupiahDigital.sol:29`).
Response 200: `{ "kind": "rd-transfer", "from": "0x<stealth address>", "txHash": "0x..", "rawTx": "0x.." }`.

`GET /holdings` 200: `{ "party": "A", "holdings": [ { "stealthAddress": "0x..", "token": "0x..", "amount": "500", "partition": null } ] }`. `amount` = on-chain balance now; `partition` set for bond holdings. Order = announcement order, as `scan()`.

`GET /history` 200: `{ "party": "A", "history": [ { "txHash": "0x..", "blockNumber": 1, "stealthAddress": "0x..", "token": "0x..", "amount": "500", "sender": "0x.." } ] }`. `sender` is null when the memo does not open (`ts/chain.ts:115-119`).

`POST /cert` request (what the bank client sends): `{ "sender": "0x<stealth address>", "token": "0x<bond>", "payload": "0x..", "expiry": "1800000600" }`. Response 200: `{ "certificate": "0x<97 bytes>" }` (`ts/bond.ts:70-74`). `expiry` and later `nonce` are decimal strings. Transport is mTLS (PLAN:90); the client takes an injectable `fetch` so the caller supplies the mTLS agent.

### Errors
Body: `{ "error": "<code>", "message": "<text without key material>" }`.
| Status | Code | When |
|---|---|---|
| 400 | `bad_json` | body is not JSON |
| 403 | `wrong_party` | `from` is not `cfg.party` |
| 403 | `role_forbidden` | `/cert` on role `bank` |
| 404 | `not_found` | unknown route |
| 422 | `unknown_kind` | kind not in the table |
| 422 | `bad_amount` | not a decimal string of an integer in 1..2^256-1 (`ts/token.ts:15` range) |
| 422 | `bad_meta_address` | `deriveStealth` throws (`ts/stealth.ts:28`) |
| 422 | `insufficient_holdings` | no single holding covers `amount` |
| 502 | `cert_unavailable` | custodian refused or unreachable; nothing is sent |
| 502 | `rpc_error` | own RPC failed |

## Security rules
- Keys live only in process memory after start. No route, error message, log line or console output contains a key value, including stealth private keys from `scan()` (proof (4)).
- Logs carry route, kind, status, tx hash only. Logging goes through `deps.log`, never `console`.
- An intent for another party is refused before any scan, signature or cert call.
- Holdings and history never include `privateKey`.

## Out of scope for S8
- S7 key store and NetworkPolicy; S9 deployment, manifests, key move; image build; S12 custodian `/cert` signing body; S17 live cert call; S21 Lensa cutover.
- Production wiring (process entrypoint, key-file loader, ethers `ChainPort` adapter).
- The persisted pool and `sent`/`escrowed` records (PLAN:90): no RED proof covers them, see open question 3.

## RED tests (`signer/test/`)
`signer.test.ts` proofs (1)-(4) plus the error codes `wrong_party`, `unknown_kind`, `bad_amount`; `cert.test.ts` proof (5). Stubs in `signer/src/` throw `not implemented`. `npx vitest run signer` fails now; `tsc --noEmit` is clean.

## Open questions
1. Does the `/cert` request carry `token`? PLAN:90 lists (sender, payload, expiry); the digest also includes the token (`ts/bond.ts:66`) and the payload does not name it. SPEC includes `token`; tests only require the three PLAN fields.
2. ABI source: `ts/chain.ts:24` reads `out/` (needs `forge build`); the signer image may inline human-readable ABIs instead. Tests inline them.
3. What does "pool" mean for a scan-based signer? `scan()` already finds every holding; `used` flags and `sent`/`escrowed` records (`frontend@28c8bdb:server/src/adapters/stealth.ts:195-198`) need a store format and volume path.
4. Holdings of spent addresses (balance 0): listed or hidden? SPEC lists every scan match with its current balance.
5. Multi-input spends: SPEC picks one holding that covers the amount; no aggregation.
6. mTLS client in Node: `fetch` with a client certificate needs an `undici` dispatcher (not a direct dependency). Allowed to add?
7. Custodian `/cert` request authentication beyond mTLS (which bank may ask for which sender)? Not in PLAN or ARCH.
8. Cert expiry default 600 s and gas limit source (`estimateGas` plus margin?) are copied from Lensa; confirm.
