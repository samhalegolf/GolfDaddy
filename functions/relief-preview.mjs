/* Relief preview - see the shading on a real hole without baking a course.

   GET /api/relief-preview?courseId=pupuke&hole=1&strength=0.9&exaggeration=5

   Deliberately separate from the snapshot/export pipeline. The bake is a resumable,
   all-or-nothing, storage-backed job that shoots a whole course; a preview is one hole, now,
   thrown away after it is looked at. Making the bake serve previews would mean giving it a
   synchronous path, a partial-plan mode and a way to skip storage, all so a slider can feel
   live - so this fetches its own tiles, shades them, and returns a JPEG. It shares the two
   things that must not drift, gd-relief-core's shading and the same mercator maths, and
   nothing else.

   That also makes it the honest tuning tool: every relief constant is a query parameter, so
   exaggeration and light angle can be judged against a real green rather than argued about.
   Whatever wins here gets written into RELIEF_DEFAULTS and baked. */

import sharp from "sharp";
import { reliefFromTerrainRgb, reliefAzimuthForPlayAxis, RELIEF_DEFAULTS, heightsFromFloat32Tiff, terrainRgbPngFromHeights } from "./lib/gd-relief-core.mjs";
import { resolveImagerySource, exportImageUrl } from "./lib/gd-imagery-sources.mjs";

const MAPS_TABLE = "course_maps";
const TILE = 256;
/* A preview is looked at on a phone-sized panel. 1024 is a hole at roughly half a metre per
   pixel, which is more than enough to judge shading and cheap enough to feel instant. */
const MAX_SIZE = 1536;
const DEFAULT_SIZE = 1024;
const TILE_CONCURRENCY = 12;
const TILE_TIMEOUT_MS = 10000;

function env(name) { return process.env[name] || ""; }
function supabaseBase() { return env("SUPABASE_URL").replace(/\/+$/, ""); }
function supabaseKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); }

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const numParam = (params, name, dflt, lo, hi) => {
  const raw = params.get(name);
  if (raw === null || raw === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? clamp(n, lo, hi) : dflt;
};

/* ---- mercator (same maths as gd-visual-export-core / gd-relief-core) ---- */
function world(lat, lng) {
  const s = Math.sin(clamp(lat, -85.05112878, 85.05112878) * Math.PI / 180);
  return { x: (lng + 180) / 360, y: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI) };
}

/* ---- tiles ----
   A simpler fetcher than the worker's on purpose. The worker refuses a capture with any
   missing tile, because a stored master with a hole in it is a permanent artefact; a preview
   is transient, so a missing edge tile draws dark and the picture is still useful. Different
   requirement, not a duplicated one. */
