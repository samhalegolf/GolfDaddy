/* Scheduled safety net for the mapper worker queue. Structural copy of
   course-visual-sweeper.mjs's pattern, applied to course-mapper-worker-background instead. */

import { createSupabaseStorage } from "./lib/gd-supabase-storage.mjs";
import { purgeMapperDebugCaptures } from "./lib/gd-mapper-debug-captures.mjs";
import { sendReadyCourseMapNotifications } from "./course-map-notify.mjs";

/* The mapper-debug captures are temporary by contract (lib/gd-mapper-debug-captures.mjs):
   date folders older than the retention window go here, on the same schedule that wakes
   the worker. Best-effort: a Storage hiccup must not stop the worker being woken. */
async function purgeCaptures() {
  const base = () => String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = () => String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
  if (!base() || !key()) return { purged: false, reason: "no supabase" };
  try {
    const result = await purgeMapperDebugCaptures(createSupabaseStorage({ base, key, bucket: "course-visuals" }));
    return { purged: true, removed: result.removed.length };
  } catch (error) {
    return { purged: false, reason: String(error && error.message || error).slice(0, 200) };
  }
}

export default async function courseMapperSweeper(req) {
  /* Players who asked to be told when a failed course got mapped (course-map-notify.mjs).
     On this schedule because a finished map is exactly what this sweeper exists to chase.
     First, and independent of the worker ping: a missed ping must not hold up an email. */
  const notifications = await sendReadyCourseMapNotifications();
  let origin = "";
  try { origin = new URL(req && req.url).origin; } catch (error) { origin = ""; }
  if (!origin || /^https?:\/\/(localhost|127\.)/.test(origin)) {
    origin = (process.env.URL || process.env.DEPLOY_PRIME_URL || "").replace(/\/+$/, "");
  }
  if (!origin) {
    console.warn("course-mapper-sweeper: no site url, worker not woken");
    return json(503, { swept: false, reason: "no site url", notifications });
  }
  try {
    const response = await fetch(origin + "/.netlify/functions/course-mapper-worker-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    return json(200, { swept: true, origin, workerStatus: response.status, captures: await purgeCaptures(), notifications });
  } catch (error) {
    console.warn("course-mapper-sweeper ping failed", error && error.message || error);
    return json(502, { swept: false, origin, reason: String(error && error.message || error).slice(0, 200), notifications });
  }
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

export const config = {
  schedule: "*/3 * * * *"
};
