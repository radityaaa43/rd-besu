// Live E2E for the Zeto model against the REAL server on :8790. Run ONLY under the Paladin lock:
//   cd web && flock /tmp/lensa-paladin.lock npx playwright test -c playwright.live.config.ts e2e/live/zeto.live.spec.ts
// Small amounts, each flow once. UI facts are dumped to OUT/zeto-<flow>.json for the chain cross-check script.
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const OUT = '/tmp/claude-1000/-home-ecs-user-project-rd-platform-ekplorasi-besu/821d83c9-e7ea-4692-9b81-95c7126fe71d/scratchpad/e2e';
const KUBE = { ...process.env, KUBECONFIG: '/home/ecs-user/alibaba-kube/alibaba.yaml' };
const restarts = () => execSync('kubectl -n paladin get pods --no-headers', { env: KUBE, encoding: 'utf8' }).trim().split('\n')
  .map((l) => { const c = l.split(/\s+/); return `${c[0]}=${c[3]}`; }).join(' ');

type P = 'BI' | 'A' | 'B' | 'C';
interface Case { flow: string; title: string; from: P; to: P; amount: string; asset: 'RD' | 'DFABI'; issuer: boolean; dvp: boolean }
const CASES: Case[] = [
  { flow: 'rd-issue', title: 'Penerbitan RD', from: 'BI', to: 'C', amount: '1000', asset: 'RD', issuer: true, dvp: false },
  { flow: 'rd-transfer', title: 'Transfer RD', from: 'A', to: 'B', amount: '1000', asset: 'RD', issuer: false, dvp: false },
  { flow: 'dfabi-issue', title: 'Penerbitan seri DFABI', from: 'BI', to: 'C', amount: '3', asset: 'DFABI', issuer: true, dvp: false },
  { flow: 'dfabi-transfer', title: 'Transfer DFABI', from: 'A', to: 'B', amount: '2', asset: 'DFABI', issuer: false, dvp: false },
  { flow: 'dvp', title: 'DvP DFABI ↔ RD', from: 'A', to: 'B', amount: '1', asset: 'DFABI', issuer: false, dvp: true },
];
const STEP_LABELS = ['Bangun bukti ZK', 'Kirim ke node Paladin', 'Masuk block Besu', 'Laporan BI terverifikasi'];
const digits = (s: string | null) => (s ?? '').replace(/\D/g, '');

test.describe.configure({ mode: 'serial' }); // a failure (incl. a pod restart) stops the remaining flows
let before = '';
test.beforeAll(() => { mkdirSync(OUT, { recursive: true }); before = restarts(); console.log('restarts before:', before); });
test.afterEach(() => { const now = restarts(); console.log('restarts now:', now); expect(now, 'Paladin pod restart count changed').toBe(before); });

async function lensFacts(page: Page, name: string) {
  const l = page.locator('button.lens', { has: page.locator('h5', { hasText: name }) });
  await expect(l).toHaveCount(1);
  return {
    party: name,
    cls: (await l.getAttribute('class')) ?? '',
    who: (await l.locator('.who').textContent()) ?? '',
    valFirst: await l.locator('.val').evaluate((el) => el.firstChild?.textContent ?? ''),
    valText: (await l.locator('.val').textContent()) ?? '',
    redacted: (await l.locator('.val .redact').count()) > 0,
    line: (await l.locator('.line').textContent()) ?? '',
    verdict: (await l.locator('.verdict').textContent()) ?? '',
  };
}

