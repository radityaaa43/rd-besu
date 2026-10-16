# DFABI bond token (ERC-1400 with ERC-5564 announcements) design

Date: 2026-10-15
Status: approved 2026-10-15; implemented, results in section 8
Part of: privacy-enabled RD + DFABI directly on Hyperledger Besu (no Paladin). Sub-project 3 of 4.
Depends on: stealth core (`2026-10-15-stealth-core-design.md`) and the RD token pattern (`2026-10-15-rd-stealth-token-design.md`).

## 1. Why

DFABI bonds must move between bank investors without other banks or nodes being able to link a recipient to a transfer. Sub-project 1 gave us the Announcer, Registry and key library; sub-project 2 showed the pattern for a token that announces its own stealth sends. This sub-project applies the same pattern to a bond token from the ERC-1400 family, so partitions (tranches), custodian control and documents come from a standard rather than from our own code.

Scope (same as sub-project 2): contract, library helper and a live Besu smoke. No backend, no DvP (sub-project 4), no replacement of the Noto bond the backends use today.

Threat model unchanged: other banks and nodes must not link a recipient to a transfer. Sender, amount, token and tranche stay public. The custodian may see recipients (it needs them for KYC and audit).

## 2. Decisions

| Topic | Decision |
|---|---|
| Base token | Consensys UniversalToken `ERC1400.sol`, vendored **unmodified** from commit `54320c6f7a8ee1fd7fcb19073e9c122e1e8f96f9` (2024-01-23, Apache-2.0) into `stealth/src/vendor/universal-token/`. User choice, 2026-10-15, over a minimal hand-written subset. |
| Known drawback of that choice | The repository is archived and its header says "This code has not been reviewed". It is a bond token: this must be said in the README of the vendor folder and again in section 7. |
| OpenZeppelin versions | The vendor code needs OZ 4 (`SafeMath`, `Ownable` without `initialOwner`). Our code stays on OZ 5.4.0. OZ 4.9.6 is installed as npm alias `oz4` (exact pin); a Foundry context remapping gives `src/vendor/` the OZ 4 tree and everything else the OZ 5.4 tree. |
| Validator | The vendored `ERC1400TokensValidator`, nonce-based certificate mode. No custom validator (this replaces the plan in the stealth-core decomposition). |
| ERC1820 | The vendored token registers itself in the ERC1820 registry at `0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24` in its constructor, so the registry must exist. Not present on the ACK Besu network (checked `eth_getCode`, 0 bytes, 2026-10-15). |
| Announcer, scheme | Same Announcer, scheme id `1`, immutable address in the constructor, as RD. |
| Tranches | ERC-1400 partitions. One `bytes32` per tranche. |
| Documents | ERC-1643 as inherited (`setDocument`, `getDocument`). Used for a prospectus hash, nothing else is added. |
| Not done | Backend, RTGS (DvP is built: 2026-10-16-dvp-design.md), coupon payment on chain, pause policy beyond what the validator offers, replacing the Noto bond, fixing anything in the vendor code. The list of which memo-signing identities are licensed banks (kept off chain by BI), and any on-chain check of the memo, are not built. Instrument data is built (section "Instrument data"); a legal-entity registry for the issuer LEI and per-instrument profiles beyond RD and DFABI are not. |

## 3. Spike evidence (2026-10-15, throwaway copy in the session scratchpad, nothing committed)

- `ERC1400.sol` and `ERC1400TokensValidator.sol` compile with solc from Foundry 1.7.1, `evm_version = shanghai`, optimizer 200 runs, against OZ 4.9.6. The other contracts of the repo (ERC721 tokens, mocks, certificate variants, `Migrations`) do not compile against 4.9.6 and are not vendored.
- Runtime sizes: `ERC1400` 17,181 B, `ERC1400TokensValidator` 21,125 B. The limit is 24,576 B. Headroom for our subclass is about 7 KB.
- Certificate rule read from source: the nonce-based certificate is 97 bytes (`expiry(32) | r(32) | s(32) | v(1)`). The signed hash is `keccak256(domainSeparator ++ keccak256(msgSender ++ token ++ payloadWithoutCertificate ++ expiry ++ usedNonce[token][msgSender]))`, signed raw (no `\x19Ethereum Signed Message` prefix), and `payloadWithoutCertificate` is the calldata minus its last **160** bytes (the 97-byte certificate padded to 128 plus the 32-byte length word). The certificate therefore has to be the **last** ABI argument of the called function, and it binds the recipient, amount and every other argument of that call.
- Only the ERC-20 selectors `transfer` and `transferFrom` skip certificate validation (`_functionSupportsCertificateValidation`). Every other selector, including our new ones, needs a certificate unless the caller is itself a certificate signer.

