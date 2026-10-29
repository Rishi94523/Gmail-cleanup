import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RULES, validateRules, undoChanges, dailyKey, dailyHours } from '../server/rules.js';
import { encryption, publicIPv4, unsubscribeUrl } from '../server/security.js';
import { randomBytes } from 'node:crypto';

test('undo reverses exactly the labels a run added and removed', () => {
  assert.deepEqual(undoChanges({ addLabelIds: ['CLEANED'], removeLabelIds: ['INBOX', 'UNREAD'] }), {
    addLabelIds: ['INBOX', 'UNREAD'],
    removeLabelIds: ['CLEANED']
  });
});
test('invalid account rules are rejected and retired rules-only fields are dropped', () => {
  for (const input of [
    { ...DEFAULT_RULES, timezone: 'invalid' },
    { ...DEFAULT_RULES, timezone: undefined },
    { ...DEFAULT_RULES, daily: 'yes' },
    { ...DEFAULT_RULES, hour: 24 },
    { ...DEFAULT_RULES, protectedSenders: ['a@example.com -is:important'] }
  ])
    assert.throws(() => validateRules(input));
  assert.equal(
    validateRules({ ...DEFAULT_RULES, protectedSenders: ['A@example.com'] }).protectedSenders[0],
    'a@example.com'
  );
  const legacy = {
    ...DEFAULT_RULES,
    days: 90,
    categories: ['promotions'],
    markRead: false,
    archive: true,
    aiEnabled: false
  };
  assert.deepEqual(Object.keys(validateRules(legacy)).sort(), Object.keys(DEFAULT_RULES).sort());
  assert.deepEqual(validateRules({ ...DEFAULT_RULES, protectedSenders: undefined }).protectedSenders, []);
});
test('daily run uses the selected timezone and hour', () => {
  const rules = { ...DEFAULT_RULES, hour: 9, timezone: 'Asia/Kolkata' };
  assert.equal(dailyKey(rules, new Date('2026-10-16T03:29:00Z')), null);
  assert.equal(dailyKey(rules, new Date('2026-10-16T03:30:00Z')), '2026-10-16');
  const until = new Date('2026-10-17T03:30:00Z').getTime();
  assert.equal(dailyKey({ ...rules, dailyPausedUntil: until }, new Date('2026-10-17T03:29:59Z')), null);
  assert.equal(dailyKey({ ...rules, dailyPausedUntil: until }, new Date(until)), '2026-10-17');
  assert.equal(dailyKey({ ...rules, dailyPausedUntil: -1 }, new Date('2030-10-17T03:30:00Z')), null);
  for (const value of [-2, 'tomorrow', 0.5, Infinity])
    assert.throws(() => validateRules({ ...rules, dailyPausedUntil: value }), /pause/);
});
test('up to three daily runs are evenly spaced from the start hour, including across midnight', () => {
  // Asia/Kolkata is UTC+5:30, so 09:00 local is 03:30Z.
  const rules = { ...DEFAULT_RULES, hour: 9, runsPerDay: 3, timezone: 'Asia/Kolkata' };
  assert.deepEqual(dailyHours(rules), [9, 17, 1]);
  assert.deepEqual(dailyHours({ ...rules, runsPerDay: 2 }), [9, 21]);
  assert.deepEqual(dailyHours({ ...rules, runsPerDay: undefined }), [9]);
  const at = iso => dailyKey(rules, new Date(iso));
  assert.equal(at('2026-10-16T03:29:00Z'), '2026-10-15#3', '08:59 is still the previous cycle’s 01:00 run');
  assert.equal(at('2026-10-16T03:30:00Z'), '2026-10-16');
  assert.equal(at('2026-10-16T11:29:00Z'), '2026-10-16');
  assert.equal(at('2026-10-16T11:30:00Z'), '2026-10-16#2');
  assert.equal(at('2026-10-16T19:30:00Z'), '2026-10-16#3', '01:00 next calendar day belongs to the same cycle');
  assert.equal(at('2026-10-17T03:30:00Z'), '2026-10-17');
  // Claim keys sort in time order, so the scheduler can skip anything not newer.
  const keys = ['2026-10-15#3', '2026-10-16', '2026-10-16#2', '2026-10-16#3', '2026-10-17'];
  assert.deepEqual([...keys].sort(), keys);
  assert.equal(dailyKey({ ...rules, dailyPausedUntil: -1 }, new Date('2026-10-16T11:30:00Z')), null);
  assert.equal(validateRules({ ...DEFAULT_RULES }).runsPerDay, 1);
  const { runsPerDay, ...legacy } = DEFAULT_RULES;
  assert.equal(runsPerDay, 1);
  assert.equal(validateRules(legacy).runsPerDay, 1, 'Accounts saved before this setting default to one run');
  for (const value of [0, 4, 1.5, '2']) assert.throws(() => validateRules({ ...rules, runsPerDay: value }), /per day/);
});
test('encrypted tokens round trip and tampering fails', () => {
  const cipher = encryption(randomBytes(32).toString('base64'));
  const sealed = cipher.seal({ refresh_token: 'sensitive-fixture' });
  assert.ok(!sealed.includes('sensitive-fixture'));
  assert.deepEqual(cipher.open(sealed), { refresh_token: 'sensitive-fixture' });
  const altered = Buffer.from(sealed, 'base64');
  altered[30] ^= 1;
  assert.throws(() => cipher.open(altered.toString('base64')));
  assert.throws(() => encryption('bad-key'));
});
test('unsubscribe destinations cannot target local, private, metadata or IPv6 addresses', () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.2',
    '169.254.169.254',
    '192.168.1.1',
    '172.20.1.1',
    '100.64.0.1',
    '::1',
    '::ffff:127.0.0.1',
    '0.0.0.0',
    '224.0.0.1'
  ])
    assert.equal(publicIPv4(address), false, address);
  assert.equal(publicIPv4('8.8.8.8'), true);
});
test('one-click unsubscribe requires signed headers and Google DKIM pass', () => {
  const headers = {
    'list-unsubscribe': '<https://lists.example.com/leave?user=1>',
    'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
    'authentication-results': 'mx.google.com; dkim=pass header.i=@example.com;',
    'dkim-signature': 'v=1; d=example.com; h=from:subject:list-unsubscribe:list-unsubscribe-post; b=signature'
  };
  assert.equal(unsubscribeUrl(headers)?.hostname, 'lists.example.com');
  assert.equal(unsubscribeUrl({ ...headers, 'list-unsubscribe-post': '' }), null);
  assert.equal(
    unsubscribeUrl({ ...headers, 'authentication-results': 'attacker; dkim=pass header.i=@example.com' }),
    null
  );
  assert.equal(unsubscribeUrl({ ...headers, 'dkim-signature': 'd=example.com; h=from:subject;' }), null);
  assert.equal(unsubscribeUrl({ ...headers, 'list-unsubscribe': '<http://example.com/leave>' }), null);
  assert.equal(unsubscribeUrl({ ...headers, 'list-unsubscribe': '<https://127.0.0.1/leave>' }), null);
  assert.equal(unsubscribeUrl({ ...headers, 'list-unsubscribe': '<https://user:secret@example.com/leave>' }), null);
});
