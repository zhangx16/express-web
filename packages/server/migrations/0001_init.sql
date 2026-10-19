-- 初始 schema。时间字段统一 ISO-8601 UTC 文本。

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  totp_secret_enc TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_uq ON users(username);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  user_agent TEXT,
  ip TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_uq ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  payload_enc TEXT NOT NULL,
  status_detail TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  last_ok_at TEXT,
  last_error_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_channel_label_uq ON accounts(channel, label);
CREATE INDEX IF NOT EXISTS accounts_channel_idx ON accounts(channel);

CREATE TABLE IF NOT EXISTS items (
  mail_no TEXT PRIMARY KEY,
  company_code TEXT NOT NULL DEFAULT '',
  company_name TEXT NOT NULL DEFAULT '',
  latest_text TEXT NOT NULL DEFAULT '',
  latest_time TEXT NOT NULL DEFAULT '',
  latest_time_ms INTEGER NOT NULL DEFAULT 0,
  state INTEGER NOT NULL DEFAULT -1,
  state_name TEXT NOT NULL DEFAULT '',
  phone TEXT,
  provider TEXT NOT NULL DEFAULT '',
  state_num INTEGER NOT NULL DEFAULT 0,
  query_channel TEXT NOT NULL DEFAULT '',
  icon_url TEXT NOT NULL DEFAULT '',
  original_name TEXT NOT NULL DEFAULT '',
  eta TEXT NOT NULL DEFAULT '',
  tracked INTEGER NOT NULL DEFAULT 0,
  notified_text TEXT NOT NULL DEFAULT '',
  notified_time TEXT NOT NULL DEFAULT '',
  state_override TEXT NOT NULL DEFAULT '',
  partition_override TEXT NOT NULL DEFAULT '',
  ai_progress INTEGER NOT NULL DEFAULT -1,
  ai_eta TEXT NOT NULL DEFAULT '',
  ai_progress_at TEXT NOT NULL DEFAULT '',
  jump_links TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  account_id TEXT NOT NULL DEFAULT '',
  account_label TEXT NOT NULL DEFAULT '',
  address_id TEXT NOT NULL DEFAULT '',
  pickup_code TEXT NOT NULL DEFAULT '',
  raw TEXT,
  first_seen_at TEXT NOT NULL,
  last_synced_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS items_source_idx ON items(source);
CREATE INDEX IF NOT EXISTS items_tracked_idx ON items(tracked);
CREATE INDEX IF NOT EXISTS items_account_idx ON items(account_id);
CREATE INDEX IF NOT EXISTS items_time_idx ON items(latest_time_ms);

CREATE TABLE IF NOT EXISTS goods (
  mail_no TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  count TEXT NOT NULL DEFAULT '',
  short_name TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  mail_no TEXT NOT NULL,
  source TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  points TEXT NOT NULL DEFAULT '[]',
  eta TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS traces_mail_source_uq ON traces(mail_no, source);
CREATE INDEX IF NOT EXISTS traces_fetched_idx ON traces(fetched_at);

CREATE TABLE IF NOT EXISTS hidden (
  mail_no TEXT PRIMARY KEY,
  hidden_at TEXT NOT NULL,
  snapshot TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS hidden_at_idx ON hidden(hidden_at);

CREATE TABLE IF NOT EXISTS addresses (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  address TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS secrets (
  name TEXT PRIMARY KEY,
  value_enc TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_created_idx ON chat_messages(created_at);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  content TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_date_idx ON reports(date);

CREATE TABLE IF NOT EXISTS report_schedules (
  id TEXT PRIMARY KEY,
  time TEXT NOT NULL,
  repeat INTEGER NOT NULL DEFAULT 1,
  weekdays INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  channels TEXT NOT NULL DEFAULT '[]',
  total INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS sync_runs_started_idx ON sync_runs(started_at);

CREATE TABLE IF NOT EXISTS login_sessions (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  account_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  message TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS login_sessions_expires_idx ON login_sessions(expires_at);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  mail_no TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  channel TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_uq ON notifications(dedupe_key, channel);
CREATE INDEX IF NOT EXISTS notifications_sent_idx ON notifications(sent_at);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);
