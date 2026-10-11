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
 *     link?: "l-abc", source?: "ai", pin?: true, osm?: "way/123" }
 *   osm says the shape was converted from that OSM element (osmToOverlayFeatures) so it can be
 *   tweaked. The converted shape REPLACES the element: mergeOverlayIntoPayload drops every OSM
 *   element an overlay shape was made from, so the mapper reads the tweaked shape, not both.
 *   link groups shapes that belong to one hole (Studio's Link tool) without numbering them.
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
 *             edge, or picked with the colour wand. The surface pass writes it onto the
 *             nearest hole as a "waste" object, and the bubble reveals it like a bunker.
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

import { osmAreaRings, coursePlayPoints, pointInShape, greenShapeSpan, osmGuideHoleRef, SURFACE_SPAN_LIMITS_M, OSM_AUTO_GREEN_MAX_SPAN_M, FAIRWAY_FILL_SOURCE } from "./gd-automapper-core.mjs";

export const OVERLAY_KINDS = new Set(["fairway", "hole", "green", "tee", "bunker", "water", "trees", "tree", "hazard", "waste"]);
const POLYGON_KINDS = new Set(["fairway", "green", "tee", "bunker", "water", "trees", "tree", "hazard", "waste"]);
/* The tag each kind is written as: golf=<kind> unless listed here. */
const OSM_TAG = { water: ["golf", "water_hazard"], trees: ["natural", "wood"], tree: ["natural", "tree"], hazard: ["golf", "hazard"], waste: ["golf", "waste_area"] };
export function overlayKindIsPolygon(kind) { return POLYGON_KINDS.has(String(kind || "").toLowerCase()); }
/* Room for a whole course placed as pins - 18 greens, fairways and tees plus the bunkers - and
   the single trees the tree finder drops, a few hundred of them. Or a well-mapped course
   converted from OSM: a 36-hole site carries 200 bunkers and 200 tee boxes on its own. */
export const OVERLAY_MAX_FEATURES = 1200;
/* A wand outline keeps enough corners to follow the ground (Studio's DETAIL_MAX_POINTS is 220),
   with room to reshape. The mapper still thins surfaces to SURFACE_SHAPE_MAX_POINTS for the
   course package; this is what the overlay itself holds. */
export const OVERLAY_MAX_POINTS = 256;
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
  const link = String(raw.link || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 40);
  const feature = { id, kind, hole: validHoleNumber(raw.hole), points };
  if (link) feature.link = link;
  if (source) feature.source = source;
  if (pin) feature.pin = true;
  const osm = String(raw.osm || "");
  if (/^(way|relation)\/\d+$/.test(osm)) feature.osm = osm;
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
  const list = normalizeOverlayFeatures(features);
  const linkHole = linkedHoleNumbers(list);
  return list.map((feature, index) => {
    const [key, value] = OSM_TAG[feature.kind] || ["golf", feature.kind];
    const tags = { [OVERLAY_TAG]: feature.id, [key]: value };
    const hole = feature.hole || (feature.link && linkHole[feature.link]) || null;
    if (hole) tags.ref = String(hole);
    /* The resolver pairs a link's green, fairway and tee as one hole whether numbered or not. */
    if (feature.link) tags["clarity:link"] = feature.link;
    const points = feature.pin ? pinShape(feature) : feature.points;
    const geometry = points.map(p => ({ lat: p.lat, lon: p.lng }));
    if (overlayKindIsPolygon(feature.kind)) geometry.push({ lat: points[0].lat, lon: points[0].lng });
    return { type: "way", id: OVERLAY_ID_BASE - index, tags, geometry };
  }).concat(derivedHoleLines(list, linkHole));
}

/* A numbered hole drawn as shapes, turned into the line the mapper numbers holes by.
 *
 * The automapper's first pass only reads hole numbers off golf=hole lines (parseOsmHoleGuides).
 * A person who outlined a tee and a green and typed "7" on them has said exactly what a
 * numbered hole line says - but with no line, the first pass found nothing, the run fell to
 * the resolver, and the resolver numbered the holes by scorecard length and lost the ones it
 * could not place (Royal Belfast, 49 numbered shapes, 16 of 18 holes). So each hole number
 * that has one green and at least one tee, and no hole line drawn for it, gets a line from the
 * tee through its fairway(s) to the green, tagged ref=<hole>. The back tee is used when there
 * are several, since that is the hole's full length. Two greens on one number is a mistake we
 * cannot pick between, so that hole gets no line and is left to the resolver. */
