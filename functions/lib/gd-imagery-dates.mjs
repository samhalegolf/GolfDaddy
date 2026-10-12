/* When the imagery under the Studio map was taken, per live map source.
 *
 * The overlay page draws over whichever provider in window.GDMapSources (scripts/gd-app-core.js)
 * covers the course. Shapes are placed by eye off that ground, so the person drawing needs to
 * know how old the picture is: a bunker rebuilt in 2023 is not on a 2019 survey. Every provider
 * publishes this differently, and some not at all, so one place asks each in its own way and
 * answers in one shape:
 *
 *   { source, status, text, from, to, detail }
 *     status  "ok"           a date was found - text says it, from/to carry it
 *             "none"         the provider was asked and gave no date for this ground
 *             "unsupported"  the provider publishes no capture dates (text says so)
 *             "error"        the provider could not be asked (text says why)
 *     from/to ISO-ish strings at the precision known: "2024", "2024-03" or "2024-03-12"
 *     detail  the survey or mosaic the date belongs to, where the provider names one
 *
 * Nothing here touches tiles or stores anything; it is read by functions/course-map-capture-date.mjs
 * for the overlay's credit line. fetch is injected so dev/imagery-dates.test.mjs can feed every
 * provider's reply shape without a network. */

const M_PER_DEG = 111320;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const LINZ_ATTRIBUTION_URL = "https://basemaps.linz.govt.nz/v1/attribution/aerial/WebMercatorQuad/summary.json";
export const NAIP_IMAGE_SERVER = "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer";
export const QLD_IMAGE_SERVER = "https://spatial-img.information.qld.gov.au/arcgis/rest/services/Basemaps/LatestStateProgram_AllUsers/ImageServer";
export const PDOK_WMTS_CAPABILITIES = "https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0?request=GetCapabilities&service=WMTS";
export const PNOA_WMS = "https://www.ign.es/wms-inspire/pnoa-ma";
export const GEOPF_WMS = "https://data.geopf.fr/wms-r";
export const ESRI_WORLD_IMAGERY = "https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer";

/* ---------- dates in whatever shape a provider uses ---------- */

const DATE_KEY = /date|acqui|captur|flown|vol|fecha|year|ann[ée]e|datetime|time|vint|epoch/i;

/* One value as a {from, to} at the precision it carries, or null. Esri serves dates as epoch
   milliseconds, its World Imagery citations as YYYYMMDD, STAC as ISO, IGN as a year or a
   dd/mm/yyyy. A bare year must look like one (1900-2099): 20220601 is a day, 2022 a year. */
export function parseDateValue(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e11) return isoDay(new Date(value));
    if (value >= 19000101 && value <= 20991231) return parseDateValue(String(value));
    if (value >= 1900 && value <= 2099 && Number.isInteger(value)) return { from: String(value), to: String(value) };
    return null;
  }
  const text = String(value).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (m) return day(m[1], m[2], m[3]);
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (m) return day(m[1], m[2], m[3]);
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(text);
  if (m) return day(m[3], m[2], m[1]);
  m = /^(\d{4})-(\d{2})$/.exec(text);
  if (m) return month(m[1], m[2]);
  m = /^(19|20)\d{2}$/.exec(text);
  if (m) return { from: text, to: text };
  if (/^\d{13}$/.test(text)) return isoDay(new Date(Number(text)));
  return null;
}

function isoDay(date) {
  if (!Number.isFinite(date.getTime())) return null;
  const iso = date.toISOString().slice(0, 10);
  return { from: iso, to: iso };
}
function day(y, mo, d) {
  const mm = Number(mo), dd = Number(d);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const iso = y + "-" + String(mm).padStart(2, "0") + "-" + String(dd).padStart(2, "0");
  return { from: iso, to: iso };
}
function month(y, mo) {
  const mm = Number(mo);
  if (mm < 1 || mm > 12) return null;
  const iso = y + "-" + String(mm).padStart(2, "0");
  return { from: iso, to: iso };
}

/* The dates an attribute bag carries, under keys that say they are dates. A name like NAIP's
   m_3712213_ne_10_060_20220601 carries its flight day too, so a value that ends in one counts. */
export function datesInAttributes(attributes) {
  const out = [];
  Object.keys(attributes || {}).forEach(key => {
    const value = attributes[key];
    if (DATE_KEY.test(key)) {
      const got = parseDateValue(value);
      if (got) { out.push(Object.assign({ key }, got)); return; }
    }
    if (typeof value === "string") {
      const m = /(?:^|[_\-\s])((?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))(?:[_\-\s.]|$)/.exec(value);
      if (m) out.push(Object.assign({ key }, parseDateValue(m[1])));
    }
  });
  return out;
}

