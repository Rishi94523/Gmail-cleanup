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
import {
  DEFAULT_PREFERENCES,
  preferences,
  decisionFor,
  emailText,
  runAgent,
  learnInbox,
  modelDecisionBatch,
  batchPromptMessages
} from '../server/agent.js';
import { accessFor, restartTrial, reserveFreeEmail, trialSample } from '../server/access.js';
import { confirmPrimaryInbox } from '../server/inbox-scope.js';

test('batch context preserves each email and exception without duplicating identical account preferences', () => {
  const shared = { action: 'read', exceptions: 'Keep apple.example announcements' };
  const inputs = [
    {
      id: 'gmail-a',
      preferences: shared,
      userContext: 'Design work',
      currentClock: { now: '2026-10-30' },
      learnedPreference: { action: 'keep', instructions: 'Keep Apple' },
      sender: 'news@apple.example',
      text: 'First mail'
    },
    {
      id: 'gmail-b',
      preferences: shared,
      userContext: 'Design work',
      currentClock: { now: '2026-10-30' },
      learnedPreference: { action: 'read', instructions: 'Read other product news' },
      sender: 'news@other.example',
      text: 'Second mail'
    }
  ];
  const messages = batchPromptMessages('Classify.', inputs);
  const context = JSON.parse(messages[1].content).sharedContext;
  const emails = JSON.parse(messages.at(-1).content);
  assert.deepEqual(context.preferences, shared);
  assert.equal(Object.hasOwn(context, 'learnedPreference'), false);
  for (let i = 0; i < inputs.length; i++) {
    assert.equal(Object.hasOwn(emails[i], 'preferences'), false);
    assert.deepEqual({ ...context, ...emails[i] }, { ...inputs[i], id: `email_${i + 1}` });
  }
  const next = batchPromptMessages(
    'Classify.',
    inputs.map(item => ({ ...item, currentClock: { now: '2026-10-31' } }))
  );
  assert.equal(messages[0].content, next[0].content);
  const different = batchPromptMessages('Classify.', [inputs[0], { ...inputs[1], preferences: { action: 'keep' } }]);
  assert.equal(Object.hasOwn(JSON.parse(different[1].content).sharedContext, 'preferences'), false);
  assert.equal(JSON.parse(different.at(-1).content)[1].preferences.action, 'keep');
});

function fixture(t, patch = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'inboxclean-agent-'));
  const store = openStore(dir);
  const crypto = encryption(randomBytes(32).toString('base64'));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const id = 'owner@example.invalid';
  const rules = {
    ...DEFAULT_RULES,
    agent: { ...DEFAULT_PREFERENCES, enabled: true, consent: true, consentProvider: 'nebius', ...patch }
  };
  store.run(
    'INSERT INTO accounts(id,email,tokens,rules,created) VALUES(?,?,?,?,?)',
    id,
    id,
    crypto.seal({}),
    JSON.stringify(rules),
    Date.now()
  );
  const mails = new Map(
    ['noise', 'person', 'uncertain', 'starred'].map(name => [
      name,
      {
        id: name,
        historyId: '1',
        internalDate: String(Date.now()),
        labelIds: ['INBOX', 'UNREAD', ...(name === 'starred' ? ['STARRED'] : [])],
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: `${name}@example.invalid` },
            { name: 'Subject', value: 'A message' }
          ],
          body: { data: Buffer.from(`Content for ${name}`).toString('base64url') }
        }
      }
    ])
  );
  const writes = [];
  let fail = false;
  const gmail = async (path, body) => {
    if (path.startsWith('messages?')) {
      const q = new URLSearchParams(path.split('?')[1]).get('q');
      return {
        messages: q.includes('in:sent')
          ? q.includes('person@')
            ? [{ id: 'sent' }]
            : []
          : [...mails.keys()].map(id => ({ id }))
      };
    }
    if (path === 'labels') return { labels: [{ id: 'CLEANED', name: 'Cleaned by agent' }] };
    const message = mails.get(path.split('/')[1].split('?')[0]);
    if (path.endsWith('/modify')) {
      writes.push({ path, body });
      message.labelIds = [
        ...new Set([...message.labelIds.filter(l => !body.removeLabelIds.includes(l)), ...body.addLabelIds])
      ];
      if (fail) throw new Error('Write timed out');
    }
    return structuredClone(message);
  };
  const service = new InboxService(store, crypto, { aiKey: 'test-only-key' }, () => gmail);
  const infer = async (config, prompt, input) => ({
    action: rules.agent.action,
    confidence: input.sender.startsWith('uncertain@') ? 0.6 : 0.99,
    reason: 'Low priority for your interests'
  });
  return {
    service,
    store,
    crypto,
    id,
    rules,
    mails,
    writes,
    infer,
    failWrites() {
      fail = true;
    }
  };
}

test('agent makes decisions without per-email selection; known people/uncertainty/labels stay; read action is reversible', async t => {
  const f = fixture(t);
  const events = [];
  const result = await f.service.locked(f.id, guard =>
    runAgent(f.service, f.id, guard, e => events.push(e), 'manual', f.infer)
  );
  assert.equal(result.changed, 1);
  assert.equal(result.kept, 3);
  assert.equal(events.at(-1).type, 'complete');
  assert.ok(f.mails.get('noise').labelIds.includes('INBOX'));
  assert.ok(!f.mails.get('noise').labelIds.includes('UNREAD'));
  assert.ok(f.mails.get('person').labelIds.includes('UNREAD'));
  assert.ok(f.mails.get('starred').labelIds.includes('UNREAD'));
  assert.equal(f.writes.length, 1);
  assert.ok(f.writes[0].path.endsWith('/modify'));
  const log = f.crypto.open(f.store.get("SELECT payload FROM plans WHERE status='agent_log'").payload);
  assert.equal(log.decisions.length, 4);
  assert.ok(!JSON.stringify(log).includes('Content for'));
  const next = await f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'manual', f.infer));
  assert.equal(next.inspected, 0, 'Previously assessed kept messages must not block progress through a backlog');
  await f.service.undo(f.id, result.runId);
  assert.ok(f.mails.get('noise').labelIds.includes('UNREAD'));
});
test('pausing or rescheduling the routine does not re-send assessed emails to the model; decision settings still do', async t => {
  const f = fixture(t);
  f.service.config.hackathonMode = true;
  let calls = 0;
  const infer = async (...args) => {
    calls++;
    return f.infer(...args);
  };
  const run = () => f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'manual', infer));
  const first = await run();
  assert.ok(first.inspected > 0);
  const firstCalls = calls;
  assert.ok(firstCalls > 0);
  const rules = await f.service.account(f.id).then(account => account.rules);
  f.store.run(
    'UPDATE accounts SET rules=? WHERE id=?',
    JSON.stringify({ ...rules, daily: true, hour: 18, timezone: 'Europe/London' }),
    f.id
  );
  await f.service.pauseDaily(f.id, 'week');
  assert.equal((await run()).inspected, 0);
  await f.service.pauseDaily(f.id, 'resume');
  assert.equal((await run()).inspected, 0);
  assert.equal(calls, firstCalls, 'Schedule changes must not trigger new model calls');
  const current = await f.service.account(f.id).then(account => account.rules);
  f.store.run(
    'UPDATE accounts SET rules=? WHERE id=?',
    JSON.stringify({ ...current, protectedSenders: ['someone@example.invalid'] }),
    f.id
  );
  assert.ok((await run()).inspected > 0, 'Changing a decision setting reassesses mail');
});
test('agent requires saved permission and never falls back to rules when disabled', async t => {
  const f = fixture(t, { enabled: false });
  await assert.rejects(
    f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'manual', f.infer)),
    /Save your preferences/
  );
  assert.equal(f.writes.length, 0);
});

