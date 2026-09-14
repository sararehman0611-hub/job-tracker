// One-off: load the pre-Postgres SQLite data into whatever DATABASE_URL points at.
//
//   node scripts/import-sqlite.js [path-to-export.json]
//
// The export is produced from the old jobtracker.db and defaults to
// ../sqlite-export.json (gitignored — it contains a Google refresh token).
//
// Safe to re-run: every insert is keyed on a natural unique column and does
// nothing on conflict, so a second run imports only what is genuinely missing.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../src/db/db');

const file = process.argv[2] || path.join(__dirname, '../../sqlite-export.json');

async function main() {
    if (!fs.existsSync(file)) {
        console.error('No export found at', file);
        process.exit(1);
    }
    const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(`Importing from ${path.basename(file)} (exported ${dump.exported_at})`);

    await db.init();

    // users: email is unique, and it maps old ids to new ones
    const userIdMap = new Map();
    for (const u of dump.users) {
        const row = await db.one(
            `INSERT INTO users (email, google_refresh_token)
             VALUES ($1, $2)
             ON CONFLICT (email) DO UPDATE SET
               google_refresh_token =
                 COALESCE(EXCLUDED.google_refresh_token, users.google_refresh_token)
             RETURNING id`,
            [u.email, u.google_refresh_token]
        );
        userIdMap.set(u.id, row.id);
    }
    console.log(`  users:        ${userIdMap.size}`);

    // applications have no natural key, so dedupe on the triple that identifies
    // one in practice; SERIAL assigns fresh ids, hence the second id map
    const appIdMap = new Map();
    let appsInserted = 0;
    for (const a of dump.applications) {
        const userId = userIdMap.get(a.user_id);
        if (!userId) continue;                       // orphaned row in the old file

        const existing = await db.one(
            'SELECT id FROM applications WHERE user_id = $1 AND company = $2 AND role = $3',
            [userId, a.company, a.role]
        );
        if (existing) {
            appIdMap.set(a.id, existing.id);
            continue;
        }
        const row = await db.one(
            `INSERT INTO applications
               (user_id, company, company_domain, role, job_url, source, status,
                applied_at, last_email_at, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             RETURNING id`,
            [userId, a.company, a.company_domain, a.role, a.job_url, a.source,
                a.status, ts(a.applied_at), ts(a.last_email_at), a.notes ?? null]
        );
        appIdMap.set(a.id, row.id);
        appsInserted++;
    }
    console.log(`  applications: ${appsInserted} inserted, ${dump.applications.length - appsInserted} already present`);

    let eventsInserted = 0;
    for (const e of dump.email_events) {
        const appId = appIdMap.get(e.application_id);
        if (!appId) continue;
        const n = await db.run(
            `INSERT INTO email_events
               (application_id, gmail_message_id, subject, from_address, detected_type, received_at)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (gmail_message_id) DO NOTHING`,
            [appId, e.gmail_message_id, e.subject, e.from_address, e.detected_type, ts(e.received_at)]
        );
        eventsInserted += n;
    }
    console.log(`  email_events: ${eventsInserted} inserted`);

    const total = await db.one('SELECT COUNT(*)::int AS n FROM applications');
    console.log(`\nDone — ${total.n} applications now in Postgres.`);
    await db.pool.end();
}

// SQLite stored naive UTC ("2026-09-03 11:04:08"); Gmail events stored ISO. Both
// have to land in a timestamptz, so mark the naive ones as UTC explicitly.
function ts(value) {
    if (!value) return null;
    return value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
}

main().catch((err) => {
    console.error('Import failed:', err.message);
    process.exit(1);
});
