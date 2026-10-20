import { readFile } from 'node:fs/promises';
import { expect as baseExpect, test, type Page } from '@playwright/test';

// the live config allows 10 min per assertion; keep the default tight, long waits pass their own timeout
const expect = baseExpect.configure({ timeout: 15_000 });

// Live E2E for the shell + Stress (TPS) menu against the real server on :8790.
// Tests that run a stress run use the smallest tx counts the reported capacity allows.
// Paladin-backed models (noto, zeto) must be wrapped in: flock /tmp/lensa-paladin.lock ...
const SHOTS = '/tmp/claude-1000/-home-ecs-user-project-rd-platform-ekplorasi-besu/821d83c9-e7ea-4692-9b81-95c7126fe71d/scratchpad/e2e';
const BESU = 'http://127.0.0.1:8545';
const PALADIN = [31548, 31648, 31748, 31848].map((p) => `http://127.0.0.1:${p}`);
const ANNOUNCER = '0x0EB83CC61eD4cAd09Ab773fB9Ea4407265C26E6A'; // server/state/stealth.json deployed.announcer
type ModelId = 'zeto' | 'noto' | 'stealth';
const NAME: Record<ModelId, string> = { zeto: 'Zeto', noto: 'Noto', stealth: 'Stealth' };
const ID = 'id-ID';
const f = (x: number, d = 1) => x.toLocaleString(ID, { minimumFractionDigits: d, maximumFractionDigits: d });

interface Summary { ok: number; failed: number; avgTps: number; peakTps: number; p50Ms: number; p95Ms: number; durationS: number }
interface Snap { state: 'running' | 'done' | 'stopped'; config: { models: ModelId[]; count: number }; models: Record<string, { status: string; summary: Summary; firstError?: string; reason?: string }> }

