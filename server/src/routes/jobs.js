const express = require('express');
const router = express.Router();
const db = require('../db/db');
const requireAuth = require('../middleware/auth');

router.use(requireAuth);   // every route below now requires a valid token

// GET /jobs — list all applications, each with its most recent matched email so
// the popup can show a "New email" banner without a request per card.
router.get('/', (req, res) => {
    const jobs = db
        .prepare(
            `SELECT a.*,
                    e.subject     AS latest_email_subject,
                    e.received_at AS latest_email_at
             FROM applications a
             LEFT JOIN email_events e ON e.id = (
                 SELECT id FROM email_events
                 WHERE application_id = a.id
                 ORDER BY received_at DESC LIMIT 1
             )
             WHERE a.user_id = ?
             ORDER BY a.applied_at DESC`
        )
        .all(req.userId);
    res.json(jobs);
});

// GET /jobs/:id/events — the email history behind one application
router.get('/:id/events', (req, res) => {
    const app = db
        .prepare('SELECT id FROM applications WHERE id = ? AND user_id = ?')
        .get(req.params.id, req.userId);
    if (!app) return res.status(404).json({ error: 'not found' });

    const events = db
        .prepare(
            `SELECT id, subject, from_address, detected_type, received_at
             FROM email_events WHERE application_id = ?
             ORDER BY received_at DESC`
        )
        .all(app.id);
    res.json(events);
});

// POST /jobs — add an application
router.post('/', (req, res) => {
    const { company, role, job_url, source, company_domain } = req.body;
    if (!company || !role) {
        return res.status(400).json({ error: 'company and role are required' });
    }
    const result = db
        .prepare(
            'INSERT INTO applications (user_id, company, role, job_url, source, company_domain) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(req.userId, company, role, job_url || null, source || null, company_domain || null);
    const job = db.prepare('SELECT * FROM applications WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(job);
});

// PATCH /jobs/:id — update status
router.patch('/:id', (req, res) => {
    const { status } = req.body;
    const result = db
        .prepare('UPDATE applications SET status = ? WHERE id = ? AND user_id = ?')
        .run(status, req.params.id, req.userId);
    if (result.changes === 0) return res.status(404).json({ error: 'not found' });
    res.json(db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id));
});

// DELETE /jobs/:id
// email_events.application_id is a foreign key and better-sqlite3 enforces them,
// so the child rows have to go first or the delete throws.
const deleteApplication = db.transaction((id, userId) => {
    const owned = db
        .prepare('SELECT id FROM applications WHERE id = ? AND user_id = ?')
        .get(id, userId);
    if (!owned) return false;
    db.prepare('DELETE FROM email_events WHERE application_id = ?').run(owned.id);
    db.prepare('DELETE FROM applications WHERE id = ?').run(owned.id);
    return true;
});

router.delete('/:id', (req, res) => {
    if (!deleteApplication(req.params.id, req.userId)) {
        return res.status(404).json({ error: 'not found' });
    }
    res.json({ deleted: true });
});

module.exports = router;