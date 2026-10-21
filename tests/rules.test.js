import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RULES,
  validateRules,
  protectedReason,
  changesFor,
  undoChanges,
  gmailQuery,
  dailyKey
} from '../server/rules.js';
import { encryption, publicIPv4, unsubscribeUrl } from '../server/security.js';
import { randomBytes } from 'node:crypto';

const message = (overrides = {}) => ({
  id: 'one',
  internalDate: String(Date.now() - 150 * 86400000),
  labelIds: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'],
  payload: {
    headers: [
      { name: 'From', value: 'Offers <offers@example.com>' },
      { name: 'Subject', value: 'A summer sale' }
    ]
  },
  ...overrides
});
test('age, categories, protected senders, starred mail and financial/security mail are checked independently', () => {
  assert.equal(protectedReason(message(), DEFAULT_RULES), null);
  assert.equal(protectedReason(message({ internalDate: String(Date.now()) }), DEFAULT_RULES), 'Recent message');
  assert.equal(
    protectedReason(message({ labelIds: ['INBOX', 'STARRED', 'CATEGORY_PROMOTIONS'] }), DEFAULT_RULES),
    'Starred or important'
  );
  assert.equal(
    protectedReason(message({ labelIds: ['INBOX', 'IMPORTANT', 'CATEGORY_PROMOTIONS'] }), DEFAULT_RULES),
    'Starred or important'
  );
  assert.equal(
    protectedReason(message({ labelIds: ['INBOX', 'CATEGORY_PERSONAL'] }), DEFAULT_RULES),
    'Outside selected categories'
  );
  assert.equal(
    protectedReason(message(), { ...DEFAULT_RULES, protectedSenders: ['offers@example.com'] }),
    'Protected sender'
  );
  assert.match(
    protectedReason(
      message({ payload: { headers: [{ name: 'Subject', value: 'Your flight booking' }] } }),
      DEFAULT_RULES
    ),
    /important/
  );
  assert.match(
    protectedReason(message({ payload: { headers: [{ name: 'Subject', value: 'Security alert' }] } }), DEFAULT_RULES),
    /important/
  );
});
test('undo reverses only changed labels and unread status', () => {
  const rules = { ...DEFAULT_RULES, markRead: true };
  const change = changesFor(message(), rules, 'CLEANED');
  assert.deepEqual(change, { addLabelIds: ['CLEANED'], removeLabelIds: ['INBOX', 'UNREAD'] });
  assert.deepEqual(undoChanges(change), { addLabelIds: ['INBOX', 'UNREAD'], removeLabelIds: ['CLEANED'] });
  const already = changesFor(message({ labelIds: ['INBOX', 'CATEGORY_PROMOTIONS', 'CLEANED'] }), rules, 'CLEANED');
  assert.deepEqual(already, { addLabelIds: [], removeLabelIds: ['INBOX'] });
});
test('query excludes starred and important and mark-read-only excludes already-read mail', () => {
  assert.match(gmailQuery(DEFAULT_RULES), /-is:starred -is:important/);
  assert.match(gmailQuery({ ...DEFAULT_RULES, archive: false, markRead: true }), /is:unread/);
});
test('invalid rules and query injection are rejected', () => {
  for (const input of [
    { ...DEFAULT_RULES, days: 0 },
    { ...DEFAULT_RULES, categories: ['promotions} in:anywhere'] },
    { ...DEFAULT_RULES, timezone: 'invalid' },
    { ...DEFAULT_RULES, timezone: undefined },
    { ...DEFAULT_RULES, archive: false },
    { ...DEFAULT_RULES, protectedSenders: ['a@example.com -is:important'] }
  ])
    assert.throws(() => validateRules(input));
  assert.equal(
    validateRules({ ...DEFAULT_RULES, protectedSenders: ['A@example.com'] }).protectedSenders[0],
    'a@example.com'
  );
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
