#!/usr/bin/env node
/* Builds the Garmin simulator demo fixture (garmin/resources-sim-demo/).
 *
 * The standalone sim demo (CIQ_SIM_DEMO=1 ./build.sh build) runs a round with
 * no phone at all: the Connect IQ simulator segfaults on any watch -> phone
 * transmit while tethered on this Mac, and its map images need Garmin's
 * image service plus a Connect sign-in. So everything the watch would have
 * been sent - a lite-map package, the hole images, the player's bag - is
 * baked into the .prg from a package that already exists on disk: the one a
 * paired Apple Watch simulator has been delivered (CaddyWatchMaps/<course>/v*
 * and CaddyWatchPlayer/player.json in its app container).
 *
 *   node garmin/tools/make-sim-demo-fixture.js <apple-watch-app-container> [holes=1,2,3] [--download]
 *
 * --download: the watch is NOT handed the bundled images; it fetches each hole
 * through its real downloader (makeImageRequest -> Garmin's image service ->
 * /api/course-watch-map-assets), exactly as in a round. The fixture always
 * carries the real URLs; the flag only decides which path the demo uses.
 *
 * --faults: the stand-in phone makes the link misbehave - every 4th send
 * fails and any batch of more than two commands is refused as too large - so
 * GarminSender's gate can be watched narrowing and widening in the console.
 *
 * Numbers that need double precision (coordinates, the map transform) are
 * written as STRINGS: Connect IQ's resource JSON is not guaranteed to decode
 * decimals as Double, and a float32 tx (~8.6e7) is off by several pixels.
 * GarminSimDemo.dbl() parses them back exactly.
 *
 * SITUATIONS are what the watch's demo browser steps through - each a hole,
 * a label and a spot on the play line, chosen to exercise a different part of
 * the watch: a tee shot and a second shot out of the bag's reach (the layup
 * target and its fairway-line guide), a par 3 tee shot and approaches in
 * reach (the green as target), a chip (a small Bubble near the green). The
 * approach is the app's own demo rule (app/js/demo-approach.js), fixed at
 * 115 m - the middle of 100-130 - so the fixture is stable.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const distance = require("../../app/js/distance.js");

const container = process.argv[2];
const args = process.argv.slice(3);
const download = args.indexOf("--download") >= 0;
const faults = args.indexOf("--faults") >= 0;
const holes = (args.filter((a) => !a.startsWith("--"))[0] || "1,2,3").split(",").map(Number);
const API_ORIGIN = "https://caddy.claritygolf.app";
/* [hole, id, label, metres short of the green along the line, or "tee"] */
const SITUATIONS = [
  [1, "h1-tee", "Tee shot", "tee"],
  [1, "h1-second", "Second shot", 280],
  [1, "h1-approach", "Approach", 115],
  [2, "h2-tee", "Par 3 tee", "tee"],
  [3, "h3-approach", "Approach", 115],
  [3, "h3-chip", "Chip", 45]
];
if (!container) {
  console.error("usage: make-sim-demo-fixture.js <apple-watch-app-container> [holes]");
  process.exit(1);
}
const support = path.join(container, "Library", "Application Support");
const mapsRoot = path.join(support, "CaddyWatchMaps");
const courseDir = fs.readdirSync(mapsRoot).find((d) => !d.startsWith("."));
const versionDir = fs.readdirSync(path.join(mapsRoot, courseDir)).filter((d) => d.startsWith("v")).sort().pop();
const pkgDir = path.join(mapsRoot, courseDir, versionDir);
const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "manifest.json"), "utf8"));
const player = JSON.parse(fs.readFileSync(path.join(support, "CaddyWatchPlayer", "player.json"), "utf8"));

const OUT = path.join(__dirname, "..", "resources-sim-demo");
fs.mkdirSync(OUT, { recursive: true });

const s = (n) => String(n);
const pt = (p) => [s(p.lat), s(p.lng)];

