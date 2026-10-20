import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// Live E2E for the Stealth model against the real server (Besu only). Evidence per flow is written next to the
// screenshots so a separate script can cross-check it on chain.
const OUT = '/tmp/claude-1000/-home-ecs-user-project-rd-platform-ekplorasi-besu/821d83c9-e7ea-4692-9b81-95c7126fe71d/scratchpad/e2e';

type Party = 'BI' | 'A' | 'B' | 'C';
const NAME: Record<Party, string> = { BI: 'Bank Indonesia', A: 'Bank Mandala', B: 'Bank Nusantara', C: 'Bank Sejahtera' };
const VERDICT = { clear: 'Terbaca utuh', viewkey: 'Dipetakan via view key', partial: 'Nominal terlihat, pihak tidak' };

interface Case {
  flow: string; button: string; from: Party; to: Party; amount: string; asset: 'RD' | 'DFABI'; dvp?: boolean;
  // expected [cls, verdict text, counterparty line] per party
  expect: Partial<Record<Party, [string, string, string]>>;
}
const cases: Case[] = [
  {
    flow: 'rd-issue', button: 'Penerbitan RD', from: 'BI', to: 'A', amount: '1000', asset: 'RD',
    expect: {
      BI: ['clear', VERDICT.clear, `diterbitkan untuk ${NAME.A}`],
      A: ['clear', VERDICT.clear, `dari ${NAME.BI}`],
      B: ['partial', VERDICT.partial, 'Pihak tidak terbaca'],
      C: ['partial', VERDICT.partial, 'Pihak tidak terbaca'],
    },
  },
  {
    flow: 'rd-transfer', button: 'Transfer RD', from: 'A', to: 'B', amount: '1000', asset: 'RD',
    expect: {
      A: ['clear', VERDICT.clear, `ke ${NAME.B}`],
      B: ['clear', VERDICT.clear, `dari ${NAME.A}`],
      BI: ['clear', VERDICT.viewkey, `${NAME.A} → ${NAME.B}`],
      C: ['partial', VERDICT.partial, 'Pihak tidak terbaca'],
    },
  },
  {
    flow: 'dfabi-issue', button: 'Penerbitan seri DFABI', from: 'BI', to: 'A', amount: '1000', asset: 'DFABI',
    expect: {
      BI: ['clear', VERDICT.clear, `diterbitkan untuk ${NAME.A}`],
      A: ['clear', VERDICT.clear, `dari ${NAME.BI}`],
      B: ['partial', VERDICT.partial, 'Pihak tidak terbaca'],
      C: ['partial', VERDICT.partial, 'Pihak tidak terbaca'],
    },
  },
  {
    flow: 'dfabi-transfer', button: 'Transfer DFABI', from: 'A', to: 'C', amount: '1000', asset: 'DFABI',
    expect: {
      A: ['clear', VERDICT.clear, `ke ${NAME.C}`],
      C: ['clear', VERDICT.clear, `dari ${NAME.A}`],
      BI: ['clear', VERDICT.viewkey, `${NAME.A} → ${NAME.C}`],
      B: ['partial', VERDICT.partial, 'Pihak tidak terbaca'],
    },
  },
  {
    flow: 'dvp', button: 'DvP DFABI ↔ RD', from: 'A', to: 'B', amount: '3', asset: 'DFABI', dvp: true,
    expect: {
      A: ['clear', VERDICT.clear, `jual ke ${NAME.B}`],
      B: ['clear', VERDICT.clear, `beli dari ${NAME.A}`],
      BI: ['clear', VERDICT.viewkey, `${NAME.A} → ${NAME.B}`],
      C: ['partial', VERDICT.partial, 'Pihak tidak terbaca'],
    },
  },
];

const digits = (s: string) => s.split('⇄')[0].replace(/\D/g, '');

async function setup(page: Page, c: Case) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Stealth', exact: true }).click();
  await page.getByRole('button', { name: c.button, exact: true }).click();
  if (c.from !== 'BI') await page.getByRole('button', { name: new RegExp(`^${NAME[c.from]}`) }).click();
  await page.locator('#to').selectOption({ label: NAME[c.to] });
  await page.locator('#amount').fill(c.amount);
  // Request tab must show exactly what we picked
  const req = JSON.parse((await page.locator('section.compose pre').innerText()).replace(/^POST \/api\/tx\s*/, ''));
  expect(req).toEqual({ model: 'stealth', flow: c.flow, from: c.from, to: c.to, amount: c.amount });
  return req;
}

