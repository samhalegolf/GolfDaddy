/* Public course page: GET /courses/<courseId>
 *
 * One indexable page per well-mapped course, so a search for that course lands on Clarity
 * showing the course on a phone, a Garmin and an Apple Watch - and nothing else. It is a shop
 * window for one course, not a course directory: there is no index, no count, no browse.
 * See COURSE_PAGES_PLAN_2026-10-20.md.
 *
 * Rendered here on the server, not by the app, because a crawler has to see the course name,
 * the hole table and the images in the HTML it fetches. The page is static for a day at the
 * CDN (Netlify-CDN-Cache-Control), so a visit costs nothing after the first.
 *
 * A course has a page only when
 *   course_maps.page_public       an admin switched it on (default off - a half-finished map
 *                                 must never go public by accident)
 *   course_maps.published         the geometry GPS Play uses is live
 *   course_visuals.published_version > 0   there is a Clarity map to show
 * Anything else is a plain 404 - not a redirect to the landing, because a 404 is exactly what
 * a crawler should record for a course that is not ready.
 *
 * The hole table reads the course's GPS scorecard (course_scorecards, the card stored under the
 * course's own name, else the facility's one card) and shows one tee: the leading distance the
 * card carries in `metres`. A course without a card still gets its page; the table is left out.
 *
 * Reads only. Never touches course_maps, course_visuals or course_scorecards except to select. */

import { createSupabaseFetch } from "./lib/gd-supabase-fetch.mjs";
import { createSupabaseStorage } from "./lib/gd-supabase-storage.mjs";
import { fetchFacilityRows } from "./lib/gd-facility-scorecards.mjs";
import { scorecardCourseKey, cardNameMatchesCourse } from "./lib/gd-scorecard-resolve.mjs";
import { splitCourseName } from "./lib/gd-automapper-core.mjs";
import { appleBakeNeeded, wakeAppleBake } from "./lib/gd-apple-bake-wake.mjs";
import store from "../clarity-caddy-app-store.js";

const MAPS_TABLE = "course_maps";
const VISUALS_TABLE = "course_visuals";
const WATCH_TABLE = "course_watch_maps";

/* The watch section runs on the watch preview's own scripts (watch-preview.html lists the
   same set, same labels - dev/course-page.test.js keeps the two lists equal). The labels are
   the hand-bumped ones from the source, not content hashes: a function-rendered page cannot
   be stamped by the deploy build, and scripts/ is cached for an hour, so a changed file is
   at most an hour behind. */
export const WATCH_SCRIPTS = [
  "/assets/vendor/leaflet/leaflet.js",
  "/scripts/inline/gd-leaflet-alias.js?v=split03",
  "/scripts/gd-bubble-signals-core.js?v=bubble-signals-core-001",
  "/scripts/studio/gps-play/watch-preview/watch-common.js?v=watch-preview-002",
  "/scripts/studio/gps-play/watch-preview/watch-preview-page.js?v=watch-preview-004",
  "/scripts/studio/gps-play/garmin-preview/garmin-watch-render.js?v=watch-preview-002",
  "/scripts/studio/gps-play/garmin-preview/garmin-preview-page.js?v=watch-preview-005",
  "/scripts/studio/gps-play/apple-preview/apple-watch-render.js?v=watch-preview-004",
  "/scripts/studio/gps-play/apple-preview/apple-preview-page.js?v=watch-preview-005",
  "/scripts/clarity-watch-preview.js?v=watch-preview-public-002"
];
/* The picker at the foot of the page, this page's own. */
export const PAGE_SCRIPTS = ["/scripts/clarity-course-page.js?v=course-page-001"];
const MAP_FIELDS = "course_id,course_name,course_lat,course_lng,region,country,country_code,hole_count,facility_key,"
  + "object_count,bunker_count,water_count,tree_count,published_at,updated_at";

/* Scorecards store metres. Golfers in these countries read yards. */
const YARD_COUNTRIES = new Set(["US", "GB", "IE"]);

