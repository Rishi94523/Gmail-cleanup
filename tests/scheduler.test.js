import test from 'node:test';
import assert from 'node:assert/strict';
import { schedulerAuthorized } from '../server/scheduler.js';
const config = { appUrl: 'https://app.example.invalid', schedulerAccount: 'cron@example.invalid' };
test('scheduler requires verified expected Google identity and passes the exact audience to signature verification', async () => {
  let called = 0;
  const verify = async (token, audience) => { called++; assert.equal(token, 'fixture'); assert.equal(audience, config.appUrl); return { email_verified: true, email: config.schedulerAccount }; };
  assert.equal(await schedulerAuthorized('', config, verify), false);
  assert.equal(await schedulerAuthorized('Bearer fixture', {}, verify), false);
  assert.equal(called, 0);
  assert.equal(await schedulerAuthorized('Bearer fixture', config, verify), true);
  assert.equal(await schedulerAuthorized('Bearer fixture', config, async () => ({ email_verified: false, email: config.schedulerAccount })), false);
  assert.equal(await schedulerAuthorized('Bearer fixture', config, async () => ({ email_verified: true, email: 'other@example.invalid' })), false);
  assert.equal(await schedulerAuthorized('Bearer forged', config, async () => { throw Error('Invalid signature'); }), false);
});
