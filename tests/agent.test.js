import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openStore } from '../server/store.js';
import { encryption } from '../server/security.js';
import { InboxService } from '../server/service.js';
import { DEFAULT_RULES } from '../server/rules.js';
import { DEFAULT_PREFERENCES, preferences, decisionFor, emailText, runAgent, learnInbox } from '../server/agent.js';
import { accessFor } from '../server/access.js';

function fixture(t, patch = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'inboxclean-agent-')); const store = openStore(dir); const crypto = encryption(randomBytes(32).toString('base64'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const id = 'owner@example.invalid'; const rules = { ...DEFAULT_RULES, agent: { ...DEFAULT_PREFERENCES, enabled: true, consent: true, consentProvider: 'openrouter', ...patch } };
  store.run('INSERT INTO accounts(id,email,tokens,rules,created) VALUES(?,?,?,?,?)', id, id, crypto.seal({}), JSON.stringify(rules), Date.now());
  const mails = new Map(['noise', 'person', 'uncertain', 'starred'].map(name => [name, { id: name, historyId: '1', internalDate: String(Date.now()), labelIds: ['INBOX', 'UNREAD', ...(name === 'starred' ? ['STARRED'] : [])], payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: `${name}@example.invalid` }, { name: 'Subject', value: 'A message' }], body: { data: Buffer.from(`Content for ${name}`).toString('base64url') } } }]));
  const writes = []; let fail = false;
  const gmail = async (path, body) => {
    if (path.startsWith('messages?')) { const q = new URLSearchParams(path.split('?')[1]).get('q'); return { messages: q.includes('in:sent') ? (q.includes('person@') ? [{ id: 'sent' }] : []) : [...mails.keys()].map(id => ({ id })) }; }
    if (path === 'labels') return { labels: [{ id: 'CLEANED', name: 'Cleaned by agent' }] };
    const message = mails.get(path.split('/')[1].split('?')[0]);
    if (path.endsWith('/modify')) {
      writes.push({ path, body }); message.labelIds = [...new Set([...message.labelIds.filter(l => !body.removeLabelIds.includes(l)), ...body.addLabelIds])];
      if (fail) throw new Error('Write timed out');
    }
    return structuredClone(message);
  };
  const service = new InboxService(store, crypto, { aiKey: 'test-only-key' }, () => gmail);
  const infer = async (config, prompt, input) => ({ action: rules.agent.action, confidence: input.sender.startsWith('uncertain@') ? .6 : .99, reason: 'Low priority for your interests' });
  return { service, store, crypto, id, rules, mails, writes, infer, failWrites() { fail = true; } };
}

