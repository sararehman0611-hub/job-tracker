const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '../../jobtracker.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    google_refresh_token TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    company TEXT NOT NULL,
    company_domain TEXT,
    role TEXT NOT NULL,
    job_url TEXT,
    source TEXT,
    status TEXT DEFAULT 'applied',
    applied_at TEXT DEFAULT (datetime('now')),
    last_email_at TEXT
  );

  CREATE TABLE IF NOT EXISTS email_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER REFERENCES applications(id),
    gmail_message_id TEXT UNIQUE,
    subject TEXT,
    from_address TEXT,
    detected_type TEXT,
    received_at TEXT
  );
`);

module.exports = db;