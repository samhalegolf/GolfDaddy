/* The Apple Watch package for a public course page, made when the page is first opened.
 *
 * The Apple Watch map is the image bake (course_watch_maps; minutes per course, run by
 * functions/course-watch-maps-background.mjs). Studio starts it by hand with an admin's
 * bearer. A course page cannot wait for an admin, so the page function asks the same worker
 * itself, authenticated with CLARITY_SERVICE_SECRET - the server-to-server secret the Booking
 * integration already uses - and the worker only honours that for a course whose page is
 * public. The page is cached at the CDN for a day, so this fires at most about once a day per
 * course until the package exists, and the next render finds it.
 *
 * The Garmin package needs none of this: its GET wakes its own builder (gd-garmin-build-wake). */

export const SERVICE_SECRET_HEADER = "x-clarity-service-secret";

/* A bake whose progress moved inside the worker's budget is still running. The same rule as
   course-watch-maps.mjs's own in-progress check, kept here so both sides agree. */
export const BAKE_WINDOW_MS = 15 * 60 * 1000;

export function bakeInProgress(progress, now) {
  const updatedAt = Date.parse(progress && progress.updatedAt);
  return Number.isFinite(updatedAt) && (now == null ? Date.now() : now) - updatedAt < BAKE_WINDOW_MS;
}

/* True when the page should ask for a bake: no package with any hole yet, and no bake running. */
export function appleBakeNeeded(row, now) {
  if (row && Number(row.ready_hole_count) > 0) return false;
  if (row && bakeInProgress(row.progress, now)) return false;
  return true;
}

/* Constant-time-ish, like clarity-caller.js's secretMatches. */
export function secretMatches(candidate, expected) {
  if (!expected || !candidate || candidate.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ candidate.charCodeAt(i);
  return diff === 0;
}

/* AWAITED, capped, never throws - the same shape as wakeGarminBuild, for the same reasons. */
export async function wakeAppleBake(origin, courseId, secret, fetchImpl = fetch) {
  if (!origin || !courseId || !secret) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchImpl(origin + "/.netlify/functions/course-watch-maps-background", {
      method: "POST",
      headers: { "Content-Type": "application/json", [SERVICE_SECRET_HEADER]: secret },
      body: JSON.stringify({ courseId, reason: "course-page" }),
      signal: controller.signal
    });
    return response.status === 202 || response.ok;
  } catch (error) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