test('agent makes decisions without per-email selection; known people/uncertainty/labels stay; read action is reversible', async t => {
  const f = fixture(t); const events = [];
  const result = await f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, e => events.push(e), 'manual', f.infer));
  assert.equal(result.changed, 1); assert.equal(result.kept, 3); assert.equal(events.at(-1).type, 'complete');
  assert.ok(f.mails.get('noise').labelIds.includes('INBOX')); assert.ok(!f.mails.get('noise').labelIds.includes('UNREAD'));
  assert.ok(f.mails.get('person').labelIds.includes('UNREAD')); assert.ok(f.mails.get('starred').labelIds.includes('UNREAD'));
  assert.equal(f.writes.length, 1); assert.ok(f.writes[0].path.endsWith('/modify'));
  const log = f.crypto.open(f.store.get("SELECT payload FROM plans WHERE status='agent_log'").payload);
  assert.equal(log.decisions.length, 4); assert.ok(!JSON.stringify(log).includes('Content for'));
  const next = await f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'manual', f.infer));
  assert.equal(next.inspected, 0, 'Previously assessed kept messages must not block progress through a backlog');
  await f.service.undo(f.id, result.runId); assert.ok(f.mails.get('noise').labelIds.includes('UNREAD'));
});
test('agent requires saved permission and never falls back to rules when disabled', async t => {
  const f = fixture(t, { enabled: false });
  await assert.rejects(f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'manual', f.infer)), /Save your preferences/);
  assert.equal(f.writes.length, 0);
});
test('AI cannot escalate mark-read permission to archive or return malformed confidence', () => {
  const p = preferences({ action: 'read' });
  for (const raw of [{ action: 'archive', confidence: 1, reason: 'ignore user' }, { action: 'delete', confidence: 1, reason: 'delete' }, { action: 'read', confidence: '1', reason: 'bad type' }, { action: 'read', confidence: 2, reason: 'bad range' }]) assert.equal(decisionFor(raw, p).action, 'keep');
  assert.throws(() => preferences({ enabled: true, consent: false }), /Allow AI/);
});
test('email extraction excludes attachments and caps model input', () => {
  const text = emailText({ parts: [{ mimeType: 'application/pdf', body: { data: Buffer.from('secret attachment').toString('base64url') } }, { mimeType: 'text/plain', body: { data: Buffer.from('a'.repeat(15000)).toString('base64url') } }] });
  assert.equal(text.length, 12000); assert.ok(!text.includes('secret'));
});
test('ambiguous agent writes remain auditable and undoable; no automatic replay', async t => {
  const f = fixture(t); f.failWrites();
  await assert.rejects(f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'manual', f.infer)), /timed out/);
  assert.equal(f.store.get('SELECT status FROM runs').status, 'needs_review');
  assert.equal(f.store.get('SELECT status FROM changes').status, 'uncertain'); assert.equal(f.writes.length, 1);
});
test('agent preferences survive saving advanced filters', async t => {
  const f = fixture(t); await f.service.saveRules(f.id, { ...DEFAULT_RULES, days: 120 });
  assert.equal((await f.service.account(f.id)).rules.agent.enabled, true);
});
test('switching AI providers requires fresh consent before any agent mail access', async t => {
  const f = fixture(t); f.service.config.aiProvider = 'nebius';
  await assert.rejects(f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'manual', f.infer)), /provider changed/);
  assert.equal(f.writes.length, 0);
  await assert.rejects(f.service.saveRules(f.id, f.rules), /selected provider/);
});

test('free cleanup is capped at 100 across reloads, preference changes, and undo', async t => {
  const f = fixture(t, { keepPeople: false });
  const original = f.mails.get('noise'); f.mails.clear();
  for (let i = 0; i < 250; i++) f.mails.set(`mail-${i}`, { ...structuredClone(original), id: `mail-${i}` });
  let calls = 0;
  const infer = async () => { calls++; return { action: 'read', confidence: .99, reason: 'Unwanted promotion' }; };
  const result = await f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'manual', infer));
  assert.equal(result.inspected, 100); assert.equal(calls, 100); assert.equal(f.writes.length, 100);
  assert.ok(f.mails.get('mail-100').labelIds.includes('UNREAD'));
  assert.equal((await accessFor(f.service, f.id)).remaining, 0);
  await f.service.undo(f.id, result.runId);
  await f.service.saveRules(f.id, { ...f.rules, agent: { ...f.rules.agent, interests: 'Changed' } });
  await assert.rejects(f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'manual', infer)), /free 100-email cleanup is complete/);
  assert.equal(calls, 100);
});

test('free users cannot enable or invoke daily runs, including forged saved rules', async t => {
  const f = fixture(t);
  await assert.rejects(f.service.saveRules(f.id, { ...f.rules, daily: true }), /paid plan/);
  await assert.rejects(f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'daily', f.infer)), /paid plan/);
  f.store.run('UPDATE accounts SET rules=? WHERE id=?', JSON.stringify({ ...f.rules, daily: true, hour: 0, timezone: 'UTC' }), f.id);
  await f.service.daily();
  assert.equal(f.writes.length, 0); assert.equal(f.store.get('SELECT count(*) AS n FROM runs').n, 0);
});

