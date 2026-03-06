const Database = require('better-sqlite3');
const path = require('node:path');

const dbPath = path.join(__dirname, '..', 'data', 'webhook.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    twilio_sid TEXT,
    from_number TEXT,
    to_number TEXT,
    body TEXT,
    num_media INTEGER DEFAULT 0,
    media_urls TEXT,
    raw_payload TEXT,
    forwarded_to TEXT,
    forward_status INTEGER,
    forward_error TEXT,
    forward_response_body TEXT,
    forward_response_headers TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id),
    destination_url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 5,
    next_retry_at TEXT DEFAULT (datetime('now')),
    last_error TEXT,
    response_status INTEGER,
    response_body TEXT,
    response_headers TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_deliveries_status_retry
    ON deliveries(status, next_retry_at);
  CREATE INDEX IF NOT EXISTS idx_deliveries_message_id
    ON deliveries(message_id);

  CREATE TABLE IF NOT EXISTS delivery_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
    attempt_number INTEGER NOT NULL,
    status_code INTEGER,
    error TEXT,
    response_body TEXT,
    response_headers TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_delivery_attempts_delivery_id
    ON delivery_attempts(delivery_id);
`);

module.exports = db;
