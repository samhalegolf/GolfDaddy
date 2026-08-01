/*
 * Fresh app surface (app/) boot + projection test.
 *
 * Part 1 runs the pure projection functions under node — both engines' math is
 * identical here, so this is the WebKit-safe half (audit rule 9: assert on what
 * both engines can see).
 * Part 2 boots /app/index.html in headless Chromium and fails on any uncaught
 * exception, then asserts the boot canary and rule 2 (the map container is
 * visible by default) and rule 3 (no setInterval fired during boot).
 *
 * Browser resolution mirrors dev/boot-smoke.test.js.
 */
const assert = require("assert");
const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const surface = require(path.join(ROOT, "app", "js", "play-surface.js"));
const distance = require(path.join(ROOT, "app", "js", "distance.js"));
const { courseKey } = require(path.join(ROOT, "app", "js", "course-key.js"));

/* Real Akarana hole 1 geometry (course_maps, read 2026-07-31) — the numbers the
   caddy display must reproduce. */
const AKARANA_H1 = {
  tee: { lat: -36.9133686, lng: 174.7409167 },
  green: { lat: -36.91669425625, lng: 174.7393568875 },
  greenShape: [
    { lat: -36.9165816, lng: 174.7393482 }, { lat: -36.916599, lng: 174.7393085 },
    { lat: -36.9166242, lng: 174.7392658 }, { lat: -36.9166733, lng: 174.7392379 },
    { lat: -36.9167239, lng: 174.739228 }, { lat: -36.9167645, lng: 174.7392416 },
    { lat: -36.9168041, lng: 174.7392738 }, { lat: -36.916823, lng: 174.7393185 },
    { lat: -36.9168245, lng: 174.7393724 }, { lat: -36.9168017, lng: 174.7394238 },
    { lat: -36.9167576, lng: 174.739466 }, { lat: -36.9167075, lng: 174.739487 },
    { lat: -36.916655, lng: 174.7394796 }, { lat: -36.9166094, lng: 174.7394517 },
    { lat: -36.9165831, lng: 174.7394189 }, { lat: -36.9165757, lng: 174.7393885 }
  ]
};

/* ---- Part 1: node unit checks ---- */

assert.strictEqual(courseKey("Akarana Golf Club"), "akarana-golf-club");
assert.strictEqual(courseKey("Akarana_Golf_Club"), "akarana-golf-club");
assert.strictEqual(courseKey(""), "course");

/* World-mercator sanity: at zoom 18, x for lng 0 is half the world. */
const half = surface.worldPx(0, 0, 18);
assert.strictEqual(half.x, 256 * Math.pow(2, 18) / 2);
assert.strictEqual(Math.round(half.y), 256 * Math.pow(2, 18) / 2);

/* Fractional captureZoom is rejected, not rounded (rule 6). */
assert.throws(() => surface.worldPx(0, 0, 18.5), /integer/);

/* Round-trip a point through a synthetic surface at the observed zoom. */
const origin = surface.worldPx(-36.9050, 174.7780, 18);
const meta = {
  captureZoom: 18,
  originPx: { x: origin.x, y: origin.y },
  outputDimensions: { width: 1341, height: 1889 }
};
const inside = surface.worldPx(-36.9060, 174.7790, 18);
const projected = surface.projectToSurface(meta, -36.9060, 174.7790);
assert.ok(projected, "a point inside the bounds must project");
assert.ok(Math.abs(projected.x - (inside.x - origin.x)) < 1e-6);
assert.strictEqual(surface.projectToSurface(meta, -36.0, 174.0), null, "off-surface points return null");

/* object-fit: contain letterboxing: a 1341x1889 surface in a 375x812 viewport
   scales by width; the image centre must land on the viewport's horizontal
   centre, vertically centred within the letterbox. */
const fitted = surface.fitContain(
  { x: 1341 / 2, y: 1889 / 2 }, { width: 1341, height: 1889 }, { width: 375, height: 812 });
assert.ok(Math.abs(fitted.left - 375 / 2) < 1e-9, "image centre must map to viewport centre x");
assert.ok(Math.abs(fitted.top - 812 / 2) < 1e-9, "image centre must map to viewport centre y");
const corner = surface.fitContain({ x: 0, y: 0 }, { width: 1341, height: 1889 }, { width: 375, height: 812 });
assert.ok(Math.abs(corner.left - 0) < 1e-9, "width-limited fit has no horizontal letterbox");
assert.ok(corner.top > 0, "top-left corner sits below the vertical letterbox");
assert.strictEqual(surface.fitContain({ x: 0, y: 0 }, { width: 0, height: 0 }, { width: 375, height: 812 }), null);

/* Projection inverses: world-pixel and full tap round-trips must land back on
   the same coordinates — a tap where the dot renders IS that lat/lng. */
{
  const start = { lat: -36.9174, lng: 174.74 };
  const world = surface.worldPx(start.lat, start.lng, 18);
  const back = surface.latLngFromWorldPx(world, 18);
  assert.ok(Math.abs(back.lat - start.lat) < 1e-9 && Math.abs(back.lng - start.lng) < 1e-9,
    "worldPx inverse must round-trip");

  const originForTap = surface.worldPx(-36.9050, 174.7780, 18);
  const tapMeta = {
    captureZoom: 18,
    originPx: { x: originForTap.x, y: originForTap.y },
    outputDimensions: { width: 1341, height: 1889 }
  };
  const view = { width: 375, height: 812 };
  const target = { lat: -36.9060, lng: 174.7790 };
  const px = surface.projectToSurface(tapMeta, target.lat, target.lng);
  const screen = surface.fitContain(px, tapMeta.outputDimensions, view);
  const tapped = surface.surfaceScreenToLatLng(tapMeta, screen, view);
  assert.ok(tapped && Math.abs(tapped.lat - target.lat) < 1e-7 && Math.abs(tapped.lng - target.lng) < 1e-7,
    "surface tap must invert to the same lat/lng the dot renders at");
  assert.strictEqual(surface.surfaceScreenToLatLng(tapMeta, { left: 5, top: 5 }, view), null,
    "a tap in the letterbox is not on the course");
}

