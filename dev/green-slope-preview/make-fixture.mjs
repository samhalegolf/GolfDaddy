/* A synthetic hole shaped exactly like a real one, so the renderer can be exercised without
   network access.

   The green OUTLINE is Jacks Point h1's actual published polygon and the elevation grid uses
   its actual 1.687 m/px spacing and terrain-RGB quantisation. Only two things are invented:
   the heights (a green with a known fall, a tier and a crown) and the aerial photograph.
   That makes this a real test of the geometry, the fit and the drawing, and not a test of
   the imagery.

   Written as hole 99 so it never collides with fetched data.

   Run: node dev/green-slope-preview/make-fixture.mjs */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { world, metricFrame, centroid, pointInPolygon, distanceToPolygon } from "./green-surface.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, "data");
const HOLE = 99;

/* Jacks Point h1, verbatim from frames/r1hepv7b/h1.jpg.json. */
const GREEN_SHAPE = [
  [-45.0801347, 168.7378793], [-45.0801517, 168.7378662], [-45.0801646, 168.7378575], [-45.0801776, 168.7378513],
  [-45.0801901, 168.7378448], [-45.080203, 168.7378401], [-45.0802124, 168.7378385], [-45.0802213, 168.7378399],
  [-45.0802351, 168.7378452], [-45.0802472, 168.737855], [-45.0802853, 168.7379038], [-45.0803014, 168.7379333],
  [-45.0803188, 168.7379681], [-45.0803291, 168.7379905], [-45.0803415, 168.7380148], [-45.0803541, 168.7380511],
  [-45.0803565, 168.7380811], [-45.0803583, 168.7381206], [-45.0803482, 168.7381607], [-45.0803387, 168.738188],
  [-45.0803283, 168.738211], [-45.0803188, 168.7382265], [-45.080306, 168.7382385], [-45.0802931, 168.7382463],
  [-45.0802777, 168.7382501], [-45.0802656, 168.7382496], [-45.0802529, 168.7382494], [-45.080238, 168.7382438],
  [-45.080228, 168.7382367], [-45.08022, 168.7382274], [-45.0802098, 168.7382141], [-45.0802019, 168.7381993],
  [-45.0801944, 168.7381841], [-45.0801876, 168.7381673], [-45.0801745, 168.7381492], [-45.0801649, 168.7381371],
  [-45.0801563, 168.7381304], [-45.0801468, 168.7381237], [-45.0801358, 168.738118], [-45.0801285, 168.7381157],
  [-45.0801188, 168.7381142], [-45.0801061, 168.7381117], [-45.0800929, 168.7381036], [-45.0800815, 168.7380915],
  [-45.0800705, 168.7380755], [-45.0800637, 168.738054], [-45.0800606, 168.7380242], [-45.080063, 168.7379933],
  [-45.0800655, 168.7379707], [-45.0800723, 168.7379556], [-45.0800808, 168.7379385], [-45.080092, 168.7379222],
  [-45.0801009, 168.7379093], [-45.0801126, 168.7378943]
].map(([lat, lng]) => ({ lat, lng }));

const ORIGIN = centroid(GREEN_SHAPE);
const FRAME = metricFrame(ORIGIN.lat, ORIGIN.lng);
const POLY = GREEN_SHAPE.map(p => FRAME.toMetres(p.lat, p.lng));

/* A green that falls front-left, crowns slightly, and carries a tier across the back. */
function trueHeight(x, y) {
  return 351.2
    - 0.019 * x
    - 0.024 * y
    - 0.0011 * (x * x + y * y)
    + 0.30 * Math.tanh((y - 6.5) / 3.0)
    + 0.03 * Math.sin(x / 3.5) * Math.cos(y / 4.5);
}

function unproject(wx, wy) {
  const lng = wx * 360 - 180;
  const n = Math.PI - 2 * Math.PI * wy;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lng };
}

function boundsAround(padM) {
  const xs = POLY.map(p => p.x), ys = POLY.map(p => p.y);
  const nw = FRAME.toLatLng(Math.min(...xs) - padM, Math.max(...ys) + padM);
  const se = FRAME.toLatLng(Math.max(...xs) + padM, Math.min(...ys) - padM);
  return { north: nw.lat, west: nw.lng, south: se.lat, east: se.lng };
}

/* Pixel grid over bounds, sized so one pixel is `mpp` metres on the ground. */
function gridFor(bounds, mpp) {
  const spanM = (bounds.east - bounds.west) * 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180);
  const spanMy = (bounds.north - bounds.south) * 111320;
  return { width: Math.max(8, Math.round(spanM / mpp)), height: Math.max(8, Math.round(spanMy / mpp)) };
}

function pixelToLatLng(bounds, width, height) {
  const nw = world(bounds.north, bounds.west);
  const se = world(bounds.south, bounds.east);
  return (px, py) => unproject(nw.x + ((px + 0.5) / width) * (se.x - nw.x), nw.y + ((py + 0.5) / height) * (se.y - nw.y));
}

