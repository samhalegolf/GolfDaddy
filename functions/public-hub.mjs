/* GET/POST /api/public-hub - Studio > Marketing > Public Facing Hub.
 *
 * The one place public course pages (/courses/<courseId>, functions/course-page.mjs) are
 * managed from:
 *   GET                         the rules, and every course with what the rules make of it
 *   POST {action:"rules"}       save the rules (functions/lib/gd-public-hub-rules.mjs)
 *   POST {action:"page"}        switch one course's page on or off by hand. Off also holds it,
 *                               so publishing never switches it back on; on releases the hold.
 *   POST {action:"publish"}     run publishing: switch on every auto-publish match that is not
 *                               on and not held. {dryRun:true} only says what it would do.
 *   POST {action:"header"}      store one header frame (a web-size JPEG the Studio made from a
 *                               snapshot) at course-pages/<courseId>/web/<frame>.jpg
 *
 * course_maps.page_public stays the only switch the page reads; nothing here touches geometry.
 * Admin only, both ways, by the same proof the overlay API uses. */
import { hasSupabase, verifiedAdminEmail, json, supabaseFetch, supabaseBase, supabaseKey } from "./lib/gd-map-overlay-store.mjs";
import { createSupabaseStorage } from "./lib/gd-supabase-storage.mjs";
import { normalizeRules, evaluate, publishPlan, HEADER_FRAMES } from "./lib/gd-public-hub-rules.mjs";

const SETTINGS_TABLE = "public_hub_settings";
const SETTINGS_ID = "rules";
const MAPS_TABLE = "course_maps";
const VISUALS_TABLE = "course_visuals";
const MAP_FIELDS = "course_id,course_name,country,country_code,region,hole_count,object_count,bunker_count,water_count,tree_count,published,page_public,course_lat,course_lng";
/* A header frame is a 585px JPEG (marketing/course-page-assets.mjs WEB_WIDTH); well under this. */
const HEADER_MAX_BYTES = 1500000;

const imageStore = createSupabaseStorage({ base: supabaseBase, key: supabaseKey, bucket: "course-pages" });

export async function loadRules(fetchRows = supabaseFetch) {
  const rows = await fetchRows(SETTINGS_TABLE + "?select=rules,updated_at,updated_by&id=eq." + SETTINGS_ID + "&limit=1").catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : null;
  return { rules: normalizeRules(row && row.rules), updatedAt: row ? row.updated_at : null, updatedBy: row ? row.updated_by : null };
}

async function saveRules(rules, admin) {
  await supabaseFetch(SETTINGS_TABLE + "?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ id: SETTINGS_ID, rules, updated_at: new Date().toISOString(), updated_by: admin })
  });
}

/* How many header frames each course has in the bucket. Root first (one folder per course that
   has anything), then only those folders' web/ - not one call per course in the database. */
export async function headerCounts(store = imageStore) {
  const counts = new Map();
  let folders = [];
  try { folders = (await store.list("")).filter((row) => row && row.name && !row.id).map((row) => row.name); }
  catch (error) { return counts; }
  await Promise.all(folders.map(async (courseId) => {
    try {
      const names = new Set((await store.list(courseId + "/web")).map((row) => row && row.name));
      counts.set(courseId, HEADER_FRAMES.filter((f) => names.has(f + ".jpg")).length);
    } catch (error) { counts.set(courseId, 0); }
  }));
  return counts;
}

export function courseRow(map, visualIds, headers) {
  return {
    courseId: map.course_id,
    name: map.course_name || map.course_id,
    country: map.country || "",
    countryCode: String(map.country_code || "").toUpperCase(),
    region: map.region || "",
    lat: map.course_lat == null ? null : Number(map.course_lat),
    lng: map.course_lng == null ? null : Number(map.course_lng),
    holeCount: Number(map.hole_count) || 0,
    objectCount: Number(map.object_count) || 0,
    bunkerCount: Number(map.bunker_count) || 0,
    waterCount: Number(map.water_count) || 0,
    treeCount: Number(map.tree_count) || 0,
    published: map.published === true,
    visualPublished: visualIds.has(map.course_id),
    pagePublic: map.page_public === true,
    headerCount: headers.get(map.course_id) || 0
  };
}

async function loadCourses() {
  const [maps, visuals, headers] = await Promise.all([
    supabaseFetch(MAPS_TABLE + "?select=" + MAP_FIELDS + "&order=course_name.asc&limit=5000"),
    supabaseFetch(VISUALS_TABLE + "?select=course_id&published_version=gt.0&limit=5000"),
    headerCounts()
  ]);
  const visualIds = new Set((Array.isArray(visuals) ? visuals : []).map((v) => v.course_id));
  return (Array.isArray(maps) ? maps : []).filter((m) => m && m.course_id).map((m) => courseRow(m, visualIds, headers));
}

