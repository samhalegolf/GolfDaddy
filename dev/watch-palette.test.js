/* Watch map course palettes: the palette rules, the pixel filters, the aerial sampler on a
   synthetic hole photo, and the Sentinel-2 seasonal sampler against fake STAC/COG data (no
   network). Run: node dev/watch-palette.test.js */
const assert = require("assert");
const path = require("path");
const sharp = require("sharp");
const palette = require("../scripts/gd-watch-palette-core.js");
const watchMapCore = require("../scripts/gd-watch-map-core.js");

let passed = 0;
async function check(name, fn) {
  try { await fn(); console.log("  PASS  " + name); passed++; }
  catch (e) { console.log("  FAIL  " + name + "\n        " + (e && e.stack || e)); process.exitCode = 1; }
}
const lab = (L, C, h) => ({ L, a: C * Math.cos(h * Math.PI / 180), b: C * Math.sin(h * Math.PI / 180) });
function hexToRgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function repeat(rgb, count) { const out = []; for (let i = 0; i < count; i++) out.push(rgb[0], rgb[1], rgb[2]); return out; }

(async () => {
  const seasons = await import(path.join(__dirname, "..", "functions", "lib", "gd-sentinel-seasons.mjs"));
  const colours = await import(path.join(__dirname, "..", "functions", "lib", "gd-watch-course-colours.mjs"));

  console.log("\n— palette rules —");

  await check("the recipe's colours ARE the base palette", () => {
    const base = palette.basePalette().colors;
    assert.deepStrictEqual(watchMapCore.WATCH_MAP_RECIPE_V1.colors, base,
      "gd-watch-map-core.js keeps a literal copy of the base palette; it must not drift");
  });

  await check("no tint, however extreme, closes the lightness gaps", () => {
    let worst = Infinity;
    for (let h = 0; h < 360; h += 15) {
      for (const C of [0, 0.05, 0.15, 0.3]) {
        const m = {};
        for (const role of Object.keys(palette.ROLES)) m[role] = Object.assign(lab(0.5, C, h), { sources: ["test"] });
        const gaps = palette.lightnessGaps(palette.buildCoursePalette(m).colors);
        Object.values(gaps).forEach(g => { worst = Math.min(worst, g); });
      }
    }
    assert.ok(worst >= palette.MIN_LIGHTNESS_GAP - 0.005,
      "every neighbouring pair must stay at least " + palette.MIN_LIGHTNESS_GAP + " apart, worst was " + worst);
  });

  await check("tints stay inside each role's hue band", () => {
    const m = {};
    for (const role of Object.keys(palette.ROLES)) m[role] = Object.assign(lab(0.5, 0.2, 10), { sources: ["test"] });
    const roles = palette.buildCoursePalette(m).roles;
    Object.keys(palette.ROLES).forEach(role => {
      const spec = palette.ROLES[role], got = roles[role];
      assert.ok(got.h >= spec.hueMin - 1e-6 && got.h <= spec.hueMax + 1e-6, role + " hue " + got.h + " left its band");
      assert.strictEqual(got.L, spec.L, role + " lightness must never move");
    });
  });

  await check("a course measuring exactly the base colour keeps the base palette", () => {
    const m = {};
    Object.keys(palette.ROLES).forEach(role => { const s = palette.ROLES[role]; m[role] = Object.assign(lab(s.L, s.C, s.h), { sources: ["t"] }); });
    assert.deepStrictEqual(palette.buildCoursePalette(m).colors, palette.basePalette().colors);
  });

  console.log("\n— measuring pixels —");

  await check("turf measurement ignores trees, paths and roofs", () => {
    const grass = [96, 140, 70];
    const rgb = [].concat(repeat(grass, 400), repeat([20, 35, 18], 300), repeat([128, 128, 128], 300), repeat([150, 60, 50], 200));
    const got = palette.summariseSamples(rgb, "fairway");
    const want = palette.rgbToOklab(grass[0], grass[1], grass[2]);
    assert.ok(Math.abs(got.a - want.a) < 0.002 && Math.abs(got.b - want.b) < 0.002, "median must land on the grass");
  });

  await check("too few pixels is no measurement, not a guess", () => {
    assert.strictEqual(palette.summariseSamples(repeat([96, 140, 70], 10), "fairway"), null);
    assert.strictEqual(palette.summariseSamples(repeat([128, 128, 128], 500), "fairway"), null, "grey is not grass");
  });

  await check("sand and water have their own filters", () => {
    assert.ok(palette.summariseSamples(repeat([235, 220, 180], 200), "bunker"));
    assert.strictEqual(palette.summariseSamples(repeat([96, 140, 70], 200), "bunker"), null, "grass is not sand");
    assert.ok(palette.summariseSamples(repeat([40, 90, 140], 200), "water"));
  });

  await check("the year outweighs the aerial day 2:1, and the green follows the fairway", () => {
    const aerial = { fairway: { L: 0.6, a: -0.09, b: 0.09 } };
    const seasonal = { months: { "2026-01": { fairway: { L: 0.5, a: -0.12, b: 0.03 } }, "2026-07": { fairway: { L: 0.5, a: -0.12, b: 0.03 } } } };
    const m = palette.combineMeasurements(aerial, seasonal);
    assert.ok(Math.abs(m.fairway.a - (-0.09 + 2 * -0.12) / 3) < 1e-4);
    assert.ok(Math.abs(m.fairway.b - (0.09 + 2 * 0.03) / 3) < 1e-4);
    assert.deepStrictEqual(m.fairway.sources, ["aerial", "sentinel-2"]);
    assert.deepStrictEqual([m.green.a, m.green.b], [m.fairway.a, m.fairway.b]);
  });

  await check("the year is a median over months, so a run of summer scenes cannot outvote winter", () => {
    const months = {};
    ["01", "02", "03"].forEach(k => { months["2026-" + k] = { fairway: { L: 0.5, a: -0.1, b: 0.02 } }; });
    ["04", "05"].forEach(k => { months["2026-" + k] = { fairway: { L: 0.5, a: -0.2, b: 0.1 } }; });
    const y = palette.seasonalYear(months, "fairway");
    assert.strictEqual(y.a, -0.1); assert.strictEqual(y.months, 5);
  });

  console.log("\n— Sentinel-2 —");

  await check("UTM matches pyproj to the millimetre", () => {
    [[-36.9174, 174.74, 60, true, 298682.113925662, 5911905.047422316],
     [51.5, -0.12, 30, false, 699889.8069851057, 5709362.292819306]].forEach(([lat, lng, z, s, x, y]) => {
      const p = seasons.utmForward(lat, lng, z, s);
      assert.ok(Math.abs(p.x - x) < 0.001 && Math.abs(p.y - y) < 0.001);
    });
    assert.deepStrictEqual(seasons.utmZoneOf("EPSG:32760"), { zone: 60, south: true });
    assert.deepStrictEqual(seasons.utmZoneOf(32630), { zone: 30, south: false });
    assert.strictEqual(seasons.utmZoneOf(4326), null);
  });

  const bounds = { south: -36.92, west: 174.735, north: -36.915, east: 174.745 };
  function item(id, datetime, cloud, extra) {
    return Object.assign({
      id, bbox: [174.0, -37.5, 175.5, -36.0],
      properties: { datetime, "eo:cloud_cover": cloud, "proj:code": "EPSG:32760" },
      assets: { visual: { href: "visual:" + id }, scl: { href: "scl:" + id } }
    }, extra || {});
  }

  await check("search keeps the least cloudy scene per month that covers the whole course", async () => {
    const features = [
      item("a", "2026-05-03T22:00:00Z", 30), item("b", "2026-05-18T22:00:00Z", 5),
      item("c", "2026-04-10T22:00:00Z", 12, { bbox: [174.74, -37.5, 175.5, -36.0] }), // misses the west edge
      item("d", "2026-03-02T22:00:00Z", 8),
      item("e", "2026-02-02T22:00:00Z", 1)
    ];
    let calls = 0;
    const fetchImpl = async () => { calls++; return { ok: true, json: async () => ({ features, links: [] }) }; };
    const found = await seasons.searchScenes(bounds, { now: Date.parse("2026-10-01"), fetchImpl, skipMonths: ["2026-02"] });
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(found.map(f => f.month + ":" + f.item.id), ["2026-05:b", "2026-03:d"]);
  });

  /* A fake COG pair over a fake course: a 400m x 400m window at 10m, a square fairway in the
     middle, grass-green inside it and darker rough around - and a cloud (SCL 9) over the west
     third painted bright red, which must never reach the measurement. */
  const centre = seasons.utmForward(-36.9175, 174.74, 60, true);
  const ox = Math.floor(centre.x / 10) * 10 - 200, oy = Math.floor(centre.y / 10) * 10 + 200;
  const FAIR = [92, 150, 60], ROUGH = [60, 100, 45], CLOUD = [230, 40, 40];
  function fakeTiff(kind) {
    const res = kind === "scl" ? 20 : 10;
    const w = 400 / res, h = 400 / res, bands = kind === "scl" ? 1 : 3;
    return {
      getImage: async () => ({
        getOrigin: () => [ox, oy], getResolution: () => [res, -res],
        getWidth: () => w, getHeight: () => h, getSamplesPerPixel: () => bands,
        readRasters: async ({ window: [x0, y0, x1, y1] }) => {
          const out = new Uint8Array((x1 - x0) * (y1 - y0) * bands);
          for (let r = y0; r < y1; r++) for (let c = x0; c < x1; c++) {
            const x = ox + (c + 0.5) * res, y = oy - (r + 0.5) * res;
            const o = ((r - y0) * (x1 - x0) + (c - x0)) * bands;
            const cloudy = x < ox + 130;
            if (kind === "scl") { out[o] = cloudy ? 9 : 4; continue; }
            const inFair = Math.abs(x - (ox + 200)) < 80 && Math.abs(y - (oy - 200)) < 80;
            const px = cloudy ? CLOUD : inFair ? FAIR : ROUGH;
            out[o] = px[0]; out[o + 1] = px[1]; out[o + 2] = px[2];
          }
          return out;
        }
      })
    };
  }
  /* The same square, back in lat/lng, as the course's only fairway. */
  /* UTM back to lat/lng by iterating the forward transform - plenty for a test fixture. */
  function toLatLng(x, y) {
    let lat = -36.9175, lng = 174.74;
    for (let i = 0; i < 60; i++) {
      const p = seasons.utmForward(lat, lng, 60, true);
      lat += (y - p.y) / 111320; lng += (x - p.x) / (111320 * Math.cos(lat * Math.PI / 180));
    }
    return { lat, lng };
  }
  const fx = ox + 200, fy = oy - 200;
  const fairwayRing = [toLatLng(fx - 80, fy - 80), toLatLng(fx + 80, fy - 80), toLatLng(fx + 80, fy + 80), toLatLng(fx - 80, fy + 80)];
  const sw = toLatLng(ox, oy - 400), ne = toLatLng(ox + 400, oy);
  const course = { rings: { fairways: [fairwayRing], greens: [], bunkers: [], water: [], tees: [] },
    bounds: { south: sw.lat + 0.0004, west: sw.lng + 0.0004, north: ne.lat - 0.0004, east: ne.lng - 0.0004 } };

  await check("a scene measures fairway and rough from clear cells only", async () => {
    const m = await seasons.sampleScene(item("s", "2026-05-01T00:00:00Z", 3), course, async href => fakeTiff(href.split(":")[0]));
    const fair = palette.rgbToOklab(FAIR[0], FAIR[1], FAIR[2]);
    assert.ok(m.fairway && Math.abs(m.fairway.a - fair.a) < 0.002 && Math.abs(m.fairway.b - fair.b) < 0.002, "fairway is the fairway's colour");
    assert.ok(m.rough, "rough band measured");
    const red = palette.rgbToOklab(CLOUD[0], CLOUD[1], CLOUD[2]);
    assert.ok(Math.abs(m.rough.a - red.a) > 0.1, "the cloud never reaches the measurement");
  });

  await check("a course record resumes where a cut-short run stopped, and goes stale after 60 days", async () => {
    const features = ["2026-05", "2026-06", "2026-07"].map((m, i) => item("i" + i, m + "-10T00:00:00Z", 2));
    const fetchImpl = async () => ({ ok: true, json: async () => ({ features, links: [] }) });
    const openTiff = async href => fakeTiff(href.split(":")[0]);
    const now = Date.parse("2026-10-01");
    const first = await seasons.sampleCourseSeasons(course, { now, fetchImpl, openTiff, deadlineMs: -1 });
    assert.strictEqual(first.complete, false, "a run past its deadline says so");
    assert.strictEqual(Object.keys(first.months).length, 0);
    const second = await seasons.sampleCourseSeasons(course, { previous: first, now, fetchImpl, openTiff });
    assert.strictEqual(second.complete, true);
    assert.deepStrictEqual(Object.keys(second.months).sort(), ["2026-05", "2026-06", "2026-07"]);
    assert.ok(/Copernicus Sentinel data 2026$/.test(second.attribution));
    assert.strictEqual(seasons.seasonsAreFresh(second, course.bounds, now + 1000), true);
    assert.strictEqual(seasons.seasonsAreFresh(second, course.bounds, now + 61 * 24 * 3600 * 1000), false);
    assert.strictEqual(seasons.seasonsAreFresh(second, Object.assign({}, course.bounds, { north: course.bounds.north + 0.01 }), now), false,
      "a course whose ground moved is measured again");
  });

  console.log("\n— aerial photos —");

  await check("the aerial sampler measures each surface from a real north-up frame", async () => {
    /* A 600x600 frame at z19 with a fairway, a bunker inside it, and water off to the side,
       each painted in its own colour on rough - placed with the exact rule the bake uses. */
    const z = 19, lat0 = -36.9175, lng0 = 174.74;
    const c = watchMapCore.worldPx(lat0, lng0, z);
    const originPx = { x: c.x - 300, y: c.y - 300 };
    const mpp = 156543.03392 * Math.cos(lat0 * Math.PI / 180) / Math.pow(2, z);
    const at = (dxM, dyM) => {
      const wx = c.x + dxM / mpp, wy = c.y + dyM / mpp, n = Math.pow(2, z) * 256;
      return { lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * wy / n))) * 180 / Math.PI, lng: wx / n * 360 - 180 };
    };
    const sq = (cx, cy, r) => [at(cx - r, cy - r), at(cx + r, cy - r), at(cx + r, cy + r), at(cx - r, cy + r)];
    const FAIRWAY = "#5c963c", SAND = "#e6d7aa", WATER = "#2a5c8c", ROUGHC = "#3c6428";
    const px = m => m / mpp;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">' +
      '<rect width="600" height="600" fill="' + ROUGHC + '"/>' +
      '<rect x="' + (300 - px(30)) + '" y="' + (300 - px(30)) + '" width="' + px(60) + '" height="' + px(60) + '" fill="' + FAIRWAY + '"/>' +
      '<rect x="' + (300 - px(5)) + '" y="' + (300 - px(5)) + '" width="' + px(10) + '" height="' + px(10) + '" fill="' + SAND + '"/>' +
      '<rect x="' + (300 + px(45)) + '" y="' + (300 - px(10)) + '" width="' + px(10) + '" height="' + px(20) + '" fill="' + WATER + '"/>' +
      '</svg>';
    const buffer = await sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toBuffer();
    const surfaces = { rings: { fairways: [sq(0, 0, 30)], bunkers: [sq(0, 0, 5)], water: [[at(45, -10), at(55, -10), at(55, 10), at(45, 10)]], greens: [], tees: [] } };
    const m = await colours.sampleAerial([{ buffer, captureZoom: z, originPx }], surfaces);
    const near = (got, hex, role) => {
      const want = palette.hexToOklab(hex);
      assert.ok(got, role + " measured");
      assert.ok(Math.abs(got.a - want.a) < 0.01 && Math.abs(got.b - want.b) < 0.01, role + " lands on its own colour");
    };
    near(m.fairway, FAIRWAY, "fairway");
    near(m.bunker, SAND, "bunker (inside the fairway's outline, still sand)");
    near(m.water, WATER, "water");
    near(m.rough, ROUGHC, "rough");
  });

  await check("courseSurfaces gathers every hole once, with tees as no-measure circles", () => {
    const shared = [{ lat: -36.91, lng: 174.73 }, { lat: -36.911, lng: 174.73 }, { lat: -36.911, lng: 174.731 }];
    const objects = {
      t1: { type: "tee", holeNumber: 1, position: { lat: -36.9, lng: 174.7 } },
      g1: { type: "green", holeNumber: 1, position: { lat: -36.91, lng: 174.71 } },
      f1: { type: "fairway_area", holeNumber: 1, shape: shared },
      f2: { type: "fairway_area", holeNumber: 2, shape: shared },
      g2: { type: "green", holeNumber: 2, position: { lat: -36.92, lng: 174.72 } }
    };
    const s = colours.courseSurfaces(objects, [1, 2]);
    assert.strictEqual(s.rings.fairways.length, 1, "a shared ribbon is one fairway");
    assert.strictEqual(s.rings.tees.length, 1);
    assert.ok(s.bounds && s.bounds.south < s.bounds.north);
  });

  console.log("\n" + passed + " watch palette checks passed.");
})();
