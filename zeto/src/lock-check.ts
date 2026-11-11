// Core of the live Zeto V1 lock lifecycle check (S21 gate): createLock -> prepareSpendLock -> delegateLock -> cancelLock for ONE party.
// Pure and injectable (no SDK, no network) so test/lock-check.test.ts runs it offline; lock-check.ts wires the real helpers.
export type Receipt = { success?: boolean; failureMessage?: string } | undefined;
export type LockCheckDeps = {
  balance(): Promise<bigint>;
  createLock(amount: bigint): Promise<{ lockId: string }>;
  prepareSpend(lockId: string): Promise<unknown>;
  delegateToSelf(lockId: string): Promise<Receipt>;
  cancel(lockId: string): Promise<Receipt>;
};
export type LockCheckStep = "createLock" | "prepareSpendLock" | "delegateLock" | "cancelLock" | "balance";

export class LockCheckError extends Error {
  constructor(public readonly step: LockCheckStep, message: string) {
    super(message);
    this.name = "LockCheckError";
  }
}

// Node errors can quote ids and keys: no message leaves this module with a 32-byte hex string in it.
const scrub = (m: string) => m.replace(/0x[0-9a-fA-F]{64}/g, "0x<redacted>");
const msgOf = (e: unknown) => scrub(e instanceof Error ? e.message : String(e));

function receiptOk(r: Receipt): void {
  if (r?.success !== true) throw new Error(`receipt failed: ${r?.failureMessage ?? "no receipt"}`);
}

export async function runLockCheck(deps: LockCheckDeps, cfg: { amount: bigint }, log: (line: string) => void): Promise<void> {
  const at = async <T>(step: LockCheckStep, f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      throw e instanceof LockCheckError ? e : new LockCheckError(step, msgOf(e));
    }
  };
  const expectBalance = async (label: string, want: bigint) => {
    const got = await at("balance", () => deps.balance());
    log(`${label} balance=${got}`);
    if (got !== want) throw new LockCheckError("balance", `${label}: balance ${got}, expected ${want}`);
  };

  let lockId: string | undefined;
  let cancelTried = false;
  try {
    const b0 = await at("balance", () => deps.balance());
    log(`before balance=${b0}`);

    lockId = (await at("createLock", () => deps.createLock(cfg.amount))).lockId;
    if (!lockId) throw new LockCheckError("createLock", "no lock id returned");
    log(`createLock ok lockId=${lockId}`);
    await expectBalance("after createLock", b0 - cfg.amount); // locked coins leave balanceOf

    await at("prepareSpendLock", () => deps.prepareSpend(lockId!));
    log("prepareSpendLock ok");

    // PUBLIC delegateLock to the owner's OWN eth address (normally the Atom is the spender), so the owner can still cancel.
    await at("delegateLock", async () => receiptOk(await deps.delegateToSelf(lockId!)));
    log("delegateLock ok");
    await expectBalance("after delegateLock", b0 - cfg.amount);

    cancelTried = true;
    await at("cancelLock", async () => receiptOk(await deps.cancel(lockId!)));
    log("cancelLock ok");
    await expectBalance("after cancelLock", b0); // cancel leaves no lock
  } catch (err) {
    if (lockId && !cancelTried) {
      try {
        receiptOk(await deps.cancel(lockId));
        log("cleanup cancelLock ok");
      } catch (e) {
        log(`cleanup cancelLock FAILED: ${msgOf(e)}`);
      }
    }
    throw err;
  }
}
