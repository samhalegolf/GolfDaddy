/*
 * Clarity 3D Mesh in the real app (headless Chromium, WebGL through SwiftShader).
 *
 * The page is the shipped /app/index.html. Esri and Mapbox tiles are answered by Playwright
 * routes (flat colours, so the composite can be read back), and /api/live-terrain-frame is the
 * real handler (functions/live-terrain-frame.mjs) with only its tile fetch faked and the admin
 * check stubbed - so the compositor, the round's tile cache, the DEM resample and the mesh all
 * run for real.
 *
 * Pinned here:
 *   - admin + "mesh" + relief on: an unpublished hole comes up on the terrain mesh, built from
 *     Esri across the frame and Mapbox only where the playing area needs it, with Mapbox colour
 *     at the tee and corrected Esri in the corners of the picture the mesh is given;
 *   - the Leaflet map underneath fetches no Mapbox at all in this mode;
 *   - GPS fixes, Play, a relief change and a debug view change fetch no provider tiles;
 *   - relief off goes back to the live map and lets the frame go; on again rebuilds from cache;
 *   - the next hole reuses the round's tiles and fetches only what it does not share, and the
 *     live map never flashes up while it is built;
 *   - Mapbox failing still gives an Esri mesh surface; a failed DEM gives a flat composite;
 *     Esri failing leaves the live map up - each with its reason on the readout;
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
/* Further off, for the failure cases, so nothing of them is cached yet. */
const HOLE_3 = { holeNumber: 3, tee: { lat: -36.9230, lng: 174.7480 }, green: { lat: -36.9250, lng: 174.7440 }, greenShape: [], route: [] };
const HOLE_4 = { holeNumber: 4, tee: { lat: -36.9290, lng: 174.7520 }, green: { lat: -36.9310, lng: 174.7480 }, greenShape: [], route: [] };
const HOLE_5 = { holeNumber: 5, tee: { lat: -36.9350, lng: 174.7560 }, green: { lat: -36.9370, lng: 174.7520 }, greenShape: [], route: [] };
const PKG = { holes: [HOLE_1, HOLE_2, HOLE_3, HOLE_4, HOLE_5] };

const ESRI_RGB = { r: 70, g: 95, b: 90 }, MAPBOX_RGB = { r: 80, g: 125, b: 70 };

/* ---- the elevation endpoint, real apart from its tiles ---- */
const counts = { elevation: 0 };
let failElevation = false;
const handler = createHandler({
  verifyAdmin: async () => "admin@test",
  env: { MAPBOX_PUBLIC_TOKEN: "pk.test" },
  mosaic: async (spec, zoom, origin, size) => {
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
});

/* ---- a published course, for the disposed-canvas regression ---- */
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
        counts.elevation++;
        const answer = await handler(new Request("http://127.0.0.1" + req.url, { method: req.method, headers: req.headers }));
        const headers = {};
        answer.headers.forEach((v, k) => { headers[k] = v; });
        res.writeHead(answer.status, headers);
        res.end(Buffer.from(await answer.arrayBuffer()));
        return;
      }
      if (urlPath === "/api/auth-public-config") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ esriApiKey: "esri-test", mapboxPublicToken: "pk.test" }));
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

/* ---- the providers ---- */
const tiles = { esri: 0, mapbox: 0, leafletMapbox: 0 };
const fail = { esri: false, mapbox: false };
const tileCache = {};
async function tileJpeg(rgb) {
  const key = rgb.r + "," + rgb.g + "," + rgb.b;
  if (!tileCache[key]) tileCache[key] = await sharp({ create: { width: 256, height: 256, channels: 3, background: rgb } }).jpeg({ quality: 95 }).toBuffer();
  return tileCache[key];
}

