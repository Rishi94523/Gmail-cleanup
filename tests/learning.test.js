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
import {
  askPreference,
  answerPreference,
  editMemory,
  learningTray,
  scopeFor,
  interpretPreference,
  interpretNotes,
  saveNotes,
  categoryContext,
  holdEmail
} from '../server/learning.js';
import { unsubscribeEligible, automaticUnsubscribe } from '../server/subscription-agent.js';
import { chatJSON } from '../server/ai.js';
import { categoryScope, matchingException, validateExceptions } from '../server/preference-categories.js';

function mail(id, subject = 'Product updates', listId = 'marketing.product.example') {
  const headers = {
    From: 'offers@product.example',
    Subject: subject,
    'List-ID': `<${listId}>`,
    'List-Unsubscribe': '<https://lists.product.example/leave>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    'Authentication-Results': 'mx.google.com; dkim=pass header.i=@product.example;',
    'DKIM-Signature': 'v=1; d=product.example; h=from:subject:list-unsubscribe:list-unsubscribe-post; b=fixture'
  };
  return {
    id,
    historyId: '1',
    internalDate: String(Date.now()),
    labelIds: ['INBOX', 'UNREAD'],
    payload: {
      mimeType: 'text/plain',
      body: { data: Buffer.from('A product announcement.').toString('base64url') },
      headers: Object.entries(headers).map(([name, value]) => ({ name, value }))
    }
  };
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'inboxclean-learning-'));
  const store = openStore(dir);
  const crypto = encryption(randomBytes(32).toString('base64'));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const id = 'owner@example.invalid';
  const rules = {
    ...DEFAULT_RULES,
    agent: {
      ...DEFAULT_PREFERENCES,
      enabled: true,
      consent: true,
      consentProvider: 'nebius',
      keepPeople: false,
      autoUnsubscribe: true
    }
  };
  store.run(
    'INSERT INTO accounts(id,email,tokens,rules,created) VALUES(?,?,?,?,?)',
    id,
    id,
    crypto.seal({}),
    JSON.stringify(rules),
    Date.now()
  );
  const messages = new Map([
    ['one', mail('one')],
    ['two', mail('two')]
  ]);
  let writes = 0;
  const gmail = async (path, body) => {
    if (path.startsWith('messages?')) return { messages: [...messages.keys()].map(id => ({ id })) };
    if (path === 'labels') return { labels: [{ id: 'CLEANED', name: 'Cleaned by agent' }] };
    const message = messages.get(path.split('/')[1].split('?')[0]);
    if (body) {
      writes++;
      message.labelIds = message.labelIds.filter(label => !body.removeLabelIds.includes(label));
    }
    return structuredClone(message);
  };
  return {
    id,
    store,
    crypto,
    rules,
    messages,
    service: new InboxService(store, crypto, { aiKey: 'fixture-only', aiProvider: 'nebius' }, () => gmail),
    writes: () => writes
  };
}
const args = {
  category: 'product_announcements',
  question: 'Do you want updates from this product?',
  reason: 'Your subscription intent is unclear.'
};

