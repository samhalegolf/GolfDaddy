/*
 * Clarity 3D Mesh in the real app (headless Chromium).
 *
 * The page is the shipped /app/index.html. /api/live-terrain-frame is the real handler
 * (functions/live-terrain-frame.mjs) with only the outbound tile fetch faked and the admin check
 * stubbed - so the window maths, the DEM resample, the headers and the client's alignment check
 * all run for real.
 *
 * Pinned here:
 *   - admin + "mesh" + relief on: an unpublished hole comes up as a published-style surface with
 *     the terrain mesh on it, from exactly one aerial and one elevation request;
 *   - GPS fixes, Play and a relief change between heights rebuild nothing;
 *   - relief off goes back to the live map and lets the frame go (object URLs revoked); on again
 *     builds it again, from the device's cache;
 *   - a new hole builds a new frame and releases the old one;
 *   - leaving the map source goes back to the live map;
 *   - an elevation failure leaves the live map up with the reason on the readout;
 *   - a non-admin never asks for anything;
 *   - published holes one after another each get their mesh (the disposed canvas regression).
 *
 * Run: node dev/live-terrain-mesh.test.mjs   (GD_BOOT_CHROMIUM=<chrome> to pick a browser)
 */
import assert from "node:assert";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import sharp from "sharp";
import { createHandler } from "../functions/live-terrain-frame.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const HOLE_1 = {
  holeNumber: 1,
  tee: { lat: -36.9133686, lng: 174.7409167 },
  green: { lat: -36.91669425625, lng: 174.7393568875 },
  greenShape: [], route: []
};
const HOLE_2 = {
  holeNumber: 2,
  tee: { lat: -36.9172, lng: 174.7398 },
  green: { lat: -36.9188, lng: 174.7432 },
  greenShape: [], route: []
};
/* Never visited before the failure case, so nothing of it is in the device's cache. */
const HOLE_3 = {
  holeNumber: 3,
  tee: { lat: -36.9195, lng: 174.7440 },
  green: { lat: -36.9210, lng: 174.7405 },
  greenShape: [], route: []
};
const PKG = { holes: [HOLE_1, HOLE_2, HOLE_3] };

/* ---- the endpoint, real apart from the tiles ---- */
const counts = { aerial: 0, elevation: 0 };
let failElevation = false;
const handler = createHandler({
  verifyAdmin: async () => "admin@test",
  env: { MAPBOX_PUBLIC_TOKEN: "pk.test" },
  mosaic: async (spec, zoom, origin, size) => {
    if (spec.encoding) {
      if (failElevation) return null;
      /* A ridge across the hole, in whichever encoding the DEM speaks. */
      const raw = Buffer.alloc(size.width * size.height * 3);
      for (let j = 0; j < size.height; j++) for (let i = 0; i < size.width; i++) {
        const v = 30 + 25 * Math.exp(-(((i / size.width) - 0.5) ** 2) * 30);
        const p = (j * size.width + i) * 3;
        if (spec.encoding === "terrarium") {
          const t = v + 32768;
          raw[p] = Math.floor(t / 256); raw[p + 1] = Math.floor(t) % 256; raw[p + 2] = Math.round((t % 1) * 256) % 256;
        } else {
          const n = Math.round((v + 10000) * 10);
          raw[p] = (n >> 16) & 255; raw[p + 1] = (n >> 8) & 255; raw[p + 2] = n & 255;
        }
      }
      return sharp(raw, { raw: { width: size.width, height: size.height, channels: 3 } }).png().toBuffer();
    }
    return sharp({ create: { width: size.width, height: size.height, channels: 3, background: { r: 52, g: 110, b: 58 } } }).png().toBuffer();
  }
});

/* A published course, for the regression the live mode exposed: dispose() loses the mesh's
   WebGL context and the canvas kept handing that dead context back, so only the FIRST
   published hole of a session ever got its mesh. */
