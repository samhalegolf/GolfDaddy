/*
 * The Studio pass that lets Clarity Studio open Clarity Booking's website builder.
 *
 * functions/studio-site-pass.mjs signs it; Booking's netlify/functions/_shared/site/house.mts
 * checks it. The two repositories share no code, so both test this same fixed vector
 * (STUDIO_PASS_TEST_VECTOR in Booking's house.test.mts): a change to the format on one side
 * fails a test until the other side matches.
 *
 * Run: node dev/studio-site-pass.test.js
 */
const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

const VECTOR = {
  secret: "test-secret",
  email: "admin@example.com",
  exp: 2000000000,
  pass: "v1.eyJhdWQiOiJjbGFyaXR5LXN0dWRpby1zaXRlcyIsInN1YiI6ImFkbWluQGV4YW1wbGUuY29tIiwiZXhwIjoyMDAwMDAwMDAwfQ.mHtdfdlNr7ISNtYFFuPc2UpsNjq170y-t4Snku17kXA"
};

(async function () {
  const mod = await import(pathToFileURL(path.join(__dirname, "..", "functions", "studio-site-pass.mjs")).href);
  let failed = 0;
  async function test(name, fn) {
    try { await fn(); console.log("ok - " + name); } catch (error) { failed += 1; console.error("not ok - " + name + "\n  " + (error && error.stack || error)); }
  }

  await test("signs exactly the pass Booking expects", () => {
    assert.strictEqual(mod.signStudioPass(VECTOR.secret, VECTOR.email, VECTOR.exp), VECTOR.pass);
  });

  await test("the pass names its audience, its admin and its expiry", () => {
    const payload = JSON.parse(Buffer.from(VECTOR.pass.split(".")[1], "base64url").toString("utf8"));
    assert.deepStrictEqual(payload, { aud: mod.STUDIO_PASS_AUDIENCE, sub: VECTOR.email, exp: VECTOR.exp });
    assert.strictEqual(mod.STUDIO_PASS_AUDIENCE, "clarity-studio-sites");
  });

  await test("Booking's address defaults to claritygolf.app and drops a trailing slash", () => {
    const saved = process.env.CLARITY_BOOKING_URL;
    delete process.env.CLARITY_BOOKING_URL;
    assert.strictEqual(mod.bookingUrl(), "https://claritygolf.app");
    process.env.CLARITY_BOOKING_URL = "https://booking.example.com/";
    assert.strictEqual(mod.bookingUrl(), "https://booking.example.com");
    if (saved === undefined) delete process.env.CLARITY_BOOKING_URL; else process.env.CLARITY_BOOKING_URL = saved;
  });

  await test("only a POST from a signed-in admin gets a pass", async () => {
    const savedSecret = process.env.CLARITY_SERVICE_SECRET;
    process.env.CLARITY_SERVICE_SECRET = VECTOR.secret;
    const get = await mod.default(new Request("https://caddy.example/api/studio-site-pass"));
    assert.strictEqual(get.status, 405);
    const anonymous = await mod.default(new Request("https://caddy.example/api/studio-site-pass", { method: "POST" }));
    assert.strictEqual(anonymous.status, 403);
    delete process.env.CLARITY_SERVICE_SECRET;
    const unconfigured = await mod.default(new Request("https://caddy.example/api/studio-site-pass", { method: "POST" }));
    assert.strictEqual(unconfigured.status, 503);
    if (savedSecret !== undefined) process.env.CLARITY_SERVICE_SECRET = savedSecret;
  });

  if (failed) { console.error(failed + " failed"); process.exit(1); }
})();