test('written onboarding instructions preview first, save encrypted topic preferences, and authorize only the initial sample', async t => {
  const f = fixture(t);
  const originalFetch = globalThis.fetch;
  f.store.run(
    'INSERT INTO trial_samples(account_id,payload) VALUES(?,?)',
    f.id,
    f.crypto.seal({ ids: ['one', 'two'] })
  );
  for (const message of f.messages.values()) message.internalDate = String(Date.now() - 120 * 86400000);
  await askPreference(f.service, f.id, f.messages.get('one'), f.rules.agent, args, { initial: true });
  globalThis.fetch = async () =>
    Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              supported: true,
              topics: [{ category: 'product_announcements', action: 'archive', minAgeDays: 30 }],
              context: ''
            })
          }
        }
      ]
    });
  try {
    const preview = await interpretNotes(f.service, f.id, {
      text: 'Archive product announcements after 30 days, but keep Apple announcements.'
    });
    assert.equal(preview.topics[0].action, 'archive');
    assert.equal(f.store.get('SELECT count(*) AS n FROM preference_memories').n, 0);
    assert.equal(f.writes(), 0);
    await saveNotes(f.service, f.id, { token: preview.token });
    const tray = await learningTray(f.service, f.id);
    assert.equal(tray.questions.length, 0);
    assert.equal(tray.memories[0].action, 'archive');
    assert.equal(tray.memories[0].applies, 'all_eligible_messages');
    assert.match(tray.memories[0].instructions, /keep Apple/);
    assert.ok(!f.store.get('SELECT payload FROM preference_memories').payload.includes('Apple'));
    let calls = 0;
    const result = await f.service.locked(f.id, guard =>
      runAgent(f.service, f.id, guard, undefined, 'manual', async (_config, _prompt, input) => {
        calls++;
        assert.match(input.categoryPreferences[0].instructions, /keep Apple/);
        return {
          action: 'archive',
          confidence: 0.99,
          reason: 'Older product announcement, not Apple',
          preferenceCategory: 'product_announcements',
          categoryConfidence: 0.99
        };
      })
    );
    assert.equal(calls, 2);
    assert.equal(result.changed, 2);
    await assert.rejects(saveNotes(f.service, f.id, { token: preview.token }), /preferences changed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('written preference confirmation rejects tampering, another account, expiry, and stale versions without writes', async t => {
  const f = fixture(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              supported: true,
              topics: [{ category: 'newsletters', action: 'keep', minAgeDays: 0 }],
              context: ''
            })
          }
        }
      ]
    });
  try {
    const preview = await interpretNotes(f.service, f.id, { text: 'Keep my newsletters.' });
    await assert.rejects(saveNotes(f.service, f.id, { token: 'tampered' }), /Review/);
    await assert.rejects(saveNotes(f.service, 'someone-else', { token: preview.token }), /expired/);
    const proposal = f.crypto.open(preview.token);
    proposal.expires = 1;
    await assert.rejects(saveNotes(f.service, f.id, { token: f.crypto.seal(proposal) }), /expired/);
    await askPreference(f.service, f.id, f.messages.get('one'), f.rules.agent, args);
    const question = (await learningTray(f.service, f.id)).questions[0];
    await answerPreference(f.service, f.id, { questionId: question.id, version: question.version, option: 'read' });
    await assert.rejects(saveNotes(f.service, f.id, { token: preview.token }), /preferences changed/);
    assert.equal(f.writes(), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('background notes reach the agent without granting topic permissions; future notes never release held emails', async t => {
  const f = fixture(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              supported: true,
              topics: [],
              context: 'I am looking for software engineering jobs.'
            })
          }
        }
      ]
    });
  try {
    f.rules.agent.topicActions = true;
    f.store.run('UPDATE accounts SET rules=? WHERE id=?', JSON.stringify(f.rules), f.id);
    await holdEmail(f.service, f.id, 'one', scopeFor(f.messages.get('one')));
    const preview = await interpretNotes(f.service, f.id, { text: 'I am looking for software engineering jobs.' });
    await saveNotes(f.service, f.id, { token: preview.token });
    assert.deepEqual((await categoryContext(f.service, f.id)).notes, ['I am looking for software engineering jobs.']);
    const note = (await learningTray(f.service, f.id)).memories[0];
    await assert.rejects(
      editMemory(f.service, f.id, { memoryId: note.id, version: note.version, action: 'archive' }),
      /context only/
    );
    await f.service.locked(f.id, guard =>
      runAgent(f.service, f.id, guard, undefined, 'manual', async (_config, _prompt, input) => {
        assert.deepEqual(input.userContext, ['I am looking for software engineering jobs.']);
        return {
          action: 'archive',
          confidence: 1,
          reason: 'Do not invent permission',
          preferenceCategory: 'product_announcements',
          categoryConfidence: 1
        };
      })
    );
    assert.equal(f.writes(), 0);
    assert.equal(f.store.get('SELECT count(*) AS n FROM agent_holds').n, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('written instructions reject unsupported actions and unsafe sensitive-notice ages', async t => {
  const f = fixture(t);
  const originalFetch = globalThis.fetch;
  let topic = { category: 'bank_transactions', action: 'read', minAgeDays: 0 };
  globalThis.fetch = async () =>
    Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: { content: JSON.stringify({ supported: true, topics: [topic], context: '' }) }
        }
      ]
    });
  try {
    await assert.rejects(interpretNotes(f.service, f.id, { text: 'Mark bank notices read.' }), /30 to 3650/);
    topic = { category: 'newsletters', action: 'delete', minAgeDays: 0 };
    await assert.rejects(interpretNotes(f.service, f.id, { text: 'Delete newsletters.' }), /clarification/);
    assert.equal(f.store.get('SELECT count(*) AS n FROM preference_memories').n, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('written answers are interpreted without saving, then explicitly confirmed and remain editable', async t => {
  const f = fixture(t);
  const created = await askPreference(f.service, f.id, f.messages.get('one'), f.rules.agent, args, { initial: true });
  const row = f.store.get('SELECT version FROM agent_questions WHERE id=?', created.id);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: { content: JSON.stringify({ supported: true, action: 'read', minAgeDays: 90 }) }
        }
      ]
    });
  try {
    const text = 'Mark these read after 90 days, but keep announcements from Apple.';
    const proposal = await interpretPreference(f.service, f.id, { questionId: created.id, version: row.version, text });
    assert.equal(proposal.action, 'read');
    assert.equal(proposal.minAgeDays, 90);
    assert.equal(proposal.instructions, text);
    assert.equal(f.store.get('SELECT count(*) AS n FROM preference_memories').n, 0);
    assert.equal(f.writes(), 0);
    await answerPreference(f.service, f.id, {
      questionId: created.id,
      version: row.version,
      option: 'custom',
      ...proposal
    });
    let tray = await learningTray(f.service, f.id);
    assert.equal(tray.memories[0].instructions, text);
    assert.equal(tray.memories[0].minAgeDays, 90);
    await editMemory(f.service, f.id, {
      memoryId: tray.memories[0].id,
      version: tray.memories[0].version,
      action: 'read',
      minAgeDays: 180,
      instructions: 'Keep Apple and Mozilla announcements.'
    });
    tray = await learningTray(f.service, f.id);
    assert.equal(tray.memories[0].minAgeDays, 180);
    assert.match(tray.memories[0].instructions, /Mozilla/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('typed answers cannot authorize unsupported actions or relax the minimum age for sensitive notices', async t => {
  const f = fixture(t);
  const created = await askPreference(f.service, f.id, f.messages.get('one'), f.rules.agent, {
    ...args,
    category: 'bank_transactions'
  });
  const row = f.store.get('SELECT version FROM agent_questions WHERE id=?', created.id);
  await assert.rejects(
    answerPreference(f.service, f.id, {
      questionId: created.id,
      version: row.version,
      option: 'custom',
      action: 'delete',
      instructions: 'Delete them',
      minAgeDays: 90
    }),
    /offered/
  );
  await assert.rejects(
    answerPreference(f.service, f.id, {
      questionId: created.id,
      version: row.version,
      option: 'custom',
      action: 'read',
      instructions: 'Read them immediately',
      minAgeDays: 0
    }),
    /30 to 3650/
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({ supported: false, clarification: 'Should these be marked read or archived?' })
          }
        }
      ]
    });
  try {
    const result = await interpretPreference(f.service, f.id, {
      questionId: created.id,
      version: row.version,
      text: 'These are usually noise.'
    });
    assert.equal(result.supported, false);
    assert.equal(f.store.get('SELECT count(*) AS n FROM preference_memories').n, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a broad age-based question discovered midway is queued once while matching emails remain untouched', async t => {
  const f = fixture(t);
  for (const message of f.messages.values()) {
    message.internalDate = String(Date.now() - 120 * 86400000);
    message.payload.headers.find(header => header.name === 'Subject').value = 'Bank transaction confirmation';
  }
  const infer = async () => ({
    requestPreference: {
      category: 'bank_transactions',
      question: 'How should I handle older bank notices?',
      reason: 'A recurring pattern of old confirmations needs your preference.',
      minAgeDays: 90
    }
  });
  await f.service.locked(f.id, guard => runAgent(f.service, f.id, guard, undefined, 'manual', infer));
  const tray = await learningTray(f.service, f.id);
  assert.equal(tray.questions.length, 1);
  assert.equal(tray.questions[0].minAgeDays, 90);
  assert.equal(f.writes(), 0);
  assert.equal(f.store.get('SELECT count(*) AS n FROM agent_holds').n, 2);
});

