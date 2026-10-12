/* When the imagery under the Studio map was taken, for the overlay's credit line. Admin only.
 *
 * GET ?source=<GDMapSources key>&lat=&lng=&zoom=[&north=&south=&east=&west=]
 *   -> 200 { source, status, text, from?, to?, detail? }   (lib/gd-imagery-dates.mjs)
 *
 * Server-side because the providers' metadata endpoints are not all CORS-open and the Esri
 * one wants the key: the page asks here, this asks the provider, nothing is stored. */

import { captureDateFor } from "./lib/gd-imagery-dates.mjs";
import { hasSupabase, verifiedAdminEmail, json } from "./lib/gd-map-overlay-store.mjs";

function num(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }

export default async function courseMapCaptureDate(req) {
  if (req.method === "OPTIONS") return json(204, null);
  if (req.method !== "GET") return json(405, { error: "Method not allowed" });
  if (!hasSupabase()) return json(503, { error: "Supabase is not configured" });
  const admin = await verifiedAdminEmail(req);
  if (!admin) return json(403, { error: "Admin verification failed" });
  const q = new URL(req.url).searchParams;
  const source = String(q.get("source") || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24);
  if (!source) return json(400, { error: "source required" });
  const lat = num(q.get("lat")), lng = num(q.get("lng"));
  if (lat == null || lng == null) return json(400, { error: "lat and lng required" });
  const edges = ["north", "south", "east", "west"].map(k => num(q.get(k)));
  const bounds = edges.every(v => v != null) ? { north: edges[0], south: edges[1], east: edges[2], west: edges[3] } : null;
  const keys = {
    linzKey: process.env.LINZ_BASEMAPS_API_KEY || process.env.LINZ_BASEMAPS_PUBLIC_KEY || "",
    esriKey: process.env.ARCGIS_API_KEY || process.env.ESRI_API_KEY || ""
  };
  const answer = await captureDateFor(source, { lat, lng, zoom: num(q.get("zoom")), bounds }, { keys });
  return json(200, answer);
}

export const config = {
  path: "/api/course-map-capture-date"
};
