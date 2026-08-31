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
import { courseFitVerdict, courseFitMessage, courseCoverageComplete } from "./lib/gd-course-fit-core.mjs";
import { osmQueryScope, osmGuideQuery, resolveCourseGeometry, resolveGuidesIntoObjects, classifyCourseRelationship, courseFootprintFrame, osmCourseHoleCountTag, detectHoleNumberCollision, detectUnnumberedMultiLoop, separateLoops, loopIsContiguous, provisionalLoopName, compassPointFrom, slug, scopeContainsFrame, osmScopeFrame, expandOsmFrame, holeFeatureFrame, frameCentre, unionOsmFrames, holeGapFrames, mergeOsmPayloads, distance, splitCourseName, MAPPER_VERSION } from "./lib/gd-automapper-core.mjs";
import { hasNumberingIssue, resolveCourseGeometryForAutoMapper, guideFromResolvedHole } from "./lib/gd-geometry-resolver-core.mjs";
import { courseBoundsFor } from "./lib/gd-visual-plan-core.mjs";
import { resolveImagerySource, unscannableReason } from "./lib/gd-imagery-sources.mjs";
import { resolveScorecard, distinctCardCount, distinctCards, facilityScorecardRow, stitchedCardVerdict } from "./lib/gd-scorecard-resolve.mjs";
import { reconcileFacilityClaims, atomicLoopCount, HOLES_PER_LOOP } from "./lib/gd-facility-loops-core.mjs";
import { assessFacilityStructure, contestedClaims, describeClaimGround, isIndependentClaim, mappingMethodFor, organiseFacility, planNextRound, summariseMappingMethod, FACILITY_STRUCTURE, MAPPING_METHOD } from "./lib/gd-facility-structure-core.mjs";
import { loopLengthsFromOsm, lineLengthM, matchLoopsToCards, scorePairing, courseLengthsFromPublishedGeometry } from "./lib/gd-scorecard-match-core.mjs";
import { planListingResolution, RESOLUTION_MODE } from "./lib/gd-course-listing-core.mjs";
import { eliminateInferredCourses } from "./lib/gd-inferred-course-claims-core.mjs";
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

/* Every distinct card stored for a facility - the broader read fetchScorecardEvidence
   above cannot do, since it looks up exactly one course_key. Used both to let a
   rescan skip re-fetching cards a prior Update Scorecards run already found, and
   as the Native Geometry Resolver's fallback when its own targeted lookup misses. */
async function fetchFacilityScorecardEvidence(facilityKey) {
  if (!facilityKey) return [];
  try {
    const rows = await supabaseFetch(SCORECARDS_TABLE + "?select=course_key,course_name,holes_json,source,source_url,sources_json&facility_key=eq." + encodeURIComponent(facilityKey));
    return (Array.isArray(rows) ? rows : []).filter(row => Array.isArray(row.holes_json) && row.holes_json.length);
  } catch (e) {
    return [];
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

/* The margin a widened frame keeps around the holes it already has. Te Arai's clip
   was 82m, so anything in the hundreds clears this class of failure; 400m also
   covers the hole that was cut off completely rather than merely clipped. */
const WIDEN_DATA_PAD_M = 400;

/* Fill a hole-sized hole.
 *
 * Te Arai Links Course 2 separated cleanly and came out 1,2,3,4,_,6..18 - every
 * hole but the 5th, whose geometry fell just outside the query box. Widening the
 * whole site frame to catch it is the expensive answer and the one that risks
 * dragging a neighbouring club in; the cheap answer is that a golf routing is
 * continuous, so the missing hole HAS to lie between hole 4's green and hole 6's
 * tee. holeGapFrames turns that into a small box, and this asks Overpass for it.
 *
 * Bounded three ways: only gaps of 1-2 holes (a five-hole gap is a separation bug,
 * not a clip), at most HOLE_GAP_MAX_QUERIES boxes per scan, and the merged result
 * is adopted only if separation genuinely improves. That last one matters - the
 * original 6-hole publish got through on an adoption rule of "holesResolved > 0",
 * which is not a floor at all. */
const HOLE_GAP_MAX_QUERIES = 3;

function separationScore(loops) {
  return {
    courses: loops.length,
    contiguous: loops.filter(loop => loop.contiguous).length,
    holes: loops.reduce((sum, loop) => sum + loop.holeNumbers.length, 0)
  };
}

async function requeryHoleGaps(job, course, payload, loops) {
  const gaps = [];
  loops.forEach(loop => {
    if (loop.contiguous) return;
    holeGapFrames(loop.payload).forEach(gap => gaps.push(Object.assign({ courseIndex: loop.index }, gap)));
  });
  const record = {
    gaps: gaps.map(gap => ({ courseIndex: gap.courseIndex, missing: gap.missing, frame: gap.frame })),
    queries: 0,
    elementsAdded: 0,
    adopted: false,
    reason: null
  };
  /* Non-contiguous with no small gap to aim at means the shortfall is not a clip.
     Say so - "looked and there was nothing to ask for" is a different finding from
     "never looked", and the last investigation lost two hours to exactly that
     ambiguity in diagnostics.widened. */
  if (!gaps.length) { record.reason = "no-small-gaps"; return { record, next: null }; }

  await heartbeatJob(job, { stage: "requerying-hole-gaps" });
  let merged = payload;
  for (const gap of gaps.slice(0, HOLE_GAP_MAX_QUERIES)) {
    const gapPayload = await fetchOverpass(osmGuideQuery(osmQueryScope({ osmFrame: gap.frame }, course.center)))
      .catch(() => null);
    record.queries += 1;
    if (!gapPayload) continue;
    const before = (merged.elements || []).length;
    merged = mergeOsmPayloads(merged, gapPayload);
    record.elementsAdded += ((merged.elements || []).length - before);
  }
  if (!record.elementsAdded) { record.reason = "no-new-elements"; return { record, next: null }; }

  const nextCollision = detectHoleNumberCollision(merged);
  const nextLoops = separateLoops(merged, course.center);
  if (!nextLoops || nextLoops.length < loops.length) { record.reason = "separation-regressed"; return { record, next: null }; }

  record.before = separationScore(loops);
  record.after = separationScore(nextLoops);
  /* More complete courses, or the same number of complete courses covering more
     holes. Anything else and the extra elements were noise: keep the tighter
     payload rather than publish a differently-wrong answer. */
  const better = record.after.contiguous > record.before.contiguous
    || (record.after.contiguous === record.before.contiguous && record.after.holes > record.before.holes);
  if (!better) { record.reason = "no-improvement"; return { record, next: null }; }

  record.adopted = true;
  return { record, next: { payload: merged, collision: nextCollision, loops: nextLoops } };
}

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

async function resolveScorecardForCourse(course, origin, want) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), SCORECARD_RESOLVE_BUDGET_MS) : null;
  const signal = controller ? controller.signal : undefined;
  /* The pinned course's own id, same value publishSeparatedLoops stamps as every
     sibling's facility_key - so cards found here are findable by facility later,
     including from Update Scorecards without re-fetching. */
  const facilityKey = course.courseId || null;
  try {
    return await resolveScorecard({ courseName: course.courseName, region: course.region, country: course.country }, {
      fetchHtml: url => fetchPageHtml(url, signal),
      search: (name, region) => searchScorecardPages(name, region, origin, signal),
      /* Reads go through fetchScorecardEvidence already; passing readStore here
         would just repeat the query the caller has done. */
      writeStore: async (key, name, cards) => {
        /* Every distinct card, not just the best one - a two-course facility's
           second card used to be found and then thrown away here. Each keyed via
           resolveFacilityCardKey (inside facilityScorecardRow) against whatever
           is already stored for this facility, so a card re-resolved under a
           different title updates its existing row instead of duplicating it. */
        const existing = await fetchFacilityScorecardEvidence(facilityKey);
        const rows = distinctCards(cards).map(card => facilityScorecardRow(card, name, facilityKey, existing)).filter(Boolean);
        if (!rows.length) return;
        await supabaseFetch(SCORECARDS_TABLE + "?on_conflict=course_key", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify(rows)
        });
      }
    }, { want });
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
  /* course-1 as well as course-2: leaving the first loop on the bare facility id
     made one row "te-rai" and the other "te-rai-course-2", which reads as a course
     and an afterthought rather than as two courses. */
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
/* Mean of a set of points, ignoring any that are missing. The facility's middle,
   which is what the compass points are measured from - a loop is "South" of its
   own site, not of anywhere else. */
