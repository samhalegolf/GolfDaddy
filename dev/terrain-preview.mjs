#!/usr/bin/env node
/**
 * terrain-preview.mjs — bake shaded relief into a course capture.
 *
 * Fetches LINZ aerial + LINZ elevation (terrain-RGB) tiles for a footprint,
 * decodes the DEM, renders a hillshade and composites it over the aerial.
 * Writes before/after JPEGs so you can eyeball the settings.
 *
 * This is deliberately written against the same mercator maths the visual
 * worker already uses (integer captureZoom + originPx), so the shading can be
 * dropped into functions/lib/gd-visual-export-core.mjs without a second
 * projection model.
 *
 *   node terrain-preview.mjs --key <LINZ_API_KEY> \
 *     --lat -36.7520289829156 --lng 174.752032756805 --zoom 18 --size 1536
 *
 *   Options:
 *     --exag 5          vertical exaggeration
 *     --az 315          light azimuth, degrees clockwise from north
 *     --alt 42          light altitude, degrees above horizon
 *     --ao 0.18         ambient-occlusion mix (0..1)
 *     --opacity 1       relief strength (0..1)
 *     --multi           multidirectional (softer, Swiss-style) lighting
 *     --out ./out
 *
 * Requires: sharp (already a dependency of this repo), Node 18+ for fetch.
 */

import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TILE = 256;

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const next = argv[i + 1];
  return next === undefined || next.startsWith('--') ? true : next;
};
const num = (name, dflt) => {
  const v = arg(name, null);
  return v === null ? dflt : Number(v);
};

const KEY = arg('key', process.env.LINZ_API_KEY);
const LAT = num('lat', -36.7520289829156);   // Pupuke
const LNG = num('lng', 174.752032756805);
const ZOOM = num('zoom', 18);
const SIZE = num('size', 1536);
const OUT = String(arg('out', './out'));

const SHADE = {
  exag: num('exag', 5),
  azimuth: num('az', 315),
  altitude: num('alt', 42),
  ao: num('ao', 0.18),
  opacity: num('opacity', 1),
  multi: arg('multi', false) === true,
  smoothPx: num('smooth', 1.2),
};

if (!KEY) {
  console.error('Need a LINZ API key: --key <key> or LINZ_API_KEY env var.');
  console.error('The app already fetches one from /api/auth-public-config.');
  process.exit(1);
}

