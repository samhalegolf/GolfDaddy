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
 *   npm run marketing:snapshots                       # shoot the plan
 *   npm run marketing:snapshots -- --course te-arai   # just one course from the plan
 *
 * MARKETING_BASE_URL overrides the target (default https://claritycaddy.com).
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

const BASE_URL = process.env.MARKETING_BASE_URL || 'https://claritycaddy.com';

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

/* The play screen reads /api/course-package with a bearer token, so a signed-out run shoots a
   bare OSM map. Rather than handling a password here, this opens a real browser at the real
   site and waits for a human to sign in, then saves the browser storage Playwright will replay
   on every later run. The saved file holds a live session - it is gitignored, and deleting it
   is how you sign the runner out. */
async function login() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  console.log('\nSign in in the browser window that just opened.');
  console.log('When you are signed in and on the home screen, come back here and press Enter.\n');
  await new Promise((resolve) => process.stdin.once('data', resolve));
  await context.storageState({ path: AUTH_FILE });
  await browser.close();
  console.log(`Saved ${path.relative(root, AUTH_FILE)}. It holds a live session - keep it out of git.`);
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

    const moved = await nudgeBubble(page, NUDGE);
    if (!moved) errors.push('The bubble could not be nudged - shooting it on the green instead.');
    await settle(page, 1200);
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

async function main() {
  if (hasFlag('--login')) return login();

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

  let storageState;
  try { await fs.access(AUTH_FILE); storageState = AUTH_FILE; }
  catch (e) {
    console.warn('No saved session (marketing/.auth.json). Run with --login first, or the run will');
    console.warn('shoot an unmapped live map - /api/course-package needs a bearer token.\n');
  }

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
