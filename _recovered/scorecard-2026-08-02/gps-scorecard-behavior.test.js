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
    page.on("pageerror", (err) => pageErrors.push(String(err && err.stack || err)));
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForFunction(() => !!window.GDGpsScorecard, null, { timeout: 10000 });

    const result = await page.evaluate(async () => {
      const renderEvents = [];
      document.addEventListener("gd:scorecard-render", () => renderEvents.push(Date.now()));
      document.body.dataset.gdActiveCourseName = "Scorecard Test Course";
      window.scorecard.courseKey = "scorecard-test-course";
      window.scorecard.courseName = "Scorecard Test Course";
      window.scorecard.source = "shell";
      window.scorecard.holes = Array.from({ length: 18 }, (_, i) => ({
        hole: i + 1,
        par: i === 1 ? 3 : 4,
        score: null,
        putts: null,
        tees: { White: { par: i === 1 ? 3 : 4, index: i + 1, metres: 300 + i } }
      }));
      window.GDGpsScorecard.init();
      const initialized = !!window.GDGpsScorecard.getState().scorecard.holes.length;

      window.GDGpsScorecard.setHoleScore(1, 5);
      const afterFirst = window.GDGpsScorecard.getState().scorecard.holes.filter((h) => h.score != null).length;
      window.GDGpsScorecard.setHoleScore(1, 5);
      const afterSame = window.GDGpsScorecard.getState().scorecard.holes.filter((h) => h.score != null).length;
      window.GDGpsScorecard.setHoleScore(2, 2);
      const total = window.GDGpsScorecard.calculateTotal();

      window.GDGpsScorecard.syncCurrentHole(2, { play: true });
      const currentHole = window.currentPlayingHole;
      const selected = window.GDGpsScorecard.getState().selectedHole;

      const nextCalls = [];
      window.gdSetActiveHoleFrame = (hole, opts) => nextCalls.push({ hole, source: opts && opts.source });
      window.GDGpsScorecard.queueNextHole(3);
      window.saveHoleScore();
      await new Promise((resolve) => setTimeout(resolve, 260));

      window.GDGpsScorecard.setHoleScore(4, 7);
      window.GDGpsScorecard.reset();
      const scoredAfterReset = window.GDGpsScorecard.getState().scorecard.holes.filter((h) => h.score != null).length;

      renderEvents.length = 0;
      window.GDGpsScorecard.init();
      window.GDGpsScorecard.init();
      renderEvents.length = 0;
      document.getElementById("teeSelect").value = "Blue";
      document.getElementById("teeSelect").dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      const renderEventsFromOneChange = renderEvents.length;

      const scorePanel = document.getElementById("scorePanel");
      scorePanel.remove();
      let missingUiRenderOk = true;
      try { window.GDGpsScorecard.render(); } catch (e) { missingUiRenderOk = false; }

      return {
        initialized,
        afterFirst,
        afterSame,
        total,
        currentHole,
        selected,
        nextCalls,
        scoredAfterReset,
        renderEventsFromOneChange,
        missingUiRenderOk,
        listenerBound: document.__gdGpsScorecardOwnerBound === true
      };
    });

    assert.strictEqual(result.initialized, true, "scorecard initialization does not throw and creates state");
    assert.strictEqual(result.afterFirst, 1, "setting a hole score changes one state record");
    assert.strictEqual(result.afterSame, 1, "setting the same score does not create duplicate records");
    assert.strictEqual(result.currentHole, 2, "current-hole synchronization updates the playing hole");
    assert.strictEqual(result.selected, 2, "current-hole synchronization updates selected hole");
    assert.strictEqual(result.total, 0, "total score calculation remains consistent versus par");
    assert.deepStrictEqual(result.nextCalls, [{ hole: 3, source: "score-save-next" }], "next-hole flow does not double-advance");
    assert.strictEqual(result.scoredAfterReset, 0, "reset clears scorecard state");
    assert.strictEqual(result.renderEventsFromOneChange, 1, "only one set of listeners is bound");
    assert.strictEqual(result.missingUiRenderOk, true, "missing scorecard elements do not crash render");
    assert.strictEqual(result.listenerBound, true, "scorecard owner listener guard is set");
    assert.deepStrictEqual(pageErrors, [], "scorecard behavior produced no page errors");
    console.log("gps-scorecard-behavior tests passed");
  } finally {
    await browser.close();
    server.close();
  }
})().catch((err) => { console.error(err); process.exit(1); });
