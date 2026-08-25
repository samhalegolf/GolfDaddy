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

/* Top-level folders in the visuals bucket. One per course id that has ever had a
   frame rendered, whether or not anything in the database still refers to it. */
export async function listBucketFolders(base, key) {
  const response = await fetch(base.replace(/\/+$/, "") + "/storage/v1/object/list/" + VISUAL_BUCKET, {
    method: "POST",
    headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ prefix: "", limit: 1000, offset: 0 })
  });
  if (!response.ok) return [];
  const entries = await response.json().catch(() => []);
  /* A row without an id is a folder; with one it is a stray object at the root. */
  return (Array.isArray(entries) ? entries : []).filter(e => e && e.name && !e.id).map(e => e.name);
}

/* Every course id that owns rows or files but has no course_maps row.
 *
 * STARTS FROM THE BUCKET as well as the tables, and that ordering matters. An
 * earlier version enumerated orphans from table rows only and counted files
 * afterwards - so a course whose rows had already been cleared but whose frames
 * were still in the bucket was invisible to the very tool built to find it. That
 * is not hypothetical: clearing four orphaned course_visuals rows by hand left
 * 474 files and 233MB that this function could no longer see, and "cromwell" had
 * been sitting in that state all along with no row in any table.
 *
 * Files are the thing that costs money and the thing nothing else in the app can
 * show, so they are the primary source of truth here, not an afterthought. */
export async function findOrphans(base, key) {
  const known = new Set(((await rest(base, key, "course_maps?select=course_id")) || [])
    .map(row => row && row.course_id).filter(Boolean));

  const byCourse = new Map();
  const entryFor = courseId => {
    if (!byCourse.has(courseId)) {
      byCourse.set(courseId, { courseId, visuals: 0, visualJobs: 0, mapperJobs: 0, files: 0, bytes: 0, published: false });
    }
    return byCourse.get(courseId);
  };

  (await listBucketFolders(base, key)).forEach(folder => { if (!known.has(folder)) entryFor(folder); });

  const visuals = await rest(base, key, "course_visuals?select=course_id,status,published_version") || [];
  visuals.forEach(row => {
    if (!row.course_id || known.has(row.course_id)) return;
    const entry = entryFor(row.course_id);
    entry.visuals += 1;
    /* Worth surfacing on its own: a PUBLISHED orphan is the one that breaks
       /api/course-package, as opposed to a stale queued job that merely lingers. */
    if (Number(row.published_version) > 0) entry.published = true;
  });
  for (const table of ["course_visual_jobs", "course_mapper_jobs"]) {
    const rows = await rest(base, key, table + "?select=course_id") || [];
    const field = table === "course_visual_jobs" ? "visualJobs" : "mapperJobs";
    rows.forEach(row => {
      if (!row.course_id || known.has(row.course_id)) return;
      entryFor(row.course_id)[field] += 1;
    });
  }

  /* All courses at once, against one shared deadline. Netlify gives a synchronous
     function 10s; 7s leaves room for the table reads above and the response. */
  const deadline = Date.now() + 7000;
  await Promise.all([...byCourse.values()].map(async entry => {
    const listed = await listCourseFiles(base, key, entry.courseId, deadline).catch(() => ({ files: [], partial: true }));
    entry.files = listed.files.length;
    entry.bytes = listed.files.reduce((sum, file) => sum + (file.size || 0), 0);
    /* Says so rather than under-reporting silently: a partial count must not read
       as "this course only has three files". */
    if (listed.partial) entry.filesPartial = true;
  }));

  return [...byCourse.values()].sort((a, b) => b.bytes - a.bytes || a.courseId.localeCompare(b.courseId));
}

/* Objects under "<courseId>/".
 *
 * The list endpoint returns one directory level, so this recurses - but it does so
 * BREADTH-FIRST AND IN PARALLEL, which is not a micro-optimisation. Walking depth
 * first and awaiting each call in turn meant one course with 188 frames spread over
 * a dozen frames/<version>/ folders cost a dozen serial round trips, and five such
 * courses blew straight past Netlify's 10s synchronous limit - the report timed out
 * and answered 502, which is the same symptom it was built to explain.
 *
 * deadline is a timestamp, not a duration: the caller is budgeting one HTTP request
 * across several courses, so each walk has to respect the time already spent. */
export async function listCourseFiles(base, key, courseId, deadline) {
  const prefix = String(courseId || "").replace(/^\/+|\/+$/g, "");
  if (!prefix) return { files: [], partial: false };
  const headers = { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" };
  const listOne = async folder => {
    const response = await fetch(base.replace(/\/+$/, "") + "/storage/v1/object/list/" + VISUAL_BUCKET, {
      method: "POST", headers, body: JSON.stringify({ prefix: folder, limit: 1000, offset: 0 })
    });
    if (!response.ok) return [];
    const entries = await response.json().catch(() => []);
    return Array.isArray(entries) ? entries : [];
  };

  const files = [];
  let frontier = [prefix];
  let partial = false;
  /* Bounded as well as budgeted: a pathological prefix cannot spin forever. */
  for (let depth = 0; depth < 6 && frontier.length; depth++) {
    if (deadline && Date.now() > deadline) { partial = true; break; }
    const levels = await Promise.all(frontier.map(async folder => {
      const entries = await listOne(folder).catch(() => []);
      const next = [];
      entries.forEach(entry => {
        if (!entry || !entry.name) return;
        const path = folder ? folder + "/" + entry.name : entry.name;
        /* A row with an id is an object; without one it is a folder. */
        if (entry.id) files.push({ path, size: Number(entry.metadata && entry.metadata.size) || 0 });
        else next.push(path);
      });
      return next;
    }));
    frontier = levels.flat();
  }
  return { files, partial: partial || frontier.length > 0 };
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
    const files = (await listCourseFiles(base, key, id)).files;
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
