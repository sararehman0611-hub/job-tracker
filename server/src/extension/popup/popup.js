const API = 'http://localhost:3000';
const STALE_DAYS = 10;      // an 'applied' row older than this gets a "No reply" nudge
const FRESH_EMAIL_DAYS = 3; // an email newer than this shows on the row as a highlight

const $ = (id) => document.getElementById(id);
let allJobs = [];
let filter = 'all';
let pendingDelete = null;   // id awaiting a second click to confirm
let tabJob = null;          // the job scraped from the currently active tab

// ---------- token & views ----------
async function getToken() {
    const { token } = await chrome.storage.local.get('token');
    return token || null;
}

function showView(name) {
    for (const v of ['connect-view', 'main-view', 'detail-view']) {
        $(v).classList.toggle('hidden', v !== name);
    }
    $('page-title').textContent = name === 'detail-view' ? 'Application' : 'Applications';
}

async function init() {
    await applyTheme();
    await clearBadge();
    const token = await getToken();
    $('sync-btn').classList.toggle('hidden', !token);
    showView(token ? 'main-view' : 'connect-view');
    if (token) {
        renderSyncLabel();
        await loadJobs();
        loadCurrentTab();
    }
}

// The service worker counts status changes it spotted while the popup was shut;
// opening the popup is what "seeing" them means.
async function clearBadge() {
    await chrome.storage.local.set({ unseenChanges: 0 });
    chrome.action.setBadgeText({ text: '' });
}

// ---------- api ----------
async function api(path, options = {}) {
    const token = await getToken();
    const res = await fetch(API + path, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token,
            ...options.headers
        }
    });
    if (res.status === 401) {           // token expired/invalid → back to connect view
        await chrome.storage.local.remove('token');
        init();
        throw new Error('unauthorized');
    }
    return res.json();
}

async function loadJobs() {
    try {
        allJobs = await api('/jobs');
        renderSummary();
        renderFilterCounts();
        render();
    } catch (e) { /* handled in api() */ }
}

// ---------- "on this tab" ----------
// Ask the content script what job the active tab is showing. It answers only on
// LinkedIn/Naukri job pages; anywhere else the message has no receiver and the
// send rejects, which is the signal to keep the card hidden.
async function loadCurrentTab() {
    const card = $('tab-card');
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return card.classList.add('hidden');
        const job = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CURRENT_JOB' });
        if (!job?.role || !job?.company) return card.classList.add('hidden');
        tabJob = job;
        renderTabCard();
    } catch (err) {
        card.classList.add('hidden');   // not a job page, or no content script here
    }
}

function alreadyTracked(job) {
    return allJobs.some(j =>
        (job.job_url && j.job_url === job.job_url) ||
        (j.company === job.company && j.role === job.role)
    );
}

function renderTabCard() {
    if (!tabJob) return;
    const card = $('tab-card');
    card.querySelector('.tab-card-job').textContent = tabJob.company + ' · ' + tabJob.role;
    const btn = $('track-btn');
    const tracked = alreadyTracked(tabJob);
    btn.textContent = tracked ? 'Tracked' : 'Track';
    btn.disabled = tracked;
    card.classList.remove('hidden');
}

$('track-btn').addEventListener('click', async () => {
    if (!tabJob) return;
    const btn = $('track-btn');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
        await api('/jobs', { method: 'POST', body: JSON.stringify(tabJob) });
        await loadJobs();
        renderTabCard();
    } catch (e) {
        btn.textContent = 'Failed';
        btn.disabled = false;
    }
});

// ---------- time helpers ----------
// applied_at is SQLite's naive UTC ("2026-09-03 11:04:08"); email received_at is
// already an ISO string with a Z. Normalise both before parsing.
function parseTs(value) {
    if (!value) return null;
    const iso = value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
}

function daysSince(value) {
    const d = parseTs(value);
    return d ? Math.floor((Date.now() - d) / 86400000) : null;
}

// compact form for the right edge of a row: 11m, 6h, 9d
function shortAgo(value) {
    const d = parseTs(value);
    if (!d) return '';
    const mins = Math.floor((Date.now() - d) / 60000);
    if (mins < 60) return Math.max(mins, 1) + 'm';
    if (mins < 1440) return Math.floor(mins / 60) + 'h';
    return Math.floor(mins / 1440) + 'd';
}

function longAgo(value) {
    const days = daysSince(value);
    if (days === null) return '';
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    return days + ' days ago';
}

function isStale(job) {
    return job.status === 'applied' && daysSince(job.applied_at) >= STALE_DAYS;
}

function freshEmail(job) {
    if (!job.latest_email_subject) return null;
    const days = daysSince(job.latest_email_at);
    return days !== null && days < FRESH_EMAIL_DAYS ? job : null;
}

// ---------- avatar colours ----------
// Deterministic per company so a row keeps its colour between renders.
const AVATAR_TONES = ['violet', 'mint', 'blush', 'amber', 'sky', 'sage'];

