/* Trees along the fairways and greens, found without anyone in Studio: the server half of
 * "Find trees near play" (scripts/studio/courses/map-overlay/map-overlay-shapes.js does the
 * finding, here and in the browser alike).
 *
 * A course's trees are their own layer (the course_trees table), not shapes in its overlay
 * and not objects in course_maps: a tree-lined course holds thousands, only the watch reads
 * them, and both of those are synced whole elsewhere. Each tree is stored with the strictest
 * sensitivity that finds it (shapes.nestedTrees), so the row holds every level at once and
 * Studio's More / Less step through them with nothing read again. The trees live on the watch
 * are the ones at the row's level.
 *
 * Where the pictures come from: the hole's own published frame when the course has one (the
 * pixels are already ours - nothing is fetched again), otherwise Esri World Imagery, fetched
 * for the run and dropped as soon as it has been read. Only the tree positions are kept.
 *
 * Pure apart from what is passed in (sharp, the fetchers), so dev/course-trees-core.test.js
 * runs it on synthetic pictures. */

import shapes from "../../scripts/studio/courses/map-overlay/map-overlay-shapes.js";
import { stitchPlan, stitch, georefFor, latLngToPixel, pixelToLatLng } from "./gd-tile-mosaic-core.mjs";
import { fetchTileBytes } from "./gd-tile-fetch.mjs";

export const TREES_TABLE = "course_trees";
/* Bumped when the finder changes enough that an automatic run is worth doing again. */
export const TREE_RUN_VERSION = 1;
/* The sensitivity a fresh run goes live at - Studio's default (shapes.TREE_FINDER_LEVELS[2]). */
export const TREE_DEFAULT_LEVEL = 2;
/* Every picture is read at about Studio's near-play resolution, so a run here and a run in
   Studio find the same trees: a frame baked finer is scaled down to it. */
export const TREE_PICTURE_MPP = 0.45;
/* A hole holds far more than the box finder's 150. */
const TREE_HOLE_MAX = 800;
/* Esri pictures: the zoom nearest TREE_PICTURE_MPP, no finer than its own imagery, within a
   tile budget per hole. */
const ESRI_MAX_ZOOM = 19;
const ESRI_MAX_TILES = 400;
const TEE_RADIUS_M = 6;
const R = 6378137;

const SURFACE_OBJECT_TYPES = new Set(["fairway_area", "bunker", "water", "waste"]);

