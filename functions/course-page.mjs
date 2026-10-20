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
import store from "../clarity-caddy-app-store.js";

const MAPS_TABLE = "course_maps";
const VISUALS_TABLE = "course_visuals";
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

  const [cardRows, images] = await Promise.all([
    fetchFacilityRows(fetchRows, map.facility_key || map.course_id),
    loadImages(courseId, deps.imageStore || imageStore)
  ]);
  const card = pickCard(cardRows, map.course_name);
  return { map, visual, card, images };
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
table{width:100%;border-collapse:collapse;font-size:16px;font-variant-numeric:tabular-nums}
th,td{padding:11px 10px;text-align:right;border-bottom:1px solid rgba(255,255,255,.08)}
th:first-child,td:first-child{text-align:left}
th{font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:rgba(255,255,255,.55);font-weight:800}
tr:last-child td{border-bottom:0}
tfoot td{font-weight:800;color:#20d96b;border-top:1px solid rgba(255,255,255,.18)}
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

function holeTable(holes, yards) {
  if (!holes.length) return "";
  const unit = yards ? "yards" : "metres";
  const hasIndex = holes.some((h) => h.index != null);
  const totalPar = holes.reduce((s, h) => s + (h.par || 0), 0);
  const totalLen = holes.reduce((s, h) => s + (h.metres || 0), 0);
  const rows = holes.map((h) => "<tr><td>" + h.hole + "</td><td>" + (h.par == null ? "" : h.par) + "</td>"
    + (hasIndex ? "<td>" + (h.index == null ? "" : h.index) + "</td>" : "")
    + "<td>" + distance(h.metres, yards) + "</td></tr>").join("");
  return '<h2 id="holes">Hole by hole</h2>'
    + '<p class="sub">Par and length in ' + unit + ' from the scorecard’s standard tee. On the course, Clarity measures from where you stand.</p>'
    + '<div class="card"><table><thead><tr><th>Hole</th><th>Par</th>' + (hasIndex ? "<th>Index</th>" : "") + "<th>" + (yards ? "Yards" : "Metres") + "</th></tr></thead>"
    + "<tbody>" + rows + "</tbody>"
    + "<tfoot><tr><td>Total</td><td>" + totalPar + "</td>" + (hasIndex ? "<td></td>" : "") + "<td>" + distance(totalLen, yards) + "</td></tr></tfoot></table></div>";
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
    + phoneFrames(images.frames, name)
    + holeTable(holes, yards)
    + '<footer class="foot"><span>&copy; Clarity Caddy</span><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/support">Support</a></footer>'
    + "</main></body></html>";
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
