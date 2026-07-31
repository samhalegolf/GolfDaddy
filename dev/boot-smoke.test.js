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
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const SETTLE_MS = 5000; // covers delayed installs (setTimeout 300/1200 patterns)

/* Three surfaces boot, not one. The deploy build emits an app index (studio
   panels stripped) and a studio index (everything, under /studio/ with a <base>
   tag), so "the page boots" is only true if it is true for BOTH outputs - and a
   stripped element that some kept code dereferences without a guard would only
   ever crash the app build, which is the one that ships to phones. The source
   tree boots too, because that is what `npm start` serves while developing. */
const SURFACES = [
  { name: "source", root: ROOT, page: "/index.html", studioPanels: true },
  { name: "app (dist)", root: DIST, page: "/index.html", studioPanels: false },
  { name: "studio (dist)", root: DIST, page: "/studio/index.html", studioPanels: true }
];

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2"
};

function startServer(serveRoot) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split("?")[0]);
      let filePath = path.join(serveRoot, urlPath === "/" ? "index.html" : urlPath);
      if (!filePath.startsWith(serveRoot)) { res.writeHead(403); res.end(); return; }
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

async function bootSurface(browser, surface) {
  const server = await startServer(surface.root);
  const port = server.address().port;
  const pageErrors = [];
  const consoleErrors = [];
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (err) => pageErrors.push(String(err && err.stack || err)));
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });

  try {
    await page.goto(`http://127.0.0.1:${port}${surface.page}`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(SETTLE_MS);

    const canaries = await page.evaluate(() => ({
      permissionsApi: typeof window.GolfDaddyPermissions === "object" && window.GolfDaddyPermissions !== null,
      homeTiles: document.querySelectorAll(".gdHomeTile").length,
      bodyBuilt: !!document.body && document.body.children.length > 0,
      /* The strip is only real if the admin surface is genuinely absent from the
         app build - present-but-hidden would still be parsed and shipped. */
      developerPanel: !!document.getElementById("developerPanel"),
      mappingDebug: !!window.GDCourseMappingDebug,
      adminCourseDb: typeof window.gdRenderAdminCourseDatabase === "function",
      /* A stray route="admin" must be a no-op on a phone, not an uncaught
         ReferenceError for renderers that only exist in the studio build. */
      openAdminThrew: (() => {
        try { window.openDeveloperPanel && window.openDeveloperPanel(); return false; }
        catch (error) { return String(error); }
      })()
    }));

    let failed = false;
    const fail = (message) => { failed = true; console.error(`FAIL [${surface.name}]: ${message}`); };
    if (pageErrors.length) {
      fail(`${pageErrors.length} uncaught exception(s) during boot:`);
      pageErrors.forEach((e, i) => console.error(`  [${i + 1}] ${e.split("\n").slice(0, 3).join("\n      ")}`));
    }
    if (!canaries.permissionsApi) fail("window.GolfDaddyPermissions missing — gd-app-core.js did not run to completion.");
    if (!canaries.homeTiles) fail("no .gdHomeTile elements — home screen did not build.");
    if (surface.studioPanels && !canaries.developerPanel) fail("#developerPanel missing — the studio surface must keep the admin panels.");
    if (surface.studioPanels && !canaries.adminCourseDb) fail("gdRenderAdminCourseDatabase missing — the studio surface must keep the Course Database.");
    if (!surface.studioPanels && canaries.developerPanel) fail("#developerPanel present — the app surface must not ship the admin panel.");
    if (!surface.studioPanels && canaries.mappingDebug) fail("GDCourseMappingDebug loaded — the app surface must not ship the mapping debug module.");
    if (!surface.studioPanels && canaries.adminCourseDb) fail("gdRenderAdminCourseDatabase defined — the app surface must not ship the admin Course Database.");
    if (canaries.openAdminThrew) fail("openDeveloperPanel() threw: " + canaries.openAdminThrew);
    if (consoleErrors.length) {
      console.log(`note [${surface.name}]: ${consoleErrors.length} console.error message(s) (network failures are expected on the static server; not fatal)`);
    }
    if (!failed) console.log(`boot-smoke passed [${surface.name}]: 0 uncaught exceptions, ${canaries.homeTiles} home tiles, permissions API present`);
    return !failed;
  } finally {
    await context.close();
    server.close();
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

  /* dist is built here rather than assumed: a stale dist would test the previous
     split and pass while the current one is broken. */
  execFileSync("node", ["scripts/clarity-deploy-build.js"], { cwd: ROOT, stdio: "pipe" });

  const browser = await launchBrowser(playwright);
  let ok = true;
  try {
    for (const surface of SURFACES) {
      ok = await bootSurface(browser, surface) && ok;
    }
  } finally {
    await browser.close();
  }
  if (!ok) process.exit(1);
})().catch((err) => { console.error("boot-smoke harness error:", err); process.exit(2); });
