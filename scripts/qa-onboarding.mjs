import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createApp } from '../server/index.js';
import { DEFAULT_RULES } from '../server/rules.js';
import { DEFAULT_PREFERENCES } from '../server/agent.js';

const output = 'data/qa-onboarding'; await mkdir(output, { recursive: true });
const app = await createApp({ dataDir: `${output}/db`, config: { databaseUrl: '', encryptionKey: '', scheduler: false, appUrl: 'http://localhost:3071', port: 3071 } });
await new Promise(resolve => app.server.listen(3071, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); const errors = []; page.on('pageerror', e => errors.push(e.message));
  const state = { connected: true, configured: true, aiConfigured: true, aiProvider: 'nebius', aiModel: 'fixture-model', schedulerActive: false, csrf: 'fixture', email: 'fixture@example.invalid', access: { tier: 'free', used: 0, remaining: 100 }, rules: { ...DEFAULT_RULES }, runs: [], subscriptions: [], totals: {}, setupMissing: [] };
  const q = (id, category, question) => ({ id, scope: { kind: 'category', category, label: category }, version: 1, initial: true, question, reason: 'A recurring pattern in this inbox sample.', sample: { subject: 'An example email' }, options: [{ id: 'keep', label: 'Keep' }, { id: 'read', label: 'Mark read' }, { id: 'later', label: 'Later' }] });
  const tray = { questions: [q('unsupported-job', 'job_opportunities', 'Do you want job opportunities in your inbox?'), q('product', 'product_announcements', 'Do you want product announcements in your inbox?'), q('newsletter', 'newsletters', 'Do you want newsletters and blog updates in your inbox?')], memories: [], discovery: null };
  let release; const discoveryGate = new Promise(resolve => { release = resolve; }); let learned = false; let ran = false;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname; let json;
    if (path === '/api/status') json = state;
    else if (path === '/api/mailbox') json = { unread: 20000, messages: 25000 };
    else if (path === '/api/agent/questions') json = { ...tray, questionsTotal: tray.questions.length };
    else if (path === '/api/rules') { const data = route.request().postDataJSON(); state.rules = { ...data, agent: { ...DEFAULT_PREFERENCES, ...data.agent } }; json = { rules: state.rules }; }
    else if (path === '/api/agent/learn') { learned = true; await discoveryGate; tray.discovery = { inspected: 100, evidenceCategories: ['product_announcements', 'newsletters'], summary: 'Product updates and publications recur.', suggestions: [] }; json = tray.discovery; }
    else if (path === '/api/agent/questions/answer') {
      const data = route.request().postDataJSON(); assert.notEqual(data.questionId, 'unsupported-job');
      const item = tray.questions.find(q => q.id === data.questionId); tray.questions = tray.questions.filter(q => q !== item);
      tray.memories.push({ id: item.id, version: 1, scope: item.scope, sourceQuestion: item.id, initialSampleIds: ['sample'], action: data.option, explanation: item.question }); json = { status: 'saved' };
    } else if (path === '/api/agent/memories/edit') { const data = route.request().postDataJSON(); const memory = tray.memories.find(m => m.id === data.memoryId); memory.action = data.action; memory.version++; json = { status: 'saved' }; }
    else if (path === '/api/agent/run') {
      ran = true; assert.equal(state.rules.agent.action, 'archive'); assert.equal(tray.memories.find(m => m.id === 'product').action, 'archive'); assert.equal(state.rules.agent.autoUnsubscribe, false);
      return route.fulfill({ contentType: 'application/x-ndjson', body: [{ type: 'stage', message: 'Reading', total: 2 }, { type: 'decision', action: 'archive', subject: 'Promotion', reason: 'Low priority', inspected: 1, changed: 1, kept: 0, total: 2 }, { type: 'complete', inspected: 2, changed: 1, kept: 1 }].map(e => JSON.stringify(e)).join('\n') + '\n' });
    } else throw new Error(`Unexpected route: ${path}`);
    await route.fulfill({ json });
  });
  async function check(stage) {
    for (const [width, height] of [[1440,900],[390,844],[320,568]]) {
      await page.setViewportSize({ width, height });
      assert.equal(await page.locator('.sidebar').isVisible(), false, `${stage}: sidebar`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth), true, `${stage}: viewport overflow at ${width}x${height}`);
      const bounds = await page.locator('.ob-panel').boundingBox(); const footer = await page.locator('.ob-footer').boundingBox(); const header = await page.locator('.ob-header').boundingBox();
      assert.ok(bounds.y >= header.y + header.height - 1 && bounds.y + bounds.height <= footer.y + 1, `${stage}: content overlaps header/footer at ${width}x${height}: ${JSON.stringify(bounds)}`);
      const primary = await page.locator('#onboarding button').count() ? await page.locator('#onboarding button').last().boundingBox() : null;
      await page.screenshot({ path: `${output}/${stage}-${width}.png` });
      if (primary) assert.ok(primary.y + primary.height <= height - 12, `${stage}: button outside viewport at ${width}x${height}: ${JSON.stringify(primary)}`);
      await page.screenshot({ path: `${output}/${stage}-${width}.png` });
    }
  }
  await page.goto('http://localhost:3071/app?auth=connected'); await page.getByRole('heading', { name: /A little thinking/ }).waitFor();
  assert.equal(learned, false); assert.equal(ran, false); await check('consent');
  await page.locator('#ob-consent').check(); await page.locator('#ob-discover').click();
  await page.getByRole('heading', { name: 'Getting to know your inbox.' }).waitFor(); await check('thinking');
  release(); await page.getByRole('heading', { name: 'Do you want product announcements in your inbox?' }).waitFor();
  assert.equal(await page.locator('#onboarding h1').count(), 1); await check('question');
  await page.getByLabel('Tidy low-priority emails like these').check(); await page.locator('#ob-question button').click();
  await page.getByRole('heading', { name: 'Do you want newsletters and blog updates in your inbox?' }).waitFor();
  await page.reload(); await page.getByRole('heading', { name: 'Do you want newsletters and blog updates in your inbox?' }).waitFor();
  await page.locator('#onboarding input[value=keep]').check(); await page.locator('#ob-question button').click();
  await page.getByRole('heading', { name: 'How shall I tidy up?' }).waitFor(); assert.equal(ran, false); await check('permission');
  await page.locator('#onboarding input[value=archive]').check();
  await page.locator('#ob-start').click(); await page.getByRole('heading', { name: 'Your first fresh start.' }).waitFor(); await check('complete');
  await page.emulateMedia({ reducedMotion: 'reduce' }); assert.equal(await page.locator('.ob-content').evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.locator('#ob-dashboard').click(); assert.equal(await page.locator('.sidebar').isVisible(), true);
  assert.deepEqual(errors, []);
  console.log('PASS consent before analysis; no sidebar or scrolling at desktop/390px/320px; animated analysis; evidence-only sequential questions; reload resumes; final archive permission; streamed cleanup; reduced motion; workspace after completion. Gmail/model are fixtures.');
} finally { await browser.close(); await app.close(); }
