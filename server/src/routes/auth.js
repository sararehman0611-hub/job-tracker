const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const jwt = require('jsonwebtoken');
const db = require('../db/db');

function makeOAuthClient() {
    return new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        'http://localhost:3000/auth/google/callback'
    );
}

// Step A: send the user to Google's consent screen
router.get('/google', (req, res) => {
    const oauth2Client = makeOAuthClient();
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',   // ask for a refresh token
        prompt: 'consent',        // force Google to send it every time
        scope: [
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/userinfo.email'
        ]
    });
    res.redirect(url);
});

// Step B: Google sends the user back here with a one-time code
router.get('/google/callback', async (req, res) => {
    try {
        const { code } = req.query;
        if (!code) return res.status(400).send('Missing code');

        const oauth2Client = makeOAuthClient();

        // Exchange the code for tokens
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        // Ask Google who just logged in
        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const { data: profile } = await oauth2.userinfo.get();

        // Create or update the user, storing the refresh token
        db.prepare(`
      INSERT INTO users (email, google_refresh_token)
      VALUES (?, ?)
      ON CONFLICT(email) DO UPDATE SET
        google_refresh_token = COALESCE(excluded.google_refresh_token, google_refresh_token)
    `).run(profile.email, tokens.refresh_token || null);

        const user = db.prepare('SELECT * FROM users WHERE email = ?').get(profile.email);

        // Issue our own token for the extension to use
        const appToken = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
            expiresIn: '30d'
        });

        // Show it on a simple success page (the extension automates this later)
        res.send(`
      <html><body style="font-family: sans-serif; max-width: 480px; margin: 80px auto;">
        <h2>Connected as ${profile.email}</h2>
        <p>Copy this token into the extension:</p>
        <textarea rows="5" style="width:100%">${appToken}</textarea>
        <p>You can close this tab afterwards.</p>
      </body></html>
    `);
    } catch (err) {
        console.error('OAuth callback error:', err);
        res.status(500).send('Authentication failed — check the server terminal for details.');
    }
});

module.exports = router;