/* ---- Bubble engine client: drift + behaviour ----
   app/js/bubble-engine.js is GENERATED (dev/generate-bubble-engine-client.js)
   with the engine functions copied verbatim from gd-app-core.js and the layup
   helpers from pin-lock. Any copied block that is no longer byte-identical to
   its source is a failure here — change the engine, re-run the generator. */
{
  const clientSrc = fs.readFileSync(path.join(ROOT, "app", "js", "bubble-engine.js"), "utf8");
  const coreSrc = fs.readFileSync(path.join(ROOT, "scripts", "gd-app-core.js"), "utf8");
  const pinlockSrc = fs.readFileSync(path.join(ROOT, "scripts", "gd-course-library-pin-lock.js"), "utf8");
  const sections = clientSrc.split("/* ==== ");
  const sourceFor = (title) => (title.includes("pin-lock") ? pinlockSrc : coreSrc);
  let checked = 0;
  sections.filter((s) => s.startsWith("VERBATIM")).forEach((section) => {
    const title = section.slice(0, section.indexOf("\n"));
    const body = section.slice(section.indexOf("*/") + 2).split("\n/* ==== ")[0].split("\n  /* ==== adapter")[0];
    body.split(/\n(?=const |function |  function )/).map((b) => b.trim()).filter(Boolean).forEach((block) => {
      assert.ok(sourceFor(title).includes(block),
        "bubble-engine drift: block no longer matches its source (" + title + "): " + block.slice(0, 60) + "…");
      checked += 1;
    });
  });
  assert.ok(checked >= 70, "expected 70+ verbatim blocks, checked " + checked);

  /* Behaviour, on the ghost bag (no account in this shell — the engine's own
     stand-in, not an invented fallback). */
  const distanceLib = require(path.join(ROOT, "app", "js", "distance.js"));
  const sandbox = {
    console,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: { body: { classList: { contains: () => false } } },
    L: { latLng: (lat, lng) => ({ lat, lng }), point: (x, y) => ({ x, y, distanceTo(o) { return Math.hypot(o.x - x, o.y - y); } }) }
  };
  sandbox.window = sandbox;
  sandbox.window.ClarityApp = { distance: distanceLib };
  vm.createContext(sandbox);
  vm.runInContext(clientSrc, sandbox, { filename: "bubble-engine.js" });
  const engine = sandbox.window.GDBubbleEngine;

  const bag = engine.playableBag();
  assert.ok(bag.length >= 10 && bag.every((r) => r.ghostBag), "ghost bag answers when no account bag is set");
  const maxCarry = engine.maxPlayableCarryM();
  assert.ok(maxCarry > 230 && maxCarry < 320, "ghost bag max playable total, got " + maxCarry);

  const route = [AKARANA_H1.tee, { lat: -36.9145, lng: 174.7403 }, { lat: -36.9157, lng: 174.7398 }, AKARANA_H1.green];
  engine.setHoleContext({ hole: 1, tee: AKARANA_H1.tee, green: AKARANA_H1.green, route });
  engine.setShot(AKARANA_H1.tee, null);
  const layup = engine.targetForGreenCentre(AKARANA_H1.green, { hole: 1 });
  const layupShort = distanceLib.haversineMeters(layup, AKARANA_H1.green);
  assert.ok(layupShort > 30, "green out of bag range → the target starts at the fairway point, "
    + layupShort.toFixed(0) + "m short");
  assert.ok(distanceLib.haversineMeters(AKARANA_H1.tee, layup) <= maxCarry + 3, "layup stays inside the bag");

  engine.setShot({ lat: -36.9157, lng: 174.7398 }, null);
  const reachable = engine.targetForGreenCentre(AKARANA_H1.green, { hole: 1 });
  assert.ok(distanceLib.haversineMeters(reachable, AKARANA_H1.green) < 1, "green in range → the target IS the green");

  engine.setShot(AKARANA_H1.tee, layup);
  const model = engine.renderModel();
  assert.ok(model && model.payload.club !== "GPS", "the calibrated engine payload answers, not the GPS fallback — got " + model.payload.club);
  assert.strictEqual(model.rings.main.length, 168, "the engine's ring resolution");
  const radii = model.rings.main.map((p) => distanceLib.haversineMeters(model.center, p));
  assert.ok(Math.min(...radii) > 2 && Math.max(...radii) < 60 && Math.max(...radii) > Math.min(...radii),
    "cluster ring is an engine-shaped ellipse, radii " + Math.min(...radii).toFixed(1) + "–" + Math.max(...radii).toFixed(1) + "m");
  console.log("bubble-engine drift+behaviour passed: " + checked + " verbatim blocks, "
    + bag.length + "-club ghost bag, layup " + layupShort.toFixed(0) + "m short, " + model.payload.club + " cluster");
}

