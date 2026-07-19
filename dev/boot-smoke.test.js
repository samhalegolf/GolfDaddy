/*
 * Boot smoke test: loads index.html in a real headless Chromium and fails on ANY
 * uncaught exception during startup. This is the test that would have caught the
 * flagTool boot crash (a deleted element killed ~6,500 lines of gd-app-core init).
 *
 * Run: npm run test:boot
 *
 * Browser resolution order:
 *   1. GD_BOOT_CHROMIUM env var (explicit executable path)
 *   2. playwright-core's downloaded chromium-headless-shell (CI/sandbox)
 *   3. Installed Google Chrome (channel: "chrome") — works on a dev Mac with Chrome
 *
 * Notes:
 *  - Network/API failures are EXPECTED (static server, no backend). They are logged
 *    but do not fail the test. Only uncaught page exceptions and missing boot
 *    canaries fail it.
 *  - Canaries assert the END of the load order ran: window.GolfDaddyPermissions is
 *    defined on the last lines of gd-app-core.js, so if any top-level crash aborts
 *    the core, this test fails even if the crash itself were somehow swallowed.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SETTLE_MS = 5000; // covers delayed installs (setTimeout 300/1200 patterns)

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
      let filePath = path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);
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
  try {
    return await playwright.chromium.launch({ headless: true });
  } catch (e) {
    // Fall back to installed Google Chrome (dev Mac)
    return playwright.chromium.launch({ channel: "chrome", headless: true });
  }
}

(async () => {
  let playwright;
  try {
    playwright = require("playwright-core");
  } catch (e) {
    console.error("boot-smoke: playwright-core is not installed. Run: npm install");
    process.exit(2);
  }

  const server = await startServer();
  const port = server.address().port;
  const pageErrors = [];
  const consoleErrors = [];

  const browser = await launchBrowser(playwright);
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (err) => pageErrors.push(String(err && err.stack || err)));
    page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });

    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(SETTLE_MS);

    const canaries = await page.evaluate(() => ({
      permissionsApi: typeof window.GolfDaddyPermissions === "object" && window.GolfDaddyPermissions !== null,
      homeTiles: document.querySelectorAll(".gdHomeTile").length,
      bodyBuilt: !!document.body && document.body.children.length > 0
    }));

    let failed = false;
    if (pageErrors.length) {
      failed = true;
      console.error(`FAIL: ${pageErrors.length} uncaught exception(s) during boot:`);
      pageErrors.forEach((e, i) => console.error(`  [${i + 1}] ${e.split("\n").slice(0, 3).join("\n      ")}`));
    }
    if (!canaries.permissionsApi) {
      failed = true;
      console.error("FAIL: window.GolfDaddyPermissions missing — gd-app-core.js did not run to completion.");
    }
    if (!canaries.homeTiles) {
      failed = true;
      console.error("FAIL: no .gdHomeTile elements — home screen did not build.");
    }
    if (consoleErrors.length) {
      console.log(`note: ${consoleErrors.length} console.error message(s) (network failures are expected on the static server; not fatal)`);
    }
    if (failed) process.exit(1);
    console.log(`boot-smoke passed: 0 uncaught exceptions, ${canaries.homeTiles} home tiles, permissions API present`);
  } finally {
    await browser.close();
    server.close();
  }
})().catch((err) => { console.error("boot-smoke harness error:", err); process.exit(2); });
