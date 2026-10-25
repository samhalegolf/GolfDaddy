/* GET/POST /api/play-view - how GPS Play draws a hole, as set in Clarity Studio.
 *
 *   GET                          {hybrid, updatedAt}: the saved hybrid look (the illustrated
 *                                map blended over the photo), or the defaults when nothing is
 *                                saved. Public: Play reads it on every device.
 *   POST {hybrid}                save it. Admin only, by the same proof the overlay API uses.
 *
 * The shape is scripts/gd-hybrid-look.js normalize(), on the way in and on the way out, so a
 * row written by an older Studio still reads as a complete look. Saved from Studio > Courses >
 * 3D Course Viewer; shown by Play's Auto map style (app/js/painter.js). */
import { hasSupabase, verifiedAdminEmail, json, supabaseFetch } from "./lib/gd-map-overlay-store.mjs";
import hybridLook from "../scripts/gd-hybrid-look.js";

const TABLE = "play_view_settings";
const HYBRID_ID = "hybrid";

export async function loadHybrid(fetchRows = supabaseFetch) {
  const rows = await fetchRows(TABLE + "?select=settings,updated_at&id=eq." + HYBRID_ID + "&limit=1").catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : null;
  return { hybrid: hybridLook.normalize(row && row.settings), updatedAt: row ? row.updated_at : null, saved: !!row };
}

/* A look changes rarely and every round reads it, so a short shared cache is right; a save
   shows up within the minute. */
function publicJson(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Accept,Authorization"
    }
  });
}

export default async function playView(req) {
  if (req.method === "OPTIONS") return json(204, null);
  if (req.method === "GET") {
    if (!hasSupabase()) return publicJson({ hybrid: hybridLook.normalize(null), updatedAt: null, saved: false });
    return publicJson(await loadHybrid());
  }
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!hasSupabase()) return json(503, { error: "Supabase is not configured" });
  const admin = await verifiedAdminEmail(req);
  if (!admin) return json(403, { error: "Admin verification failed" });
  let payload;
  try { payload = await req.json(); } catch (e) { return json(400, { error: "Invalid JSON" }); }
  if (!payload || typeof payload.hybrid !== "object" || !payload.hybrid) return json(400, { error: "hybrid is required" });
  const hybrid = hybridLook.normalize(payload.hybrid);
  const updatedAt = new Date().toISOString();
  try {
    await supabaseFetch(TABLE + "?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ id: HYBRID_ID, settings: hybrid, updated_at: updatedAt, updated_by: admin })
    });
  } catch (error) {
    return json(error.status || 503, { error: String(error && error.message || error) });
  }
  return json(200, { ok: true, hybrid, updatedAt });
}

export const config = { path: "/api/play-view" };