async function rpc(url: string, method: string, params: unknown[]) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json() as { result?: any; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const head = async () => parseInt(await rpc(BESU, 'eth_blockNumber', []), 16);

// What the chain holds for one model right now: stealth = announcer logs; paladin models = receipts (id -> tx hash) across the 4 nodes.
async function chainMark(m: ModelId) {
  if (m === 'stealth') {
    const h = await head();
    return { block: h, ids: new Map<string, string>() };
  }
  const ids = new Map<string, string>();
  for (const url of PALADIN) {
    const rs = await rpc(url, 'ptx_queryTransactionReceipts', [{ limit: 300, sort: ['sequence DESC'] }]);
    for (const x of rs) if (x.domain === m) ids.set(x.id, x.transactionHash);
  }
  return { block: await head(), ids };
}
async function chainDelta(m: ModelId, before: Awaited<ReturnType<typeof chainMark>>) {
  if (m === 'stealth') {
    const logs = await rpc(BESU, 'eth_getLogs', [{ address: ANNOUNCER, fromBlock: '0x' + (before.block + 1).toString(16), toBlock: 'latest' }]);
    return { count: logs.length as number, onBesuOk: new Set<string>(logs.map((l: any) => l.transactionHash)).size };
  }
  const after = await chainMark(m);
  const fresh = [...after.ids].filter(([id]) => !before.ids.has(id));
  let onBesuOk = 0;
  for (const [, hash] of fresh) {
    const rc = await rpc(BESU, 'eth_getTransactionReceipt', [hash]);
    if (rc?.status === '0x1') onBesuOk++;
  }
  return { count: fresh.length, onBesuOk };
}
const apiCapacity = async (): Promise<Partial<Record<ModelId, number>>> => (await fetch('http://127.0.0.1:8790/api/preflight-capacity')).json();
const apiStress = async (): Promise<Snap> => (await fetch('http://127.0.0.1:8790/api/stress')).json();

async function openStress(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Stress test TPS' }).click();
  await expect(page.getByRole('complementary', { name: 'Konfigurasi stress test' })).toBeVisible();
  // capacity badges are loaded asynchronously
  await expect(page.locator('.mchk small').first()).not.toHaveText('');
}
const chip = (page: Page, m: ModelId) => page.locator('.mchk button').filter({ hasText: NAME[m] });
async function pickModels(page: Page, models: ModelId[]) {
  for (const m of ['zeto', 'noto', 'stealth'] as ModelId[]) {
    const b = chip(page, m);
    const on = (await b.getAttribute('aria-pressed')) === 'true';
    if (on !== models.includes(m)) await b.click();
  }
}
async function configure(page: Page, models: ModelId[], count: number) {
  await pickModels(page, models);
  await page.locator('#tn').fill(String(count));
  await page.locator('#tn').blur();
  await page.getByRole('group', { name: 'Pengirim paralel' }).getByRole('button', { name: '1', exact: true }).click();
  await page.locator('#tlimit').selectOption('120');
}
const startBtn = (page: Page) => page.getByRole('button', { name: 'Mulai stress test' });

// UI results table -> api JSON -> csv, all must agree
async function assertResults(page: Page, snap: Snap, models: ModelId[]) {
  const rows = page.locator('table.res tbody tr');
  const csvText = await (async () => {
    const dl = page.waitForEvent('download');
    await page.getByRole('link', { name: /Unduh hasil/ }).click();
    const d = await dl;
    expect(d.suggestedFilename()).toBe('lensa-stress.csv');
    return readFile(await d.path(), 'utf8');
  })();
  const csv = csvText.trim().split('\n');
  expect(csv[0]).toBe('model,tps_avg,tps_peak,p50_s,p95_s,ok,failed,duration_s');
  for (const m of models) {
    const s = snap.models[m].summary;
    const row = rows.filter({ hasText: NAME[m] });
    const cells = (await row.locator('td').allInnerTexts()).map((t) => t.trim());
    expect.soft(cells, `UI row ${m}`).toEqual([NAME[m], f(s.avgTps), f(s.peakTps), `${f(s.p50Ms / 1000, 2)} s`, `${f(s.p95Ms / 1000, 2)} s`, s.ok.toLocaleString(ID), String(s.failed), `${Math.round(s.durationS)} s`]);
    // TPS = ok / elapsed (first submit -> last receipt), to rounding
    if (s.ok > 0) expect.soft(Math.abs(s.avgTps - s.ok / s.durationS), `TPS=ok/dur ${m}`).toBeLessThan(0.01);
    const line = csv.slice(1).find((l) => l.startsWith(NAME[m] + ','));
    expect.soft(line, `csv row ${m}`).toBe([NAME[m], s.avgTps.toFixed(2), s.peakTps.toFixed(2), (s.p50Ms / 1000).toFixed(2), (s.p95Ms / 1000).toFixed(2), s.ok, s.failed, s.durationS.toFixed(1)].join(','));
  }
  expect.soft(csv.length - 1, 'csv rows = models run').toBe(models.length);
  return csvText;
}

async function pickCheapModel(): Promise<ModelId> {
  const cap = await apiCapacity();
  if ((cap.stealth ?? 0) >= 2) return 'stealth';
  test.info().annotations.push({ type: 'deviation', description: `stealth capacity ${cap.stealth} < 2 (pool empty, --prepare not allowed): using noto instead` });
  return 'noto';
}

test.use({ viewport: { width: 1280, height: 900 } });

test('a. page shell: header, selectors, health, no console errors, layout at 1280 and 390', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 404/.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  // GET /api/stress is 404 until a first run exists (server/src/app.ts:249): recorded as a finding, not a failure
  const noRun = (url: string) => url.endsWith('/api/stress');
  let known404 = 0;
  page.on('response', (r) => { if (r.status() === 404 && noRun(r.url())) known404++; else if (r.status() >= 400) errors.push(`http ${r.status()} ${r.url()}`); });

  await page.goto('/');
  await expect(page.getByText('Lensa Privasi').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Demo transaksi' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stress test TPS' })).toBeVisible();

  const net = page.getByRole('complementary', { name: 'Pengaturan' });
  await expect(net.getByRole('button', { name: 'Besu', exact: true })).toBeEnabled();
  await expect(net.getByRole('button', { name: 'Besu', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const fx = net.getByRole('button', { name: /Fabric-X/ });
  await expect(fx).toBeDisabled();
  await expect(fx).toContainText('segera');

  for (const n of ['Zeto', 'Noto', 'Stealth']) await expect(net.getByRole('button', { name: n, exact: true })).toBeEnabled();
  await expect(net.locator('.roles button')).toHaveCount(4);
  expect(await net.locator('button.flow').count()).toBeGreaterThanOrEqual(5);

  // health: both indicators say terhubung (aria-label) and neither dot is the red down colour
  const hdr = page.locator('header .net span');
  await expect(hdr.nth(0)).toHaveAttribute('aria-label', 'Besu: terhubung');
  await expect(hdr.nth(1)).toHaveAttribute('aria-label', 'Paladin: terhubung');
  for (const i of [0, 1]) expect(await hdr.nth(i).locator('i').evaluate((e) => getComputedStyle(e).backgroundColor), `dot ${i}`).not.toBe('rgb(194, 74, 74)');
  const health = await (await page.request.get('/api/health')).json();
  expect(health.nodes.besu).toBe(true);
  expect(health.nodes.paladin).toEqual([true, true, true, true]);

  for (const tab of ['Demo transaksi', 'Stress test TPS']) {
    await page.getByRole('button', { name: tab }).click();
    const text = await page.locator('body').innerText();
    expect(text, `raw html tags on ${tab}`).not.toMatch(/<\/?[a-z][a-z0-9]*[^>]*>/i);
    expect(text, `raw backticks on ${tab}`).not.toContain('`');
    // accessible names
    const unnamed = await page.locator('button:visible, input:visible, select:visible').evaluateAll((els) =>
      els.filter((e) => !((e as HTMLElement).innerText?.trim() || e.getAttribute('aria-label') || e.getAttribute('title') || (e as HTMLInputElement).labels?.length)).map((e) => e.outerHTML.slice(0, 80)));
    expect.soft(unnamed, `unnamed controls on ${tab}`).toEqual([]);
  }

  for (const [width, height] of [[1280, 900], [390, 844]]) {
    for (const [tab, tag] of [['Demo transaksi', 'demo'], ['Stress test TPS', 'stress']]) {
      // at phone width the nav may be hidden: switch tabs at desktop width, then resize (view state survives)
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.getByRole('button', { name: tab }).click();
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(400);
      if (width < 400) {
        expect.soft(await page.locator('header nav').isVisible(), `nav (Stress test TPS menu) reachable at ${width}px`).toBe(true);
        expect.soft(await page.locator('header .net span:visible').count(), `both health indicators visible at ${width}px`).toBe(2);
      }
      const overflow = await page.evaluate(() => {
        const W = document.documentElement.clientWidth;
        const bad = [...document.querySelectorAll('body *')].filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.right > W + 1 && !e.closest('.tablewrap') && getComputedStyle(e).position !== 'fixed' && !!(e as HTMLElement).offsetParent;
        }).map((e) => `${e.tagName.toLowerCase()}.${(e as HTMLElement).className}`).slice(0, 8);
        return { sw: document.documentElement.scrollWidth, W, bad };
      });
      expect.soft(overflow.sw, `h-scroll ${width}px ${tag}`).toBeLessThanOrEqual(overflow.W);
      expect.soft(overflow.bad, `overflowing elements ${width}px ${tag}`).toEqual([]);
      await page.screenshot({ path: `${SHOTS}/shell-${tag}-${width}.png`, fullPage: true });
    }
  }
  if (known404) test.info().annotations.push({ type: 'ux', description: `GET /api/stress 404 x${known404} on a fresh load logs a red console error` });
  expect(errors).toEqual([]);
});

