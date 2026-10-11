/* Server-side AutoMapper geometry core: a from-scratch, faithful port of the pure
   query/parse/match/dedupe pieces of the client AutoMapper in
   scripts/gd-course-library-pin-lock.js, following the same precedent as
   functions/lib/gd-visual-plan-core.mjs (a standalone port kept honest by a parity test,
   not a shared import - this codebase has already chosen "two implementations, tested for
   agreement" over "one shared module loaded by both runtimes" for exactly this class of
   problem, since the browser file is full of DOM/localStorage/UI code that has no server
   equivalent).

   What this module does NOT include, deliberately: anything that reads/writes localStorage,
   touches the DOM/Leaflet, or drives UI (toasts, debug telemetry, map framing). Those stay
   client-side or have no server equivalent at all. What this module adds that the client
   never needed: resolveCourseGeometry(), a pure function that walks OSM guides straight into
   an in-memory objects/holes map - the server-side replacement for what saveCourseObject()
   did against a localStorage-backed store.

   Line references below point at the client functions this was ported from, so the two can
   be compared directly when the client algorithm changes. */

/* The capture corridor is imported rather than re-derived: surfaces are selected by the exact
   box a hole is photographed at, so a second copy of that arithmetic here could drift and start
   putting hazards on holes they are not visible on. One-way - gd-visual-plan-core.mjs imports
   only gd-imagery-sources.mjs, so there is no cycle. */
import { packageHoleData, boundsFromPoints, padBounds, boundsSpanM, validBounds, capturePolicy } from "./gd-visual-plan-core.mjs";

/* Bumped whenever this module's resolution algorithm changes in a way that should make an
   already-mapped course eligible to be remapped. Compared against course_maps.geometry_version
   by functions/course-mapper-jobs.mjs and written by functions/course-mapper-worker-background.mjs -
   the single source of truth for both, per the migration plan's stage 3 note.
   v2: footprint-bbox querying (long thin courses no longer clipped by the 1400m circle) and
   one-green-one-hole assignment (a guide can no longer steal a neighbouring hole's green). */
export const MAPPER_VERSION = "v2";

export const OSM_AUTOMAPPER_RADIUS_M = 1400; // gd-course-library-pin-lock.js:2109
export const OSM_AUTO_GREEN_MATCH_RADIUS_M = 95; // gd-course-library-pin-lock.js:40
export const OSM_AUTO_GREEN_MAX_SPAN_M = 145; // gd-course-library-pin-lock.js:41
export const OBJECT_DEDUPE_RADIUS_M = { green: 26, bunker: 14, tee: 9, fairway: 12, water: 30, fairway_area: 40, default: 10 }; // :39

/* OSM-derived course surfaces. Deliberately NOT "fairway": that type is already taken by the
   1-2 centreline sample points fairwaySamplesForGuide writes, which packageHoleData reads into
   a hole's route and planCourseCaptures turns into corridorBounds. Reusing the name would push
   every fairway polygon's centroid into the route and shift every hole's capture frame. */
export const SURFACE_TYPES = new Set(["fairway_area", "bunker", "water", "trees", "hazard", "waste"]);
/* Surfaces that are never wand-refined: the refine traces an edge it already believes in (a sand
   or water boundary), and a tree line or a gorse patch has no such edge in the frame. */
export const HAND_DRAWN_SURFACE_TYPES = new Set(["trees", "hazard", "waste"]);
export const SURFACE_SOURCE = "osm_auto_surface";

/* A surface whose geometry has been re-traced from our own published frame
   (gd-surface-refine-core.mjs). Declared HERE rather than there because upsertResolvedObject
   below has to recognise it, and the refine core imports this module - the dependency only
   runs one way. */
export const REFINED_SHAPE_SOURCE = "wand_refined";

/* Bumped independently of MAPPER_VERSION so an improved surface pass can be re-run over a
   course whose hole geometry did not change.
   s2: relation outlines joined (relation-mapped fairways and lakes were being lost), OSM woods
   read as trees, and default fairways laid on holes OSM has none for. */
export const SURFACE_MAPPER_VERSION = "s2";

/* Stored polygons are simplified to this many points. Lower than the client's 64-point cap for
   greens (gd-course-library-pin-lock.js:1364) because surfaces are not greens: a surface is
   cloned once per hole whose corridor it falls in, so every point is paid for several times
   over, and the course package ships these to every player on the course.

   Measured on Millbrook rather than guessed: at 64 points its 115 OSM features became 278
   stored surfaces carrying 7,117 points and a 322KB package, against 5KB before enrichment.
   At 16 the same course lands at ~160KB. A bunker or water outline is still smooth at play
   zoom by then - the detail this gives up is on very large lake rings, which are drawn at a
   scale where it does not read. */
export const SURFACE_SHAPE_MAX_POINTS = 16;
/* Fairways get twice that. There are only one or two per hole, and at 16 a long dogleg
   fairway lost its bend and the bites its bunkers take out of it - the shape a player reads. */
export const SURFACE_SHAPE_MAX_POINTS_BY_TYPE = { fairway_area: 32 };

/* Greens get a cap too, but a far higher one, and for the opposite reason to surfaces. Nothing
   bounded them server-side at all before this - cleanOsmShape returns whatever OSM drew, and
   only the CLIENT ever decimated (gd-course-library-pin-lock.js:1364, at 64). So a densely
   traced green went into course_maps at full resolution and shipped that way.
   64 rather than the surfaces' 16 because a green's outline is load-bearing geometry: front
   and back yardages, pin distances and the green-focus render all read it. This is a ceiling
   on the pathological case, not a decimation of the normal one - Millbrook's greens are 14-25
   points and are not touched by it. */
export const GREEN_SHAPE_MAX_POINTS = 64;

/* Gross-mismatch rejection only (the plan's "do not over-clean good OSM geometry"): a 400m
   "bunker" and a 15m "fairway" are tagging errors, anything in between is trusted as-is. */
export const SURFACE_SPAN_LIMITS_M = {
  bunker: { min: 2, max: 140 },
  fairway_area: { min: 25, max: 900 },
  water: { min: 3, max: 1200 },
  trees: { min: 3, max: 1200 },
  hazard: { min: 3, max: 1200 },
  waste: { min: 3, max: 1200 }
};

/* ---------- plain geometry (no Leaflet) --------------------------------------------------- */

export function toPlain(ll) {
  return ll ? { lat: Number(ll.lat), lng: Number(ll.lng) } : null;
}

/* Same haversine-free flat-earth approximation the client falls back to when no Leaflet map
   instance is available (gd-course-library-pin-lock.js:1145-1152) - accurate enough at
   course scale (tens to low hundreds of meters) and the only option server-side. */
export function distance(a, b) {
  if (!a || !b) return Infinity;
  const lat = (Number(a.lat) + Number(b.lat)) * Math.PI / 360;
  const dy = (Number(b.lat) - Number(a.lat)) * 111320;
  const dx = (Number(b.lng) - Number(a.lng)) * 111320 * Math.cos(lat);
  return Math.hypot(dx, dy);
}

/* gd-app-core.js:22858 - bearing in radians, distance in meters. */
export function project(origin, bearingRad, meters) {
  const earth = 111320;
  return {
    lat: origin.lat + (Math.cos(bearingRad) * meters) / earth,
    lng: origin.lng + (Math.sin(bearingRad) * meters) / (earth * Math.cos(origin.lat * Math.PI / 180))
  };
}

export function fallbackGreenShape(center, radiusM = 16, count = 40) {
  if (!center) return [];
  const pts = [];
  for (let i = 0; i < count; i++) pts.push(project(center, (Math.PI * 2 * i) / count, radiusM));
  return pts;
}

export function validHoleNumber(value) {
  const h = Number(value);
  return Number.isFinite(h) && h >= 1 && h <= 36 ? Math.round(h) : null;
}

/* NFD-normalised before the character filter, because [^a-z0-9] does not eat a
   macron - it eats the letter WITH the macron and the space beside it. "Te Arai
   Links" (with the macron on the A) slugged to "te-rai", a course id that is not
   the course's name and reads as a typo, and every accented club in the world
   had the same problem waiting. */
