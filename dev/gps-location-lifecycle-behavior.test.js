const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

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
  } catch (_e) {
    return playwright.chromium.launch({ channel: "chrome", headless: true });
  }
}

(async () => {
  let playwright;
  try {
    playwright = require("playwright-core");
  } catch (_e) {
    console.error("gps-location-lifecycle-behavior: playwright-core is not installed. Run: npm install");
    process.exit(2);
  }

  const server = await startServer();
  const browser = await launchBrowser(playwright);
  const pageErrors = [];
  try {
    const page = await (await browser.newContext()).newPage();
    page.on("pageerror", (err) => pageErrors.push(String(err && err.stack || err)));
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(1500);
    assert.deepStrictEqual(pageErrors, [], "GPS lifecycle page boot should not throw");

    const result = await page.evaluate(async () => {
      const calls = { get: 0, watch: 0, clear: [] };
      const pos = { coords: { latitude: -36.9175, longitude: 174.7401, accuracy: 8 } };
      Object.defineProperty(navigator, "geolocation", {
        configurable: true,
        value: {
          getCurrentPosition(success) {
            calls.get += 1;
            setTimeout(() => success(pos), 0);
            return 501;
          },
          watchPosition(success) {
            calls.watch += 1;
            setTimeout(() => success(pos), 0);
            return 1000 + calls.watch;
          },
          clearWatch(id) {
            calls.clear.push(id);
          }
        }
      });

      const api = window.GDGpsLocationLifecycle;
      const firstWatch = api.startWatch();
      const secondWatch = api.startWatch();
      await new Promise((resolve) => setTimeout(resolve, 25));
      const watchCallsBeforeStop = calls.watch;
      api.stopWatch("test-exit");
      const refreshStarted = api.refresh();
      await new Promise((resolve) => setTimeout(resolve, 25));
      api.rememberLive({ lat: -36.918, lng: 174.741 }, 5, "gps-test");
      return {
        apiPresent: !!api,
        manualModeAvailable: typeof window.gdEnterTwoTapNoLocation === "function",
        firstWatch,
        secondWatch,
        watchCallsBeforeStop,
        watchCalls: calls.watch,
        clearCalls: calls.clear,
        getCalls: calls.get,
        refreshStarted,
        lastFix: window.gdGpsState && window.gdGpsState.lastFix,
        liveMarker: !!window.__gdLiveGpsMarker,
        bodyLat: document.body.dataset.gdLiveGpsLat,
        stopReason: window.gdGpsState && window.gdGpsState.watchStopReason
      };
    });

    assert.strictEqual(result.apiPresent, true, "GPS lifecycle API is present");
    assert.strictEqual(result.manualModeAvailable, true, "manual GPS mode remains available");
    assert.strictEqual(result.firstWatch, 1001, "first watch returns the geolocation watch id");
    assert.strictEqual(result.secondWatch, null, "second watch is blocked while one is active");
    assert.strictEqual(result.watchCallsBeforeStop, 1, "only one geolocation watch is active");
    assert.deepStrictEqual(result.clearCalls, [1001], "stopWatch clears the active watch id");
    assert.strictEqual(result.refreshStarted, true, "refresh starts one current-position request");
    assert.strictEqual(result.getCalls, 1, "refresh sends one getCurrentPosition request");
    assert.strictEqual(result.watchCalls, 2, "refresh starts a new watch after the old one is stopped");
    assert.strictEqual(result.lastFix.source, "gps-test", "live marker updates route through the lifecycle owner");
    assert.strictEqual(result.lastFix.simulated, false, "live GPS observations are not marked simulated");
    assert.strictEqual(result.liveMarker, true, "player live marker is created by the owner");
    assert.strictEqual(result.bodyLat, "-36.918", "body live GPS dataset is updated");
    assert.strictEqual(result.stopReason, "test-exit", "exit/destroy reason is recorded on stop");
    console.log("gps-location-lifecycle-behavior tests passed");
  } finally {
    await browser.close();
    server.close();
  }
})().catch((err) => {
  console.error("gps-location-lifecycle-behavior failed:", err);
  process.exit(1);
});
