#!/usr/bin/env node
"use strict";

/* The hybrid map style's settings and where they live:
     - scripts/gd-hybrid-look.js: normalize (the stored shape), look/ambient (what the renderers
       take) and holeQualifies (Auto's rule: the watch maps' criteria)
     - functions/play-view.mjs: anyone reads the saved look, only an admin saves it, and both
       ways go through normalize
   No network - fetch is a stub. The drawing itself is dev/course-3d-framed.test.js's. */
const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const H = require(path.join(ROOT, "scripts", "gd-hybrid-look.js"));
let passed = 0;
const ok = (name) => { passed += 1; console.log("  ok  " + name); };

(async function run() {
  /* ---- the shape ---- */
  assert.deepStrictEqual(H.normalize(null), H.DEFAULTS);
  assert.deepStrictEqual(H.normalize({ nonsense: 1 }), H.DEFAULTS);
  const n = H.normalize({
    blend: 140, method: "screen", detail: "80", saturation: -5, shading: 30, where: "surfaces",
    featherM: 99, trees: "low", surfaces: { greens: false, bunkers: "yes", extra: true }
  });
  assert.strictEqual(n.blend, 100);
  assert.strictEqual(n.method, "mix", "an unknown method falls back");
  assert.strictEqual(n.detail, 80);
  assert.strictEqual(n.saturation, 0);
  assert.strictEqual(n.shading, 30);
  assert.strictEqual(n.where, "surfaces");
  assert.strictEqual(n.featherM, 15);
  assert.strictEqual(n.trees, "low");
  assert.strictEqual(n.surfaces.greens, false);
  assert.strictEqual(n.surfaces.bunkers, H.DEFAULTS.surfaces.bunkers, "only a real true/false changes a surface");
  assert.ok(!("extra" in n.surfaces));
  assert.strictEqual(H.normalize({ shading: null }).shading, null, "null shading stays automatic");
  ok("normalize clamps every number, keeps only known choices and fills the rest from the defaults");

  const l = H.look({ blend: 40, detail: 150, saturation: 90, shading: null, method: "detail" });
  assert.deepStrictEqual(l, { blend: 0.4, method: "detail", detail: 1.5, saturation: 0.9, shading: null });
  assert.strictEqual(H.ambient(l, 0.78, 0.5), 0.78 + (0.5 - 0.78) * 0.4, "automatic shading follows the blend");
  assert.strictEqual(H.ambient(H.look({ shading: 25 }), 0.78, 0.5), 0.75, "set shading is the light, whatever the blend");
  ok("look is the renderers' fractions; ambient follows the blend unless shading is set");

  /* ---- which looks change the green (Play leaves its sharper green photo off for them) ---- */
  assert.strictEqual(H.changesGreens(null), true, "the default look blends everywhere");
  assert.strictEqual(H.changesGreens({ blend: 0 }), false, "blend 0 is the photo");
  assert.strictEqual(H.changesGreens({ blend: 0, saturation: 60 }), true, "photo colour changes every pixel");
  assert.strictEqual(H.changesGreens({ where: "surfaces", surfaces: { greens: false } }), false, "masked off the greens");
  assert.strictEqual(H.changesGreens({ where: "surfaces", surfaces: { greens: true } }), true, "masked onto the greens");
  ok("changesGreens: any blend that reaches a green, or any change to the photo's colour");

  /* ---- Auto's rule: the watch maps' ---- */
  const green = { lat: -36.9, lng: 174.7 };
  const full = { status: "full-map-ready", holes: [{ holeNumber: 1, geometry: { green } }, { holeNumber: 2, geometry: { tee: green } }] };
  const lite = { status: "lite-geo-ready", holes: [{ holeNumber: 3, green }] };
  assert.strictEqual(H.holeQualifies(full, 1), true, "published map, hole with a green");
  assert.strictEqual(H.holeQualifies(full, 2), false, "no green on the hole: the watch builds no frame for it either");
  assert.strictEqual(H.holeQualifies(full, 9), false, "a hole the package does not have");
  assert.strictEqual(H.holeQualifies(lite, 3), true, "a lite package is a published map too, its holes flat");
  assert.strictEqual(H.holeQualifies({ status: "processing", holes: lite.holes }, 3), false, "no published map, no watch map");
  assert.strictEqual(H.holeQualifies(null, 1), false);
  assert.strictEqual(H.holeQualifies({ status: "full-map-ready", holes: [{ holeNumber: 1, geometry: { green: { lat: "x" } } }] }, 1), false);
  ok("holeQualifies is the watch maps' criteria: a published map, and a green on the hole");

  /* ---- the API ---- */
  const mod = await import(pathToFileURL(path.join(ROOT, "functions", "play-view.mjs")).href);
  assert.strictEqual(mod.config.path, "/api/play-view");
  const req = (method, body, bearer) => mod.default(new Request("https://caddy.test/api/play-view", {
    method, headers: Object.assign({ "Content-Type": "application/json" }, bearer ? { Authorization: "Bearer " + bearer } : {}),
    body: body ? JSON.stringify(body) : undefined
  }));

  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  let res = await req("GET");
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual((await res.json()).hybrid, H.DEFAULTS, "no database: Play still gets a complete look");
  ok("without a database the GET answers the defaults rather than failing Play");

  process.env.SUPABASE_URL = "https://db.example.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  let who = "samhalegolf@gmail.com";
  let stored = null;
  const reply = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  global.fetch = async function (url, init) {
    const target = String(url);
    init = init || {};
    if (target.includes("/auth/v1/user")) return { ok: !!who, status: who ? 200 : 401, json: async () => ({ id: "u1", email: who }), text: async () => "" };
    if (target.includes("play_view_settings")) {
      if (init.method === "POST") { stored = JSON.parse(init.body); return reply([]); }
      return reply(stored ? [{ settings: stored.settings, updated_at: stored.updated_at }] : []);
    }
    return reply([]);
  };

  res = await req("GET");
  let body = await res.json();
  assert.deepStrictEqual([body.saved, body.hybrid], [false, H.DEFAULTS], "nothing saved: the defaults, marked as such");
  assert.ok(/max-age=60/.test(res.headers.get("cache-control")), "a short shared cache: every round reads it");

  res = await req("POST", { hybrid: { blend: 70 } }, "tok");
  assert.strictEqual(res.status, 200);
  assert.strictEqual(stored.id, "hybrid");
  assert.strictEqual(stored.updated_by, "samhalegolf@gmail.com");
  assert.deepStrictEqual(stored.settings, H.normalize({ blend: 70 }), "stored normalised, never as sent");

  res = await req("GET");
  body = await res.json();
  assert.deepStrictEqual([body.saved, body.hybrid.blend], [true, 70]);
  ok("an admin's save is stored normalised and read back by anyone");

  who = "player@example.com";
  res = await req("POST", { hybrid: { blend: 5 } }, "tok");
  assert.strictEqual(res.status, 403, "only an admin may save");
  res = await req("POST", { hybrid: { blend: 5 } });
  assert.strictEqual(res.status, 403, "no token, no save");
  who = "samhalegolf@gmail.com";
  res = await req("POST", { nothing: true }, "tok");
  assert.strictEqual(res.status, 400);
  assert.strictEqual(stored.settings.blend, 70, "refused saves change nothing");
  ok("saving is admin only, and needs a look to save");

  console.log("play-view passed: " + passed + " checks");
})().catch((e) => { console.error(e); process.exit(1); });
