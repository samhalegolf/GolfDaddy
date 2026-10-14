/* The tree run on the mapper queue (find_trees in functions/course-mapper-worker-background.mjs):
 * a course with no frames is read off Esri and its tree layer written live; trees someone
 * edited in Studio are left alone unless the run was asked for by hand.
 *
 * Supabase, Esri and the canopy host are stubbed at the fetch layer, so the suite is hermetic.
 *
 * Run: node dev/course-trees-job.test.js */

const assert = require("assert");
const path = require("path");
const sharp = require("sharp");

const root = path.join(__dirname, "..");
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => null } };
}

const LAT = -37.78, LNG = 175.28, K = Math.cos(LAT * Math.PI / 180);
const at = (dx, dy) => ({ lat: LAT + dy / 111320, lng: LNG + dx / (111320 * K) });
const OBJECTS = {
  f: { type: "fairway_area", holeNumber: 1, shape: [at(-40, -20), at(40, -20), at(40, 20), at(-40, 20)] },
  g: { type: "green", holeNumber: 1, position: at(60, 0) }
};

let tile = null;
function stub(world) {
  const calls = { posts: [], esri: 0, headers: [] };
  global.fetch = async (url, options = {}) => {
    url = String(url);
    const method = String(options.method || "GET").toUpperCase();
    if (url.includes("ibasemaps-api.arcgis.com")) {
      calls.esri++;
      calls.headers.push(options.headers || {});
      return { ok: true, status: 200, arrayBuffer: async () => tile.buffer.slice(tile.byteOffset, tile.byteOffset + tile.length), headers: { get: () => null } };
    }
    if (url.includes("data.source.coop")) throw new Error("no canopy in tests");
    const rest = url.split("/rest/v1/")[1] || "";
    const table = rest.split("?")[0];
    if (method === "POST") { calls.posts.push({ table, rows: JSON.parse(options.body || "[]") }); return jsonResponse(201, []); }
    if (method === "PATCH") return jsonResponse(200, []);
    if (table === "course_maps") return jsonResponse(200, [{ course_id: "c", objects_json: OBJECTS }]);
    if (table === "course_trees") return jsonResponse(200, world.trees || []);
    if (table === "course_visuals") return jsonResponse(200, []);
    return jsonResponse(200, []);
  };
  return calls;
}

test("trees edited in Studio are left as they are by an automatic run", async () => {
  const calls = stub({ trees: [{ status: "edited", level: 3 }] });
  const out = await worker.runTreeJob({ id: "j", course_id: "c", kind: "find_trees", result: null });
  assert.strictEqual(out.written, false);
  assert.strictEqual(calls.esri, 0, "nothing was fetched");
  assert.ok(!calls.posts.some(p => p.table === "course_trees"));
});

test("a course with no frames is read off Esri, and its tree layer written live at its level", async () => {
  const calls = stub({ trees: [{ status: "edited", level: 4 }] });
  const out = await worker.runTreeJob({ id: "j", course_id: "c", kind: "find_trees", requested_by: "user:x", result: { force: true } });
  assert.strictEqual(out.written, true);
  assert.strictEqual(out.imagery, "esri");
  assert.ok(calls.esri > 0, "Esri tiles were fetched");
  assert.ok(calls.headers.every(h => h.Referer), "Esri is asked from the site's own address");
  const saved = calls.posts.find(p => p.table === "course_trees").rows[0];
  assert.strictEqual(saved.status, "auto");
  assert.strictEqual(saved.level, 4, "a forced run keeps the level the course was shown at");
  assert.strictEqual(saved.imagery, "esri");
  assert.ok(saved.published_at && Array.isArray(saved.trees));
  assert.ok(saved.run && saved.run.holes["1"] && saved.run.holes["1"].source === "esri");
});

let worker = null;
(async () => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub";
  process.env.ARCGIS_API_KEY = "test-key";
  tile = await sharp({ create: { width: 256, height: 256, channels: 3, background: { r: 90, g: 140, b: 65 } } }).png().toBuffer();
  worker = (await import(path.join(root, "functions", "course-mapper-worker-background.mjs"))).__courseMapperWorkerTest;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (error) { failed++; console.log("FAIL  " + t.name + "\n      " + (error && error.stack || error)); }
  }
  console.log((failed ? "FAILED " + failed + "/" : "passed ") + tests.length + " tree job checks");
  process.exit(failed ? 1 : 0);
})();