for (const c of cases) {
  test(`stealth ${c.flow}`, async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (m) => m.type() === 'error' && !/\/(favicon\.ico|api\/stress)$/.test(m.location().url) && consoleErrors.push(m.text() + ' @ ' + m.location().url)); // known benign 404s: favicon (product nit) and /api/stress before any stress run
    const request = await setup(page, c);
    const t0 = Date.now();
    await page.getByRole('button', { name: c.dvp ? 'Jalankan DvP' : c.from === 'BI' ? 'Terbitkan' : 'Kirim', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Memproses di network…' })).toBeVisible();

    const steps = page.getByRole('region', { name: 'Proses' }).locator('li');
    await expect(steps.locator('xpath=self::li[contains(@class,"ok")]')).toHaveCount(4);
    await expect(page.locator('button.lens')).toHaveCount(4);
    const wallMs = Date.now() - t0;
    const stepLabels = await steps.allInnerTexts();
    expect(stepLabels.map((s) => s.split('\n')[0])).toEqual(['Alamat stealth & enkripsi memo', 'Tanda tangan & kirim transaksi', 'Masuk block Besu', 'BI memindai dengan view key']);

    // response JSON
    await expect(page.getByRole('tab', { name: 'Response' })).toHaveAttribute('aria-selected', 'true');
    const response = JSON.parse(await page.locator('section.compose pre').innerText());
    expect(response.status).toBe('SUCCESS');
    expect(response.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Number.isInteger(response.block)).toBe(true);
    expect(Object.keys(response.timings_ms)).toHaveLength(4);

    // lenses
    const lenses: Record<string, unknown> = {};
    for (const p of Object.keys(c.expect) as Party[]) {
      const [cls, verdict, line] = c.expect[p]!;
      const card = page.locator('button.lens').filter({ has: page.locator('h5', { hasText: new RegExp(`^${NAME[p]}$`) }) });
      await expect(card).toHaveCount(1);
      await expect(card).toHaveClass(new RegExp(`\\b${cls}\\b`));
      await expect(card.locator('.verdict')).toHaveText(verdict);
      await expect(card.locator('.line')).toHaveText(line);
      const val = await card.locator('.val').innerText();
      expect(digits(val), `${p} amount`).toBe(c.dvp ? c.amount : c.amount);
      if (c.dvp) expect(val).toContain(`Rp ${(Number(c.amount) * 1_000_000).toLocaleString('id-ID')}`);
      // open detail panel, read the full on-chain values from the title attributes
      await card.click();
      const detail = page.locator('.card.detail');
      await expect(detail).toBeVisible();
      await expect(detail.locator('h4').first()).toHaveText(`Cara ${NAME[p]} membaca transaksi ini`);
      const method = await detail.locator('div').first().locator('p').innerText();
      expect(method, 'raw backticks/html in method').not.toMatch(/[`<>]/);
      const onChain: Record<string, string> = {};
      for (const li of await detail.locator('li').all()) {
        const code = li.locator('code');
        onChain[(await li.innerText()).includes(':') ? (await li.innerText()).split(':')[0].trim() : 'Tx'] = (await code.getAttribute('title')) ?? (await code.innerText());
      }
      const txLi = await detail.locator('li').first().innerText();
      expect(txLi).toContain(`block ${response.block}`);
      lenses[p] = { cls, verdict: await card.locator('.verdict').innerText(), line: await card.locator('.line').innerText(), value: val, method, onChain, hexText: await card.locator('.hex').allInnerTexts() };
      if (cls === 'partial') expect(Object.keys(onChain).sort()).toEqual(['Alamat sekali pakai', 'Memo terenkripsi', 'Nominal (publik)', 'Tx'].sort());
      expect(onChain['Tx']).toBe(response.txHash); // shown once; no duplicate 'Tx hash' row
    }

    // sanity: no leaked placeholders / raw html anywhere
    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/undefined|NaN|\[object|<code>|&lt;/);
    expect(consoleErrors).toEqual([]);

    await page.screenshot({ path: `${OUT}/stealth-${c.flow}.png`, fullPage: true });
    writeFileSync(`${OUT}/stealth-${c.flow}.json`, JSON.stringify({ flow: c.flow, request, response, wallMs, lenses }, null, 2));
  });
}
