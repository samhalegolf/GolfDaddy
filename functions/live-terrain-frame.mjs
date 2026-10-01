/* Live terrain frame - one hole's elevation, for the admin-only "Clarity 3D Mesh" map source
   (app/js/live-terrain.js). TEST PATH.

   GET /api/live-terrain-frame?layer=elevation&z=&x=&y=&w=&h=
     Authorization: Bearer <admin session>

   z/x/y/w/h is a rectangle of web-mercator pixels (gd-live-terrain-core parseWindow) - the same
   rectangle the browser builds its hybrid Esri + Mapbox picture on (app/js/live-hybrid.js), so
   the heights cover exactly the ground of the picture. The mesh needs that and cannot check it.

   The answer is a terrain-RGB PNG from the best DEM for the ground: the regional one (LINZ in
   NZ, and so on) through resolveElevationSource, else the global terrain tiles, else Mapbox
   Terrain-DEM. Headers carry the height range and the source, which the mesh needs and an image
   cannot.

   Nothing is stored and nothing is published: the answer is private to the device that asked
   and never cached at the CDN. Admin only, because this is a test of whether the look is worth
   having. The pictures are not fetched here - they are display tiles the browser draws itself,
   so it can reuse them hole to hole. */

import sharp from "sharp";
import { verifiedAdminEmail } from "./lib/gd-map-overlay-store.mjs";
import { mapboxCaptureSource } from "./lib/gd-mapbox-source.mjs";
import { resolveElevationSource, reliefSpec, GLOBAL_ELEVATION } from "./lib/gd-imagery-sources.mjs";
import { decodeElevation, terrainRgbPngFromHeights } from "./lib/gd-relief-core.mjs";
import { mosaic } from "./lib/gd-relief-fetch.mjs";
import { parseWindow, windowBounds, windowMetres, demPlan, resampleToWindow, heightRange } from "./lib/gd-live-terrain-core.mjs";

/* The DEMs to try, best first. A regional DEM that fails (an outage, a hole in its coverage)
   falls through to the next rather than leaving the hole flat. */
export function elevationCandidates(bounds, env) {
  const out = [];
  const regional = resolveElevationSource(bounds, { env });
  if (regional) out.push({ key: regional.key, label: regional.label, attribution: regional.attribution, dem: reliefSpec(regional.dem) });
  out.push({ key: GLOBAL_ELEVATION.key, label: GLOBAL_ELEVATION.label, attribution: GLOBAL_ELEVATION.attribution, dem: reliefSpec(GLOBAL_ELEVATION.dem) });
  const mapbox = mapboxCaptureSource(env);
  if (mapbox) out.push({ key: "mapbox-terrain-dem", label: "Mapbox Terrain-DEM v1", attribution: { text: "© Mapbox" }, dem: mapbox.terrain });
  return out.filter(c => c.dem);
}

export async function elevationFor(win, deps = {}) {
  const bounds = windowBounds(win);
  const tried = [];
  for (const candidate of elevationCandidates(bounds, deps.env)) {
    const plan = demPlan(win, candidate.dem.maxUsefulZoom);
    let decoded = null;
    try {
      const png = await (deps.mosaic || mosaic)(candidate.dem, plan.demZoom, { x: plan.fetch.left, y: plan.fetch.top },
        { width: plan.fetch.width, height: plan.fetch.height }, { requireAll: true });
      if (png) {
        const { data, info } = await sharp(png, { limitInputPixels: false }).raw().toBuffer({ resolveWithObject: true });
        /* A float32 source arrives already transcoded to terrain-RGB by mosaic(). */
        decoded = decodeElevation(data, info.width, info.height, info.channels,
          candidate.dem.encoding === "float32" ? "terrain-rgb" : candidate.dem.encoding);
        decoded.width = info.width; decoded.height = info.height;
      }
    } catch (e) {
      decoded = null;
    }
    if (!decoded) { tried.push(candidate.key); continue; }
    const heights = resampleToWindow(decoded.heights, decoded.width, decoded.height, plan);
    const range = heightRange(heights);
    const body = await terrainRgbPngFromHeights(heights, plan.grid.width, plan.grid.height);
    const metres = windowMetres(win);
    return {
      body, type: "image/png",
      headers: {
        "X-Elevation-Source": candidate.key,
        "X-Elevation-Credit": encodeURIComponent(String((candidate.attribution && candidate.attribution.text) || "")),
        "X-Elevation-Min": range.min.toFixed(2),
        "X-Elevation-Max": range.max.toFixed(2),
        "X-Elevation-Zoom": String(plan.demZoom),
        "X-Elevation-Size": plan.grid.width + "x" + plan.grid.height,
        "X-Window-Metres": metres.width.toFixed(1) + "x" + metres.height.toFixed(1)
      }
    };
  }
  return { error: "no elevation for this window (tried " + (tried.join(", ") || "nothing") + ")", status: 502 };
}

const EXPOSED = ["X-Window", "X-Elevation-Source", "X-Elevation-Credit", "X-Elevation-Min",
  "X-Elevation-Max", "X-Elevation-Zoom", "X-Elevation-Size", "X-Window-Metres"].join(", ");

function cors(headers) {
  return Object.assign({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization",
    "Access-Control-Expose-Headers": EXPOSED
  }, headers);
}

function fail(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: cors({ "Content-Type": "application/json", "Cache-Control": "no-store" })
  });
}

export function createHandler(deps = {}) {
  const verifyAdmin = deps.verifyAdmin || verifiedAdminEmail;
  return async function liveTerrainFrame(req) {
    if (req.method === "OPTIONS") return new Response("", { status: 204, headers: cors({}) });
    if (req.method !== "GET") return fail(405, "Method not allowed");
    if (!(await verifyAdmin(req))) return fail(403, "Admin verification failed");
    const params = new URL(req.url).searchParams;
    const win = parseWindow(params);
    if (win.error) return fail(400, win.error);
    if (params.get("layer") !== "elevation") return fail(400, "layer must be elevation");
    let result;
    try {
      result = await elevationFor(win, deps);
    } catch (e) {
      return fail(502, String((e && e.message) || e));
    }
    if (result.error) return fail(result.status || 502, result.error);
    return new Response(result.body, {
      status: 200,
      headers: cors(Object.assign({
        "Content-Type": result.type,
        /* The device may keep it a while (Mapbox allows caching on the requesting device);
           a shared cache may not. */
        "Cache-Control": "private, max-age=3600",
        "Netlify-CDN-Cache-Control": "no-store",
        /* Echoed so the client can prove the answer is for the window it asked about. */
        "X-Window": [win.z, win.x, win.y, win.w, win.h].join("/")
      }, result.headers))
    });
  };
}

export default createHandler();

export const config = {
  path: "/api/live-terrain-frame"
};
