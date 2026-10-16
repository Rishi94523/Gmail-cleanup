import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import assert from 'node:assert/strict';
import { openPostgresStore } from '../server/postgres-store.js';
import { hash } from '../server/security.js';

if (process.env.NEON_BRANCH !== 'production') throw new Error('This smoke check expects the configured production branch.');
const port = 3002; let child; let sessionId;
const call = (path, cookie) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, headers: { Host: `localhost:${port}`, ...(cookie ? { Cookie: cookie } : {}) } }, response => {
    let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
  }); req.setTimeout(5000, () => req.destroy(new Error('Smoke request timed out.'))); req.on('error', reject); req.end();
});
async function start() {
  child = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(port), APP_URL: `http://localhost:${port}`, ENABLE_LOCAL_SCHEDULER: 'false' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('The application exited before becoming healthy.');
    try { const health = await call('/api/health'); if (health.status === 200) return JSON.parse(health.body); } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('The application did not become healthy in time.');
}
async function stop() {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
}
let store;
try {
  const health = await start(); assert.equal(health.database, 'postgres'); assert.equal(health.connected, true);
  console.log('PASS application started with production Neon Postgres; /api/health returned HTTP 200');
  const page = await call('/'); assert.equal(page.status, 200); assert.match(page.body, /A little less inbox/);
  const status = await call('/api/status'); assert.equal(status.status, 200);
  const first = JSON.parse(status.body); const cookie = status.headers['set-cookie'][0].split(';')[0]; sessionId = hash(cookie.slice(cookie.indexOf('=') + 1));
  store = await openPostgresStore(process.env.DATABASE_URL);
  assert.ok(await store.get('SELECT id FROM sessions WHERE id=?', sessionId));
  await stop(); await start();
  const resumed = JSON.parse((await call('/api/status', cookie)).body);
  assert.equal(resumed.csrf, first.csrf); assert.equal(resumed.connected, false);
  console.log('PASS dashboard HTTP 200 and anonymous session persisted across an actual server restart');
  console.log(`Production smoke passed. Gmail configured: ${health.gmailConfigured}. No Gmail API calls or fake account records were created.`);
} finally {
  await stop();
  if (store) { if (sessionId) await store.run('DELETE FROM sessions WHERE id=?', sessionId); await store.close(); }
}
