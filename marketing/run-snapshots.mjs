/* The camera for the Studio's Marketing > Snapshot Machine.
 *
 * Reads marketing/snapshot-plan.json (written by scripts/studio/marketing/snapshot-machine-page.js),
 * drives the REAL play screen at app/index.html in headless Chromium, and writes three
 * screenshots per course:
 *
 *   01-pre-lock      the hole framed with the start pill up, before anything is placed
 *   02-head-to-tee   Head To the Tee pressed on a par 4 or 5, bubble on the layup/green target
 *   03-approach      placed 130m out, bubble on the green, then nudged slightly up and left
 *
 * WHY THIS IS A SEPARATE PROCESS. A browser page cannot screenshot itself at a device scale
 * factor it is not being displayed at, and these are 1170x2532 - a 390x844 layout at DPR 3.
 * Playwright is the only thing here that can set that and then read the pixels back. The Studio
 * page decides WHAT to shoot; this decides nothing.
 *
 * IT USES THE APP'S OWN SIGNALS, NOT SYNTHETIC CLICKS THROUGH A MAP. Placement is
 * marshal.signal("PLACED", {point}) and the nudge is marshal.signal("AIM_DRAGGED", {point}) -
 * the same two the finger sends through painter.js. Head To the Tee is a real click on the
 * real button, because that one has a button. A screenshot taken any other way would be a
 * screenshot of a state the app cannot actually reach.
 *
 * Usage:
 *   node marketing/run-snapshots.mjs --login          # once: sign in, saves marketing/.auth.json
 *   node marketing/run-snapshots.mjs --plan a,b,c     # plan without Studio (terrain only)
 *   npm run marketing:snapshots                       # shoot the plan
 *   npm run marketing:snapshots -- --course te-arai   # just one course from the plan
 *
 * MARKETING_BASE_URL overrides the target (default https://caddy.claritygolf.app — the same
 * default the functions use for CLARITY_SITE_URL).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/* The same module the Studio page used to choose these holes. It is loaded here only for
   standingPoint, which the plan already carries - but a plan hand-edited to a different
   approach hole would carry a standing point for the old one, so it is re-derived from the
   package the app itself loaded. One source for "where 130m out is". */
const core = require('../scripts/gd-marketing-snapshot-core.js');

const root = process.cwd();
const PLAN_FILE = path.join(root, 'marketing', 'snapshot-plan.json');
const AUTH_FILE = path.join(root, 'marketing', '.auth.json');
const OUTPUT_ROOT = path.join(root, 'marketing-output');

const BASE_URL = process.env.MARKETING_BASE_URL || 'https://caddy.claritygolf.app';

/* 390x844 at deviceScaleFactor 3 = 1170x2532. Sam's chosen output size: web and social, and it
   downsizes cleanly. Changing the scale factor changes nothing else - the layout is the phone
   layout either way, which is the point of doing this in a browser rather than upscaling. */
const DEVICE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true
};

/* How far, in CSS pixels of the 390-wide layout, the approach bubble is nudged. "Slightly up
   and to the left" - far enough to read as a deliberate aim rather than a rendering wobble,
   small enough that the bubble still overlaps the green. */
const NUDGE = { left: 26, up: 38 };

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const hasFlag = (flag) => process.argv.includes(flag);

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/* ------------------------------------------------------------------ sign-in, once */

/* OPTIONAL. A signed-out run shoots perfectly good frames - /api/course-package serves a
   published course to anyone, and the play screen's shot view is free - but the player badge
   reads GUEST. Signing in replaces it with the account name.

   Rather than handling a password here, this opens a real browser at the real site and waits
   for a human to sign in, then saves the browser storage Playwright replays on later runs. The
   saved file holds a live session - it is gitignored, and deleting it signs the runner out. */
/* Long, and overridable, because the person signing in may not be sitting at the terminal that
   started this - the window can open behind whatever else is on screen. MARKETING_LOGIN_MINUTES
   raises it further. */
const LOGIN_TIMEOUT_MS = (Number(process.env.MARKETING_LOGIN_MINUTES) || 20) * 60 * 1000;

