/* Browser acceptance for the package/readiness boundary. */
const assert = require("assert");
const http = require("http");
const fs = require("fs");
const path = require("path");
const playwright = require("playwright-core");

const ROOT = path.join(__dirname, "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
const tee = { lat: -36.9174, lng: 174.74 };
const green = n => ({ lat: -36.919 - n / 10000, lng: 174.74 });
const complete = () => ({ courseId: "readiness", status: "lite-geo-ready", readiness: "complete", objectsVersion: "v5", mappedHoleCount: 3, expectedHoleCount: 3, missingHoles: [], holes: [1, 2, 3].map(n => ({ holeNumber: n, tee, green: green(n), route: [tee, green(n)] })) });
const partial = () => ({ courseId: "readiness", status: "lite-geo-ready", readiness: "partial", objectsVersion: "v4", mappedHoleCount: 2, expectedHoleCount: 3, missingHoles: [2], holes: [1, 3].map(n => ({ holeNumber: n, tee, green: green(n), route: [tee, green(n)] })) });

let latePackage = { status: "failed", reason: "temporary read failure" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/course-package") {
    const id = url.searchParams.get("courseId");
    const body = id === "late-course" ? latePackage : id === "repair-course" ? complete() : partial();
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); return;
  }
  if (url.pathname.startsWith("/api/")) { res.writeHead(404); res.end("{}"); return; }
  const file = path.join(ROOT, url.pathname === "/" ? "index.html" : url.pathname);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" }); res.end(data);
  });
});

(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    try { browser = await playwright.chromium.launch(); }
    catch (e) { browser = await playwright.chromium.launch({ channel: "chrome" }); }
    const context = await browser.newContext({ geolocation: { latitude: tee.lat, longitude: tee.lng }, permissions: ["geolocation"] });
    const page = await context.newPage();
    const base = "http://127.0.0.1:" + server.address().port + "/app/index.html";
    await page.goto(base + "?courseId=partial-course&courseName=Partial&courseLat=" + tee.lat + "&courseLng=" + tee.lng + "&hole=2", { waitUntil: "load" });
    await page.waitForFunction(() => window.ClarityApp && window.ClarityApp.marshal && window.ClarityApp.marshal.round().hole === 2);
    assert.strictEqual(await page.locator("#mapRecoveryScreen").isVisible(), true, "missing hole shows one stable recovery screen");
    assert.match(await page.locator("#mapRecoveryTitle").textContent(), /not mapped/i);
    await page.locator("#mapRecoveryManual").click();
    assert.strictEqual(await page.locator("#manualGpsIntro").isVisible(), true, "manual GPS is an explicit explained transition");
    await page.locator("#manualGpsBegin").click();
    await page.waitForFunction(() => window.ClarityApp.marshal.lastFix());
    await page.evaluate(point => window.ClarityApp.mapReadiness.handleTap(point), green(2));
    assert.strictEqual(await page.locator("#mapRecoveryScreen").isVisible(), false);
    assert.deepStrictEqual(await page.evaluate(() => window.ClarityApp.marshal.scene().hole.rec.green), green(2));
    await page.evaluate(() => window.ClarityApp.marshal.signal("VIEW_HOLE_CHANGED", { hole: 3 }));
    assert.strictEqual(await page.evaluate(() => window.ClarityApp.mapReadiness.controller.current().state), "PARTIAL_READY", "the next mapped hole resumes mapped play");

    latePackage = { status: "failed", reason: "temporary read failure" };
    await page.goto(base + "?courseId=late-course&courseName=Late&courseLat=" + tee.lat + "&courseLng=" + tee.lng, { waitUntil: "load" });
    await page.waitForFunction(() => window.ClarityApp && window.ClarityApp.marshal);
    assert.strictEqual(await page.locator("#mapRecoveryScreen").isVisible(), true, "a corrupt/failed package is stable and recoverable");
    latePackage = complete();
    await page.waitForFunction(() => document.getElementById("mapRecoveryScreen").classList.contains("hiddenState"), { timeout: 7000 });
    assert.strictEqual(await page.evaluate(() => window.ClarityApp.mapReadiness.controller.current().state), "READY", "a late package recovers without restart");

    await page.evaluate(pkg => window.ClarityApp.courseStore.save({ courseId: "repair-course", courseName: "Repair", mapType: "object", objectsVersion: "v4", mapVersion: null, pkg }), partial());
    await page.goto(base + "?courseId=repair-course&courseName=Repair&courseLat=" + tee.lat + "&courseLng=" + tee.lng, { waitUntil: "load" });
    await page.waitForFunction(() => !document.getElementById("mapUpdateBar").classList.contains("hiddenState"), { timeout: 5000 });
    assert.match(await page.locator("#mapUpdateLabel").textContent(), /COURSE MAP FIXED/, "partial-to-complete uses the repair banner");
    await page.locator("#mapUpdateDownload").click();
    await page.waitForFunction(() => /Ready|updated/.test(document.getElementById("mapUpdateLabel").textContent), { timeout: 3000 });
    console.log("map-readiness browser passed: partial hole, manual choice, mapped resume, corrupt package, late recovery, repair banner");
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})().catch(error => { console.error(error.stack || error); process.exit(1); });
