/* GPS Play continuity regression.
   fresh-app-boot.test.js proves the app BOOTS. This proves the round HOLDS
   TOGETHER: it serves the real tree, stubs /api, grants a geolocation, and then
   walks a scripted round through the three sequences that broke on course on
   2026-08-08 (see GPS_PLAY_OWNERSHIP_2026-08-08.md).

   Every check here fails on the code as it was that day, so this is a
   regression test rather than a description of the current behaviour:
     1. A hand-off with no courseLat/courseLng must still trust GPS.
        Number(null) is 0, so the round used to start with a centre at
        (0, 0) and reject every fix for the whole round.
     2. "Head To the Tee" must let go once the player has plainly walked off.
        It used to hold for the whole hole, so the dot never moved and green
        focus could never open.
     3. "Unlock Shot" must stop drawing the aim cluster. The shot stays in
        flight for Course Data, but the next GPS fix used to redraw the whole
        bubble from the OLD start against the OLD target.

   Run: node dev/gps-play-continuity.test.js
   GD_BOOT_CHROMIUM=/path/to/chromium overrides the browser, same as
   fresh-app-boot.test.js. */
const http = require("http");
const fs = require("fs");
const path = require("path");
const playwright = require("playwright");

async function launchBrowser() {
  if (process.env.GD_BOOT_CHROMIUM) {
    return playwright.chromium.launch({ executablePath: process.env.GD_BOOT_CHROMIUM });
  }
  try { return await playwright.chromium.launch(); }
  catch (e) { return playwright.chromium.launch({ channel: "chrome" }); }
}