function centroidOf(points) {
  const list = (points || []).filter(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (!list.length) return null;
  return {
    lat: list.reduce((sum, p) => sum + p.lat, 0) / list.length,
    lng: list.reduce((sum, p) => sum + p.lng, 0) / list.length
  };
}

/* How long this loop plays, in metres.
 *
 * Measured geometry, not a card: the label has to describe the ground that was
 * actually published, and on the unnumbered path there may be no card for this
 * nine at all - which is exactly when the label matters most. Prefers the
 * resolver guides when the loop carries them (no OSM hole ways to measure),
 * and falls back to the OSM hole lengths the card matcher already sums. */
function loopTotalM(loop) {
  if (loop && Array.isArray(loop.guides) && loop.guides.length) {
    return loop.guides.reduce((sum, guide) => sum + (lineLengthM(guide && guide.points) || 0), 0);
  }
  const lengths = loopLengthsFromOsm((loop && loop.payload && loop.payload.elements) || []);
  return Object.values(lengths).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

function nameLoopsFromCards(loops, cards) {
  /* Provisional names first, so two courses are never both called the facility.
   *
   * "Te Arai Links" twice in the picker is unusable - the player cannot tell which
   * is which, and it was the visible symptom of naming failing. "Course 1" and
   * "Course 2" are honest: they say the site has two courses and that we do not yet
   * know their names, which is exactly true. A real label replaces them the moment
   * one is found, and never blocks the map in the meantime. */
  /* Carrying the two facts that make a placeholder usable: how long the loop
     plays, and where on the property it sits. "Course 2 - 3547m South" is
     something a player at the clubhouse can act on - see provisionalLoopName. */
  const facilityCentre = centroidOf(loops.map(loop => loop.centre));
  loops.forEach((loop, index) => {
    if (!loop.name) {
      loop.name = provisionalLoopName(index, {
        totalM: loopTotalM(loop),
        compass: compassPointFrom(facilityCentre, loop.centre)
      });
      loop.nameSource = "provisional";
    }
  });

  const usable = distinctCards(cards || []).filter(card => card && card.name);
  if (usable.length < 2) return { resolved: false, reason: "fewer-than-two-cards", cards: usable.length };

  const measured = loops
    .map((loop, index) => ({ index, id: "loop-" + index, lengths: loopLengthsFromOsm(loop.payload.elements) }))
    .filter(entry => Object.keys(entry.lengths).length >= 6);
  if (measured.length < 2) return { resolved: false, reason: "loops-not-measurable", measured: measured.length };

  const result = matchLoopsToCards(measured, usable);
  /* The assignment is recorded either way. Matching a loop to a card is what makes
     the GEOMETRY right - hole numbering, expected count - and that is worth keeping
     even when the cards carry no name good enough to publish. */
  const byId = new Map(result.assignment.map(pair => [pair.loopId, pair.cardName]));
  measured.forEach(entry => {
    const cardName = byId.get(entry.id);
    if (!cardName) return;
    loops[entry.index].matchedCard = cardName;
    /* Only a card whose name actually identifies a course replaces the provisional
       one - "Scorecard" is not a course name. */
    if (result.resolved && cardName && !/^course \d+$/i.test(cardName)) {
      loops[entry.index].name = cardName;
      loops[entry.index].nameSource = "scorecard-match";
    }
  });
  return {
    resolved: result.resolved,
    reason: result.reason,
    score: result.score,
    margin: result.margin,
    assignment: result.assignment.map(p => ({ loopId: p.loopId, cardName: p.cardName, signals: p.signals }))
  };
}

async function publishSeparatedLoops(job, course, loops, expectedHoles, scorecardEvidence, origin) {
  const published = [];
  /* A child that cannot be published must not take its siblings down with it.
   *
   * One row per course, one set of writes each, and they are independent - so a
   * conflict or a bad write on the third course is no reason to lose the two
   * that worked. They are already in the database by then; failing the whole run
   * would only mean nobody is told which ones landed. The exception is the
   * PINNED course: that is the row the player selected and the run exists to
   * fill, and reporting success without it would be a lie. */
  const failures = [];
  /* Mutates loops[].name in place, so this must run before ids are derived. */
  const naming = nameLoopsFromCards(loops, course.scorecardCards);
  for (let index = 0; index < loops.length; index++) {
    const loop = loops[index];
    await heartbeatJob(job, { stage: "publishing-course-" + (index + 1) + "-of-" + loops.length });
    /* index 0 is the pinned loop - separateLoops sorts by distance from the pin. */
    const isPinned = index === 0;
    const derivedId = loopCourseId(loop, course, index);
    try {
      const courseId = isPinned ? course.courseId : (await findExistingLoopRow(loop, derivedId)) || derivedId;
      /* NO sibling centres, deliberately.
       *
       * guideBelongsToCourse drops any guide that sits closer to a sibling's centre
       * than to this course's - per-hole nearest-centre assignment, which is exactly
       * the rule separateLoops replaced. Handing it the other loop's centroid made it
       * re-partition holes that separation had already assigned by routing continuity,
       * and on interleaved courses it threw away holes that genuinely belong here:
       * Te Arai's loop 0 came out of separation contiguous 1-18 and lost holes 9 and 10
       * to this filter, publishing 16.
       *
       * It is not needed either way. This payload was built by separateLoops and
       * contains only this loop's hole features, so there is nothing to partition. The
       * filter still earns its place on the unseparated path, where a single-course
       * sweep really can catch a neighbouring club. */
      /* A loop separated WITHOUT OSM hole numbers arrives carrying resolver
         GUIDES rather than a payload - the Native Resolver derived its numbering
         from the loop's own card, which is the only thing that could have, and
         re-running resolveCourseGeometry over the payload would find no numbered
         holes and publish an empty course.
       *
       * Resolved here rather than by the caller, because resolveGuidesIntoObjects
       * stamps every object with the courseId it is given and only THIS function
       * knows which id the row ends up under - loopCourseId can rename a loop off
       * its card, and findExistingLoopRow can hand back an id from a previous
       * scan. Resolving early stamped a guess. */
      const geometry = loop.guides
        ? Object.assign(
          resolveGuidesIntoObjects(loop.guides, courseId, loop.resolverGreens || [], isPinned ? (loop.existingObjects || []) : []),
          { guidesFound: loop.guides.length, greensFound: (loop.resolverGreens || []).length, holesResolved: loop.guides.length }
        )
        : resolveCourseGeometry(loop.payload, courseId, loop.centre || course.center, [], []);

      const row = {
        course_id: courseId,
        /* "Te Arai Links Golf Club - Course 1" rather than a bare "Course 1": the
           facility is what the player searched for, the suffix is what tells the
           two apart. Stripped down to the FACILITY half of the searched name via
           splitCourseName, not the raw string - "Te Arai Links Golf Club - North
           Course" pinned on the search result must not become the base name for
           BOTH siblings, or the second course reads as another North Course
           before anything has actually identified it. */
        course_name: loop.name && /^course \d+\b/i.test(loop.name)
          ? (course.courseName ? splitCourseName(course.courseName).facility + " - " + loop.name : loop.name)
          : (loop.name || course.courseName || courseId),
        course_lat: loop.centre ? loop.centre.lat : course.center.lat,
        course_lng: loop.centre ? loop.centre.lng : course.center.lng,
        osm_course_ref: loop.osmRef || null,
        /* Every course out of this separation shares one token, so a search result can
           offer the choice without re-deriving the link from proximity. The pinned
           course's id: unique, stable, and readable. */
        facility_key: course.courseId,
        objects_json: geometry.objects,
        holes_json: geometry.holes,
        geometry_version: MAPPER_VERSION,
        hole_count: Object.keys(geometry.holes || {}).length || null,
        published: true,
        updated_at: new Date().toISOString()
      };
      /* Every name this course is known by at publish time - the facility it was
         searched as, the provisional label, and the card it matched. A course named
         "Course 1" today can become "South Course" tomorrow without losing the name
         anything already referred to it by. Built after the row so it can exclude
         whichever of them became the display name. */
      row.course_aliases = [...new Set([course.courseName, loop.matchedCard, loop.name].filter(Boolean))]
        .filter(alias => alias !== row.course_name);
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

      /* A loop separated by its own card knows its own length, and the facility's
         expectedHoles is the wrong number for it: an 18 and a nine sharing a site
         would judge the nine against 18 and call a complete course short. */
      const coverage = courseCoverageComplete({ holeNumbers, expectedHoles: loop.expectedHoles || expectedHoles });
      const visualChain = await chainVisualSnapshot(courseId, courseBounds, origin, coverage)
        .catch(error => ({ chained: false, reason: String(error && error.message || error).slice(0, 300) }));

      published.push({
        courseId,
        courseName: row.course_name || course.courseName || courseId,
        osmRef: loop.osmRef || null,
        pinned: isPinned,
        method: loop.method,
        nameSource: loop.nameSource || (loop.name ? "osm-polygon" : "derived"),
        matchedCard: loop.matchedCard || null,
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
    } catch (error) {
      if (isPinned) throw error;
      failures.push({
        courseId: derivedId,
        name: loop.name || null,
        holes: (loop.holeNumbers || []).length,
        reason: String((error && error.message) || error).slice(0, 200)
      });
    }
  }
  if (naming) published.naming = naming;
  /* Retryable, not lost: the ground is still there and the next scan of this
     facility will offer this course again. */
  if (failures.length) published.failures = failures;
  return published;
}

/* How long a facility run may take, and how many passes it may make.
 *
 * Both, because either alone can hang. Rounds end a facility whose other cards
 * simply are not published anywhere - each pass finds nothing new and the loop
 * closes itself. The clock ends one whose sources are slow enough to outlast
 * any round count. These runs are deliberately longer than a normal scan: a
 * three-nine facility genuinely needs several fetches and several matching
 * passes, and it is a background job, so the cost is patience rather than a
 * player waiting. */
export const FACILITY_RESOLVE_BUDGET_MS = 240000;
export const FACILITY_MAX_ROUNDS = 4;
/* Below this a card cannot identify anything - same floor the scorecard
   matcher uses, and for the same reason. */
const MIN_CARD_HOLES = 6;

/* RESOLVE A FACILITY: map what can be trusted, keep it, shrink what is left.
 *
 * The numbered path separates ground first and finds cards afterwards, because
 * OSM's hole numbers do the separating for free. Here there are no numbers, one
 * course polygon over the whole site, and several loops running through each
 * other - so there is nothing to cluster on. Proximity is not the answer either:
 * single-link chaining merges interleaved loops the moment any hole of one sits
 * near any hole of the other, which is exactly the failure separateLoops was
 * written to replace.
 *
 * So the cards do the separating. Each card is a set of relative hole lengths
 * and par positions, which is the same evidence the loop matcher already trusts
 * to tell a North from a South; run the Native Resolver once per card over the
 * shared payload and each card claims the ground that actually fits it.
 *
 * THREE THINGS THIS OWES THE CALLER, IN ORDER
 *
 *   1  Keep what is already trustworthy. A claim handed in by AutoMapper or by
 *      the resolver run that got us here is evidence, not something to redo. It
 *      is seeded straight into the accepted set.
 *   2  Say what the facility IS before deciding how to read its cards. Structure
 *      comes from gd-facility-structure-core.mjs, off the ground the claims sit
 *      on, and once it is confidently known it holds for the rest of the run.
 *   3  Make the remaining problem smaller with every accepted claim. Ground that
 *      an INDEPENDENT claim owns comes off the table immediately - within the
 *      round, not after it - so the next card is matched against a smaller,
 *      cleaner field. Composite claims never take ground off the table; see
 *      isIndependentClaim for why that distinction is load-bearing.
 *
 * WHY ROUND ONE IS OPEN
 *
 * The first pass matches every card over the WHOLE site with nothing held back,
 * because compositing is only visible in what overlaps what: three 18-hole cards
 * over three nines are recognised by wanting the same ground as each other, and
 * ground removed before they ask cannot be seen to be shared. Structure is
 * assessed from that open pass, and exclusion begins the moment it is known.
 *
 * WHAT WENT WRONG AT HOWESTON, AND WHERE IT IS FIXED
 *
 * Three nines. A named 9-hole card for each of two of them, plus a generic
 * 18-hole aggregator card. In the open pass the 18 claimed the ground of two
 * real loops; reconciliation read the named nine inside it as a duplicate and
 * dropped it; two loops came back with eight candidates spare, which was under
 * the noise floor, and the run stopped and published a course that does not
 * exist. Every one of those is a decision made with no idea what the facility
 * was. Now: the nine inside the eighteen with a nine of ground still beyond it
 * IS the evidence of a multi-nine site, the eighteen is read as the two loops it
 * describes rather than as a course, the named nine names one of them, and
 * completion asks whether the expected loops were resolved rather than only
 * whether the leftovers are quiet.
 *
 * It runs in ROUNDS because a facility is rarely resolved in a single fetch and
 * each answer makes the next one easier. It stops when the facility is accounted
 * for, when a round turns up no new evidence, or on the budget.
 *
 * Returns { published, record }. published is null when this could not be
 * finished, and the caller then publishes ONE course, untrusted and warned,
 * rather than either refusing outright or lying about what it found. */
async function publishUnnumberedFacility(context) {
  const { job, course, payload, origin, facility, expectedHoles, existingObjects, seedClaim } = context;

  /* The state that used to be implicit, spread across four locals and a record.
     Written down because every rule above reads or moves one of these fields,
     and a run that goes wrong is diagnosed by reading them in order. */
  const resolution = {
    structure: FACILITY_STRUCTURE.UNKNOWN,
    structureConfident: false,
    mappingMethods: [],
    candidateCount: facility.candidateCount,
    expectedLoops: atomicLoopCount(facility.candidateCount),
    /* Ground already spoken for by an independent claim. Handed to the resolver
       as excludeCandidateIds so the remaining problem is genuinely smaller. */
    excludedIds: [],
    /* Whether the cards have shown themselves to be play orders. Nothing may be
       excluded while this is true - see claimFacilityGround. */
    composite: false,
    rounds: []
  };

  const record = {
    want: facility.loops,
    candidateCount: facility.candidateCount,
    expectedLoops: resolution.expectedLoops,
    structure: resolution.structure,
    structureReason: null,
    structureEvidence: [],
    mappingMethod: null,
    seeded: false,
    cards: 0, loops: 0, composite: false,
    rounds: [], completionReason: null, reason: null
  };

  /* A claim already in hand, from the AutoMapper or resolver run that decided
     this was a facility at all. Seeding it costs nothing and means a nine that
     was confidently identified cannot be lost to a later round matching that
     card differently over a field that has changed underneath it. */
  const seeded = [];
  if (seedClaim && (seedClaim.holes || []).length >= MIN_CARD_HOLES) {
    seeded.push(seedClaim);
    resolution.mappingMethods.push(seedClaim.method || MAPPING_METHOD.NATIVE_RESOLVER);
    record.seeded = true;
  }

  const deadline = Date.now() + FACILITY_RESOLVE_BUDGET_MS;
  let cards = [];
  let reconciled = null;
  /* How many distinct cards to go looking for. Driven by GROUND, not by how
     many card rows happen to exist: Howeston had three rows for three loops and
     one of them was an aggregator describing two of the others, so counting
     rows said "enough evidence" over a facility a third unexplained. */
  let target = Math.max(2, resolution.expectedLoops);

  for (let round = 0; round < FACILITY_MAX_ROUNDS; round += 1) {
    /* Two stops, because either alone can hang. Rounds end a facility whose
       cards simply do not exist on the internet; the clock ends one whose
       sources are slow enough to outlast anything. */
    if (Date.now() > deadline) { record.reason = "budget-exhausted"; break; }

    await heartbeatJob(job, { stage: "gathering-cards-for-facility-" + (round + 1) });
    const before = cards.length;
    /* From round two the store has already been read and every card in it
       already matched, so a repeat of the same pool cannot say anything new -
       go to the network whatever the count says. */
    cards = await gatherFacilityCards(course, origin, target, cards, record, { force: round > 0 });
    if (!cards.length && !seeded.length) { record.reason = record.reason || "no-readable-card"; break; }
    if (round > 0 && cards.length === before) { record.reason = "no-new-cards"; break; }

    /* An aggregator's scrape that lost the boundaries between the club's nines
       is not a course, and matching it produces an eighteen nobody has played
       over ground belonging to two real loops. Dropped before it can claim
       anything - see stitchedCardVerdict, which is careful to keep GENUINE
       combined cards, because those are how composite facilities are found. */
    const stitched = [];
    const usableCards = cards.filter(card => {
      const verdict = stitchedCardVerdict(card, cards);
      if (!verdict.stitched) return true;
      stitched.push({ card: card.name || "(unnamed)", holes: (card.holes || []).length, reason: verdict.reason, runs: verdict.runs });
      return false;
    });
    record.stitchedCards = stitched;

    await heartbeatJob(job, { stage: "resolving-facility-loops-" + (round + 1) });
    let pass = await claimFacilityGround({
      cards: usableCards, course, payload, deadline, resolution, seeded
    });

    /* Two cards that matched the same ground mean the open pass could not
       separate them, not that the site has two loops there. Run it again with
       the strongest claim's ground taken away, so the loser has to find its own
       - the progressive reduction this whole path exists for, brought forward to
       the round that actually needs it. */
    const contested = contestedClaims(pass.claims);
    if (contested.length) {
      record.contested = contested;
      await heartbeatJob(job, { stage: "separating-contested-loops-" + (round + 1) });
      pass = await claimFacilityGround({
        cards: usableCards, course, payload, deadline, resolution, seeded,
        sequential: true, priorClaims: pass.claims
      });
      record.contestedAfter = contestedClaims(pass.claims);
    }

    /* What the ground says the site is, from the claims as they now stand.
       Sticky once confident - a generic 18-hole card arriving in round three
       does not get to redefine a facility that has already shown itself to be
       nines. */
    const assessed = assessFacilityStructure({
      candidateCount: resolution.candidateCount,
      claims: pass.claims,
      prior: resolution.structureConfident ? { structure: resolution.structure, confident: true } : null
    });
    resolution.structure = assessed.structure;
    resolution.structureConfident = assessed.confident;
    record.structure = assessed.structure;
    record.structureReason = assessed.reason;
    record.structureEvidence = assessed.evidence;

    reconciled = reconcileFacilityClaims(pass.claims, {
      candidateCount: resolution.candidateCount,
      structure: assessed.confident ? assessed.structure : null
    });

    /* What comes off the table, and how much evidence the next round should go
       looking for. Both live in planNextRound so the policy can be read - and
       tested - in one place instead of inferred from two lines in a loop. */
    const plan = planNextRound(reconciled, { target });
    resolution.excludedIds = plan.excludeCandidateIds;
    resolution.composite = reconciled.composite;

    record.rounds.push({
      round: round + 1,
      cards: cards.length,
      claims: pass.claims.length,
      /* Capped, like every other diagnostic list on this row - a facility with
         a dozen wrong cards should not turn the job row into a card dump. */
      rejected: pass.rejected.slice(0, 6),
      excludedBefore: pass.excludedAtStart,
      excludedWithinRound: pass.excludedWithinRound,
      structure: assessed.structure,
      structureConfident: assessed.confident,
      structureReason: assessed.reason,
      loops: reconciled.claimedLoops,
      composite: reconciled.composite,
      claimed: reconciled.claimedCandidateIds.length,
      unclaimed: reconciled.unclaimedCandidates,
      completionReason: reconciled.completionReason,
      /* The ground itself, not a count of it. Which candidates each card took,
         how much every pair shares, and what reconciliation did with each -
         see describeClaimGround for why counts alone were not enough. */
      ground: describeClaimGround(pass.claims, reconciled)
    });

    record.completionReason = reconciled.completionReason;
    if (plan.done) { record.reason = null; break; }
    target = plan.target;
    record.reason = plan.reason;
  }

  record.cards = cards.length;
  record.composite = !!(reconciled && reconciled.composite);
  record.loops = reconciled ? reconciled.claimedLoops : 0;
  record.mappingMethod = summariseMappingMethod(resolution.mappingMethods);
  if (!reconciled || reconciled.loops.length < 2) {
    record.reason = record.reason || "only-" + ((reconciled && reconciled.loops.length) || 0) + "-courses-identified";
    return { published: null, record };
  }

  /* A SPLIT NEEDS A REASON, NOT JUST A REMAINDER.
   *
   * Structure "unknown" means the evidence could not explain the ground - and
   * splitting a facility on evidence that explains nothing is how Howeston
   * published a stitched aggregator card as a whole eighteen. It got there
   * through the back door: with no structure the reconciler falls back to the
   * plain "under a loop's worth left over" rule, eight candidates were spare,
   * and that read as finished.
   *
   * Publishing one course, untrusted and warned, is the honest answer here. The
   * caller already has that path - it is what a facility with no readable cards
   * takes - and the ground that IS well mapped still publishes, which at
   * Howeston was a correct nine. */
  if (resolution.structure === FACILITY_STRUCTURE.UNKNOWN || !resolution.structureConfident) {
    record.reason = "structure-unresolved: " + (record.structureReason || "unknown")
      + " - refusing to split " + reconciled.claimedLoops + " loops on evidence that does not explain the ground";
    return { published: null, record };
  }

  const loops = reconciled.loops.map((loop, index) => {
    /* Renumbered by reconciliation when the loop was sliced out of a composite
       card, so the guide has to be restamped to agree - White's ninth hole is
       its hole 9, not the card's hole 18. */
    const guides = (loop.holes || [])
      .map(hole => hole.guide && Object.assign({}, hole.guide, { hole: hole.holeNumber }))
      .filter(Boolean);
    const holeNumbers = guides.map(guide => guide.hole).sort((a, b) => a - b);
    return {
      index,
      name: loop.cardName || "",
      nameSource: loop.cardName ? "scorecard-resolved" : "provisional",
      matchedCard: loop.cardName || null,
      osmRef: "",
      method: reconciled.composite ? "play-order-slice" : "scorecard-claim",
      /* This loop's OWN length, not the facility's. */
      expectedHoles: guides.length,
      centre: centreOfGuides(guides) || course.center,
      holeNumbers,
      contiguous: loopIsContiguous(holeNumbers),
      awayFromPinM: null,
      /* No OSM element belongs to this loop by any tag, so there is no payload
         to hand over - the guides ARE the separation. publishSeparatedLoops
         resolves them once it knows the id the row lands under. */
      payload: { elements: [] },
      guides,
      resolverGreens: loop.resolverGreens || [],
      /* Only the pinned loop inherits what was already saved against this
         course id; a sibling published into a new row starts clean. */
      existingObjects: index === 0 ? existingObjects : []
    };
  });

  /* GROUND WITH NO CARD IS STILL GROUND, AND IT IS SAID OUT LOUD.
   *
   * A facility does not always publish whole. Howeston has three nines and two
   * cards; the third loop is real, it is under the sweep, and nothing that
   * exists can number it - the Native Resolver derives hole order from a
   * scorecard's distances, so no card means no numbering, and inventing one
   * would be exactly the guessed geometry this pipeline refuses to publish.
   *
   * The answer is not to hold back the two loops that ARE resolved. Two
   * playable nines beat nothing, and they are correct. So they publish, and the
   * remainder is recorded as what it is: a loop's worth of ground this run
   * could not explain, with the reason it could not. That is the difference
   * between a facility that is finished and one that is waiting for a card. */
  const outstandingLoops = Math.max(0, resolution.expectedLoops - reconciled.claimedLoops);
  record.unresolvedGround = outstandingLoops > 0 || reconciled.unclaimedCandidates >= HOLES_PER_LOOP
    ? {
      loops: outstandingLoops,
      candidates: reconciled.unclaimedCandidates,
      /* Why it stopped, in the loop's own words - "no-new-cards" and
         "budget-exhausted" want opposite responses next time. */
      reason: record.reason || record.completionReason || null
    }
    : null;

  const published = await publishSeparatedLoops(job, course, loops, expectedHoles, null, origin);
  if (published.failures) record.failedChildren = published.failures;
  /* Geometry is finished. What the loops are to EACH OTHER is a separate
     question with a separate owner - see organiseFacility, which is not allowed
     to be consulted while claims are still being matched. */
  record.organisation = Object.assign(
    organiseFacility(loops, {
      structure: resolution.structure,
      mappingMethod: record.mappingMethod
    }),
    /* Carried on the organisation rather than left in a reason string, so the
       Studio can offer "find the missing card" against exactly the facilities
       that have ground waiting rather than re-scanning to find out. */
    { unresolved: record.unresolvedGround }
  );
  return { published, record };
}

/* One matching pass: every card over the ground still unspoken for.
 *
 * The strongest evidence goes first and takes its ground with it. At a facility
 * already known to be built from nines, a named 9-hole card is stronger evidence
 * for a physical loop than a generic 18 that may be describing two of them, so
 * the nines lead; everywhere else the cards keep the order the scorecard engine
 * ranked them in, which is by source quality.
 *
 * The timing is the point. Exclusion used to wait for a whole round's claims to
 * be reconciled, which gave an aggregator card a free run at the entire field
 * alongside the real cards for the loops inside it. Here a claim that is
 * INDEPENDENT - owning ground no other claim in this pass partially shares -
 * takes that ground off the table for every card still to be matched in the same
 * pass. Composite claims never do; a play-order facility depends on its cards
 * reaching for the same nine. */
async function claimFacilityGround(input) {
  const { cards, course, payload, deadline, resolution, seeded, sequential, priorClaims } = input;
  const multiNine = resolution.structureConfident && resolution.structure === FACILITY_STRUCTURE.MULTI_NINE;
  /* In sequential mode the order decides who gets their ground first, so it has
     to be strength order - and the only honest measure of strength is what the
     open pass actually scored each card, not a guess from its hole count. */
  const scored = new Map((priorClaims || []).map(claim => [claim.cardName || "", claim.confidence || 0]));
  const ordered = cards.slice().sort((a, b) => {
    if (sequential) return (scored.get(b.name || "") || 0) - (scored.get(a.name || "") || 0);
    if (!multiNine) return 0;
    const nine = card => ((card.holes || []).length === HOLES_PER_LOOP ? 0 : 1);
    return (nine(a) - nine(b)) || ((b.name ? 1 : 0) - (a.name ? 1 : 0));
  });

  const excludedAtStart = resolution.excludedIds.slice();
  const excluded = new Set(excludedAtStart);
  /* The seed rides along as a claim from the first pass onwards, so a loop that
     was already identified cannot be lost to a later round matching its card
     differently over a field that has changed underneath it. Its GROUND is not
     excluded here: it arrives in resolution.excludedIds once a round has
     reconciled, which is the first moment the site has said whether excluding
     anything is safe. */
  const claims = seeded.slice();
  /* Sequential mode exists because cards were landing on each other's ground, so
     the seed's ground goes off the table immediately too - it is the one claim
     this run already trusts, and leaving it free is leaving the contest open. */
  if (sequential) {
    seeded.forEach(claim => (claim.holes || []).forEach(hole => {
      if (hole.candidateId != null) excluded.add(String(hole.candidateId));
    }));
  }
  const rejected = [];
  let excludedWithinRound = 0;

  for (const card of ordered) {
    if (Date.now() > deadline) break;
    const holes = (card.holes || []).map(hole => ({ holeNumber: hole.hole, par: hole.par, distanceM: hole.distanceM }));
    if (holes.length < MIN_CARD_HOLES) { rejected.push({ card: card.name || "", reason: "card-too-short" }); continue; }
    /* Already claimed by the seed, matched under its own name. Re-running it
       would only produce a duplicate of ground we already hold. */
    if (claims.some(claim => claim.cardName && card.name && claim.cardName === card.name)) continue;
    const result = await resolveCourseGeometryForAutoMapper({
      osmPayload: payload,
      courseId: course.courseId,
      course: { courseId: course.courseId, courseName: card.name || course.courseName, courseCentre: course.center },
      courseCentre: course.center,
      expectedHoleCount: holes.length,
      excludeCandidateIds: [...excluded],
      scorecardHoles: holes,
      scorecardEvidence: { holes }
    });
    const guides = (result.holes || []).map(hole => guideFromResolvedHole(hole, result)).filter(Boolean);
    /* A card has to reach its own full length to be describing a course here.
       A partial match is a card for somewhere else, or ground this run has not
       fetched - either way it is not a course to publish. */
    if (guides.length < holes.length) {
      rejected.push({ card: card.name || "", reason: "matched-" + guides.length + "-of-" + holes.length });
      continue;
    }
    const byHole = new Map((result.holes || []).map(hole => [hole.holeNumber, hole]));
    const claim = {
      cardName: card.name || "",
      confidence: result.confidence || 0,
      method: MAPPING_METHOD.NATIVE_RESOLVER,
      resolverGreens: (result.debugEvidence && result.debugEvidence.greenCandidates || []).map(green => ({ center: green.centre, shape: green.polygon })),
      /* The guide rides along with its hole so reconciliation can slice a
         composite card into nines and still hand back publishable geometry. */
      holes: guides.map(guide => ({
        holeNumber: guide.hole,
        candidateId: String((byHole.get(guide.hole) || {}).candidate ? byHole.get(guide.hole).candidate.candidateId : guide.id),
        guide
      }))
    };
    claims.push(claim);
    if (!resolution.mappingMethods.includes(MAPPING_METHOD.NATIVE_RESOLVER)) resolution.mappingMethods.push(MAPPING_METHOD.NATIVE_RESOLVER);

    /* Take this ground off the table for the rest of the pass.
     *
     * THIS IS THE TIMING FIX. Exclusion used to wait for the whole round to be
     * reconciled, which gave a generic aggregator card a free run at the entire
     * field alongside the real cards for the loops inside it - and at Howeston
     * that is exactly what it did.
     *
     * Three things have to be true first. The site must have SAID what it is,
     * because round one has to stay open or compositing cannot be seen at all.
     * It must not be a composite facility, where every card legitimately reaches
     * for a nine another one already has. And this particular claim must own its
     * ground outright - a claim that partially shares with another is half of a
     * play order and removing it strands the other half. */
    if (!sequential) {
      if (!resolution.structureConfident) continue;
      if (resolution.composite) continue;
    }
    if (!isIndependentClaim(claim, claims)) continue;
    claim.holes.forEach(hole => { if (!excluded.has(hole.candidateId)) { excluded.add(hole.candidateId); excludedWithinRound += 1; } });
  }

  return { claims, rejected, excludedAtStart: excludedAtStart.length, excludedWithinRound };
}

/* Every distinct card known for this facility, cheapest source first.
 *
 * The shared store is free and may already hold what a sibling's scan or an
 * Update Scorecards run found. Only when it comes up short is the network
 * asked, and it is asked for a TARGET rather than a fixed number, so a second
 * round genuinely digs further instead of repeating the first.
 *
 * `force` is the second round onwards, and it exists because a card COUNT is not
 * evidence about ground. Three rows for a three-loop site looks like enough
 * until one of them turns out to be an aggregator describing two of the others,
 * at which point the site is a third unexplained and the store has nothing left
 * to say. When the caller knows ground is still unaccounted for, the network
 * gets asked whatever the count says. */
async function gatherFacilityCards(course, origin, target, held, record, opts) {
  const force = !!(opts && opts.force);
  const stored = await fetchFacilityScorecardEvidence(course.courseId).catch(() => []);
  const storedCards = stored
    .filter(row => Array.isArray(row.holes_json) && row.holes_json.length)
    .map(row => ({
      name: row.course_name,
      holes: row.holes_json.map(hole => ({ hole: hole.hole, par: hole.par, distanceM: hole.metres ?? hole.distanceM ?? null })),
      source: row.source, sourceUrl: row.source_url
    }));
  let cards = distinctCards(held.concat(storedCards));
  const describe = list => list.map(card => ({
    name: card.name || "(unnamed)",
    holes: (card.holes || []).length,
    source: card.source || null
  }));
  if (cards.length >= target && !force) {
    record.cardsSeen = describe(cards);
    record.cardFetch = { target, force, wentToNetwork: false, fromStore: storedCards.length };
    return cards;
  }
  const found = await resolveScorecardForCourse(course, origin, target)
    .catch(error => ({ cards: [], reason: String(error && error.message || error).slice(0, 200) }));
  if (found.reason) record.reason = found.reason;
  const all = distinctCards(cards.concat(found.cards || []));
  /* What the fetch was asked for and what it came back with, so a facility that
     stays unexplained can be told apart from one whose evidence simply is not
     published anywhere - the difference between "search harder" and "there is
     no card for that nine". */
  record.cardsSeen = describe(all);
  record.cardFetch = {
    target, force, wentToNetwork: true,
    fromStore: storedCards.length,
    fromNetwork: (found.cards || []).length,
    distinctAfter: all.length,
    reason: found.reason || null,
    /* Every page the engine opened and what it made of it. This is the raw
       material for the follow-up hunt: a sibling course page that was found and
       REJECTED names a loop we know exists and could not read, which is a far
       better search term than the facility's own name. */
    attempts: (found.attempts || []).slice(0, 8).map(attempt => ({
      url: String(attempt.url || "").slice(0, 120),
      source: attempt.source || null,
      cards: attempt.cards || 0,
      usable: !!attempt.usable,
      rejected: attempt.rejected || attempt.reason || null
    }))
  };
  return all;
}


/* Mean of the guide centre-lines - the only centre available to a loop that owns
   no OSM elements of its own, and the number that becomes the published row's
   course_lat/course_lng. */
function centreOfGuides(guides) {
  const points = (guides || []).flatMap(guide => guide && guide.points || [])
    .filter(point => point && Number.isFinite(point.lat) && Number.isFinite(point.lng));
  if (!points.length) return null;
  return {
    lat: points.reduce((sum, p) => sum + p.lat, 0) / points.length,
    lng: points.reduce((sum, p) => sum + p.lng, 0) / points.length
  };
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
      /* The card's own name rides along. It is what a loop resolved from this
         evidence gets published as when the facility turns out to be bigger
         than the card - without it a correctly identified nine publishes as
         "Course 1" while its name sits unused two lines above. */
      scorecardEvidence = { holes: best.holes.map(hole => ({ holeNumber: hole.hole, par: hole.par, distanceM: hole.distanceM })), cardName: best.name || "", source: best.source || "scorecard-engine", sourceUrl: best.sourceUrl || "", sources: [] };
    }
    /* A page that says "18 hole, par 72" but whose table would not parse still
       answers the only question expectedHoles asks. */
    if (!scorecardEvidence && resolved.statedHoleCount) diagnostics.statedHoleCount = resolved.statedHoleCount;
    /* Every card found, kept for the loop matcher - a two-course site yields two,
       and telling North from South needs both. */
    if (resolved.cards && resolved.cards.length > 1) diagnostics.scorecardCards = resolved.cards.map(card => ({ name: card.name, source: card.source, par: card.par, holes: card.holes.length }));
    course.scorecardCards = resolved.cards || [];
  }
  /* Third and last resort: this course's own name-keyed lookup and its own
     network search both came up empty, but a sibling's search - or an earlier
     Update Scorecards run - may already have stored a card for this facility
     under a different key. Cheap (one store read, no network) and exactly the
     "broader facility fetcher" evidence order the scorecard engine is meant to
     offer every consumer, this worker included. */
  if (!scorecardEvidence) {
    const facilityCards = await fetchFacilityScorecardEvidence(course.courseId);
    const usable = facilityCards.find(row => Array.isArray(row.holes_json) && row.holes_json.length);
    if (usable) {
      scorecardEvidence = { holes: usable.holes_json, source: usable.source || "", sourceUrl: usable.source_url || "", sources: Array.isArray(usable.sources_json) ? usable.sources_json : [] };
      diagnostics.scorecardResolve = Object.assign({}, diagnostics.scorecardResolve, { facilityFallback: true });
    }
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
  /* Set only when the ground proved bigger than the card AND the other cards
     could not be found - the one case where a course publishes knowing it is a
     fragment of a facility. Fed to courseFitVerdict so the run cannot report
     itself trusted. */
  let facilityUnresolved = null;
  /* WHICH NUMBERING REACHED THE PUBLISHED GEOMETRY.
   *
   * The single-course path used to report no mapping method at all - which
   * meant the commonest facility of all, a standalone 18 or 9, published with
   * the structure question answered and the method question simply missing.
   * Only the facility paths carried one, so "how were these holes identified"
   * was answerable exactly where the geometry was hardest and unanswerable
   * everywhere else.
   *
   * Counted rather than flagged, because a resolver run that replaced SOME of
   * the OSM numbering is genuinely mixed and a boolean cannot say so. Both
   * counts are taken at the moment of adoption - before the resolver's guides
   * overwrite geometry.holesResolved, which is what made this uncountable
   * after the fact. */
  let osmNumberedHoles = 0;
  let resolverNumberedHoles = 0;

  /* Names are labels, not identity - so when OSM has already numbered the holes,
     geometry does not wait on them.
   *
   * This used to spend a network round trip here hunting one card per course
   * before publishing anything, and that ordering was backwards. OSM's hole
   * numbers have ALREADY separated the courses; the cards were only ever going
   * to decide whether a row reads "North Course" or "Course 1". Blocking three
   * correct maps behind an aggregator lookup that may take seconds and may
   * return nothing put the cheap, certain half of the job behind the expensive,
   * uncertain half.
   *
   * So: publish the geometry with provisional names, and label afterwards. The
   * cards already in the shared store are free and still get used - a rescan of
   * a facility whose siblings were named last time names them again with no
   * network at all. What is gone is the FETCH. course-scorecard-update.mjs is
   * the other half and does it properly: broader search, geometry-safe, and
   * runnable any time without re-scanning. */
  const wantCards = collision.multiLoop ? Math.max(2, Number(collision.loops) || 2) : 1;
  if (collision.multiLoop && distinctCardCount(course.scorecardCards) < wantCards) {
    const stored = await fetchFacilityScorecardEvidence(course.courseId).catch(() => []);
    const storedCards = stored.map(row => ({ name: row.course_name, holes: row.holes_json, source: row.source, sourceUrl: row.source_url }));
    if (distinctCardCount(storedCards) > distinctCardCount(course.scorecardCards)) course.scorecardCards = storedCards;
    diagnostics.namingCards = {
      want: wantCards,
      distinct: distinctCardCount(course.scorecardCards),
      cards: (course.scorecardCards || []).length,
      /* Said plainly on the row, because "Course 1" with no explanation reads
         like a failure rather than a job half done on purpose. */
      labelledLater: distinctCardCount(course.scorecardCards) < wantCards,
      source: "facility-store-only"
    };
  }

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
   * for a site that has already proven it needs one.
   *
   * Sized right, centred wrong. The box was built around the stored course PIN,
   * which is the clubhouse - at Te Arai Links that is the North course, in the
   * north-west corner of a facility that runs south-east. The 2198m box was
   * mis-centred by ~910m, so it spent half its area on ocean and came up 82m short
   * over Course 2's bottom holes; hole 5 sits entirely in that strip and was never
   * fetched. See holeFeatureFrame for the full arithmetic.
   *
   * Centre it on the holes already found instead, and union with what the first
   * sweep already covered so widening can never LOSE ground. Usually a smaller box
   * than the pin-centred one, and it is aimed by evidence rather than by a guess
   * about which corner of the site the clubhouse sits in. */
  if (collision.multiLoop && collision.widestSeparationM > scope.radiusM) {
    await heartbeatJob(job, { stage: "widening-for-multi-course-site" });
    const needM = collision.widestSeparationM + WIDER_RETRY_PAD_M;
    const scopeFrame = osmScopeFrame(scope, course.center);
    const dataFrame = holeFeatureFrame(payload);
    const anchor = frameCentre(dataFrame) || course.center;
    const widerFrame = unionOsmFrames(
      /* never lose first-pass coverage */
      scopeFrame,
      /* the site is at least needM across, centred on where its holes actually are */
      expandOsmFrame({ south: anchor.lat, west: anchor.lng, north: anchor.lat, east: anchor.lng }, needM),
      /* and never sit tighter than a clear margin around the holes already in hand */
      holeFeatureFrame(payload, WIDEN_DATA_PAD_M)
    );
    /* Recorded whether or not it helps.
     *
     * This block only wrote its diagnostics on the branch where the wider query
     * found MORE - so a widen that ran and returned exactly the same features was
     * indistinguishable from a widen that never ran at all, and the job row showed
     * `widened: null` for both. That sent the last investigation looking at query
     * bounds when the answer might be that OSM simply does not have the holes.
     *
     * "Tried and it changed nothing" is a finding. It says the sweep was never the
     * constraint, which is the opposite conclusion and needs the same evidence. */
    diagnostics.widened = {
      attempted: true,
      fromRadiusM: scope.radiusM,
      toSpanM: needM,
      widestSeparationM: collision.widestSeparationM,
      holeFeaturesBefore: collision.holeFeatures,
      holeFeaturesAfter: null,
      /* The number that explains a clipped scan at a glance: how far the pin sat
         from the middle of the holes. Te Arai's was ~910m against an 82m shortfall. */
      centredOn: dataFrame ? "hole-features" : "pin",
      pinOffsetM: dataFrame ? Math.round(distance(course.center, anchor)) : 0,
      frame: widerFrame,
      adopted: false,
      reason: widerFrame ? null : "could-not-build-wider-frame"
    };
    if (widerFrame) {
      const widerPayload = await fetchOverpass(osmGuideQuery(osmQueryScope({ osmFrame: widerFrame }, course.center)));
      const widerCollision = detectHoleNumberCollision(widerPayload);
      const widerCounts = golfFeatureCounts(widerPayload);
      diagnostics.widened.holeFeaturesAfter = widerCollision.holeFeatures;
      diagnostics.widened.osmFeaturesAfter = widerCounts;
      /* Adopted only if it actually found more hole features - a wider frame that
         returns the same thing means the site really is that size, and keeping the
         tighter payload avoids dragging a neighbouring club in for nothing. */
      if (widerCollision.holeFeatures > collision.holeFeatures) {
        payload = widerPayload;
        collision = widerCollision;
        queryStages.push("widened-to-site-extent");
        diagnostics.widened.adopted = true;
        diagnostics.osmFeatures = widerCounts;
        geometry = resolveCourseGeometry(payload, course.courseId, course.center, existingObjects, siblingCentres);
      } else {
        /* The decisive line: the sweep was not the constraint. */
        diagnostics.widened.reason = "no-additional-holes-in-wider-frame";
        queryStages.push("widened-no-change");
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
    /* A separated course with a hole missing out of the middle: ask a small box
       around the gap before accepting the shortfall. Runs after separation because
       the gap is only visible per course - the site as a whole has every number. */
    if (loops && loops.some(loop => !loop.contiguous)) {
      const filled = await requeryHoleGaps(job, course, payload, loops)
        .catch(error => ({ record: { adopted: false, reason: String((error && error.message) || error).slice(0, 200) }, next: null }));
      diagnostics.gapFill = filled.record;
      if (filled.next) {
        payload = filled.next.payload;
        collision = filled.next.collision;
        loops = filled.next.loops;
        queryStages.push("gap-requery");
        diagnostics.osmFeatures = golfFeatureCounts(payload);
        diagnostics.collision = {
          loops: collision.loops,
          collidedHoles: collision.collidedHoles,
          widestSeparationM: collision.widestSeparationM,
          distinctNumbers: collision.distinctNumbers,
          holeFeatures: collision.holeFeatures
        };
      }
    }

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

  /* WHO SAID THIS SITE HOLDS SEVERAL COURSES - the search, or us?
   *
   * The transition that used to happen here without being named: "hole numbers
   * repeat" became "publish several separated courses", in one step, whatever
   * the player had actually selected. That is the step Millbrook went wrong on.
   * A scan started from the individual listing "Millbrook - Remarkables 18"
   * caught the rest of the resort's golf geometry, the collision fired, and the
   * mapper set about interpreting the ground into courses of its own invention -
   * when the answer had been handed to it in the search result.
   *
   * So the transition is now a router with three named outcomes, and the whole
   * point of naming them is that two of them treat duplicated ground in
   * OPPOSITE ways:
   *
   *   single-listing            the selection names one course. Map that course.
   *                             The rest of the site belongs to other listings,
   *                             and duplicating their ground later is fine.
   *   listing-led-multi-course  the selection names the place, and credible
   *                             individual course listings sit on it. They are
   *                             the children, they carry their own identity, and
   *                             nothing below second-guesses their ground.
   *   geometry-led-multi-course nothing named the courses, so the mapper is
   *                             inferring them - and only here does unique
   *                             physical-hole allocation become evidence.
   *
   * See lib/gd-course-listing-core.mjs for the rules and why the order runs this
   * way round. */
  let resolution = { mode: RESOLUTION_MODE.SINGLE_LISTING, reason: "no-multi-course-signal-on-this-ground" };
  /* Written now rather than at each return, so a job row that failed halfway
     still says which of the three problems the run thought it was solving. */
  diagnostics.resolution = Object.assign({}, resolution);
  /* Everything a single-listing verdict does: throw the site's other courses
     away and carry on as the ordinary one-course run below, over the ground the
     selected listing actually owns. Nothing downstream needs to know it
     happened - the collision is recomputed from the scoped payload, so it is
     simply no longer a multi-course site as far as this run is concerned. */
  const scopeRunToLoop = (loop, why) => {
    payload = loop.payload;
    collision = detectHoleNumberCollision(payload);
    geometry = resolveCourseGeometry(payload, course.courseId, loop.centre || course.center, existingObjects, []);
    queryStages.push("scoped-to-one-course");
    diagnostics.scopedToOneCourse = {
      reason: why,
      name: loop.name || course.courseName || null,
      osmRef: loop.osmRef || null,
      method: loop.method,
      holes: loop.holeNumbers.length,
      contiguous: loop.contiguous,
      otherCoursesOnSite: null
    };
    loops = null;
  };

  if (loops && loops.length > 1) {
    const plan = planListingResolution({ courseName: course.courseName, loops });
    resolution = { mode: plan.mode, reason: plan.reason };
    diagnostics.resolution = {
      mode: plan.mode,
      reason: plan.reason,
      listingKind: plan.listingKind,
      parentListing: plan.parentListing,
      childListings: plan.childListings.map(listing => listing.name),
      selectedListing: plan.selectedListing ? plan.selectedListing.name : null,
      courseCandidates: loops.length
    };

    if (plan.mode === RESOLUTION_MODE.SINGLE_LISTING) {
      const chosen = loops[plan.scopedLoopIndex] || loops[0];
      const others = loops.length - 1;
      scopeRunToLoop(chosen, plan.reason);
      diagnostics.scopedToOneCourse.otherCoursesOnSite = others;
      /* Deliberately NOT a warning. The other courses here are not a shortfall
         of this run - they are other listings, and a player who wants one
         searches for it and gets a scan of its own. Duplicated geometry between
         two listing-backed records is acceptable by design; see the listing
         core's header. */
    } else if (plan.mode === RESOLUTION_MODE.GEOMETRY_LED) {
      /* ELIMINATION, and only here.
       *
       * The mapper is inferring these courses, so a candidate assembled from
       * ground a stronger candidate already claimed is not a second course, and
       * a handful of scattered holes is not a course at all - Millbrook
       * produced a "1, 2, 18". Listing-backed children never reach this line. */
      const inferred = eliminateInferredCourses(loops.map((loop, index) => ({
        index,
        name: loop.name || null,
        contiguous: loop.contiguous,
        holes: loop.holeFeatures || []
      })));
      diagnostics.inferredCourses = inferred.ledger;
      if (inferred.withheld.length) {
        const survivors = inferred.courses.map(entry => loops[entry.index]);
        warnings.push(
          inferred.withheld.length + " separated candidate" + (inferred.withheld.length === 1 ? "" : "s")
          + " withheld as unresolved facility ground rather than published as courses ("
          + inferred.ledger.withheldCourses.map(entry => (entry.name || "candidate") + ": " + entry.ownHoles + " holes, " + entry.reason).join("; ")
          + ")"
        );
        loops = survivors;
      }
      /* One course left standing is not a facility. Publishing it through the
         separated path would give it a "- Course 1" suffix and a facility_key
         for siblings that do not exist, so it takes the ordinary single-course
         route instead. Nothing left standing falls through to the resolver
         below, which is the honest answer: separation produced no course. */
      if (loops.length === 1) scopeRunToLoop(loops[0], "only-one-inferred-course-survived-elimination");
      else if (!loops.length) loops = null;
    }
  }

  /* Every separated course published, the pinned one into the row this job was enqueued
     against so the player's own selection resolves immediately, the rest into rows of
     their own. Returns early: the single-course path below has nothing left to do. */
  if (loops && loops.length > 1) {
    /* CLEANLY MAPPED, AND THAT IS THE END OF IT.
     *
     * The numbering already separated these courses. Nothing below is asked to
     * re-derive them, and the Native Resolver is not invoked just because the
     * site turned out to hold nines - a 27-hole facility whose three loops OSM
     * numbered correctly is a finished job, not a harder one. What the loops are
     * to each other is a separate question, answered once here from the shapes
     * the separation produced. */
    const structure = assessFacilityStructure({
      candidateCount: loops.reduce((sum, loop) => sum + loop.holeNumbers.length, 0),
      osmNineLoops: loops.filter(loop => loop.holeNumbers.length === HOLES_PER_LOOP).length,
      /* Separated loops own disjoint ground by construction, so the candidate
         ids only have to be unique per loop - the position in the list is
         enough, and it does not depend on separateLoops carrying an index. */
      claims: loops.map((loop, index) => ({
        cardName: loop.name || "",
        holes: loop.holeNumbers.map(number => ({ holeNumber: number, candidateId: index + ":" + number }))
      }))
    });
    /* Numbering came from OSM either way; what differs is whether OSM's own
       course polygons sorted the holes onto their loops, or whether nothing
       said which loop was which and the AutoMapper had to chain hole geometry
       into loops itself. The second is the broken-numbering case, and calling
       it "osm-numbered" hid exactly the facilities whose separation is worth
       re-checking - see mappingMethodFor. */
    const osmMappingMethod = summariseMappingMethod(loops.map(loop => mappingMethodFor({
      osmNumberedHoles: loop.holeNumbers.length,
      separatedByGeometry: loop.method === "routing"
    })));
    const published = await publishSeparatedLoops(job, course, loops, expectedHoles, scorecardEvidence, origin);
    /* A child that could not be written is outstanding, not fatal - the ones
       that did publish are correct and playable, and saying which failed is
       what makes the next run a retry rather than a rediscovery. */
    if (published.failures) {
      diagnostics.failedChildren = published.failures;
      warnings.push(published.failures.length + " of " + (published.length + published.failures.length)
        + " courses at this facility could not be written ("
        + published.failures.map(entry => entry.courseId + ": " + entry.reason).join("; ")
        + ") - the rest published and are unaffected");
    }
    diagnostics.facilityStructure = structure;
    diagnostics.published = published.map(entry => ({ courseId: entry.courseId, holes: entry.holesResolved, contiguous: entry.contiguous, nameSource: entry.nameSource }));
    if (published.naming) diagnostics.loopNaming = published.naming;
    const short = published.filter(entry => !entry.contiguous);
    if (short.length) {
      warnings.push(short.length + " of " + published.length + " separated courses did not resolve a contiguous 1..n hole set"
        + " (" + short.map(entry => entry.courseId + ": " + entry.holesResolved).join(", ") + ") - separation is not trustworthy here");
    }
    /* Geometry is done and correct; the labels are the half still outstanding.
       Said on the row rather than left to be inferred from a "Course 2", so
       Studio can offer Update Scorecards against exactly the facilities that
       need it instead of re-scanning to find out. */
    const unlabelled = published.filter(entry => entry.nameSource === "provisional");
    if (unlabelled.length) {
      warnings.push(unlabelled.length + " of " + published.length + " courses published with provisional names"
        + " - run Update Scorecards to label them (geometry is complete and will not be re-scanned)");
    }
    return {
      courseId: course.courseId,
      mapperVersion: MAPPER_VERSION,
      multiCourse: true,
      /* WHY several courses are being published, not just THAT they are.
         `multiCourse: true` covered a listing-led split and a geometry-led one
         with the same flag, so nothing downstream - and nobody reading a job
         row - could tell a facility whose courses the search had already named
         from one the mapper partitioned itself. Those two have different
         trustworthiness and opposite rules about duplicated ground. */
      resolutionMode: resolution.mode,
      resolutionReason: resolution.reason,
      coursesPublished: published,
      facilityStructure: structure.structure,
      facilityOrganisation: organiseFacility(loops, {
        structure: structure.structure,
        mappingMethod: osmMappingMethod
      }),
      mappingMethod: osmMappingMethod,
      needsLabelling: unlabelled.length > 0,
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
      /* The resolver is answering here because loop separation could not tell
         the courses apart, so its numbering stands alone - the colliding OSM
         numbers it replaced identified nothing. */
      osmNumberedHoles = 0;
      resolverNumberedHoles = guides.length;
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
    /* Same mis-centring as the multi-course widen above, same fix: grow around the
       holes, not around the clubhouse. This is the Omaha Beach path - a long thin
       course with its pin at one end is exactly the shape a pin-centred box handles
       worst, so it had the bug more sharply than the case it was written for. */
    const retryAnchor = frameCentre(holeFeatureFrame(payload)) || course.center;
    const widerFrame = unionOsmFrames(
      osmScopeFrame(scope, course.center),
      expandOsmFrame({ south: retryAnchor.lat, west: retryAnchor.lng, north: retryAnchor.lat, east: retryAnchor.lng }, scope.radiusM + WIDER_RETRY_PAD_M),
      holeFeatureFrame(payload, WIDEN_DATA_PAD_M)
    );
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

    /* A scorecard describes a COURSE. The ground is the facility.
     *
     * Everything above this point has taken expectedHoles - which on this path
     * came from a scorecard - as the size of the site. At Howeston that made one
     * 9-hole GolfPass card speak for 27 fairways, and the resolver dutifully
     * matched nine of them and called the job done. So before the resolver's
     * answer is adopted, ask whether the card was ever describing the whole
     * place. See detectUnnumberedMultiLoop. */
    const facility = detectUnnumberedMultiLoop({
      candidateCount: (result.debugEvidence && result.debugEvidence.totalHoleCandidates) || 0,
      cardHoles: expectedHoles
    });
    diagnostics.unnumberedFacility = facility;
    if (facility.multiLoop) {
      /* The nine this run has ALREADY identified, handed forward rather than
         resolved again from scratch.
       *
         The resolver above matched a full card over this ground and reported a
         confidence for it; that is an accepted claim, not work to redo. Seeding
         it is what makes the facility a smaller problem than the site - the
         partial-success case where AutoMapper or the resolver gets one loop
         right and only the remainder needs harder work. */
      const seedGuides = (result.holes || []).map(hole => guideFromResolvedHole(hole, result)).filter(Boolean);
      const seedByHole = new Map((result.holes || []).map(hole => [hole.holeNumber, hole]));
      const seedClaim = (expectedHoles && seedGuides.length >= expectedHoles) ? {
        cardName: (scorecardEvidence && scorecardEvidence.cardName) || "",
        confidence: result.confidence || 0,
        method: MAPPING_METHOD.NATIVE_RESOLVER,
        resolverGreens: (result.debugEvidence && result.debugEvidence.greenCandidates || []).map(green => ({ center: green.centre, shape: green.polygon })),
        holes: seedGuides.map(guide => ({
          holeNumber: guide.hole,
          candidateId: String((seedByHole.get(guide.hole) || {}).candidate ? seedByHole.get(guide.hole).candidate.candidateId : guide.id),
          guide
        }))
      } : null;
      const separated = await publishUnnumberedFacility({
        job, course, payload, origin, facility, expectedHoles, existingObjects, resolverStatus, seedClaim
      });
      diagnostics.unnumberedSeparation = separated.record;
      if (separated.published) {
        diagnostics.published = separated.published.map(entry => ({ courseId: entry.courseId, holes: entry.holesResolved, contiguous: entry.contiguous, nameSource: entry.nameSource }));
        /* Nines sliced out of a composite card are unnamed by construction -
           "Red + White" names neither of them - so this path expects to leave
           labelling to Update Scorecards rather than treating it as a shortfall. */
        const unlabelled = separated.published.filter(entry => entry.nameSource === "provisional");
        if (unlabelled.length) {
          warnings.push(unlabelled.length + " of " + separated.published.length + " courses published with provisional names"
            + (separated.record.composite ? " (sliced from combined play-order cards, which name no single nine)" : "")
            + " - run Update Scorecards to label them (geometry is complete and will not be re-scanned)");
        }
        /* Said on the row, because a facility that published two of its three
           nines looks identical to a finished two-nine facility from the outside
           - and the difference is a whole course the player cannot reach. */
        const outstanding = separated.record.unresolvedGround;
        if (outstanding) {
          warnings.push("published " + separated.published.length + " of about "
            + separated.record.expectedLoops + " loops; " + outstanding.candidates
            + " hole candidates remain unexplained"
            + (outstanding.reason ? " (" + outstanding.reason + ")" : "")
            + " - no scorecard was found for the remaining ground, so it cannot be numbered."
            + " Geometry for what published is complete and will not be re-scanned.");
        }
        return {
          courseId: course.courseId,
          mapperVersion: MAPPER_VERSION,
          multiCourse: true,
          /* Always geometry-led: nothing on this ground carried a hole number,
             let alone a course listing, so every one of these courses was
             inferred - from the cards, over ground the mapper allocated. The
             elimination that keeps that honest is the card reconciler's own
             (contestedClaims, dropContainedClaims, dedupeLoops in
             lib/gd-facility-loops-core.mjs), which is why the numbered path's
             claim ledger is not run a second time over it. */
          resolutionMode: RESOLUTION_MODE.GEOMETRY_LED,
          resolutionReason: "no-osm-hole-numbering-courses-derived-from-cards",
          coursesPublished: separated.published,
          /* What the site IS, on the row rather than inferred from a row count.
             Downstream decides grouping and round-start pairing from this; it
             does not get to reach back and change how the ground was matched. */
          facilityStructure: separated.record.structure,
          facilityOrganisation: separated.record.organisation || null,
          mappingMethod: separated.record.mappingMethod || null,
          needsLabelling: unlabelled.length > 0,
          queryStages,
          expectedHoles,
          warnings: warnings.length ? warnings : undefined,
          diagnostics
        };
      }
      /* Not enough cards to tell the loops apart. The single course still
         publishes - a playable nine beats nothing, and the ground it sits on is
         real - but it publishes as what it is: one course out of a facility we
         could not finish separating. courseFitVerdict is told not to trust the
         run, so the Studio and the player both see an unfinished answer rather
         than the confident "done" this used to report. */
      facilityUnresolved = facility;
      warnings.push(
        "facility geometry holds about " + facility.candidateCount + " holes but only a "
        + facility.cardHoles + "-hole scorecard was found (" + facility.loops + " loops suspected)"
        + " - " + separated.record.reason + "; published one course of a multi-loop facility"
      );
    }

    const guides = (result.holes || []).map(hole => guideFromResolvedHole(hole, result)).filter(Boolean);
    /* The resolver's numbering (scorecard-derived, OSM refs ignored) only replaces the
       OSM-numbered answer when it genuinely covers MORE holes - a lower-coverage resolver run
       must not clobber good numbered geometry. In the no-numbering case anything it found is
       strictly better than the nothing OSM numbering produced. */
    if (guides.length > geometry.holesResolved) {
      const resolverGreens = (result.debugEvidence && result.debugEvidence.greenCandidates || []).map(green => ({ center: green.centre, shape: green.polygon }));
      const base = numberingIssue ? Object.values(geometry.objects) : existingObjects;
      const merged = resolveGuidesIntoObjects(guides, course.courseId, resolverGreens, base);
      /* numberingIssue means OSM had shapes and no numbers at all, so every
         published number is the resolver's. The short-of-expected case is the
         genuinely mixed one: OSM numbered part of the course and the resolver
         filled in the rest, and reporting either method alone would overstate
         the evidence behind half the holes. */
      osmNumberedHoles = numberingIssue ? 0 : geometry.holesResolved;
      resolverNumberedHoles = guides.length;
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
  /* Late trust check: does the ground we resolved actually look like the card
     this course's own name matched to? Only fires on evidence that is a
     genuine name-match for THIS course - a facility-fallback card (any card
     stored for the site, used above only to fill in expectedHoles) might just
     as well belong to a sibling, so scoring it here would manufacture false
     wrong-neighbour alarms rather than catch real ones. Reuses the exact
     relative-shape math course-scorecard-update.mjs uses to tell siblings
     apart - see gd-scorecard-match-core.mjs. */
  const identityMatchedEvidence = scorecardEvidence && !(diagnostics.scorecardResolve && diagnostics.scorecardResolve.facilityFallback);
  const scorecardIdentity = identityMatchedEvidence
    ? Object.assign(
      scorePairing({ id: course.courseId, lengths: courseLengthsFromPublishedGeometry(geometry.objects) }, scorecardEvidence, null),
      { cardName: course.courseName }
    )
    : null;
  /* Whether the coordinate this run was given can be trusted, decided from what
     the run actually found. The player is only asked to drag a pin when this
     says the answer is clearly wrong - see lib/gd-course-fit-core.mjs. */
  const fit = courseFitVerdict({
    collision,
    expectedHoles,
    holesResolved: geometry.holesResolved,
    /* The hole numbers themselves, so the verdict can judge coverage against the
       card when there is one and against the standard 9/18/27/36 shape when there
       is not - see courseCoverageComplete. */
    holeNumbers: Object.keys(geometry.holes || {}).map(Number).filter(Number.isFinite),
    courseBounds,
    scorecardIdentity,
    facilityUnresolved
  });
  const resolvedHoleNumbers = Object.keys(geometry.holes || {}).map(Number).filter(Number.isFinite);

  /* THE ORDINARY COURSE ANSWERS THE SAME THREE QUESTIONS AS THE HARD ONES.
   *
   * Structure, method and organisation were built for the facilities that
   * needed untangling, and only those facilities reported them. So a standalone
   * 18 - the commonest shape there is - published with none of the three, and
   * anything downstream reading facilityStructure had to treat "absent" as
   * "probably one course", which is an inference about the site made from a
   * missing field. Now it is stated.
   *
   * Deliberately run through the SAME assessor, not short-circuited to
   * single-course on the grounds that one row published. That matters in the
   * one case where it could lie: when the ground proved bigger than the card
   * and the other cards could not be found, this course IS a fragment of a
   * facility, and asking the assessor over the facility's full candidate count
   * returns unknown - one claim with a loop or more standing outside it - which
   * is the truth. Claiming single-course there would tell downstream the site
   * was finished. */
  if (!osmNumberedHoles && !resolverNumberedHoles) osmNumberedHoles = geometry.holesResolved;
  const singleMappingMethod = mappingMethodFor({
    osmNumberedHoles,
    resolverHoles: resolverNumberedHoles
  });
  const singleStructure = assessFacilityStructure({
    candidateCount: facilityUnresolved ? facilityUnresolved.candidateCount : resolvedHoleNumbers.length,
    claims: resolvedHoleNumbers.length
      ? [{
        cardName: (scorecardEvidence && scorecardEvidence.cardName) || course.courseName || "",
        /* Hole numbers are unique within a course, so they identify the ground
           here without the candidate ids the facility paths carry. */
        holes: resolvedHoleNumbers.map(number => ({ holeNumber: number, candidateId: "hole:" + number }))
      }]
      : []
  });
  diagnostics.facilityStructure = singleStructure;
  diagnostics.mappingMethod = {
    method: singleMappingMethod,
    osmNumberedHoles,
    resolverHoles: resolverNumberedHoles
  };

  /* Carried rather than rebuilt client-side: the player is being asked to do
     work, so the sentence explaining why lives next to the rule that decided
     it. */
  if (!fit.trusted) fit.message = courseFitMessage(fit);
  diagnostics.fit = fit;
  return {
    courseId: course.courseId,
    fit,
    mapperVersion: MAPPER_VERSION,
    /* Stated on the ordinary course too. "single-listing" here is not a
       fallback for "no facility fields" - it is the answer: one listing was
       selected and one course was mapped. When the router scoped a multi-course
       site down to the listing the player picked, this is the same value for the
       same reason, and diagnostics.scopedToOneCourse says which ground it kept. */
    resolutionMode: resolution.mode,
    resolutionReason: resolution.reason,
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
    /* The same three answers the facility paths give, on the ordinary course
       too, so nothing downstream has to read an absent field as a verdict. */
    facilityStructure: singleStructure.structure,
    mappingMethod: singleMappingMethod,
    facilityOrganisation: organiseFacility(
      /* nameSource left to the organiser to derive: a course row that somehow
         reached here unnamed should report as needing labelling, not assert a
         name it does not have. */
      [{ name: course.courseName || "", holes: resolvedHoleNumbers }],
      { structure: singleStructure.structure, mappingMethod: singleMappingMethod }
    ),
    /* Carried on the result so chainVisualSnapshot below can run the licensing check without
       re-reading the row it just wrote, and so a job's record shows what ground the mapper
       actually covered. */
    courseBounds,
    /* Carried so chainVisualSnapshot can judge coverage without re-deriving it. */
    holeNumbers: resolvedHoleNumbers,
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
async function chainVisualSnapshot(courseId, courseBounds, origin, coverage) {
  /* Frames are only worth rendering for a course that is actually finished.
   *
   * The chain used to fire on any saved geometry, so a scan that resolved 11 of 18
   * holes still got a full frame set rendered and written to the bucket - a few
   * hundred files and tens of MB per bad scan, for a course that courseFitVerdict
   * will not serve as a full map anyway. That is the same storage the orphan
   * cleanup exists to reclaim, being fed from the front.
   *
   * Geometry still saves and the course still plays on a live map; only the render
   * waits until the coverage is real. */
  if (coverage && !coverage.complete) {
    return { chained: false, reason: "coverage-incomplete: " + coverage.reason + " (" + coverage.holes + " holes)" };
  }
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
        result.visualChain = await chainVisualSnapshot(job.course_id, result.courseBounds, origin,
          courseCoverageComplete({
            holeNumbers: (result.fit && result.fit.detail && result.fit.detail.holeNumbers) || result.holeNumbers || [],
            expectedHoles: result.expectedHoles
          }))
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

export const __courseMapperWorkerTest = { claimJob, finishJob, heartbeatJob, reapStaleJobs, runMapperJob, chainVisualSnapshot, transientMapperFailure, golfFeatureCounts, publishSeparatedLoops, nameLoopsFromCards, MAX_TRANSIENT_ATTEMPTS };
