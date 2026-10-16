# Atomic DvP, DFABI bond against RD (sub-project 4) design

Status: approved 2026-10-16; implemented (`src/DvPEscrow.sol`, `src/DvPFactory.sol`, `test/DvP.t.sol`, `script/smoke-dvp.ts`); results in section 7.

## 1. Why

A bank sells bond units (DFABI, ERC-1400) to another bank for RD (ERC-20). Both legs must move in one transaction or not at all, without BI online, and without the other banks learning who received what. BI, the seller and the buyer must each be able to read the whole trade afterwards (sender, receiver, amount, token, tranche).

Inputs from earlier specs: the bond certificate binds `msgSender`, so an escrow that calls the bond is its own `msgSender` with its own nonce, and the custodian signs for the escrow address (`dfabi-bond-token-design.md`, section 7). The escrow holds the bonds and RD and calls `transferByPartitionStealth` / `sendStealth` itself, so the Announcement `caller` is the token; settlement reads balances, never metadata (`rd-stealth-token-design.md`). Both legs carry the encrypted sender memo (`rd-stealth-token-design.md`, "Encrypted sender memo").

## 2. Decisions

| Topic | Decision |
|---|---|
| Shape | One `DvPEscrow` per trade, created by `DvPFactory` with CREATE2. The salt is `keccak256(abi.encode(terms))` and the terms include a `tradeId` (bytes32, chosen by the seller, unique), so two trades with identical terms still get different addresses. The escrow's balance is exactly that trade's money: no shared pool, no per-trade accounting. |
| Terms (immutable, in storage from the constructor) | `tradeId`; bond token, `partition`, `bondAmount`; RD token, `rdAmount`; `seller` and `buyer` (the stealth addresses that fund the legs and get refunds); `expiry`; `refundWindow`; the bond leg and the RD leg, each `(receiver, ephemeralPubKey, viewTag, memo)`. Nothing can change after creation, so receivers and memos cannot be swapped. |
| Certificates | Not part of the terms. A certificate is signed for the escrow address, and the address depends on the terms, so the certificates cannot be inputs to the address. The factory attaches them right after creating the escrow, in the same transaction (`setCertificates`, factory only, once). The custodian computes the address with `factory.predict(terms)`, signs, then calls `create(terms, settleCert, refundCert)`. |
| Who creates | Only the custodian (`DvPFactory.custodian`, immutable). It has checked both parties' terms (KYC of both receivers), and a third party cannot take an address with bad certificates (which would block the trade). Each party reads `getTerms()` and `certificatesSet()` from the escrow before funding. |
| Certificate expiry, checked on chain | `setCertificates` reads the expiry from the first 32 bytes of each 97-byte certificate (the validator's format `expiry | r | s | v`) and requires `settleCert expiry >= expiry` and `refundCert expiry >= expiry + refundWindow` (`CertificateExpiresTooEarly`, `BadCertificateLength`). The normal failure mode is therefore a refund inside the window, not a bond stuck until the custodian intervenes. The check does not prove the signature is valid: that is the custodian's responsibility. |
| Funding | Seller: `bond.transferByPartition(partition, escrow, bondAmount, cert)` with the seller's own custodian certificate. Buyer: `rd.transfer(escrow, rdAmount)`. |
| `settle()` | Anyone, strictly before `expiry` (`block.timestamp < expiry`). Reverts `NotFunded` unless the bond balance in the partition is `>= bondAmount` and the RD balance is `>= rdAmount`, before anything moves. Then `bond.transferByPartitionStealth(... settleCert)` and `rd.sendStealth(...)`; any revert undoes both. RD above `rdAmount` is returned to the buyer in the same transaction. Sets `settled`; a second `settle()` reverts `AlreadySettled`. At `block.timestamp == expiry` settle reverts `Expired`. |
| `cancel()` | Anyone, from `expiry` on (`block.timestamp >= expiry`) and only if not settled. Per leg: if the bond balance is `>= bondAmount`, `transferByPartition(partition, seller, bondAmount, refundCert)`; if the RD balance is above 0, the whole RD balance goes to the buyer. An unfunded leg is skipped, so it works when only one side funded. Reverts `NothingToRefund` if neither moved. A failing bond refund (an expired certificate) is caught and emits `BondRefundFailed`, so it cannot block the RD refund. It can be called again later. |
| Bond refund amount | Exactly `bondAmount` (the refund certificate binds the calldata). A bond overfunding, or a bond sent after the refund certificate was used, stays in the escrow until the controller moves it. |
| Nonce | Both certificates are for the escrow's nonce 0; whichever runs first consumes it, so settle and the bond refund can never both execute. |
| Availability | The custodian must be online when a trade is created (pre-signing). It is **not** needed at settle or cancel. BI is never needed. Both operations are open to anyone, so they keep working while BI's node is down. |
| Not done | Partial fills, multi-leg trades, price discovery, a mutual cancel before expiry, coupon payments, DvP for the plain ERC-20 path, a UI, an on-chain check that the certificate signature is valid, a list of licensed memo identities. |

## 3. Properties and how they hold

1. **Atomic.** `settle()` is one transaction; a revert in either leg undoes both (test: RD leg fails, bond leg fails).
2. **No theft or redirect.** Destinations are fixed in the terms. `settle()` and `cancel()` take no arguments, so a third party can trigger them but cannot choose where money goes (test: a third party settles and ends with nothing). A certificate is bound to the escrow address and to the exact calldata, including the memo, so it cannot be reused elsewhere (tests: certificate for another address, for another memo).
3. **Reclaim.** After `expiry` either side, or anyone, calls `cancel()`; each side gets its own leg back.
4. **No early cancel.** `cancel()` reverts before `expiry`; `settle()` reverts from `expiry`. The boundary second belongs to cancel.
5. **Privacy.** Both legs are announced by the tokens (`caller == token`) during `settle()` with the encrypted memos. Other banks cannot link the receivers; BI, the seller and the buyer read the trade.
6. **Replay.** `settled` and the certificate nonce both block a second settlement.

## 4. Risks and limits

- A bond sent to the escrow outside the terms (extra units, or after a refund) is recoverable only by the controller (the custodian).
- The custodian's signing key gates every bond move out of an escrow; a custodian that refuses to sign simply prevents the trade. A custodian that signs a certificate for terms it did not check can lock a trade.
- If `cancel()` is first called after `expiry + refundWindow`, the refund certificate may have expired; the RD is refunded, the bond waits for the controller.
- `settle()` can fail forever on terms the custodian should have rejected (for example a 32-byte ephemeral key in a leg). The trade is then refundable after `expiry` but not settleable; parties check their own leg before funding.
- The ERC-1400 vendor code is archived and unreviewed (see the bond spec).
- One contract deployment per trade.

## 5. Tests and smoke

`test/DvP.t.sol` (22 tests): happy path with both announcements and fixed receivers; RD overfunding returned at settle; double settle; `NotFunded` for each missing or short leg; the `expiry` boundary for settle and cancel; atomic revert when either leg fails; certificate for another address and for another memo refused; cancel with both legs, only the seller, only the buyer, RD overfunding, a bond overfunding, nothing funded, twice, and after settle; an expired bond refund does not block the RD refund; the refund certificate is valid through the last second of the window; the address depends on `tradeId` and a trade cannot be created twice; only the custodian creates; certificate expiry and length checked at creation; terms readable and certificates settable only by the factory. I also mutated the boundary comparisons, the refund-window check, the RD excess refund and the `settled` assignment, and each mutation failed a test.

## 6. Smoke (`script/smoke-dvp.ts`, Besu)

Trade 1 is settled by a third party; trade 2 expires and is cancelled by a third party. Checks: both legs and refunds by balance, BI (all view keys) resolves the bond receiver to the buyer bank and the RD receiver to the seller bank and reads both memos, the seller and buyer find their own receiving address and see both receivers in the escrow terms, a third bank's view key resolves nothing and decrypts nothing.

## 7. Results

Foundry 73 passed (51 before + 22 DvP), vitest 48, `tsc` clean. Besu smoke passed on the first run: settle `0x56d4ec4d7c1f0e3c255f6ae822ddd90485f0e92971eab8e2aecdfd88897bbf4e`, cancel `0x00385a0e6ec18ee59b788c069e000d0b26273b5883f766f9e3a9aa59eb0fd5a7`; throwaway contracts: announcer `0x691f30b54b02630E52f28aF21Cd3F5e750313981`, bond `0xAEA0253E29e50810b57DbB9f0Ed113ed08c7e559`, RD `0xBc5fe1A72288DD0D4c2F408b56d68508d1C7DED0`, factory `0xA1c04d8995d5EB325735948d7aD43dcF848F9f86`.