function env(name) { return process.env[name] || ""; }
function supabaseBase() { return env("SUPABASE_URL").replace(/\/+$/, ""); }
function supabaseKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); }
function hasSupabase() { return !!(supabaseBase() && supabaseKey()); }

const supabaseFetch = createSupabaseFetch({ base: supabaseBase, key: supabaseKey, label: "course-page" });

/* The page's images, made by the marketing snapshot runner (marketing/course-page-assets.mjs):
   <courseId>/web/<frame>.jpg and <courseId>/og.png in the public course-pages bucket. */
const IMAGE_BUCKET = "course-pages";
const FRAMES = [
  { file: "01-pre-lock", caption: "The hole, before you place a shot" },
  { file: "02-head-to-tee", caption: "On the tee, with the shot bubble on the target" },
  { file: "03-approach", caption: "An approach, bubble on the green" }
];
const imageStore = createSupabaseStorage({ base: supabaseBase, key: supabaseKey, bucket: IMAGE_BUCKET });

function slug(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 160);
}

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/* ---- data ---------------------------------------------------------------------------- */

export async function loadCoursePage(courseId, deps = {}) {
  const fetchRows = deps.supabaseFetch || supabaseFetch;
  const rows = await fetchRows(MAPS_TABLE + "?select=" + MAP_FIELDS
    + "&course_id=eq." + encodeURIComponent(courseId) + "&published=eq.true&page_public=eq.true&limit=1");
  const map = Array.isArray(rows) ? rows[0] : null;
  if (!map) return null;

  const visuals = await fetchRows(VISUALS_TABLE + "?select=published_version,bake_number,updated_at&course_id=eq."
    + encodeURIComponent(courseId) + "&limit=1").catch(() => []);
  const visual = Array.isArray(visuals) ? visuals[0] : null;
  if (!visual || !(Number(visual.published_version) > 0)) return null;

  const [cardRows, images, watchRows] = await Promise.all([
    fetchFacilityRows(fetchRows, map.facility_key || map.course_id),
    loadImages(courseId, deps.imageStore || imageStore),
    fetchRows(WATCH_TABLE + "?select=status,ready_hole_count,progress&course_id=eq." + encodeURIComponent(courseId) + "&limit=1").catch(() => [])
  ]);
  const card = pickCard(cardRows, map.course_name);
  const watch = Array.isArray(watchRows) ? watchRows[0] || null : null;
  return { map, visual, card, images, appleBakeNeeded: appleBakeNeeded(watch) };
}

/* Whatever the runner has uploaded for this course; a course with no frames yet has none, and
   the page simply renders without pictures. */
export async function loadImages(courseId, store) {
  const names = new Set();
  try {
    (await store.list(courseId + "/web")).forEach((row) => row && row.name && names.add("web/" + row.name));
    (await store.list(courseId)).forEach((row) => row && row.name && names.add(row.name));
  } catch (error) {
    return { frames: [], og: "" };
  }
  const frames = FRAMES
    .filter((f) => names.has("web/" + f.file + ".jpg"))
    .map((f) => ({ src: store.publicUrl(courseId + "/web/" + f.file + ".jpg"), caption: f.caption }));
  return { frames, og: names.has("og.png") ? store.publicUrl(courseId + "/og.png") : "" };
}

/* The course's own card (stored under its exact name) first; otherwise the one card the
   facility has; otherwise the card whose name says it is this course. A facility with several
   cards and no match gets no table rather than a wrong one. */
export function pickCard(rows, courseName) {
  const usable = (rows || []).filter((row) => Array.isArray(row.holes_json) && row.holes_json.length);
  if (!usable.length) return null;
  const key = scorecardCourseKey(courseName);
  const exact = usable.find((row) => row.course_key === key);
  if (exact) return exact;
  if (usable.length === 1) return usable[0];
  return usable.find((row) => cardNameMatchesCourse(row.course_name || row.course_key, courseName)) || null;
}