test('b. stress form: capacity validation, minimal config, tiny run, results and CSV', async ({ page }) => {
  const cap = await apiCapacity();
  await openStress(page);
  await page.screenshot({ path: `${SHOTS}/stress-initial.png`, fullPage: true });

  // config is minimal: models, count, parallel senders, time limit. No raw JSON / free-form fields.
  await expect(page.locator('aside[aria-label="Konfigurasi stress test"] input')).toHaveCount(1);
  await expect(page.locator('#tlimit option')).toHaveCount(3);

  // Zeto only: typed count above capacity is clamped on the spot
  if (cap.zeto) {
    await pickModels(page, ['zeto']);
    await page.locator('#tn').fill('999');
    await page.locator('#tn').blur();
    await expect(page.locator('#tn')).toHaveValue(String(cap.zeto));
    await page.screenshot({ path: `${SHOTS}/stress-clamp-zeto.png` });
  }
  // a model with 0 ready tx: start must be refused in the UI...
  if (cap.stealth === 0) {
    await pickModels(page, ['stealth']);
    await expect(startBtn(page)).toBeDisabled();
    const shown = await page.locator('aside[aria-label="Konfigurasi stress test"]').innerText();
    test.info().annotations.push({ type: 'ux', description: `stealth cap 0: Start disabled, panel text mentions: ${JSON.stringify(shown.match(/Kapasitas siap: 0[^\n]*/)?.[0])}` });
    await page.screenshot({ path: `${SHOTS}/stress-cap0-stealth.png` });
  }
  // ...and by the API with an Indonesian message (400 happens before any tx is submitted)
  const over = await page.request.post('/api/stress', { data: { models: ['zeto'], count: (cap.zeto ?? 0) + 1, concurrency: 1, limitS: 120 } });
  expect(over.status()).toBe(400);
  expect((await over.json()).reason).toMatch(/^Melebihi kapasitas siap Zeto \(\d+ tx\)$/);
  const none = await page.request.post('/api/stress', { data: { models: [], count: 1, concurrency: 1, limitS: 120 } });
  expect([400]).toContain(none.status());
  if (cap.stealth !== undefined) {
    const s0 = await page.request.post('/api/stress', { data: { models: ['stealth'], count: cap.stealth + 1, concurrency: 1, limitS: 120 } });
    expect(s0.status()).toBe(400);
    expect((await s0.json()).reason).toBe(`Melebihi kapasitas siap Stealth (${cap.stealth} tx)`);
  }

  // tiny real run
  const m = await pickCheapModel();
  const n = 2;
  const before = await chainMark(m);
  await configure(page, [m], n);
  await startBtn(page).click();
  const proses = page.getByRole('region', { name: 'Proses' });
  await expect(page.getByRole('button', { name: 'Hentikan' })).toBeVisible();
  await expect(proses.locator('.runrow')).toHaveCount(1);
  await expect(proses.locator('.prog')).toContainText(`/ ${n}`);
  await page.screenshot({ path: `${SHOTS}/stress-running-${m}.png`, fullPage: true });
  await expect(page.getByRole('heading', { name: 'Hasil perbandingan' })).toBeVisible({ timeout: 5 * 60_000 });
  await page.screenshot({ path: `${SHOTS}/stress-result-${m}.png`, fullPage: true });

  const snap = await apiStress();
  expect(snap.state).toBe('done');
  const s = snap.models[m].summary;
  expect(s.ok + s.failed).toBe(n);
  expect(s.ok).toBe(n);
  expect(s.p95Ms).toBeGreaterThanOrEqual(s.p50Ms);
  await assertResults(page, snap, [m]);
  await expect(proses.locator('.runrow .prog')).toContainText(`${n} / ${n}`);

  // chain cross-check
  const d = await chainDelta(m, before);
  test.info().annotations.push({ type: 'chain', description: `${m}: api ok=${s.ok} chain new=${d.count} onBesuOk=${d.onBesuOk}` });
  expect(d.count, 'new chain events/receipts vs ok').toBe(s.ok);
  expect(d.onBesuOk).toBeGreaterThanOrEqual(s.ok === 0 ? 0 : 1);
});