export function slug(s) {
  return String(s || "item").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

/* ---------- course identity / duplicate matching (gd-course-library-pin-lock.js:763-1073) - */

export function normalizeCourseName(s) {
  const cleaned = String(s || "").replace(/\b(golf club|golf course|country club|gc|course|club|cub)\b/gi, " ").replace(/\s+/g, " ").trim();
  return cleaned ? slug(cleaned) : "";
}

export function courseIdentity(course) {
  const name = normalizeCourseName(course && (course.courseName || course.name));
  if (name && name !== "manual-gps") return "name:" + name;
  const cid = slug((course && (course.courseId || course.id)) || "assumed-golf-course");
  return "id:" + cid;
}

export function courseMatchesIdentity(course, candidateId, candidateName) {
  if (!course) return false;
  const cId = slug(candidateId || "");
  const courseCid = slug(course.courseId || course.id || "");
  if (cId && courseCid && cId === courseCid) return true;
  const probe = normalizeCourseName(candidateName || "");
  const courseNameKey = normalizeCourseName(course.courseName || course.name || "");
  return !!(probe && courseNameKey && probe === courseNameKey);
}

/* ---------- facility vs course identity --------------------------------------------------- */

/* A FACILITY is a club; a COURSE is one loop within it. "Taupo Golf Club Centennial" and
   "Taupo Golf Club Tauhara" are two courses at one facility and each need their own geometry.
   The 4km duplicate check in functions/course-package.mjs used to collapse any two courses
   within range into one, so the second course at a facility served the first's holes and
   never got a mapper job of its own - it could not be mapped at all.

   splitCourseName pulls a name apart at an explicit separator, or otherwise at the club
   designator:
     "Taupo Golf Club Centennial"  -> facility "Taupo Golf Club",    label "Centennial"
     "Taupo Golf Club - Tauhara"   -> facility "Taupo Golf Club",    label "Tauhara"
     "Riverside Golf Club (Par 3)" -> facility "Riverside Golf Club", label "Par 3"
     "Muriwai Golf Club"           -> facility "Muriwai Golf Club",   label ""
   An empty label means the name does not identify a particular loop. Bare "golf" is
   deliberately NOT a designator - it would split ordinary course names that merely contain
   the word. */
const COURSE_DESIGNATOR = /\b(golf links|golf club|golf course|golf centre|golf center|golf resort|country club|gc)\b/i;

export function splitCourseName(raw) {
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  if (!text) return { facility: "", label: "" };
  /* A trailing parenthetical always names the loop: "X Golf Club (Par 3)". */
  const paren = text.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (paren && paren[1].trim()) return { facility: paren[1].trim(), label: paren[2].trim() };
  /* A dash/colon separator splits facility from loop, but only when the left side still looks
     like a club - "Wairakei - Taupo" is one course's name, not a facility and a loop. */
  const separated = text.match(/^(.*?)\s+[-–—:]\s+(.*)$/);
  if (separated && COURSE_DESIGNATOR.test(separated[1])) return { facility: separated[1].trim(), label: separated[2].trim() };
  /* Otherwise whatever trails the club designator names the loop. */
  const designator = text.match(COURSE_DESIGNATOR);
  if (designator) {
    const cut = designator.index + designator[0].length;
    const label = text.slice(cut).trim();
    if (label) return { facility: text.slice(0, cut).trim(), label };
  }
  return { facility: text, label: "" };
}

export function facilityIdentity(course) {
  const key = normalizeCourseName(splitCourseName(course && (course.courseName || course.name)).facility);
  if (key) return "facility:" + key;
  return "facility-id:" + slug((course && (course.courseId || course.id)) || "assumed-golf-course");
}

export function courseLabelKey(course) {
  const label = splitCourseName(course && (course.courseName || course.name)).label;
  return label ? slug(label) : "";
}

/* Same facility and same loop - or one side not naming a loop at all - is the SAME course
   under a different id/name, and should still be redirected to the already-mapped copy: that
   is what the duplicate check exists for, so two players' spellings don't each start a job.
   Same facility with two different named loops is a SIBLING pair, and both must be mapped.
   A bare club name matches any loop on purpose: someone who typed only "Taupo Golf Club"
   most likely means the main course, and sending them to it is the useful old behaviour. */
export function classifyCourseRelationship(a, b) {
  if (facilityIdentity(a) !== facilityIdentity(b)) return "unrelated";
  const aLabel = courseLabelKey(a);
  const bLabel = courseLabelKey(b);
  return !aLabel || !bLabel || aLabel === bLabel ? "duplicate" : "sibling";
}

/* Nearby-course matching by distance, ported from nearbyKnownCourses/nearestKnownCourse
   (gd-course-library-pin-lock.js:498-527) but taking a plain candidate list instead of
   reading from localStorage/window globals - the server's candidate list is a Supabase
   query result, not a client store. */
export function nearbyKnownCourses(center, candidates, maxDistanceM) {
  if (!center) return [];
  const seen = new Set();
  return (candidates || [])
    .map(course => {
      const name = course && (course.courseName || course.name);
      const point = course && Number.isFinite(Number(course.courseLat)) && Number.isFinite(Number(course.courseLng))
        ? { lat: Number(course.courseLat), lng: Number(course.courseLng) } : null;
      const key = normalizeCourseName(name) || slug(course && course.courseId || name);
      if (!name || !point || seen.has(key)) return null;
      seen.add(key);
      return { name, courseName: name, courseId: (course && course.courseId) || slug(name), lat: point.lat, lng: point.lng, distanceM: distance(center, point) };
    })
    .filter(Boolean)
    .filter(course => Number.isFinite(course.distanceM) && course.distanceM <= maxDistanceM)
    .sort((a, b) => a.distanceM - b.distanceM);
}

/* ---------- OSM Overpass query building (gd-course-library-pin-lock.js:2118-2157) --------- */

export function normalizedOsmFrame(frame) {
  if (!frame) return null;
  const south = Number(frame.south ?? frame.minLat);
  const west = Number(frame.west ?? frame.minLng);
  const north = Number(frame.north ?? frame.maxLat);
  const east = Number(frame.east ?? frame.maxLng);
  if (![south, west, north, east].every(Number.isFinite)) return null;
  const out = { south: Math.min(south, north), west: Math.min(west, east), north: Math.max(south, north), east: Math.max(west, east) };
  if (out.north <= out.south || out.east <= out.west) return null;
  return out;
}

export function osmQueryRadius(opts = {}) {
  const raw = Number(opts.osmRadiusM ?? opts.radiusM);
  if (Number.isFinite(raw) && raw > 0) return Math.max(400, Math.min(5000, Math.round(raw)));
  return OSM_AUTOMAPPER_RADIUS_M;
}

export function osmQueryScope(opts = {}, center) {
  const frame = normalizedOsmFrame(opts.osmFrame || opts.queryFrame);
  if (frame) {
    const box = [frame.south, frame.west, frame.north, frame.east].map(value => Number(value).toFixed(6)).join(",");
    return { mode: "bbox", selector: "(" + box + ")", frame };
  }
  const radiusM = osmQueryRadius(opts);
  return { mode: "around", selector: "(around:" + radiusM + "," + center.lat + "," + center.lng + ")", radiusM, center: toPlain(center) };
}

/* ---------- course footprint frame (why: Omaha Beach) --------------------------------------
   The around-radius query circles the stored course PIN, which usually sits at the clubhouse
   - not the centroid. On a long thin course (Omaha Beach runs ~2.3km down a spit with the pin
   at the north end) the far loop sits entirely outside the 1400m circle, so Overpass never
   returns those holes and the mapper "succeeds" with a partial course. The course's own
   footprint polygon (golf=course / leisure=golf_course) is the honest query area: derive a
   padded bbox from it and requery in bbox mode when it spills outside the circle. */

/* Pad FIRST, normalise second.
 *
 * normalizedOsmFrame rejects a zero-area box, and osmScopeFrame deliberately builds
 * one - a point at the course centre, to be inflated by the query radius. Running
 * the rejection before the padding meant it returned null for every around-scope,
 * so osmScopeFrame answered null every time, so expandOsmFrame(null) answered null,
 * and BOTH widen paths quietly did nothing: the wider-retry that has been in this
 * file for months and the multi-course widen added today. A point plus a pad is a
 * perfectly good box; it just is not one yet at the moment it arrives. */
export function expandOsmFrame(frame, padM = 0) {
  if (!frame) return null;
  const south = Number(frame.south ?? frame.minLat), west = Number(frame.west ?? frame.minLng);
  const north = Number(frame.north ?? frame.maxLat), east = Number(frame.east ?? frame.maxLng);
  if (![south, west, north, east].every(Number.isFinite)) return null;
  const pad = Number(padM) || 0;
  /* A degenerate frame with no padding stays degenerate, and that IS invalid - the
     caller asked to expand by nothing, so there is nothing to hand back. */
  const f = { south: Math.min(south, north), west: Math.min(west, east), north: Math.max(south, north), east: Math.max(west, east) };
  if (pad <= 0) return normalizedOsmFrame(f);
  const centerLat = (f.south + f.north) / 2;
  const latPad = padM / 111320;
  const lngPad = padM / (111320 * Math.max(0.2, Math.cos(centerLat * Math.PI / 180)));
  return { south: f.south - latPad, west: f.west - lngPad, north: f.north + latPad, east: f.east + lngPad };
}

function isCourseFootprintElement(element) {
  const t = (element && element.tags) || {};
  return String(t.golf || "").toLowerCase() === "course" || String(t.leisure || "").toLowerCase() === "golf_course";
}

/* Bounding box of a set of points. Degenerate on its own (a single point gives a
   zero-area box) - always hand the result to expandOsmFrame with a pad. */
export function frameOfPoints(points) {
  let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
  (points || []).map(toPlain).forEach(p => {
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return;
    south = Math.min(south, p.lat); north = Math.max(north, p.lat);
    west = Math.min(west, p.lng); east = Math.max(east, p.lng);
  });
  if (!Number.isFinite(south) || !Number.isFinite(west)) return null;
  return { south, west, north, east };
}

export function frameCentre(frame) {
  if (!frame) return null;
  const south = Number(frame.south), west = Number(frame.west);
  const north = Number(frame.north), east = Number(frame.east);
  if (![south, west, north, east].every(Number.isFinite)) return null;
  return { lat: (south + north) / 2, lng: (west + east) / 2 };
}

export function unionOsmFrames(...frames) {
  const list = frames.filter(Boolean);
  if (!list.length) return null;
  const corners = [];
  list.forEach(frame => {
    const south = Number(frame.south), west = Number(frame.west);
    const north = Number(frame.north), east = Number(frame.east);
    if (![south, west, north, east].every(Number.isFinite)) return;
    corners.push({ lat: south, lng: west }, { lat: north, lng: east });
  });
  return frameOfPoints(corners);
}

/* The overlap of two frames, or null when they do not overlap. */
export function intersectOsmFrames(a, b) {
  if (!a || !b) return null;
  const south = Math.max(Number(a.south), Number(b.south)), north = Math.min(Number(a.north), Number(b.north));
  const west = Math.max(Number(a.west), Number(b.west)), east = Math.min(Number(a.east), Number(b.east));
  if (![south, west, north, east].every(Number.isFinite) || south >= north || west >= east) return null;
  return { south, west, north, east };
}

/* The footprints that are THIS course's: ones whose padded box holds the course pin.
   Any course polygon touching the 1400m circle used to count, so at Darenth Valley a
   neighbour - Austin Lodge, closed 2014, no holes - became "the course": the requery
   searched only its box, Darenth's own holes were thrown away, and its name was used as
   Darenth's first scorecard search. High Elms failed the same way. */
export function ownCourseFootprints(payload, center, padM = 400) {
  const footprints = ((payload && payload.elements) || []).filter(isCourseFootprintElement);
  const origin = toPlain(center);
  if (!origin) return footprints;
  return footprints.filter(element => {
    const box = expandOsmFrame(frameOfPoints(osmGuidePointsFromElement(element)), padM);
    return !!box && origin.lat >= box.south && origin.lat <= box.north && origin.lng >= box.west && origin.lng <= box.east;
  });
}

export function courseFootprintFrame(payload, padM = 160, center = null) {
  const pts = [];
  ownCourseFootprints(payload, center).forEach(element => {
    osmGuidePointsFromElement(element).forEach(p => pts.push(p));
  });
  if (!pts.length) return null;
  return expandOsmFrame(frameOfPoints(pts), padM);
}

/* Where the holes ACTUALLY are, as a frame.
 *
 * The widen frame used to be a square centred on the stored course pin, which is
 * the clubhouse, not the middle of the site. At Te Arai Links the pin sits at the
 * North course in the north-west corner, so a 2198m half-extent box put its south
 * edge at lat -36.20010 - and Course 2's bottom holes sit BELOW that: hole 2's
 * green 33m past it, hole 3's tee 50m, hole 4's green 54m, hole 6's tee 82m. Those
 * came back at all only because Overpass returns a whole way when any one of its
 * nodes is inside the box. Hole 5 lives entirely in that strip (hole 4's green and
 * hole 6's tee are 95m apart, so 5 is tucked in the corner between them), had no
 * node inside, and was never fetched. The box was mis-centred by ~910m against a
 * shortfall of 82m.
 *
 * Centring on the hole features instead costs nothing and is usually SMALLER than
 * the pin-centred box, because it stops spending half its area on the ocean and
 * farmland the pin happens to sit beside. */
export function holeFeatureFrame(payload, padM = 0) {
  const pts = [];
  ((payload && payload.elements) || []).forEach(element => {
    const tags = (element && element.tags) || {};
    if (String(tags.golf || "").toLowerCase() !== "hole") return;
    if (!osmGuideHoleRef(tags.ref || tags.name)) return;
    osmGuidePointsFromElement(element).forEach(p => pts.push(p));
  });
  if (!pts.length) return null;
  const frame = frameOfPoints(pts);
  return padM > 0 ? expandOsmFrame(frame, padM) : normalizedOsmFrame(frame);
}

/* The wider retry may only finish a course the first search found, never supply one.
 *
 * It exists for the course whose far holes sit outside the 1400m circle (Omaha Beach) -
 * some of its holes are always inside. When NONE are, every hole the wider box brings
 * back is somebody else's: East Berkshire's own holes were hand-drawn but not yet
 * numbered, the retry found seven numbered holes of a neighbour 2.7km away, published
 * them as East Berkshire, and their mismatch with East Berkshire's card then stopped the
 * resolver from numbering the real ones. With nothing to extend, the resolver gets the
 * course as it is. */
export function widerRetryAdopts(holesBefore, holesAfter) {
  return holesBefore > 0 && holesAfter > holesBefore;
}

/* Two Overpass payloads into one, deduped on type/id so a targeted follow-up query
   can be folded into the main sweep without double-counting the overlap. */
export function mergeOsmPayloads(base, extra) {
  const osmElementKey = element => (element && element.id != null)
    ? String(element.type || "way") + "/" + element.id
    : null;
  const elements = ((base && base.elements) || []).slice();
  const seen = new Set(elements.map(osmElementKey).filter(Boolean));
  ((extra && extra.elements) || []).forEach(element => {
    const key = osmElementKey(element);
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    elements.push(element);
  });
  return Object.assign({}, base || {}, { elements });
}

/* The course polygon's holes=N tag is the only hole-count evidence available without a shared
   scorecard - enough to notice "the card says 18, I resolved 15" and retry/warn. Max across
   footprint elements because an 18-hole facility often maps its main polygon plus a par-3
   loop; overstating only costs a warning, understating hides a clipped course. */
export function osmCourseHoleCountTag(payload) {
  let best = null;
  ((payload && payload.elements) || []).filter(isCourseFootprintElement).forEach(element => {
    const n = Number(element.tags && element.tags.holes);
    if (Number.isFinite(n) && n >= 1 && n <= 45) best = Math.max(best || 0, Math.round(n));
  });
  return best;
}

/* True when everything inside `frame` would already have been returned by `scope`'s query -
   i.e. requerying with the frame cannot add elements, so don't. */
export function scopeContainsFrame(scope, frame) {
  const f = normalizedOsmFrame(frame);
  if (!scope || !f) return false;
  if (scope.mode === "bbox" && scope.frame) {
    const s = scope.frame;
    return f.south >= s.south && f.west >= s.west && f.north <= s.north && f.east <= s.east;
  }
  if (scope.mode === "around" && scope.center && Number.isFinite(scope.radiusM)) {
    const corners = [
      { lat: f.south, lng: f.west }, { lat: f.south, lng: f.east },
      { lat: f.north, lng: f.west }, { lat: f.north, lng: f.east }
    ];
    return corners.every(corner => distance(scope.center, corner) <= scope.radiusM);
  }
  return false;
}

/* A square frame equivalent to what the scope already covered, so a wider retry can grow from
   it regardless of which mode the first pass used. */
export function osmScopeFrame(scope, center) {
  if (scope && scope.frame) return normalizedOsmFrame(scope.frame);
  const origin = toPlain((scope && scope.center) || center);
  if (!origin) return null;
  const r = Number(scope && scope.radiusM) || OSM_AUTOMAPPER_RADIUS_M;
  return expandOsmFrame({ south: origin.lat, west: origin.lng, north: origin.lat, east: origin.lng }, r);
}

/* How far the last query reached, as the radius-equivalent the multi-course widen compares
   against. Around mode answers with its radius. Bbox mode used to answer with nothing - the
   scope carries no radiusM - so `widestSeparationM > scope.radiusM` was `2326 > undefined`
   at Fancourt and the widen never ran on any site whose course polygon had already put the
   scope into bbox mode. Half the frame's shorter side: the distance from the middle the
   query is guaranteed to have covered in every direction. */
export function osmScopeReachM(scope, center) {
  if (scope && scope.mode === "around" && Number.isFinite(Number(scope.radiusM))) return Number(scope.radiusM);
  const frame = osmScopeFrame(scope, center);
  if (!frame) return OSM_AUTOMAPPER_RADIUS_M;
  const width = distance({ lat: frame.south, lng: frame.west }, { lat: frame.south, lng: frame.east });
  const height = distance({ lat: frame.south, lng: frame.west }, { lat: frame.north, lng: frame.west });
  return Math.round(Math.min(width, height) / 2);
}

export const OSM_WOOD_MAX_OUTLINE_M = 6000;

export function osmGuideQuery(scope) {
  const selector = (scope && scope.selector) || "";
  const selectors = [
    ["way", "golf", "course"], ["relation", "golf", "course"],
    ["way", "golf", "hole"], ["relation", "golf", "hole"],
    ["way", "golf", "green"], ["relation", "golf", "green"],
    ["way", "golf", "fairway"], ["relation", "golf", "fairway"],
    ["way", "golf", "tee"], ["relation", "golf", "tee"],
    ["way", "golf", "bunker"], ["relation", "golf", "bunker"],
    ["way", "golf", "water_hazard"], ["relation", "golf", "water_hazard"],
    ["way", "golf", "lateral_water_hazard"], ["relation", "golf", "lateral_water_hazard"],
    ["way", "natural", "water"], ["relation", "natural", "water"],
    /* Course footprint: many courses tag only leisure=golf_course, not golf=course. Needed by
       courseFootprintFrame so the worker can requery long thin courses by their real extent. */
    ["way", "leisure", "golf_course"], ["relation", "leisure", "golf_course"]
  ];
  /* Tree areas. Capped by outline length so a national forest the course sits inside is not
     downloaded whole - a wood that size is never one a hole plays past, and parseOsmSurfaces
     would throw it away anyway (too big, or holding the course). */
  const woods = [["natural", "wood"], ["landuse", "forest"]].map(([key, value]) =>
    "way" + selector + '["' + key + '"="' + value + '"](if:length()<' + OSM_WOOD_MAX_OUTLINE_M + ");"
    + "relation" + selector + '["' + key + '"="' + value + '"](if:length()<' + OSM_WOOD_MAX_OUTLINE_M * 2 + ");").join("");
  return "[out:json][timeout:18];(" + selectors.map(([type, key, value]) => type + selector + '["' + key + '"="' + value + '"];').join("") + woods + ");out geom tags;";
}

/* ---------- OSM payload parsing (gd-course-library-pin-lock.js:1966-2039) ------------------ */

export function osmGuideHoleRef(value) {
  const direct = validHoleNumber(value);
  if (direct) return direct;
  const match = String(value || "").match(/\d+/);
  return match ? validHoleNumber(match[0]) : null;
}

/* Two features carrying the same hole number, far enough apart to be different
   ground.
 *
 * Royal Auckland is 27 holes and published as 9. OSM numbers each loop of a
 * multi-nine site 1-9, and every layer below this keys holes by number
 * (holes[green.holeNumber]), so three loops collapse into nine holes. The
 * safety net that catches short scans is `expectedHoles && holesResolved <
 * expectedHoles`, and expectedHoles was null - no shared scorecard, no OSM
 * holes=N tag - so nine looked like a whole course and the job reported done.
 *
 * Distance is what separates a real second loop from OSM's habit of tagging one
 * hole as both a way and a relation: duplicate representations sit on top of
 * each other, a different loop does not. LOOP_SEPARATION_M is deliberately well
 * above a green's own span (OSM_AUTO_GREEN_MAX_SPAN_M is 145m) and well below
 * the distance between loops on any real site.
 *
 * A neighbouring course caught inside the query radius produces the same signal,
 * which is correct: both mean "do not publish this silently". The caller gets
 * the numbers and the separation so the difference is readable rather than
 * guessed at. */
export const LOOP_SEPARATION_M = 250;

function centroidOfPoints(points) {
  const list = (points || []).map(toPlain).filter(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (!list.length) return null;
  return {
    lat: list.reduce((sum, p) => sum + p.lat, 0) / list.length,
    lng: list.reduce((sum, p) => sum + p.lng, 0) / list.length
  };
}

export function detectHoleNumberCollision(payload) {
  const byNumber = new Map();
  ((payload && payload.elements) || []).forEach(element => {
    const tags = (element && element.tags) || {};
    if (String(tags.golf || "").toLowerCase() !== "hole") return;
    const number = osmGuideHoleRef(tags.ref || tags.name);
    if (!number) return;
    const centre = centroidOfPoints(osmGuidePointsFromElement(element));
    if (!centre) return;
    if (!byNumber.has(number)) byNumber.set(number, []);
    byNumber.get(number).push(centre);
  });

  let loops = 1;
  let widestSeparationM = 0;
  const collidedHoles = [];
  /* The clusters ARE the neighbouring courses. This used to compute them, take a
     count off them and drop them on the floor, which meant the one piece of
     evidence that could separate a 27-hole site from its neighbour never left
     the function - see separateLoops below, which is the whole reason to
     keep them. */
  const clusters = [];
  byNumber.forEach((centres, number) => {
    /* Single-link clustering: a centre joins the first cluster it is within
       LOOP_SEPARATION_M of, otherwise it starts one. */
    const numberClusters = [];
    centres.forEach(centre => {
      const near = numberClusters.find(cluster => cluster.some(member => distance(member, centre) <= LOOP_SEPARATION_M));
      if (near) near.push(centre); else numberClusters.push([centre]);
    });
    clusters.push({ number, centres: numberClusters.map(centroidOfPoints).filter(Boolean) });
    if (numberClusters.length < 2) return;
    collidedHoles.push(number);
    loops = Math.max(loops, numberClusters.length);
    numberClusters.forEach((a, i) => numberClusters.slice(i + 1).forEach(b => {
      widestSeparationM = Math.max(widestSeparationM, Math.round(distance(a[0], b[0])));
    }));
  });

  collidedHoles.sort((a, b) => a - b);
  return {
    multiLoop: loops > 1,
    loops,
    /* Per hole number, where in the world that number was found. One entry means
       one course; six means the query radius covered six. */
    clusters,
    collidedHoles,
    widestSeparationM,
    /* What the course would publish as if this went unnoticed - the count that
       made Royal Auckland look like a finished 9-hole course. */
    distinctNumbers: byNumber.size,
    holeFeatures: [...byNumber.values()].reduce((sum, list) => sum + list.length, 0)
  };
}

/* Telling one unnamed nine from another.
 *
 * "Course 1" and "Course 2" are honest - they say the site has more than one
 * course and that we do not know their names - but they are useless to a player
 * standing at the clubhouse deciding which one to open. Nothing about the label
 * connects to anything they can see.
 *
 * Two facts we already hold do connect. HOW LONG it plays, which the player
 * recognises from the card in their pocket, and WHERE ON THE PROPERTY it sits,
 * which they can see. "Course 2 - 3547m South" is a label somebody can act on;
 * "Course 2" is a placeholder they have to guess at.
 *
 * Both are free. The lengths are already summed to match cards to loops, and
 * the centres already exist because separation computed them.
 *
 * Replaced the moment a real name is found - see nameLoopsFromCards. This is
 * what an unnamed course is called in the meantime, not a naming scheme. */
export const COMPASS_POINTS = ["North", "North-East", "East", "South-East", "South", "South-West", "West", "North-West"];

/* Which way `to` lies from `from`, as one of eight compass points. Eight rather
   than four: a three-nine site puts its loops closer together than 90 degrees
   apart, and "South-East" separates two of them where "South" would not. */
export function compassPointFrom(from, to) {
  const a = toPlain(from), b = toPlain(to);
  if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(b.lat)) return "";
  const dLat = b.lat - a.lat;
  const dLng = (b.lng - a.lng) * Math.cos((a.lat * Math.PI) / 180);
  if (!dLat && !dLng) return "";
  const deg = (Math.atan2(dLng, dLat) * 180) / Math.PI;
  return COMPASS_POINTS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

/* "3547m South", "3547m", "South", or "" - whatever is actually known.
 *
 * Never invents the half it does not have. A loop with no measurable holes and
 * no separable position gets a bare "Course 2", which is worse than a full
 * label but better than a confident wrong one. */
export function loopDescriptor(facts) {
  const totalM = Math.round(Number(facts && facts.totalM) || 0);
  const compass = String((facts && facts.compass) || "");
  return [totalM > 0 ? totalM + "m" : "", compass].filter(Boolean).join(" ");
}

/* The provisional name for a loop nothing has named yet. */
export function provisionalLoopName(index, facts) {
  const descriptor = loopDescriptor(facts);
  return "Course " + (Number(index) + 1) + (descriptor ? " - " + descriptor : "");
}

/* More ground than the scorecard describes.
 *
 * detectHoleNumberCollision only sees a multi-course site when OSM NUMBERS the
 * holes - the whole signal is one number turning up twice. A site OSM has not
 * numbered at all is invisible to it, and that is precisely the site the Native
 * Resolver exists for, so the two never met.
 *
 * Howeston is three nines. OSM gave it 27 tees, 27 fairways, 30 greens and zero
 * numbered holes, so the collision detector said "one course" and the resolver
 * was handed a 9-hole GolfPass card as expectedHoles. It matched nine of the
 * twenty-seven candidates, reported status "resolved" at 0.87 confidence, and
 * published a third of the facility as a finished 9-hole course with
 * fit.trusted true. The one thing that knew something was wrong was a warning
 * nobody was reading: "map geometry scale differs from scorecard by -36%".
 *
 * The missing rule is small and general: A SCORECARD DESCRIBES A COURSE, NOT A
 * FACILITY. Finding one 9-hole card is not evidence that the site has nine
 * holes - only that one of its courses does. When the ground carries
 * substantially more hole candidates than the card accounts for, the card is
 * the incomplete half of the comparison, and the site is a multi-loop facility
 * that has to go through the multi-course machinery rather than round it.
 *
 * Two gates, because either alone misfires. A RATIO, so a 9-hole card against
 * 27 candidates reads as three loops while an 18 against 20 (a couple of
 * practice greens caught in the sweep) does not. And an ABSOLUTE floor of
 * roughly another nine, because ratios are unstable on small numbers - 6
 * candidates against a 4-hole read is 1.5x and means nothing. */
export const MULTI_LOOP_GEOMETRY_RATIO = 1.5;
export const MULTI_LOOP_MIN_EXTRA_HOLES = 7;

export function detectUnnumberedMultiLoop(input) {
  const candidateCount = Math.max(0, Number(input && input.candidateCount) || 0);
  const cardHoles = Math.max(0, Number(input && input.cardHoles) || 0);
  const base = { multiLoop: false, loops: 1, candidateCount, cardHoles, ratio: null };
  /* No card means no comparison to make. That is not "one course" - it is a
     question this rule cannot answer, and saying so keeps it out of the way of
     the paths that can. */
  if (!cardHoles) return Object.assign(base, { reason: "no-card-hole-count" });
  if (!candidateCount) return Object.assign(base, { reason: "no-hole-candidates" });
  const ratio = candidateCount / cardHoles;
  if (ratio < MULTI_LOOP_GEOMETRY_RATIO || candidateCount - cardHoles < MULTI_LOOP_MIN_EXTRA_HOLES) {
    return Object.assign(base, { ratio, reason: "geometry-matches-card" });
  }
  /* Rounded, not floored: 27 candidates against a 9-hole card is three loops,
     and 27 against an 18 is two (an 18 and a nine) rather than one-and-a-half.
     This is how many CARDS to go looking for, so an over-count costs a wasted
     fetch and an under-count costs a whole course. */
  return { multiLoop: true, loops: Math.max(2, Math.round(ratio)), candidateCount, cardHoles, ratio, reason: null };
}

/* Separate a multi-course site into its courses - all of them.
 *
 * This replaces selectNearestLoop, which kept one course and discarded the rest.
 * That was the wrong shape twice over.
 *
 * It was wrong in method: it clustered EACH HOLE NUMBER independently and kept,
 * per number, whichever cluster sat nearest the pin. Nothing constrained the
 * kept numbers to come from the same course. At St Andrews, where the six
 * courses are far apart, per-number-nearest happens to agree every time and it
 * looked like loop selection. At Te Arai Links, whose two 18s run alongside each
 * other through the same dunes, "nearest" flipped between courses hole by hole
 * and produced a set belonging to neither: holes 9, 10, 12, 13, 16, 17.
 *
 * It was wrong in intent: a second course on the site is not ambiguity to be
 * resolved, it is a course to be published. The player picks which one they are
 * playing from the course list, the same way they pick between two clubs, and
 * /api/courses-near already lists them that way. The pin screen stays for what
 * it is for - the mapped location being wrong.
 *
 * Two ways to separate, in order of preference:
 *
 *   containment  The payload already carries the site's golf=course /
 *                leisure=golf_course polygons with full geometry and names,
 *                requested by osmGuideQuery and until now reduced to a bounding
 *                box. Assigning each hole to the polygon that contains it is
 *                exact, deterministic, and free - and the polygon's name tag is
 *                the course's real name rather than one we invented.
 *
 *   routing      When the site maps one polygon over both courses. Proximity
 *                clustering is NOT the fallback: single-link chaining merges two
 *                interleaved courses the moment any hole of one sits within
 *                LOOP_SEPARATION_M of any hole of the other, which at a links
 *                site is immediate - that is the failure being replaced, not a
 *                fix for it. Instead this uses the property that makes a loop a
 *                loop: hole N ends where hole N+1 begins. Walking 1..18 and
 *                keeping each chain on its own nearest continuation separates
 *                courses that are physically interleaved, because adjacency
 *                along the routing is what distinguishes them, not adjacency in
 *                space.
 *
 * Every hole-scoped feature is partitioned, not just the numbered hole ways.
 * selectNearestLoop filtered golf=hole and passed everything else through
 * untouched, so its "tightened" Te Arai payload held 16 mixed guides competing
 * against all 32 greens from BOTH courses - twice the candidates each guide
 * should have seen, half of them on the wrong course. That is why 16 guides
 * resolved to 6 holes. Fix the clustering but keep the passthrough and the same
 * failure returns wearing better code. */

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i].lat, xi = ring[i].lng, yj = ring[j].lat, xj = ring[j].lng;
    if ((yi > point.lat) !== (yj > point.lat)
      && point.lng < ((xj - xi) * (point.lat - yi)) / ((yj - yi) || Number.EPSILON) + xi) inside = !inside;
  }
  return inside;
}

