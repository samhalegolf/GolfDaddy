/* Sentinel-2 seasonal colour sampler for Watch map palettes.

   The course's own aerial photos are sharp but are one day - usually a summer flight - so a
   palette tinted from them alone describes that day. Sentinel-2 (ESA Copernicus) revisits
   every course about every five days, all year, so it can say what the turf looks like across
   the seasons. One pixel is 10m, far too coarse to draw with, but a course is thousands of
   them, which is plenty to measure a colour.

   What this keeps: a handful of measured colours per month (see gd-watch-palette-core.js).
   What it never keeps: a single satellite pixel. Copernicus data is free and open, commercial
   use included; anything derived from it carries ATTRIBUTION.

   Source: Element 84's Earth Search STAC (sentinel-2-c1-l2a on the AWS Open Data registry).
   Each scene carries a "visual" true-colour COG (10m, 8-bit RGB) and an "scl" scene
   classification COG (20m) that marks cloud, cloud shadow and snow - only pixels SCL calls
   vegetation or bare soil are measured, so a cloudy edge or a frosty morning cannot tint
   the map. Only small windows over the course are read, via HTTP range requests. */

import paletteCore from "../../scripts/gd-watch-palette-core.js";

export const STAC_SEARCH_URL = "https://earth-search.aws.element84.com/v1/search";
export const COLLECTION = "sentinel-2-c1-l2a";
export const ATTRIBUTION = "Contains modified Copernicus Sentinel data";

/* Two years of history, one scene per calendar month (the least cloudy that covers the whole
   course), scenes over 40% cloud never considered. */
const HISTORY_MONTHS = 24;
const MAX_SCENE_CLOUD = 40;
/* SCL classes that are ground we can read: 4 vegetation, 5 not-vegetated (dry or dormant turf). */
const CLEAR_SCL = new Set([4, 5]);
/* A 10m cell is only "fairway" when it sits wholly inside the fairway - its centre at least
   half a diagonal from the edge - so mixed edge cells never blend rough into the measurement. */
const CELL_HALF_DIAGONAL_M = 7.1;
/* Rough is the band just outside the fairways, clear of every other surface. */
const ROUGH_BAND_M = { min: 10, max: 35 };

// ------------------------------------------------------------------ UTM (WGS84)

/* Krüger series transverse mercator, the same maths EPSG:326xx/327xx use. Accurate to well
   under a millimetre inside a zone - far finer than a 10m pixel. */
export function utmForward(lat, lng, zone, south) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
  const n = f / (2 - f);
  const A = a / (1 + n) * (1 + n * n / 4 + Math.pow(n, 4) / 64);
  const alpha = [n / 2 - 2 * n * n / 3 + 5 * n * n * n / 16, 13 * n * n / 48 - 3 * n * n * n / 5, 61 * n * n * n / 240];
  const phi = lat * Math.PI / 180;
  const dLam = (lng - ((zone - 1) * 6 - 180 + 3)) * Math.PI / 180;
  const e2n = 2 * Math.sqrt(n) / (1 + n);
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - e2n * Math.atanh(e2n * Math.sin(phi)));
  const xiP = Math.atan2(t, Math.cos(dLam));
  const etaP = Math.atanh(Math.sin(dLam) / Math.sqrt(1 + t * t));
  let xi = xiP, eta = etaP;
  for (let j = 1; j <= 3; j++) {
    xi += alpha[j - 1] * Math.sin(2 * j * xiP) * Math.cosh(2 * j * etaP);
    eta += alpha[j - 1] * Math.cos(2 * j * xiP) * Math.sinh(2 * j * etaP);
  }
  return { x: 500000 + k0 * A * eta, y: (south ? 10000000 : 0) + k0 * A * xi };
}

/* EPSG:326zz is UTM north, 327zz south. Anything else is not a Sentinel-2 grid. */
export function utmZoneOf(epsg) {
  const code = Number(String(epsg || "").replace(/^EPSG:/i, ""));
  if (code >= 32601 && code <= 32660) return { zone: code - 32600, south: false };
  if (code >= 32701 && code <= 32760) return { zone: code - 32700, south: true };
  return null;
}

function itemEpsg(item) {
  const p = item && item.properties || {};
  return p["proj:epsg"] || p["proj:code"] || null;
}

// ------------------------------------------------------------------ geometry

export function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function distanceToRing(x, y, ring) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0;
    const d = Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
    if (d < best) best = d;
  }
  return best;
}

function boxOf(ring, pad) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  ring.forEach(p => { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; });
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}
function inBox(x, y, b) { return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY; }

/* Every surface of the course, as rings in some planar metre space (UTM here, frame pixels
   scaled to metres for the aerial sampler). Returns which role a point belongs to for
   measuring, or null: "fairway" only well inside a fairway; "rough" only in the band outside
   the fairways and clear of greens, bunkers, water and tees. */
