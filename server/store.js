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
    CREATE TABLE IF NOT EXISTS agent_questions (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, scope_hash TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL, updated INTEGER NOT NULL, deferred_at INTEGER NOT NULL, snoozed_until INTEGER NOT NULL DEFAULT 0, UNIQUE(account_id,scope_hash));
    CREATE INDEX IF NOT EXISTS agent_questions_tray ON agent_questions(account_id,status,snoozed_until,created);
    CREATE TABLE IF NOT EXISTS preference_memories (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, scope_hash TEXT NOT NULL, payload TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated INTEGER NOT NULL, UNIQUE(account_id,scope_hash));
    CREATE TABLE IF NOT EXISTS preference_events (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, payload TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS preference_events_account ON preference_events(account_id,created);
    CREATE TABLE IF NOT EXISTS agent_holds (account_id TEXT NOT NULL, message_id TEXT NOT NULL, scope_hash TEXT NOT NULL, question_id TEXT, created INTEGER NOT NULL, PRIMARY KEY(account_id,message_id));
    CREATE TABLE IF NOT EXISTS subscription_actions (account_id TEXT NOT NULL, list_key TEXT NOT NULL, message_id TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(account_id,list_key));
    CREATE TABLE IF NOT EXISTS agent_discoveries (account_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, payload TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(account_id,provider,model));
    CREATE INDEX IF NOT EXISTS runs_account ON runs(account_id,created);
    CREATE INDEX IF NOT EXISTS plans_account ON plans(account_id,created);
    CREATE INDEX IF NOT EXISTS changes_account ON changes(account_id,run_id);
    CREATE TABLE IF NOT EXISTS account_access (account_key TEXT PRIMARY KEY, tier TEXT NOT NULL DEFAULT 'free' CHECK(tier IN ('free','paid')), free_used INTEGER NOT NULL DEFAULT 0 CHECK(free_used BETWEEN 0 AND 100), discovery_used INTEGER NOT NULL DEFAULT 0 CHECK(discovery_used IN (0,1)));
    CREATE TABLE IF NOT EXISTS free_email_usage (account_key TEXT NOT NULL, message_key TEXT NOT NULL, PRIMARY KEY(account_key,message_key));
    CREATE TABLE IF NOT EXISTS trial_samples (account_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
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