function point(p) {
  const lat = Number(p && p.lat), lng = Number(p && p.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}
function ring(shape) {
  const out = (Array.isArray(shape) ? shape : []).map(point).filter(Boolean);
  return out.length >= 3 ? out : null;
}
function ringKey(r) { return r.length + ":" + r[0].lat.toFixed(7) + "," + r[0].lng.toFixed(7); }

/* What a run needs from course_maps.objects_json: for each hole, the shapes looked along (its
   fairways and green), and for the whole course the turf (every fairway and green), the
   surfaces a tree keeps clear of, and the woods already drawn. Surfaces are stored once per
   hole they show on, so the same one comes back several times - kept once. */
export function courseTreeInputs(objectsJson) {
  const play = new Map(), turf = [], surfaces = [], woods = [], seen = new Set();
  const once = (list, r) => { const k = ringKey(r); if (seen.has(k)) return; seen.add(k); list.push(r); };
  Object.values(objectsJson || {}).forEach(o => {
    if (!o) return;
    const hole = Number(o.holeNumber);
    let r = null;
    if (o.type === "green") r = ring(o.greenShape || o.shape) || (point(o.position) ? shapes.circle(point(o.position), shapes.GREEN_RADIUS_M, 16) : null);
    else if (o.type === "tee") r = point(o.position) ? shapes.circle(point(o.position), TEE_RADIUS_M, 12) : null;
    else if (SURFACE_OBJECT_TYPES.has(o.type) || o.type === "trees") r = ring(o.shape);
    if (!r) return;
    if (o.type === "trees") { once(woods, r); return; }
    if (o.type === "green" || o.type === "fairway_area") {
      if (Number.isFinite(hole) && hole > 0) {
        if (!play.has(hole)) play.set(hole, []);
        if (!play.get(hole).some(x => ringKey(x) === ringKey(r))) play.get(hole).push(r);
      }
      const k = ringKey(r);
      if (!seen.has("t" + k)) { seen.add("t" + k); turf.push(r); }
    }
    once(surfaces, r);
  });
  return { holes: [...play.keys()].sort((a, b) => a - b), play, turf, surfaces, woods };
}

/* The box round a hole's play shapes, padded by padM. */
export function holeBounds(rings, padM) {
  const pts = [].concat(...rings);
  const north = Math.max(...pts.map(p => p.lat)), south = Math.min(...pts.map(p => p.lat));
  const east = Math.max(...pts.map(p => p.lng)), west = Math.min(...pts.map(p => p.lng));
  const dLat = padM / 111320, dLng = padM / (111320 * Math.cos((north + south) / 2 * Math.PI / 180));
  return { north: north + dLat, south: south - dLat, east: east + dLng, west: west - dLng };
}

/* A picture's ground: metres a pixel at its middle, and the box it covers. */
function pictureGround(picture) {
  const georef = { playSurface: picture.playSurface };
  const nw = pixelToLatLng(georef, { x: 0, y: 0 }), se = pixelToLatLng(georef, { x: picture.width, y: picture.height });
  const lat = (nw.lat + se.lat) / 2;
  return { mpp: 2 * Math.PI * R * Math.cos(lat * Math.PI / 180) / (256 * Math.pow(2, picture.playSurface.captureZoom)), bounds: { north: nw.lat, south: se.lat, west: nw.lng, east: se.lng } };
}

/* A stored frame (any format sharp reads, and its playSurface) as a picture the finder reads,
   scaled down to about TREE_PICTURE_MPP. Scaling folds into the georeference exactly as the
   stitcher's own resize does (gd-tile-mosaic-core georefFor): half the pixels is one zoom
   level down, and the origin scales with it. */
export async function frameAsPicture(buffer, playSurface, sharp) {
  const meta = await sharp(buffer).metadata();
  const ground = pictureGround({ width: meta.width, height: meta.height, playSurface });
  const scale = Math.min(1, ground.mpp / TREE_PICTURE_MPP);
  const width = Math.max(1, Math.round(meta.width * scale));
  const height = Math.max(1, Math.round(meta.height * width / meta.width));
  const s = width / meta.width;
  const { data, info } = await sharp(buffer, { limitInputPixels: false }).resize(width, height, { fit: "fill" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length),
    playSurface: { originPx: { x: playSurface.originPx.x * s, y: playSurface.originPx.y * s }, captureZoom: playSurface.captureZoom + Math.log2(s), outputDimensions: { width, height } }
  };
}

export function esriTileUrl(t, key) {
  /* Esri's order is {z}/{y}/{x} - y before x. */
  return "https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/" + t.z + "/" + t.y + "/" + t.x + "?token=" + encodeURIComponent(key);
}

/* Esri World Imagery over a box, as a picture the finder reads. Fetched for this run only:
   the pixels are read and dropped, never stored. */
export async function esriPicture(bounds, { key, sharp, fetchImpl = fetch }) {
  if (!key) throw new Error("no Esri key (ARCGIS_API_KEY)");
  const lat = (bounds.north + bounds.south) / 2;
  let zoom = Math.min(ESRI_MAX_ZOOM, Math.round(Math.log2(2 * Math.PI * R * Math.cos(lat * Math.PI / 180) / 256 / TREE_PICTURE_MPP)));
  let plan = stitchPlan(bounds, zoom);
  while (plan.tiles && plan.tiles.length > ESRI_MAX_TILES && zoom > 15) plan = stitchPlan(bounds, --zoom);
  if (plan.error) throw new Error(plan.error);
  const out = await stitch(plan, { fetchTile: t => fetchTileBytes(esriTileUrl(t, key), { provider: "esri", fetchImpl }), sharp, format: "png" });
  if (out.failed) throw new Error(out.failed.length + " of " + plan.tiles.length + " Esri tiles failed (" + String(out.failed[0].error && out.failed[0].error.message || "").slice(0, 120) + ")");
  const { data, info } = await sharp(out.buffer, { limitInputPixels: false }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), playSurface: georefFor(plan, out.width, out.height).playSurface };
}

/* The trees round one hole's play shapes on one picture.
   picture: {width, height, data (RGBA), playSurface}. play: the hole's fairway and green
   rings. inputs: courseTreeInputs. canopy: canopy-height grids (gd-canopy-height readCanopy),
   or none. Returns {trees: [{lat, lng, r (metres), l, h}], reason} - l the strictest level that
   finds the tree (h: 1 when it was found from its height alone, and stands at every level). */
export function findTreesOnPicture({ picture, play, inputs, canopy, bandM = shapes.TREE_BAND_M }) {
  const w = picture.width, h = picture.height, georef = { playSurface: picture.playSurface };
  const ground = pictureGround(picture);
  const px = r => r.map(p => latLngToPixel(georef, p));
  const onPicture = xy => Math.min(...xy.map(p => p.x)) < w && Math.max(...xy.map(p => p.x)) >= 0 && Math.min(...xy.map(p => p.y)) < h && Math.max(...xy.map(p => p.y)) >= 0;
  const near = list => list.map(px).filter(onPicture);
  const playPx = near(play);
  if (!playPx.length) return { trees: [], reason: "off-picture" };
  const radiusPx = shapes.TREE_AUTO_RADIUS_M / ground.mpp;
  const band = shapes.playBand(w, h, { play: playPx, surfaces: near(inputs.surfaces), woods: near(inputs.woods), bandPx: bandM / ground.mpp, clearPx: shapes.TREE_CLEAR_M / ground.mpp });
  const tall = canopy && canopy.length
    ? shapes.heightMask({ width: w, height: h, z: picture.playSurface.captureZoom, ox: picture.playSurface.originPx.x, oy: picture.playSurface.originPx.y }, canopy, shapes.TREE_MIN_HEIGHT_M)
    : null;
  const auto = shapes.autoTreeModel(picture, shapes.ringsMask(w, h, near(inputs.turf)), band, { radiusPx, tall });
  const found = auto.model ? shapes.nestedTrees(shapes.treeFinder(picture, auto.model, { radiusPx, inside: auto.allow, max: TREE_HOLE_MAX })) : [];
  let byHeight = [];
  if (tall) {
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = tall[i] && band[i] ? 1 : 0;
    byHeight = shapes.treesInMask(mask, w, h, { radiusPx, avoid: found, max: TREE_HOLE_MAX });
  }
  const toTree = (t, l, fromHeight) => {
    const ll = pixelToLatLng(georef, t);
    return { lat: ll.lat, lng: ll.lng, r: t.r * ground.mpp, l, h: fromHeight ? 1 : 0 };
  };
  return {
    trees: found.map(t => toTree(t, t.l, false)).concat(byHeight.map(t => toTree(t, 0, true))),
    reason: auto.model ? "" : auto.reason,
    heights: !!tall
  };
}