/* The site's course polygons, each with the name that should become the course's
   own. Rings under 4 points are tagging noise and cannot contain anything. */
export function coursePolygonsFrom(payload) {
  return ((payload && payload.elements) || [])
    .filter(element => {
      const t = (element && element.tags) || {};
      return String(t.golf || "").toLowerCase() === "course" || String(t.leisure || "").toLowerCase() === "golf_course";
    })
    .map(element => ({
      ref: String(element.type || "way") + "/" + String(element.id || ""),
      name: String((element.tags && element.tags.name) || "").trim(),
      holesTag: Number(element.tags && element.tags.holes) || null,
      /* Who runs it. Two outlines with different websites or operators are two clubs,
         whatever their names share - see markNeighbouringClubs. */
      owner: ownerOf(element.tags),
      ring: osmGuidePointsFromElement(element)
    }))
    .filter(polygon => polygon.ring.length >= 4);
}

function holeFeatures(payload) {
  const list = [];
  ((payload && payload.elements) || []).forEach(element => {
    const tags = (element && element.tags) || {};
    if (String(tags.golf || "").toLowerCase() !== "hole") return;
    const number = osmGuideHoleRef(tags.ref || tags.name);
    const centre = centroidOfPoints(osmGuidePointsFromElement(element));
    if (!number || !centre) return;
    const points = osmGuidePointsFromElement(element);
    list.push({ element, number, centre, start: points[0] || centre, end: points[points.length - 1] || centre });
  });
  return list;
}

/* ---------- containment (why: Fancourt, 2026-09-16) ---------------------------------------
 *
 * Fancourt's OSM has a facility outline ("Fancourt Golf Estate") with a course outline
 * ("The Links at Fancourt") drawn INSIDE it, and a second 18 drawn outside both. The old
 * rule - smallest containing polygon wins, keep going if 60% of holes landed somewhere -
 * did three wrong things at once:
 *
 *   the facility outline became a "course" holding the three holes that spill past the
 *   Links boundary, so one 18 published as a 3 and a 14;
 *   every hole outside both polygons was dropped from every loop, silently, because
 *   17 of 24 cleared the floor;
 *   the dropped holes then came back as SUPPORTING elements (see
 *   partitionSupportingElements), so a loop's payload carried another course's hole 1
 *   and holeGapFrames anchored a gap on two holes 1.6km apart.
 *
 * Three rules replace it. An outline that contains another outline is the facility, not
 * a course. A hole inside no course outline is still a hole: it joins the outline whose
 * routing it continues (hole 18 starts where hole 17 ends), or forms a loop of its own
 * with the other unclaimed holes. And when a facility outline exists, a course outline
 * wholly outside it is a different club that a wide sweep dragged in - kept apart, never
 * dropped, never published as a sibling. */

/* A tee within this of the previous green is the next hole on the same course. Measured
   across all three courses at Fancourt the longest green-to-next-tee walk is 216m and the
   shortest cross-course one is 859m; interleaved sites are closer than that, but a hole
   only reaches this test when it sits outside every course outline, and a site with no
   outlines never runs it at all. */
export const HOLE_CONTINUITY_M = 250;

function polygonContainsPolygon(outer, inner) {
  if (outer === inner) return false;
  const centre = centroidOfPoints(inner.ring);
  return !!centre && spanOfRing(inner.ring) < spanOfRing(outer.ring) && pointInRing(centre, outer.ring);
}

/* Does this outline hold the same hole number twice, on different ground? A course has
   one hole 7; a site has one per course. The separation distance keeps a hole that OSM
   happens to have drawn twice from turning its own course outline into a facility. */
function outlineHoldsRepeatedNumbers(polygon, features) {
  const seen = new Map();
  return (features || []).some(feature => {
    if (!pointInRing(feature.centre, polygon.ring)) return false;
    const earlier = seen.get(feature.number) || [];
    if (earlier.some(centre => distance(centre, feature.centre) > LOOP_SEPARATION_M)) return true;
    seen.set(feature.number, earlier.concat([feature.centre]));
    return false;
  });
}

/* Course outlines and facility outlines, told apart by what they contain. An outline
   with another outline inside it is the site. A LONE outline with the same hole number
   twice inside it is also the site - one polygon drawn over every course, the Millbrook
   and Te Arai shape. A lone outline around one course's worth of holes is that course's
   outline whatever tag it carries; OSM draws single-course sites with leisure=golf_course
   and no golf=course at all. The repetition test is only asked of a lone outline on
   purpose: two course outlines on an interleaved site overlap at their edges and each
   catches a few of the other's holes, which is not evidence that either is the site. */