const playwright = require("playwright-core");
const server = await startServer();
const browser = await launchBrowser(playwright);
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 },
    geolocation: { latitude: -36.9150, longitude: 174.7400 }, permissions: ["geolocation"] });
  await context.route(/ibasemaps-api\.arcgis\.com|api\.mapbox\.com|tile\.openstreetmap\.org/, async (route) => {
    const url = route.request().url();
    const fromCompositor = route.request().resourceType() === "fetch";
    const kind = url.includes("mapbox") ? "mapbox" : url.includes("arcgis") ? "esri" : "osm";
    if (kind === "mapbox" && !fromCompositor) tiles.leafletMapbox++;
    if (fromCompositor && (kind === "esri" || kind === "mapbox")) {
      tiles[kind]++;
      if (fail[kind]) return route.fulfill({ status: 503, headers: { "Access-Control-Allow-Origin": "*" }, body: "" });
    }
    return route.fulfill({ status: 200, contentType: "image/jpeg", headers: { "Access-Control-Allow-Origin": "*" },
      body: await tileJpeg(kind === "mapbox" ? MAPBOX_RGB : ESRI_RGB) });
  });
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
        const deadline = Date.now() + (ms || 10000);
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
      /* The picture the mesh was handed, read back at a frame pixel. */
      async pixel(fx, fy) {
        const img = document.getElementById("surfaceImage");
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        return Array.from(ctx.getImageData(Math.floor(fx), Math.floor(fy), 1, 1).data.slice(0, 3));
      },
      async open() {
        app.painter.detach();
        app.marshal.signal("ROUND_OPENED", { courseKey: "live-mesh-course", pkg, centre: { lat: -36.915, lng: 174.74 }, nines: null });
        document.body.classList.remove("route-home");
        document.body.classList.add("route-play");
        await wait(400);
      },
      async hole(n) {
        app.marshal.signal("VIEW_HOLE_CHANGED", { hole: n });
        await window.__lm.until(() => app.marshal.round().hole === n, "hole " + n);
      }
    };
    /* The admin account, as far as the display gates are concerned. */
    app.account.isAdmin = () => true;
    app.gpsSettings.set("relief", "enhanced");
    app.gpsSettings.set("hybridView", "composite");
    app.basemap.setOverride("mesh");
  }, PKG);
  await page.evaluate(() => window.ClarityApp.basemap.ready());

  /* 1. Up on the mesh, from Esri across the frame and Mapbox over the playing area. */
  await page.evaluate(() => window.__lm.open());
  await page.evaluate(() => window.__lm.until(() => window.__lm.debug().active, "the live mesh"));
  let s = await page.evaluate(() => window.__lm.state());
  const f1 = s.debug.frame;
  ok("an unpublished hole comes up on the terrain mesh", s.debug.active && s.published && s.meshUp && s.presentation === "published", s);
  ok("Esri for every frame tile, Mapbox for the playing area only", tiles.esri === f1.tiles.frame && tiles.mapbox === f1.tiles.mapbox
    && tiles.mapbox < tiles.esri && counts.elevation === 1, { tiles, f1: f1.tiles });
  ok("the Leaflet map underneath asks Mapbox for nothing", tiles.leafletMapbox === 0, tiles);
  ok("the readout says the mesh is on and what it cost", /^3D mesh on · z\d+ \d+x\d+ [\d.]+m\/px · Esri \d+\+0r · Mapbox \d+\+0r \([\d.]+% frame, session \d+\)/.test(s.stamp)
    && s.stamp.includes("2.5x") && /mesh \d+ms/.test(s.stamp), s.stamp);
  const teeAt = await page.evaluate((t) => {
    const scale = 256 * Math.pow(2, t.z), r = t.lat * Math.PI / 180;
    return { x: ((t.lng + 180) / 360) * scale - t.x, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * scale - t.y };
  }, { ...HOLE_1.tee, z: f1.window.z, x: f1.window.x, y: f1.window.y });
  const atTee = await page.evaluate((p) => window.__lm.pixel(p.x, p.y), teeAt);
  const atCorner = await page.evaluate(() => window.__lm.pixel(3, 3));
  const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
  ok("the mesh is given the composite: Mapbox at the tee", near(atTee, [MAPBOX_RGB.r, MAPBOX_RGB.g, MAPBOX_RGB.b], 6), atTee);
  ok("and corrected Esri in the corner, nearer Mapbox than raw Esri is", !near(atCorner, [ESRI_RGB.r, ESRI_RGB.g, ESRI_RGB.b], 2)
    && Math.abs(atCorner[1] - MAPBOX_RGB.g) < Math.abs(ESRI_RGB.g - MAPBOX_RGB.g), atCorner);
  ok("colour correction applied within its limits", f1.colour.applied && f1.colour.gain.every((g) => g >= 0.8 && g <= 1.25), f1.colour);

  /* 2. GPS, Play, a new height and a debug view fetch no tiles. */
  const before = { ...tiles, elevation: counts.elevation };
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
  ok("GPS fixes, Play and a new height fetch nothing", tiles.esri === before.esri && tiles.mapbox === before.mapbox
    && counts.elevation === before.elevation, { tiles, counts });
  ok("the height follows the setting", s.debug.active && s.debug.exaggeration === 5 && s.stamp.includes("5x"), s);
  await page.evaluate(() => window.ClarityApp.gpsSettings.set("hybridView", "mask"));
  await page.evaluate(() => window.__lm.until(() => { const d = window.__lm.debug(); return d.active && d.frame.view === "mask"; }, "the mask view"));
  s = await page.evaluate(() => window.__lm.state());
  ok("a debug view is rebuilt from the round's tiles, fetching none", tiles.esri === before.esri && tiles.mapbox === before.mapbox
    && s.debug.frame.mapbox.reused === f1.tiles.mapbox && s.stamp.includes("view mask"), { tiles, s: s.stamp });
  await page.evaluate(() => window.ClarityApp.gpsSettings.set("hybridView", "composite"));
  await page.evaluate(() => window.__lm.until(() => { const d = window.__lm.debug(); return d.active && d.frame.view === "composite"; }, "back to composite"));

  /* 3. Relief off: back to the live map, frame released. On again: rebuilt from cache. */
  const revokedBefore = await page.evaluate(() => window.__revoked);
  await page.evaluate(() => window.ClarityApp.gpsSettings.set("relief", "off"));
  await page.evaluate(() => window.__lm.until(() => window.ClarityApp.painter.presentation().kind === "live", "the live map"));
  s = await page.evaluate(() => window.__lm.state());
  ok("terrain off goes back to the live map", !s.debug.active && !s.published && !s.meshUp && !s.debug.wanted, s);
  ok("and lets the frame go", s.revoked >= revokedBefore + 2 && !s.debug.frame, s);
  await page.evaluate(() => window.ClarityApp.gpsSettings.set("relief", "natural"));
  await page.evaluate(() => window.__lm.until(() => window.__lm.debug().active, "the mesh again"));
  s = await page.evaluate(() => window.__lm.state());
  ok("terrain on again rebuilds it, without fetching a tile", s.debug.exaggeration === 1 && s.debug.frame.rebuild === "relief"
    && tiles.esri === before.esri && tiles.mapbox === before.mapbox, { tiles, s });

  /* 4. The next hole: a new frame from the round's tiles plus only the ones it lacks. */
  const beforeH2 = { ...tiles };
  /* Watch every frame of the change: the live map must never be what is on screen. */
  const flashed = page.evaluate(() => new Promise((resolve) => {
    const map = document.getElementById("map");
    let seen = 0, frames = 0;
    (function look() {
      frames++;
      if (getComputedStyle(map).visibility !== "hidden") seen++;
      if (frames < 90) requestAnimationFrame(look); else resolve({ seen, frames });
    })();
  }));
  await page.evaluate(() => window.__lm.hole(2));
  await page.evaluate(() => window.__lm.until(() => window.__lm.debug().active && window.__lm.debug().frame.rebuild === "hole change", "hole 2 on the mesh"));
  s = await page.evaluate(() => window.__lm.state());
  const f2 = s.debug.frame;
  ok("the next hole reuses the round's tiles", f2.mapbox.reused > 0 && f2.esri.reused > 0
    && tiles.mapbox - beforeH2.mapbox === f2.mapbox.network && tiles.esri - beforeH2.esri === f2.esri.network, { f2, tiles });
  ok("and the readout counts the round's Mapbox total", f2.sessionMapbox === tiles.mapbox, { f2, tiles });
  const flash = await flashed;
  ok("changing hole holds the last picture instead of flashing the live map", flash.seen === 0, flash);
  console.log("      hole 1: Esri " + f1.esri.network + ", Mapbox " + f1.mapbox.network + " of " + f1.tiles.frame + " frame tiles ("
    + f1.maskPct + "% masked); hole 2: Esri " + f2.esri.network + " new + " + f2.esri.reused + " reused, Mapbox "
    + f2.mapbox.network + " new + " + f2.mapbox.reused + " reused");

  /* The "3D Mesh view" row shows on Clarity 3D Mesh and on nothing else - actually hidden, not
     just classed hidden (.setRow's own display once beat .hiddenState). */
  const rowShown = await page.evaluate(() => {
    const app = window.ClarityApp, row = document.getElementById("setHybridViewRow"), seen = {};
    app.gpsSettings.open();
    for (const source of ["auto", "esri", "mapbox", "mesh"]) {
      app.basemap.setOverride(source);
      document.getElementById("setMapSource").click();               // re-renders the panel...
      document.getElementById("setMapSource").click();
      document.getElementById("setMapSource").click();
      document.getElementById("setMapSource").click();               // ...and back to `source`
      const coarse = document.getElementById("setGreenCoarseRow");
      seen[source] = getComputedStyle(row).display !== "none" && row.offsetHeight > 0
        && getComputedStyle(coarse).display !== "none" && coarse.offsetHeight > 0;
    }
    app.gpsSettings.close();
    return seen;
  });
  ok("the 3D Mesh view and coarse green-lines rows are visible only on Clarity 3D Mesh", !rowShown.auto && !rowShown.esri && !rowShown.mapbox && rowShown.mesh, rowShown);
  await page.evaluate(() => window.__lm.until(() => window.__lm.debug().active, "the mesh after the settings round trip"));

  /* 5. Mapbox fails: an Esri surface, still on the mesh, with the reason. */
  fail.mapbox = true;
  await page.evaluate(() => window.__lm.hole(3));
  await page.evaluate(() => window.__lm.until(() => window.__lm.debug().active && /tile 503/.test(window.__lm.debug().frame.mapboxFailed || "")
    && /FAILED/.test(document.getElementById("assetVersionStamp").textContent), "the Esri surface"));
  s = await page.evaluate(() => window.__lm.state());
  ok("Mapbox failing still gives an Esri mesh surface", s.debug.active && s.meshUp && s.stamp.includes("FAILED") && !s.debug.frame.colour.applied, s);
  fail.mapbox = false;

  /* 6. The DEM fails: the composite, flat. */
  failElevation = true;
  await page.evaluate(() => window.__lm.hole(4));
  /* Wait for the new hole's own readout: until it is presented, the hold keeps the previous
     hole (and its mesh) on screen. */
  await page.evaluate(() => window.__lm.until(() => { const d = window.__lm.debug(); return d.frame && d.frame.elevationFailed
    && document.body.classList.contains("surface-published") && /DEM none/.test(document.getElementById("assetVersionStamp").textContent); }, "the flat composite"));
  s = await page.evaluate(() => window.__lm.state());
  ok("a failed DEM gives the flat composite", s.published && !s.meshUp && /DEM none \(elevation 502/.test(s.stamp) && /3D mesh off/.test(s.stamp), s);
  failElevation = false;

  /* 7. Esri fails: the live map stays, with the reason. */
  fail.esri = true;
  await page.evaluate(() => window.__lm.hole(5));
  await page.evaluate(() => window.__lm.until(() => /esri tile 503/.test(window.__lm.debug().fallback || ""), "the fallback reason"));
  s = await page.evaluate(() => window.__lm.state());
  ok("Esri failing leaves the live map up", !s.published && !s.meshUp && s.presentation === "live" && /3D mesh off · esri tile 503/.test(s.stamp), s);
  fail.esri = false;

  /* 8. A player never asks. */
  const asked = { ...tiles, elevation: counts.elevation };
  await page.evaluate(async () => {
    window.ClarityApp.account.isAdmin = () => false;
    await window.__lm.hole(1);
    await new Promise((r) => setTimeout(r, 900));
  });
  s = await page.evaluate(() => window.__lm.state());
  ok("a non-admin with a stored mesh override gets the normal live map and no requests",
    tiles.esri === asked.esri && tiles.mapbox === asked.mapbox && counts.elevation === asked.elevation && !s.debug.wanted && !s.published, { tiles, s });

  /* 9. Published holes, one after another, each get their mesh. */
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