/* Dates in free text (an HTML or plain GetFeatureInfo answer): days first, then bare years. */
export function datesInText(text) {
  const out = [];
  const s = String(text || "");
  let m;
  const iso = /\b((?:19|20)\d{2})-(\d{2})-(\d{2})\b/g;
  while ((m = iso.exec(s))) { const got = day(m[1], m[2], m[3]); if (got) out.push(got); }
  const dmy = /\b(\d{1,2})[/.](\d{1,2})[/.]((?:19|20)\d{2})\b/g;
  while ((m = dmy.exec(s))) { const got = day(m[3], m[2], m[1]); if (got) out.push(got); }
  if (out.length) return out;
  const year = /\b((?:19|20)\d{2})\b/g;
  while ((m = year.exec(s))) out.push({ from: m[1], to: m[1] });
  return out;
}

export function latest(dates) {
  return (dates || []).filter(Boolean).sort((a, b) => (b.to || b.from).localeCompare(a.to || a.from))[0] || null;
}

/* "12 Mar 2024", "Mar 2024", "2024", or "12 Mar 2024 – 4 Apr 2024". */
export function describeDates(from, to) {
  const a = pretty(from), b = pretty(to);
  if (!a && !b) return "";
  if (!a || !b || a === b) return a || b;
  return a + " – " + b;
}
function pretty(value) {
  const s = String(value || "");
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return Number(m[3]) + " " + MONTHS[Number(m[2]) - 1] + " " + m[1];
  m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) return MONTHS[Number(m[2]) - 1] + " " + m[1];
  m = /^(\d{4})/.exec(s);
  return m ? m[1] : "";
}

/* ---------- geometry ---------- */

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    const crosses = ((yi > point.lat) !== (yj > point.lat)) && (point.lng < (xj - xi) * (point.lat - yi) / (yj - yi) + xi);
    if (crosses) inside = !inside;
  }
  return inside;
}
/* GeoJSON Polygon or MultiPolygon, [lng, lat] like STAC and LINZ's attribution items. */
export function pointInGeometry(point, geometry) {
  if (!geometry || !Array.isArray(geometry.coordinates)) return false;
  const polygons = geometry.type === "MultiPolygon" ? geometry.coordinates : geometry.type === "Polygon" ? [geometry.coordinates] : [];
  return polygons.some(rings => rings.length && pointInRing(point, rings[0]) && !rings.slice(1).some(hole => pointInRing(point, hole)));
}
function pointInBbox(point, bbox) {
  if (!Array.isArray(bbox) || bbox.length < 4) return false;
  const [w, s, e, n] = bbox.map(Number);
  return point.lng >= w && point.lng <= e && point.lat >= s && point.lat <= n;
}

function boundsAround(lat, lng, m) {
  const dLat = m / M_PER_DEG, dLng = m / (M_PER_DEG * Math.max(0.01, Math.cos(lat * Math.PI / 180)));
  return { west: lng - dLng, east: lng + dLng, south: lat - dLat, north: lat + dLat };
}

/* ---------- fetching ---------- */

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}
async function getText(fetchImpl, url) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.text();
}

/* ---------- providers ---------- */

/* LINZ Basemaps' attribution feed is STAC-shaped: `collections` (one per survey, with a temporal
   interval and the licensor) and `items` (one per survey piece, with a footprint and the zoom
   range it is drawn at). The aerial mosaic stacks urban surveys over rural ones, so of the
   surveys under the point at this zoom the finest (smallest gsd) is the one on screen. */
