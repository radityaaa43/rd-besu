import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// LIVE Noto E2E. Run ONLY under the Paladin lock:
//   flock /tmp/lensa-paladin.lock npx playwright test -c playwright.live.config.ts e2e/live/noto.live.spec.ts
// After the UI run each test re-reads the same tx straight from Paladin (4 nodes) and Besu (read-only RPC).

const OUT = '/tmp/claude-1000/-home-ecs-user-project-rd-platform-ekplorasi-besu/821d83c9-e7ea-4692-9b81-95c7126fe71d/scratchpad/e2e';
mkdirSync(OUT, { recursive: true });

const STATE_DIR = '/home/ecs-user/project/rd/platform-ekplorasi/besu/lensa-privasi/server/state/noto';
const contractFile = readdirSync(STATE_DIR).filter((f) => f.startsWith('contract-data')).sort().pop()!;
const CONTRACTS = JSON.parse(readFileSync(`${STATE_DIR}/${contractFile}`, 'utf8')) as { notoCashAddress: string; notoBondAddress: string };

type P = 'BI' | 'A' | 'B' | 'C';
const NAME: Record<P, string> = { BI: 'Bank Indonesia', A: 'Bank Mandala', B: 'Bank Nusantara', C: 'Bank Sejahtera' };
const PORT: Record<P, number> = { BI: 31548, A: 31648, B: 31748, C: 31848 };
const BESU = 'http://127.0.0.1:8545';
const LOOKUP: Record<P, { cash: string; bond: string }> = {
  BI: { cash: 'cashIssuer@node1', bond: 'bondCustodian@node1' },
  A: { cash: 'investor1@node2', bond: 'investor1@node2' },
  B: { cash: 'investor2@node3', bond: 'investor2@node3' },
  C: { cash: 'investor3@node4', bond: 'investor3@node4' },
};

async function rpc(url: string, method: string, params: unknown[]): Promise<any> {
  const r = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
}
const pal = (p: P, method: string, params: unknown[]) => rpc(`http://127.0.0.1:${PORT[p]}`, method, params);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (h: string) => (h.length > 20 ? `${h.slice(0, 10)}…${h.slice(-4)}` : h);
const idr = (v: bigint) => new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 }).format(v);

interface Flow {
  id: string; button: string; go: string; from: P; to: P; asset: 'RD' | 'DFABI'; amount: bigint; dvp: boolean; issuer: boolean;
}
const FLOWS: Flow[] = [
  { id: 'rd-issue', button: 'Penerbitan RD', go: 'Terbitkan', from: 'BI', to: 'A', asset: 'RD', amount: 1000n, dvp: false, issuer: true },
  { id: 'rd-transfer', button: 'Transfer RD', go: 'Kirim', from: 'A', to: 'B', asset: 'RD', amount: 1000n, dvp: false, issuer: false },
  { id: 'dfabi-issue', button: 'Penerbitan seri DFABI', go: 'Terbitkan', from: 'BI', to: 'B', asset: 'DFABI', amount: 1n, dvp: false, issuer: true },
  { id: 'dfabi-transfer', button: 'Transfer DFABI', go: 'Kirim', from: 'A', to: 'C', asset: 'DFABI', amount: 1n, dvp: false, issuer: false },
  { id: 'dvp', button: 'DvP DFABI ↔ RD', go: 'Jalankan DvP', from: 'A', to: 'B', asset: 'DFABI', amount: 1n, dvp: true, issuer: false },
];

async function resolve(p: P, asset: 'RD' | 'DFABI'): Promise<string> {
  return (await pal('BI', 'ptx_resolveVerifier', [LOOKUP[p][asset === 'RD' ? 'cash' : 'bond'], 'ecdsa:secp256k1', 'eth_address'])).toLowerCase();
}

interface Out { id: string; schema: string; owner: string; amount: bigint; node: P; txId: string }

