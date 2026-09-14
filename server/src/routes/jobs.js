const express = require('express');
const router = express.Router();
const db = require('../db/db');
const requireAuth = require('../middleware/auth');

router.use(requireAuth);   // every route below now requires a valid token

// GET /jobs — list all applications, each with its most recent matched email so
// the popup can show a "New email" flag without a request per row.
router.get('/', async (req, res, next) => {
    try {
        const jobs = await db.all(
            `SELECT a.*,
                    e.subject     AS latest_email_subject,
                    e.received_at AS latest_email_at
             FROM applications a
             LEFT JOIN LATERAL (
                 SELECT subject, received_at
                 FROM email_events
                 WHERE application_id = a.id
                 ORDER BY received_at DESC
                 LIMIT 1
             ) e ON TRUE
             WHERE a.user_id = $1
             ORDER BY a.applied_at DESC`,
            [req.userId]
        );
        res.json(jobs);
    } catch (err) { next(err); }
});

// GET /jobs/:id/events — the email history behind one application
router.get('/:id/events', async (req, res, next) => {
    try {
        const app = await db.one(
            'SELECT id FROM applications WHERE id = $1 AND user_id = $2',
            [req.params.id, req.userId]
        );
        if (!app) return res.status(404).json({ error: 'not found' });

        const events = await db.all(
            `SELECT id, subject, from_address, detected_type, received_at
             FROM email_events WHERE application_id = $1
             ORDER BY received_at DESC`,
            [app.id]
        );
        res.json(events);
    } catch (err) { next(err); }
});

// POST /jobs — add an application
router.post('/', async (req, res, next) => {
    const { company, role, job_url, source, company_domain } = req.body;
    if (!company || !role) {
        return res.status(400).json({ error: 'company and role are required' });
    }
    try {
        const job = await db.one(
            `INSERT INTO applications (user_id, company, role, job_url, source, company_domain)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [req.userId, company, role, job_url || null, source || null, company_domain || null]
        );
        res.status(201).json(job);
    } catch (err) { next(err); }
});

// PATCH /jobs/:id — update status and/or notes
router.patch('/:id', async (req, res, next) => {
    const { status, notes } = req.body;
    const sets = [];
    const values = [];
    if (status !== undefined) { sets.push(`status = $${values.push(status)}`); }
    if (notes !== undefined) { sets.push(`notes = $${values.push(notes || null)}`); }
    if (sets.length === 0) return res.status(400).json({ error: 'nothing to update' });

    try {
        const job = await db.one(
            `UPDATE applications SET ${sets.join(', ')}
             WHERE id = $${values.push(req.params.id)} AND user_id = $${values.push(req.userId)}
             RETURNING *`,
            values
        );
        if (!job) return res.status(404).json({ error: 'not found' });
        res.json(job);
    } catch (err) { next(err); }
});

// DELETE /jobs/:id
// email_events cascades from the schema, so this is a single statement.
router.delete('/:id', async (req, res, next) => {
    try {
        const deleted = await db.run(
            'DELETE FROM applications WHERE id = $1 AND user_id = $2',
            [req.params.id, req.userId]
        );
        if (deleted === 0) return res.status(404).json({ error: 'not found' });
        res.json({ deleted: true });
    } catch (err) { next(err); }
});

module.exports = router;
