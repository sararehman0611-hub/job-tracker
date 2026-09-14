const cron = require('node-cron');
const db = require('../db/db');
const { fetchRecentMessages } = require('../services/gmailService');
const { extractDomain, matchesApplication, classify, nextStatus } = require('../services/matcher');

async function syncUser(user) {
    const apps = await db.all(
        "SELECT * FROM applications WHERE user_id = $1 AND status NOT IN ('rejected','offer')",
        [user.id]
    );
    if (apps.length === 0) return 0;

    const messages = await fetchRecentMessages(user.google_refresh_token);
    let updates = 0;

    // one round trip instead of one per message
    const seenIds = new Set(
        (await db.all(
            'SELECT gmail_message_id FROM email_events WHERE gmail_message_id = ANY($1)',
            [messages.map(m => m.id)]
        )).map(r => r.gmail_message_id)
    );

    for (const msg of messages) {
        if (seenIds.has(msg.id)) continue;                 // already processed

        const domain = extractDomain(msg.from);
        const app = apps.find(a => matchesApplication(domain, msg.from, a));
        if (!app) continue;                                // not job-related

        const detected = classify(msg.subject, msg.snippet);
        await db.run(
            `INSERT INTO email_events
               (application_id, gmail_message_id, subject, from_address, detected_type, received_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (gmail_message_id) DO NOTHING`,
            [app.id, msg.id, msg.subject, msg.from, detected, msg.receivedAt]
        );

        const newStatus = nextStatus(app.status, detected);
        await db.run(
            'UPDATE applications SET status = $1, last_email_at = $2 WHERE id = $3',
            [newStatus, msg.receivedAt, app.id]
        );
        if (newStatus !== app.status) {
            console.log(`[sync] ${app.company}: ${app.status} -> ${newStatus} ("${msg.subject}")`);
            app.status = newStatus;
            updates++;
        }
    }
    return updates;
}

async function syncAllUsers() {
    const users = await db.all(
        'SELECT * FROM users WHERE google_refresh_token IS NOT NULL'
    );
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