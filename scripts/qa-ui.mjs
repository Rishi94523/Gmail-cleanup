import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEFAULT_RULES } from '../server/rules.js';

const output = resolve(process.argv[2] || 'data/qa');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://localhost:3000'); await page.waitForSelector('#setup-rules');
  assert.equal(await page.locator('#scan-button').isDisabled(), true);
  await page.screenshot({ path: resolve(output, 'inboxclean-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Cleanup rules', exact: true }).click();
  await page.locator('#rule-days').fill('120');
  assert.equal(await page.locator('#save-rules').isDisabled(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Mobile page must not overflow horizontally');
  await page.screenshot({ path: resolve(output, 'inboxclean-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);

  // Test-only browser fixtures exercise the connected UI without accessing Gmail.
  const ui = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  ui.on('pageerror', error => errors.push(error.message));
  let applied = null; let saved = null;
  let state = { csrf: 'test-only', connected: true, configured: true, aiConfigured: false, email: 'test@example.com', rules: { ...DEFAULT_RULES }, totals: { cleaned: 0, requested: 0 }, setupMissing: [], runs: [], subscriptions: [], plan: null };
  const plan = { id: 'test-plan', rules: state.rules, created: Date.now(), moreAvailable: false, decisions: [{ id: 'one', sender: 'shop@example.com', subject: '<script>bad()</script> weekend sale', date: Date.now() - 150 * 86400000, reason: null, source: 'Saved rules' }, { id: 'two', sender: 'bank@example.com', subject: 'Account security', date: Date.now() - 150 * 86400000, reason: 'Potentially important', source: 'Saved rules' }] };
  await ui.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname; let result;
    if (path === '/api/status') result = state;
    else if (path === '/api/mailbox') result = { unread: 24561, messages: 31000 };
    else if (path === '/api/scan') { state.plan = plan; result = { plan }; }
    else if (path === '/api/apply') { applied = route.request().postDataJSON(); state.plan = null; state.runs = [{ id: 'run-one', kind: 'cleanup', status: 'completed', changed: 1, skipped: 0, created: Date.now(), undoable: true }]; result = { changed: 1 }; }
    else if (path === '/api/rules') { saved = route.request().postDataJSON(); state.rules = saved; result = { rules: saved }; }
    else throw new Error(`Unexpected fixture request: ${path}`);
    await route.fulfill({ json: result });
  });
  await ui.goto('http://localhost:3000');
  await ui.locator('#scan-button').click();
  await ui.waitForSelector('#preview-section:not([hidden])');
  assert.equal(await ui.locator('#preview-body input:not([disabled])').count(), 1);
  assert.equal(await ui.locator('#preview-body script').count(), 0, 'Email subjects must be escaped');
  await ui.locator('#review-cleanup').click(); assert.equal(applied, null, 'Review must not mutate Gmail');
  await ui.locator('#confirm-cleanup').click();
  await ui.waitForSelector('#preview-section[hidden]', { state: 'attached' });
  assert.deepEqual(applied.ids, ['one']);
  await ui.getByRole('button', { name: 'Cleanup rules', exact: true }).click();
  await ui.locator('#rule-days').fill('120'); await ui.locator('#rule-daily').check(); await ui.locator('#save-rules').click();
  await ui.waitForFunction(() => document.querySelector('#agent-pill').textContent.includes('Daily agent on'));
  assert.equal(saved.days, 120); assert.equal(saved.daily, true);
  assert.deepEqual(errors, []);
  console.log('Desktop/mobile layout, navigation, setup state, escaped email subjects, protected selections, approval, and rule-save flow passed. Connected UI used test-only fixtures; no live Gmail actions performed.');
} finally { await browser.close(); }