/* {hole, par, index, metres} rows in hole order, holes with a number only. */
export function tableHoles(card) {
  return (card && Array.isArray(card.holes_json) ? card.holes_json : [])
    .filter((h) => h && num(h.hole) > 0)
    .sort((a, b) => num(a.hole) - num(b.hole))
    .map((h) => ({ hole: num(h.hole), par: num(h.par), index: num(h.index), metres: num(h.metres) }));
}

/* "Millbrook Golf Resort - Course 1 - 6298m North-West" is how the mapper names a loop it
   could not name; the page shows the club. A loop with a real name keeps it. */
export function displayName(courseName) {
  const parts = splitCourseName(courseName);
  if (!parts.label || /^course\s*\d+/i.test(parts.label)) return parts.facility || String(courseName || "").trim();
  return parts.facility + " – " + parts.label;
}

function placeLine(map) {
  return [map.region, map.country].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(", ");
}

function distance(metres, yards) {
  if (metres == null) return "";
  return yards ? Math.round(metres * 1.09361) : Math.round(metres);
}

/* ---- html ---------------------------------------------------------------------------- */

const CSS = `
*{box-sizing:border-box}html{background:#000}
body{margin:0;background:#000;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;line-height:1.5}
a{color:#20d96b;text-decoration:none}a:hover{color:#fff}
.page{width:min(1100px,calc(100% - 40px));margin:0 auto;padding:26px 0 80px}
.brand{display:inline-flex;align-items:center;gap:12px;color:#fff;margin-bottom:38px}
.brand img{width:46px;height:46px;border-radius:12px}
.brand span{font-size:20px;font-weight:950;letter-spacing:.08em;text-transform:uppercase}
.eyebrow{color:#20d96b;text-transform:uppercase;letter-spacing:.16em;font-weight:900;font-size:13px;margin:0 0 14px}
h1{margin:0;font-size:clamp(34px,5vw,58px);line-height:1.04;letter-spacing:-.03em;max-width:860px;text-wrap:pretty}
.lede{margin:18px 0 0;color:rgba(255,255,255,.72);font-size:clamp(17px,1.5vw,21px);max-width:720px}
.facts{display:flex;flex-wrap:wrap;gap:10px;margin:26px 0 0;padding:0;list-style:none}
.facts li{padding:8px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.16);font-size:14px;color:rgba(255,255,255,.86)}
.facts b{color:#20d96b;font-weight:800}
.hero{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:40px;align-items:center}
.heroShot{width:min(300px,38vw);height:auto;border-radius:28px;box-shadow:0 30px 70px rgba(0,0,0,.6);display:block;justify-self:end}
.frames{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:22px}
.frames figure{margin:0}
.frames img{width:100%;height:auto;border-radius:22px;display:block;box-shadow:0 18px 40px rgba(0,0,0,.5)}
.frames figcaption{margin-top:10px;color:rgba(255,255,255,.62);font-size:14px;text-align:center}
@media (max-width:760px){.hero{grid-template-columns:1fr}.heroShot{justify-self:start;width:min(260px,70vw)}}
.stores{display:flex;flex-wrap:wrap;gap:12px;margin-top:30px}
.stores a{display:inline-flex;align-items:center;justify-content:center;min-height:58px;padding:0 14px;border-radius:999px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.26)}
.stores img{display:block;height:42px;width:auto}
h2{margin:60px 0 14px;font-size:clamp(24px,2.6vw,32px);letter-spacing:-.02em}
.sub{margin:0 0 22px;color:rgba(255,255,255,.62);font-size:16px}
.card{max-width:680px;padding:clamp(18px,3vw,30px);border:1px solid rgba(255,255,255,.12);border-radius:24px;background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.025))}
h2.small{font-size:20px;margin-top:44px;color:rgba(255,255,255,.85)}
.nines{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;max-width:680px}
.nines .card{padding:6px 12px;border-radius:16px}
table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums;color:rgba(255,255,255,.8)}
th,td{padding:4px 6px;text-align:right;border-bottom:1px solid rgba(255,255,255,.06)}
th:first-child,td:first-child{text-align:left}
th{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:rgba(255,255,255,.45);font-weight:800}
tbody tr:last-child td{border-bottom:0}
tfoot td{font-weight:800;color:#20d96b;border-top:1px solid rgba(255,255,255,.14);border-bottom:0}
.card.isWide{max-width:none}
.wpGrid{display:grid;grid-template-columns:minmax(260px,1fr) minmax(300px,520px);gap:26px;align-items:start}
.wpBar{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.wpBar label{font-size:13px;color:rgba(255,255,255,.6);display:inline-flex;align-items:center;gap:8px}
.wpSelect{font:inherit;font-size:14px;color:#fff;background:rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.22);border-radius:12px;padding:8px 10px}
.wpTabs button,.gdStudioDiagramBtn,.wpPreset,.wpStep{background:none;border:1px solid rgba(255,255,255,.26);color:rgba(255,255,255,.8);border-radius:999px;padding:9px 16px;font:inherit;font-size:14px;font-weight:700;cursor:pointer}
.wpTabs button:hover,.gdStudioDiagramBtn:hover,.wpPreset:hover,.wpStep:hover{color:#20d96b;border-color:rgba(32,217,107,.6)}
.wpTabs button.isActive,.wpPreset.isActive{background:#20d96b;color:#000;border-color:#20d96b}
.wpTabs{display:inline-flex}
.wpTabs button:first-child{border-top-right-radius:0;border-bottom-right-radius:0}
.wpTabs button:last-child{border-top-left-radius:0;border-bottom-left-radius:0;border-left:none}
.wpStatus{margin:12px 0 0;min-height:1.4em;font-size:14px;color:rgba(255,255,255,.72)}
.wpPresets{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.wpHoleRow{display:flex;align-items:center;gap:8px;margin-top:18px}
.wpStep{padding:9px 14px}
.wpWatch{display:flex;flex-direction:column;align-items:center}
.wpBezel{display:inline-block;max-width:100%;padding:14px;border-radius:28px;background:#1b1f1d;box-shadow:inset 0 0 0 2px #2a302d,0 8px 24px rgba(0,0,0,.45);margin:6px 0 10px;box-sizing:border-box}
.wpBezel.isRound{border-radius:50%}
.wpBezel.isRect{padding:10px;border-radius:calc(var(--gdWatchCorner,40px) + 10px);background:#141614}
.wpBezel.isMip{background:#101311}
.wpBezel canvas{display:block;background:#000;border-radius:10px;touch-action:none;cursor:crosshair;max-width:100% !important;height:auto !important}
.wpBezel.isRound canvas{border-radius:50%}
.wpBezel.isRect canvas{border-radius:var(--gdWatchCorner,40px)}
.wpButtons{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:4px}
.wpButtons .gdStudioDiagramBtn{min-width:64px}
.wpReadout{margin:14px 0 0;padding:12px 14px;width:100%;box-sizing:border-box;border:1px solid rgba(255,255,255,.12);border-radius:12px;background:rgba(0,0,0,.4);color:rgba(255,255,255,.72);font:13px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word;min-height:3.2em}
.wpHelp{margin:18px 0 0;font-size:13px;color:rgba(255,255,255,.5);line-height:1.5}
@media (max-width:860px){.wpGrid{grid-template-columns:1fr}}
.cpFind{display:flex;gap:10px}
.cpFind input{flex:1;min-width:0;font:inherit;font-size:16px;color:#fff;background:rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.22);border-radius:12px;padding:12px 14px}
.cpPrimary{min-height:46px;padding:0 22px;border-radius:999px;border:0;background:#20d96b;color:#000;font:inherit;font-size:15px;font-weight:800;cursor:pointer}
.cpPrimary:disabled{opacity:.5;cursor:default}
.cpResults{display:flex;flex-direction:column;gap:10px;margin-top:14px}
.cpResult{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;padding:14px 16px;border-radius:16px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.03)}
.cpResult strong{display:block}
.cpResult span{display:block;font-size:13px;color:rgba(255,255,255,.55)}
.cpResult em{display:block;font-size:12px;color:#20d96b;font-style:normal;margin-top:2px}
.cpActions{display:flex;flex-wrap:wrap;gap:8px}
.cpAction{display:inline-flex;align-items:center;background:none;border:1px solid rgba(255,255,255,.26);color:rgba(255,255,255,.85);border-radius:999px;padding:9px 16px;font:inherit;font-size:14px;font-weight:700;cursor:pointer;text-decoration:none}
.cpAction:hover{color:#20d96b;border-color:rgba(32,217,107,.6)}
.cpAction.isPrimary{background:#20d96b;color:#000;border-color:#20d96b}
.cpAction.isPrimary:hover{color:#000;filter:brightness(1.07)}
.cpRequest{margin-top:18px;padding:18px 20px;border-radius:18px;border:1px solid rgba(32,217,107,.34);background:rgba(0,0,0,.3)}
.cpRequest h3{margin:0 0 6px;font-size:18px}
.cpField{display:flex;flex-direction:column;gap:6px;margin-top:14px;font-size:14px;color:rgba(255,255,255,.72)}
.cpField input,.cpField textarea{font:inherit;font-size:16px;color:#fff;background:rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.22);border-radius:12px;padding:12px 14px}
.cpField textarea{min-height:64px;resize:vertical}
.cpRow{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:16px}
.cpCancel{background:none;border:0;color:rgba(255,255,255,.6);font:inherit;cursor:pointer;text-decoration:underline}
.foot{margin-top:70px;padding-top:24px;border-top:1px solid rgba(255,255,255,.1);display:flex;flex-wrap:wrap;gap:18px;color:rgba(255,255,255,.55);font-size:14px}
@media (max-width:600px){.page{width:calc(100% - 32px)}th,td{padding:9px 6px;font-size:15px}}
`;