test('c. stop: Hentikan halts the run and nothing more is submitted', async ({ page }) => {
  const m = await pickCheapModel();
  const n = m === 'stealth' ? 3 : 8; // noto does ~1.5 s per tx at 1 sender: long enough to stop mid-run
  await openStress(page);
  const before = await chainMark(m);
  await configure(page, [m], n);
  await startBtn(page).click();
  const stop = page.getByRole('button', { name: 'Hentikan' });
  await expect(stop).toBeVisible();

  // single-runner lock: a second run is refused while this one is active
  const second = await page.request.post('/api/stress', { data: { models: [m], count: 1, concurrency: 1, limitS: 120 } });
  expect(second.status()).toBe(409);
  test.info().annotations.push({ type: 'lock', description: `409 reason: ${(await second.json()).reason}` });

  // let the first tx confirm, then stop with the rest still queued
  await expect.poll(async () => (await apiStress()).models[m].summary.ok, { timeout: 120_000 }).toBeGreaterThanOrEqual(1);
  const stopResp = page.waitForResponse((r) => r.url().endsWith('/api/stress/stop'));
  await stop.click();
  const sr = await stopResp;
  // PRODUCT BUG if this is 400: web/src/api.ts:31 sends content-type json with an empty body, Fastify rejects it (server/src/app.ts:74-78)
  expect.soft(sr.status(), `UI Hentikan -> POST /api/stress/stop (${JSON.stringify(await sr.json())})`).toBe(200);
  if (sr.status() !== 200) {
    // server-side stop path, same endpoint without a json content-type
    const r = await page.request.post('/api/stress/stop');
    expect(r.status()).toBe(200);
    test.info().annotations.push({ type: 'workaround', description: 'UI stop was rejected; stopped through the API instead' });
  }
  await expect(page.getByRole('button', { name: 'Mulai stress test' })).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await apiStress()).state, { timeout: 60_000 }).toBe('stopped');
  await page.screenshot({ path: `${SHOTS}/stress-stopped-${m}.png`, fullPage: true });
  await expect(page.getByRole('region', { name: 'Proses' }).locator('.state')).toHaveText('Dihentikan');

  const a = await apiStress();
  const c1 = await chainDelta(m, before);
  await page.waitForTimeout(25_000);
  const b = await apiStress();
  const c2 = await chainDelta(m, before);
  expect(b.models[m].summary).toEqual(a.models[m].summary);
  expect(c2.count, 'no further tx after stop').toBe(c1.count);
  const s = a.models[m].summary;
  expect(s.ok + s.failed, 'stopped before all tx were sent').toBeLessThan(n);
  test.info().annotations.push({ type: 'chain', description: `${m}: api ok=${s.ok} failed=${s.failed}; chain new=${c2.count}` });
  // the lock is released again
  const third = await page.request.post('/api/stress', { data: { models: [m], count: (await apiCapacity())[m]! + 1, concurrency: 1, limitS: 120 } });
  expect(third.status(), 'lock released (400 validation, not 409)').toBe(400);
  expect(c2.count, 'chain events vs ok (in-flight tx at stop can add 1)').toBeGreaterThanOrEqual(s.ok);
  expect(c2.count).toBeLessThanOrEqual(s.ok + s.failed);
});

