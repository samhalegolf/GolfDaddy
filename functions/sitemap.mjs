/* GET /sitemap.xml - the public pages, for crawlers.
 *
 * The landing, the watch preview's public neighbours (privacy, terms, support) and every
 * live public course page (see functions/course-page.mjs and publicCourses below). This is the
 * only place the public course pages are listed together, and it is for crawlers: no page
 * links here, and nothing on the site renders it, because the site deliberately has no
 * course directory. Cached an hour at the CDN; a course switched on shows up within that. */

import { createSupabaseFetch } from "./lib/gd-supabase-fetch.mjs";

const STATIC_PAGES = ["/welcome", "/privacy", "/terms", "/support"];

function env(name) { return process.env[name] || ""; }
const supabaseFetch = createSupabaseFetch({
  base: () => env("SUPABASE_URL").replace(/\/+$/, ""),
  key: () => env("SUPABASE_SERVICE_ROLE_KEY"),
  label: "sitemap"
});

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function day(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "";
}

export function renderSitemap(origin, courses) {
  const urls = STATIC_PAGES.map((p) => ({ loc: origin + p }))
    .concat(courses.map((c) => ({ loc: origin + "/courses/" + encodeURIComponent(c.course_id), lastmod: day(c.updated_at || c.published_at) })));
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + urls.map((u) => "  <url><loc>" + esc(u.loc) + "</loc>" + (u.lastmod ? "<lastmod>" + u.lastmod + "</lastmod>" : "") + "</url>").join("\n")
    + "\n</urlset>\n";
}

/* Only pages that actually render: switched on, published, AND something to show - a
   published visual or a Garmin package - the same conditions functions/course-page.mjs
   loadCoursePage checks. A switched-on course with neither is a 404, and a sitemap full of
   404s is what teaches a crawler to distrust it. */
export async function publicCourses(fetchRows = supabaseFetch) {
  const [rows, visuals, garmins] = await Promise.all([
    fetchRows("course_maps?select=course_id,published_at,updated_at&page_public=eq.true&published=eq.true&order=course_id.asc&limit=5000"),
    fetchRows("course_visuals?select=course_id&published_version=gt.0&limit=5000"),
    fetchRows("course_garmin_maps?select=course_id&garmin_package_version=gt.0&limit=5000")
  ]);
  const ids = (list) => new Set((Array.isArray(list) ? list : []).map((v) => v && v.course_id));
  const visual = ids(visuals), garmin = ids(garmins);
  return (Array.isArray(rows) ? rows : []).filter((r) => r && r.course_id && (visual.has(r.course_id) || garmin.has(r.course_id)));
}

export default async function sitemap(req) {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const origin = new URL(req.url).origin;
  let courses = [];
  try { courses = await publicCourses(); } catch (error) { /* the static pages still list */ }
  return new Response(renderSitemap(origin, courses), {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Netlify-CDN-Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400"
    }
  });
}

export const config = { path: "/sitemap.xml" };
