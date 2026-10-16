import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { openPostgresStore } from '../server/postgres-store.js';

const url = process.env.DATABASE_URL_UNPOOLED;
if (!url || new URL(url).hostname.includes('-pooler')) throw new Error('Migrations require DATABASE_URL_UNPOOLED with a direct connection.');
const store = await openPostgresStore(url, { max: 1 });
try {
  await store.transaction(async tx => {
    // Transaction-scoped lock is released even if the process or migration fails.
    await tx.get('SELECT pg_advisory_xact_lock(511806)');
    await tx.run('CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied BIGINT NOT NULL)');
    for (const name of (await readdir('db/migrations')).filter(name => name.endsWith('.sql')).sort()) {
      const sql = (await readFile(resolve('db/migrations', name), 'utf8')).replace(/\r\n/g, '\n');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await tx.get('SELECT checksum FROM app_migrations WHERE name=?', name);
      if (existing) { if (existing.checksum !== checksum) throw new Error(`Applied migration changed: ${name}`); console.log(`Already applied: ${name}`); continue; }
      for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await tx.run(statement);
      await tx.run('INSERT INTO app_migrations(name,checksum,applied) VALUES(?,?,?)', name, checksum, Date.now());
      console.log(`Applied migration: ${name}`);
    }
  });
  console.log('Postgres migrations complete.');
} finally { await store.close(); }
