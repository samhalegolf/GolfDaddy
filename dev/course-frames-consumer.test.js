#!/usr/bin/env node
"use strict";

/* GPS play as a CONSUMER of cloud frames.
 *
 * A course is 18 hole images in the database. The app surface downloads them once, keeps them,
 * and plays from them - it never scans, stitches or bakes. This suite covers the consumer end
 * of that, and the things it must refuse to do:
 *
 *   - a phone with no signal must never read an unreachable server as "this course has never
 *     been built" and start a course scan on a guess,
 *   - a half-downloaded course must read back as NOT cached, because 16 of 18 frames fails on
 *     the 14th tee, which is worse than failing at the first,
 *   - cached frames must be served without waiting on the network, which is both the
 *     zero-network case and the whole offline-round promise,
 *   - and every read goes through the same-origin /api proxy, never a Storage URL, which is
 *     what keeps the Capacitor shells and mobile web on one code path.
 *
 * Run against the GENERATED client rather than the engine: the app surface is what ships to
 * phones, and this proves the play API survives generation. */

const assert = require("assert");
const path = require("path");

const CLIENT = path.join(__dirname, "..", "scripts", "gd-course-visual-client.js");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function installGlobals() {
  const data = {};
  global.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    clear: () => Object.keys(data).forEach((k) => delete data[k])
  };
  global.dispatchEvent = function () {};
  global.CustomEvent = function (type, init) { return { type, detail: init && init.detail }; };
  /* The store falls back to an in-memory path when IndexedDB is absent, which is exactly the
     behaviour under test - what matters is what is cached, not where. */
  /* ...except where the POINT is where. Without a persistent layer the client's in-memory
     transient map is the only store, so it is always warm and a cold start cannot be expressed:
     a fresh module instance loses the download along with the map. assetDb() below is the
     minimum IndexedDB that makes the two layers distinct - bytes that outlive the module. */
  global.FileReader = function () {
    this.readAsDataURL = (blob) => {
      this.result = "data:" + blob.type + ";base64," + Buffer.from(String(blob.body)).toString("base64");
      setTimeout(() => this.onload && this.onload(), 0);
    };
  };
}

/* A course as the server would serve it: a build state, a frames index, and the frame bytes. */
function server(world) {
  const calls = { urls: [], posts: [] };
  global.fetch = async (url, options = {}) => {
    url = String(url);
    calls.urls.push(url);
    const method = String(options.method || "GET").toUpperCase();

    if (world.offline) throw new Error("network down");

    if (url.startsWith("/api/course-visual-jobs")) {
      if (method === "POST") {
        calls.posts.push(JSON.parse(options.body || "{}"));
        return json(world.enqueueStatus || 202, world.enqueueBody || { job: { id: "j1" }, state: "queued" });
      }
      return json(200, world.state || { state: "none", hasGeometry: true, framesReady: false });
    }
    if (url.startsWith("/api/course-visual-assets")) {
      const assetPath = decodeURIComponent(url.split("path=")[1] || "");
      if (assetPath.endsWith("index.json")) {
        return world.index ? json(200, world.index) : json(404, { error: "no index" });
      }
      const bytes = world.bytes && world.bytes[assetPath];
      return bytes ? blobResponse(bytes) : json(404, { error: "missing" });
    }
    if (url.startsWith("/api/course-visuals")) {
      return world.visual ? json(200, { visual: world.visual }) : json(404, { error: "no visual" });
    }
    return json(404, {});
  };
  return calls;
}

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, blob: async () => ({ type: "application/json", body: JSON.stringify(body) }) };
}
function blobResponse(bytes) {
  return { ok: true, status: 200, json: async () => null, blob: async () => ({ type: "image/jpeg", body: bytes }) };
}

const VERSION = "rabc123";
function framesIndex(holeCount = 3) {
  return {
    version: 1,
    courseId: "pupuke",
    exportVersion: VERSION,
    source: { key: "linz-nz", attribution: { text: "Sourced from the LINZ Data Service", license: "CC BY 4.0" } },
    overview: { path: "pupuke/frames/" + VERSION + "/overview.jpg", width: 1440, height: 900 },
    holes: Array.from({ length: holeCount }, (_, i) => ({
      holeNumber: i + 1,
      path: "pupuke/frames/" + VERSION + "/h" + (i + 1) + ".jpg",
      width: 2600, height: 2600,
      playSurface: { model: "mercator-image", captureZoom: 18, originPx: { x: 1, y: 2 } }
    }))
  };
}
function frameBytes(index) {
  const out = {};
  index.holes.forEach((hole) => { out[hole.path] = "jpeg-" + hole.holeNumber; });
  if (index.overview) out[index.overview.path] = "jpeg-overview";
  return out;
}