export const DERIVED_TAG = "clarity:derived";

function centreOf(feature) {
  const points = feature.pin ? pinShape(feature) : feature.points;
  const sum = points.reduce((acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }), { lat: 0, lng: 0 });
  return { lat: sum.lat / points.length, lng: sum.lng / points.length };
}

function flatDistance(a, b) {
  const k = Math.cos(a.lat * Math.PI / 180);
  return Math.hypot((a.lng - b.lng) * M_PER_DEG * k, (a.lat - b.lat) * M_PER_DEG);
}

export function derivedHoleLines(features, linkHole) {
  const byHole = {};
  features.forEach(feature => {
    const hole = feature.hole || (feature.link && linkHole[feature.link]) || null;
    if (!hole) return;
    const entry = byHole[hole] = byHole[hole] || { greens: [], tees: [], fairways: [], line: false };
    if (feature.kind === "hole") entry.line = true;
    else if (feature.kind === "green") entry.greens.push(feature);
    else if (feature.kind === "tee") entry.tees.push(feature);
    else if (feature.kind === "fairway") entry.fairways.push(feature);
  });
  return Object.keys(byHole).map(Number).sort((a, b) => a - b).map(hole => {
    const entry = byHole[hole];
    if (entry.line || entry.greens.length !== 1 || !entry.tees.length) return null;
    const green = centreOf(entry.greens[0]);
    const tee = entry.tees.map(centreOf).sort((a, b) => flatDistance(b, green) - flatDistance(a, green))[0];
    const fairways = entry.fairways.map(centreOf).sort((a, b) => flatDistance(a, tee) - flatDistance(b, tee));
    const geometry = [tee].concat(fairways, [green]).map(p => ({ lat: p.lat, lon: p.lng }));
    return {
      type: "way",
      id: OVERLAY_ID_BASE - OVERLAY_MAX_FEATURES - hole,
      tags: { [OVERLAY_TAG]: "hole-line-" + hole, [DERIVED_TAG]: "hole-line", golf: "hole", ref: String(hole) },
      geometry
    };
  }).filter(Boolean);
}

/* A link says "these shapes are one hole" - it never says which. The resolver keeps a link's
   shapes together (gd-geometry-resolver-core.mjs, LINK_TAG). Only when a group carries
   exactly one hole number that a person typed does the rest of the group take it; a group
   with no number, or with two different ones, is left for the scorecard to number. */
export function linkedHoleNumbers(features) {
  const seen = {};
  (features || []).forEach(f => {
    if (!f.link || !f.hole) return;
    (seen[f.link] = seen[f.link] || new Set()).add(f.hole);
  });
  const out = {};
  Object.keys(seen).forEach(link => { if (seen[link].size === 1) out[link] = [...seen[link]][0]; });
  return out;
}

export function isOverlayElement(element) {
  return !!(element && element.tags && element.tags[OVERLAY_TAG]);
}

/* Overlay elements go onto the payload, never in place of it. Real OSM data always wins a
   duplicate key, and an empty overlay leaves the payload untouched - including the object
   identity, so callers comparing payloads before and after see no phantom change. */
export function mergeOverlayIntoPayload(payload, features) {
  /* OSM elements an overlay shape was converted from are replaced by it. */
  const replaced = new Set(normalizeOverlayFeatures(features).map(f => f.osm).filter(Boolean));
  const elements = ((payload && payload.elements) || [])
    .filter(e => !(e && replaced.has(String(e.type || "way") + "/" + e.id)));
  /* A hole OSM already numbers keeps OSM's line; a derived one is only for the holes it lacks. */
  const osmNumbered = new Set(elements
    .filter(e => e && e.tags && String(e.tags.golf || "").toLowerCase() === "hole" && !isOverlayElement(e))
    .map(e => validHoleNumber((String(e.tags.ref || e.tags.name || "").match(/\d+/) || [])[0]))
    .filter(Boolean));
  const extra = overlayToOsmElements(features)
    .filter(e => !(e.tags[DERIVED_TAG] && osmNumbered.has(Number(e.tags.ref))));
  if (!extra.length) return payload;
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
    numbered: list.filter(f => f.hole).length,
    linked: list.filter(f => f.link).length
  };
}