async function linz(point, zoom, keys, fetchImpl) {
  const url = LINZ_ATTRIBUTION_URL + (keys.linzKey ? "?api=" + encodeURIComponent(keys.linzKey) : "");
  const feed = await getJson(fetchImpl, url);
  const collections = new Map((feed.collections || []).map(c => [c.id, c]));
  const z = Math.floor(zoom);
  const here = (feed.items || []).filter(item => {
    const zr = item.properties && item.properties["linz:zoom"];
    if (zr && ((zr.min != null && z < zr.min) || (zr.max != null && z > zr.max))) return false;
    if (item.geometry) return pointInGeometry(point, item.geometry);
    return pointInBbox(point, item.bbox);
  });
  let candidates = here.map(item => ({ item, collection: collections.get(item.collection) }));
  if (!candidates.length) candidates = [...collections.values()].filter(c => pointInBbox(point, c.extent && c.extent.spatial && c.extent.spatial.bbox && c.extent.spatial.bbox[0])).map(collection => ({ item: null, collection }));
  if (!candidates.length) return { status: "none", text: "no survey listed here" };
  const gsd = c => { const g = c.collection && c.collection.summaries && c.collection.summaries.gsd; return Array.isArray(g) ? Math.min(...g.map(Number)) : Number(g) || Infinity; };
  candidates.sort((a, b) => gsd(a) - gsd(b));
  const top = candidates[0];
  const interval = top.collection && top.collection.extent && top.collection.extent.temporal && top.collection.extent.temporal.interval && top.collection.extent.temporal.interval[0];
  const props = (top.item && top.item.properties) || {};
  const from = parseDateValue(props.start_datetime || (interval && interval[0]) || props.datetime);
  const to = parseDateValue(props.end_datetime || (interval && interval[1]) || props.datetime);
  const title = (top.collection && top.collection.title) || (top.item && top.item.collection) || "";
  if (!from && !to) return { status: "none", text: "no date on the survey here", detail: title };
  const others = candidates.length - 1;
  return { status: "ok", from: (from || to).from, to: (to || from).to, detail: title + (others ? " (+" + others + " more survey" + (others === 1 ? "" : "s") + " under this point)" : "") };
}

/* An ArcGIS ImageServer mosaic answers a point query with the rasters covering it and their
   attributes; the capture day is in one of them, under a date field or in the raster's name. */
async function imageServer(base, point, fetchImpl) {
  const params = new URLSearchParams({
    geometry: point.lng + "," + point.lat, geometryType: "esriGeometryPoint", inSR: "4326",
    spatialRel: "esriSpatialRelIntersects", outFields: "*", returnGeometry: "false", f: "json"
  });
  const body = await getJson(fetchImpl, base + "/query?" + params.toString());
  if (body.error) throw new Error(body.error.message || "query refused");
  const rows = (body.features || []).map(f => f.attributes || {});
  if (!rows.length) return { status: "none", text: "no raster listed at this point" };
  const found = rows.map(attrs => ({ attrs, date: latest(datesInAttributes(attrs)) })).filter(r => r.date).sort((a, b) => b.date.to.localeCompare(a.date.to))[0];
  if (!found) return { status: "none", text: "the rasters here carry no date" };
  const name = found.attrs.Name || found.attrs.NAME || found.attrs.name || "";
  return { status: "ok", from: found.date.from, to: found.date.to, detail: String(name).slice(0, 80) };
}

/* PDOK's Actueel_orthoHR is whichever yearly flight is newest: the capabilities list the years
   it holds (2023_orthoHR, 2024_orthoHR...) and the newest is the one on screen. */
async function pdok(fetchImpl) {
  const xml = await getText(fetchImpl, PDOK_WMTS_CAPABILITIES);
  const years = [...xml.matchAll(/\b((?:19|20)\d{2})_orthoHR\b/g)].map(m => Number(m[1]));
  if (!years.length) return { status: "none", text: "no yearly layer listed" };
  const year = String(Math.max(...years));
  return { status: "ok", from: year, to: year, detail: "Beeldmateriaal flight of " + year + " (the most recent year PDOK serves)" };
}

function wmsFeatureInfo(base, layer, point, infoFormat) {
  const b = boundsAround(point.lat, point.lng, 50);
  const params = new URLSearchParams({
    SERVICE: "WMS", VERSION: "1.3.0", REQUEST: "GetFeatureInfo", LAYERS: layer, QUERY_LAYERS: layer, STYLES: "",
    CRS: "EPSG:4326", BBOX: [b.south, b.west, b.north, b.east].join(","), WIDTH: "101", HEIGHT: "101", I: "50", J: "50",
    INFO_FORMAT: infoFormat, FEATURE_COUNT: "10"
  });
  return base + "?" + params.toString();
}

/* IGN España's PNOA WMS carries the flight dates as their own layer, OI.MosaicElement. */
async function pnoa(point, fetchImpl) {
  return wmsDates(PNOA_WMS, "OI.MosaicElement", point, fetchImpl, "PNOA mosaic element");
}
/* Géoplateforme's "graphe de mosaïquage" says which photo, taken when, each piece of the
   BD ORTHO came from. */
async function geopf(point, fetchImpl) {
  return wmsDates(GEOPF_WMS, "ORTHOIMAGERY.ORTHOPHOTOS.GRAPHE-MOSAIQUAGE", point, fetchImpl, "BD ORTHO mosaic piece");
}