// ---------------------------------------------------------------- mercator
// Matches world()/unworld() in functions/lib/gd-visual-export-core.mjs.
const world = (lat, lng) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return {
    x: (lng + 180) / 360,
    y: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI),
  };
};
const metresPerPixel = (lat, zoom) =>
  (156543.03392804097 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;

// ---------------------------------------------------------------- tiles
const AERIAL = (z, x, y) =>
  `https://basemaps.linz.govt.nz/v1/tiles/aerial/WebMercatorQuad/${z}/${x}/${y}.webp?api=${KEY}`;

// LINZ publishes an elevation tileset in terrain-RGB. The tileset slug has
// moved around, so probe rather than hard-code, and cache what worked.
const ELEVATION_CANDIDATES = [
  (z, x, y) => `https://basemaps.linz.govt.nz/v1/tiles/elevation/WebMercatorQuad/${z}/${x}/${y}.png?api=${KEY}`,
  (z, x, y) => `https://basemaps.linz.govt.nz/v1/tiles/elevation.terrain-rgb/WebMercatorQuad/${z}/${x}/${y}.png?api=${KEY}`,
  (z, x, y) => `https://basemaps.linz.govt.nz/v1/tiles/topographic/terrain-rgb/WebMercatorQuad/${z}/${x}/${y}.png?api=${KEY}`,
];
let elevationUrl = null;

async function probeElevation(z, x, y) {
  for (const make of ELEVATION_CANDIDATES) {
    const url = make(z, x, y);
    try {
      const r = await fetch(url);
      if (r.ok) {
        elevationUrl = make;
        console.log(`  elevation tileset: ${url.split('?')[0].replace(/\/\d+\/\d+\/\d+\.png$/, '')}`);
        return Buffer.from(await r.arrayBuffer());
      }
    } catch { /* try next */ }
  }
  throw new Error(
    'No LINZ elevation tileset responded. Check the tileset list at ' +
    'https://basemaps.linz.govt.nz/v1/tiles.json and update ELEVATION_CANDIDATES.'
  );
}

async function getTile(url) {
  const r = await fetch(url);
  if (!r.ok) return null;                       // holes are normal at the edges
  return Buffer.from(await r.arrayBuffer());
}

/** Stitch a tile grid into one raw RGB buffer covering [originPx, originPx+size). */
async function mosaic({ zoom, originPx, size, makeUrl, probe }) {
  const tx0 = Math.floor(originPx.x / TILE);
  const ty0 = Math.floor(originPx.y / TILE);
  const tx1 = Math.floor((originPx.x + size - 1) / TILE);
  const ty1 = Math.floor((originPx.y + size - 1) / TILE);
  const cols = tx1 - tx0 + 1;
  const rows = ty1 - ty0 + 1;

  const composites = [];
  let got = 0;
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      let buf;
      if (probe && !elevationUrl) buf = await probeElevation(zoom, tx, ty);
      else buf = await getTile(makeUrl(zoom, tx, ty));
      if (!buf) continue;
      got++;
      composites.push({
        input: await sharp(buf).toFormat('png').toBuffer(),
        left: (tx - tx0) * TILE,
        top: (ty - ty0) * TILE,
      });
    }
  }
  if (!got) throw new Error(`No tiles returned at z${zoom}`);

  const sheet = sharp({
    create: { width: cols * TILE, height: rows * TILE, channels: 3, background: '#000' },
  }).composite(composites);

  return sharp(await sheet.png().toBuffer())
    .extract({
      left: Math.round(originPx.x - tx0 * TILE),
      top: Math.round(originPx.y - ty0 * TILE),
      width: size,
      height: size,
    })
    .raw()
    .toBuffer({ resolveWithObject: true });
}

// ---------------------------------------------------------------- DEM decode
/**
 * Terrain-RGB (Mapbox): h = -10000 + (R*65536 + G*256 + B) * 0.1
 * Terrarium (Mapzen):   h = (R*256 + G + B/256) - 32768
 * Auto-detect by which one lands inside a plausible NZ range.
 */
function decodeDem(raw, w, h, channels) {
  const mapbox = new Float32Array(w * h);
  const terrarium = new Float32Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += channels) {
    const R = raw[p], G = raw[p + 1], B = raw[p + 2];
    mapbox[i] = -10000 + (R * 65536 + G * 256 + B) * 0.1;
    terrarium[i] = R * 256 + G + B / 256 - 32768;
  }
  const plausible = (a) => {
    let lo = Infinity, hi = -Infinity;
    for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v; }
    return { lo, hi, ok: lo > -50 && hi < 4000 && hi - lo < 2500 };
  };
  const m = plausible(mapbox), t = plausible(terrarium);
  if (m.ok && !t.ok) return { z: mapbox, encoding: 'terrain-rgb', ...m };
  if (t.ok && !m.ok) return { z: terrarium, encoding: 'terrarium', ...t };
  if (m.ok) return { z: mapbox, encoding: 'terrain-rgb', ...m };
  throw new Error(
    `DEM decode failed. terrain-rgb ${m.lo.toFixed(0)}..${m.hi.toFixed(0)}m, ` +
    `terrarium ${t.lo.toFixed(0)}..${t.hi.toFixed(0)}m — neither looks like NZ land.`
  );
}

// ---------------------------------------------------------------- shading
function gaussianBlur(src, w, h, sigma) {
  if (sigma <= 0) return src;
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v; sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = Math.min(w - 1, Math.max(0, x + k));
        acc += src[y * w + xx] * kernel[k + radius];
      }
      tmp[y * w + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k));
        acc += tmp[yy * w + x] * kernel[k + radius];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

