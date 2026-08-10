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

  /* fetchRecord(courseKey) downloads the WHOLE course's visual record in one
     call, every hole included - a second hole of the SAME course must be
     answered from that one record, not trigger its own re-download. */
  let multiFetches = 0;
  const multiHoleRecord = {
    status: "published",
    uploaded_assets: [
      { holeNumber: 1, path: "a/h1.jpg", metadata: { playSurface: meta } },
      { holeNumber: 2, path: "a/h2.jpg", metadata: { playSurface: meta } }
    ]
  };
  const multiStore = surface.createStore({ fetchRecord: async () => { multiFetches += 1; return multiHoleRecord; } });
  const hole1 = await multiStore.surfaceFor("multi-hole-course", 1);
  const hole2 = await multiStore.surfaceFor("multi-hole-course", 2);
  assert.strictEqual(hole1.asset.path, "a/h1.jpg", "hole 1 gets its own asset from the shared record");
  assert.strictEqual(hole2.asset.path, "a/h2.jpg", "hole 2 gets its own asset from the SAME shared record");
  assert.strictEqual(multiFetches, 1, "a second hole of the same course must not re-download the course's visual record");

  /* forget() is the explicit refresh - it must drop the cached record too,
     or a stale record survives the very call meant to invalidate it. */
  multiStore.forget("multi-hole-course");
  await multiStore.surfaceFor("multi-hole-course", 1);
  assert.strictEqual(multiFetches, 2, "forget() must force the next lookup to re-fetch the record");

  console.log("fresh-app projection/store checks passed");
  await bootCheck();
})().catch((err) => { console.error(err); process.exit(1); });

/* ---- Part 2: headless boot ---- */

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp"
};

/* The hand-off package the harness round opens on. Hole 1 declares a captured
   visual, hole 2 does not — which is the surface-first pair: the declared
   surface must present without an OSM map ever being created underneath it,
   and the map must appear the moment a hole without one is entered. It has to
   be the FIRST round in the page, because "no map exists yet" stops being
   observable once any round has put one there. */
/* Every scenario that presents a surface uses its OWN tiny PNG. The painter
   re-presents when the hole or its surface URL changes, so two different
   courses sharing one URL would sit behind that cache instead of exercising
   it — a shape only a test ever builds, and one that quietly leaves the
   previous course's projection metadata in place. */