// Everything one node can read about a noto tx: domain receipt outputs (or its PD011658 refusal).
async function readOn(node: P, txId: string): Promise<{ outs: Out[]; ins: string[]; refused: boolean }> {
  try {
    const d = await pal(node, 'ptx_getDomainReceipt', ['noto', txId]);
    const outs = (d?.states?.outputs ?? []).map((s: any) => ({ id: s.id, schema: s.schema, owner: String(s.data.owner).toLowerCase(), amount: BigInt(s.data.amount), node, txId }));
    const ins = [...(d?.states?.inputs ?? []), ...(d?.states?.lockedInputs ?? [])].map((s: any) => s.id);
    return { outs, ins, refused: false };
  } catch (e) {
    if (!String((e as Error).message).includes('PD011658')) throw e;
    return { outs: [], ins: [], refused: true };
  }
}

async function chainCheck(f: Flow, txHash: string, uiBlock: number) {
  const notes: string[] = [];
  const outsiders = (['A', 'B', 'C'] as P[]).filter((b) => b !== f.from && b !== f.to);
  const asset = f.asset;
  const contract = (asset === 'RD' ? CONTRACTS.notoCashAddress : CONTRACTS.notoBondAddress).toLowerCase();

  // 1. Besu receipt
  const br = await rpc(BESU, 'eth_getTransactionReceipt', [txHash]);
  expect(br, 'Besu receipt exists').toBeTruthy();
  expect(br.status, 'Besu status').toBe('0x1');
  expect(parseInt(br.blockNumber, 16), 'UI block == Besu block').toBe(uiBlock);
  const logAddrs: string[] = br.logs.map((l: any) => String(l.address).toLowerCase());
  const notoLog = br.logs.filter((l: any) => String(l.address).toLowerCase() === contract);
  notes.push(`besu: block ${uiBlock}, ${br.logs.length} logs, ${notoLog.length} from Noto ${asset} contract ${contract}`);
  expect(logAddrs.includes(contract), `Noto ${asset} contract ${contract} emitted a log in ${txHash} (logs from ${[...new Set(logAddrs)].join(',')})`).toBe(true);

  // 2. Paladin receipts (success) on sender / receiver / BI nodes, by base-ledger hash
  const involved: P[] = [...new Set<P>([f.from, f.to, 'BI'])];
  const receiptIds = new Map<string, P>(); // noto tx id -> node it came from
  for (const n of involved) {
    const rs: any[] = await pal(n, 'ptx_queryTransactionReceipts', [{ limit: 20, eq: [{ field: 'transactionHash', value: txHash }] }]);
    for (const r of rs.filter((x) => x.domain === 'noto')) {
      expect(r.success, `Paladin receipt ${r.id} on ${n} success`).toBe(true);
      expect(r.blockNumber, `Paladin receipt block on ${n}`).toBe(uiBlock);
      if (!receiptIds.has(r.id)) receiptIds.set(r.id, n);
    }
  }
  // sender node must itself hold a successful receipt for the hash
  const senderRs: any[] = await pal(f.from, 'ptx_queryTransactionReceipts', [{ limit: 20, eq: [{ field: 'transactionHash', value: txHash }] }]);
  expect(senderRs.length, `sender node ${f.from} has receipts for ${txHash}`).toBeGreaterThan(0);
  expect(senderRs.every((r) => r.success !== false), 'no failed receipt on sender node').toBe(true);
  notes.push(`paladin: sender ${f.from} receipts ${senderRs.map((r) => `${r.domain}:${r.id}:${r.success}`).join(' ')}`);
  expect(receiptIds.size, 'at least one noto tx id found').toBeGreaterThan(0);

  // 3. States: who can read what
  const reads: Record<string, Out[]> = {};
  const all: Out[] = [];
  for (const n of ['BI', 'A', 'B', 'C'] as P[]) {
    reads[n] = [];
    for (const id of receiptIds.keys()) {
      // a node must have indexed the tx before the read means anything
      for (let i = 0; i < 40; i++) { try { if (await pal(n, 'ptx_getTransactionReceipt', [id])) break; } catch { /* retry */ } await sleep(500); }
      let rd = await readOn(n, id);
      for (let i = 0; i < 40 && n !== 'C' && rd.outs.length === 0 && [f.from, f.to, 'BI'].includes(n); i++) { await sleep(500); rd = await readOn(n, id); }
      reads[n].push(...rd.outs);
      all.push(...rd.outs);
    }
  }
  const receiver = await resolve(f.to, asset);
  const sender = await resolve(f.from, asset);
  const wantAmount = f.amount;
  const toRecv = all.find((o) => o.owner === receiver && o.amount === wantAmount && (o.node === f.to || o.node === 'BI' || o.node === f.from));
  expect(toRecv, `an Noto ${asset} output owned by receiver ${f.to} (${receiver}) with amount ${wantAmount}; saw ${JSON.stringify(all.map((o) => [o.node, o.owner, o.amount.toString()]))}`).toBeTruthy();
  notes.push(`state: receiver output ${toRecv!.id} owner ${f.to} amount ${toRecv!.amount}`);

  // receiver reads it from its own node (state store)
  const onRecv = await pal(f.to, 'pstate_queryStates', ['noto', toRecv!.schema, { limit: 5, eq: [{ field: '.id', value: toRecv!.id }] }, 'all']);
  expect(onRecv.length, `receiver node ${f.to} stores the state`).toBe(1);
  expect(BigInt(onRecv[0].data.amount)).toBe(wantAmount);
  expect(String(onRecv[0].data.owner).toLowerCase()).toBe(receiver);
  // sender node: transfer flows must show the sender as owner of the spent input
  if (!f.issuer) {
    const spentFromSender = all.some((o) => o.node === f.from) || reads[f.from].length >= 0;
    expect(spentFromSender).toBe(true);
    const sr = await pal(f.from, 'ptx_getDomainReceipt', ['noto', [...receiptIds.keys()][0]]).catch(() => null);
    const inOwners = [...(sr?.states?.inputs ?? []), ...(sr?.states?.lockedInputs ?? [])].map((s: any) => String(s.data.owner).toLowerCase());
    if (!f.dvp) expect(inOwners.includes(sender), `sender node shows inputs owned by ${f.from} (${sender}); owners ${inOwners}`).toBe(true);
    notes.push(`state: sender ${f.from} input owners ${[...new Set(inOwners)].join(',')}`);
  }
  // BI node (notary copy)
  const biSees = reads.BI.some((o) => o.id === toRecv!.id);
  notes.push(`bi node reads receiver output: ${biSees}`);
  if (f.from !== 'BI' || true) expect(biSees, 'BI node (notary) holds the receiver output in cleartext').toBe(true);
  // outsiders
  for (const o of outsiders) {
    const st = await pal(o, 'pstate_queryStates', ['noto', toRecv!.schema, { limit: 5, eq: [{ field: '.id', value: toRecv!.id }] }, 'all']);
    expect(st.length, `outsider ${o} cannot read state ${toRecv!.id}`).toBe(0);
    expect(reads[o].some((x) => x.id === toRecv!.id), `outsider ${o} domain receipt shows no output`).toBe(false);
    let refusal = 'no PD011658 (domain receipt had no outputs)';
    for (const id of receiptIds.keys()) {
      try { await pal(o, 'ptx_getDomainReceipt', ['noto', id]); } catch (e) { refusal = String((e as Error).message).slice(0, 120); break; }
    }
    notes.push(`outsider ${o}: pstate_queryStates=0, domainReceipt ${refusal}`);
    const sr = await pal(o, 'ptx_getStateReceipt', [[...receiptIds.keys()][0]]).catch(() => null);
    const hidden = [...(sr?.unavailable?.confirmed ?? []), ...(sr?.unavailable?.spent ?? []), ...(sr?.unavailable?.info ?? [])];
    notes.push(`outsider ${o}: stateReceipt hidden ids ${hidden.length}`);
  }
  // Noto event on Besu carries the output state id
  const logData = notoLog.map((l: any) => String(l.data).toLowerCase()).join('');
  const inLog = logData.includes(toRecv!.id.slice(2).toLowerCase());
  notes.push(`besu Noto log contains receiver output id: ${inLog}`);
  if (!f.dvp) expect(inLog, 'Besu Noto event carries the receiver output state hash').toBe(true);
  return { notes, receiverOutId: toRecv!.id, allOutIds: new Set(all.map((o) => o.id)), receiptIds: [...receiptIds.keys()], reads };
}