/* ---------- OSM -> overlay: making what OSM has editable --------------------------------

   OSM's greens, tees, fairways, bunkers, water and woods, as overlay shapes - so Studio can
   reshape them like anything drawn by hand. Each keeps the OSM element it came from (osm), and
   once saved it stands in for that element (mergeOverlayIntoPayload). Hole lines are left in
   OSM: play orders refer to them by their OSM id.

   The same size checks the mapper applies are applied here, so nothing is offered that the
   mapper would have thrown away - including a wood drawn round the whole course.

   Default fairways (the mapper's FAIRWAY_FILL_SOURCE objects, for holes OSM has no fairway on)
   come too, numbered to their hole: drawn in, they become the hole's real fairway.

   Shapes already in the overlay are not offered again - matched on id, or on lying inside a
   shape of the same kind someone has already drawn. */
const OSM_TO_OVERLAY_KIND = { green: "green", tee: "tee", fairway: "fairway", bunker: "bunker", water_hazard: "water", lateral_water_hazard: "water" };
const KIND_SPAN_TYPE = { green: null, tee: null, fairway: "fairway_area", bunker: "bunker", water: "water", trees: "trees" };

function overlayKindForOsm(element) {
  const tags = (element && element.tags) || {};
  if (tags[OVERLAY_TAG]) return null;
  const golf = String(tags.golf || "").toLowerCase();
  if (golf) return OSM_TO_OVERLAY_KIND[golf] || null;
  const natural = String(tags.natural || "").toLowerCase();
  if (natural === "wood" || String(tags.landuse || "").toLowerCase() === "forest") return "trees";
  if (natural === "water" || tags.water) return "water";
  return null;
}

function thinRing(ring) {
  if (ring.length <= OVERLAY_MAX_POINTS) return ring;
  const step = ring.length / OVERLAY_MAX_POINTS;
  return Array.from({ length: OVERLAY_MAX_POINTS }, (_, i) => ring[Math.floor(i * step)]);
}

function centreOfRing(points) {
  const sum = points.reduce((acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }), { lat: 0, lng: 0 });
  return { lat: sum.lat / points.length, lng: sum.lng / points.length };
}

export function osmToOverlayFeatures(payload, existing = [], savedObjects = []) {
  const have = normalizeOverlayFeatures(existing);
  const ids = new Set(have.map(f => f.id));
  const covered = (kind, centre) => have.some(f => f.kind === kind && !f.pin && overlayKindIsPolygon(kind) && pointInShape(centre, f.points));
  const out = [];
  const offer = feature => {
    if (ids.has(feature.id) || covered(feature.kind, centreOfRing(feature.points))) return;
    ids.add(feature.id);
    out.push(feature);
  };
  let playPoints = null;
  ((payload && payload.elements) || []).forEach(element => {
    const kind = overlayKindForOsm(element);
    if (!kind || element.id == null) return;
    const key = String(element.type || "way") + "/" + element.id;
    const hole = kind === "trees" || kind === "water" ? null : validHoleNumber(osmGuideHoleRef(element.tags.ref || element.tags.name));
    osmAreaRings(element).outers.forEach((ring, index) => {
      const span = greenShapeSpan(ring);
      if (kind === "green" && (span < 5 || span > OSM_AUTO_GREEN_MAX_SPAN_M)) return;
      const limits = SURFACE_SPAN_LIMITS_M[KIND_SPAN_TYPE[kind]];
      if (limits && (!Number.isFinite(span) || span < limits.min || span > limits.max)) return;
      if (kind === "trees") {
        playPoints = playPoints || coursePlayPoints(payload);
        if (playPoints.some(point => pointInShape(point, ring))) return;
      }
      const id = ("osm-" + key.replace("/", "-") + (index ? "-" + index : "")).slice(0, 40);
      offer({ id, kind, hole, points: thinRing(ring.map(p => ({ lat: p.lat, lng: p.lng }))), source: "osm", osm: key });
    });
  });
  /* Default fairways: one per piece, numbered to the hole it was laid for ("fill/7#1"). */
  const seen = new Set();
  (savedObjects || []).forEach(object => {
    if (!object || object.source !== FAIRWAY_FILL_SOURCE || !Array.isArray(object.shape)) return;
    const match = /^fill\/(\d+)(?:#(\d+))?$/.exec(String(object.osmId || ""));
    if (!match || Number(match[1]) !== validHoleNumber(object.holeNumber) || seen.has(object.osmId)) return;
    seen.add(object.osmId);
    const points = object.shape.map(cleanPoint).filter(Boolean);
    if (points.length < 3) return;
    offer({ id: "auto-fairway-" + match[1] + (match[2] ? "-" + match[2] : ""), kind: "fairway", hole: Number(match[1]), points, source: "auto" });
  });
  return out;
}