function lineOf(ref) {
  const out = [];
  [ref.tee].concat(ref.route || [], [ref.green]).forEach((p) => {
    if (!p) return;
    const last = out[out.length - 1];
    if (last && distance.haversineMeters(last, p) < 1) return;
    out.push(p);
  });
  return out;
}

function shortOfGreen(line, back) {
  let left = back;
  for (let i = line.length - 1; i > 0; i--) {
    const a = line[i], b = line[i - 1];
    const seg = distance.haversineMeters(a, b);
    if (!(seg > 0)) continue;
    if (seg >= left) { const t = left / seg; return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t }; }
    left -= seg;
  }
  return line[0];
}

function spot(pos, ref) {
  const shape = (ref.greenShape || []).map((p) => distance.haversineMeters(pos, p));
  const centre = distance.haversineMeters(pos, ref.green);
  return {
    pos: pt(pos), metres: Math.round(centre),
    front: Math.round(shape.length ? Math.min(...shape) : centre),
    centre: Math.round(centre),
    back: Math.round(shape.length ? Math.max(...shape) : centre)
  };
}

const situations = [];
const fixtureHoles = [];
const manifestHoles = [];
const bitmaps = [];
for (const n of holes) {
  const h = manifest.holes.find((x) => x.holeNumber === n);
  if (!h) { console.error("hole " + n + " not in package"); process.exit(1); }
  const ref = h.reference || h.golfReference;
  const line = lineOf(ref);
  fixtureHoles.push({
    n,
    line: line.map(pt),
    len: Math.round(distance.haversineMeters(line[0], line[line.length - 1]))
  });
  SITUATIONS.filter((x) => x[0] === n).forEach(([hole, id, label, back]) => {
    const pos = back === "tee" ? line[0] : shortOfGreen(line, back);
    situations.push(Object.assign({ id, hole, label }, spot(pos, ref)));
  });
  const sr = h.spatialReference;
  manifestHoles.push({
    holeNumber: n, asset: "h" + n + ".png",
    // The phone's own URL rule (app/js/watch-map-delivery.js assetUrl):
    // slashes literal, JPEG re-encode.
    url: API_ORIGIN + "/api/course-watch-map-assets?path=" + courseDir + "/" + versionDir + "/h" + n + ".webp&format=jpeg",
    width: h.width, height: h.height,
    green: pt(ref.green),
    sr: {
      version: sr.version, refZoom: sr.refZoom, imageWidth: sr.imageWidth, imageHeight: sr.imageHeight,
      rotationDegrees: s(sr.rotationDegrees), metresPerPixel: s(sr.metresPerPixel),
      a: s(sr.transform.a), b: s(sr.transform.b), tx: s(sr.transform.tx), ty: s(sr.transform.ty)
    }
  });
  execFileSync("sips", ["-s", "format", "png", path.join(pkgDir, "h" + n + ".webp"), "--out", path.join(OUT, "h" + n + ".png")], { stdio: "ignore" });
  bitmaps.push(n);
}

const fixture = {
  course: { key: "sim-demo-" + courseDir, name: "Millbrook (sim demo)", source: courseDir + "/" + versionDir, download, faults },
  holes: fixtureHoles,
  situations,
  manifest: manifestHoles,
  player
};
fs.writeFileSync(path.join(OUT, "sim-demo.json"), JSON.stringify(fixture));
fs.writeFileSync(path.join(OUT, "resources.xml"),
  "<resources>\n" +
  "    <!-- Generated by garmin/tools/make-sim-demo-fixture.js. Simulator demo build only. -->\n" +
  '    <jsonData id="simDemo" filename="sim-demo.json"/>\n' +
  bitmaps.map((n) => '    <bitmap id="simHole' + n + '" filename="h' + n + '.png"/>').join("\n") + "\n" +
  "</resources>\n");
console.log("wrote " + OUT + " (" + holes.join(",") + ") from " + courseDir + "/" + versionDir);
