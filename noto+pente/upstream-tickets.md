# Upstream issues to file against LF-Decentralized-Trust-labs/paladin (v1.0.0)

## #7 - pollForReceipt uses a plain counter loop; a hung inner HTTP call blocks forever regardless of waitMs

What happens: `pollForReceipt(txID, waitMs)` iterates `for (let i = 0; i < waitMs; i += POLL_INTERVAL_MS)` where `i` only advances *after* the inner await completes, so any single stalled `getTransactionReceipt` HTTP call pins the loop open indefinitely. Evidence, `sdk/typescript/src/paladin.ts:128-137`:
```ts
async pollForReceipt(txID: string, waitMs: number, full?: boolean) {
    for (let i = 0; i < waitMs; i += POLL_INTERVAL_MS) {
      var receipt = full
        ? await this.ptx.getTransactionReceiptFull(txID)
        : await this.ptx.getTransactionReceipt(txID);
    ...
```
Observed impact: a 3.5-minute hang on an `issueSeries` call, cleared only by an external process restart. Local mitigation: `withReceiptDeadline` (paladin-client v0.6.4) wraps the whole call in an outer `Promise.race` deadline — see `common/paladin-client/src/errors.ts:63` and usage at `src/client.ts:690,708`.

## #8 - axios instance created without `timeout`, so a single stalled HTTP request is unbounded

What happens: the SDK's axios instance carries `baseURL` but no `timeout`, so no HTTP-level bound exists under any SDK method (every receipt poll, every send). Evidence, `sdk/typescript/src/paladin.ts:55-59`:
```ts
  constructor(options: PaladinConfig) {
    this.http = axios.create({
      ...options.requestConfig,
      baseURL: options.url,
    });
```
Observed impact: a stalled connection hangs the caller forever (the substrate of #7). Local mitigation: paladin-client `connect()` always sets `requestConfig: { timeout: 30000, ... }` — `src/client.ts:2682-2685` (introduced after the 0.6.4 incident).

## #2 - Mint-shaped hooks write unlock state without NotoLocks.onLock; delegate-unlock on a mint lock always underflows/reverts after the mint confirmed

What happens: `onCreateMintLock`/`onPrepareMintUnlock` call the internal `_onPrepareUnlock` helper but never `_locks.onLock`, so `lock.amount`/`lock.from` remain `0`/`address(0)`; a later delegated unlock then reverts (underflow in `onUnlock`) AFTER the real mint has confirmed. Compare the lock-writing hooks vs the mint hooks in `solidity/contracts/private/NotoLocks.sol:33-38`:
```solidity
    function onLock(bytes32 lockId, address from, uint256 amount) public {
        LockDetail storage lock = _locks[lockId];
        lock.from = from;
        lock.amount = amount;
```
...with `solidity/contracts/private/NotoTrackerERC20.sol:207-215` (`onCreateMintLock` = `onlyNotary`, calls only `_onPrepareUnlock`; no `_locks.onLock`) and `:152-160` (`onPrepareMintUnlock` same shape); contrast the non-mint paths at `:202-205` and `:225` which do call `_locks.onLock`. Revert lands in `NotoLocks.sol:46` (`lock.amount -= recipients[i].amount` with `lock.amount == 0`) reached via `handleDelegateUnlock` at `:69-78` and `NotoTrackerERC20.sol:245-249`. Usages: only the SDK domain wrapper (`sdk/typescript/src/domains/noto.ts:411,532`), interface decl (`solidity/contracts/domains/interfaces/INotoPrivate.sol:69,90`), one upstream example `examples/spend-lock-tokens/src/create-mint-lock.ts:95-196` (which would hit the revert), and two test contracts — no production consumer in upstream. Local mitigation: mint-lock path is unused on this platform (only generated ABI JSON in `Paladin/bond/src/abis/`, zero call sites).

---
Verified against upstream source at /home/ecs-user/eksplorasi-paladin/paladin; paladin-client = our downstream package, not upstream. Version markers found: no root `VERSION` file or root `package.json` (Go/Gradle monorepo); `git describe` = `paladin-operator-1.0.0-rc.12-322-g4ab578f3a` (commit `4ab578f3a`); SDK `sdk/typescript/package.json` version = `0.0.0` (placeholder).