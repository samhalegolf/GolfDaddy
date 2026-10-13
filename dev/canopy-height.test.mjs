/* Tree heights for the tree finder: the tiles a box needs, and the box's window of each read
 * into the grid Studio lines up with its capture - without a network.
 *
 * Run: node dev/canopy-height.test.mjs */

import assert from "node:assert/strict";

const lib = await import("../functions/lib/gd-canopy-height.mjs");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const R = 6378137;
const merc = (lat, lng) => ({ x: lng * Math.PI / 180 * R, y: Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * R });

/* A geotiff.js stand-in: one band, origin and cell size as given, heights[row][col]. */
function fakeTiff({ crs, origin, res, width, height, at, nodata }) {
  const keys = crs === "EPSG:3857" ? { ProjectedCSTypeGeoKey: 3857 } : crs === "EPSG:4326" ? { GeographicTypeGeoKey: 4326 } : { ProjectedCSTypeGeoKey: 2193 };
  const image = {
    getGeoKeys: () => keys, getOrigin: () => origin, getResolution: () => res, getWidth: () => width, getHeight: () => height,
    getGDALNoData: () => (nodata == null ? null : nodata),
    readRasters: async ({ window: [x0, y0, x1, y1] }) => {
      const out = new Uint8Array((x1 - x0) * (y1 - y0));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out[(y - y0) * (x1 - x0) + x - x0] = at(x, y);
      return out;
    }
  };
  return { getImage: async () => image };
}

test("a box is read from the quadkey tile it sits in, or each one it straddles", () => {
  assert.strictEqual(lib.quadkeyAt(-36.85, 174.76, 10).length, 10);
  assert.ok(lib.quadkeyAt(-36.85, 174.76, 10).startsWith("3113"), "Auckland is in the 3113 quarter: " + lib.quadkeyAt(-36.85, 174.76, 10));
  assert.deepStrictEqual(lib.quadkeysFor({ north: -36.85, south: -36.851, east: 174.761, west: 174.76 }).length, 1);
  /* Tile edges at zoom 10 fall every 360/1024 degrees of longitude. */
  const edge = 360 / 1024 * 980 - 180;
  assert.strictEqual(lib.quadkeysFor({ north: 10.001, south: 10, east: edge + 0.001, west: edge - 0.001 }).length, 2);
  assert.ok(lib.canopyTileUrl("0123").endsWith("/0123.tif"));
});

test("a Web Mercator tile's window covers the box and reads its heights, nodata as 0", async () => {
  const bounds = { north: -36.85, south: -36.852, east: 174.762, west: 174.76 };
  const nw = merc(bounds.north, bounds.west);
  const origin = [nw.x - 120, nw.y + 60];
  const tiff = fakeTiff({ crs: "EPSG:3857", origin, res: [1.2, -1.2], width: 4000, height: 4000, nodata: 255, at: (x, y) => (x === 100 && y === 50 ? 12 : x === 101 && y === 50 ? 255 : 0) });
  const grid = await lib.readTileWindow(tiff, bounds);
  assert.strictEqual(grid.crs, "EPSG:3857");
  assert.ok(grid.x0 <= nw.x && grid.x0 + grid.width * grid.dx >= merc(bounds.south, bounds.east).x, "the window spans the box east to west");
  assert.ok(grid.y0 >= nw.y && grid.y0 + grid.height * grid.dy <= merc(bounds.south, bounds.east).y, "and north to south");
  const col = Math.round((origin[0] + 100 * 1.2 - grid.x0) / grid.dx), row = Math.round((origin[1] - 50 * 1.2 - grid.y0) / grid.dy);
  assert.strictEqual(grid.heights[row * grid.width + col], 12, "the tall cell is where it was");
  assert.strictEqual(grid.heights[row * grid.width + col + 1], 0, "nodata reads as nothing");
});

test("a tile that cannot be read is reported, and a projection that would not line up is refused", async () => {
  const bounds = { north: 51.501, south: 51.5, east: -0.1, west: -0.102 };
  const out = await lib.readCanopy(bounds, { openTiff: async () => { throw new Error("HTTP 404"); } });
  assert.strictEqual(out.grids.length, 0);
  assert.ok(out.missing.length >= 1 && /404/.test(out.missing[0].reason));
  const odd = await lib.readCanopy(bounds, { openTiff: async () => fakeTiff({ crs: "other", origin: [0, 0], res: [1, -1], width: 10, height: 10, at: () => 0 }) });
  assert.ok(/projection/.test(odd.missing[0].reason));
  const geo = await lib.readCanopy(bounds, { openTiff: async () => fakeTiff({ crs: "EPSG:4326", origin: [-0.2, 51.6], res: [0.00001, -0.00001], width: 20000, height: 20000, at: () => 5 }) });
  assert.strictEqual(geo.grids[0].crs, "EPSG:4326", "lat/lng tiles are passed on as they are");
});

let failed = 0;
for (const t of tests) {
  try { await t.fn(); console.log("  ok  " + t.name); }
  catch (error) { failed++; console.log("FAIL  " + t.name + "\n      " + (error && error.stack || error)); }
}
console.log((failed ? "FAILED " + failed + "/" : "passed ") + tests.length + " canopy height checks");
process.exit(failed ? 1 : 0);