export function classifyCoursePolygons(polygons, features) {
  const list = polygons || [];
  const facilities = list.filter(polygon => list.some(other => polygonContainsPolygon(polygon, other))
    || (list.length === 1 && outlineHoldsRepeatedNumbers(polygon, features)));
  return { courses: list.filter(polygon => !facilities.includes(polygon)), facilities };
}

function polygonTouchesAnyFacility(polygon, facilities) {
  return facilities.some(facility => polygon.ring.some(point => pointInRing(point, facility.ring)));
}

/* Does this hole continue the bucket's routing - start at the previous hole's green, or
   finish at the next hole's tee? Hole 1 follows the highest hole the bucket holds, since
   18's green and 1's tee share the clubhouse. */
function continuesRouting(bucket, feature) {
  const numbers = bucket.features.map(entry => entry.number);
  if (numbers.includes(feature.number)) return false;
  const prevNumber = feature.number > 1 ? feature.number - 1 : Math.max(...numbers);
  const prev = bucket.features.find(entry => entry.number === prevNumber);
  const next = bucket.features.find(entry => entry.number === feature.number + 1);
  return !!((prev && distance(prev.end, feature.start) <= HOLE_CONTINUITY_M)
    || (next && distance(feature.end, next.start) <= HOLE_CONTINUITY_M));
}

/* Holes that spill past their course outline join it by continuity. Iterates because a
   spill of three (Fancourt's 18, 1 and 2) attaches one hole at a time: 18 off 17, then 1
   off 18, then 2 off 1. A hole that could continue two buckets is left alone rather than
   guessed. Returns what is still unplaced. */
function attachSpills(buckets, unplaced) {
  let pending = unplaced.slice();
  let changed = true;
  while (changed && pending.length) {
    changed = false;
    pending = pending.filter(feature => {
      const homes = buckets.filter(bucket => continuesRouting(bucket, feature));
      if (homes.length !== 1) return true;
      homes[0].features.push(feature);
      changed = true;
      return false;
    });
  }
  return pending;
}

/* Unclaimed holes are a course nobody drew an outline for - Fancourt's east 18 - so they
   route among themselves. One chain per repeated number; a set with no repeats is one loop. */
function routeUnclaimed(features) {
  if (!features.length) return [];
  const multiplicity = new Map();
  features.forEach(feature => multiplicity.set(feature.number, (multiplicity.get(feature.number) || 0) + 1));
  const loopCount = Math.max(...multiplicity.values());
  return assignByRouting(features, loopCount)
    || [{ name: "", osmRef: "", holesTag: null, features: features.slice(), method: "routing" }];
}

/* ---------- neighbouring clubs, whatever separated the loops (Fancourt, Poppy Hills) -------
 *
 * A sweep wide enough to finish a multi-course site also catches the clubs next door.
 * Fancourt's 2026-10-01 rescan put George Golf Club up as "Course 3"; Poppy Hills'
 * 2026-10-02 scan published Spyglass Hill, Cypress Point, The Hay, Pebble Beach, Spanish
 * Bay and Pacific Grove as six "Poppy Hills" courses, under poppy-hills-* ids.
 *
 * A loop other than the pinned one is a NEIGHBOUR - its own course, never this
 * facility's sibling - when any of these holds:
 *
 *   the player selected a single course. "Poppy Hills Golf Course" and "Pebble Beach
 *     Golf Links" name one course, not a resort, so nothing else on the ground is theirs;
 *   its centre sits more than SIBLING_REACH_M from the pin and no facility outline
 *     holds it. Measured across every multi-course site scanned so far, real siblings
 *     sat at most ~1.7km from the pin (Te Arai North 1711m) and the nearest unnamed
 *     neighbour 2.2km (Pebble Beach from Poppy Hills);
 *   its outline is run by a different owner (website / operator / brand) than the
 *     pinned course's outline;
 *   its outline carries a full club or course name - "George Golf Club", "Monterey
 *     Peninsula Country Club", "Spyglass Hill Golf Course", "Pacific Grove Golf Links" -
 *     and shares no distinctive word with the facility the player searched for.
 *
 * An outline named only as a course label ("Coronet 18", "The Hills", "North Course")
 * is never ruled out by its name: resort courses are routinely outlined under their own
 * name alone. Being a neighbour is not being dropped - a named, complete neighbour is
 * published as a course of its own by the worker, under its own name and facility. */
const CLUB_DESIGNATOR = /\b(golf\s+club|country\s+club|golf\s+&\s+country\s+club|golf\s+course|golf\s+links|g\.?\s?c\.?|c\.?\s?c\.?)\b/i;
const GENERIC_NAME_WORDS = new Set(["golf", "club", "country", "course", "courses", "links", "the", "and", "resort", "estate", "at", "of", "de", "la", "le", "gc", "cc", "international", "national", "championship", "north", "south", "east", "west", "par", "holes", "hole"]);
const OWNED_MAJORITY = 0.6;

/* How far from the pin a course's centre may sit and still be taken as this facility's
   own without an outline saying so. See the header above for where 2000m comes from. */
export const SIBLING_REACH_M = 2000;

/* How far the multi-course widen may reach from the pin: a sibling's centre at the reach
   limit, plus the ~1km an 18-hole routing spreads around its own centre. Anything
   further out cannot hold a sibling, so fetching it only drags in other clubs. */
export const SIBLING_SWEEP_M = SIBLING_REACH_M + 1000;

/* A name that ends in a single-course designator names one course, not a facility:
   "Poppy Hills Golf Course", "Pebble Beach Golf Links". "Golf Club", "Resort", "Estate"
   and "Country Club" can all hold several courses and are left alone. */
const SINGLE_COURSE_NAME = /\bgolf\s+(course|links)\s*$/i;

export function namesSingleCourse(name) {
  return SINGLE_COURSE_NAME.test(String(name || "").replace(/\s+/g, " ").trim());
}

function ownerOf(tags) {
  const t = tags || {};
  const site = String(t.website || t["contact:website"] || "").toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  return site || String(t.operator || t.brand || "").trim().toLowerCase();
}

