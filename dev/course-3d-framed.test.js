/*
 * GPS Play's 3D mode (app/js/gd-course-3d.js createFramed), in a real WebGL context.
 *
 * 3D mode swaps the plain terrain mesh for the 3D scene but keeps Play's framing, so the one
 * thing that has to hold is that the two agree on where the ground is: the dot, the pin, the
 * bubble and every tap go through the mesh's lift, and the picture has to be drawn exactly
 * there or the overlays float off the ground they belong to. Pinned here, by rendering a
 * black frame with one white dot and finding the dot:
 *   - it has GDTerrainMesh.create's contract (state, render, dispose, lift, ground, offsetAt)
 *   - flat (no lock tilt) a raised hole is seen from above: the dot stays on its own pixel
 *   - tilted, the dot moves exactly where lift() says, for any frame rotation
 *   - ground at height zero never moves, tilt or not
 *   - a tree model stands up on it, and dispose is safe twice and after a render
 *
 * Run: node dev/course-3d-framed.test.js
 */
const assert = require("assert");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

const PAGE = `<!doctype html><html><body>
<canvas id="c" width="256" height="256"></canvas>
<script src="/app/js/gd-terrain-mesh.js"></script>
<script src="/scripts/trees/nz-trees.js"></script>
<script src="/scripts/gd-bubble-hazard-core.js"></script>
<script src="/scripts/gd-watch-map-core.js"></script>
<script src="/app/js/gd-illustrated-surface.js"></script>
<script src="/app/js/gd-course-3d.js"></script>
<script>
/* Terrain-RGB at one height everywhere. */
function elevation(heightM) {
  const c = document.createElement("canvas"); c.width = c.height = 16;
  const v = Math.round((heightM + 10000) / 0.1);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "rgb(" + (v >> 16) + "," + ((v >> 8) & 255) + "," + (v & 255) + ")";
  ctx.fillRect(0, 0, 16, 16);
  return c;
}
/* Black, with a white 4px dot at the frame's centre. */
function picture() {
  const c = document.createElement("canvas"); c.width = c.height = 256;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = "#fff"; ctx.fillRect(126, 126, 4, 4);
  return c;
}
/* The centroid of the white pixels, read in the same task as the render. */
function dot(canvas) {
  const c = document.createElement("canvas"); c.width = canvas.width; c.height = canvas.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(canvas, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    const i = (y * c.width + x) * 4;
    if (d[i] > 160 && d[i + 1] > 160 && d[i + 2] > 160) { sx += x + 0.5; sy += y + 0.5; n++; }
  }
  return n ? { x: sx / n, y: sy / n, n } : null;
}
function snapshot(canvas) {
  const c = document.createElement("canvas"); c.width = canvas.width; c.height = canvas.height;
  c.getContext("2d").drawImage(canvas, 0, 0);
  return c.toDataURL();
}
window.run = () => {
  const out = { webgl: !!document.createElement("canvas").getContext("webgl") };
  if (!out.webgl) return out;
  /* A fresh canvas per scene: dispose loses the context for good, as it does in Play. */
  let canvas = document.getElementById("c");
  function build(heightM, seaLevel, trees) {
    const fresh = canvas.cloneNode(false);
    canvas.parentNode.replaceChild(fresh, canvas);
    canvas = fresh;
    const m = GDCourse3D.createFramed(canvas, {
      aerial: picture(), elevation: elevation(heightM), metres: [300, 300], demSize: [16, 16],
      imagePx: [256, 256], framePx: [256, 256], seaLevel: seaLevel, illustrated: true, trees: trees || []
    });
    m.state.exaggeration = 2.5;
    m.state.ambient = 1;
    m.state.frameRotationDeg = 0;
    return m;
  }
  let m = build(20, 0);
  out.api = ["state", "render", "dispose", "lift", "ground", "offsetAt"].every((k) => typeof m[k] !== "undefined");
  m.state.tiltDeg = 0; m.render();
  out.flat = dot(canvas);
  out.cases = [0, 137].map((rot) => {
    m.state.tiltDeg = 32; m.state.frameRotationDeg = rot; m.render();
    return { rot, drawn: dot(canvas), lifted: m.lift({ x: 128, y: 128 }) };
  });
  m.dispose();
  /* Height zero: the sea level is the ground's own height. */
  m = build(20, 20);
  m.state.tiltDeg = 32; m.render();
  out.groundZero = dot(canvas);
  out.groundZeroLift = m.lift({ x: 128, y: 128 });
  m.dispose();
  /* A tree, near the bottom of the frame so the dot stays clear. */
  m = build(20, 0);
  m.state.tiltDeg = 32; m.render();
  const bare = snapshot(canvas);
  m.dispose();
  m = build(20, 0, [{ u: 0.5, v: 0.8, r: 4, species: (window.NZTrees.SPECIES[0] || {}).id }]);
  m.state.tiltDeg = 32; m.render();
  out.treeDrawn = snapshot(canvas) !== bare;
  m.dispose();
  try { m.render(); out.renderAfterDispose = "ok"; } catch (e) { out.renderAfterDispose = "threw: " + e.message; }
  try { m.dispose(); out.doubleDispose = "ok"; } catch (e) { out.doubleDispose = "threw: " + e.message; }
  return out;
};
/* The Studio's free viewer draws the same scene through its own camera: it still builds. */
window.runViewer = async () => {
  const stage = document.createElement("div");
  stage.style.cssText = "width:200px;height:150px;position:relative";
  const c = document.createElement("canvas");
  stage.appendChild(c);
  document.body.appendChild(stage);
  const viewer = GDCourse3D.createViewer(stage, c, {});
  const built = await viewer.load({
    holeNumber: 1,
    meta: { captureZoom: 18, originPx: { x: 0, y: 0 }, outputDimensions: { width: 256, height: 256 },
      elevation: { width: 16, height: 16, metresPerPixel: 18.75, elevationRange: { min: 0, max: 20 } } },
    frameUrl: picture().toDataURL(),
    elevationUrl: elevation(20).toDataURL(),
    style: "photo",
    course: () => null
  }, false);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const status = viewer.status();
  viewer.dispose();
  return { built: !!built && !built.flat, status: !!status && status.mode === "orbit" };
};
/* Hybrid (the Studio's photo/illustrated blend): a dark blue photo under an illustrated map
   with one green in the middle of the frame. The colour at the middle of the screen says
   which picture is showing as the blend and the mask change. */
window.runHybrid = async () => {
  const stage = document.createElement("div");
  stage.style.cssText = "width:200px;height:150px;position:relative";
  const c = document.createElement("canvas");
  stage.appendChild(c);
  document.body.appendChild(stage);
  let centre = null;
  const viewer = GDCourse3D.createViewer(stage, c, {
    onFrame: () => {
      const s = document.createElement("canvas"); s.width = c.width; s.height = c.height;
      const ctx = s.getContext("2d"); ctx.drawImage(c, 0, 0);
      const d = ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
      centre = { r: d[0], g: d[1], b: d[2] };
    }
  });
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  /* A frame round a real place, so the course shapes project onto it. */
  const zoom = 18, scale = 256 * Math.pow(2, zoom), lat0 = -36.9, lng0 = 174.7;
  const rad = lat0 * Math.PI / 180;
  const cx = (lng0 + 180) / 360 * scale, cy = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * scale;
  const at = (x, y) => ({
    lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * (cy - 128 + y) / scale))) * 180 / Math.PI,
    lng: (cx - 128 + x) / scale * 360 - 180
  });
  const greenShape = [at(88, 88), at(168, 88), at(168, 168), at(88, 168)];
  const pkg = { status: "full-map-ready", holes: [{ holeNumber: 1, geometry: { greenShape, green: at(128, 128), tee: at(128, 240), route: [] } }] };
  const photoPic = document.createElement("canvas"); photoPic.width = photoPic.height = 256;
  const pctx = photoPic.getContext("2d"); pctx.fillStyle = "rgb(0,0,90)"; pctx.fillRect(0, 0, 256, 256);
  const built = await viewer.load({
    holeNumber: 1,
    meta: { captureZoom: zoom, originPx: { x: cx - 128, y: cy - 128 }, outputDimensions: { width: 256, height: 256 } },
    frameUrl: photoPic.toDataURL(),
    style: "hybrid",
    treeModels: "low",
    course: () => ({ pkg, surfaces: GDBubbleHazardCore.collectPackageSurfaces(pkg) })
  }, false);
  const out = { hybrid: !!built && built.hybrid, unavailable: built && built.illustratedUnavailable };
  await frames(); out.blendNone = centre;
  viewer.setLook({ blend: 1, method: "mix" }); await frames(); out.blendFull = centre;
  viewer.setMask({ where: "surfaces", surfaces: { bunkers: true } }); await frames(); out.maskedOff = centre;
  viewer.setMask({ where: "surfaces", surfaces: { greens: true } }); await frames(); out.maskedGreen = centre;
  viewer.setLook({ method: "detail", detail: 1 }); await frames(); out.detail = centre;
  viewer.dispose();
  return out;
};
</script></body></html>`;

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split("?")[0]);
      if (urlPath === "/__course-3d-framed.html") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(PAGE);
        return;
      }
      const filePath = path.join(ROOT, urlPath);
      if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end("not found"); return; }
        res.writeHead(200, { "Content-Type": "text/javascript" });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function launchBrowser(playwright) {
  const args = [];
  if (process.env.GD_BOOT_CHROMIUM) return playwright.chromium.launch({ executablePath: process.env.GD_BOOT_CHROMIUM, args });
  try { return await playwright.chromium.launch({ args }); }
  catch (e) { return playwright.chromium.launch({ channel: "chrome", args }); }
}

