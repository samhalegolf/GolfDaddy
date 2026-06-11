# Clarity Golf Long-Term Structure

## Direction

Clarity Golf should move from a local prototype into a small hosted app without breaking the current single-file build, saved browser data, or Green Wand/GPS work.

The safest structure is three layers:

1. Static hosted app
2. Tiny cloud data layer
3. Support loop that captures context for Codex fixes

## Recommended First Architecture

### Hosting

Use static hosting first. The current app is mostly `index.html`, local assets, CSS, and scripts, so it does not need a full backend to go live.

Good first choices:

- Netlify: simple static deploys, custom domains/SSL, deploy previews, functions, Blob storage, and database options on the same platform.
- Vercel: strong static/app hosting, preview URLs, custom domains, and serverless functions if the app becomes more framework-based later.

Recommendation for this repo: start with Netlify or Vercel static hosting, not a custom server.

### Cloud Storage

Start very small. Store only data that must survive across devices or support cases.

Minimum cloud tables/buckets:

- `profiles`: player/account basics, not full personal data unless needed
- `rounds`: course, date, hole state, score state
- `shot_events`: planned/result shots, tied to a round and course
- `practice_captures`: launch monitor imports and normalized rows
- `support_tickets`: user-reported issue plus app context
- `support_attachments`: optional screenshot/log uploads

Recommendation: Supabase is the best fit for first cloud storage because it gives Postgres, Auth, file storage, and row-level security in one place. Keep localStorage as an offline/cache layer, then sync selected records.

### Support That Feeds Codex

Add a small in-app Support button that creates a structured support package:

- app name/version/cache-bust
- current route/module
- browser/device info
- active course label
- last action if available
- redacted local storage summary
- recent console errors
- optional screenshot
- user note: "what happened" and "what I expected"

Support flow:

1. User taps Support.
2. App creates a support ticket in cloud storage.
3. A serverless function also creates a GitHub issue or sends an email/slack alert.
4. Codex can later read the ticket/issue and reproduce from the attached context.

Do not send raw precise location, account passwords, full localStorage dumps, or private personal data by default.

## Migration Plan

### Phase 1: Deploy Current App

- Create a git repo for this folder.
- Add a static hosting config.
- Deploy `index.html`, `assets/`, `scripts/`, `styles/`, and vendor Leaflet files.
- Verify home, GPS, course picker, Data Hub, Practice Data, and Green Wand.
- Add cache headers that make HTML update quickly while assets can be cached longer.

### Phase 2: Add Cloud Foundation

- Create Supabase project.
- Add tables for `support_tickets` first.
- Add one serverless endpoint: `POST /api/support-ticket`.
- Keep shot/course/practice data in localStorage during this phase.
- Add support modal inside the app.

### Phase 3: Sync Small App Data

- Add account/auth only if the app needs cross-device persistence.
- Sync selected course/practice records to Supabase.
- Keep legacy `gd_*` localStorage keys as read fallback.
- Add explicit export/import backup before any storage migration.

### Phase 4: Codex Fix Loop

- Every support ticket gets a stable ID.
- Every deployed build gets a build ID.
- Every fix references the ticket ID.
- Keep a `SUPPORT_FIX_LOG.md` or GitHub issue trail so Codex can reason from past failures.

## Files To Add Later

```txt
netlify.toml or vercel.json
functions/support-ticket.js
scripts/clarity-cloud.js
scripts/clarity-support.js
styles/clarity-support.css
SUPPORT_FIX_LOG.md
```

## Guardrails

- Do not migrate `gd_*` storage keys until a backup/export path exists.
- Do not rename internal globals without aliases.
- Do not send full browser storage to support.
- Do not make Green Wand cloud-dependent.
- Keep the app usable offline or with cloud unavailable for GPS/play basics.

## Near-Term Decision

Choose one of these:

1. Netlify + Supabase: simplest all-around path for static hosting, support endpoint, and small storage.
2. Vercel + Supabase: best if the app later becomes a Next.js/React product.
3. Firebase only: good Google-native option, but less clean for relational golf data and support diagnostics.

Recommended: Netlify + Supabase for the next build step.
