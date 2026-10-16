import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { createApp } from '../server/index.js';
import { DEFAULT_RULES } from '../server/rules.js';

async function setup(t, configured = false) {
  const directory = mkdtempSync(join(tmpdir(), 'inboxclean-http-'));
  const app = await createApp({ dataDir: directory, config: { databaseUrl: '', appUrl: 'http://localhost:3000', encryptionKey: configured ? randomBytes(32).toString('base64') : '', clientId: configured ? 'fixture-client' : '', clientSecret: configured ? 'fixture-secret' : '' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const call = (path, options = {}) => new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { method: options.method || 'GET', headers: { Host: 'localhost:3000', ...options.headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const headers = new Headers(); for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers }));
      });
    });
    req.on('error', reject); req.end(options.body);
  });
  return { app, call };
}
test('unconfigured app serves real setup state, secure headers, and no invented mailbox data', async t => {
  const { call } = await setup(t); const response = await call('/'); assert.equal(response.status, 200); assert.match(await response.text(), /A little less inbox/);
  assert.equal(response.headers.get('x-frame-options'), 'DENY'); assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  const status = await call('/api/status'); const data = await status.json(); assert.equal(data.connected, false); assert.equal(data.configured, false); assert.deepEqual(data.runs, []); assert.equal(data.plan, null);
  assert.match(status.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  assert.equal((await call('/api/scan', { method: 'POST' })).status, 401);
  assert.equal((await call('/.env')).status, 404);
});
test('OAuth uses state and PKCE and callback rejects missing or foreign state without external calls', async t => {
  const { call } = await setup(t, true); const status = await call('/api/status'); const cookie = status.headers.get('set-cookie').split(';')[0];
  const start = await call('/auth/google', { headers: { Cookie: cookie } }); assert.equal(start.status, 302);
  const location = new URL(start.headers.get('location')); assert.equal(location.hostname, 'accounts.google.com'); assert.equal(location.searchParams.get('access_type'), 'offline'); assert.equal(location.searchParams.get('code_challenge_method'), 'S256'); assert.ok(location.searchParams.get('state'));
  const callback = await call('/auth/google/callback?state=forged&code=fake', { headers: { Cookie: cookie } }); assert.equal(callback.headers.get('location'), '/?auth=state');
});
test('session cookies resolve, write routes reject cross-origin or missing CSRF, and disconnect is not a GET action', async t => {
  const { call, app } = await setup(t, true); const status = await call('/api/status'); const cookie = status.headers.get('set-cookie').split(';')[0]; const data = await status.json();
  const id = 'owner@example.com'; app.store.run('INSERT INTO accounts(id,email,tokens,rules,created) VALUES(?,?,?,?,?)', id, id, app.service.crypto.seal({ refresh_token: 'fixture' }), JSON.stringify(DEFAULT_RULES), Date.now());
  app.store.run('UPDATE sessions SET account_id=?', id);
  assert.equal((await (await call('/api/status', { headers: { Cookie: cookie } })).json()).connected, true);
  const post = headers => call('/api/rules', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(DEFAULT_RULES) });
  assert.equal((await post({ Origin: 'https://attacker.example', 'X-CSRF-Token': data.csrf })).status, 403);
  assert.equal((await post({ Origin: 'http://localhost:3000' })).status, 403);
  assert.equal((await post({ Origin: 'http://localhost:3000', 'X-CSRF-Token': data.csrf })).status, 200);
  assert.equal((await call('/api/disconnect', { headers: { Cookie: cookie } })).status, 405);
});
