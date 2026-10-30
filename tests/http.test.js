import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { createApp } from '../server/index.js';
import { DEFAULT_RULES } from '../server/rules.js';
import { primaryUnreadCount } from '../server/gmail.js';
import { failure } from '../server/failures.js';
import { DEFAULT_PREFERENCES } from '../server/agent.js';
import { askPreference, learningTray } from '../server/learning.js';

async function setup(t, configured = false, config = {}, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'inboxclean-http-'));
  const app = await createApp({
    dataDir: directory,
    config: {
      databaseUrl: '',
      appUrl: 'http://localhost:3000',
      encryptionKey: configured ? randomBytes(32).toString('base64') : '',
      clientId: configured ? 'fixture-client' : '',
      clientSecret: configured ? 'fixture-secret' : '',
      ...config
    },
    ...options
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const call = (path, options = {}) =>
    new Promise((resolve, reject) => {
      const req = request(
        `${base}${path}`,
        { method: options.method || 'GET', headers: { Host: 'localhost:3000', ...options.headers } },
        res => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => {
            const headers = new Headers();
            for (const [key, value] of Object.entries(res.headers))
              if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
            resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers }));
          });
        }
      );
      req.on('error', reject);
      req.end(options.body);
    });
  return { app, call };
}
test('unconfigured app serves real setup state, secure headers, and no invented mailbox data', async t => {
  const { call } = await setup(t);
  const response = await call('/');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /A little less inbox/);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  const status = await call('/api/status');
  const data = await status.json();
  assert.equal(data.connected, false);
  assert.equal(data.configured, false);
  assert.deepEqual(data.runs, []);
  assert.equal(data.plan, undefined);
  assert.match(status.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  assert.equal((await call('/api/agent/run', { method: 'POST' })).status, 401);
  assert.equal((await call('/.env')).status, 404);
});

