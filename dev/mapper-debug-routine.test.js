/* A mapping job that fails for good is handed to Claude.
 *
 * functions/alert-utils.js fireClaudeRoutine POSTs the failure to a Claude Code
 * Routine's API trigger, which starts a pre-scoped cloud session. The worker calls
 * it from both terminal paths (a non-transient error, and a job reaped eight times)
 * and records the outcome on the job row as result.debugSession, so the failed row
 * links to the session that looked at it - or says why none did.
 *
 * What is asserted: the feature is a no-op until both env vars exist; the fire
 * URL is only ever the Anthropic endpoint; a terminal failure fires once and
 * stores the session link; a transient failure is requeued and fires nothing. */

const assert = require("assert");
const path = require("path");

const root = path.join(__dirname, "..");
const ALERTS = path.join(root, "functions", "alert-utils.js");
const realFetch = global.fetch;
const realEnv = Object.assign({}, process.env);

const FIRE_URL = "https://api.anthropic.com/v1/claude_code/routines/trig_01TESTROUTINE/fire";
const SESSION_URL = "https://claude.ai/code/session_01TESTSESSION";

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

let worker = null;

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
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

/* Every fetch the code under test makes, plus a Supabase stub with one queued job for a
   course that course_maps has never heard of - the simplest terminal mapper failure. */
