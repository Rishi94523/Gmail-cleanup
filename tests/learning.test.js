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
import { DEFAULT_PREFERENCES, runAgent } from '../server/agent.js';
import { askPreference, answerPreference, editMemory, learningTray, scopeFor } from '../server/learning.js';
import { unsubscribeEligible, automaticUnsubscribe } from '../server/subscription-agent.js';
import { chatJSON } from '../server/ai.js';
import { categoryScope, matchingException, validateExceptions } from '../server/preference-categories.js';

function mail(id, subject = 'Product updates', listId = 'marketing.product.example') {
  const headers = { From: 'offers@product.example', Subject: subject, 'List-ID': `<${listId}>`, 'List-Unsubscribe': '<https://lists.product.example/leave>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', 'Authentication-Results': 'mx.google.com; dkim=pass header.i=@product.example;', 'DKIM-Signature': 'v=1; d=product.example; h=from:subject:list-unsubscribe:list-unsubscribe-post; b=fixture' };
  return { id, historyId: '1', internalDate: String(Date.now()), labelIds: ['INBOX', 'UNREAD'], payload: { mimeType: 'text/plain', body: { data: Buffer.from('A product announcement.').toString('base64url') }, headers: Object.entries(headers).map(([name, value]) => ({ name, value })) } };
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'inboxclean-learning-')); const store = openStore(dir); const crypto = encryption(randomBytes(32).toString('base64'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const id = 'owner@example.invalid'; const rules = { ...DEFAULT_RULES, agent: { ...DEFAULT_PREFERENCES, enabled: true, consent: true, consentProvider: 'openrouter', keepPeople: false, autoUnsubscribe: true } };
  store.run('INSERT INTO accounts(id,email,tokens,rules,created) VALUES(?,?,?,?,?)', id, id, crypto.seal({}), JSON.stringify(rules), Date.now());
  const messages = new Map([['one', mail('one')], ['two', mail('two')]]); let writes = 0;
  const gmail = async (path, body) => {
    if (path.startsWith('messages?')) return { messages: [...messages.keys()].map(id => ({ id })) };
    if (path === 'labels') return { labels: [{ id: 'CLEANED', name: 'Cleaned by agent' }] };
    const message = messages.get(path.split('/')[1].split('?')[0]);
    if (body) { writes++; message.labelIds = message.labelIds.filter(label => !body.removeLabelIds.includes(label)); }
    return structuredClone(message);
  };
  return { id, store, crypto, rules, messages, service: new InboxService(store, crypto, { aiKey: 'fixture-only', aiProvider: 'openrouter' }, () => gmail), writes: () => writes };
}
const args = { category: 'product_announcements', question: 'Do you want updates from this product?', reason: 'Your subscription intent is unclear.' };
test('brand-specific wording is normalized into one broad question across different senders', async t => {
  const f = fixture(t); const apple = mail('apple'); apple.payload.headers.find(h => h.name === 'From').value = 'news@apple.com';
  const a = await askPreference(f.service, f.id, f.messages.get('one'), f.rules.agent, args);
  const b = await askPreference(f.service, f.id, apple, f.rules.agent, { ...args, question: 'Do you want Apple announcements?' });
  assert.equal(a.id, b.id);
  const tray = await learningTray(f.service, f.id); assert.equal(tray.questions.length, 1);
  assert.equal(tray.questions[0].question, 'Do you want product announcements in your inbox?');
  assert.equal(tray.questions[0].scope.kind, 'category'); assert.equal(tray.questions[0].scope.sender, undefined);
  await answerPreference(f.service, f.id, { questionId: a.id, version: tray.questions[0].version, option: 'read' });
  const again = await askPreference(f.service, f.id, apple, f.rules.agent, args);
  assert.equal(again.status, 'already_learned'); assert.equal((await learningTray(f.service, f.id)).questions.length, 0);
});
test('a category answer applies to another brand and an Apple exception takes precedence', async t => {
  const f = fixture(t); await askPreference(f.service, f.id, f.messages.get('one'), f.rules.agent, args);
  const q = (await learningTray(f.service, f.id)).questions[0]; await answerPreference(f.service, f.id, { questionId: q.id, version: q.version, option: 'keep' });
  const memory = (await learningTray(f.service, f.id)).memories[0];
  const apple = mail('apple'); apple.internalDate = String(memory.effectiveFrom + 1000); apple.payload.headers.find(h => h.name === 'From').value = 'news@email.apple.com';
  const other = mail('other'); other.internalDate = apple.internalDate; other.payload.headers.find(h => h.name === 'From').value = 'news@another-product.example';
  f.messages.clear(); f.messages.set('apple', apple); f.messages.set('other', other);
  await f.service.saveRules(f.id, { ...f.rules, agent: { ...f.rules.agent, exceptionsRules: [{ id: 'apple-exception', type: 'domain', value: 'apple.com', category: 'product_announcements', action: 'read' }] } });
  const result = await f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'manual', async () => ({ action: 'read', confidence: .99, preferenceCategory: 'product_announcements', categoryConfidence: .99, reason: 'Low-priority announcement' })));
  assert.equal(result.changed, 1); assert.ok(!apple.labelIds.includes('UNREAD')); assert.ok(other.labelIds.includes('UNREAD'));
  assert.equal((await learningTray(f.service, f.id)).questions.length, 0);
});
test('category scope and exception matching reject unknown categories and misleading domains', () => {
  assert.equal(categoryScope('a-new-category-per-product'), null);
  const rules = validateExceptions([{ id: 'apple', type: 'domain', value: 'apple.com', category: 'product_announcements', action: 'keep' }]);
  assert.equal(matchingException(rules, 'news@email.apple.com', 'product_announcements').action, 'keep');
  assert.equal(matchingException(rules, 'news@evilapple.com', 'product_announcements'), null);
  assert.equal(matchingException(rules, 'news@apple.com.evil.example', 'product_announcements'), null);
  assert.equal(matchingException(rules, 'news@apple.com', 'sales_discounts'), null);
  assert.throws(() => validateExceptions([{ ...rules[0], value: '*@apple.com' }]), /complete sender/);
});