/* Each test gets a fresh module instance, so one test's cache is never another's. */
function freshEngine() {
  delete require.cache[require.resolve(CLIENT)];
  return require(CLIENT);
}

/* Enough IndexedDB for the asset store: open, one object store keyed by path, put and get.
   Backed by a plain object the caller owns, so surviving a freshEngine() is the whole point -
   that object is the phone's disk, and a new module instance is the app being reopened. */
function assetDb(disk) {
  const later = (fn) => setTimeout(fn, 0);
  return {
    open() {
      const req = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      const store = {
        put(record) { if (record && record.path) disk[record.path] = record; return {}; },
        get(key) {
          const out = { result: disk[key] || undefined, onsuccess: null, onerror: null };
          later(() => out.onsuccess && out.onsuccess());
          return out;
        }
      };
      req.result = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => store,
        /* oncomplete matters: saveAssetData resolves on it, so a transaction that never
           completes leaves the download awaiting forever and the run just stops. */
        transaction() {
          const tx = { objectStore: () => store, oncomplete: null, onerror: null, onabort: null };
          later(() => tx.oncomplete && tx.oncomplete());
          return tx;
        }
      };
      later(() => {
        if (req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    }
  };
}

function settle(ms = 30) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test("the play client exposes the frame consumer API and no authoring", () => {
  const engine = freshEngine();
  ["courseBuildState", "requestCourseBuild", "cachedCourseFrames", "downloadCourseFrames", "ensureCourseFrames"]
    .forEach((name) => assert.strictEqual(typeof engine[name], "function", name + " must ship to the app surface"));
  ["publishCourseVisual", "buildCourseVisual", "renderHoleFrame", "stitchCaptures"]
    .forEach((name) => assert.strictEqual(engine[name], undefined, name + " must not exist on the app surface"));
});

test("the wait mode is one flag with one value", () => {
  const engine = freshEngine();
  assert.strictEqual(engine.framesWaitMode, "live-until-ready", "ships live-until-ready; the other variant is a one-line flip");
});

test("frames download through the /api proxy, never a Storage URL", async () => {
  const engine = freshEngine();
  const index = framesIndex();
  const calls = server({ index, bytes: frameBytes(index) });
  const frames = await engine.downloadCourseFrames("pupuke");
  assert.ok(frames && frames.complete);
  assert.strictEqual(frames.holes.length, 3);
  assert.ok(calls.urls.length >= 4, "index plus every frame");
  calls.urls.forEach((url) => {
    assert.ok(url.startsWith("/api/"), "same-origin proxy only, got " + url);
    assert.ok(!/supabase|storage\/v1/i.test(url), "a Storage URL would split web and Capacitor apart");
  });
});

test("a complete download reads back from cache with no network at all", async () => {
  const engine = freshEngine();
  const index = framesIndex();
  server({ index, bytes: frameBytes(index) });
  await engine.downloadCourseFrames("pupuke");

  /* Flight mode. Anything that reaches for the network now is a bug the player finds on a
     course with no signal. */
  const offline = server({ offline: true });
  const cached = await engine.cachedCourseFrames("pupuke");
  assert.ok(cached && cached.complete, "a course opened once must play offline");
  assert.strictEqual(cached.holes.length, 3);
  assert.strictEqual(cached.version, VERSION);
  assert.deepStrictEqual(offline.urls, [], "cached frames must cost zero requests");
});

test("a download interrupted mid-course reads back as not cached", async () => {
  const engine = freshEngine();
  const index = framesIndex();
  const bytes = frameBytes(index);
  delete bytes[index.holes[2].path];
  server({ index, bytes });

  const frames = await engine.downloadCourseFrames("pupuke");
  assert.strictEqual(frames, null, "a partial course is not a course");
  const cached = await engine.cachedCourseFrames("pupuke");
  assert.strictEqual(cached, null, "the index is written last, so a partial set has no completion marker");
});

test("an unreachable server is not an unbuilt course", async () => {
  const engine = freshEngine();
  const calls = server({ offline: true });
  const state = await engine.courseBuildState("pupuke");
  assert.strictEqual(state.state, "unknown", "offline must never read as state none");

  const seen = [];
  const watch = engine.ensureCourseFrames("pupuke", { accessToken: "token", onState: (s) => seen.push(s.state) });
  await settle();
  watch.stop();
  assert.deepStrictEqual(calls.posts, [], "starting a course scan on a guess is the one irreversible mistake here");
  assert.ok(seen.includes("unknown"));
});

test("selecting an unbuilt course starts the build", async () => {
  const engine = freshEngine();
  const calls = server({ state: { state: "none", hasGeometry: true, framesReady: false } });
  const watch = engine.ensureCourseFrames("pupuke", { accessToken: "player-token" });
  await settle();
  watch.stop();
  assert.strictEqual(calls.posts.length, 1);
  assert.deepStrictEqual(calls.posts[0], { courseId: "pupuke", kind: "auto" }, "auto only - the app surface never sends a recipe");
});

test("a signed-out player does not start a build", async () => {
  const engine = freshEngine();
  const calls = server({ state: { state: "none", hasGeometry: true } });
  const watch = engine.ensureCourseFrames("pupuke", {});
  await settle();
  watch.stop();
  assert.deepStrictEqual(calls.posts, []);
});

/* The storage rule. The device holds two very different things and only one is automatic:
   course objects are kilobytes and cache freely (Live Map), while the frame package is
   megabytes and lands only when the player asks for it (Offline Map). Selecting a course is
   not consent to spend someone's cellular data, so the default must be to OFFER. */
test("ready frames are offered, not downloaded, when nobody asked", async () => {
  const engine = freshEngine();
  const index = framesIndex();
  const calls = server({ state: { state: "frames-ready", hasGeometry: true, framesReady: true, framesVersion: 3 }, index, bytes: frameBytes(index) });
  const offered = [], delivered = [];
  const watch = engine.ensureCourseFrames("pupuke", { accessToken: "t", onOfflineAvailable: (i) => offered.push(i), onFrames: (f) => delivered.push(f) });
  await settle(60);
  watch.stop();
  assert.strictEqual(offered.length, 1, "the player is told the offline map exists");
  assert.deepStrictEqual(delivered, [], "and nothing is downloaded");
  assert.deepStrictEqual(calls.urls.filter(u => /\.jpg/.test(u)), [], "not one frame fetched");
  assert.strictEqual(await engine.cachedCourseFrames("pupuke"), null, "nothing written to the device");
});

test("accepting the offer downloads the package", async () => {
  const engine = freshEngine();
  const index = framesIndex();
  server({ state: { state: "frames-ready", hasGeometry: true, framesReady: true, framesVersion: 3 }, index, bytes: frameBytes(index) });
  const delivered = [];
  const watch = engine.ensureCourseFrames("pupuke", { accessToken: "t", acquire: true, onFrames: (f) => delivered.push(f) });
  await settle(60);
  watch.stop();
  assert.strictEqual(delivered.length, 1);
  assert.strictEqual(delivered[0].holes.length, 3);
  assert.ok(delivered[0].holes[0].playSurface, "the frame carries the surface GPS play projects against");
  assert.ok(await engine.cachedCourseFrames("pupuke"), "and it is in the library afterwards");
});

test("a re-baked course is advertised, never silently re-pulled", async () => {
  const engine = freshEngine();
  const index = framesIndex();
  server({ index, bytes: frameBytes(index) });
  await engine.downloadCourseFrames("pupuke");

  const next = framesIndex();
  next.exportVersion = "rdef456";
  next.holes.forEach((hole) => { hole.path = "pupuke/frames/rdef456/h" + hole.holeNumber + ".jpg"; });
  next.overview.path = "pupuke/frames/rdef456/overview.jpg";
  const calls = server({ index: next, bytes: frameBytes(next), state: { state: "frames-ready", hasGeometry: true, framesReady: true } });

  const updates = [], delivered = [];
  const watch = engine.ensureCourseFrames("pupuke", { accessToken: "t", onUpdateAvailable: (i) => updates.push(i), onFrames: (f) => delivered.push(f) });
  await settle(80);
  watch.stop();
  assert.strictEqual(updates.length, 1, "the library screen is told an update exists");
  assert.strictEqual(updates[0].haveVersion, VERSION);
  assert.strictEqual(updates[0].framesVersion, "rdef456");
  assert.strictEqual(delivered.length, 1, "the cached copy still plays immediately");
  assert.strictEqual(delivered[0].fromCache, true);
  assert.deepStrictEqual(calls.urls.filter(u => /rdef456.*\.jpg/.test(u)), [],
    "re-pulling megabytes mid-round because the studio republished is exactly what this prevents");
});

test("a build already running is polled, not restarted", async () => {
  const engine = freshEngine();
  const calls = server({ state: { state: "running", hasGeometry: true, building: true, activeKind: "snapshot" } });
  const seen = [];
  const watch = engine.ensureCourseFrames("pupuke", { accessToken: "t", pollMs: 5000, onState: (s) => seen.push(s.state) });
  await settle();
  watch.stop();
  assert.deepStrictEqual(calls.posts, [], "one live job per course - the server dedupes, and so does this");
  assert.deepStrictEqual(seen, ["running"]);
});

test("a failed build stops rather than hammering the server", async () => {
  const engine = freshEngine();
  const calls = server({ state: { state: "failed", hasGeometry: true, lastError: "tile coverage incomplete" } });
  const watch = engine.ensureCourseFrames("pupuke", { accessToken: "t", pollMs: 20, onState: () => {} });
  await settle(120);
  watch.stop();
  const stateReads = calls.urls.filter((u) => u.startsWith("/api/course-visual-jobs")).length;
  assert.strictEqual(stateReads, 1, "a failed course is not retried in a loop");
  assert.deepStrictEqual(calls.posts, []);
});

/* The full hands-off chain, from the player's chair: selecting a brand-new course races the
   AutoMapper enqueue (the build request can be refused before the mapper job is visible),
   mapping takes minutes, and the mapper worker chains the snapshot server-side. The watch
   must survive that whole window - and when frames land, the player gets the OFFER, never a
   silent swap. Runs on real poll ticks (the 5s floor), so this test takes ~11s on purpose. */
test("a course being automapped keeps its watch, and ready frames arrive as the offer", async () => {
  const engine = freshEngine();
  const index = framesIndex();
  const world = { state: { state: "none", hasGeometry: false }, enqueueStatus: 404, enqueueBody: { error: "course has no published geometry", state: "none" } };
  const calls = server(world);
  const offered = [], delivered = [], seen = [];
  const watch = engine.ensureCourseFrames("pupuke", { accessToken: "t", pollMs: 5000, onState: (s) => seen.push(s.state), onOfflineAvailable: (i) => offered.push(i), onFrames: (f) => delivered.push(f) });
  await settle(60);
  assert.strictEqual(calls.posts.length, 1, "the build request went out and was refused - mapping had not surfaced yet");
  /* The mapper job becomes visible a beat later; the one-poll re-check catches it. */
  world.state = { state: "mapping", hasGeometry: false };
  await settle(5300);
  assert.ok(seen.includes("mapping"), "the watch heard mapping instead of dying on the refusal");
  /* Mapper finished; the worker chained snapshot -> export server-side; frames published. */
  world.state = { state: "frames-ready", hasGeometry: true, framesReady: true, framesVersion: 1 };
  world.index = index;
  world.bytes = frameBytes(index);
  await settle(5300);
  watch.stop();
  assert.strictEqual(offered.length, 1, "the player is offered the new map when it is ready");
  assert.deepStrictEqual(delivered, [], "and nothing swapped in on its own");
  assert.strictEqual(calls.posts.length, 1, "no second build request was manufactured along the way");
});

test("an accepted update swaps the newer export in", async () => {
  const engine = freshEngine();
  const index = framesIndex();
  server({ index, bytes: frameBytes(index) });
  await engine.downloadCourseFrames("pupuke");

  const next = framesIndex();
  next.exportVersion = "rdef456";
  next.holes.forEach((hole) => { hole.path = "pupuke/frames/rdef456/h" + hole.holeNumber + ".jpg"; });
  next.overview.path = "pupuke/frames/rdef456/overview.jpg";
  server({ index: next, bytes: frameBytes(next), state: { state: "frames-ready", hasGeometry: true, framesReady: true } });

  const delivered = [];
  const watch = engine.ensureCourseFrames("pupuke", { accessToken: "t", acquire: true, onFrames: (f) => delivered.push(f) });
  await settle(80);
  watch.stop();
  assert.ok(delivered.length >= 1);
  assert.strictEqual(delivered[0].fromCache, true, "the cached set plays immediately, before any network");
  assert.strictEqual(delivered[0].version, VERSION);
  assert.strictEqual(delivered[delivered.length - 1].version, "rdef456", "and the newer export swaps in behind it");
});

/* The published row as the server serves it: paths, and never pixels. The pixels only ever
   exist on the device, put there by the download. */
function publishedRow(index) {
  return {
    course_id: "pupuke", status: "published", current_version: 8, published_version: 8,
    uploaded_assets: [{ role: "published", path: index.overview.path }].concat(
      index.holes.map((hole) => ({ role: "hole-frame-published", path: hole.path, hole_number: hole.holeNumber }))
    )
  };
}

/* Downloading a course and then playing over live tiles anyway is the worst of both tiers: the
   megabytes are spent, the storage is used, and the player gets none of it.
 *
 * It happened because a pull rebuilt the record from the cloud row and reattached pixels only
 * from an in-memory map that nothing had filled yet - so the record play renders from carried
 * paths and no data, and cloudSurfaceSrc correctly returned "" for every hole. The ordering that
 * exposed it is the app's own: app-core schedules the pull ahead of the frames watch that
 * hydrates, so the pull always won.
 *
 * Asserted on a pull with NO hydrate call in front of it, because that is the real sequence. */
test("a downloaded course comes back from a pull with its pixels, not just its paths", async () => {
  const index = framesIndex();
  const disk = {};
  global.indexedDB = assetDb(disk);

  /* Session one: the player accepts the offer and the bytes land on the device. */
  const first = freshEngine();
  server({ index, bytes: frameBytes(index), visual: publishedRow(index) });
  const frames = await first.downloadCourseFrames("pupuke");
  assert.ok(frames && frames.complete, "the download must land before the pull means anything");
  assert.ok(Object.keys(disk).length >= index.holes.length, "and must actually reach the disk, not just the module");

  /* Session two: the app reopened. Same disk, and an empty in-memory map - which is the
     condition the bug needed, and the condition every real round after the first one is in.
     No hydrate call in front of the pull, because app-core does not make one: it schedules the
     pull at +80ms and the frames watch that hydrates at +120ms. */
  const next = freshEngine();
  server({ index, bytes: frameBytes(index), visual: publishedRow(index) });
  const record = await next.pullCourseVisual("pupuke");
  const published = (record && record.holeFramePublishedVisuals) || [];
  assert.strictEqual(published.length, index.holes.length, "every hole comes back on the record");
  const withPixels = published.filter((asset) => asset && asset.dataUrl);
  assert.strictEqual(withPixels.length, published.length,
    "a downloaded frame with no dataUrl plays as live tiles - " + withPixels.length + "/" + published.length + " carried pixels");
  delete global.indexedDB;
});

/* The other half of the same rule: nothing downloaded must still resolve, because "no library
   copy" is the live-tile tier and a real one - not an error, and not a reason to stall play. */
test("a course with nothing downloaded still pulls, and simply has no pixels", async () => {
  const engine = freshEngine();
  const index = framesIndex();
  server({ index, visual: publishedRow(index) });
  const record = await engine.pullCourseVisual("pupuke");
  const published = (record && record.holeFramePublishedVisuals) || [];
  assert.strictEqual(published.length, index.holes.length, "the paths are known even when the bytes are not");
  assert.strictEqual(published.filter((asset) => asset && asset.dataUrl).length, 0, "and no pixels are invented");
});

(async function run() {
  installGlobals();
  let failures = 0;
  for (const item of tests) {
    try {
      await item.fn();
      console.log("  ok  " + item.name);
    } catch (error) {
      failures += 1;
      console.error("  FAIL  " + item.name + "\n        " + (error && error.stack || error));
    }
  }
  if (failures) {
    console.error("course-frames-consumer FAILED: " + failures + " of " + tests.length);
    process.exit(1);
  }
  console.log("course-frames-consumer passed: " + tests.length + " checks");
})();