function distinctiveWords(name) {
  return new Set(String(name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .split(/[^a-z0-9]+/).filter(word => word.length >= 3 && !GENERIC_NAME_WORDS.has(word)));
}

function outlineHolding(group, polygons) {
  const named = (polygons || []).filter(polygon => polygon.name || polygon.owner);
  let best = null;
  named.forEach(polygon => {
    const inside = group.features.filter(feature => pointInRing(feature.centre, polygon.ring)).length;
    if (inside / Math.max(1, group.features.length) >= OWNED_MAJORITY && (!best || inside > best.inside)) best = { polygon, inside };
  });
  return best ? best.polygon : null;
}

function insideAnyOutline(group, outlines) {
  return outlines.some(outline => group.features.filter(feature => pointInRing(feature.centre, outline.ring)).length
    / Math.max(1, group.features.length) >= OWNED_MAJORITY);
}

/* Why this loop is a neighbour, or null when it is the facility's own. Outline evidence
   first - an owner or a name says more than a distance - and the reach last. An outline
   that shares the facility's own distinctive word ("The Links at Fancourt") is the
   facility's whatever its distance. */
function neighbourReason(group, ctx) {
  if (ctx.singleCourse) return "selected-listing-is-one-course";
  const outline = outlineHolding(group, ctx.polygons);
  const foreignOutline = outline && outline !== ctx.pinnedOutline
    && !ctx.pinned.features.some(feature => pointInRing(feature.centre, outline.ring));
  if (foreignOutline) {
    if (outline.owner && ctx.pinnedOutline && ctx.pinnedOutline.owner && outline.owner !== ctx.pinnedOutline.owner) {
      return "course-outline-run-by-another-owner";
    }
    const words = distinctiveWords(outline.name);
    const sharesName = [...words].some(word => ctx.facilityWords.has(word));
    if (sharesName) return null;
    if (CLUB_DESIGNATOR.test(outline.name) && ctx.facilityWords.size > 0 && words.size > 0) return "course-outline-names-another-club";
  }
  const awayM = ctx.centre ? distance(ctx.centre, ctx.centreOf(group)) : 0;
  if (awayM > SIBLING_REACH_M && !insideAnyOutline(group, ctx.facilityOutlines)) return "beyond-facility-reach";
  return null;
}

/* selectedName is the whole name the player picked; facilityName its facility half. The
   single-course test reads the whole name, so "X Golf Course - North" (one course OF a
   facility) is not mistaken for "X Golf Course" (a facility that is one course). */
export function markNeighbouringClubs(groups, polygons, centre, facilityName, selectedName) {
  const live = (groups || []).filter(group => !group.foreign);
  if (live.length < 2) return groups;
  const centreOf = group => centroidOfPoints(group.features.map(feature => feature.centre));
  const pinned = centre
    ? live.slice().sort((a, b) => distance(centre, centreOf(a)) - distance(centre, centreOf(b)))[0]
    : live[0];
  const pinnedOutline = outlineHolding(pinned, polygons);
  const ctx = {
    centre,
    centreOf,
    polygons,
    pinned,
    pinnedOutline,
    singleCourse: namesSingleCourse(selectedName == null ? facilityName : selectedName),
    facilityWords: distinctiveWords([facilityName, pinnedOutline && pinnedOutline.name].filter(Boolean).join(" ")),
    facilityOutlines: classifyCoursePolygons(polygons, groups.flatMap(group => group.features)).facilities
  };
  live.forEach(group => {
    if (group === pinned) return;
    const reason = neighbourReason(group, ctx);
    if (!reason) return;
    group.foreign = true;
    group.foreignReason = reason;
    const outline = outlineHolding(group, polygons);
    if (outline && !group.name) group.name = outline.name;
    if (outline && !group.osmRef) group.osmRef = outline.ref;
  });
  return groups;
}

/* ---------- one course, outlined in pieces (The Club at Mapledurham) -----------------------
 *
 * OSM sometimes draws a single course's boundary as several golf_course polygons - a field
 * added later, a strip across a lane. Containment then hands back each piece as a course:
 * Mapledurham's 18 came out as 10 + 7 + 1, each too small to publish, and the run failed
 * with the whole course in hand. Two real courses always repeat hole numbers (both start
 * at 1), so the site's own pieces whose numbers never repeat are one course. Capped at 18
 * so a facility numbered 1-27 across three outlines keeps its nines. Joined in place. */
function joinOutlinePieces(groups) {
  const own = groups.filter(group => !group.foreign);
  if (own.length < 2) return groups;
  const numbers = new Set();
  for (const group of own) {
    for (const feature of group.features) {
      if (numbers.has(feature.number)) return groups;
      numbers.add(feature.number);
    }
  }
  if (numbers.size > 18) return groups;
  const largest = own.slice().sort((a, b) => b.features.length - a.features.length)[0];
  const joined = Object.assign({}, largest, {
    name: largest.name || (own.find(group => group.name) || {}).name || "",
    features: own.flatMap(group => group.features)
  });
  const firstAt = groups.indexOf(own[0]);
  for (let i = groups.length - 1; i >= 0; i--) if (!groups[i].foreign) groups.splice(i, 1);
  groups.splice(firstAt, 0, joined);
  return groups;
}

function assignByContainment(features, polygons) {
  const { courses, facilities } = classifyCoursePolygons(polygons, features);
  if (!courses.length) return null;
  /* Smallest containing course outline wins: a par-3 loop drawn inside the main course's
     outline is the tighter of the two. */
  const areaRank = courses.map(polygon => ({ polygon, span: spanOfRing(polygon.ring) })).sort((a, b) => a.span - b.span);
  const buckets = new Map();
  const unplaced = [];
  features.forEach(feature => {
    const hit = areaRank.find(entry => pointInRing(feature.centre, entry.polygon.ring));
    if (!hit) { unplaced.push(feature); return; }
    if (!buckets.has(hit.polygon.ref)) buckets.set(hit.polygon.ref, { polygon: hit.polygon, features: [] });
    buckets.get(hit.polygon.ref).features.push(feature);
  });
  if (!buckets.size) return null;
  const groups = [...buckets.values()].map(bucket => ({
    name: bucket.polygon.name,
    osmRef: bucket.polygon.ref,
    holesTag: bucket.polygon.holesTag,
    features: bucket.features,
    method: "containment",
    /* Only judged when OSM has drawn the facility: with no outline to be outside of,
       every course outline is taken to belong to the site, as before. */
    foreign: facilities.length > 0 && !polygonTouchesAnyFacility(bucket.polygon, facilities)
  }));
  const stillUnplaced = attachSpills(groups.filter(group => !group.foreign), unplaced);
  const all = groups.concat(routeUnclaimed(stillUnplaced));
  /* One course on this site's own ground is not a separation, whatever else the sweep
     caught - the single-course path keeps its neighbour filter for that. */
  if (all.filter(group => !group.foreign).length < 2) return null;
  return all;
}

function spanOfRing(ring) {
  let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
  ring.forEach(p => {
    south = Math.min(south, p.lat); north = Math.max(north, p.lat);
    west = Math.min(west, p.lng); east = Math.max(east, p.lng);
  });
  return distance({ lat: south, lng: west }, { lat: north, lng: east });
}

function assignByRouting(features, loopCount) {
  if (loopCount < 2) return null;
  const byNumber = new Map();
  features.forEach(feature => {
    if (!byNumber.has(feature.number)) byNumber.set(feature.number, []);
    byNumber.get(feature.number).push(feature);
  });
  const numbers = [...byNumber.keys()].sort((a, b) => a - b);
  const seedNumber = numbers.find(number => byNumber.get(number).length >= loopCount);
  if (!seedNumber) return null;

  const chains = byNumber.get(seedNumber).slice(0, loopCount).map(feature => ({ features: [feature], tip: feature.end }));
  numbers.forEach(number => {
    if (number === seedNumber) return;
    const candidates = byNumber.get(number).slice();
    /* Best pair first, so a hole that is unambiguous for one chain is not stolen
       by another chain that merely reached it earlier in the loop. */
    const pairs = [];
    chains.forEach((chain, ci) => candidates.forEach((candidate, qi) => {
      pairs.push({ ci, qi, away: distance(chain.tip, candidate.start) });
    }));
    pairs.sort((a, b) => a.away - b.away);
    const usedChain = new Set(), usedCandidate = new Set();
    pairs.forEach(pair => {
      if (usedChain.has(pair.ci) || usedCandidate.has(pair.qi)) return;
      usedChain.add(pair.ci); usedCandidate.add(pair.qi);
      chains[pair.ci].features.push(candidates[pair.qi]);
      chains[pair.ci].tip = candidates[pair.qi].end;
    });
  });
  return chains.map(chain => ({ name: "", osmRef: "", holesTag: null, features: chain.features, method: "routing" }));
}

/* Non-hole features - greens, tees, fairways, bunkers, water - go to the loop
   whose holes they actually sit among. Anything that belongs to no loop in
   particular (the clubhouse pond, a practice green) is copied to every loop:
   resolveCourseGeometry already discards greens it cannot pair, and withholding
   a green from the loop that needed it is the more expensive mistake. */
function partitionSupportingElements(payload, loops) {
  const holeElements = new Set();
  loops.forEach(loop => loop.features.forEach(feature => holeElements.add(feature.element)));
  const shared = [];
  const buckets = loops.map(() => []);
  ((payload && payload.elements) || []).forEach(element => {
    if (holeElements.has(element)) return;
    const tags = (element && element.tags) || {};
    const golf = String(tags.golf || "").toLowerCase();
    /* A numbered hole is never a supporting element. Every one of them was either placed
       in a loop above or deliberately kept out; letting a leftover ride along as if it
       were a bunker is how a loop's payload came to carry another course's hole 1 and
       holeGapFrames anchored on it. Unnumbered hole ways still travel with the nearest
       loop - they are exactly what an elimination fill needs to find. */
    if (golf === "hole" && osmGuideHoleRef(tags.ref || tags.name)) return;
    const isCourseOutline = golf === "course" || String(tags.leisure || "").toLowerCase() === "golf_course";
    const centre = centroidOfPoints(osmGuidePointsFromElement(element));
    if (isCourseOutline || !centre) { shared.push(element); return; }
    let best = null;
    loops.forEach((loop, index) => {
      loop.features.forEach(feature => {
        const away = distance(centre, feature.centre);
        if (!best || away < best.away) best = { away, index };
      });
    });
    if (!best) { shared.push(element); return; }
    buckets[best.index].push(element);
  });
  return { buckets, shared };
}

/* Hole numbers running 1..n with nothing missing. A loop that fails this was not
   separated correctly, and publishing it is how Te Arai shipped six holes as a
   finished course. Checked here rather than at the caller so no path can skip it. */
export function loopIsContiguous(numbers) {
  const unique = [...new Set(numbers)].sort((a, b) => a - b);
  if (!unique.length) return false;
  return unique[0] === 1 && unique[unique.length - 1] === unique.length;
}

/* A golf routing is continuous: hole N ends where hole N+1 begins. So a course that
 * resolved 1,2,3,4,_,6..18 tells you exactly where the missing hole is - between
 * hole 4's green and hole 6's tee - without knowing anything else about the site.
 *
 * That is the cheap answer to a clipped scan. Rather than growing the whole site
 * frame and re-fetching thousands of elements on the chance of catching one hole,
 * ask a small box around the two anchors either side of the gap. At Te Arai those
 * anchors are 95m apart, so a 500m pad is a ~1.1km box in one corner of the site -
 * and hole 5 cannot be anywhere else, because it has to start near one anchor and
 * finish near the other.
 *
 * Only small gaps. A course missing five holes in a row was not clipped, it was
 * separated wrongly, and a small box will not fix that - widening the search there
 * would just hide a separation bug behind more data. */
export const HOLE_GAP_PAD_M = 500;

export function holeGapFrames(payload, opts = {}) {
  const padM = Number(opts.padM) || HOLE_GAP_PAD_M;
  const maxGapHoles = Number(opts.maxGapHoles) || 2;
  const maxFrames = Number(opts.maxFrames) || 3;

  const byNumber = new Map();
  holeFeatures(payload).forEach(feature => {
    if (!byNumber.has(feature.number)) byNumber.set(feature.number, feature);
  });
  const numbers = [...byNumber.keys()].sort((a, b) => a - b);
  if (!numbers.length) return [];
  const highest = numbers[numbers.length - 1];

  /* Runs of consecutive missing numbers below the highest one seen. A trailing
     shortfall (1..17 of an 18) is invisible here by design - nothing in the
     geometry says a hole 18 should exist, that is expectedHoles' job. */
  const gaps = [];
  let run = null;
  for (let number = 1; number <= highest; number += 1) {
    if (byNumber.has(number)) { if (run) { gaps.push(run); run = null; } continue; }
    if (!run) run = [];
    run.push(number);
  }
  if (run) gaps.push(run);

  return gaps
    .filter(gap => gap.length <= maxGapHoles)
    .map(gap => {
      /* Hole ways are drawn tee -> green, which assignByRouting already relies on:
         the hole before the gap ends at its green, the hole after starts at its tee. */
      const before = byNumber.get(gap[0] - 1);
      const after = byNumber.get(gap[gap.length - 1] + 1);
      const anchors = [];
      if (before && before.end) anchors.push(before.end);
      if (after && after.start) anchors.push(after.start);
      if (!anchors.length) return null;
      const frame = expandOsmFrame(frameOfPoints(anchors), padM);
      return frame ? { missing: gap.slice(), anchors: anchors.map(toPlain), frame } : null;
    })
    .filter(Boolean)
    .slice(0, maxFrames);
}

export function separateLoops(payload, centre, options) {
  const features = holeFeatures(payload);
  if (!features.length) return null;

  const collision = detectHoleNumberCollision(payload);
  const polygons = coursePolygonsFrom(payload);
  const groups = assignByContainment(features, polygons) || assignByRouting(features, collision.loops);
  if (!groups || groups.length < 2) return null;
  markNeighbouringClubs(groups, polygons, centre, (options && options.facilityName) || "", options && options.selectedName);
  joinOutlinePieces(groups);

  const { buckets, shared } = partitionSupportingElements(payload, groups);

  const everyLoop = groups.map((group, index) => {
    const numbers = group.features.map(feature => feature.number);
    const loopCentre = centroidOfPoints(group.features.map(feature => feature.centre));
    return {
      name: group.name,
      osmRef: group.osmRef,
      holesTag: group.holesTag,
      method: group.method,
      foreign: !!group.foreign,
      foreignReason: group.foreignReason || null,
      centre: loopCentre,
      holeNumbers: [...new Set(numbers)].sort((a, b) => a - b),
      /* The PHYSICAL holes, number and OSM element together. holeNumbers cannot
         answer "did two of these courses claim the same ground" - both courses
         on a 36-hole site are numbered 1..18 - so the element ref travels with
         the number for anything that has to allocate ground rather than count
         it. See gd-inferred-course-claims-core.mjs. */
      holeFeatures: group.features.map(feature => ({
        number: feature.number,
        id: String(feature.element && feature.element.type || "way") + "/" + String(feature.element && feature.element.id)
      })),
      contiguous: loopIsContiguous(numbers),
      awayFromPinM: loopCentre && centre ? Math.round(distance(centre, loopCentre)) : null,
      payload: Object.assign({}, payload, {
        elements: group.features.map(feature => feature.element).concat(buckets[index], shared)
      })
    };
  });

  /* A neighbouring club, caught by a wide sweep, is separated from the site's own courses
     so its greens and holes cannot be paired with theirs - and then kept OFF the list,
     because publishing George Golf Club as Fancourt's Course 3 is the failure this exists
     to prevent. It travels on `neighbours` instead, whole, so the worker can publish it
     as a course of its own; `excluded` is the job-row summary of the same set.
   *
   * One course of this site's own plus neighbours is still a result: it is how a
   * single-course selection (Poppy Hills) tells the worker which loop is the player's
   * and which belong to the clubs around it. */
  const loops = everyLoop.filter(loop => !loop.foreign);
  const neighbours = everyLoop.filter(loop => loop.foreign);
  if (!loops.length || (loops.length < 2 && !neighbours.length)) return null;
  loops.neighbours = neighbours;
  loops.excluded = neighbours.map(loop => ({
    name: loop.name || null,
    osmRef: loop.osmRef || null,
    holes: loop.holeNumbers.length,
    contiguous: loop.contiguous,
    awayFromPinM: loop.awayFromPinM,
    reason: loop.foreignReason || "course-outline-outside-facility-outline"
  }));
  /* Nearest first, so a caller that has to pick one - the row the job was
     enqueued against - picks the one the player pinned. */
  loops.sort((a, b) => (a.awayFromPinM ?? Infinity) - (b.awayFromPinM ?? Infinity));
  loops.forEach((loop, index) => { loop.index = index; });
  return loops;
}

export function osmGuidePointsFromElement(element) {
  const pts = [];
  const add = p => {
    const lat = Number(p && p.lat), lng = Number(p && (p.lng ?? p.lon));
    if (Number.isFinite(lat) && Number.isFinite(lng)) pts.push({ lat, lng });
  };
  if (Array.isArray(element && element.geometry)) element.geometry.forEach(add);
  if (Array.isArray(element && element.members)) {
    element.members.forEach(member => {
      if (Array.isArray(member && member.geometry)) member.geometry.forEach(add);
    });
  }
  return pts;
}

/* An OSM area's real outlines. A plain way is one closed ring. A multipolygon relation is not:
   its outline is usually split across several member ways that join end to end (a fairway
   traced in three pieces, a lake in thirty), with holes cut out as "inner" members. Reading
   each member way as its own shape - which is what every parser here used to do - turns one
   fairway into a handful of open slivers that fail every size check, so relation-mapped
   fairways never reached a course at all (Hammock Dunes and Colts Neck: 18 OSM fairways
   each, none saved) and one water relation came back as 31 fragments.

   Pieces are joined on shared end points, flipping a piece when it runs the other way, until
   the ring closes. A ring that never closes (a piece missing from the download) is kept as
   drawn - an almost-closed outline is still the right area. */
const RING_JOIN_TOLERANCE_DEG = 1e-7;

function samePoint(a, b) {
  return Math.abs(a.lat - b.lat) < RING_JOIN_TOLERANCE_DEG && Math.abs(a.lng - b.lng) < RING_JOIN_TOLERANCE_DEG;
}

function joinRingPieces(pieces) {
  const left = pieces.filter(piece => piece.length >= 2).map(piece => piece.slice());
  const rings = [];
  while (left.length) {
    const ring = left.shift();
    let grew = true;
    while (grew && !(ring.length > 3 && samePoint(ring[0], ring[ring.length - 1]))) {
      grew = false;
      const end = ring[ring.length - 1];
      for (let i = 0; i < left.length; i++) {
        const piece = left[i];
        if (samePoint(piece[0], end)) ring.push(...piece.slice(1));
        else if (samePoint(piece[piece.length - 1], end)) ring.push(...piece.slice(0, -1).reverse());
        else continue;
        left.splice(i, 1);
        grew = true;
        break;
      }
    }
    const clean = cleanOsmShape(ring);
    if (clean) rings.push(clean);
  }
  return rings;
}

export function osmAreaRings(element) {
  const members = (element && element.members) || [];
  if (!members.length) {
    const single = cleanOsmShape(osmGuidePointsFromElement(element));
    return { outers: single ? [single] : [], inners: [] };
  }
  const piecesFor = inner => members
    .filter(member => member && Array.isArray(member.geometry) && (String(member.role || "") === "inner") === inner)
    .map(member => member.geometry.map(p => ({ lat: Number(p && p.lat), lng: Number(p && (p.lng ?? p.lon)) }))
      .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng)));
  return { outers: joinRingPieces(piecesFor(false)), inners: joinRingPieces(piecesFor(true)) };
}

/* The single outline that stands for an area: its largest outer ring. */
export function osmMainOutline(element) {
  const { outers } = osmAreaRings(element);
  return outers.map(ring => ({ ring, span: greenShapeSpan(ring) })).sort((a, b) => b.span - a.span)[0]?.ring || null;
}

export function cleanOsmShape(points) {
  const clean = (points || []).map(toPlain).filter(p => Number.isFinite(p && p.lat) && Number.isFinite(p && p.lng));
  if (clean.length > 3 && distance(clean[0], clean[clean.length - 1]) < 1) clean.pop();
  return clean.length >= 3 ? clean : null;
}

/* The AREA centroid of the outline, not the average of its vertices. A vertex average leans
   toward whichever edge was traced with more points - a heart-shaped green drawn with a fussy
   back edge put its "centre" 2.3 m long at Millbrook hole 3 - and every distance to the
   centre, the Bubble's green target and the watch's framing all hang off this point. Planar
   shoelace in a local equirectangular frame (exact to well under a centimetre at green size);
   a degenerate or self-cancelling outline falls back to the vertex average. */
export function shapeCentroid(shape) {
  const pts = cleanOsmShape(shape);
  if (!pts) return null;
  let lat = 0, lng = 0;
  pts.forEach(p => { lat += Number(p.lat); lng += Number(p.lng); });
  const mean = { lat: lat / pts.length, lng: lng / pts.length };
  const k = Math.cos(mean.lat * Math.PI / 180);
  let area = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const x1 = (a.lng - mean.lng) * k, y1 = a.lat - mean.lat, x2 = (b.lng - mean.lng) * k, y2 = b.lat - mean.lat;
    const cross = x1 * y2 - x2 * y1;
    area += cross; cx += (x1 + x2) * cross; cy += (y1 + y2) * cross;
  }
  if (!(Math.abs(area) > 1e-14)) return mean;
  const centre = { lat: mean.lat + cy / (3 * area), lng: mean.lng + cx / (3 * area) / k };
  return Number.isFinite(centre.lat) && Number.isFinite(centre.lng) ? centre : mean;
}

export function greenShapeSpan(shape, center = shapeCentroid(shape)) {
  if (!center) return Infinity;
  return Math.max(...(shape || []).map(p => distance(center, p)).filter(Number.isFinite), 0) * 2;
}

export function osmGreenShapeFromElement(element) {
  if (String((element && element.tags && element.tags.golf) || "").toLowerCase() !== "green") return null;
  const direct = osmMainOutline(element);
  if (!direct) return null;
  const center = shapeCentroid(direct);
  if (!center) return null;
  const span = greenShapeSpan(direct, center);
  if (span < 5 || span > OSM_AUTO_GREEN_MAX_SPAN_M) return null;
  return { id: (element.type || "osm") + "-" + (element.id || "green"), ref: osmGuideHoleRef((element.tags && (element.tags.ref || element.tags.name))), center, shape: direct, span };
}

export function parseOsmHoleGuides(payload) {
  const rows = [];
  (payload && payload.elements || []).forEach(element => {
    if (String((element.tags && element.tags.golf) || "").toLowerCase() !== "hole") return;
    const hole = osmGuideHoleRef(element.tags && (element.tags.ref || element.tags.name));
    if (!hole) return;
    const points = osmGuidePointsFromElement(element);
    if (points.length < 2) return;
    rows.push({ id: (element.type || "osm") + "-" + (element.id || rows.length), hole, par: Number.isFinite(Number(element.tags && element.tags.par)) ? Number(element.tags.par) : null, points });
  });
  return rows;
}

/* The hole ways OSM drew but did not number - parseOsmHoleGuides drops these,
   because a guide with no number has nowhere to go. Kept separately for the one
   inference that CAN place one: elimination, below. */
export function parseOsmUnnumberedHoleGuides(payload) {
  const rows = [];
  (payload && payload.elements || []).forEach(element => {
    if (String((element.tags && element.tags.golf) || "").toLowerCase() !== "hole") return;
    if (osmGuideHoleRef(element.tags && (element.tags.ref || element.tags.name))) return;
    const points = osmGuidePointsFromElement(element);
    if (points.length < 2) return;
    rows.push({ id: (element.type || "osm") + "-" + (element.id || rows.length), hole: null, par: Number.isFinite(Number(element.tags && element.tags.par)) ? Number(element.tags.par) : null, points });
  });
  return rows;
}