function stubWorld(options = {}) {
  const calls = { fires: [], patches: [], emails: 0, served: false };
  const job = { id: "job-dead", course_id: "nowhere", kind: "automap", status: "queued", result: null };
  global.fetch = async (url, init = {}) => {
    url = String(url);
    const method = String(init.method || "GET").toUpperCase();
    if (url.startsWith("https://api.anthropic.com/")) {
      calls.fires.push({ url, headers: init.headers || {}, body: JSON.parse(init.body || "{}") });
      return jsonResponse(200, { type: "routine_fire", claude_code_session_id: "session_01TESTSESSION", claude_code_session_url: SESSION_URL });
    }
    if (url.startsWith("https://api.resend.com/")) { calls.emails += 1; return jsonResponse(200, { id: "email-1" }); }
    if (url.includes("overpass")) {
      if (options.overpassStatus) { const e = new Error("Overpass " + options.overpassStatus); e.status = options.overpassStatus; throw e; }
      return jsonResponse(200, { elements: [] });
    }
    const rest = url.split("/rest/v1/")[1] || "";
    /* Served once: a requeued job must not be claimed again in the same test, or the
       worker loop would run it forever. The sweeper supplies that spacing in production. */
    if (method === "GET" && rest.startsWith("course_mapper_jobs") && rest.includes("status=eq.queued")) {
      if (calls.served) return jsonResponse(200, []);
      calls.served = true;
      return jsonResponse(200, [job]);
    }
    if (method === "GET" && rest.startsWith("course_maps")) {
      return jsonResponse(200, options.courseRow ? [options.courseRow] : []);
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

test("fireClaudeRoutine is a no-op until the routine URL and token are configured", async () => {
  routineEnv(false);
  const calls = stubWorld();
  const { fireClaudeRoutine } = require(ALERTS);
  const outcome = await fireClaudeRoutine({ key: "t", text: "hello" });
  assert.strictEqual(outcome.fired, false);
  assert.strictEqual(outcome.reason, "missing_routine_url");
  assert.strictEqual(calls.fires.length, 0, "nothing is fetched without configuration");
});

test("fireClaudeRoutine refuses a fire URL that is not the Anthropic routines endpoint", async () => {
  routineEnv(true);
  process.env.CLAUDE_MAPPER_ROUTINE_URL = "https://example.com/v1/claude_code/routines/trig_x/fire";
  const calls = stubWorld();
  const { fireClaudeRoutine } = require(ALERTS);
  const outcome = await fireClaudeRoutine({ key: "t", text: "hello" });
  assert.strictEqual(outcome.fired, false);
  assert.strictEqual(outcome.reason, "missing_routine_url");
  assert.strictEqual(calls.fires.length, 0, "the token is never sent anywhere else");
});

test("fireClaudeRoutine posts the text with the bearer token and returns the session link", async () => {
  routineEnv(true);
  const calls = stubWorld();
  const { fireClaudeRoutine } = require(ALERTS);
  const outcome = await fireClaudeRoutine({ key: "t-" + Date.now(), text: "job failed" });
  assert.strictEqual(outcome.fired, true);
  assert.strictEqual(outcome.sessionUrl, SESSION_URL);
  assert.strictEqual(calls.fires.length, 1);
  assert.strictEqual(calls.fires[0].url, FIRE_URL);
  assert.strictEqual(calls.fires[0].headers.Authorization, "Bearer sk-ant-oat01-stub");
  assert.ok(calls.fires[0].headers["anthropic-beta"], "the routines beta header is sent");
  assert.strictEqual(calls.fires[0].body.text, "job failed");
});

test("a terminal mapper failure fires the routine once and stores the session on the job row", async () => {
  routineEnv(true);
  process.env.CLARITY_ALERT_EMAIL = "sam@example.com";
  process.env.RESEND_API_KEY = "re_stub";
  const calls = stubWorld();
  await worker.run(new Request("https://clarity.test/.netlify/functions/course-mapper-worker-background", { method: "POST", body: "{}" }));
  const failed = calls.patches.find(p => p.status === "failed");
  assert.ok(failed, "the job ends failed");
  assert.match(failed.error, /no known location/);
  assert.strictEqual(calls.fires.length, 1, "exactly one routine fire");
  assert.match(calls.fires[0].body.text, /job_id: job-dead/);
  assert.match(calls.fires[0].body.text, /course_id: nowhere/);
  assert.match(calls.fires[0].body.text, /no known location/);
  assert.deepStrictEqual(
    { fired: failed.result.debugSession.fired, url: failed.result.debugSession.sessionUrl },
    { fired: true, url: SESSION_URL },
    "the failed row links to the session that took it"
  );
  assert.strictEqual(calls.emails, 1, "one heads-up email with the session link");
});

test("a transient mapper failure is requeued and fires nothing", async () => {
  routineEnv(true);
  const calls = stubWorld({
    overpassStatus: 504,
    courseRow: { course_id: "nowhere", course_name: "Somewhere", course_lat: -36.8, course_lng: 174.7, region: "Auckland", country: "New Zealand", country_code: "nz", objects_json: {}, holes_json: {} }
  });
  await worker.run(new Request("https://clarity.test/.netlify/functions/course-mapper-worker-background", { method: "POST", body: "{}" }));
  const last = calls.patches[calls.patches.length - 1];
  assert.strictEqual(last.status, "queued", "a 504 is retried, not handed off");
  assert.strictEqual(calls.fires.length, 0, "no session for an Overpass blip");
});

test("the worker records why no session was started when the feature is off", async () => {
  routineEnv(false);
  const calls = stubWorld();
  await worker.run(new Request("https://clarity.test/.netlify/functions/course-mapper-worker-background", { method: "POST", body: "{}" }));
  const failed = calls.patches.find(p => p.status === "failed");
  assert.ok(failed);
  assert.deepStrictEqual(failed.result.debugSession, { fired: false, reason: "missing_routine_url" });
  assert.strictEqual(calls.fires.length, 0);
});

(async function run() {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-stub";
  const mod = await import(path.join(root, "functions", "course-mapper-worker-background.mjs"));
  worker = Object.assign({ run: mod.default }, mod.__courseMapperWorkerTest);
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
  global.fetch = realFetch;
  process.env = realEnv;
  if (failures) {
    console.error("mapper-debug-routine FAILED: " + failures + " of " + tests.length);
    process.exit(1);
  }
  console.log("mapper-debug-routine passed: " + tests.length + " checks");
})();