async function fetchTile(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TILE_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function tileUrl(spec, z, x, y) {
  return spec.urlTemplate
    .replace(/\{ *z *\}/g, z).replace(/\{ *x *\}/g, x).replace(/\{ *y *\}/g, y);
}

async function mosaic(spec, zoom, originPx, size) {
  /* arcgis-export sources (US) answer the whole preview window in ONE exportImage request -
     a preview is at most 1536px against the service's 4000px cap, so there is no grid to
     assemble. A float32 elevation answer is transcoded to terrain-RGB here, exactly as the
     capture path does, so everything downstream of mosaic() stays one format. */
  if (spec.adapter === "arcgis-export") {
    const buf = await fetchTile(exportImageUrl(spec, { left: originPx.x, top: originPx.y, width: size, height: size }, zoom));
    if (!buf) return null;
    if (spec.encoding !== "float32") return buf;
    const { heights, width, height } = await heightsFromFloat32Tiff(buf);
    return terrainRgbPngFromHeights(heights, width, height);
  }
  const tx0 = Math.floor(originPx.x / TILE), ty0 = Math.floor(originPx.y / TILE);
  const tx1 = Math.floor((originPx.x + size - 1) / TILE), ty1 = Math.floor((originPx.y + size - 1) / TILE);
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push({ tx, ty });

  const placed = new Array(jobs.length).fill(null);
  let cursor = 0;
  async function pump() {
    while (cursor < jobs.length) {
      const i = cursor++;
      const { tx, ty } = jobs[i];
      const buf = await fetchTile(tileUrl(spec, zoom, tx, ty));
      if (buf) placed[i] = { input: buf, left: (tx - tx0) * TILE, top: (ty - ty0) * TILE };
    }
  }
  await Promise.all(Array.from({ length: Math.min(TILE_CONCURRENCY, jobs.length) }, pump));
  const layers = placed.filter(Boolean);
  if (!layers.length) return null;

  const sheet = await sharp({
    create: { width: (tx1 - tx0 + 1) * TILE, height: (ty1 - ty0 + 1) * TILE, channels: 3, background: { r: 16, g: 19, b: 15 } },
    limitInputPixels: false
  }).composite(layers).png().toBuffer();

  return sharp(sheet, { limitInputPixels: false }).extract({
    left: Math.round(originPx.x - tx0 * TILE),
    top: Math.round(originPx.y - ty0 * TILE),
    width: size, height: size
  }).png().toBuffer();
}

/* ---- soft-light, matching gd-visual-export-core exactly ---- */
function softLightTable(opacity) {
  const table = new Uint8Array(256 * 256);
  for (let s = 0; s < 256; s++) {
    const shade = 0.5 + (s / 255 - 0.5) * opacity;
    for (let b = 0; b < 256; b++) {
      const base = b / 255;
      const d = base <= 0.25 ? ((16 * base - 12) * base + 4) * base : Math.sqrt(base);
      const v = shade <= 0.5 ? base - (1 - 2 * shade) * base * (1 - base) : base + (2 * shade - 1) * (d - base);
      table[s * 256 + b] = Math.round(clamp(v, 0, 1) * 255);
    }
  }
  return table;
}

/* ---- course geometry ---- */
async function loadHole(courseId, holeNumber) {
  const r = await fetch(
    supabaseBase() + "/rest/v1/" + MAPS_TABLE +
    "?select=course_id,course_name,objects_json&course_id=eq." + encodeURIComponent(courseId) +
    "&published=eq.true&limit=1",
    { headers: { apikey: supabaseKey(), Authorization: "Bearer " + supabaseKey() } }
  );
  if (!r.ok) return null;
  const rows = await r.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  const objects = Object.values(row.objects_json || {});
  const forHole = objects.filter(o => Number(o && o.holeNumber) === holeNumber && o.position);
  const tee = forHole.find(o => o.type === "tee");
  const green = forHole.find(o => o.type === "green");
  if (!tee || !green) return null;
  return { courseName: row.course_name || courseId, tee: tee.position, green: green.position };
}

/* Frame the hole: centre on tee-green midpoint, and pick the zoom that fits the hole with a
   margin. Integer zoom, like the export - fractional zoom desynchronises the frame from the
   geometry, which is the bug the iz1 tag in the worker records. */
function frameHole(tee, green, size) {
  const centre = { lat: (tee.lat + green.lat) / 2, lng: (tee.lng + green.lng) / 2 };
  const a = world(tee.lat, tee.lng), b = world(green.lat, green.lng);
  const span = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) * 1.45 || 1e-6;
  let zoom = Math.floor(Math.log2(size / (TILE * span)));
  zoom = clamp(zoom, 12, 20);
  const c = world(centre.lat, centre.lng);
  const scalePx = TILE * Math.pow(2, zoom);
  return {
    zoom, centre,
    originPx: { x: Math.round(c.x * scalePx - size / 2), y: Math.round(c.y * scalePx - size / 2) }
  };
}

