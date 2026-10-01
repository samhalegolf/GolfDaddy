/* Relief tiles - the live map's hillshade layer.

   GET /api/relief-tile?z=16&x=64600&y=40100&az=315&v=1[&course=<courseId>]

   A published hole carries its relief baked into the frame. A live-map hole has no frame, so
   without this it plays on a flat photograph while the published course next door stands up.
   This shades the same DEM with the same Horn hillshade, exaggeration and light altitude the
   bake uses (gd-relief-core's RELIEF_DEFAULTS), and returns a grey tile the map lays over the
   aerial with a soft-light blend - the compositor the bake uses (gd-visual-export-core), at
   the bake's default strength. Same recipe, so a live hole reads like a captured one.

   Elevation only, from the terrain system (functions/lib/terrain/): when the map names its
   course and the tile lies inside that course's baked terrain asset, the tile is shaded from
   the asset and no elevation provider is contacted. Elsewhere the terrain resolver picks the
   best approved source for the tile - a national DTM where one is registered, else the global
   terrain tiles (coarse, 25-30m: a fairway's roll shows, a green's moulding does not). A tile
   nothing can answer is a neutral tile - mid-grey, which a soft-light blend leaves untouched -
   rather than an error the map would draw as a hole.

   The DEM's licence wants a credit, and an <img> tile cannot carry one, so the same endpoint
   answers ?credit=1&lat=&lng= with the credit for the DEM that point is shaded from.

   Two deliberate differences from the bake, both about tiles meeting at seams:
   - No ambient-occlusion term. The bake normalises it over the whole hole; per tile that
     normalisation changes at every tile edge and draws the grid.
   - Each tile shades a padded DEM window and keeps the middle, so the gradient and the
     smoothing at a tile's edge see the same neighbours the next tile does.

   Every input is in the URL (v is bumped when the recipe changes; course is part of it), so a
   tile is immutable and cached hard at the CDN: a course is shaded once, not once per player.
   A course whose terrain is later rebaked keeps its cached shade until v is bumped - accepted
   for the live map, which is the fallback presentation, and the same hill either way. */

import sharp from "sharp";
import { decodeElevation, hillshade, metresPerPixel, RELIEF_DEFAULTS } from "./lib/gd-relief-core.mjs";
import { resolveTerrain, planSources } from "./lib/terrain/gd-terrain-resolver.mjs";
import { terrainForWindow, nativeZoomFor } from "./lib/terrain/gd-terrain-window.mjs";
import { loadCourseTerrainHeights, TERRAIN_BUCKET } from "./lib/terrain/gd-terrain-service.mjs";
import { createSupabaseFetch } from "./lib/gd-supabase-fetch.mjs";

const TILE = 256;
/* The zooms a golf hole is looked at from. Below 12 the shading is of hills, not holes; the
   client asks no higher than 17 and lets Leaflet upscale, because past ~1m/px there is no
   DEM detail left to shade and every extra zoom would quadruple the function calls. */
const MIN_Z = 12;
const MAX_Z = 17;
/* DEM pixels of margin on each side: one for the gradient, the rest for the smoothing
   kernel (sigma 1.2 -> radius 4). */
const PAD = 6;
/* The bake's default terrain strength and its opacity curve (terrainParams in
   gd-visual-export-core: strength 0.9 -> opacity 0.54). Folded into the grey here so the
   client's soft-light blend at full opacity is the bake's blend exactly. */
const OPACITY = 0.9 * 0.6;
const SMOOTH_PX = 1.2;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function tileBounds(z, x, y) {
  const n = Math.pow(2, z);
  const lat = t => (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - 2 * t / n)));
  return { north: lat(y), south: lat(y + 1), west: (x / n) * 360 - 180, east: ((x + 1) / n) * 360 - 180 };
}

let neutral = null;
async function neutralTile() {
  if (!neutral) {
    neutral = await sharp(Buffer.from([128]), { raw: { width: 1, height: 1, channels: 1 } }).png().toBuffer();
  }
  return neutral;
}

/* The approved source the resolver picks for some bounds, configured, or null. */
function bestSourceFor(bounds, options) {
  const resolution = resolveTerrain({ bounds, env: options.env, marginM: 0 });
  if (!resolution.ok) return null;
  return planSources(resolution, { env: options.env })[0] || null;
}

let loadAssetDefault = null;
function assetLoader(options) {
  if (options.loadAsset) return options.loadAsset;
  if (!loadAssetDefault) {
    const base = () => String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
    const key = () => String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
    const supabaseFetch = createSupabaseFetch({ base, key, label: "relief-tile" });
    loadAssetDefault = async courseId => {
      if (!base() || !key()) return null;
      return loadCourseTerrainHeights(courseId, {
        supabaseFetch, sharp, decodeElevation,
        download: async path => {
          const res = await fetch(base() + "/storage/v1/object/public/" + TERRAIN_BUCKET + "/" + path);
          if (!res.ok) throw new Error("terrain asset " + res.status);
          return Buffer.from(await res.arrayBuffer());
        }
      });
    };
  }
  return loadAssetDefault;
}