test('initial setup answers authorize the saved sample without releasing later held mail', async t => {
  const f = fixture(t);
  f.messages.get('one').internalDate = '1';
  f.messages.get('two').internalDate = '1';
  f.store.run(
    'INSERT INTO trial_samples(account_id,payload) VALUES(?,?)',
    f.id,
    f.crypto.seal({ ids: ['one', 'two'] })
  );
  const question = await askPreference(f.service, f.id, f.messages.get('one'), f.rules.agent, args, { initial: true });
  assert.equal(f.store.get('SELECT count(*) AS n FROM agent_holds').n, 0);
  await answerPreference(f.service, f.id, { questionId: question.id, version: 1, option: 'read' });
  const result = await f.service.locked(f.id, guard =>
    runAgent(f.service, f.id, guard, undefined, 'manual', async () => ({
      action: 'read',
      confidence: 0.99,
      reason: 'Approved product category',
      preferenceCategory: 'product_announcements',
      categoryConfidence: 0.99
    }))
  );
  assert.equal(result.changed, 2);
});

test('saving archive permission updates pending setup choices before answering', async t => {
  const f = fixture(t);
  const question = await askPreference(f.service, f.id, f.messages.get('one'), f.rules.agent, args, { initial: true });
  await f.service.saveRules(f.id, { ...f.rules, agent: { ...f.rules.agent, action: 'archive' } });
  const offered = (await learningTray(f.service, f.id)).questions.find(q => q.id === question.id);
  assert.equal(offered.version, 2);
  assert.ok(offered.options.some(o => o.id === 'archive'));
  assert.ok(!offered.options.some(o => o.id === 'read'));
});
test('brand-specific wording is normalized into one broad question across different senders', async t => {
  const f = fixture(t);
  const apple = mail('apple');
  apple.payload.headers.find(h => h.name === 'From').value = 'news@apple.com';
  const a = await askPreference(f.service, f.id, f.messages.get('one'), f.rules.agent, args);
  const b = await askPreference(f.service, f.id, apple, f.rules.agent, {
    ...args,
    question: 'Do you want Apple announcements?'
  });
  assert.equal(a.id, b.id);
  const tray = await learningTray(f.service, f.id);
  assert.equal(tray.questions.length, 1);
  assert.equal(tray.questions[0].question, 'Do you want product announcements in your inbox?');
  assert.equal(tray.questions[0].scope.kind, 'category');
  assert.equal(tray.questions[0].scope.sender, undefined);
  await answerPreference(f.service, f.id, { questionId: a.id, version: tray.questions[0].version, option: 'read' });
  const again = await askPreference(f.service, f.id, apple, f.rules.agent, args);
  assert.equal(again.status, 'already_learned');
  assert.equal((await learningTray(f.service, f.id)).questions.length, 0);
});
test('a category answer applies to another brand and an Apple exception takes precedence', async t => {
  const f = fixture(t);
  await askPreference(f.service, f.id, f.messages.get('one'), f.rules.agent, args);
  const q = (await learningTray(f.service, f.id)).questions[0];
  await answerPreference(f.service, f.id, { questionId: q.id, version: q.version, option: 'keep' });
  const memory = (await learningTray(f.service, f.id)).memories[0];
  const apple = mail('apple');
  apple.internalDate = String(memory.savedAt + 1000);
  apple.payload.headers.find(h => h.name === 'From').value = 'news@email.apple.com';
  const other = mail('other');
  other.internalDate = apple.internalDate;
  other.payload.headers.find(h => h.name === 'From').value = 'news@another-product.example';
  f.messages.clear();
  f.messages.set('apple', apple);
  f.messages.set('other', other);
  await f.service.saveRules(f.id, {
    ...f.rules,
    agent: {
      ...f.rules.agent,
      exceptionsRules: [
        { id: 'apple-exception', type: 'domain', value: 'apple.com', category: 'product_announcements', action: 'read' }
      ]
    }
  });
  const result = await f.service.locked(f.id, guard =>
    runAgent(f.service, f.id, guard, undefined, 'manual', async () => ({
      action: 'read',
      confidence: 0.99,
      preferenceCategory: 'product_announcements',
      categoryConfidence: 0.99,
      reason: 'Low-priority announcement'
    }))
  );
  assert.equal(result.changed, 1);
  assert.ok(!apple.labelIds.includes('UNREAD'));
  assert.ok(other.labelIds.includes('UNREAD'));
  assert.equal((await learningTray(f.service, f.id)).questions.length, 0);
});
test('category scope and exception matching reject unknown categories and misleading domains', () => {
  assert.equal(categoryScope('a-new-category-per-product'), null);
  const rules = validateExceptions([
    { id: 'apple', type: 'domain', value: 'apple.com', category: 'product_announcements', action: 'keep' }
  ]);
  assert.equal(matchingException(rules, 'news@email.apple.com', 'product_announcements').action, 'keep');
  assert.equal(matchingException(rules, 'news@evilapple.com', 'product_announcements'), null);
  assert.equal(matchingException(rules, 'news@apple.com.evil.example', 'product_announcements'), null);
  assert.equal(matchingException(rules, 'news@apple.com', 'sales_discounts'), null);
  assert.throws(() => validateExceptions([{ ...rules[0], value: '*@apple.com' }]), /complete sender/);
});

