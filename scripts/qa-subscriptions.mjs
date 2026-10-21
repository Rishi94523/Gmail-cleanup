import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createApp } from '../server/index.js';
import { DEFAULT_RULES } from '../server/rules.js';
const output = 'data/qa-subscriptions';
await mkdir(output, { recursive: true });
const base = process.env.QA_BASE_URL || 'http://localhost:3073';
const app = process.env.QA_BASE_URL
  ? null
  : await createApp({ config: { appUrl: base, databaseUrl: '', scheduler: false }, dataDir: `${output}/db` });
if (app) await new Promise(resolve => app.server.listen(3073, '127.0.0.1', resolve));
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  let requests = 0;
  const subscription = {
    sender: 'news@mail.example.invalid',
    displayName: 'Garden Journal',
    subject: 'Your weekly garden notes',
    host: 'delivery-provider.example.invalid',
    status: 'review'
  };
  const state = {
    connected: true,
    configured: true,
    aiConfigured: true,
    aiProvider: 'nebius',
    aiModel: 'fixture',
    hackathonMode: true,
    schedulerActive: true,
    csrf: 'fixture',
    email: 'fixture@example.invalid',
    access: { tier: 'hackathon', limit: 100, remaining: 100, dailyAllowed: true, used: 0 },
    rules: { ...DEFAULT_RULES, agent: { enabled: true, consent: true, consentProvider: 'nebius' } },
    subscriptions: [subscription],
    runs: [],
    totals: {},
    setupMissing: []
  };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/status') return route.fulfill({ json: state });
    if (path === '/api/agent/questions')
      return route.fulfill({
        json: { questions: [], questionsTotal: 0, memories: [], discovery: { inspected: 100, evidenceCategories: [] } }
      });
    if (path === '/api/mailbox') return route.fulfill({ json: { unread: 100, messages: 100 } });
    if (path === '/api/unsubscribe') {
      requests++;
      assert.equal(route.request().postDataJSON().sender, subscription.sender);
      subscription.status = 'requested';
      return route.fulfill({ json: { status: 'requested' } });
    }
    throw Error(`Unexpected route ${path}`);
  });
  await page.goto(`${base}/app#subscriptions`, { waitUntil: 'networkidle' });
  await page.locator('#subscriptions-list strong').waitFor();
  assert.equal(await page.locator('#subscriptions-list strong').innerText(), 'Garden Journal');
  assert.match(await page.locator('#subscriptions-list').innerText(), /weekly garden notes/);
  assert.doesNotMatch(await page.locator('#subscriptions-list').innerText(), /delivery-provider/);
  await page.getByRole('button', { name: 'Unsubscribe →', exact: true }).click();
  assert.equal(requests, 0);
  await page.getByRole('button', { name: /Confirm unsubscribe/ }).click();
  await page.waitForFunction(() =>
    document.querySelector('#subscriptions-list').textContent.includes('Request accepted')
  );
  assert.equal(requests, 1);
  assert.equal(await page.getByRole('button', { name: 'Unsubscribe →', exact: true }).count(), 0);
  await page.screenshot({ path: `${output}/subscription-request.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log(
    'PASS recognizable subscription name/example, two-step confirmation, accepted-request state, no duplicate action, and mobile layout. Fixture-only; no real unsubscribe request.'
  );
} finally {
  await browser.close();
  if (app) await app.close();
}