function toneFor(company) {
    let hash = 0;
    for (const ch of company) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return AVATAR_TONES[hash % AVATAR_TONES.length];
}

// ---------- summary ----------
function countBy(status) {
    return allJobs.filter(j => j.status === status).length;
}

function renderSummary() {
    const active = allJobs.filter(j => j.status !== 'rejected');
    const applied = active.filter(j => ['applied', 'confirmed'].includes(j.status)).length;
    const interview = active.filter(j => ['interview', 'assessment'].includes(j.status)).length;
    const offers = active.filter(j => j.status === 'offer').length;

    $('active-n').textContent = active.length;
    $('summary').querySelector('.summary-label').textContent =
        active.length === 1 ? 'active application' : 'active applications';

    const total = active.length || 1;
    const seg = (n, cls) => n
        ? `<div class="seg ${cls}" style="flex:${n / total}"></div>`
        : '';
    $('progress').innerHTML =
        seg(applied, 'applied') + seg(interview, 'interview') + seg(offers, 'offer') +
        (active.length ? '' : '<div class="seg empty" style="flex:1"></div>');

    const item = (n, cls, label) =>
        `<span class="leg"><i class="dot-${cls}"></i>${n} ${label}</span>`;
    $('legend').innerHTML =
        item(applied, 'applied', 'applied') +
        item(interview, 'interview', interview === 1 ? 'interview' : 'interviews') +
        item(offers, 'offer', offers === 1 ? 'offer' : 'offers');
}

function renderFilterCounts() {
    for (const btn of document.querySelectorAll('#filters .tab')) {
        const f = btn.dataset.f;
        btn.querySelector('b').textContent = f === 'all' ? allJobs.length : countBy(f);
    }
}

// ---------- list ----------
// Rows are grouped by how recently the application was added.
function bucketOf(job) {
    const days = daysSince(job.applied_at);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    return 'Earlier';
}

function render() {
    const list = $('job-list');
    const jobs = allJobs.filter(j => filter === 'all' || j.status === filter);
    list.innerHTML = '';
    if (jobs.length === 0) {
        list.innerHTML = '<p class="empty">No applications here yet.</p>';
        return;
    }

    let lastBucket = null;
    for (const job of jobs) {
        const bucket = bucketOf(job);
        if (bucket !== lastBucket) {
            const h = document.createElement('div');
            h.className = 'group';
            h.textContent = bucket;
            list.appendChild(h);
            lastBucket = bucket;
        }

        const fresh = freshEmail(job);
        const row = document.createElement('div');
        row.className = 'row' + (fresh ? ' flagged' : '');

        const confirming = pendingDelete === job.id;
        row.innerHTML = `
      <div class="avatar ${toneFor(job.company)}">${job.company.slice(0, 2).toUpperCase()}</div>
      <div class="row-info">
        <div class="row-company"></div>
        <div class="row-role"></div>
        <div class="row-note"></div>
      </div>
      <div class="row-right">
        <span class="row-time">${shortAgo(job.applied_at)}</span>
        <button class="icon-btn del ${confirming ? 'danger' : ''}" data-del="${job.id}"
                title="${confirming ? 'Click again to delete' : 'Delete'}">${confirming ? 'Delete?' : '🗑'}</button>
      </div>
    `;
        row.querySelector('.row-company').textContent = job.company;
        row.querySelector('.row-role').textContent = job.role;

        // the third line carries whichever signal matters: a new email, or silence
        const note = row.querySelector('.row-note');
        if (fresh) {
            note.textContent = fresh.latest_email_subject + ' · ' + shortAgo(fresh.latest_email_at);
            note.classList.add('note-fresh');
        } else if (isStale(job)) {
            note.textContent = 'No reply in ' + daysSince(job.applied_at) + ' days';
            note.classList.add('note-stale');
        } else if (job.status !== 'applied') {
            note.textContent = job.status;
            note.classList.add('note-status', 'st-' + job.status);
        } else {
            note.remove();
        }

        row.addEventListener('click', (e) => {
            if (!e.target.closest('[data-del]')) showDetail(job);
        });
        list.appendChild(row);
    }
}

$('job-list').addEventListener('click', async (e) => {
    const delBtn = e.target.closest('[data-del]');
    if (!delBtn) return;
    const id = Number(delBtn.dataset.del);

    if (pendingDelete !== id) {          // first click arms it, second click deletes
        pendingDelete = id;
        render();
        setTimeout(() => { if (pendingDelete === id) { pendingDelete = null; render(); } }, 4000);
        return;
    }
    pendingDelete = null;
    await api('/jobs/' + id, { method: 'DELETE' });
    await loadJobs();
    renderTabCard();
});

// ---------- detail view ----------
const TYPE_LABEL = {
    rejected: 'Rejection',
    offer: 'Offer',
    interview: 'Interview',
    assessment: 'Assessment',
    confirmed: 'Confirmation'
};