test('d. side-by-side: every model with capacity, smallest counts', async ({ page }) => {
  const cap = await apiCapacity();
  const models = (['zeto', 'noto', 'stealth'] as ModelId[]).filter((m) => (cap[m] ?? 0) >= 1);
  const skipped = (['zeto', 'noto', 'stealth'] as ModelId[]).filter((m) => !models.includes(m));
  if (skipped.length) test.info().annotations.push({ type: 'deviation', description: `no capacity, not run: ${skipped.join(',')} (cap=${JSON.stringify(cap)})` });
  const n = 1;
  await openStress(page);
  const before = Object.fromEntries(await Promise.all(models.map(async (m) => [m, await chainMark(m)])));
  await configure(page, models, n);
  await startBtn(page).click();
  const proses = page.getByRole('region', { name: 'Proses' });
  await expect(proses.locator('.runrow')).toHaveCount(models.length);
  await page.screenshot({ path: `${SHOTS}/side-running.png`, fullPage: true });
  await expect(page.getByRole('heading', { name: 'Hasil perbandingan' })).toBeVisible({ timeout: 10 * 60_000 });
  await page.screenshot({ path: `${SHOTS}/side-result.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${SHOTS}/side-result-390.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  const snap = await apiStress();
  expect(snap.state).toBe('done');
  await assertResults(page, snap, models);
  await expect(page.locator('table.res tbody tr')).toHaveCount(models.length);
  // rows are ordered by TPS, descending
  const tps = await page.locator('table.res tbody tr td:nth-child(2)').allInnerTexts();
  const nums = tps.map((t) => Number(t.replace(',', '.')));
  expect(nums).toEqual([...nums].sort((x, y) => y - x));
  for (const m of models) {
    const s = snap.models[m].summary;
    expect.soft(s.ok + s.failed, `${m} total`).toBe(n);
    const d = await chainDelta(m, before[m]);
    test.info().annotations.push({ type: 'chain', description: `${m}: api ok=${s.ok} failed=${s.failed} chain new=${d.count} onBesuOk=${d.onBesuOk}` });
    expect.soft(d.count, `${m} chain events vs ok`).toBe(s.ok);
  }
});
