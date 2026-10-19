import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('zeto transfer: 4 steps, 4 lenses, exactly 1 sealed', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Transfer RD', exact: true }).click();
  await page.getByRole('button', { name: 'Kirim', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Proses' }).locator('li.ok')).toHaveCount(4);
  await expect(page.locator('button.lens')).toHaveCount(4);
  await expect(page.locator('button.lens.sealed')).toHaveCount(1);
});

test('stealth: exactly 1 partial lens', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Stealth', exact: true }).click();
  await page.getByRole('button', { name: 'Transfer RD', exact: true }).click();
  await page.getByRole('button', { name: 'Kirim', exact: true }).click();
  await expect(page.locator('button.lens')).toHaveCount(4);
  await expect(page.locator('button.lens.partial')).toHaveCount(1);
});

test('stress run on Ringan shows results and a CSV with the right header', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Stress test TPS' }).click();
  await page.getByRole('button', { name: '50 tx' }).click();
  await page.getByRole('button', { name: 'Mulai stress test' }).click();
  await expect(page.getByRole('heading', { name: 'Hasil perbandingan' })).toBeVisible({ timeout: 20_000 });
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: /Unduh hasil/ }).click();
  const body = await readFile(await (await download).path(), 'utf8');
  expect(body.split('\n')[0].trim()).toBe('model,tps_avg,tps_peak,p50_s,p95_s,ok,failed,duration_s');
});

test('unknown route returns Indonesian 404 while the web build is served', async ({ request }) => {
  const r = await request.get('/api/tidak-ada');
  expect(r.status()).toBe(404);
  expect(await r.json()).toEqual({ reason: 'Tidak ditemukan' });
});
