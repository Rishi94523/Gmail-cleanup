import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresQuery } from '../server/postgres-store.js';
test('Postgres placeholders remain parameterized and quoted question marks are preserved', () => {
  assert.equal(
    postgresQuery("SELECT '?' AS literal FROM accounts WHERE id=? AND email=?"),
    "SELECT '?' AS literal FROM accounts WHERE id=$1 AND email=$2"
  );
  assert.equal(
    postgresQuery("UPDATE accounts SET last_error='What''s next?' WHERE id=?"),
    "UPDATE accounts SET last_error='What''s next?' WHERE id=$1"
  );
});

test('local SQLite schema matches the Postgres migrations', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const { readdirSync, readFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { openStore } = await import('../server/store.js');
  const migrated = new DatabaseSync(':memory:');
  for (const name of readdirSync('db/migrations')
    .filter(name => name.endsWith('.sql'))
    .sort())
    migrated.exec(readFileSync(join('db/migrations', name), 'utf8'));
  const directory = mkdtempSync(join(tmpdir(), 'inboxclean-schema-'));
  const local = openStore(directory);
  t.after(() => {
    local.close();
    migrated.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const describe = db => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map(row => row.name);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name")
      .all()
      .map(row => row.name);
    // Postgres BIGINT and SQLite INTEGER hold the same values here.
    return {
      indexes,
      tables: Object.fromEntries(
        tables.map(table => [
          table,
          db
            .prepare(`PRAGMA table_info(${table})`)
            .all()
            .map(
              c =>
                `${c.name} ${c.type.replace('BIGINT', 'INTEGER')}${c.notnull ? ' NOT NULL' : ''}${c.pk ? ` PK${c.pk}` : ''}${c.dflt_value === null ? '' : ` DEFAULT ${c.dflt_value}`}`
            )
            .sort()
        ])
      )
    };
  };
  assert.deepEqual(describe(local.db), describe(migrated));
});

test('SQLite transactions do not absorb or collide with concurrent requests', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { openStore } = await import('../server/store.js');
  const directory = mkdtempSync(join(tmpdir(), 'inboxclean-tx-'));
  const store = openStore(directory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let entered;
  const inside = new Promise(resolve => {
    entered = resolve;
  });
  let finish;
  const blocked = new Promise(resolve => {
    finish = resolve;
  });
  const failing = store.transaction(async tx => {
    tx.run("INSERT INTO locks(account_id,owner,expires) VALUES('rolled-back','tx',1)");
    entered();
    await blocked;
    throw new Error('rollback');
  });
  await inside;
  const outsideWrite = store.run("INSERT INTO locks(account_id,owner,expires) VALUES('outside','request',1)");
  const second = store.transaction(async tx =>
    tx.run("INSERT INTO locks(account_id,owner,expires) VALUES('second','tx',1)")
  );
  finish();
  await assert.rejects(failing, /rollback/);
  await outsideWrite;
  await second;
  assert.deepEqual(
    store.all('SELECT account_id FROM locks ORDER BY account_id').map(row => row.account_id),
    ['outside', 'second']
  );
});