async function showDetail(job) {
    showView('detail-view');
    const head = $('detail-head');
    head.innerHTML = `
    <div class="detail-title"></div>
    <div class="detail-sub"></div>
    <span class="badge ${job.status}">${job.status}</span>
  `;
    head.querySelector('.detail-title').textContent = job.role;
    head.querySelector('.detail-sub').textContent =
        job.company + ' · applied ' + longAgo(job.applied_at);

    // notes are written from the on-page widget; this is where they surface
    const noteBox = $('detail-note');
    noteBox.classList.toggle('hidden', !job.notes);
    if (job.notes) noteBox.textContent = job.notes;

    const box = $('detail-events');
    box.innerHTML = '<p class="empty">Loading…</p>';
    try {
        renderEvents(await api('/jobs/' + job.id + '/events'));
    } catch (e) {
        box.innerHTML = '<p class="empty">Could not load email history.</p>';
    }
}

function renderEvents(events) {
    const box = $('detail-events');
    box.innerHTML = '';
    if (!events.length) {
        box.innerHTML = '<p class="empty">No emails matched to this application yet.</p>';
        return;
    }
    for (const ev of events) {
        const row = document.createElement('div');
        row.className = 'event';
        row.innerHTML = `
      <div class="dot ${ev.detected_type || 'none'}"></div>
      <div class="event-body">
        <div class="event-subject"></div>
        <div class="event-meta"></div>
      </div>
    `;
        row.querySelector('.event-subject').textContent = ev.subject || '(no subject)';
        const when = parseTs(ev.received_at)?.toLocaleDateString() || '';
        const type = TYPE_LABEL[ev.detected_type] || 'Update';
        row.querySelector('.event-meta').textContent = [type, when, ev.from_address]
            .filter(Boolean).join(' · ');
        box.appendChild(row);
    }
}

$('back-btn').addEventListener('click', () => showView('main-view'));

// ---------- sync ----------
function renderSyncLabel() {
    chrome.storage.local.get('lastSyncAt').then(({ lastSyncAt }) => {
        const label = $('sync-label');
        if (!lastSyncAt) return label.classList.add('hidden');
        const mins = Math.floor((Date.now() - lastSyncAt) / 60000);
        label.textContent = 'Synced ' + (mins < 1 ? 'just now' : mins + 'm ago');
        label.classList.remove('hidden');
    });
}

$('sync-btn').addEventListener('click', async () => {
    const btn = $('sync-btn');
    btn.disabled = true;
    btn.classList.add('spinning');
    const label = $('sync-label');
    label.classList.remove('hidden');
    try {
        const result = await api('/sync', { method: 'POST' });
        await chrome.storage.local.set({ lastSyncAt: Date.now() });
        label.textContent = result.error
            ? result.error
            : result.statusChanges
                ? result.statusChanges + ' update' + (result.statusChanges === 1 ? '' : 's')
                : 'Synced just now';
        await loadJobs();
        setTimeout(renderSyncLabel, 4000);
    } catch (e) {
        label.textContent = 'Sync failed';
    } finally {
        btn.disabled = false;
        btn.classList.remove('spinning');
    }
});

// ---------- manual entry ----------
function toggleAddForm(open) {
    $('add-form').classList.toggle('hidden', !open);
    $('manual-btn').classList.toggle('hidden', open);
    if (open) $('company').focus();
}

$('manual-btn').addEventListener('click', () => toggleAddForm(true));
$('cancel-add').addEventListener('click', () => {
    $('add-form').reset();
    toggleAddForm(false);
});

$('add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api('/jobs', {
        method: 'POST',
        body: JSON.stringify({
            company: $('company').value,
            role: $('role').value,
            job_url: $('job_url').value || null,
            source: 'manual'
        })
    });
    e.target.reset();
    toggleAddForm(false);
    loadJobs();
});

// ---------- events ----------
$('login-btn').addEventListener('click', () => {
    chrome.tabs.create({ url: API + '/auth/google' });
});

$('save-token-btn').addEventListener('click', async () => {
    const token = $('token-input').value.trim();
    if (!token) return;
    await chrome.storage.local.set({ token });
    $('token-input').value = '';
    init();
});

$('logout-btn').addEventListener('click', async () => {
    await chrome.storage.local.remove('token');
    init();
});

$('filters').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    document.querySelectorAll('#filters .tab').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    filter = btn.dataset.f;
    render();
});

// ---------- theme ----------
async function applyTheme() {
    const { theme } = await chrome.storage.local.get({ theme: 'system' });
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const resolved = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
    document.documentElement.dataset.theme = resolved;
    $('theme-btn').textContent = resolved === 'dark' ? '☀️' : '🌙';
}

$('theme-btn').addEventListener('click', async () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    await chrome.storage.local.set({ theme: next });
    applyTheme();
});

init();
