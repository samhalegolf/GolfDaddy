/* Poppy Hills, 2026-10-02: a scan of "Poppy Hills Golf Course" published seven courses under
 * facility poppy-hills - itself plus Spyglass Hill, The Hay, Cypress Point, Pacific Grove and
 * two unnamed 18s (Pebble Beach, Spanish Bay) - every one with a poppy-hills-* id.
 *
 * Replays the real worker over a small version of that ground, with Supabase and Overpass
 * stubbed at the fetch layer:
 *   Poppy Hills         the pinned 18, no outline of its own
 *   Spyglass Hill       ~1.4km, its own named outline
 *   an unnamed 18       ~2.5km, nobody's outline
 *
 * What should come out: Poppy Hills maps as one course on its own row; Spyglass is published
 * as a course of its own (own id and name, no facility grouping); the unnamed 18 is skipped, since
 * it has no name to publish under; nothing is published as poppy-hills-*.
 *
 * Run: node dev/poppy-hills-neighbours.test.js */

const assert = require("assert");
const path = require("path");

const root = path.join(__dirname, "..");
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const PIN = { lat: 36.5848, lng: -121.9400 };
const SPYGLASS = { lat: 36.5848, lng: -121.9580 };
const FAR = { lat: 36.5620, lng: -121.9400 };

/* An 18 laid out as one walk: each hole's tee 60m on from the last green. */
function course(idBase, origin) {
  const elements = [];
  let at = { lat: origin.lat, lng: origin.lng };
  for (let n = 1; n <= 18; n++) {
    const start = at;
    const end = { lat: start.lat + 0.0025, lng: start.lng + (n % 2 ? 0.0006 : -0.0006) };
    elements.push({ type: "way", id: idBase + n, tags: { golf: "hole", ref: String(n), par: "4" }, geometry: [start, end] });
    elements.push({ type: "way", id: idBase + 500 + n, tags: { golf: "green" }, geometry: [
      { lat: end.lat, lng: end.lng }, { lat: end.lat + 0.0001, lng: end.lng },
      { lat: end.lat + 0.0001, lng: end.lng + 0.0001 }, { lat: end.lat, lng: end.lng + 0.0001 }, { lat: end.lat, lng: end.lng }
    ] });
    at = { lat: end.lat - 0.0021, lng: end.lng + 0.0007 };
  }
  return elements;
}

function ring(origin, tags, id) {
  const pts = [
    { lat: origin.lat - 0.002, lng: origin.lng - 0.002 },
    { lat: origin.lat + 0.008, lng: origin.lng - 0.002 },
    { lat: origin.lat + 0.008, lng: origin.lng + 0.016 },
    { lat: origin.lat - 0.002, lng: origin.lng + 0.016 },
    { lat: origin.lat - 0.002, lng: origin.lng - 0.002 }
  ];
  return { type: "way", id, tags, geometry: pts };
}

const PAYLOAD = { elements: course(1000, PIN).concat(course(2000, SPYGLASS), course(3000, FAR), [
  ring(SPYGLASS, { leisure: "golf_course", name: "Spyglass Hill Golf Course" }, 281477606)
]) };

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function queryValue(rest, key) {
  const match = rest.match(new RegExp("[?&]" + key + "=eq\\.([^&]*)"));
  return match ? decodeURIComponent(match[1]) : null;
}

