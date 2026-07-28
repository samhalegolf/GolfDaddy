/* Scheduled safety net for the visual worker queue. The enqueue endpoints ping the background
   worker fire-and-forget; if a ping is lost (deploy in flight, cold start crash) the job sits
   queued forever. This pokes the worker, which reaps stale jobs and sweeps everything queued.
   A quiet queue makes this a no-op costing one invocation.

   Cadence is half the story. The worker's reaper will not touch a job until it has been silent
   for two minutes, so the real time-to-recovery is that window PLUS however long until a worker
   next runs - and at the original ten minutes that came to a quarter of an hour of a dead job
   sitting untouched. Three minutes keeps the pair bounded at ~5.

   Returns what it actually did. It used to answer "ok" whether it had pinged the worker or bailed
   out on a missing site URL, so the one failure mode it has looked exactly like success. */

export default async function courseVisualSweeper(req) {
  /* Prefer the request's own origin - it is always right, needs no environment, and cannot go
     stale against a renamed site. The env vars stay as the fallback for invocation paths that
     do not carry a usable URL. */
  let origin = "";
  try { origin = new URL(req && req.url).origin; } catch (error) { origin = ""; }
  if (!origin || /^https?:\/\/(localhost|127\.)/.test(origin)) {
    origin = (process.env.URL || process.env.DEPLOY_PRIME_URL || "").replace(/\/+$/, "");
  }
  if (!origin) {
    console.warn("course-visual-sweeper: no site url, worker not woken");
    return json(503, { swept: false, reason: "no site url" });
  }
  try {
    const response = await fetch(origin + "/.netlify/functions/course-visual-worker-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    return json(200, { swept: true, origin, workerStatus: response.status });
  } catch (error) {
    console.warn("course-visual-sweeper ping failed", error && error.message || error);
    return json(502, { swept: false, origin, reason: String(error && error.message || error).slice(0, 200) });
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