function storeBadges() {
  const apple = store.appStoreUrl(), play = store.playStoreUrl();
  return '<div class="stores">'
    + (apple ? '<a href="' + esc(apple) + '" aria-label="Download Clarity Caddy on the App Store"><img src="/assets/brand/app-store-badge.png" alt="Download on the App Store" width="142" height="42"></a>' : "")
    + (play ? '<a href="' + esc(play) + '" aria-label="Get Clarity Caddy on Google Play"><img src="/assets/brand/google-play-badge.png" alt="Get it on Google Play" width="141" height="42"></a>' : "")
    + "</div>";
}

function phoneFrames(frames, name) {
  if (!frames.length) return "";
  return '<h2 id="phone">On your phone</h2>'
    + '<p class="sub">Straight from the app, on this course.</p>'
    + '<div class="frames">' + frames.map((f) => '<figure><img src="' + esc(f.src) + '" alt="' + esc(name + ": " + f.caption) + '" width="585" height="1266" loading="lazy"><figcaption>' + esc(f.caption) + "</figcaption></figure>").join("") + "</div>";
}

/* The Garmin and Apple Watch faces, drawn by the watch preview's own renderers and locked to
   this course (scripts/clarity-watch-preview.js reads data-course-id). Same ids as
   watch-preview.html, because the same script drives both. */