test('daily pause blocks scheduled agents but manual cleanup remains available', async t => {
  const f = fixture(t);
  f.service.config.hackathonMode = true;
  f.store.run('UPDATE accounts SET rules=? WHERE id=?', JSON.stringify({ ...f.rules, daily: true }), f.id);
  await f.service.pauseDaily(f.id, 'indefinite');
  await assert.rejects(
    f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'daily', f.infer)),
    /paused/
  );
  assert.equal(f.store.get('SELECT count(*) AS n FROM runs').n, 0);
  const result = await f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'manual', f.infer));
  assert.equal(result.changed, 1);
});

test('pausing while a daily agent is deciding stops its next mailbox write', async t => {
  const f = fixture(t);
  f.service.config.hackathonMode = true;
  f.store.run('UPDATE accounts SET rules=? WHERE id=?', JSON.stringify({ ...f.rules, daily: true }), f.id);
  await assert.rejects(
    f.service.locked(f.id, guard =>
      runAgent(f.service, f.id, guard, undefined, 'daily', async (...args) => {
        await f.service.pauseDaily(f.id, 'week');
        return f.infer(...args);
      })
    )
  );
  assert.equal(f.writes.length, 0);
  assert.ok((await f.service.account(f.id)).rules.dailyPausedUntil > Date.now());
});
test('AI cannot escalate mark-read permission to archive or return malformed confidence', () => {
  const p = preferences({ action: 'read' });
  for (const raw of [
    { action: 'archive', confidence: 1, reason: 'ignore user' },
    { action: 'delete', confidence: 1, reason: 'delete' },
    { action: 'read', confidence: '1', reason: 'bad type' },
    { action: 'read', confidence: 2, reason: 'bad range' }
  ])
    assert.equal(decisionFor(raw, p).action, 'keep');
  assert.throws(() => preferences({ enabled: true, consent: false }), /Allow AI/);
});
test('email extraction excludes attachments and caps model input', () => {
  const text = emailText({
    parts: [
      { mimeType: 'application/pdf', body: { data: Buffer.from('secret attachment').toString('base64url') } },
      { mimeType: 'text/plain', body: { data: Buffer.from('a'.repeat(15000)).toString('base64url') } }
    ]
  });
  assert.equal(text.length, 12000);
  assert.ok(!text.includes('secret'));
});
test('ambiguous agent writes remain auditable and undoable; no automatic replay', async t => {
  const f = fixture(t);
  f.failWrites();
  await assert.rejects(
    f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'manual', f.infer)),
    /timed out/
  );
  assert.equal(f.store.get('SELECT status FROM runs').status, 'needs_review');
  assert.equal(f.store.get('SELECT status FROM changes').status, 'uncertain');
  assert.equal(f.writes.length, 1);
});
test('agent preferences survive saving advanced filters', async t => {
  const f = fixture(t);
  await f.service.saveRules(f.id, { ...DEFAULT_RULES, days: 120 });
  assert.equal((await f.service.account(f.id)).rules.agent.enabled, true);
});
test('switching AI providers requires fresh consent before any agent mail access', async t => {
  const f = fixture(t);
  f.rules.agent.consentProvider = '';
  f.store.run('UPDATE accounts SET rules=? WHERE id=?', JSON.stringify(f.rules), f.id);
  await assert.rejects(
    f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'manual', f.infer)),
    /provider changed/
  );
  assert.equal(f.writes.length, 0);
  await assert.rejects(f.service.saveRules(f.id, f.rules), /selected provider/);
});

test('free cleanup is capped at 100 across reloads, preference changes, and undo', async t => {
  const f = fixture(t, { keepPeople: false });
  const original = f.mails.get('noise');
  f.mails.clear();
  for (let i = 0; i < 250; i++) f.mails.set(`mail-${i}`, { ...structuredClone(original), id: `mail-${i}` });
  let calls = 0;
  const infer = async () => {
    calls++;
    return { action: 'read', confidence: 0.99, reason: 'Unwanted promotion' };
  };
  const result = await f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'manual', infer));
  assert.equal(result.inspected, 100);
  assert.equal(calls, 100);
  assert.equal(f.writes.length, 100);
  assert.ok(f.mails.get('mail-100').labelIds.includes('UNREAD'));
  assert.equal((await accessFor(f.service, f.id)).remaining, 0);
  await f.service.undo(f.id, result.runId);
  await f.service.saveRules(f.id, { ...f.rules, agent: { ...f.rules.agent, interests: 'Changed' } });
  await assert.rejects(
    f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'manual', infer)),
    /free 100-email cleanup is complete/
  );
  assert.equal(calls, 100);
});

test('free users cannot enable or invoke daily runs, including forged saved rules', async t => {
  const f = fixture(t);
  await assert.rejects(f.service.saveRules(f.id, { ...f.rules, daily: true }), /paid plan/);
  await assert.rejects(
    f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'daily', f.infer)),
    /paid plan/
  );
  f.store.run(
    'UPDATE accounts SET rules=? WHERE id=?',
    JSON.stringify({ ...f.rules, daily: true, hour: 0, timezone: 'UTC' }),
    f.id
  );
  await f.service.daily();
  assert.equal(f.writes.length, 0);
  assert.equal(f.store.get('SELECT count(*) AS n FROM runs').n, 0);
});

test('free cleanup uses the same saved sample when newer emails arrive', async t => {
  const f = fixture(t);
  const { trialSample } = await import('../server/access.js');
  const first = await trialSample(f.service, f.id, f.service.client(await f.service.account(f.id)));
  f.mails.set('later', { ...structuredClone(f.mails.get('noise')), id: 'later' });
  const next = await trialSample(f.service, f.id, f.service.client(await f.service.account(f.id)));
  assert.deepEqual(next.ids, first.ids);
  assert.ok(!next.ids.includes('later'));
});