test('privacy and terms are public documents without session or database access', async t => {
  const { app, call } = await setup(t);
  app.store.get = () => {
    throw new Error('Public legal pages must not access account sessions');
  };
  for (const [path, heading] of [
    ['/privacy', 'Privacy policy.'],
    ['/terms', 'Terms of service.']
  ]) {
    const response = await call(path, { headers: { Cookie: 'inboxclean_session=unused-fixture' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('set-cookie'), null);
    const html = await response.text();
    assert.ok(html.includes(heading));
    assert.match(html, /rishidv2005@gmail\.com/);
    assert.match(html, /href="\/privacy"|href="\/terms"/);
    const head = await call(path, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  }
  const privacy = await (await call('/privacy')).text();
  assert.match(privacy, /Limited Use/);
  assert.match(privacy, /Nebius Token Factory/);
  assert.match(privacy, /does not promise zero-retention/);
  assert.equal((await call('/legal.css')).status, 200);
  assert.match(await (await call('/robots.txt')).text(), /Disallow: \/api\//);
  assert.match(await (await call('/sitemap.xml')).text(), /https:\/\/cleanmyinbox\.space\/privacy/);
});

test('custom-domain aliases redirect browser paths without trusting arbitrary hosts or replaying writes', async t => {
  const { call } = await setup(t, false, {
    appUrl: 'https://cleanmyinbox.example',
    redirectHosts: ['legacy.run.app', 'www.cleanmyinbox.example'],
    schedulerAudience: 'https://legacy.run.app'
  });
  const old = { headers: { Host: 'legacy.run.app' } };
  const response = await call('/app?auth=connected', old);
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), 'https://cleanmyinbox.example/app?auth=connected');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal((await call('/', { headers: { Host: 'www.cleanmyinbox.example' } })).status, 308);
  assert.equal((await call('/', { headers: { Host: 'attacker.example' } })).status, 403);
  assert.equal((await call('/api/rules', { method: 'POST', ...old })).status, 403);
  assert.equal((await call('/api/health', old)).status, 200);
  assert.equal((await call('/', { headers: { Host: 'cleanmyinbox.example' } })).status, 200);
  // Absolute-form request targets must never control the redirect origin.
  const target = await call('//attacker.example/app?x=1', old);
  assert.equal(target.headers.get('location'), 'https://cleanmyinbox.example/app?x=1');
});

test('custom-domain migration preserves signed scheduler access through its original host and audience', async t => {
  let ticks = 0;
  const { app, call } = await setup(
    t,
    true,
    {
      appUrl: 'https://cleanmyinbox.example',
      scheduler: false,
      schedulerAudience: 'https://legacy.run.app',
      schedulerAccount: 'cron@example.invalid',
      redirectHosts: ['legacy.run.app']
    },
    {
      verifySchedulerIdentity: async (token, audience) => {
        assert.equal(audience, 'https://legacy.run.app');
        return { email_verified: true, email: token === 'valid' ? 'cron@example.invalid' : 'wrong@example.invalid' };
      }
    }
  );
  app.service.daily = async () => {
    ticks++;
  };
  const send = token =>
    call('/internal/scheduler/tick', {
      method: 'POST',
      headers: { Host: 'legacy.run.app', Authorization: `Bearer ${token}` }
    });
  assert.equal((await send('wrong')).status, 401);
  assert.equal((await send('valid')).status, 200);
  assert.equal(ticks, 1);
});

test('answer HTTP request saves then cleans its held subset before responding without an inbox sweep', async t => {
  const messages = new Map(
    ['held', 'unrelated'].map(id => [
      id,
      {
        id,
        historyId: '1',
        internalDate: String(Date.now() - 90 * 86400000),
        labelIds: ['INBOX', 'UNREAD'],
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'updates@example.invalid' },
            { name: 'Subject', value: 'Synthetic product announcement' }
          ],
          body: { data: Buffer.from('A synthetic product release.').toString('base64url') }
        }
      }
    ])
  );
  const writes = [];
  const { app, call } = await setup(
    t,
    true,
    { aiKey: 'synthetic-only', aiProvider: 'nebius', hackathonMode: true, scheduler: false },
    {
      clientFactory: () => async (path, body) => {
        if (path.startsWith('messages?')) throw new Error('A full mailbox candidate search must not run');
        if (path === 'labels') return { labels: [{ id: 'CLEANED', name: 'Cleaned by agent' }] };
        const id = path.split('/')[1].split('?')[0];
        const message = messages.get(id);
        if (body) {
          writes.push(id);
          message.labelIds = message.labelIds.filter(l => !body.removeLabelIds.includes(l));
        }
        return structuredClone(message);
      }
    }
  );
  const first = await call('/api/status');
  const cookie = first.headers.get('set-cookie').split(';')[0];
  const state = await first.json();
  const id = 'owner@example.invalid';
  const rules = {
    ...DEFAULT_RULES,
    agent: {
      ...DEFAULT_PREFERENCES,
      enabled: true,
      consent: true,
      consentProvider: 'nebius',
      keepPeople: false,
      autoUnsubscribe: false,
      topicActions: true
    }
  };
  app.store.run(
    'INSERT INTO accounts(id,email,tokens,rules,created) VALUES(?,?,?,?,?)',
    id,
    id,
    app.service.crypto.seal({}),
    JSON.stringify(rules),
    Date.now()
  );
  app.store.run('UPDATE sessions SET account_id=?', id);
  await askPreference(app.service, id, messages.get('held'), rules.agent, {
    category: 'product_announcements',
    question: 'How should I handle product announcements?',
    reason: 'Synthetic recurring updates.'
  });
  const q = (await learningTray(app.service, id)).questions[0];
  const previousFetch = globalThis.fetch;
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
                  decision: {
                    action: 'read',
                    confidence: 1,
                    reason: 'Saved preference',
                    preferenceCategory: 'product_announcements',
                    categoryConfidence: 1
                  }
                }
              ]
            })
          }
        }
      ]
    });
  try {
    const response = await call('/api/agent/questions/answer', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'http://localhost:3000',
        'X-CSRF-Token': state.csrf,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ questionId: q.id, version: q.version, option: 'read' })
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, 'saved');
    assert.equal(result.cleanup.status, 'completed');
    assert.equal(result.cleanup.changed, 1);
    assert.deepEqual(writes, ['held']);
    assert.equal(messages.get('unrelated').labelIds.includes('UNREAD'), true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('mailbox count includes only unread Primary inbox messages across all result pages', async t => {
  const reads = [];
  const { app, call } = await setup(
    t,
    true,
    {},
    {
      clientFactory: account => async path => {
        assert.equal(account.id, 'owner@example.invalid');
        reads.push(path);
        assert.ok(
          path.startsWith('messages?'),
          'Count must not use the all-mail unread label or download message bodies'
        );
        const params = new URLSearchParams(path.split('?')[1]);
        assert.equal(params.get('q'), 'in:inbox category:primary is:unread');
        assert.equal(params.get('maxResults'), '500');
        assert.equal(params.get('fields'), 'messages(id),nextPageToken');
        return params.has('pageToken')
          ? { messages: [{ id: 'two' }, { id: 'three' }], resultSizeEstimate: 10000 }
          : { messages: [{ id: 'one' }, { id: 'two' }], nextPageToken: 'next', resultSizeEstimate: 20000 };
      }
    }
  );
  const initial = await call('/api/status');
  const cookie = initial.headers.get('set-cookie').split(';')[0];
  const id = 'owner@example.invalid';
  app.store.run(
    'INSERT INTO accounts(id,email,tokens,rules,created) VALUES(?,?,?,?,?)',
    id,
    id,
    app.service.crypto.seal({}),
    JSON.stringify(DEFAULT_RULES),
    Date.now()
  );
  app.store.run('UPDATE sessions SET account_id=?', id);
  const response = await call('/api/mailbox', { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.unread, 3);
  assert.equal(result.unreadCapped, false);
  assert.equal(result.scope, 'primary');
  assert.equal(result.messages, undefined);
  assert.equal(reads.length, 2);
});

test('mailbox count stops at its limit instead of paging through a large backlog', async () => {
  let reads = 0;
  const gmail = async path => {
    reads++;
    const page = Number(new URLSearchParams(path.split('?')[1]).get('pageToken') || 0);
    return {
      messages: Array.from({ length: 500 }, (_, i) => ({ id: `${page}-${i}` })),
      nextPageToken: String(page + 1)
    };
  };
  assert.deepEqual(await primaryUnreadCount(gmail), { count: 1000, capped: true });
  assert.equal(reads, 2);
});
test('OAuth uses state and PKCE and callback rejects missing or foreign state without external calls', async t => {
  const { call } = await setup(t, true);
  const status = await call('/api/status');
  const cookie = status.headers.get('set-cookie').split(';')[0];
  const start = await call('/auth/google', { headers: { Cookie: cookie } });
  assert.equal(start.status, 302);
  const location = new URL(start.headers.get('location'));
  assert.equal(location.hostname, 'accounts.google.com');
  assert.equal(location.searchParams.get('access_type'), 'offline');
  assert.equal(location.searchParams.get('prompt'), 'consent select_account');
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(location.searchParams.get('state'));
  const callback = await call('/auth/google/callback?state=forged&code=fake', { headers: { Cookie: cookie } });
  assert.equal(callback.headers.get('location'), '/?auth=state');
});
test('session cookies resolve, write routes reject cross-origin or missing CSRF, and disconnect is not a GET action', async t => {
  const { call, app } = await setup(t, true);
  const status = await call('/api/status');
  const cookie = status.headers.get('set-cookie').split(';')[0];
  const data = await status.json();
  const id = 'owner@example.com';
  app.store.run(
    'INSERT INTO accounts(id,email,tokens,rules,created) VALUES(?,?,?,?,?)',
    id,
    id,
    app.service.crypto.seal({ refresh_token: 'fixture' }),
    JSON.stringify(DEFAULT_RULES),
    Date.now()
  );
  app.store.run('UPDATE sessions SET account_id=?', id);
  assert.equal((await (await call('/api/status', { headers: { Cookie: cookie } })).json()).connected, true);
  const post = headers =>
    call('/api/rules', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(DEFAULT_RULES)
    });
  assert.equal((await post({ Origin: 'https://attacker.example', 'X-CSRF-Token': data.csrf })).status, 403);
  assert.equal((await post({ Origin: 'http://localhost:3000' })).status, 403);
  assert.equal((await post({ Origin: 'http://localhost:3000', 'X-CSRF-Token': data.csrf })).status, 200);
  assert.equal((await call('/api/disconnect', { headers: { Cookie: cookie } })).status, 405);
  for (const path of ['/api/agent/preferences/interpret', '/api/agent/preferences/save', '/api/routine/pause']) {
    assert.equal(
      (
        await call(path, {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: '{}'
        })
      ).status,
      403
    );
    assert.equal((await call(path, { headers: { Cookie: cookie } })).status, 405);
  }
});

test('logout clears only the browser session and preserves the connected account and daily routine', async t => {
  const { call, app } = await setup(t, true);
  const status = await call('/api/status');
  const cookie = status.headers.get('set-cookie').split(';')[0];
  const { csrf } = await status.json();
  const id = 'logout@example.invalid';
  app.store.run(
    'INSERT INTO accounts(id,email,tokens,rules,created) VALUES(?,?,?,?,?)',
    id,
    id,
    app.service.crypto.seal({ refresh_token: 'fixture' }),
    JSON.stringify({ ...DEFAULT_RULES, daily: true }),
    Date.now()
  );
  app.store.run('UPDATE sessions SET account_id=?', id);
  assert.equal((await call('/api/logout', { headers: { Cookie: cookie } })).status, 405);
  const post = headers =>
    call('/api/logout', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', ...headers },
      body: '{}'
    });
  assert.equal((await post({ Origin: 'http://localhost:3000' })).status, 403);
  const response = await post({ Origin: 'http://localhost:3000', 'X-CSRF-Token': csrf });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/i);
  assert.equal((await (await call('/api/status', { headers: { Cookie: cookie } })).json()).connected, false);
  const account = app.store.get('SELECT rules,tokens FROM accounts WHERE id=?', id);
  assert.equal(JSON.parse(account.rules).daily, true);
  assert.equal(app.service.crypto.open(account.tokens).refresh_token, 'fixture');
});

