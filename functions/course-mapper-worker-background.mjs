/* Server-side AutoMapper worker (Netlify background function). Structural sibling of
   course-visual-worker-background.mjs's claim/finish pattern.

   Claims a queued course_mapper_jobs row, reads the course's center point from course_maps,
   queries Overpass for OSM golf-course geometry around it, resolves hole guides into
   tee/green/fairway objects (functions/lib/gd-automapper-core.mjs - a from-scratch port of
   the client AutoMapper's pure geometry pipeline), and writes the result into
   course_maps.objects_json/holes_json/geometry_version.

   When OSM exposes shapes but no hole NUMBERS (hasNumberingIssue), falls through to the
   Native Geometry Resolver (functions/lib/gd-geometry-resolver-core.mjs) - a separate
   algorithm that infers numbering from geometry + scorecard evidence. This mirrors the
   client's old two-stage mapping (AutoMapper, then the native resolver as its own fallback)
   entirely server-side, so nothing client-side needs to run either stage anymore.

   Multi-loop courses (hole numbers repeating across separated loops - the Royal Auckland
   case) also hand off to the resolver now instead of refusing outright: the resolver ignores
   OSM refs and numbers holes from scorecard distances, which is exactly the evidence a
   multi-nine site needs. The refusal only remains for the case it was written for - no
   scorecard, or a resolver answer that cannot beat the collapsed count.

   Every run also carries a diagnostics object (queried centre, query stages, OSM feature
   counts, scorecard/resolver state) that is saved on the job result for FAILED runs too, via
   error.diagnostics - a failed row used to keep nothing but the error sentence and an attempt
   counter, which made "wrong centre coordinates" indistinguishable from "course not in OSM". */

import { fetchOverpass } from "./lib/gd-overpass-client.mjs";
import { courseFitVerdict, courseFitMessage } from "./lib/gd-course-fit-core.mjs";
import { osmQueryScope, osmGuideQuery, resolveCourseGeometry, resolveGuidesIntoObjects, classifyCourseRelationship, courseFootprintFrame, osmCourseHoleCountTag, detectHoleNumberCollision, separateLoops, loopIsContiguous, slug, scopeContainsFrame, osmScopeFrame, expandOsmFrame, MAPPER_VERSION } from "./lib/gd-automapper-core.mjs";
import { hasNumberingIssue, resolveCourseGeometryForAutoMapper, guideFromResolvedHole } from "./lib/gd-geometry-resolver-core.mjs";
import { courseBoundsFor } from "./lib/gd-visual-plan-core.mjs";
import { resolveImagerySource, unscannableReason } from "./lib/gd-imagery-sources.mjs";
import { resolveScorecard, toStorePayload } from "./lib/gd-scorecard-resolve.mjs";
import { loopLengthsFromOsm, matchLoopsToCards } from "./lib/gd-scorecard-match-core.mjs";
import pkg from "./lib/safe-remote-url.js";
const { safeRemoteUrl, resolvesToPublicAddress } = pkg;

const JOBS_TABLE = "course_mapper_jobs";
const MAPS_TABLE = "course_maps";
const SCORECARDS_TABLE = "course_scorecards";
const VISUAL_JOBS_TABLE = "course_visual_jobs";

function env(name) { return process.env[name] || ""; }
function supabaseBase() { return env("SUPABASE_URL").replace(/\/+$/, ""); }
function supabaseKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); }

async function supabaseFetch(path, options = {}) {
  const headers = Object.assign({
    apikey: supabaseKey(),
    Authorization: "Bearer " + supabaseKey(),
    "Content-Type": "application/json"
  }, options.headers || {});
  const response = await fetch(supabaseBase() + "/rest/v1/" + path, Object.assign({}, options, { headers }));
  const textBody = await response.text();
  let body = null;
  try { body = textBody ? JSON.parse(textBody) : null; } catch (e) { body = textBody; }
  if (!response.ok) throw new Error("Supabase " + response.status + ": " + (typeof body === "string" ? body : JSON.stringify(body)));
  return body;
}

/* status=eq.queued in the filter makes the claim atomic - two workers racing the same row
   can't both flip it to running. Identical pattern to course-visual-worker-background.mjs's
   claimJob(). */
async function claimJob(jobId) {
  const filter = jobId ? "id=eq." + encodeURIComponent(jobId) + "&" : "";
  const rows = await supabaseFetch(JOBS_TABLE + "?" + filter + "status=eq.queued&order=created_at.asc&limit=1", { method: "GET" });
  const job = Array.isArray(rows) ? rows[0] : null;
  if (!job) return null;
  const claimed = await supabaseFetch(JOBS_TABLE + "?id=eq." + job.id + "&status=eq.queued", {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status: "running", updated_at: new Date().toISOString() })
  });
  return Array.isArray(claimed) && claimed.length ? claimed[0] : null;
}

async function finishJob(id, patch) {
  await supabaseFetch(JOBS_TABLE + "?id=eq." + id, {
    method: "PATCH",
    body: JSON.stringify(Object.assign({ updated_at: new Date().toISOString() }, patch))
  });
}

async function heartbeatJob(job, progress) {
  await supabaseFetch(JOBS_TABLE + "?id=eq." + job.id, {
    method: "PATCH",
    body: JSON.stringify({ updated_at: new Date().toISOString(), result: { progress, attempts: job.result && Number(job.result.attempts) || 0 } })
  }).catch(() => {});
}

/* Is this failure worth trying again?
 *
 * Every job error used to end the same way - status "failed", permanently, with
 * attempts still at 0. That is right for "no OSM hole geometry within range",
 * which will be just as true tomorrow. It is wrong for "Overpass 504", which
 * means a shared public endpoint was busy for a moment and says nothing at all
 * about the course.
 *
 * Large courses feel this most: a site bigger than the default 1400m circle is
 * re-queried on its footprint bbox, and again with WIDER_RETRY_PAD_M if it
 * comes up short of the expected hole count, so a 27-hole complex can send
 * three progressively larger Overpass queries. Bigger queries are the ones that
 * time out, which is why the multi-nine courses were the ones failing.
 *
 * Deliberately a allowlist of transient causes rather than a denylist of
 * terminal ones: an unrecognised error stays terminal and visible, instead of
 * being retried forever because nobody thought to classify it. */
