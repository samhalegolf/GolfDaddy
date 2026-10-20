#!/usr/bin/env node
"use strict";

/* The public course page (functions/course-page.mjs, /courses/<courseId>): renders a real page
   for a switched-on course, a 404 for anything else, picks the right scorecard, shows one tee,
   and the web gate lets /courses through. No network - Supabase is a stub. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const MAP = {
  course_id: "maungakiekie-golf-club", course_name: "Maungakiekie Golf Club", course_lat: -36.92, course_lng: 174.72,
  region: "Auckland", country: "New Zealand", country_code: "NZ", hole_count: 18, facility_key: "maungakiekie-golf-club",
  object_count: 690, bunker_count: 154, water_count: 4, tree_count: 491, published_at: "2026-10-14T00:00:00Z", updated_at: "2026-10-14T00:00:00Z"
};
const CARD = {
  course_key: "maungakiekie golf club", course_name: "Maungakiekie Golf Club",
  holes_json: [1, 2, 3].map((n) => ({ hole: n, par: 4, index: n, metres: 300 + n, tees: { White: { metres: 280 + n }, Blue: { metres: 320 + n } } }))
};

/* The course-pages bucket, as a store that lists these names under the course. */
function imageStub(names) {
  return {
    list: async (prefix) => names.filter((n) => n.startsWith(prefix.split("/").slice(1).join("/") || "") && !/\//.test(n.slice((prefix.split("/").slice(1).join("/") || "").length).replace(/^\//, ""))).map((n) => ({ name: n.split("/").pop() })),
    publicUrl: (p) => "https://cdn.test/" + p
  };
}
function deps(rows, names) { return { supabaseFetch: stub(rows), imageStore: imageStub(names || []) }; }

/* A PostgREST stub keyed on the table in the query string. */
function stub(rows) {
  return async (query) => {
    if (query.startsWith("course_maps?")) return query.includes("page_public=eq.true") ? rows.maps : [];
    if (query.startsWith("course_visuals?")) return rows.visuals;
    if (query.startsWith("course_scorecards?")) return rows.cards;
    if (query.startsWith("course_watch_maps?")) return rows.watch || [];
    if (query.startsWith("course_garmin_maps?")) return rows.garmin || [];
    throw new Error("unexpected query " + query);
  };
}

test("a switched-on course renders its page with the course in the title, meta and schema", async () => {
  const { loadCoursePage, renderCoursePage } = await import("../functions/course-page.mjs");
  const data = await loadCoursePage("maungakiekie-golf-club", deps({ maps: [MAP], visuals: [{ published_version: 1 }], cards: [CARD] }));
  assert.ok(data, "no data for a public course");
  const html = renderCoursePage(data, "https://example.test");
  assert.ok(/<title>Maungakiekie Golf Club — /.test(html), "title does not lead with the course");
  assert.ok(html.includes('rel="canonical" href="https://example.test/courses/maungakiekie-golf-club"'), "no canonical");
  assert.ok(!/noindex/.test(html), "the page must be indexable");
  assert.ok(/"@type":"GolfCourse"/.test(html) && /"numberOfHoles":18/.test(html), "no GolfCourse schema");
  assert.ok(html.includes("apps.apple.com") && html.includes("play.google.com"), "store badges missing");
  assert.ok(!/courses\/?"[^>]*>(All|Browse)/i.test(html), "the page must not link to a course directory");
});

test("the hole table shows one tee - the card's leading distance - never the other tees", async () => {
  const { loadCoursePage, renderCoursePage } = await import("../functions/course-page.mjs");
  const data = await loadCoursePage("maungakiekie-golf-club", deps({ maps: [MAP], visuals: [{ published_version: 1 }], cards: [CARD] }));
  const html = renderCoursePage(data, "https://example.test");
  assert.ok(/<td>1<\/td><td>4<\/td><td>1<\/td><td>301<\/td>/.test(html), "hole 1 row wrong: " + html.match(/<tbody>.*?<\/tr>/)[0]);
  assert.ok(!/<th>White<\/th>|<th>Blue<\/th>/.test(html), "other tees leaked into the table");
  assert.ok(/<th>M<\/th>/.test(html), "NZ reads metres");
  assert.ok(/<td>Total<\/td><td>12<\/td><td><\/td><td>906<\/td>/.test(html), "totals wrong");
});

test("eighteen holes split into Out and In, each with its own line, plus the total", async () => {
  const { renderCoursePage } = await import("../functions/course-page.mjs");
  const card = { holes_json: Array.from({ length: 18 }, (_, i) => ({ hole: i + 1, par: 4, metres: 300 })) };
  const html = renderCoursePage({ map: MAP, visual: {}, card }, "https://example.test");
  assert.strictEqual((html.match(/<table>/g) || []).length, 2);
  assert.ok(/<th>Out<\/th>/.test(html) && /<th>In<\/th>/.test(html));
  assert.ok(/<td>Out<\/td><td>36<\/td><td>2700<\/td>/.test(html) && /<td>In<\/td><td>36<\/td><td>2700<\/td>/.test(html), "nine-hole subtotals");
  assert.ok(/Total par 72 \u00b7 5400 m/.test(html), "grand total line");
});

test("a yards country converts the same card to yards", async () => {
  const { renderCoursePage } = await import("../functions/course-page.mjs");
  const html = renderCoursePage({ map: Object.assign({}, MAP, { country_code: "US" }), visual: {}, card: CARD }, "https://example.test");
  assert.ok(/<th>Yds<\/th>/.test(html) && /<td>329<\/td>/.test(html), "301 m should read 329 yards");
});

test("no images yet: no hero picture, no phone section, a plain summary card", async () => {
  const { loadCoursePage, renderCoursePage } = await import("../functions/course-page.mjs");
  const data = await loadCoursePage("maungakiekie-golf-club", deps({ maps: [MAP], visuals: [{ published_version: 1 }], cards: [CARD] }));
  const html = renderCoursePage(data, "https://example.test");
  assert.ok(!/class="heroShot"|id="phone"|og:image/.test(html));
  assert.ok(/twitter:card" content="summary"/.test(html));
});

test("uploaded frames become the hero, the phone section and the share image", async () => {
  const { loadCoursePage, renderCoursePage } = await import("../functions/course-page.mjs");
  const names = ["web/01-pre-lock.jpg", "web/02-head-to-tee.jpg", "web/03-approach.jpg", "og.png", "web"];
  const data = await loadCoursePage("maungakiekie-golf-club", deps({ maps: [MAP], visuals: [{ published_version: 1 }], cards: [CARD] }, names));
  assert.strictEqual(data.images.frames.length, 3);
  const html = renderCoursePage(data, "https://example.test");
  assert.ok(html.includes('class="heroShot" src="https://cdn.test/maungakiekie-golf-club/web/02-head-to-tee.jpg"'), "hero is the tee-shot frame");
  assert.ok(html.includes('property="og:image" content="https://cdn.test/maungakiekie-golf-club/og.png"'), "no og:image");
  assert.ok(/summary_large_image/.test(html) && /On your phone/.test(html));
  assert.strictEqual((html.match(/web\/0\d-[a-z-]+\.jpg/g) || []).length, 4, "three frames plus the hero");
});

test("a storage outage leaves the page up, just without pictures", async () => {
  const { loadImages } = await import("../functions/course-page.mjs");
  const images = await loadImages("x", { list: async () => { throw new Error("storage down"); }, publicUrl: () => "" });
  assert.deepStrictEqual(images, { frames: [], og: "" });
});

test("the runner's asset module: config, card markup and upload paths", async () => {
  const m = await import("../marketing/course-page-assets.mjs");
  assert.strictEqual(m.storageConfig({}), null);
  assert.deepStrictEqual(m.storageConfig({ SUPABASE_URL: "https://x.supabase.co/", SUPABASE_SERVICE_ROLE_KEY: "k" }), { base: "https://x.supabase.co", key: "k" });
  const card = m.ogCardHtml({ name: "Tara <Iti>", place: "", frames: ["data:a", "data:b", "data:c"] });
  assert.ok(card.includes("Tara &lt;Iti&gt;") && card.includes("Mapped course") && (card.match(/<img /g) || []).length === 2, "the card shows two phones and escapes the name");
  const calls = [];
  const paths = await m.uploadAssets("tara-iti", [{ path: "web/02-head-to-tee.jpg", buffer: Buffer.from("x"), type: "image/jpeg" }, { path: "og.png", buffer: Buffer.from("y"), type: "image/png" }],
    { base: "https://x.supabase.co", key: "k" }, async (url, init) => { calls.push({ url, init }); return { ok: true }; });
  assert.deepStrictEqual(paths, ["tara-iti/web/02-head-to-tee.jpg", "tara-iti/og.png"]);
  assert.strictEqual(calls[0].url, "https://x.supabase.co/storage/v1/object/course-pages/tara-iti/web/02-head-to-tee.jpg");
  assert.strictEqual(calls[0].init.headers["x-upsert"], "true");
  const bucketSql = read("supabase", "migrations", "20261020_create_course_pages_bucket.sql");
  assert.ok(/'course-pages', 'course-pages', true/.test(bucketSql), "the bucket must be public");
});

test("the watch section is course-locked and loads exactly the watch preview's scripts", async () => {
  const { loadCoursePage, renderCoursePage, WATCH_SCRIPTS } = await import("../functions/course-page.mjs");
  const data = await loadCoursePage("maungakiekie-golf-club", deps({ maps: [MAP], visuals: [{ published_version: 1 }], cards: [CARD] }));
  const html = renderCoursePage(data, "https://example.test");
  assert.ok(html.includes('id="preview" class="card isWide" data-course-id="maungakiekie-golf-club" data-course-name="Maungakiekie Golf Club"'), "no course-locked preview");
  ["watchTabs", "units", "courseLine", "holePrev", "hole", "holeNext", "presets", "bezel", "canvas", "buttons", "readout"].forEach((id) => assert.ok(html.includes('id="' + id + '"'), "missing #" + id));
  assert.ok(!/id="gate"|id="searchForm"/.test(html), "no gate and no search on a course page");
  const preview = read("watch-preview.html");
  const theirs = [...preview.matchAll(/<script src="([^"]+)"/g)].map((m) => "/" + m[1]);
  assert.deepStrictEqual(WATCH_SCRIPTS, theirs, "the course page and watch-preview.html must load the same scripts with the same labels");
  WATCH_SCRIPTS.forEach((src) => {
    assert.ok(html.includes('<script src="' + src + '"></script>'), "page does not load " + src);
    const file = src.slice(1).split("?")[0];
    assert.ok(fs.existsSync(path.join(ROOT, file)), file + " does not exist");
  });
  const script = read("scripts", "clarity-watch-preview.js");
  assert.ok(/getAttribute\("data-course-id"\)/.test(script), "the preview script does not read the course lock");
  assert.ok(/Making the " \+ watchName \+ " map/.test(script), "no building state while a package is made");
});

test("the Apple bake is asked for only when there is no package and nothing is running", async () => {
  const w = await import("../functions/lib/gd-apple-bake-wake.mjs");
  const now = Date.parse("2026-10-20T05:00:00Z");
  assert.strictEqual(w.appleBakeNeeded(null, now), true);
  assert.strictEqual(w.appleBakeNeeded({ ready_hole_count: 18 }, now), false);
  assert.strictEqual(w.appleBakeNeeded({ ready_hole_count: 0, progress: { updatedAt: "2026-10-20T04:55:00Z" } }, now), false, "a bake that moved five minutes ago is running");
  assert.strictEqual(w.appleBakeNeeded({ ready_hole_count: 0, progress: { updatedAt: "2026-10-20T04:00:00Z" } }, now), true, "a bake an hour old died");
  assert.strictEqual(w.secretMatches("abc", "abc"), true);
  assert.strictEqual(w.secretMatches("abd", "abc"), false);
  assert.strictEqual(w.secretMatches("", ""), false);
  const calls = [];
  const ok = await w.wakeAppleBake("https://example.test", "tara-iti", "s3cret", async (url, init) => { calls.push({ url, init }); return { status: 202, ok: true }; });
  assert.strictEqual(ok, true);
  assert.strictEqual(calls[0].url, "https://example.test/.netlify/functions/course-watch-maps-background");
  assert.strictEqual(calls[0].init.headers["x-clarity-service-secret"], "s3cret");
  assert.strictEqual(await w.wakeAppleBake("https://example.test", "tara-iti", "", async () => { throw new Error("must not be called"); }), false, "no secret, no wake");
  assert.strictEqual(await w.wakeAppleBake("https://example.test", "tara-iti", "s", async () => { throw new Error("down"); }), false, "a failed wake never throws");
  const worker = read("functions", "course-watch-maps-background.mjs");
  assert.ok(/secretMatches\(String\(req\.headers\.get\(SERVICE_SECRET_HEADER\)/.test(worker), "the worker does not accept the page's secret");
  assert.ok(/if \(fromPage && map\.page_public !== true\) return new Response\("not a public course page", \{ status: 403 \}\)/.test(worker), "the secret must only bake public-page courses");
});

test("a visitor's first click asks for the Apple bake; the render no longer does", async () => {
  const { coursePageWake, config } = await import("../functions/course-page-wake.mjs");
  assert.strictEqual(config.path, "/api/course-page-wake");
  const page = read("functions", "course-page.mjs");
  assert.ok(!/wakeAppleBake|appleBakeNeeded/.test(page), "the page function must not wake the bake on render (a render is mostly a crawler)");
  const client = read("scripts", "clarity-course-page.js");
  assert.ok(/\["pointerdown", "keydown"\]\.forEach\(function \(type\) \{ document\.addEventListener\(type, wake, \{ once: true/.test(client), "the first click or key does not wake the bake");
  assert.ok(/fetch\("\/api\/course-page-wake", \{ method: "POST"/.test(client), "the client does not post to the wake endpoint");
  assert.ok(/getAttribute\("data-course-id"\)/.test(client), "the client must take the course from the page's preview lock");
  const { PAGE_SCRIPTS } = await import("../functions/course-page.mjs");
  assert.ok(!PAGE_SCRIPTS.includes("/scripts/clarity-course-page.js?v=course-page-001"), "the client script's cache label must move with this change");

  const woken = [];
  const run = (body, rows, wakeOk = true, method = "POST", secret = "s3cret") => coursePageWake(new Request("https://example.test/api/course-page-wake", { method, body: method === "POST" ? JSON.stringify(body) : undefined }), {
    supabaseFetch: async (path) => path.startsWith("course_maps?") ? rows.maps : rows.watch,
    wake: async (origin, courseId, s) => { woken.push({ origin, courseId, secret: s }); return wakeOk; },
    secret
  });
  const PUBLIC = { maps: [{ course_id: "tara-iti" }], watch: [] };
  let res = await run({ courseId: "tara-iti" }, PUBLIC);
  assert.strictEqual(res.status, 202);
  assert.deepStrictEqual(await res.json(), { courseId: "tara-iti", apple: "queued" });
  assert.deepStrictEqual(woken, [{ origin: "https://example.test", courseId: "tara-iti", secret: "s3cret" }], "the wake carries the service secret to the worker");
  assert.strictEqual(res.headers.get("Cache-Control"), "no-store");

  woken.length = 0;
  res = await run({ courseId: "tara-iti" }, { maps: [{ course_id: "tara-iti" }], watch: [{ ready_hole_count: 18 }] });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { courseId: "tara-iti", apple: "ready" });
  res = await run({ courseId: "tara-iti" }, { maps: [{ course_id: "tara-iti" }], watch: [{ ready_hole_count: 0, progress: { updatedAt: new Date().toISOString() } }] });
  assert.strictEqual((await res.json()).apple, "building");
  assert.deepStrictEqual(woken, [], "a package that exists or is being made is never asked for again");

  res = await run({ courseId: "secret-club" }, { maps: [], watch: [] });
  assert.strictEqual(res.status, 404, "a course without a public page cannot be baked from the outside");
  assert.deepStrictEqual(woken, []);
  res = await run({}, PUBLIC);
  assert.strictEqual(res.status, 400);
  res = await run({ courseId: "tara-iti" }, PUBLIC, false);
  assert.strictEqual(res.status, 503, "a wake that did not get through says so, so the next click tries again");
  res = await run({ courseId: "tara-iti" }, PUBLIC, true, "GET");
  assert.strictEqual(res.status, 405);
  res = await run({ courseId: "tara-iti" }, PUBLIC, true, "POST", "");
  assert.strictEqual(res.status, 503, "no secret configured, no wake");
});

test("the picker: search-shaped, every result can ask for an upgrade, nothing lists courses", async () => {
  const { loadCoursePage, renderCoursePage, PAGE_SCRIPTS } = await import("../functions/course-page.mjs");
  const data = await loadCoursePage("maungakiekie-golf-club", deps({ maps: [MAP], visuals: [{ published_version: 1 }], cards: [CARD] }));
  const html = renderCoursePage(data, "https://example.test");
  ["findForm", "findInput", "findResults", "requestForm", "requestName", "requestEmail", "requestNote", "requestCancel"].forEach((id) => assert.ok(html.includes('id="' + id + '"'), "missing #" + id));
  PAGE_SCRIPTS.forEach((src) => {
    assert.ok(html.includes('<script src="' + src + '"></script>'), "page does not load " + src);
    assert.ok(fs.existsSync(path.join(ROOT, src.slice(1).split("?")[0])), src + " does not exist");
  });
  assert.ok(!/href="\/courses\/?"/.test(html), "no link to a course index");
  const picker = read("scripts", "clarity-course-page.js");
  assert.ok(/if \(mapped && r\.hasPage\) actions\.push\('<a class="cpAction isPrimary" href="\/courses\/'/.test(picker), "a result with a page links to it");
  assert.ok(/if \(!mapped\) actions\.push\(requestButton\("map"/.test(picker), "an unmapped course offers Map this course");
  assert.ok(/actions\.push\(requestButton\("upgrade", id, r\.name, false\)\);/.test(picker), "every result offers Request an upgrade");
  assert.ok(/fetch\("\/api\/watch-preview-request"/.test(picker) && /request: request\.kind, courseId: request\.courseId, courseName: request\.courseName/.test(picker), "the request is the watch preview's own, with the course on it");
});

test("the request endpoint takes map and upgrade requests about a course, same ticket, clear subject", async () => {
  const fn = await import("../functions/watch-preview-request.mjs");
  const up = fn.buildTicket({ name: "Sam", email: "sam@example.com", request: "upgrade", courseId: "tara-iti", courseName: "Tara Iti", note: "bunkers are off on 7" }, {});
  assert.strictEqual(up.ticket.happened, "Course request from Sam: upgrade this course's map - Tara Iti");
  assert.strictEqual(up.ticket.context.request, "upgrade");
  assert.strictEqual(up.ticket.context.courseId, "tara-iti");
  assert.strictEqual(up.ticket.source, "clarity-caddy-watch-preview-request", "same ticket source as the watch preview");
  const mail = fn.renderEmail(up.ticket, "row-9");
  assert.ok(mail.subject.startsWith("Clarity Caddy course request (upgrade) · Tara Iti · Sam"), mail.subject);
  assert.ok(mail.text.includes("Course: Tara Iti (tara-iti)") && mail.html.includes("bunkers are off on 7"));
  const map = fn.buildTicket({ name: "Sam", email: "sam@example.com", request: "map", courseName: "Nowhere Links" }, {});
  assert.ok(map.ticket.happened.includes("map this course - Nowhere Links"));
  assert.strictEqual(fn.buildTicket({ name: "Sam", email: "sam@example.com", request: "map" }, {}).code, "course_required");
  assert.strictEqual(fn.buildTicket({ name: "Sam", email: "sam@example.com", request: "demolish", courseName: "X" }, {}).ticket.context.request, "", "an unknown request kind is a plain sign-up");
  const plain = fn.buildTicket({ name: "Sam", email: "sam@example.com", watch: "apple" }, {});
  assert.ok(plain.ticket.happened.startsWith("Watch preview sign-up request from Sam"), "the watch preview's own request is unchanged");
  assert.ok(fn.renderEmail(plain.ticket, null).subject.startsWith("Clarity Caddy watch preview request · Sam"));
});

test("course search says which results have a public page", async () => {
  const core = await import("../functions/lib/gd-course-search-core.mjs");
  const rows = core.listingsFromClarity([
    { id: 1, course_id: "tara-iti", course_name: "Tara Iti", course_lat: -36.2, course_lng: 174.6, hole_count: 18, page_public: true },
    { id: 2, course_id: "parkes", course_name: "Parkes Golf Club", course_lat: -33, course_lng: 148, hole_count: 18, page_public: false }
  ]);
  assert.strictEqual(core.publicResult(rows[0]).hasPage, true);
  assert.strictEqual(core.publicResult(rows[1]).hasPage, false);
  assert.ok(/hole_count,page_public"/.test(read("functions", "course-search.mjs")), "the search does not select page_public");
  assert.ok(/m\.page_public\s+FROM public\.course_maps m/.test(read("supabase", "migrations", "20261020_course_maps_list_page_public.sql")));
});

test("being found: sitemap of public courses, robots, and a way in from the landing", async () => {
  const sm = await import("../functions/sitemap.mjs");
  assert.strictEqual(sm.config.path, "/sitemap.xml");
  const courses = await sm.publicCourses(async (q) => {
    if (q.startsWith("course_visuals")) { assert.ok(/published_version=gt\.0/.test(q), q); return [{ course_id: "tara-iti" }]; }
    if (q.startsWith("course_garmin_maps")) { assert.ok(/garmin_package_version=gt\.0/.test(q), q); return [{ course_id: "garmin-only" }]; }
    assert.ok(/page_public=eq\.true/.test(q) && /published=eq\.true/.test(q), q);
    /* nothing-yet is switched on but has neither a visual nor a Garmin package - its page is a
       404, so not listed; garmin-only renders (watch-first), so it is. The page function's rule. */
    return [{ course_id: "tara-iti", updated_at: "2026-10-14T06:28:55.241Z" }, { course_id: "garmin-only" }, { course_id: "nothing-yet" }, { course_id: "" }];
  });
  assert.deepStrictEqual(courses.map((c) => c.course_id), ["tara-iti", "garmin-only"]);
  const xml = sm.renderSitemap("https://caddy.test", courses);
  assert.ok(xml.includes("<loc>https://caddy.test/courses/tara-iti</loc><lastmod>2026-10-14</lastmod>"), xml);
  assert.ok(xml.includes("<loc>https://caddy.test/welcome</loc>") && !/\/app|\/studio/.test(xml));
  const robots = read("robots.txt");
  assert.ok(/Allow: \/courses\//.test(robots) && /Disallow: \/studio\//.test(robots) && /Sitemap: https:\/\/caddy\.claritygolf\.app\/sitemap\.xml/.test(robots));
  assert.ok(/"robots\.txt"/.test(read("scripts", "clarity-deploy-build.js")), "robots.txt is not deployed");
  const welcome = read("welcome.html");
  const links = [...welcome.matchAll(/href="\/courses\/([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.ok(links.length >= 3 && links.length <= 5, "a handful of featured course links, not a directory: " + links.length);
  assert.ok(/data-i18n="welcome\.courseLinksTitle"/.test(welcome));
  fs.readdirSync(path.join(ROOT, "scripts/i18n")).filter((f) => f.endsWith(".js")).forEach((f) => assert.ok(read("scripts/i18n", f).includes('"welcome.courseLinksTitle"'), f + " lacks the heading"));
});

test("no card: the page still renders, without a hole table", async () => {
  const { loadCoursePage, renderCoursePage } = await import("../functions/course-page.mjs");
  const data = await loadCoursePage("maungakiekie-golf-club", deps({ maps: [MAP], visuals: [{ published_version: 1 }], cards: [] }));
  const html = renderCoursePage(data, "https://example.test");
  assert.ok(!/<table/.test(html) && /<h1>/.test(html));
});

test("not switched on, or nothing to show: nothing to render", async () => {
  const { loadCoursePage } = await import("../functions/course-page.mjs");
  assert.strictEqual(await loadCoursePage("x", deps({ maps: [], visuals: [], cards: [] })), null);
  assert.strictEqual(await loadCoursePage("x", deps({ maps: [MAP], visuals: [{ published_version: 0 }], cards: [] })), null);
  assert.strictEqual(await loadCoursePage("x", deps({ maps: [MAP], visuals: [], cards: [], garmin: [{ garmin_package_version: 0 }] })), null);
});

test("no Clarity visual but a Garmin package: the page renders on the watch map alone", async () => {
  const { loadCoursePage, renderCoursePage } = await import("../functions/course-page.mjs");
  const data = await loadCoursePage("maungakiekie-golf-club", deps({ maps: [MAP], visuals: [], cards: [CARD], garmin: [{ garmin_package_version: 1760000000000 }] }));
  assert.ok(data, "a course outside licensed imagery still gets its page");
  assert.strictEqual(data.visual, null);
  const html = renderCoursePage(data, "https://example.test");
  assert.ok(html.includes('id="preview" class="card isWide"') && /<h1>/.test(html));
});

test("picking the card: own name first, the facility's only card second, a named sibling third", async () => {
  const { pickCard } = await import("../functions/course-page.mjs");
  const own = { course_key: "akarana golf course", course_name: "Akarana Golf Course", holes_json: [{ hole: 1 }] };
  const other = { course_key: "maungakiekie golf club", course_name: "Maungakiekie Golf Club", holes_json: [{ hole: 1 }] };
  assert.strictEqual(pickCard([other, own], "Akarana Golf Course"), own);
  assert.strictEqual(pickCard([other], "Akarana Golf Course"), other, "a facility's single card is the course's card");
  assert.strictEqual(pickCard([other, { course_key: "z", course_name: "Z Links", holes_json: [{ hole: 1 }] }], "Akarana Golf Course"), null, "two cards, neither ours: no table rather than a wrong one");
  assert.strictEqual(pickCard([{ course_key: "empty", holes_json: [] }], "Akarana Golf Course"), null);
});

test("the mapper's placeholder loop names are hidden; real loop names are kept", async () => {
  const { displayName } = await import("../functions/course-page.mjs");
  assert.strictEqual(displayName("Millbrook Golf Resort - Course 1 - 6298m North-West"), "Millbrook Golf Resort");
  assert.strictEqual(displayName("Taupo Golf Club - Tauhara"), "Taupo Golf Club – Tauhara");
  assert.strictEqual(displayName("Te Arai Links - North Course"), "Te Arai Links - North Course", "no club designator: the name is left exactly as stored");
  assert.strictEqual(displayName("Tara Iti"), "Tara Iti");
});

test("the function answers 404 (noindex) for an unknown course and routes /courses/:courseId", async () => {
  const mod = await import("../functions/course-page.mjs");
  assert.strictEqual(mod.config.path, "/courses/:courseId");
  const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = "https://stub.supabase.co"; process.env.SUPABASE_SERVICE_ROLE_KEY = "k";
  const realFetch = global.fetch;
  global.fetch = async () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    const res = await mod.default(new Request("https://example.test/courses/nowhere-golf-club"));
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.headers.get("X-Robots-Tag"), "noindex");
    assert.ok(/isn[’']t on Clarity yet/.test(await res.text()));
  } finally {
    global.fetch = realFetch;
    if (saved.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = saved.url;
    if (saved.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
  }
});

test("the web gate lets /courses through and still gates the app", () => {
  const gate = read("netlify", "edge-functions", "web-app-gate.js");
  assert.ok(/PUBLIC_TREES = \/\^\\\/courses/.test(gate), "no PUBLIC_TREES for /courses");
  assert.ok(/if \(PUBLIC_TREES\.test\(pathname\)\) return false;/.test(gate), "isGated does not consult PUBLIC_TREES");
  assert.ok(/GATED_TREES = \/\^\\\/\(studio\|app\|demo\)/.test(gate), "the app trees must stay gated");
});

test("the page_public migration exists and defaults to off", () => {
  const sql = read("supabase", "migrations", "20261020_course_maps_page_public.sql");
  assert.ok(/add column if not exists page_public boolean not null default false/.test(sql));
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.stack || err)); }
  }
  console.log(failed ? failed + " failed" : tests.length + "/" + tests.length + " passed");
  process.exit(failed ? 1 : 0);
})();
