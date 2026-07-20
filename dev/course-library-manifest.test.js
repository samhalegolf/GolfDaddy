/* The course library manifest.
 *
 * A device holds a local library of downloaded courses for speed and needs to
 * know whether that copy is stale. The whole point is that asking is cheap: if
 * the manifest read payload columns, checking freshness would cost as much as
 * re-downloading, which is what it exists to avoid.
 *
 * These run the real handler with fetch stubbed, so both the response shape and
 * the queries it issues are checked. */
const assert = require("assert");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FN = path.join(ROOT, "functions", "course-library.mjs");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

/* Capture every Supabase query the handler makes so the "cheap" claim is
   testable rather than asserted in a comment. */
function stubSupabase(tables) {
  const queries = [];
  const original = global.fetch;
  global.fetch = async function (url) {
    const u = String(url);
    queries.push(u);
    const table = u.includes("course_visuals") ? "course_visuals" : "course_maps";
    const rows = tables[table] || [];
    return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
  };
  return {
    queries,
    restore: function () { global.fetch = original; }
  };
}

function withEnv(fn) {
  const prev = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-key";
  return Promise.resolve(fn()).finally(function () {
    if (prev.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prev.url;
    if (prev.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prev.key;
  });
}

async function callHandler(tables, url) {
  const mod = await import("file://" + FN + "?t=" + Math.random());
  const stub = stubSupabase(tables);
  try {
    const res = await mod.default({ method: "GET", url: url || "https://x/api/course-library" });
    const body = JSON.parse(await res.text());
    return { status: res.status, body: body, queries: stub.queries, headers: res.headers };
  } finally {
    stub.restore();
  }
}

const COURSE = {
  course_id: "takapuna-golf-course",
  course_name: "Takapuna Golf Course",
  course_lat: -36.78,
  course_lng: 174.76,
  hole_count: 17,
  published_at: "2026-07-20T02:00:00.000Z",
  updated_at: "2026-07-20T02:30:00.000Z"
};

test("returns one small row per published course", async () => {
  await withEnv(async () => {
    const r = await callHandler({ course_maps: [COURSE], course_visuals: [] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.count, 1);
    const c = r.body.courses[0];
    assert.strictEqual(c.course_id, "takapuna-golf-course");
    assert.strictEqual(c.course_name, "Takapuna Golf Course");
    assert.strictEqual(c.hole_count, 17, "a 17 hole course reports 17, not a padded 18");
  });
});

test("never returns course payloads - that is the entire point", async () => {
  await withEnv(async () => {
    const r = await callHandler({ course_maps: [COURSE], course_visuals: [] });
    const c = r.body.courses[0];
    ["objects", "objects_json", "holes", "holes_json", "course_json", "assets_json"].forEach(function (key) {
      assert.strictEqual(c[key], undefined, "manifest must not carry " + key);
    });
  });
});

test("does not even ask Supabase for payload columns", async () => {
  await withEnv(async () => {
    const r = await callHandler({ course_maps: [COURSE], course_visuals: [] });
    const mapQuery = r.queries.find(function (q) { return q.includes("course_maps"); });
    assert.ok(mapQuery, "a course_maps query must be issued");
    ["objects_json", "holes_json", "course_json", "assets_json"].forEach(function (col) {
      assert.ok(
        !mapQuery.includes(col),
        "selecting " + col + " would read tens of kilobytes per course to answer a freshness question"
      );
    });
    assert.ok(mapQuery.includes("hole_count"), "hole_count must come from the denormalised column");
  });
});

test("reports objects and Clarity map versions independently", async () => {
  await withEnv(async () => {
    const r = await callHandler({
      course_maps: [COURSE],
      course_visuals: [{ course_id: "takapuna-golf-course", published_version: 3, status: "published" }]
    });
    const c = r.body.courses[0];
    assert.strictEqual(c.objects_version, "2026-07-20T02:30:00.000Z", "newest of published_at/updated_at");
    assert.strictEqual(c.clarity_map_version, 3);
    assert.strictEqual(c.clarity_map_status, "published");
  });
});

test("a course with no Clarity map reports null, not an error", async () => {
  await withEnv(async () => {
    const r = await callHandler({ course_maps: [COURSE], course_visuals: [] });
    assert.strictEqual(r.body.courses[0].clarity_map_version, null);
    assert.strictEqual(r.body.courses[0].clarity_map_status, null);
  });
});

test("hole_count is null rather than guessed for pre-migration rows", async () => {
  await withEnv(async () => {
    const legacy = Object.assign({}, COURSE, { hole_count: null });
    const r = await callHandler({ course_maps: [legacy], course_visuals: [] });
    assert.strictEqual(
      r.body.courses[0].hole_count, null,
      "guessing 18 here is what caused the hole-count bugs in the first place"
    );
  });
});

test("since= issues a delta query", async () => {
  await withEnv(async () => {
    const r = await callHandler(
      { course_maps: [COURSE], course_visuals: [] },
      "https://x/api/course-library?since=2026-07-19T00:00:00.000Z"
    );
    const mapQuery = r.queries.find(function (q) { return q.includes("course_maps"); });
    assert.ok(mapQuery.includes("updated_at=gt."), "since must filter server side, not client side");
    assert.strictEqual(r.body.since, "2026-07-19T00:00:00.000Z");
  });
});

test("no visual query is issued when there are no courses", async () => {
  await withEnv(async () => {
    const r = await callHandler({ course_maps: [], course_visuals: [] });
    assert.strictEqual(r.body.count, 0);
    assert.strictEqual(
      r.queries.filter(function (q) { return q.includes("course_visuals"); }).length, 0,
      "an empty library must not cost a second round trip"
    );
  });
});

test("unconfigured Supabase fails clearly instead of pretending the library is empty", async () => {
  const prev = process.env.SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  try {
    const mod = await import("file://" + FN + "?t=" + Math.random());
    const res = await mod.default({ method: "GET", url: "https://x/api/course-library" });
    const body = JSON.parse(await res.text());
    assert.strictEqual(res.status, 503);
    assert.strictEqual(body.configured, false, "an empty list would look like 'no courses exist'");
  } finally {
    if (prev !== undefined) process.env.SUPABASE_URL = prev;
  }
});

test("only GET is allowed", async () => {
  await withEnv(async () => {
    const mod = await import("file://" + FN + "?t=" + Math.random());
    const res = await mod.default({ method: "POST", url: "https://x/api/course-library" });
    assert.strictEqual(res.status, 405);
  });
});

test("the response is not cached", async () => {
  await withEnv(async () => {
    const r = await callHandler({ course_maps: [COURSE], course_visuals: [] });
    assert.strictEqual(
      r.headers.get("Cache-Control"), "no-store",
      "a cached manifest would defeat the freshness check it exists to answer"
    );
  });
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("course-library-manifest failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("course-library-manifest passed: " + tests.length + " checks");
})();