test('questions persist and deduplicate; answered preferences apply to held mail in the next cleanup', async t => {
  const f = fixture(t);
  const first = await askPreference(f.service, f.id, f.messages.get('one'), f.rules.agent, args);
  const second = await askPreference(f.service, f.id, f.messages.get('two'), f.rules.agent, args);
  assert.equal(first.id, second.id);
  assert.equal(first.waitsForUser, false);
  let tray = await learningTray(f.service, f.id);
  assert.equal(tray.questions.length, 1);
  const q = tray.questions[0];
  assert.ok(!f.store.get('SELECT payload FROM agent_questions').payload.includes(args.question));
  assert.equal(f.store.get('SELECT count(*) AS n FROM agent_holds').n, 2);
  await assert.rejects(
    answerPreference(f.service, 'another@example.invalid', { questionId: q.id, version: q.version, option: 'read' }),
    /changed or was already/
  );
  await answerPreference(f.service, f.id, { questionId: q.id, version: q.version, option: 'read' });
  tray = await learningTray(f.service, f.id);
  assert.equal(tray.questions.length, 0);
  assert.equal(tray.memories[0].action, 'read');
  assert.equal(tray.memories[0].applies, 'all_eligible_messages');
  assert.equal(f.writes(), 0);
  const result = await f.service.locked(f.id, guard =>
    runAgent(f.service, f.id, guard, undefined, 'manual', async () => ({
      action: 'read',
      confidence: 1,
      reason: 'Saved product preference',
      preferenceCategory: 'product_announcements',
      categoryConfidence: 1
    }))
  );
  assert.equal(result.changed, 2);
  assert.equal(f.messages.get('one').labelIds.includes('UNREAD'), false);
  const memory = tray.memories[0];
  await editMemory(f.service, f.id, { memoryId: memory.id, version: memory.version, action: 'keep' });
  await assert.rejects(
    editMemory(f.service, f.id, { memoryId: memory.id, version: memory.version, action: 'read' }),
    /changed/
  );
  const edited = (await learningTray(f.service, f.id)).memories[0];
  await editMemory(f.service, f.id, { memoryId: edited.id, version: edited.version, remove: true });
  assert.equal((await learningTray(f.service, f.id)).memories.length, 0);
  assert.equal(f.store.get('SELECT count(*) AS n FROM agent_holds').n, 2);
});
test('snoozing a question never creates permission; it returns after the deadline', async t => {
  const f = fixture(t);
  await askPreference(f.service, f.id, f.messages.get('one'), f.rules.agent, args);
  const q = (await learningTray(f.service, f.id)).questions[0];
  await answerPreference(f.service, f.id, { questionId: q.id, version: q.version, option: 'later' });
  assert.equal((await learningTray(f.service, f.id)).questions.length, 0);
  assert.equal((await learningTray(f.service, f.id)).memories.length, 0);
  f.store.run('UPDATE agent_questions SET snoozed_until=?', Date.now() - 1);
  assert.equal((await learningTray(f.service, f.id)).questions.length, 1);
  assert.equal(f.writes(), 0);
});
test('saved preferences apply to old unseen mail and newer mail regardless of save time', async t => {
  const f = fixture(t);
  await askPreference(f.service, f.id, f.messages.get('one'), f.rules.agent, args);
  const q = (await learningTray(f.service, f.id)).questions[0];
  await answerPreference(f.service, f.id, { questionId: q.id, version: q.version, option: 'read' });
  const memory = (await learningTray(f.service, f.id)).memories[0];
  f.messages.get('two').internalDate = String(memory.savedAt - 1000);
  const future = mail('new');
  future.internalDate = String(memory.savedAt + 1000);
  f.messages.set('new', future);
  let calls = 0;
  const result = await f.service.locked(f.id, guard =>
    runAgent(f.service, f.id, guard, undefined, 'manual', async (config, prompt, data) => {
      calls++;
      assert.equal(data.categoryPreferences[0].action, 'read');
      return {
        action: 'read',
        confidence: 0.99,
        reason: 'User preference',
        preferenceCategory: 'product_announcements',
        categoryConfidence: 0.99
      };
    })
  );
  assert.equal(calls, 3);
  assert.equal(result.changed, 3);
  assert.equal(f.messages.get('two').labelIds.includes('UNREAD'), false);
  assert.ok(!f.messages.get('new').labelIds.includes('UNREAD'));
});

