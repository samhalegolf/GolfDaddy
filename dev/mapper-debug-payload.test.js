/* What the worker hands the Claude mapper-debug Routine for a real terminal failure.
 *
 * Companion to dev/mapper-debug-routine.test.js, which pins the fire itself. This pins
 * what rides on it: the operator's stored prompt for the failure's KIND opens the text,
 * the satellite and OSM captures are uploaded under the temporary mapper-debug/ folder
 * and linked, and the job row records the kind and where the captures went. And the
 * other way round: with the Routine off, no tile is fetched and nothing is uploaded.
 *
 * The course is 소피아그린CC as course_maps holds it, with Overpass returning nothing -
 * the 27 September 2026 failure replayed. */
const assert = require("assert");
const path = require("path");
const root = path.join(__dirname, "..");
const FIRE_URL = "https://api.anthropic.com/v1/claude_code/routines/trig_01PAYLOAD/fire";
const SESSION_URL = "https://claude.ai/code/session_01PAYLOAD";
const STUB_BASE = "https://stub.supabase.co";
const realFetch = global.fetch;
const realEnv = Object.assign({}, process.env);

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
let worker = null;
let tilePng = null;

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
function pngResponse(buffer) {
  return { ok: true, status: 200, arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), json: async () => ({}), text: async () => "" };
}
function routineEnv(on) {
  if (on) {
    process.env.CLAUDE_MAPPER_ROUTINE_URL = FIRE_URL;
    process.env.CLAUDE_MAPPER_ROUTINE_TOKEN = "sk-ant-oat01-stub";
  } else {
    delete process.env.CLAUDE_MAPPER_ROUTINE_URL;
    delete process.env.CLAUDE_MAPPER_ROUTINE_TOKEN;
  }
}

function stubWorld(options = {}) {
  const calls = { fires: [], patches: [], uploads: [], tiles: [], promptReads: 0, served: false };
  const job = { id: "job-sophia", course_id: "cc-37-178n-127-708e", kind: "automap", status: "queued", result: null };
  const courseRow = {
    course_id: job.course_id, course_name: "소피아그린CC", course_lat: 37.1780373, course_lng: 127.7075087,
    region: "Yeoju-si", country: "South Korea", country_code: "kr", objects_json: {}, holes_json: {}
  };
  global.fetch = async (url, init = {}) => {
    url = String(url);
    const method = String(init.method || "GET").toUpperCase();
    if (url.startsWith("https://api.anthropic.com/")) {
      calls.fires.push({ url, body: JSON.parse(init.body || "{}") });
      return jsonResponse(200, { type: "routine_fire", claude_code_session_id: "session_01PAYLOAD", claude_code_session_url: SESSION_URL });
    }
    if (url.startsWith("https://api.resend.com/")) return jsonResponse(200, { id: "email-1" });
    if (url.includes("overpass")) return jsonResponse(200, { elements: [] });
    if (url.includes("arcgis.com/") || url.includes("tile.openstreetmap.org/")) {
      calls.tiles.push({ url, headers: init.headers || {} });
      return pngResponse(tilePng);
    }
    if (url.startsWith(STUB_BASE + "/storage/v1/object/") && method === "POST") {
      calls.uploads.push(url.slice((STUB_BASE + "/storage/v1/object/").length));
      return jsonResponse(200, { Key: "ok" });
    }
    const rest = url.split("/rest/v1/")[1] || "";
    if (method === "GET" && rest.startsWith("mapper_failure_prompts")) {
      calls.promptReads += 1;
      return jsonResponse(200, options.storedPrompt ? [{ prompt: options.storedPrompt }] : []);
    }
    if (method === "GET" && rest.startsWith("course_mapper_jobs") && rest.includes("status=eq.queued")) {
      if (calls.served) return jsonResponse(200, []);
      calls.served = true;
      return jsonResponse(200, [job]);
    }
    if (method === "GET" && rest.startsWith("course_maps")) {
      return jsonResponse(200, rest.includes("course_id=eq.") ? [courseRow] : []);
    }
    if (method === "PATCH" && rest.startsWith("course_mapper_jobs")) {
      const body = JSON.parse(init.body || "{}");
      if (rest.includes("status=eq.queued")) return jsonResponse(200, [job]);
      calls.patches.push(body);
      return jsonResponse(200, [job]);
    }
    return jsonResponse(200, []);
  };
  return calls;
}

async function runWorker() {
  await worker.run(new Request("https://clarity.test/.netlify/functions/course-mapper-worker-background", { method: "POST", body: "{}" }));
}