export function makeClassifier(rings, edgeM, roughBand) {
  const pad = Math.max(edgeM, roughBand.max);
  const fairways = (rings.fairways || []).filter(r => r.length >= 3).map(r => ({ r, box: boxOf(r, pad) }));
  const others = [].concat(rings.greens || [], rings.bunkers || [], rings.water || [], rings.tees || [])
    .filter(r => r.length >= 3).map(r => ({ r, box: boxOf(r, edgeM) }));
  return function classify(x, y) {
    for (const o of others) {
      if (!inBox(x, y, o.box)) continue;
      if (pointInRing(x, y, o.r) || distanceToRing(x, y, o.r) < edgeM) return null;
    }
    let nearest = Infinity;
    for (const f of fairways) {
      if (!inBox(x, y, f.box)) continue;
      const d = distanceToRing(x, y, f.r);
      if (pointInRing(x, y, f.r)) return d >= edgeM ? "fairway" : null;
      if (d < nearest) nearest = d;
    }
    return nearest >= roughBand.min && nearest <= roughBand.max ? "rough" : null;
  };
}

// ------------------------------------------------------------------ STAC search

function bboxContains(outer, inner) {
  return outer && outer[0] <= inner.west && outer[1] <= inner.south && outer[2] >= inner.east && outer[3] >= inner.north;
}

/* The least cloudy scene per calendar month over the last HISTORY_MONTHS that covers the
   whole course, newest month first. `skipMonths` lets a resumed run fetch only what it lacks. */
export async function searchScenes(bounds, { now = Date.now(), fetchImpl = fetch, skipMonths = [] } = {}) {
  const end = new Date(now);
  const start = new Date(now);
  start.setUTCMonth(start.getUTCMonth() - HISTORY_MONTHS);
  let body = {
    collections: [COLLECTION],
    bbox: [bounds.west, bounds.south, bounds.east, bounds.north],
    datetime: start.toISOString() + "/" + end.toISOString(),
    query: { "eo:cloud_cover": { lt: MAX_SCENE_CLOUD } },
    limit: 100
  };
  const items = [];
  let url = STAC_SEARCH_URL;
  for (let page = 0; page < 8 && url; page++) {
    const response = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/geo+json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error("Sentinel-2 search " + response.status);
    const data = await response.json();
    (data.features || []).forEach(f => items.push(f));
    const next = (data.links || []).find(l => l.rel === "next");
    if (!next) break;
    url = next.href;
    if (next.body) body = next.body;
  }
  const byMonth = new Map();
  items.forEach(item => {
    const when = item.properties && item.properties.datetime;
    const cloud = Number(item.properties && item.properties["eo:cloud_cover"]);
    if (!when || !bboxContains(item.bbox, bounds) || !utmZoneOf(itemEpsg(item))) return;
    if (!item.assets || !item.assets.visual || !item.assets.scl) return;
    const month = String(when).slice(0, 7);
    if (skipMonths.includes(month)) return;
    const held = byMonth.get(month);
    if (!held || cloud < Number(held.properties["eo:cloud_cover"])) byMonth.set(month, item);
  });
  return Array.from(byMonth.entries()).sort((x, y) => (x[0] < y[0] ? 1 : -1)).map(([month, item]) => ({ month, item }));
}

// ------------------------------------------------------------------ one scene

/* Reads only the course's window of a COG. `openTiff(href)` resolves to a geotiff.js GeoTIFF;
   injected so tests never touch the network. */
async function readWindow(openTiff, href, utmBox) {
  const tiff = await openTiff(href);
  const image = await tiff.getImage();
  const [ox, oy] = image.getOrigin();
  const [rx, ry] = image.getResolution();
  const w = image.getWidth(), h = image.getHeight();
  const x0 = Math.max(0, Math.floor((utmBox.minX - ox) / rx));
  const x1 = Math.min(w, Math.ceil((utmBox.maxX - ox) / rx));
  const y0 = Math.max(0, Math.floor((utmBox.maxY - oy) / ry));
  const y1 = Math.min(h, Math.ceil((utmBox.minY - oy) / ry));
  if (!(x1 > x0 && y1 > y0)) return null;
  const data = await image.readRasters({ window: [x0, y0, x1, y1], interleave: true });
  return { data, x0, y0, width: x1 - x0, height: y1 - y0, ox, oy, rx, ry, bands: image.getSamplesPerPixel() };
}

/* Measures one scene: fairway and rough colours from clear 10m cells, or null per role when
   the scene had too few of them (cloud over the course, mostly). */