export default async function reliefPreview(req) {
  if (req.method === "OPTIONS") return new Response("", { status: 200, headers: cors({}) });
  if (req.method !== "GET") return json(405, { error: "Method not allowed" });
  if (!supabaseBase() || !supabaseKey()) return json(503, { error: "Supabase is not configured" });

  const params = new URL(req.url).searchParams;
  const courseId = String(params.get("courseId") || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,90}$/.test(courseId)) return json(400, { error: "Invalid courseId" });
  const holeNumber = Math.round(numParam(params, "hole", 1, 1, 36));
  const size = Math.round(numParam(params, "size", DEFAULT_SIZE, 256, MAX_SIZE));

  const shade = {
    exaggeration: numParam(params, "exaggeration", RELIEF_DEFAULTS.exaggeration, 0.5, 20),
    /* Filled in below once the hole is known - the bake aims the light off the play axis, and
       a preview lit from anywhere else is a preview of something we are not going to ship. */
    azimuth: null,
    altitude: numParam(params, "altitude", RELIEF_DEFAULTS.altitude, 5, 89),
    ambient: numParam(params, "ambient", RELIEF_DEFAULTS.ambient, 0, 1),
    multi: params.get("multi") === "1"
  };
  /* Same curve as terrainParams in gd-visual-export-core, so what you tune is what bakes. */
  const strength = numParam(params, "strength", 0.9, 0, 1.6);
  const opacity = clamp(strength * 0.6, 0, 0.96);

  const hole = await loadHole(courseId, holeNumber);
  if (!hole) return json(404, { error: "No published tee and green for hole " + holeNumber + " of " + courseId });

  const bounds = {
    north: Math.max(hole.tee.lat, hole.green.lat), south: Math.min(hole.tee.lat, hole.green.lat),
    east: Math.max(hole.tee.lng, hole.green.lng), west: Math.min(hole.tee.lng, hole.green.lng)
  };
  const source = resolveImagerySource(bounds);
  if (!source) return json(422, { error: "No licensed imagery covers this course" });
  if (!source.terrain) {
    return json(422, {
      error: "No relief source for this region",
      detail: source.key + " has no elevation source the pipeline can decode, so relief cannot be computed here."
    });
  }

  /* Match the bake: azimuth is measured off this hole's play axis unless one is given
     explicitly, in which case that is taken as a world bearing so the tuning knob can still
     sweep the light right round. */
  const azimuthParam = params.get("azimuth");
  shade.azimuth = azimuthParam === null || azimuthParam === ""
    ? reliefAzimuthForPlayAxis(hole.tee, hole.green)
    : numParam(params, "azimuth", RELIEF_DEFAULTS.azimuth, 0, 360);

  const frame = frameHole(hole.tee, hole.green, size);
  const aerialZoom = Math.min(frame.zoom, source.imagery.maxUsefulZoom || frame.zoom);
  const demZoom = Math.min(frame.zoom, source.terrain.maxUsefulZoom || 17);
  const scaleAt = z => Math.pow(2, z - frame.zoom);

  const originAt = z => ({ x: Math.round(frame.originPx.x * scaleAt(z)), y: Math.round(frame.originPx.y * scaleAt(z)) });
  const sizeAt = z => Math.max(64, Math.round(size * scaleAt(z)));

  const [aerialPng, demPng] = await Promise.all([
    mosaic(source.imagery, aerialZoom, originAt(aerialZoom), sizeAt(aerialZoom)),
    mosaic(source.terrain, demZoom, originAt(demZoom), sizeAt(demZoom))
  ]);
  if (!aerialPng) return json(502, { error: "No imagery tiles returned" });
  if (!demPng) return json(502, { error: "No elevation tiles returned" });

  let relief;
  try {
    /* A float32 source was transcoded to terrain-RGB by mosaic(), so that is what the bytes
       in hand actually are - declaring "float32" here would just cost decodeElevation a
       wasted first attempt. */
    const heldEncoding = source.terrain.encoding === "float32" ? "terrain-rgb" : source.terrain.encoding;
    relief = await reliefFromTerrainRgb(demPng, { latitude: frame.centre.lat, zoom: demZoom }, {
      ...shade, encoding: heldEncoding, outputWidth: size, outputHeight: size
    });
  } catch (e) {
    /* The decoder refuses greys that are not plausible ground. Nearly always this means the
       elevation URL lost its pipeline=terrain-rgb and we are looking at a rendered picture. */
    return json(502, { error: "Elevation decode failed", detail: String(e && e.message || e) });
  }

  const aerial = await sharp(aerialPng, { limitInputPixels: false })
    .resize({ width: size, height: size, fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const mask = await sharp(relief.png, { limitInputPixels: false }).greyscale().raw().toBuffer();

  const table = softLightTable(opacity);
  const px = aerial.data;
  const ch = aerial.info.channels;
  if (params.get("mode") !== "shade") {
    for (let i = 0, p = 0; i < mask.length; i++, p += ch) {
      const row = mask[i] * 256;
      px[p] = table[row + px[p]];
      px[p + 1] = table[row + px[p + 1]];
      px[p + 2] = table[row + px[p + 2]];
    }
  }

  const body = params.get("mode") === "shade"
    ? await sharp(mask, { raw: { width: size, height: size, channels: 1 } }).jpeg({ quality: 88 }).toBuffer()
    : await sharp(px, { raw: { width: size, height: size, channels: ch } }).jpeg({ quality: 88 }).toBuffer();

  return new Response(body, {
    status: 200,
    headers: cors({
      "Content-Type": "image/jpeg",
      /* Every knob is in the URL, so a given URL is immutable - cache it hard. Dragging a
         slider produces a new URL, and dragging back reuses the cached one. */
      "Cache-Control": "public, max-age=600",
      "X-Relief-Course": hole.courseName,
      "X-Relief-Source": source.key,
      "X-Relief-Encoding": relief.encoding,
      "X-Relief-Zoom": String(frame.zoom) + " aerial z" + aerialZoom + " dem z" + demZoom,
      "X-Relief-Elevation": relief.elevation.min.toFixed(1) + ".." + relief.elevation.max.toFixed(1) + "m",
      "X-Relief-Shade": "exag " + shade.exaggeration + " az " + Math.round(shade.azimuth) + " alt " + shade.altitude +
        " ambient " + shade.ambient + " strength " + strength
    })
  });
}

function cors(headers) {
  return Object.assign({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, OPTIONS"
  }, headers);
}
function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: cors({ "Content-Type": "application/json" }) });
}
