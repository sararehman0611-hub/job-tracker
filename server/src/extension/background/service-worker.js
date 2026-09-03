const API = 'http://localhost:3000';
const POLL_MINUTES = 5;

// ---- authenticated calls on behalf of the content script ----
// The content script runs on linkedin.com, so it can't call the API directly
// without CORS trouble, and it shouldn't hold the token. It asks here instead.
async function call(path, options = {}) {
    const { token } = await chrome.storage.local.get('token');
    if (!token) return { ok: false, error: 'no-token' };
    try {
        const res = await fetch(API + path, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token,
                ...options.headers
            }
        });
        if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
        return { ok: true, body: res.status === 204 ? null : await res.json() };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const handler = {
        TRACK_JOB: async () => {
            const r = await call('/jobs', { method: 'POST', body: JSON.stringify(message.payload) });
            return r.ok ? { ok: true, job: r.body } : r;
        },
        UNTRACK_JOB: async () => call('/jobs/' + message.id, { method: 'DELETE' }),
        UPDATE_JOB: async () => {
            const r = await call('/jobs/' + message.id, {
                method: 'PATCH', body: JSON.stringify(message.patch)
            });
            return r.ok ? { ok: true, job: r.body } : r;
        },
        GET_SHORTCUT: async () => {
            const commands = await chrome.commands.getAll();
            const cmd = commands.find(c => c.name === 'track-job');
            return { shortcut: prettyShortcut(cmd?.shortcut) };
        }
    }[message.type];

    if (!handler) return;
    handler().then(sendResponse);
    return true;   // keeps the message channel open for the async response
});

// Chrome hands back e.g. "Command+Shift+J" / "Ctrl+Shift+Y", or "" when nothing
// bound (the key was already taken, or the user cleared it).
function prettyShortcut(shortcut) {
    if (!shortcut) return '';
    return shortcut
        .replace(/Command|Cmd|MacCtrl/g, '⌘')
        .replace(/Shift/g, '⇧')
        .replace(/Alt|Option/g, '⌥')
        .replace(/Ctrl|Control/g, '⌃')
        .replace(/\+/g, '');
}

// ---- keyboard command ----
chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'track-job') return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    // no receiver on a non-job page; the rejection is expected
    chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_TRACK' }).catch(() => { });
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
    const { statusSnapshot = {}, unseenChanges = 0 } =
        await chrome.storage.local.get(['statusSnapshot', 'unseenChanges']);

    const res = await call('/jobs');
    if (!res.ok) return;             // server down or token expired — try next tick

    const snapshot = {};
    let changed = 0;
    for (const job of res.body) {
        snapshot[job.id] = job.status;
        // a job we've never seen isn't a "change" — the first poll just seeds
        if (statusSnapshot[job.id] && statusSnapshot[job.id] !== job.status) changed++;
    }
    await chrome.storage.local.set({ statusSnapshot: snapshot });
    if (changed === 0) return;

    const total = unseenChanges + changed;
    await chrome.storage.local.set({ unseenChanges: total });
    chrome.action.setBadgeText({ text: String(total) });
    chrome.action.setBadgeBackgroundColor({ color: '#2d43b8' });
}