/* Two hole features closer than this at an end share ground: a tee box or a
   green is never 40m from itself on another hole. */
export const HOLE_GROUND_CLAIM_RADIUS_M = 40;

function guideEnds(guide) {
  const pts = (guide && guide.points || []).filter(p => Number.isFinite(p && p.lat) && Number.isFinite(p && p.lng));
  return pts.length ? [pts[0], pts[pts.length - 1]] : [];
}

function guideSharesGroundWith(guide, others, radiusM) {
  const ends = guideEnds(guide);
  return (others || []).some(other => {
    const otherEnds = guideEnds(other);
    return ends.some(end => otherEnds.some(point => distance(end, point) <= radiusM));
  });
}

/* The one missing number goes to the one un-numbered way.
 *
 * Dorado Beach East: OSM draws 18 hole ways and numbers 17 of them; the card
 * says 18. Every number but 5 is on the ground and exactly one way carries no
 * ref, sitting between holes 4 and 6 and ending 3m from a mapped green. The
 * geometry resolver was asked to fill that gap and instead re-derived the whole
 * course from scorecard distances, moving hole 5 onto another fairway. No
 * distance matching is needed here - it is elimination, and it is only ever
 * done when it is elimination: one missing number, one unclaimed un-numbered
 * way that belongs to this course, and (when the card gives a length) a way
 * that is roughly that long. Anything less certain is left to the resolver. */
export function fillMissingHoleByElimination({ payload, resolvedHoleNumbers, numberedGuides, expectedHoles, coursePoint, siblingPoints = [], scorecardLengths = null }) {
  const expected = Number(expectedHoles) || 0;
  const have = new Set((resolvedHoleNumbers || []).map(validHoleNumber).filter(Boolean));
  const missing = [];
  for (let hole = 1; hole <= expected; hole++) if (!have.has(hole)) missing.push(hole);
  const record = { expectedHoles: expected, missing, unnumberedWays: 0, assigned: null, reason: null };
  if (!expected || missing.length !== 1) {
    record.reason = missing.length ? "more-than-one-missing" : "nothing-missing";
    return { guide: null, record };
  }
  const candidates = parseOsmUnnumberedHoleGuides(payload)
    .filter(guide => guideBelongsToCourse(guide, coursePoint, siblingPoints))
    .filter(guide => !guideSharesGroundWith(guide, numberedGuides || [], HOLE_GROUND_CLAIM_RADIUS_M));
  record.unnumberedWays = candidates.length;
  if (candidates.length !== 1) {
    record.reason = candidates.length ? "more-than-one-unnumbered-way" : "no-unnumbered-way";
    return { guide: null, record };
  }
  const hole = missing[0];
  const candidate = candidates[0];
  const lengthM = guideLength(candidate.points);
  const cardLengthM = scorecardLengths ? Number(scorecardLengths[hole]) : NaN;
  record.lengthM = Math.round(lengthM);
  if (Number.isFinite(cardLengthM) && cardLengthM > 0) {
    record.cardLengthM = Math.round(cardLengthM);
    const ratio = lengthM / cardLengthM;
    if (ratio < 0.6 || ratio > 1.5) {
      record.reason = "length-disagrees-with-card";
      return { guide: null, record };
    }
  }
  record.assigned = hole;
  record.reason = "one-missing-number-one-unnumbered-way";
  return { guide: Object.assign({}, candidate, { hole }), record };
}

/* Which of the geometry resolver's guides may be ADDED to an OSM-numbered course.
 *
 * On the short-of-expected path the resolver's answer used to replace the OSM
 * one whenever it covered more holes. Its numbering comes from scorecard
 * distances alone, so with 17 holes right on the ground and one missing, an
 * 18-hole resolver answer that disagreed about three of them still won, and
 * Dorado Beach East got a second hole 6 on the wrong fairway and duplicate
 * greens. The resolver now fills: only numbers the course does not have, and
 * only on ground no numbered hole already holds a tee or green. */
export function resolverFillGuides(guides, geometry, radiusM = HOLE_GROUND_CLAIM_RADIUS_M) {
  const holes = (geometry && geometry.holes) || {};
  const claimed = Object.values((geometry && geometry.objects) || {})
    .filter(o => o && (o.type === "tee" || o.type === "green") && validHoleNumber(o.holeNumber))
    .map(o => ({ hole: validHoleNumber(o.holeNumber), point: objectCenter(o) }))
    .filter(entry => entry.point);
  const accepted = [], rejected = [];
  (guides || []).forEach(guide => {
    const hole = validHoleNumber(guide && guide.hole);
    if (!hole) return;
    if (holes[hole]) { rejected.push({ hole, reason: "already-numbered" }); return; }
    const ends = guideEnds(guide);
    const clash = claimed.find(entry => entry.hole !== hole && ends.some(end => distance(end, entry.point) <= radiusM));
    if (clash) { rejected.push({ hole, reason: "ground-claimed-by-hole-" + clash.hole }); return; }
    accepted.push(guide);
  });
  return { accepted, rejected };
}

export function parseOsmGreenShapes(payload) {
  return (payload && payload.elements || []).map(osmGreenShapeFromElement).filter(Boolean);
}

export function parseOsmGuideBundle(payload) {
  return { guides: parseOsmHoleGuides(payload), greens: parseOsmGreenShapes(payload) };
}

/* ---------- guide selection / hole assembly (gd-course-library-pin-lock.js:3773-3855) ------ */

export function guideLength(points) {
  const pts = (points || []).filter(p => Number.isFinite(p && p.lat) && Number.isFinite(p && p.lng));
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += distance(pts[i - 1], pts[i]);
  return total;
}

export function guideDistanceToPoint(guide, point) {
  if (!point) return Infinity;
  const pts = (guide && guide.points || []).filter(p => Number.isFinite(p && p.lat) && Number.isFinite(p && p.lng));
  if (!pts.length) return Infinity;
  return Math.min(...pts.map(pt => distance(point, pt)).filter(Number.isFinite));
}

export function bestGuideForHole(guides, hole, coursePoint) {
  const h = validHoleNumber(hole);
  if (!h) return null;
  return (guides || [])
    .filter(guide => Number(guide.hole) === h && Array.isArray(guide.points) && guide.points.length >= 2)
    .sort((a, b) => {
      const ad = guideDistanceToPoint(a, coursePoint);
      const bd = guideDistanceToPoint(b, coursePoint);
      if (Math.abs(ad - bd) > 120) return ad - bd;
      return guideLength(b.points) - guideLength(a.points);
    })[0] || null;
}

/* At a multi-course facility the Overpass sweep (OSM_AUTOMAPPER_RADIUS_M, 1400m) covers BOTH
   courses, and both return holes numbered 1-18. Left alone, one course's hole 7 competes with
   the other's for a single slot in byHole below, decided by whichever happens to be longer -
   so a course could be assembled out of its neighbour's holes.

   Assign each guide to the nearest course centre instead: a guide strictly closer to a
   sibling's centre than to this one's belongs to that sibling. No siblings means no filtering
   at all, so a single-course facility behaves exactly as before. */
export function guideBelongsToCourse(guide, coursePoint, siblingPoints) {
  if (!coursePoint || !(siblingPoints || []).length) return true;
  const own = guideDistanceToPoint(guide, coursePoint);
  if (!Number.isFinite(own)) return true;
  return !siblingPoints.some(point => guideDistanceToPoint(guide, point) < own);
}

/* One best guide per hole number, preferring the guide nearest the course center (within
   120m) and otherwise the longer one - identical selection rule to the client's
   chooseAutoMapGuides. */
export function chooseAutoMapGuides(guides, coursePoint, siblingPoints = []) {
  const byHole = new Map();
  (guides || []).filter(guide => guideBelongsToCourse(guide, coursePoint, siblingPoints)).forEach(guide => {
    const h = validHoleNumber(guide.hole);
    if (!h) return;
    const prev = byHole.get(h);
    if (!prev) { byHole.set(h, guide); return; }
    const guideDistance = guideDistanceToPoint(guide, coursePoint);
    const prevDistance = guideDistanceToPoint(prev, coursePoint);
    if (Math.abs(guideDistance - prevDistance) > 120) {
      if (guideDistance < prevDistance) byHole.set(h, guide);
      return;
    }
    if (guideLength(guide.points) > guideLength(prev.points)) byHole.set(h, guide);
  });
  return Array.from(byHole.values()).sort((a, b) => Number(a.hole) - Number(b.hole));
}

export function pointAlongGuide(points, fraction = 0.5) {
  const pts = (points || []).filter(p => Number.isFinite(p && p.lat) && Number.isFinite(p && p.lng));
  if (!pts.length) return null;
  if (pts.length === 1) return toPlain(pts[0]);
  const target = guideLength(pts) * Math.max(0, Math.min(1, fraction));
  let travelled = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const seg = distance(a, b);
    if (travelled + seg >= target) {
      const t = seg ? (target - travelled) / seg : 0;
      return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    }
    travelled += seg;
  }
  return toPlain(pts[pts.length - 1]);
}

export function fairwaySamplesForGuide(points) {
  const len = guideLength(points);
  if (len > 360) return [pointAlongGuide(points, 0.36), pointAlongGuide(points, 0.64)].filter(Boolean);
  return [pointAlongGuide(points, 0.5)].filter(Boolean);
}

/* Matches a hole guide's tee/green endpoint against the nearest OSM green polygon within
   OSM_AUTO_GREEN_MATCH_RADIUS_M, same rule as the client (gd-course-library-pin-lock.js:3815). */
export function bestOsmGreenForGuide(guide, greens = []) {
  const pts = (guide && guide.points || []).filter(p => Number.isFinite(p && p.lat) && Number.isFinite(p && p.lng));
  if (pts.length < 2) return null;
  const ends = [pts[0], pts[pts.length - 1]];
  let best = null;
  greens.forEach(green => {
    if (green.ref && guide.hole && Number(green.ref) !== Number(guide.hole)) return;
    const center = green.center;
    if (!center) return;
    ends.forEach((end, index) => {
      const d = distance(center, end);
      if (d <= OSM_AUTO_GREEN_MATCH_RADIUS_M && (!best || d < best.distance)) best = { green, endpointIndex: index, distance: d };
    });
  });
  return best;
}

/* ---------- object dedupe (gd-course-library-pin-lock.js:769-857, 1335-1344, 1409-1413) --- */

export function objectCenter(object) {
  return (object && (object.position || object.greenCenter)) || null;
}

export function objectDedupeRadius(type) {
  return OBJECT_DEDUPE_RADIUS_M[type] || OBJECT_DEDUPE_RADIUS_M.default;
}

export function objectLifecycle(object) {
  if (validHoleNumber(object && object.holeNumber) && object && object.confirmed) return "hole-linked";
  if (validHoleNumber(object && object.holeNumber)) return "assigned-draft";
  return "unassigned";
}

export function asGreenRecord(object) {
  if (!object) return null;
  return {
    id: object.id,
    courseId: object.courseId,
    holeNumber: validHoleNumber(object.holeNumber),
    greenCenter: object.greenCenter || object.position || null,
    greenShape: object.greenShape || object.shape || null,
    greenSource: object.greenSource || object.source || "unknown",
    confirmed: !!object.confirmed && !!validHoleNumber(object.holeNumber),
    createdAt: object.createdAt,
    updatedAt: object.updatedAt
  };
}

/* holeNumber scopes the match to objects already on that hole, and is required for surfaces.
   A bunker between two holes is stored once PER hole (play is one hole at a time, so a shared
   feature is cloned rather than assigned), and those clones sit at identical coordinates.
   Without the scope the second clone matches the first and upsertResolvedObject rewrites its
   holeNumber instead of inserting - the same flip that cost Omaha Beach hole 5 its green (see
   assignGreensToGuides). Left undefined for tee/green/fairway, which keep the original
   position-only behaviour. */
export function nearestMatchingObject(objects, type, center, maxDistance = objectDedupeRadius(type), holeNumber) {
  if (!center) return null;
  const scoped = holeNumber === undefined ? undefined : validHoleNumber(holeNumber);
  let best = null;
  objects.filter(o => o && o.type === type).forEach(object => {
    if (scoped !== undefined && validHoleNumber(object.holeNumber) !== scoped) return;
    const d = distance(objectCenter(object), center);
    if (d <= maxDistance && (!best || d < best.distance)) best = { object, distance: d };
  });
  return best ? best.object : null;
}

export function isOsmAutoSource(source) {
  return /^osm_auto/.test(String(source || ""));
}

/* A hand-placed object of the same type near this position, IGNORING hole number - manual
   bunkers are stored with holeNumber null (gd-course-library-pin-lock.js:1368), so the
   hole-scoped dedupe above will never see one. Without this an OSM bunker would be written
   on top of the pin an admin placed for it rather than suppressed by it. */
export function manualObjectNear(objects, type, center, maxDistance = objectDedupeRadius(type)) {
  if (!center) return null;
  return objects.filter(o => o && o.type === type && !isOsmAutoSource(o.source))
    .find(object => distance(objectCenter(object), center) <= maxDistance) || null;
}

/* Client simplifyShape (gd-course-library-pin-lock.js:1193), ported unchanged so a shape
   written by the server and one written by Studio decimate identically. */
export function simplifyShape(points, max = SURFACE_SHAPE_MAX_POINTS) {
  if (!Array.isArray(points) || !points.length) return null;
  const clean = points.map(toPlain).filter(p => Number.isFinite(p && p.lat) && Number.isFinite(p && p.lng));
  if (clean.length < 3) return null;
  const step = Math.max(1, Math.ceil(clean.length / max));
  const out = clean.filter((_, i) => i % step === 0);
  return out.length >= 3 ? out : clean.slice(0, Math.min(clean.length, max));
}

export function mergeObjectRecord(target, source) {
  if (!target || !source) return target;
  const sourceNewer = String(source.updatedAt || "") > String(target.updatedAt || "");
  const sourceCenter = objectCenter(source);
  if (sourceCenter) {
    target.position = toPlain(sourceCenter);
    if (target.type === "green") target.greenCenter = target.position;
  }
  if (source.holeNumber != null && target.holeNumber == null) target.holeNumber = source.holeNumber;
  if (source.confirmed) target.confirmed = true;
  target.lifecycle = objectLifecycle(target);
  target.targetEligible = target.type === "green" && target.confirmed;
  if (source.shape && (!target.shape || sourceNewer)) target.shape = source.shape;
  if (source.greenShape && (!target.greenShape || sourceNewer)) target.greenShape = source.greenShape;
  if (source.greenCenter && (!target.greenCenter || sourceNewer)) target.greenCenter = source.greenCenter;
  if (source.source && (!target.source || sourceNewer)) target.source = source.source;
  if (!target.createdAt || String(source.createdAt || "") < String(target.createdAt || "")) target.createdAt = source.createdAt || target.createdAt;
  target.updatedAt = sourceNewer ? source.updatedAt : (target.updatedAt || source.updatedAt || new Date().toISOString());
  return target;
}