async function wmsDates(base, layer, point, fetchImpl, what) {
  let found = null, detail = "";
  try {
    const body = await getJson(fetchImpl, wmsFeatureInfo(base, layer, point, "application/json"));
    const features = Array.isArray(body) ? body : (body && body.features) || [];
    const dates = [];
    features.forEach(f => { const attrs = f && (f.properties || f.attributes) || f; const d = latest(datesInAttributes(attrs)); if (d) dates.push(d); });
    found = latest(dates);
    if (!found && body) found = latest(datesInText(JSON.stringify(body)));
  } catch (e) {
    const text = await getText(fetchImpl, wmsFeatureInfo(base, layer, point, "text/html"));
    found = latest(datesInText(text.replace(/<[^>]+>/g, " ")));
  }
  if (!found) return { status: "none", text: "no " + what + " listed here" };
  detail = what;
  return { status: "ok", from: found.from, to: found.to, detail };
}

/* Esri World Imagery's citation layers answer identify with the source, resolution and date of
   the imagery drawn at each zoom band (SRC_DATE as YYYYMMDD, SRC_DATE2 as epoch ms). */
async function esri(point, zoom, bounds, keys, fetchImpl) {
  if (!keys.esriKey) return { status: "error", text: "no ArcGIS key on the server" };
  const b = bounds || boundsAround(point.lat, point.lng, 200);
  const params = new URLSearchParams({
    f: "json", geometry: point.lng + "," + point.lat, geometryType: "esriGeometryPoint", sr: "4326",
    layers: "all", tolerance: "2", mapExtent: [b.west, b.south, b.east, b.north].join(","),
    imageDisplay: "256,256,96", returnGeometry: "false", token: keys.esriKey
  });
  const body = await getJson(fetchImpl, ESRI_WORLD_IMAGERY + "/identify?" + params.toString());
  if (body.error) throw new Error(body.error.message || "identify refused");
  const results = (body.results || []).map(r => r.attributes || {});
  if (!results.length) return { status: "none", text: "no citation at this point" };
  const z = Math.floor(zoom);
  const level = (a, key) => Number(a[key]);
  const inBand = results.filter(a => Number.isFinite(level(a, "MinMapLevel")) && Number.isFinite(level(a, "MaxMapLevel")) && z >= level(a, "MinMapLevel") && z <= level(a, "MaxMapLevel"));
  const pick = (inBand.length ? inBand : results).map(a => ({ a, date: latest(datesInAttributes(a)) })).filter(r => r.date).sort((x, y) => y.date.to.localeCompare(x.date.to))[0];
  if (!pick) return { status: "none", text: "the citation here carries no date" };
  const detail = [pick.a.NICE_NAME || pick.a.NICE_DESC || pick.a.SRC_DESC, pick.a.SRC_RES ? Number(pick.a.SRC_RES).toFixed(2) + " m/px" : ""].filter(Boolean).join(", ");
  return { status: "ok", from: pick.date.from, to: pick.date.to, detail };
}

const UNSUPPORTED = {
  mapbox: "Mapbox does not publish capture dates for its satellite tiles",
  google: "Google does not publish capture dates through the Map Tiles API",
  osm: "the OSM line guide is a map, not imagery"
};

/* The answer for one source key (GDMapSources' key: linz, naip, qld, pdok, pnoa, geopf, esri,
   mapbox, osm; plus google for the side pane) at a view: {lat, lng, zoom, bounds?}. */
export async function captureDateFor(sourceKey, view, { fetchImpl = fetch, keys = {} } = {}) {
  const source = String(sourceKey || "").toLowerCase();
  const lat = Number(view && view.lat), lng = Number(view && view.lng), zoom = Number(view && view.zoom);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { source, status: "error", text: "no view to ask about" };
  const point = { lat, lng };
  const z = Number.isFinite(zoom) ? zoom : 17;
  if (UNSUPPORTED[source]) return { source, status: "unsupported", text: UNSUPPORTED[source] };
  let answer;
  try {
    if (source === "linz") answer = await linz(point, z, keys, fetchImpl);
    else if (source === "naip") answer = await imageServer(NAIP_IMAGE_SERVER, point, fetchImpl);
    else if (source === "qld") answer = await imageServer(QLD_IMAGE_SERVER, point, fetchImpl);
    else if (source === "pdok") answer = await pdok(fetchImpl);
    else if (source === "pnoa") answer = await pnoa(point, fetchImpl);
    else if (source === "geopf") answer = await geopf(point, fetchImpl);
    else if (source === "esri") answer = await esri(point, z, view && view.bounds, keys, fetchImpl);
    else return { source, status: "error", text: "unknown map source" };
  } catch (error) {
    return { source, status: "error", text: "could not ask the provider (" + String(error && error.message || error).slice(0, 120) + ")" };
  }
  if (answer.status === "ok") answer.text = describeDates(answer.from, answer.to);
  return Object.assign({ source }, answer);
}