/* Pre-locked hole framing (guide contract v20): tee pinned to the bottom
   guide box, green to the upper hole box, one similarity transform. */
{
  const view = { width: 375, height: 812 };
  const teeAnchor = surface.frameAnchor("tee", view);
  const holeAnchor = surface.frameAnchor("hole", view);
  assert.ok(teeAnchor.top > holeAnchor.top, "tee anchor must sit below the green anchor");
  assert.ok(Math.abs(teeAnchor.left - holeAnchor.left) < 1e-9, "both anchors sit on the same vertical axis");

  const frameOrigin = surface.worldPx(-36.9100, 174.7360, 18);
  const frameMeta = { captureZoom: 18, originPx: frameOrigin, outputDimensions: { width: 1341, height: 1889 } };
  const anchors = { tee: AKARANA_H1.tee, green: AKARANA_H1.green };
  const frame = surface.playFrameTransform(frameMeta, anchors, view);
  assert.ok(frame, "the frame transform must exist for on-surface anchors");

  const teePx = surface.projectToSurface(frameMeta, AKARANA_H1.tee.lat, AKARANA_H1.tee.lng);
  const greenPx = surface.projectToSurface(frameMeta, AKARANA_H1.green.lat, AKARANA_H1.green.lng);
  const teeMapped = surface.transformApply(frame, teePx);
  const greenMapped = surface.transformApply(frame, greenPx);
  assert.ok(Math.abs(teeMapped.left - teeAnchor.left) < 1e-6 && Math.abs(teeMapped.top - teeAnchor.top) < 1e-6,
    "the tee must land on the tee guide box");
  assert.ok(Math.abs(greenMapped.left - holeAnchor.left) < 1e-6 && Math.abs(greenMapped.top - holeAnchor.top) < 1e-6,
    "the green must land on the hole guide box");

  const roundTrip = surface.transformInvert(frame, teeMapped);
  assert.ok(Math.abs(roundTrip.x - teePx.x) < 1e-6 && Math.abs(roundTrip.y - teePx.y) < 1e-6,
    "the transform must invert exactly (taps depend on it)");

  assert.strictEqual(surface.playFrameTransform(frameMeta, null, view), null, "no anchors → contain fallback");
  assert.strictEqual(surface.playFrameTransform(frameMeta, anchors, { width: 0, height: 0 }), null,
    "a zero viewport must not produce a frame");
}

/* Lock and zoom stages against the same contract. */
{
  const view = { width: 375, height: 812 };
  const frameOrigin = surface.worldPx(-36.9100, 174.7360, 18);
  const meta = { captureZoom: 18, originPx: frameOrigin, outputDimensions: { width: 1341, height: 1889 } };
  const position = { lat: -36.9150, lng: 174.7400 };   // mid-fairway
  const pts = { tee: AKARANA_H1.tee, green: AKARANA_H1.green, greenShape: AKARANA_H1.greenShape, position };
  const posPx = surface.projectToSurface(meta, position.lat, position.lng);
  const greenPx = surface.projectToSurface(meta, AKARANA_H1.green.lat, AKARANA_H1.green.lng);

  const lock = surface.stageFrameTransform(meta, "lock", pts, view);
  assert.ok(lock, "lock stage must frame");
  const posLocked = surface.transformApply(lock, posPx);
  const greenLocked = surface.transformApply(lock, greenPx);
  const teeAnchor = surface.frameAnchor("tee", view);
  const lockAnchor = surface.frameAnchor("lock", view);
  assert.ok(Math.abs(posLocked.left - teeAnchor.left) < 1e-6 && Math.abs(posLocked.top - teeAnchor.top) < 1e-6,
    "lock: the player lands on the tee guide box");
  assert.ok(Math.abs(greenLocked.left - lockAnchor.left) < 1e-6 && Math.abs(greenLocked.top - lockAnchor.top) < 1e-6,
    "lock: the green lands on the lock guide box");

  /* An aimed shot: the TARGET, not the green, lands on the lock box. */
  const aimPoint = { lat: -36.916, lng: 174.7402 };
  const lockAimed = surface.stageFrameTransform(meta, "lock", { ...pts, target: aimPoint }, view);
  const aimPx = surface.projectToSurface(meta, aimPoint.lat, aimPoint.lng);
  const aimMapped = surface.transformApply(lockAimed, aimPx);
  const posAimed = surface.transformApply(lockAimed, posPx);
  assert.ok(Math.abs(aimMapped.left - lockAnchor.left) < 1e-6 && Math.abs(aimMapped.top - lockAnchor.top) < 1e-6,
    "lock with an aim: the target lands on the lock box");
  assert.ok(Math.abs(posAimed.left - teeAnchor.left) < 1e-6 && Math.abs(posAimed.top - teeAnchor.top) < 1e-6,
    "lock with an aim: the player still lands on the tee box");

  const zoom = surface.stageFrameTransform(meta, "zoom", pts, view);
  assert.ok(zoom, "zoom stage must frame");
  const greenZoomed = surface.transformApply(zoom, greenPx);
  const zoomAnchor = surface.frameAnchor("zoom", view);
  assert.ok(Math.abs(greenZoomed.left - zoomAnchor.left) < 1e-6 && Math.abs(greenZoomed.top - zoomAnchor.top) < 1e-6,
    "zoom: the green centres on the zoom guide box");
  const posZoomed = surface.transformApply(zoom, posPx);
  assert.ok(posZoomed.top > greenZoomed.top, "zoom: the approach direction points up the screen");
  let maxR = 0;
  AKARANA_H1.greenShape.forEach((p) => {
    const sp = surface.projectToSurface(meta, p.lat, p.lng);
    const m = surface.transformApply(zoom, sp);
    maxR = Math.max(maxR, Math.hypot(m.left - greenZoomed.left, m.top - greenZoomed.top));
  });
  const boxMin = Math.min(view.width * 0.687, view.height * 0.316);
  assert.ok(Math.abs(maxR - (0.55 * boxMin) / 2) < 1e-6, "zoom: the green shape fills 55% of the zoom box");
}

/* Provenance label: compact, readable, and it names the source. */
{
  const label = surface.provenanceLabel({
    origin: "package",
    url: "/api/course-visual-assets?path=akarana-golf-club%2Fframes%2Fr1alw6nz%2Fh1.jpg",
    loadMs: 412.4,
    playSurface: { captureZoom: 18, outputDimensions: { width: 1341, height: 1889 } }
  });
  assert.strictEqual(label, "pkg · r1alw6nz/h1.jpg · z18 · 1341×1889 · 412ms");
  assert.strictEqual(surface.provenanceLabel(null), "");
  const viaEndpoint = surface.provenanceLabel({
    origin: "visuals", url: "/api/course-visual-assets?path=a%2Fframes%2Fx%2Fh2.jpg",
    playSurface: { captureZoom: 18, outputDimensions: { width: 10, height: 20 } }
  });
  assert.ok(viaEndpoint.startsWith("visuals · "), "endpoint fallback must be labelled distinctly");
}

