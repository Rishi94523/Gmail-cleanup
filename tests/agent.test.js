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
import { DEFAULT_PREFERENCES, preferences, decisionFor, emailText, runAgent, learnInbox, modelDecisionBatch } from '../server/agent.js';
import { accessFor, restartTrial, reserveFreeEmail } from '../server/access.js';

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

test('batched agent handles 45 approved low-priority messages in five model calls and preserves security alerts', async t => {
  const f = fixture(t, { topicActions: true, keepPeople: false });
  const original = structuredClone(f.mails.get('noise')); f.mails.clear();
  for (let i = 0; i < 45; i++) f.mails.set(`promo-${i}`, { ...structuredClone(original), id: `promo-${i}` });
  const security = { ...structuredClone(original), id: 'security' }; security.payload.headers[1].value = 'Security alert: a new sign-in'; f.mails.set('security', security);
  f.store.run('INSERT INTO preference_memories(id,account_id,scope_hash,payload,updated) VALUES(?,?,?,?,?)', 'product-pref', f.id, 'category:product_announcements', f.crypto.seal({ scope: { kind: 'category', category: 'product_announcements', scopeHash: 'category:product_announcements' }, action: 'read', effectiveFrom: 0 }), Date.now());
  const originalFetch = globalThis.fetch; let calls = 0; let active = 0; let peak = 0;
  globalThis.fetch = async (_url, options) => {
    calls++; active++; peak = Math.max(peak, active);
    const body = JSON.parse(options.body); assert.equal(body.max_tokens, undefined);
    const items = JSON.parse(body.messages[1].content); assert.ok(items.length <= 10);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ decisions: items.map(item => ({ id: item.id, decision: { action: 'read', confidence: .94, preferenceCategory: 'product_announcements', categoryConfidence: .96, reason: 'An ordinary promotion in the topic you approved.' } })) }) } }] });
  };
  try {
    const result = await f.service.locked(f.id, guard => runAgent(f.service, f.id, guard));
    assert.equal(result.changed, 45); assert.equal(result.kept, 1); assert.equal(calls, 5); assert.equal(peak, 2);
    assert.ok(f.mails.get('security').labelIds.includes('UNREAD'));
    assert.equal((await accessFor(f.service, f.id)).used, 46);
  } finally { globalThis.fetch = originalFetch; }
});

test('incomplete model batch cannot modify any message in that window', async t => {
  const f = fixture(t, { keepPeople: false }); const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ decisions: [{ id: 'invented-id', decision: { action: 'read', confidence: 1, reason: 'Must not apply' } }] }) } }] });
  try {
    const result = await f.service.locked(f.id, guard => runAgent(f.service, f.id, guard));
    assert.ok(result.waiting > 0);
    assert.equal(f.writes.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('one explicit reassessment revisits only the original zero-change trial without resetting lifetime usage', async t => {
  const f = fixture(t, { keepPeople: false });
  await f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'manual', async () => ({ action: 'keep', confidence: 1, reason: 'Kept during the earlier run' })));
  assert.equal((await accessFor(f.service, f.id)).recoveryAvailable, true);
  await assert.rejects(restartTrial(f.service, f.id, false), /Authorize/);
  const used = (await accessFor(f.service, f.id)).used;
  f.store.run('INSERT INTO agent_holds(account_id,message_id,scope_hash,created) VALUES(?,?,?,?)', f.id, 'noise', 'category:product_announcements', Date.now());
  await f.service.locked(f.id, () => restartTrial(f.service, f.id, true));
  assert.equal(f.store.get('SELECT count(*) AS n FROM agent_holds').n, 0);
  assert.equal((await accessFor(f.service, f.id)).used, used);
  assert.equal(await reserveFreeEmail(f.service, f.id, 'outside-original-sample', true), false);
  f.mails.set('later', { ...structuredClone(f.mails.get('noise')), id: 'later' });
  const result = await f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'manual', f.infer));
  assert.ok(result.changed > 0); assert.ok(f.mails.get('later').labelIds.includes('UNREAD'));
  assert.equal((await accessFor(f.service, f.id)).used, used);
  assert.equal((await accessFor(f.service, f.id)).recoveryAvailable, false);
  await assert.rejects(restartTrial(f.service, f.id, true), /not available/);
});

test('HTML-only mail is readable as text without scripts, styles, or attachments', () => {
  const payload = { mimeType: 'text/html', body: { data: Buffer.from('<style>hidden styles</style><script>hidden code</script><p>New features &amp; updates</p>').toString('base64url') } };
  assert.equal(emailText(payload), 'New features & updates');
});

