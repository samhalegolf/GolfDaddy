/* Data a deleted course left behind, and the means to remove it.
 *
 * A course owns rows in four tables and a folder of rendered frames in the
 * course-visuals bucket. Deleting it used to remove two of those, so the rest
 * stayed - and not harmlessly: a published course_visuals row whose course_maps
 * row is gone made /api/course-package answer "full-map-ready" for a null map,
 * hand it to shapeFullPackage, and 502 on every request for that course id. Four
 * courses were in that state (omaha-beach, saint-andrews, royal-auckland,
 * north-shore) holding 474 files and 233MB between them.
 *
 * Both halves live here so the delete path and the "what is left behind" report
 * cannot disagree about what a course owns. course-maps.mjs calls purgeCourseData
 * when a course is deleted; course-orphans.mjs calls findOrphans to show what
 * earlier deletes missed and purgeCourseData to clear it.
 *
 * FILES GO THROUGH THE STORAGE API, NEVER SQL. Supabase is explicit that deleting
 * from storage.objects leaves the underlying object orphaned in the bucket - still
 * stored, still billed, no longer listed. A SQL delete would look like it worked
 * and quietly make the problem permanent. */

export const VISUAL_BUCKET = "course-visuals";
const COURSE_TABLES = ["course_visuals", "course_visual_jobs", "course_mapper_jobs"];

function restUrl(base, path) { return base.replace(/\/+$/, "") + "/rest/v1/" + path; }

async function rest(base, key, path, options = {}) {
  const response = await fetch(restUrl(base, path), Object.assign({}, options, {
    headers: Object.assign({
      apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json"
    }, options.headers || {})
  }));
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  if (!response.ok) throw new Error("Supabase " + response.status + ": " + (typeof body === "string" ? body : JSON.stringify(body)));
  return body;
}

/* Every course id that owns rows or files but has no course_maps row.
 *
 * Storage is included because a course can be fully absent from every table and
 * still hold a folder of frames - which is exactly the state a SQL-only cleanup
 * leaves behind, and the state that costs money silently. */
export async function findOrphans(base, key) {
  const known = new Set(((await rest(base, key, "course_maps?select=course_id")) || [])
    .map(row => row && row.course_id).filter(Boolean));

  const byCourse = new Map();
  const note = (courseId, patch) => {
    if (!courseId || known.has(courseId)) return;
    const entry = byCourse.get(courseId) || { courseId, visuals: 0, visualJobs: 0, mapperJobs: 0, files: 0, bytes: 0, published: false };
    byCourse.set(courseId, Object.assign(entry, patch(entry)));
  };

  const visuals = await rest(base, key, "course_visuals?select=course_id,status,published_version") || [];
  visuals.forEach(row => note(row.course_id, entry => ({
    visuals: entry.visuals + 1,
    /* Worth surfacing on its own: a PUBLISHED orphan is the one that breaks
       /api/course-package, as opposed to a stale queued job that merely lingers. */
    published: entry.published || Number(row.published_version) > 0
  })));
  for (const table of ["course_visual_jobs", "course_mapper_jobs"]) {
    const rows = await rest(base, key, table + "?select=course_id") || [];
    const field = table === "course_visual_jobs" ? "visualJobs" : "mapperJobs";
    rows.forEach(row => note(row.course_id, entry => ({ [field]: entry[field] + 1 })));
  }

  for (const courseId of [...byCourse.keys()]) {
    const listed = await listCourseFiles(base, key, courseId).catch(() => []);
    const entry = byCourse.get(courseId);
    entry.files = listed.length;
    entry.bytes = listed.reduce((sum, file) => sum + (file.size || 0), 0);
  }
  return [...byCourse.values()].sort((a, b) => b.bytes - a.bytes || a.courseId.localeCompare(b.courseId));
}

/* Objects under "<courseId>/", walked by hand: the list endpoint returns one
   directory level and frames live under <courseId>/frames/<version>/. */
export async function listCourseFiles(base, key, courseId) {
  const prefix = String(courseId || "").replace(/^\/+|\/+$/g, "");
  if (!prefix) return [];
  const headers = { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" };
  const walk = async folder => {
    const response = await fetch(base.replace(/\/+$/, "") + "/storage/v1/object/list/" + VISUAL_BUCKET, {
      method: "POST", headers, body: JSON.stringify({ prefix: folder, limit: 1000, offset: 0 })
    });
    if (!response.ok) return [];
    const entries = await response.json().catch(() => []);
    const out = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || !entry.name) continue;
      const path = folder ? folder + "/" + entry.name : entry.name;
      /* A row with an id is an object; without one it is a folder. */
      if (entry.id) out.push({ path, size: Number(entry.metadata && entry.metadata.size) || 0 });
      else out.push(...await walk(path));
    }
    return out;
  };
  return walk(prefix);
}

/* Everything one course owns, removed. Best effort per step and counted, so a
   partial cleanup is visible rather than silent - a course that is gone must not
   come back because one of its leftovers refused to delete. */
export async function purgeCourseData(base, key, courseId, options = {}) {
  const id = String(courseId || "").trim();
  const result = { courseId: id, visuals: 0, visualJobs: 0, mapperJobs: 0, files: 0, bytes: 0, errors: [] };
  if (!id || !base || !key) { result.errors.push("missing courseId or Supabase credentials"); return result; }

  for (const table of COURSE_TABLES) {
    if (table === "course_mapper_jobs" && options.keepMapperJobs) continue;
    try {
      const removed = await rest(base, key, table + "?course_id=eq." + encodeURIComponent(id), {
        method: "DELETE", headers: { Prefer: "return=representation" }
      });
      const count = Array.isArray(removed) ? removed.length : 0;
      if (table === "course_visuals") result.visuals = count;
      else if (table === "course_visual_jobs") result.visualJobs = count;
      else result.mapperJobs = count;
    } catch (error) {
      result.errors.push(table + ": " + String(error && error.message || error).slice(0, 200));
    }
  }

  try {
    const files = await listCourseFiles(base, key, id);
    const headers = { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" };
    for (let i = 0; i < files.length; i += 100) {
      const batch = files.slice(i, i + 100);
      const response = await fetch(base.replace(/\/+$/, "") + "/storage/v1/object/" + VISUAL_BUCKET, {
        method: "DELETE", headers, body: JSON.stringify({ prefixes: batch.map(file => file.path) })
      });
      if (response.ok) {
        result.files += batch.length;
        result.bytes += batch.reduce((sum, file) => sum + file.size, 0);
      } else {
        result.errors.push("storage " + response.status);
        break;
      }
    }
  } catch (error) {
    result.errors.push("storage: " + String(error && error.message || error).slice(0, 200));
  }
  return result;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}