const SURFACE_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
function surfaceFirstPackage() {
  const origin = surface.worldPx(AKARANA_H1.tee.lat + 0.003, AKARANA_H1.tee.lng - 0.003, 18);
  const meta = { captureZoom: 18, originPx: { x: origin.x, y: origin.y },
    outputDimensions: { width: 1341, height: 1889 } };
  return {
    courseId: "surface-first-course", status: "full-map-ready", packageVersion: 1,
    holes: [
      { holeNumber: 1, geometry: { tee: AKARANA_H1.tee, green: AKARANA_H1.green,
        greenShape: AKARANA_H1.greenShape, route: [] },
        visual: { url: SURFACE_PNG, playSurface: meta } },
      { holeNumber: 2, geometry: { tee: AKARANA_H1.tee, green: AKARANA_H1.green, greenShape: [], route: [] } }
    ]
  };
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split("?")[0]);
      if (urlPath === "/api/course-package") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(surfaceFirstPackage()));
        return;
      }
      if (urlPath.startsWith("/api/")) { res.writeHead(404); res.end("{}"); return; }
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
    accountLine: document.getElementById("accountState").textContent,
    loadingScreenHidden: document.getElementById("loadingScreen").classList.contains("hiddenState"),
    /* Before any round: nothing has created a Leaflet map yet. */
    mapEmpty: document.getElementById("map").childElementCount === 0
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

  /* No picker or Play tile here any more — the main site's picker is the
     only entry point (via ?courseId=..., checked separately below); the
     global Home/Back bar plus the tool rail's GPS Settings icon are the
     only way out. */
  const noOwnPicker = await page.evaluate(() => ({
    noPickerScreen: !document.getElementById("pickerScreen"),
    noPlayTile: !document.getElementById("playTile"),
    globalNavExists: !!document.getElementById("globalHomeBtn")
      && !!document.getElementById("globalBackBtn") && !!document.getElementById("railGpsSettings")
  }));

  /* ---- into a round ----
     Every scenario below plays one, and a round belongs to the Marshal now:
     play.js, position.js and shot.js were retired with the Marshal/Painter
     rewrite, so `app.play`, `app.position` and `app.shot` no longer exist.
     boot.js builds the Marshal once, on the hand-off (?courseId=...), and hands
     it the effects it is allowed to cause. So the way in is the hand-off, and
     from there the scenarios drive the SAME Signals the screen does, through
     the marshal boot itself wired — not a stand-in built by the test. */
  await page.goto("http://127.0.0.1:" + port
    + "/app/index.html?courseId=surface-first-course&courseName=Surface+First&courseLat=-36.9175&courseLng=174.74",
    { waitUntil: "load" });
  await page.waitForFunction(() => window.ClarityApp && window.ClarityApp.marshal, { timeout: 15000 });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const app = window.ClarityApp;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms === undefined ? 220 : ms));
    const sig = (name, payload) => app.marshal.signal(name, payload);
    window.__gd = {
      wait,
      /* Poll rather than sleep. A surface decode, a camera solve and a dock
         face all settle on their own schedule, and a fixed sleep that is long
         enough today is the thing that makes a suite flaky next month. */
      async until(fn, label) {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          try { if (fn()) return true; } catch (e) {}
          await wait(40);
        }
        throw new Error("timed out waiting for " + (label || "condition"));
      },
      /* boot.js's own startRound(), reachable from a test — preceded by the
         painter.detach() that boot does on the way OUT of the previous round.
         Both halves are load-bearing: without the detach, a second course whose
         hole 1 also declares a surface matches loadedHole/loadedVisual and
         keeps the FIRST course's image and metadata, so every projection is
         solved against the wrong hole (painter.js's own note on detach). The
         route class comes with it because boot's show("play") is part of
         opening a round, and the camera cannot measure a screen that is down. */
      async open(courseKey, pkg, centre, settle) {
        /* Back to back, with nothing awaited in between: a GPS fix landing in
           the gap would publish the OUTGOING round's scene, and the painter
           would re-present its surface — repopulating exactly the state the
           detach just cleared, so the new course never loads its own. */
        app.painter.detach();
        sig("ROUND_OPENED", { courseKey: courseKey, pkg: pkg, centre: centre || null, nines: null });
        /* The browser's geolocation watch only fires on CHANGE, so a second
           round in the same page never hears the fix the first one consumed —
           and every round starts from a blank state. Replay the watcher's last
           reading through the same handler boot wires, so a round opened
           mid-test starts where a freshly-loaded one would. Courses far from
           it still refuse it, which is the point of the off-course cases. */
        const last = app.gps && app.gps.lastFix && app.gps.lastFix();
        if (last) sig("FIX_RECEIVED", { point: last });
        document.body.classList.remove("route-home");
        document.body.classList.add("route-play");
        await wait(settle === undefined ? 600 : settle);
      },
      /* Into Live: a trusted fix at the course, then Play. Preview needs
         neither — placing yourself is the whole gesture there. */
      async live(point, settle) {
        sig("FIX_RECEIVED", { point: point });
        await wait(120);
        sig("PLAY_PRESSED");
        await wait(settle === undefined ? 320 : settle);
      },
      async fix(point, settle) { sig("FIX_RECEIVED", { point: point }); await wait(settle); },
      async place(point, settle) { sig("PLACED", { point: point }); await wait(settle); },
      async goHole(n, settle) { sig("VIEW_HOLE_CHANGED", { hole: n }); await wait(settle); },
      async send(name, payload, settle) { sig(name, payload); await wait(settle); },
      async tap(id, settle) { document.getElementById(id).click(); await wait(settle); },
      scene: () => app.marshal.scene(),
      player: () => app.marshal.player(),
      hole: () => app.marshal.round().hole,
      courseKey: () => app.marshal.round().courseKey,
      shots: (h) => app.marshal.shots(h),
      openShot: (h) => app.marshal.openShot(h),
      shown: (id) => { const e = document.getElementById(id); return !!e && !e.classList.contains("hiddenState"); }
    };
  });

  /* Surface-first, read off that very hand-off: hole 1 declares a visual and
     presents it without ever creating the OSM map underneath; the map is
     created the moment hole 2 — which has no surface — is entered. */
  const surfaceFirst = await page.evaluate(async () => {
    const gd = window.__gd;
    const h1State = {
      hole: gd.hole(),
      presented: document.body.classList.contains("surface-published"),
      mapStillEmpty: document.getElementById("map").childElementCount === 0,
      chip: document.getElementById("surfaceSource").textContent,
      chipKind: document.getElementById("surfaceSource").dataset.source
    };
    await gd.goHole(2, 600);
    const h2State = {
      presented: document.body.classList.contains("surface-published"),
      mapCreated: document.getElementById("map").childElementCount > 0
    };
    return { h1State, h2State };
  });

  const play = await page.evaluate(async (h1) => {
    const app = window.ClarityApp, gd = window.__gd;
    /* Lite-shaped package with the real hole 1 geometry: frames the hole AND
       feeds the distance bar once the granted fix arrives. */
    const pkg = { holes: [{ holeNumber: 1, tee: h1.tee, green: h1.green, greenShape: h1.greenShape, route: [] }] };
    await gd.open("akarana-golf-club", pkg, { lat: -36.918, lng: 174.735 });
    await gd.until(() => !!app.gps.lastFix(), "the granted geolocation to reach the watcher");
    await gd.until(() => !!gd.scene().locator, "the trusted fix to reach the scene");
    /* The granted fix is at the course, so Play is offered — and pressing it is
       what makes the fix the PLAYER. In Preview the fix is only ever the
       locator (it draws the dot); the distances measure from your placement,
       and there isn't one yet. */
    const playOffered = gd.scene().playButton.show;
    const previewDotShown = gd.shown("gpsDot");
    const previewDistances = gd.scene().distances.show;
    await gd.send("PLAY_PRESSED");
    await gd.until(() => gd.scene().flow === "live", "Play to start the round");
    await gd.until(() => gd.shown("distanceBar"), "the distance bar to read off the fix");
    const style = getComputedStyle(document.getElementById("map"));
    return {
      mapDisplayed: style.visibility !== "hidden" && style.display !== "none",
      hole: gd.hole(),
      courseKey: gd.courseKey(),
      surfacePresented: document.body.classList.contains("surface-published"),
      gpsFix: app.gps.lastFix(),
      playOffered, previewDotShown, previewDistances,
      flow: gd.scene().flow,
      /* One projected dot serves both presentations now, so on the live map
         it is the marker — and it must land inside the viewport, which is the
         real check that the live frame projects rather than just that some
         element exists. */
      gpsDotShown: gd.shown("gpsDot"),
      gpsDotAt: {
        left: parseFloat(document.getElementById("gpsDot").style.left),
        top: parseFloat(document.getElementById("gpsDot").style.top)
      },
      mapFramed: document.body.classList.contains("map-framed"),
      frameStage: document.body.dataset.frameStage,
      attribution: document.getElementById("mapAttribution").textContent,
      distanceBarShown: gd.shown("distanceBar"),
      sourceChipKind: document.getElementById("surfaceSource").dataset.source,
      sourceChipText: document.getElementById("surfaceSource").textContent,
      distFront: Number(document.getElementById("distFront").textContent),
      /* Centre no longer renders on the card (front/back cover it) — the
         underlying math still runs, so check it straight from the module. */
      distCentre: Math.round(app.distance.haversineMeters(gd.player(), h1.green)),
      distBack: Number(document.getElementById("distBack").textContent)
    };
  }, AKARANA_H1);

  /* Head To the Tee is a PIN, not a nudge. Preview SETUP offers two ways to
     place yourself — the tee button or a tap where you'd stand — and once you
     have used either, you are AIMING: a further tap must not drag the origin
     sideways, and a live fix must not quietly adopt you somewhere else. The
     way to change your mind is Unlock (back to SETUP with the pill up) or
     leaving the hole, both of which clear the placement. */
  const teePin = await page.evaluate(async (h1) => {
    const app = window.ClarityApp, gd = window.__gd;
    const pkg = { holes: [{ holeNumber: 1, tee: h1.tee, green: h1.green,
      greenShape: h1.greenShape, route: [] }] };
    await gd.open("tee-pin-course", pkg, { lat: -36.918, lng: 174.735 }, 900);
    const setup = { flow: gd.scene().flow, mode: gd.scene().mode,
      pillShown: gd.shown("startPill"), placed: !!gd.player() };
    await gd.tap("headToTeeBtn", 60);
    const offTee = () => Math.round(app.distance.haversineMeters(gd.player(), h1.tee));
    const atTee = { mode: gd.scene().mode, offTee: offTee(), pillShown: gd.shown("startPill") };
    /* A map tap must move the pin, never the player. */
    document.getElementById("map").dispatchEvent(
      new MouseEvent("click", { clientX: 240, clientY: 300, bubbles: true }));
    await gd.wait(120);
    const afterTap = { mode: gd.scene().mode, offTee: offTee() };
    return { setup, atTee, afterTap };
  }, AKARANA_H1);

  /* A fresh live fix, delivered while placed, must also be ignored: in Preview
     the fix is the locator, never the player. */
  await context.setGeolocation({ latitude: -36.9179, longitude: 174.7409 });
  await page.waitForTimeout(700);
  const teePinAfterFix = await page.evaluate((h1) => {
    const app = window.ClarityApp, gd = window.__gd;
    return {
      offTee: Math.round(app.distance.haversineMeters(gd.player(), h1.tee)),
      fixMoved: !!app.gps.lastFix(),
      locatorMoved: !!gd.scene().locator
    };
  }, AKARANA_H1);

  /* Unlock, and leaving the hole, both give the choice back. */
  const afterLeaving = await page.evaluate(async () => {
    const gd = window.__gd;
    await gd.send("UNLOCK", null, 200);
    const unlocked = { mode: gd.scene().mode, placed: !!gd.player(), pillShown: gd.shown("startPill") };
    await gd.place({ lat: -36.9140, lng: 174.7405 }, 200);
    const replaced = { mode: gd.scene().mode, placed: !!gd.player() };
    await gd.goHole(2, 400);
    await gd.goHole(1, 400);
    return { unlocked, replaced, afterHoleChange: { mode: gd.scene().mode, placed: !!gd.player() } };
  });

  /* The tap seam, end to end. "or tap where you'd stand" is half of Preview's
     SETUP pill, so a tap has to land you exactly where you touched — which is
     only true if screen → latLng round-trips through the same projection the
     overlays draw with. Aim it at the green, because the package knows where
     the green is and so the answer is checkable to the metre.

     (What this scenario used to assert — that a tap on a MAPPED hole must be
     ignored unless you first pressed "Standing Here" — was play.js's policy.
     There is no Standing Here button any more: placing yourself IS Preview,
     mapped or not, and the rule that replaced it is teePin's above, that a tap
     stops moving you the moment you have placed yourself.) */
  const greenTap = await page.evaluate(async (h1) => {
    const app = window.ClarityApp, gd = window.__gd;
    const tapAtGreen = async () => {
      /* Aim the tap at wherever the green is actually drawn on screen. Take
         the CLOSEST point rather than the first inside a tolerance - the
         metres-per-pixel varies a lot between stages, so a fixed tolerance
         plus a fixed step can stride straight over the green. */
      const proj = app.painter.latLngAt;
      let hit = null, best = Infinity;
      /* Scan the real viewport, not a hardcoded phone width - the stage
         decides where on screen the green lands, and a fixed box can miss it
         entirely once the framing changes. */
      for (let y = 60; y < window.innerHeight - 40; y += 6) {
        for (let x = 20; x < window.innerWidth - 20; x += 6) {
          const ll = proj(x, y);
          if (!ll) continue;
          const d = app.distance.haversineMeters(ll, h1.green);
          if (d < best) { best = d; hit = [x, y]; }
        }
      }
      if (!hit || best > 12) return null;
      document.getElementById("map").dispatchEvent(
        new MouseEvent("click", { clientX: hit[0], clientY: hit[1], bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 120));
      return hit;
    };

    // A mapped hole, in SETUP: tapping the green puts you on the green.
    await gd.open("green-tap-mapped", { holes: [{ holeNumber: 1,
      tee: h1.tee, green: h1.green, greenShape: h1.greenShape, route: [] }] },
      { lat: -36.918, lng: 174.735 }, 900);
    const before = gd.player();
    const hit = await tapAtGreen();
    const after = gd.player();
    const mapped = {
      /* If this ever fails, mapState is the thing to look at: a Leaflet size
         of 0 means the camera was solved before the screen was measurable. */
      mapState: JSON.stringify(app.painter.mapState()),
      foundGreenOnScreen: !!hit,
      placedFromNothing: !before && !!after,
      landedOnGreen: after ? Math.round(app.distance.haversineMeters(after, h1.green)) : null,
      /* Even on the green, placing yourself is AIM. Preview has exactly two
         modes now: a tap near a green used to drop you into green focus, which
         made the mode depend on where your finger landed rather than on
         anything you asked for. */
      mode: gd.scene().mode,
      flow: gd.scene().flow
    };

    // An UNMAPPED hole (no geometry at all) still takes the tap.
    await gd.open("green-tap-unmapped", { holes: [{ holeNumber: 1 }] },
      { lat: -36.918, lng: 174.735 }, 700);
    document.getElementById("map").dispatchEvent(
      new MouseEvent("click", { clientX: 200, clientY: 400, bubbles: true }));
    await gd.wait(120);
    return { mapped, unmappedPlaces: !!gd.player() };
  }, AKARANA_H1);


  /* GPS Settings: the four legacy controls that survived the rebuild have to
     actually reach the render, and the rail button must open the sheet in
     place rather than navigating to the main site the way it used to. */
  const gpsSettings = await page.evaluate(async (h1) => {
    const app = window.ClarityApp, gd = window.__gd, S = app.gpsSettings;
    const wait = () => gd.wait(220);
    await gd.open("settings-course", { holes: [{ holeNumber: 1,
      tee: h1.tee, green: h1.green, greenShape: h1.greenShape,
      route: [{ lat: -36.91860, lng: 174.74190 }] }] }, { lat: -36.918, lng: 174.735 }, 800);
    await gd.tap("headToTeeBtn");

    const href = location.href;
    document.getElementById("railGpsSettings").click();
    const opened = { navigatedAway: location.href !== href,
      panelOpen: !document.getElementById("gpsSettingsPanel").classList.contains("hiddenState") };

    const front = () => document.getElementById("distFront").textContent;
    const guide = () => (document.querySelector("#bubbleSvg .middleGuideLabel") || {}).textContent || "";
    const angle = () => { const m = getComputedStyle(document.getElementById("map")).transform;
      const n = m.match(/matrix\(([^,]+),([^,]+)/);
      return n ? Math.round(Math.atan2(+n[2], +n[1]) * 180 / Math.PI) : null; };

    const metres = { front: front(), guide: guide() };
    S.set("units", "yd"); await wait();
    const yards = { front: front(), guide: guide() };
    S.set("units", "m"); await wait();

    S.set("aimLine", false); await wait();
    const aimOff = { line: !!document.querySelector("#bubbleSvg .aimLine"),
      bubble: !!document.querySelector("#bubbleSvg .bubbleFill") };
    S.set("aimLine", true); await wait();
    const aimOn = { line: !!document.querySelector("#bubbleSvg .aimLine") };

    const rotated = angle();
    S.set("shotUp", false); await wait();
    const flat = angle();
    S.set("shotUp", true); await wait();

    /* Tightness in real terms: metres per screen pixel, read through the
       same seam the overlays use (the pin marker). */
    const a = h1.tee, b = { lat: h1.tee.lat + 0.001, lng: h1.tee.lng };
    const apart = app.distance.haversineMeters(a, b);
    const marker = document.getElementById("pinMarker");
    const at = async (p) => { app.pin.set(p); await new Promise((r) => setTimeout(r, 60));
      return [parseFloat(marker.style.left), parseFloat(marker.style.top)]; };
    const scale = async () => { const pa = await at(a), pb = await at(b);
      return apart / Math.hypot(pb[0] - pa[0], pb[1] - pa[1]); };
    const mpp = {};
    for (const t of ["wide", "medium", "tight"]) { S.set("frameTightness", t); await wait(); mpp[t] = await scale(); }
    S.set("frameTightness", "medium"); app.pin.clear();

    /* Every rail icon the same size - the gear used to fill its button. */
    document.getElementById("toolRailTab").click();
    const iconSizes = [...document.querySelectorAll("#toolRail .railBtn")].map((b) => {
      const g = b.querySelector("img, svg"); const r = g.getBoundingClientRect();
      return Math.round(r.width) + "x" + Math.round(r.height);
    });
    document.getElementById("toolRailTab").click();

    try { localStorage.removeItem("clarity:gps-settings:v1"); } catch (e) {}
    return { opened, metres, yards, aimOff, aimOn, rotated, flat, mpp, iconSizes };
  }, AKARANA_H1);

  /* Green focus: arriving at the green with a shot outstanding opens Finish by
     itself, and the whole point is that it is STICKY — you can walk on to the
     next tee with the ball still where you arrived and the camera keeps holding
     the green you are logging, so the ball has something to be dragged onto.
     Shot End then records where the BALL is, not where the player is standing.

     Live only: Finish opens off a trusted fix and needs an open shot, so this
     walks the real route — fix at the course, Play, Lock, then walk in. */
  const greenFocus = await page.evaluate(async (h1) => {
    const app = window.ClarityApp, gd = window.__gd;
    const ball = document.getElementById("greenFocusBall");
    const near = (m) => ({ lat: h1.green.lat + m / 111320, lng: h1.green.lng });
    await gd.open("green-focus-course", { holes: [{ holeNumber: 1,
      tee: h1.tee, green: h1.green, greenShape: h1.greenShape, route: [] }] },
      { lat: -36.918, lng: 174.735 });
    await gd.live(h1.tee);
    await gd.send("LOCK");                            // opens the shot to log
    await gd.until(() => gd.scene().mode === "aim", "Lock to raise the shot view");
    const openedShot = !!gd.openShot(1);

    /* Where the green is drawn — the ball has to be draggable onto it. */
    const greenOnScreen = async () => {
      app.pin.set(h1.green); await gd.wait(60);
      const m = document.getElementById("pinMarker");
      return m.classList.contains("hiddenState") ? null
        : [Math.round(parseFloat(m.style.left)), Math.round(parseFloat(m.style.top))];
    };
    const state = () => ({
      mode: gd.scene().mode,
      stage: document.body.dataset.frameStage,
      ball: gd.shown("greenFocusBall"),
      origin: gd.shown("finishOrigin"),
      hint: gd.shown("greenFocusHint"),
      dock: gd.shown("shotActionBtn"),
      dockFace: document.getElementById("shotActionBtn").dataset.action,
      /* Aiming instruments. Standing on the green there is nothing to aim, so
         the engine must not be asked to model a shot from there - it answers
         with the shortest club and a bag-roof clamp that throws the cluster
         well past the green, which showed up as a bubble anchored on the
         green itself. */
      aimPaths: document.getElementById("bubbleSvg").children.length,
      bubble: gd.shown("aimBubble"),
      shotRow: gd.shown("shotRow"),
      distBarPaused: !gd.shown("distanceBar")
    });

    /* Two fixes clear of the lock point release Aim back to Track (§4), which
       is the state arriving at a green is judged from. 120m out, then 28m. */
    await gd.fix(near(120));
    await gd.fix(near(120));
    await gd.until(() => gd.scene().mode === "track", "Aim to release back to Track");
    const beforeArrival = state();
    await gd.fix(near(28));
    await gd.until(() => gd.scene().mode === "finish", "arrival to open Finish");
    const onGreen = state();
    const greenAtArrival = await greenOnScreen();

    /* Walk 260m past the green to the next tee without touching the ball. */
    await gd.fix(near(-260), 320);
    const atNextTee = state();
    const greenStillFramed = await greenOnScreen();
    app.pin.clear(); await gd.wait(60);

    /* Pick the ball up and drop it on the green. */
    const box = ball.getBoundingClientRect();
    const grab = [Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2)];
    const drop = greenStillFramed ? [greenStillFramed[0] - 22, greenStillFramed[1] + 34] : [180, 320];
    for (const [type, xy] of [["pointerdown", grab], ["pointermove", drop], ["pointerup", drop]]) {
      ball.dispatchEvent(new PointerEvent(type, { clientX: xy[0], clientY: xy[1], bubbles: true, pointerId: 7 }));
    }
    await gd.wait();
    const afterDrop = state();
    const droppedLL = app.painter.latLngAt(drop[0], drop[1]);
    const playerPos = gd.player();

    await gd.tap("shotActionBtn");
    await gd.until(() => gd.scene().mode === "logged", "the shot to land on Logged");
    const shots = gd.shots(1);
    const last = shots[shots.length - 1];
    return {
      openedShot, beforeArrival, onGreen, atNextTee, afterDrop,
      greenHeld: greenAtArrival && greenStillFramed
        && greenAtArrival[0] === greenStillFramed[0] && greenAtArrival[1] === greenStillFramed[1],
      recorded: {
        shots: shots.length,
        offBall: last && last.end && droppedLL
          ? Number(app.distance.haversineMeters(last.end, droppedLL).toFixed(1)) : null,
        endFromGreen: last && last.end ? Math.round(app.distance.haversineMeters(last.end, h1.green)) : null,
        playerFromGreen: Math.round(app.distance.haversineMeters(playerPos, h1.green)),
        method: last && last.method,
        hole: gd.hole(),
        loggedShown: gd.shown("loggedScreen")
      }
    };
  }, AKARANA_H1);

  /* The approach shot: standing inside the bag's reach with the aim on its
     default (the green), club/total/carry must stay on the card. This used to
     hide whenever the landing was within 3m of the green — which IS the
     normal approach — so the numbers vanished exactly when they were wanted. */
  const approachCard = await page.evaluate(async (h1) => {
    const app = window.ClarityApp, gd = window.__gd;
    await gd.open("approach-card-course", { holes: [{ holeNumber: 1,
      tee: h1.tee, green: h1.green, greenShape: h1.greenShape, route: [] }] },
      { lat: -36.918, lng: 174.735 }, 700);
    /* ~120m out: the green is comfortably inside the bag, so the default aim
       lands on it and the old rule would have hidden the row. Placing yourself
       is an automatic lock-in, so the bubble and the card are up with nothing
       else pressed (§3). */
    await gd.place({ lat: h1.green.lat - 0.00108, lng: h1.green.lng + 0.0004 }, 350);
    const model = window.GDBubbleEngine.renderModel();
    const landing = (model && model.center) || gd.scene().bubble.target;
    return {
      rowShown: gd.shown("shotRow"),
      club: document.getElementById("shotClub").textContent,
      dist: Number(document.getElementById("shotDist").textContent),
      /* Proof the aim really is on the green - otherwise this asserts nothing. */
      landingFromGreen: landing ? Math.round(app.distance.haversineMeters(landing, h1.green)) : null
    };
  }, AKARANA_H1);

  /* Off-course play: a course far from the granted fix. The far fix is refused
     outright (it is not at THIS course), so there is no Play button and no
     position — just the pill — and the whole flow still works from the couch:
     head to the tee, unlock, place yourself somewhere else. */
  const remote = await page.evaluate(async (h1) => {
    const app = window.ClarityApp, gd = window.__gd;
    /* Same hole geometry shifted ~110km south — far outside the adopt radius. */
    const shift = (p) => ({ lat: p.lat - 1, lng: p.lng });
    const tee = shift(h1.tee), green = shift(h1.green);
    const pkg = { holes: [{ holeNumber: 1, tee, green, greenShape: h1.greenShape.map(shift), route: [] }] };
    await gd.open("remote-test-course", pkg, null, 900);          // let any live fix arrive
    const preFrame = {
      pillShown: gd.shown("startPill"),
      hasPosition: !!gd.player(),
      playOffered: gd.scene().playButton.show,
      distanceHidden: !gd.shown("distanceBar")
    };
    await gd.tap("headToTeeBtn", 60);
    const atTee = {
      flow: gd.scene().flow,
      /* Centre no longer renders on the card — check the module directly. */
      centre: Math.round(app.distance.haversineMeters(gd.player(), green)),
      pillShown: gd.shown("startPill")
    };
    /* Unlock, then place 100m up the fairway from the tee (~0.0009° of lat). */
    await gd.send("UNLOCK", null, 120);
    await gd.place({ lat: tee.lat - 0.0009, lng: tee.lng }, 120);
    const afterTap = {
      flow: gd.scene().flow,
      centre: Math.round(app.distance.haversineMeters(gd.player(), green))
    };
    return { preFrame, atTee, afterTap };
  }, AKARANA_H1);

  /* Pre-locked framing in the page: a framed surface far from the granted fix
     holds the tee placement, and the shot it raises lands on screen. The dot is
     NOT the confirmation any more — it draws where you ACTUALLY are (§6), and
     off-course that is nowhere; placing yourself shows up as the bubble. */
  const framed = await page.evaluate(async (h1) => {
    const app = window.ClarityApp, gd = window.__gd;
    const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    const shift = (p) => ({ lat: p.lat - 1, lng: p.lng });
    const tee = shift(h1.tee), green = shift(h1.green);
    const origin = app.playSurface.worldPx(green.lat + 0.004, green.lng - 0.004, 18);
    const meta = {
      captureZoom: 18, originPx: { x: origin.x, y: origin.y },
      outputDimensions: { width: 1341, height: 1889 },
      anchorPins: { tee, green }
    };
    const pkg = { holes: [{ holeNumber: 1, geometry: { tee, green, greenShape: [], route: [] }, visual: { url: PNG, playSurface: meta } }] };
    await gd.open("framed-course", pkg, null);
    await gd.until(() => document.body.classList.contains("surface-published"), "the surface to present");
    await gd.tap("headToTeeBtn");                      // leave the pre-frame state
    await gd.until(() => gd.shown("aimBubble"), "the bubble to come up on the surface");
    const screen = document.getElementById("playScreen");
    const scrollJumped = screen.scrollTop !== 0 || screen.scrollLeft !== 0
      || document.getElementById("surfaceViewport").scrollTop !== 0;
    /* Head To the Tee's visible confirmation is the bubble coming up — it must
       land on screen and not underneath the distance bar. */
    const barRect = document.getElementById("distanceBar").getBoundingClientRect();
    const aim = document.getElementById("aimBubble").getBoundingClientRect();
    const bubbleUnderBar = aim.left < barRect.right && aim.right > barRect.left
      && aim.top < barRect.bottom && aim.bottom > barRect.top;
    const img = document.getElementById("surfaceImage");
    const shot = gd.scene().bubble;
    /* Where the tee lands on screen, read through the same projection seam the
       overlays draw with. The dot used to be this check; off-course there is no
       dot to read, and the pin marker answers the same question. */
    app.pin.set(tee);
    await gd.wait(80);
    const marker = document.getElementById("pinMarker");
    const teeOnScreen = { left: parseFloat(marker.style.left), top: parseFloat(marker.style.top) };
    app.pin.clear();
    await gd.wait(60);
    const engineDefault = {
      targetFromTee: shot.target ? app.distance.haversineMeters(tee, shot.target) : null,
      targetToGreen: shot.target ? app.distance.haversineMeters(shot.target, green) : null,
      maxCarry: window.GDBubbleEngine.maxPlayableCarryM(),
      shotRowShown: gd.shown("shotRow"),
      bubbleShapes: document.querySelectorAll("#bubbleSvg .bubbleFill, #bubbleSvg .bubbleEdge").length,
      legacyRings: document.querySelectorAll("#bubbleSvg .ringOuter, #bubbleSvg .ringMain, #bubbleSvg .ringInner").length,
      carryKnockout: !!document.querySelector("#bubbleSvg mask[id$='-carry']"),
      clubChip: (function () {
        var c = document.getElementById("bubbleClub");
        return c && !c.classList.contains("hiddenState") ? c.textContent : null;
      })(),
      svgShown: gd.shown("bubbleSvg"),
      aimLine: !!document.querySelector("#bubbleSvg .aimLine"),
      middleGuide: !!document.querySelector("#bubbleSvg .middleGuide"),
      middleLabel: (document.querySelector("#bubbleSvg .middleGuideLabel") || {}).textContent || "",
      fairwayLine: !!document.querySelector("#bubbleSvg .fairwayLine")
    };
    return {
      presented: document.body.classList.contains("surface-published"),
      transform: img.style.transform,
      flow: gd.scene().flow,
      offTee: Math.round(app.distance.haversineMeters(gd.player(), tee)),
      /* The granted fix is 110km away, so it is refused: no locator, no dot. */
      dotVisible: gd.shown("gpsDot"),
      bubbleVisible: gd.shown("aimBubble"),
      teeOnScreen,
      view: { w: window.innerWidth, h: window.innerHeight },
      scrollJumped,
      bubbleUnderBar,
      engineDefault
    };
  }, AKARANA_H1);

  /* Camera stages on the framed course, driven by the MODE rather than by
     where the player is standing: SETUP frames the hole, AIM is the tilted
     shot view, and placing yourself on the green is the flat green view. This
     is Preview, so the other half of the check is that walking the whole
     sequence records absolutely nothing (§3) — Preview cannot open a shot. */
  const stages = await page.evaluate(async (h1) => {
    const gd = window.__gd;
    const shift = (p) => ({ lat: p.lat - 1, lng: p.lng });
    const tee = shift(h1.tee), green = shift(h1.green);
    const read = () => ({
      mode: gd.scene().mode,
      stage: document.body.dataset.frameStage,
      tilt: document.body.classList.contains("tilt-lock"),
      dotVisible: gd.shown("gpsDot"),
      /* In green focus the dot is replaced by the draggable ball, so "the
         player is visible" means one or the other, never both. */
      ballVisible: gd.shown("greenFocusBall")
    });
    /* framed left us placed at the tee — Unlock is the way back to SETUP. */
    await gd.send("UNLOCK");
    await gd.until(() => document.body.dataset.frameStage === "hole", "the hole frame");
    const atTee = read();
    await gd.place({ lat: tee.lat - 0.0015, lng: tee.lng });
    await gd.until(() => document.body.dataset.frameStage === "lock", "the locked shot view");
    const lock = read();
    /* A fix inside the same stage must move the dot, not the camera — and in
       Preview it must not move the PLAYER either (teePin's rule, seen from the
       camera's side). The round's centre came from this package, so a fix on
       this course is trusted even though the browser's granted one is not. */
    const img = document.getElementById("surfaceImage");
    const dotEl = document.getElementById("gpsDot");
    const frameBefore = img.style.transform;
    const placedBefore = JSON.stringify(gd.player());
    await gd.fix({ lat: tee.lat - 0.0016, lng: tee.lng }, 200);
    const gpsHold = {
      frameHeld: img.style.transform === frameBefore,
      dotAppeared: gd.shown("gpsDot") && !!dotEl.style.top,
      playerHeld: JSON.stringify(gd.player()) === placedBefore,
      stage: document.body.dataset.frameStage
    };
    /* Dragging the aim keeps the shot row live and never re-frames. */
    await gd.send("AIM_DRAGGED", { point: { lat: tee.lat - 0.0025, lng: tee.lng } }, 120);
    const aimed = {
      shotRowShown: gd.shown("shotRow"),
      shotDist: Number(document.getElementById("shotDist").textContent),
      bubbleShown: gd.shown("aimBubble")
    };
    /* And the green is not a trapdoor: Preview has SETUP and AIM and nothing
       else, so standing yourself on the green is still the shot view. Green
       focus belongs to Live arrival and to the picker's catch-up, both of
       which need an open shot — and Preview can never open one. */
    await gd.send("UNLOCK");
    await gd.until(() => gd.scene().mode === "setup", "Preview to rest at SETUP");
    await gd.place({ lat: green.lat - 0.0002, lng: green.lng });
    await gd.until(() => gd.scene().mode === "aim", "the green placement to be an ordinary AIM");
    const onGreen = read();
    const greenIsNotATrapdoor = {
      offGreen: Math.round(gd.scene().hole.rec
        ? window.ClarityApp.distance.haversineMeters(gd.player(), gd.scene().hole.rec.green) : -1),
      ballVisible: gd.shown("greenFocusBall"),
      /* Shot End is the single confirm - Hole Out is gone, because in green
         focus the two had become the same action on the same point. */
      holeOutGone: !document.getElementById("holeOutBtn"),
      dockFace: document.getElementById("shotActionBtn").dataset.action,
      shotsRecorded: gd.shots(1).length
    };
    return { atTee, lock, gpsHold, aimed, onGreen, greenIsNotATrapdoor };
  }, AKARANA_H1);

  /* The dock's three faces, in Live, where all three exist. Track offers Lock;
     Lock opens a shot and the face becomes Unlock, which releases the VIEW and
     records nothing — the shot stays in flight and the NEXT lock closes it; on
     the green the face is Shot End, and that one really does log.
     frameStage (what "green focus" means) is only tracked once a real surface
     is up - same as the `framed` scenario above - so hole 1 needs a captured
     visual, not just geometry. */
  const shotEndWiring = await page.evaluate(async (h1) => {
    const app = window.ClarityApp, gd = window.__gd;
    const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC";
    const shift = (p) => ({ lat: p.lat - 2, lng: p.lng });
    const tee = shift(h1.tee), green = shift(h1.green);
    const origin = app.playSurface.worldPx(green.lat + 0.004, green.lng - 0.004, 18);
    const meta = {
      captureZoom: 18, originPx: { x: origin.x, y: origin.y },
      outputDimensions: { width: 1341, height: 1889 },
      anchorPins: { tee, green }
    };
    const pkg = { holes: [
      { holeNumber: 1, geometry: { tee, green, greenShape: [], route: [] }, visual: { url: PNG, playSurface: meta } },
      { holeNumber: 2, geometry: { tee, green, greenShape: [], route: [] } }
    ] };
    const face = () => document.getElementById("shotActionBtn").dataset.action;
    await gd.open("shot-end-wiring-course", pkg, null);
    await gd.until(() => document.body.classList.contains("surface-published"), "the surface to present");
    await gd.live({ lat: tee.lat - 0.0015, lng: tee.lng });
    await gd.until(() => face() === "lock", "the dock to offer Lock");
    const tracking = { mode: gd.scene().mode, stage: document.body.dataset.frameStage, face: face() };
    await gd.tap("shotActionBtn");                      // Lock
    await gd.until(() => face() === "unlock", "the dock to offer Unlock");
    const lockStage = document.body.dataset.frameStage;
    const lockedFace = face();
    const openedShot = gd.openShot(1);
    await gd.tap("shotActionBtn");                      // Unlock
    await gd.until(() => gd.scene().mode === "track", "Live to return to Track");
    const afterUnlock = {
      hole: gd.hole(),
      mode: gd.scene().mode,
      shots: gd.shots(1).length,
      stage: document.body.dataset.frameStage,
      stillInFlight: !!gd.openShot(1),
      face: face(),
      /* The dock stays offered in Track, because the next Lock is right there.
         What it must NOT have done is record an end. */
      shown: gd.shown("shotActionBtn"),
      endRecorded: !!(gd.shots(1)[0] || {}).end
    };
    /* Walk in: the arrival fix opens Finish because a shot is outstanding. */
    await gd.fix({ lat: green.lat - 0.0002, lng: green.lng });
    await gd.until(() => gd.scene().mode === "finish", "arrival to open Finish");
    await gd.until(() => face() === "shotEnd", "the dock to offer Shot End");
    const zoomStage = document.body.dataset.frameStage;
    const greenFace = face();
    const shotsBeforeGreenFocusClick = gd.shots(1).length;
    await gd.tap("shotActionBtn");                      // Shot End
    await gd.until(() => gd.scene().mode === "logged", "the shot to land on Logged");
    const logged = gd.shots(1);
    return {
      tracking, lockStage, lockedFace, afterUnlock, zoomStage, greenFace,
      shotsBeforeGreenFocusClick,
      lockStartOffTee: openedShot
        ? Math.round(app.distance.haversineMeters(openedShot.start, { lat: tee.lat - 0.0015, lng: tee.lng })) : null,
      hole: gd.hole(),
      mode: gd.scene().mode,
      finalShots: logged.length,
      allClosed: logged.every((s) => !!s.end),
      loggedShown: gd.shown("loggedScreen")
    };
  }, AKARANA_H1);

  /* Dragging the bubble: pointer events on the cluster hit move the aim and
     the frame holds mid-drag. */
  const bubbleDrag = await page.evaluate(async (h1) => {
    const app = window.ClarityApp, gd = window.__gd;
    /* Its own round rather than the tail of the last one: the tilt only exists
       on a published surface in the locked shot view, and inheriting whatever
       mode the previous scenario finished in is how this drifts. */
    const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC";
    const shift = (p) => ({ lat: p.lat - 3, lng: p.lng });
    const tee = shift(h1.tee), green = shift(h1.green);
    const origin = app.playSurface.worldPx(green.lat + 0.004, green.lng - 0.004, 18);
    const meta = { captureZoom: 18, originPx: { x: origin.x, y: origin.y },
      outputDimensions: { width: 1341, height: 1889 }, anchorPins: { tee, green } };
    await gd.open("bubble-drag-course", { holes: [{ holeNumber: 1,
      geometry: { tee, green, greenShape: [], route: [] },
      visual: { url: PNG, playSurface: meta } }] }, null);
    await gd.until(() => document.body.classList.contains("surface-published"), "the surface to present");
    await gd.tap("headToTeeBtn");
    await gd.until(() => gd.shown("aimBubble"), "the bubble to come up on the surface");
    const hit = document.getElementById("aimBubble");
    const before = gd.scene().bubble.target;
    const rect = hit.getBoundingClientRect();
    /* The 44px floor is a LAYOUT size the painter sets, read BEFORE the drags —
       the client rect is that box after the tilt's perspective, which is
       legitimately smaller up the screen, and by the end of the block the aim
       has been dragged to the bezel. */
    const hitBox = { w: hit.offsetWidth, h: hit.offsetHeight };
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    const img = document.getElementById("surfaceImage");
    const frameBefore = img.style.transform;
    hit.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 9, clientX: cx, clientY: cy, bubbles: true }));
    let midDragFrameHeld = null, tiltHeldMidDrag = null;
    const vp = document.getElementById("surfaceViewport");
    for (let i = 1; i <= 4; i++) {
      hit.dispatchEvent(new PointerEvent("pointermove", { pointerId: 9, clientX: cx, clientY: cy - i * 12, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (i === 2) {
        midDragFrameHeld = img.style.transform === frameBefore;
        /* matrix3d means the perspective tilt is still applied. It used to be
           forced to none for the duration of the drag. */
        tiltHeldMidDrag = getComputedStyle(vp).transform.startsWith("matrix3d");
      }
    }
    hit.dispatchEvent(new PointerEvent("pointerup", { pointerId: 9, clientX: cx, clientY: cy - 48, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const after = gd.scene().bubble.target;
    const reframedAfter = img.style.transform !== frameBefore;

    /* The edge exception: a bubble dragged into the edge band is the one thing
       allowed to move a parked camera, because the player is asking for map
       that is not on screen yet. */
    const frameAfterInterior = img.style.transform;
    const edgeHit = document.getElementById("aimBubble");
    const edgeRect = edgeHit.getBoundingClientRect();
    const sx = edgeRect.left + edgeRect.width / 2, sy = edgeRect.top + edgeRect.height / 2;
    edgeHit.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 11, clientX: sx, clientY: sy, bubbles: true }));
    /* Dragged straight back toward the player - a layup, which the engine
       lets the cluster follow all the way, unlike a lateral drag that the bag
       roof clamps long before the screen edge. */
    const edgeY = window.innerHeight - 8;
    for (let i = 1; i <= 8; i++) {
      const y = sy + (edgeY - sy) * (i / 8);
      edgeHit.dispatchEvent(new PointerEvent("pointermove", { pointerId: 11, clientX: sx, clientY: y, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const edgePanned = img.style.transform !== frameAfterInterior;
    edgeHit.dispatchEvent(new PointerEvent("pointerup", { pointerId: 11, clientX: sx, clientY: edgeY, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const frameAfterEdge = img.style.transform;
    await new Promise((resolve) => setTimeout(resolve, 150));

    return {
      hitSized: hitBox.w >= 44 && hitBox.h >= 44,
      hitBox: hitBox.w + "x" + hitBox.h,
      aimMovedM: app.distance.haversineMeters(before, after),
      midDragFrameHeld, tiltHeldMidDrag,
      draggingCleared: !document.body.classList.contains("bubble-dragging"),
      reframedAfter,
      edgePanned,
      stationaryAfterEdge: img.style.transform === frameAfterEdge
    };
  }, AKARANA_H1);

  /* Hole picker: tapping the hole number opens a straight jump to any hole,
     not just stepping one at a time. */
  const holePicker = await page.evaluate(async (h1) => {
    const gd = window.__gd;
    const pkg = { holes: [1, 2, 3].map((n) => ({ holeNumber: n, tee: h1.tee, green: h1.green, greenShape: [], route: [] })) };
    await gd.open("hole-picker-course", pkg, null, 400);
    await gd.tap("holeNumber", 60);
    const opened = {
      panelShown: gd.shown("holePickerPanel"),
      buttons: Array.from(document.querySelectorAll("#holePickerGrid button")).map((b) => b.textContent),
      activeButton: document.querySelector("#holePickerGrid button.active").textContent
    };
    document.querySelectorAll("#holePickerGrid button")[2].click();
    await gd.wait(120);
    return {
      opened,
      jumpedToHole: gd.hole(),
      panelClosedAfterPick: !gd.shown("holePickerPanel")
    };
  }, AKARANA_H1);

  /* Back-as-undo: during play, Back steps off the most recent wind/pin
     change instead of leaving the screen - only once there is nothing left
     to undo does it fall through to leaving GPS play. */
  const backUndo = await page.evaluate(async () => {
    const app = window.ClarityApp;
    const eng = window.GDBubbleEngine;
    app.undo.clear();
    eng.setWind(0, 1);   // seed a wind level directly - matches a real first press only opening the compass, not setting state
    const beforeWindPress = eng.windState();
    app.wind.press();   // level 1 -> 2, pushes an undo entry
    const afterPress = eng.windState();
    const anyAfterPress = app.undo.any();

    const beforePin = app.pin.current();
    app.pin.set({ lat: -36.9166, lng: 174.7393 });
    const afterPinSet = app.pin.current();

    const historyLenBefore = window.history.length;
    document.getElementById("globalBackBtn").click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const afterFirstBack = {
      pin: app.pin.current(),
      stillOnPlay: document.body.classList.contains("route-play"),
      historyUnchanged: window.history.length === historyLenBefore
    };

    document.getElementById("globalBackBtn").click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const afterSecondBack = {
      wind: eng.windState(),
      stillOnPlay: document.body.classList.contains("route-play"),
      anyLeft: app.undo.any()
    };

    window.__historyBackCalled = false;
    const origBack = window.history.back;
    window.history.back = function () { window.__historyBackCalled = true; };
    document.getElementById("globalBackBtn").click();
    const fallthrough = { historyBackCalled: window.__historyBackCalled };
    window.history.back = origBack;

    return { beforeWindPress, afterPress, anyAfterPress, beforePin, afterPinSet, afterFirstBack, afterSecondBack, fallthrough };
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

  /* The real hand-off: a fresh load with ?courseId=... must land directly on
     the play route, and never paint the home screen first. The transient
     pre-JS state can't be observed after waitUntil:"load" (this page's own
     JS has already run), so the no-flash guarantee is checked statically
     instead — the raw HTML must not default the body into a route class at
     all, or the browser paints it before any script executes. */
  const noDefaultRouteClass = !/<body[^>]*\bclass=/.test(fs.readFileSync(path.join(ROOT, "app", "index.html"), "utf8"));
  const handoffPage = await (await browser.newContext()).newPage();
  const handoffErrors = [];
  handoffPage.on("pageerror", (err) => handoffErrors.push(err && err.message || String(err)));
  await handoffPage.goto("http://127.0.0.1:" + port + "/app/index.html?courseId=akarana-golf-club&courseName=Akarana&courseLat=-36.9175&courseLng=174.74",
    { waitUntil: "load" });
  await handoffPage.waitForTimeout(500);
  const handoff = await handoffPage.evaluate(() => ({
    onPlay: document.body.classList.contains("route-play"),
    onHome: document.body.classList.contains("route-home"),
    hole: window.ClarityApp.marshal.round().hole,
    courseKey: window.ClarityApp.marshal.round().courseKey,
    loadingScreenHidden: document.getElementById("loadingScreen").classList.contains("hiddenState")
  }));
  await handoffPage.close();

  /* Course library: a course auto-downloads on its first visit with no
     prompt (the auto-download bias only needs confirmation for a map
     arriving mid-round, not one already there when play starts) - and a
     second hand-off to the SAME course must load from that saved copy with
     no second network call. A published map that arrives mid-round is a
     PROMPT, and only becomes the saved copy once that prompt is accepted. */
  const storeContext = await browser.newContext();
  const storePage = await storeContext.newPage();
  const storeErrors = [];
  storePage.on("pageerror", (err) => storeErrors.push(err && err.message || String(err)));
  let packageFetches = 0;
  let packageStatus = "lite-geo-ready";
  await storePage.route("**/api/course-package**", (route) => {
    packageFetches += 1;
    const url = new URL(route.request().url());
    const courseId = url.searchParams.get("courseId");
    const body = packageStatus === "full-map-ready"
      ? {
          courseId, status: "full-map-ready", packageVersion: 7, geometryVersion: "2026-08-01T00:00:00Z",
          holes: [{ holeNumber: 1, geometry: { tee: AKARANA_H1.tee, green: AKARANA_H1.green, greenShape: [], route: [] }, visual: null }]
        }
      : {
          courseId, status: "lite-geo-ready", geometryVersion: "2026-08-01T00:00:00Z",
          holes: [{ holeNumber: 1, tee: AKARANA_H1.tee, green: AKARANA_H1.green, greenShape: [], route: [] }]
        };
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  const storeUrl = "http://127.0.0.1:" + port
    + "/app/index.html?courseId=store-test-course&courseName=Store+Test&courseLat=-36.9175&courseLng=174.74";

  await storePage.goto(storeUrl, { waitUntil: "load" });
  await storePage.waitForTimeout(400);
  const firstVisit = await storePage.evaluate(() => {
    const saved = window.ClarityApp.courseStore.load("store-test-course");
    return { fetchesSoFar: undefined, savedMapType: saved && saved.mapType, hole: window.ClarityApp.marshal.round().hole };
  });
  const fetchesAfterFirstVisit = packageFetches;

  await storePage.goto(storeUrl, { waitUntil: "load" });
  await storePage.waitForTimeout(400);
  const secondVisit = await storePage.evaluate(() => ({
    courseKey: window.ClarityApp.marshal.round().courseKey,
    hole: window.ClarityApp.marshal.round().hole
  }));
  const fetchesAfterSecondVisit = packageFetches;

  /* Now simulate the published map appearing mid-round: the next hole
     change's background check should find it and prompt, not auto-switch. */
  packageStatus = "full-map-ready";
  await storePage.evaluate(() => document.getElementById("nextHole").click());
  await storePage.waitForTimeout(400);
  const midRoundPrompt = await storePage.evaluate(() => ({
    barShown: !document.getElementById("mapUpdateBar").classList.contains("hiddenState"),
    stillObjectMapSaved: window.ClarityApp.courseStore.load("store-test-course").mapType
  }));
  await storePage.evaluate(() => document.getElementById("mapUpdateDownload").click());
  await storePage.waitForTimeout(200);
  const afterDownload = await storePage.evaluate(() => ({
    barHidden: document.getElementById("mapUpdateBar").classList.contains("hiddenState"),
    savedMapType: window.ClarityApp.courseStore.load("store-test-course").mapType
  }));
  await storePage.close();

  await browser.close();
  server.close();

  assert.strictEqual(errors.length, 0, "uncaught exceptions during boot:\n" + errors.join("\n"));
  assert.ok(state.booted, "ClarityApp.booted canary missing - the load order did not finish");
  assert.strictEqual(state.intervals, 0, "rule 3: no setInterval may be registered at boot");
  assert.ok(state.authLoaded, "clarity-supabase-auth must load in the fresh shell");
  assert.ok(state.signedOut, "a fresh profile starts signed out");
  assert.strictEqual(state.accountLine, "Not signed in");
  assert.ok(state.loadingScreenHidden, "the loading screen must hide once the home route is ready — no permanent spinner");
  assert.ok(signIn.onSignIn, "Sign in must open the sign-in screen");
  assert.ok(signIn.status.length > 0, "an offline login must surface a status message");
  assert.ok(signIn.stillOnSignIn, "a failed login stays on the sign-in screen");
  assert.ok(noOwnPicker.noPickerScreen, "the picker screen must not exist in /app/ any more");
  assert.ok(noOwnPicker.noPlayTile, "the Play tile must not exist in /app/ any more");
  assert.ok(noOwnPicker.globalNavExists, "the global Home/Back/Settings bar must exist in the play screen");
  assert.ok(state.mapEmpty, "no map exists before play starts");
  assert.strictEqual(surfaceFirst.h1State.hole, 1, "the hand-off opens on hole 1");
  assert.ok(surfaceFirst.h1State.presented, "a declared package visual must present");
  assert.ok(surfaceFirst.h1State.mapStillEmpty, "no OSM is created under a declared surface");
  assert.strictEqual(surfaceFirst.h1State.chipKind, "published",
    "the chip must say the surface is the published one, got: " + surfaceFirst.h1State.chip);
  assert.strictEqual(surfaceFirst.h2State.presented, false, "no visual on hole 2 → back on the live map");
  assert.ok(surfaceFirst.h2State.mapCreated, "the map is created the moment absence is the answer");
  assert.ok(!framed.scrollJumped, "clicking the pill must not scroll-jump the play screen");
  assert.ok(!framed.bubbleUnderBar, "the bubble Head To the Tee raises must not hide under the distance bar");
  {
    const e = framed.engineDefault;
    assert.ok(e.targetToGreen > 30, "395m hole, " + Math.round(e.maxCarry) + "m bag → the default aim starts short of the green");
    assert.ok(Math.abs(e.targetFromTee - e.maxCarry) < 8,
      "the default aim sits at the max bag distance: " + Math.round(e.targetFromTee) + " vs " + Math.round(e.maxCarry));
    assert.ok(e.shotRowShown, "aimed short of the green from the tee → SHOT/REM row shows");
    assert.ok(e.svgShown && e.bubbleShapes === 2 && e.legacyRings === 0,
      "the bubble renders as ONE shape (fill + border), not three rings: "
      + e.bubbleShapes + " shapes, " + e.legacyRings + " legacy rings");
    assert.ok(e.carryKnockout, "the real carry distance is knocked out of the bubble");
    assert.ok(e.clubChip, "the club chip sits at the head of the aim line, got " + e.clubChip);
    assert.ok(e.aimLine, "the aim ray renders with the bubble");
    assert.ok(e.middleGuide, "laying up → the bubble→green middle guide shows");
    assert.ok(/^Green \d+m$/.test(e.middleLabel), "the middle guide labels the remaining leg, got: " + e.middleLabel);
    assert.ok(e.fairwayLine, "laying up → the fairway route line shows");
  }
  assert.ok(framed.presented, "framed course must present its surface");
  assert.ok(framed.transform.indexOf("matrix(") === 0, "the surface must carry the frame transform, got: " + framed.transform);
  assert.strictEqual(framed.flow, "preview", "far from any usable fix, a round stays in Preview");
  assert.strictEqual(framed.offTee, 0, "Head To the Tee places you exactly on the tee");
  assert.ok(!framed.dotVisible,
    "the dot is where you ACTUALLY are - 110km away is nowhere on this hole, so there is no dot to draw");
  assert.ok(framed.bubbleVisible, "placing yourself IS the lock-in: the bubble is up with nothing pressed");
  const expectedLeft = framed.view.w * (0.308 + 0.375 / 2);
  const expectedTop = framed.view.h * (0.881 + 0.037 / 2);
  assert.ok(Math.abs(framed.teeOnScreen.left - expectedLeft) < 2 && Math.abs(framed.teeOnScreen.top - expectedTop) < 2,
    "the tee must project onto the tee guide box: got " + framed.teeOnScreen.left + "," + framed.teeOnScreen.top
    + " want " + expectedLeft + "," + expectedTop);
  assert.strictEqual(stages.atTee.mode, "setup", "Unlock returns Preview to SETUP");
  assert.strictEqual(stages.atTee.stage, "hole", "SETUP frames the whole hole, tee to green");
  assert.ok(!stages.atTee.tilt, "the pre-frame hole view is flat");
  assert.strictEqual(stages.lock.mode, "aim", "placing yourself IS the lock-in");
  assert.strictEqual(stages.lock.stage, "lock", "AIM is the locked shot view");
  assert.ok(stages.lock.tilt, "the lock stage carries the 32° tilt");
  assert.strictEqual(stages.gpsHold.stage, "lock", "a same-stage fix stays in lock");
  assert.ok(stages.gpsHold.frameHeld, "a same-stage fix must NOT re-anchor the locked frame");
  assert.ok(stages.gpsHold.dotAppeared, "a trusted fix still draws the dot - it is the locator, in either flow");
  assert.ok(stages.gpsHold.playerHeld,
    "in Preview the fix is the locator and never the player: it must not move where you placed yourself");
  assert.ok(stages.lock.ballVisible === false, "no ball in the shot view");
  assert.ok(stages.aimed.bubbleShown, "the aim bubble renders on the locked view");
  assert.ok(stages.aimed.shotRowShown, "aiming off the green shows the shot row");
  assert.ok(stages.aimed.shotDist > 80 && stages.aimed.shotDist < 140,
    "shot distance must be the start→target number, got " + stages.aimed.shotDist);
  assert.ok(stages.greenIsNotATrapdoor.offGreen >= 0 && stages.greenIsNotATrapdoor.offGreen < 40,
    "test setup: the placement must be inside the green-focus radius, got "
    + stages.greenIsNotATrapdoor.offGreen + "m");
  assert.strictEqual(stages.onGreen.mode, "aim",
    "and it is still AIM - the mode must depend on what you asked for, not on where your finger landed");
  assert.strictEqual(stages.onGreen.stage, "lock", "so the camera is still the shot view");
  assert.ok(!stages.greenIsNotATrapdoor.ballVisible, "no ball: Preview has nothing to log");
  assert.strictEqual(stages.greenIsNotATrapdoor.dockFace, "unlock",
    "and the dock still offers Unlock, not a Shot End for a shot that does not exist");
  assert.ok(stages.greenIsNotATrapdoor.holeOutGone,
    "Hole Out is collapsed into Shot End - there must be no second confirm button");
  assert.strictEqual(stages.greenIsNotATrapdoor.shotsRecorded, 0,
    "Preview cannot open a shot - previewing hole 5 must never invent a shot on hole 5");
  assert.strictEqual(shotEndWiring.tracking.face, "lock", "in Track the dock offers Lock");
  assert.strictEqual(shotEndWiring.tracking.stage, "hole", "Track is the pre-frame hole view");
  assert.strictEqual(shotEndWiring.lockStage, "lock", "Lock raises the locked shot view");
  assert.strictEqual(shotEndWiring.lockedFace, "unlock",
    "locked in, the dock button is Unlock - Shot End belongs to green focus only");
  assert.strictEqual(shotEndWiring.lockStartOffTee, 0, "the shot opens from where you locked in");
  assert.strictEqual(shotEndWiring.afterUnlock.hole, 1, "unlocking must not advance the hole");
  assert.strictEqual(shotEndWiring.afterUnlock.mode, "track", "unlocking returns Live to its resting state");
  assert.ok(!shotEndWiring.afterUnlock.endRecorded,
    "unlocking records nothing - the next lock-in is what closes the shot");
  assert.ok(shotEndWiring.afterUnlock.stillInFlight,
    "unlocking keeps the shot in flight; it costs the camera, never the shot");
  assert.strictEqual(shotEndWiring.afterUnlock.stage, "hole",
    "unlocking pulls back to the pre-frame view");
  assert.strictEqual(shotEndWiring.afterUnlock.face, "lock",
    "unlocked, the dock button offers Lock again");
  assert.ok(shotEndWiring.afterUnlock.shown,
    "and it stays offered, because the next Lock is the thing to press");
  assert.strictEqual(shotEndWiring.zoomStage, "zoom", "arriving at the green opens the green view");
  assert.strictEqual(shotEndWiring.greenFace, "shotEnd", "and the dock turns into Shot End");
  /* One shot, not two: the unlock in between is not a boundary. Course data
     joins the last lock-in to the next lock-in, so one lock plus the on-green
     Shot End bracket exactly one shot. */
  assert.strictEqual(shotEndWiring.shotsBeforeGreenFocusClick, 1,
    "one lock-in opened exactly one shot - the unlock between added none");
  assert.strictEqual(shotEndWiring.finalShots, 1, "Shot End closes that shot rather than opening another");
  assert.ok(shotEndWiring.allClosed, "and it leaves nothing in flight");
  assert.ok(shotEndWiring.loggedShown, "Shot End in green focus lands on the Logged screen");
  assert.strictEqual(shotEndWiring.mode, "logged", "which is the mode it puts the round into");
  assert.ok(bubbleDrag.tiltHeldMidDrag,
    "the lock tilt must survive the drag - it used to flatten to birds-eye on grab and spring back on release");
  assert.ok(bubbleDrag.hitSized, "the drag hit covers the cluster (44px minimum), got " + bubbleDrag.hitBox);
  assert.ok(bubbleDrag.aimMovedM > 5, "dragging the bubble moves the aim, got " + bubbleDrag.aimMovedM.toFixed(1) + "m");
  assert.ok(bubbleDrag.midDragFrameHeld, "the camera holds mid-drag");
  assert.ok(bubbleDrag.draggingCleared, "release clears the dragging state");
  assert.ok(!bubbleDrag.reframedAfter,
    "a locked shot view is stationary: ordinary bubble movement must not re-frame, on release or during");
  assert.ok(bubbleDrag.edgePanned,
    "dragging the bubble into the edge band pans the camera - the one exception to a parked view");
  assert.ok(bubbleDrag.stationaryAfterEdge,
    "the camera returns to fully stationary the moment the edge interaction ends");
  assert.ok(holePicker.opened.panelShown, "tapping the hole number opens the picker panel");
  assert.deepStrictEqual(holePicker.opened.buttons, ["1", "2", "3"], "the picker lists every hole the package has geometry for");
  assert.strictEqual(holePicker.opened.activeButton, "1", "the current hole is marked active in the picker");
  assert.strictEqual(holePicker.jumpedToHole, 3, "picking a hole jumps straight to it");
  assert.ok(holePicker.panelClosedAfterPick, "picking a hole closes the picker");
  assert.ok(backUndo.anyAfterPress, "a wind change must leave something to undo");
  assert.strictEqual(backUndo.afterPress.level, backUndo.beforeWindPress.level + 1, "pressing wind bumps its level");
  assert.ok(backUndo.afterPinSet && backUndo.afterPinSet.lat === -36.9166, "placing a pin must be readable back");
  assert.strictEqual(backUndo.afterFirstBack.pin, backUndo.beforePin, "Back undoes the pin placement first (most recent action)");
  assert.ok(backUndo.afterFirstBack.stillOnPlay, "undoing a pin placement must not leave the play screen");
  assert.ok(backUndo.afterFirstBack.historyUnchanged, "undoing must not touch browser history");
  assert.deepStrictEqual(backUndo.afterSecondBack.wind, backUndo.beforeWindPress, "a second Back undoes the wind change underneath it");
  assert.ok(backUndo.afterSecondBack.stillOnPlay, "undoing a wind change must not leave the play screen");
  assert.ok(!backUndo.afterSecondBack.anyLeft, "both actions undone → nothing left on the stack");
  assert.ok(backUndo.fallthrough.historyBackCalled, "with nothing left to undo, Back falls through to leaving GPS play");
  assert.strictEqual(basemap.keylessNz, "osm", "no LINZ key → OSM even in NZ");
  assert.strictEqual(basemap.nz, "linz", "keyed NZ centre → LINZ aerial");
  assert.strictEqual(basemap.pebbleBeach, "naip", "US centre → NAIP aerial");
  assert.strictEqual(basemap.brisbane, "qld", "Queensland centre → QLD aerial");
  assert.strictEqual(basemap.london, "osm", "outside every aerial region → OSM, never empty tiles");
  assert.ok(basemap.naipTileIsBbox, "NAIP tiles are bbox exportImage requests");
  assert.ok(noDefaultRouteClass, "the body must not default into a route class - that's a flash of the wrong screen before this page's own JS runs");
  assert.strictEqual(handoffErrors.length, 0, "uncaught exceptions on the ?courseId= hand-off:\n" + handoffErrors.join("\n"));
  assert.ok(handoff.onPlay, "a ?courseId= hand-off must land directly on the play route");
  assert.ok(!handoff.onHome, "a ?courseId= hand-off must never show the home screen");
  assert.strictEqual(handoff.courseKey, "akarana-golf-club", "the hand-off's courseId must reach the round the Marshal opens");
  assert.strictEqual(handoff.hole, 1, "a ?courseId= hand-off opens on hole 1");
  assert.ok(handoff.loadingScreenHidden, "the loading screen must hide once the course package has loaded and the hole is framed");

  assert.strictEqual(storeErrors.length, 0, "uncaught exceptions in the course-library flow:\n" + storeErrors.join("\n"));
  assert.strictEqual(firstVisit.savedMapType, "object", "a lite-geo-ready course auto-saves to the library with no prompt");
  assert.strictEqual(firstVisit.hole, 1, "the first visit plays from the freshly-fetched package");
  assert.strictEqual(fetchesAfterFirstVisit, 1, "the first visit fetches the package exactly once");
  assert.strictEqual(secondVisit.courseKey, "store-test-course", "a second hand-off to the same course still starts play");
  assert.strictEqual(secondVisit.hole, 1, "a second hand-off to the same course opens on hole 1 from the saved copy");
  assert.strictEqual(fetchesAfterSecondVisit, fetchesAfterFirstVisit, "a second hand-off to an already-downloaded course must not re-fetch the package");
  assert.ok(midRoundPrompt.barShown, "a published map appearing mid-round must prompt, not auto-switch");
  assert.strictEqual(midRoundPrompt.stillObjectMapSaved, "object", "the saved copy must not change until the prompt is accepted");
  assert.ok(afterDownload.barHidden, "accepting the prompt closes the update bar");
  assert.strictEqual(afterDownload.savedMapType, "published", "accepting the prompt saves the published map as the new downloaded copy");
  assert.ok(play.mapDisplayed, "rule 2: #map must be visible by default on the play route");
  assert.strictEqual(play.hole, 1, "play must start on hole 1");
  assert.strictEqual(play.courseKey, "akarana-golf-club");
  assert.strictEqual(play.surfacePresented, false, "no surface offline → live map, no overlay");
  assert.strictEqual(play.sourceChipKind, "live",
    "no surface → the chip says which live basemap is up rather than going quiet, got: " + play.sourceChipText);
  assert.ok(play.gpsFix, "the granted geolocation fix must reach the watcher");
  assert.ok(play.gpsDotShown, "the projected dot must render on the live map");
  assert.ok(Number.isFinite(play.gpsDotAt.left) && Number.isFinite(play.gpsDotAt.top)
    && play.gpsDotAt.left >= 0 && play.gpsDotAt.left <= 1400
    && play.gpsDotAt.top >= 0 && play.gpsDotAt.top <= 1400,
    "the live-map dot must project inside the viewport, got " + JSON.stringify(play.gpsDotAt));
  assert.ok(play.mapFramed, "a hole with tee+green geometry must stage-frame the live map");
  /* A passive fix never locks you in. Walking the hole with GPS driving, you
     stay in the pre-frame view with the dot moving along the map; the locked
     shot view is earned by a lock-in (the dock's Lock, or the pill). */
  assert.strictEqual(play.frameStage, "hole",
    "an on-hole GPS fix must leave the live map pre-framed, not lock the shot view");
  assert.ok(/openstreetmap|linz/i.test(play.attribution || ""),
    "the basemap credit must render as fixed chrome, got " + JSON.stringify(play.attribution));
  assert.ok(play.distanceBarShown, "with a fix and a green, the distance bar must show");
  assert.ok(play.distFront < play.distCentre && play.distCentre < play.distBack,
    "F < C < B, got " + play.distFront + "/" + play.distCentre + "/" + play.distBack);
  /* The granted fix (-36.9174, 174.74) sits ~90m from Akarana green 1 — at the
     course, so it is trusted, which is what Play needs. Until Play is pressed
     the fix is only the locator: it draws the dot and measures nothing. */
  assert.ok(play.playOffered, "a trusted fix at the course must offer Play");
  assert.ok(play.previewDotShown, "the fix draws the dot before Play, because that is where you actually are");
  assert.ok(!play.previewDistances, "but it measures nothing until it is the player - Preview measures from a placement");
  assert.strictEqual(play.flow, "live", "pressing Play starts the round on the hole you are standing on");
  assert.ok(play.distCentre > 60 && play.distCentre < 120,
    "centre distance from the granted fix must be ~90m, got " + play.distCentre);
  assert.ok(remote.preFrame.pillShown, "pre-frame state shows the Head To the Tee / tap-where-you'd-stand pill");
  assert.ok(!remote.preFrame.hasPosition, "pre-frame state has no position - nothing is placed yet");
  assert.ok(!remote.preFrame.playOffered,
    "a fix 110km from this course is refused outright, so there is no round to start from it");
  assert.ok(remote.preFrame.distanceHidden, "no position → no distances");
  assert.strictEqual(teePin.setup.flow, "preview", "no trusted fix → the round rests in Preview");
  assert.strictEqual(teePin.setup.mode, "setup", "which opens at SETUP with the pill up");
  assert.ok(teePin.setup.pillShown && !teePin.setup.placed, "nothing placed, nothing measured");
  assert.strictEqual(teePin.atTee.mode, "aim", "Head To the Tee places you, and the lock-in is automatic");
  assert.strictEqual(teePin.atTee.offTee, 0, "Head To the Tee lands exactly on the tee");
  assert.ok(!teePin.atTee.pillShown, "placing the player retires the pill");
  assert.strictEqual(teePin.afterTap.offTee, 0,
    "a map tap must not drag the origin off a placement, moved " + teePin.afterTap.offTee + "m");
  assert.strictEqual(teePin.afterTap.mode, "aim", "and it must not knock you out of AIM either");
  assert.ok(teePinAfterFix.fixMoved, "the moved geolocation must reach the watcher");
  assert.ok(teePinAfterFix.locatorMoved, "and it must reach the scene as the locator");
  assert.strictEqual(teePinAfterFix.offTee, 0,
    "a live on-course fix must not move a player placed on the tee, moved "
    + teePinAfterFix.offTee + "m");
  assert.strictEqual(afterLeaving.unlocked.mode, "setup", "Unlock is the way back to SETUP");
  assert.ok(!afterLeaving.unlocked.placed && afterLeaving.unlocked.pillShown,
    "and it clears the placement and brings the pill back - that is its whole job in this flow");
  assert.strictEqual(afterLeaving.replaced.mode, "aim", "so you can change your mind and place yourself elsewhere");
  assert.strictEqual(afterLeaving.afterHoleChange.mode, "setup",
    "leaving the hole and coming back also clears the placement");
  assert.ok(!afterLeaving.afterHoleChange.placed, "a hole you have just arrived at has nobody standing on it");

  assert.ok(greenTap.mapped.foundGreenOnScreen,
    "the green must be projectable on screen for the tap test to mean anything; map was "
    + greenTap.mapped.mapState);
  assert.ok(greenTap.mapped.placedFromNothing,
    "'or tap where you'd stand' is half the pill: from SETUP, a tap places you");
  assert.ok(greenTap.mapped.landedOnGreen !== null && greenTap.mapped.landedOnGreen < 8,
    "and it lands where you touched - tapping the green puts you on the green, got "
    + greenTap.mapped.landedOnGreen + "m off");
  assert.strictEqual(greenTap.mapped.mode, "aim",
    "placing yourself is AIM wherever you put it - Preview has two modes, and a tap near a green "
    + "must not be a trapdoor into a third");
  assert.strictEqual(greenTap.mapped.flow, "preview", "and it is still Preview, not some other flow");
  assert.ok(greenTap.unmappedPlaces,
    "a hole with no geometry at all still takes the tap - it is the only way to play one");

  assert.ok(!gpsSettings.opened.navigatedAway,
    "the GPS Settings rail button must open a sheet in place, not navigate away");
  assert.ok(gpsSettings.opened.panelOpen, "the GPS Settings sheet must open");
  assert.ok(/m$/.test(gpsSettings.metres.guide),
    "the middle guide reads metres by default, got " + gpsSettings.metres.guide);
  assert.ok(/yd$/.test(gpsSettings.yards.guide),
    "Units: Yards must reach the middle guide label, got " + gpsSettings.yards.guide);
  assert.ok(Math.abs(Number(gpsSettings.yards.front) / Number(gpsSettings.metres.front) - 1.0936) < 0.01,
    "Units: Yards must convert the card, got " + gpsSettings.metres.front + "m -> "
    + gpsSettings.yards.front + "yd");
  assert.ok(!gpsSettings.aimOff.line, "Show aim line: Off must drop the aim ray");
  assert.ok(gpsSettings.aimOff.bubble, "Show aim line: Off must NOT drop the bubble itself");
  assert.ok(gpsSettings.aimOn.line, "Show aim line: On brings the aim ray back");
  assert.ok(Math.abs(gpsSettings.rotated) > 5,
    "the shot-up frame rotates the live map, got " + gpsSettings.rotated + " deg");
  assert.strictEqual(gpsSettings.flat, 0,
    "Shot-up frame: Off must leave the live map north-up, got " + gpsSettings.flat + " deg");
  assert.ok(gpsSettings.mpp.tight < gpsSettings.mpp.medium
    && gpsSettings.mpp.medium < gpsSettings.mpp.wide,
    "frame tightness must zoom monotonically, got "
    + JSON.stringify(gpsSettings.mpp));
  assert.ok(gpsSettings.iconSizes.every((s) => s === "24x24"),
    "every tool-rail icon must be 24x24 (the inline gear used to fill its button), got "
    + gpsSettings.iconSizes.join(", "));

  assert.ok(greenFocus.openedShot, "test setup: Lock must open a shot from the tee");
  assert.ok(!greenFocus.beforeArrival.ball, "no ball before green focus opens");
  assert.strictEqual(greenFocus.beforeArrival.mode, "track",
    "two fixes clear of the lock point release Aim back to Track");
  assert.strictEqual(greenFocus.onGreen.mode, "finish",
    "arriving at the green with a shot outstanding opens Finish by itself");
  assert.strictEqual(greenFocus.onGreen.stage, "zoom", "inside 40m of the green opens green focus");
  assert.ok(greenFocus.onGreen.ball, "green focus turns the position marker into the ball");
  assert.ok(greenFocus.onGreen.origin, "and draws the shot's ORIGIN, so you can see the shot you are reconstructing");
  assert.ok(greenFocus.beforeArrival.aimPaths === 0, "no aim overlays in Track - the shot view is earned by a Lock");
  assert.strictEqual(greenFocus.onGreen.aimPaths, 0,
    "green focus must clear the aim overlays - a bubble anchored on the green is a shot nobody is playing");
  assert.ok(!greenFocus.onGreen.bubble, "no aim bubble in green focus");
  assert.ok(!greenFocus.onGreen.shotRow, "no club/carry row in green focus - there is no shot to play");
  assert.ok(greenFocus.onGreen.distBarPaused,
    "the distance readout pauses in green focus - front/back of a green you are standing on is not a number you play to");
  assert.ok(greenFocus.atNextTee.distBarPaused,
    "it stays paused while deferred, rather than reading a 250m approach to a hole already finished");

  assert.ok(approachCard.landingFromGreen !== null && approachCard.landingFromGreen <= 3,
    "test setup: the default aim must land on the green, got " + approachCard.landingFromGreen + "m off");
  assert.ok(approachCard.rowShown,
    "club/total/carry must stay on the card for an approach aimed at the green");
  assert.ok(approachCard.club && approachCard.club !== "-" && approachCard.club !== "–",
    "the approach must name a club, got " + JSON.stringify(approachCard.club));
  assert.ok(approachCard.dist > 80 && approachCard.dist < 180,
    "the approach distance must be the real number, got " + approachCard.dist);
  assert.strictEqual(greenFocus.atNextTee.aimPaths, 0,
    "the aim overlays stay cleared while green focus is deferred");
  assert.strictEqual(greenFocus.atNextTee.mode, "finish",
    "green focus is sticky: walking to the next tee must not close it");
  assert.strictEqual(greenFocus.atNextTee.stage, "zoom",
    "and the camera keeps holding the green being logged, not the hole you walked to");
  assert.ok(greenFocus.atNextTee.hint, "the unplaced ball still asks to be dragged into place");
  assert.ok(greenFocus.atNextTee.dock, "Shot End stays available to confirm the ball");
  assert.strictEqual(greenFocus.atNextTee.dockFace, "shotEnd", "and it is still wearing the Shot End face");
  assert.ok(greenFocus.greenHeld,
    "the camera must keep holding the green being logged - the ball needs it on screen");
  assert.ok(!greenFocus.afterDrop.hint, "the prompt goes once the ball is placed");
  assert.strictEqual(greenFocus.recorded.shots, 1, "Shot End records the shot");
  assert.strictEqual(greenFocus.recorded.method, "ball-placed",
    "and records that the end was placed by hand rather than tracked");
  assert.ok(greenFocus.recorded.offBall !== null && greenFocus.recorded.offBall < 1.5,
    "Shot End must record where the BALL is, off by " + greenFocus.recorded.offBall + "m");
  assert.ok(greenFocus.recorded.playerFromGreen > 200,
    "test setup: the player must be far from the green when confirming, got "
    + greenFocus.recorded.playerFromGreen + "m");
  assert.ok(greenFocus.recorded.endFromGreen < 40,
    "the recorded end is on the green, not at the player 260m away, got "
    + greenFocus.recorded.endFromGreen + "m");
  assert.ok(greenFocus.recorded.loggedShown, "Shot End lands on the Logged screen");
  assert.strictEqual(greenFocus.recorded.hole, 1,
    "and stays on the hole it logged - advancing is the Logged screen's offer, not something Shot End does for you");

  assert.ok(!remote.atTee.pillShown, "placing the player retires the pill");
  assert.strictEqual(remote.atTee.flow, "preview", "off-course play is Preview, start to finish");
  assert.ok(remote.atTee.centre > 380 && remote.atTee.centre < 410,
    "tee position must give the ~395m tee shot, got " + remote.atTee.centre);
  assert.ok(remote.afterTap.centre > remote.atTee.centre - 120 && remote.afterTap.centre < remote.atTee.centre - 80,
    "unlock, then a 100m tap up the fairway must shorten the shot ~100m, got " + remote.afterTap.centre);
  console.log("fresh-app boot passed: 0 uncaught exceptions, 0 intervals, picker empty-state, GPS adopt "
    + play.distFront + "/" + play.distCentre + "/" + play.distBack + "m, head-to-tee "
    + remote.atTee.centre + "m, tap " + remote.afterTap.centre + "m");
}
