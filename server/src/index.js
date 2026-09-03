require('dotenv').config();
const { startEmailSync, syncUser } = require('./jobs/emailSync');
const requireAuth = require('./middleware/auth');
const db = require('./db/db');
const express = require('express');
const cors = require('cors');
const jobsRouter = require('./routes/jobs');
const authRouter = require('./routes/auth');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.json({ status: 'JobTrail API running' }));
app.use('/auth', authRouter);
app.use('/jobs', jobsRouter);

const PORT = process.env.PORT || 3000;
app.post('/sync', requireAuth, async (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    if (!user || !user.google_refresh_token) {
        return res.status(400).json({ error: 'No Gmail connection for this user' });
    }
    try {
        const updates = await syncUser(user);
        res.json({ synced: true, statusChanges: updates });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Sync failed: ' + err.message });
    }
});
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
startEmailSync();