function transientMapperFailure(error) {
  const status = Number(error && error.status);
  /* Upstream said "not now": gateway/proxy failures and explicit rate limits. */
  if (status === 429 || status === 502 || status === 503 || status === 504) return true;
  const message = String(error && error.message || error || "").toLowerCase();
  if (/\b(429|502|503|504)\b/.test(message)) return true;
  return /timeout|timed out|etimedout|econnreset|econnrefused|enotfound|socket hang up|network|fetch failed|too many requests|rate limit|temporarily unavailable/.test(message);
}

/* Four attempts, spaced by the sweeper's own 3-minute cadence, so a course gets
   about twelve minutes to get past a busy Overpass before anyone is told it
   failed. No backoff column is needed for that - requeuing is enough, the
   sweeper supplies the spacing, and gd-overpass-client.mjs still throttles. */
const MAX_TRANSIENT_ATTEMPTS = 4;

/* Jobs stuck "running" belong to a worker that died mid-run. Same reasoning and cutoff as
   course-visual-worker-background.mjs's reapStaleJobs, sized to this job's much shorter
   expected runtime (one Overpass fetch + per-hole resolution, not a multi-minute tile
   snapshot). */
async function reapStaleJobs() {
  const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  try {
    const stale = await supabaseFetch(JOBS_TABLE + "?select=id,result&status=eq.running&updated_at=lt." + encodeURIComponent(cutoff));
    for (const row of Array.isArray(stale) ? stale : []) {
      const attempts = (row.result && Number(row.result.attempts) || 0) + 1;
      const patch = attempts >= 8
        ? { status: "failed", error: "stale-running-reaped: worker died mid-job " + attempts + " times", updated_at: new Date().toISOString() }
        : { status: "queued", error: null, result: Object.assign({}, row.result || {}, { attempts }), updated_at: new Date().toISOString() };
      await supabaseFetch(JOBS_TABLE + "?id=eq." + row.id, { method: "PATCH", body: JSON.stringify(patch) });
    }
  } catch (e) { /* reaping is best-effort */ }
}

async function loadCourseCenter(courseId) {
  const rows = await supabaseFetch(MAPS_TABLE + "?select=course_id,course_name,course_lat,course_lng,objects_json,holes_json&course_id=eq." + encodeURIComponent(courseId) + "&limit=1");
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  const lat = Number(row.course_lat), lng = Number(row.course_lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { courseId: row.course_id, courseName: row.course_name, center: { lat, lng }, objects: row.objects_json || {}, holes: row.holes_json || {} };
}

/* The Overpass sweep around a course centre also covers any sibling course at the same
   facility, and both come back with holes numbered 1-18. Handing those sibling centres to
   resolveCourseGeometry lets it drop guides that belong to the neighbour instead of letting
   them compete for the same hole slots. Sibling rows do NOT need geometry of their own - an
   unmapped sibling still has a centre, and that is all the partition needs.

   Bounding box first to keep this off a full-table scan, same shape as
   course-package.mjs's findDuplicateCourseWithGeometry. */
const SIBLING_SEARCH_PAD_DEG = 0.06;

async function loadSiblingCentres(course) {
  const { center } = course;
  const rows = await supabaseFetch(
    MAPS_TABLE + "?select=course_id,course_name,course_lat,course_lng" +
    "&course_lat=gte." + (center.lat - SIBLING_SEARCH_PAD_DEG) + "&course_lat=lte." + (center.lat + SIBLING_SEARCH_PAD_DEG) +
    "&course_lng=gte." + (center.lng - SIBLING_SEARCH_PAD_DEG) + "&course_lng=lte." + (center.lng + SIBLING_SEARCH_PAD_DEG) + "&limit=50"
  ).catch(() => []);
  return (Array.isArray(rows) ? rows : [])
    .filter(row => row.course_id !== course.courseId)
    .filter(row => classifyCourseRelationship(course, { courseId: row.course_id, courseName: row.course_name }) === "sibling")
    .map(row => ({ lat: Number(row.course_lat), lng: Number(row.course_lng) }))
    .filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lng));
}

async function saveResolvedGeometry(courseId, geometry) {
  const holeCount = Object.keys(geometry.holes || {}).length || null;
  const written = await supabaseFetch(MAPS_TABLE + "?course_id=eq." + encodeURIComponent(courseId), {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      objects_json: geometry.objects,
      holes_json: geometry.holes,
      geometry_version: MAPPER_VERSION,
      /* Denormalised for /api/course-library, which reports hole counts from this column
         rather than reading holes_json. course-maps.mjs writes it on every Studio publish;
         the mapper did not, so a course that had only ever been auto-mapped reported zero
         holes there while Studio - which derives from holes_json - showed eighteen. */
      hole_count: holeCount,
      updated_at: new Date().toISOString()
    })
  });
  /* The PATCH filters on course_id and does not upsert, so with no row it writes nothing and
     still returns 200. Saying "saved" then would be a lie the job result carries forever. */
  if (!Array.isArray(written) || !written.length) {
    throw new Error("course " + courseId + " has no course_maps row to save geometry into");
  }
  return holeCount;
}

/* course_scorecards.course_key is the course's DISPLAY NAME, lowercased and whitespace-
   collapsed - NOT the dash-slugged course_id every other table uses. This has to match
   gdScorecardCourseKey() (scripts/inline/gd-gps-scorecard-owner-v1.js:49) exactly or every
   lookup here misses a scorecard that is sitting right there under a different-looking key. */
function scorecardCourseKey(courseName) {
  return String(courseName || "").trim().replace(/\s+/g, " ").toLowerCase();
}

