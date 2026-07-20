/* The password reset route rendered blank.
 *
 * forcePasswordResetSurface hides the shell, then calls GDShell.showAuth, then
 * adds the auth body classes and un-hides the reset overlay. That middle call was
 * written as safe(...), but safe() is not defined in gd-auth-account-shell.js, so
 * it threw a ReferenceError on every invocation:
 *
 *   [GD auth gate] ReferenceError: safe is not defined
 *     at forcePasswordResetSurface (gd-auth-account-shell.js:328)
 *
 * The throw landed after the hiding and before the revealing, so a user following
 * a reset link got a blank page. Caught only because an unrelated probe surfaced
 * the console warning.
 *
 * These assert the function cannot throw again and that the reveal still runs. */
const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const SHELL = path.join(ROOT, "scripts", "inline", "gd-auth-account-shell.js");
const src = fs.readFileSync(SHELL, "utf8");

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

/* Blank out comments while preserving line numbers, so prose mentioning safe()
   is not mistaken for a call. */
const codeOnly = src
  .replace(/\/\*[\s\S]*?\*\//g, function (m) { return m.replace(/[^\n]/g, " "); })
  .replace(/\/\/[^\n]*/g, function (m) { return m.replace(/[^\n]/g, " "); });

check("no undefined safe() helper is referenced in this file", () => {
  const bare = codeOnly.split("\n")
    .map(function (line, i) { return { line: line, n: i + 1 }; })
    .filter(function (e) { return /[^a-zA-Z_.$]safe\s*\(/.test(e.line); });
  assert.deepStrictEqual(
    bare.map(function (e) { return e.n; }), [],
    "safe() is not defined here; every call throws. Offending line(s): "
      + bare.map(function (e) { return e.n + ": " + e.line.trim().slice(0, 70); }).join(" | ")
  );
});

check("the reveal still happens after the auth-shell call", () => {
  const idx = src.indexOf("function forcePasswordResetSurface(");
  assert.notStrictEqual(idx, -1, "forcePasswordResetSurface must exist");
  const fn = src.slice(idx, src.indexOf("\n  }", idx) + 4);
  const showAuthAt = fn.indexOf("showAuth");
  const revealAt = fn.indexOf("overlay().classList.remove('hidden')");
  assert.notStrictEqual(revealAt, -1, "the overlay reveal must still be there - it is what shows the reset UI");
  assert.ok(showAuthAt !== -1 && showAuthAt < revealAt, "showAuth still precedes the reveal");
  assert.ok(
    /try \{ window\.GDShell\?\.showAuth/.test(fn),
    "the showAuth call must be guarded, or a throw skips the reveal below it again"
  );
});

(async () => {
  let playwright;
  try { playwright = require("playwright-core"); }
  catch (_e) { console.error("password-reset-surface: playwright-core is not installed."); process.exit(2); }

  const server = await startServer();
  const browser = await launchBrowser(playwright);
  try {
    const page = await (await browser.newContext()).newPage();
    const refErrors = [];
    page.on("console", function (m) { if (/ReferenceError/.test(m.text())) refErrors.push(m.text()); });
    page.on("pageerror", function (e) { if (/ReferenceError/.test(String(e))) refErrors.push(String(e)); });

    /* Load the actual reset route the emails link to. */
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html?claritySetPassword=1&clarityResetPassword=1`, {
      waitUntil: "load", timeout: 30000
    });
    await page.waitForTimeout(2500);

    check("the reset route raises no ReferenceError", () => {
      assert.deepStrictEqual(
        refErrors.slice(0, 3), [],
        "a ReferenceError on this route is what blanked the page: " + refErrors.slice(0, 2).join(" / ")
      );
    });

    const state = await page.evaluate(() => {
      const overlay = document.getElementById("gdAuthAccountOverlay")
        || document.querySelector("[id*='AuthAccount'],[class*='authAccountOverlay']");
      return {
        onResetRoute: document.body.classList.contains("gdPasswordResetRoute"),
        authLocked: document.body.classList.contains("gdAuthLocked"),
        overlayFound: !!overlay,
        overlayHidden: overlay ? overlay.classList.contains("hidden") : null
      };
    });

    check("the reset route reaches the lines after the guarded call", () => {
      assert.ok(
        state.onResetRoute || state.authLocked,
        "body should carry gdPasswordResetRoute or gdAuthLocked - both are set on the lines "
        + "that the ReferenceError used to skip"
      );
    });

    await page.close();
  } finally {
    await browser.close();
    server.close();
  }

  if (failed) { console.error("password-reset-surface failed: " + failed + " check(s)"); process.exit(1); }
  console.log("password-reset-surface passed");
})().catch((err) => {
  console.error("password-reset-surface failed:", err && err.stack || err);
  process.exit(1);
});
