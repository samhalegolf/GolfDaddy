/* Client error reporting.
 *
 * Four bugs found in one day - a CORS block that fell back to local accounts, a
 * blank screen, a swallowed ReferenceError in password reset, and a pull path
 * that was never called - all failed silently, and none would have produced a
 * support ticket. Errors were captured in memory and only transmitted if a user
 * manually asked for help.
 *
 * The reporter must never make a bad session worse, so most of these check
 * restraint rather than capability: no recursion, no flooding, no throwing, and
 * a hard ceiling on sends. */
const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const REPORTER = path.join(ROOT, "scripts", "clarity-error-reporter.js");
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2"
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split("?")[0]);
      const filePath = path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);
      if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end("not found"); return; }
        res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function launchBrowser(playwright) {
  const explicit = process.env.GD_BOOT_CHROMIUM;
  if (explicit) return playwright.chromium.launch({ executablePath: explicit, headless: true });
  try { return await playwright.chromium.launch({ headless: true }); }
  catch (_e) { return playwright.chromium.launch({ channel: "chrome", headless: true }); }
}

let failed = 0;
function check(name, fn) {
  try { fn(); console.log("  ok  " + name); }
  catch (err) { failed += 1; console.error("  FAIL " + name); console.error("       " + (err && err.message || err)); }
}