(async () => {
  const playwright = require("playwright-core");
  const server = await startServer();
  const browser = await launchBrowser(playwright);
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:" + server.address().port + "/__course-3d-framed.html", { waitUntil: "load" });
  const out = await page.evaluate(() => window.run());
  const viewer = out.webgl ? await page.evaluate(() => window.runViewer()) : null;
  const hybrid = out.webgl ? await page.evaluate(() => window.runHybrid()) : null;
  await browser.close();
  server.close();

  assert.deepStrictEqual(errors, [], "no page errors");
  if (!out.webgl) { console.log("course-3d-framed: skipped, no WebGL in this browser"); return; }
  const near = (a, b, tol, label) => {
    assert.ok(a && b, label + ": nothing found");
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) <= tol, label + ": drawn at " + JSON.stringify(a) + ", expected " + JSON.stringify(b));
  };
  assert.ok(out.api, "createFramed has the terrain mesh's contract");
  near(out.flat, { x: 128, y: 128 }, 1, "flat, a raised hole is seen from above");
  out.cases.forEach((c) => {
    assert.ok(Math.hypot(c.lifted.x - 128, c.lifted.y - 128) > 10, "tilted, the lift moves a raised point (rotation " + c.rot + ")");
    near(c.drawn, c.lifted, 1.5, "tilted, the ground is drawn where the overlays' lift puts it (rotation " + c.rot + ")");
  });
  near(out.groundZero, { x: 128, y: 128 }, 1, "ground at height zero stays on its own pixel");
  near(out.groundZeroLift, { x: 128, y: 128 }, 0.01, "and the lift agrees it does not move");
  assert.ok(out.treeDrawn, "a tree model stands up on the frame");
  assert.strictEqual(out.renderAfterDispose, "ok", "render after dispose is harmless");
  assert.strictEqual(out.doubleDispose, "ok", "dispose twice is harmless");
  assert.deepStrictEqual(viewer, { built: true, status: true }, "the Studio's free viewer still builds a hole");
  const blue = (p) => p && p.b > p.g + 20, green = (p) => p && p.g > p.b + 20;
  assert.ok(hybrid.hybrid, "a mapped hole builds as a hybrid: " + JSON.stringify(hybrid));
  assert.ok(blue(hybrid.blendNone), "blend 0 is the photo: " + JSON.stringify(hybrid.blendNone));
  assert.ok(green(hybrid.blendFull), "blend 100 over the whole frame is the illustrated map: " + JSON.stringify(hybrid.blendFull));
  assert.ok(blue(hybrid.maskedOff), "masked to surfaces that are not there, the photo shows: " + JSON.stringify(hybrid.maskedOff));
  assert.ok(green(hybrid.maskedGreen), "masked to the greens, the green is illustrated: " + JSON.stringify(hybrid.maskedGreen));
  assert.ok(hybrid.detail && hybrid.detail.g > 0, "the detail method draws: " + JSON.stringify(hybrid.detail));
  console.log("course-3d-framed passed: lift agreement at rotations 0 and 137, flat, height zero, tree, dispose, Studio viewer, hybrid blend and mask");
})().catch((e) => { console.error(e); process.exit(1); });
