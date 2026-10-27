import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonFetch } from '../server/gmail.js';
import { publicFailure } from '../server/failures.js';

test('Google invalid_grant on HTTP 400 requests reconnection without exposing provider details', async t => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const logs = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  });
  console.warn = message => logs.push(JSON.parse(message));
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'private token diagnostic' }), {
      status: 400
    });
  await assert.rejects(jsonFetch('https://oauth2.googleapis.com/token'), error => {
    assert.equal(error.status, 400);
    assert.equal(publicFailure(error).code, 'GMAIL_AUTH');
    assert.match(publicFailure(error).message, /Reconnect Gmail/);
    assert.doesNotMatch(publicFailure(error).message, /private|invalid_grant|400/);
    return true;
  });
  assert.equal(logs[0].api, 'oauth');
  assert.equal(logs[0].reason, 'invalid_grant');
  assert.doesNotMatch(JSON.stringify(logs), /private token/);
});
