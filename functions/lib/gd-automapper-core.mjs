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
export const OBJECT_DEDUPE_RADIUS_M = { green: 26, bunker: 14, tee: 9, fairway: 12, default: 10 }; // :39

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

export function slug(s) {
  return String(s || "item").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item";
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

export function expandOsmFrame(frame, padM = 0) {
  const f = normalizedOsmFrame(frame);
  if (!f) return null;
  const centerLat = (f.south + f.north) / 2;
  const latPad = padM / 111320;
  const lngPad = padM / (111320 * Math.max(0.2, Math.cos(centerLat * Math.PI / 180)));
  return { south: f.south - latPad, west: f.west - lngPad, north: f.north + latPad, east: f.east + lngPad };
}

function isCourseFootprintElement(element) {
  const t = (element && element.tags) || {};
  return String(t.golf || "").toLowerCase() === "course" || String(t.leisure || "").toLowerCase() === "golf_course";
}

export function courseFootprintFrame(payload, padM = 160) {
  const pts = [];
  ((payload && payload.elements) || []).filter(isCourseFootprintElement).forEach(element => {
    osmGuidePointsFromElement(element).forEach(p => pts.push(p));
  });
  if (!pts.length) return null;
  let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
  pts.forEach(p => {
    south = Math.min(south, p.lat); north = Math.max(north, p.lat);
    west = Math.min(west, p.lng); east = Math.max(east, p.lng);
  });
  return expandOsmFrame({ south, west, north, east }, padM);
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
  return "[out:json][timeout:18];(" + selectors.map(([type, key, value]) => type + selector + '["' + key + '"="' + value + '"];').join("") + ");out geom tags;";
}

/* ---------- OSM payload parsing (gd-course-library-pin-lock.js:1966-2039) ------------------ */

export function osmGuideHoleRef(value) {
  const direct = validHoleNumber(value);
  if (direct) return direct;
  const match = String(value || "").match(/\d+/);
  return match ? validHoleNumber(match[0]) : null;
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

export function cleanOsmShape(points) {
  const clean = (points || []).map(toPlain).filter(p => Number.isFinite(p && p.lat) && Number.isFinite(p && p.lng));
  if (clean.length > 3 && distance(clean[0], clean[clean.length - 1]) < 1) clean.pop();
  return clean.length >= 3 ? clean : null;
}

export function shapeCentroid(shape) {
  const pts = cleanOsmShape(shape);
  if (!pts) return null;
  let lat = 0, lng = 0;
  pts.forEach(p => { lat += Number(p.lat); lng += Number(p.lng); });
  return { lat: lat / pts.length, lng: lng / pts.length };
}

export function greenShapeSpan(shape, center = shapeCentroid(shape)) {
  if (!center) return Infinity;
  return Math.max(...(shape || []).map(p => distance(center, p)).filter(Number.isFinite), 0) * 2;
}

export function osmGreenShapeFromElement(element) {
  if (String((element && element.tags && element.tags.golf) || "").toLowerCase() !== "green") return null;
  const direct = cleanOsmShape(osmGuidePointsFromElement(element));
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

export function nearestMatchingObject(objects, type, center, maxDistance = objectDedupeRadius(type)) {
  if (!center) return null;
  let best = null;
  objects.filter(o => o && o.type === type).forEach(object => {
    const d = distance(objectCenter(object), center);
    if (d <= maxDistance && (!best || d < best.distance)) best = { object, distance: d };
  });
  return best ? best.object : null;
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
  const existing = nearestMatchingObject(objects, input.type, position, input.maxDedupeDistanceM || objectDedupeRadius(input.type));
  const id = (existing && existing.id) || nextObjectId(input.type);
  const hole = validHoleNumber(input.holeNumber);
  const record = Object.assign({}, existing || {}, {
    id,
    courseId: input.courseId,
    type: input.type,
    position,
    shape: input.shape || (existing && existing.shape) || null,
    holeNumber: hole,
    confirmed: !!(input.confirmed || (existing && existing.confirmed)),
    source: input.source || (existing && existing.source) || "unknown",
    greenCenter: input.type === "green" ? position : undefined,
    greenShape: input.type === "green" ? (input.shape || (existing && existing.shape) || null) : undefined,
    greenSource: input.type === "green" ? (input.source || (existing && existing.source) || "unknown") : undefined,
    createdAt: (existing && existing.createdAt) || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
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
  const greenShape = (match && match.green && match.green.shape) || fallbackGreenShape(greenCenter, 16, 40);
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

export function resolveGuidesIntoObjects(guides, courseId, greens, existingObjects = []) {
  const objects = (existingObjects || []).map(o => Object.assign({}, o));
  let saved = 0, polygons = 0, fallbacks = 0;
  assignGreensToGuides(guides, greens).forEach(({ guide, match }) => {
    const result = resolveGuideObjects(objects, courseId, guide, match);
    saved += result.saved;
    if (result.greenPolygon) polygons++;
    if (result.fallback) fallbacks++;
  });
  const objectsMap = {};
  objects.forEach(object => { objectsMap[object.id] = object; });
  const holes = {};
  objects.filter(o => o.type === "green" && o.confirmed && validHoleNumber(o.holeNumber)).forEach(green => {
    holes[green.holeNumber] = asGreenRecord(green);
  });
  return { objects: objectsMap, holes, saved, polygons, fallbacks };
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
  const result = resolveGuidesIntoObjects(guides, courseId, bundle.greens, existingObjects);
  return Object.assign(result, { guidesFound: bundle.guides.length, greensFound: bundle.greens.length, holesResolved: guides.length });
}