async function setPagePublic(courseIds, on) {
  const changed = [];
  for (let i = 0; i < courseIds.length; i += 100) {
    const batch = courseIds.slice(i, i + 100);
    const list = batch.map((id) => '"' + String(id).replace(/["\\]/g, "") + '"').join(",");
    const rows = await supabaseFetch(MAPS_TABLE + "?course_id=in.(" + encodeURIComponent(list) + ")&select=course_id", {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ page_public: on })
    });
    (Array.isArray(rows) ? rows : []).forEach((r) => changed.push(r.course_id));
  }
  return changed;
}

function brief(c) { return { courseId: c.courseId, name: c.name, countryCode: c.countryCode }; }

export default async function publicHub(req) {
  if (req.method === "OPTIONS") return json(204, null);
  if (!hasSupabase()) return json(503, { error: "Supabase is not configured" });
  const admin = await verifiedAdminEmail(req);
  if (!admin) return json(403, { error: "Admin verification failed" });

  try {
    if (req.method === "GET") {
      const [stored, courses] = await Promise.all([loadRules(), loadCourses()]);
      const evaluated = evaluate(stored.rules, courses);
      const plan = publishPlan(stored.rules, evaluated);
      return json(200, {
        rules: stored.rules, updatedAt: stored.updatedAt, updatedBy: stored.updatedBy,
        frames: HEADER_FRAMES,
        courses: evaluated,
        publish: { toPublish: plan.toPublish.map(brief), notMatching: plan.notMatching.map(brief) }
      });
    }
    if (req.method !== "POST") return json(405, { error: "Method not allowed" });

    let payload;
    try { payload = await req.json(); } catch (e) { return json(400, { error: "Invalid JSON" }); }
    const action = String(payload && payload.action || "");

    if (action === "rules") {
      const current = (await loadRules()).rules;
      /* The held list is changed by the page switch, never by a rules save from a tab that
         loaded it earlier. */
      const rules = normalizeRules(Object.assign({}, payload.rules, { held: current.held }));
      await saveRules(rules, admin);
      return json(200, { ok: true, rules });
    }

    if (action === "page") {
      const courseId = String(payload.courseId || "").trim();
      if (!courseId) return json(400, { error: "courseId is required" });
      if (typeof payload.pagePublic !== "boolean") return json(400, { error: "pagePublic must be true or false" });
      const changed = await setPagePublic([courseId], payload.pagePublic);
      if (!changed.length) return json(404, { error: "No such course", courseId });
      const stored = (await loadRules()).rules;
      const held = new Set(stored.held);
      if (payload.pagePublic) held.delete(courseId); else held.add(courseId);
      const rules = normalizeRules(Object.assign({}, stored, { held: Array.from(held) }));
      await saveRules(rules, admin);
      return json(200, { ok: true, courseId, pagePublic: payload.pagePublic, held: !payload.pagePublic });
    }

    if (action === "publish") {
      const [stored, courses] = await Promise.all([loadRules(), loadCourses()]);
      const plan = publishPlan(stored.rules, evaluate(stored.rules, courses));
      if (payload.dryRun) return json(200, { ok: true, dryRun: true, toPublish: plan.toPublish.map(brief), notMatching: plan.notMatching.map(brief) });
      const published = await setPagePublic(plan.toPublish.map((c) => c.courseId), true);
      return json(200, { ok: true, published, notMatching: plan.notMatching.map(brief) });
    }

    if (action === "header") {
      const courseId = String(payload.courseId || "").trim();
      const frame = String(payload.frame || "");
      if (!/^[a-z0-9][a-z0-9-]*$/.test(courseId)) return json(400, { error: "courseId is required" });
      if (!HEADER_FRAMES.includes(frame)) return json(400, { error: "frame must be one of " + HEADER_FRAMES.join(", ") });
      const data = String(payload.jpegBase64 || "");
      const buffer = Buffer.from(data, "base64");
      if (!buffer.length || buffer[0] !== 0xff || buffer[1] !== 0xd8) return json(400, { error: "jpegBase64 must be a JPEG" });
      if (buffer.length > HEADER_MAX_BYTES) return json(413, { error: "Header image is too large" });
      const path = courseId + "/web/" + frame + ".jpg";
      await imageStore.upload(path, buffer, "image/jpeg");
      return json(200, { ok: true, courseId, frame, url: imageStore.publicUrl(path) });
    }

    return json(400, { error: "Unknown action" });
  } catch (error) {
    return json(error.status || 503, { error: String(error && error.message || error) });
  }
}

export const config = { path: "/api/public-hub" };
