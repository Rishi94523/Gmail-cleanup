import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createApp } from '../server/index.js';
const output = 'data/qa-landing';
await mkdir(output, { recursive: true });
const base = process.env.QA_BASE_URL || 'http://localhost:3072';
const app = process.env.QA_BASE_URL
  ? null
  : await createApp({
      config: { appUrl: base, port: 3072, databaseUrl: '', scheduler: false, serveLanding: true },
      dataDir: `${output}/db`
    });
if (app) await new Promise(resolve => app.server.listen(3072, '127.0.0.1', resolve));
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.clock.install();
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: /Your inbox/ }).waitFor();
  assert.equal(
    await page
      .locator('.site-header')
      .getByRole('button', { name: /Connect Gmail/ })
      .count(),
    0
  );
  assert.equal(
    await page
      .locator('.hero-actions')
      .getByRole('button', { name: /Connect Gmail/ })
      .count(),
    1
  );
  assert.equal((await page.request.get(`${base}/favicon.svg`)).status(), 200);
  assert.equal(await page.locator('link[rel=icon]').getAttribute('href'), '/favicon.svg');
  await page.screenshot({ path: `${output}/hero-desktop.png` });
  await page.getByRole('link', { name: /See it in action/ }).click();
  await page.locator('#agent-demo').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: /Replay/ }).click();
  await page.clock.runFor(5000);
  assert.equal(await page.locator('.demo-option.selected').count(), 1);
  await page.locator('#agent-demo').screenshot({ path: `${output}/demo-question-desktop.png` });
  await page.clock.runFor(14000);
  assert.equal(await page.locator('#agent-demo').getAttribute('data-stage'), 'cleanup');
  assert.ok((await page.locator('.demo-email.decided').count()) > 0);
  await page.locator('#agent-demo').screenshot({ path: `${output}/demo-cleanup-desktop.png` });
  await page.clock.runFor(7000);
  assert.equal(await page.locator('#agent-demo').getAttribute('data-stage'), 'questions');
  await page.getByRole('button', { name: 'Pause demo' }).click();
  const before = await page.locator('.demo-conversation').innerText();
  await page.clock.runFor(8000);
  assert.equal(await page.locator('.demo-conversation').innerText(), before);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#agent-demo').screenshot({ path: `${output}/demo-mobile.png` });
  await page.route('**/auth/google', route => route.fulfill({ body: 'OAuth entry reached' }));
  await page
    .locator('.hero-actions')
    .getByRole('button', { name: /Connect Gmail/ })
    .click();
  await page.waitForURL('**/auth/google');
  await page.goto(`${base}/app`, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('link[rel=icon]').getAttribute('href'), '/favicon.svg');
  const reduced = await browser.newPage({ reducedMotion: 'reduce' });
  await reduced.goto(base, { waitUntil: 'networkidle' });
  await reduced.getByRole('button', { name: 'Play demo' }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'PASS landing Gmail CTA placement, looping questions/decisions, pause/replay, mobile layout, reduced-motion default and shared favicon. No mailbox access.'
  );
} finally {
  await browser.close();
  if (app) await app.close();
}