## 4. Contract `DfabiBond` (`stealth/src/DfabiBond.sol`)

`contract DfabiBond is ERC1400`. Constructor: `(string name, string symbol, address[] controllers, bytes32[] defaultPartitions, address announcer_)`; granularity fixed to `1`. `announcer` is immutable.

| Function | Who | Does |
|---|---|---|
| `issueByPartitionStealth(bytes32 partition, address stealthAddress, uint256 value, bytes ephemeralPubKey, bytes1 viewTag, bytes memo)` | minter (the custodian) | Issue to a stealth address and announce, one transaction. No certificate: a certificate signer is exempt in the validator. |
| `transferByPartitionStealth(bytes32 partition, address stealthAddress, uint256 value, bytes ephemeralPubKey, bytes1 viewTag, bytes memo, bytes data)` | any holder | Transfer from `msg.sender` and announce, one transaction. `data` is the custodian certificate and **must be the last parameter**. |

Everything else is inherited: `transferByPartition`, `redeemByPartition` (the holder redeems with a certificate), `operatorTransferByPartition`, controller forced transfer, `setDocument`, ERC-20 views. Inherited transfers do not announce (like a plain ERC-20 `transfer` for RD).

Both new functions call the parent's internal `_issueByPartition` / `_transferByPartition` (the same code the external functions use), then `announcer.announce(1, stealthAddress, ephemeralPubKey, metadata)`. Reverts: `InvalidEphemeralPubKey()` when the key is not 33 bytes, `ZeroAmount()` when `value == 0` (same reasons as RD).

### Lock-down of the ERC-20 path

`transfer` and `transferFrom` skip certificates. To close that hole the setup sequence activates the validator's **allowlist** with only the custodian on it: for those two selectors the validator then rejects any sender or recipient that is not allowlisted. To be confirmed by a test (section 6): an ERC-20 `transfer` between non-allowlisted addresses reverts with code `54`. This lock lasts only while the token owner keeps the validator and its setup in place; see the owner-key risk in section 7.

### Announcement metadata (89 bytes)

| Bytes | Content |
|---|---|
| 1 | view tag |
| 2-5 | selector of `transferByPartition(bytes32,address,uint256,bytes)` |
| 6-25 | token contract address |
| 26-57 | amount, 32-byte big-endian |
| 58-89 | partition (tranche), 32 bytes |

Built on chain from the variables that move the balance. This extends the EIP's ERC-20 layout by the partition; the EIP calls its layout a SHOULD and defines none for ERC-1400.

### Trust rule

Same as RD: the token calls `announce`, so `caller` is the token address and cannot be forged. Scanners read only announcements whose `caller` equals the bond token address. `balanceOfByPartition(partition, stealthAddress)` is the authority; metadata is a hint.

### Certificate flow (who signs what)

1. Investor bank B publishes its meta-address to the custodian (the custodian already holds B's view key and spend public key from KYC). A bank should register a dedicated meta-address for bonds: the custodian holds the view key, so if the bank reused its RD meta-address the custodian would also see the bank's RD receipts.
2. Sender A derives a stealth address `S` and ephemeral key `R` for B and sends `(S, R, viewTag, partition, amount)` to the custodian off chain.
3. The custodian verifies that `S` belongs to a KYC'd investor (it can recompute `S` from B's meta-address and `R`), reads `usedCertificateNonce(token, A_stealth)` from the validator, and signs a certificate for the exact `transferByPartitionStealth` calldata with a short expiry. The certificate binds the whole calldata, including `ephemeralPubKey` and `viewTag`, but nothing on chain checks that they are consistent with the recipient, so this check is the custodian's duty. The custodian decodes the calldata itself and never signs an opaque payload. It signs only the `transferByPartitionStealth` and `redeemByPartition` selectors. With the bank's view key it checks that `S`, `R` and `viewTag` are consistent (recompute `S` and the tag from `R`) and refuses otherwise.
4. A submits the transaction with the certificate as `data`. The validator verifies the signature and increments the nonce.

On chain only `S` appears; the link from `S` to bank B exists in the custodian's records only.

## 4b. Encrypted sender memo (added 2026-10-16)

Same mechanism as RD (`2026-10-15-rd-stealth-token-design.md`, "Encrypted sender memo"): both stealth functions take a `bytes memo` before the certificate; the announcement metadata is the 89-byte prefix above followed by the memo; the contract only bounds it (`MemoTooLong()`, `MAX_MEMO` = 256). Bond specifics: the memo signature also covers the partition (`ts/memo.ts`, `MemoContext.partition`); `data` (the certificate) stays the LAST parameter, and because the certificate covers the whole calldata minus its own tail, **the custodian also vouches for the memo it signed over** and a certificate cannot be reused with a different memo (`test_certificate_is_bound_to_the_memo`). For `issueByPartitionStealth` the sender is the custodian. The custodian holds each investor bank's view key, so it reads the memo like BI does.

