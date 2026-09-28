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
 *   { id: "f-1", kind: "fairway" | "hole" | "green", hole: 7 | null, points: [{lat, lng}, ...],
 *     source?: "ai" }
 *   source says who produced the shape (gd-overlay-georef-core.mjs stamps "ai"; a hand-drawn
 *   one has none). Display only - the mapper treats every feature the same.
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
 */

export const OVERLAY_KINDS = new Set(["fairway", "hole", "green", "tee"]);
const POLYGON_KINDS = new Set(["fairway", "green", "tee"]);
export function overlayKindIsPolygon(kind) { return POLYGON_KINDS.has(String(kind || "").toLowerCase()); }
export const OVERLAY_MAX_FEATURES = 80;
export const OVERLAY_MAX_POINTS = 64;
export const OVERLAY_TAG = "clarity:overlay";

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
  const points = (Array.isArray(raw.points) ? raw.points : []).map(cleanPoint).filter(Boolean).slice(0, OVERLAY_MAX_POINTS);
  if (points.length > 3 && polygon) {
    const first = points[0], last = points[points.length - 1];
    if (Math.abs(first.lat - last.lat) < 1e-7 && Math.abs(first.lng - last.lng) < 1e-7) points.pop();
  }
  if (points.length < (polygon ? 3 : 2)) return null;
  const id = String(raw.id || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 40) || ("f-" + (index + 1));
  const source = String(raw.source || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 24);
  const feature = { id, kind, hole: validHoleNumber(raw.hole), points };
  if (source) feature.source = source;
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

/* The overlay as Overpass would have returned it: one way per feature, geometry as {lat,lon},
   a polygon ring closed the way OSM closes areas. The tag set is exactly what the parsers key
   on (golf=fairway / golf=hole / golf=green + ref) plus the overlay marker. */
export function overlayToOsmElements(features) {
  return normalizeOverlayFeatures(features).map((feature, index) => {
    const tags = { [OVERLAY_TAG]: feature.id, golf: feature.kind };
    if (feature.hole) tags.ref = String(feature.hole);
    const geometry = feature.points.map(p => ({ lat: p.lat, lon: p.lng }));
    if (overlayKindIsPolygon(feature.kind)) geometry.push({ lat: feature.points[0].lat, lon: feature.points[0].lng });
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
    numbered: list.filter(f => f.hole).length
  };
}
