/* Scheduled safety net for the mapper worker queue. Structural copy of
   course-visual-sweeper.mjs's pattern, applied to course-mapper-worker-background instead. */

export default async function courseMapperSweeper(req) {
  let origin = "";
  try { origin = new URL(req && req.url).origin; } catch (error) { origin = ""; }
  if (!origin || /^https?:\/\/(localhost|127\.)/.test(origin)) {
    origin = (process.env.URL || process.env.DEPLOY_PRIME_URL || "").replace(/\/+$/, "");
  }
  if (!origin) {
    console.warn("course-mapper-sweeper: no site url, worker not woken");
    return json(503, { swept: false, reason: "no site url" });
  }
  try {
    const response = await fetch(origin + "/.netlify/functions/course-mapper-worker-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    return json(200, { swept: true, origin, workerStatus: response.status });
  } catch (error) {
    console.warn("course-mapper-sweeper ping failed", error && error.message || error);
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
