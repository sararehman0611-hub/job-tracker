# JobTrail

A personal tool that tracks job applications and **updates their status automatically**
by reading the user's Gmail inbox. A Chrome extension is the UI; an Express + SQLite
server is the backend. Single-user / personal use — not a product.

The reason the project exists: the tracker updates itself. An email from a recruiter flips
an application from `applied` → `interview` without the user touching anything.

Jobs get in mainly via the extension's scraper; manual entry lives behind the
"Track a job manually" button in the popup footer rather than as an always-visible form.

## Layout

```
job-tracker/
├── extension/              # EMPTY — stray dir, ignore. Real extension is below.
└── server/
    ├── jobtracker.db       # SQLite file (gitignored via *.db, but currently force-added)
    ├── .env                # GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, JWT_SECRET, PORT
    └── src/
        ├── index.js            # Express app entry; mounts routers; starts cron; POST /sync
        ├── db/db.js            # opens SQLite, creates tables on boot
        ├── routes/
        │   ├── auth.js         # /auth/google + /auth/google/callback (OAuth → refresh token + JWT)
        │   └── jobs.js         # GET/POST/PATCH/DELETE /jobs, all scoped to req.userId
        ├── middleware/auth.js  # verifies Bearer JWT → req.userId
        ├── services/
        │   ├── gmailService.js # fetchRecentMessages() — last 2 days of inbox, metadata only
        │   └── matcher.js      # extractDomain / matchesApplication / classify / nextStatus
        ├── jobs/emailSync.js   # cron every 15 min; syncUser() ties gmail + matcher + db together
        └── extension/          # the Chrome extension (Manifest V3)
            ├── manifest.json
            ├── background/service-worker.js  # relays TRACK_JOB → POST /jobs; alarm polls for badge
            ├── content/scraper.js            # LinkedIn/Naukri scrape + floating "Track this job" button
            ├── popup/ (index.html, popup.css, popup.js)
            └── icons/
```

Note: the extension lives at `server/src/extension/`, not at the repo root. `load unpacked`
points there.

## Data model (`server/src/db/db.js`)

- `users` — `email` (unique), `google_refresh_token`
- `applications` — `user_id`, `company`, `company_domain`, `role`, `job_url`, `source`,
  `status` (default `applied`), `applied_at`, `last_email_at`, `notes`

`notes` is added by a migration at the bottom of `db.js` (a `PRAGMA table_info` check plus
`ALTER TABLE`), because `CREATE TABLE IF NOT EXISTS` will not add a column to a table that
already exists. Any future column needs the same treatment.
- `email_events` — `application_id`, `gmail_message_id` (unique, used for dedupe),
  `subject`, `from_address`, `detected_type`, `received_at`. Surfaced in the popup's
  detail view via `GET /jobs/:id/events`.

Status ladder (`matcher.js`): `applied → confirmed → assessment → interview → offer`.
Never moves backward; `rejected` always wins; `rejected`/`offer` are terminal.

## Auth model — two separate things

1. **Gmail permission** = the Google `refresh_token`, stored per user, used by the sync.
2. **API identity** = a 30-day JWT the server issues, pasted into the extension, sent as
   `Authorization: Bearer …` on every request.

## Running it

```bash
cd server
npm install
node src/index.js          # serves http://localhost:3000, starts the 15-min cron
```

Then in Chrome: `chrome://extensions` → Developer mode → Load unpacked →
`server/src/extension/`. Click the popup → Connect Gmail → paste the token from the
success page.

Manual sync without waiting for cron: the `⟳` button in the popup header, or
`POST /sync` with the Bearer token.

**Restart the server after any change under `server/src/`** — there is no auto-reload, and
a stale process silently serves the old routes (`npx nodemon src/index.js` if you want it).
Extension changes instead need the reload button on `chrome://extensions` plus a page
refresh.

No tests. No build step. No linter.

## Status by phase

| Phase | What | State |
|---|---|---|
| 0 | Google Cloud project, OAuth client, `.env` | ✅ done |
| 1 | Backend API (SQLite, `/jobs` CRUD, Express) | ✅ done |
| 2 | Google OAuth (`/auth/google`, JWT middleware) | ✅ done |
| 3 | Extension popup (views, theming, job cards) | ✅ done |
| 5 | Email sync (gmailService, matcher, cron, `/sync`) | ✅ done — verified by self-emailing |
| 4 | Auto-capture from LinkedIn job pages | ✅ done — LinkedIn verified live; Naukri untested |
| 6 | Polish | ✅ done — all four items + delete UI |
| 7 | Deploy | ⬜ not started |

