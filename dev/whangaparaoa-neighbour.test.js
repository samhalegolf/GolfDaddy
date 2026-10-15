/* Whangaparaoa, 2026-10-15: a scan of "Whangaparaoa Golf Club" published Gulf Harbour's 18,
 * 1.2km south, as "Whangaparaoa Golf Club - Course 2". Whangaparaoa's OSM outline carries the
 * club's name and holds its one 18; Gulf Harbour's holes sit in no outline at all. Inside the
 * 2km sibling reach, with no other club's name on it, nothing set it aside.
 *
 * The club's own outline is the club's boundary: an unoutlined 18 outside it is a neighbour,
 * and an unnamed neighbour is not published. Controls: a course outline named only as a
 * course label, or one that does not name the searched club, says nothing about what lies
 * outside it, so the second 18 still publishes as a sibling there (Te Arai, Millbrook).
 *
 * Run: node dev/whangaparaoa-neighbour.test.js */

const assert = require("assert");
const path = require("path");

const root = path.join(__dirname, "..");
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const PIN = { lat: -36.6067, lng: 174.7920 };
const SOUTH = { lat: PIN.lat - 0.012, lng: PIN.lng };

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

function site(pinnedOutlineName) {
  return { elements: course(1000, PIN).concat(course(2000, SOUTH), [
    ring(PIN, { leisure: "golf_course", name: pinnedOutlineName }, 384124005)
  ]) };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function queryValue(rest, key) {
  const match = rest.match(new RegExp("[?&]" + key + "=eq\\.([^&]*)"));
  return match ? decodeURIComponent(match[1]) : null;
}

async function replay(payload, { existingMaps = [] } = {}) {
  const maps = new Map([["whangaparaoa", {
    course_id: "whangaparaoa", course_name: "Whangaparaoa Golf Club", course_lat: PIN.lat, course_lng: PIN.lng,
    country: "New Zealand", country_code: "NZ", region: "Auckland", objects_json: {}, holes_json: {}
  }]].concat(existingMaps.map(row => [row.course_id, row])));
  const job = { id: "job-whangaparaoa", course_id: "whangaparaoa", kind: "automap", status: "queued", mapper_version: "v2" };
  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    url = String(url);
    const method = String(init.method || "GET").toUpperCase();
    if (url.includes("overpass")) return jsonResponse(200, payload);
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

test("the club's own outline: the unoutlined 18 beside it is a neighbour, and not published", async () => {
  const { job, maps } = await replay(site("Whangaparaoa Golf Club"));
  assert.strictEqual(job.status, "done", "the run finishes: " + JSON.stringify(job.error || job.result && job.result.warnings));
  assert.deepStrictEqual([...maps.keys()], ["whangaparaoa"], "no whangaparaoa-course-2, and no row for the unnamed neighbour");
  assert.strictEqual(Object.keys(maps.get("whangaparaoa").holes_json || {}).length, 18, "Whangaparaoa keeps its own 18");
  const diagnostics = job.result.diagnostics;
  assert.strictEqual(diagnostics.scopedToOneCourse.reason, "one-course-left-after-neighbours-set-aside");
  assert.deepStrictEqual(diagnostics.neighbouringClubs.map(entry => entry.reason), ["outside-the-clubs-own-outline"]);
  assert.deepStrictEqual(diagnostics.neighbourCourses.map(entry => entry.skipped), ["no-name"]);
});

test("an outline named only as a course label leaves the second 18 a sibling", async () => {
  const { separateLoops } = await import(path.join(root, "functions", "lib", "gd-automapper-core.mjs"));
  const loops = separateLoops(site("North Course"), PIN, { facilityName: "Whangaparaoa Golf Club", selectedName: "Whangaparaoa Golf Club" });
  assert.strictEqual(loops.length, 2);
  assert.deepStrictEqual(loops.neighbours, []);
});

test("an outline that does not name the searched club leaves the second 18 a sibling", async () => {
  const { separateLoops } = await import(path.join(root, "functions", "lib", "gd-automapper-core.mjs"));
  const loops = separateLoops(site("Army Bay Golf Club"), PIN, { facilityName: "Whangaparaoa Golf Club", selectedName: "Whangaparaoa Golf Club" });
  assert.strictEqual(loops.length, 2);
  assert.deepStrictEqual(loops.neighbours, []);
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log("  ok  " + name); }
    catch (error) { failed++; console.log("  FAIL  " + name + "\n        " + String(error && error.stack || error).split("\n").slice(0, 6).join("\n        ")); }
  }
  if (failed) { console.log("whangaparaoa-neighbour FAILED: " + failed + " of " + tests.length); process.exit(1); }
  console.log("whangaparaoa-neighbour passed: " + tests.length + " checks");
})();