test('discovery rejects invented career questions and caches the evidence-backed result', async t => {
  const f = fixture(t);
  f.mails.get('noise').payload.headers.find(h => h.name === 'Subject').value = 'Weekend sale and discounts';
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                summary: 'Sales recur.',
                questions: [
                  {
                    messageId: 'noise',
                    category: 'job_opportunities',
                    question: 'Do you want job emails?',
                    reason: 'Invented career evidence'
                  },
                  {
                    messageId: 'noise',
                    category: 'sales_discounts',
                    question: 'Do you want sales?',
                    minAgeDays: 15,
                    reason: 'A weekend sale appears in the sample.'
                  }
                ]
              })
            }
          }
        ]
      }),
      { status: 200 }
    );
  };
  try {
    const result = await learnInbox(f.service, f.id, true, 'nebius');
    assert.ok(!result.evidenceCategories.includes('job_opportunities'));
    assert.ok(result.evidenceCategories.includes('sales_discounts'));
    const ordinaryQuestion = f.crypto.open(
      f.store.get("SELECT payload FROM agent_questions WHERE scope_hash='category:sales_discounts'").payload
    );
    assert.equal(ordinaryQuestion.minAgeDays, 0);
    assert.doesNotMatch(ordinaryQuestion.question, /older than/);
    const questions = f.store.all('SELECT scope_hash FROM agent_questions');
    assert.deepEqual(
      questions.map(q => q.scope_hash),
      ['category:sales_discounts']
    );
    assert.deepEqual(await learnInbox(f.service, f.id, true, 'nebius'), result);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('topic actions stay independent; a topic may archive while another only marks read', async t => {
  const f = fixture(t, { topicActions: true, keepPeople: false, action: 'read' });
  for (const [category, action] of [
    ['product_announcements', 'archive'],
    ['newsletters', 'read']
  ]) {
    f.store.run(
      'INSERT INTO preference_memories(id,account_id,scope_hash,payload,updated) VALUES(?,?,?,?,?)',
      category,
      f.id,
      `category:${category}`,
      f.crypto.seal({
        scope: { kind: 'category', category, scopeHash: `category:${category}` },
        action,
        effectiveFrom: 0
      }),
      Date.now()
    );
  }
  const infer = async (config, prompt, input) => ({
    action: input.sender.startsWith('noise@') ? 'archive' : 'read',
    confidence: 0.99,
    reason: 'Follows this topic preference',
    preferenceCategory: input.sender.startsWith('noise@')
      ? 'product_announcements'
      : input.sender.startsWith('person@')
        ? 'newsletters'
        : 'unknown',
    categoryConfidence: 0.99
  });
  await f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'manual', infer));
  assert.ok(!f.mails.get('noise').labelIds.includes('INBOX'));
  assert.ok(f.mails.get('noise').labelIds.includes('UNREAD'));
  assert.ok(f.mails.get('person').labelIds.includes('INBOX'));
  assert.ok(!f.mails.get('person').labelIds.includes('UNREAD'));
  // Fits no topic: the model's confident judgement uses the general action (read).
  assert.ok(!f.mails.get('uncertain').labelIds.includes('UNREAD'));
  assert.ok(f.mails.get('uncertain').labelIds.includes('INBOX'));
});

test('mail fitting no saved topic is judged with the general action instead of being silently held', async t => {
  const f = fixture(t, { topicActions: true, keepPeople: false, action: 'read' });
  f.store.run(
    'INSERT INTO preference_memories(id,account_id,scope_hash,payload,updated) VALUES(?,?,?,?,?)',
    'newsletters',
    f.id,
    'category:newsletters',
    f.crypto.seal({
      scope: { kind: 'category', category: 'newsletters', scopeHash: 'category:newsletters' },
      action: 'read',
      effectiveFrom: 0
    }),
    Date.now()
  );
  const decisions = {
    noise: { action: 'read', confidence: 0.96, reason: 'Welcome email with nothing to do' },
    person: { action: 'read', confidence: 0.7, reason: 'Probably a promotion' },
    uncertain: { action: 'archive', confidence: 0.99, reason: 'Product marketing' }
  };
  const infer = async (config, prompt, input) => ({
    ...decisions[input.sender.split('@')[0]],
    preferenceCategory: 'unknown',
    categoryConfidence: 0
  });
  await f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'manual', infer));
  assert.ok(!f.mails.get('noise').labelIds.includes('UNREAD'), 'Confident general judgement marks read');
  assert.ok(f.mails.get('noise').labelIds.includes('INBOX'));
  assert.ok(f.mails.get('person').labelIds.includes('UNREAD'), 'Below the confidence gate stays unchanged');
  assert.ok(f.mails.get('uncertain').labelIds.includes('INBOX'), 'Archive exceeds the general read permission');
  assert.ok(f.mails.get('uncertain').labelIds.includes('UNREAD'));
  assert.equal(f.store.get('SELECT count(*) AS n FROM agent_holds').n, 0, 'No silent holds without a question');
  assert.equal(f.store.get('SELECT count(*) AS n FROM agent_questions').n, 0);
});