(async () => {
  let playwright;
  try { playwright = require("playwright-core"); }
  catch (_e) { console.error("error-reporting: playwright-core is not installed."); process.exit(2); }

  const server = await startServer();
  const browser = await launchBrowser(playwright);
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const posted = [];

    /* Playwright matches routes most-recently-registered first, so the catch-all
       has to be registered BEFORE the specific one or it swallows it. */
    await context.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    await context.route("**/api/client-errors", async (route) => {
      let body = null;
      try { body = JSON.parse(route.request().postData() || "{}"); } catch (_e) {}
      posted.push(body);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ accepted: 1 }) });
    });

    await page.goto(`${base}/index.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(1800);

    const present = await page.evaluate(() => ({
      exists: !!window.ClarityErrorReporter,
      state: window.ClarityErrorReporter ? window.ClarityErrorReporter.__state() : null
    }));

    check("the reporter installs", () => {
      assert.strictEqual(present.exists, true, "ClarityErrorReporter must exist");
      assert.ok(present.state && present.state.maxSends > 0, "a send ceiling must be configured");
    });

    /* Repeats of one bug must collapse. The password reset bug fired on every
       auth gate pass; one row per occurrence would say nothing a count does not. */
    const deduped = await page.evaluate(async () => {
      for (let i = 0; i < 25; i += 1) window.ClarityErrorReporter.report("Repeated failure " + 1, "same detail");
      const pendingBefore = window.ClarityErrorReporter.pending();
      window.ClarityErrorReporter.flush();
      await new Promise((r) => setTimeout(r, 300));
      return { pendingBefore };
    });

    check("25 identical errors collapse to one queued event", () => {
      assert.strictEqual(
        deduped.pendingBefore, 1,
        "identical errors must dedupe before sending, not produce 25 queue entries"
      );
    });

    check("the batch carries a count rather than duplicates", () => {
      const batch = posted.find((b) => b && Array.isArray(b.events) && b.events.length);
      assert.ok(batch, "a batch should have been posted");
      assert.strictEqual(batch.events.length, 1, "one distinct error, one event");
      assert.strictEqual(batch.events[0].count, 25, "the repeat count must survive dedupe");
    });

    check("context is attached so a report is actionable", () => {
      const batch = posted.find((b) => b && Array.isArray(b.events) && b.events.length);
      assert.ok("platform" in batch, "platform distinguishes native from web");
      assert.ok("appVersion" in batch, "version distinguishes an old build from a live bug");
      assert.ok("route" in batch.events[0], "route says where it happened - the URL does not, this app is DOM routed");
    });

    /* An uncaught error must be captured without the page having to cooperate. */
    const captured = await page.evaluate(async () => {
      window.dispatchEvent(new ErrorEvent("error", { message: "Boom from nowhere", filename: "x.js", lineno: 42 }));
      await new Promise((r) => setTimeout(r, 50));
      const pending = window.ClarityErrorReporter.pending();
      window.ClarityErrorReporter.flush();
      await new Promise((r) => setTimeout(r, 300));
      return pending;
    });

    check("an uncaught window error is captured", () => {
      assert.ok(captured >= 1, "window.error must be queued");
      const batch = posted.filter((b) => b && b.events && b.events.some((e) => /Boom from nowhere/.test(e.message)));
      assert.ok(batch.length, "the uncaught error must reach the endpoint");
    });

    /* console.error is the swallowed-failure channel: today's password reset bug
       only ever surfaced there. */
    const consoleCaptured = await page.evaluate(async () => {
      console.error("ReferenceError: safe is not defined");
      await new Promise((r) => setTimeout(r, 50));
      const pending = window.ClarityErrorReporter.pending();
      window.ClarityErrorReporter.flush();
      await new Promise((r) => setTimeout(r, 300));
      return pending;
    });

    check("a swallowed error logged to console.error is captured", () => {
      assert.ok(consoleCaptured >= 1, "console.error must be queued");
      const batch = posted.filter((b) => b && b.events && b.events.some((e) => /safe is not defined/.test(e.message)));
      assert.ok(batch.length, "the swallowed failure must reach the endpoint");
      const event = batch[0].events.find((e) => /safe is not defined/.test(e.message));
      assert.strictEqual(event.level, "warn", "console.error is noisier, so it is levelled for filtering");
    });

    /* The reporter must not become the problem. */
    const ceiling = await page.evaluate(async () => {
      const before = window.ClarityErrorReporter.__state().sends;
      for (let i = 0; i < 60; i += 1) {
        window.ClarityErrorReporter.report("Distinct failure " + i, "");
        window.ClarityErrorReporter.flush();
      }
      await new Promise((r) => setTimeout(r, 200));
      const state = window.ClarityErrorReporter.__state();
      return { before, sends: state.sends, max: state.maxSends };
    });

    check("a runaway error loop cannot flood the backend", () => {
      assert.ok(
        ceiling.sends <= ceiling.max,
        "sends (" + ceiling.sends + ") must not exceed the per-session ceiling (" + ceiling.max + ")"
      );
    });

    const survived = await page.evaluate(() => {
      let threw = false;
      try { window.ClarityErrorReporter.report(null, undefined); } catch (_e) { threw = true; }
      try { window.ClarityErrorReporter.report({ weird: true }, { alsoWeird: true }); } catch (_e) { threw = true; }
      return { threw, stillAlive: !!window.ClarityErrorReporter };
    });

    check("reporting never throws, whatever it is handed", () => {
      assert.strictEqual(survived.threw, false, "a reporter that throws makes a bad session worse");
      assert.strictEqual(survived.stillAlive, true);
    });

    await page.close();
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }

  /* Static guarantees worth pinning. */
  const src = fs.readFileSync(REPORTER, "utf8");
  check("the reporter guards against reporting its own failures", () => {
    assert.ok(/reporting\s*=\s*true/.test(src) && /if \(reporting\) return;/.test(src),
      "without a recursion guard a failing report becomes an error it tries to report");
  });

  check("a failed send is swallowed rather than surfaced", () => {
    assert.ok(/\.catch\(function \(\) \{\}\)/.test(src), "a reporting failure must not become a visible error");
  });

  check("the send uses keepalive so a closing page still reports", () => {
    assert.ok(/keepalive: true/.test(src), "the last errors of a session are often the interesting ones");
  });

  if (failed) { console.error("error-reporting failed: " + failed + " check(s)"); process.exit(1); }
  console.log("error-reporting passed");
})().catch((err) => {
  console.error("error-reporting failed:", err && err.stack || err);
  process.exit(1);
});
