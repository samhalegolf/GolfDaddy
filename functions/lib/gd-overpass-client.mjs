/* Overpass API client for the server-side AutoMapper worker.

   Moving AutoMapper server-side concentrates every course-mapping request onto Netlify's
   function IP range instead of spreading it across thousands of player devices - a real
   change in how this traffic looks to a shared, goodwill-based public API whose usage policy
   explicitly discourages concentrated automated querying without a dedicated instance. This
   client does not solve that risk (see the migration plan's open decision #1 - relocating as
   the cheap option was accepted for now); it only keeps it from getting worse than it has to:
   a descriptive User-Agent (Overpass's policy asks for one so a heavy source can be traced
   and contacted before being blocked outright), a conservative GLOBAL (not per-course) rate
   limiter since Overpass throttles by source IP, exponential backoff on 429/504, and a
   process-lifetime cache keyed by the exact query so a re-run for the same course within one
   warm container doesn't refetch. */

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const USER_AGENT = "ClarityCaddyAutoMapper/1 (server-side course geometry mapping; contact samhalegolf@gmail.com)";

/* One request in flight at a time, plus a minimum gap between requests. This is a worker
   claiming one job at a time from a queue (see course-mapper-worker-background.mjs), not a
   fleet of concurrent invocations, so a per-process limiter is enough to keep this instance
   polite; it does not coordinate across multiple warm containers. */
const MIN_INTERVAL_MS = 1200;
let lastRequestAt = 0;
let queue = Promise.resolve();

const RETRY_STATUSES = new Set([429, 504]);
const MAX_RETRIES = 4;

/* Cache survives for the lifetime of a warm container; there is no cross-invocation
   persistence and none is needed - a course is mapped once and the geometry is then read
   from course_maps, not re-fetched from Overpass. */
const responseCache = new Map();
const CACHE_MAX_ENTRIES = 64;

function cacheGet(key) {
  return responseCache.has(key) ? responseCache.get(key) : null;
}
function cachePut(key, value) {
  responseCache.set(key, value);
  if (responseCache.size > CACHE_MAX_ENTRIES) {
    const oldest = responseCache.keys().next().value;
    responseCache.delete(oldest);
  }
}

async function throttle() {
  const wait = Math.max(0, lastRequestAt + MIN_INTERVAL_MS - Date.now());
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

async function requestOnce(query) {
  await throttle();
  const response = await fetch(OVERPASS_URL + "?data=" + encodeURIComponent(query), {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT }
  });
  if (!response.ok) {
    const error = new Error("Overpass " + response.status);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

/* Serialised through `queue` so overlapping calls within one process still respect
   MIN_INTERVAL_MS instead of racing the throttle check. */
export async function fetchOverpass(query) {
  const cached = cacheGet(query);
  if (cached) return cached;
  const run = queue.then(async () => {
    let lastError = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const data = await requestOnce(query);
        cachePut(query, data);
        return data;
      } catch (error) {
        lastError = error;
        if (!RETRY_STATUSES.has(error && error.status)) throw error;
        if (attempt < MAX_RETRIES - 1) await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt)));
      }
    }
    throw lastError || new Error("Overpass request failed");
  });
  /* Keep the shared queue alive even if this particular request ultimately rejects, so one
     failure doesn't wedge every request queued behind it. */
  queue = run.catch(() => {});
  return run;
}

export const __overpassClientTest = { responseCache, MIN_INTERVAL_MS, RETRY_STATUSES };
