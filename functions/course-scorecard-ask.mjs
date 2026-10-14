/* "Ask AI for this card": POST queues an ask for a course, GET reads where it got to.
 *
 * POST /api/course-scorecard-ask { courseId }   (admin)
 *   -> 202 {status:"queued"}. The ask itself runs in course-scorecard-ask-background.mjs -
 *   a web-searching model call outlives a synchronous function - so this half proves the
 *   caller, parks the request on the course's row in course_scorecard_asks and pings the
 *   background half.
 * GET /api/course-scorecard-ask?courseId=...   (admin)
 *   -> the row: status, and when done the card text for the paste box, its unit, where the
 *   model looked and how sure it was.
 *
 * Nothing here or in the background half stores a scorecard. The card text lands in Studio's
 * paste box and the operator presses Import, the same as a card they pasted themselves. */

import { verifiedAdminEmail, loadCourse, json } from "./lib/gd-map-overlay-store.mjs";
import { hasSupabase, loadAsk, writeAsk, STALE_ASK_MS } from "./lib/gd-scorecard-ask-store.mjs";

function slug(value) { return String(value || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90); }
function aiConfigured() { return !!process.env.ANTHROPIC_API_KEY; }

async function pingBackground(origin, courseId) {
  try {
    await fetch(origin + "/.netlify/functions/course-scorecard-ask-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ courseId })
    }).catch(() => {});
  } catch (e) { /* the queued request stays on the row; a later ping picks it up */ }
}

export default async function courseScorecardAsk(req) {
  if (req.method === "OPTIONS") return json(204, null);
  if (!hasSupabase()) return json(503, { error: "Supabase is not configured" });
  const admin = await verifiedAdminEmail(req);
  if (!admin) return json(403, { error: "Admin verification failed" });
  const url = new URL(req.url);

  if (req.method === "GET") {
    const courseId = slug(url.searchParams.get("courseId"));
    if (!courseId) return json(400, { error: "courseId required" });
    return json(200, { courseId, ask: await loadAsk(courseId) });
  }
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!aiConfigured()) return json(503, { error: "AI is not configured", detail: "Set ANTHROPIC_API_KEY on the site." });

  let payload;
  try { payload = await req.json(); } catch (e) { return json(400, { error: "Invalid JSON" }); }
  const courseId = slug(payload && (payload.courseId || payload.course_id));
  if (!courseId) return json(400, { error: "courseId required" });
  const course = await loadCourse(courseId);
  if (!course) return json(404, { error: "no course_maps row for " + courseId });

  const current = await loadAsk(courseId);
  const startedAt = current && Date.parse(current.requestedAt || "") || 0;
  if (current && (current.status === "queued" || current.status === "running") && Date.now() - startedAt < STALE_ASK_MS) {
    return json(409, { error: "an ask is already running for " + courseId, detail: "Wait for it to finish - its answer lands in the paste box." });
  }
  const ask = await writeAsk(courseId, {
    status: "queued", requested_at: new Date().toISOString(), requested_by: admin,
    started_at: null, finished_at: null, card_text: null, unit: null, source: null, confidence: null, notes: null, error: null, model: null, usage: null
  });
  await pingBackground(url.origin, courseId);
  return json(202, { courseId, ask });
}

export const config = { path: "/api/course-scorecard-ask" };