test('cleanup applies saved preferences to old resolved holds without an extra authorization flag', async t => {
  const f = fixture(t);
  for (const message of f.messages.values()) message.internalDate = String(Date.now() - 120 * 86400000);
  await askPreference(f.service, f.id, f.messages.get('one'), f.rules.agent, args);
  await askPreference(f.service, f.id, f.messages.get('two'), f.rules.agent, args);
  const q = (await learningTray(f.service, f.id)).questions[0];
  await answerPreference(f.service, f.id, { questionId: q.id, version: q.version, option: 'read' });
  assert.equal(f.writes(), 0);
  const result = await f.service.locked(f.id, guard =>
    runAgent(
      f.service,
      f.id,
      guard,
      undefined,
      'manual',
      async () => ({
        action: 'read',
        confidence: 1,
        reason: 'Saved topic preference',
        preferenceCategory: 'product_announcements',
        categoryConfidence: 1
      }),
      undefined
    )
  );
  assert.equal(result.changed, 2);
  assert.equal(f.writes(), 2);
  assert.ok(f.messages.get('one').labelIds.includes('INBOX'));
  const log = f.crypto.open(f.store.get("SELECT payload FROM plans WHERE status='agent_log'").payload);
  assert.equal(log.applies, 'all_eligible_messages');
});

