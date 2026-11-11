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
| own RPC URL + JWT | the party's own Besu RPC node; the node's RS256 private key file from Secret `stealth-rpc-jwt` (`private.pem`, env `RPC_JWT_KEY_FILE`); the signer mints a token per request (permissions `eth|net|web3`, `exp` <= now+900, reused until 60 s before expiry, `src/rpcToken.ts`) | PLAN:72, ARCH:180 |
| `certUrl` | custodian `/cert` base URL (mTLS), bank role only | PLAN:90 |
| keys | files `spendKey`, `viewKey`, `identityKey` of the S7 mount `stealth-keys`; read once at start, kept in memory | PLAN:81 |

Code boundary: `createSigner(cfg, deps)` takes `deps = { keys, chain: ChainPort, log, cert? }`. `ChainPort` is the only RPC surface (announcements, balanceOf, nonce, gasPrice, estimateGas, now, sendRawTransaction). Production adapts ethers `JsonRpcProvider` (`ts/chain.ts:11`); tests use an in-memory fake.

## API
| Route | Who | Does |
|---|---|---|
| `POST /intent` | Lensa gateway | builds, signs, submits; kinds `rd-transfer`, `bond-transfer`, `dvp-leg` |
| `GET /holdings` | gateway | own stealth addresses with token and amounts: `scan()` result without private keys |
| `GET /history` | gateway | own received payments, newest last, with authenticated sender when the memo opens |
| `GET /meta-address` | gateway, operator | role bank: `{party, metaAddress, identityAddress}`: the meta-address derived from the spend + view keys (public) and the identity ACCOUNT address, the ERC-6538 registry key (`registerKeys` stores under `msg.sender`, `ERC6538Registry.sol:36-38`); never a key; role custodian: 403 `role_forbidden` (S9 proof, PLAN S9 RED) |
| `POST /intent` kinds `rd-mint`, `bond-issue` | gateway (role bi only; bank role 403 `role_forbidden`) | S10: signed by the ISSUER account: `RupiahDigital.mintStealth(receiver, amount, ephPub, viewTag, memo)` / `DfabiBond.issueByPartitionStealth(partition (default TRANCHE_A), receiver, value, ephPub, viewTag, memo)`; no holding spent, no certificate (the minter is exempt); `from` must be the party id `BI` |
| `GET /ledger?kind=rd\|bond` | gateway (role bi only) | S10 DELTA 3: `{kind, rows: [{bank, amount, sender, tx}]}` from the per-bank VIEW-key copies (`viewcopies/<id>.viewKey` + `.metaAddress`), never a spend key; sender null when the memo does not open |
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

## Decisions (analyst verdict on the S8 questions, 2026-11-11; AFTER ARCHITECTURE-stealth :123, :137, :150-161, :181-182)
1. The custodian reads nonce (`usedCertificateNonce`) and domain separator (`generateDomainSeparator`) from the chain, never from the request; extra request fields are ignored (test).
2. ABIs inline, pinned by test (no `forge build` in the image).
3. Pool/`sent`/`escrowed` records: scan-based, none persisted. **GATE: refund tracking for DvP escrows (src/DvPEscrow.sol:124-142) must exist before S17.**
4. Holdings list every scan match including balance 0 (test).
5. One covering holding per intent, no aggregation (it would link addresses on chain); none covers -> 422 `insufficient_holdings` (recorded limit, test).
6. mTLS client = stdlib `node:https` with key/cert/ca behind the injectable fetch port (`src/mtls.ts`, test with a local https server requiring a client cert); no undici.
7. `/cert` on role custodian cannot enforce "which bank owns which stealth address" (unknowable). Rules instead: (a) the mTLS client cert must be a registered bank signer else 403 `not_registered_signer`, and requester, sender, token, selector are logged; (b) token must equal the bond else 422 `bad_token`; (c) expiry <= chain now + 600 else 422 `bad_expiry`; (d) payload selector allowlist: `transferByPartitionStealth`, or `transferByPartition` to an escrow created by OUR DvPFactory, else 422 `selector_not_allowed` (no rubber stamp). Banks never hold the cert key; role `bank` gets 403 `role_forbidden` on `/cert` until S12.
8. Cert expiry 600 s and gas price 0 as Lensa. **Order: `estimateGas` only AFTER the real certificate is inserted** (the 97-byte placeholder reverts; test).
Gaps closed: `/intent` returns `{kind, from, txHash, rawTx}`; `from` = party id; the signer picks the stealth address.

## Role `bi` (S10; analyst Q12 aligned)
KEYS_DIR files: `issuerKey` (copy of `deployerKey`), `spendKey` + `viewKey` (BI's own receive keys; its identity account is the issuer key, as in the Lensa adapter), `viewcopies/<id>.viewKey` + `<id>.metaAddress` per bank (S11 fills them; a view key that does not match its meta-address is refused at load, `ts/stealth.ts:74`). Holdings, history and meta-address work as for a bank with the own receive keys. **No route signs a certificate or a controller op with the issuer key**: `/cert` is custodian-only (the deployerKey copy is still certificate signer, owner and controller until S12), and bank signers cannot mint or issue.

## Placement (binding)
One signer PER PARTY namespace holding only that party's spend + view keys. The BI signer holds the issuer key + view-key copies, never spend keys. The CERT signer is a separate key (`certKey`) and role (`custodian`) in the custodian namespace (default BI; a different user pick changes only a config name). A single signer holding all banks' spend keys is forbidden (DELTA 1). Accepted limit: the spend key sits raw in process memory (Vault protects at rest only, AFTER :137 hard limit 6).

## Open questions
1. Which party is the custodian (DELTA 4): default BI, the user picks.
2. Registered bank signer list: source and rotation (S12).