async function login() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  /* ?login=1 so the landing page does not eat the visit - gd-landing-redirect-v1.js sends a
     signed-out visitor to welcome.html, which has no sign-in form of its own. */
  await page.goto(`${BASE_URL}/?login=1`, { waitUntil: 'domcontentloaded' });

  /* ?login=1 only stops gd-landing-redirect-v1.js eating the visit - it does NOT open a sign-in
     form, and the home screen has no visible way in at all. The route is Player Profile tile ->
     the guest panel's "Sign In" -> the login form (#gd67AuthEmail / #gd67AuthPassword). Walked
     here so the window opens ON the form; leaving somebody to find it themselves is how the
     first two attempts at this timed out having shown nothing but the home screen.

     Note the login form's fields are gd67Auth*, NOT the gdPlayerSettings* pair that also exists
     in the DOM - those belong to the profile editor and are never visible on this route. */
  let onForm = false;
  try {
    await page.locator('button.gdProfileTile').first().click({ timeout: 20_000 });
    await page.getByRole('button', { name: /^sign in$/i }).first().click({ timeout: 20_000 });
    await page.waitForSelector('#gd67AuthEmail', { state: 'visible', timeout: 20_000 });
    onForm = true;
  } catch (e) { onForm = false; }

  console.log(`\nA browser window has opened at ${BASE_URL} - it may be BEHIND your other windows.`);
  console.log(onForm
    ? 'It is sitting on the sign-in form. Enter your email and password there.'
    : 'Go to Player Profile, then Sign In, and enter your email and password there.');
  console.log('This notices by itself when you are signed in; nothing to press here.');
  console.log(`Waiting up to ${Math.round(LOGIN_TIMEOUT_MS / 60000)} minutes.\n`);

  /* Watched rather than waited on with a keypress. A prompt on stdin means this can only ever
     be run from a terminal somebody is sitting at, and the thing being waited for is a fact
     the page already holds: clarity-supabase-auth.js writes its session to localStorage the
     moment a login succeeds. Polling the page for it works the same way whoever - or whatever -
     started the process. */
  const started = Date.now();
  let signedIn = false;
  while (Date.now() - started < LOGIN_TIMEOUT_MS) {
    signedIn = await page.evaluate(() => {
      try {
        const raw = localStorage.getItem('clarity:supabase-auth-session:v1');
        if (!raw) return false;
        const session = JSON.parse(raw);
        return !!(session && (session.access_token || session.accessToken));
      } catch (e) { return false; }
    }).catch(() => false);
    if (signedIn) break;
    await page.waitForTimeout(2000);
  }

  if (!signedIn) {
    await browser.close();
    console.error(`No sign-in seen within ${Math.round(LOGIN_TIMEOUT_MS / 60000)} minutes. Nothing was saved.`);
    process.exitCode = 1;
    return;
  }

  await context.storageState({ path: AUTH_FILE });
  await browser.close();
  console.log(`Signed in. Saved ${path.relative(root, AUTH_FILE)} - it holds a live session, keep it out of git.`);
}

/* ------------------------------------------------------------------ page helpers */

async function waitForPlay(page, hole) {
  await page.waitForFunction(() => !!(window.ClarityApp && window.ClarityApp.booted), null, { timeout: 45_000 });
  /* Booted is "the load order ran", not "the hole is up". The hole is up when the Marshal has
     a scene whose record carries a green - that is the same condition holeRecord uses to call
     a hole drawable, so waiting on anything softer means shooting a half-framed hole. */
  await page.waitForFunction((wanted) => {
    const app = window.ClarityApp;
    if (!app || !app.marshal) return false;
    const scene = app.marshal.scene();
    return !!(scene && scene.hole && scene.hole.rec && scene.hole.rec.green
      && Number(scene.hole.number) === Number(wanted));
  }, hole, { timeout: 45_000 });
  /* The loading sheet covers the frame until boot.js is satisfied. */
  await page.waitForSelector('#loadingScreen.hiddenState', { timeout: 45_000 }).catch(() => {});
}

/* Tiles, the published surface image and the camera transition all settle asynchronously, and
   none of them announces "done" anywhere a test can read. Two animation frames after a fixed
   settle is what demo/run-demo.mjs uses for the same reason; the settle here is longer because
   a play surface is one large image over a network rather than a DOM transition. */