/* Trees from several pictures as one list: where two overlap (neighbouring holes' frames do),
   the one found at the stricter level is kept. */
export function mergeTrees(lists) {
  const all = [].concat(...lists).sort((a, b) => a.l - b.l);
  const cell = 12, grid = new Map(), out = [];
  const xy = t => ({ x: t.lng * 111320 * Math.cos(t.lat * Math.PI / 180), y: t.lat * 111320 });
  all.forEach(t => {
    const p = xy(t), gx = Math.floor(p.x / cell), gy = Math.floor(p.y / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const near = grid.get((gx + dx) + "," + (gy + dy)) || [];
      if (near.some(k => Math.hypot(k.p.x - p.x, k.p.y - p.y) < (k.t.r + t.r) * 0.75)) return;
    }
    const key = gx + "," + gy;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push({ p, t });
    out.push(t);
  });
  return out;
}

/* Stored as [lat, lng, radius, level, fromHeight] - about 30 bytes a tree. */
export function packTrees(trees) {
  return (trees || []).map(t => [Number(t.lat.toFixed(7)), Number(t.lng.toFixed(7)), Math.round(t.r * 10) / 10, t.l | 0, t.h ? 1 : 0]);
}
export function unpackTrees(packed) {
  return (Array.isArray(packed) ? packed : []).filter(a => Array.isArray(a) && a.length >= 4 && Number.isFinite(Number(a[0])) && Number.isFinite(Number(a[1])) && Number(a[2]) > 0)
    .map(a => ({ lat: Number(a[0]), lng: Number(a[1]), r: Number(a[2]), l: Number(a[3]) | 0, h: a[4] ? 1 : 0 }));
}

/* The trees a course_trees row puts on the watch: every one at or under its level. */
export function liveTrees(row) {
  if (!row) return [];
  const level = Number.isFinite(Number(row.level)) ? Number(row.level) : TREE_DEFAULT_LEVEL;
  return unpackTrees(row.trees).filter(t => t.h || t.l <= level);
}

/* A whole course: every hole with fairways or a green, on its published frame when it has
   one and on Esri otherwise. deps: {frames (Map hole -> {path, playSurface}), downloadFrame,
   esriKey, readCanopyFor(bounds) -> grids or null, sharp, fetchImpl, heartbeat(stage)}.
   Returns {trees (merged), holes: {hole: {count, source, reason}}, imagery, heights}. */
export async function findCourseTrees(objectsJson, deps) {
  const inputs = courseTreeInputs(objectsJson);
  const bandM = shapes.TREE_BAND_M;
  const lists = [], holes = {};
  const sources = new Set();
  let heights = false;
  for (let i = 0; i < inputs.holes.length; i++) {
    const hole = inputs.holes[i], play = inputs.play.get(hole);
    if (deps.heartbeat) await deps.heartbeat("trees-hole-" + hole + "-of-" + inputs.holes.length);
    try {
      const frame = deps.frames && deps.frames.get(hole);
      const picture = frame
        ? await frameAsPicture(await deps.downloadFrame(frame.path), frame.playSurface, deps.sharp)
        : await esriPicture(holeBounds(play, bandM + 10), { key: deps.esriKey, sharp: deps.sharp, fetchImpl: deps.fetchImpl });
      const canopy = deps.readCanopyFor ? await deps.readCanopyFor(pictureGround(picture).bounds).catch(() => null) : null;
      const found = findTreesOnPicture({ picture, play, inputs, canopy, bandM });
      if (found.heights) heights = true;
      sources.add(frame ? "frames" : "esri");
      lists.push(found.trees);
      holes[hole] = { count: found.trees.filter(t => t.h || t.l <= TREE_DEFAULT_LEVEL).length, source: frame ? "frame" : "esri", reason: found.reason || undefined };
    } catch (error) {
      holes[hole] = { count: 0, error: String(error && error.message || error).slice(0, 200) };
    }
  }
  return { trees: mergeTrees(lists), holes, imagery: [...sources].sort().join("+") || "none", heights };
}