let elevationPngCache = null;
async function publishedElevationPng() {
  if (!elevationPngCache) {
    const raw = Buffer.alloc(64 * 64 * 3);
    for (let i = 0; i < 64 * 64; i++) {
      const n = Math.round((40 + (i % 64) * 0.3 + 10000) * 10);
      raw[i * 3] = (n >> 16) & 255; raw[i * 3 + 1] = (n >> 8) & 255; raw[i * 3 + 2] = n & 255;
    }
    elevationPngCache = await sharp(raw, { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer();
  }
  return elevationPngCache;
}
function worldPx(lat, lng, z) {
  const scale = 256 * Math.pow(2, z), r = lat * Math.PI / 180;
  return { x: ((lng + 180) / 360) * scale, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * scale };
}
async function publishedHole(hole, shade) {
  const a = worldPx(hole.tee.lat, hole.tee.lng, 18), b = worldPx(hole.green.lat, hole.green.lng, 18);
  const x = Math.floor(Math.min(a.x, b.x)) - 300, y = Math.floor(Math.min(a.y, b.y)) - 300;
  const w = Math.ceil(Math.abs(a.x - b.x)) + 600, h = Math.ceil(Math.abs(a.y - b.y)) + 600;
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: shade, g: 120, b: 60 } } }).png().toBuffer();
  return {
    holeNumber: hole.holeNumber,
    geometry: { tee: hole.tee, green: hole.green, greenShape: [], route: [] },
    visual: {
      url: "data:image/png;base64," + png.toString("base64"),
      playSurface: {
        captureZoom: 18, originPx: { x, y }, outputDimensions: { width: w, height: h },
        elevation: { path: "pub/h" + hole.holeNumber + ".elevation.png", width: 64, height: 64,
          metresPerPixel: (w * 0.48) / 64, elevationRange: { min: 40, max: 60 } }
      }
    }
  };
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp" };

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const urlPath = decodeURIComponent(req.url.split("?")[0]);
      if (urlPath === "/api/live-terrain-frame") {
        const layer = new URL(req.url, "http://x").searchParams.get("layer");
        if (counts[layer] !== undefined) counts[layer]++;
        const answer = await handler(new Request("http://127.0.0.1" + req.url, { method: req.method, headers: req.headers }));
        const headers = {};
        answer.headers.forEach((v, k) => { headers[k] = v; });
        res.writeHead(answer.status, headers);
        res.end(Buffer.from(await answer.arrayBuffer()));
        return;
      }
      if (urlPath === "/api/course-visual-assets") {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(await publishedElevationPng());
        return;
      }
      if (urlPath === "/api/course-package") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ courseId: "live-mesh-course", status: "lite", packageVersion: 1, holes: [] }));
        return;
      }
      if (urlPath.startsWith("/api/")) { res.writeHead(404); res.end("{}"); return; }
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
  const args = ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
  if (process.env.GD_BOOT_CHROMIUM) return playwright.chromium.launch({ executablePath: process.env.GD_BOOT_CHROMIUM, args });
  try { return await playwright.chromium.launch({ args }); }
  catch (e) { return playwright.chromium.launch({ channel: "chrome", args }); }
}

let passed = 0;
function ok(name, cond, detail) {
  assert.ok(cond, name + (detail ? " - " + JSON.stringify(detail) : ""));
  passed++;
  console.log("ok  - " + name);
}