async function settle(page, ms = 2200) {
  await page.waitForTimeout(ms);
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

/* Three transient banners can be up when a frame is taken, and all three are honest app UI that
   has no business in a marketing screenshot:
     - the GPS notice, which is guaranteed here because geolocation is denied on purpose;
     - the access notice, up whenever a gated signal was refused;
     - the "a new map is available" bar, which fires on a hole change if the server published
       something since the round opened.
   Each has a real dismiss button and each remembers being dismissed, so this clicks them the
   way a person would rather than hiding them with CSS - a screenshot of a state the app cannot
   reach is not a screenshot of the app. Run before every frame: they can reappear on a hole
   change, and the map-update bar only ever appears after one. */
async function clearChrome(page) {
  for (const id of ['gpsNoticeDismiss', 'accessNoticeDismiss', 'mapUpdateDismiss']) {
    const button = page.locator(`#${id}`);
    if (await button.isVisible().catch(() => false)) await button.click().catch(() => {});
  }
}

/* Did the bubble actually PAINT? #aimBubble is only the transparent drag handle - the rings,
   aim ray and club chip are SVG in #bubbleSvg - so waiting for #aimBubble to be visible proves
   nothing about the picture. The whole first run shipped three approach frames with no bubble in
   them and reported "3 frames" for each, because that is what it was checking.
 *
 * The app hides #bubbleSvg whenever the shot cannot be drawn on the current presentation. The
 * case that bit us: on a published surface, play-surface.js projectToSurface answers null for
 * anything outside the hole's own raster, so a start point off the end of a short hole takes the
 * bubble with it. The plan avoids that now; this checks it rather than trusting it. */
async function bubblePainted(page) {
  return page.evaluate(() => {
    const svg = document.getElementById('bubbleSvg');
    if (!svg) return { painted: false, why: 'no #bubbleSvg' };
    if (svg.classList.contains('hiddenState')) return { painted: false, why: 'bubble layer hidden' };
    if (!svg.innerHTML.length) return { painted: false, why: 'bubble layer empty' };
    /* The club chip only shows when the full bubble visual built, so it separates "the layer has
       a guide line in it" from "the bubble itself is there". */
    const chip = document.getElementById('bubbleClub');
    const hasChip = !!(chip && !chip.classList.contains('hiddenState'));
    return { painted: true, withBubbleVisual: hasChip, bytes: svg.innerHTML.length };
  });
}

async function signal(page, name, payload) {
  return page.evaluate(([n, p]) => {
    const app = window.ClarityApp;
    if (!app || !app.marshal) return false;
    return app.marshal.signal(n, p || null);
  }, [name, payload || null]);
}

async function holeRecord(page) {
  return page.evaluate(() => {
    const scene = window.ClarityApp.marshal.scene();
    const r = scene && scene.hole && scene.hole.rec;
    if (!r) return null;
    return {
      holeNumber: scene.hole.number,
      par: r.par,
      tee: r.tee ? { lat: r.tee.lat, lng: r.tee.lng } : null,
      green: { lat: r.green.lat, lng: r.green.lng },
      route: (r.route || []).map((p) => ({ lat: p.lat, lng: p.lng }))
    };
  });
}

/* Move the bubble by a screen offset. Read where the bubble actually IS on screen, offset that,
   and ask the app's own projection seam what lat/lng the new point is - which is exactly what a
   finger drag does (painter.js dragHandler -> latLngAt -> AIM_DRAGGED). Computing a lat/lng
   offset directly would be wrong on a rotated, shot-up frame, which every one of these is. */
async function nudgeBubble(page, { left, up }) {
  const moved = await page.evaluate(([dx, dy]) => {
    const node = document.getElementById('aimBubble');
    const app = window.ClarityApp;
    if (!node || !app || !app.painter || !app.marshal) return null;
    const box = node.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    const to = app.painter.latLngAt(box.left + box.width / 2 - dx, box.top + box.height / 2 - dy);
    if (!to) return null;
    return app.marshal.signal('AIM_DRAGGED', { point: to }) ? to : null;
  }, [left, up]);
  return moved;
}

/* ------------------------------------------------------------------ one course */

async function shootCourse(context, course, outDir, report) {
  const shots = [];
  const errors = [];

  const url = (hole) => {
    const params = new URLSearchParams({ courseId: course.courseId, hole: String(hole) });
    if (course.name) params.set('courseName', course.name);
    if (Number.isFinite(Number(course.lat))) params.set('courseLat', String(course.lat));
    if (Number.isFinite(Number(course.lng))) params.set('courseLng', String(course.lng));
    return `${BASE_URL}/app/index.html?${params.toString()}`;
  };

  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(String(error && error.message || error)));

  async function shoot(name) {
    await clearChrome(page);
    const file = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: file });
    shots.push(path.relative(root, file));
    return file;
  }

  try {
    // ---- frames 1 and 2: the tee-shot hole
    await page.goto(url(course.teeHole), { waitUntil: 'domcontentloaded' });
    await waitForPlay(page, course.teeHole);
    await settle(page);

    const teeRec = await holeRecord(page);
    if (teeRec && Number.isFinite(teeRec.par) && teeRec.par < 4) {
      /* Not fatal - the frame is still usable - but the plan asked for a par 4 or 5 and this is
         the only place that can see what the package actually says. */
      errors.push(`Hole ${course.teeHole} is a par ${teeRec.par}; the plan wanted a par 4 or 5.`);
    }

    const pillUp = await page.locator('#startPill:not(.hiddenState)').isVisible().catch(() => false);
    if (!pillUp) {
      errors.push('The start pill never appeared - shooting the frame as it stands.');
    }
    await shoot('01-pre-lock');

    await page.click('#headToTeeBtn', { timeout: 10_000 });
    /* The bubble is the whole subject of this frame; without it there is nothing to show. */
    await page.waitForSelector('#aimBubble', { state: 'visible', timeout: 15_000 });
    await settle(page, 1600);
    const teeBubble = await bubblePainted(page);
    if (!teeBubble.painted) errors.push(`Tee-shot bubble did not render (${teeBubble.why}).`);
    else if (!teeBubble.withBubbleVisual) errors.push('Tee-shot bubble layer drew guides but no bubble.');
    await shoot('02-head-to-tee');

    // ---- frame 3: the approach hole, from 130m
    await page.goto(url(course.approachHole), { waitUntil: 'domcontentloaded' });
    await waitForPlay(page, course.approachHole);
    await settle(page);

    const rec = await holeRecord(page);
    /* Re-derived rather than trusted from the plan: a hand-edited approachHole would carry the
       old hole's standing point, and the app is the only thing here holding the real geometry
       for the hole now on screen. */
    const stand = rec ? core.standingPoint(rec, course.approachFromM || 130) : null;
    if (!stand) throw new Error(`Could not work out a ${course.approachFromM || 130}m point on hole ${course.approachHole}.`);

    const placed = await signal(page, 'PLACED', { point: stand });
    if (!placed) throw new Error('PLACED was refused - the hole is not in preview setup.');
    await page.waitForSelector('#aimBubble', { state: 'visible', timeout: 15_000 });
    await settle(page, 1600);

    const placedBubble = await bubblePainted(page);
    if (!placedBubble.painted) {
      /* Loud, because a frame with no bubble is not a usable marketing frame - it is the one
         thing this shot exists to show. The commonest cause is an approach hole too short for
         the distance, which the planner now excludes. */
      errors.push(`Approach bubble did not render (${placedBubble.why}) - hole ${course.approachHole} may be too short to stand ${course.approachFromM || 130}m back on.`);
    }

    const moved = await nudgeBubble(page, NUDGE);
    if (!moved) errors.push('The bubble could not be nudged - shooting it on the green instead.');
    await settle(page, 1200);
    const finalBubble = await bubblePainted(page);
    if (!finalBubble.painted) errors.push(`Approach bubble gone after the nudge (${finalBubble.why}).`);
    await shoot('03-approach');

    const distance = rec ? Math.round(core.metresBetween(stand, rec.green)) : null;
    report.courses.push({
      courseId: course.courseId,
      name: course.name,
      units: course.units,
      teeHole: course.teeHole,
      teePar: teeRec ? teeRec.par : null,
      approachHole: course.approachHole,
      approachM: distance,
      bubbleNudged: !!moved,
      bubblePainted: finalBubble.painted,
      shots,
      warnings: errors,
      pageErrors: consoleErrors
    });
    console.log(`  ${course.name}: ${shots.length} frames` + (errors.length ? ` (${errors.length} warning${errors.length === 1 ? '' : 's'})` : ''));
  } catch (error) {
    const message = String(error && error.message || error);
    report.courses.push({
      courseId: course.courseId,
      name: course.name,
      failed: message,
      shots,
      warnings: errors,
      pageErrors: consoleErrors
    });
    console.log(`  ${course.name}: FAILED - ${message}`);
  } finally {
    await page.close();
  }
}