function watchSection(map, name) {
  return '<h2 id="watch">On your watch</h2>'
    + '<p class="sub">The Garmin and Apple Watch faces, drawn exactly as the watch draws them, on ' + esc(name) + '. Stand on the tee or on the approach and see the distances, the club and the hole map.</p>'
    + '<section id="preview" class="card isWide" data-course-id="' + esc(map.course_id) + '" data-course-name="' + esc(name) + '">'
    + '<div class="wpGrid"><div>'
    + '<div class="wpBar"><div class="wpTabs" id="watchTabs" role="tablist"><button type="button" data-watch="garmin" role="tab">Garmin</button><button type="button" data-watch="apple" role="tab">Apple Watch</button></div>'
    + '<label>Units <select id="units" class="wpSelect"><option value="m">metres</option><option value="y">yards</option></select></label></div>'
    + '<p id="courseLine" class="wpStatus" style="margin-top:18px;color:#fff;font-weight:700"></p>'
    + '<div class="wpHoleRow"><button type="button" class="wpStep" id="holePrev" aria-label="Previous hole">\u2039</button><select id="hole" class="wpSelect" aria-label="Hole"></select><button type="button" class="wpStep" id="holeNext" aria-label="Next hole">\u203a</button></div>'
    + '<div class="wpPresets" id="presets"><button type="button" class="wpPreset isActive" data-preset="tee">Tee shot</button><button type="button" class="wpPreset" data-preset="long">Long approach</button><button type="button" class="wpPreset" data-preset="short">Short approach</button></div>'
    + '<p class="wpHelp">Garmin: SELECT is AIM on the numbers and enters or confirms the aim on the map, MENU swaps the numbers and the map, UP and DOWN change hole. Apple Watch: AIM locks the shot and brings the map up; on the map tap to aim, press and drag to carry it, and the wheel is the Digital Crown.</p>'
    + '</div><div class="wpWatch"><div class="wpBezel" id="bezel"><canvas id="canvas"></canvas></div><div class="wpButtons" id="buttons"></div><pre class="wpReadout" id="readout"></pre></div></div>'
    + "</section>"
    + '<p class="wpHelp">On the course, distances come from the watch\u2019s own GPS. Here you stand on the hole\u2019s mapped play line: the tee, 180 m short of the green, or 90 m short.</p>';
}

