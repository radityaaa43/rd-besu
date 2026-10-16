// Compares a BondTracker's private balances with the Noto token's. The tracker is updated by a
// hook transaction that runs AFTER the base-ledger movement confirmed (events.go@v1.0.0:258-268),
// so a failed hook leaves the two out of step; this finds that.
export interface AccountRow {
  account: string;
  noto: bigint; // Noto balanceOf: unlocked coins only
  tracker: bigint; // BondTracker balanceOf: unlocked + locked
  locked?: bigint; // BondTracker lockedBalanceOf; undefined on series deployed before the view existed
}

export interface Finding extends AccountRow {
  expectedNoto: bigint;
  delta: bigint; // noto - expectedNoto
  status: "OK" | "MISMATCH" | "UNVERIFIABLE";
}

export function reconcile(rows: AccountRow[]): Finding[] {
  return rows.map((r) => {
    const expectedNoto = r.tracker - (r.locked ?? 0n);
    const delta = r.noto - expectedNoto;
    // Without the locked view, tracker > noto may just be open locks: report it, do not call it OK.
    const status = delta === 0n ? "OK" : r.locked === undefined && delta < 0n ? "UNVERIFIABLE" : "MISMATCH";
    return { ...r, expectedNoto, delta, status };
  });
}