test('cleanup does not release unanswered or snoozed question holds', async t => {
  const f = fixture(t);
  await askPreference(f.service, f.id, f.messages.get('one'), f.rules.agent, args);
  await askPreference(f.service, f.id, f.messages.get('two'), f.rules.agent, args);
  const q = (await learningTray(f.service, f.id)).questions[0];
  await answerPreference(f.service, f.id, { questionId: q.id, version: q.version, option: 'later' });
  const result = await f.service.locked(f.id, guard =>
    runAgent(
      f.service,
      f.id,
      guard,
      undefined,
      'manual',
      async () => {
        throw new Error('Pending question holds must not reach the model');
      },
      undefined
    )
  );
  assert.equal(result.inspected, 0);
  assert.equal(f.writes(), 0);
});

test('daily cleanup applies a newly saved preference to old resolved holds without an age-of-preference cutoff', async t => {
  const f = fixture(t);
  f.service.config.hackathonMode = true;
  f.store.run('UPDATE accounts SET rules=? WHERE id=?', JSON.stringify({ ...f.rules, daily: true }), f.id);
  for (const message of f.messages.values()) message.internalDate = String(Date.now() - 200 * 86400000);
  await askPreference(f.service, f.id, f.messages.get('one'), f.rules.agent, args);
  await askPreference(f.service, f.id, f.messages.get('two'), f.rules.agent, args);
  const question = (await learningTray(f.service, f.id)).questions[0];
  await answerPreference(f.service, f.id, { questionId: question.id, version: question.version, option: 'read' });
  const result = await f.service.locked(f.id, guard =>
    runAgent(f.service, f.id, guard, undefined, 'daily', async () => ({
      action: 'read',
      confidence: 1,
      reason: 'Saved product preference',
      preferenceCategory: 'product_announcements',
      categoryConfidence: 1
    }))
  );
  assert.equal(result.changed, 2);
  assert.equal(f.writes(), 2);
});

test('daily cleanup measures a saved 30-day security rule from today; recent and suspicious notices stay protected', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-24T12:00:00Z') });
  const f = fixture(t);
  f.service.config.hackathonMode = true;
  f.store.run('UPDATE accounts SET rules=? WHERE id=?', JSON.stringify({ ...f.rules, daily: true }), f.id);
  f.messages.get('one').internalDate = String(Date.now() - 60 * 86400000);
  f.messages.get('two').internalDate = String(Date.now() - 10 * 86400000);
  const suspicious = structuredClone(f.messages.get('one'));
  suspicious.id = 'suspicious';
  f.messages.set('suspicious', suspicious);
  for (const [id, message] of f.messages)
    message.payload.headers.find(h => h.name === 'Subject').value =
      id === 'suspicious' ? 'Suspicious security alert' : 'Login confirmation';
  f.store.run(
    'INSERT INTO preference_memories(id,account_id,scope_hash,payload,updated) VALUES(?,?,?,?,?)',
    'security',
    f.id,
    'category:security_notices',
    f.crypto.seal({
      scope: categoryScope('security_notices'),
      action: 'read',
      minAgeDays: 30,
      effectiveFrom: Date.now() + 86400000,
      applies: 'future_messages_only'
    }),
    Date.now()
  );
  const result = await f.service.locked(f.id, guard =>
    runAgent(f.service, f.id, guard, undefined, 'daily', async () => ({
      action: 'read',
      confidence: 1,
      reason: 'Routine historical login confirmation',
      preferenceCategory: 'security_notices',
      categoryConfidence: 1,
      routineNotice: true
    }))
  );
  assert.equal(result.changed, 1);
  assert.equal(f.messages.get('one').labelIds.includes('UNREAD'), false);
  assert.equal(f.messages.get('two').labelIds.includes('UNREAD'), true);
  assert.equal(suspicious.labelIds.includes('UNREAD'), true);
});

