import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

const url = process.argv[2] || 'http://localhost:8080';
const output = resolve(process.argv[3] || 'data/qa-preview');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: /Your inbox/ }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Desktop must not overflow');
  await page.screenshot({ path: resolve(output, 'gmail-cleanup-landing-desktop.png') });
  await page.getByRole('button', { name: 'Connect Gmail', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'does not access or modify' }).waitFor();
  await page.getByRole('button', { name: 'Dismiss notice' }).click();
  await page.getByLabel('Mark matching emails as read').check();
  await page.getByRole('button', { name: 'Preview my plan' }).click();
  assert.match(await page.locator('.preview-result').innerText(), /Mark 2 as read/);
  await page.getByLabel('Enable example daily routine').uncheck();
  await page.getByRole('button', { name: 'Preview my plan' }).click();
  assert.match(await page.locator('.preview-result').innerText(), /Daily routine is paused/);
  await page.getByRole('button', { name: 'Can I connect Gmail today?' }).click();
  assert.match(await page.locator('#faq-3').innerText(), /Not on this public preview/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Mobile must not overflow');
  await page.screenshot({ path: resolve(output, 'gmail-cleanup-landing-mobile.png') });
  assert.deepEqual(errors, []);
  console.log('Public preview passed desktop/mobile layout, disclosure, checkbox plan, daily toggle, FAQ, and browser-error checks. No live mailbox actions performed.');
} finally { await browser.close(); }