## 4c. Instrument data (added 2026-10-16)

The bond terms (ISIN, issuer LEI, amounts, dates, pricing, listing, DLT platform) follow the ICMA Bond Data Taxonomy v1.2 as the DFABI profile of the shared instrument data (`besu/docs/instrument-data-spec.md`): `ts/instrument.ts` validates a record against the catalog and `besu/docs/instrument-data/profiles/DFABI.profile.json`, `InstrumentRegistry` stores the record hash and URI per token, and the bond holds the same hash in the ERC-1400 document slot `setDocument("ICMA-BDT-v1.2", uri, hash)`, which is an inherited function, so `DfabiBond` did not change. Smoke: `script/smoke-instrument.ts`. The terms are public; privacy still covers only holdings and transfers.

## 5. Library (`stealth/ts/bond.ts`)

| Function | Does |
|---|---|
| `buildBondMetadata(viewTag, token, amount, partition): string` | 89-byte `0x` hex. Throws on bad tag, address, amount outside `0 .. 2^256-1`, or partition not 32 bytes. |
| `parseBondMetadata(metadata)` | `{ viewTag, token, amount, partition } \| null`; never throws; `null` for anything that is not 89 bytes with the right selector (including RD's 57-byte form). |
| `payloadWithoutCertificate(calldata): string` | Takes calldata encoded with a 97-byte placeholder as the certificate and returns the calldata minus its last 160 bytes (what the custodian signs over). Throws if the calldata is too short. |
| `certificateDigest(params): string` | `params = { domainSeparator, msgSender, token, payload, expiry, nonce }`. Returns `keccak256(domainSeparator ++ keccak256(msgSender ++ token ++ payload ++ expiry ++ nonce))`, the hash rule in section 3. Throws on a bad domain separator, address or out-of-range `expiry` / `nonce`. |
| `signCertificate(custodianKey, params): string` | Same `params`. Returns the 97-byte certificate as `0x` hex (`expiry(32) \| r(32) \| s(32) \| v(1)`), signed raw over the digest. Custodian side. |
| `CERTIFICATE_LENGTH` | Constant, 97. |

`scan` from sub-project 1 is unchanged.

## 6. Tests and checks

1. **Foundry** (`stealth/test/DfabiBond.t.sol`; ERC1820 registry bytecode placed with `vm.etch` at its fixed address): setup sequence works (token, validator, signer, allowlist); minter-only issue; `issueByPartitionStealth` and `transferByPartitionStealth` move the balance and emit the exact 89-byte announcement from the Announcer (emitter pinned, expected bytes built independently with `bytes.concat`); transfer without a certificate, with an expired one, with a wrong signer, with one signed for a different recipient or amount, and a replayed one (nonce) all revert; ephemeral key lengths 0, 32, 34, 65 and zero value revert; ERC-20 `transfer` and `transferFrom` revert with code `54`; partition balances and `totalSupplyByPartition` stay consistent after a partial send; holder redeem needs a certificate; a document can be set and read.
2. **TypeScript** (`stealth/ts/bond.test.ts`): metadata round trip and golden vector, `parseBondMetadata` null cases, and a fixed vector pinning the certificate hash rule of `signTransferCertificate`. That the on-chain validator accepts a certificate from this helper is proved by the Foundry suite (same vector) and by the smoke.
3. **Pre-flight on Besu (first plan task, before any other work):** deploy the ERC1820 registry with the standard pre-signed transaction. Fund the one-time sender first if the node needs balance for the upfront gas check, even though the network gas price is 0. Record the outcome here. If Besu refuses the transaction, stop and ask: the fallback options (genesis change, or a patched registry address in the vendor code) conflict with "vendored unmodified".
4. **Besu smoke** (`stealth/script/smoke-bond.ts`, one-off, not CI): check that the registry exists (it is deployed beforehand by `stealth/script/deploy-erc1820.ts`, see 3 above), deploy Announcer, validator, bond token; configure as in section 4; custodian issues 1000 units of tranche A to bank A's stealth address; A scans only announcements with `caller` = token and checks `balanceOfByPartition` equals the metadata amount; A, with a custodian certificate, sends 400 to B's stealth address from its unfunded stealth address; B scans and finds 400 in tranche A; the same transfer without a certificate reverts; a forged announcement (posted straight to the Announcer) is excluded by the `caller` filter; B redeems 400 and A redeems 600 with certificates; final `totalSupplyByPartition` is 0. Results go in a new section 8 after the live run.

## 7. Risks

- **Unreviewed, archived base.** The bond token inherits whatever bugs the vendor code has. Nothing here audits it. Pinned by commit so it cannot change underneath us.
- **Custodian is a controller and a certificate signer.** It can force transfers and decide who may receive. This is by design for a regulated bond, but it also means the custodian sees every recipient and its key is the most sensitive key in the system. Key custody and rotation are out of scope here.
- **The token owner is the most powerful key.** `onlyMinter` is `isMinter || owner`, and the owner can call `setTokenExtension`, `registerTokenSetup`, `setControllers`, `addMinter` and `migrate(definitive)`. Reproduced in review: the owner calls `setTokenExtension(address(0), "ERC1400TokensValidator", ...)`, which removes the certificates and the allowlist in one transaction, after which an ERC-20 `transfer` between non-allowlisted addresses succeeds. The owner can also mint silently through the inherited `issueByPartition` (no announcement), and `migrate(definitive)` freezes the token. The ERC-20 lock-down therefore lasts only while the owner keeps the validator and its setup. The owner should be the custodian or a custody multisig; a separate deployer key would be an unlisted party that can undo the lock.
- **Custodian must be online per transfer** (nonce-based certificates), and each certificate is bound to one exact call. A failed or reordered transaction by the same sender invalidates the next certificate until the nonce matches; senders must request certificates one at a time.
- **The nonce is per `msg.sender`.** Because a stealth address is used once or twice, nonces stay small, but a sender that reuses one stealth address sees all its transfers linked by that address (same as RD change risk).
- **Inherited transfers are silent.** `transferByPartition`, operator and controller transfers do not announce, and neither do the inherited `issue` and `issueByPartition`. A recipient is told only if the custodian refuses to sign certificates for the silent paths and for inconsistent `(R, viewTag)` (section 4, step 3). Wallets using `transferByPartitionStealth` is necessary, but the custodian's signing policy is the real gate.
- **Custodian burn power.** The custodian, as controller, can burn any holder's balance with no certificate through the inherited `operatorRedeemByPartition`.
- **Certificate signers administer each other.** Any certificate signer can add or remove other signers, so a second signer key is a full signer admin.
- **ERC1820 registry dependency** on the Besu network (section 6 pre-flight).
- **Change stays on the sender's stealth address** after a partial send, like RD.
- **Sender, amount, token and tranche are public.** Only the recipient is hidden. Dust announcements pass the `caller` filter like RD's; `balanceOfByPartition` is the authority.
- **For sub-project 4 (DvP):** the certificate binds `msgSender`, so a DvP contract that calls the bond is its own `msgSender` with its own nonce, and the custodian must sign for the DvP address; the DvP must hold the escrowed bonds and call `transferByPartitionStealth` itself so that `caller` is the token. Settlement confirmation reads balances, never metadata.
- Gas price on this network is 0 (sub-project 1 smoke). `eth_getLogs` is range-capped; scanners page and checkpoint.

## 8. Results

- Pre-flight, 2026-10-15, ACK `besu` namespace via `besu-node-validator-1-0`: ERC1820 registry deployed at `0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24` (2501 bytes of runtime code) with the standard pre-signed transaction. The deployer funded the one-time sender with 0.08 ETH first (the deployer balance on this network is far above that). Besu accepted the unprotected transaction. A second run did nothing (idempotent), and the runtime code on Besu equals `stealth/test/fixtures/erc1820-runtime.hex`.
- Live smoke 2026-10-15, `stealth/script/smoke-bond.ts` against the shipped contracts (repository HEAD `850b4b4` when it ran), passed on the first attempt. Chain id `1337`, gas price `0`; stealth addresses sent and redeemed with no funding and the script asserts bank A's stealth address holds `0` native balance.
- All checks passed: the custodian issued 1000 of tranche A to bank A; A's scan over only the token's own announcements found exactly one payment whose on-chain metadata (token, amount 1000, tranche A) matched `balanceOfByPartition`; a transfer without a certificate and an ERC-20 `transfer` were both refused with `"54"`; A sent 400 to B with a custodian certificate and kept 600; replaying the same certificate was refused; B's scan found exactly one payment (400, tranche A); a forged announcement with bond-looking metadata appeared in the unfiltered scan but not in the `caller`-filtered scan and its address held 0; both banks redeemed with certificates and tranche and total supply ended at 0.
- Throwaway contracts left on the network, not for use: Announcer `0x9BD334613D72Bf495DEc22f28D9Bf4f81B788b02`, validator `0xF702A5Ca53fC99Ea4C5e046d68DaD5F1b35d5DFE`, bond `0xd2aAd8107aB3E8dC52f05F762E6dEBA263138FCa`.
- Not exercised live: expired, wrong-signer, wrong-recipient, wrong-amount and wrong-sender certificates, bad ephemeral key lengths, zero value, non-minter issue (Foundry suite only).