test('grouped discovery preserves evidence through alias mapping and topic selection', async t => {
  const f = fixture(t, { topicActions: true }); const original = structuredClone(f.mails.get('noise')); f.mails.clear();
  for (let i = 0; i < 100; i++) { const message = { ...structuredClone(original), id: `opaque-${i}` }; message.payload.headers[1].value = i < 50 ? 'Weekend sale and discounts' : 'Weekly newsletter digest'; f.mails.set(message.id, message); }
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++; const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    if (input[0].candidateId) { assert.equal(input.length, 2, 'Exact topic duplicates must be combined before the merge call'); assert.equal(input.find(item => item.category === 'sales_discounts').minAgeDays, 90); }
    const result = input[0].candidateId ? { selected: ['question_1', 'question_2'] } : { summary: 'Recurring topics.', questions: [{ messageId: input[0].id, category: input[0].subject.includes('sale') ? 'sales_discounts' : 'newsletters', minAgeDays: input[0].id === 'email_26' ? 90 : 0, question: 'How should I handle offers from this particular brand?', reason: 'This is a recurring topic in this part of the sample.', evidenceQuote: input[0].subject }] };
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] });
  };
  try {
    await learnInbox(f.service, f.id, true, 'openrouter');
    const questions = f.store.all('SELECT payload FROM agent_questions').map(row => f.crypto.open(row.payload));
    assert.equal(calls, 5); assert.equal(questions.length, 2);
    assert.ok(questions.every(question => !question.question.includes('brand')));
    assert.deepEqual(questions.map(q => q.scope.category).sort(), ['newsletters', 'sales_discounts']);
    assert.ok(questions.every(q => ['Weekend sale and discounts', 'Weekly newsletter digest'].includes(q.sample.subject)));
  } finally { globalThis.fetch = originalFetch; }
});

test('discovery fetches headers only and never sends bodies or snippets to the model', async t => {
  const f = fixture(t); const secretBody = 'BODY_ONLY_DISCOVERY_CANARY';
  for (const message of f.mails.values()) { message.snippet = secretBody; message.payload.body.data = Buffer.from(secretBody).toString('base64url'); }
  const originalFactory = f.service.clientFactory; const paths = [];
  f.service.clientFactory = (...args) => { const client = originalFactory(...args); return async (path, ...rest) => { paths.push(path); return client(path, ...rest); }; };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    assert.ok(!options.body.includes(secretBody));
    const body = JSON.parse(options.body); const input = JSON.parse(body.messages[1].content);
    for (const item of input) for (const field of ['text','body','snippet','payload']) assert.equal(Object.hasOwn(item, field), false);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ questions: [{ messageId: input[0].id, category: 'topic_body_only_evidence', question: 'How should I handle this topic?', reason: 'A fabricated body citation must be rejected.', evidenceQuote: secretBody }] }) } }] });
  };
  try {
    await learnInbox(f.service, f.id, true, 'openrouter');
    const reads = paths.filter(path => path.startsWith('messages/')); assert.equal(reads.length, 4);
    for (const path of reads) { const params = new URLSearchParams(path.split('?')[1]); assert.equal(params.get('format'), 'metadata'); assert.deepEqual(params.getAll('metadataHeaders').sort(), ['Date','From','List-ID','Subject']); }
    assert.equal(f.store.get('SELECT count(*) AS n FROM agent_questions').n, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('batch preference proposal beside the id normalizes to a question, never a mailbox action', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ decisions: [{ id: 'email_1', requestPreference: { category: 'product_announcements', question: 'How should I handle announcements?', reason: 'Preference unknown' } }] }) } }] });
  try {
    const result = await modelDecisionBatch({ aiKey: 'fixture' }, 'Decide from saved preferences.', [{ id: 'opaque-gmail-id' }]);
    assert.equal(result.get('opaque-gmail-id').requestPreference.category, 'product_announcements');
    assert.equal(result.get('opaque-gmail-id').action, undefined);
  } finally { globalThis.fetch = originalFetch; }
});

