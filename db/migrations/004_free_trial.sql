CREATE TABLE account_access (account_key TEXT PRIMARY KEY, tier TEXT NOT NULL DEFAULT 'free' CHECK(tier IN ('free','paid')), free_used INTEGER NOT NULL DEFAULT 0 CHECK(free_used BETWEEN 0 AND 100), discovery_used INTEGER NOT NULL DEFAULT 0 CHECK(discovery_used IN (0,1)));
CREATE TABLE free_email_usage (account_key TEXT NOT NULL, message_key TEXT NOT NULL, PRIMARY KEY(account_key,message_key));
CREATE TABLE trial_samples (account_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
