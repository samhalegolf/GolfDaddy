/* Green wand for the Mapping Overlay: a pin on a green in, a first-draft green outline out.
 *
 * POST {image:{data, mediaType}, georef:{playSurface}, seed:{lat, lng}}  (admin)
 *   image  - a small picture of the ground around the pin, base64, captured by Studio from the
 *            mounted provider's own tiles at a fixed zoom, never resampled.
 *   georef - where that picture is: its playSurface (originPx / captureZoom /
 *            outputDimensions), the same shape a published frame carries.
 *   seed   - the pin.
 * -> 200 {ok:true, shape:[{lat,lng}...], confidence, area, stable} or {ok:false, reason}.
 *
 * Writes nothing. Studio adds the shape to the overlay as a green and autosaves it the same
 * way as anything drawn by hand, so the wand is a drafting aid and the overlay stays the one
 * thing the mapper reads. The engine is functions/lib/gd-surface-refine-core.mjs's
 * wandGreenAtPoint, which runs the Green Wand (gd-green-shape-core.mjs) - server-side because
 * the wand needs sharp. */

import { wandGreenAtPoint } from "./lib/gd-surface-refine-core.mjs";
import { hasSupabase, verifiedAdminEmail, json } from "./lib/gd-map-overlay-store.mjs";

const MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
/* A few tiles around a pin is well under half a megabyte; anything near this is not that. */
const MAX_IMAGE_CHARS = 3000000;

export default async function courseMapWand(req) {
  if (req.method === "OPTIONS") return json(204, null);
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!hasSupabase()) return json(503, { error: "Supabase is not configured" });
  const admin = await verifiedAdminEmail(req);
  if (!admin) return json(403, { error: "Admin verification failed" });

  let payload;
  try { payload = await req.json(); } catch (e) { return json(400, { error: "Invalid JSON" }); }
  const image = payload && payload.image;
  const data = String(image && image.data || "");
  if (!image || !MEDIA_TYPES.has(String(image.mediaType)) || !data) return json(400, { error: "image required", detail: "image/jpeg, image/png or image/webp, base64" });
  if (data.length > MAX_IMAGE_CHARS) return json(413, { error: "image too large" });
  const playSurface = payload.georef && payload.georef.playSurface;
  const seed = payload.seed;
  if (!playSurface || !seed) return json(400, { error: "georef.playSurface and seed required" });

  try {
    const out = await wandGreenAtPoint({ image: Buffer.from(data, "base64"), playSurface, seed });
    return json(200, out);
  } catch (error) {
    return json(200, { ok: false, reason: "wand-failed", detail: String(error && error.message || error).slice(0, 200) });
  }
}

export const config = {
  path: "/api/course-map-wand"
};
