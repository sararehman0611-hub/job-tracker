// JobTrail content script — scrapes the role + company from LinkedIn / Naukri
// job pages and offers a floating widget to track them.
//
// LinkedIn ships hashed, per-deploy CSS class names (e.g. `_9f92f1a5`), and the
// job detail pane has no <h1>, no [role="heading"] and no large-font leaf node
// holding the role — so class- and heading-based scraping is a dead end there.
// document.title is the reliable source: LinkedIn keeps it in the shape
// "<Role> | <Company> | LinkedIn" and updates it as you click through the split
// view. DOM selectors are kept as a fallback for layouts that still have them.
//
// Set DEBUG = true and watch the page console for [jt] lines.

const DEBUG = false;
const log = (...args) => DEBUG && console.log('[jt]', ...args);

log('scraper loaded on', location.href);

// ---- helpers ----
function textOf(el) {
    if (!el) return null;
    // first line only, collapse whitespace — LinkedIn crams metadata into siblings
    const text = (el.textContent || '').split('\n')[0].replace(/\s+/g, ' ').trim();
    return text || null;
}

function firstMatch(root, selectors) {
    for (const sel of selectors) {
        const el = root.querySelector(sel);
        if (el && textOf(el)) return el;
    }
    return null;
}

// "Software Engineer II | Hewlett Packard Enterprise | LinkedIn"
//     -> { title: 'Software Engineer II', company: 'Hewlett Packard Enterprise' }
// "Acme Corp hiring Backend Engineer in Bengaluru | LinkedIn"
//     -> { title: 'Backend Engineer', company: 'Acme Corp' }
// "Jobs | LinkedIn"  (nothing open) -> {}
function parseLinkedInDocTitle() {
    // drop a leading unread counter like "(3) " and the trailing " | LinkedIn"
    const raw = document.title.replace(/^\(\d+\+?\)\s*/, '').trim();
    const parts = raw.split('|').map(s => s.trim()).filter(Boolean);
    if (parts.pop() !== 'LinkedIn') return {};

    if (parts.length === 1) {
        const hiring = parts[0].match(/^(.+?)\s+hiring\s+(.+?)(?:\s+in\s+.+)?$/i);
        if (hiring) return { title: hiring[2].trim(), company: hiring[1].trim() };
        return {};   // bare "Jobs" / "Feed" — no job is open
    }
    if (parts.length < 2) return {};

    // a role containing "|" leaves extra leading segments; company is always last
    const company = parts.pop();
    return { title: parts.join(' | '), company };
}

// ---- site-specific scrapers ----
function scrapeLinkedIn() {
    // document.title always describes the job currently open in the pane, so it
    // wins over the DOM — a stray a[href*="/company/"] in the left sidebar would
    // otherwise attribute the job to the wrong company.
    const fromTitle = parseLinkedInDocTitle();

    const pane =
        document.querySelector('.jobs-search__job-details--wrapper') ||
        document.querySelector('.jobs-details') ||
        document.querySelector('.job-view-layout') ||
        document.querySelector('main') ||
        document;

    const titleEl = firstMatch(pane, [
        '.job-details-jobs-unified-top-card__job-title h1',
        '.job-details-jobs-unified-top-card__job-title',
        'h1 a',
        'h1',
    ]);
    const companyEl = firstMatch(pane, [
        '.job-details-jobs-unified-top-card__company-name a',
        '.jobs-unified-top-card__company-name a',
        '.job-details-jobs-unified-top-card__company-name',
    ]);

    return {
        title: fromTitle.title || textOf(titleEl),
        company: fromTitle.company || textOf(companyEl)
    };
}

function scrapeNaukri() {
    const titleEl = firstMatch(document, [
        'h1[class*="jd-header-title"]',
        'section[class*="jd-header"] h1',
        'h1',
    ]);
    const companyEl = firstMatch(document, [
        '[class*="jd-header-comp-name"] a',
        'div[class*="comp-name"] a',
        'a[href*="-jobs-careers-"]',
        '[class*="jd-header-comp-name"]',
    ]);
    return { title: textOf(titleEl), company: textOf(companyEl) };
}

function siteName() {
    return location.hostname.includes('linkedin') ? 'LinkedIn' : 'Naukri';
}

function scrape() {
    const host = location.hostname;
    let result = {};
    if (host.includes('linkedin.com')) result = scrapeLinkedIn();
    else if (host.includes('naukri.com')) result = scrapeNaukri();
    log('scrape ->', result);
    return result;
}

function currentJob() {
    const { title, company } = scrape();
    if (!title || !company) return null;
    return {
        role: title.trim(),
        company: company.trim(),
        job_url: location.href.split('?')[0],
        source: siteName()
    };
}