test('disconnect removes account data when Google already revoked the token, but keeps it when revocation fails', async t => {
  let reply = { status: 503, body: {} };
  const revocations = [];
  const fetch = async (url, options) => {
    revocations.push([url, options.body.get('token')]);
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  };
  const { call, app } = await setup(t, true, {}, { fetch });
  const status = await call('/api/status');
  const cookie = status.headers.get('set-cookie').split(';')[0];
  const data = await status.json();
  const id = 'owner@example.com';
  app.store.run(
    'INSERT INTO accounts(id,email,tokens,rules,created) VALUES(?,?,?,?,?)',
    id,
    id,
    app.service.crypto.seal({ refresh_token: 'fixture' }),
    JSON.stringify({ ...DEFAULT_RULES, daily: true }),
    Date.now()
  );
  app.store.run(
    "INSERT INTO runs(id,account_id,kind,status,total,created) VALUES('run',?,'cleanup','completed',1,?)",
    id,
    Date.now()
  );
  app.store.run('UPDATE sessions SET account_id=?', id);
  const disconnect = () =>
    call('/api/disconnect', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'http://localhost:3000',
        'X-CSRF-Token': data.csrf,
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
  const failed = await disconnect();
  assert.equal(failed.status, 400);
  assert.match((await failed.json()).error, /revocation failed/);
  assert.equal(JSON.parse(app.store.get('SELECT rules FROM accounts WHERE id=?', id).rules).daily, false);
  assert.equal(app.store.get('SELECT count(*) AS n FROM runs').n, 1);
  reply = { status: 400, body: { error: 'invalid_token', error_description: 'Token expired or revoked' } };
  const removed = await disconnect();
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { success: true });
  assert.equal(app.store.get('SELECT count(*) AS n FROM accounts').n, 0);
  assert.equal(app.store.get('SELECT count(*) AS n FROM runs').n, 0);
  assert.deepEqual(revocations, [
    ['https://oauth2.googleapis.com/revoke', 'fixture'],
    ['https://oauth2.googleapis.com/revoke', 'fixture']
  ]);
});

