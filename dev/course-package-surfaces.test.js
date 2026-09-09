#!/usr/bin/env node
/* Surfaces (fairway/bunker/water rings) travel to the phone through the course package, not
 * the library mirror. This locks the client half: how a package - lite or full - becomes the
 * surface object records GPS Play reads, and that the library merge stops drawing a cached
 * full copy over the top once the package has written its own.
 *
 * Same technique as dev/course-library-client.test.js: the functions are lifted out of the
 * pin-lock IIFE by signature and run with their few dependencies stubbed. */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "scripts", "gd-course-library-pin-lock.js"), "utf8");

function extract(signature, terminator) {
  const idx = src.indexOf(signature);
  assert.notStrictEqual(idx, -1, "could not find " + signature);
  const end = src.indexOf(terminator, idx);
  assert.notStrictEqual(end, -1, "could not bound " + signature);
  return src.slice(idx, end + terminator.length);
}

function load() {
  const code = [
    "const PACKAGE_SURFACE_BUCKETS={fairways:'fairway_area',bunkers:'bunker',water:'water'};",
    extract("function isSurfaceObject(object){", "\n\t  }"),
    extract("function surfaceShapeKey(shape){", "\n\t  }"),
    extract("function packageSurfaceRecords(pkg){", "\n\t  }"),
    extract("function withoutSurfaceObjects(objects){", "\n  }")
  ].join("\n");
  const scope = {
    toPlain: ll => (ll ? { lat: Number(ll.lat), lng: Number(ll.lng) } : null),
    shapeCentroid: shape => ({
      lat: shape.reduce((s, p) => s + p.lat, 0) / shape.length,
      lng: shape.reduce((s, p) => s + p.lng, 0) / shape.length
    })
  };
  const names = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  const build = new Function(names.join(","), code + "\nreturn {isSurfaceObject,packageSurfaceRecords,withoutSurfaceObjects};");
  return build.apply(null, names.map(n => scope[n]));
}

const api = load();
const ring = [{ lat: -44.949, lng: 168.819 }, { lat: -44.9491, lng: 168.8192 }, { lat: -44.9493, lng: 168.8191 }];
const ring2 = [{ lat: -44.95, lng: 168.82 }, { lat: -44.9502, lng: 168.8203 }, { lat: -44.9504, lng: 168.8201 }, { lat: -44.9503, lng: 168.8198 }];

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log("  ok  " + name); }

test("lite package: surfaces per hole become typed records keyed by OSM id", () => {
  const records = api.packageSurfaceRecords({
    status: "lite-geo-ready",
    objectsVersion: "2026-09-02T18:32:37.840Z",
    holes: [
      { holeNumber: 1, surfaces: { fairway: null, fairways: [{ shape: ring, center: { lat: -44.9491, lng: 168.8191 }, osmId: "way/1" }], bunkers: [{ shape: ring2, center: null, osmId: "way/2" }], water: [{ shape: ring, center: null, osmId: "way/3", hazardClass: "penalty_area" }] } },
      { holeNumber: 2, surfaces: null }
    ]
  });
  assert.strictEqual(records.length, 3);
  const byType = Object.fromEntries(records.map(r => [r.type, r]));
  assert.strictEqual(byType.fairway_area.holeNumber, 1);
  assert.strictEqual(byType.fairway_area.osmId, "way/1");
  assert.deepStrictEqual(byType.fairway_area.position, { lat: -44.9491, lng: 168.8191 });
  assert.strictEqual(byType.bunker.shape.length, 4);
  assert.ok(Number.isFinite(byType.bunker.position.lat), "a missing centre falls back to the ring centroid");
  assert.strictEqual(byType.water.hazardClass, "penalty_area");
  assert.strictEqual(byType.fairway_area.id, "pkg-fairway_area:way-1", "ids are storage-safe: the slash in an OSM id becomes a dash");
});

test("full package: the same surfaces sit under hole.geometry", () => {
  const records = api.packageSurfaceRecords({
    status: "full-map-ready",
    holes: [{ holeNumber: 4, geometry: { surfaces: { fairways: [], bunkers: [{ shape: ring, osmId: "way/9" }], water: [] } }, visual: {} }]
  });
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].type, "bunker");
  assert.strictEqual(records[0].holeNumber, 4);
});

test("a surface the server cloned onto two holes is kept once, on the first hole", () => {
  const records = api.packageSurfaceRecords({
    status: "lite-geo-ready",
    holes: [
      { holeNumber: 3, surfaces: { fairways: [], bunkers: [{ shape: ring, osmId: "way/7" }], water: [] } },
      { holeNumber: 4, surfaces: { fairways: [], bunkers: [{ shape: ring, osmId: "way/7" }], water: [] } }
    ]
  });
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].holeNumber, 3);
});

test("no OSM id: identical rings dedupe by shape, different rings do not", () => {
  const records = api.packageSurfaceRecords({
    status: "lite-geo-ready",
    holes: [
      { holeNumber: 1, surfaces: { fairways: [], bunkers: [{ shape: ring }], water: [] } },
      { holeNumber: 2, surfaces: { fairways: [], bunkers: [{ shape: ring }, { shape: ring2 }], water: [] } }
    ]
  });
  assert.strictEqual(records.length, 2);
  assert.ok(records.every(r => /^pkg-bunker:shape-/.test(r.id)));
});

test("junk is dropped: short rings, bad points, unknown buckets, missing holes", () => {
  const records = api.packageSurfaceRecords({
    status: "lite-geo-ready",
    holes: [
      { holeNumber: 1, surfaces: { fairways: [{ shape: [{ lat: 1, lng: 2 }, { lat: 2, lng: 3 }] }], bunkers: [{ shape: [{ lat: "x", lng: 1 }, { lat: 1, lng: 1 }, { lat: 2, lng: 2 }] }], water: [], rough: [{ shape: ring }] } }
    ]
  });
  assert.strictEqual(records.length, 0);
  assert.deepStrictEqual(api.packageSurfaceRecords(null), []);
  assert.deepStrictEqual(api.packageSurfaceRecords({ status: "processing" }), []);
});

test("isSurfaceObject: fairway/water always, bunker only with a ring (a bunker pin is not a surface)", () => {
  assert.strictEqual(api.isSurfaceObject({ type: "fairway_area" }), true);
  assert.strictEqual(api.isSurfaceObject({ type: "water", shape: ring }), true);
  assert.strictEqual(api.isSurfaceObject({ type: "bunker", shape: ring }), true);
  assert.strictEqual(api.isSurfaceObject({ type: "bunker", position: { lat: 1, lng: 1 } }), false);
  assert.strictEqual(api.isSurfaceObject({ type: "green", shape: ring }), false);
  assert.strictEqual(api.isSurfaceObject(null), false);
});

test("withoutSurfaceObjects strips a cached full copy's surfaces and keeps everything else", () => {
  const out = api.withoutSurfaceObjects({
    g: { id: "g", type: "green", shape: ring },
    t: { id: "t", type: "tee" },
    pin: { id: "pin", type: "bunker", position: { lat: 1, lng: 1 } },
    b: { id: "b", type: "bunker", shape: ring },
    w: { id: "w", type: "water", shape: ring },
    f: { id: "f", type: "fairway_area", shape: ring }
  });
  assert.deepStrictEqual(Object.keys(out).sort(), ["g", "pin", "t"]);
});

console.log("course-package-surfaces: " + passed + " tests passed");
