# RD stealth token (ERC-20 with ERC-5564 announcements) design

Date: 2026-10-15
Status: approved 2026-10-15; implemented, results in section 7
Part of: privacy-enabled RD + DFABI directly on Hyperledger Besu (no Paladin). Sub-project 2 of 4.
Depends on: stealth core (`2026-10-15-stealth-core-design.md`, committed, final fix wave in flight).

## 1. Why

Rupiah Digital (RD) must move between banks without other banks or nodes being able to link a recipient to a transfer. Sub-project 1 gave us the Announcer, the Registry and the key library. This sub-project puts a cash token on top of them: an ERC-20 whose send and mint functions announce the stealth recipient in the same transaction.

Scope (user, 2026-10-15): contract, library helper and a live Besu smoke only. No backend, no `rtgs-sim` adapter, no replacement of the Noto RD that the backends use today. Those come after the bond side exists.

Threat model unchanged: other banks and nodes must not link a recipient to a transfer. Sender, amount and token stay public.

## 2. Decisions

| Topic | Decision |
|---|---|
| Token | ERC-20 on OpenZeppelin `ERC20` + `ERC20Burnable` 5.4.0 (same version as `Paladin/contracts`, `pragma ^0.8.20`). Not hand-rolled: it is a money token. |
| New dependency | `@openzeppelin/contracts` 5.4.0, exact pin, in `stealth/package.json`, with a Foundry remapping. Spec 1's "no new dependency" applied to the TypeScript library only. |
| Name, symbol, decimals | "Rupiah Digital", "RD", **0**. Assumption: RD amounts are whole rupiah, matching the integer-string amounts the backends and `rtgs-sim` use today. Change here if centi-rupiah is wanted. |
| Issuer | One immutable address (BI), set in the constructor. Only the issuer mints. No ownership transfer: redeploy to change it. |
| Burn | Any holder burns its own balance. Anonymous on chain; see risks. |
| Announcer | Immutable address, set in the constructor. Scheme id fixed to `1`. |
| Library scope | `scan` from sub-project 1 is unchanged. Two new pure helpers for the token metadata. |
| BI sees every receiver (added 2026-10-16) | At onboarding each bank hands BI its RD **view key**; BI keeps each bank's meta-address (the spend public key is inside it). BI scans all RD announcements with every bank's view key (`scanAll` / `scanView` in `ts/stealth.ts`) and resolves each stealth address to a bank, after the fact, with no online step at transfer time. A view key cannot move funds. **Risk:** a leaked view key exposes that bank's whole RD receive history (not just BI's copy: whoever holds it can read every past and future receipt), so BI must store view keys like secrets and a bank that suspects a leak must move to a fresh meta-address. Same pattern as the DFABI custodian (`dfabi-bond-token-design.md`). |
| Not done | Backend integration, RTGS adapter, pause, blacklist, KYC, allowance-based stealth sends, replacing Noto RD. The list of which memo-signing identities are licensed banks (kept off chain by BI), and any on-chain check of the memo, are not built. |

## 3. Contract `RupiahDigital` (`stealth/src/RupiahDigital.sol`)

Constructor: `(address issuer_, address announcer_)`.

| Function | Who | Does |
|---|---|---|
| `mint(address to, uint256 amount)` | issuer | Plain mint. No announcement. |
| `mintStealth(address stealthAddress, uint256 amount, bytes ephemeralPubKey, bytes1 viewTag, bytes memo)` | issuer | Mint to a stealth address and announce, one transaction. |
| `sendStealth(address stealthAddress, uint256 amount, bytes ephemeralPubKey, bytes1 viewTag, bytes memo)` | any holder | Transfer from `msg.sender` to a stealth address and announce, one transaction. |
| `burn(uint256 amount)` | holder | Inherited from `ERC20Burnable`. |
| `decimals()` | any | Returns `0`. |

The contract also inherits `burnFrom`, `approve`, `transfer` and `transferFrom` from OpenZeppelin; none of them announce, so a `transfer` or `transferFrom` to a stealth address is silent like any plain ERC-20 transfer.

`mintStealth` is an addition to the design shown on 2026-10-15: without it the first hop (BI funds a bank) would need a separate `announce` call whose `caller` is BI, not the token, which breaks the trust rule below.

Reverts: `InvalidEphemeralPubKey()` when `ephemeralPubKey.length != 33`; `ZeroAmount()` when `amount == 0` for `mintStealth` and `sendStealth`; `OnlyIssuer()` for non-issuer mint calls; the OpenZeppelin errors for zero recipient and insufficient balance.

### Announcement metadata (EIP-5564, ERC-20 form, 57 bytes)

