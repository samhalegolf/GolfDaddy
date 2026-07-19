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
    await page.waitForFunction(() => !!window.GolfDaddyGreenWandEngine, null, { timeout: 10000 });

    const result = await page.evaluate(async () => {
      function buildCanvas(kind) {
        const canvas = document.createElement("canvas");
        canvas.width = 240;
        canvas.height = 240;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.fillStyle = "#806f54";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (kind === "green") {
          ctx.fillStyle = "#3a9b55";
          ctx.beginPath();
          ctx.ellipse(120, 120, 56, 42, 0.15, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "#d8d0ac";
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.ellipse(120, 120, 60, 46, 0.15, 0, Math.PI * 2);
          ctx.stroke();
        } else if (kind === "tiny") {
          ctx.fillStyle = "#3a9b55";
          ctx.beginPath();
          ctx.arc(120, 120, 3, 0, Math.PI * 2);
          ctx.fill();
        } else if (kind === "oversized") {
          ctx.fillStyle = "#3a9b55";
          ctx.fillRect(5, 5, 230, 230);
        }
        return canvas;
      }
      function summarize(analysis) {
        const polygon = analysis.outerShell && analysis.outerShell.length >= 3 ? analysis.outerShell : analysis.insetGreen || [];
        const boundsOk = polygon.every((p) => p.x >= 0 && p.y >= 0 && p.x <= 240 && p.y <= 240);
        return {
          count: polygon.length,
          boundsOk,
          acceptedDots: analysis.metrics.acceptedDots,
          bestChain: analysis.metrics.bestChain,
          ridgeLineCount: analysis.metrics.ridgeLineCount,
          ridgeCoverage: analysis.metrics.ridgeCoverage,
          difference: analysis.metrics.difference,
          first: polygon[0] ? { x: Number(polygon[0].x.toFixed(3)), y: Number(polygon[0].y.toFixed(3)) } : null,
          last: polygon[polygon.length - 1] ? { x: Number(polygon[polygon.length - 1].x.toFixed(3)), y: Number(polygon[polygon.length - 1].y.toFixed(3)) } : null
        };
      }
      const engine = window.GolfDaddyGreenWandEngine;
      const preset = engine.getModeDefaults("robustTonal");
      const options = {
        seed: { x: 120, y: 120 },
        sensitivity: 68,
        baseBubbleSize: 61,
        clusterPull: 100,
        filters: preset.filters
      };
      const first = summarize(await engine.analyzeGreenWand(buildCanvas("green"), 240, 240, options));
      const second = summarize(await engine.analyzeGreenWand(buildCanvas("green"), 240, 240, options));
      const blank = summarize(await engine.analyzeGreenWand(buildCanvas("blank"), 240, 240, options));
      const tiny = summarize(await engine.analyzeGreenWand(buildCanvas("tiny"), 240, 240, options));
      const oversized = summarize(await engine.analyzeGreenWand(buildCanvas("oversized"), 240, 240, options));
      const detected = await engine.detect({
        image: buildCanvas("green"),
        width: 240,
        height: 240,
        candidateCentrePx: { x: 120, y: 120 },
        constraints: { width: 240, height: 240, minPoints: 16, minConfidence: 0.45, minAcceptedDots: 1, minBestChain: 1 }
      });
      const rejected = await engine.detect({
        image: buildCanvas("blank"),
        width: 240,
        height: 240,
        candidateCentrePx: { x: 120, y: 120 },
        constraints: { width: 240, height: 240, minPoints: 16, minConfidence: 0.99, minAcceptedDots: 60, minBestChain: 60 }
      });
      const panel = document.getElementById("gdWandPanel");
      return {
        first, second, blank, tiny, oversized, panelPresent: !!panel,
        detected: {
          ok: detected.ok,
          polygonPoints: detected.polygonPixels.length,
          confidence: Number(detected.confidence.toFixed(4)),
          reason: detected.rejectionReason,
          validationReason: detected.diagnostics.validation.reason
        },
        rejected: {
          ok: rejected.ok,
          polygonPoints: rejected.polygonPixels.length,
          confidence: Number(rejected.confidence.toFixed(4)),
          reason: rejected.rejectionReason,
          validationReason: rejected.diagnostics.validation.reason
        }
      };
    });

    assert.strictEqual(result.panelPresent, false, "engine behavior test does not require standalone Wand UI");
    assert.strictEqual(result.first.count >= 3, true, "green-like region returns a polygon");
    assert.strictEqual(result.first.boundsOk, true, "green-like polygon remains inside crop bounds");
    assert.strictEqual(result.first.acceptedDots > 0 || result.first.bestChain > 0, true, "green-like region finds an edge family");
    assert.deepStrictEqual(result.second, result.first, "repeated identical input produces equivalent output");
    assert.strictEqual(result.blank.count >= 3, true, "no-match returns the current controlled fallback shell instead of throwing");
    assert.strictEqual(result.blank.boundsOk, true, "no-match fallback shell remains inside crop bounds");
    assert.strictEqual(result.tiny.count >= 3, true, "tiny noise returns the current controlled shell instead of throwing");
    assert.strictEqual(result.tiny.boundsOk, true, "tiny-noise shell remains inside crop bounds");
    assert.strictEqual(result.oversized.boundsOk, true, "oversized fixture remains bounded by crop");
    assert.strictEqual(result.detected.ok, true, "detect accepts a green-like crop with permissive gates");
    assert.strictEqual(result.detected.polygonPoints >= 16, true, "detect returns polygon pixels for AutoMapper");
    assert.strictEqual(result.detected.validationReason, "accepted", "detect returns an acceptance diagnostic");
    assert.strictEqual(result.rejected.ok, false, "detect rejects when deterministic gates are not met");
    assert.strictEqual(result.rejected.validationReason, "low-confidence", "detect returns a controlled rejection reason");
    assert.deepStrictEqual(pageErrors, [], "green-shape behavior produced no page errors");
    console.log("green-shape-engine-behavior tests passed");
  } finally {
    await browser.close();
    server.close();
  }
})().catch((err) => { console.error(err); process.exit(1); });
