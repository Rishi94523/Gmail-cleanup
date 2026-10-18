import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { openPostgresStore } from '../server/postgres-store.js';
import { accessFor, reserveFreeEmail, requirePaid } from '../server/access.js';

const trialUrl = process.env.TRIAL_DATABASE_URL;
if (!trialUrl || !new URL(trialUrl).hostname.startsWith('ep-shiny-brook-b54rydrs')) throw new Error('Use only the expiring schema-only free-trial branch.');
const trial = await openPostgresStore(trialUrl, { max: 1 });
const baseline = await openPostgresStore(process.env.DATABASE_URL, { max: 1 });
try {
  // Schema-only branches contain the migration table but none of its rows.
  for (const row of await baseline.all('SELECT name,checksum,applied FROM app_migrations')) {
    await trial.run('INSERT INTO app_migrations(name,checksum,applied) VALUES(?,?,?) ON CONFLICT DO NOTHING', row.name, row.checksum, row.applied);
  }
  const sql = (await readFile('db/migrations/004_free_trial.sql', 'utf8')).replace(/\r\n/g, '\n');
  await trial.transaction(async tx => {
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await tx.run(statement);
    await tx.run('INSERT INTO app_migrations(name,checksum,applied) VALUES(?,?,?)', '004_free_trial.sql', createHash('sha256').update(sql).digest('hex'), Date.now());
  });
  const service = { store: trial }; const id = `${randomBytes(12).toString('hex')}@example.invalid`;
  assert.equal((await accessFor(service, id)).remaining, 100);
  for (let i = 0; i < 100; i++) assert.equal(await reserveFreeEmail(service, id, `mail-${i}`), true);
  assert.equal(await reserveFreeEmail(service, id, 'mail-100'), false);
  assert.equal(await reserveFreeEmail(service, id, 'mail-0'), false);
  assert.equal((await accessFor(service, id)).remaining, 0);
  await assert.rejects(requirePaid(service, id), /paid plan/);
  console.log('PASS schema-only Neon migration; 100 real transactional reservations; email 101 and repeat inference blocked; free daily access denied. No mailbox data copied or accessed.');
} finally { await trial.close(); await baseline.close(); }
