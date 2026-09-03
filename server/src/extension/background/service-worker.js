const API = 'http://localhost:3000';
const POLL_MINUTES = 5;

// ---- track-a-job messages from the content script ----
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== 'TRACK_JOB') return;

    (async () => {
        const { token } = await chrome.storage.local.get('token');
        if (!token) return sendResponse({ ok: false, error: 'no-token' });

        try {
            const res = await fetch(API + '/jobs', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify(message.payload)
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            sendResponse({ ok: true, job: await res.json() });
        } catch (err) {
            sendResponse({ ok: false, error: err.message });
        }
    })();

    return true;   // keeps the message channel open for the async response
});

// ---- badge the icon when the server-side sync moves a status ----
// The 15-minute cron does the actual Gmail work; this just notices the result
// by diffing /jobs against the last snapshot we stored.
function schedulePoll() {
    chrome.alarms.create('jt-poll', { periodInMinutes: POLL_MINUTES });
}

chrome.runtime.onInstalled.addListener(schedulePoll);
chrome.runtime.onStartup.addListener(schedulePoll);

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'jt-poll') checkForStatusChanges();
});

async function checkForStatusChanges() {
    const { token, statusSnapshot = {}, unseenChanges = 0 } =
        await chrome.storage.local.get(['token', 'statusSnapshot', 'unseenChanges']);
    if (!token) return;

    let jobs;
    try {
        const res = await fetch(API + '/jobs', {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        if (!res.ok) return;           // server down or token expired — try again next tick
        jobs = await res.json();
    } catch (err) {
        return;
    }

    const snapshot = {};
    let changed = 0;
    for (const job of jobs) {
        snapshot[job.id] = job.status;
        // a job we've never seen isn't a "change" — the first poll just seeds
        if (statusSnapshot[job.id] && statusSnapshot[job.id] !== job.status) changed++;
    }
    await chrome.storage.local.set({ statusSnapshot: snapshot });
    if (changed === 0) return;

    const total = unseenChanges + changed;
    await chrome.storage.local.set({ unseenChanges: total });
    chrome.action.setBadgeText({ text: String(total) });
    chrome.action.setBadgeBackgroundColor({ color: '#185FA5' });
}