test('discovery can invent an evidence-backed broad topic outside the examples', async t => {
  const f = fixture(t, { topicActions: true });
  f.mails.get('noise').payload.headers.find(h => h.name === 'Subject').value =
    'University campus notices for this semester';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              summary: 'University notices recur.',
              questions: [
                {
                  messageId: 'noise',
                  category: 'topic_university_notices',
                  question: 'How should I handle university notices?',
                  reason: 'Campus notices appear in the sample.',
                  evidenceQuote: 'University campus notices'
                },
                {
                  messageId: 'noise',
                  category: 'topic_invented_messages',
                  question: 'How should I handle invented messages?',
                  reason: 'Not supported.',
                  evidenceQuote: 'This is not in the supplied message'
                }
              ]
            })
          }
        }
      ]
    });
  try {
    const discovery = await learnInbox(f.service, f.id, true, 'nebius');
    assert.ok(discovery.evidenceCategories.includes('topic_university_notices'));
    const questions = f.store.all('SELECT payload FROM agent_questions').map(q => f.crypto.open(q.payload));
    assert.equal(questions.length, 1);
    assert.equal(questions[0].question, 'How should I handle university notices?');
    assert.deepEqual(
      questions[0].options.map(o => o.id),
      ['keep', 'read', 'archive', 'both', 'later']
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('discovery asks about Primary mail that also carries the Updates label', async t => {
  const f = fixture(t, { topicActions: true });
  const noise = f.mails.get('noise');
  noise.labelIds.push('CATEGORY_UPDATES');
  noise.payload.headers.push({ name: 'Message-ID', value: '<updates@example.invalid>' });
  noise.payload.headers.find(h => h.name === 'Subject').value = 'Your trial ends in three days';
  const originalClient = f.service.client.bind(f.service);
  f.service.client = account => {
    const base = originalClient(account);
    return async (path, ...args) =>
      path.startsWith('messages?') && new URLSearchParams(path.split('?')[1]).get('q')?.includes('rfc822msgid:')
        ? { messages: [{ id: 'noise' }] }
        : base(path, ...args);
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const id = JSON.parse(JSON.parse(options.body).messages.at(-1).content).find(m => /trial/.test(m.subject))?.id;
    return Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              summary: 'Service notices recur.',
              questions: [
                {
                  messageId: id,
                  category: 'topic_service_notices',
                  question: 'How should I handle service notices?',
                  reason: 'Trial reminders appear in the sample.',
                  evidenceQuote: 'Your trial ends'
                }
              ]
            })
          }
        }
      ]
    });
  };
  try {
    await learnInbox(f.service, f.id, true, 'nebius');
    const questions = f.store.all('SELECT payload FROM agent_questions').map(q => f.crypto.open(q.payload));
    assert.deepEqual(
      questions.map(q => q.question),
      ['How should I handle service notices?']
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('batched agent handles 45 approved low-priority messages in five model calls and preserves security alerts', async t => {
  const f = fixture(t, { topicActions: true, keepPeople: false });
  const original = structuredClone(f.mails.get('noise'));
  f.mails.clear();
  for (let i = 0; i < 45; i++) f.mails.set(`promo-${i}`, { ...structuredClone(original), id: `promo-${i}` });
  const security = { ...structuredClone(original), id: 'security' };
  security.payload.headers[1].value = 'Security alert: a new sign-in';
  f.mails.set('security', security);
  f.store.run(
    'INSERT INTO preference_memories(id,account_id,scope_hash,payload,updated) VALUES(?,?,?,?,?)',
    'product-pref',
    f.id,
    'category:product_announcements',
    f.crypto.seal({
      scope: { kind: 'category', category: 'product_announcements', scopeHash: 'category:product_announcements' },
      action: 'read',
      effectiveFrom: 0
    }),
    Date.now()
  );
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let active = 0;
  let peak = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    const body = JSON.parse(options.body);
    assert.equal(body.max_tokens, 50000);
    const items = JSON.parse(body.messages.at(-1).content);
    assert.ok(items.length <= 10);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              decisions: items.map(item => ({
                id: item.id,
                decision: {
                  action: 'read',
                  confidence: 0.94,
                  preferenceCategory: 'product_announcements',
                  categoryConfidence: 0.96,
                  reason: 'An ordinary promotion in the topic you approved.'
                }
              }))
            })
          }
        }
      ]
    });
  };
  try {
    const result = await f.service.locked(f.id, guard => runAgent(f.service, f.id, guard));
    assert.equal(result.changed, 45);
    assert.equal(result.kept, 1);
    assert.equal(calls, 5);
    assert.equal(peak, 2);
    assert.ok(f.mails.get('security').labelIds.includes('UNREAD'));
    assert.equal((await accessFor(f.service, f.id)).used, 46);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('incomplete model batch cannot modify any message in that window', async t => {
  const f = fixture(t, { keepPeople: false });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              decisions: [{ id: 'invented-id', decision: { action: 'read', confidence: 1, reason: 'Must not apply' } }]
            })
          }
        }
      ]
    });
  try {
    const result = await f.service.locked(f.id, guard => runAgent(f.service, f.id, guard));
    assert.equal(result.waiting, 0, 'Malformed or uncertain results are kept, not presented as nonexistent questions');
    assert.equal(f.writes.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('one explicit reassessment revisits only the original zero-change trial without resetting lifetime usage', async t => {
  const f = fixture(t, { keepPeople: false });
  await f.service.locked(f.id, guard =>
    runAgent(f.service, f.id, guard, undefined, 'manual', async () => ({
      action: 'keep',
      confidence: 1,
      reason: 'Kept during the earlier run'
    }))
  );
  assert.equal((await accessFor(f.service, f.id)).recoveryAvailable, true);
  await assert.rejects(restartTrial(f.service, f.id, false), /Authorize/);
  const used = (await accessFor(f.service, f.id)).used;
  f.store.run(
    'INSERT INTO agent_holds(account_id,message_id,scope_hash,created) VALUES(?,?,?,?)',
    f.id,
    'noise',
    'category:product_announcements',
    Date.now()
  );
  await f.service.locked(f.id, () => restartTrial(f.service, f.id, true));
  assert.equal(f.store.get('SELECT count(*) AS n FROM agent_holds').n, 0);
  assert.equal((await accessFor(f.service, f.id)).used, used);
  assert.equal(await reserveFreeEmail(f.service, f.id, 'outside-original-sample', true), false);
  f.mails.set('later', { ...structuredClone(f.mails.get('noise')), id: 'later' });
  const result = await f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'manual', f.infer));
  assert.ok(result.changed > 0);
  assert.ok(f.mails.get('later').labelIds.includes('UNREAD'));
  assert.equal((await accessFor(f.service, f.id)).used, used);
  assert.equal((await accessFor(f.service, f.id)).recoveryAvailable, false);
  await assert.rejects(restartTrial(f.service, f.id, true), /not available/);
});

test('HTML-only mail is readable as text without scripts, styles, or attachments', () => {
  const payload = {
    mimeType: 'text/html',
    body: {
      data: Buffer.from(
        '<style>hidden styles</style><script>hidden code</script><p>New features &amp; updates</p>'
      ).toString('base64url')
    }
  };
  assert.equal(emailText(payload), 'New features & updates');
});