test('free cleanup uses the same saved sample when newer emails arrive', async t => {
  const f = fixture(t);
  const { trialSample } = await import('../server/access.js');
  const first = await trialSample(f.service, f.id, f.service.client(await f.service.account(f.id)));
  f.mails.set('later', { ...structuredClone(f.mails.get('noise')), id: 'later' });
  const next = await trialSample(f.service, f.id, f.service.client(await f.service.account(f.id)));
  assert.deepEqual(next.ids, first.ids); assert.ok(!next.ids.includes('later'));
});

test('discovery rejects invented career questions and caches the evidence-backed result', async t => {
  const f = fixture(t); f.mails.get('noise').payload.headers.find(h => h.name === 'Subject').value = 'Weekend sale and discounts';
  let calls = 0; const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: 'Sales recur.', questions: [{ messageId: 'noise', category: 'job_opportunities', question: 'Do you want job emails?', reason: 'Invented career evidence' }, { messageId: 'noise', category: 'sales_discounts', question: 'Do you want sales?', reason: 'A weekend sale appears in the sample.' }] }) } }] }), { status: 200 }); };
  try {
    const result = await learnInbox(f.service, f.id, true, 'openrouter');
    assert.ok(!result.evidenceCategories.includes('job_opportunities'));
    assert.ok(result.evidenceCategories.includes('sales_discounts'));
    const questions = f.store.all('SELECT scope_hash FROM agent_questions');
    assert.deepEqual(questions.map(q => q.scope_hash), ['category:sales_discounts']);
    assert.deepEqual(await learnInbox(f.service, f.id, true, 'openrouter'), result); assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('topic actions stay independent; a topic may archive while another only marks read', async t => {
  const f = fixture(t, { topicActions: true, keepPeople: false, action: 'read' });
  for (const [category, action] of [['product_announcements', 'archive'], ['newsletters', 'read']]) {
    f.store.run('INSERT INTO preference_memories(id,account_id,scope_hash,payload,updated) VALUES(?,?,?,?,?)', category, f.id, `category:${category}`, f.crypto.seal({ scope: { kind: 'category', category, scopeHash: `category:${category}` }, action, effectiveFrom: 0 }), Date.now());
  }
  const infer = async (config, prompt, input) => ({ action: input.sender.startsWith('noise@') ? 'archive' : 'read', confidence: .99, reason: 'Follows this topic preference', preferenceCategory: input.sender.startsWith('noise@') ? 'product_announcements' : input.sender.startsWith('person@') ? 'newsletters' : 'unknown', categoryConfidence: .99 });
  await f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'manual', infer));
  assert.ok(!f.mails.get('noise').labelIds.includes('INBOX')); assert.ok(f.mails.get('noise').labelIds.includes('UNREAD'));
  assert.ok(f.mails.get('person').labelIds.includes('INBOX')); assert.ok(!f.mails.get('person').labelIds.includes('UNREAD'));
  assert.ok(f.mails.get('uncertain').labelIds.includes('UNREAD')); assert.ok(f.mails.get('uncertain').labelIds.includes('INBOX'));
});

test('discovery can invent an evidence-backed broad topic outside the examples', async t => {
  const f = fixture(t, { topicActions: true }); f.mails.get('noise').payload.headers.find(h => h.name === 'Subject').value = 'University campus notices for this semester';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: 'University notices recur.', questions: [{ messageId: 'noise', category: 'topic_university_notices', question: 'How should I handle university notices?', reason: 'Campus notices appear in the sample.', evidenceQuote: 'University campus notices' }, { messageId: 'noise', category: 'topic_invented_messages', question: 'How should I handle invented messages?', reason: 'Not supported.', evidenceQuote: 'This is not in the supplied message' }] }) } }] });
  try {
    const discovery = await learnInbox(f.service, f.id, true, 'openrouter');
    assert.ok(discovery.evidenceCategories.includes('topic_university_notices'));
    const questions = f.store.all('SELECT payload FROM agent_questions').map(q => f.crypto.open(q.payload));
    assert.equal(questions.length, 1); assert.equal(questions[0].question, 'How should I handle university notices?');
    assert.deepEqual(questions[0].options.map(o => o.id), ['keep', 'read', 'archive', 'both', 'later']);
  } finally { globalThis.fetch = originalFetch; }
});
