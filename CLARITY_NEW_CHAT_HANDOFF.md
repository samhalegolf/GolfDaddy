# Clarity Caddie Fresh Chat Handoff

Updated: 2026-06-01 16:28 NZST

## Start Here

Project path:

`/Users/samhalegolf/Documents/Codex/2026-05-21/files-mentioned-by-the-user-golf/golf-daddy-handoff-cleaned-current`

Local app:

`http://localhost:5173/`

Run locally:

```bash
npm start
```

Production app:

`https://clarity-caddie.netlify.app/`

Netlify project:

- Project: `clarity-caddie`
- Admin: `https://app.netlify.com/projects/clarity-caddie`
- Project ID: `998dc390-a3da-4fe1-95c3-c441abcca54e`
- Account: `Samuel Hale <samhalegolf@gmail.com>`
- Team: `Sam Hale Golf`

Latest production deploy:

- Deploy ID: `6a1d08ca742f62b1fffbe194`
- Deploy URL: `https://6a1d08ca742f62b1fffbe194--clarity-caddie.netlify.app`
- Logs: `https://app.netlify.com/projects/clarity-caddie/deploys/6a1d08ca742f62b1fffbe194`
- Production URL: `https://clarity-caddie.netlify.app`

This deploy includes the latest mapped GPS corridor-frame tuning and cache bust:

`scripts/gd-course-library-pin-lock.js?v=hole-corridor-frame-20260601`

## Current User Priority

The user is polishing the GPS play camera/frame for mapped courses.

Current intent:

- If OSM/course mapping exists, treat the course as mapped until told otherwise.
- Selecting a course should go straight to Hole 1 with loading, not show random map movement.
- A hole tap/select should frame the playable hole corridor cleanly.
- The frame should look more like the user's selected rectangle: tee-to-green visible, zoomed in, with some bleed, not a wide course/neighborhood overview.
- Long par 5s need more zoomed-out framing; par 3s should be much more zoomed in.
- When locked in, the map should not drag; only the shot bubble should move.

Latest tuning:

- `mappedHoleFrameProfile()` now uses a tighter corridor profile.
- Akarana/Muriwai normal mapped holes moved from an overly wide zoom `16` feel toward tighter `17`/`18` corridor framing depending on hole length/par.
- If the frame is still too wide, tune `mappedHoleFrameProfile()` first, not the overlay code.

Main file/line to start with:

`scripts/gd-course-library-pin-lock.js`

Search terms:

- `mappedHoleFrameProfile`
- `mappedHoleViewPoints`
- `frameMappedHoleForPlay`
- `settleMappedHoleZoom`
- `orientCameraToMappedHole`
- `openCourseToFirstHole`

## Recent GPS Mapping Work

The mapped GPS flow now has these behaviours:

- Course selection forces mapped play mode for saved/published courses.
- `openCourseToFirstHole(course)` sends the user to Hole 1, shows a loading overlay, automaps if needed, frames the hole, then hides loading.
- OSM auto-mapper uses hole lines and nearby OSM golf polygons. Non-standard green polygon shapes are trusted when found.
- Mapped courses suppress the old two-tap/green-centre fallback flow. If mapped data is missing, show/report a mapped dropout instead of silently falling back.
- Manual mode on a mapped course means: tap where you are standing.
- Manual mode on an unmapped course means: banner says tap twice.
- Fairway/hole axis is used for orientation. The native map is still Leaflet, but the visual camera rotation is done with `gdOrientGpsCameraToBearing()` in `index.html`.
- Post-fit zoom settling exists because Leaflet `fitBounds()` happens before the CSS rotation and UI chrome can make the final view feel wrong.

Important functions:

- `mappedHolePlayData(course,hole)`
- `mappedHoleFrameProfile(data)`
- `mappedHoleViewPoints(data)`
- `frameMappedHoleForPlay(course,hole,opts)`
- `focusMappedHoleOrSavedGreen(hole,opts)`
- `openCourseToFirstHole(course)`
- `scheduleOsmAutoMapForPlay(course,opts)`

## Current Frame Values

As of the latest deploy, `mappedHoleFrameProfile()` uses these broad bands:

- `effectiveLength >= 520`: max/settled zoom `16`, wider long-hole bleed.
- `effectiveLength >= 360`: max/settled zoom `17`, medium corridor bleed.
- `effectiveLength >= 220`: max/settled zoom `18`, tight corridor.
- `effectiveLength >= 120`: max/settled zoom `18`, tighter short-hole corridor.
- shorter: max/settled zoom `18`, very tight.

If the next visual check still feels too wide on Akarana Hole 1:

- Try reducing the `>=360` band pad/lateral first.
- If it still needs more zoom, move the `>=360` settled/max zoom to `18`.
- Do not loosen the long-hole `>=520` band unless Muriwai-style long holes start clipping tee/green again.

## Launch/Deploy Commands

Local checks:

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

Deploy:

```bash
npx netlify deploy --prod
```

Production verification:

```bash
curl -L -s https://clarity-caddie.netlify.app/ | rg "hole-corridor-frame-20260601|gd-course-library-pin-lock"
```

```bash
curl -L -s 'https://clarity-caddie.netlify.app/scripts/gd-course-library-pin-lock.js?v=hole-corridor-frame-20260601' | rg "mappedHoleFrameProfile|settledMaxZoom|effectiveLength"
```

## Netlify Configuration

Config file:

`netlify.toml`

Current config:

- Publish directory: `.`
- Build command: empty
- Functions directory: `functions`
- HTML no-cache/no-store.
- Scripts/styles cache for one hour.
- Assets cache for one week.

API redirects:

- `/api/email-notification` -> `/.netlify/functions/email-notification`
- `/api/support-ticket` -> `/.netlify/functions/support-ticket`
- `/api/course-maps` -> `/.netlify/functions/course-maps`

Deploy protection:

`.netlifyignore` excludes `.git`, `.netlify`, `.vercel`, `node_modules`, zips, handoff markdown files, `CLARITY_NEW_CHAT_HANDOFF.md`, and `eng.traineddata`.

## Course Maps / Published Mapping

Course maps now have a Netlify function:

`functions/course-maps.mjs`

Storage:

- Netlify Blobs store: `clarity-course-maps`
- Blob key: `published-course-maps-v1`
- API path: `/api/course-maps`

Client constant:

`PUBLISHED_COURSE_API='/api/course-maps'`

The mapper/library code can sync published course maps and publish admin-approved course maps. Published maps should be read-only in the UI.

## Files Changed In Current Working Tree

The working tree is intentionally dirty. Do not assume a clean git state.

Important modified/untracked files include:

- `index.html`
- `scripts/gd-course-library-pin-lock.js`
- `functions/course-maps.mjs`
- `functions/email-notification.js`
- `functions/email-notification.mjs` is deleted/replaced by `.js`
- `netlify.toml`
- `package.json`
- `package-lock.json`
- `.netlifyignore`
- `scripts/clarity-email.js`
- `scripts/gd-gps-badge.js`
- `styles/gd-course-library.css`
- `assets/brand/cg-gps-pin.png`
- `assets/brand/clarity-app-icon.png`
- `assets/home/shot-system.svg`
- brand/play icon assets

Do not revert unrelated changes unless the user explicitly asks.

## Other Recent User-Facing Changes

Brand/home:

- General Clarity Golf logo updated.
- Main Clarity Caddie Play tile icon updated.
- Clarity Shot System home tile icon updated.
- Tagline/subtitle uses: `Turn Practice Patterns Into on Course Results`, with orange emphasis on selected words.

GPS controls:

- GPS settings gear moved beside Back/Home.
- GPS locate button uses the new CG GPS icon.
- Manual/Live language replaced old `2 Tap/Live` wording.
- Locked frame disables map panning and leaves the shot bubble as the movable thing.

Auth/login:

- Login/reset surfaces should stay above home unless the browser already has a valid session.
- Lightweight local auth is still used; this is not full Supabase Auth.

## Test Accounts / Auth Notes

Known short local test logins requested by the user:

- Coach: email `coach`, password `coach`
- Player: email `player`, password `player`

Other older local test accounts may exist:

- `coach@clarity.local`
- `mia@clarity.local`

Treat these as test accounts only.

## Email / Support Environment

Email provider:

`Resend`

Expected Netlify environment variables:

- `RESEND_API_KEY`
- `EMAIL_NOTIFICATIONS_ENABLED=1`
- `CLARITY_EMAIL_FROM`
- `CLARITY_SITE_URL=https://clarity-caddie.netlify.app`

Support/Supabase variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY` fallback only

Main files:

- `scripts/clarity-email.js`
- `functions/email-notification.js`
- `functions/support-ticket.js`
- `supabase/support-schema.sql`

## Known Follow-Ups

Immediate:

- Have the user visually verify Akarana and Muriwai mapped-hole framing after the corridor-frame deploy.
- If too wide, tune only `mappedHoleFrameProfile()` first.
- If tee/green clip on long holes, loosen only the long-hole profile band.

Worth keeping an eye on:

- The in-app browser reload may return to Home; use the user’s current GPS screen when possible for visual checks.
- If the Home Play tile does not respond in the automation session, do not assume the app is broken. The user was already on GPS locally before reloads.
- Avoid adding more fallback paths to mapped GPS. The user explicitly wants less hidden fallback behaviour.
- Do not show old mapped-course prompts such as `Tap green centre` or two-click fallbacks when mapped data exists.

## Latest Verification Done

Last successful checks before this handoff:

- `node --check scripts/gd-course-library-pin-lock.js`
- Inline script parse: `34 inline scripts checked; 0 failed`
- `git diff --check -- index.html scripts/gd-course-library-pin-lock.js`
- Production cache-bust verified:
  - `hole-corridor-frame-20260601`
  - `settledMaxZoom`
  - `effectiveLength`