/* ---------- top-level assembly: OSM payload -> objects/holes map -------------------------- */

function nextObjectId(type) {
  return type + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
}

/* Pure function replacement for saveCourseObject()'s matching/insert logic
   (gd-course-library-pin-lock.js:1345-1408), operating on a plain `objects` array instead of
   a localStorage-backed store. Mutates and returns the matched/created record. */
function upsertResolvedObject(objects, input) {
  const position = toPlain(input.position);
  if (!Number.isFinite(position && position.lat) || !Number.isFinite(position && position.lng)) return null;
  const radius = input.maxDedupeDistanceM || objectDedupeRadius(input.type);
  const surface = SURFACE_TYPES.has(input.type);
  /* Manual override wins (surfaces only - tee/green keep merging as they always have, which is
     what lets a rescan refine a hand-placed tee rather than duplicate it). */
  if (surface && isOsmAutoSource(input.source) && manualObjectNear(objects, input.type, position, radius)) return null;
  const hole = validHoleNumber(input.holeNumber);
  /* A surface carrying an OSM id is matched on THAT id, not on proximity.
     Proximity is wrong here and measurably so: on a real course, clustered bunkering puts
     genuinely separate bunkers well inside the 14m dedupe radius, and a position match silently
     folded distinct features into one another - a first run over Millbrook lost 4 of 119 that
     way. The id is exact, it is what makes a re-run idempotent rather than merely
     approximately idempotent, and it is the "stable source identity" the maintenance-modes
     plan asks collection to reconcile on. No position fallback when an id is present: falling
     back would reinstate exactly the collapse this avoids. */
  const osmId = input.extra && input.extra.osmId;
  const existing = surface && osmId
    ? (objects.find(o => o && o.type === input.type && o.osmId === osmId && validHoleNumber(o.holeNumber) === hole) || null)
    : nearestMatchingObject(objects, input.type, position, radius, surface ? input.holeNumber : undefined);
  const id = (existing && existing.id) || nextObjectId(input.type);
  const record = Object.assign({}, existing || {}, {
    id,
    courseId: input.courseId,
    type: input.type,
    /* A refined surface keeps the geometry it was refined to. Without this, the next Collect
       Extra Objects run matches it on osmId+hole and writes the OSM ring straight back over the
       traced one - silently undoing every refinement on the course. Same principle as the
       manual-override guard above: what we derived beats what OSM drew. */
    position: existing && existing.shapeSource === REFINED_SHAPE_SOURCE ? existing.position : position,
    shape: (existing && existing.shapeSource === REFINED_SHAPE_SOURCE ? existing.shape : null)
      || input.shape || (existing && existing.shape) || null,
    holeNumber: hole,
    confirmed: !!(input.confirmed || (existing && existing.confirmed)),
    source: input.source || (existing && existing.source) || "unknown",
    greenCenter: input.type === "green" ? position : undefined,
    greenShape: input.type === "green" ? (input.shape || (existing && existing.shape) || null) : undefined,
    greenSource: input.type === "green" ? (input.source || (existing && existing.source) || "unknown") : undefined,
    createdAt: (existing && existing.createdAt) || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }, input.extra || {});
  record.lifecycle = objectLifecycle(record);
  record.targetEligible = record.type === "green" && record.confirmed;
  if (existing) {
    const index = objects.indexOf(existing);
    objects[index] = record;
  } else {
    objects.push(record);
  }
  return record;
}

/* Server equivalent of saveOsmAutoHole() + persistOsmGuideBundle()
   (gd-course-library-pin-lock.js:3868-3955), minus the green-shape-refinement call (that is
   functions/lib/gd-green-shape-core.mjs, wired in by the worker separately since it needs
   image buffers, not just the OSM payload) and everything UI/telemetry-related. Green shape
   defaults to a simple circle (fallbackGreenShape) here; the worker replaces it with a
   refined shape from gd-green-shape-core.mjs when imagery is available. */
function resolveGuideObjects(objects, courseId, guide, match) {
  const pts = (guide.points || []).map(toPlain).filter(Boolean);
  const h = validHoleNumber(guide.hole);
  if (!h || pts.length < 2) return { saved: 0, greenPolygon: false, fallback: false };
  const ordered = match && match.endpointIndex === 0 ? [...pts].reverse() : pts;
  const tee = ordered[0];
  const greenEnd = ordered[ordered.length - 1];
  const greenCenter = (match && match.green && match.green.center) || greenEnd;
  const greenShape = simplifyShape((match && match.green && match.green.shape) || fallbackGreenShape(greenCenter, 16, 40), GREEN_SHAPE_MAX_POINTS)
    || fallbackGreenShape(greenCenter, 16, 40);
  let saved = 0;
  if (greenCenter && greenShape.length >= 3) {
    if (upsertResolvedObject(objects, { courseId, type: "green", position: greenCenter, shape: greenShape, source: match && match.green ? "osm_auto_green_polygon" : "osm_auto_green_estimate", holeNumber: h, confirmed: true, maxDedupeDistanceM: 4 })) saved++;
  }
  if (tee) {
    if (upsertResolvedObject(objects, { courseId, type: "tee", position: tee, source: "osm_auto_tee", holeNumber: h, confirmed: true, maxDedupeDistanceM: 4 })) saved++;
  }
  fairwaySamplesForGuide(ordered).forEach((point, index) => {
    if (upsertResolvedObject(objects, { courseId, type: "fairway", position: point, source: index ? "osm_auto_fairway_bend" : "osm_auto_fairway", holeNumber: h, confirmed: true, maxDedupeDistanceM: 4 })) saved++;
  });
  return { saved, greenPolygon: !!(match && match.green), fallback: !(match && match.green) };
}

/* Shared by both the OSM-numbered path (resolveCourseGeometry below) and the Native Geometry
   Resolver path (functions/lib/gd-geometry-resolver-core.mjs, via the worker): once ANY
   source has produced a list of {hole, points, ...} guides, turning them into saved
   tee/green/fairway objects and a holes map is identical regardless of where the guide came
   from - a guide is a guide. existingObjects carries forward whatever the other path (or a
   prior run) already resolved, so running both against the same course_maps row merges
   rather than clobbers. */
/* One green polygon, one hole. Without this, per-guide matching lets two guides claim the
   same green: at Omaha Beach hole 5 has no green polygon in OSM, its guide ends within the
   95m match radius of hole 6's green, and the upsert dedupe (identical centre) then flipped
   that green's holeNumber from 5 to 6 as the guides processed in order - leaving hole 5 with
   a tee and fairway but no green at all ("incomplete" in Studio, polygons > greensFound in
   the job result). Assign each green to the single guide whose endpoint sits closest to it;
   every losing guide gets an estimated circle at its own guide end instead. */
export function assignGreensToGuides(guides, greens) {
  const matches = (guides || []).map(guide => ({ guide, match: bestOsmGreenForGuide(guide, greens || []) }));
  const winnerByGreen = new Map();
  matches.forEach(row => {
    if (!row.match || !row.match.green) return;
    const key = row.match.green.id;
    const prev = winnerByGreen.get(key);
    if (!prev || row.match.distance < prev.match.distance) winnerByGreen.set(key, row);
  });
  return matches.map(row => {
    if (!row.match || !row.match.green) return row;
    return winnerByGreen.get(row.match.green.id) === row ? row : { guide: row.guide, match: null };
  });
}

/* ---------- OSM course surfaces (fairway / bunker / water / trees) ----------------------- */

/* golf=* is authoritative about what a thing IS. natural=water is not - a lake beside a course
   is still a lake, and calling every one of them a penalty area would have Caddy asserting a
   Rules-of-Golf status OSM never claimed. Both are drawn; only the tagged ones are penalty
   areas. */
function surfaceKindForElement(element) {
  const tags = (element && element.tags) || {};
  const golf = String(tags.golf || "").toLowerCase();
  if (golf === "fairway") return { type: "fairway_area", hazardClass: null };
  if (golf === "bunker") return { type: "bunker", hazardClass: null };
  if (golf === "water_hazard" || golf === "lateral_water_hazard") return { type: "water", hazardClass: "penalty_area" };
  /* golf=hazard and golf=waste_area are our own tags (the mapping overlay's): nothing in OSM
     carries them. A waste area is sandy, scrubby ground played as it lies - its own type so
     nothing treats it as a bunker under the Rules; the bubble draws it like one. */
  const overlay = !!tags["clarity:overlay"];
  if (overlay && golf === "hazard") return { type: "hazard", hazardClass: null };
  if (overlay && golf === "waste_area") return { type: "waste", hazardClass: null };
  if (golf) return null; /* green / tee / hole / course / rough - not a surface */
  const natural = String(tags.natural || "").toLowerCase();
  if (natural === "wood" || String(tags.landuse || "").toLowerCase() === "forest") return { type: "trees", hazardClass: null };
  if (natural === "water" || tags.water) return { type: "water", hazardClass: "water" };
  return null;
}

/* Where the course itself is: the middle of every green, tee and fairway. A tree area that
   holds one of these is not trees - it is a wood drawn round the course with the course cut out
   of it, and only the outline survived (surfaces are stored as single rings). Read as trees it
   would paint every hole as forest. */
export function coursePlayPoints(payload) {
  const out = [];
  ((payload && payload.elements) || []).forEach(element => {
    const golf = String((element && element.tags && element.tags.golf) || "").toLowerCase();
    if (golf !== "green" && golf !== "tee" && golf !== "fairway") return;
    const outline = osmMainOutline(element);
    const centre = outline && shapeCentroid(outline);
    if (centre) out.push(centre);
  });
  return out;
}

export function pointInShape(point, shape) {
  if (!point || !Array.isArray(shape) || shape.length < 3) return false;
  let inside = false;
  for (let i = 0, j = shape.length - 1; i < shape.length; j = i++) {
    const a = shape[i], b = shape[j];
    if ((a.lat > point.lat) !== (b.lat > point.lat)
      && point.lng < (b.lng - a.lng) * (point.lat - a.lat) / (b.lat - a.lat) + a.lng) inside = !inside;
  }
  return inside;
}

/* rejected, when given, collects every OSM surface left out and why - so a course whose OSM
   plainly has fairways but gets none says which check stopped them. */
export function parseOsmSurfaces(payload, rejected = null) {
  const out = [];
  let playPoints = null;
  ((payload && payload.elements) || []).forEach(element => {
    const kind = surfaceKindForElement(element);
    if (!kind) return;
    const key = (element.type || "osm") + "/" + (element.id != null ? element.id : "x");
    const reject = (reason, extra) => { if (rejected) rejected.push(Object.assign({ osmId: key, type: kind.type, reason }, extra || {})); };
    const rings = osmAreaRings(element).outers;
    if (!rings.length) {
      const points = osmGuidePointsFromElement(element).length;
      reject("no-outline", { points, members: ((element && element.members) || []).length });
      return;
    }
    rings.forEach((ring, index) => {
      const centre = shapeCentroid(ring);
      if (!centre) { reject("no-centre", { points: ring.length }); return; }
      const span = greenShapeSpan(ring, centre);
      const limits = SURFACE_SPAN_LIMITS_M[kind.type];
      if (limits && (!Number.isFinite(span) || span < limits.min || span > limits.max)) {
        reject(span > (limits && limits.max) ? "too-big" : "too-small", { span: Math.round(span), points: ring.length });
        return;
      }
      if (kind.type === "trees") {
        playPoints = playPoints || coursePlayPoints(payload);
        if (playPoints.some(point => pointInShape(point, ring))) { reject("holds-course", { span: Math.round(span) }); return; }
      }
      const shape = simplifyShape(ring, SURFACE_SHAPE_MAX_POINTS_BY_TYPE[kind.type] || SURFACE_SHAPE_MAX_POINTS);
      if (!shape) { reject("no-shape", { points: ring.length }); return; }
      out.push({
        type: kind.type,
        hazardClass: kind.hazardClass,
        centre,
        shape,
        span,
        bounds: boundsFromPoints(ring),
        osmId: (element.type || "osm") + "/" + (element.id != null ? element.id : "x") + (index ? "#" + index : "")
      });
    });
  });
  return out;
}

/* The extent a hole is actually CAPTURED at, rebuilt from the same inputs and with the same
   arithmetic as planCourseCaptures (gd-visual-plan-core.mjs:297 and the padBounds(bleedMeters)
   in item()). Deliberately not an approximation of it: surfaces selected by a box that differed
   from the frame's box would put a bunker on a hole it is not visible on, or omit one the
   player can plainly see. packageHoleData is reused rather than re-deriving the route, so the
   two cannot drift. */
export function holeCaptureBounds(holeData) {
  if (!holeData) return null;
  const route = Array.isArray(holeData.route) ? holeData.route : [];
  const greenShape = Array.isArray(holeData.greenShape) ? holeData.greenShape : [];
  let bounds = boundsFromPoints([
    holeData.tee && holeData.tee.position,
    holeData.green && holeData.green.position,
    ...route, ...greenShape
  ].filter(Boolean));
  if (!validBounds(bounds)) return null;
  if (boundsSpanM(bounds).diag < 35) bounds = padBounds(bounds, 32);
  return padBounds(bounds, capturePolicy("play-corridor").bleedMeters);
}

export function boundsIntersect(a, b) {
  if (!validBounds(a) || !validBounds(b)) return false;
  return Number(a.south) <= Number(b.north) && Number(a.north) >= Number(b.south)
    && Number(a.west) <= Number(b.east) && Number(a.east) >= Number(b.west);
}

/* The Overpass area for an enrichment run: the union of the holes this course ALREADY has,
   padded. Deliberately not courseFootprintFrame's golf=course polygon, which is what the
   mapping path requeries on.

   That polygon is not this course. At Millbrook - a multi-course facility - it covers the
   eastern loop only, with a west edge at lng 168.8170 while the saved course runs out to
   168.8062. Requerying on it returned a payload with nothing near holes 10, 11 and 15-18, and
   six of eighteen holes came back with no surfaces at all - not because OSM lacks them, but
   because the second query had stopped asking about that ground.

   The saved holes cannot be wrong about where this course is, which is the whole premise of
   the job. Anything outside their corridors can never be written to a hole anyway, so this is
   also the smallest area worth asking for. */
export const SURFACE_QUERY_PAD_M = 150;

export function savedCourseQueryFrame(objects, holes) {
  const objectsMap = {};
  (objects || []).forEach(object => { if (object && object.id) objectsMap[object.id] = object; });
  const holeData = packageHoleData({ objects: objectsMap, holes: holes || {} });
  const boxes = Object.keys(holeData).map(hole => holeCaptureBounds(holeData[hole])).filter(validBounds);
  if (!boxes.length) return null;
  return expandOsmFrame({
    south: Math.min(...boxes.map(b => Number(b.south))), north: Math.max(...boxes.map(b => Number(b.north))),
    west: Math.min(...boxes.map(b => Number(b.west))), east: Math.max(...boxes.map(b => Number(b.east)))
  }, SURFACE_QUERY_PAD_M);
}

