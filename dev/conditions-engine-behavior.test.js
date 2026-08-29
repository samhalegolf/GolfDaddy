/*
  Conditions Engine — real-browser load. Verifies the Course Data modules
  register in the live page, in the right order, and that a shot analysed inside
  the browser produces the same result the vm unit tests assert.

  Run: node dev/conditions-engine-behavior.test.js
*/

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.join(__dirname, "..");
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
  try {
    return await playwright.chromium.launch({ headless: true });
  } catch (e) {
    return playwright.chromium.launch({ channel: "chrome", headless: true });
  }
}

(async () => {
  const playwright = require("playwright-core");
  const server = await startServer();
  const browser = await launchBrowser(playwright);
  const pageErrors = [];

  try {
    const page = await browser.newPage();
    page.on("pageerror", (err) => pageErrors.push(String(err && err.message ? err.message : err)));

    /* ?login=1 declines the web landing redirect. scripts/inline/gd-landing-redirect-v1.js
       runs at the top of index.html and replaces it with welcome.html for a SIGNED-OUT
       visitor, decided synchronously from localStorage - and a fresh browser profile is
       always signed out, so without this the page under test is the landing page, not the
       app. ?login=1 is the redirect's own documented escape hatch (one of its SKIP_PARAMS). */
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html?login=1`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.GolfDaddyCourseDataIntake, null, { timeout: 15000 });

    const registered = await page.evaluate(() => ({
      snapshot: !!window.GolfDaddyShotSnapshot,
      tolerance: !!window.GolfDaddyConditionsToleranceProfile,
      geometry: !!window.GolfDaddyConditionsGeometry,
      engine: !!window.GolfDaddyConditionsEngine,
      intake: !!window.GolfDaddyCourseDataIntake,
      comparison: !!window.GolfDaddyCourseDataComparison,
      debug: !!window.GolfDaddyConditionsDebug,
      modules: Object.keys(window.GolfDaddy.modules || {}),
      engineVersion: window.GolfDaddyConditionsEngine.ENGINE_VERSION,
      profileVersion: window.GolfDaddyConditionsToleranceProfile.latest().version,
      // GPS Play must expose the snapshot emitter and nothing analytical.
      gpsPlayEmitter: typeof window.gdSubmitCourseDataShotSnapshot
    }));

    Object.keys(registered).forEach((key) => {
      if (typeof registered[key] === "boolean") {
        assert.strictEqual(registered[key], true, `${key} module registered in the live page`);
      }
    });
    ["shotSnapshot", "conditionsToleranceProfile", "conditionsGeometry", "conditionsEngine", "courseDataIntake", "courseDataComparison", "conditionsDebug"]
      .forEach((name) => {
        assert(registered.modules.indexOf(name) !== -1, `GolfDaddy.modules.${name} is registered`);
      });
    assert.strictEqual(registered.engineVersion, "1.0.0", "engine version is exposed");
    assert.strictEqual(registered.profileVersion, "1.1.0", "tolerance profile version is exposed");

    // Same fixture as dev/conditions-engine.test.js: a 150 m shot due north
    // from 0,0 that finished 13.1625 m west of the bubble centre in a level 3
    // wind from the east. Under profile 1.1.0 that is
    // clamp(150 * 0.045, 4, 12) = 6.75, x level 3 = 20.25, x crosswind 0.65.
    const result = await page.evaluate(() => {
      const EARTH = 111320;
      const CROSSWIND_M = 6.75 * 3 * 0.65;
      const centre = { lat: 150 / EARTH, lng: 0 };
      return window.GolfDaddyConditionsEngine.analyse({
        shotSnapshot: {
          shotId: "browser-fixture",
          capturedAt: "2026-07-20T10:00:00.000Z",
          shotStartPosition: { lat: 0, lng: 0 },
          shotLandingPosition: { lat: centre.lat, lng: centre.lng - CROSSWIND_M / EARTH },
          targetPosition: centre,
          intendedDirection: 0,
          shotDistance: 150,
          landingConfidence: "high",
          liveWindAvailable: true,
          liveWindDirection: 90,
          liveWindScaleLevel: 3,
          liveWindConfidence: "high",
          liveWindCapturedAt: "2026-07-20T10:00:00.000Z",
          userSelectedWind: false
        },
        activeMyBubble: {
          versionId: "mb_browser",
          centerLat: centre.lat,
          centerLng: centre.lng,
          orientationDeg: 0,
          widthM: 20,
          depthM: 30,
          carryM: 150
        }
      });
    });

    assert.strictEqual(result.status, "ok", "analysis completes in the browser");
    assert.strictEqual(result.selectedVariant, "windNormalised", "wind variant is selected in the browser");
    assert.strictEqual(result.normalisationApplied, true, "normalisation applied in the browser");
    assert(Math.abs(result.rawBubbleFitScore - 0.341875) < 0.001, "raw fit score matches the vm result");
    assert(Math.abs(result.selectedBubbleFitScore - 1) < 0.001, "normalised fit score matches the vm result");

    assert.strictEqual(registered.gpsPlayEmitter, "function", "GPS Play exposes the snapshot emitter");

    // End-to-end through the real page: submit a snapshot, let the deferred
    // analysis run, then confirm the comparison layer plots the normalised
    // position for the matching course record.
    const endToEnd = await page.evaluate(async () => {
      const EARTH = 111320;
      const CROSSWIND_M = 6.75 * 3 * 0.65;
      const centre = { lat: 150 / EARTH, lng: 0 };
      const shotId = "browser-e2e-" + Math.random().toString(36).slice(2);

      const submission = window.GolfDaddyCourseDataIntake.submitShotSnapshot({
        shotId: shotId,
        capturedAt: "2026-07-20T10:00:00.000Z",
        clubId: "7i",
        shotStartPosition: { lat: 0, lng: 0 },
        shotLandingPosition: { lat: centre.lat, lng: centre.lng - CROSSWIND_M / EARTH },
        targetPosition: centre,
        intendedDirection: 0,
        shotDistance: 150,
        landingConfidence: "high",
        myBubbleVersionId: "mb_browser_e2e",
        myBubbleGeometry: {
          versionId: "mb_browser_e2e",
          centerLat: centre.lat,
          centerLng: centre.lng,
          orientationDeg: 0,
          widthM: 20,
          depthM: 30,
          carryM: 150
        },
        liveWindAvailable: true,
        liveWindDirection: 90,
        liveWindScaleLevel: 3,
        liveWindConfidence: "high",
        liveWindCapturedAt: "2026-07-20T10:00:00.000Z",
        userSelectedWind: false
      });

      // The analysis is deferred; wait a tick for it to land.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const values = window.GolfDaddyCourseDataComparison.comparisonValues({
        shotId: shotId,
        club: "7i",
        expectedDistanceM: 150,
        actualDistanceM: 150,
        lateralM: -CROSSWIND_M,
        depthM: 0,
        counted: true
      });

      return {
        analysisScheduled: submission.analysisScheduled,
        analysisStatus: (window.GolfDaddyCourseDataIntake.getActiveAnalysis(shotId) || {}).status,
        normalisationApplied: values.normalisationApplied,
        normalisationType: values.normalisationType,
        lateralM: values.lateralM,
        rawLateralM: values.rawLateralM
      };
    });

    assert.strictEqual(endToEnd.analysisScheduled, true, "submission defers analysis in the browser");
    assert.strictEqual(endToEnd.analysisStatus, "ok", "the deferred analysis completes in the browser");
    assert.strictEqual(endToEnd.normalisationApplied, true, "the comparison layer uses the normalised position");
    assert.strictEqual(endToEnd.normalisationType, "windNormalised", "the normalisation type reaches the comparison");
    assert(Math.abs(endToEnd.lateralM) < 0.01, "the normalised lateral position is on the bubble centre");
    assert(Math.abs(endToEnd.rawLateralM + 6.75 * 3 * 0.65) < 0.01, "raw lateral survives the comparison");

    assert.deepStrictEqual(pageErrors, [], "conditions engine load produced no page errors");
  } finally {
    await browser.close();
    server.close();
  }

  console.log("conditions-engine-behavior tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
