require('dotenv').config();
const { startEmailSync, syncUser } = require('./jobs/emailSync');
const requireAuth = require('./middleware/auth');
const db = require('./db/db');
const express = require('express');
const cors = require('cors');
const jobsRouter = require('./routes/jobs');
const authRouter = require('./routes/auth');

const app = express();

// Only the extension calls this API. Both the popup and the service worker send
// Origin: chrome-extension://<id>, so that is the whole allowlist. Requests with
// no Origin at all (curl, and the OAuth redirect Google sends the browser to)
// are left alone — CORS is a browser rule, not an auth check.
const EXTENSION_ID = process.env.EXTENSION_ID || 'ikckplflpjebbfeppemcpkpmnkpilicn';
const allowedOrigins = ['chrome-extension://' + EXTENSION_ID];

app.use(cors({
    // `false` simply omits the allow-origin header, which is what makes the
    // browser block the response. Erroring here instead would turn every stray
    // crawler into a logged 500.
    origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin))
}));
app.use(express.json());

app.get('/', (req, res) => res.json({ status: 'JobTrail API running' }));
app.use('/auth', authRouter);
app.use('/jobs', jobsRouter);

app.post('/sync', requireAuth, async (req, res, next) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
    if (!user || !user.google_refresh_token) {
        return res.status(400).json({ error: 'No Gmail connection for this user' });
    }
    try {
        const updates = await syncUser(user);
        res.json({ synced: true, statusChanges: updates });
    } catch (err) {
        next(err);
    }
});

// Must come last, and must take four arguments — that is how Express recognises
// an error handler. Without it the default handler replies with the stack trace,
// absolute paths and all.
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
startEmailSync();
