#!/usr/bin/env node
/* The Garmin package: the drawn watch map, built after every scan.
 *
 * Pinned here:
 *   - it is data only - spatial reference, golf reference, outlines, terrain, palette -
 *     with no image rendered, encoded or uploaded, in its own table;
 *   - it is rebuilt only when the course's geometry, its terrain or the builder moved on,
 *     and never twice at once;
 *   - the phone's GET serves it and wakes the builder when it is missing or behind;
 *   - the mapper and the visual export wake the builder only AFTER their own job is
 *     finished, so the normal scan is never held up or failed by it;
 *   - the phone sends a connected Garmin the drawn package (no image urls, nothing to
 *     download) and an Apple Watch the image package, as before; a Garmin falls back to the
 *     image package while its own does not exist yet.
 *
 * Run: node dev/garmin-package.test.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

process.env.SUPABASE_URL = "https://stub.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service";

/* Two small holes near Queenstown: tee, route, green with a shape, a fairway and a bunker. */
function ring(lat, lng, r) {
  const out = [];
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * Math.PI * 2;
    out.push({ lat: lat + Math.sin(a) * r, lng: lng + Math.cos(a) * r * 1.4 });
  }
  return out;
}
function courseObjects() {
  const objects = {};
  [[1, -45.0000, 168.7000], [2, -45.0040, 168.7000]].forEach(([n, lat, lng]) => {
    const greenLat = lat - 0.0028;
    objects["t" + n] = { type: "tee", holeNumber: n, position: { lat, lng } };
    objects["f" + n] = { type: "fairway", holeNumber: n, position: { lat: lat - 0.0014, lng } };
    objects["g" + n] = { type: "green", holeNumber: n, position: { lat: greenLat, lng }, greenShape: ring(greenLat, lng, 0.00012) };
    objects["fa" + n] = { type: "fairway_area", holeNumber: n, shape: [
      { lat: lat - 0.0004, lng: lng - 0.0003 }, { lat: lat - 0.0004, lng: lng + 0.0003 },
      { lat: lat - 0.0024, lng: lng + 0.0003 }, { lat: lat - 0.0024, lng: lng - 0.0003 }] };
    objects["b" + n] = { type: "bunker", holeNumber: n, shape: ring(greenLat + 0.0002, lng + 0.0003, 0.00004) };
  });
  return objects;
}
const MAP = { course_id: "test-course", objects_json: courseObjects(), holes_json: {}, objects_revision: 7, published_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z" };

/* A Supabase + Storage stand-in. Every request is recorded; routes answer by URL. */
function stubNetwork(state) {
  const calls = [];
  global.fetch = async function (url, init) {
    url = String(url);
    const method = (init && init.method) || "GET";
    const body = init && init.body && typeof init.body === "string" ? init.body : null;
    calls.push({ url, method, body });
    const reply = (status, data) => new Response(data === undefined ? "" : JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    if (url.includes("/.netlify/functions/course-garmin-maps-background")) return new Response("", { status: 202 });
    if (url.includes("/rest/v1/course_maps")) return reply(200, state.map ? [state.map] : []);
    if (url.includes("/rest/v1/course_garmin_maps")) {
      if (method === "POST") { state.saves.push(JSON.parse(body)[0]); return reply(201, []); }
      return reply(200, state.garminRow ? [state.garminRow] : []);
    }
    if (url.includes("/storage/v1/object/")) return method === "GET" ? reply(404, { error: "not found" }) : reply(200, {});
    throw new Error("offline in tests: " + url);
  };
  return calls;
}

let api;
async function load() {
  if (!api) api = await import(pathToFileURL(path.join(ROOT, "functions", "course-watch-maps.mjs")).href);
  return api;
}

/* ------------------------------------------------------------------ server */

test("a package is current only for the same geometry, terrain and builder", async () => {
  const { garminPackageCurrent, GARMIN_BUILDER_VERSION } = (await load()).__test;
  const row = { garmin_package_version: 5, builder_version: GARMIN_BUILDER_VERSION, source_objects_revision: 7, terrain_generated_at: "T1" };
  assert.strictEqual(garminPackageCurrent(row, MAP, "T1"), true);
  assert.strictEqual(garminPackageCurrent(row, MAP, undefined), true, "the GET skips the terrain check");
  assert.strictEqual(garminPackageCurrent(row, Object.assign({}, MAP, { objects_revision: 8 }), "T1"), false, "geometry moved on");
  assert.strictEqual(garminPackageCurrent(row, MAP, "T2"), false, "a new export brought new terrain");
  assert.strictEqual(garminPackageCurrent(Object.assign({}, row, { terrain_generated_at: null }), MAP, "T1"), false, "first terrain after a flat build");
  assert.strictEqual(garminPackageCurrent(Object.assign({}, row, { builder_version: 0 }), MAP, "T1"), false, "a new builder rebuilds");
  assert.strictEqual(garminPackageCurrent(null, MAP, "T1"), false);
  const noRevision = Object.assign({}, MAP, { objects_revision: null });
  assert.strictEqual(garminPackageCurrent(Object.assign({}, row, { source_objects_version: "2026-10-02T00:00:00Z" }), noRevision, "T1"), true,
    "with no revision the geometry timestamp decides");
});

test("a stale course is built as data only, into its own table", async () => {
  const { buildGarminPackageIfStale } = await load();
  const state = { map: MAP, garminRow: null, saves: [] };
  const calls = stubNetwork(state);
  const result = await buildGarminPackageIfStale("test-course", Date.parse("2026-10-06T00:00:00Z"));
  assert.strictEqual(result.built, true);
  assert.strictEqual(state.saves.length, 2, "a lock, then the package");
  assert.ok(state.saves[0].building_since, "the lock is taken before building");
  const row = state.saves[1];
  assert.strictEqual(row.status, "ready");
  assert.strictEqual(row.building_since, null, "the lock is released by the same write");
  assert.strictEqual(row.source_objects_revision, 7);
  assert.strictEqual(row.terrain_generated_at, null, "no export yet, so no terrain");
  assert.strictEqual(row.holes.length, 2);
  row.holes.forEach(hole => {
    assert.ok(hole.spatialReference && hole.spatialReference.version === 1);
    assert.ok(hole.reference && hole.reference.green);
    assert.ok(hole.outlines && hole.outlines.version === 1 && hole.outlines.g, "the green outline is drawn");
    assert.ok(hole.palette && hole.palette.fairway, "the palette rides each hole");
    assert.ok(!("path" in hole), "no image behind a Garmin hole");
  });
  const imageUploads = calls.filter(c => c.method === "POST" && /\/storage\/v1\/object\/course-watch-maps\/test-course\/v\d+\//.test(c.url));
  assert.strictEqual(imageUploads.length, 0, "nothing is rendered or uploaded");
  assert.ok(!calls.some(c => c.url.includes("/rest/v1/course_watch_maps") && c.method !== "GET"), "the Apple Watch package is never touched");
});

test("a current package, or one already building, is left alone", async () => {
  const { buildGarminPackageIfStale } = await load();
  const { GARMIN_BUILDER_VERSION } = (await load()).__test;
  const now = Date.parse("2026-10-06T00:00:00Z");
  const current = { course_id: "test-course", garmin_package_version: 5, builder_version: GARMIN_BUILDER_VERSION, source_objects_revision: 7, terrain_generated_at: null };
  let state = { map: MAP, garminRow: current, saves: [] };
  stubNetwork(state);
  assert.deepStrictEqual(await buildGarminPackageIfStale("test-course", now), { built: false, reason: "current" });
  assert.strictEqual(state.saves.length, 0);

  state = { map: MAP, garminRow: Object.assign({}, current, { source_objects_revision: 6, building_since: new Date(now - 60000).toISOString() }), saves: [] };
  stubNetwork(state);
  assert.deepStrictEqual(await buildGarminPackageIfStale("test-course", now), { built: false, reason: "already-building" });

  state = { map: MAP, garminRow: Object.assign({}, current, { source_objects_revision: 6, building_since: new Date(now - 11 * 60000).toISOString() }), saves: [] };
  stubNetwork(state);
  assert.strictEqual((await buildGarminPackageIfStale("test-course", now)).built, true, "a build that died long ago does not block a new one");

  state = { map: null, garminRow: null, saves: [] };
  stubNetwork(state);
  assert.deepStrictEqual(await buildGarminPackageIfStale("test-course", now), { built: false, reason: "no-geometry" });
});

async function garminGet(state) {
  const handler = (await load()).default;
  const calls = stubNetwork(state);
  const res = await handler(new Request("https://app.example/api/course-watch-maps?courseId=test-course&watch=garmin"));
  return { body: await res.json(), wakes: calls.filter(c => c.url.includes("course-garmin-maps-background")) };
}

test("the phone's GET serves the package and wakes the builder when it is missing or behind", async () => {
  const { GARMIN_BUILDER_VERSION } = (await load()).__test;
  const missing = await garminGet({ map: MAP, garminRow: null, saves: [] });
  assert.strictEqual(missing.body.status, "building");
  assert.strictEqual(missing.body.watchPackageVersion, 0);
  assert.strictEqual(missing.wakes.length, 1);
  assert.strictEqual(missing.wakes[0].url, "https://app.example/.netlify/functions/course-garmin-maps-background");

  const row = { status: "ready", garmin_package_version: 99, builder_version: GARMIN_BUILDER_VERSION, source_objects_revision: 6, hole_count: 1, ready_hole_count: 1, holes: [{ holeNumber: 1 }] };
  const behind = await garminGet({ map: MAP, garminRow: row, saves: [] });
  assert.strictEqual(behind.body.watchPackageVersion, 99, "an older map is served rather than none");
  assert.strictEqual(behind.body.current, false);
  assert.strictEqual(behind.wakes.length, 1);

  const fresh = await garminGet({ map: MAP, garminRow: Object.assign({}, row, { source_objects_revision: 7 }), saves: [] });
  assert.strictEqual(fresh.body.current, true);
  assert.strictEqual(fresh.wakes.length, 0, "a current package costs no wake");

  const noCourse = await garminGet({ map: null, garminRow: null, saves: [] });
  assert.strictEqual(noCourse.body.status, "none");
  assert.strictEqual(noCourse.wakes.length, 0);
});

test("the scan and the export wake the builder only after their own job is done", () => {
  const mapper = fs.readFileSync(path.join(ROOT, "functions", "course-mapper-worker-background.mjs"), "utf8");
  const done = mapper.indexOf('await finishJob(job.id, { status: "done", result, error: null });');
  const wake = mapper.indexOf("await wakeGarminBuild(origin, courseId)");
  assert.ok(done > 0 && wake > done, "mapper: wake after the job is finished");
  assert.ok(mapper.slice(done, wake).includes("coursesPublished"), "mapper: every course a multi-course run published");

  const visual = fs.readFileSync(path.join(ROOT, "functions", "course-visual-worker-background.mjs"), "utf8");
  const vDone = visual.indexOf('await finishJob(job.id, { status: "done", result, error: null });');
  const vWake = visual.indexOf("await wakeGarminBuild(origin, job.course_id)");
  assert.ok(vDone > 0 && vWake > vDone, "export: wake after the job is finished");
  assert.ok(/job\.kind === "export" && !\(result && result\.test\)/.test(visual.slice(vDone, vWake)), "export: published exports only");
});

/* ------------------------------------------------------------------- phone */

const delivery = require(path.join(ROOT, "app", "js", "watch-map-delivery.js"));

function phone(options) {
  const published = [];
  const assets = [];
  const requests = [];
  const plugin = {
    publishWatchMap: async (args) => { published.push(args.manifest); return { published: true }; },
    publishWatchMapAsset: async (args) => { assets.push(args); return { sent: true }; },
    watchMapInventory: async () => options.inventory || {}
  };
  if (options.garmin !== undefined) plugin.garminState = async () => ({ selectedDevice: options.garmin ? { deviceId: "d1" } : null });
  const fetchImpl = async (url) => {
    requests.push(url);
    const body = url.includes("watch=garmin") ? options.garminReport : options.imageReport;
    return { ok: true, json: async () => body, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  };
  const d = delivery.createDelivery({ plugin, fetch: fetchImpl, apiUrl: (u) => "https://app.example" + u, toBase64: () => "AAA" });
  return { d, published, assets, requests };
}

async function builtHoles() {
  const { buildGarminPackageIfStale } = await load();
  const state = { map: MAP, garminRow: null, saves: [] };
  stubNetwork(state);
  await buildGarminPackageIfStale("test-course", Date.now());
  return state.saves[1].holes;
}

test("a connected Garmin gets the drawn package: no images, no urls", async () => {
  const holes = await builtHoles();
  const p = phone({ garmin: true, garminReport: { watchPackageVersion: 4242, holes } });
  const result = await p.d.deliver("test-course");
  assert.strictEqual(result.drawn, true);
  assert.strictEqual(p.assets.length, 0, "nothing to download or send byte by byte");
  assert.ok(p.requests.every(u => u.includes("watch=garmin")), "the image package is not even read");
  const manifest = p.published[0];
  assert.strictEqual(manifest.version, 4242);
  assert.deepStrictEqual(manifest.holes.map(h => h.asset), ["h1.webp", "h2.webp"], "the name the watch requires");
  assert.ok(manifest.holes.every(h => !("url" in h)), "no url, so the Garmin draws every hole");
  assert.ok(manifest.skeleton && manifest.outlines && manifest.outlines.length, "skeleton and outlines ride along");

  assert.strictEqual(p.d.progress("test-course").complete, false, "not done until the watch says so");
  p.d.noteInventory({ courseKey: "test-course", version: "4242", holes: [] });
  assert.strictEqual(p.d.progress("test-course").complete, true, "the watch naming the version holds every drawn hole");
});

test("a Garmin already holding the package is not sent it again", async () => {
  const holes = await builtHoles();
  const p = phone({ garmin: true, garminReport: { watchPackageVersion: 4242, holes }, inventory: { courseKey: "test-course", version: "4242", holes: [] } });
  const result = await p.d.deliver("test-course");
  assert.strictEqual(result.sent, 0);
  assert.strictEqual(p.published.length, 0);
  assert.strictEqual(p.d.progress("test-course").complete, true);
});

test("a Garmin falls back to the image package until its own exists; an Apple Watch keeps images", async () => {
  const imageReport = { watchPackageVersion: 77, holes: [{ holeNumber: 1, path: "test-course/v77/h1.webp", spatialReference: { version: 1, refZoom: 20, transform: { a: 1, b: 0, tx: 0, ty: 0 }, imageWidth: 100, imageHeight: 200 } }] };
  const waiting = phone({ garmin: true, garminReport: { status: "building", watchPackageVersion: 0, holes: [] }, imageReport });
  await waiting.d.deliver("test-course");
  assert.strictEqual(waiting.published[0].version, 77, "the image package fills in");
  assert.ok(waiting.published[0].holes[0].url, "with its image url, as before");

  const apple = phone({ garmin: false, imageReport });
  await apple.d.deliver("test-course");
  assert.ok(!apple.requests.some(u => u.includes("watch=garmin")), "no Garmin chosen: the Garmin package is never asked for");
  assert.strictEqual(apple.assets.length, 1, "the Apple Watch still receives its image");
});

(async () => {
  let failed = 0;
  const realFetch = global.fetch;
  for (const t of tests) {
    try {
      await t.fn();
      console.log("  ok  " + t.name);
    } catch (err) {
      failed += 1;
      console.error("  FAIL " + t.name);
      console.error("       " + (err && err.stack || err));
    }
  }
  global.fetch = realFetch;
  if (failed) {
    console.error("garmin-package failed: " + failed + "/" + tests.length);
    process.exit(1);
  }
  console.log("garmin-package passed: " + tests.length + " checks");
})();
