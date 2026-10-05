/* functions/course-usage.mjs: the anonymous course map usage counter. Checks it
 * passes only course id / event / origin / Netlify's country to the database,
 * and refuses anything outside the known events and origins. */

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
    { p_course_id: "royal-test-gc", p_event: "play", p_origin: "ios", p_country: "NZ" },
    "only course, event, origin and country reach the database");

  res = await courseUsage(post({ courseId: "royal-test-gc", event: "download", origin: "watch" }), {});
  assert.strictEqual(res.status, 200);
  assert.strictEqual(calls[1].body.p_country, "", "no geo means no country, not a guess");

  for (const bad of [{ courseId: "x", event: "view", origin: "ios" }, { courseId: "x", event: "play", origin: "desktop" }, { event: "play", origin: "web" }]) {
    res = await courseUsage(post(bad), {});
    assert.strictEqual(res.status, 400, JSON.stringify(bad));
  }
  assert.strictEqual(calls.length, 2, "rejected requests never reach the database");

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

  global.fetch = async (url) => {
    url = String(url);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "u1", email: "samhalegolf@gmail.com" }), { status: 200 });
    assert.ok(url.includes("/rest/v1/course_map_usage_summary"), url);
    return { ok: true, status: 200, text: async () => JSON.stringify([{ course_id: "royal-test-gc", origin: "ios", plays: 3 }]) };
  };
  res = await courseUsage(new Request("https://example.test/api/course-usage", { headers: { Authorization: "Bearer t" } }), {});
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual((await res.json()).rows, [{ course_id: "royal-test-gc", origin: "ios", plays: 3 }]);

  global.fetch = realFetch;
  console.log("course-usage: all checks passed");
})().catch((error) => { console.error(error); process.exit(1); });