### Phase 4 — auto-capture

Working on LinkedIn as of 2026-09-03. The original bug: LinkedIn ships hashed, per-deploy
CSS class names (`_9f92f1a5`), so the class-based selectors returned `undefined` and the
floating button never appeared.

The real finding is stronger than "classes churn": the LinkedIn job detail pane has **no
`<h1>`, no `[role="heading"]`, and no large-font leaf node** holding the role. There is no
stable DOM anchor for the job title at all. What *is* stable is `document.title`, which
LinkedIn keeps in the shape `"<Role> | <Company> | LinkedIn"` and updates as you click
through the split view.

So `scrapeLinkedIn()` parses `document.title` first (`parseLinkedInDocTitle()`, which also
strips a leading `(3) ` unread counter and handles the older
`"<Company> hiring <Role> in <Location>"` form) and falls back to DOM selectors only if
that fails. The loose `a[href*="/company/"]` fallback was **removed on purpose** — on
`/jobs/` your own sidebar company link would win and mis-attribute the job.

The SPA is watched three ways: a MutationObserver, plus a 1s poll of **both** the URL and
`document.title` (LinkedIn swaps jobs in split view without always changing the URL).

`DEBUG` at the top of `content/scraper.js` turns on `[jt]` console tracing. **Naukri's
selectors are unverified** — they are the original class-based ones and may have rotted the
same way; run the same console probe there before trusting it.

### Phase 6 — polish

All four planned items plus a delete UI:

1. **Sync button** — `⟳` in the popup header calls `POST /sync`; header shows
   "Synced X min ago" (from `lastSyncAt` in `chrome.storage.local`), or the status-change
   count right after a sync.
2. **Email timeline** — clicking a card opens `#detail-view`, which loads the new
   `GET /jobs/:id/events` and renders `email_events` as a dotted timeline colour-coded by
   `detected_type`. This is the first thing that ever displays that table.
3. **Stale nudge** — an `applied` row older than `STALE_DAYS` (10) gets an amber
   "No reply" badge. Frontend only.
4. **Icon badge** — the service worker polls `/jobs` every 5 min on a `chrome.alarms`
   alarm (hence the new `alarms` permission), diffs statuses against `statusSnapshot` in
   storage, and calls `chrome.action.setBadgeText` with the count of changes. Opening the
   popup clears it. The first poll only seeds the snapshot, so it never badges on install.
5. **Delete UI** — a 🗑 button per card, revealed on hover, two-click confirm
   (`confirm()` is avoided because it can dismiss a Chrome popup). Arms for 4s then resets.

### Popup UI (redesigned 2026-09-03, second pass, to a supplied mockup)

Dashboard layout: `Applications` title + "Synced Nm ago"; an **On this tab** capture card;
an active-count with a segmented progress bar and legend; underlined filter tabs carrying
counts; then a divider-separated list grouped **Today / Yesterday / Earlier**, each row
showing company, role, a context note, and a compact age (`11m`, `6h`, `9d`).

- **On this tab** — the popup calls `chrome.tabs.sendMessage(tabId, {type:'GET_CURRENT_JOB'})`
  and the content script replies with what it scraped. Anywhere without the content script
  the send rejects, which is the signal to hide the card. This needs
  `host_permissions` for the LinkedIn/Naukri job paths (content-script `matches` alone do
  not reliably grant `tabs.sendMessage`), so those patterns are listed there too, scoped to
  the same paths rather than the whole domain. The button reads `Tracked` and disables when
  the URL, or the company+role pair, already exists.
- **Row note line** carries one signal, in priority order: a fresh email (green), then a
  stale nudge (amber), then a non-`applied` status. Plain `applied` rows show nothing —
  the note element is removed rather than left blank.
- **Active** excludes `rejected`; the bar groups `applied`+`confirmed`,
  `interview`+`assessment`, and `offer`.
- Avatar tints are theme-aware CSS variables (`--t-<tone>-bg/tx`), pastel in light, deep in
  dark. With few companies the hash can repeat a tone on adjacent rows — cosmetic.

Superseded first pass (stat tiles, pill filters, per-card email banner):

- **Stats row** — Applied / Interviews / Offers. "Applied" is the **total tracked**, read as
  the top of a funnel, not the count of rows whose status is literally `applied`.