export async function sampleScene(item, courseLatLng, openTiff) {
  const utm = utmZoneOf(itemEpsg(item));
  if (!utm) return null;
  const project = ring => ring.map(p => utmForward(p.lat, p.lng, utm.zone, utm.south));
  const rings = {};
  Object.keys(courseLatLng.rings).forEach(k => { rings[k] = courseLatLng.rings[k].map(project); });
  const corners = [
    utmForward(courseLatLng.bounds.south, courseLatLng.bounds.west, utm.zone, utm.south),
    utmForward(courseLatLng.bounds.north, courseLatLng.bounds.east, utm.zone, utm.south),
    utmForward(courseLatLng.bounds.south, courseLatLng.bounds.east, utm.zone, utm.south),
    utmForward(courseLatLng.bounds.north, courseLatLng.bounds.west, utm.zone, utm.south)
  ];
  const box = boxOf(corners, ROUGH_BAND_M.max);
  const visual = await readWindow(openTiff, item.assets.visual.href, box);
  const scl = await readWindow(openTiff, item.assets.scl.href, box);
  if (!visual || !scl || visual.bands < 3) return null;

  const classify = makeClassifier(rings, CELL_HALF_DIAGONAL_M, ROUGH_BAND_M);
  const rgb = { fairway: [], rough: [] };
  for (let row = 0; row < visual.height; row++) {
    for (let col = 0; col < visual.width; col++) {
      const x = visual.ox + (visual.x0 + col + 0.5) * visual.rx;
      const y = visual.oy + (visual.y0 + row + 0.5) * visual.ry;
      const sc = Math.floor((x - scl.ox) / scl.rx) - scl.x0;
      const sr = Math.floor((y - scl.oy) / scl.ry) - scl.y0;
      if (sc < 0 || sr < 0 || sc >= scl.width || sr >= scl.height) continue;
      if (!CLEAR_SCL.has(scl.data[(sr * scl.width + sc) * scl.bands])) continue;
      const o = (row * visual.width + col) * visual.bands;
      const r = visual.data[o], g = visual.data[o + 1], b = visual.data[o + 2];
      if (!r && !g && !b) continue;
      const role = classify(x, y);
      if (role) rgb[role].push(r, g, b);
    }
  }
  return {
    fairway: paletteCore.summariseSamples(rgb.fairway, "fairway"),
    rough: paletteCore.summariseSamples(rgb.rough, "rough")
  };
}

// ------------------------------------------------------------------ the course

/* Builds (or extends) the course's monthly record. `previous` is the stored record; months it
   already holds are not fetched again, so a run cut short by the deadline is finished by the
   next bake instead of starting over. Returns the record to store - never throws for a scene
   that fails, only for a search that does. */
export async function sampleCourseSeasons(courseLatLng, { previous = null, now = Date.now(), deadlineMs = 60000, fetchImpl = fetch, openTiff } = {}) {
  if (typeof openTiff !== "function") throw new Error("openTiff is required");
  const startedAt = Date.now();
  const keep = previous && previous.version === 1 && previous.boundsKey === boundsKey(courseLatLng.bounds) ? previous : null;
  const months = Object.assign({}, keep && keep.months || {});
  const scenes = (keep && keep.scenes || []).slice();
  const tried = new Set(scenes.map(s => s.month));
  const found = await searchScenes(courseLatLng.bounds, { now, fetchImpl, skipMonths: Array.from(tried) });
  let complete = true;
  for (const { month, item } of found) {
    if (Date.now() - startedAt > deadlineMs) { complete = false; break; }
    let measured = null;
    try { measured = await sampleScene(item, courseLatLng, openTiff); } catch (error) { measured = null; }
    scenes.push({ month, id: item.id, cloud: Number(item.properties["eo:cloud_cover"]), ok: !!(measured && (measured.fairway || measured.rough)) });
    if (measured && (measured.fairway || measured.rough)) months[month] = measured;
  }
  /* Months older than the window fall away, so the record is always "the last two years". */
  const oldest = new Date(now); oldest.setUTCMonth(oldest.getUTCMonth() - HISTORY_MONTHS);
  const floor = oldest.toISOString().slice(0, 7);
  Object.keys(months).forEach(m => { if (m < floor) delete months[m]; });
  return {
    version: 1,
    source: COLLECTION,
    attribution: ATTRIBUTION + " " + yearsLabel(Object.keys(months)),
    boundsKey: boundsKey(courseLatLng.bounds),
    updatedAt: new Date(now).toISOString(),
    complete,
    months,
    scenes: scenes.filter(s => s.month >= floor)
  };
}

export function boundsKey(b) {
  return [b.south, b.west, b.north, b.east].map(v => Number(v).toFixed(4)).join(",");
}

function yearsLabel(months) {
  const years = Array.from(new Set(months.map(m => m.slice(0, 4)))).sort();
  if (!years.length) return "";
  return years.length === 1 ? years[0] : years[0] + "–" + years[years.length - 1];
}

/* Is a stored record still good enough to use as-is? Fresh within 60 days, same ground, and
   either finished or with nothing left it could add. */
export function seasonsAreFresh(record, bounds, now = Date.now()) {
  if (!record || record.version !== 1 || record.boundsKey !== boundsKey(bounds)) return false;
  if (!record.complete) return false;
  return now - Date.parse(record.updatedAt) < 60 * 24 * 3600 * 1000;
}

export const __test = { bboxContains, readWindow, yearsLabel };