test('grouped discovery preserves evidence through alias mapping and topic selection', async t => {
  const f = fixture(t, { topicActions: true });
  const original = structuredClone(f.mails.get('noise'));
  f.mails.clear();
  for (let i = 0; i < 100; i++) {
    const message = { ...structuredClone(original), id: `opaque-${i}` };
    message.payload.headers[1].value = i < 50 ? 'Weekend sale and discounts' : 'Weekly newsletter digest';
    f.mails.set(message.id, message);
  }
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    const input = JSON.parse(JSON.parse(options.body).messages.at(-1).content);
    if (input[0].candidateId) {
      assert.equal(input.length, 2, 'Exact topic duplicates must be combined before the merge call');
      assert.equal(input.find(item => item.category === 'sales_discounts').minAgeDays, 90);
    }
    const result = input[0].candidateId
      ? { selected: ['question_1', 'question_2'] }
      : {
          summary: 'Recurring topics.',
          questions: [
            {
              messageId: input[0].id,
              category: input[0].subject.includes('sale') ? 'sales_discounts' : 'newsletters',
              minAgeDays: input[0].id === 'email_26' ? 90 : 0,
              question: 'How should I handle offers from this particular brand?',
              reason: 'This is a recurring topic in this part of the sample.',
              evidenceQuote: input[0].subject
            }
          ]
        };
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] });
  };
  try {
    await learnInbox(f.service, f.id, true, 'nebius');
    const questions = f.store.all('SELECT payload FROM agent_questions').map(row => f.crypto.open(row.payload));
    assert.equal(calls, 5);
    assert.equal(questions.length, 2);
    assert.ok(questions.every(question => !question.question.includes('brand')));
    assert.deepEqual(questions.map(q => q.scope.category).sort(), ['newsletters', 'sales_discounts']);
    assert.ok(
      questions.every(q => ['Weekend sale and discounts', 'Weekly newsletter digest'].includes(q.sample.subject))
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('discovery fetches headers only and never sends bodies or snippets to the model', async t => {
  const f = fixture(t);
  const secretBody = 'BODY_ONLY_DISCOVERY_CANARY';
  for (const message of f.mails.values()) {
    message.snippet = secretBody;
    message.payload.body.data = Buffer.from(secretBody).toString('base64url');
  }
  const originalFactory = f.service.clientFactory;
  const paths = [];
  f.service.clientFactory = (...args) => {
    const client = originalFactory(...args);
    return async (path, ...rest) => {
      paths.push(path);
      return client(path, ...rest);
    };
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    assert.ok(!options.body.includes(secretBody));
    const body = JSON.parse(options.body);
    const input = JSON.parse(body.messages.at(-1).content);
    for (const item of input)
      for (const field of ['text', 'body', 'snippet', 'payload']) assert.equal(Object.hasOwn(item, field), false);
    return Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              questions: [
                {
                  messageId: input[0].id,
                  category: 'topic_body_only_evidence',
                  question: 'How should I handle this topic?',
                  reason: 'A fabricated body citation must be rejected.',
                  evidenceQuote: secretBody
                }
              ]
            })
          }
        }
      ]
    });
  };
  try {
    await learnInbox(f.service, f.id, true, 'nebius');
    const reads = paths.filter(path => path.startsWith('messages/'));
    assert.equal(reads.length, 4);
    for (const path of reads) {
      const params = new URLSearchParams(path.split('?')[1]);
      assert.equal(params.get('format'), 'metadata');
      assert.deepEqual(params.getAll('metadataHeaders').sort(), ['Date', 'From', 'List-ID', 'Message-ID', 'Subject']);
    }
    assert.equal(f.store.get('SELECT count(*) AS n FROM agent_questions').n, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('batch preference proposal beside the id normalizes to a question, never a mailbox action', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              decisions: [
                {
                  id: 'email_1',
                  requestPreference: {
                    category: 'product_announcements',
                    question: 'How should I handle announcements?',
                    reason: 'Preference unknown'
                  }
                }
              ]
            })
          }
        }
      ]
    });
  try {
    const result = await modelDecisionBatch({ aiKey: 'fixture' }, 'Decide from saved preferences.', [
      { id: 'opaque-gmail-id' }
    ]);
    assert.equal(result.get('opaque-gmail-id').requestPreference.category, 'product_announcements');
    assert.equal(result.get('opaque-gmail-id').action, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('low-confidence named-category batch results get one focused retry with independent aliases and a complete saved-topic decision', async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    calls++;
    if (calls === 2) {
      assert.match(request.messages[0].content, /CATEGORY CLARIFICATION PASS/);
      const items = JSON.parse(request.messages.at(-1).content);
      assert.equal(items.length, 1);
      assert.equal(items[0].subject, 'Synthetic weekly report');
    }
    return Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              decisions:
                calls === 1
                  ? [
                      {
                        id: 'email_1',
                        decision: {
                          action: 'read',
                          confidence: 1,
                          reason: 'Saved products topic',
                          preferenceCategory: 'product_announcements',
                          categoryConfidence: 1
                        }
                      },
                      {
                        id: 'email_2',
                        decision: {
                          action: 'keep',
                          confidence: 1,
                          reason: 'Category unclear',
                          preferenceCategory: 'newsletters',
                          categoryConfidence: 0
                        }
                      }
                    ]
                  : [
                      {
                        id: 'email_1',
                        decision: {
                          action: 'read',
                          confidence: 0.96,
                          reason: 'A routine report follows the newsletters preference',
                          preferenceCategory: 'newsletters',
                          categoryConfidence: 0.96
                        }
                      }
                    ]
            })
          }
        }
      ]
    });
  };
  try {
    const result = await modelDecisionBatch({ aiKey: 'synthetic-only' }, 'Use saved topic preferences.', [
      { id: 'product', subject: 'Synthetic product update' },
      { id: 'report', subject: 'Synthetic weekly report' }
    ]);
    assert.equal(calls, 2);
    assert.equal(result.get('product').preferenceCategory, 'product_announcements');
    assert.equal(result.get('report').preferenceCategory, 'newsletters');
    assert.equal(result.get('report').action, 'read');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('category retry is bounded and can ask one new broad question without inventing an action', async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              decisions: [
                {
                  id: 'email_1',
                  decision:
                    calls === 1
                      ? {
                          action: 'keep',
                          confidence: 1,
                          reason: 'Unclear category',
                          preferenceCategory: 'newsletters',
                          categoryConfidence: 0
                        }
                      : {
                          requestPreference: {
                            category: 'topic_routine_service_notices',
                            question: 'How should I handle routine service notices?',
                            reason: 'These include welcome messages and usage summaries.'
                          }
                        }
                }
              ]
            })
          }
        }
      ]
    });
  };
  try {
    const result = await modelDecisionBatch({ aiKey: 'synthetic-only' }, 'Use saved topic preferences.', [
      { id: 'welcome' }
    ]);
    assert.equal(calls, 2);
    assert.equal(result.get('welcome').requestPreference.category, 'topic_routine_service_notices');
    assert.equal(result.get('welcome').action, undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('duplicate and missing batch entries keep only affected messages; unknown ids cannot authorize writes', async () => {
  const originalFetch = globalThis.fetch;
  const decision = { action: 'read', confidence: 0.99, reason: 'Low-priority promotion' };
  globalThis.fetch = async () =>
    Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              decisions: [
                null,
                { id: 'email_1', decision },
                { id: 'email_1', decision },
                { id: 'email_2', decision },
                { id: 'invented', decision }
              ]
            })
          }
        }
      ]
    });
  try {
    const result = await modelDecisionBatch({ aiKey: 'fixture' }, 'Decide from saved preferences.', [
      { id: 'first' },
      { id: 'second' },
      { id: 'missing' }
    ]);
    assert.equal(result.get('first').action, 'keep');
    assert.equal(result.get('second').action, 'read');
    assert.equal(result.get('missing').action, 'keep');
    assert.equal(result.has('invented'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('older routine bank/login notices obey their own age and written preferences; recent and unresolved alerts stay', async t => {
  const f = fixture(t, { topicActions: true, keepPeople: false });
  const base = structuredClone(f.mails.get('noise'));
  f.mails.clear();
  const add = (id, days, subject, extra = {}) => {
    const message = {
      ...structuredClone(base),
      id,
      internalDate: days === null ? 'invalid' : String(Date.now() - days * 86400000),
      ...extra
    };
    message.payload.headers = [
      { name: 'From', value: 'Account notices <notices@bank.example>' },
      { name: 'Subject', value: subject },
      { name: 'Date', value: 'Mon, 1 Jan 2001 12:00:00 +0000' }
    ];
    f.mails.set(id, message);
  };
  add('old-bank', 120, 'Bank transaction confirmation');
  add('new-bank', 10, 'Bank transaction confirmation');
  add('not-old-enough', 60, 'Bank transaction confirmation');
  add('old-login', 120, 'Login confirmation');
  add('current-login', 1, 'Login confirmation');
  add('fraud', 120, 'Suspicious bank transaction');
  add('ambiguous', 120, 'Bank transaction detail');
  add('undated', null, 'Bank transaction confirmation');
  for (const [category, minAgeDays] of [
    ['bank_transactions', 90],
    ['security_notices', 60]
  ]) {
    f.store.run(
      'INSERT INTO preference_memories(id,account_id,scope_hash,payload,updated) VALUES(?,?,?,?,?)',
      category,
      f.id,
      `category:${category}`,
      f.crypto.seal({
        scope: { kind: 'category', category, scopeHash: `category:${category}`, minimumAgeDays: 30 },
        action: 'read',
        minAgeDays,
        instructions: 'Keep unusual activity alerts.',
        effectiveFrom: 0
      }),
      Date.now()
    );
  }
  let calls = 0;
  const infer = async (_config, _prompt, input) => {
    calls++;
    assert.ok(input.currentClock.currentDate);
    assert.equal(input.fromAddress, 'notices@bank.example');
    assert.ok(input.sender.includes('@bank.example'));
    assert.equal(input.sentAt, '2001-01-01T12:00:00.000Z');
    assert.equal(
      input.categoryPreferences.find(memory => memory.scope.category === 'bank_transactions').instructions,
      'Keep unusual activity alerts.'
    );
    return {
      action: 'read',
      confidence: 0.99,
      preferenceCategory: input.sensitiveNoticeCategory,
      categoryConfidence: 0.99,
      routineNotice: input.subject !== 'Bank transaction detail',
      reason: 'Routine historical confirmation.'
    };
  };
  const result = await f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'manual', infer));
  assert.equal(result.changed, 2);
  assert.equal(calls, 4);
  for (const id of ['old-bank', 'old-login']) assert.ok(!f.mails.get(id).labelIds.includes('UNREAD'));
  for (const id of ['new-bank', 'not-old-enough', 'current-login', 'fraud', 'ambiguous', 'undated'])
    assert.ok(f.mails.get(id).labelIds.includes('UNREAD'));
});

test('discovery supplies from address, sent/received dates, trustworthy age and the current clock', async t => {
  const f = fixture(t);
  const old = f.mails.get('noise');
  old.internalDate = String(Date.now() - 120 * 86400000);
  old.payload.headers[1].value = 'Bank transaction confirmation';
  old.payload.headers.push({ name: 'Date', value: 'Mon, 1 Jan 2001 12:00:00 +0000' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.doesNotMatch(body.messages[0].content, /User background notes.*\d{4}-\d{2}-\d{2}/);
    const context = JSON.parse(body.messages[1].content).discoveryContext;
    assert.ok(context.currentClock.currentDate);
    assert.ok(context.currentClock.now);
    const sample = JSON.parse(body.messages.at(-1).content);
    const email = sample.find(item => item.subject === 'Bank transaction confirmation');
    assert.equal(email.fromAddress, 'noise@example.invalid');
    assert.equal(email.sentAt, '2001-01-01T12:00:00.000Z');
    assert.ok(email.ageDays >= 120 && email.ageDays < 121);
    return Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              questions: [
                {
                  messageId: email.id,
                  category: 'bank_transactions',
                  minAgeDays: 90,
                  question: 'How should I handle old bank confirmations?',
                  reason: 'Routine bank notices are several months old.',
                  evidenceQuote: email.subject
                }
              ]
            })
          }
        }
      ]
    });
  };
  try {
    await learnInbox(f.service, f.id, true, 'nebius');
    const question = f.crypto.open(f.store.get('SELECT payload FROM agent_questions').payload);
    assert.match(question.question, /older than 90 days/);
    assert.equal(question.minAgeDays, 90);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('free sample requests the newest 100 unread Primary messages and stays frozen', async t => {
  const f = fixture(t);
  let calls = 0;
  const gmail = async path => {
    calls++;
    const q = new URLSearchParams(path.split('?')[1]);
    assert.equal(q.get('q'), 'in:inbox category:primary is:unread');
    assert.equal(q.get('maxResults'), '100');
    return { messages: Array.from({ length: 105 }, (_, i) => ({ id: `newest-${i}` })), nextPageToken: 'older' };
  };
  const sample = await trialSample(f.service, f.id, gmail);
  assert.equal(sample.scope, 'primary');
  assert.equal(sample.ids.length, 100);
  assert.equal(sample.ids[0], 'newest-0');
  assert.equal(sample.ids[99], 'newest-99');
  assert.deepEqual(await trialSample(f.service, f.id, gmail), sample);
  assert.equal(calls, 1);
});

test('discovery excludes other tabs even when a legacy saved sample contains them', async t => {
  const f = fixture(t);
  f.mails.clear();
  const msg = tab => ({
    id: tab,
    internalDate: String(Date.now()),
    labelIds: ['INBOX', 'UNREAD', tab],
    payload: {
      headers: [
        { name: 'From', value: 'news@example.invalid' },
        { name: 'Subject', value: tab === 'CATEGORY_PERSONAL' ? 'Primary subject' : 'EXCLUDED_TAB_CANARY' }
      ]
    }
  });
  for (const tab of [
    'CATEGORY_PERSONAL',
    'CATEGORY_PROMOTIONS',
    'CATEGORY_SOCIAL',
    'CATEGORY_UPDATES',
    'CATEGORY_FORUMS'
  ])
    f.mails.set(tab, msg(tab));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    assert.ok(!options.body.includes('EXCLUDED_TAB_CANARY'));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"questions":[]}' } }] });
  };
  try {
    const result = await learnInbox(f.service, f.id, true, 'nebius');
    assert.equal(result.inspected, 1);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('messages without confirmed Primary membership never reach AI classification or mailbox changes', async t => {
  const f = fixture(t, { keepPeople: false });
  f.mails.get('noise').labelIds.push('CATEGORY_PERSONAL');
  for (const [id, tab] of [
    ['person', 'CATEGORY_PROMOTIONS'],
    ['uncertain', 'CATEGORY_UPDATES'],
    ['starred', 'CATEGORY_SOCIAL']
  ])
    f.mails.get(id).labelIds.push(tab);
  const classified = [];
  const result = await f.service.locked(f.id, guard =>
    runAgent(f.service, f.id, guard, undefined, 'manual', async (_config, _prompt, input) => {
      classified.push(input.sender);
      return { action: 'read', confidence: 1, reason: 'Approved low-priority mail.' };
    })
  );
  assert.equal(result.changed, 1);
  assert.deepEqual(classified, ['noise@example.invalid']);
  assert.equal(f.writes.length, 1);
  for (const id of ['person', 'uncertain', 'starred']) assert.ok(f.mails.get(id).labelIds.includes('UNREAD'));
});

test('Primary search confirmation lets an Updates-labelled product announcement follow its saved read preference', async t => {
  const f = fixture(t, { keepPeople: false, topicActions: true });
  const message = f.mails.get('noise');
  f.mails.clear();
  f.mails.set('noise', message);
  message.labelIds.push('CATEGORY_UPDATES');
  message.payload.headers.push({ name: 'Message-ID', value: '<product-update@example.invalid>' });
  f.store.run(
    'INSERT INTO preference_memories(id,account_id,scope_hash,payload,updated) VALUES(?,?,?,?,?)',
    'product',
    f.id,
    'category:product_announcements',
    f.crypto.seal({
      scope: { kind: 'category', category: 'product_announcements', scopeHash: 'category:product_announcements' },
      action: 'read',
      minAgeDays: 0,
      effectiveFrom: 0
    }),
    Date.now()
  );
  const originalClient = f.service.client.bind(f.service);
  let confirmations = 0;
  let classified = 0;
  f.service.client = account => {
    const base = originalClient(account);
    return async (path, ...args) => {
      if (path.startsWith('messages?') && new URLSearchParams(path.split('?')[1]).get('q')?.includes('rfc822msgid:')) {
        confirmations++;
        assert.equal(
          new URLSearchParams(path.split('?')[1]).get('q'),
          'in:inbox category:primary is:unread rfc822msgid:product-update@example.invalid'
        );
        return { messages: [{ id: 'noise' }] };
      }
      return base(path, ...args);
    };
  };
  const result = await f.service.locked(f.id, guard =>
    runAgent(f.service, f.id, guard, undefined, 'manual', async () => {
      classified++;
      return {
        action: 'read',
        confidence: 1,
        reason: 'Saved product announcement preference',
        preferenceCategory: 'product_announcements',
        categoryConfidence: 1
      };
    })
  );
  assert.equal(classified, 1);
  assert.equal(confirmations, 2);
  assert.equal(result.changed, 1);
  assert.ok(message.labelIds.includes('INBOX'));
  assert.equal(message.labelIds.includes('UNREAD'), false);
});

test('an Updates-labelled message removed from Primary while AI decides is not modified', async t => {
  const f = fixture(t, { keepPeople: false });
  const message = f.mails.get('noise');
  f.mails.clear();
  f.mails.set('noise', message);
  message.labelIds.push('CATEGORY_UPDATES');
  message.payload.headers.push({ name: 'Message-ID', value: '<moved@example.invalid>' });
  const originalClient = f.service.client.bind(f.service);
  let confirmations = 0;
  f.service.client = account => {
    const base = originalClient(account);
    return async (path, ...args) => {
      if (path.startsWith('messages?') && new URLSearchParams(path.split('?')[1]).get('q')?.includes('rfc822msgid:'))
        return { messages: ++confirmations === 1 ? [{ id: 'noise' }] : [] };
      return base(path, ...args);
    };
  };
  await f.service.locked(f.id, guard =>
    runAgent(f.service, f.id, guard, undefined, 'manual', async () => ({
      action: 'read',
      confidence: 1,
      reason: 'Low priority'
    }))
  );
  assert.equal(confirmations, 2);
  assert.equal(f.writes.length, 0);
  assert.ok(message.labelIds.includes('UNREAD'));
});

test('Primary confirmation requires the exact Gmail message and rejects unsafe or absent Message-ID headers', async () => {
  const message = {
    id: 'wanted',
    labelIds: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'],
    payload: { headers: [{ name: 'Message-ID', value: '<shared@example.invalid>' }] }
  };
  assert.equal(await confirmPrimaryInbox(async () => ({ messages: [{ id: 'another-message' }] }), message), false);
  for (const value of ['', '<id@example.invalid> OR in:anywhere', '<id@example.invalid)']) {
    let calls = 0;
    message.payload.headers[0].value = value;
    assert.equal(
      await confirmPrimaryInbox(async () => {
        calls++;
        return {};
      }, message),
      false
    );
    assert.equal(calls, 0);
  }
});

test('a message that moves out of Primary after classification is left unchanged', async t => {
  const f = fixture(t, { keepPeople: false });
  const originalClient = f.service.client.bind(f.service);
  f.service.client = account => {
    const gmail = originalClient(account);
    return async (path, ...args) => {
      const message = await gmail(path, ...args);
      if (path === 'messages/noise?format=metadata') message.labelIds.push('CATEGORY_PROMOTIONS');
      return message;
    };
  };
  await f.service.locked(f.id, guard =>
    runAgent(f.service, f.id, guard, undefined, 'manual', async (_config, _prompt, input) => ({
      action: input.sender.startsWith('noise@') ? 'read' : 'keep',
      confidence: 1,
      reason: 'Approved topic.'
    }))
  );
  assert.equal(f.writes.length, 0);
  assert.ok(f.mails.get('noise').labelIds.includes('UNREAD'));
});

test('paid discovery and cleanup searches are also restricted to Primary', async t => {
  const f = fixture(t);
  await accessFor(f.service, f.id);
  f.store.run("UPDATE account_access SET tier='paid'");
  const originalClient = f.service.client.bind(f.service);
  const queries = [];
  f.service.client = account => {
    const gmail = originalClient(account);
    return async (path, ...args) => {
      if (path.startsWith('messages?')) {
        const query = new URLSearchParams(path.split('?')[1]).get('q');
        if (!query.includes('in:sent')) queries.push(query);
      }
      return gmail(path, ...args);
    };
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"questions":[]}' } }] });
  try {
    await learnInbox(f.service, f.id, true, 'nebius');
    await f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'manual', f.infer));
    assert.equal(queries.length, 2);
    assert.ok(queries.every(query => query.includes('category:primary') && query.includes('is:unread')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('hackathon mode unlocks repeated 100-email runs and daily access without resetting commercial quota', async t => {
  const f = fixture(t, { keepPeople: false });
  await accessFor(f.service, f.id);
  f.store.run('UPDATE account_access SET free_used=100,discovery_used=1');
  f.service.config.hackathonMode = true;
  assert.equal((await accessFor(f.service, f.id)).dailyAllowed, true);
  const run = () =>
    f.service.locked(f.id, guard =>
      runAgent(f.service, f.id, guard, undefined, 'manual', async () => ({
        action: 'read',
        confidence: 1,
        reason: 'Low priority.'
      }))
    );
  assert.ok((await run()).changed > 0);
  const fresh = structuredClone(f.mails.get('noise'));
  fresh.id = 'brand-new';
  fresh.labelIds = ['INBOX', 'UNREAD'];
  fresh.payload.headers[0].value = 'new@example.invalid';
  f.mails.clear();
  f.mails.set(fresh.id, fresh);
  assert.equal((await run()).changed, 1);
  assert.equal(f.store.get('SELECT free_used FROM account_access').free_used, 100);
  assert.equal((await accessFor(f.service, f.id)).remaining, 100);
  await f.service.saveRules(f.id, { ...f.rules, daily: true });
});

test('hackathon daily agent runs with saved consent once per account-local day', async t => {
  const f = fixture(t, { keepPeople: false });
  f.service.config.hackathonMode = true;
  await f.service.saveRules(f.id, { ...f.rules, daily: true, hour: 0, timezone: 'UTC' });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    const items = JSON.parse(JSON.parse(options.body).messages.at(-1).content);
    return Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              decisions: items.map(item => ({
                id: item.id,
                decision: { action: 'read', confidence: 1, reason: 'Routine low-priority mail.' }
              }))
            })
          }
        }
      ]
    });
  };
  try {
    await f.service.daily();
    const firstCalls = calls;
    assert.ok(f.writes.length > 0);
    assert.ok(firstCalls > 0);
    await f.service.daily();
    assert.equal(calls, firstCalls);
    assert.equal(f.store.get("SELECT count(*) AS total FROM runs WHERE kind='daily'").total, 1);
    assert.equal(f.store.get('SELECT last_error FROM accounts').last_error, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a valid unknown category never triggers a clarification retry, even with zero category confidence', async t => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              decisions: [
                {
                  id: 'email_1',
                  decision: {
                    action: 'read',
                    confidence: 0.99,
                    reason: 'Low priority according to saved general preferences',
                    preferenceCategory: 'unknown',
                    categoryConfidence: 0
                  }
                }
              ]
            })
          }
        }
      ]
    });
  };
  const result = await modelDecisionBatch({ aiKey: 'fixture' }, 'Use saved preferences', [{ id: 'sample' }]);
  assert.equal(calls, 1);
  assert.equal(result.get('sample').action, 'read');
  assert.equal(result.get('sample').preferenceCategory, 'unknown');
});

