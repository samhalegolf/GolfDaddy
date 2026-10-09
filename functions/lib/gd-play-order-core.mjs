/* Play orders: courses built by hand from the holes on the ground.
 *
 * The automatic split (separateLoops and the listing/structure logic around it) works out the
 * courses at a site from hole numbers and geometry. Where it gets it wrong - Billingbear Park,
 * two nines numbered 1-9 twice, published as one nine - an admin says it outright in the
 * Mapping Overlay: a named play order, and its holes in the order they are played. A hole can
 * be in several play orders, so two 18s over the same three nines are just three play orders.
 *
 * A hole reference is one of:
 *   "osm:way/123"   an OSM golf=hole line, as Overpass returned it
 *   "link:l-abc"    the overlay shapes linked as one hole (Studio's Link tool): a hand-drawn
 *                   hole line if the link has one, else a line from its back tee through its
 *                   fairways to its green
 *
 * Stored on the overlay row (course_map_overlays.play_orders,
 * supabase/migrations/20261009_add_course_map_overlay_play_orders.sql) and read by the mapper
 * only when the overlay is ready, like the shapes. */

import { OVERLAY_TAG, derivedHoleLines, normalizeOverlayFeatures, isOverlayElement } from "./gd-map-overlay-core.mjs";

export const PLAY_ORDER_MAX = 12;
export const PLAY_ORDER_MAX_HOLES = 36;
const NAME_MAX = 80;

const OSM_REF = /^osm:(way|relation)\/(\d{1,15})$/;
const LINK_REF = /^link:([a-z0-9_-]{1,40})$/i;

/* Hole lines built here sit below the overlay's own ids and its derived lines. */
const PLAY_ORDER_LINE_ID_BASE = -910000000;

export function validHoleRef(value) {
  const ref = String(value || "").trim();
  return OSM_REF.test(ref) || LINK_REF.test(ref) ? ref : null;
}

function slugPart(value) {
  return String(value || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90);
}

/* Cleans what Studio sends and gives every play order a course id that then never changes.
 *
 * The pinned course - the row the overlay belongs to - is one of the play orders: the one
 * already holding its id, else the first. Every other play order gets an id under the pinned
 * one ("billingbear-park-new-course"), minted from its name the first time it is saved. A
 * rename keeps the id, so a course's rounds, visuals and watch maps stay with it. An id from
 * outside this facility is never accepted: it could overwrite another club's course. */
export function normalizePlayOrders(raw, pinnedCourseId) {
  const pinned = slugPart(pinnedCourseId);
  const list = (Array.isArray(raw) ? raw : []).slice(0, PLAY_ORDER_MAX);
  const seenIds = new Set();
  const out = [];
  list.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    let id = String(item.id || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 40) || ("po-" + (index + 1));
    while (seenIds.has(id)) id = id + "-" + (index + 1);
    seenIds.add(id);
    const name = String(item.name || "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
    const holes = [];
    (Array.isArray(item.holes) ? item.holes : []).forEach(ref => {
      const clean = validHoleRef(ref);
      if (clean && holes.length < PLAY_ORDER_MAX_HOLES) holes.push(clean);
    });
    const courseId = slugPart(item.courseId);
    const ours = courseId && pinned && (courseId === pinned || courseId.startsWith(pinned + "-"));
    out.push({ id, name: name || "Play order " + (index + 1), courseId: ours ? courseId : "", holes });
  });
  if (!pinned) return out;
  const taken = new Set();
  /* The pinned id goes to the play order that has it, else the first. */
  const holder = out.find(order => order.courseId === pinned) || out[0];
  out.forEach(order => {
    if (order !== holder && order.courseId === pinned) order.courseId = "";
  });
  if (holder) { holder.courseId = pinned; taken.add(pinned); }
  out.forEach(order => {
    if (order === holder) return;
    if (order.courseId && !taken.has(order.courseId)) { taken.add(order.courseId); return; }
    const base = slugPart(pinned + "-" + (slugPart(order.name) || "course"));
    let candidate = base, n = 2;
    while (taken.has(candidate)) candidate = base + "-" + n++;
    order.courseId = candidate;
    taken.add(candidate);
  });
  return out;
}

function isHoleWay(element) {
  return !!(element && element.tags && String(element.tags.golf || "").toLowerCase() === "hole");
}

function lineCentre(element) {
  const pts = (element.geometry || []).filter(p => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)));
  if (!pts.length) return null;
  return { lat: pts.reduce((s, p) => s + Number(p.lat), 0) / pts.length, lng: pts.reduce((s, p) => s + Number(p.lon), 0) / pts.length };
}

/* The hole line a link stands for, numbered `position`: its own hand-drawn line if it has one,
   else the tee-to-green line derivedHoleLines builds for one green and at least one tee. */
function linkHoleLine(members, position) {
  const drawn = members.find(f => f.kind === "hole");
  if (drawn) {
    return {
      type: "way",
      id: PLAY_ORDER_LINE_ID_BASE - position,
      tags: { [OVERLAY_TAG]: drawn.id, golf: "hole", ref: String(position) },
      geometry: drawn.points.map(p => ({ lat: p.lat, lon: p.lng }))
    };
  }
  const numbered = members.map(f => Object.assign({}, f, { hole: position, link: undefined }));
  const line = derivedHoleLines(numbered, {})[0];
  if (!line) return null;
  return Object.assign({}, line, { id: PLAY_ORDER_LINE_ID_BASE - position, tags: Object.assign({}, line.tags, { ref: String(position) }) });
}

