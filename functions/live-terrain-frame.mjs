/* Live terrain frame - one hole's elevation, for Clarity 3D Mesh, the default picture of a hole
   with no published surface (app/js/live-terrain.js).

   GET /api/live-terrain-frame?layer=elevation&z=&x=&y=&w=&h=[&course=<courseId>]
     Authorization: Bearer <signed-in session>

   z/x/y/w/h is a rectangle of web-mercator pixels (gd-live-terrain-core parseWindow) - the same
   rectangle the browser builds its hybrid Esri + Mapbox picture on (app/js/live-hybrid.js), so
   the heights cover exactly the ground of the picture. The mesh needs that and cannot check it.

   The heights come from the course's BAKED terrain asset when a course is named and its asset
   covers the window - no elevation provider is contacted. Outside one, the terrain resolver
   picks the best approved source for the ground (functions/lib/terrain/gd-terrain-window.mjs),
   falling through to the next when one fails. Headers carry the height range, the source, its
   real sample spacing and the asset's terrain quality, which the mesh and the green-line gate
   need and an image cannot carry.

   Nothing is stored and nothing is published: the answer is private to the device that asked
   and never cached at the CDN. Signed-in players only, so the terrain sources behind it are not
   an open proxy. The pictures are not fetched here - they are display tiles the browser draws
   itself, so it can reuse them hole to hole. */

import sharp from "sharp";
import { verifiedUserId } from "./lib/gd-map-overlay-store.mjs";
import { terrainRgbPngFromHeights, decodeElevation } from "./lib/gd-relief-core.mjs";
import { parseWindow, windowMetres, demGrid } from "./lib/gd-live-terrain-core.mjs";
import { terrainForWindow } from "./lib/terrain/gd-terrain-window.mjs";
import { loadCourseTerrainHeights, TERRAIN_BUCKET } from "./lib/terrain/gd-terrain-service.mjs";
import { createSupabaseFetch } from "./lib/gd-supabase-fetch.mjs";

function envOf(deps) { return deps.env || process.env; }

function defaultLoadAsset(deps) {
  const env = envOf(deps);
  const base = () => String(env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = () => String(env.SUPABASE_SERVICE_ROLE_KEY || "");
  const supabaseFetch = createSupabaseFetch({ base, key, label: "live-terrain-frame" });
  return async courseId => {
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

export async function elevationFor(win, deps = {}, courseId = "") {
  const grid = demGrid(win);
  let asset = null;
  if (courseId) {
    try { asset = await (deps.loadAsset || defaultLoadAsset(deps))(courseId); } catch (e) { asset = null; }
  }
  const result = await (deps.terrainForWindow || terrainForWindow)({ grid, asset, env: envOf(deps) }, deps.terrain || {});
  if (!result || !result.heights) {
    return { error: "no elevation for this window (tried " + ((result && result.tried || []).join(", ") || "nothing") + ")", status: 502 };
  }
  const body = await terrainRgbPngFromHeights(result.heights, grid.width, grid.height);
  const metres = windowMetres(win);
  const quality = result.quality || null;
  return {
    body, type: "image/png",
    headers: {
      "X-Elevation-Source": (result.source && result.source.id) || "?",
      "X-Elevation-From": result.from,
      "X-Elevation-Credit": encodeURIComponent(String((result.source && result.source.attribution && result.source.attribution.text) || "")),
      "X-Elevation-Min": result.range.min.toFixed(2),
      "X-Elevation-Max": result.range.max.toFixed(2),
      "X-Elevation-Size": grid.width + "x" + grid.height,
      "X-Window-Metres": metres.width.toFixed(1) + "x" + metres.height.toFixed(1),
      /* How far apart the source's real heights are, whatever grid they were resampled onto.
         The phone draws green slope lines only from elevation fine enough to know a green's
         shape (app/js/live-terrain.js greenReadable). */
      "X-Elevation-Sample-M": Number(result.sampleM || 0).toFixed(2),
      "X-Terrain-Version": result.terrainVersion ? String(result.terrainVersion) : "",
      "X-Terrain-Quality": quality ? String(quality.class || "") : "",
      "X-Green-Detail": quality ? String(quality.greenDetail || "") : ""
    }
  };
}

const EXPOSED = ["X-Window", "X-Elevation-Source", "X-Elevation-From", "X-Elevation-Credit", "X-Elevation-Min",
  "X-Elevation-Max", "X-Elevation-Size", "X-Window-Metres", "X-Elevation-Sample-M",
  "X-Terrain-Version", "X-Terrain-Quality", "X-Green-Detail"].join(", ");

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
  const verifyUser = deps.verifyUser || verifiedUserId;
  return async function liveTerrainFrame(req) {
    if (req.method === "OPTIONS") return new Response("", { status: 204, headers: cors({}) });
    if (req.method !== "GET") return fail(405, "Method not allowed");
    if (!(await verifyUser(req))) return fail(401, "Sign in to load terrain");
    const params = new URL(req.url).searchParams;
    const win = parseWindow(params);
    if (win.error) return fail(400, win.error);
    if (params.get("layer") !== "elevation") return fail(400, "layer must be elevation");
    const courseId = String(params.get("course") || "").slice(0, 200);
    let result;
    try {
      result = await elevationFor(win, deps, courseId);
    } catch (e) {
      return fail(502, String((e && e.message) || e));
    }
    if (result.error) return fail(result.status || 502, result.error);
    return new Response(result.body, {
      status: 200,
      headers: cors(Object.assign({
        "Content-Type": result.type,
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