/* ------------------------------------------------------------------ contact sheet */

/* One page showing everything the run produced, at a size a human can judge. Written as a file
   rather than printed, because the thing worth reviewing is the pixels. */
function contactSheet(report) {
  const card = (c) => {
    const frames = (c.shots || []).map((rel) => {
      const name = path.basename(rel);
      return `<figure><img src="${path.basename(path.dirname(rel))}/${name}" alt="${name}"><figcaption>${name}</figcaption></figure>`;
    }).join('');
    const notes = []
      .concat(c.failed ? [`<p class="bad">Failed: ${escapeHtml(c.failed)}</p>`] : [])
      .concat((c.warnings || []).map((w) => `<p class="warn">${escapeHtml(w)}</p>`))
      .join('');
    return `<section>
      <h2>${escapeHtml(c.name || c.courseId)}</h2>
      <p class="meta">tee hole ${c.teeHole ?? '—'}${c.teePar ? ` (par ${c.teePar})` : ''} · approach hole ${c.approachHole ?? '—'}${c.approachM ? ` from ${c.approachM}m` : ''} · ${c.units === 'yd' ? 'yards' : 'metres'}${c.bubbleNudged ? ' · bubble nudged' : ''}</p>
      ${notes}
      <div class="frames">${frames}</div>
    </section>`;
  };
  return `<!doctype html><meta charset="utf-8"><title>Clarity marketing snapshots ${escapeHtml(report.startedAt)}</title>
<style>
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; background: #0b0f0d; color: #e7f3ec; margin: 0; padding: 32px; }
  h1 { font-size: 20px; margin: 0 0 4px; color: #3cff8d; }
  h2 { font-size: 16px; margin: 0 0 2px; }
  .meta { color: #8fa79c; font-size: 12px; margin: 0 0 10px; }
  .warn { color: #ffb54c; font-size: 12px; margin: 2px 0; }
  .bad { color: #ff6b6b; font-size: 12px; margin: 2px 0; }
  section { border-top: 1px solid rgba(97,255,159,.14); padding: 22px 0; }
  .frames { display: flex; gap: 16px; flex-wrap: wrap; }
  figure { margin: 0; }
  img { width: 260px; border-radius: 14px; display: block; border: 1px solid rgba(97,255,159,.14); }
  figcaption { font-size: 11px; color: #8fa79c; margin-top: 6px; }
</style>
<h1>Clarity marketing snapshots</h1>
<p class="meta">${escapeHtml(report.startedAt)} · ${escapeHtml(report.baseUrl)} · ${report.courses.length} course(s) · ${report.device.viewport.width}×${report.device.viewport.height} @${report.device.deviceScaleFactor}x</p>
${report.courses.map(card).join('')}`;
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------------------------------------------ main */

/* ------------------------------------------------------------------ planning, headless */

/* `--plan te-arai-links,tara-iti` writes marketing/snapshot-plan.json without opening Studio.
 *
 * The Studio page is the place a human plans a shoot - it shows the terrain scores, the reason
 * each hole won, and lets you override before committing. This is the same decision made without
 * the room: it calls the same /api/course-package the Studio calls, hands the result to the same
 * scripts/gd-marketing-snapshot-core.js, and writes the same file. It exists so a re-plan (a
 * course was rebuilt, a hole changed) does not require a browser, and so this whole pipeline can
 * be run start to finish from a terminal.
 *
 * Signature-hole intel is deliberately NOT fetched here. It is admin-gated and spends a shared
 * search key, and a headless re-plan is exactly the case where nobody is watching what it costs;
 * the Studio asks for it because a person is there to see the answer. Terrain decides here. */
async function planCourses(courseIds) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: await authIfPresent() });
  const page = await context.newPage();
  /* The package call needs the bearer token that clarity-supabase-auth.js holds, so the fetch is
     made FROM the site's own origin with the restored session rather than reimplementing token
     refresh out here. */
  /* /app/ rather than the site root, because this needs ClarityApp.playSurface - the app's own
     projectToSurface - to answer whether a standing point is inside a hole's published raster.
     That is the difference between "long enough, probably" and knowing. */
  await page.goto(`${BASE_URL}/app/index.html?login=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.ClarityApp && window.ClarityApp.playSurface), null, { timeout: 30_000 });

  const courses = [];
  for (const courseId of courseIds) {
    const got = await page.evaluate(async (id) => {
      let token = '';
      try { token = window.ClaritySupabaseAuth ? (await window.ClaritySupabaseAuth.freshAccessToken()) || '' : ''; } catch (e) {}
      const headers = { Accept: 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      const res = await fetch('/api/course-package?courseId=' + encodeURIComponent(id), { headers, cache: 'no-store' });
      if (!res.ok) return { error: 'course-package returned ' + res.status };
      const pkg = await res.json();
      /* The published-surface metadata per hole, so the caller can ask whether a point is
         inside the raster the app will actually draw. Absent is normal - a course with no
         published visuals plays on the live map, where nothing is clipped. */
      const meta = {};
      (pkg.holes || []).forEach((h) => {
        const ps = h && h.visual && h.visual.playSurface;
        if (ps) meta[h.holeNumber] = ps;
      });
      return { pkg, meta };
    }, courseId);

    if (got.error) { console.error(`  ${courseId}: ${got.error}`); continue; }

    const pkg = got.pkg;
    const recs = core.holeRecords(pkg);
    if (!recs.length) { console.error(`  ${courseId}: package has no hole with a green`); continue; }

    /* Exact rather than heuristic: ask the app's own projectToSurface whether the standing point
       lands inside that hole's raster. Outside it, projectToSurface answers null, the bubble
       visual cannot be built and the app draws no bubble at all - which is the entire subject of
       the approach frame. A hole with no published surface is fine: the live map has no edges. */
    const usable = async (holeNumber, stand) => page.evaluate(([m, s]) => {
      if (!m) return true;
      try { return !!window.ClarityApp.playSurface.projectToSurface(m, s.lat, s.lng); }
      catch (e) { return true; }
    }, [got.meta[holeNumber] || null, stand]);

    /* pickHoles' predicate is synchronous, so resolve every candidate up front. */
    const usableByHole = {};
    for (const rec of recs) {
      const stand = core.standingPoint(rec, core.constants.APPROACH_M);
      usableByHole[rec.holeNumber] = stand ? await usable(rec.holeNumber, stand) : true;
    }

    const picked = core.pickHoles(pkg, {
      approachUsable: (holeNumber) => usableByHole[holeNumber] !== false
    });
    const centre = core.packageCentre(pkg);
    const units = core.unitsForPoint(centre);
    const approachRec = recs.find((r) => r.holeNumber === picked.approachHole) || null;

    courses.push({
      courseId,
      name: (pkg && (pkg.courseName || pkg.name)) || courseId,
      lat: centre ? centre.lat : null,
      lng: centre ? centre.lng : null,
      units: units.units,
      teeHole: picked.teeHole,
      approachHole: picked.approachHole,
      approachFromM: core.constants.APPROACH_M,
      standingPoint: approachRec ? core.standingPoint(approachRec, core.constants.APPROACH_M) : null,
      notes: picked.notes.concat([units.reason])
    });
    console.log(`  ${courseId}: ${recs.length} holes · tee ${picked.teeHole} · approach ${picked.approachHole} · ${units.units}`);
    picked.notes.forEach((n) => console.log(`      ${n}`));
  }

  await browser.close();
  if (!courses.length) { console.error('Nothing could be planned.'); process.exitCode = 1; return; }
  await fs.writeFile(PLAN_FILE, JSON.stringify({ version: 1, createdAt: new Date().toISOString(), courses }, null, 2));
  console.log(`\nWrote ${path.relative(root, PLAN_FILE)} (${courses.length} course(s)).`);
}

async function authIfPresent() {
  try { await fs.access(AUTH_FILE); return AUTH_FILE; } catch (e) { return undefined; }
}

async function main() {
  if (hasFlag('--login')) return login();

  const planFor = argValue('--plan');
  if (planFor) return planCourses(planFor.split(',').map((s) => s.trim()).filter(Boolean));

  let plan;
  try {
    plan = JSON.parse(await fs.readFile(PLAN_FILE, 'utf8'));
  } catch (error) {
    console.error(`No plan at ${path.relative(root, PLAN_FILE)}.`);
    console.error('Build one in Studio > Marketing > Snapshot Machine and save it there.');
    process.exitCode = 1;
    return;
  }

  const only = argValue('--course');
  const courses = (plan.courses || []).filter((c) => !only || c.courseId === only);
  if (!courses.length) {
    console.error(only ? `No course "${only}" in the plan.` : 'The plan has no courses.');
    process.exitCode = 1;
    return;
  }

  /* Signed in is OPTIONAL, contrary to what this used to warn. /api/course-package answers a
     published course for a signed-out visitor - geometry, surfaces and the published play
     surface all come back - and the play screen itself runs the whole shot view as a guest
     (the bubble and the rangefinder are free; only writing a round is gated). Verified against
     production: all three frames render identically signed out.

     A session still changes ONE visible thing: the player badge reads GUEST rather than a name.
     Sign in with --login if that badge matters for the shot. */
  const storageState = await authIfPresent();
  if (!storageState) console.log('Signed out - the player badge will read GUEST. `--login` changes that.\n');

  const runDir = path.join(OUTPUT_ROOT, stamp());
  await fs.mkdir(runDir, { recursive: true });

  const report = {
    startedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    device: DEVICE,
    nudge: NUDGE,
    plan: path.relative(root, PLAN_FILE),
    courses: []
  };

  const browser = await chromium.launch({ headless: !hasFlag('--headed') });

  console.log(`Shooting ${courses.length} course(s) against ${BASE_URL}`);
  for (const course of courses) {
    /* A fresh context per course. Two reasons, and the second is the real one: units have to be
       seeded into localStorage BEFORE any script runs (gps-settings.js reads its key once at
       boot and only the tool rail changes it afterwards), and addInitScript is additive and
       cannot be removed - so one context reused across courses would accumulate a stack of
       conflicting seeds. A new context also means the scorecard, bag and resume state one
       course wrote cannot leak into the next one's frames. */
    const context = await browser.newContext({
      ...DEVICE,
      storageState,
      locale: 'en-NZ',
      /* No geolocation permission on purpose. A real fix would put the Marshal into Live flow
         and take the screen off the placement these frames are built from - and there is no fix
         to be had in a data centre anyway. Preview is the honest state for a course you are
         not standing on. */
      permissions: [],
      colorScheme: 'light'
    });
    await context.addInitScript(`(() => {
      try {
        const raw = JSON.parse(localStorage.getItem('clarity:gps-settings:v1') || '{}');
        localStorage.setItem('clarity:gps-settings:v1', JSON.stringify({ ...raw, units: ${JSON.stringify(course.units || 'm')} }));
      } catch (e) {}
    })();`);

    const outDir = path.join(runDir, course.courseId);
    await fs.mkdir(outDir, { recursive: true });
    await shootCourse(context, course, outDir, report);
    await context.close();
  }

  await browser.close();

  await fs.writeFile(path.join(runDir, 'run-report.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(runDir, 'contact-sheet.html'), contactSheet(report));

  const failed = report.courses.filter((c) => c.failed).length;
  console.log(`\n${path.relative(root, runDir)}`);
  console.log(`  contact-sheet.html · run-report.json${failed ? ` · ${failed} course(s) failed` : ''}`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