/* "Looking for your course?" - search, not browse (scripts/clarity-course-page.js). */
function findSection() {
  return '<h2 id="find">Looking for your course?</h2>'
    + '<p class="sub">Search for it. If it\u2019s on Clarity you can see it like this one; if it isn\u2019t mapped yet, or you\u2019d like a better map, tell us and we\u2019ll let you know when it\u2019s done.</p>'
    + '<div class="card">'
    + '<form id="findForm" class="cpFind"><input id="findInput" type="search" placeholder="Course name" autocomplete="off" aria-label="Course name"><button class="cpPrimary" type="submit">Search</button></form>'
    + '<p id="findStatus" class="wpStatus"></p><div id="findResults" class="cpResults"></div>'
    + '<form id="requestForm" class="cpRequest" hidden novalidate><h3 id="requestTitle"></h3><p class="wpStatus" style="margin:0">Leave your name and email and we\u2019ll be in touch when it\u2019s ready.</p>'
    + '<label class="cpField">Your name<input id="requestName" type="text" name="name" autocomplete="name" required maxlength="120"></label>'
    + '<label class="cpField">Email<input id="requestEmail" type="email" name="email" autocomplete="email" required maxlength="240"></label>'
    + '<label class="cpField">Anything you\u2019d like to tell us (optional)<textarea id="requestNote" name="note" maxlength="1200"></textarea></label>'
    + '<div class="cpRow"><button class="cpPrimary" type="submit">Send request</button><button type="button" class="cpCancel" id="requestCancel">Cancel</button></div>'
    + '<p id="requestStatus" class="wpStatus" role="status"></p></form>'
    + "</div>";
}

/* Compact, and deliberately second-tier: the visuals are the page, the card is reference.
   Nine holes per table, side by side on a wide screen, each with its own subtotal. */
