CREATE TABLE agent_assessments (
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  created BIGINT NOT NULL,
  PRIMARY KEY (account_id, policy_hash, message_id)
);
