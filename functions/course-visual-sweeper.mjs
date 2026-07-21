/* Scheduled safety net for the visual worker queue. The enqueue endpoints ping the background
   worker fire-and-forget; if a ping is lost (deploy in flight, cold start crash) the job sits
   queued forever. This runs every 10 minutes and pokes the worker, which reaps stale jobs and
   sweeps everything queued. A quiet queue makes this a no-op costing one invocation. */

export default async function courseVisualSweeper() {
  const origin = (process.env.URL || process.env.DEPLOY_PRIME_URL || "").replace(/\/+$/, "");
  if (!origin) return new Response("no site url", { status: 200 });
  try {
    await fetch(origin + "/.netlify/functions/course-visual-worker-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
  } catch (error) {
    console.warn("course-visual-sweeper ping failed", error && error.message || error);
  }
  return new Response("ok", { status: 200 });
}

export const config = {
  schedule: "*/10 * * * *"
};
