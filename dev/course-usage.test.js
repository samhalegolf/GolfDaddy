/* functions/course-usage.mjs: the anonymous course map usage counter. Checks it
 * passes only the course, the event, what the map was and Netlify's country to the
 * database, still counts the bare shape older app installs send, refuses anything
 * outside the known values, and shapes the admin report. */

const assert = require("assert");
const path = require("path");

const root = path.join(__dirname, "..");
const realFetch = global.fetch;

function post(body, headers) {
  return new Request("https://example.test/api/course-usage", {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
    body: JSON.stringify(body)
  });
}

(async () => {
  process.env.SUPABASE_URL = "https://db.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: JSON.parse(options.body || "null") });
    return { ok: true, status: 204, text: async () => "" };
  };
  const { default: courseUsage } = await import(path.join(root, "functions/course-usage.mjs"));

  let res = await courseUsage(post({ courseId: "Royal Test GC", event: "play", origin: "ios", accountId: "someone" },
    { "user-agent": "phone" }), { geo: { country: { code: "nz" } } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/rest/v1/rpc/record_course_map_usage"));
  assert.deepStrictEqual(calls[0].body,
    { p_course_id: "royal-test-gc", p_event: "play", p_origin: "ios", p_country: "NZ",
      p_map_type: "", p_outcome: "", p_version: "", p_wait_ms: 0, p_course_name: "" },
    "an older install's bare play still counts, and nothing about the player reaches the database");

  res = await courseUsage(post({ courseId: "royal-test-gc", event: "download", origin: "watch" }), {});
  assert.strictEqual(res.status, 200);
  assert.strictEqual(calls[1].body.p_country, "", "no geo means no country, not a guess");

  res = await courseUsage(post({ courseId: "Unmapped Links", courseName: "  Unmapped   Links ", event: "play", origin: "android",
    mapType: "live", outcome: "not-mapped", waitMs: 99999999 }), {});
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(calls[2].body,
    { p_course_id: "unmapped-links", p_event: "play", p_origin: "android", p_country: "",
      p_map_type: "live", p_outcome: "not-mapped", p_version: "", p_wait_ms: 600000, p_course_name: "Unmapped Links" },
    "a course with no map is counted, with its name, and the wait is capped");

  res = await courseUsage(post({ courseId: "royal-test-gc", event: "update", origin: "web", mapType: "full", version: "v2.1" }), {});
  assert.strictEqual(res.status, 200);
  assert.strictEqual(calls[3].body.p_version, "v2.1");

  for (const bad of [
    { courseId: "x", event: "view", origin: "ios" },
    { courseId: "x", event: "play", origin: "desktop" },
    { event: "play", origin: "web" },
    { courseId: "x", event: "play", origin: "web", mapType: "huge" },
    { courseId: "x", event: "play", origin: "web", outcome: "whatever" },
    { courseId: "x", event: "play", origin: "web", version: "1.4" }
  ]) {
    res = await courseUsage(post(bad), {});
    assert.strictEqual(res.status, 400, JSON.stringify(bad));
  }
  assert.strictEqual(calls.length, 4, "rejected requests never reach the database");

  res = await courseUsage(new Request("https://example.test/api/course-usage", { method: "PUT" }), {});
  assert.strictEqual(res.status, 405);

  /* The admin read: no session is refused; a verified admin gets the summary rows. */
  res = await courseUsage(new Request("https://example.test/api/course-usage"), {});
  assert.strictEqual(res.status, 403, "no session token, no stats");

  global.fetch = async (url) => {
    url = String(url);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "u1", email: "player@example.com" }), { status: 200 });
    throw new Error("summary must not be read for a non-admin: " + url);
  };
  res = await courseUsage(new Request("https://example.test/api/course-usage", { headers: { Authorization: "Bearer t" } }), {});
  assert.strictEqual(res.status, 403, "a signed-in non-admin is refused");

  const rows = [{ course_id: "royal-test-gc", event: "play", origin: "ios", map_type: "full", outcome: "cached", version: "v2.1", count: 3 }];
  let asked = null;
  global.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "u1", email: "samhalegolf@gmail.com" }), { status: 200 });
    assert.ok(url.endsWith("/rest/v1/rpc/course_map_usage_report"), url);
    asked = JSON.parse(options.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({
      rows,
      daily: [{ day: "2026-10-20", event: "play", origin: "ios", count: 3 }],
      courses: [
        { course_id: "royal-test-gc", course_name: "Royal Test GC", in_database: true, objects_revision: 5, bake_number: 2, bake_objects_revision: 4, published_version: 9 },
        { course_id: "lite-only", course_name: "Lite Only", in_database: true, objects_revision: 3 },
        { course_id: "unmapped-links", course_name: "Unmapped Links", in_database: false }
      ]
    }) };
  };
  res = await courseUsage(new Request("https://example.test/api/course-usage?days=7", { headers: { Authorization: "Bearer t" } }), {});
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(asked, { p_days: 7 });
  const report = await res.json();
  assert.deepStrictEqual(report.rows, rows);
  assert.strictEqual(report.daily.length, 1);
  assert.deepStrictEqual(report.courses, [
    { courseId: "royal-test-gc", courseName: "Royal Test GC", inDatabase: true, currentVersion: "v2.1" },
    { courseId: "lite-only", courseName: "Lite Only", inDatabase: true, currentVersion: "v0.3" },
    { courseId: "unmapped-links", courseName: "Unmapped Links", inDatabase: false, currentVersion: null }
  ], "the current label follows the same rule the package endpoint uses");

  await courseUsage(new Request("https://example.test/api/course-usage?days=12345", { headers: { Authorization: "Bearer t" } }), {});
  assert.deepStrictEqual(asked, { p_days: 30 }, "an unknown range falls back to 30 days");

  global.fetch = realFetch;
  console.log("course-usage: all checks passed");
})().catch((error) => { console.error(error); process.exit(1); });