for (const c of CASES) {
  test(`zeto ${c.flow}`, async ({ page, request }) => {
    const meta = await (await request.get('/api/meta')).json();
    const nm = (id: P) => meta.parties[id].name as string;
    const uiErrors: string[] = [];
    page.on('pageerror', (e) => uiErrors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) uiErrors.push(m.text()); });
    page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) uiErrors.push(`${r.status()} ${r.url()}`); }); // /favicon.ico 404 is a known UI nit

    await page.goto('/');
    await page.getByRole('button', { name: 'Besu', exact: true }).click();
    await page.getByRole('button', { name: 'Zeto', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Zeto', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: c.title, exact: true }).click();
    await page.locator('aside .roles button', { hasText: nm(c.from) }).click();
    await page.locator('#to').selectOption({ label: nm(c.to) });
    await page.locator('#amount').fill(c.amount);
    await expect(page.getByRole('heading', { level: 2, name: c.title })).toBeVisible();

    // request JSON shown before sending
    const pre = page.locator('section[aria-label="Susun transaksi"] pre');
    const reqText = (await pre.textContent()) ?? '';
    expect(reqText).toContain('POST /api/tx');
    expect(JSON.parse(reqText.replace('POST /api/tx', ''))).toEqual({ model: 'zeto', flow: c.flow, from: c.from, to: c.to, amount: c.amount });

    const go = page.locator('button.go');
    await expect(go).toBeEnabled();
    await go.click();
    await expect(go).toHaveText('Memproses di network…'); // spinner state while running

    // done = 4 ok steps, or an ERROR response
    const steps = page.getByRole('region', { name: 'Proses' }).locator('li');
    await page.waitForFunction(() => document.querySelectorAll('section[aria-label="Proses"] li.ok').length === 4
      || (document.querySelector('section[aria-label="Susun transaksi"] pre')?.textContent ?? '').includes('"ERROR"'), null, { timeout: 14 * 60_000 });
    // the result event (which flips to the Response tab) arrives just after the 4th step is marked ok
    await expect(page.getByRole('tab', { name: 'Response' })).toHaveAttribute('aria-selected', 'true');
    const resText = (await pre.textContent()) ?? '';
    expect(resText, `UI showed an error: ${resText}`).not.toContain('"ERROR"');
    await expect(page.locator('section[aria-label="Proses"] li.ok')).toHaveCount(4);
    for (let i = 0; i < 4; i++) await expect(steps.nth(i)).toContainText(STEP_LABELS[i]!);
    await expect(go).toHaveText(c.issuer ? 'Terbitkan' : c.dvp ? 'Jalankan DvP' : 'Kirim'); // spinner gone

    // response JSON
    await expect(page.getByRole('tab', { name: 'Response' })).toHaveAttribute('aria-selected', 'true');
    const res = JSON.parse(resText);
    expect(res.status).toBe('SUCCESS');
    expect(res.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Number.isInteger(res.block) && res.block > 0).toBe(true);
    expect(Object.keys(res.timings_ms)).toEqual(STEP_LABELS);
    for (const v of Object.values(res.timings_ms)) expect(typeof v).toBe('number');

    // lenses: 4 cards, verdicts follow Zeto's claim
    await expect(page.locator('button.lens')).toHaveCount(4);
    const banks = (['A', 'B', 'C'] as P[]).filter((b) => b !== c.from && b !== c.to);
    const want: { id: P; role: string; cls: string; verdict: string; seesAmount: boolean }[] = [
      { id: c.from, role: c.issuer ? 'Penerbit & pengawas' : c.dvp ? 'Penjual DFABI' : 'Pengirim', cls: 'clear', verdict: 'Terbaca utuh', seesAmount: true },
      { id: c.to, role: c.dvp ? 'Pembeli DFABI' : 'Penerima', cls: 'clear', verdict: 'Terbaca utuh', seesAmount: true },
      ...banks.map((id) => ({ id, role: 'Tidak terlibat', cls: 'sealed', verdict: 'Tersegel', seesAmount: false })),
    ];
    if (!c.issuer) want.push({ id: 'BI', role: 'Pengawas', cls: 'clear', verdict: 'Laporan terverifikasi', seesAmount: true });
    expect(want).toHaveLength(4);
    const expectAmt = c.asset === 'RD' ? digits(c.amount) : c.amount;

    const lenses: Record<string, unknown>[] = [];
    for (const w of want) {
      const f = await lensFacts(page, nm(w.id));
      lenses.push({ id: w.id, ...f });
      expect.soft(f.cls, `${w.id} class`).toContain(w.cls);
      expect.soft(f.verdict.trim(), `${w.id} verdict`).toBe(w.verdict);
      expect.soft(f.who, `${w.id} role label`).toContain(w.role);
      if (w.seesAmount) {
        expect.soft(f.redacted, `${w.id} amount visible`).toBe(false);
        expect.soft(digits(f.valFirst), `${w.id} amount`).toBe(expectAmt);
        if (c.dvp) expect.soft(digits(f.valText), `${w.id} dvp leg`).toBe(expectAmt + (BigInt(c.amount) * 1_000_000n).toString());
      } else {
        expect.soft(f.redacted, `${w.id} amount redacted`).toBe(true);
        expect.soft(f.line.trim(), `${w.id} counterparty`).toBe('Pihak tidak terbaca');
      }
    }
    // counterparty lines: BI reads both sides from its ledger; a bank reads only what its own node holds,
    // and a Zeto UTXO does not name its sender (server/src/adapters/zeto.ts)
    const byId = Object.fromEntries(lenses.map((l) => [l.id as string, l as { line: string }]));
    if (c.issuer) {
      expect.soft(byId[c.from]!.line).toBe(`diterbitkan untuk ${nm(c.to)}`);
      expect.soft(byId[c.to]!.line).toBe('Pengirim tidak tercantum di UTXO');
    } else {
      expect.soft(byId[c.from]!.line).toBe(`${c.dvp ? 'jual ke' : 'ke'} ${nm(c.to)}`);
      expect.soft(byId[c.to]!.line).toBe('Pengirim tidak tercantum di UTXO');
      expect.soft(byId.BI!.line).toBe(`${nm(c.from)} → ${nm(c.to)}`);
    }

    // detail panel per lens: tx hash + commitments from chain, no raw HTML or backticks
    const details: Record<string, unknown> = {};
    for (const w of want) {
      await page.locator('button.lens', { has: page.locator('h5', { hasText: nm(w.id) }) }).click();
      const d = page.locator('.detail');
      await expect(d).toBeVisible();
      const txt = (await d.textContent()) ?? '';
      expect.soft(txt, `${w.id} detail has stray markup`).not.toMatch(/[`<>]|&lt;|&gt;/);
      await expect.soft(d.locator('li').first().locator('code')).toHaveAttribute('title', res.txHash);
      expect.soft(txt).toContain(`block ${res.block}`);
      const items = await d.locator('li').evaluateAll((els) => els.map((e) => ({ text: e.textContent ?? '', title: e.querySelector('code')?.getAttribute('title') ?? '' })));
      expect.soft(items.filter((i) => i.text.startsWith('Commitment')).length, `${w.id} commitments listed`).toBeGreaterThan(0);
      details[w.id] = { method: await d.locator('p').first().textContent(), items };
    }

    await page.screenshot({ path: `${OUT}/zeto-${c.flow}.png`, fullPage: true });
    writeFileSync(`${OUT}/zeto-${c.flow}.json`, JSON.stringify({ flow: c.flow, from: c.from, to: c.to, amount: c.amount, txHash: res.txHash, block: res.block, timings_ms: res.timings_ms, lenses, details, uiErrors }, null, 2));
    expect(uiErrors, 'browser console/page errors').toEqual([]);
  });
}