/* ---------- default fairways ---------------------------------------------------------------

   A hole with a tee, a green and its hazards mapped but no fairway polygon still has a
   fairway: it is the mown strip between the hazards, from the drive zone to the green. Without
   one the watch map and the bubble draw the hole as bare rough. So when OSM has no fairway on a
   hole, one is laid along the hole's route and pulled in wherever a bunker, water, trees or a
   hazard gets in the way - narrowing past a bunker, stopping short of a crossing burn and
   starting again beyond it.

   Stored like any other surface (type fairway_area, cloned onto every hole whose frame it
   falls in) under its own source, so a re-run can tell it from a real one: it is regenerated
   every time, and disappears the moment the hole gets a real fairway - from OSM or drawn in
   Studio. A short hole (a par 3) gets none. */
export const FAIRWAY_FILL_SOURCE = "osm_auto_fairway_fill";
export const FAIRWAY_FILL = {
  minHoleM: 215,      /* shorter than this is a par 3: tee to green, no fairway */
  halfWidthM: 16,     /* a 32 m fairway when nothing is in the way */
  minHalfWidthM: 6,   /* narrower than 12 m is not a fairway - the strip is broken there */
  hazardGapM: 3,      /* rough left between the fairway edge and a hazard */
  startFraction: 0.3, /* where the fairway starts, as a share of the hole... */
  startMinM: 70, startMaxM: 190, /* ...kept to a sensible drive zone */
  greenGapM: 4,       /* stops this far short of the green's edge */
  minPieceM: 30,      /* a piece shorter than this between two hazards is dropped */
  stepM: 4            /* sampled this often; only the samples where the width changes are kept */
};
const OBSTACLE_TYPES = new Set(["bunker", "water", "trees", "hazard", "waste"]);

function localFrame(origin) {
  const k = Math.cos(origin.lat * Math.PI / 180);
  return {
    xy: p => ({ x: (p.lng - origin.lng) * 111320 * k, y: (p.lat - origin.lat) * 111320 }),
    ll: v => ({ lat: origin.lat + v.y / 111320, lng: origin.lng + v.x / (111320 * k) })
  };
}

function insideXY(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/* Distance from p along the unit direction d to the first edge of any ring, or Infinity. */
function rayHitXY(p, d, rings) {
  let best = Infinity;
  rings.forEach(ring => {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j], b = ring[i];
      const ex = b.x - a.x, ey = b.y - a.y;
      const den = d.x * ey - d.y * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((a.x - p.x) * ey - (a.y - p.y) * ex) / den;
      const u = ((a.x - p.x) * d.y - (a.y - p.y) * d.x) / den;
      if (t > 0 && u >= 0 && u <= 1 && t < best) best = t;
    }
  });
  return best;
}

/* The point and heading at distance s along a polyline (in metres, local frame). */
function alongXY(route, s) {
  let walked = 0;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1], b = route[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!len) continue;
    if (walked + len >= s || i === route.length - 1) {
      const t = Math.max(0, Math.min(1, (s - walked) / len));
      return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, d: { x: (b.x - a.x) / len, y: (b.y - a.y) / len } };
    }
    walked += len;
  }
  return null;
}

/* The fairway outline(s) for one hole: zero (a par 3, or hazards everywhere), one, or several
   when a hazard crosses the line of play. holeData is a packageHoleData entry; obstacles and
   fairways are {lat,lng} rings. Returns [] when the hole already has a fairway on its line. */
export function defaultFairwayShapes(holeData, obstacles = [], fairways = []) {
  const route = Array.isArray(holeData && holeData.route) ? holeData.route.filter(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lng)) : [];
  if (route.length < 2) return [];
  const frame = localFrame(route[0]);
  const line = route.map(frame.xy);
  let length = 0;
  for (let i = 1; i < line.length; i++) length += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y);
  if (length < FAIRWAY_FILL.minHoleM) return [];
  const greenShape = Array.isArray(holeData.greenShape) && holeData.greenShape.length >= 3 ? holeData.greenShape : null;
  const greenRadius = greenShape ? Math.min(25, greenShapeSpan(greenShape) / 2) : 14;
  const start = Math.max(FAIRWAY_FILL.startMinM, Math.min(FAIRWAY_FILL.startMaxM, length * FAIRWAY_FILL.startFraction));
  const end = length - greenRadius - FAIRWAY_FILL.greenGapM;
  if (end - start < FAIRWAY_FILL.minPieceM) return [];

  const toRings = list => list.filter(ring => Array.isArray(ring) && ring.length >= 3).map(ring => ring.map(frame.xy));
  const blockers = toRings(obstacles);
  const existing = toRings(fairways);
  const count = Math.max(2, Math.ceil((end - start) / FAIRWAY_FILL.stepM) + 1);
  const step = (end - start) / (count - 1);
  const stations = [];
  for (let i = 0; i < count; i++) {
    const at = alongXY(line, start + step * i);
    if (at) stations.push(at);
  }
  /* A real fairway already on the line of play: nothing to fill. */
  if (stations.some(st => existing.some(ring => insideXY(st.p, ring)))) return [];

  const last = stations.length - 1;
  const rows = stations.map((st, i) => {
    if (blockers.some(ring => insideXY(st.p, ring))) return null;
    /* Rounded ends: narrow at the drive-zone start, and no wider than the green at the far end. */
    const fromStart = i * step, toEnd = (last - i) * step;
    const greenHalf = Math.max(FAIRWAY_FILL.minHalfWidthM + 2, Math.min(FAIRWAY_FILL.halfWidthM, greenRadius * 0.9));
    let half = FAIRWAY_FILL.halfWidthM;
    if (fromStart < 25) half = Math.min(half, 9 + (FAIRWAY_FILL.halfWidthM - 9) * fromStart / 25);
    if (toEnd < 30) half = Math.min(half, greenHalf + (FAIRWAY_FILL.halfWidthM - greenHalf) * toEnd / 30);
    const n = { x: -st.d.y, y: st.d.x };
    const left = Math.min(half, rayHitXY(st.p, n, blockers) - FAIRWAY_FILL.hazardGapM);
    const right = Math.min(half, rayHitXY(st.p, { x: -n.x, y: -n.y }, blockers) - FAIRWAY_FILL.hazardGapM);
    if (left < 0 || right < 0 || left + right < FAIRWAY_FILL.minHalfWidthM * 2) return null;
    return { p: st.p, n, left, right };
  });

  const pieces = [];
  let run = [];
  rows.concat([null]).forEach(row => {
    if (row) { run.push(row); return; }
    if (run.length >= 2 && (run.length - 1) * step >= FAIRWAY_FILL.minPieceM) pieces.push(run);
    run = [];
  });
  /* A sample is only worth a corner where the outline bends: an edge pulled in by a hazard, the
     start and end of a taper, a bend in the route. A straight run between them is two points. */
  const bends = (prev, row, next) => Math.abs(2 * row.left - prev.left - next.left) > 0.15
    || Math.abs(2 * row.right - prev.right - next.right) > 0.15
    || Math.abs(prev.n.x - next.n.x) + Math.abs(prev.n.y - next.n.y) > 0.01;
  return pieces.map(all => {
    const piece = all.filter((row, i) => i === 0 || i === all.length - 1 || bends(all[i - 1], row, all[i + 1]));
    const leftEdge = piece.map(r => ({ x: r.p.x + r.n.x * r.left, y: r.p.y + r.n.y * r.left }));
    const rightEdge = piece.map(r => ({ x: r.p.x - r.n.x * r.right, y: r.p.y - r.n.y * r.right })).reverse();
    return leftEdge.concat(rightEdge).map(frame.ll);
  });
}

/* Default fairways for every hole that has none, as surfaces ready to clone. */
function fairwayFillSurfaces(holeData, surfaces, objects) {
  const out = [];
  const realFairways = surfaces.filter(s => s.type === "fairway_area").map(s => s.shape)
    .concat(objects.filter(o => o && o.type === "fairway_area" && o.source !== FAIRWAY_FILL_SOURCE && Array.isArray(o.shape)).map(o => o.shape));
  Object.keys(holeData).map(Number).sort((a, b) => a - b).forEach(holeNumber => {
    const bounds = holeCaptureBounds(holeData[holeNumber]);
    if (!bounds) return;
    /* Hazards, plus the ground that belongs to other holes - their greens and their fairways - so
       a default fairway never runs onto a neighbour. */
    const obstacles = surfaces.filter(s => OBSTACLE_TYPES.has(s.type) && boundsIntersect(s.bounds, bounds)).map(s => s.shape)
      .concat(objects.filter(o => o && OBSTACLE_TYPES.has(o.type) && Array.isArray(o.shape) && o.shape.length >= 3
        && (o.holeNumber == null || validHoleNumber(o.holeNumber) === holeNumber)).map(o => o.shape))
      .concat(Object.keys(holeData).map(Number).filter(other => other !== holeNumber).map(other => holeData[other].greenShape))
      .concat(realFairways);
    defaultFairwayShapes(holeData[holeNumber], obstacles, realFairways).forEach((outline, index) => {
      /* Normally a couple of dozen corners; the cap is for a hole that winds past a long run of
         bunkers. */
      const shape = simplifyShape(outline, 64);
      const centre = shape && shapeCentroid(shape);
      if (!centre) return;
      out.push({
        type: "fairway_area", hazardClass: null, centre, shape, span: greenShapeSpan(shape, centre),
        bounds: boundsFromPoints(shape), osmId: "fill/" + holeNumber + (index ? "#" + index : ""), source: FAIRWAY_FILL_SOURCE
      });
    });
  });
  return out;
}

/* Every surface inside a hole's capture extent is written onto that hole. There is no
   assignment step and nothing owns anything: GPS Play is one hole at a time with no free
   panning, so a bunker that falls in three corridors is simply stored three times, and the
   question "which hole does this bunker belong to" never has to be answered. An axis-aligned
   box is over-inclusive on a diagonal hole - see the note at gd-visual-plan-core.mjs:344 - but
   under cloning that is the correct behaviour rather than a defect: anything inside the box is
   inside the frame the player is looking at, so drawing it beats hiding it.

   Holes with no fairway get a default one (defaultFairwayShapes above). Default fairways from
   an earlier run that are not produced again - the hole has a real fairway now - are removed. */
export function enrichSurfaceObjects(objects, courseId, payload, holes) {
  const rejected = [];
  const surfaces = parseOsmSurfaces(payload, rejected);
  const objectsMap = {};
  objects.forEach(object => { if (object && object.id) objectsMap[object.id] = object; });
  const holeData = packageHoleData({ objects: objectsMap, holes: holes || {} });
  const fills = fairwayFillSurfaces(holeData, surfaces, objects);
  const all = surfaces.concat(fills);
  const written = new Set();
  const held = {};
  let cloned = 0;
  Object.keys(holeData).map(Number).sort((a, b) => a - b).forEach(holeNumber => {
    const bounds = holeCaptureBounds(holeData[holeNumber]);
    if (!bounds) return;
    all.forEach(surface => {
      if (!boundsIntersect(surface.bounds, bounds)) return;
      const saved = upsertResolvedObject(objects, {
        courseId, type: surface.type, position: surface.centre, shape: surface.shape,
        source: surface.source || SURFACE_SOURCE, holeNumber, confirmed: true,
        extra: {
          hazardClass: surface.hazardClass || undefined,
          osmId: surface.osmId,
          surfaceMapperVersion: SURFACE_MAPPER_VERSION
        }
      });
      if (saved) { cloned++; written.add(saved.id); }
      /* A null upsert is a hand-placed object of the same kind standing on this one. */
      else held[surface.type] = (held[surface.type] || 0) + 1;
    });
  });
  for (let i = objects.length - 1; i >= 0; i--) {
    if (objects[i] && objects[i].source === FAIRWAY_FILL_SOURCE && !written.has(objects[i].id)) objects.splice(i, 1);
  }
  return { surfaces: surfaces.length, cloned, filled: fills.length, left: surfaceRejectSummary(rejected, held) };
}

/* What enrichSurfaceObjects left out, small enough to sit on a job row: counts by type and
   reason, a few examples of each, and how many clones a hand-placed object held back. */
export function surfaceRejectSummary(rejected, held = {}) {
  const counts = {};
  const examples = {};
  (rejected || []).forEach(row => {
    const key = row.type + ":" + row.reason;
    counts[key] = (counts[key] || 0) + 1;
    if ((examples[key] = examples[key] || []).length < 3) examples[key].push(row);
  });
  return { counts, examples, heldByHandPlaced: held };
}

export function resolveGuidesIntoObjects(guides, courseId, greens, existingObjects = [], payload = null) {
  const objects = (existingObjects || []).map(o => Object.assign({}, o));
  let saved = 0, polygons = 0, fallbacks = 0;
  assignGreensToGuides(guides, greens).forEach(({ guide, match }) => {
    const result = resolveGuideObjects(objects, courseId, guide, match);
    saved += result.saved;
    if (result.greenPolygon) polygons++;
    if (result.fallback) fallbacks++;
  });
  const holes = {};
  objects.filter(o => o.type === "green" && o.confirmed && validHoleNumber(o.holeNumber)).forEach(green => {
    holes[green.holeNumber] = asGreenRecord(green);
  });
  /* After hole resolution, never before it: surfaces are enrichment and must not be able to
     create, move or renumber a hole. No payload (a caller that only has guides) simply skips
     it. Runs on `objects` so the clones land in the same map everything else is written to. */
  const surfaces = payload ? enrichSurfaceObjects(objects, courseId, payload, holes) : { surfaces: 0, cloned: 0 };
  const objectsMap = {};
  objects.forEach(object => { objectsMap[object.id] = object; });
  return { objects: objectsMap, holes, saved, polygons, fallbacks, surfaces };
}

/* Top-level entry: OSM Overpass payload -> a plain {objects, holes} pair shaped like
   course_maps.objects_json/holes_json. courseId is a plain string; coursePoint is
   {lat,lng} used to break ties between duplicate guides for the same hole number.
   existingObjects (an array of already-saved object records, e.g. from a prior manual scan
   or an earlier mapper run) is merged into rather than discarded - upsertResolvedObject's
   nearestMatchingObject dedup treats them exactly like objects resolved this run, so a
   hand-placed tee is updated in place rather than duplicated. */
export function resolveCourseGeometry(payload, courseId, coursePoint, existingObjects = [], siblingPoints = []) {
  const bundle = parseOsmGuideBundle(payload);
  const guides = chooseAutoMapGuides(bundle.guides, coursePoint, siblingPoints);
  const result = resolveGuidesIntoObjects(guides, courseId, bundle.greens, existingObjects, payload);
  return Object.assign(result, { guidesFound: bundle.guides.length, greensFound: bundle.greens.length, holesResolved: guides.length });
}