test('production routing serves landing and dashboard together and protects free additional-cleanup endpoints', async t => {
  const { call, app } = await setup(t, true, { serveLanding: true });
  assert.match(await (await call('/')).text(), /\/assets\/index-/);
  assert.match(await (await call('/app')).text(), /A little less inbox/);
  const status = await call('/api/status');
  const cookie = status.headers.get('set-cookie').split(';')[0];
  const first = await status.json();
  const callback = await call('/auth/google/callback?state=forged&code=fake', { headers: { Cookie: cookie } });
  assert.equal(callback.headers.get('location'), '/app?auth=state');
  const id = 'free@example.invalid';
  app.store.run(
    'INSERT INTO accounts(id,email,tokens,rules,created) VALUES(?,?,?,?,?)',
    id,
    id,
    app.service.crypto.seal({}),
    JSON.stringify(DEFAULT_RULES),
    Date.now()
  );
  app.store.run('UPDATE sessions SET account_id=?', id);
  const state = await (await call('/api/status', { headers: { Cookie: cookie } })).json();
  assert.equal(state.access.remaining, 100);
  assert.equal(state.access.dailyAllowed, false);
  for (const path of ['/api/discover', '/api/unsubscribe']) {
    const response = await call(path, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'http://localhost:3000',
        'X-CSRF-Token': first.csrf,
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /paid plan/);
  }
  assert.equal(app.store.get('SELECT count(*) AS n FROM runs').n, 0);
});

