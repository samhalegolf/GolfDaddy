/* Measures a course's own colours for its Watch map palette (scripts/gd-watch-palette-core.js).

   courseSurfaces  - every mapped surface on the course, as lat/lng rings, from objects_json.
   sampleAerial    - the satellite bake's published hole photos: each is a north-up mercator
                     frame where a lat/lng lands at worldPx(lat, lng, captureZoom) - originPx
                     (the same rule app/js/painter.js places it with), so the course's own
                     shapes can be laid on its pixels exactly. Rough, fairway, green, sand and
                     water are measured from the pixels well inside (or, for rough, just
                     outside) those shapes.

   Sentinel-2's seasonal record is gathered by gd-sentinel-seasons.mjs and combined with this
   in the palette core. Nothing here keeps a pixel - only the measured medians leave. */

import sharp from "sharp";
import watchMapCore from "../../scripts/gd-watch-map-core.js";
import paletteCore from "../../scripts/gd-watch-palette-core.js";
import { makeClassifier, pointInRing, distanceToRing } from "./gd-sentinel-seasons.mjs";

const TEE_RADIUS_M = 12;
/* Aerial pixels are ~0.1-0.3m, so the edge margins can be tight: far enough in that a
   slightly-off outline never samples the neighbouring surface. */
const AERIAL_EDGE_M = { fairway: 1.5, green: 1, bunker: 1, water: 2 };
const ROUGH_BAND_M = { min: 10, max: 35 };
/* Per frame, about this many pixels are tested - a palette is a distribution. */
const TEST_PIXELS_PER_FRAME = 60000;

function circle(center, radiusM) {
  const ring = [];
  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * Math.cos(center.lat * Math.PI / 180));
  for (let i = 0; i < 16; i++) {
    const t = (i / 16) * 2 * Math.PI;
    ring.push({ lat: center.lat + dLat * Math.sin(t), lng: center.lng + dLng * Math.cos(t) });
  }
  return ring;
}

/* All surfaces of every hole, de-duplicated (a fairway ribbon shared by two holes is one
   fairway), plus the course's bounds. Tees are points in the data, so they become small
   circles: ground to keep the rough measurement off, never something to measure. */
export function courseSurfaces(objectsJson, holeNumbers) {
  const seen = new Set();
  const rings = { fairways: [], greens: [], bunkers: [], water: [], tees: [] };
  const add = (bucket, ring) => {
    if (!Array.isArray(ring) || ring.length < 3) return;
    const key = JSON.stringify(ring);
    if (seen.has(key)) return;
    seen.add(key);
    rings[bucket].push(ring);
  };
  (holeNumbers || []).forEach(n => {
    const g = watchMapCore.objectsForHole(objectsJson, n);
    g.fairways.forEach(r => add("fairways", r));
    g.bunkers.forEach(r => add("bunkers", r));
    g.water.forEach(r => add("water", r));
    if (g.greenShape) add("greens", g.greenShape);
    if (g.tee) add("tees", circle(g.tee, TEE_RADIUS_M));
  });
  let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
  Object.values(rings).forEach(list => list.forEach(ring => ring.forEach(p => {
    if (p.lat < south) south = p.lat; if (p.lat > north) north = p.lat;
    if (p.lng < west) west = p.lng; if (p.lng > east) east = p.lng;
  })));
  const bounds = Number.isFinite(south) ? { south, west, north, east } : null;
  return { rings, bounds };
}

/* Which surface a frame point (in metres) should be measured as, or null. Small surfaces
   first - a bunker inside a fairway's outline is sand, not fairway - then fairway and rough. */
export function makeAerialClassifier(rings) {
  const deep = (list, edge) => list.filter(r => r.length >= 3).map(r => ({ r, edge }));
  const small = [].concat(
    deep(rings.bunkers || [], AERIAL_EDGE_M.bunker).map(o => Object.assign(o, { role: "bunker" })),
    deep(rings.greens || [], AERIAL_EDGE_M.green).map(o => Object.assign(o, { role: "green" })),
    deep(rings.water || [], AERIAL_EDGE_M.water).map(o => Object.assign(o, { role: "water" }))
  );
  const turf = makeClassifier(rings, AERIAL_EDGE_M.fairway, ROUGH_BAND_M);
  return function classify(x, y) {
    for (const o of small) {
      if (!pointInRing(x, y, o.r)) continue;
      return distanceToRing(x, y, o.r) >= o.edge ? o.role : null;
    }
    return turf(x, y);
  };
}

/* frames: [{ buffer, captureZoom, originPx: {x, y} }] - the published hole photos.
   Returns per-role measurements ({L, a, b, n} or null) pooled across every frame. */
export async function sampleAerial(frames, surfaces) {
  const rgb = { rough: [], fairway: [], green: [], bunker: [], water: [] };
  for (const frame of frames || []) {
    const z = Number(frame.captureZoom);
    if (!Number.isInteger(z) || !frame.originPx || !frame.buffer) continue;
    const { data, info } = await sharp(frame.buffer, { limitInputPixels: false }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const ox = Number(frame.originPx.x), oy = Number(frame.originPx.y);
    /* Metres per frame pixel at this frame's latitude - near enough constant across one hole. */
    const midY = oy + info.height / 2;
    const latMid = (Math.atan(Math.sinh(Math.PI * (1 - 2 * midY / (256 * Math.pow(2, z))))) * 180) / Math.PI;
    const mpp = 156543.03392 * Math.cos(latMid * Math.PI / 180) / Math.pow(2, z);
    const toFrameM = ring => ring.map(p => {
      const w = watchMapCore.worldPx(p.lat, p.lng, z);
      return { x: (w.x - ox) * mpp, y: (w.y - oy) * mpp };
    });
    const rings = {};
    Object.keys(surfaces.rings).forEach(k => { rings[k] = surfaces.rings[k].map(toFrameM); });
    const classify = makeAerialClassifier(rings);
    const stride = Math.max(1, Math.round(Math.sqrt((info.width * info.height) / TEST_PIXELS_PER_FRAME)));
    for (let y = 0; y < info.height; y += stride) {
      for (let x = 0; x < info.width; x += stride) {
        const role = classify((x + 0.5) * mpp, (y + 0.5) * mpp);
        if (!role) continue;
        const o = (y * info.width + x) * info.channels;
        const r = data[o], g = data[o + 1], b = data[o + 2];
        /* The frame's void behind missing captures is near-black - never a surface. */
        if (r + g + b < 60) continue;
        rgb[role].push(r, g, b);
      }
    }
  }
  const out = {};
  Object.keys(rgb).forEach(role => { out[role] = paletteCore.summariseSamples(rgb[role], role); });
  return out;
}
