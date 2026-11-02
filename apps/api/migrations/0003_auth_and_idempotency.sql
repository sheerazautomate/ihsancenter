-- 0003_auth_and_idempotency.sql
-- Login rate limiting.
--
-- The idempotency columns and their unique indexes now live in 0001_init.sql.
-- They were originally added here with ALTER TABLE, which can never be re-run and
-- would have made this file unsafe to repeat on a database whose first attempt
-- half-finished. No production database existed when they moved, so nothing was
-- migrated: the columns are simply part of the schema.

-- Rate limiting for login. Keyed by username+IP hash, never stores raw IPs.
CREATE TABLE IF NOT EXISTS login_attempts (
  id            TEXT PRIMARY KEY,
  at            TEXT NOT NULL,
  username      TEXT NOT NULL,
  ip_hash       TEXT,
  succeeded     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_attempts_user ON login_attempts(username, at);
CREATE INDEX IF NOT EXISTS idx_attempts_ip   ON login_attempts(ip_hash, at);
