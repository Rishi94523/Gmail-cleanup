import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreview } from '../server/preview.js';

test('cloud preview serves only public assets, identifies its stage, and refuses Gmail routes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'gmail-cleanup-preview-'));
  const root = join(directory, 'dist'); mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>Public preview</title>');
  writeFileSync(join(root, 'assets', 'app-test.js'), 'console.log("preview");');
  writeFileSync(join(directory, '.env'), 'private-test-fixture');
  const app = createPreview({ directory: root });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const call = (path, method = 'GET') => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: app.server.address().port, path, method }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    }); req.on('error', reject); req.end();
  });
  const page = await call('/'); assert.equal(page.status, 200); assert.match(page.body, /Public preview/); assert.equal(page.headers['cache-control'], 'no-store'); assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  const asset = await call('/assets/app-test.js'); assert.equal(asset.status, 200); assert.match(asset.headers['cache-control'], /immutable/);
  const health = await call('/healthz'); assert.deepEqual(JSON.parse(health.body), { name: 'gmail-cleanup', stage: 'public-product-preview', gmailEnabled: false });
  for (const path of ['/api/status', '/auth/google', '/.env', '/assets/..%2f..%2f.env', '/server/index.js']) { const response = await call(path); assert.ok([404, 503].includes(response.status), path); assert.ok(!response.body.includes('private-test-fixture')); }
  assert.equal((await call('/api/apply', 'POST')).status, 405);
  assert.equal((await call('/', 'HEAD')).body, '');
});
