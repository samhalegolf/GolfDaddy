/* Test bakes: the normal capture + bake pipeline, run against a source whose output we may
 * look at but not keep (Mapbox), into a sandbox that players can never reach.
 *
 * What makes a bake a TEST bake, all enforced in code rather than by convention:
 *   - its own job kinds (test-snapshot, test-export). The player-facing build state in
 *     course-visual-jobs.mjs ignores them, so a running test never shows a course as building;
 *   - its own PRIVATE Storage bucket (course-visual-tests). The public asset proxy only serves
 *     course-visuals, so there is no URL a player could be handed; Studio reads test frames
 *     through short-lived signed links from an admin-only endpoint;
 *   - it never writes course_visuals, never writes the course's live captures/ or frames/
 *     index, and never sweeps the course's live frame versions;
 *   - everything it stores sits under a date folder and is deleted after RETENTION_DAYS.
 *
 * The geometry baked is the course's current published geometry, read exactly as the live
 * bake reads it. Only the imagery and elevation source differ.
 *
 * Pure apart from the injected storage in purgeTestBakes. */

export const TEST_BAKE_BUCKET = "course-visual-tests";
export const TEST_BAKE_RETENTION_DAYS = 7;
export const TEST_SNAPSHOT_KIND = "test-snapshot";
export const TEST_EXPORT_KIND = "test-export";
export const TEST_BAKE_SOURCES = Object.freeze(["mapbox"]);

const ROOT_RE = /^\d{4}-\d{2}-\d{2}\/[a-z0-9][a-z0-9-]{0,90}\/[a-z0-9-]{6,40}$/;

export function isTestKind(kind) {
  return kind === TEST_SNAPSHOT_KIND || kind === TEST_EXPORT_KIND;
}

/* <date>/<courseId>/<runId>. Date first so retention is one list of the bucket root. */
export function testBakeRoot(courseId, runId, now) {
  const date = new Date(now || Date.now()).toISOString().slice(0, 10);
  return date + "/" + String(courseId) + "/" + String(runId);
}

export function newTestRun({ courseId, source, requestedBy, now, random }) {
  const at = now || Date.now();
  const rand = random || Math.random;
  const runId = "t" + at.toString(36) + "-" + Math.floor(rand() * 1e8).toString(36);
  return {
    source: String(source),
    runId,
    root: testBakeRoot(courseId, runId, at),
    requestedAt: new Date(at).toISOString(),
    requestedBy: String(requestedBy || "")
  };
}

/* The run a test job carries on its recipe column, validated - a test job with a malformed
   or foreign root must fail rather than write somewhere it was never meant to. */
export function testRunFromJob(job) {
  const run = job && job.recipe && job.recipe.testRun;
  if (!run || typeof run !== "object") throw new Error("test job has no testRun");
  if (!TEST_BAKE_SOURCES.includes(run.source)) throw new Error("test job source " + JSON.stringify(run.source) + " is not a test source");
  const root = String(run.root || "");
  if (!ROOT_RE.test(root) || root.split("/")[1] !== String(job.course_id)) throw new Error("test job root " + JSON.stringify(root) + " does not belong to " + job.course_id);
  return { source: run.source, runId: String(run.runId || ""), root, requestedAt: run.requestedAt || null, requestedBy: run.requestedBy || "" };
}

/* Every object under a prefix, recursively. Storage list returns folders with id null. */
async function listFiles(storage, prefix) {
  const out = [];
  for (const entry of await storage.list(prefix)) {
    if (!entry || !entry.name) continue;
    const path = prefix + entry.name;
    if (entry.id === null || entry.id === undefined) out.push(...await listFiles(storage, path + "/"));
    else out.push(path);
  }
  return out;
}

/* Date folders older than the retention window, deleted whole. storage: { list, remove }. */
export async function purgeTestBakes(storage, options = {}) {
  const days = Number(options.days) || TEST_BAKE_RETENTION_DAYS;
  const cutoff = new Date((options.now || Date.now()) - days * 86400000).toISOString().slice(0, 10);
  const dates = (await storage.list(""))
    .map(entry => String(entry && entry.name || ""))
    .filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name) && name < cutoff);
  let removed = 0;
  for (const date of dates) {
    const files = await listFiles(storage, date + "/");
    for (let i = 0; i < files.length; i += 500) {
      const batch = files.slice(i, i + 500);
      await storage.remove(batch);
      removed += batch.length;
    }
  }
  return { cutoff, dates, removed };
}