const playwright = require("playwright-core");
const server = await startServer();
const browser = await launchBrowser(playwright);
try {
  const context = await browser.newContext({ geolocation: { latitude: -36.9150, longitude: 174.7400 }, permissions: ["geolocation"] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push((err && err.message) || String(err)));
  await page.addInitScript(() => {
    window.__revoked = 0;
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = function (u) { window.__revoked++; return revoke(u); };
  });
  await page.goto("http://127.0.0.1:" + server.address().port
    + "/app/index.html?courseId=live-mesh-course&courseName=Live+Mesh&courseLat=-36.915&courseLng=174.74", { waitUntil: "load" });
  await page.waitForFunction(() => window.ClarityApp && window.ClarityApp.marshal && window.ClarityApp.painter, { timeout: 15000 });
  await page.waitForTimeout(600);

  const webgl = await page.evaluate(() => !!(window.GDTerrainMesh && window.GDTerrainMesh.supported()));
  if (!webgl) {
    console.log("SKIP - this Chromium has no WebGL, so the mode cannot switch on; run with a GL-capable browser");
    process.exit(0);
  }

  await page.evaluate((pkg) => {
    const app = window.ClarityApp;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__lm = {
      async until(fn, label, ms) {
        const deadline = Date.now() + (ms || 8000);
        while (Date.now() < deadline) { try { if (fn()) return true; } catch (e) {} await wait(40); }
        throw new Error("timed out waiting for " + label + " - " + JSON.stringify(app.painter.liveTerrainDebug()));
      },
      debug: () => app.painter.liveTerrainDebug(),
      state: () => ({
        debug: app.painter.liveTerrainDebug(),
        presentation: app.painter.presentation().kind,
        published: document.body.classList.contains("surface-published"),
        meshUp: document.body.classList.contains("surface-mesh"),
        stamp: document.getElementById("assetVersionStamp").textContent,
        revoked: window.__revoked
      }),
      async open() {
        app.painter.detach();
        app.marshal.signal("ROUND_OPENED", { courseKey: "live-mesh-course", pkg, centre: { lat: -36.915, lng: 174.74 }, nines: null });
        document.body.classList.remove("route-home");
        document.body.classList.add("route-play");
        await wait(400);
      }
    };
    /* The admin account, as far as the display gates are concerned. */
    app.account.isAdmin = () => true;
    app.gpsSettings.set("relief", "enhanced");
    app.basemap.setOverride("mesh");
  }, PKG);

  /* 1. Up on the mesh, from one request per layer. */
  await page.evaluate(() => window.__lm.open());
  await page.evaluate(() => window.__lm.until(() => window.__lm.debug().active, "the live mesh"));
  let s = await page.evaluate(() => window.__lm.state());
  ok("an unpublished hole comes up on the terrain mesh", s.debug.active && s.published && s.meshUp && s.presentation === "published", s);
  ok("from exactly one aerial and one elevation request", counts.aerial === 1 && counts.elevation === 1, counts);
  ok("the admin readout names the sources and the height", /3D mesh · Mapbox z\d+ \d+x\d+ · DEM \S+ z\d+ \d+x\d+/.test(s.stamp) && s.stamp.includes("2.5x"), s.stamp);
  ok("the frame is the window's own size and metres", s.debug.frame && /^\d+x\d+m$/.test(s.debug.frame.metres) && s.debug.frame.rebuild === "hole change", s.debug.frame);

  /* 2. GPS, Play and a new height rebuild nothing. */
  s = await page.evaluate(async () => {
    const app = window.ClarityApp;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const p of [{ lat: -36.9135, lng: 174.7408 }, { lat: -36.9140, lng: 174.7405 }, { lat: -36.9142, lng: 174.7404 }]) {
      app.marshal.signal("FIX_RECEIVED", { point: p });
      await wait(120);
    }
    app.marshal.signal("PLAY_PRESSED");
    await wait(300);
    app.gpsSettings.set("relief", "dramatic");
    await wait(300);
    return window.__lm.state();
  });
  ok("GPS fixes, Play and a new height do not rebuild the frame", counts.aerial === 1 && counts.elevation === 1, counts);
  ok("the height follows the setting", s.debug.active && s.debug.exaggeration === 5 && s.stamp.includes("5x"), s);

  /* 3. Relief off: back to the live map, frame released. On again: rebuilt. */
  const revokedBefore = s.revoked;
  await page.evaluate(() => window.ClarityApp.gpsSettings.set("relief", "off"));
  await page.evaluate(() => window.__lm.until(() => window.ClarityApp.painter.presentation().kind === "live", "the live map"));
  s = await page.evaluate(() => window.__lm.state());
  ok("terrain off goes back to the live map", !s.debug.active && !s.published && !s.meshUp && !s.debug.wanted, s);
  ok("and lets the frame go", s.revoked >= revokedBefore + 2 && !s.debug.frame, s);
  await page.evaluate(() => window.ClarityApp.gpsSettings.set("relief", "natural"));
  await page.evaluate(() => window.__lm.until(() => window.__lm.debug().active, "the mesh again"));
  s = await page.evaluate(() => window.__lm.state());
  ok("terrain on again builds it again", s.debug.active && s.debug.exaggeration === 1 && s.debug.frame.rebuild === "relief", s);
  /* The same window is the same URL, and the answer is private-cacheable on the device. */
  ok("from the device's own cache, not the server", counts.aerial === 1 && counts.elevation === 1, counts);

  /* 4. A new hole is a new frame, and the old one is released. */
  const before = await page.evaluate(() => ({ win: window.__lm.debug().frame.window, revoked: window.__revoked }));
  await page.evaluate(() => window.ClarityApp.marshal.signal("VIEW_HOLE_CHANGED", { hole: 2 }));
  await page.evaluate(() => window.__lm.until(() => {
    const d = window.__lm.debug();
    return d.active && window.ClarityApp.marshal.round().hole === 2;
  }, "hole 2 on the mesh"));
  s = await page.evaluate(() => window.__lm.state());
  ok("a new hole builds a new frame", counts.aerial === 2 && counts.elevation === 2
    && JSON.stringify(s.debug.frame.window) !== JSON.stringify(before.win), { counts, frame: s.debug.frame });
  ok("and releases the old one", s.revoked >= before.revoked + 2, s);

  /* 5. Another map source: back to the live map. */
  await page.evaluate(() => window.ClarityApp.basemap.setOverride("mapbox"));
  await page.evaluate(() => window.__lm.until(() => window.ClarityApp.painter.presentation().kind === "live", "the live map"));
  s = await page.evaluate(() => window.__lm.state());
  ok("plain Mapbox is the flat live map", !s.debug.active && !s.published, s);

  /* 6. Back on the mesh (hole 2 again, from the device cache), then a hole whose elevation
     fails: the live map stays, with the reason. */
  await page.evaluate(() => window.ClarityApp.basemap.setOverride("mesh"));
  await page.evaluate(() => window.__lm.until(() => window.__lm.debug().active, "the mesh back on"));
  s = await page.evaluate(() => window.__lm.state());
  ok("choosing Clarity 3D Mesh again brings it back", s.debug.frame.rebuild === "map source", s.debug.frame);
  failElevation = true;
  await page.evaluate(() => window.ClarityApp.marshal.signal("VIEW_HOLE_CHANGED", { hole: 3 }));
  await page.evaluate(() => window.__lm.until(() => /elevation 502/.test(window.__lm.debug().fallback || ""), "the fallback reason"));
  s = await page.evaluate(() => window.__lm.state());
  ok("a failed DEM leaves the live map up", !s.published && !s.meshUp && s.presentation === "live", s);
  ok("with the reason on the admin readout", /3D mesh off · elevation 502: no elevation/.test(s.stamp), s.stamp);
  failElevation = false;

  /* 7. A player never asks. */
  const asked = { ...counts };
  await page.evaluate(async () => {
    const app = window.ClarityApp;
    app.account.isAdmin = () => false;
    app.marshal.signal("VIEW_HOLE_CHANGED", { hole: 1 });
    await new Promise((r) => setTimeout(r, 900));
  });
  s = await page.evaluate(() => window.__lm.state());
  ok("a non-admin with a stored mesh override gets the normal live map and no requests",
    counts.aerial === asked.aerial && counts.elevation === asked.elevation && !s.debug.wanted && !s.published, { counts, s });

  /* 8. Published holes, one after another, each get their mesh. */
  const published = { courseId: "published-course", status: "full-map-ready", packageVersion: 1,
    holes: [await publishedHole(HOLE_1, 40), await publishedHole(HOLE_2, 80)] };
  const meshes = await page.evaluate(async (pkg) => {
    const app = window.ClarityApp;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    app.basemap.setOverride("auto");
    app.painter.detach();
    app.marshal.signal("ROUND_OPENED", { courseKey: "published-course", pkg, centre: { lat: -36.915, lng: 174.74 }, nines: null });
    const seen = [];
    for (const hole of [1, 2, 1]) {
      if (hole !== app.marshal.round().hole) app.marshal.signal("VIEW_HOLE_CHANGED", { hole });
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline && !(document.body.classList.contains("surface-mesh") && app.marshal.round().hole === hole)) await wait(40);
      seen.push(document.body.classList.contains("surface-mesh"));
      await wait(150);
    }
    return seen;
  }, published);
  ok("every published hole gets its mesh, not just the first", meshes.every(Boolean), meshes);

  ok("no uncaught errors", errors.length === 0, errors);
  console.log("\nlive-terrain-mesh: " + passed + " passed");
} finally {
  await browser.close();
  server.close();
}
