/* Mapping overlay: hand-drawn course features the mapper reads as if OSM had them.
 *
 * Why this exists. The geometry resolver builds hole centre-lines from three things in the
 * Overpass payload - golf=hole ways, golf=fairway polygons, and greens to hang them off - and
 * numbers them from the scorecard. Royal Belfast is the shape of course that defeats it: OSM
 * carries eleven greens and nothing else. No fairways, no hole lines, so zero candidates, so
 * the run fails at "no numbered hole geometry" no matter how good the greens are.
 *
 * The fix is not another table of objects. objects_json is rewritten wholesale by every mapper
 * run and the resolver never reads it - it reads the payload. So the overlay is stored beside
 * the map and merged INTO the payload, as ordinary OSM-shaped elements, before anything looks
 * at it. Every downstream parser (guides, surfaces, the resolver) then sees a fairway it would
 * have seen had someone traced it in OSM, and nothing downstream needs to know the difference.
 *
 * Temporary by design: when OSM catches up, delete the overlay and the merge adds nothing.
 * Overlay elements carry a "clarity:overlay" tag and negative ids so they can never collide
 * with, or be mistaken for, a real OSM way.
 *
 * Feature shape (what course_map_overlays.features stores, and what Studio draws):
 *   { id: "f-1", kind: "fairway" | "hole" | "green" | "tee" | "bunker" | "water" | "trees" | "tree" | "hazard" | "waste", hole: 7 | null, points: [{lat, lng}, ...],
 *     source?: "ai", pin?: true }
 *   source says who produced the shape (gd-overlay-georef-core.mjs stamps "ai"; Studio stamps
 *   "wand" on a green the wand outlined from a pin; a hand-placed one has none). Display only - the mapper treats every feature the same.
 *
 *   fairway - a closed polygon (3+ points). Becomes golf=fairway. The resolver takes its major
 *             axis as the centre-line and links it to the nearest green (within 230m); the
 *             surface pass clones it onto the hole as a fairway_area for visuals and the bubble.
 *   hole    - a tee-to-green line (2+ points). Becomes golf=hole, with ref=<hole> when numbered.
 *             Quicker to draw than a polygon and, when numbered, the resolver's strongest
 *             evidence (osm-hole-line, existing-ref).
 *   green   - a closed polygon (3+ points). Becomes golf=green. For the greens OSM has not
 *             got at all (Royal Belfast has eleven of eighteen): a fairway with no green to
 *             link to is not a candidate, so the missing seven need their greens too.
 *   tee     - a closed polygon (3+ points). Becomes golf=tee. The resolver reads a tee near a
 *             green or fairway as course context, and the mapper writes tee objects from it.
 *   bunker  - a closed polygon (3+ points). Becomes golf=bunker, which the surface pass
 *             (enrichSurfaceObjects) writes onto the nearest hole as a bunker object. Placed
 *             with the bunker wand the same way a green is.
 *   water   - a closed polygon (3+ points). Becomes golf=water_hazard, which the surface pass
 *             writes onto the nearest hole as a water object (penalty area) and the resolver
 *             already reads as water. Drawn round by hand in Studio, or placed with the wand.
 *   trees   - a closed polygon (3+ points). Becomes natural=wood. Dense trees: the surface pass
 *             writes it onto every hole whose frame it falls in as a "trees" object, and the
 *             bubble reveals it like a bunker. Drawn round by hand, or stretched over a cluster as an
 *             oval - no wand, no pin.
 *   hazard  - a closed polygon (3+ points). Becomes golf=hazard (our tag, not OSM's - OSM has no
 *             generic non-water hazard). Gorse, scrub, a ravine: anything that punishes a ball
 *             and is not water. Same path as trees. Drawn round by hand only.
 *   tree    - a closed polygon (3+ points): one tree, a small ring round its crown. Becomes
 *             natural=tree. Placed with a click in Studio, or dropped in numbers by the tree
 *             finder. Nothing downstream reads single trees yet - they are kept so the course
 *             has them when tree rendering lands.
 *   waste   - a closed polygon (3+ points). Becomes golf=waste_area (our tag - OSM has none).
 *             Sandy, scrubby ground that is played as it lies. Drawn round and grown out to its
 *             edge, or picked with the colour wand. Not a surface the mapper writes yet.
 *
 *   hole numbers are optional on every kind. A numbered green or fairway is matched to that
 *   hole's guide (ref), a numbered hole line is the resolver's strongest evidence.
 *
 *   pin     - a placeholder put down quickly, to be shaped later: the centre of a green, tee,
 *             bunker or water hazard (one point), or a fairway's start and end (two points). Stored as pins so
 *             Studio can turn them into outlines afterwards; in the payload each pin becomes the
 *             plain default shape for its kind (pinShape), so a course pinned and nothing more
 *             still gives the resolver greens to hang fairways off.
 */

