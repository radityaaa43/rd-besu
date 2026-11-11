// S21 layer 5b: BI-side recreation of the three report groups {bank, BI} on the NEW nodes (zeto/src/flows.ts newGroup, externalCallsEnabled false).
// Run AFTER layer 5 (cross-node transport works). Prints only the new group ids (public). NEVER run against the old nodes (it submits txs).
// Env: S21_URL_1..S21_URL_3 = http://127.0.0.1:<forward port> of the NEW paladin-node1..3 (BI, bank A, bank B), S21_URL_4 = bank C.
import PaladinClient from "@lfdecentralizedtrust/paladin-sdk";
import { Party, newGroup } from "./src/flows";

const url = (n: number) => { const u = process.env[`S21_URL_${n}`]; if (!u) throw new Error(`S21_URL_${n} missing`); return u; };
const party = (n: number, lookup: string): Party => { const c = new PaladinClient({ url: url(n) }); return { lookup, c, v: c.getVerifiers(lookup)[0] }; };

(async () => {
  const bi = party(1, "bi@node1");
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const out: Record<string, string> = {};
  for (const [bank, n, lookup] of [["A", 2, "bankA@node2"], ["B", 3, "bankB@node3"], ["C", 4, "bankC@node4"]] as const) {
    const id = await newGroup(party(n, lookup), bi, `report-${bank}-s21-${stamp}`);
    out[bank] = id;
    console.log(`${new Date().toISOString()} report group ${bank} {${lookup}, bi@node1}: ${id}`);
  }
  console.log(JSON.stringify({ groups: out }));
})().catch((e) => { console.log(`FAIL: ${String(e?.message ?? e).slice(0, 300)}`); process.exit(1); });
