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
import { DEFAULT_PREFERENCES, preferences, decisionFor, emailText, runAgent } from '../server/agent.js';

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
