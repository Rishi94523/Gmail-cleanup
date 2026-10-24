import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApp } from '../server/index.js';
import { DEFAULT_RULES } from '../server/rules.js';
import { PREFERENCE_CATEGORIES } from '../server/preference-categories.js';

const output = resolve(process.argv[2] || 'data/qa-agent');
await mkdir(output, { recursive: true });
const app = await createApp({
  dataDir: 'data/qa-agent/db',
  config: { databaseUrl: '', encryptionKey: '', scheduler: false, appUrl: 'http://localhost:3070', port: 3070 }
});
await new Promise(resolve => app.server.listen(3070, '127.0.0.1', resolve));
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const state = {
    connected: true,
    configured: true,
    aiConfigured: true,
    aiProvider: 'nebius',
    aiModel: 'nvidia/Nemotron-3.5-Super-VL',
    schedulerActive: false,
    preferenceCategories: PREFERENCE_CATEGORIES,
    access: { tier: 'free', used: 0, remaining: 100, dailyAllowed: false },
    csrf: 'fixture-only',
    email: 'test@example.invalid',
    rules: { ...DEFAULT_RULES, agent: { enabled: true, consent: true, consentProvider: 'nebius' } },
    runs: [],
    subscriptions: [],
    plan: null,
    totals: {}
  };
  let learned = false;
  let ran = false;
  const tray = { questions: [], memories: [], discovery: null, questionsTotal: 0 };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/agent/run') {
      ran = true;
      state.access.used = 100;
      state.access.remaining = 0;
      assert.deepEqual(route.request().postDataJSON(), { authorize: true, includeExisting: true });
      return route.fulfill({
        contentType: 'application/x-ndjson',
        body:
          [
            { type: 'stage', message: 'Reading and deciding', total: 2 },
            {
              type: 'decision',
              action: 'read',
              subject: '<script>bad()</script> sale',
              reason: 'Not relevant to your interests',
              inspected: 1,
              total: 2,
              changed: 1,
              kept: 0
            },
            {
              type: 'decision',
              action: 'keep',
              subject: 'Interview next week',
              reason: 'Job opportunity',
              inspected: 2,
              total: 2,
              changed: 1,
              kept: 1
            },
            { type: 'complete', inspected: 2, changed: 1, kept: 1 }
          ]
            .map(e => JSON.stringify(e))
            .join('\n') + '\n'
      });
    }
    let json;
    if (path === '/api/status') json = state;
    else if (path === '/api/mailbox') json = { unread: 7590, messages: 7626 };
    else if (path === '/api/agent/questions') json = tray;
    else if (path === '/api/agent/learn') {
      assert.equal(route.request().postDataJSON().consent, true);
      learned = true;
      json = {
        inspected: 100,
        summary: 'Your inbox includes job opportunities.',
        suggestions: [{ topic: 'jobs', note: 'Would you like to keep recruiting emails?' }]
      };
      tray.discovery = json;
      tray.questionsTotal = 1;
      tray.questions = [
        {
          id: 'question-one',
          version: 1,
          question: 'Do you want product announcements in your inbox?',
          reason: 'These might be unwanted signup marketing.',
          scope: { kind: 'category', category: 'product_announcements', label: 'Product announcements' },
          sample: { subject: 'A new product announcement' },
          options: [
            { id: 'keep', label: 'Keep these in my inbox' },
            { id: 'read', label: 'Mark future low-priority mail as read' },
            { id: 'later', label: 'Ask me tomorrow' }
          ]
        }
      ];
    } else if (path === '/api/agent/questions/interpret') {
      const answer = route.request().postDataJSON();
      json = { supported: true, action: 'read', minAgeDays: 90, instructions: answer.text };
    } else if (path === '/api/agent/questions/answer') {
      const answer = route.request().postDataJSON();
      assert.equal(answer.option, 'custom');
      assert.equal(answer.action, 'read');
      tray.memories = [
        {
          id: 'memory-one',
          version: 1,
          action: answer.action,
          minAgeDays: answer.minAgeDays,
          instructions: answer.instructions,
          scope: tray.questions[0].scope,
          explanation: tray.questions[0].question
        }
      ];
      tray.questions = [];
      tray.questionsTotal = 0;
      json = { status: 'saved' };
    } else if (path === '/api/agent/memories/edit') {
      const change = route.request().postDataJSON();
      Object.assign(tray.memories[0], {
        action: change.action,
        minAgeDays: change.minAgeDays,
        instructions: change.instructions
      });
      tray.memories[0].version++;
      json = { status: 'saved' };
    } else if (path === '/api/rules') {
      state.rules = route.request().postDataJSON();
      json = { rules: state.rules };
    } else if (path === '/api/agent/history')
      json = { logs: [{ decisions: [{ subject: 'Sale', action: 'read', reason: 'Low priority' }] }] };
    else throw new Error(`Unexpected request ${path}`);
    await route.fulfill({ json });
  });
  await page.goto('http://localhost:3070');
  await page.waitForSelector('#agent-configure');
  await page.waitForFunction(
    () => document.querySelector('#unread-caption').textContent === 'Unread emails in your Primary inbox'
  );
  assert.equal(await page.locator('#metric-unread').textContent(), '7,590');
  assert.equal(await page.locator('.metric-label').first().textContent(), 'Unread in Primary');
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  await page.locator('.preference-settings:has(#preferences-form) > summary').click();
  assert.equal(await page.locator('#agent-consent').count(), 0);
  await page.locator('#agent-learn').click();
  await page.waitForFunction(() => document.querySelector('#agent-suggestions').textContent.includes('100 messages'));
  assert.equal(learned, true);
  assert.equal(ran, false);
  await page.locator('#pref-interests').fill('Software engineering roles');
  await page.locator('#save-preferences').click();
  await page.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  assert.equal(await page.locator('#pref-daily').isDisabled(), true);
  assert.equal(state.rules.agent.action, 'read');
  assert.equal(state.rules.agent.enabled, true);
  assert.equal(state.rules.daily, false);
  assert.equal(state.rules.agent.consentProvider, 'nebius');
  assert.equal(await page.locator('#question-count').textContent(), '1');
  await page.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  await page.evaluate(() => {
    document.querySelector('#toast').hidden = true;
  });
  await page.getByRole('button', { name: /Questions/ }).click();
  await page.screenshot({ path: resolve(output, 'questions-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    'Mobile questions overflow'
  );
  await page.screenshot({ path: resolve(output, 'questions-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Or write my own answer' }).click();
  await page
    .getByRole('textbox', { name: 'Your written preference' })
    .fill('Mark these read after 90 days, except Apple announcements.');
  await page.getByRole('button', { name: /Understand my answer/ }).click();
  await page.locator('.custom-summary').waitFor();
  assert.equal(tray.memories.length, 0);
  await page.getByRole('button', { name: /Save this preference/ }).click();
  await page.waitForFunction(() => document.querySelector('#question-count').textContent === '0');
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  assert.equal(await page.locator('#learned-preferences [name=minAgeDays]').inputValue(), '90');
  await page.locator('.preference-row > summary').click();
  await page.locator('#learned-preferences [name=instructions]').fill('Keep Apple and Mozilla announcements.');
  await page.locator('#learned-preferences [name=minAgeDays]').fill('180');
  await page.locator('#learned-preferences select').selectOption('keep');
  await page.locator('#learned-preferences button[type=submit]').click();
  await page.waitForFunction(() =>
    document.querySelector('.preference-row summary small').textContent.includes('Keep in inbox')
  );
  assert.equal(tray.memories[0].action, 'keep');
  assert.equal(tray.memories[0].minAgeDays, 180);
  assert.match(tray.memories[0].instructions, /Mozilla/);
  await page.locator('.preference-settings:has(#exception-form) > summary').click();
  await page.locator('#exception-value').fill('apple.com');
  await page.locator('#exception-category').selectOption('product_announcements');
  await page.locator('#exception-action').selectOption('read');
  await page.locator('#exception-save').click();
  await page.waitForSelector('#sender-exceptions [data-remove-exception]');
  assert.equal(state.rules.agent.exceptionsRules[0].value, 'apple.com');
  assert.equal(state.rules.agent.exceptionsRules[0].action, 'read');
  assert.equal(tray.memories[0].action, 'keep', 'Adding an exception must preserve the general category answer');
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.locator('#agent-start').click();
  await page.waitForFunction(() => document.querySelector('#agent-stage').textContent === 'Run finished.');
  await page.waitForFunction(() => document.querySelector('#agent-start').disabled);
  assert.equal(ran, true);
  assert.equal(await page.locator('#agent-decisions script').count(), 0);
  assert.ok((await page.locator('#agent-counts').textContent()).includes('1 changed'));
  await page.evaluate(() => {
    document.querySelector('#toast').hidden = true;
  });
  await page.screenshot({ path: resolve(output, 'agent-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  await page.screenshot({ path: resolve(output, 'preferences-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    'Mobile preferences overflow'
  );
  await page.screenshot({ path: resolve(output, 'preferences-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    'Mobile dashboard overflow'
  );
  await page.screenshot({ path: resolve(output, 'agent-mobile.png'), fullPage: true });
  state.rules.agent.consentProvider = '';
  await page.reload();
  await page.getByRole('button', { name: 'Preferences', exact: true }).first().click();
  await page.waitForFunction(() =>
    document.querySelector('#agent-processing-note').textContent.includes('Finish setup')
  );
  assert.equal(await page.locator('#agent-consent').count(), 0);
  assert.doesNotMatch(
    await page.locator('body').innerText(),
    /Nebius|Token Factory|OpenRouter|fixture-model|API_KEY|README|\.env\b/i
  );
  assert.equal(await page.locator('#agent-start').isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log(
    'PASS automatic discovery using saved onboarding consent, persistent MCQ tray, answering and editing learned preferences, desktop/mobile layout, provider consent, paid-only daily controls, exhaustion controls, and streamed decisions. Gmail and AI were test fixtures; no live email actions.'
  );
} finally {
  await browser.close();
  await app.close();
}