function hillshade(z, w, h, mpp, opts) {
  const { exag, azimuth, altitude, multi, smoothPx } = opts;
  const s = gaussianBlur(z, w, h, smoothPx);
  const zen = ((90 - altitude) * Math.PI) / 180;
  const cosZen = Math.cos(zen), sinZen = Math.sin(zen);

  const lights = multi
    ? [[azimuth - 45, 0.25], [azimuth, 0.35], [azimuth + 45, 0.25], [azimuth + 180, 0.15]]
    : [[azimuth, 1]];
  const rads = lights.map(([a, wgt]) => [((360 - a + 90) * Math.PI) / 180, wgt]);

  const out = new Float32Array(w * h);
  const at = (x, y) => s[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // central differences, scaled to metres
      const dzdx = ((at(x + 1, y) - at(x - 1, y)) * exag) / (2 * mpp);
      const dzdy = ((at(x, y + 1) - at(x, y - 1)) * exag) / (2 * mpp);
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(dzdy, -dzdx);
      let v = 0;
      for (const [a, wgt] of rads) {
        v += wgt * (cosZen * Math.cos(slope) + sinZen * Math.sin(slope) * Math.cos(a - aspect));
      }
      out[y * w + x] = Math.min(1, Math.max(0, v));
    }
  }
  return out;
}

/** Cheap ambient occlusion: how far a point sits below its neighbourhood mean. */
function ambientOcclusion(z, w, h, exag, radiusPx = 28) {
  const local = gaussianBlur(z, w, h, radiusPx / 3);
  const d = new Float32Array(w * h);
  let mean = 0;
  for (let i = 0; i < d.length; i++) { d[i] = (z[i] - local[i]) * exag; mean += d[i]; }
  mean /= d.length;
  let varr = 0;
  for (const v of d) varr += (v - mean) ** 2;
  const sd = Math.sqrt(varr / d.length) || 1;
  const out = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) out[i] = Math.min(1, Math.max(0, 0.5 + d[i] / (4 * sd)));
  return out;
}

/** W3C soft-light: shade < 0.5 darkens, > 0.5 lightens. Preserves base hue. */
function softLight(b, s) {
  const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
  return s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * (d - b);
}

function composite(aerial, w, h, channels, shade) {
  const out = Buffer.alloc(w * h * 3);
  for (let i = 0, p = 0, q = 0; i < w * h; i++, p += channels, q += 3) {
    const s = shade[i];
    for (let c = 0; c < 3; c++) {
      out[q + c] = Math.round(255 * softLight(aerial[p + c] / 255, s));
    }
  }
  return out;
}

