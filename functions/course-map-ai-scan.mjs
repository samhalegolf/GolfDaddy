/* AI scan: ask a model to trace fairways and greens off a satellite picture of a course.
 *
 * POST {courseId, image:{data, mediaType}, georef, append?, notes?}  (admin)
 *   image  - the picture, base64, JPEG/PNG/WebP, as the model will see it (Studio captures
 *            the current map view and scales it to the size the model reads at, so the
 *            pixels it answers in are the pixels we georeference).
 *   georef - where that picture is: a playSurface (originPx / captureZoom / dimensions), a
 *            centre+zoom, or bounds - gd-overlay-georef-core.mjs.
 *   append - keep the shapes already saved and add these (a course scanned one view at a
 *            time). Default replaces.
 *   anchors - what Studio drew onto the picture that is not ground: known OSM greens and
 *            saved shapes, as pixel centres, so the prompt can name them. grid - the pixel
 *            spacing of the coordinate grid drawn on the picture, so the prompt can say so.
 * -> 202 {status:"queued"}. The scan itself runs in course-map-ai-scan-background.mjs: a
 *    vision call with thinking takes longer than a synchronous function is allowed, so this
 *    endpoint only proves the caller, checks the request, parks it on the course's overlay
 *    row (ai_scan) and pings the background half. Studio polls GET /api/course-map-overlay,
 *    whose aiScan field carries the status and then the outcome.
 *
 * What the scan writes is the same overlay a person draws - the mapper cannot tell the
 * difference and does not need to. Nothing on the course changes until a mapper run is
 * requested. */

import { imageGeoreference } from "./lib/gd-overlay-georef-core.mjs";
import { hasSupabase, slug, verifiedAdminEmail, loadCourse, loadOverlay, writeAiScan, json } from "./lib/gd-map-overlay-store.mjs";

const MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
/* Base64 of a ~4MB picture. Netlify caps a function body at 6MB anyway; this just makes the
   refusal a sentence rather than a gateway error. */
const MAX_IMAGE_CHARS = 5500000;
/* A scan older than this that never finished is a dead background invocation, not a live
   one, and a new request may replace it. */
const STALE_SCAN_MS = 12 * 60 * 1000;

function aiConfigured() { return !!process.env.ANTHROPIC_API_KEY; }

async function pingBackground(origin, courseId) {
  try {
    await fetch(origin + "/.netlify/functions/course-map-ai-scan-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ courseId })
    }).catch(() => {});
  } catch (e) { /* the queued request stays on the row; a later ping picks it up */ }
}

export default async function courseMapAiScan(req) {
  if (req.method === "OPTIONS") return json(204, null);
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!hasSupabase()) return json(503, { error: "Supabase is not configured" });
  if (!aiConfigured()) return json(503, { error: "AI scan is not configured", detail: "Set ANTHROPIC_API_KEY on the site." });

  const admin = await verifiedAdminEmail(req);
  if (!admin) return json(403, { error: "Admin verification failed" });

  let payload;
  try { payload = await req.json(); } catch (e) { return json(400, { error: "Invalid JSON" }); }
  const courseId = slug(payload && (payload.courseId || payload.course_id));
  if (!courseId) return json(400, { error: "courseId required" });

  const image = payload && payload.image && typeof payload.image === "object" ? payload.image : null;
  const mediaType = String(image && image.mediaType || "").toLowerCase();
  const data = String(image && image.data || "").replace(/^data:[^,]+,/, "");
  if (!image || !MEDIA_TYPES.has(mediaType)) return json(400, { error: "image required", detail: "image.mediaType must be image/jpeg, image/png or image/webp" });
  if (!data || !/^[A-Za-z0-9+/=]+$/.test(data.slice(0, 200))) return json(400, { error: "image required", detail: "image.data must be base64" });
  if (data.length > MAX_IMAGE_CHARS) return json(413, { error: "image too large", detail: "Zoom in, or capture a smaller view - the model reads at most ~1568px on the long side anyway." });

  const georef = imageGeoreference(payload.georef);
  if (georef.error) return json(400, { error: "bad georef", detail: georef.error });

  const course = await loadCourse(courseId);
  if (!course) return json(404, { error: "no course_maps row for " + courseId, detail: "An overlay belongs to a course the picker already knows. Add the course first." });

  const current = (await loadOverlay(courseId)).aiScan;
  const startedAt = current && Date.parse(current.requestedAt || "") || 0;
  if (current && (current.status === "queued" || current.status === "running") && Date.now() - startedAt < STALE_SCAN_MS) {
    return json(409, { error: "a scan is already running for " + courseId, detail: "Wait for it to finish - its outcome lands on the overlay." });
  }

  const requested = {
    status: "queued",
    requestedAt: new Date().toISOString(),
    requestedBy: admin,
    georef: payload.georef,
    image: { mediaType, data },
    append: !!payload.append,
    notes: String(payload.notes || "").slice(0, 600),
    anchors: (Array.isArray(payload.anchors) ? payload.anchors : []).slice(0, 120).map(a => ({
      kind: String(a && a.kind || "").slice(0, 12),
      label: String(a && a.label || "").slice(0, 12),
      x: Math.round(Number(a && a.x)), y: Math.round(Number(a && a.y)),
      saved: !!(a && a.saved)
    })).filter(a => Number.isFinite(a.x) && Number.isFinite(a.y)),
    grid: Number.isFinite(Number(payload.grid)) && Number(payload.grid) > 0 ? Math.round(Number(payload.grid)) : 0
  };
  await writeAiScan(courseId, requested);
  await pingBackground(new URL(req.url).origin, courseId);
  return json(202, { courseId, status: "queued", requestedAt: requested.requestedAt, georef: { width: georef.width, height: georef.height, metresPerPixel: georef.metresPerPixel } });
}

export const config = {
  path: "/api/course-map-ai-scan"
};