function missingReason(members) {
  if (!members.length) return "link-not-found";
  const greens = members.filter(f => f.kind === "green").length;
  if (greens !== 1) return greens ? "link-has-two-greens" : "link-has-no-green";
  return "link-has-no-tee";
}

/* One play order's payload: the site's payload with every hole line and every hole number taken
 * out, then this play order's holes put back as golf=hole lines numbered 1..n in its order.
 *
 * Every number goes because the numbers on the ground are exactly what was wrong: a green OSM
 * tagged ref=3 on the other nine would refuse to sit on this course's hole 3
 * (bestOsmGreenForGuide skips a green whose ref disagrees). With no numbers left, greens, tees
 * and fairways attach to the hole lines by where they are, the way the resolver already
 * attaches unnumbered ones. A linked overlay hole's own shapes take its new number, so its
 * green is matched by number, not just by distance.
 *
 * Bunkers, water and trees from the whole site stay in: each lands on whichever hole's frame
 * it falls in, which is the same rule a single-course run uses.
 *
 * Returns { payload, centre, holes: [{position, ref, found, reason?}] }. */
export function playOrderPayload(payload, overlayFeatures, playOrder) {
  const features = normalizeOverlayFeatures(overlayFeatures);
  const source = (payload && payload.elements) || [];
  const byOsmKey = new Map(source.filter(e => e && !isOverlayElement(e)).map(e => [String(e.type || "way") + "/" + e.id, e]));
  const linkMembers = new Map();
  features.forEach(f => { if (f.link) (linkMembers.get(f.link) || linkMembers.set(f.link, []).get(f.link)).push(f); });

  const numberOf = new Map();
  const lines = [];
  const holes = [];
  (playOrder && playOrder.holes || []).forEach((ref, index) => {
    const position = index + 1;
    const osm = OSM_REF.exec(ref);
    if (osm) {
      const element = byOsmKey.get(osm[1] + "/" + osm[2]);
      if (!element || !isHoleWay(element)) { holes.push({ position, ref, found: false, reason: "osm-hole-not-in-payload" }); return; }
      lines.push(Object.assign({}, element, { tags: Object.assign({}, element.tags, { ref: String(position) }) }));
      holes.push({ position, ref, found: true });
      return;
    }
    const link = LINK_REF.exec(ref);
    const members = link ? (linkMembers.get(link[1]) || []) : [];
    const line = members.length ? linkHoleLine(members, position) : null;
    if (!line) { holes.push({ position, ref, found: false, reason: missingReason(members) }); return; }
    members.forEach(f => numberOf.set(f.id, position));
    lines.push(line);
    holes.push({ position, ref, found: true });
  });

  const rest = source.filter(e => e && !isHoleWay(e)).map(element => {
    if (!element.tags) return element;
    const tags = Object.assign({}, element.tags);
    delete tags.ref;
    const own = isOverlayElement(element) ? numberOf.get(tags[OVERLAY_TAG]) : null;
    if (own) tags.ref = String(own);
    return Object.assign({}, element, { tags });
  });

  const centres = lines.map(lineCentre).filter(Boolean);
  const centre = centres.length
    ? { lat: centres.reduce((s, c) => s + c.lat, 0) / centres.length, lng: centres.reduce((s, c) => s + c.lng, 0) / centres.length }
    : null;
  return { payload: Object.assign({}, payload || {}, { elements: rest.concat(lines) }), centre, holes };
}

/* "Billingbear Park Golf Course - New Course": the facility, then the play order's own name -
   unless the name already says the facility, or there is no facility to say. */
export function playOrderCourseName(name, facilityName) {
  const own = String(name || "").trim();
  const facility = String(facilityName || "").trim();
  if (!facility) return own;
  if (!own) return facility;
  return own.toLowerCase().includes(facility.toLowerCase()) ? own : facility + " - " + own;
}

/* The loops publishSeparatedLoops takes, one per play order with at least one hole, the
   pinned course's first - that row is the one the job was queued against. */
export function playOrderLoops(payload, overlayFeatures, playOrders, { pinnedCourseId, facilityName } = {}) {
  const orders = normalizePlayOrders(playOrders, pinnedCourseId).filter(order => order.holes.length);
  const loops = orders.map(order => {
    const built = playOrderPayload(payload, overlayFeatures, order);
    const found = built.holes.filter(h => h.found).map(h => h.position);
    return {
      name: playOrderCourseName(order.name, facilityName),
      nameSource: "play-order",
      playOrderId: order.id,
      courseId: order.courseId,
      osmRef: "",
      method: "play-order",
      centre: built.centre,
      holeNumbers: found,
      contiguous: found.length === order.holes.length,
      expectedHoles: order.holes.length,
      holes: built.holes,
      payload: built.payload
    };
  });
  const pinnedAt = loops.findIndex(loop => loop.courseId === pinnedCourseId);
  if (pinnedAt > 0) loops.unshift(loops.splice(pinnedAt, 1)[0]);
  loops.forEach((loop, index) => { loop.index = index; });
  return loops;
}
