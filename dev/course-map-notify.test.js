/* course-map-notify.mjs: "email me when this course is ready".
 * Supabase, Supabase Auth and Resend are stubbed at the fetch layer, so this is hermetic. */

const assert = require("assert");
const path = require("path");

const root = path.join(__dirname, "..");
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

const READY_MAP = { course_id: "pupuke", published: true, geometry_version: "v1", objects_json: {
  "green-1": { type: "green", holeNumber: 1, position: { lat: -36.8, lng: 174.7 }, greenShape: [{ lat: -36.8001, lng: 174.7001 }] },
  "tee-1": { type: "tee", holeNumber: 1, position: { lat: -36.799, lng: 174.699 } }
}, holes_json: {} };

function stubFetch(world) {
  world.writes = [];
  world.emails = [];
  global.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.includes("api.resend.com")) {
      if (world.resendStatus && world.resendStatus !== 200) return jsonResponse(world.resendStatus, { message: "rejected" });
      world.emails.push(JSON.parse(options.body));
      return jsonResponse(200, { id: "email-" + world.emails.length });
    }
    if (url.includes("/auth/v1/user")) {
      return world.user ? jsonResponse(200, world.user) : jsonResponse(401, {});
    }
    const rest = url.split("/rest/v1/")[1] || "";
    const table = rest.split("?")[0];
    const method = String(options.method || "GET").toUpperCase();
    if (method !== "GET") { world.writes.push({ table, method, query: rest, body: options.body ? JSON.parse(options.body) : null }); return jsonResponse(201, null); }
    if (table === "course_map_notify_requests") return jsonResponse(200, world.requests || []);
    if (table === "course_maps") return jsonResponse(200, rest.includes("course_id=eq.pupuke") ? (world.maps || []) : []);
    if (table === "course_mapper_jobs") return jsonResponse(200, world.mapperJobs || []);
    return jsonResponse(200, []);
  };
}

let mod = null;

test("emails everyone waiting on a course that now has a map, and stamps them", async () => {
  const world = { maps: [READY_MAP], requests: [
    { id: "r1", course_id: "pupuke", course_name: "Pupuke Golf Club", email: "a@example.com", recipient_name: "Alex" },
    { id: "r2", course_id: "pupuke", course_name: null, email: "b@example.com", recipient_name: null }
  ] };
  stubFetch(world);
  const result = await mod.sendReadyCourseMapNotifications();
  assert.deepStrictEqual(result, { checked: 1, sent: 2, failed: 0 });
  assert.strictEqual(world.emails.length, 2);
  assert.strictEqual(world.emails[0].subject, "Pupuke Golf Club is ready to play");
  assert.deepStrictEqual(world.emails[1].to, ["b@example.com"]);
  const stamps = world.writes.filter(w => w.method === "PATCH");
  assert.deepStrictEqual(stamps.map(w => w.query.split("id=eq.")[1]), ["r1", "r2"]);
  assert.ok(stamps.every(w => w.body.notified_at));
});

test("a course that is still failed sends nothing and stays pending", async () => {
  const world = { maps: [], mapperJobs: [{ id: "j1", kind: "automap", status: "failed", error: "no holes" }], requests: [
    { id: "r1", course_id: "fancourt", course_name: "Fancourt", email: "a@example.com" }
  ] };
  stubFetch(world);
  const result = await mod.sendReadyCourseMapNotifications();
  assert.strictEqual(result.sent, 0);
  assert.strictEqual(world.emails.length, 0);
  assert.strictEqual(world.writes.length, 0);
});

test("no email provider configured leaves the row waiting instead of claiming it was sent", async () => {
  delete process.env.RESEND_API_KEY;
  const world = { maps: [READY_MAP], requests: [{ id: "r1", course_id: "pupuke", email: "a@example.com" }] };
  stubFetch(world);
  const result = await mod.sendReadyCourseMapNotifications();
  process.env.RESEND_API_KEY = "re_test";
  assert.strictEqual(result.sent, 0);
  assert.strictEqual(world.writes.length, 0);
});

test("a bad address is stamped so it is not retried forever; a rate limit is retried", async () => {
  let world = { maps: [READY_MAP], resendStatus: 422, requests: [{ id: "r1", course_id: "pupuke", email: "a@example.com" }] };
  stubFetch(world);
  await mod.sendReadyCourseMapNotifications();
  assert.strictEqual(world.writes.filter(w => w.method === "PATCH").length, 1);
  world = { maps: [READY_MAP], resendStatus: 429, requests: [{ id: "r1", course_id: "pupuke", email: "a@example.com" }] };
  stubFetch(world);
  await mod.sendReadyCourseMapNotifications();
  assert.strictEqual(world.writes.length, 0);
});

test("POST stores the request against the verified account email, not anything the browser sends", async () => {
  const world = { user: { id: "u1", email: "Real@Example.com", user_metadata: { name: "Alex" } }, requests: [] };
  stubFetch(world);
  const req = new Request("https://x.test/api/course-map-notify", { method: "POST", headers: { Authorization: "Bearer t" }, body: JSON.stringify({ courseId: "Pupuke Golf", courseName: "Pupuke", email: "attacker@example.com" }) });
  const res = await mod.default(req);
  assert.strictEqual(res.status, 200);
  const write = world.writes.find(w => w.method === "POST");
  assert.strictEqual(write.body.email, "real@example.com");
  assert.strictEqual(write.body.course_id, "pupuke-golf");
  assert.strictEqual(write.body.notified_at, null);
  assert.ok(write.query.includes("on_conflict=course_id,user_id"));
});

test("POST without a session is refused", async () => {
  stubFetch({ user: null });
  const req = new Request("https://x.test/api/course-map-notify", { method: "POST", body: JSON.stringify({ courseId: "pupuke" }) });
  assert.strictEqual((await mod.default(req)).status, 401);
});

(async () => {
  process.env.SUPABASE_URL = "https://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  process.env.RESEND_API_KEY = "re_test";
  mod = await import(path.join(root, "functions", "course-map-notify.mjs"));
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("ok - " + t.name); }
    catch (error) { failed++; console.error("not ok - " + t.name + "\n", error); }
  }
  if (failed) { console.error(failed + " failed"); process.exit(1); }
  console.log("course-map-notify: " + tests.length + " passed");
})();