test("the fire opens with the stored prompt for the kind and links both captures", async () => {
  routineEnv(true);
  process.env.ARCGIS_API_KEY = "esri-stub";
  const calls = stubWorld({ storedPrompt: "Draw {{courseName}} ({{courseId}}) from the imagery, {{expectedHoles}} holes." });
  await runWorker();
  const failed = calls.patches.find(p => p.status === "failed");
  assert.ok(failed, "the job ends failed");
  assert.match(failed.error, /no numbered hole geometry/);
  assert.strictEqual(calls.fires.length, 1, "exactly one routine fire");
  const text = calls.fires[0].body.text;
  assert.ok(text.startsWith("Draw 소피아그린CC (cc-37-178n-127-708e) from the imagery,"), "the operator's prompt comes first, filled: " + text.slice(0, 90));
  assert.match(failed.result.failureKind, /^no-osm-data/, "the kind is recorded on the row");
  assert.match(text, /failure_kind: no-osm-data/);
  assert.match(text, /job_id: job-sophia/);
  assert.strictEqual(calls.promptReads, 1, "the stored prompt was read once");

  const publicBase = STUB_BASE + "/storage/v1/object/public/course-visuals/mapper-debug/";
  assert.ok(text.includes("satellite: " + publicBase), "satellite capture linked");
  assert.ok(text.includes("osm: " + publicBase), "osm capture linked");
  assert.match(text, /bounds: north 37\.\d+, south 37\.\d+, west 127\.\d+, east 127\.\d+/, "the captures are georeferenced");
  assert.match(text, /--- output contract ---/);
  assert.strictEqual(calls.tiles.length, 32, "sixteen tiles per capture, two captures");
  const osmTile = calls.tiles.find(t => t.url.includes("openstreetmap.org"));
  assert.match(String(osmTile.headers["User-Agent"] || ""), /ClarityCaddy/, "OSM tiles are fetched with a descriptive User-Agent");
  assert.deepStrictEqual(calls.uploads.map(u => u.split("/").slice(0, 2).join("/") + "/.../" + u.split("/").pop()),
    ["course-visuals/mapper-debug/.../satellite.png", "course-visuals/mapper-debug/.../osm.png"], "uploaded under the temporary folder");

  const payload = failed.result.debugPayload;
  assert.strictEqual(payload.promptSource, "stored");
  assert.ok(payload.captures.satellite.url.startsWith(publicBase) && payload.captures.osm.url.startsWith(publicBase), "the row says where the captures went");
  assert.strictEqual(payload.captures.width, 1024);
  assert.strictEqual(failed.result.debugSession.sessionUrl, SESSION_URL);
});

test("without an Esri key the satellite capture says why and the OSM one still happens", async () => {
  routineEnv(true);
  delete process.env.ARCGIS_API_KEY;
  delete process.env.ESRI_API_KEY;
  const calls = stubWorld();
  await runWorker();
  const text = calls.fires[0].body.text;
  assert.match(text, /satellite: not captured \(no-esri-key/);
  assert.ok(text.includes("osm: " + STUB_BASE + "/storage/v1/object/public/course-visuals/mapper-debug/"));
  assert.strictEqual(calls.uploads.length, 1);
  const failed = calls.patches.find(p => p.status === "failed");
  assert.strictEqual(failed.result.debugPayload.promptSource, "default", "no stored prompt means the kind's default");
  assert.ok(text.startsWith("소피아그린CC (cc-37-178n-127-708e) has no golf geometry"), "and the default is filled the same way: " + text.slice(0, 60));
});

test("with the routine off nothing is fetched or uploaded, and the kind is still recorded", async () => {
  routineEnv(false);
  process.env.ARCGIS_API_KEY = "esri-stub";
  const calls = stubWorld({ storedPrompt: "unused" });
  await runWorker();
  const failed = calls.patches.find(p => p.status === "failed");
  assert.ok(failed);
  assert.strictEqual(calls.tiles.length, 0, "no tiles for a feature that is off");
  assert.strictEqual(calls.uploads.length, 0);
  assert.strictEqual(calls.promptReads, 0);
  assert.strictEqual(calls.fires.length, 0);
  assert.match(failed.result.failureKind, /^no-osm-data/);
  assert.strictEqual(failed.result.debugPayload, undefined, "nothing was built, so nothing is claimed");
  assert.deepStrictEqual(failed.result.debugSession, { fired: false, reason: "missing_routine_url" });
});

(async function run() {
  process.env.SUPABASE_URL = STUB_BASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-stub";
  process.env.CLARITY_ALERT_EMAIL = "sam@example.com";
  process.env.RESEND_API_KEY = "re_stub";
  tilePng = await require("sharp")({ create: { width: 256, height: 256, channels: 3, background: { r: 30, g: 120, b: 40 } } }).png().toBuffer();
  const mod = await import(path.join(root, "functions", "course-mapper-worker-background.mjs"));
  worker = Object.assign({ run: mod.default }, mod.__courseMapperWorkerTest);
  let failures = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failures++; console.error("  FAIL " + t.name); console.error("       " + (err && err.stack || err)); }
  }
  global.fetch = realFetch;
  process.env = realEnv;
  if (failures) { console.error("mapper-debug-payload failed: " + failures + "/" + tests.length); process.exit(1); }
  console.log("mapper-debug-payload passed: " + tests.length + " checks");
})();