/* Read-only: this worker never scrapes a club website itself (that parsing lives client-side
   and needs a DOM parser this runtime doesn't have) - it only reads what someone has already
   shared to course_scorecards. No shared scorecard yet means the geometry resolver runs
   without one and correctly reports geometry-resolved-numbering-unavailable rather than
   guessing hole numbers. */
async function fetchScorecardEvidence(courseName) {
  const key = scorecardCourseKey(courseName);
  if (!key) return null;
  try {
    const rows = await supabaseFetch(SCORECARDS_TABLE + "?select=holes_json,source,source_url,sources_json&course_key=eq." + encodeURIComponent(key) + "&limit=1");
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || !Array.isArray(row.holes_json) || !row.holes_json.length) return null;
    return { holes: row.holes_json, source: row.source || "", sourceUrl: row.source_url || "", sources: Array.isArray(row.sources_json) ? row.sources_json : [] };
  } catch (e) {
    return null;
  }
}

/* How many holes the shared scorecard actually lists - distinct valid hole numbers, since a
   card row per tee-set would otherwise double-count. */
function scorecardHoleCount(evidence) {
  if (!evidence || !Array.isArray(evidence.holes)) return null;
  const seen = new Set();
  evidence.holes.forEach(row => {
    const n = Number(row && (row.holeNumber ?? row.hole ?? row.number));
    if (Number.isFinite(n) && n >= 1 && n <= 45) seen.add(Math.round(n));
  });
  return seen.size || null;
}

/* What Overpass actually returned, in numbers a failed job row can carry. "0 golf features
   at this centre" and "40 features, 0 numbered holes" are different problems with different
   fixes, and neither is readable from the error sentence alone. */
function golfFeatureCounts(payload) {
  const elements = (payload && payload.elements) || [];
  const counts = { elements: elements.length, holes: 0, numberedHoles: 0, greens: 0, fairways: 0, tees: 0 };
  elements.forEach(element => {
    const tags = (element && element.tags) || {};
    const golf = String(tags.golf || "").toLowerCase();
    if (golf === "hole") {
      counts.holes += 1;
      if (String(tags.ref || tags.name || "").trim()) counts.numberedHoles += 1;
    } else if (golf === "green") counts.greens += 1;
    else if (golf === "fairway") counts.fairways += 1;
    else if (golf === "tee") counts.tees += 1;
  });
  return counts;
}

/* fetch OSM golf geometry -> resolve into tee/green/fairway objects -> persist.

   Query area, in order of preference: the course's own footprint bbox when it spills outside
   the default 1400m circle (long thin courses - Omaha Beach lost holes 7-9 to the circle),
   otherwise the circle as before. After resolution the hole count is checked against the best
   available expectation (shared scorecard, else the OSM course polygon's holes=N tag): coming
   up short triggers one retry on a wider frame, and if STILL short, the Native Geometry
   Resolver runs with OSM hole numbers ignored - numbering worked out from geometry +
   scorecard instead - and its answer is used when it covers more holes. A scan that remains
   short saves what it has but carries a loud warning on the job result instead of silently
   publishing a partial course. The resolver also still runs in its original case: OSM has
   shapes but no hole numbers at all. */
const WIDER_RETRY_PAD_M = 700;

/* Resolve a card when the shared store has none.
 *
 * fetchScorecardEvidence above is a pure cache read, and the cache has never had a
 * row in it: the parser that filled it was deleted with the old GPS play runtime
 * on 2026-08-02 and nothing replaced it, so every mapper run since has computed
 * expectedHoles = null. This closes that loop.
 *
 * Warn-only and time-boxed. The mapper's job is geometry; a slow or unreachable
 * scorecard site must cost this run its expectedHoles, never its result. Every
 * outcome lands on diagnostics.scorecardResolve so a course that keeps failing to
 * find a card says so in the job row rather than looking like a course that has
 * none. */
const SCORECARD_RESOLVE_BUDGET_MS = 12000;

async function fetchPageHtml(url, signal) {
  const target = safeRemoteUrl(url);
  if (!target) throw new Error("unsafe or unsupported url");
  if (!(await resolvesToPublicAddress(target))) throw new Error("url does not resolve to a public address");
  const response = await fetch(target.href, {
    signal,
    redirect: "follow",
    headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "ClarityCaddie/1.0 (+https://caddy.claritygolf.app)" }
  });
  if (!response.ok) throw new Error("HTTP " + response.status);
  const text = await response.text();
  /* Same cap scorecard-fetch uses - a scorecard table is never megabytes, and an
     unbounded read is how one bad URL becomes a function timeout. */
  return text.slice(0, 650000);
}

async function searchScorecardPages(name, region, origin, signal) {
  if (!origin) return [];
  const response = await fetch(origin + "/.netlify/functions/scorecard-search", {
    method: "POST", signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, region })
  });
  if (!response.ok) return [];
  const payload = await response.json().catch(() => null);
  return ((payload && payload.results) || []).map(result => ({ url: result.url, name: result.title || "" }));
}