export const OVERLAY_KINDS = new Set(["fairway", "hole", "green", "tee", "bunker", "water", "trees", "tree", "hazard", "waste"]);
const POLYGON_KINDS = new Set(["fairway", "green", "tee", "bunker", "water", "trees", "tree", "hazard", "waste"]);
/* The tag each kind is written as: golf=<kind> unless listed here. */
const OSM_TAG = { water: ["golf", "water_hazard"], trees: ["natural", "wood"], tree: ["natural", "tree"], hazard: ["golf", "hazard"], waste: ["golf", "waste_area"] };
export function overlayKindIsPolygon(kind) { return POLYGON_KINDS.has(String(kind || "").toLowerCase()); }
/* Room for a whole course placed as pins - 18 greens, fairways and tees plus the bunkers - and
   the single trees the tree finder drops, a few hundred of them, with space to spare. */
export const OVERLAY_MAX_FEATURES = 600;
export const OVERLAY_MAX_POINTS = 64;
export const OVERLAY_TAG = "clarity:overlay";

/* How many points a pin of each kind holds. A hole line has no pin form. */
export const OVERLAY_PIN_POINTS = { fairway: 2, green: 1, tee: 1, bunker: 1, water: 1 };
/* The default shape a pin stands for. Same sizes Studio's shape builders use for a pin it
   cannot read (map-overlay-shapes.js FAIRWAY_WIDTH_M / GREEN_RADIUS_M / BUNKER_RADIUS_M /
   WATER_RADIUS_M). */
const PIN_RADIUS_M = { green: 14, tee: 6, bunker: 6, water: 15 };
const PIN_FAIRWAY_WIDTH_M = 35;
const M_PER_DEG = 111320;

/* Ids start well below anything Overpass hands out (its ids are positive) and stay stable per
   feature index so a merge into two payloads in one job dedupes on the same key. */
const OVERLAY_ID_BASE = -900000000;

function num(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }

function cleanPoint(raw) {
  if (!raw) return null;
  const lat = num(Array.isArray(raw) ? raw[0] : raw.lat);
  const lng = num(Array.isArray(raw) ? raw[1] : (raw.lng != null ? raw.lng : raw.lon));
  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

export function validHoleNumber(value) {
  const n = num(value);
  return n != null && Number.isInteger(n) && n >= 1 && n <= 36 ? n : null;
}

/* One feature, cleaned, or null when it cannot mean anything on the ground. A fairway needs
   three distinct corners to be an area; a hole line needs two ends. A closing point that
   repeats the first is dropped so the stored ring is open like every other shape here. */
export function normalizeOverlayFeature(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  const kind = String(raw.kind || "").toLowerCase();
  if (!OVERLAY_KINDS.has(kind)) return null;
  const polygon = overlayKindIsPolygon(kind);
  const pin = raw.pin === true && Object.prototype.hasOwnProperty.call(OVERLAY_PIN_POINTS, kind);
  const points = (Array.isArray(raw.points) ? raw.points : []).map(cleanPoint).filter(Boolean).slice(0, OVERLAY_MAX_POINTS);
  if (pin) {
    if (points.length < OVERLAY_PIN_POINTS[kind]) return null;
    points.length = OVERLAY_PIN_POINTS[kind];
  } else {
    if (points.length > 3 && polygon) {
      const first = points[0], last = points[points.length - 1];
      if (Math.abs(first.lat - last.lat) < 1e-7 && Math.abs(first.lng - last.lng) < 1e-7) points.pop();
    }
    if (points.length < (polygon ? 3 : 2)) return null;
  }
  const id = String(raw.id || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 40) || ("f-" + (index + 1));
  const source = String(raw.source || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 24);
  const feature = { id, kind, hole: validHoleNumber(raw.hole), points };
  if (source) feature.source = source;
  if (pin) feature.pin = true;
  return feature;
}

export function normalizeOverlayFeatures(raw) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.features) ? raw.features : []);
  const seen = new Set();
  const out = [];
  list.slice(0, OVERLAY_MAX_FEATURES).forEach((item, index) => {
    const feature = normalizeOverlayFeature(item, index);
    if (!feature) return;
    /* Two features with one id would dedupe to one OSM element and silently lose a hole. */
    while (seen.has(feature.id)) feature.id = feature.id + "-" + (index + 1);
    seen.add(feature.id);
    out.push(feature);
  });
  return out;
}

