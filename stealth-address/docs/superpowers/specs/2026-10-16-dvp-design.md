# Atomic DvP, DFABI bond against RD (sub-project 4) design

Status: draft 2026-10-16, waiting for the lead's go before any DvP code.

## 1. Why

A bank sells bond units (DFABI, ERC-1400) to another bank for RD (ERC-20). Both legs must move in one transaction or not at all, without BI online, and without the other banks learning who received what. BI, the seller and the buyer must each be able to read the whole trade afterwards (sender, receiver, amount, token, tranche).

Inputs from earlier specs: the bond certificate binds `msgSender`, so a DvP contract that calls the bond is its own `msgSender` with its own nonce, and the custodian signs for the DvP address (`dfabi-bond-token-design.md`, section 7). The DvP holds the escrowed bonds and RD and calls `transferByPartitionStealth` / `sendStealth` itself, so the Announcement `caller` is the token; settlement reads balances, never metadata (`rd-stealth-token-design.md`). Both legs carry the encrypted sender memo (`rd-stealth-token-design.md`, "Encrypted sender memo").

## 2. Decisions

| Topic | Decision |
|---|---|
| Shape | One escrow contract per trade (`DvPEscrow`), created by a `DvPFactory` with CREATE2 (`salt = keccak256(terms)`). The escrow address is known before it exists and the contract balance is exactly that trade's money, so there is no per-trade accounting and no shared pool to confuse. |
| Terms | Immutable constructor data: bond token, partition, `bondAmount`; RD token, `rdAmount`; `seller` and `buyer` (their stealth addresses that fund the escrow and receive refunds); `expiry`; the bond leg `(buyerReceiver, ephemeralPubKey, viewTag, memo)`; the RD leg `(sellerReceiver, ephemeralPubKey, viewTag, memo)`; `settleCert` and `refundCert` for the bond. Nothing can be changed after creation, so the receivers and memos cannot be swapped. |
| Who builds what | The seller derives the bond receiver from the buyer's meta-address (ERC-6538) and signs the memo as seller. The buyer derives the RD receiver from the seller's meta-address and signs the memo as buyer. Each party recomputes its own receiver and opens its memo before funding (`openMemo`). |
| Funding | Seller: `bond.transferByPartition(partition, escrow, bondAmount, cert)` (the seller needs an ordinary custodian certificate; the custodian sees the escrow address). Buyer: `rd.transfer(escrow, rdAmount)`. Exact amounts in one transfer. |
| `settle()` | Anyone may call, before `expiry`, once `bond.balanceOfByPartition(partition, this) >= bondAmount` and `rd.balanceOf(this) >= rdAmount`. It runs `bond.transferByPartitionStealth(..., settleCert)` then `rd.sendStealth(...)`. Either call reverting reverts the whole transaction. Sets `settled`; a second `settle()` reverts. |
| `cancel()` | Anyone may call, only after `expiry`, only if not settled. Returns the bond to `seller` (`bond.transferByPartition(..., refundCert)`) and the RD to `buyer` (`rd.transfer`). Funds can only go to the two fixed addresses, so the caller's identity does not matter. |
| Certificates | The custodian signs `settleCert` and `refundCert` for `msgSender = escrow address`, against the exact calldata, before the escrow exists (CREATE2 address). Signing is the custodian's approval of the trade (KYC of both receivers). Both certificates use nonce 0; whichever runs first consumes it, so only one of settle and refund can ever execute. Their expiry must outlast the trade `expiry` by the refund window, or the bond cannot be refunded. |
| BI | Not involved at settlement. BI reads the announcements afterwards with the banks' view keys (`scanAll`) and opens both memos (BI holds the view keys). |
| Not done | Partial fills, multi-leg trades, price discovery, a pre-expiry mutual cancel, coupon payments, DvP for the plain (non-stealth) ERC-20 path, a UI. |

## 3. Properties and how they hold

1. **Atomic.** `settle()` is one transaction; a revert in either leg undoes both.
2. **No theft or redirect.** Destinations are immutable constructor data. `settle()` and `cancel()` take no arguments that choose a destination. A third party can trigger them but cannot change where money goes. Certificates are bound to the escrow address and exact calldata, so they cannot be reused for another call.
3. **Reclaim.** After `expiry` either party (or anyone) calls `cancel()` and each side gets its own leg back.
4. **No grief by early cancel.** `cancel()` is unavailable before `expiry`.
5. **Privacy.** The stealth receivers and memos are announced by the token (`caller == token`) during `settle()`. Other banks cannot link the receivers; BI, seller and buyer read everything.
6. **Replay.** `settled` blocks a second `settle()`; the certificate nonce also blocks it.

## 4. Risks and limits

- **Funds can get stuck** if the bond certificates expire before a refund, if the seller deposits a different amount than `bondAmount` (the refund certificate covers exactly `bondAmount`), or if someone donates extra bond units. Recovery is the custodian acting as ERC-1400 controller. The seller and buyer should fund only the exact amounts.
- The custodian's signing key gates every bond move out of an escrow; a custodian that refuses to sign simply prevents the trade.
- The ERC-1400 vendor code is archived and unreviewed (see the bond spec).
- Escrows are not reusable; each trade costs one contract deployment.

## 5. Tests (Foundry) and smoke

Happy path with both memos announced; atomic revert when the RD leg fails; atomic revert when the bond leg fails; `cancel()` before `expiry` reverts; refund by each side after `expiry`; a third party cannot change the destination (there is no parameter) and cannot settle after `expiry`; replay of a settled trade; a certificate signed for another address or another calldata fails; the settle certificate and refund certificate cannot both run. `script/smoke-dvp.ts` on Besu: seller and buyer fund, a third party settles, then the seller, buyer and BI all read the trade and a third bank cannot.
