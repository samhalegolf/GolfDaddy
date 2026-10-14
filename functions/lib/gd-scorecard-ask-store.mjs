/* The course_scorecard_asks row: one per course, the state of the last "Ask AI for this
   card". Shared by the two halves of the ask so they cannot disagree about its shape. */
import { createSupabaseFetch } from "./gd-supabase-fetch.mjs";

export const ASKS_TABLE = "course_scorecard_asks";
/* An ask older than this that never finished is a dead background invocation, not a live
   one, and a new request may replace it. */
export const STALE_ASK_MS = 6 * 60 * 1000;

function env(name) { return process.env[name] || ""; }
export function supabaseBase() { return env("SUPABASE_URL").replace(/\/+$/, ""); }
export function supabaseKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); }
export function hasSupabase() { return !!(supabaseBase() && supabaseKey()); }
export const supabaseFetch = createSupabaseFetch({ base: supabaseBase, key: supabaseKey, label: "course-scorecard-ask" });

const FIELDS = "course_id,status,requested_at,requested_by,started_at,finished_at,card_text,unit,source,confidence,notes,error,model,usage";

function publicAsk(row) {
  if (!row) return null;
  return {
    status: row.status, requestedAt: row.requested_at, requestedBy: row.requested_by,
    startedAt: row.started_at, finishedAt: row.finished_at,
    cardText: row.card_text, unit: row.unit, source: row.source, confidence: row.confidence, notes: row.notes,
    error: row.error, model: row.model, usage: row.usage
  };
}

export async function loadAsk(courseId) {
  const rows = await supabaseFetch(ASKS_TABLE + "?select=" + FIELDS + "&course_id=eq." + encodeURIComponent(courseId) + "&limit=1").catch(() => []);
  return publicAsk(Array.isArray(rows) ? rows[0] : null);
}

/* Writes the columns given, merging into the course's row. */
export async function writeAsk(courseId, columns) {
  const written = await supabaseFetch(ASKS_TABLE + "?on_conflict=course_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(Object.assign({ course_id: courseId }, columns))
  });
  return publicAsk(Array.isArray(written) && written[0] ? written[0] : Object.assign({ course_id: courseId }, columns));
}
