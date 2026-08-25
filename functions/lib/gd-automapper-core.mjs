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

export function courseFootprintFrame(payload, padM = 160) {
  const pts = [];
  ((payload && payload.elements) || []).filter(isCourseFootprintElement).forEach(element => {
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

function assignByContainment(features, polygons) {
  /* Smallest containing polygon wins: a site often maps one facility outline
     over two course outlines, and the course is the tighter of the two. */
  const areaRank = polygons.map(polygon => ({
    polygon,
    span: spanOfRing(polygon.ring)
  })).sort((a, b) => a.span - b.span);
  const buckets = new Map();
  let placed = 0;
  features.forEach(feature => {
    const hit = areaRank.find(entry => pointInRing(feature.centre, entry.polygon.ring));
    if (!hit) return;
    if (!buckets.has(hit.polygon.ref)) buckets.set(hit.polygon.ref, { polygon: hit.polygon, features: [] });
    buckets.get(hit.polygon.ref).features.push(feature);
    placed += 1;
  });
  if (buckets.size < 2 || placed < features.length * 0.6) return null;
  return [...buckets.values()].map(bucket => ({
    name: bucket.polygon.name,
    osmRef: bucket.polygon.ref,
    holesTag: bucket.polygon.holesTag,
    features: bucket.features,
    method: "containment"
  }));
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

export function separateLoops(payload, centre) {
  const features = holeFeatures(payload);
  if (!features.length) return null;

  const collision = detectHoleNumberCollision(payload);
  const polygons = coursePolygonsFrom(payload);
  const groups = assignByContainment(features, polygons) || assignByRouting(features, collision.loops);
  if (!groups || groups.length < 2) return null;

  const { buckets, shared } = partitionSupportingElements(payload, groups);

  const loops = groups.map((group, index) => {
    const numbers = group.features.map(feature => feature.number);
    const loopCentre = centroidOfPoints(group.features.map(feature => feature.centre));
    return {
      name: group.name,
      osmRef: group.osmRef,
      holesTag: group.holesTag,
      method: group.method,
      centre: loopCentre,
      holeNumbers: [...new Set(numbers)].sort((a, b) => a - b),
      contiguous: loopIsContiguous(numbers),
      awayFromPinM: loopCentre && centre ? Math.round(distance(centre, loopCentre)) : null,
      payload: Object.assign({}, payload, {
        elements: group.features.map(feature => feature.element).concat(buckets[index], shared)
      })
    };
  });

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