/* A pin's default shape, in flat-earth metres about its first point: a round green, tee or
   bunker on its centre, or a fairway of the default width along the line from start to end with
   a point beyond each end, so its long axis is the line the resolver takes as the centre-line. */
export function pinShape(feature) {
  const origin = feature.points[0];
  const k = Math.cos(origin.lat * Math.PI / 180);
  const toXY = p => ({ x: (p.lng - origin.lng) * M_PER_DEG * k, y: (p.lat - origin.lat) * M_PER_DEG });
  const toLL = v => ({ lat: origin.lat + v.y / M_PER_DEG, lng: origin.lng + v.x / (M_PER_DEG * k) });
  if (feature.kind === "fairway") {
    const b = toXY(feature.points[1]);
    const length = Math.hypot(b.x, b.y);
    const d = length > 1e-6 ? { x: b.x / length, y: b.y / length } : { x: 0, y: 1 };
    const n = { x: -d.y, y: d.x };
    const half = PIN_FAIRWAY_WIDTH_M / 2;
    const at = (along, across) => toLL({ x: d.x * along + n.x * across, y: d.y * along + n.y * across });
    return [at(-half / 2, 0), at(0, -half), at(length, -half), at(length + half / 2, 0), at(length, half), at(0, half)];
  }
  const r = PIN_RADIUS_M[feature.kind] || PIN_RADIUS_M.green;
  const out = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    out.push(toLL({ x: Math.cos(a) * r, y: Math.sin(a) * r }));
  }
  return out;
}

/* The overlay as Overpass would have returned it: one way per feature, geometry as {lat,lon},
   a polygon ring closed the way OSM closes areas. The tag set is exactly what the parsers key
   on (golf=fairway / golf=hole / golf=green / golf=water_hazard + ref) plus the overlay marker. */
export function overlayToOsmElements(features) {
  return normalizeOverlayFeatures(features).map((feature, index) => {
    const [key, value] = OSM_TAG[feature.kind] || ["golf", feature.kind];
    const tags = { [OVERLAY_TAG]: feature.id, [key]: value };
    if (feature.hole) tags.ref = String(feature.hole);
    const points = feature.pin ? pinShape(feature) : feature.points;
    const geometry = points.map(p => ({ lat: p.lat, lon: p.lng }));
    if (overlayKindIsPolygon(feature.kind)) geometry.push({ lat: points[0].lat, lon: points[0].lng });
    return { type: "way", id: OVERLAY_ID_BASE - index, tags, geometry };
  });
}

export function isOverlayElement(element) {
  return !!(element && element.tags && element.tags[OVERLAY_TAG]);
}

/* Overlay elements go onto the payload, never in place of it. Real OSM data always wins a
   duplicate key, and an empty overlay leaves the payload untouched - including the object
   identity, so callers comparing payloads before and after see no phantom change. */
export function mergeOverlayIntoPayload(payload, features) {
  const extra = overlayToOsmElements(features);
  if (!extra.length) return payload;
  const elements = ((payload && payload.elements) || []).slice();
  const seen = new Set(elements.map(e => (e && e.id != null) ? String(e.type || "way") + "/" + e.id : null).filter(Boolean));
  extra.forEach(element => {
    const key = "way/" + element.id;
    if (seen.has(key)) return;
    seen.add(key);
    elements.push(element);
  });
  return Object.assign({}, payload || {}, { elements });
}

/* What a job row says about the overlay it ran with. Counts, not shapes: the row is read by a
   person asking "did the overlay reach the mapper", and the shapes are one query away. */
export function overlaySummary(features) {
  const list = normalizeOverlayFeatures(features);
  return {
    features: list.length,
    fairways: list.filter(f => f.kind === "fairway").length,
    holeLines: list.filter(f => f.kind === "hole").length,
    greens: list.filter(f => f.kind === "green").length,
    tees: list.filter(f => f.kind === "tee").length,
    bunkers: list.filter(f => f.kind === "bunker").length,
    water: list.filter(f => f.kind === "water").length,
    trees: list.filter(f => f.kind === "trees").length,
    singleTrees: list.filter(f => f.kind === "tree").length,
    hazards: list.filter(f => f.kind === "hazard").length,
    waste: list.filter(f => f.kind === "waste").length,
    pins: list.filter(f => f.pin).length,
    numbered: list.filter(f => f.hole).length
  };
}