test('completed AI batches modify emails before a slow sibling fails, and the run remains partial', async t => {
  const f = fixture(t, { keepPeople: false, topicActions: false, action: 'read' });
  f.service.config.hackathonMode = true;
  const base = structuredClone(f.mails.get('noise'));
  f.mails.clear();
  for (let i = 0; i < 20; i++) {
    const mail = structuredClone(base);
    mail.id = `sample-${i}`;
    mail.payload.headers.find(h => h.name === 'Subject').value =
      `${i < 10 ? 'Slow' : 'Fast'} synthetic announcement ${i}`;
    f.mails.set(mail.id, mail);
  }
  let releaseSlow;
  const slowGate = new Promise(resolve => {
    releaseSlow = resolve;
  });
  let signalFast;
  const fastApplied = new Promise(resolve => {
    signalFast = resolve;
  });
  const previous = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const inputs = JSON.parse(JSON.parse(options.body).messages.at(-1).content);
    if (inputs[0].subject.startsWith('Slow')) {
      await slowGate;
      return Response.json({}, { status: 503 });
    }
    return Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              decisions: inputs.map(item => ({
                id: item.id,
                decision: {
                  action: 'read',
                  confidence: 1,
                  preferenceCategory: 'product_announcements',
                  categoryConfidence: 1,
                  reason: 'Low-priority synthetic announcement'
                }
              }))
            })
          }
        }
      ]
    });
  };
  let run;
  try {
    run = f.service.locked(f.id, guard =>
      runAgent(f.service, f.id, guard, event => {
        if (event.type === 'decision' && event.changed === 10) signalFast();
      })
    );
    run.catch(() => {});
    await Promise.race([
      fastApplied,
      new Promise((_, reject) => {
        const timeout = setTimeout(() => reject(new Error('Fast batch blocked by slow sibling')), 5000);
        timeout.unref();
      })
    ]);
    assert.equal(f.writes.length, 10);
    assert.equal(f.mails.get('sample-0').labelIds.includes('UNREAD'), true);
    assert.equal(f.mails.get('sample-10').labelIds.includes('UNREAD'), false);
    releaseSlow();
    await assert.rejects(run);
    const saved = f.store.get('SELECT status,changed FROM runs WHERE account_id=?', f.id);
    assert.equal(saved.status, 'needs_review');
    assert.equal(saved.changed, 10);
    assert.equal(f.writes.length, 10);
  } finally {
    releaseSlow();
    if (run) await run.catch(() => {});
    globalThis.fetch = previous;
  }
});

test('uncertain keeps never imply pending questions, but saved questions retain an actionable count', async t => {
  const f = fixture(t, { keepPeople: false, topicActions: false });
  const result = await f.service.locked(f.id, guard =>
    runAgent(f.service, f.id, guard, undefined, 'manual', async () => ({
      action: 'keep',
      confidence: 1,
      reason: 'Uncertain; left unchanged without another question'
    }))
  );
  assert.equal(result.kept, 4);
  assert.equal(result.waiting, 0);
  assert.equal(f.store.get('SELECT count(*) AS count FROM agent_questions WHERE account_id=?', f.id).count, 0);
  const g = fixture(t, { keepPeople: false, topicActions: true });
  const asked = await g.service.locked(g.id, guard =>
    runAgent(g.service, g.id, guard, undefined, 'manual', async () => ({
      requestPreference: {
        category: 'product_announcements',
        question: 'How should I handle announcements?',
        reason: 'A broad topic preference is needed.'
      }
    }))
  );
  assert.equal(asked.kept, 4);
  assert.equal(asked.waiting, 3);
  assert.equal(
    g.store.get("SELECT count(*) AS count FROM agent_questions WHERE account_id=? AND status='pending'", g.id).count,
    1
  );
});
