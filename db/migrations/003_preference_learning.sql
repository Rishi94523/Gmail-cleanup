CREATE TABLE agent_questions (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, scope_hash TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created BIGINT NOT NULL, updated BIGINT NOT NULL, deferred_at BIGINT NOT NULL, snoozed_until BIGINT NOT NULL DEFAULT 0, UNIQUE(account_id,scope_hash));
CREATE INDEX agent_questions_tray ON agent_questions(account_id,status,snoozed_until,created);
CREATE TABLE preference_memories (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, scope_hash TEXT NOT NULL, payload TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated BIGINT NOT NULL, UNIQUE(account_id,scope_hash));
CREATE TABLE preference_events (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, payload TEXT NOT NULL, created BIGINT NOT NULL);
CREATE INDEX preference_events_account ON preference_events(account_id,created);
CREATE TABLE agent_holds (account_id TEXT NOT NULL, message_id TEXT NOT NULL, scope_hash TEXT NOT NULL, question_id TEXT, created BIGINT NOT NULL, PRIMARY KEY(account_id,message_id));
CREATE TABLE subscription_actions (account_id TEXT NOT NULL, list_key TEXT NOT NULL, message_id TEXT NOT NULL, status TEXT NOT NULL, created BIGINT NOT NULL, PRIMARY KEY(account_id,list_key));
CREATE TABLE agent_discoveries (account_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, payload TEXT NOT NULL, created BIGINT NOT NULL, PRIMARY KEY(account_id,provider,model));
