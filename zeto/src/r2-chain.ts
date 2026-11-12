// R2-chain core (analyst row "R2-chain", 2026-11-12): ONE Zeto RD transfer A->B submitted through bank A's OWN gateway while BI (node1) is offline, then the same post-settlement
// report attempt Lensa makes. Pure and injectable (no SDK, no network) so test/r2-chain.test.ts runs it offline; r2-chain.ts wires the real calls.
// The report failing is an OBSERVATION (groupmgr/manager.go:157-181: a send to an unreachable member rolls back, no queue), never an error here and never retried.
export type R2Settled = { success?: boolean; transactionHash?: string; blockNumber?: number; failureMessage?: string } | undefined;
export type R2Deps = {
  biDown(): Promise<boolean>;
  balanceA(): Promise<bigint>;
  transfer(amount: number): Promise<R2Settled>;
  report(): Promise<unknown>;
};
export type R2Step = "config" | "guard" | "transfer";
export class R2ChainError extends Error {
  constructor(public readonly step: R2Step, message: string) {
    super(message);
    this.name = "R2ChainError";
  }
}
const scrub = (m: string) => m.replace(/0x[0-9a-fA-F]{64}/g, "0x<redacted>");
const AMOUNT = 1;

export async function runR2Chain(deps: R2Deps, cfg: { execute: boolean; amount: number }, log: (l: string) => void): Promise<{ settled: boolean; report: string; balanceOk: boolean }> {
  if (cfg.amount !== AMOUNT) throw new R2ChainError("config", `amount must be ${AMOUNT}`);
  const down = await deps.biDown();
  log(`node1 (BI) down: ${down}`);
  if (!cfg.execute) {
    log(`DRY RUN: A balance ${await deps.balanceA()}; nothing sent`);
    return { settled: false, report: "not run", balanceOk: false };
  }
  if (!down) throw new R2ChainError("guard", "node1 answers: refusing to send (the real run needs BI offline)");
  const before = await deps.balanceA();
  const s = await deps.transfer(AMOUNT);
  if (s?.success !== true) throw new R2ChainError("transfer", scrub(`transfer failed: ${s?.failureMessage ?? "no receipt"}`));
  const after = await deps.balanceA();
  const balanceOk = after === before - BigInt(AMOUNT);
  log(`transfer A->B amount ${AMOUNT}: tx ${s.transactionHash} success=true block=${s.blockNumber}`);
  log(`balance A before ${before} after ${after}${balanceOk ? " ok" : " MISMATCH"}`);
  let report: string;
  try {
    await deps.report();
    report = "accepted";
  } catch (e) {
    const m = scrub(e instanceof Error ? e.message : String(e));
    report = `failed ${m.match(/PD\d{6}/)?.[0] ?? "unknown"}${m.match(/PD030015/) ? " (PD030015 GRPC connection failed)" : ""}`;
  }
  log(`report attempt (topic zeto-report-v1): ${report}`);
  return { settled: true, report, balanceOk };
}