function holeTable(holes, yards) {
  if (!holes.length) return "";
  const hasIndex = holes.some((h) => h.index != null);
  const unitHead = yards ? "Yds" : "M";
  const nines = [holes.slice(0, 9), holes.slice(9)].filter((n) => n.length);
  const total = (list, key) => list.reduce((s, h) => s + (h[key] || 0), 0);
  const table = (list, label, footLabel) => '<div class="card"><table><thead><tr><th>' + label + "</th><th>Par</th>" + (hasIndex ? "<th>SI</th>" : "") + "<th>" + unitHead + "</th></tr></thead><tbody>"
    + list.map((h) => "<tr><td>" + h.hole + "</td><td>" + (h.par == null ? "" : h.par) + "</td>" + (hasIndex ? "<td>" + (h.index == null ? "" : h.index) + "</td>" : "") + "<td>" + distance(h.metres, yards) + "</td></tr>").join("")
    + "</tbody><tfoot><tr><td>" + footLabel + "</td><td>" + total(list, "par") + "</td>" + (hasIndex ? "<td></td>" : "") + "<td>" + distance(total(list, "metres"), yards) + "</td></tr></tfoot></table></div>";
  const split = nines.length > 1;
  const grand = split ? '<p class="sub" style="margin:10px 0 0;font-size:13px">Total par ' + total(holes, "par") + " \u00b7 " + distance(total(holes, "metres"), yards) + (yards ? " yards" : " m") + "</p>" : "";
  return '<h2 id="holes" class="small">Scorecard</h2>'
    + '<p class="sub" style="font-size:13px;margin-bottom:12px">Standard tee, ' + (yards ? "yards" : "metres") + ". On the course, Clarity measures from where you stand.</p>"
    + '<div class="nines">' + nines.map((n, i) => table(n, split ? (i === 0 ? "Out" : "In") : "Hole", split ? (i === 0 ? "Out" : "In") : "Total")).join("") + "</div>" + grand;
}

function jsonLd(map, name, url, origin) {
  const course = {
    "@context": "https://schema.org", "@type": "GolfCourse", name, url,
    geo: { "@type": "GeoCoordinates", latitude: num(map.course_lat), longitude: num(map.course_lng) }
  };
  const place = placeLine(map);
  if (place) course.address = { "@type": "PostalAddress", addressRegion: map.region || undefined, addressCountry: map.country_code || map.country || undefined };
  if (num(map.hole_count)) course.numberOfHoles = num(map.hole_count);
  const app = { "@context": "https://schema.org", "@type": "SoftwareApplication", name: "Clarity Caddy", applicationCategory: "SportsApplication", operatingSystem: "iOS, Android, watchOS, Garmin", url: origin + "/welcome" };
  return '<script type="application/ld+json">' + JSON.stringify(course).replace(/</g, "\\u003c") + "</script>"
    + '<script type="application/ld+json">' + JSON.stringify(app).replace(/</g, "\\u003c") + "</script>";
}

