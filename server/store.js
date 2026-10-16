import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export function openStore(directory = 'data') {
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(resolve(directory, 'inboxclean.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL, tokens TEXT NOT NULL, rules TEXT NOT NULL, last_day TEXT, last_error TEXT, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, account_id TEXT, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_states (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, verifier TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, total INTEGER NOT NULL DEFAULT 0, changed INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, detail TEXT, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS changes (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, account_id TEXT NOT NULL, message_id TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS subscriptions (account_id TEXT NOT NULL, sender TEXT NOT NULL, message_id TEXT NOT NULL, host TEXT, status TEXT NOT NULL, PRIMARY KEY(account_id,sender));
    CREATE TABLE IF NOT EXISTS locks (account_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_assessments (account_id TEXT NOT NULL, message_id TEXT NOT NULL, policy_hash TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(account_id,policy_hash,message_id));
    CREATE INDEX IF NOT EXISTS runs_account ON runs(account_id,created);
    CREATE INDEX IF NOT EXISTS plans_account ON plans(account_id,created);
    CREATE INDEX IF NOT EXISTS changes_account ON changes(account_id,run_id);
  `);
  return {
    kind: 'sqlite',
    db,
    get: (sql, ...args) => db.prepare(sql).get(...args),
    all: (sql, ...args) => db.prepare(sql).all(...args),
    run: (sql, ...args) => db.prepare(sql).run(...args),
    close: () => db.close(),
    async transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const result = await fn(this); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
}