- **New-email flag** — a card shows `New email: "<subject>" · <when>` when its most recent
  matched email is under `FRESH_EMAIL_DAYS` (3) old. Fed by `latest_email_subject` /
  `latest_email_at`, which `GET /jobs` now joins in, so the list costs one request, not one
  per card.
- **Stale rows show "No reply" *instead of* their status badge**, not alongside it.
- **Avatar tint** is a hash of the company name over six pastel tones — deterministic, so a
  card keeps its colour across renders.
- `parseTs()` exists because the two timestamp formats differ: `applied_at` is SQLite's
  naive UTC (`2026-09-03 11:04:08`) while `email_events.received_at` is a full ISO string
  with a `Z`. Appending `Z` to the latter produces an invalid date, so both are normalised
  before parsing.
- Active filter pill is high-contrast (dark on light, white on dark), not accent blue.

Bug found and fixed while building this: `DELETE /jobs/:id` had **always** thrown
`FOREIGN KEY constraint failed` for any application with `email_events`, because
`better-sqlite3` enforces foreign keys by default. Nothing had exercised it before — the
popup had no delete UI. It now deletes the child rows first inside a transaction.

### On-page widget states (content script)

The floating widget is rendered inside a **shadow root** — LinkedIn's stylesheet is
aggressive enough to restyle a plain injected button. It has four states:

1. **Detected** — a blue "Track this job" pill carrying the keyboard hint.
2. **Saving** — the same pill dimmed, with a spinner.
3. **Tracked** — a card reading "Tracked as Applied", the company · role, and
   "Saved from this page just now", with **Add a note** and **Undo**. It auto-dismisses
   after 9s; opening the note box cancels that timer.
4. **Error** — a red pill naming the failure, reverting to Detected after 3.5s.

`refresh()` refuses to re-render while the state is `saving` or `tracked`, so a LinkedIn
re-render cannot yank the confirmation away mid-flow.

**Keyboard shortcut** — a `commands` entry (`track-job`) messages the active tab. Mac gets
`Command+Shift+J`; the non-mac default is **`Ctrl+Shift+Y`, not `Ctrl+Shift+J`**, because
the latter is Chrome's own DevTools shortcut and will not register. The button asks the
service worker for the shortcut actually bound (`chrome.commands.getAll()`) and renders
that, so it can never advertise a key that does not work. If nothing is bound, the hint is
simply omitted. Users can rebind at `chrome://extensions/shortcuts`.

**Undo / notes** go through the service worker rather than `fetch` from the content script,
which keeps the JWT out of the page and avoids CORS from linkedin.com. The worker exposes
one `call()` helper and a message map: `TRACK_JOB`, `UNTRACK_JOB`, `UPDATE_JOB`,
`GET_SHORTCUT`, `GET_CURRENT_JOB` (handled in the content script).

`PATCH /jobs/:id` builds its `SET` clause from whichever of `status` / `notes` is present,
so a status-only update does not blank the notes. An empty body is a 400.

### Phase 7 — deploy

Everything currently requires the laptop terminal running. Deploy means:
- Swap SQLite → Postgres (`pg`, rewrite `db.js`, `await` the queries) — Railway/Render have
  ephemeral filesystems that wipe the `.db` on redeploy.
- Push `server/` to GitHub, deploy, set env vars (fresh `JWT_SECRET`), add the production
  callback URL to the Google OAuth client.
- Update the extension's `API` constant + `host_permissions` to the prod URL. Publishing to
  the Web Store triggers Google verification because of the sensitive Gmail scope;
  load-unpacked is fine for personal use.

## Known issues / cleanup backlog

- `server/jobtracker.db`, `.DS_Store`, and `package-lock.json` are staged despite `*.db`
  in `.gitignore` (the db was force-added). Repo has **no commits yet**.
- Express's default error handler returns a **full stack trace with absolute paths** on any
  unhandled route error. Fine locally, must not ship in Phase 7.
- Naukri scraping is unverified (see Phase 4).
- `emailSync.js` inserts an `email_events` row even when `classify()` returns `null`
  (writes `detected_type = null`) and bumps `last_email_at` regardless.
- CORS is wide open (`app.use(cors())`).
- `gmailService` fetches messages one-by-one in a loop (N+1 API calls).
- Empty stray `extension/` dir at repo root.

## Conventions

- CommonJS (`require`), not ESM.
- 4-space indent, single quotes, semicolons.
- `better-sqlite3` — synchronous, prepared statements (`db.prepare(...).get/all/run`).
- Every `/jobs` query is filtered by `user_id = req.userId`; keep it that way.