test('cleanup can reassess a hold that had no question, while uncertain writes remain excluded', async t => {
  const f = fixture(t);
  f.service.config.hackathonMode = true;
  await holdEmail(f.service, f.id, 'one', scopeFor(f.messages.get('one')));
  await holdEmail(f.service, f.id, 'two', scopeFor(f.messages.get('two')));
  f.store.run(
    "INSERT INTO changes(id,run_id,account_id,message_id,payload,status,created) VALUES(?,?,?,?,?,'uncertain',?)",
    'uncertain-change',
    'old-run',
    f.id,
    'two',
    f.crypto.seal({}),
    Date.now()
  );
  const result = await f.service.locked(f.id, guard =>
    runAgent(
      f.service,
      f.id,
      guard,
      undefined,
      'manual',
      async () => ({ action: 'read', confidence: 1, reason: 'Explicit review of older mail' }),
      undefined
    )
  );
  assert.equal(result.inspected, 1);
  assert.equal(result.changed, 1);
  assert.equal(f.messages.get('two').labelIds.includes('UNREAD'), true);
});
test('agent tool calls queue questions without waiting; same-pattern messages and future held runs stay unchanged', async t => {
  const f = fixture(t);
  let modelCalls = 0;
  const result = await f.service.locked(f.id, guard =>
    runAgent(f.service, f.id, guard, undefined, 'manual', async () => {
      modelCalls++;
      return { requestPreference: args };
    })
  );
  assert.equal(result.changed, 0);
  assert.equal(modelCalls, 2);
  assert.equal(f.writes(), 0);
  assert.equal((await learningTray(f.service, f.id)).questions.length, 1);
  assert.equal(f.store.get('SELECT count(*) AS n FROM agent_holds').n, 2);
});
test('ask_preference transport exposes only the declared tool; unknown tool calls are rejected', async () => {
  const { ASK_PREFERENCE_TOOL } = await import('../server/learning.js');
  const config = { aiProvider: 'nebius', aiKey: 'fixture-only', aiModel: 'fixture' };
  const result = await chatJSON(
    config,
    [],
    async (url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.tools[0].function.name, 'ask_preference');
      assert.equal(body.response_format, undefined);
      return Response.json({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: { tool_calls: [{ function: { name: 'ask_preference', arguments: JSON.stringify(args) } }] }
          }
        ]
      });
    },
    [ASK_PREFERENCE_TOOL]
  );
  assert.deepEqual(result.requestPreference, args);
  await assert.rejects(
    chatJSON(
      config,
      [],
      async () =>
        Response.json({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: { tool_calls: [{ function: { name: 'delete_email', arguments: '{}' } }] }
            }
          ]
        }),
      [ASK_PREFERENCE_TOOL]
    ),
    /invalid JSON/
  );
});
test('automatic unsubscribe rejects OTPs, newsletters, mixed-purpose history, missing permission and unknown intent', () => {
  const message = mail('one');
  const history = [message, mail('two')];
  const raw = {
    action: 'unsubscribe',
    emailType: 'marketing',
    subscriptionIntent: 'unwanted',
    confidence: 0.999,
    historyTypes: history.map(m => ({ id: m.id, type: 'marketing' }))
  };
  const p = { autoUnsubscribe: true };
  assert.equal(unsubscribeEligible(raw, p, message, history), true);
  assert.equal(unsubscribeEligible(raw, p, message, history, { action: 'read' }), false);
  assert.equal(unsubscribeEligible(raw, { autoUnsubscribe: false }, message, history), false);
  assert.equal(unsubscribeEligible({ ...raw, subscriptionIntent: 'unknown' }, p, message, history), false);
  assert.equal(unsubscribeEligible(raw, p, message, [message, mail('two', 'Your OTP code')]), false);
  assert.equal(unsubscribeEligible(raw, p, message, [message, mail('two', 'Weekly newsletter')]), false);
  assert.equal(
    unsubscribeEligible(
      {
        ...raw,
        historyTypes: [
          { id: 'one', type: 'marketing' },
          { id: 'two', type: 'transactional' }
        ]
      },
      p,
      message,
      history
    ),
    false
  );
  assert.equal(unsubscribeEligible(raw, p, message, [message]), false);
});
test('supported automatic request is recorded once; uncertain network outcomes never replay', async t => {
  const f = fixture(t);
  let requests = 0;
  const message = f.messages.get('one');
  const result = await automaticUnsubscribe(
    f.service,
    f.id,
    message,
    async () => {},
    f.rules,
    async () => {
      requests++;
    }
  );
  assert.equal(result.requested, true);
  await automaticUnsubscribe(
    f.service,
    f.id,
    message,
    async () => {},
    f.rules,
    async () => {
      requests++;
    }
  );
  assert.equal(requests, 1);
  f.store.run('DELETE FROM subscription_actions');
  await assert.rejects(
    automaticUnsubscribe(
      f.service,
      f.id,
      message,
      async () => {},
      f.rules,
      async () => {
        requests++;
        throw new Error('timeout');
      }
    ),
    /timeout/
  );
  const retried = await automaticUnsubscribe(
    f.service,
    f.id,
    message,
    async () => {},
    f.rules,
    async () => {
      requests++;
    }
  );
  assert.equal(retried.requested, false);
  assert.equal(requests, 2);
  assert.equal(f.store.get('SELECT status FROM subscription_actions').status, 'uncertain');
});

