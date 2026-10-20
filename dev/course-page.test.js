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
  assert.ok(/<th>Metres<\/th>/.test(html), "NZ reads metres");
  assert.ok(/<td>Total<\/td><td>12<\/td><td><\/td><td>906<\/td>/.test(html), "totals wrong");
});

test("a yards country converts the same card to yards", async () => {
  const { renderCoursePage } = await import("../functions/course-page.mjs");
  const html = renderCoursePage({ map: Object.assign({}, MAP, { country_code: "US" }), visual: {}, card: CARD }, "https://example.test");
  assert.ok(/<th>Yards<\/th>/.test(html) && /<td>329<\/td>/.test(html), "301 m should read 329 yards");
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

test("no card: the page still renders, without a hole table", async () => {
  const { loadCoursePage, renderCoursePage } = await import("../functions/course-page.mjs");
  const data = await loadCoursePage("maungakiekie-golf-club", deps({ maps: [MAP], visuals: [{ published_version: 1 }], cards: [] }));
  const html = renderCoursePage(data, "https://example.test");
  assert.ok(!/<table/.test(html) && /<h1>/.test(html));
});

test("not switched on, or no published visual: nothing to render", async () => {
  const { loadCoursePage } = await import("../functions/course-page.mjs");
  assert.strictEqual(await loadCoursePage("x", deps({ maps: [], visuals: [], cards: [] })), null);
  assert.strictEqual(await loadCoursePage("x", deps({ maps: [MAP], visuals: [{ published_version: 0 }], cards: [] })), null);
  assert.strictEqual(await loadCoursePage("x", deps({ maps: [MAP], visuals: [], cards: [] })), null);
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