// ---- messages from the popup and the service worker ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'GET_CURRENT_JOB') {
        sendResponse(currentJob());
        return;
    }
    if (msg.type === 'TRIGGER_TRACK') {   // the keyboard command fired
        if (state === 'idle') onTrack();
        return;
    }
});

// ---------------------------------------------------------------------------
// Widget
//
// Rendered inside a shadow root: LinkedIn's stylesheet is aggressive and would
// otherwise reach in and restyle the button.
// ---------------------------------------------------------------------------
const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; margin: 0; font-family: system-ui, -apple-system, sans-serif; }

.pill {
  display: flex; align-items: center; gap: 10px;
  border: none; border-radius: 12px; cursor: pointer;
  background: #2d43b8; color: #fff;
  font-size: 15px; font-weight: 650;
  padding: 14px 18px;
  box-shadow: 0 6px 20px rgba(0,0,0,.28);
}
.pill:hover { background: #243694; }
.pill.busy { background: #3a4a8f; color: #cdd6f5; cursor: default; }
.pill.err  { background: #7a2626; }

.kbd {
  font-size: 12px; font-weight: 500;
  color: #c3cdf6; letter-spacing: .06em;
}
.pill.busy .kbd { color: #93a1cf; }

.spinner {
  width: 15px; height: 15px; flex-shrink: 0;
  border: 2px solid rgba(255,255,255,.28);
  border-top-color: #fff; border-radius: 50%;
  animation: spin .7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.card {
  width: 330px;
  background: #1b1b19; color: #f2f1ea;
  border: 1px solid #3a3a35; border-radius: 14px;
  padding: 16px 18px;
  box-shadow: 0 10px 34px rgba(0,0,0,.45);
}
.card-head { display: flex; align-items: center; gap: 10px; }
.dot { width: 13px; height: 13px; border-radius: 50%; background: #6ece8a; flex-shrink: 0; }
.card-title { font-size: 15px; font-weight: 650; }
.card-body { color: #a3a199; font-size: 13px; line-height: 1.5; margin-top: 9px; }
.card-body .job { color: #d7d5cc; }

.actions { display: flex; gap: 18px; margin-top: 14px; }
.link {
  border: none; background: none; padding: 0; cursor: pointer;
  font-size: 13.5px; font-weight: 500; color: #8d8b82;
}
.link.note { color: #6ece8a; }
.link:hover { text-decoration: underline; }

.note-box { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
textarea {
  width: 100%; resize: vertical; min-height: 62px;
  background: #121210; color: #f2f1ea;
  border: 1px solid #3a3a35; border-radius: 9px;
  padding: 9px 10px; font-size: 13px; font-family: inherit;
}
textarea:focus { outline: none; border-color: #6ece8a; }
.note-actions { display: flex; gap: 8px; justify-content: flex-end; }
.btn-sm {
  border: 1px solid #3a3a35; background: none; color: #d7d5cc;
  border-radius: 8px; padding: 6px 13px; font-size: 12.5px; cursor: pointer;
}
.btn-sm.go { background: #6ece8a; border-color: #6ece8a; color: #10240f; font-weight: 600; }
.saved { color: #6ece8a; font-size: 12.5px; margin-top: 10px; }
`;

let host = null;
let shadow = null;
let state = 'hidden';        // hidden | idle | saving | tracked | error
let trackedJob = null;       // the row the API just created, for Undo / notes
let shortcutLabel = '';
let dismissTimer = null;

function ensureHost() {
    if (host && document.body.contains(host)) return;
    host = document.createElement('div');
    host.id = 'jt-root';
    Object.assign(host.style, {
        position: 'fixed', bottom: '24px', right: '24px',
        zIndex: '2147483647', display: 'block'
    });
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    shadow.appendChild(style);
    shadow.appendChild(document.createElement('div'));
    document.body.appendChild(host);
}

function paint(nodeHtml, wire) {
    ensureHost();
    const slot = shadow.lastElementChild;
    slot.innerHTML = nodeHtml;
    if (wire) wire(slot);
}

function setState(next, opts = {}) {
    state = next;
    clearTimeout(dismissTimer);

    if (next === 'hidden') {
        if (host) host.style.display = 'none';
        return;
    }
    ensureHost();
    host.style.display = 'block';

    if (next === 'idle') return renderIdle();
    if (next === 'saving') return renderSaving();
    if (next === 'tracked') return renderTracked();
    if (next === 'error') return renderError(opts.message);
}

// 1 — detected
function renderIdle() {
    paint(
        `<button class="pill" id="go">Track this job${shortcutLabel ? `<span class="kbd">${shortcutLabel}</span>` : ''}</button>`,
        (root) => root.querySelector('#go').addEventListener('click', onTrack)
    );
}

// 2 — saving
function renderSaving() {
    paint('<div class="pill busy"><span class="spinner"></span>Saving…</div>');
}

// 3 — tracked
function renderTracked() {
    const status = (trackedJob?.status || 'applied');
    paint(`
    <div class="card">
      <div class="card-head">
        <span class="dot"></span>
        <span class="card-title">Tracked as ${status[0].toUpperCase() + status.slice(1)}</span>
      </div>
      <div class="card-body">
        <div class="job"></div>
        <div>Saved from this page just now</div>
      </div>
      <div class="actions">
        <button class="link note" id="note">Add a note</button>
        <button class="link" id="undo">Undo</button>
      </div>
    </div>
  `, (root) => {
        root.querySelector('.job').textContent =
            trackedJob.company + ' · ' + trackedJob.role;
        root.querySelector('#note').addEventListener('click', renderNoteBox);
        root.querySelector('#undo').addEventListener('click', onUndo);
    });

    // stays long enough to read and act on, then gets out of the way
    dismissTimer = setTimeout(() => { if (state === 'tracked') setState('idle'); }, 9000);
}

function renderNoteBox() {
    clearTimeout(dismissTimer);
    paint(`
    <div class="card">
      <div class="card-head">
        <span class="dot"></span>
        <span class="card-title">Add a note</span>
      </div>
      <div class="card-body"><div class="job"></div></div>
      <div class="note-box">
        <textarea id="txt" placeholder="Referred by…, salary range, follow-up date"></textarea>
        <div class="note-actions">
          <button class="btn-sm" id="cancel">Cancel</button>
          <button class="btn-sm go" id="save">Save note</button>
        </div>
      </div>
    </div>
  `, (root) => {
        root.querySelector('.job').textContent =
            trackedJob.company + ' · ' + trackedJob.role;
        const txt = root.querySelector('#txt');
        txt.value = trackedJob.notes || '';
        txt.focus();
        root.querySelector('#cancel').addEventListener('click', renderTracked);
        root.querySelector('#save').addEventListener('click', () => onSaveNote(txt.value));
    });
}

function renderError(message) {
    paint(`<button class="pill err" id="go">${message || 'Could not save'}</button>`,
        (root) => root.querySelector('#go').addEventListener('click', onTrack));
    dismissTimer = setTimeout(() => setState('idle'), 3500);
}

// ---- actions ----
function send(message) {
    return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

async function onTrack() {
    const job = currentJob();
    if (!job) return setState('error', { message: 'Could not read job details' });

    setState('saving');
    const res = await send({ type: 'TRACK_JOB', payload: job });
    if (res?.ok) {
        trackedJob = res.job;
        setState('tracked');
    } else if (res?.error === 'no-token') {
        setState('error', { message: 'Log in via the popup first' });
    } else {
        setState('error', { message: 'Failed — is the server on?' });
    }
}

async function onUndo() {
    if (!trackedJob) return setState('idle');
    setState('saving');
    const res = await send({ type: 'UNTRACK_JOB', id: trackedJob.id });
    trackedJob = null;
    setState(res?.ok ? 'idle' : 'error', { message: 'Could not undo' });
}

async function onSaveNote(text) {
    const res = await send({
        type: 'UPDATE_JOB', id: trackedJob.id, patch: { notes: text.trim() }
    });
    if (res?.ok) trackedJob = res.job;
    paint(`
    <div class="card">
      <div class="card-head"><span class="dot"></span><span class="card-title">${res?.ok ? 'Note saved' : 'Could not save note'}</span></div>
      <div class="card-body"><div class="job"></div></div>
    </div>
  `, (root) => {
        root.querySelector('.job').textContent = trackedJob.company + ' · ' + trackedJob.role;
    });
    dismissTimer = setTimeout(() => setState('idle'), 2200);
}

// ---- show/hide as the user navigates (LinkedIn is a SPA) ----
function refresh() {
    // never yank the widget out from under someone mid-flow
    if (state === 'saving' || state === 'tracked') return;
    setState(currentJob() ? 'idle' : 'hidden');
}

const debouncedRefresh = () => {
    clearTimeout(window.__jtDebounce);
    window.__jtDebounce = setTimeout(refresh, 500);
};

const observer = new MutationObserver(debouncedRefresh);
observer.observe(document.documentElement, { childList: true, subtree: true });

// LinkedIn re-renders the detail pane without a full navigation, so watch the
// URL and the document title too (the title changes even when the URL doesn't).
let lastKey = location.href + ' ' + document.title;
setInterval(() => {
    const key = location.href + ' ' + document.title;
    if (key !== lastKey) {
        lastKey = key;
        trackedJob = null;
        log('page changed ->', location.href, '|', document.title);
        debouncedRefresh();
    }
}, 1000);

// the hint on the button reflects whatever key is actually bound, so it can't
// advertise a shortcut the user has rebound or Chrome refused to register
send({ type: 'GET_SHORTCUT' }).then((res) => {
    shortcutLabel = res?.shortcut || '';
    if (state === 'idle') renderIdle();
});

refresh();
