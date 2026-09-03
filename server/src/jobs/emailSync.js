const cron = require('node-cron');
const db = require('../db/db');
const { fetchRecentMessages } = require('../services/gmailService');
const { extractDomain, matchesApplication, classify, nextStatus } = require('../services/matcher');

async function syncUser(user) {
    const apps = db.prepare(
        "SELECT * FROM applications WHERE user_id = ? AND status NOT IN ('rejected','offer')"
    ).all(user.id);
    if (apps.length === 0) return 0;

    const messages = await fetchRecentMessages(user.google_refresh_token);
    let updates = 0;

    const seen = db.prepare('SELECT 1 FROM email_events WHERE gmail_message_id = ?');
    const insertEvent = db.prepare(`
    INSERT INTO email_events (application_id, gmail_message_id, subject, from_address, detected_type, received_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
    const updateApp = db.prepare(
        'UPDATE applications SET status = ?, last_email_at = ? WHERE id = ?'
    );

    for (const msg of messages) {
        if (seen.get(msg.id)) continue;                    // already processed

        const domain = extractDomain(msg.from);
        const app = apps.find(a => matchesApplication(domain, msg.from, a));
        if (!app) continue;                                // not job-related

        const detected = classify(msg.subject, msg.snippet);
        insertEvent.run(app.id, msg.id, msg.subject, msg.from, detected, msg.receivedAt);

        const newStatus = nextStatus(app.status, detected);
        updateApp.run(newStatus, msg.receivedAt, app.id);
        if (newStatus !== app.status) {
            console.log(`[sync] ${app.company}: ${app.status} -> ${newStatus} ("${msg.subject}")`);
            app.status = newStatus;
            updates++;
        }
    }
    return updates;
}

async function syncAllUsers() {
    const users = db.prepare(
        'SELECT * FROM users WHERE google_refresh_token IS NOT NULL'
    ).all();
    for (const user of users) {
        try {
            await syncUser(user);
        } catch (err) {
            console.error(`[sync] failed for ${user.email}:`, err.message);
        }
    }
}

function startEmailSync() {
    cron.schedule('*/15 * * * *', syncAllUsers);
    console.log('Email sync scheduled: every 15 minutes');
}

module.exports = { startEmailSync, syncAllUsers, syncUser };