async function resolveScorecardForCourse(course, origin) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), SCORECARD_RESOLVE_BUDGET_MS) : null;
  const signal = controller ? controller.signal : undefined;
  try {
    return await resolveScorecard({ courseName: course.courseName, region: course.region, country: course.country }, {
      fetchHtml: url => fetchPageHtml(url, signal),
      search: (name, region) => searchScorecardPages(name, region, origin, signal),
      /* Reads go through fetchScorecardEvidence already; passing readStore here
         would just repeat the query the caller has done. */
      writeStore: async (key, name, cards) => {
        const payload = toStorePayload(cards[0], name);
        if (!payload) return;
        await supabaseFetch(SCORECARDS_TABLE + "?on_conflict=course_key", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify([{
            course_key: key,
            course_name: name,
            source: payload.source,
            source_url: payload.sourceUrl,
            holes_json: payload.holes,
            sources_json: cards.slice(0, 4).map(card => ({ source: card.source, sourceUrl: card.sourceUrl, holes: card.holes.length })),
            updated_at: new Date().toISOString()
          }])
        });
      }
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* Publish every course a separated site produced.
 *
 * The mapper has never created a course_maps row - saveResolvedGeometry PATCHes an
 * existing one and throws when there is none, because rows are created by the picker
 * when a player selects a course. A site with two courses only ever had one row, so
 * publishing both means inserting the siblings here.
 *
 * The pinned loop keeps the row this job was enqueued against, so the player who
 * started the scan gets geometry in the course they actually selected rather than a
 * course that appeared beside it. Its name is corrected to the loop's own OSM name
 * when there is one; its course_id is left alone, because ids are referenced by
 * visuals, shot events and captured surfaces and renaming one orphans all three.
 *
 * osm_course_ref is the stable identity across rescans. Names get edited in OSM and
 * slugs move with them; element ids do not. Matched before the slug for that reason. */
async function findExistingLoopRow(loop, courseId) {
  if (loop.osmRef) {
    const byRef = await supabaseFetch(MAPS_TABLE + "?select=course_id&osm_course_ref=eq." + encodeURIComponent(loop.osmRef) + "&limit=1").catch(() => null);
    if (Array.isArray(byRef) && byRef.length) return byRef[0].course_id;
  }
  const bySlug = await supabaseFetch(MAPS_TABLE + "?select=course_id&course_id=eq." + encodeURIComponent(courseId) + "&limit=1").catch(() => null);
  return Array.isArray(bySlug) && bySlug.length ? bySlug[0].course_id : null;
}

function loopCourseId(loop, course, index) {
  if (loop.name) {
    const fromName = slug(loop.name);
    /* A polygon named for the whole site tells the courses apart no better than a
       number does, so fall through rather than minting two identical ids. */
    if (fromName && fromName !== slug(course.courseName || "") && fromName !== course.courseId) return fromName;
  }
  return slug(course.courseId + "-course-" + (index + 1));
}

/* Which separated loop is which named course.
 *
 * Only runs when OSM did not name the polygons - a name tag is exact and free and
 * beats any inference. When it does run it matches on RELATIVE structure: rank
 * order of hole lengths, and where the short holes fall. Absolute distance cannot
 * be the signal, because a card is measured from one tee set of several, OSM's
 * playing line and a card's yardage disagree on every dogleg, and GolfPass's own
 * per-hole row for Te Arai South sums to 6778 against its own stated 6843.
 *
 * Naming only. A weak or tied answer costs the courses their names, never their
 * geometry - they publish with provisional ids either way. */
function nameLoopsFromCards(loops, cards) {
  if (!Array.isArray(cards) || cards.length < 2) return null;
  if (loops.every(loop => loop.name)) return null;
  const measured = loops
    .map((loop, index) => ({ index, id: "loop-" + index, lengths: loopLengthsFromOsm(loop.payload.elements) }))
    .filter(entry => Object.keys(entry.lengths).length >= 6);
  if (measured.length < 2) return null;
  const result = matchLoopsToCards(measured, cards);
  if (!result.resolved) return { resolved: false, reason: result.reason, score: result.score, margin: result.margin };
  const byId = new Map(result.assignment.map(pair => [pair.loopId, pair.cardName]));
  measured.forEach(entry => {
    const name = byId.get(entry.id);
    if (name && !loops[entry.index].name) {
      loops[entry.index].name = name;
      loops[entry.index].nameSource = "scorecard-match";
    }
  });
  return { resolved: true, score: result.score, margin: result.margin, assignment: result.assignment.map(p => ({ loopId: p.loopId, cardName: p.cardName, signals: p.signals })) };
}

async function publishSeparatedLoops(job, course, loops, expectedHoles, scorecardEvidence, origin) {
  const published = [];
  /* Mutates loops[].name in place, so this must run before ids are derived. */
  const naming = nameLoopsFromCards(loops, course.scorecardCards);
  const otherCentres = loops.map(loop => loop.centre).filter(Boolean);
  for (let index = 0; index < loops.length; index++) {
    const loop = loops[index];
    await heartbeatJob(job, { stage: "publishing-course-" + (index + 1) + "-of-" + loops.length });
    /* index 0 is the pinned loop - separateLoops sorts by distance from the pin. */
    const isPinned = index === 0;
    const derivedId = loopCourseId(loop, course, index);
    const courseId = isPinned ? course.courseId : (await findExistingLoopRow(loop, derivedId)) || derivedId;
    const siblings = otherCentres.filter(centre => centre !== loop.centre);
    const geometry = resolveCourseGeometry(loop.payload, courseId, loop.centre || course.center, [], siblings);

    const row = {
      course_id: courseId,
      course_name: loop.name || course.courseName || courseId,
      course_lat: loop.centre ? loop.centre.lat : course.center.lat,
      course_lng: loop.centre ? loop.centre.lng : course.center.lng,
      osm_course_ref: loop.osmRef || null,
      objects_json: geometry.objects,
      holes_json: geometry.holes,
      geometry_version: MAPPER_VERSION,
      hole_count: Object.keys(geometry.holes || {}).length || null,
      published: true,
      updated_at: new Date().toISOString()
    };
    /* The pinned row exists by definition and must not have its name replaced by a
       blank one when the polygon carried no name. */
    if (isPinned && !loop.name) delete row.course_name;

    if (isPinned) {
      await supabaseFetch(MAPS_TABLE + "?course_id=eq." + encodeURIComponent(courseId), {
        method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(row)
      });
    } else {
      /* on_conflict + merge-duplicates so a rescan updates the sibling it created last
         time instead of failing on its primary key. */
      await supabaseFetch(MAPS_TABLE + "?on_conflict=course_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify([Object.assign({ id: "published::" + courseId, published_at: new Date().toISOString() }, row)])
      });
    }

    const courseBounds = courseBoundsFor({ courseId, objects: geometry.objects, holes: geometry.holes });
    const holeNumbers = Object.keys(geometry.holes || {}).map(Number).filter(Number.isFinite);
    const visualChain = await chainVisualSnapshot(courseId, courseBounds, origin)
      .catch(error => ({ chained: false, reason: String(error && error.message || error).slice(0, 300) }));

    published.push({
      courseId,
      courseName: row.course_name || course.courseName || courseId,
      osmRef: loop.osmRef || null,
      pinned: isPinned,
      method: loop.method,
      nameSource: loop.nameSource || (loop.name ? "osm-polygon" : "derived"),
      holesResolved: geometry.holesResolved,
      guidesFound: geometry.guidesFound,
      greensFound: geometry.greensFound,
      saved: geometry.saved,
      /* Contiguity is judged on what SURVIVED resolution, not on what separation
         handed over - the Te Arai run had 16 guides and six holes, and only the
         second number was ever the truth about the course. */
      contiguous: loopIsContiguous(holeNumbers),
      holeNumbers: holeNumbers.sort((a, b) => a - b),
      awayFromPinM: loop.awayFromPinM,
      courseBounds,
      visualChain
    });
  }
  if (naming) published.naming = naming;
  return published;
}

async function runMapperJob(job, origin) {
  const course = await loadCourseCenter(job.course_id);
  if (!course) throw new Error("course " + job.course_id + " has no known location in " + MAPS_TABLE + " - cannot query Overpass");
  /* Everything learned along the way, attached to any throw via fail() so the default
     handler can save it on the failed job row. The centre goes first because it is the
     question a dead-end failure most needs answered: north-shore failed with "no OSM hole
     geometry within range" while its centre sat in Michigan, and the row had no way to say so. */
  const diagnostics = {
    centre: { lat: course.center.lat, lng: course.center.lng },
    courseName: course.courseName || null
  };
  const fail = message => {
    const error = new Error(message);
    error.diagnostics = diagnostics;
    return error;
  };
  await heartbeatJob(job, { stage: "querying-overpass" });
  let scope = osmQueryScope({}, course.center);
  let payload = await fetchOverpass(osmGuideQuery(scope));
  const queryStages = ["around:" + scope.radiusM];
  const footprint = courseFootprintFrame(payload);
  if (footprint && !scopeContainsFrame(scope, footprint)) {
    scope = osmQueryScope({ osmFrame: footprint }, course.center);
    payload = await fetchOverpass(osmGuideQuery(scope));
    queryStages.push("footprint-bbox");
  }
  diagnostics.queryStages = queryStages;
  diagnostics.osmFeatures = golfFeatureCounts(payload);
  await heartbeatJob(job, { stage: "resolving-geometry" });
  const existingObjects = Object.values(course.objects || {}).filter(Boolean);
  const siblingCentres = await loadSiblingCentres(course).catch(() => []);
  let geometry = resolveCourseGeometry(payload, course.courseId, course.center, existingObjects, siblingCentres);

  let scorecardEvidence = await fetchScorecardEvidence(course.courseName);
  /* Nothing in the shared store: go and find one. Warn-only - see
     resolveScorecardForCourse. A course whose card cannot be found still maps, it
     just maps without the three guards expectedHoles switches on. */
  if (!scorecardEvidence) {
    await heartbeatJob(job, { stage: "resolving-scorecard" });
    const resolved = await resolveScorecardForCourse(course, origin)
      .catch(error => ({ cards: [], reason: String(error && error.message || error).slice(0, 200) }));
    diagnostics.scorecardResolve = {
      cards: (resolved.cards || []).length,
      statedHoleCount: resolved.statedHoleCount || null,
      stored: !!resolved.stored,
      reason: resolved.reason || null,
      attempts: (resolved.attempts || []).slice(0, 6)
    };
    if (resolved.cards && resolved.cards.length) {
      const best = resolved.cards[0];
      scorecardEvidence = { holes: best.holes.map(hole => ({ holeNumber: hole.hole, par: hole.par, distanceM: hole.distanceM })), source: best.source || "scorecard-engine", sourceUrl: best.sourceUrl || "", sources: [] };
    }
    /* A page that says "18 hole, par 72" but whose table would not parse still
       answers the only question expectedHoles asks. */
    if (!scorecardEvidence && resolved.statedHoleCount) diagnostics.statedHoleCount = resolved.statedHoleCount;
    /* Every card found, kept for the loop matcher - a two-course site yields two,
       and telling North from South needs both. */
    if (resolved.cards && resolved.cards.length > 1) diagnostics.scorecardCards = resolved.cards.map(card => ({ name: card.name, source: card.source, par: card.par, holes: card.holes.length }));
    course.scorecardCards = resolved.cards || [];
  }
  const expectedHoles = scorecardHoleCount(scorecardEvidence)
    || osmCourseHoleCountTag(payload)
    || (diagnostics.scorecardResolve && diagnostics.scorecardResolve.statedHoleCount)
    || null;
  diagnostics.scorecardFound = !!scorecardEvidence;
  diagnostics.expectedHoles = expectedHoles;
  const warnings = [];

  /* Hole numbers repeating at separated locations - a site with more than one course.
   *
   * This used to be treated as ambiguity: keep one loop, discard the rest, and refuse
   * outright when that could not be done safely. Both halves were wrong. A second course
   * on the site is not a problem to resolve, it is a course to publish - the player picks
   * which one they are playing from the course list, exactly as they pick between two
   * clubs, and /api/courses-near already lists nearby courses that way. The pin screen
   * stays for the case it exists for: the mapped location being wrong.
   *
   * So the collision detector stops being an error detector and becomes a router:
   *
   *   numbers unique across the site   one course, however many holes. North Shore is 27
   *                                    holes numbered 1-27; one row plus a start hole.
   *   numbers repeat, far apart        N courses. Te Arai Links is two 18s each numbered
   *                                    1-18; Royal Auckland is three loops. N rows.
   *
   * Same function, same output, no longer a failure. */
  let collision = detectHoleNumberCollision(payload);
  let resolverStatus = null;
  let loops = null;

  /* A site wider than the sweep that found it.
   *
   * The collision measures how far apart the same hole number turned up -
   * 2533m at Te Arai Links against a 1400m radius. That is not ambiguity, it is
   * arithmetic: holes beyond the radius were never fetched, so the courses cannot
   * possibly come back whole. Te Arai returned 29 numbered hole ways for a 36-hole
   * site and both separated courses published short.
   *
   * Neither existing widen-er could fire. courseFootprintFrame needs a
   * golf=course / leisure=golf_course polygon and Te Arai has none in OSM (which is
   * also why its courses have no names to inherit), and the wider-retry below is
   * gated on !collision.multiLoop - multi-course sites, the ones most likely to
   * outgrow a radius, were the ones excluded from growing it.
   *
   * Re-queried from the separation itself rather than by a fixed pad: the widest
   * gap between two instances of one hole number is a floor on the site's real
   * extent, so ask for that plus the usual margin. One extra Overpass call, only
   * for a site that has already proven it needs one. */
  if (collision.multiLoop && collision.widestSeparationM > scope.radiusM) {
    await heartbeatJob(job, { stage: "widening-for-multi-course-site" });
    const needM = collision.widestSeparationM + WIDER_RETRY_PAD_M;
    const widerFrame = expandOsmFrame(osmScopeFrame(scope, course.center), needM - scope.radiusM);
    if (widerFrame) {
      const widerPayload = await fetchOverpass(osmGuideQuery(osmQueryScope({ osmFrame: widerFrame }, course.center)));
      const widerCollision = detectHoleNumberCollision(widerPayload);
      /* Adopted only if it actually found more hole features - a wider frame that
         returns the same thing means the site really is that size, and keeping the
         tighter payload avoids dragging a neighbouring club in for nothing. */
      if (widerCollision.holeFeatures > collision.holeFeatures) {
        payload = widerPayload;
        collision = widerCollision;
        queryStages.push("widened-to-site-extent");
        diagnostics.widened = {
          fromRadiusM: scope.radiusM,
          toSpanM: needM,
          holeFeaturesBefore: diagnostics.osmFeatures ? diagnostics.osmFeatures.holes : null,
          holeFeaturesAfter: widerCollision.holeFeatures
        };
        diagnostics.osmFeatures = golfFeatureCounts(payload);
        geometry = resolveCourseGeometry(payload, course.courseId, course.center, existingObjects, siblingCentres);
      }
    }
  }

  if (collision.multiLoop) {
    loops = separateLoops(payload, course.center);
    diagnostics.collision = {
      loops: collision.loops,
      collidedHoles: collision.collidedHoles,
      widestSeparationM: collision.widestSeparationM,
      distinctNumbers: collision.distinctNumbers,
      holeFeatures: collision.holeFeatures
    };
    if (loops) {
      diagnostics.separated = loops.map(loop => ({
        name: loop.name || null,
        osmRef: loop.osmRef || null,
        method: loop.method,
        holes: loop.holeNumbers.length,
        contiguous: loop.contiguous,
        awayFromPinM: loop.awayFromPinM
      }));
    }
  }

  /* Every separated course published, the pinned one into the row this job was enqueued
     against so the player's own selection resolves immediately, the rest into rows of
     their own. Returns early: the single-course path below has nothing left to do. */
  if (loops && loops.length > 1) {
    const published = await publishSeparatedLoops(job, course, loops, expectedHoles, scorecardEvidence, origin);
    diagnostics.published = published.map(entry => ({ courseId: entry.courseId, holes: entry.holesResolved, contiguous: entry.contiguous, nameSource: entry.nameSource }));
    if (published.naming) diagnostics.loopNaming = published.naming;
    const short = published.filter(entry => !entry.contiguous);
    if (short.length) {
      warnings.push(short.length + " of " + published.length + " separated courses did not resolve a contiguous 1..n hole set"
        + " (" + short.map(entry => entry.courseId + ": " + entry.holesResolved).join(", ") + ") - separation is not trustworthy here");
    }
    return {
      courseId: course.courseId,
      mapperVersion: MAPPER_VERSION,
      multiCourse: true,
      coursesPublished: published,
      queryStages,
      expectedHoles,
      warnings: warnings.length ? warnings : undefined,
      diagnostics
    };
  }

  /* One loop and still colliding means separation could not tell the courses apart -
     interleaved beyond what routing continuity can follow, or one course mapped twice.
     The Native Geometry Resolver is the remaining option: it ignores OSM refs entirely
     and derives numbering from scorecard distances, which is the evidence this case
     needs. Refusing stays the honest answer when that cannot work. */
  if (collision.multiLoop) {
    await heartbeatJob(job, { stage: "geometry-resolver" });
    const result = await resolveCourseGeometryForAutoMapper({
      osmPayload: payload,
      courseId: course.courseId,
      course: { courseId: course.courseId, courseName: course.courseName, courseCentre: course.center },
      courseCentre: course.center,
      expectedHoleCount: expectedHoles || undefined,
      scorecardHoles: scorecardEvidence ? scorecardEvidence.holes : [],
      scorecardEvidence: scorecardEvidence || {}
    });
    resolverStatus = { status: result.status, confidence: result.confidence, warnings: result.warnings, hadScorecard: !!scorecardEvidence, trigger: "multi-loop" };
    diagnostics.resolverStatus = resolverStatus;
    const guides = (result.holes || []).map(hole => guideFromResolvedHole(hole, result)).filter(Boolean);
    if (guides.length > collision.distinctNumbers) {
      const resolverGreens = (result.debugEvidence && result.debugEvidence.greenCandidates || []).map(green => ({ center: green.centre, shape: green.polygon }));
      const merged = resolveGuidesIntoObjects(guides, course.courseId, resolverGreens, existingObjects);
      geometry = Object.assign({}, geometry, merged, { holesResolved: guides.length });
    } else {
      diagnostics.fit = Object.assign(
        courseFitVerdict({ collision, expectedHoles, holesResolved: 0, courseBounds: null }),
        { message: courseFitMessage({ trusted: false, reason: "multiple-courses", detail: { loops: collision.loops } }) }
      );
      throw fail(
        "multi-course site: hole number" + (collision.collidedHoles.length === 1 ? " " : "s ")
        + collision.collidedHoles.join(", ")
        + " appear in " + collision.loops + " separate locations up to "
        + collision.widestSeparationM + "m apart"
        + " - " + collision.holeFeatures + " hole features resolve to only "
        + collision.distinctNumbers + " distinct numbers."
        + " Loop separation could not tell the courses apart"
        + (scorecardEvidence
          ? ", and the geometry resolver returned only " + guides.length + " holes (status: " + result.status + ")."
          : ", and there is no shared scorecard to derive physical numbering from - share one for this course and remap.")
      );
    }
  }

  if (!collision.multiLoop && expectedHoles && geometry.holesResolved < expectedHoles) {
    await heartbeatJob(job, { stage: "retry-wider-frame" });
    const widerFrame = expandOsmFrame(osmScopeFrame(scope, course.center), WIDER_RETRY_PAD_M);
    if (widerFrame) {
      const widerPayload = await fetchOverpass(osmGuideQuery(osmQueryScope({ osmFrame: widerFrame }, course.center)));
      const widerGeometry = resolveCourseGeometry(widerPayload, course.courseId, course.center, existingObjects, siblingCentres);
      if (widerGeometry.holesResolved > geometry.holesResolved) {
        geometry = widerGeometry;
        payload = widerPayload;
        queryStages.push("wider-retry");
        diagnostics.osmFeatures = golfFeatureCounts(payload);
      }
    }
  }

  const numberingIssue = !collision.multiLoop && !geometry.holesResolved && hasNumberingIssue({ osmPayload: payload });
  const shortOfExpected = !!(!collision.multiLoop && expectedHoles && geometry.holesResolved < expectedHoles);
  if (numberingIssue || shortOfExpected) {
    await heartbeatJob(job, { stage: "geometry-resolver" });
    const result = await resolveCourseGeometryForAutoMapper({
      osmPayload: payload,
      courseId: course.courseId,
      course: { courseId: course.courseId, courseName: course.courseName, courseCentre: course.center },
      courseCentre: course.center,
      expectedHoleCount: expectedHoles || undefined,
      scorecardHoles: scorecardEvidence ? scorecardEvidence.holes : [],
      scorecardEvidence: scorecardEvidence || {}
    });
    resolverStatus = { status: result.status, confidence: result.confidence, warnings: result.warnings, hadScorecard: !!scorecardEvidence, trigger: numberingIssue ? "no-osm-numbering" : "short-of-expected" };
    diagnostics.resolverStatus = resolverStatus;
    const guides = (result.holes || []).map(hole => guideFromResolvedHole(hole, result)).filter(Boolean);
    /* The resolver's numbering (scorecard-derived, OSM refs ignored) only replaces the
       OSM-numbered answer when it genuinely covers MORE holes - a lower-coverage resolver run
       must not clobber good numbered geometry. In the no-numbering case anything it found is
       strictly better than the nothing OSM numbering produced. */
    if (guides.length > geometry.holesResolved) {
      const resolverGreens = (result.debugEvidence && result.debugEvidence.greenCandidates || []).map(green => ({ center: green.centre, shape: green.polygon }));
      const base = numberingIssue ? Object.values(geometry.objects) : existingObjects;
      const merged = resolveGuidesIntoObjects(guides, course.courseId, resolverGreens, base);
      geometry = Object.assign({}, geometry, merged, { holesResolved: guides.length });
    }
  }
  if (!geometry.holesResolved) {
    const reason = resolverStatus ? "geometry resolver status: " + resolverStatus.status + (resolverStatus.hadScorecard ? "" : " (no shared scorecard found)") : "no OSM hole geometry within range";
    /* The queried centre rides in the sentence itself: "no hole geometry HERE" is only
       actionable when the row says where "here" was - north-shore's centre sat in Michigan
       and nothing surfaced it. */
    throw fail("no numbered hole geometry found for " + course.courseId + " (" + reason + ") - queried centre " + course.center.lat.toFixed(5) + "," + course.center.lng.toFixed(5));
  }
  if (expectedHoles && geometry.holesResolved < expectedHoles) {
    warnings.push("expected " + expectedHoles + " holes (" + (scorecardHoleCount(scorecardEvidence) ? "shared scorecard" : "OSM holes tag") + ") but resolved " + geometry.holesResolved + " - published incomplete after wider retry" + (resolverStatus ? " and geometry resolver" : ""));
  }
  await saveResolvedGeometry(course.courseId, geometry);
  /* Same bounds the visual planner computes, needed twice now - once below for
     the visual chain, once here to judge whether these holes can plausibly be
     one course. */
  const courseBounds = courseBoundsFor({ courseId: course.courseId, objects: geometry.objects, holes: geometry.holes });
  /* Whether the coordinate this run was given can be trusted, decided from what
     the run actually found. The player is only asked to drag a pin when this
     says the answer is clearly wrong - see lib/gd-course-fit-core.mjs. */
  const fit = courseFitVerdict({
    collision,
    expectedHoles,
    holesResolved: geometry.holesResolved,
    /* The hole numbers themselves, so the verdict can notice a set that does not
       run 1..n without needing a scorecard to compare against. */
    holeNumbers: Object.keys(geometry.holes || {}).map(Number).filter(Number.isFinite),
    courseBounds
  });
  /* Carried rather than rebuilt client-side: the player is being asked to do
     work, so the sentence explaining why lives next to the rule that decided
     it. */
  if (!fit.trusted) fit.message = courseFitMessage(fit);
  diagnostics.fit = fit;
  return {
    courseId: course.courseId,
    fit,
    mapperVersion: MAPPER_VERSION,
    guidesFound: geometry.guidesFound,
    greensFound: geometry.greensFound,
    holesResolved: geometry.holesResolved,
    saved: geometry.saved,
    polygons: geometry.polygons,
    fallbacks: geometry.fallbacks,
    queryStages,
    expectedHoles,
    warnings: warnings.length ? warnings : undefined,
    resolverStatus,
    /* Carried on the result so chainVisualSnapshot below can run the licensing check without
       re-reading the row it just wrote, and so a job's record shows what ground the mapper
       actually covered. */
    courseBounds,
    /* On success too, not only on failure. Diagnostics used to ride on error.diagnostics
       alone, so the run that most needed explaining recorded the least: Te Arai published
       six holes of a 36-hole site with status "done" and kept no record of what separation
       dropped. A job that succeeded and was wrong is exactly the case this exists for. */
    diagnostics
  };
}

/* The missing link in the hands-off chain: a successful mapping run used to end right here,
   so a brand-new course got geometry but no frames until a player happened to REOPEN it -
   the app's own kind:"auto" visual request had already been refused ("no published
   geometry") while mapping was still running, and it does not retry. Enqueue the snapshot
   the moment geometry lands; the visual worker auto-chains the export, which completes
   select course -> automap -> snapshot -> export -> frames with nobody in Studio.

   Same shape as the two existing auto-enqueue hooks (course-maps.mjs publish -> snapshot,
   visual worker snapshot -> export): deduped against a live snapshot, and warn-only - the
   mapping job it rides on has already succeeded and must never be failed by queue trouble.

   Licensing is checked first only to avoid queueing a job whose one possible outcome is
   "imagery-source-unavailable" (the visual worker stays the real gate) - an unlicensed-region
   course keeps its geometry and plays live tiles, exactly as before. No confidence gate
   beyond the ones that already exist: the mapper fails outright without numbered holes, and
   the visual planner only shoots play-ready holes and refuses an empty plan. */
async function chainVisualSnapshot(courseId, courseBounds, origin) {
  const source = resolveImagerySource(courseBounds);
  if (!source) return { chained: false, reason: "imagery-source-unavailable: " + unscannableReason(courseBounds) };
  const existing = await supabaseFetch(VISUAL_JOBS_TABLE + "?select=id&course_id=eq." + encodeURIComponent(courseId) + "&kind=eq.snapshot&status=in.(queued,running)&limit=1");
  if (Array.isArray(existing) && existing.length) return { chained: false, reason: "snapshot-already-live" };
  await supabaseFetch(VISUAL_JOBS_TABLE, {
    method: "POST",
    body: JSON.stringify([{ course_id: courseId, kind: "snapshot", status: "queued", requested_by: "auto-after-automap" }])
  });
  /* Wake the visual worker now rather than waiting for its 10-minute sweeper. Awaited with a
     swallow, same reasoning as course-visual-jobs.mjs's pingWorker: a lost ping only means
     the queued job waits for the sweep. */
  if (origin) {
    await fetch(origin + "/.netlify/functions/course-visual-worker-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    }).catch(() => {});
  }
  return { chained: true };
}

export default async function courseMapperWorker(req) {
  if (!supabaseBase() || !supabaseKey()) return new Response("supabase not configured", { status: 503 });
  let payload = {};
  try { payload = await req.json(); } catch (e) { payload = {}; }
  let origin = "";
  try { origin = new URL(req.url).origin; } catch (e) { origin = ""; }
  await reapStaleJobs();
  let job = await claimJob(payload && payload.jobId || null);
  while (job) {
    try {
      const result = await runMapperJob(job, origin);
      /* Chained BEFORE finishJob so the outcome rides on the job's own result row - a course
         whose frames never appeared should say why in the same place everything else about
         the run is recorded. The catch keeps the contract above: geometry saved means the
         job is "done", whatever the visual queue thought of it. */
      /* A multi-course run chained a snapshot per published course inside
         publishSeparatedLoops, where the per-course bounds live; chaining the parent
         again here would queue a job for a course_id that now holds only one of them. */
      if (!result.multiCourse) {
        result.visualChain = await chainVisualSnapshot(job.course_id, result.courseBounds, origin)
          .catch(error => ({ chained: false, reason: String(error && error.message || error).slice(0, 300) }));
      }
      await finishJob(job.id, { status: "done", result, error: null });
    } catch (error) {
      console.error("course-mapper-worker job failed", job.id, error);
      const attempts = (job.result && Number(job.result.attempts) || 0) + 1;
      const retryable = transientMapperFailure(error) && attempts < MAX_TRANSIENT_ATTEMPTS;
      const message = String(error && error.message || error).slice(0, 900);
      /* Requeued rather than failed: the sweeper picks it back up on its next
         pass. attempts is carried on the job result, the same counter the stale
         reaper uses, so the two retry paths cannot disagree about how many
         goes a job has had. */
      /* Whatever the run learned before it died - queried centre, query stages, feature
         counts, scorecard/resolver state - lands on the job row instead of evaporating.
         Failed rows used to keep only the error sentence and an attempt counter. */
      const diagnostics = error && error.diagnostics || null;
      const patch = retryable
        ? { status: "queued", error: null, result: Object.assign({}, job.result || {}, { attempts, lastTransientError: message }, diagnostics ? { diagnostics } : {}) }
        : { status: "failed", error: attempts > 1 ? message + " (after " + attempts + " attempts)" : message, result: Object.assign({}, job.result || {}, { attempts }, diagnostics ? { diagnostics } : {}) };
      await finishJob(job.id, patch).catch(() => {});
    }
    job = await claimJob(null);
  }
  return new Response("ok", { status: 200 });
}

export const __courseMapperWorkerTest = { claimJob, finishJob, heartbeatJob, reapStaleJobs, runMapperJob, chainVisualSnapshot, transientMapperFailure, golfFeatureCounts, MAX_TRANSIENT_ATTEMPTS };