test('daily HTTP endpoint verifies scheduler identity without user cookies or CSRF bypass', async t => {
  const { app, call } = await setup(t, true, { scheduler: false, schedulerAccount: 'cron@example.invalid' });
  let ticks = 0;
  app.service.daily = async () => {
    ticks++;
  };
  assert.equal((await call('/internal/scheduler/tick', { method: 'POST' })).status, 401);
  assert.equal((await call('/internal/scheduler/tick')).status, 405);
  assert.equal(ticks, 0);
});

test('verified Cloud Scheduler tick runs maintenance once and rejects a different identity', async t => {
  const identity = 'cron@example.invalid';
  const { app, call } = await setup(
    t,
    true,
    { scheduler: false, schedulerAccount: identity },
    {
      verifySchedulerIdentity: async token => ({
        email_verified: true,
        email: token === 'authorized-fixture' ? identity : 'other@example.invalid'
      })
    }
  );
  let ticks = 0;
  app.service.daily = async () => {
    ticks++;
  };
  assert.equal(
    (await call('/internal/scheduler/tick', { method: 'POST', headers: { Authorization: 'Bearer wrong-fixture' } }))
      .status,
    401
  );
  const result = await call('/internal/scheduler/tick', {
    method: 'POST',
    headers: { Authorization: 'Bearer authorized-fixture' }
  });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).status, 'completed');
  assert.equal(ticks, 1);
});

test('internal and upstream failures return 5xx with a safe message; validation errors stay 400', async t => {
  const { call, app } = await setup(t, true);
  const status = await call('/api/status');
  const cookie = status.headers.get('set-cookie').split(';')[0];
  const data = await status.json();
  const id = 'owner@example.com';
  app.store.run(
    'INSERT INTO accounts(id,email,tokens,rules,created) VALUES(?,?,?,?,?)',
    id,
    id,
    app.service.crypto.seal({ refresh_token: 'fixture' }),
    JSON.stringify(DEFAULT_RULES),
    Date.now()
  );
  app.store.run('UPDATE sessions SET account_id=?', id);
  const post = () =>
    call('/api/rules', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'http://localhost:3000',
        'X-CSRF-Token': data.csrf,
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
  const cases = [
    [new Error('SQLITE_BUSY: database is locked'), 500, /temporarily unavailable/],
    [
      Object.assign(new Error('Provider request failed (503). Try again later.'), { status: 503 }),
      502,
      /Provider request failed/
    ],
    [failure('AI_UNAVAILABLE', 'Nebius Token Factory could not be reached.'), 502, /could not finish this step/],
    [Object.assign(new Error('Gmail connection expired. Please reconnect.'), { status: 401 }), 400, /reconnect/],
    [new Error('Choose a valid daily hour.'), 400, /valid daily hour/]
  ];
  for (const [error, expected, message] of cases) {
    app.service.saveRules = async () => {
      throw error;
    };
    const response = await post();
    assert.equal(response.status, expected);
    assert.match((await response.json()).error, message);
  }
});
