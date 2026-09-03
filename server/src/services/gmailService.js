const { google } = require('googleapis');

function makeClientForUser(refreshToken) {
    const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET
    );
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    return google.gmail({ version: 'v1', auth: oauth2Client });
}

// Returns recent messages as [{ id, from, subject, snippet, receivedAt }]
async function fetchRecentMessages(refreshToken, days = 2) {
    const gmail = makeClientForUser(refreshToken);

    const listRes = await gmail.users.messages.list({
        userId: 'me',
        q: `newer_than:${days}d in:inbox`,
        maxResults: 50
    });

    const ids = listRes.data.messages || [];
    const messages = [];

    for (const { id } of ids) {
        const msg = await gmail.users.messages.get({
            userId: 'me',
            id,
            format: 'metadata',
            metadataHeaders: ['From', 'Subject', 'Date']
        });

        const headers = {};
        for (const h of msg.data.payload.headers) headers[h.name.toLowerCase()] = h.value;

        messages.push({
            id,
            from: headers.from || '',
            subject: headers.subject || '',
            snippet: msg.data.snippet || '',
            receivedAt: new Date(Number(msg.data.internalDate)).toISOString()
        });
    }
    return messages;
}

module.exports = { fetchRecentMessages };