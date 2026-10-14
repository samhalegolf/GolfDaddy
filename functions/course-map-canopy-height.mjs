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
  const { fromUrl } = await import("geotiff");
  const { grids, missing } = await readCanopy({ north, south, east, west }, { openTiff: url => fromUrl(url, { allowFullFile: false }) });
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
