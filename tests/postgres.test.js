import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresQuery } from '../server/postgres-store.js';
test('Postgres placeholders remain parameterized and quoted question marks are preserved', () => {
  assert.equal(postgresQuery("SELECT '?' AS literal FROM accounts WHERE id=? AND email=?"), "SELECT '?' AS literal FROM accounts WHERE id=$1 AND email=$2");
  assert.equal(postgresQuery("UPDATE accounts SET last_error='What''s next?' WHERE id=?"), "UPDATE accounts SET last_error='What''s next?' WHERE id=$1");
});
