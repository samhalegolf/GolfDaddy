/* GET /sitemap.xml - the public pages, for crawlers.
 *
 * The landing, the watch preview's public neighbours (privacy, terms, support) and every
 * public course page (course_maps.page_public - see functions/course-page.mjs). This is the
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

export async function publicCourses(fetchRows = supabaseFetch) {
  const rows = await fetchRows("course_maps?select=course_id,published_at,updated_at&page_public=eq.true&published=eq.true&order=course_id.asc&limit=1000");
  return (Array.isArray(rows) ? rows : []).filter((r) => r && r.course_id);
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