export function renderCoursePage(data, origin) {
  const { map, card } = data;
  const images = data.images || { frames: [], og: "" };
  const hero = images.frames.find((f) => /02-head-to-tee/.test(f.src)) || images.frames[0] || null;
  const name = displayName(map.course_name);
  const place = placeLine(map);
  const holes = tableHoles(card);
  const yards = YARD_COUNTRIES.has(String(map.country_code || "").toUpperCase());
  const url = origin + "/courses/" + encodeURIComponent(map.course_id);
  const holeCount = num(map.hole_count) || holes.length || null;
  const title = name + " — hole maps on Garmin, Apple Watch & phone | Clarity Caddy";
  const description = name + (place ? " in " + place : "") + ", mapped for Clarity Caddy"
    + (holeCount ? ": " + holeCount + " holes" : "") + (num(map.bunker_count) ? ", " + map.bunker_count + " bunkers" : "")
    + (num(map.water_count) ? ", " + map.water_count + " water hazards" : "")
    + ". See every hole on your Garmin, Apple Watch or phone before you play.";
  const facts = [
    holeCount ? "<li><b>" + holeCount + "</b> holes mapped</li>" : "",
    num(map.bunker_count) ? "<li><b>" + map.bunker_count + "</b> bunkers</li>" : "",
    num(map.water_count) ? "<li><b>" + map.water_count + "</b> water hazards</li>" : "",
    num(map.tree_count) ? "<li><b>" + map.tree_count + "</b> trees placed</li>" : ""
  ].join("");

  return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    + "<title>" + esc(title) + "</title>"
    + '<meta name="description" content="' + esc(description) + '">'
    + '<link rel="canonical" href="' + esc(url) + '">'
    + '<meta property="og:type" content="website"><meta property="og:site_name" content="Clarity Caddy">'
    + '<meta property="og:title" content="' + esc(name + " on Clarity Caddy") + '"><meta property="og:description" content="' + esc(description) + '">'
    + '<meta property="og:url" content="' + esc(url) + '">'
    + (images.og ? '<meta property="og:image" content="' + esc(images.og) + '"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image">' : '<meta name="twitter:card" content="summary">')
    + '<link rel="icon" href="/assets/brand/clarity-app-icon.png"><link rel="apple-touch-icon" href="/assets/brand/clarity-app-icon.png">'
    + "<style>" + CSS + "</style>"
    + jsonLd(map, name, url, origin)
    + "</head><body><main class=\"page\">"
    + '<a class="brand" href="/welcome"><img src="/assets/brand/clarity-app-icon.png" alt=""><span>Clarity Caddy</span></a>'
    + '<section class="hero"><div>'
    + '<p class="eyebrow">' + esc(place || "Mapped course") + "</p>"
    + "<h1>" + esc(name) + " on your watch and phone.</h1>"
    + '<p class="lede">Every tee, green, bunker and hazard at ' + esc(name) + ' mapped from aerial imagery, with distances from where you stand. On Garmin, Apple Watch and your phone.</p>'
    + (facts ? '<ul class="facts">' + facts + "</ul>" : "")
    + storeBadges()
    + "</div>"
    + (hero ? '<img class="heroShot" src="' + esc(hero.src) + '" alt="' + esc(name + " on Clarity Caddy: " + hero.caption) + '" width="585" height="1266" fetchpriority="high">' : "")
    + "</section>"
    + watchSection(map, name)
    + phoneFrames(images.frames, name)
    + holeTable(holes, yards)
    + findSection()
    + '<footer class="foot"><span>&copy; Clarity Caddy</span><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/support">Support</a></footer>'
    + "</main>"
    + WATCH_SCRIPTS.concat(PAGE_SCRIPTS).map((src) => '<script src="' + src + '"></script>').join("")
    + "</body></html>";
}

function notFound() {
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Course not found | Clarity Caddy</title><style>' + CSS + "</style></head>"
    + '<body><main class="page"><a class="brand" href="/welcome"><img src="/assets/brand/clarity-app-icon.png" alt=""><span>Clarity Caddy</span></a><h1>This course isn’t on Clarity yet.</h1><p class="lede">Clarity Caddy maps courses from aerial imagery for Garmin, Apple Watch and phone.</p>' + storeBadges() + "</main></body></html>";
  return new Response(html, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300", "X-Robots-Tag": "noindex" } });
}

export default async function coursePage(req) {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  if (!hasSupabase()) return new Response("Course pages are not configured", { status: 503 });
  const url = new URL(req.url);
  const courseId = slug(decodeURIComponent(url.pathname.replace(/^\/courses\/?/, "").split("/")[0] || ""));
  if (!courseId) return notFound();

  let data;
  try { data = await loadCoursePage(courseId); } catch (error) {
    return new Response("Course page unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (!data) return notFound();

  /* The Apple Watch package, if this course has none yet: ask the worker now, so by the time
     the visitor opens that tab (the page polls) it is on its way. Awaited and capped; a lost
     wake costs nothing but a later visit. */
  if (data.appleBakeNeeded) await wakeAppleBake(url.origin, courseId, env("CLARITY_SERVICE_SECRET"));

  return new Response(renderCoursePage(data, url.origin), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      /* Browsers always revalidate; the CDN keeps it a day and serves stale while refreshing.
         A republish does not purge yet - the page can lag a map change by up to a day. */
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Netlify-CDN-Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800"
    }
  });
}

export const config = {
  path: "/courses/:courseId"
};
