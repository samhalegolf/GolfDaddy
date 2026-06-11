# Upload Handover - Clarity Caddie GPS

Date: 2026-06-08

## Repo

Work from:

`/Users/samhalegolf/Documents/Codex/2026-05-21/files-mentioned-by-the-user-golf/golf-daddy-handoff-cleaned-current`

Current app is verified locally from `dist` on:

`http://127.0.0.1:5178/`

Local server was started with:

```bash
cd /Users/samhalegolf/Documents/Codex/2026-05-21/files-mentioned-by-the-user-golf/golf-daddy-handoff-cleaned-current/dist
python3 -m http.server 5178
```

## Upload Target

Netlify config is present. `netlify.toml` publishes:

```toml
[build]
  publish = "dist"
  command = "npm run build:netlify"
  functions = "functions"
```

Important: upload/deploy from `dist`, not the repo root. The last bug looked confusing because `index.html` had newer source changes while the browser was effectively seeing stale `dist/index.html`.

## Build Before Upload

Run:

```bash
npm run build:netlify
```

This uses `scripts/clarity-deploy-build.js` to rebuild `dist` from:

- `index.html`
- `assets`
- `scripts`
- `styles`

After build, sanity check:

```bash
rg -n "mapped-prelock|gdRenderMappedPreLockHoleFrame" dist/index.html
```

Expected evidence:

```text
gdOrientGpsCameraToBearing(bearing(route[0],route[route.length-1]),"mapped-prelock")
```

## Current Verified GPS Behaviour

Verified in browser after rebuilding and serving fresh `dist`:

- Nearby course Play path opens selected course, not stale stored course.
- Akarana Golf Club opens to Hole 1.
- Maungakiekie Golf Club opens to Hole 1.
- Pre-lock prompt shows the two-button pill:
  - `Set Start Point`
  - `Head To the Tee`
- Pre-lock mapped course frame is fairway-up/oriented, not flat north-up.
- Akarana H1 pre-lock reported `mapTransform: rotate(154.872deg) scale(1)`.
- `Head To the Tee` enters locked shot view.
- `Undo` returns to pre-lock prompt, hides shot tile, and keeps pre-lock orientation.

## Main Files Touched For This Fix

- `index.html`
  - Pre-lock renderer now applies mapped fairway orientation directly with source `"mapped-prelock"`.
  - `applyShotUpAfterPlacement()` no longer clears rotation while `gdMappedStartPromptActive` is active.
- `scripts/gd-course-library-pin-lock.js`
  - Delayed auto-map/refocus paths carry the selected course explicitly.
  - Scorecard/play-hole delayed refocus stays in prompt-start mode and skips auto-lock.
- `scripts/clarity-deploy-build.js`
  - Build helper that prepares `dist`.

## Validation Commands Already Passed

```bash
node - <<'NODE'
const fs=require('fs');
const html=fs.readFileSync('index.html','utf8');
const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m=>m[1]);
let ok=0;
for(let i=0;i<scripts.length;i++){
  const src=scripts[i].trim();
  if(!src)continue;
  try{new Function(src);ok++;}
  catch(e){console.error('script',i+1,e.message);process.exit(1);}
}
console.log('parsed scripts',ok);
NODE

node --check scripts/gd-course-library-pin-lock.js
git diff --check -- index.html scripts/gd-course-library-pin-lock.js
npm run build:netlify
```

## Current Git State Warning

The working tree is dirty and includes other existing app changes beyond this last GPS orientation fix. Do not blindly reset or discard anything.

Relevant changed/untracked deploy files include:

- `index.html`
- `scripts/gd-course-library-pin-lock.js`
- `netlify.toml`
- `package.json`
- `scripts/clarity-deploy-build.js`

There are also other modified/untracked assets, styles, functions, and handover files in the repo. Treat them as part of the current working app unless Sam explicitly asks to trim scope.

## Suggested Uploader Flow

1. Open the repo above.
2. Run `npm run build:netlify`.
3. Serve `dist` locally and smoke test `http://127.0.0.1:5178/`.
4. Confirm Akarana/Maungakiekie nearby Play paths both go to their own Hole 1.
5. Confirm Akarana H1 pre-lock has non-zero rotation and the two-button pill.
6. Deploy/upload `dist` using the connected Netlify flow.
7. After deploy, verify the live URL contains the `mapped-prelock` code and repeat the GPS smoke test.