/* The shade for one tile as greyscale PNG bytes, or null when there is nothing honest to
   draw (no terrain here, a source that failed, or a decode that does not look like ground). */
export async function shadeTile(z, x, y, azimuth, options = {}) {
  const bounds = tileBounds(z, x, y);
  const latitude = (bounds.north + bounds.south) / 2;
  let asset = null;
  if (options.courseId) {
    try { asset = await assetLoader(options)(options.courseId); } catch (e) { asset = null; }
  }

  /* The DEM is read at its own best zoom and the shade scaled up to the tile, the way
     reliefFromTerrainRgb does it: gradients of upsampled heights are gradients of the
     interpolation. From an asset that zoom is the asset's grid; otherwise the source's. */
  let nativeZoom;
  if (asset && asset.manifest) nativeZoom = asset.manifest.grid.captureZoom;
  else {
    const source = bestSourceFor(bounds, options);
    if (!source) return null;
    nativeZoom = nativeZoomFor(source, latitude);
  }
  const demZoom = Math.min(z, nativeZoom);
  const k = Math.pow(2, z - demZoom);
  const footprint = TILE / k;
  const ox = (x * TILE) / k, oy = (y * TILE) / k;
  const left = Math.floor(ox) - PAD, top = Math.floor(oy) - PAD;
  const size = Math.ceil(ox + footprint) - Math.floor(ox) + 2 * PAD;

  const grid = { zoom: demZoom, originPx: { x: left, y: top }, width: size, height: size };
  const result = await (options.terrainForWindow || terrainForWindow)({ grid, asset, env: options.env }, options.terrain || {});
  if (!result || !result.heights) return null;

  const shade = hillshade(result.heights, size, size, metresPerPixel(latitude, demZoom), {
    exaggeration: RELIEF_DEFAULTS.exaggeration,
    azimuth,
    altitude: RELIEF_DEFAULTS.altitude,
    multi: RELIEF_DEFAULTS.multi,
    smoothPx: SMOOTH_PX
  });
  const grey = Buffer.allocUnsafe(shade.length);
  for (let i = 0; i < shade.length; i++) grey[i] = Math.round(clamp(0.5 + (shade[i] - 0.5) * OPACITY, 0, 1) * 255);

  /* Scale the padded window by k and cut the tile out of the middle. */
  const scaled = Math.round(size * k);
  return sharp(grey, { raw: { width: size, height: size, channels: 1 }, limitInputPixels: false })
    .resize({ width: scaled, height: scaled, fit: "fill", kernel: "cubic" })
    .extract({ left: Math.round((ox - left) * k), top: Math.round((oy - top) * k), width: TILE, height: TILE })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export default async function reliefTile(req) {
  if (req.method === "OPTIONS") return new Response("", { status: 200, headers: cors({}) });
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405, headers: cors({}) });

  const params = new URL(req.url).searchParams;
  if (params.get("credit") === "1") {
    const lat = Number(params.get("lat")), lng = Number(params.get("lng"));
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 85 || Math.abs(lng) > 180) {
      return new Response("Bad point", { status: 400, headers: cors({}) });
    }
    /* A point, asked as a sliver of bounds - the same containment test a tile at that point
       goes through. */
    const e = 1e-6;
    const source = bestSourceFor({ north: lat + e, south: lat - e, west: lng - e, east: lng + e }, {});
    const credit = (source && source.attribution) || {};
    return new Response(JSON.stringify({ text: String(credit.text || ""), url: String(credit.url || "") }), {
      status: 200,
      headers: cors({ "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" })
    });
  }
  const z = Number(params.get("z")), x = Number(params.get("x")), y = Number(params.get("y"));
  const n = Math.pow(2, z);
  if (!Number.isInteger(z) || z < MIN_Z || z > MAX_Z || !Number.isInteger(x) || !Number.isInteger(y)
    || x < 0 || y < 0 || x >= n || y >= n) {
    return new Response("Bad tile", { status: 400, headers: cors({}) });
  }
  const azRaw = Number(params.get("az"));
  const azimuth = Number.isFinite(azRaw) ? ((Math.round(azRaw) % 360) + 360) % 360 : RELIEF_DEFAULTS.azimuth;

  let body = null;
  try {
    body = await shadeTile(z, x, y, azimuth, { courseId: String(params.get("course") || "").slice(0, 200) });
  } catch (e) {
    body = null;
  }
  /* A tile with nothing to shade is a real, stable answer where there is no DEM - but it is
     also what a DEM outage looks like, so it is only cached briefly. */
  const shaded = !!body;
  return new Response(shaded ? body : await neutralTile(), {
    status: 200,
    headers: cors({
      "Content-Type": "image/png",
      "Cache-Control": shaded ? "public, max-age=604800, immutable" : "public, max-age=300",
      "Netlify-CDN-Cache-Control": shaded ? "public, durable, s-maxage=31536000" : "public, s-maxage=300",
      "X-Relief-Tile": shaded ? "shaded" : "neutral"
    })
  });
}

function cors(headers) {
  return Object.assign({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS"
  }, headers);
}