| Bytes | Content |
|---|---|
| 1 | view tag |
| 2-5 | `0xa9059cbb` (selector of `transfer(address,uint256)`) |
| 6-25 | token contract address |
| 26-57 | amount, 32-byte big-endian |

Built on chain from the same variables that move the balance, so the announced amount always equals the moved amount. Layout and selector checked against the EIP text and `cast sig` on 2026-10-15; the EIP calls the layout a SHOULD, not a MUST.

### Encrypted sender memo (added 2026-10-16)

Goal: the receiver and BI see a transfer in full (authenticated sender, receiver, amount, token); other banks cannot link the receiver. Amount, token and the sender's on-chain address stay public. BI is never online for a transfer: it reads the chain afterwards with the receiver bank's view key.

- **On chain:** `mintStealth` and `sendStealth` take a trailing `bytes memo`. The announcement metadata is the exact 57-byte prefix above, then `memo` unchanged (byte 0 is still the view tag, so EIP-5564 scanners work). The contract does **no crypto**; it only reverts `MemoTooLong()` when `memo.length > MAX_MEMO` (256, public constant). An empty memo gives the plain 57-byte metadata.
- **Memo (`ts/memo.ts`), 102 bytes:** version `0x01` | AES-256-GCM ciphertext (85) | tag (16). Plaintext = sender identity address (20) | signature r,s,v (65). Key = `keccak256("RD-memo-v1" || ECDH point)` (the point EIP-5564 already uses, so the receiver's view key opens it, and BI, holding that view key, too; no other bank can). Nonce = first 12 bytes of `keccak256("RD-memo-nonce" || ephemeralPubKey)`; never reuse an ephemeral key. AAD = the version byte.
- **Signature:** the sender's identity key signs `keccak256("RD-memo-sig-v1" || chainId || token || stealthAddress || amount || ephemeralPubKey [|| partition])`, so a memo is valid for exactly one payment and a replayed memo opens as `null`. For `mintStealth` the sender is BI's identity key.
- **Receiver check:** `openMemo(memo, viewKey, ctx)` returns the sender or `null` (wrong key, tampered, other payment, or signature not by the claimed sender). A forged memo needs the sender's identity key, so it cannot name another bank.
- **Which identities are banks** is an off-chain list kept by BI at onboarding (the memo proves who signed, not that they are a licensed bank).
- **Risks:** the memo hides the sender identity only from banks without the receiver's view key; anyone with that view key (BI, a leaked key) reads it. The ciphertext length (102 bytes) is visible, so a memo is distinguishable from none. `ts/memo.ts` uses `node:crypto` (AES-GCM), no new dependency.

### Trust rule

The token itself calls `announce`, so the `caller` field of every announcement it emits is the token address, and nobody else can forge that field (the Announcer sets it from `msg.sender`). A scanner therefore reads only announcements whose `caller` equals the RD address and can believe the metadata. Anyone may still post an announcement that merely claims RD metadata; its `caller` is theirs, and the scanner ignores it. Even for trusted announcements, the authoritative balance is `balanceOf(stealthAddress)`; metadata is a hint for display.

## 4. Library (`stealth/ts/token.ts`)

| Function | Does |
|---|---|
| `buildTokenMetadata(viewTag, token, amount): string` | 57-byte `0x` hex. Throws if `viewTag` is not 1 byte, `token` is not an address, or `amount` is outside `0 .. 2^256-1`. |
| `parseTokenMetadata(metadata): { viewTag, token, amount } \| null` | Returns `null` (never throws) for anything that is not exactly 57 bytes with selector `0xa9059cbb`, including the 1-byte tag-only metadata from sub-project 1. |

`scan` already reads only the first metadata byte, so token metadata works with it as is. It relies on the two sub-project 1 fixes now in flight: a malformed view key throws instead of returning nothing, and replayed announcements are returned once.

## 5. Tests and checks

1. **Foundry** (`stealth/test/RupiahDigital.t.sol`): non-issuer `mint` and `mintStealth` revert; `mintStealth` and `sendStealth` move the balance and emit `Announcement(1, stealth, address(token), ephemeralPubKey, metadata)` with the exact 57 bytes (expected value built in the test with `bytes.concat`, independent of the contract's encoding); ephemeral key lengths 0, 32, 34, 65 revert; zero amount reverts for both `sendStealth` (even from an account holding no RD) and `mintStealth`; the announce tests pin the emitter to the Announcer (`expectEmit` with the Announcer address); zero recipient and insufficient balance revert; a partial send leaves the remainder and announces only the sent amount; `burn` lowers `totalSupply`; `decimals()` is 0.
2. **TypeScript** (`stealth/ts/token.test.ts`): build then parse round trip; a fixed golden vector for the 57 bytes; `parseTokenMetadata` returns `null` for empty, tag-only, 56 and 58 bytes, wrong selector; `buildTokenMetadata` throws for a 2-byte tag, bad address, negative amount, `2^256`; `scan` still finds an announcement whose metadata comes from `buildTokenMetadata`.
3. **Besu smoke** (`stealth/script/smoke-rd.ts`, one-off, not CI): deploy a fresh Announcer and `RupiahDigital` (deployer = issuer); BI `mintStealth` 1000 to bank A; A scans logs filtered by `caller = token` and bounded from the pre-deploy block, checks `balanceOf` equals the metadata amount and that the stealth address holds no native balance; A, from its unfunded stealth address, `sendStealth` 400 to bank B; B scans, finds 400 and checks the on-chain metadata says 400; a forged announcement (posted straight to the Announcer, `caller` = attacker) appears in an unfiltered scan but not in the `caller`-filtered one, and its address holds 0; B burns 400, A burns the remaining 600; final `totalSupply` is 0. Results (addresses, any failure) are recorded in section 7 after the live run.

## 6. Risks

- A plain ERC-20 `transfer` to a stealth address still works and announces nothing, so the recipient is never told. Cannot be blocked in an ERC-20. Wallets must use `sendStealth`.
- Change stays on the sender's stealth address. After a partial send the remainder sits at the same address that received the funds, so an observer can link "received 1000" to "sent 400" there. A recipient who cares should sweep to a fresh stealth address of its own. Not automated here.
- `burn` is anonymous on chain. When the RTGS adapter arrives, a bank has to tell BI which burn transaction to credit; that protocol belongs to that sub-project.
- No pause, blacklist or KYC on RD. Whether cash needs them is a policy question for later; DFABI (sub-project 3) handles investor checks for bonds.
- Sender, amount and token are public by design. Only the recipient is hidden.
- Gas price on this Besu network is 0 (sub-project 1 smoke). On a network with fees, stealth addresses need gas before they can send.
- `eth_getLogs` is range-capped on this Besu network; real scanners must page and checkpoint.
- No contract here uses a precompile; all curve math is off chain.
- Zero-amount announcements revert, but 1-unit dust announcements from anyone who holds RD still pass the `caller == token` filter and cost every scanner one ECDH computation. The `caller` filter guarantees each announcement matches a real transfer; it does not make it wanted. `balanceOf` (or the `Transfer` event of the same transaction) is the authority, never the metadata amount; wallets must dedupe by stealth address and never sum metadata amounts.
- For sub-project 4 (DvP): the DvP contract must hold the escrowed RD itself and call `sendStealth`, so `caller` is the token. A `transferFrom(buyer, sellerStealth, ...)` announces nothing, and an `announce` call made by the DvP contract carries the DvP as `caller` and fails the scanner's filter. Settlement confirmation must read `Transfer` or `balanceOf`, never announcement metadata.

## 7. Results

Live smoke 2026-10-15 on the ACK `besu` namespace via `besu-node-validator-1-0`, `stealth/script/smoke-rd.ts`. Run twice: once on the first implementation and once after the final-review fix wave (zero-amount revert, extra smoke checks), because the contract bytecode changed. The results below are from the second run, against the shipped code (commit `b94144a`), and it passed on the first attempt.

- Chain id `1337`, gas price `0`. Stealth addresses sent and burned with no funding; the script now asserts that bank A's stealth address holds `0` native balance.
- All checks passed: `mintStealth` of 1000 RD to bank A; A's scan over only the token's own announcements found exactly one payment, and its on-chain metadata (token, amount 1000) matched `balanceOf`; A sent 400 to B from its unfunded stealth address and kept 600; B's scan found exactly one payment, its on-chain metadata said this token and 400, and its balance was 400; a forged announcement carrying RD-looking metadata (posted straight to the Announcer, so `caller` is the poster, not the token) showed up in the unfiltered scan but not in the `caller`-filtered scan, and its address held 0; both banks burned and final `totalSupply` was 0.
- Throwaway contracts left on the network, not for use. Second run (shipped code): Announcer `0xc2C6ff79B2224378d60621Ac2dB577C2330C87B0`, RD `0xd8E8F930a6997f8189cED0abe341715553B07F73`. First run (superseded code): Announcer `0x501bD2fc53f552013a64d98cE958495484379d8F`, RD `0x4e99d46878919168d17816b3315Db4ba5d065127`.
- Not exercised live: revert paths (zero amount, bad ephemeral key length, non-issuer mint, insufficient balance, zero recipient) are covered by the Foundry suite only, and a plain ERC-20 `transfer` to a stealth address (silent by design, see section 6).