const ROOT = path.join(__dirname, "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };

/* Akarana-ish. Hole 1 tee → green is 300m, holes spread over ~600m so the
   derived centroid sits well inside the 800m trust radius of both. */
const TEE = { lat: -36.9174, lng: 174.7400 };
const GREEN = { lat: -36.9201, lng: 174.7400 };   // ~300m south of the tee

function offsetM(base, northM, eastM) {
  return { lat: base.lat + northM / 111320,
    lng: base.lng + eastM / (111320 * Math.cos(base.lat * Math.PI / 180)) };
}

const PKG = {
  status: "lite-geo-ready",
  geometryVersion: "v1",
  packageVersion: 1,
  holes: [
    { holeNumber: 1, tee: TEE, green: GREEN, greenShape: [], route: [] },
    { holeNumber: 2, tee: offsetM(TEE, -320, 80), green: offsetM(TEE, -600, 80), greenShape: [], route: [] }
  ]
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  if (p.startsWith("/api/course-package")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(PKG));
  }
  if (p.startsWith("/api/client-errors")) { res.writeHead(200); return res.end("{}"); }
  if (p.startsWith("/api/")) { res.writeHead(404); return res.end("{}"); }
  const file = path.join(ROOT, decodeURIComponent(p));
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(body);
  });
});

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "  — " + detail : ""));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const browser = await launchBrowser();
  const context = await browser.newContext({
    geolocation: { latitude: TEE.lat, longitude: TEE.lng },
    permissions: ["geolocation"]
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  /* NO courseLat/courseLng on the hand-off — the case that silently killed GPS
     for the whole round before packageCentre existed. */
  await page.goto(`http://127.0.0.1:${port}/app/index.html?courseId=verify-course&courseName=Verify`,
    { waitUntil: "load" });
  await page.waitForFunction(() => window.ClarityApp && window.ClarityApp.booted, null, { timeout: 15000 });
  await page.waitForFunction(() => window.ClarityApp.play.state().hole === 1, null, { timeout: 15000 });

  const pos = () => page.evaluate(() => window.ClarityApp.position.current());
  const setFix = async (pt) => {
    await context.setGeolocation({ latitude: pt.lat, longitude: pt.lng });
    await wait(450);
  };

  /* ---- 1. The course centre, derived from the package ----
     current.centre is private, so this is proved through the behaviour that
     depends on it: a fix is only adopted once the centre says the player is
     at the golf course. */
  await setFix(offsetM(TEE, -10, 5));
  let p = await pos();
  check("GPS adopted with no courseLat/courseLng on the URL (derived centre)",
    !!p && p.source === "gps", p ? `source=${p.source}` : "no position");

  // ---- 2. The tee pin releases itself once you walk off ----
  /* A live fix retires the start pill, so get back to pre-frame the way a
     player does: lock in, then Unlock Shot. */
  await page.click("#shotActionBtn");           // Lock in here
  await wait(200);
  await page.click("#shotActionBtn");           // Unlock Shot → pill returns
  await wait(200);
  check("Unlock brings the start pill back", await page.isVisible("#startPill"));
  await page.click("#headToTeeBtn");
  p = await pos();
  check("Head To the Tee pins the player to the tee", !!p && p.source === "tee",
    p ? `source=${p.source}` : "no position");

  await setFix(offsetM(TEE, -12, 0));          // still on the tee (12m)
  p = await pos();
  check("A fix ON the tee does not break the pin", p.source === "tee", `source=${p.source}`);

  await setFix(offsetM(TEE, -60, 0));          // walked off — fix 1 of 2
  p = await pos();
  check("One fix clear of the tee is not enough to release it", p.source === "tee",
    `source=${p.source}`);

  await setFix(offsetM(TEE, -90, 0));          // fix 2 of 2 → release
  p = await pos();
  check("Two consecutive fixes clear of the tee release the pin", p.source === "gps",
    `source=${p.source}`);

  await setFix(offsetM(TEE, -140, 0));
  p = await pos();
  const walked = Math.abs(p.lat - TEE.lat) * 111320;
  check("The dot keeps following the player down the hole", p.source === "gps" && walked > 120,
    `${Math.round(walked)}m from the tee`);

  // ---- 3. No stale bubble after Unlock ----
  /* Placing the player IS the lock-in, so Head To the Tee above already put a
     shot in flight and the dock is showing Unlock Shot. */
  let face = await page.getAttribute("#shotActionBtn", "data-action");
  check("A placed player leaves the dock on the Unlock face", face === "unlock", `face=${face}`);
  const bubbleShownAfterLock = await page.evaluate(() =>
    !document.getElementById("aimBubble").classList.contains("hiddenState"));
  check("A locked-in shot draws the aim bubble", bubbleShownAfterLock);

  await page.click("#shotActionBtn");           // Unlock Shot
  await wait(250);
  await setFix(offsetM(TEE, -180, 12));         // the fix that used to resurrect it
  await setFix(offsetM(TEE, -200, 12));
  const after = await page.evaluate(() => ({
    bubble: !document.getElementById("aimBubble").classList.contains("hiddenState"),
    svg: !document.getElementById("bubbleSvg").classList.contains("hiddenState"),
    svgHtml: document.getElementById("bubbleSvg").innerHTML.length,
    shotStillInFlight: !!window.ClarityApp.shot.active(),
    face: document.getElementById("shotActionBtn").dataset.action
  }));
  check("No bubble after Unlock, even once GPS fixes resume",
    !after.bubble && !after.svg && after.svgHtml === 0,
    `bubble=${after.bubble} svg=${after.svg} paths=${after.svgHtml}`);
  check("Unlock still leaves the shot in flight for Course Data",
    after.shotStillInFlight === true);
  check("Unlock returns the dock button to the Lock face", after.face === "lock",
    `face=${after.face}`);

  // ---- green focus opens on arrival, now that position keeps flowing ----
  await setFix(offsetM(GREEN, 25, 0));          // 25m short of the green
  await wait(300);
  const gf = await page.evaluate(() => ({
    cls: document.body.classList.contains("green-focus"),
    stage: document.body.dataset.frameStage,
    face: document.getElementById("shotActionBtn").dataset.action,
    ball: !document.getElementById("greenFocusBall").classList.contains("hiddenState")
  }));
  check("Walking to the green opens green focus", gf.cls && gf.stage === "zoom",
    `green-focus=${gf.cls} stage=${gf.stage}`);
  check("Green focus shows the ball and the Shot End face",
    gf.ball && gf.face === "end", `ball=${gf.ball} face=${gf.face}`);

  check("No uncaught exceptions during the whole sequence", errors.length === 0,
    errors.slice(0, 3).join(" | "));

  await browser.close();
  server.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