test('stored question explanations stay natural; answers apply to old and new eligible mail', async t => {
  const f = fixture(t);
  f.store.run(
    'INSERT INTO trial_samples(account_id,payload) VALUES(?,?)',
    f.id,
    f.crypto.seal({ ids: ['one', 'two'] })
  );
  const created = await askPreference(
    f.service,
    f.id,
    f.messages.get('one'),
    f.rules.agent,
    { ...args, reason: 'No category preference exists for product_announcements.' },
    { initial: true }
  );
  const stored = f.store.get('SELECT payload FROM agent_questions WHERE id=?', created.id);
  const legacy = f.crypto.open(stored.payload);
  legacy.options.find(option => option.id === 'read').label = 'Mark low-priority emails in this first cleanup as read';
  legacy.reason = 'No category preference exists for product_announcements.';
  f.store.run('UPDATE agent_questions SET payload=? WHERE id=?', f.crypto.seal(legacy), created.id);
  await f.service.locked(f.id, guard =>
    runAgent(f.service, f.id, guard, undefined, 'manual', async () => ({
      action: 'keep',
      confidence: 1,
      reason: 'Keep for now.'
    }))
  );
  const q = (await learningTray(f.service, f.id)).questions[0];
  assert.equal(q.initial, false);
  assert.ok(q.options.every(option => !option.label.includes('first cleanup')));
  assert.match(q.reason, /Your inbox includes/);
  assert.doesNotMatch(q.reason, /product_announcements|category preference/);
  const result = await answerPreference(f.service, f.id, { questionId: q.id, version: q.version, option: 'read' });
  assert.equal(result.applies, 'all_eligible_messages');
  assert.equal((await learningTray(f.service, f.id)).memories[0].initialSampleIds, undefined);
});

test('automatic unsubscribe refuses mail that moved out of Primary before the request', async t => {
  const f = fixture(t);
  const originalClient = f.service.client.bind(f.service);
  f.service.client = account => {
    const gmail = originalClient(account);
    return async (path, ...args) => {
      const message = await gmail(path, ...args);
      if (path === 'messages/one?format=metadata') message.labelIds.push('CATEGORY_PROMOTIONS');
      return message;
    };
  };
  let posts = 0;
  await assert.rejects(
    automaticUnsubscribe(
      f.service,
      f.id,
      f.messages.get('one'),
      async () => {},
      f.rules,
      async () => {
        posts++;
      }
    ),
    /Subscription changed/
  );
  assert.equal(posts, 0);
  assert.equal(f.store.get('SELECT count(*) AS total FROM subscription_actions').total, 0);
});

test('subscription profiles identify the sender and sample without exposing encrypted storage; confirmed requests are not replayed', async t => {
  const f = fixture(t);
  const message = f.messages.get('one');
  message.payload.headers.find(h => h.name === 'From').value = 'Product Studio <offers@product.example>';
  await f.service.recordSubscriptions(f.id, [message]);
  const row = f.store.get('SELECT * FROM subscriptions WHERE account_id=?', f.id);
  assert.equal(row.status, 'review');
  assert.ok(!row.payload.includes('Product Studio'));
  const profile = f.crypto.open(row.payload);
  assert.equal(profile.displayName, 'Product Studio');
  assert.equal(profile.subject, 'Product updates');
  let requests = 0;
  assert.equal(
    (
      await f.service.unsubscribe(f.id, 'offers@product.example', async () => {
        requests++;
      })
    ).status,
    'requested'
  );
  await assert.rejects(
    f.service.unsubscribe(f.id, 'offers@product.example', async () => {
      requests++;
    }),
    /already submitted/
  );
  assert.equal(requests, 1);
  assert.equal(f.store.get('SELECT status FROM subscriptions').status, 'requested');
});
