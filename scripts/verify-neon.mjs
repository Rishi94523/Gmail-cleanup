import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { createApp } from '../server/index.js';
import { openPostgresStore } from '../server/postgres-store.js';
import { encryption, randomToken, hash } from '../server/security.js';
import { DEFAULT_RULES } from '../server/rules.js';
import { DEFAULT_PREFERENCES, runAgent } from '../server/agent.js';
import { askPreference } from '../server/learning.js';

// This destructive-fixture test is intentionally restricted to our expiring
// development branch. It never seeds mock accounts in production.
if (process.env.NEON_BRANCH !== 'dev-postgres-20261016') throw new Error('Run this verification only with the expiring development branch environment.');
const databaseUrl = process.env.DATABASE_URL;
const crypto = encryption(randomBytes(32).toString('base64'));
const owner = `verify-${randomUUID()}@example.invalid`;
const other = `verify-${randomUUID()}@example.invalid`;
const token = randomToken(); const otherToken = randomToken(); const csrf = randomToken();
const messages = new Map(['one', 'two'].map(id => [id, { id, internalDate: String(Date.now() - 150 * 86400000), labelIds: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'], payload: { headers: [{ name: 'From', value: 'offers@example.invalid' }, { name: 'Subject', value: 'Example sale' }] } }]));
let writes = 0;
const clientFactory = () => async (path, body) => {
  if (path.startsWith('messages?')) return { messages: [...messages.values()].filter(m => m.labelIds.includes('INBOX')).map(m => ({ id: m.id })) };
  if (path === 'labels') return { labels: [{ id: 'CLEANED', name: 'Cleaned by agent' }] };
  const message = messages.get(path.split('/')[1]?.split('?')[0]);
  if (!message) throw new Error('Unexpected test provider request.');
  if (body) { writes++; message.labelIds = [...new Set([...message.labelIds.filter(label => !body.removeLabelIds.includes(label)), ...body.addLabelIds])]; }
  return structuredClone(message);
};
const applications = [];
const call = (app, path, input, sessionToken = token) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port: app.server.address().port, path, method: input === undefined ? 'GET' : 'POST', headers: { Host: 'localhost:3000', Cookie: `inboxclean_session=${sessionToken}`, ...(input === undefined ? {} : { Origin: 'http://localhost:3000', 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }) } }, response => {
    let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
  }); req.on('error', reject); req.end(input === undefined ? undefined : JSON.stringify(input));
});
async function instance() {
  const app = await createApp({ config: { databaseUrl, encryptionKey: randomBytes(32).toString('base64'), appUrl: 'http://localhost:3000', scheduler: false, clientId: 'test-client', clientSecret: 'test-secret' }, clientFactory });
  // Share only a test encryption key across simulated replicas.
  app.service.crypto = crypto;
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); applications.push(app); return app;
}
let store;
try {
  const first = await instance(); store = first.store;
  for (const [id, sessionToken] of [[owner, token], [other, otherToken]]) {
    await store.run('INSERT INTO accounts(id,email,tokens,rules,created) VALUES(?,?,?,?,?)', id, id, crypto.seal({ refresh_token: 'test-only' }), JSON.stringify(DEFAULT_RULES), Date.now());
    await store.run('INSERT INTO sessions(id,account_id,csrf,expires) VALUES(?,?,?,?)', hash(sessionToken), id, csrf, Date.now() + 600000);
  }
  const health = await call(first, '/api/health'); assert.equal(health.status, 200); assert.equal(health.body.database, 'postgres'); assert.equal(health.body.connected, true);
  console.log('PASS real Neon connection through the running HTTP app');
  const rules = { ...DEFAULT_RULES, days: 120, markRead: true };
  assert.equal((await call(first, '/api/rules', rules)).status, 200);
  const second = await instance();
  assert.equal((await call(second, '/api/status')).body.rules.days, 120);
  console.log('PASS rule/session persistence across independent app instances');
  const scanned = await call(first, '/api/scan', {}); assert.equal(scanned.status, 200); assert.equal(scanned.body.plan.decisions.length, 2); assert.equal(writes, 0);
  const forbidden = await call(second, '/api/apply', { planId: scanned.body.plan.id, ids: ['one'] }, otherToken); assert.equal(forbidden.status, 400); assert.equal(writes, 0);
  const applied = await call(second, '/api/apply', { planId: scanned.body.plan.id, ids: ['one'] }); assert.equal(applied.status, 200); assert.equal(applied.body.changed, 1);
  assert.equal((await call(first, '/api/apply', { planId: scanned.body.plan.id, ids: ['one'] })).status, 400);
  console.log('PASS scan/approval/account isolation and duplicate prevention with persisted Neon records (Gmail test adapter)');
  const activity = await call(first, '/api/status'); assert.equal(activity.body.runs[0].undoable, true); assert.equal(activity.body.totals.cleaned, 1);
  assert.equal((await call(first, '/api/undo', { runId: applied.body.id })).status, 200); assert.ok(messages.get('one').labelIds.includes('UNREAD')); assert.ok(messages.get('one').labelIds.includes('INBOX'));
  console.log('PASS persisted cleanup history and undo (Gmail test adapter)');
  await first.service.locked(owner, async () => { await assert.rejects(second.service.scan(owner), /already running/); });
  console.log('PASS distributed account lock across two database pools');
  await assert.rejects(store.transaction(async tx => { await tx.run("UPDATE accounts SET last_error='rollback-test' WHERE id=?", owner); throw new Error('forced rollback'); }));
  assert.equal((await store.get('SELECT last_error FROM accounts WHERE id=?', owner)).last_error, null);
  console.log('PASS PostgreSQL transaction rollback');
  await first.service.saveRules(owner, { ...rules, daily: true, hour: 0, timezone: 'UTC' });
  await first.service.daily();
  const dailyWrites = writes;
  await second.service.daily();
  assert.equal(writes, dailyWrites);
  assert.equal((await store.get("SELECT count(*) AS total FROM runs WHERE account_id=? AND kind='daily'", owner)).total, 1);
  assert.equal(dailyWrites, 4);
  console.log('PASS once-per-day claim persisted across app instances (Gmail test adapter)');
  first.service.config.aiKey = 'test-only-key';
  await first.service.saveRules(owner, { ...rules, daily: false, agent: { ...DEFAULT_PREFERENCES, consent: true, consentProvider: first.service.config.aiProvider, enabled: true, keepPeople: false } });
  for (const message of messages.values()) message.labelIds = ['INBOX', 'UNREAD'];
  const result = await first.service.locked(owner, guard => runAgent(first.service, owner, guard, undefined, 'manual', async () => ({ action: 'read', confidence: .99, reason: 'Test-only AI decision' })));
  assert.equal(result.changed, 2);
  assert.equal((await store.get('SELECT count(*) AS total FROM agent_assessments WHERE account_id=?', owner)).total, 2);
  await first.service.undo(owner, result.runId);
  assert.ok(messages.get('one').labelIds.includes('UNREAD'));
  console.log('PASS autonomous agent decisions, durable assessment records, and undo on real Neon (Gmail and AI test adapters)');
  const beforeAnswerWrites = writes;
  const question = await askPreference(first.service, owner, messages.get('one'), (await first.service.account(owner)).rules.agent, { question: 'Do you want mail from this sender?', reason: 'Test-only uncertainty.' });
  const tray = await call(second, '/api/agent/questions');
  assert.equal(tray.body.questions[0].id, question.id);
  assert.equal((await call(second, '/api/agent/questions', undefined, otherToken)).body.questions.length, 0);
  const answer = { questionId: question.id, version: tray.body.questions[0].version, option: 'read' };
  assert.equal((await call(first, '/api/agent/questions/answer', answer, otherToken)).status, 400);
  assert.equal((await call(first, '/api/agent/questions/answer', answer)).status, 200);
  const saved = (await call(second, '/api/agent/questions')).body.memories[0];
  assert.equal(saved.action, 'read'); assert.equal(saved.applies, 'future_messages_only');
  assert.equal((await call(second, '/api/agent/memories/edit', { memoryId: saved.id, version: saved.version, action: 'keep' })).status, 200);
  assert.equal((await call(first, '/api/agent/memories/edit', { memoryId: saved.id, version: saved.version, action: 'read' })).status, 400);
  assert.equal(writes, beforeAnswerWrites);
  assert.equal((await store.get('SELECT count(*) AS n FROM agent_holds WHERE account_id=?', owner)).n, 1);
  console.log('PASS real Neon/HTTP question persistence across replicas, account isolation, future-only answers, editable versioned memory, and unchanged held mail');
  console.log('Neon end-to-end verification passed. Real database and HTTP app; Gmail provider was simulated and no real emails were accessed.');
} finally {
  if (store) for (const id of [owner, other]) await store.transaction(async tx => {
    for (const table of ['changes', 'plans', 'runs', 'subscriptions', 'locks', 'sessions', 'agent_assessments', 'agent_questions', 'preference_memories', 'preference_events', 'agent_holds', 'subscription_actions', 'agent_discoveries']) await tx.run(`DELETE FROM ${table} WHERE account_id=?`, id);
    await tx.run('DELETE FROM accounts WHERE id=?', id);
  });
  await Promise.all(applications.map(app => app.close()));
}