// ---------------------------------------------------------------- main
(async () => {
  await mkdir(OUT, { recursive: true });

  const scalePx = TILE * 2 ** ZOOM;
  const centre = world(LAT, LNG);
  const originPx = {
    x: Math.round(centre.x * scalePx - SIZE / 2),
    y: Math.round(centre.y * scalePx - SIZE / 2),
  };
  const mpp = metresPerPixel(LAT, ZOOM);

  console.log(`Footprint: ${SIZE}x${SIZE}px @ z${ZOOM}  (${(SIZE * mpp).toFixed(0)}m across, ${mpp.toFixed(2)} m/px)`);

  console.log('Fetching aerial…');
  const aerial = await mosaic({ zoom: ZOOM, originPx, size: SIZE, makeUrl: AERIAL });

  // The DEM is almost certainly published at a lower max zoom than the aerial.
  // Fetch at the deepest zoom that answers, then upscale — hillshade wants a
  // smooth surface anyway, so this costs nothing visually.
  console.log('Fetching elevation…');
  let dem = null, demZoom = ZOOM;
  for (; demZoom >= ZOOM - 6; demZoom--) {
    const f = 2 ** (demZoom - ZOOM);
    const o = { x: Math.round(originPx.x * f), y: Math.round(originPx.y * f) };
    const sz = Math.max(64, Math.round(SIZE * f));
    try {
      dem = await mosaic({ zoom: demZoom, originPx: o, size: sz, makeUrl: (z, x, y) => elevationUrl(z, x, y), probe: true });
      break;
    } catch (e) {
      elevationUrl = null;
      if (demZoom === ZOOM - 6) throw e;
    }
  }
  console.log(`  DEM native zoom: z${demZoom} (${dem.info.width}px)`);

  const decoded = decodeDem(dem.data, dem.info.width, dem.info.height, dem.info.channels);
  console.log(`  encoding: ${decoded.encoding}   elevation ${decoded.lo.toFixed(1)}..${decoded.hi.toFixed(1)}m   relief ${(decoded.hi - decoded.lo).toFixed(1)}m`);

  // upsample DEM to the aerial grid (bilinear)
  const dw = dem.info.width, dh = dem.info.height;
  const z = new Float32Array(SIZE * SIZE);
  const sx = dw / SIZE, sy = dh / SIZE;
  for (let y = 0; y < SIZE; y++) {
    const fy = Math.min(dh - 1.001, y * sy), y0 = Math.floor(fy), ty = fy - y0;
    for (let x = 0; x < SIZE; x++) {
      const fx = Math.min(dw - 1.001, x * sx), x0 = Math.floor(fx), tx = fx - x0;
      const a = decoded.z[y0 * dw + x0], b = decoded.z[y0 * dw + x0 + 1];
      const c = decoded.z[(y0 + 1) * dw + x0], d = decoded.z[(y0 + 1) * dw + x0 + 1];
      z[y * SIZE + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }

  // Terrain-RGB quantises to 0.1 m steps. Once you exaggerate 5x and upsample
  // from a coarser DEM zoom, those steps show up as concentric contour rings —
  // the terrain looks like a topographic map, not a moulded surface. Smooth in
  // proportion to the upsample factor so the quantisation is below the noise
  // floor of the gradient. This is the single setting that makes or breaks it.
  const upsample = SIZE / dw;
  const effSmooth = Math.max(SHADE.smoothPx, SHADE.smoothPx * upsample);
  console.log(`Shading  exag=${SHADE.exag} az=${SHADE.azimuth} alt=${SHADE.altitude} ao=${SHADE.ao} multi=${SHADE.multi}`);
  console.log(`  upsample ${upsample.toFixed(1)}x -> smoothing sigma ${effSmooth.toFixed(1)}px (anti-terracing)`);
  let shade = hillshade(z, SIZE, SIZE, mpp, { ...SHADE, smoothPx: effSmooth });
  if (SHADE.ao > 0) {
    const ao = ambientOcclusion(z, SIZE, SIZE, SHADE.exag);
    for (let i = 0; i < shade.length; i++) shade[i] = shade[i] * (1 - SHADE.ao) + ao[i] * SHADE.ao;
  }
  if (SHADE.opacity !== 1) {
    for (let i = 0; i < shade.length; i++) shade[i] = 0.5 + (shade[i] - 0.5) * SHADE.opacity;
  }

  const before = path.join(OUT, 'before.jpg');
  const after = path.join(OUT, 'after.jpg');
  const shadeOnly = path.join(OUT, 'hillshade.jpg');

  await sharp(aerial.data, { raw: { width: SIZE, height: SIZE, channels: aerial.info.channels } })
    .jpeg({ quality: 92 }).toFile(before);

  const blended = composite(aerial.data, SIZE, SIZE, aerial.info.channels, shade);
  await sharp(blended, { raw: { width: SIZE, height: SIZE, channels: 3 } })
    .jpeg({ quality: 92 }).toFile(after);

  const grey = Buffer.alloc(SIZE * SIZE);
  for (let i = 0; i < shade.length; i++) grey[i] = Math.round(shade[i] * 255);
  await sharp(grey, { raw: { width: SIZE, height: SIZE, channels: 1 } })
    .jpeg({ quality: 92 }).toFile(shadeOnly);

  await writeFile(path.join(OUT, 'meta.json'), JSON.stringify({
    lat: LAT, lng: LNG, captureZoom: ZOOM, originPx, outputDimensions: { width: SIZE, height: SIZE },
    metresPerPixel: mpp, demZoom, demEncoding: decoded.encoding,
    elevation: { min: decoded.lo, max: decoded.hi }, shade: SHADE,
  }, null, 2));

  console.log(`\nWrote:\n  ${before}\n  ${after}\n  ${shadeOnly}\n  ${path.join(OUT, 'meta.json')}`);
})().catch((e) => { console.error('\n' + e.message); process.exit(1); });