/* Distance math: one degree of latitude is ~111.2km, so 0.001° ≈ 111.2m. */
const meridian = distance.haversineMeters({ lat: 0, lng: 0 }, { lat: 0.001, lng: 0 });
assert.ok(Math.abs(meridian - 111.2) < 0.3, "0.001° latitude must be ~111.2m, got " + meridian);
assert.strictEqual(distance.haversineMeters({ lat: 0, lng: 0 }, null), null);

/* Tee shot on Akarana hole 1: tee to green centre is a ~395m par 4. */
const teeToGreen = distance.haversineMeters(AKARANA_H1.tee, AKARANA_H1.green);
assert.ok(teeToGreen > 380 && teeToGreen < 410, "Akarana 1 tee→green must be ~395m, got " + teeToGreen);

const fcb = distance.greenDistances(AKARANA_H1.tee, AKARANA_H1);
assert.ok(fcb.front < fcb.centre && fcb.centre < fcb.back, "front < centre < back from the tee");
assert.ok(fcb.back - fcb.front > 10 && fcb.back - fcb.front < 60, "green depth must be plausible, got " + (fcb.back - fcb.front));

const centreOnly = distance.greenDistances(AKARANA_H1.tee, { green: AKARANA_H1.green, greenShape: [] });
assert.strictEqual(centreOnly.front, null, "no shape → no front number");
assert.strictEqual(centreOnly.back, null, "no shape → no back number");
assert.ok(centreOnly.centre > 0, "centre still answers without a shape");

/* Asset picking: only published records with playSurface metadata answer. */
const record = {
  status: "published",
  uploaded_assets: [
    { holeNumber: 1, path: "a/h1.webp", metadata: { playSurface: meta } },
    { holeNumber: 2, path: "a/h2.webp", metadata: {} }
  ]
};
assert.strictEqual(surface.holeSurfaceAsset(record, 1).path, "a/h1.webp");
assert.strictEqual(surface.holeSurfaceAsset(record, 2), null, "no playSurface metadata → no surface");
assert.strictEqual(surface.holeSurfaceAsset({ ...record, status: "draft" }, 1), null, "unpublished → no surface");

/* Absence is a state: the store answers "none" once and never refetches. */
(async () => {
  let fetches = 0;
  const store = surface.createStore({ fetchRecord: async () => { fetches += 1; return null; } });
  const first = await store.surfaceFor("akarana-golf-club", 1);
  const second = await store.surfaceFor("akarana-golf-club", 1);
  assert.strictEqual(first.state, "none");
  assert.strictEqual(second, first, "asking twice must return the cached answer");
  assert.strictEqual(fetches, 1, "absence must not refetch");
  console.log("fresh-app projection/store checks passed");
  await bootCheck();
})().catch((err) => { console.error(err); process.exit(1); });

/* ---- Part 2: headless boot ---- */

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp"
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split("?")[0]);
      let filePath = path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);
      if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end("not found"); return; }
        res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function launchBrowser(playwright) {
  if (process.env.GD_BOOT_CHROMIUM) {
    return playwright.chromium.launch({ executablePath: process.env.GD_BOOT_CHROMIUM });
  }
  try { return await playwright.chromium.launch(); }
  catch (e) { return playwright.chromium.launch({ channel: "chrome" }); }
}

