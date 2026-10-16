# D34 reopen-with-burn — paladin-client signer verification report

File analyzed: `/home/ecs-user/alibaba-kube/Paladin/common/paladin-client/src/client.ts` (2758 lines)
Date: 2026-10-08
Method: read-only source inspection against `/home/ecs-user/alibaba-kube/Paladin/contracts/src/BondTracker.sol` lines 262-267.

All 6 methods sign with identities hardcoded inside client.ts (no caller-supplied signer parameter for these). All 6 match the expected D34 mapping. None performs an on-chain status pre-check.

---

## One-liners

```
forceCompleteDistribution -> bondCustodian -> client.ts:2326 -> OK
closeDistribution         -> bondCustodian -> client.ts:2320 -> OK
beginDistribution         -> bondCustodian -> client.ts:2317 -> OK
setActive                 -> bondIssuer    -> client.ts:2323 -> OK
mintTranche               -> bondIssuer (from), to: bondCustodian -> client.ts:2307 -> OK
burnBond                  -> bondCustodian -> client.ts:1502 -> OK
```

## Evidence per method

### forceCompleteDistribution — client.ts:2325-2327
```ts
async forceCompleteDistribution(token: string, idempotencyKey?: string): Promise<void> {
  await this.sendBondTrackerTx(token, "forceCompleteDistribution", "bondCustodian", {}, idempotencyKey);
}
```
Signer = `"bondCustodian"` (hardcoded literal at line 2326). No pre-flight other than what `sendBondTrackerTx` does (below): in-memory series-context presence + identity node check. No on-chain status probe.

### closeDistribution — client.ts:2319-2321
```ts
async closeDistribution(token: string, idempotencyKey?: string): Promise<void> {
  await this.sendBondTrackerTx(token, "closeDistribution", "bondCustodian", {}, idempotencyKey);
}
```
Signer = `"bondCustodian"` (line 2320). Same pre-flight as above. No status check.

### beginDistribution — client.ts:2316-2318
```ts
async beginDistribution(token: string, p: { price: string; minimumDenomination: string }, idempotencyKey?: string): Promise<void> {
  await this.sendBondTrackerTx(token, "beginDistribution", "bondCustodian", { discountPrice: p.price, minimumDenomination: p.minimumDenomination }, idempotencyKey);
}
```
Signer = `"bondCustodian"` (line 2317). No status pre-check.

### setActive — client.ts:2322-2324
```ts
async setActive(token: string, idempotencyKey?: string): Promise<void> {
  await this.sendBondTrackerTx(token, "setActive", "bondIssuer", {}, idempotencyKey);
}
```
Signer = `"bondIssuer"` (line 2323). No status pre-check.

### mintTranche — client.ts:2300-2314
```ts
async mintTranche(token: string, amount: string, idempotencyKey?: string): Promise<void> {
  try {
    this.requireSeriesContext(token);
    const bondIssuer = this.requireIdentityVerifier("bondIssuer");
    const bondCustodian = this.requireIdentityVerifier("bondCustodian");
    const noto = new NotoInstance(this.sdk, token);
    const receipt = await this.submitIdempotent(
      () => Promise.resolve(noto.mint(bondIssuer, { to: bondCustodian, amount, data: "0x" }, idempotencyKey).id),
      idempotencyKey
    );
    if (!receipt?.success) throw new PaladinClientError("PD_CLIENT_MINT_TRANCHE_FAILED", `mintTranche failed: ${receipt?.failureMessage ?? "no receipt"}`);
  } catch (err) { throw toPaladinClientError(err); }
}
```
Signer = `bondIssuer` (the `from` of the Noto `mint`, line 2307); recipient is `bondCustodian`. Both hardcoded, not parameterized. Pre-flight = `requireSeriesContext(token)` (line 2302) — in-memory cache-presence check only (throws `PD_CLIENT_UNKNOWN_SERIES` if this client instance never issued/resumed the series), NOT an on-chain status check. Uses Noto domain `mint` directly; never calls BondTracker.

### burnBond — client.ts:1500-1512
```ts
async burnBond(token: string, amount: string, idempotencyKey?: string): Promise<{ txId: string }> {
  try {
    const signer = this.requireIdentityVerifier("bondCustodian");
    const notoToken = new NotoInstance(this.sdk, token);
    const future = notoToken.burn(signer, { amount, data: "0x" }, idempotencyKey);
    const txId = await future.id;
    const receipt = await resolveIdempotentFuture(this.sdk, txId, idempotencyKey, DEFAULT_POLL_TIMEOUT);
    if (!receipt?.success) throw receiptFailureError("burnBond", "PD_CLIENT_BURN_BOND_FAILED", receipt);
    return { txId };
  } catch (err) { throw toPaladinClientError(err); }
}
```
Signer = `this.requireIdentityVerifier("bondCustodian")` (line 1502), passed as the `from` of `notoToken.burn` (line 1504). Hardcoded. **No tracker-status probe anywhere in this method** — burnBond never touches BondTracker or the private tracker; it is a pure Noto domain-level burn ("implemented in Go", `onlySelf`-gated — comment lines 1494-1499: the custodian can only burn its OWN Noto holdings, so the bond leg must have settled to the custodian first). Pre-flight is limited to `requireIdentityVerifier` (identity configured + same-node check) and NotoInstance construction.

## Shared helper pre-flight

`sendBondTrackerTx` (client.ts:2329-2347) — used by beginDistribution/closeDistribution/setActive/forceCompleteDistribution:
```ts
const ctx = this.requireSeriesContext(token);              // 2337: in-memory cache presence, PD_CLIENT_UNKNOWN_SERIES
const verifier = this.requireIdentityVerifier(signer);     // 2338: identity config + same-node check (2562-2572)
ctx.privateTracker.sendTransaction({ from: verifier.lookup, function: fn, data }, { idempotencyKey })
```
The only pre-checks are (a) the issuing client has the Pente-group/privateTracker pair cached (`requireSeriesContext`, client.ts:2604-2608) and (b) the signer identity is configured on this node (`requireIdentityVerifier`, client.ts:2562-2572, `PD_CLIENT_WRONG_ROLE`). Neither reads on-chain tracker state. No `.status`/`getStatus` call exists in any of the 6 paths (the file's only tracker-status read is in `getDistributionState` at client.ts:2448-2449, a separate method not involved here).

## DISTRIBUTION_CLOSED reachability (burn after forceComplete, before close)

**Verified safe at the client layer.** burnBond performs zero tracker-status or agreement probes — it never instantiates or calls the BondTracker, Pente group, or investorList; the only on-chain object it touches is the Noto instance for a domain-level `burn`. Nothing in client.ts can revert or misbehave because tracker status is DISTRIBUTION_CLOSED, and no pre-check conflicts with the reopen flow ordering (forceComplete → DISTRIBUTION_CLOSED → burnBond → closeDistribution).

On-chain gating of the burn is the tracker's own burn gate (BondTracker.sol:262-267), not anything in client.ts — and that gate explicitly permits both DISTRIBUTION_STARTED and DISTRIBUTION_CLOSED, so DISTRIBUTION_CLOSED (the exact state after forceCompleteDistribution, before closeDistribution) is a sanctioned burn state.

One non-status prerequisite to keep in mind (design note in client.ts:1494-1499, not a client check): Noto burn is `onlySelf`-gated — the custodian must already hold the bond on its own Noto balance, which the redemption bond leg must have settled first. That is a balance prerequisite, not a status gate, and is satisfied by the flow's own preceding steps.