async function replay({ existingMaps = [] } = {}) {
  const maps = new Map([["poppy-hills", {
    course_id: "poppy-hills", course_name: "Poppy Hills Golf Course", course_lat: PIN.lat, course_lng: PIN.lng,
    country: "United States", country_code: "US", region: "California", objects_json: {}, holes_json: {}
  }]].concat(existingMaps.map(row => [row.course_id, row])));
  const job = { id: "job-poppy", course_id: "poppy-hills", kind: "automap", status: "queued", mapper_version: "v2" };
  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    url = String(url);
    const method = String(init.method || "GET").toUpperCase();
    if (url.includes("overpass")) return jsonResponse(200, PAYLOAD);
    if (!url.startsWith("https://stub.supabase.co/")) return jsonResponse(404, {});
    const rest = url.split("/rest/v1/")[1] || "";
    const table = rest.split("?")[0];
    const body = init.body ? JSON.parse(init.body) : null;
    if (table === "course_mapper_jobs") {
      if (method === "GET") return jsonResponse(200, rest.includes("status=eq.queued") && job.status === "queued" ? [Object.assign({}, job)] : (queryValue(rest, "id") ? [Object.assign({}, job)] : []));
      if (method === "PATCH") {
        if (rest.includes("status=eq.queued") && job.status !== "queued") return jsonResponse(200, []);
        Object.assign(job, body);
        return jsonResponse(200, [Object.assign({}, job)]);
      }
      return jsonResponse(200, []);
    }
    if (table === "course_maps") {
      if (method === "GET") {
        const id = queryValue(rest, "course_id");
        const facility = queryValue(rest, "facility_key");
        const ref = queryValue(rest, "osm_course_ref");
        let rows = [...maps.values()];
        if (id != null) rows = rows.filter(row => row.course_id === id);
        if (facility != null) rows = rows.filter(row => row.facility_key === facility);
        if (ref != null) rows = rows.filter(row => row.osm_course_ref === ref);
        return jsonResponse(200, rows.map(row => Object.assign({}, row)));
      }
      if (method === "PATCH") {
        const row = maps.get(queryValue(rest, "course_id"));
        if (row) Object.assign(row, body);
        return jsonResponse(200, row ? [row] : []);
      }
      if (method === "POST") {
        (Array.isArray(body) ? body : [body]).forEach(row => maps.set(row.course_id, Object.assign(maps.get(row.course_id) || {}, row)));
        return jsonResponse(201, Array.isArray(body) ? body : [body]);
      }
    }
    return jsonResponse(200, []);
  };
  const realEnv = Object.assign({}, process.env);
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-stub";
  try {
    const worker = await import(path.join(root, "functions", "course-mapper-worker-background.mjs"));
    await worker.default({ json: async () => ({ jobId: job.id }) });
  } finally {
    global.fetch = realFetch;
    process.env = realEnv;
  }
  return { job, maps };
}

test("a single course maps alone, and a named neighbour is published as a course of its own", async () => {
  const { job, maps } = await replay();
  assert.strictEqual(job.status, "done", "the run finishes: " + JSON.stringify(job.error || job.result && job.result.warnings));
  const ids = [...maps.keys()].sort();
  assert.deepStrictEqual(ids, ["poppy-hills", "spyglass-hill-golf-course"],
    "Poppy Hills and Spyglass only - no poppy-hills-* siblings, and no row for the unnamed 18");
  const poppy = maps.get("poppy-hills");
  assert.strictEqual(Object.keys(poppy.holes_json || {}).length, 18, "Poppy Hills keeps its own 18");
  const spyglass = maps.get("spyglass-hill-golf-course");
  assert.strictEqual(spyglass.course_name, "Spyglass Hill Golf Course");
  assert.strictEqual(spyglass.facility_key, null, "a course on its own, not one of Poppy Hills'");
  assert.strictEqual(spyglass.facility_name, null);
  assert.strictEqual(spyglass.osm_course_ref, "way/281477606");
  assert.strictEqual(Object.keys(spyglass.holes_json || {}).length, 18);

  const diagnostics = job.result.diagnostics;
  assert.strictEqual(diagnostics.scopedToOneCourse.reason, "one-course-left-after-neighbours-set-aside");
  const outcomes = diagnostics.neighbourCourses.map(entry => [entry.name, entry.courseId || entry.skipped]);
  assert.deepStrictEqual(outcomes.sort(), [[null, "no-name"], ["Spyglass Hill Golf Course", "spyglass-hill-golf-course"]].sort());
});

test("a neighbour we already have is never overwritten", async () => {
  const existing = {
    course_id: "spyglass-hill", course_name: "Spyglass Hill", course_lat: 36.59, course_lng: -121.95,
    osm_course_ref: "way/281477606", facility_key: "spyglass-hill", objects_json: { keep: true }, holes_json: { 1: {} }
  };
  const { job, maps } = await replay({ existingMaps: [existing] });
  assert.strictEqual(job.status, "done");
  assert.ok(!maps.has("spyglass-hill-golf-course"), "no second Spyglass row");
  assert.deepStrictEqual(maps.get("spyglass-hill").objects_json, { keep: true }, "the existing row is untouched");
  const spyglass = job.result.diagnostics.neighbourCourses.find(entry => entry.name === "Spyglass Hill Golf Course");
  assert.strictEqual(spyglass.skipped, "already-mapped");
  assert.deepStrictEqual(spyglass.existing, { courseId: "spyglass-hill", by: "osm-outline" });
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log("  ok  " + name); }
    catch (error) { failed++; console.log("  FAIL  " + name + "\n        " + String(error && error.stack || error).split("\n").slice(0, 6).join("\n        ")); }
  }
  if (failed) { console.log("poppy-hills-neighbours FAILED: " + failed + " of " + tests.length); process.exit(1); }
  console.log("poppy-hills-neighbours passed: " + tests.length + " checks");
})();
