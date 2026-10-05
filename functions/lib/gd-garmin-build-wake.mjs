/* Wakes functions/course-garmin-maps-background.mjs for one course.

   Called after the normal course package is made (the end of a mapper run, the end of a
   visual export) and by the phone's GET when it finds the Garmin package missing or behind.
   The worker decides for itself whether anything needs building, so a spare wake costs one
   read and nothing else.

   AWAITED by every caller, never fire-and-forget: serverless freezes the process the moment a
   handler returns, so an un-awaited fetch never leaves (the same rule as the mapper's and the
   visual worker's own wakes). The worker is a background function that acks 202 at once, so
   this costs a few hundred ms, capped at 8 s. It never throws: the work it follows has
   already succeeded and must not be failed by a lost wake - the phone's next GET wakes it
   again. */
export async function wakeGarminBuild(origin, courseId) {
  if (!origin || !courseId) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(origin + "/.netlify/functions/course-garmin-maps-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ courseId }),
      signal: controller.signal
    });
    return response.status === 202 || response.ok;
  } catch (error) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
