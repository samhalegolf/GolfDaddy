/* Tree heights under a box, for Studio's tree finder near play. Admin only.
 *
 * GET ?north=&south=&east=&west=
 *   -> 200 { grids: [{quadkey, crs, x0, y0, dx, dy, width, height, heights (base64 uint8,
 *            metres, row by row from the top)}], missing: [{quadkey, reason}], credit }
 *
 * Read from Meta / WRI canopy height COGs (lib/gd-canopy-height.mjs) - only the box's window,
 * nothing stored. */

import { readCanopy, CANOPY_CREDIT } from "./lib/gd-canopy-height.mjs";
import { hasSupabase, verifiedAdminEmail, json } from "./lib/gd-map-overlay-store.mjs";

/* A fairway's capture is well under this; it keeps the answer to a couple of megabytes. */
const MAX_SPAN_M = 2500;

function num(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }

/* Tiles already opened by this instance. Opening one reads its header - several round trips -
   and the tree finder asks for one fairway after another on the same tile, so a warm
   instance keeps the few it has opened (and the blocks geotiff.js has cached on them). */
const OPEN_TILES_MAX = 8;
const openTiles = new Map();
async function openTile(url) {
  if (openTiles.has(url)) return openTiles.get(url);
  const { fromUrl } = await import("geotiff");
  const opening = fromUrl(url, { allowFullFile: false });
  openTiles.set(url, opening);
  opening.catch(() => openTiles.delete(url));
  while (openTiles.size > OPEN_TILES_MAX) openTiles.delete(openTiles.keys().next().value);
  return opening;
}

export default async function courseMapCanopyHeight(req) {
  if (req.method === "OPTIONS") return json(204, null);
  if (req.method !== "GET") return json(405, { error: "Method not allowed" });
  if (!hasSupabase()) return json(503, { error: "Supabase is not configured" });
  const admin = await verifiedAdminEmail(req);
  if (!admin) return json(403, { error: "Admin verification failed" });
  const q = new URL(req.url).searchParams;
  const [north, south, east, west] = ["north", "south", "east", "west"].map(k => num(q.get(k)));
  if ([north, south, east, west].some(v => v == null) || !(north > south) || !(east > west) || Math.abs(north) > 85 || Math.abs(south) > 85) {
    return json(400, { error: "north, south, east and west required" });
  }
  const metresPerDeg = 111320, across = (east - west) * metresPerDeg * Math.cos((north + south) / 2 * Math.PI / 180);
  if ((north - south) * metresPerDeg > MAX_SPAN_M || across > MAX_SPAN_M) return json(400, { error: "area too large" });
  const { grids, missing } = await readCanopy({ north, south, east, west }, { openTiff: openTile });
  if (!grids.length && missing.length) return json(502, { error: "tree heights unavailable", detail: missing.map(m => m.quadkey + ": " + m.reason).join("; "), missing });
  return json(200, {
    grids: grids.map(g => Object.assign({}, g, { heights: Buffer.from(g.heights.buffer, g.heights.byteOffset, g.heights.byteLength).toString("base64") })),
    missing,
    credit: CANOPY_CREDIT
  });
}

export const config = {
  path: "/api/course-map-canopy-height"
};
