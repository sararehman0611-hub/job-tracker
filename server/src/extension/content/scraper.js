// JobTrail content script — injects a "Track this job" button on
// LinkedIn / Naukri job pages and scrapes the role + company.
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

function scrape() {
    const host = location.hostname;
    let result = {};
    if (host.includes('linkedin.com')) result = scrapeLinkedIn();
    else if (host.includes('naukri.com')) result = scrapeNaukri();
    log('scrape ->', result);
    return result;
}

// The popup asks the active tab what job it is showing, so it can offer a
// one-click Track without the user having to find the floating button.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type !== 'GET_CURRENT_JOB') return;
    const { title, company } = scrape();
    sendResponse(
        title && company
            ? { role: title, company, job_url: location.href.split('?')[0], source: siteName() }
            : null
    );
});

function siteName() {
    return location.hostname.includes('linkedin') ? 'LinkedIn' : 'Naukri';
}

// ---- floating button ----
let btn = null;

function ensureButton() {
    if (btn && document.body.contains(btn)) return btn;
    btn = document.createElement('button');
    btn.id = 'jt-track-btn';
    btn.textContent = '💼 Track this job';
    Object.assign(btn.style, {
        position: 'fixed', bottom: '24px', right: '24px', zIndex: 2147483647,
        padding: '10px 16px', borderRadius: '999px', border: 'none',
        background: '#185FA5', color: '#fff', fontSize: '14px',
        fontFamily: 'system-ui, sans-serif', cursor: 'pointer',
        boxShadow: '0 4px 14px rgba(0,0,0,0.25)'
    });
    btn.addEventListener('click', onTrackClick);
    document.body.appendChild(btn);
    return btn;
}

function setButtonState(text, disabled = false) {
    ensureButton();
    btn.textContent = text;
    btn.disabled = disabled;
    btn.style.opacity = disabled ? '0.7' : '1';
}

function onTrackClick() {
    const { title, company } = scrape();
    if (!title || !company) {
        setButtonState('⚠️ Could not read job details');
        setTimeout(() => setButtonState('💼 Track this job'), 2500);
        return;
    }
    setButtonState('Saving...', true);
    chrome.runtime.sendMessage(
        {
            type: 'TRACK_JOB',
            payload: {
                role: title.trim(),
                company: company.trim(),
                job_url: location.href.split('?')[0],
                source: siteName()
            }
        },
        (response) => {
            if (response?.ok) {
                setButtonState('✓ Tracked!', true);
                setTimeout(() => setButtonState('💼 Track this job'), 3000);
            } else {
                setButtonState(response?.error === 'no-token' ? '🔑 Log in via the popup first' : '✗ Failed — is the server on?');
                setTimeout(() => setButtonState('💼 Track this job'), 3000);
            }
        }
    );
}

// ---- show/hide as the user navigates (LinkedIn is a SPA) ----
function refresh() {
    const { title, company } = scrape();
    if (title && company) {
        ensureButton();
        btn.style.display = 'block';
    } else if (btn) {
        btn.style.display = 'none';
    }
}

const debouncedRefresh = () => {
    clearTimeout(window.__jtDebounce);
    window.__jtDebounce = setTimeout(refresh, 500);
};

// LinkedIn re-renders the detail pane without a full navigation, so watch the
// DOM, the URL and the document title (which changes even when the URL doesn't).
const observer = new MutationObserver(debouncedRefresh);
observer.observe(document.documentElement, { childList: true, subtree: true });

let lastKey = location.href + ' ' + document.title;
setInterval(() => {
    const key = location.href + ' ' + document.title;
    if (key !== lastKey) {
        lastKey = key;
        log('page changed ->', location.href, '|', document.title);
        debouncedRefresh();
    }
}, 1000);

refresh();
