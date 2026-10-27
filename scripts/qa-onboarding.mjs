import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createApp } from '../server/index.js';
import { DEFAULT_RULES } from '../server/rules.js';
import { DEFAULT_PREFERENCES } from '../server/agent.js';

const output = 'data/qa-onboarding';
await mkdir(output, { recursive: true });
const app = await createApp({
  dataDir: `${output}/db`,
  config: { databaseUrl: '', encryptionKey: '', scheduler: false, appUrl: 'http://localhost:3071', port: 3071 }
});
await new Promise(resolve => app.server.listen(3071, '127.0.0.1', resolve));
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const state = {
    connected: true,
    configured: true,
    aiConfigured: true,
    aiProvider: 'nebius',
    aiModel: 'fixture-model',
    schedulerActive: false,
    csrf: 'fixture',
    email: 'fixture@example.invalid',
    access: { tier: 'free', used: 0, remaining: 100 },
    rules: { ...DEFAULT_RULES },
    runs: [],
    subscriptions: [],
    totals: {},
    setupMissing: []
  };
  const q = (id, category, question) => ({
    id,
    scope: { kind: 'category', category, label: category.replaceAll('_', ' ') },
    version: 1,
    initial: true,
    question,
    reason: 'A recurring pattern in this inbox sample.',
    sample: { subject: 'An example email' },
    options: [
      { id: 'keep', label: 'Keep' },
      { id: 'read', label: 'Mark read' },
      { id: 'archive', label: 'Archive' },
      { id: 'both', label: 'Both' },
      { id: 'later', label: 'Later' }
    ]
  });
  const tray = {
    questions: [
      q('unsupported-job', 'job_opportunities', 'Do you want job opportunities in your inbox?'),
      q('product', 'product_announcements', 'Do you want product announcements in your inbox?'),
      q('newsletter', 'newsletters', 'Do you want newsletters and blog updates in your inbox?')
    ],
    memories: [],
    discovery: null
  };
  let release;
  const discoveryGate = new Promise(resolve => {
    release = resolve;
  });
  let discoveryFails = false;
  let learned = false;
  let ran = false;
  let repairRequested = false;
  let notesPreview;
  let notesSaved = false;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let json;
    if (path === '/api/status') json = state;
    else if (path === '/api/mailbox') json = { unread: 20000, messages: 25000 };
    else if (path === '/api/agent/questions') json = { ...tray, questionsTotal: tray.questions.length };
    else if (path === '/api/rules') {
      const data = route.request().postDataJSON();
      state.rules = { ...data, agent: { ...DEFAULT_PREFERENCES, ...data.agent } };
      json = { rules: state.rules };
    } else if (path === '/api/routine/pause') {
      const duration = route.request().postDataJSON().duration;
      state.rules.dailyPausedUntil =
        duration === 'resume'
          ? 0
          : duration === 'indefinite'
            ? -1
            : Date.now() + { day: 1, week: 7, month: 30 }[duration] * 86400000;
      json = { rules: state.rules };
    } else if (path === '/api/agent/reassess-trial') {
      assert.equal(route.request().postDataJSON().authorize, true);
      repairRequested = true;
      state.access = { ...state.access, recoveryAvailable: false, recovering: true, remaining: 100 };
      json = { status: 'ready', sampleCount: 100 };
    } else if (path === '/api/agent/learn') {
      if (discoveryFails)
        return route.fulfill({
          status: 400,
          json: {
            error: 'Nebius Token Factory reached its response limit before returning a complete decision.',
            code: 'AI_TRUNCATED'
          }
        });
      learned = true;
      await discoveryGate;
      tray.discovery = {
        inspected: 100,
        evidenceCategories: ['product_announcements', 'newsletters'],
        summary: 'Product updates and publications recur.',
        suggestions: []
      };
      json = tray.discovery;
    } else if (path === '/api/agent/questions/interpret') {
      const data = route.request().postDataJSON();
      assert.match(data.text, /90 days/);
      json = { supported: true, action: 'archive', minAgeDays: 90, instructions: data.text };
    } else if (path === '/api/agent/questions/answer') {
      const data = route.request().postDataJSON();
      assert.notEqual(data.questionId, 'unsupported-job');
      const item = tray.questions.find(q => q.id === data.questionId);
      tray.questions = tray.questions.filter(q => q !== item);
      tray.memories.push({
        id: item.id,
        version: 1,
        scope: item.scope,
        sourceQuestion: item.id,
        initialSampleIds: ['sample'],
        action: data.option === 'custom' ? data.action : data.option,
        minAgeDays: data.minAgeDays || 0,
        instructions: data.instructions || '',
        explanation: item.question
      });
      if (item.id === 'newsletter')
        for (const label of ['University notices', 'Community discussions', 'Travel offers', 'Delivery updates'])
          tray.memories.push({
            id: label,
            version: 1,
            scope: { kind: 'category', category: `topic_${label.toLowerCase().replaceAll(' ', '_')}`, label },
            action: 'read',
            initialSampleIds: ['sample']
          });
      json = { status: 'saved' };
    } else if (path === '/api/agent/preferences/interpret') {
      const data = route.request().postDataJSON();
      const survey = data.text.includes('survey');
      notesPreview = {
        supported: true,
        topics: [
          {
            scope: {
              kind: 'category',
              category: survey ? 'surveys_feedback' : 'product_announcements',
              label: survey ? 'Surveys and feedback' : 'Product announcements'
            },
            action: survey ? 'read' : 'archive',
            minAgeDays: survey ? 0 : 30,
            instructions: data.text,
            replaces: !survey
          }
        ],
        context: '',
        token: 'fixture-preview'
      };
      json = notesPreview;
    } else if (path === '/api/agent/preferences/save') {
      assert.equal(route.request().postDataJSON().token, 'fixture-preview');
      for (const topic of notesPreview.topics) {
        const old = tray.memories.find(m => m.scope.category === topic.scope.category);
        if (old) Object.assign(old, topic, { version: old.version + 1 });
        else tray.memories.push({ ...topic, id: 'written-topic', version: 1 });
      }
      notesSaved = true;
      json = { status: 'saved' };
    } else if (path === '/api/agent/memories/edit') {
      const data = route.request().postDataJSON();
      const memory = tray.memories.find(m => m.id === data.memoryId);
      if (data.remove) tray.memories = tray.memories.filter(m => m !== memory);
      else {
        Object.assign(memory, { action: data.action, minAgeDays: data.minAgeDays, instructions: data.instructions });
        memory.version++;
      }
      json = { status: 'saved' };
    } else if (path === '/api/agent/run') {
      ran = true;
      assert.equal(notesSaved, true);
      assert.equal(state.rules.agent.topicActions, true);
      assert.equal(tray.memories.find(m => m.id === 'product').action, 'archive');
      assert.equal(tray.memories.find(m => m.id === 'newsletter').action, 'read');
      assert.equal(state.rules.agent.autoUnsubscribe, false);
      return route.fulfill({
        contentType: 'application/x-ndjson',
        body:
          [
            { type: 'stage', message: 'Reading', total: 2 },
            {
              type: 'decision',
              action: 'archive',
              subject: 'Promotion',
              reason: 'Low priority',
              inspected: 1,
              changed: 1,
              kept: 0,
              total: 2
            },
            { type: 'complete', inspected: 2, changed: 1, kept: 1 }
          ]
            .map(e => JSON.stringify(e))
            .join('\n') + '\n'
      });
    } else throw new Error(`Unexpected route: ${path}`);
    await route.fulfill({ json });
  });
  async function check(stage) {
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
      [320, 568]
    ]) {
      await page.setViewportSize({ width, height });
      assert.equal(await page.locator('.sidebar').isVisible(), false, `${stage}: sidebar`);
      assert.equal(
        await page.evaluate(
          () =>
            document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth
        ),
        true,
        `${stage}: viewport overflow at ${width}x${height}`
      );
      const bounds = await page.locator('.ob-panel').boundingBox();
      const footer = await page.locator('.ob-footer').boundingBox();
      const header = await page.locator('.ob-header').boundingBox();
      assert.ok(
        bounds.y >= header.y + header.height - 1 && bounds.y + bounds.height <= footer.y + 1,
        `${stage}: content overlaps header/footer at ${width}x${height}: ${JSON.stringify(bounds)}`
      );
      const primary = (await page.locator('#onboarding button').count())
        ? await page.locator('#onboarding button').last().boundingBox()
        : null;
      await page.screenshot({ path: `${output}/${stage}-${width}.png` });
      if (primary)
        assert.ok(
          primary.y + primary.height <= height - 12,
          `${stage}: button outside viewport at ${width}x${height}: ${JSON.stringify(primary)}`
        );
      await page.screenshot({ path: `${output}/${stage}-${width}.png` });
    }
  }
  await page.goto('http://localhost:3071/app?auth=connected');
  await page.getByRole('heading', { name: /A little thinking/ }).waitFor();
  assert.equal(learned, false);
  assert.equal(ran, false);
  await check('consent');
  await page.locator('#ob-consent').check();
  await page.locator('#ob-discover').click();
  await page.getByRole('heading', { name: 'Getting to know your inbox.' }).waitFor();
  await check('thinking');
  release();
  await page.getByRole('heading', { name: 'Do you want product announcements in your inbox?' }).waitFor();
  assert.equal(await page.locator('#onboarding h1').count(), 1);
  await check('question');
  await page.getByRole('button', { name: 'Or write my own answer' }).click();
  await check('written-answer');
  await page
    .getByRole('textbox', { name: 'Your written preference' })
    .fill('Archive product announcements after 90 days, but keep Apple announcements.');
  await page.getByRole('button', { name: /Understand my answer/ }).click();
  await page.locator('.custom-summary').waitFor();
  await check('written-preview');
  assert.equal(tray.memories.length, 0, 'Interpretation must not save a preference');
  await page.getByRole('button', { name: /Save this preference/ }).click();
  await page.getByRole('heading', { name: 'Do you want newsletters and blog updates in your inbox?' }).waitFor();
  await page.reload();
  await page.getByRole('heading', { name: 'Do you want newsletters and blog updates in your inbox?' }).waitFor();
  await page.locator('#onboarding input[value=read]').check();
  await page.locator('#ob-question button').click();
  await page.getByRole('heading', { name: 'Your preferences, ready.' }).waitFor();
  assert.equal(ran, false);
  await check('permission');
  assert.equal(await page.locator('.ob-topic-row').count(), 3);
  assert.equal(await page.locator('#ob-start').count(), 0, 'Cannot skip unread preference pages');
  assert.equal(await page.locator('#ob-notes').count(), 0);
  assert.equal(await page.locator('#ob-next.primary').count(), 1);
  await page.locator('#ob-next').click();
  await page.locator('[aria-label="Action for Community discussions"]').waitFor();
  await check('more-topics');
  await page.locator('#ob-prev').click();
  await page.locator('[aria-label="Action for product announcements"]').waitFor();
  assert.equal(await page.locator('[aria-label="Action for product announcements"]').inputValue(), 'archive');
  assert.equal(await page.locator('[aria-label="Action for newsletters"]').inputValue(), 'read');
  assert.equal(await page.locator('#ob-start').count(), 0, 'Going back must still lead through the next page');
  await page.locator('#ob-next').click();
  await page.locator('#ob-start').click();
  await page.getByRole('heading', { name: 'Anything else we should know?' }).waitFor();
  assert.equal(ran, false);
  await check('final-notes');
  await page.locator('#ob-notes').fill('Archive product announcements after 30 days, but keep Apple announcements.');
  await page.getByRole('button', { name: /Review my instructions/ }).click();
  await page.locator('.notes-preview').waitFor();
  await check('final-notes-preview');
  assert.equal(notesSaved, false);
  assert.equal(ran, false);
  await page.getByRole('button', { name: /Save these preferences/ }).click();
  await page.getByRole('heading', { name: 'Your first fresh start.' }).waitFor();
  await check('complete');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.ob-content').evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.locator('#ob-dashboard').click();
  assert.equal(await page.locator('.sidebar').isVisible(), true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.nav-item[data-page=rules]').click();
  await page.getByRole('heading', { name: 'Your preferences', exact: true }).waitFor();
  assert.equal(await page.locator('.preference-row').count(), 6);
  assert.equal(await page.locator('.preference-row[open]').count(), 0);
  assert.equal(await page.locator('.preference-settings[open]').count(), 0);
  assert.equal(
    await page.locator('#agent-consent, #rule-daily, #rule-hour, #rule-ai').count(),
    0,
    'Consent belongs to onboarding and schedule belongs to one settings section'
  );
  await page.screenshot({ path: `${output}/preferences-desktop.png` });
  await page.locator('#preference-search').fill('product');
  assert.equal(await page.locator('.preference-row').count(), 1);
  await page.locator('.preference-row summary').click();
  await page.locator('.memory-card select').selectOption('both');
  await page.getByRole('button', { name: 'Save change', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('.preference-row summary').textContent.includes('Read & archive')
  );
  let cleanups = 0;
  page.on('request', request => {
    if (request.url().endsWith('/api/agent/run')) cleanups++;
  });
  await page.locator('#preference-notes').fill('Mark survey requests as read.');
  await page.getByRole('button', { name: /Review my instructions/ }).click();
  await page.locator('.notes-preview').waitFor();
  assert.equal(
    tray.memories.some(m => m.scope.category === 'surveys_feedback'),
    false
  );
  await page.getByRole('button', { name: /Save these preferences/ }).click();
  await page.waitForFunction(() => document.querySelector('#preference-notes').value === '');
  assert.equal(tray.memories.find(m => m.scope.category === 'surveys_feedback').action, 'read');
  assert.equal(cleanups, 0);
  await page.locator('#preference-search').fill('');
  await page.locator('[data-preference-page="1"]').click();
  assert.equal(await page.locator('.preference-row').count(), 1);
  state.schedulerActive = true;
  state.access.tier = 'hackathon';
  state.rules.daily = true;
  await page.reload();
  await page.locator('.nav-item[data-page=rules]').click();
  await page.locator('.preference-settings:has(#preferences-form) > summary').click();
  for (const [duration, days] of [
    ['day', 1],
    ['week', 7],
    ['month', 30]
  ]) {
    const start = Date.now();
    await page.locator('#routine-pause-duration').selectOption(duration);
    await page.locator('#routine-pause').click();
    await page.waitForFunction(
      () =>
        document.body.getAttribute('aria-busy') === 'false' &&
        document.querySelector('#routine-pause-status').textContent.includes('Resumes automatically')
    );
    assert.ok(state.rules.dailyPausedUntil >= start + days * 86400000);
    assert.equal(state.rules.daily, true);
    assert.equal(state.rules.agent.consent, true);
  }
  await page.locator('#routine-pause-duration').selectOption('indefinite');
  await page.locator('#routine-pause').click();
  await page.waitForFunction(
    () =>
      document.body.getAttribute('aria-busy') === 'false' &&
      document.querySelector('#routine-pause-status').textContent.includes('until you resume')
  );
  assert.equal(state.rules.dailyPausedUntil, -1);
  await page.reload();
  await page.locator('.nav-item[data-page=rules]').click();
  await page.locator('.preference-settings:has(#preferences-form) > summary').click();
  assert.match(await page.locator('#routine-pause-status').textContent(), /until you resume/);
  await page.screenshot({ path: `${output}/daily-routine-paused.png`, fullPage: true });
  await page.locator('#routine-resume').click();
  await page.waitForFunction(
    () =>
      document.body.getAttribute('aria-busy') === 'false' &&
      document.querySelector('#routine-pause-status').textContent.includes('active')
  );
  assert.equal(state.rules.dailyPausedUntil, 0);
  assert.equal(state.rules.daily, true);
  assert.equal(cleanups, 0, 'Changing pauses must not invoke manual cleanup');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      'Preferences must not overflow horizontally'
    );
    await page.screenshot({ path: `${output}/preferences-${width}.png` });
  }
  await page.locator('.legacy-settings > summary').click();
  for (const width of [1440, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.locator('.settings-main').evaluate(main =>
      [...main.querySelectorAll('fieldset')].map(fieldset => {
        const bounds = fieldset.getBoundingClientRect();
        const legend = fieldset.querySelector('legend').getBoundingClientRect();
        return {
          title: fieldset.querySelector('legend').textContent,
          right: bounds.right,
          legendBottom: legend.bottom,
          rows: [...fieldset.querySelectorAll('.check-row')].map(row => {
            const r = row.getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top };
          })
        };
      })
    );
    for (const field of layout)
      for (const row of field.rows) {
        assert.ok(
          row.right <= field.right + 1,
          `Advanced ${field.title}: checkbox row escapes its fieldset at ${width}px`
        );
        assert.ok(
          row.top >= field.legendBottom - 1,
          `Advanced ${field.title}: checkbox overlaps heading at ${width}px`
        );
      }
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `Advanced settings overflow at ${width}px`
    );
    await page.locator('.legacy-settings').screenshot({ path: `${output}/advanced-${width}.png` });
  }
  // Reconnecting a configured account in unrestricted mode must not replay setup,
  // run discovery, reset its daily routine, or automatically retry a failed run.
  state.access = { tier: 'hackathon', used: 0, remaining: 100, dailyAllowed: true };
  state.rules.daily = true;
  state.rules.agent.enabled = true;
  state.rules.agent.consent = true;
  state.rules.agent.consentProvider = state.aiProvider;
  state.runs = [{ status: 'needs_review', changed: 0, created: Date.now(), kind: 'cleanup' }];
  learned = false;
  ran = false;
  await page.goto('http://localhost:3071/app?auth=connected');
  await page.waitForFunction(() => !document.body.classList.contains('booting'));
  assert.equal(await page.locator('#onboarding').isVisible(), false);
  assert.equal(learned, false, 'Reconnect must not trigger discovery again');
  assert.equal(ran, false, 'Reconnect must not retry cleanup automatically');
  assert.equal(state.rules.daily, true, 'Reconnect preserves the saved daily routine');
  state.access = { ...state.access, tier: 'free', used: 100, remaining: 0, recoveryAvailable: true };
  state.runs = [{ status: 'completed', changed: 0, created: Date.now(), kind: 'cleanup' }];
  await page.reload();
  await page.getByRole('heading', { name: 'Let’s take another look.' }).waitFor();
  await check('repair-consent');
  assert.equal(repairRequested, false);
  await page.locator('#ob-consent').check();
  await page.locator('#ob-discover').click();
  await page.getByRole('heading', { name: 'Your preferences, ready.' }).waitFor();
  assert.equal(repairRequested, true);
  discoveryFails = true;
  state.access = { ...state.access, used: 0, remaining: 100, recoveryAvailable: false, recovering: false };
  state.rules.agent.enabled = false;
  state.rules.agent.consent = false;
  tray.discovery = null;
  await page.reload();
  await page.locator('#ob-consent').check();
  await page.locator('#ob-discover').click();
  await page.getByRole('heading', { name: 'Your inbox can wait.' }).waitFor();
  assert.match(await page.locator('#onboarding').innerText(), /couldn’t finish learning your preferences/);
  assert.doesNotMatch(
    await page.locator('#onboarding').innerText(),
    /Nebius|Token Factory|OpenRouter|response limit|API|model/i
  );
  await check('plain-language-error');
  assert.deepEqual(errors, []);
  console.log(
    'PASS consent; sequential questions; final written instructions preview and confirmation before cleanup; compact searchable/paginated preference editors; future written preferences save without running cleanup; mobile layouts; streamed cleanup; reduced motion. Gmail/model are fixtures.'
  );
} finally {
  await browser.close();
  await app.close();
}