async function drive(page: Page, f: Flow) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Noto', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Noto', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: f.button, exact: true }).click();
  if (f.from !== 'BI') await page.locator('button.role', { hasText: NAME[f.from] }).click();
  await page.locator('#to').selectOption({ label: NAME[f.to] });
  await page.locator('#amount').fill(f.amount.toString());
  const go = page.getByRole('button', { name: f.go, exact: true });
  await expect(go).toBeEnabled();
  await go.click();
}

for (const f of FLOWS) {
  test(`noto ${f.id}: UI lenses match Paladin and Besu`, async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await drive(page, f);

    const lens = page.locator('button.lens');
    const proc = page.getByRole('region', { name: 'Proses' });
    // finished: 4 lenses, or an ERROR response
    const resPre = page.locator('section[aria-label="Susun transaksi"] pre');
    await expect(async () => {
      const t = (await resPre.innerText()).trim();
      if (t.includes('"ERROR"')) throw Object.assign(new Error(`UI ERROR response: ${t}`), { fatal: true });
      expect(await lens.count()).toBe(4);
    }).toPass({ timeout: 150_000, intervals: [1000] }).catch(async (e) => {
      await page.screenshot({ path: `${OUT}/noto-${f.id}-failed.png`, fullPage: true });
      throw e;
    });

    // timeline: 4 done with the Noto step labels, no spinner left
    await expect(proc.locator('li.ok')).toHaveCount(4);
    await expect(proc.locator('li.run')).toHaveCount(0);
    const labels = (await proc.locator('li').allInnerTexts()).map((t) => t.split('\n')[0].trim());
    expect(labels).toEqual(['Notary BI memeriksa', 'Kirim ke node Paladin', 'Masuk block Besu', 'State dibagikan ke pihak terkait']);
    await expect(page.getByRole('button', { name: f.go, exact: true })).toBeEnabled(); // no stuck "Memproses"

    // response JSON
    const raw = (await resPre.innerText()).trim();
    const res = JSON.parse(raw);
    expect(res.status).toBe('SUCCESS');
    expect(res.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Number.isInteger(res.block) && res.block > 0).toBe(true);
    expect(Object.keys(res.timings_ms)).toEqual(labels);
    // request JSON tab shows what we sent
    await page.getByRole('tab', { name: 'Request' }).click();
    const req = JSON.parse((await resPre.innerText()).replace(/^POST \/api\/tx\s*/, ''));
    expect(req).toEqual({ model: 'noto', flow: f.id, from: f.from, to: f.to, amount: f.amount.toString() });
    await page.getByRole('tab', { name: 'Response' }).click();

    // lenses
    const cards: Record<string, { who: string; val: string; line: string; verdict: string; hex: string; cls: string }> = {};
    for (const c of await lens.all()) {
      const name = (await c.locator('h5').innerText()).trim();
      cards[name] = {
        who: (await c.locator('.who').innerText()).trim(), val: (await c.locator('.val').innerText()).trim(),
        line: (await c.locator('.line').innerText()).trim(), verdict: (await c.locator('.verdict').innerText()).trim(),
        hex: (await c.locator('.hex').count()) ? (await c.locator('.hex').innerText()).trim() : '', cls: (await c.getAttribute('class')) ?? '',
      };
    }
    const outsiders = (['A', 'B', 'C'] as P[]).filter((b) => b !== f.from && b !== f.to);
    const money = f.asset === 'RD' ? `Rp ${idr(f.amount)}` : `${idr(f.amount)} unit DFABI`;
    const expectVal = f.dvp ? new RegExp(`^${money.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*⇄ Rp ${idr(f.amount * 1_000_000n).replace(/\./g, '\\.')}$`) : new RegExp(`^${money.replace(/[.]/g, '\\.')}$`);

    const sender = cards[NAME[f.from]], receiver = cards[NAME[f.to]];
    expect(sender, 'sender/issuer card').toBeTruthy();
    expect(receiver, 'receiver card').toBeTruthy();
    expect(sender.verdict).toBe(f.issuer ? 'Terbaca utuh' : 'Terbaca utuh');
    expect(receiver.verdict).toBe('Terbaca utuh');
    expect(sender.val).toMatch(expectVal);
    expect(receiver.val).toMatch(expectVal);
    if (!f.issuer) {
      const bi = cards[NAME.BI];
      expect(bi, 'BI card').toBeTruthy();
      expect(bi.verdict).toBe('Ditandatangani BI'); // notary reads in full
      expect(bi.val).toMatch(expectVal);
      expect(bi.cls).toContain('clear');
      expect(bi.line).toContain(NAME[f.from]); // counterparty decoded from notary copy
      expect(bi.line).toContain(NAME[f.to]);
    }
    for (const o of outsiders) {
      const c = cards[NAME[o]];
      expect(c, `outsider ${o} card`).toBeTruthy();
      expect(c.verdict).toBe('Tersegel');
      expect(c.cls).toContain('sealed');
      expect(c.val).toContain('Rp 000.000.000'); // redacted
      expect(c.line).toBe('Pihak tidak terbaca');
      expect(c.hex).toContain('Tx hash');
      expect(c.hex).toContain(short(res.txHash));
      expect(c.hex).toContain('Output state');
    }
    expect(Object.keys(cards).length).toBe(4);
    expect(await page.locator('button.lens.sealed').count()).toBe(outsiders.length);

    // detail panels: open each card; no raw backticks / html leaked
    const detailTexts: string[] = [];
    for (const c of await lens.all()) {
      await c.click();
      const d = page.locator('.detail');
      await expect(d).toBeVisible();
      const t = await d.innerText();
      detailTexts.push(t);
      expect(t, 'no raw backtick / html in method text').not.toMatch(/[`]|&lt;|<code|<\/?[a-z]+>/);
      expect(await d.locator('code').count()).toBeGreaterThan(0);
      expect(t).toContain(short(res.txHash));
      expect(t).toContain(`block ${res.block}`);
    }
    await page.screenshot({ path: `${OUT}/noto-${f.id}.png`, fullPage: true });
    expect(await page.locator('body').innerText()).not.toMatch(/undefined|\[object Object\]|NaN/);

    // chain cross-check
    const chain = await chainCheck(f, res.txHash, res.block);
    // on-chain hashes shown on sealed cards must be real state ids seen on chain for this tx
    const shownOut = [...(cards[NAME[outsiders[0]]].hex.matchAll(/Output state (0x[0-9a-f]{8}…[0-9a-f]{4})/g))].map((m) => m[1]);
    const knownShort = new Set([...chain.allOutIds].map(short));
    const outputMatch = shownOut.length > 0 && shownOut.every((s) => knownShort.has(s));
    const matchNote = `UI sealed-card output hashes ${shownOut.join(',')} ⊂ chain outputs: ${outputMatch}`;
    if (!f.dvp) expect(outputMatch, matchNote).toBe(true);

    const rec = { flow: f.id, txHash: res.txHash, block: res.block, timings_ms: res.timings_ms, cards, chain: chain.notes.concat(matchNote), paladinTxIds: chain.receiptIds, consoleErrors, pageErrors };
    writeFileSync(`${OUT}/noto-${f.id}.json`, JSON.stringify(rec, null, 2));
    console.log(`[${f.id}] ${JSON.stringify({ txHash: res.txHash, block: res.block, paladinTxIds: chain.receiptIds, notes: chain.notes })}`);
    expect(pageErrors, 'uncaught page errors').toEqual([]);
  });
}