async function bootCheck() {
  const playwright = require("playwright-core");
  const server = await startServer();
  const port = server.address().port;
  const browser = await launchBrowser(playwright);
  /* A granted geolocation permission plus a fixed position near Akarana lets the
     GPS marker path run for real - watchPosition fires with this fix. */
  const context = await browser.newContext({
    geolocation: { latitude: -36.9174, longitude: 174.7400 },
    permissions: ["geolocation"]
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err && err.message || String(err)));
  await page.addInitScript(() => {
    window.__intervals = 0;
    const orig = window.setInterval;
    window.setInterval = function () { window.__intervals += 1; return orig.apply(window, arguments); };
  });
  await page.goto("http://127.0.0.1:" + port + "/app/index.html", { waitUntil: "load" });
  await page.waitForTimeout(1500);

  const state = await page.evaluate(() => ({
    booted: !!(window.ClarityApp && window.ClarityApp.booted),
    intervals: window.__intervals,
    authLoaded: !!(window.ClaritySupabaseAuth && typeof window.ClaritySupabaseAuth.freshAccessToken === "function"),
    signedOut: !window.ClarityApp.account.signedIn(),
    accountLine: document.getElementById("accountState").textContent
  }));

  /* Sign-in offline: the form submits, the request fails, and the failure is a
     status line — never an exception, never a retry loop. Fake credentials
     only; this asserts the error path. */
  const signIn = await page.evaluate(async () => {
    document.getElementById("accountAction").click();
    const onSignIn = document.body.classList.contains("route-signin");
    document.getElementById("signInEmail").value = "nobody@example.com";
    document.getElementById("signInPassword").value = "not-a-real-password";
    document.getElementById("signInForm").dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 800));
    return {
      onSignIn,
      status: document.getElementById("signInStatus").textContent,
      stillOnSignIn: document.body.classList.contains("route-signin")
    };
  });
  await page.evaluate(() => document.getElementById("signInBack").click());

  /* Picker flow, offline: Play opens the picker, the library fetch fails
     (static server), and the empty state is the answer — no exception, no
     retry loop. */
  await page.click("#playTile");
  await page.waitForTimeout(800);
  const picker = await page.evaluate(() => ({
    onPicker: document.body.classList.contains("route-picker"),
    emptyShown: !document.getElementById("pickerEmpty").classList.contains("hiddenState"),
    rows: document.querySelectorAll("#courseList .courseRow").length
  }));

  /* Course tap-through with a stubbed library row: lands on the play route
     with the live map visible (rule 2) and framed on the course. */
  /* Surface-first: a hole whose package declares a visual presents it without
     ever creating the OSM map underneath; the map is created the moment a
     hole with no surface is entered. */
  const surfaceFirst = await page.evaluate(async (h1) => {
    const app = window.ClarityApp;
    const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const origin = app.playSurface.worldPx(h1.tee.lat + 0.003, h1.tee.lng - 0.003, 18);
    const meta = { captureZoom: 18, originPx: { x: origin.x, y: origin.y }, outputDimensions: { width: 1341, height: 1889 } };
    const pkg = { holes: [
      { holeNumber: 1, geometry: { tee: h1.tee, green: h1.green, greenShape: h1.greenShape, route: [] }, visual: { url: PNG, playSurface: meta } },
      { holeNumber: 2, geometry: { tee: h1.tee, green: h1.green, greenShape: [], route: [] } }
    ] };
    const mapEmptyBefore = document.getElementById("map").childElementCount === 0;
    await app.play.start("surface-first-course", pkg, null);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const h1State = {
      presented: document.body.classList.contains("surface-published"),
      mapStillEmpty: document.getElementById("map").childElementCount === 0,
      chip: document.getElementById("surfaceSource").textContent
    };
    await app.play.goHole(2);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const h2State = {
      presented: document.body.classList.contains("surface-published"),
      mapCreated: document.getElementById("map").childElementCount > 0
    };
    return { mapEmptyBefore, h1State, h2State };
  }, AKARANA_H1);

  const play = await page.evaluate(async (h1) => {
    const app = window.ClarityApp;
    /* Lite-shaped package with the real hole 1 geometry: frames the hole AND
       feeds the distance bar once the granted fix arrives. */
    const pkg = { holes: [{ holeNumber: 1, tee: h1.tee, green: h1.green, greenShape: h1.greenShape, route: [] }] };
    await app.play.start("akarana-golf-club", pkg, { lat: -36.918, lng: 174.735 });
    document.body.classList.remove("route-home", "route-picker");
    document.body.classList.add("route-play");
    await new Promise((resolve) => setTimeout(resolve, 1200));   // let watchPosition deliver
    const style = getComputedStyle(document.getElementById("map"));
    return {
      mapDisplayed: style.visibility !== "hidden" && style.display !== "none",
      hole: app.play.state().hole,
      courseKey: app.play.state().courseKey,
      surfacePresented: document.body.classList.contains("surface-published"),
      gpsFix: app.gps.lastFix(),
      positionSource: app.position.current() && app.position.current().source,
      gpsMarkerOnMap: !!document.querySelector("#map .gpsMarker"),
      gpsDotHidden: document.getElementById("gpsDot").classList.contains("hiddenState"),
      distanceBarShown: !document.getElementById("distanceBar").classList.contains("hiddenState"),
      sourceChipHidden: document.getElementById("surfaceSource").classList.contains("hiddenState"),
      distFront: Number(document.getElementById("distFront").textContent),
      /* Centre no longer renders on the card (front/back cover it) — the
         underlying math still runs, so check it straight from the module. */
      distCentre: Math.round(app.distance.haversineMeters(app.position.current(), h1.green)),
      distBack: Number(document.getElementById("distBack").textContent)
    };
  }, AKARANA_H1);

  /* Off-course play: a course far from the granted fix. Entering the hole
     heads to the tee (the far fix is NOT adopted), and tapping where you are
     standing moves the position — the whole flow works from the couch. */
  const remote = await page.evaluate(async (h1) => {
    const app = window.ClarityApp;
    /* Same hole geometry shifted ~110km south — far outside the adopt radius. */
    const shift = (p) => ({ lat: p.lat - 1, lng: p.lng });
    const green = shift(h1.green);
    const pkg = { holes: [{ holeNumber: 1, tee: shift(h1.tee), green, greenShape: h1.greenShape.map(shift), route: [] }] };
    await app.play.start("remote-test-course", pkg, null);
    await new Promise((resolve) => setTimeout(resolve, 900));   // let any live fix arrive
    const preFrame = {
      pillShown: !document.getElementById("startPill").classList.contains("hiddenState"),
      hasPosition: !!app.position.current(),
      distanceHidden: document.getElementById("distanceBar").classList.contains("hiddenState")
    };
    document.getElementById("headToTeeBtn").click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const atTee = {
      source: app.position.current() && app.position.current().source,
      /* Centre no longer renders on the card — check the module directly. */
      centre: Math.round(app.distance.haversineMeters(app.position.current(), green)),
      pillShown: !document.getElementById("startPill").classList.contains("hiddenState")
    };
    /* Tap 100m up the fairway from the tee (~0.0009° of latitude). */
    app.position.set({ lat: shift(h1.tee).lat - 0.0009, lng: shift(h1.tee).lng }, "tap");
    const afterTap = {
      source: app.position.current().source,
      centre: Math.round(app.distance.haversineMeters(app.position.current(), green))
    };
    return { preFrame, atTee, afterTap };
  }, AKARANA_H1);

  /* Pre-locked framing in the page: a framed surface far from the granted fix
     keeps the tee position, and the dot renders exactly on the tee guide box. */
  const framed = await page.evaluate(async (h1) => {
    const app = window.ClarityApp;
    const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const shift = (p) => ({ lat: p.lat - 1, lng: p.lng });
    const tee = shift(h1.tee), green = shift(h1.green);
    const origin = app.playSurface.worldPx(green.lat + 0.004, green.lng - 0.004, 18);
    const meta = {
      captureZoom: 18, originPx: { x: origin.x, y: origin.y },
      outputDimensions: { width: 1341, height: 1889 },
      anchorPins: { tee, green }
    };
    const pkg = { holes: [{ holeNumber: 1, geometry: { tee, green, greenShape: [], route: [] }, visual: { url: PNG, playSurface: meta } }] };
    await app.play.start("framed-course", pkg, null);
    await new Promise((resolve) => setTimeout(resolve, 500));
    document.getElementById("headToTeeBtn").click();   // leave the pre-frame state
    await new Promise((resolve) => setTimeout(resolve, 60));
    const screen = document.getElementById("playScreen");
    const scrollJumped = screen.scrollTop !== 0 || screen.scrollLeft !== 0
      || document.getElementById("surfaceViewport").scrollTop !== 0;
    /* Head To the Tee's visible confirmation is the dot appearing — it must
       not be hidden underneath the distance bar. */
    const barRect = document.getElementById("distanceBar").getBoundingClientRect();
    const dotStyle = document.getElementById("gpsDot").style;
    const dotUnderBar = parseFloat(dotStyle.left) >= barRect.left && parseFloat(dotStyle.left) <= barRect.right
      && parseFloat(dotStyle.top) >= barRect.top && parseFloat(dotStyle.top) <= barRect.bottom;
    const img = document.getElementById("surfaceImage");
    const dot = document.getElementById("gpsDot");
    const act = app.shot.active();
    const engineDefault = {
      targetFromTee: act && act.target ? app.distance.haversineMeters(tee, act.target) : null,
      targetToGreen: act && act.target ? app.distance.haversineMeters(act.target, green) : null,
      maxCarry: window.GDBubbleEngine.maxPlayableCarryM(),
      shotRowShown: !document.getElementById("shotRow").classList.contains("hiddenState"),
      ringPaths: document.querySelectorAll("#bubbleSvg .ringOuter, #bubbleSvg .ringMain, #bubbleSvg .ringInner").length,
      svgShown: !document.getElementById("bubbleSvg").classList.contains("hiddenState"),
      aimLine: !!document.querySelector("#bubbleSvg .aimLine"),
      middleGuide: !!document.querySelector("#bubbleSvg .middleGuide"),
      middleLabel: (document.querySelector("#bubbleSvg .middleGuideLabel") || {}).textContent || "",
      fairwayLine: !!document.querySelector("#bubbleSvg .fairwayLine")
    };
    return {
      presented: document.body.classList.contains("surface-published"),
      transform: img.style.transform,
      positionSource: app.position.current() && app.position.current().source,
      dotVisible: !dot.classList.contains("hiddenState"),
      dot: { left: parseFloat(dot.style.left), top: parseFloat(dot.style.top) },
      view: { w: window.innerWidth, h: window.innerHeight },
      scrollJumped,
      dotUnderBar,
      engineDefault
    };
  }, AKARANA_H1);

  /* Stage transitions on the framed course: tee → hole frame; a tap up the
     fairway → lock (tilted); a tap by the green → zoom (flat); back to the
     tee → hole again. */
  const stages = await page.evaluate(async (h1) => {
    const app = window.ClarityApp;
    const shift = (p) => ({ lat: p.lat - 1, lng: p.lng });
    const tee = shift(h1.tee), green = shift(h1.green);
    const read = () => ({
      stage: document.body.dataset.frameStage,
      tilt: document.body.classList.contains("tilt-lock"),
      dotVisible: !document.getElementById("gpsDot").classList.contains("hiddenState")
    });
    const atTee = read();
    app.position.set({ lat: tee.lat - 0.0015, lng: tee.lng }, "tap");
    await new Promise((resolve) => setTimeout(resolve, 60));
    const lock = read();
    /* A GPS fix inside the same stage must move the dot, not the camera. */
    const img = document.getElementById("surfaceImage");
    const dotEl = document.getElementById("gpsDot");
    const frameBefore = img.style.transform;
    const dotBefore = dotEl.style.top;
    app.position.set({ lat: tee.lat - 0.0016, lng: tee.lng }, "gps");
    await new Promise((resolve) => setTimeout(resolve, 60));
    const gpsHold = {
      frameHeld: img.style.transform === frameBefore,
      dotMoved: dotEl.style.top !== dotBefore,
      stage: document.body.dataset.frameStage
    };
    /* The shot loop: aim off the green shows the shot row, and each tap
       records the previous shot. */
    const activeAfterLockTap = app.shot.active();
    app.shot.aim({ lat: tee.lat - 0.0025, lng: tee.lng });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const aimed = {
      shotRowShown: !document.getElementById("shotRow").classList.contains("hiddenState"),
      shotDist: Number(document.getElementById("shotDist").textContent),
      bubbleShown: !document.getElementById("aimBubble").classList.contains("hiddenState")
    };
    app.position.set({ lat: green.lat - 0.0002, lng: green.lng }, "tap");
    await new Promise((resolve) => setTimeout(resolve, 60));
    const zoom = read();
    const greenFocus = {
      ringShown: !document.getElementById("greenRing").classList.contains("hiddenState"),
      holeOutVisible: getComputedStyle(document.getElementById("holeOutBtn")).display !== "none",
      shotsRecorded: app.shot.holeShots(1).length
    };
    document.getElementById("holeOutBtn").click();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const holedOut = {
      hole: app.play.state().hole,
      shots: app.shot.holeShots(1).length,
      activeCleared: !app.shot.active()
    };
    return {
      atTee, lock, gpsHold,
      shotStart: activeAfterLockTap && activeAfterLockTap.start,
      aimed, zoom, greenFocus, holedOut
    };
  }, AKARANA_H1);

  /* Dragging the bubble: pointer events on the cluster hit move the aim and
     the frame holds mid-drag. */
  const bubbleDrag = await page.evaluate(async () => {
    const app = window.ClarityApp;
    /* Back to hole 1 (the stages scenario holed out onto hole 2). */
    await app.play.goHole(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    document.getElementById("headToTeeBtn").click();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const hit = document.getElementById("aimBubble");
    const before = app.shot.active().target;
    const rect = hit.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    const img = document.getElementById("surfaceImage");
    const frameBefore = img.style.transform;
    hit.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 9, clientX: cx, clientY: cy, bubbles: true }));
    let midDragFrameHeld = null;
    for (let i = 1; i <= 4; i++) {
      hit.dispatchEvent(new PointerEvent("pointermove", { pointerId: 9, clientX: cx, clientY: cy - i * 12, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (i === 2) midDragFrameHeld = img.style.transform === frameBefore;
    }
    hit.dispatchEvent(new PointerEvent("pointerup", { pointerId: 9, clientX: cx, clientY: cy - 48, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const after = app.shot.active().target;
    return {
      hitSized: rect.width >= 44 && rect.height >= 44,
      aimMovedM: app.distance.haversineMeters(before, after),
      midDragFrameHeld,
      draggingCleared: !document.body.classList.contains("bubble-dragging"),
      reframedAfter: img.style.transform !== frameBefore
    };
  });

  /* Base imagery policy: aerial only inside a licensed source's coverage —
     LINZ (keyed, NZ), NAIP (US), QLD (AU) — and the honest OSM fallback
     everywhere else, including NZ when the key never arrived. */
  const basemap = await page.evaluate(() => {
    const app = window.ClarityApp;
    const keylessNz = app.basemap.baseFor({ lat: -36.9, lng: 174.7 }).kind;
    app.basemap.configure({ linzBasemapsKey: "test-key" });
    return {
      keylessNz,
      nz: app.basemap.baseFor({ lat: -36.9, lng: 174.7 }).kind,
      pebbleBeach: app.basemap.baseFor({ lat: 36.564, lng: -121.938 }).kind,
      brisbane: app.basemap.baseFor({ lat: -27.5, lng: 153.0 }).kind,
      london: app.basemap.baseFor({ lat: 51.5, lng: -0.1 }).kind,
      naipTileIsBbox: (() => {
        const layer = app.basemap.baseFor({ lat: 36.564, lng: -121.938 }).layer;
        const url = layer.getTileUrl({ x: 41522, y: 101387, z: 18 });
        return url.includes("exportImage") && url.includes("bbox=");
      })()
    };
  });

  await browser.close();
  server.close();

  assert.strictEqual(errors.length, 0, "uncaught exceptions during boot:\n" + errors.join("\n"));
  assert.ok(state.booted, "ClarityApp.booted canary missing - the load order did not finish");
  assert.strictEqual(state.intervals, 0, "rule 3: no setInterval may be registered at boot");
  assert.ok(state.authLoaded, "clarity-supabase-auth must load in the fresh shell");
  assert.ok(state.signedOut, "a fresh profile starts signed out");
  assert.strictEqual(state.accountLine, "Not signed in");
  assert.ok(signIn.onSignIn, "Sign in must open the sign-in screen");
  assert.ok(signIn.status.length > 0, "an offline login must surface a status message");
  assert.ok(signIn.stillOnSignIn, "a failed login stays on the sign-in screen");
  assert.ok(picker.onPicker, "Play must open the course picker");
  assert.ok(picker.emptyShown, "offline picker must show its empty state");
  assert.strictEqual(picker.rows, 0, "offline picker must list no courses");
  assert.ok(surfaceFirst.mapEmptyBefore, "no map exists before play starts");
  assert.ok(surfaceFirst.h1State.presented, "a declared package visual must present");
  assert.ok(surfaceFirst.h1State.mapStillEmpty, "no OSM is created under a declared surface");
  assert.ok(surfaceFirst.h1State.chip.startsWith("pkg"), "the chip names the package source, got: " + surfaceFirst.h1State.chip);
  assert.strictEqual(surfaceFirst.h2State.presented, false, "no visual on hole 2 → back on the live map");
  assert.ok(surfaceFirst.h2State.mapCreated, "the map is created the moment absence is the answer");
  assert.ok(!framed.scrollJumped, "clicking the pill must not scroll-jump the play screen");
  assert.ok(!framed.dotUnderBar, "the tee dot must not hide under the distance bar");
  {
    const e = framed.engineDefault;
    assert.ok(e.targetToGreen > 30, "395m hole, " + Math.round(e.maxCarry) + "m bag → the default aim starts short of the green");
    assert.ok(Math.abs(e.targetFromTee - e.maxCarry) < 8,
      "the default aim sits at the max bag distance: " + Math.round(e.targetFromTee) + " vs " + Math.round(e.maxCarry));
    assert.ok(e.shotRowShown, "aimed short of the green from the tee → SHOT/REM row shows");
    assert.ok(e.svgShown && e.ringPaths === 3, "the engine's three cluster rings render on the surface, got " + e.ringPaths);
    assert.ok(e.aimLine, "the aim ray renders with the bubble");
    assert.ok(e.middleGuide, "laying up → the bubble→green middle guide shows");
    assert.ok(/^Green \d+m$/.test(e.middleLabel), "the middle guide labels the remaining leg, got: " + e.middleLabel);
    assert.ok(e.fairwayLine, "laying up → the fairway route line shows");
  }
  assert.ok(framed.presented, "framed course must present its surface");
  assert.ok(framed.transform.indexOf("matrix(") === 0, "the surface must carry the frame transform, got: " + framed.transform);
  assert.strictEqual(framed.positionSource, "tee", "far from the fix, the framed hole heads to the tee");
  assert.ok(framed.dotVisible, "the position dot renders on the framed surface");
  const expectedLeft = framed.view.w * (0.308 + 0.375 / 2);
  const expectedTop = framed.view.h * (0.881 + 0.037 / 2);
  assert.ok(Math.abs(framed.dot.left - expectedLeft) < 2 && Math.abs(framed.dot.top - expectedTop) < 2,
    "at the tee, the dot must sit on the tee guide box: got " + framed.dot.left + "," + framed.dot.top
    + " want " + expectedLeft + "," + expectedTop);
  assert.strictEqual(stages.atTee.stage, "lock", "placement IS the lock-in: head-to-tee locks the shot view");
  assert.ok(stages.atTee.tilt, "the locked shot view carries the tilt from the tee");
  assert.strictEqual(stages.lock.stage, "lock", "a tap up the fairway stays locked");
  assert.ok(stages.lock.tilt, "the lock stage carries the 32° tilt");
  assert.ok(stages.lock.dotVisible, "the player stays visible in lock");
  assert.strictEqual(stages.gpsHold.stage, "lock", "a same-stage GPS fix stays in lock");
  assert.ok(stages.gpsHold.frameHeld, "a same-stage GPS fix must NOT re-anchor the locked frame");
  assert.ok(stages.gpsHold.dotMoved, "a same-stage GPS fix still moves the dot");
  assert.strictEqual(stages.zoom.stage, "zoom", "inside 45m of the green → zoom stage");
  assert.ok(!stages.zoom.tilt, "green zoom is flat");
  assert.ok(stages.zoom.dotVisible, "the player stays visible in zoom");
  assert.ok(stages.shotStart, "a tap starts a shot");
  assert.ok(stages.aimed.bubbleShown, "the aim bubble renders on the locked view");
  assert.ok(stages.aimed.shotRowShown, "aiming off the green shows the shot row");
  assert.ok(stages.aimed.shotDist > 80 && stages.aimed.shotDist < 140,
    "shot distance must be the start→target number, got " + stages.aimed.shotDist);
  assert.ok(stages.greenFocus.ringShown, "green focus shows the green ring");
  assert.ok(stages.greenFocus.holeOutVisible, "green focus offers Hole Out");
  assert.strictEqual(stages.greenFocus.shotsRecorded, 2, "two shots recorded before holing out");
  assert.strictEqual(stages.holedOut.shots, 3, "Hole Out records the final shot");
  assert.strictEqual(stages.holedOut.hole, 2, "Hole Out advances to the next hole");
  assert.ok(stages.holedOut.activeCleared, "no active shot after holing out");
  assert.ok(bubbleDrag.hitSized, "the drag hit covers the cluster (44px minimum)");
  assert.ok(bubbleDrag.aimMovedM > 5, "dragging the bubble moves the aim, got " + bubbleDrag.aimMovedM.toFixed(1) + "m");
  assert.ok(bubbleDrag.midDragFrameHeld, "the camera holds mid-drag");
  assert.ok(bubbleDrag.draggingCleared, "release clears the dragging state");
  assert.ok(bubbleDrag.reframedAfter, "release re-frames start→target");
  assert.strictEqual(basemap.keylessNz, "osm", "no LINZ key → OSM even in NZ");
  assert.strictEqual(basemap.nz, "linz", "keyed NZ centre → LINZ aerial");
  assert.strictEqual(basemap.pebbleBeach, "naip", "US centre → NAIP aerial");
  assert.strictEqual(basemap.brisbane, "qld", "Queensland centre → QLD aerial");
  assert.strictEqual(basemap.london, "osm", "outside every aerial region → OSM, never empty tiles");
  assert.ok(basemap.naipTileIsBbox, "NAIP tiles are bbox exportImage requests");
  assert.ok(play.mapDisplayed, "rule 2: #map must be visible by default on the play route");
  assert.strictEqual(play.hole, 1, "play must start on hole 1");
  assert.strictEqual(play.courseKey, "akarana-golf-club");
  assert.strictEqual(play.surfacePresented, false, "no surface offline → live map, no overlay");
  assert.ok(play.sourceChipHidden, "no surface → no provenance chip");
  assert.ok(play.gpsFix, "the granted geolocation fix must reach the watcher");
  assert.ok(play.gpsMarkerOnMap, "the GPS marker must render on the live map");
  assert.ok(play.gpsDotHidden, "with no surface up, the projected dot stays hidden");
  assert.ok(play.distanceBarShown, "with a fix and a green, the distance bar must show");
  assert.ok(play.distFront < play.distCentre && play.distCentre < play.distBack,
    "F < C < B, got " + play.distFront + "/" + play.distCentre + "/" + play.distBack);
  /* The granted fix (-36.9174, 174.74) sits ~90m from Akarana green 1 — near
     the hole, so it is adopted over the tee position. */
  assert.strictEqual(play.positionSource, "gps", "an on-hole fix must take over from the tee");
  assert.ok(play.distCentre > 60 && play.distCentre < 120,
    "centre distance from the granted fix must be ~90m, got " + play.distCentre);
  assert.ok(remote.preFrame.pillShown, "pre-frame state shows the Standing Here / Head To the Tee pill");
  assert.ok(!remote.preFrame.hasPosition, "pre-frame state has no position - no pin exists yet");
  assert.ok(remote.preFrame.distanceHidden, "no position → no distances");
  assert.ok(!remote.atTee.pillShown, "placing the player retires the pill");
  assert.ok(remote.atTee.source === "tee", "Head To the Tee places the player on the tee");
  assert.ok(remote.atTee.centre > 380 && remote.atTee.centre < 410,
    "tee position must give the ~395m tee shot, got " + remote.atTee.centre);
  assert.strictEqual(remote.afterTap.source, "tap");
  assert.ok(remote.afterTap.centre > remote.atTee.centre - 120 && remote.afterTap.centre < remote.atTee.centre - 80,
    "a 100m tap up the fairway must shorten the shot ~100m, got " + remote.afterTap.centre);
  console.log("fresh-app boot passed: 0 uncaught exceptions, 0 intervals, picker empty-state, GPS adopt "
    + play.distFront + "/" + play.distCentre + "/" + play.distBack + "m, head-to-tee "
    + remote.atTee.centre + "m, tap " + remote.afterTap.centre + "m");
}
