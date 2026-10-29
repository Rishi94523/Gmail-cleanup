import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { openStore } from '../server/store.js';
import { encryption } from '../server/security.js';
import { DEFAULT_RULES } from '../server/rules.js';
import { InboxService } from '../server/service.js';
import { DEFAULT_PREFERENCES } from '../server/agent.js';

const AGENT = { ...DEFAULT_PREFERENCES, enabled: true, consent: true, consentProvider: 'nebius' };
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'inboxclean-test-'));
  const store = openStore(directory);
  const crypto = encryption(randomBytes(32).toString('base64'));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const accountId = 'owner@example.com';
  const rules = { ...DEFAULT_RULES, agent: AGENT, ...options.rules };
  store.run(
    'INSERT INTO accounts(id,email,tokens,rules,created) VALUES(?,?,?,?,?)',
    accountId,
    accountId,
    crypto.seal({ refresh_token: 'fixture' }),
    JSON.stringify(rules),
    Date.now()
  );
  const messages = new Map(
    ['one', 'two'].map(id => [id, { id, labelIds: ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL'], payload: { headers: [] } }])
  );
  const writes = [];
  const client = async (path, body) => {
    const id = path.split('/')[1]?.split('?')[0];
    const message = messages.get(id);
    if (path.endsWith('/modify')) {
      writes.push({ id, body: structuredClone(body) });
      message.labelIds = [
        ...new Set([...message.labelIds.filter(l => !body.removeLabelIds.includes(l)), ...body.addLabelIds])
      ];
    }
    return structuredClone(message);
  };
  const agentRuns = [];
  // Scheduled runs are observed here; the agent itself is covered in agent.test.js.
  const runAgent = async (service, id, guard, emit, mode) => {
    await guard();
    agentRuns.push({ id, mode });
    store.run(
      "INSERT INTO runs(id,account_id,kind,status,total,created) VALUES(?,?,'daily','completed',0,?)",
      randomUUID(),
      id,
      Date.now()
    );
  };
  const service = new InboxService(store, crypto, { aiKey: 'test-only-key' }, () => client);
  service.runAgent = runAgent;
  // Records a run the way the agent does: change rows plus the resulting labels.
  const cleaned = (ids, { status = 'applied' } = {}) => {
    const runId = randomUUID();
    store.run(
      "INSERT INTO runs(id,account_id,kind,status,total,changed,created) VALUES(?,?,'cleanup','completed',?,?,?)",
      runId,
      accountId,
      ids.length,
      ids.length,
      Date.now()
    );
    for (const messageId of ids) {
      const message = messages.get(messageId);
      message.labelIds = [...message.labelIds.filter(l => l !== 'UNREAD'), 'CLEANED'];
      store.run(
        'INSERT INTO changes(id,run_id,account_id,message_id,payload,status,created) VALUES(?,?,?,?,?,?,?)',
        randomUUID(),
        runId,
        accountId,
        messageId,
        crypto.seal({ addLabelIds: ['CLEANED'], removeLabelIds: ['UNREAD'] }),
        status,
        Date.now()
      );
    }
    return runId;
  };
  return { store, service, accountId, messages, writes, agentRuns, cleaned };
}
const paid = f =>
  f.store.run(
    "INSERT INTO account_access(account_key,tier) VALUES(?,'paid')",
    createHash('sha256').update(f.accountId).digest('hex')
  );

test('undo restores only the labels a run changed and cannot run twice', async t => {
  const f = fixture(t);
  const runId = f.cleaned(['one']);
  f.messages.get('one').labelIds.push('PERSONAL_LABEL');
  assert.deepEqual(await f.service.undo(f.accountId, runId), { restored: 1 });
  assert.deepEqual(
    new Set(f.messages.get('one').labelIds),
    new Set(['INBOX', 'UNREAD', 'CATEGORY_PERSONAL', 'PERSONAL_LABEL'])
  );
  assert.deepEqual(f.messages.get('two').labelIds, ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL']);
  await assert.rejects(f.service.undo(f.accountId, runId), /no remaining changes/);
  await assert.rejects(f.service.undo('other@example.com', runId), /not found/);
});
test('uncertain writes can be reconciled by undo and overlapping jobs are rejected', async t => {
  const f = fixture(t);
  const runId = f.cleaned(['one', 'two'], { status: 'uncertain' });
  await f.service.locked(f.accountId, async () => {
    await assert.rejects(f.service.undo(f.accountId, runId), /already running/);
  });
  assert.deepEqual(await f.service.undo(f.accountId, runId), { restored: 2 });
  assert.ok(f.messages.get('one').labelIds.includes('UNREAD'));
});
test('agent cannot be enabled without a configured AI key', async t => {
  const f = fixture(t);
  f.service.config.aiKey = '';
  await assert.rejects(f.service.saveRules(f.accountId, { ...DEFAULT_RULES, agent: AGENT }), /NEBIUS_API_KEY/);
});
test('scheduled cleanup runs only the agent; accounts without it are skipped and not claimed', async t => {
  const f = fixture(t, { rules: { agent: { ...AGENT, enabled: false } } });
  paid(f);
  await f.service.saveRules(f.accountId, { ...DEFAULT_RULES, daily: true, hour: 0, timezone: 'UTC' });
  await f.service.daily();
  assert.equal(f.agentRuns.length, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.store.get('SELECT last_day FROM accounts').last_day, null);
});
test('daily agent runs once per account-local day and only after explicit enabling', async t => {
  const f = fixture(t);
  paid(f);
  await f.service.daily();
  assert.equal(f.agentRuns.length, 0);
  await f.service.saveRules(f.accountId, { ...DEFAULT_RULES, daily: true, hour: 0, timezone: 'UTC' });
  await f.service.daily();
  assert.equal(f.agentRuns.length, 1);
  await f.service.daily();
  assert.equal(f.agentRuns.length, 1);
  assert.deepEqual(f.agentRuns, [{ id: f.accountId, mode: 'daily' }]);
});

test('three runs a day each run once at their evenly spaced times', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-20T00:30:00Z') });
  const f = fixture(t);
  paid(f);
  await f.service.saveRules(f.accountId, { ...DEFAULT_RULES, daily: true, hour: 0, runsPerDay: 3, timezone: 'UTC' });
  const runs = () => f.store.get("SELECT count(*) AS n FROM runs WHERE kind='daily'").n;
  const lastDay = () => f.store.get('SELECT last_day FROM accounts').last_day;
  await f.service.daily();
  await f.service.daily();
  assert.equal(lastDay(), '2026-10-20');
  const first = runs();
  assert.equal(first, 1, 'The 00:00 run happens once');
  t.mock.timers.tick(7 * 3600000); // 07:30, still the first slot
  await f.service.daily();
  assert.equal(runs(), first);
  t.mock.timers.tick(3600000); // 08:30
  await f.service.daily();
  await f.service.daily();
  assert.equal(lastDay(), '2026-10-20#2');
  assert.equal(runs(), first + 1);
  t.mock.timers.tick(8 * 3600000); // 16:30
  await f.service.daily();
  assert.equal(lastDay(), '2026-10-20#3');
  assert.equal(runs(), first + 2);
  // Switching back to once a day must not repeat today's cleanup.
  const { rules } = await f.service.account(f.accountId);
  await f.service.saveRules(f.accountId, { ...rules, runsPerDay: 1 });
  await f.service.daily();
  assert.equal(runs(), first + 2);
  t.mock.timers.tick(8 * 3600000); // next day 00:30
  await f.service.daily();
  assert.equal(lastDay(), '2026-10-21');
  assert.equal(runs(), first + 3);
});

test('daily pauses persist per account, preserve settings, validate durations, and do not enable a disabled routine', async t => {
  const f = fixture(t);
  const before = (await f.service.account(f.accountId)).rules;
  for (const [duration, days] of [
    ['day', 1],
    ['week', 7],
    ['month', 30]
  ]) {
    const start = Date.now();
    const { rules } = await f.service.pauseDaily(f.accountId, duration);
    assert.ok(
      rules.dailyPausedUntil >= start + days * 86400000 && rules.dailyPausedUntil <= Date.now() + days * 86400000
    );
    assert.equal(rules.daily, false);
    assert.equal(rules.hour, before.hour);
    assert.equal(rules.timezone, before.timezone);
  }
  await f.service.pauseDaily(f.accountId, 'indefinite');
  assert.equal((await f.service.account(f.accountId)).rules.dailyPausedUntil, -1);
  // Saving unrelated advanced settings must not accidentally clear the pause.
  const { dailyPausedUntil, ...oldClientRules } = (await f.service.account(f.accountId)).rules;
  await f.service.saveRules(f.accountId, { ...oldClientRules, hour: 10 });
  assert.equal((await f.service.account(f.accountId)).rules.dailyPausedUntil, -1);
  await f.service.saveRules(f.accountId, { ...oldClientRules, dailyPausedUntil: 0, hour: 11 });
  assert.equal(
    (await f.service.account(f.accountId)).rules.dailyPausedUntil,
    -1,
    'A stale settings form must not resume the routine'
  );
  await f.service.pauseDaily(f.accountId, 'resume');
  assert.equal((await f.service.account(f.accountId)).rules.dailyPausedUntil, 0);
  assert.equal((await f.service.account(f.accountId)).rules.daily, false);
  await assert.rejects(f.service.pauseDaily(f.accountId, 'forever-ish'), /Choose/);
  await assert.rejects(f.service.pauseDaily('another-account', 'day'), /Connect Gmail/);
  assert.equal(f.writes.length, 0);
});

test('scheduler skips paused accounts without claiming the day, then resumes after expiry and still runs once', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-20T12:00:00Z') });
  const f = fixture(t);
  paid(f);
  await f.service.saveRules(f.accountId, { ...DEFAULT_RULES, daily: true, hour: 0, timezone: 'UTC' });
  await f.service.pauseDaily(f.accountId, 'day');
  // A fresh service must observe the database pause, not process-local state.
  const restarted = new InboxService(f.store, f.service.crypto, f.service.config, f.service.clientFactory);
  restarted.runAgent = f.service.runAgent;
  await restarted.daily();
  assert.equal(f.agentRuns.length, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.store.get('SELECT last_day FROM accounts').last_day, null);
  t.mock.timers.tick(86400000 + 1);
  await restarted.daily();
  assert.equal(f.agentRuns.length, 1);
  await restarted.daily();
  assert.equal(f.agentRuns.length, 1);
  assert.equal(f.store.get('SELECT last_day FROM accounts').last_day, '2026-10-21');
});

test('indefinite daily pause survives elapsed time until explicit resume', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-20T12:00:00Z') });
  const f = fixture(t);
  paid(f);
  await f.service.saveRules(f.accountId, { ...DEFAULT_RULES, daily: true, hour: 0, timezone: 'UTC' });
  await f.service.pauseDaily(f.accountId, 'indefinite');
  t.mock.timers.tick(100 * 86400000);
  await f.service.daily();
  assert.equal(f.writes.length, 0);
  assert.equal(f.agentRuns.length, 0);
  await f.service.pauseDaily(f.accountId, 'resume');
  await f.service.daily();
  assert.equal(f.agentRuns.length, 1);
});
test('retention prunes leftover previews, old agent logs, expired undo payloads and old preference history only', async t => {
  const f = fixture(t);
  const now = Date.now();
  const hour = 3600000;
  const day = 24 * hour;
  const other = 'other@example.com';
  const plan = (id, status, created, account = f.accountId) =>
    f.store.run(
      'INSERT INTO plans(id,account_id,payload,status,created) VALUES(?,?,?,?,?)',
      id,
      account,
      'sealed',
      status,
      created
    );
  plan('fresh-ready', 'ready', now - 10 * 60000);
  plan('stale-ready', 'ready', now - 2 * hour);
  plan('applying', 'applying', now - 3 * day);
  plan('recent-applied', 'applied', now - hour);
  plan('old-applied', 'applied', now - 2 * day);
  plan('old-expired', 'expired', now - 2 * day);
  plan('old-review', 'needs_review', now - 2 * day);
  for (let i = 0; i < 12; i++) plan(`log-${i}`, 'agent_log', now - i * hour);
  plan('other-log', 'agent_log', now - 100 * day, other);
  const change = (id, status, created) =>
    f.store.run(
      "INSERT INTO changes(id,run_id,account_id,message_id,payload,status,created) VALUES(?,'run',?,?,'sealed',?,?)",
      id,
      f.accountId,
      `m-${id}`,
      status,
      created
    );
  change('recent', 'applied', now - day);
  change('old', 'applied', now - 31 * day);
  change('old-undone', 'undone', now - 31 * day);
  change('old-uncertain', 'uncertain', now - 31 * day);
  change('old-undo-uncertain', 'undo_uncertain', now - 31 * day);
  f.store.run(
    "INSERT INTO preference_events(id,account_id,payload,created) VALUES('recent',?,'sealed',?),('old',?,'sealed',?)",
    f.accountId,
    now - 179 * day,
    f.accountId,
    now - 181 * day
  );
  f.store.run(
    "INSERT INTO agent_holds(account_id,message_id,scope_hash,question_id,created) VALUES(?,'held','scope',NULL,?)",
    f.accountId,
    now - 400 * day
  );
  await f.service.prune(now);
  assert.deepEqual(
    f.store.all('SELECT id FROM plans ORDER BY id').map(r => r.id),
    [...Array.from({ length: 10 }, (_, i) => `log-${i}`), 'other-log'].sort()
  );
  assert.deepEqual(
    Object.fromEntries(
      f.store.all('SELECT id,status,payload FROM changes').map(r => [r.id, `${r.status}:${r.payload}`])
    ),
    {
      recent: 'applied:sealed',
      old: 'expired:',
      'old-undone': 'expired:',
      'old-uncertain': 'uncertain:sealed',
      'old-undo-uncertain': 'undo_uncertain:sealed'
    }
  );
  assert.deepEqual(
    f.store.all('SELECT id FROM preference_events').map(r => r.id),
    ['recent']
  );
  assert.equal(f.store.get('SELECT count(*) AS n FROM agent_holds').n, 1);
});
test('a cleanup cannot be undone after the undo window', async t => {
  const f = fixture(t);
  const runId = f.cleaned(['one']);
  await f.service.prune(Date.now() + 31 * 86400000);
  await assert.rejects(f.service.undo(f.accountId, runId), /undone for 30 days/);
  assert.ok(!f.messages.get('one').labelIds.includes('UNREAD'));
});
