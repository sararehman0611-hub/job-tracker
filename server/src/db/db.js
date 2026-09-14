const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set — copy .env.example to .env and fill it in');
}

// Neon (and any hosted Postgres) requires TLS; a local server usually has none.
const isLocal = /@(localhost|127\.0\.0\.1)/.test(process.env.DATABASE_URL);

// The `ssl` option below is what actually decides TLS, so a `sslmode` left in
// the URL is redundant — and pg logs a deprecation warning about how it plans to
// reinterpret it. Strip it so production logs stay readable.
const connectionString = process.env.DATABASE_URL.replace(/([?&])sslmode=[^&]*&?/, '$1')
    .replace(/[?&]$/, '');

const pool = new Pool({
    connectionString,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    // Neon's free tier is stingy about concurrent connections, and this process
    // only ever serves one user plus a cron tick.
    max: 5,
    idleTimeoutMillis: 30000
});

pool.on('error', (err) => console.error('[db] idle client error:', err.message));

// --- query helpers ---------------------------------------------------------
// better-sqlite3 was synchronous; pg is not. These mirror its get/all/run so
// the call sites read much the same way, just awaited.
const query = (text, params) => pool.query(text, params);
const one = async (text, params) => (await pool.query(text, params)).rows[0] || null;
const all = async (text, params) => (await pool.query(text, params)).rows;
const run = async (text, params) => (await pool.query(text, params)).rowCount;

// --- schema ----------------------------------------------------------------
// ON DELETE CASCADE on email_events is what lets DELETE /jobs/:id be a single
// statement. Under SQLite this needed a hand-rolled transaction to clear the
// child rows first, or the foreign key threw.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    google_refresh_token TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS applications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    company TEXT NOT NULL,
    company_domain TEXT,
    role TEXT NOT NULL,
    job_url TEXT,
    source TEXT,
    status TEXT DEFAULT 'applied',
    applied_at TIMESTAMPTZ DEFAULT NOW(),
    last_email_at TIMESTAMPTZ,
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS email_events (
    id SERIAL PRIMARY KEY,
    application_id INTEGER REFERENCES applications(id) ON DELETE CASCADE,
    gmail_message_id TEXT UNIQUE,
    subject TEXT,
    from_address TEXT,
    detected_type TEXT,
    received_at TIMESTAMPTZ
  );

  CREATE INDEX IF NOT EXISTS idx_applications_user ON applications(user_id);
  CREATE INDEX IF NOT EXISTS idx_email_events_app ON email_events(application_id);
`;

// Called once at boot, before the server starts listening.
async function init() {
    await pool.query(SCHEMA);
    // columns added after the table first shipped
    await pool.query('ALTER TABLE applications ADD COLUMN IF NOT EXISTS notes TEXT');
}

module.exports = { pool, query, one, all, run, init };
