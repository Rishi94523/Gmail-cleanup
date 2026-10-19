import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { openStore } from '../server/store.js';
import { encryption } from '../server/security.js';
import { DEFAULT_RULES } from '../server/rules.js';
import { InboxService } from '../server/service.js';

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'inboxclean-test-')); const store = openStore(directory); const crypto = encryption(randomBytes(32).toString('base64'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const accountId = 'owner@example.com'; const rules = { ...DEFAULT_RULES, markRead: true, ...options.rules };
  store.run('INSERT INTO accounts(id,email,tokens,rules,created) VALUES(?,?,?,?,?)', accountId, accountId, crypto.seal({ refresh_token: 'fixture' }), JSON.stringify(rules), Date.now());
  const messages = new Map(['one', 'two'].map(id => [id, { id, internalDate: String(Date.now() - 150 * 86400000), labelIds: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'], payload: { headers: [{ name: 'From', value: 'shop@example.com' }, { name: 'Subject', value: 'Weekend offers' }] } }]));
  const writes = []; const reads = []; let failWrite = false;
  const client = async (path, body) => {
    reads.push(path);
    if (path.startsWith('messages?')) return { messages: [...messages.values()].filter(m => m.labelIds.includes('INBOX')).map(m => ({ id: m.id })), ...(options.pagination ? { nextPageToken: 'next-token' } : {}) };
    if (path === 'labels') return { labels: [{ id: 'CLEANED', name: 'Cleaned by agent' }] };
    const id = path.split('/')[1]?.split('?')[0]; const message = messages.get(id);
    if (!message) { const error = new Error('Not found'); error.status = 404; throw error; }
    if (path.endsWith('/modify')) {
      writes.push({ id, body: structuredClone(body) });
      message.labelIds = [...new Set([...message.labelIds.filter(l => !body.removeLabelIds.includes(l)), ...body.addLabelIds])];
      if (failWrite) throw new Error('Provider timed out after applying the change.');
    }
    return structuredClone(message);
  };
  const service = new InboxService(store, crypto, {}, () => client);
  return { store, service, accountId, messages, writes, reads, failWrites(value) { failWrite = value; } };
}
test('scan is read-only; approval changes exactly selected messages; duplicate approval is rejected; undo preserves other labels', async t => {
  const f = fixture(t); const plan = await f.service.scan(f.accountId);
  assert.equal(f.writes.length, 0); assert.equal(plan.decisions.length, 2);
  const result = await f.service.apply(f.accountId, plan.id, ['one']);
  assert.equal(result.changed, 1); assert.deepEqual(f.messages.get('one').labelIds, ['CATEGORY_PROMOTIONS', 'CLEANED']);
  assert.ok(f.messages.get('two').labelIds.includes('UNREAD'));
  await assert.rejects(f.service.apply(f.accountId, plan.id, ['one']), /already been used/);
  f.messages.get('one').labelIds.push('PERSONAL_LABEL');
  await f.service.undo(f.accountId, result.id);
  assert.deepEqual(new Set(f.messages.get('one').labelIds), new Set(['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS', 'PERSONAL_LABEL']));
  await assert.rejects(f.service.undo(f.accountId, result.id), /no remaining changes/);
});
test('starred mail is protected even when it becomes starred after preview', async t => {
  const f = fixture(t); const plan = await f.service.scan(f.accountId); f.messages.get('one').labelIds.push('STARRED');
  const result = await f.service.apply(f.accountId, plan.id, ['one']); assert.equal(result.changed, 0); assert.equal(result.skipped, 1); assert.equal(f.writes.length, 0);
});
test('changing rules invalidates the preview', async t => {
  const f = fixture(t); const plan = await f.service.scan(f.accountId);
  await f.service.saveRules(f.accountId, { ...DEFAULT_RULES, days: 180 });
  await assert.rejects(f.service.apply(f.accountId, plan.id, ['one']), /expired/); assert.equal(f.writes.length, 0);
});
test('arbitrary IDs, plans from another account, and overlapping jobs are rejected', async t => {
  const f = fixture(t); const plan = await f.service.scan(f.accountId);
  await assert.rejects(f.service.apply(f.accountId, plan.id, ['foreign']), /Select messages/);
  await assert.rejects(f.service.apply('other@example.com', plan.id, ['one']), /expired/);
  await f.service.locked(f.accountId, async () => { await assert.rejects(f.service.scan(f.accountId), /already running/); });
});
test('ambiguous provider writes are recorded, never replayed, and can be reconciled by undo', async t => {
  const f = fixture(t); const plan = await f.service.scan(f.accountId); f.failWrites(true);
  await assert.rejects(f.service.apply(f.accountId, plan.id, ['one', 'two']), /review activity/);
  const run = f.store.get('SELECT * FROM runs'); const change = f.store.get('SELECT * FROM changes');
  assert.equal(run.status, 'needs_review'); assert.equal(change.status, 'uncertain'); assert.equal(f.writes.length, 1);
  await assert.rejects(f.service.apply(f.accountId, plan.id, ['one']), /already been used/); assert.equal(f.writes.length, 1);
  f.failWrites(false); await f.service.undo(f.accountId, run.id); assert.ok(f.messages.get('one').labelIds.includes('UNREAD'));
});
test('daily agent runs once per account-local day and only after explicit enabling', async t => {
  const f = fixture(t);
  f.store.run("INSERT INTO account_access(account_key,tier) VALUES(?,'paid')", createHash('sha256').update(f.accountId).digest('hex'));
  await f.service.daily(); assert.equal(f.writes.length, 0);
  await f.service.saveRules(f.accountId, { ...DEFAULT_RULES, daily: true, hour: 0, timezone: 'UTC' });
  await f.service.daily(); assert.equal(f.writes.length, 2);
  await f.service.daily(); assert.equal(f.writes.length, 2);
  assert.equal(f.store.get('SELECT kind FROM runs').kind, 'daily');
});
test('next batch token is stored server-side and scoped to the owning account', async t => {
  const f = fixture(t, { pagination: true }); const plan = await f.service.scan(f.accountId);
  assert.equal(plan.moreAvailable, true); assert.equal(plan.nextPageToken, undefined);
  await f.service.scan(f.accountId, 'manual', plan.id); assert.ok(f.reads.some(path => path.includes('pageToken=next-token')));
  await assert.rejects(f.service.scan(f.accountId, 'manual', plan.id), /expired/);
});
test('AI cannot be enabled without a configured provider', async t => {
  const f = fixture(t); await assert.rejects(f.service.saveRules(f.accountId, { ...DEFAULT_RULES, aiEnabled: true }), /NEBIUS_API_KEY/);
});