test('questions persist, deduplicate, hold mail immediately, and later answers affect only future messages', async t => {
  const f = fixture(t);
  const first = await askPreference(f.service, f.id, f.messages.get('one'), f.rules.agent, args);
  const second = await askPreference(f.service, f.id, f.messages.get('two'), f.rules.agent, args);
  assert.equal(first.id, second.id); assert.equal(first.waitsForUser, false);
  let tray = await learningTray(f.service, f.id); assert.equal(tray.questions.length, 1); const q = tray.questions[0];
  assert.ok(!f.store.get('SELECT payload FROM agent_questions').payload.includes(args.question));
  assert.equal(f.store.get('SELECT count(*) AS n FROM agent_holds').n, 2);
  await assert.rejects(answerPreference(f.service, 'another@example.invalid', { questionId: q.id, version: q.version, option: 'read' }), /changed or was already/);
  await answerPreference(f.service, f.id, { questionId: q.id, version: q.version, option: 'read' });
  tray = await learningTray(f.service, f.id); assert.equal(tray.questions.length, 0); assert.equal(tray.memories[0].action, 'read');
  assert.equal(tray.memories[0].applies, 'future_messages_only'); assert.equal(f.writes(), 0);
  const result = await f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'manual', async () => { throw new Error('Held emails must not be reconsidered'); }));
  assert.equal(result.inspected, 0); assert.ok(f.messages.get('one').labelIds.includes('UNREAD'));
  const memory = tray.memories[0]; await editMemory(f.service, f.id, { memoryId: memory.id, version: memory.version, action: 'keep' });
  await assert.rejects(editMemory(f.service, f.id, { memoryId: memory.id, version: memory.version, action: 'read' }), /changed/);
  const edited = (await learningTray(f.service, f.id)).memories[0]; await editMemory(f.service, f.id, { memoryId: edited.id, version: edited.version, remove: true });
  assert.equal((await learningTray(f.service, f.id)).memories.length, 0); assert.equal(f.store.get('SELECT count(*) AS n FROM agent_holds').n, 2);
});
test('snoozing a question never creates permission; it returns after the deadline', async t => {
  const f = fixture(t); await askPreference(f.service, f.id, f.messages.get('one'), f.rules.agent, args);
  const q = (await learningTray(f.service, f.id)).questions[0];
  await answerPreference(f.service, f.id, { questionId: q.id, version: q.version, option: 'later' });
  assert.equal((await learningTray(f.service, f.id)).questions.length, 0); assert.equal((await learningTray(f.service, f.id)).memories.length, 0);
  f.store.run('UPDATE agent_questions SET snoozed_until=?', Date.now() - 1);
  assert.equal((await learningTray(f.service, f.id)).questions.length, 1); assert.equal(f.writes(), 0);
});
test('saved answers inform new mail while older unseen mail in that scope stays untouched', async t => {
  const f = fixture(t); await askPreference(f.service, f.id, f.messages.get('one'), f.rules.agent, args);
  const q = (await learningTray(f.service, f.id)).questions[0]; await answerPreference(f.service, f.id, { questionId: q.id, version: q.version, option: 'read' });
  const memory = (await learningTray(f.service, f.id)).memories[0];
  f.messages.get('two').internalDate = String(memory.effectiveFrom - 1000);
  const future = mail('new'); future.internalDate = String(memory.effectiveFrom + 1000); f.messages.set('new', future);
  let calls = 0;
  const result = await f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'manual', async (config, prompt, data) => { calls++; assert.equal(data.categoryPreferences[0].action, 'read'); return { action: 'read', confidence: .99, reason: 'User preference', preferenceCategory: 'product_announcements', categoryConfidence: .99 }; }));
  assert.equal(calls, 2); assert.equal(result.changed, 1); assert.ok(f.messages.get('two').labelIds.includes('UNREAD')); assert.ok(!f.messages.get('new').labelIds.includes('UNREAD'));
});
test('agent tool calls queue questions without waiting; same-pattern messages and future held runs stay unchanged', async t => {
  const f = fixture(t); let modelCalls = 0;
  const result = await f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'manual', async () => { modelCalls++; return { requestPreference: args }; }));
  assert.equal(result.changed, 0); assert.equal(modelCalls, 2); assert.equal(f.writes(), 0);
  assert.equal((await learningTray(f.service, f.id)).questions.length, 1); assert.equal(f.store.get('SELECT count(*) AS n FROM agent_holds').n, 2);
});
test('ask_preference transport exposes only the declared tool; unknown tool calls are rejected', async () => {
  const { ASK_PREFERENCE_TOOL } = await import('../server/learning.js');
  const config = { aiProvider: 'nebius', aiKey: 'fixture-only', aiModel: 'fixture' };
  const result = await chatJSON(config, [], async (url, options) => { const body = JSON.parse(options.body); assert.equal(body.tools[0].function.name, 'ask_preference'); assert.equal(body.response_format, undefined); return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ function: { name: 'ask_preference', arguments: JSON.stringify(args) } }] } }] }); }, [ASK_PREFERENCE_TOOL]);
  assert.deepEqual(result.requestPreference, args);
  await assert.rejects(chatJSON(config, [], async () => Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ function: { name: 'delete_email', arguments: '{}' } }] } }] }), [ASK_PREFERENCE_TOOL]), /invalid JSON/);
});
test('automatic unsubscribe rejects OTPs, newsletters, mixed-purpose history, missing permission and unknown intent', () => {
  const message = mail('one'); const history = [message, mail('two')];
  const raw = { action: 'unsubscribe', emailType: 'marketing', subscriptionIntent: 'unwanted', confidence: .999, historyTypes: history.map(m => ({ id: m.id, type: 'marketing' })) };
  const p = { autoUnsubscribe: true };
  assert.equal(unsubscribeEligible(raw, p, message, history), true);
  assert.equal(unsubscribeEligible(raw, p, message, history, { action: 'read' }), false);
  assert.equal(unsubscribeEligible(raw, { autoUnsubscribe: false }, message, history), false);
  assert.equal(unsubscribeEligible({ ...raw, subscriptionIntent: 'unknown' }, p, message, history), false);
  assert.equal(unsubscribeEligible(raw, p, message, [message, mail('two', 'Your OTP code')]), false);
  assert.equal(unsubscribeEligible(raw, p, message, [message, mail('two', 'Weekly newsletter')]), false);
  assert.equal(unsubscribeEligible({ ...raw, historyTypes: [{ id: 'one', type: 'marketing' }, { id: 'two', type: 'transactional' }] }, p, message, history), false);
  assert.equal(unsubscribeEligible(raw, p, message, [message]), false);
});
test('supported automatic request is recorded once; uncertain network outcomes never replay', async t => {
  const f = fixture(t); let requests = 0; const message = f.messages.get('one');
  const result = await automaticUnsubscribe(f.service, f.id, message, async () => {}, f.rules, async () => { requests++; });
  assert.equal(result.requested, true); await automaticUnsubscribe(f.service, f.id, message, async () => {}, f.rules, async () => { requests++; }); assert.equal(requests, 1);
  f.store.run('DELETE FROM subscription_actions');
  await assert.rejects(automaticUnsubscribe(f.service, f.id, message, async () => {}, f.rules, async () => { requests++; throw new Error('timeout'); }), /timeout/);
  const retried = await automaticUnsubscribe(f.service, f.id, message, async () => {}, f.rules, async () => { requests++; }); assert.equal(retried.requested, false); assert.equal(requests, 2);
  assert.equal(f.store.get('SELECT status FROM subscription_actions').status, 'uncertain');
});
