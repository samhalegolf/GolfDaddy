# Clarity Caddie Deploy Handover

Updated: 2026-06-01 16:28 NZST

## Project

- App name: `Clarity Caddie`
- Netlify project: `clarity-caddie`
- Production URL: `https://clarity-caddie.netlify.app/`
- Netlify admin: `https://app.netlify.com/projects/clarity-caddie`
- Project ID: `998dc390-a3da-4fe1-95c3-c441abcca54e`
- Netlify account: `Samuel Hale <samhalegolf@gmail.com>`
- Netlify team: `Sam Hale Golf`
- Local project path: `/Users/samhalegolf/Documents/Codex/2026-05-21/files-mentioned-by-the-user-golf/golf-daddy-handoff-cleaned-current`
- Local app URL: `http://localhost:5173/`
- Local run command: `npm start`

## Current Production Deploy

- Deploy ID: `6a1d08ca742f62b1fffbe194`
- Deploy URL: `https://6a1d08ca742f62b1fffbe194--clarity-caddie.netlify.app`
- Deploy logs: `https://app.netlify.com/projects/clarity-caddie/deploys/6a1d08ca742f62b1fffbe194`
- Function logs: `https://app.netlify.com/projects/clarity-caddie/logs/functions`
- Edge function logs: `https://app.netlify.com/projects/clarity-caddie/logs/edge-functions`

This deploy supersedes:

- `6a1d043ecd3f82a16ccef252` - wider whole-hole fit pass.
- `6a1cfe35ba2fd99329da7284` - earlier hole frame/orientation pass.

## Latest Live Markers

Production `index.html` should include:

```html
<script src="scripts/gd-course-library-pin-lock.js?v=hole-corridor-frame-20260601"></script>
```

Production script should include:

- `mappedHoleFrameProfile`
- `settledMaxZoom`
- `effectiveLength`
- `settleMappedHoleZoom`

Verify with:

```bash
curl -L -s https://clarity-caddie.netlify.app/ | rg "hole-corridor-frame-20260601|gd-course-library-pin-lock"
```

```bash
curl -L -s 'https://clarity-caddie.netlify.app/scripts/gd-course-library-pin-lock.js?v=hole-corridor-frame-20260601' | rg "mappedHoleFrameProfile|settledMaxZoom|effectiveLength"
```

## Deploy Command

Current deployment command:

```bash
npx netlify deploy --prod
```

The project uses `.netlifyignore` to avoid publishing local-only files when deploying from the repo root.

Important `.netlifyignore` exclusions:

- `.git`
- `.netlify`
- `.vercel`
- `node_modules`
- `*.zip`
- `*HANDOFF*.md`
- `CLARITY_NEW_CHAT_HANDOFF.md`
- `eng.traineddata`

## Netlify Configuration

Config file:

`netlify.toml`

Current config:

- Publish directory: `.`
- Build command: empty
- Functions directory: `functions`

Redirects:

- `/api/email-notification` -> `/.netlify/functions/email-notification`
- `/api/support-ticket` -> `/.netlify/functions/support-ticket`
- `/api/course-maps` -> `/.netlify/functions/course-maps`

Cache:

- `index.html` and `/*.html`: no-cache/no-store.
- `/scripts/*`: `public, max-age=3600`.
- `/styles/*`: `public, max-age=3600`.
- `/assets/*`: `public, max-age=604800`.

## Current Launch State

Live feature focus:

- Mapped GPS play mode.
- OSM auto mapping and published course map sync.
- Course selection opens straight to Hole 1.
- Mapped hole camera orientation and corridor framing.
- Mapped courses should not silently fall back into old green-centre/two-tap flows.

Latest visual request:

- The mapped hole frame should be closer to the user's selected rectangle: tee-to-green corridor with bleed, not a whole-course overview.
- Current code has been tightened, but the user should visually verify Akarana and Muriwai again.

Primary file for the next change:

`scripts/gd-course-library-pin-lock.js`

Search:

- `mappedHoleFrameProfile`
- `frameMappedHoleForPlay`
- `mappedHoleViewPoints`

## Functions

Current functions directory:

`functions`

Expected functions:

- `course-maps.mjs`
- `email-notification.js`
- `support-ticket.js`

Course maps:

- API: `/api/course-maps`
- Store: Netlify Blobs
- Store name: `clarity-course-maps`
- Key: `published-course-maps-v1`

## Environment Variables

Email:

- `RESEND_API_KEY`
- `EMAIL_NOTIFICATIONS_ENABLED=1`
- `CLARITY_EMAIL_FROM`
- `CLARITY_SITE_URL=https://clarity-caddie.netlify.app`

Support/Supabase:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY` fallback only

## Verification Before Deploy

Run:

```bash
node --check scripts/gd-course-library-pin-lock.js
```

```bash
node <<'NODE'
const fs=require('fs');
const html=fs.readFileSync('index.html','utf8');
const scripts=[...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1]);
let failed=0;
scripts.forEach((code,i)=>{try{new Function(code);}catch(e){failed++;console.error(`Inline script ${i+1} failed: ${e.message}`);}});
console.log(`${scripts.length} inline scripts checked; ${failed} failed`);
process.exit(failed?1:0);
NODE
```

```bash
git diff --check -- index.html scripts/gd-course-library-pin-lock.js
```

## Important Note

The repo working tree is dirty and contains ongoing product changes. Do not revert unrelated files or assume untracked files are disposable.

For broader context, start the next chat with:

`/Users/samhalegolf/Documents/Codex/2026-05-21/files-mentioned-by-the-user-golf/golf-daddy-handoff-cleaned-current/CLARITY_NEW_CHAT_HANDOFF.md`