test('duplicate and missing batch entries keep only affected messages; unknown ids cannot authorize writes', async () => {
  const originalFetch = globalThis.fetch;
  const decision = { action: 'read', confidence: .99, reason: 'Low-priority promotion' };
  globalThis.fetch = async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ decisions: [null, { id: 'email_1', decision }, { id: 'email_1', decision }, { id: 'email_2', decision }, { id: 'invented', decision }] }) } }] });
  try {
    const result = await modelDecisionBatch({ aiKey: 'fixture' }, 'Decide from saved preferences.', [{ id: 'first' }, { id: 'second' }, { id: 'missing' }]);
    assert.equal(result.get('first').action, 'keep'); assert.equal(result.get('second').action, 'read'); assert.equal(result.get('missing').action, 'keep');
    assert.equal(result.has('invented'), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('older routine bank/login notices obey their own age and written preferences; recent and unresolved alerts stay', async t => {
  const f = fixture(t, { topicActions: true, keepPeople: false });
  const base = structuredClone(f.mails.get('noise')); f.mails.clear();
  const add = (id, days, subject, extra = {}) => {
    const message = { ...structuredClone(base), id, internalDate: days === null ? 'invalid' : String(Date.now() - days * 86400000), ...extra };
    message.payload.headers = [{ name: 'From', value: 'Account notices <notices@bank.example>' }, { name: 'Subject', value: subject }, { name: 'Date', value: 'Mon, 1 Jan 2001 12:00:00 +0000' }];
    f.mails.set(id, message);
  };
  add('old-bank', 120, 'Bank transaction confirmation'); add('new-bank', 10, 'Bank transaction confirmation'); add('not-old-enough', 60, 'Bank transaction confirmation');
  add('old-login', 120, 'Login confirmation'); add('current-login', 1, 'Login confirmation'); add('fraud', 120, 'Suspicious bank transaction');
  add('ambiguous', 120, 'Bank transaction detail'); add('undated', null, 'Bank transaction confirmation');
  for (const [category, minAgeDays] of [['bank_transactions', 90], ['security_notices', 60]]) {
    f.store.run('INSERT INTO preference_memories(id,account_id,scope_hash,payload,updated) VALUES(?,?,?,?,?)', category, f.id, `category:${category}`, f.crypto.seal({ scope: { kind: 'category', category, scopeHash: `category:${category}`, minimumAgeDays: 30 }, action: 'read', minAgeDays, instructions: 'Keep unusual activity alerts.', effectiveFrom: 0 }), Date.now());
  }
  let calls = 0;
  const infer = async (_config, _prompt, input) => {
    calls++; assert.ok(input.currentClock.currentDate); assert.equal(input.fromAddress, 'notices@bank.example'); assert.ok(input.sender.includes('@bank.example')); assert.equal(input.sentAt, '2001-01-01T12:00:00.000Z');
    assert.equal(input.categoryPreferences.find(memory => memory.scope.category === 'bank_transactions').instructions, 'Keep unusual activity alerts.');
    return { action: 'read', confidence: .99, preferenceCategory: input.sensitiveNoticeCategory, categoryConfidence: .99, routineNotice: input.subject !== 'Bank transaction detail', reason: 'Routine historical confirmation.' };
  };
  const result = await f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'manual', infer));
  assert.equal(result.changed, 2); assert.equal(calls, 4);
  for (const id of ['old-bank', 'old-login']) assert.ok(!f.mails.get(id).labelIds.includes('UNREAD'));
  for (const id of ['new-bank', 'not-old-enough', 'current-login', 'fraud', 'ambiguous', 'undated']) assert.ok(f.mails.get(id).labelIds.includes('UNREAD'));
});

test('discovery supplies from address, sent/received dates, trustworthy age and the current clock', async t => {
  const f = fixture(t); const old = f.mails.get('noise'); old.internalDate = String(Date.now() - 120 * 86400000); old.payload.headers[1].value = 'Bank transaction confirmation';
  old.payload.headers.push({ name: 'Date', value: 'Mon, 1 Jan 2001 12:00:00 +0000' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); assert.match(body.messages[0].content, /Current clock:.*currentDate/);
    const sample = JSON.parse(body.messages[1].content); const email = sample.find(item => item.subject === 'Bank transaction confirmation');
    assert.equal(email.fromAddress, 'noise@example.invalid'); assert.equal(email.sentAt, '2001-01-01T12:00:00.000Z'); assert.ok(email.ageDays >= 120 && email.ageDays < 121);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ questions: [{ messageId: email.id, category: 'bank_transactions', minAgeDays: 90, question: 'How should I handle old bank confirmations?', reason: 'Routine bank notices are several months old.', evidenceQuote: email.subject }] }) } }] });
  };
  try {
    await learnInbox(f.service, f.id, true, 'openrouter');
    const question = f.crypto.open(f.store.get('SELECT payload FROM agent_questions').payload);
    assert.match(question.question, /older than 90 days/); assert.equal(question.minAgeDays, 90);
  } finally { globalThis.fetch = originalFetch; }
});