async function main() {
  await mkdir(DATA, { recursive: true });

  /* ---- elevation: terrain-RGB at Jacks Point's real 1.687 m/px ---- */
  const MPP = 1.6867204548959047;
  const elevBounds = boundsAround(46);
  const eg = gridFor(elevBounds, MPP);
  const toLL = pixelToLatLng(elevBounds, eg.width, eg.height);
  const elev = Buffer.alloc(eg.width * eg.height * 3);
  let lo = Infinity, hi = -Infinity;
  for (let py = 0; py < eg.height; py++) {
    for (let px = 0; px < eg.width; px++) {
      const ll = toLL(px, py);
      const m = FRAME.toMetres(ll.lat, ll.lng);
      /* Ground beyond the green rolls away, so the collar is not artificially flat. */
      const far = Math.max(0, distanceToPolygon(m.x, m.y, POLY) - 4);
      const h = trueHeight(m.x, m.y) - 0.025 * far;
      /* This is the step that makes the whole exercise hard: 0.1m quantisation. */
      const q = Math.round(h / 0.1) * 0.1;
      lo = Math.min(lo, q); hi = Math.max(hi, q);
      const v = Math.max(0, Math.min(0xffffff, Math.round((q + 10000) / 0.1)));
      const i = (py * eg.width + px) * 3;
      elev[i] = (v >> 16) & 255; elev[i + 1] = (v >> 8) & 255; elev[i + 2] = v & 255;
    }
  }
  await writeFile(
    path.join(DATA, `h${HOLE}.elevation.png`),
    await sharp(elev, { raw: { width: eg.width, height: eg.height, channels: 3 } }).png({ compressionLevel: 9 }).toBuffer()
  );

  /* ---- a plausible aerial, at roughly z20 ground resolution ---- */
  const baseBounds = boundsAround(24);
  const bg = gridFor(baseBounds, 0.10);
  const toLLb = pixelToLatLng(baseBounds, bg.width, bg.height);
  const img = Buffer.alloc(bg.width * bg.height * 3);
  const hash = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
  for (let py = 0; py < bg.height; py++) {
    for (let px = 0; px < bg.width; px++) {
      const ll = toLLb(px, py);
      const m = FRAME.toMetres(ll.lat, ll.lng);
      const inside = pointInPolygon(m.x, m.y, POLY);
      const d = distanceToPolygon(m.x, m.y, POLY);
      let r, g, b;
      if (inside) {
        /* Putting surface: bright, fine, with mowing bands. */
        const mow = Math.sin((m.x * 0.9 + m.y * 0.35) * 1.05) > 0 ? 7 : -7;
        const n = (hash(Math.floor(px / 2), Math.floor(py / 2)) - 0.5) * 12;
        r = 96 + mow * 0.5 + n; g = 141 + mow + n; b = 62 + mow * 0.4 + n;
      } else if (d < 2.4) {
        const n = (hash(px, py) - 0.5) * 10;
        r = 84 + n; g = 120 + n; b = 56 + n;                       // collar
      } else if (d < 6.5 && m.x < -6 && m.y < -2) {
        const n = (hash(px, py) - 0.5) * 16;
        r = 206 + n; g = 192 + n; b = 152 + n;                      // bunker
      } else {
        const n = (hash(Math.floor(px / 3), Math.floor(py / 3)) - 0.5) * 22;
        const patch = Math.sin(m.x / 5) * Math.cos(m.y / 6) * 9;
        r = 68 + n + patch; g = 92 + n + patch; b = 47 + n + patch; // rough
      }
      const i = (py * bg.width + px) * 3;
      img[i] = Math.max(0, Math.min(255, r));
      img[i + 1] = Math.max(0, Math.min(255, g));
      img[i + 2] = Math.max(0, Math.min(255, b));
    }
  }
  await writeFile(
    path.join(DATA, `h${HOLE}.base.jpg`),
    await sharp(img, { raw: { width: bg.width, height: bg.height, channels: 3 } }).jpeg({ quality: 92 }).toBuffer()
  );
  await writeFile(path.join(DATA, `h${HOLE}.base.json`), JSON.stringify({ kind: "green-surround", label: "synthetic z20" }));

  /* ---- metadata, shaped exactly like a published sidecar ---- */
  await writeFile(path.join(DATA, `h${HOLE}.meta.json`), JSON.stringify({
    width: bg.width, height: bg.height, bounds: baseBounds,
    playSurface: {
      anchorPins: { greenShape: GREEN_SHAPE },
      outputDimensions: { width: bg.width, height: bg.height },
      elevation: {
        path: `fixture/h${HOLE}.elevation.png`, encoding: "terrain-rgb", bounds: elevBounds,
        width: eg.width, height: eg.height, captureZoom: 16, metresPerPixel: MPP,
        elevationRange: { min: lo, max: hi }
      }
    }
  }, null, 2));

  /* A captures index entry so the renderer resolves the base image's geometry the same way it
     will for a real green-surround capture. */
  await writeFile(path.join(DATA, "captures-index.json"), JSON.stringify({
    captures: [{ role: "green-surround", holeNumber: HOLE, captureZoom: 20, width: bg.width, height: bg.height, bounds: baseBounds }]
  }, null, 2));

  console.log(`fixture h${HOLE}: elevation ${eg.width}x${eg.height} @${MPP.toFixed(3)}m/px, aerial ${bg.width}x${bg.height} @0.10m/px`);
  console.log(`heights ${lo.toFixed(1)}..${hi.toFixed(1)}m`);
  console.log("next: node dev/green-slope-preview/render-green-slope.mjs");
}

main().catch(e => { console.error(e); process.exit(1); });
