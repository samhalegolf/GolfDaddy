/*
 * Illustrated map (app/js/gd-illustrated-surface.js): the hole drawn from the course map and
 * handed to the terrain mesh in place of the aerial photo.
 *
 * Pinned here:
 *   - a hole counts as mapped only with a green or fairway of its own;
 *   - paint() draws every on-frame shape and skips the ones far off the frame;
 *   - fairway stripes run across the line of play (rotated to tee -> first route point);
 *   - the same seed paints the same picture;
 *   - packageHoles reads tee/green/route from lite and full packages alike;
 *   - placeTrees stands the watch's trees (buildHoleTrees) in the woods, off played ground,
 *     and the picture draws only their shadows - the mesh draws the trees;
 *   - the mesh draws trees far to near along the frame's own up;
 *   - the Map style setting defaults to Photo, cycles, survives a relaunch, and painter.js
 *     only swaps the picture (and rebuilds the mesh) when Illustrated is chosen.
 *
 * Run: node dev/illustrated-surface.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const lib = require(path.join(ROOT, 'app', 'js', 'gd-illustrated-surface.js'));
const watchCore = require(path.join(ROOT, 'scripts', 'gd-watch-map-core.js'));
const SETTINGS_SRC = fs.readFileSync(path.join(ROOT, 'app', 'js', 'gps-settings.js'), 'utf8');
const PAINTER_SRC = fs.readFileSync(path.join(ROOT, 'app', 'js', 'painter.js'), 'utf8');

/* A 2D context that records what it is asked to do. */
function recorder() {
  const calls = [];
  const ctx = { calls };
  ['beginPath', 'moveTo', 'lineTo', 'closePath', 'fill', 'stroke', 'clip', 'save', 'restore',
    'fillRect', 'arc', 'arcTo', 'translate', 'rotate'].forEach((name) => {
    ctx[name] = (...args) => calls.push([name, ...args]);
  });
  return ctx;
}

/* Ground as plain metres: lat is y, lng is x, 1 px per metre. */
const project = (pt) => ({ x: pt.lng, y: pt.lat });
const square = (x, y, size) => [
  { lat: y, lng: x }, { lat: y, lng: x + size }, { lat: y + size, lng: x + size }, { lat: y + size, lng: x }
];
const surface = (ring, holeNumber) => ({ ring, holeNumber });

function course() {
  return {
    fairways: [surface(square(100, 100, 60), 1)],
    greens: [surface(square(300, 110, 20), 1)],
    bunkers: [surface(square(280, 140, 8), 1), surface(square(9000, 9000, 8), 7)],
    water: [surface(square(180, 200, 40), 1)],
    trees: [surface(square(20, 20, 30), 1)],
    hazards: []
  };
}

function paint(overrides) {
  const ctx = recorder();
  const shapes = lib.paint(ctx, Object.assign({
    width: 400, height: 300, pxPerMetre: 1, project, surfaces: course(),
    holes: [{ holeNumber: 1, tee: { lat: 130, lng: 20 }, green: { lat: 120, lng: 310 }, route: [] }],
    seed: 1
  }, overrides));
  return { ctx, shapes };
}

// holeIsMapped
assert.strictEqual(lib.holeIsMapped(course(), 1), true);
assert.strictEqual(lib.holeIsMapped(course(), 7), false, 'a bunker alone is not a mapped hole');
assert.strictEqual(lib.holeIsMapped(null, 1), false);
assert.strictEqual(lib.holeIsMapped({ greens: [surface(square(0, 0, 5), 3)] }, '3'), true);

// paint: on-frame shapes drawn, the far-off bunker skipped
{
  const { ctx, shapes } = paint();
  assert.strictEqual(shapes, 5, 'fairway, green, near bunker, water, trees');
  assert.ok(!ctx.calls.some((c) => c[0] === 'arc' && c[3] < 8), 'no tree crowns painted: the mesh stands them up');
  assert.ok(!ctx.calls.some((c) => (c[0] === 'moveTo' || c[0] === 'lineTo') && c[1] >= 9000), 'off-frame bunker not traced');
}

// stripes rotate to the line of play
{
  const { ctx } = paint();
  const rotations = ctx.calls.filter((c) => c[0] === 'rotate').map((c) => c[1]);
  const play = Math.atan2(120 - 130, 310 - 20);
  assert.ok(rotations.some((r) => Math.abs(r - play) < 1e-9), 'fairway stripes follow tee -> green');

  const viaRoute = paint({ holes: [{ holeNumber: 1, tee: { lat: 130, lng: 20 }, green: { lat: 120, lng: 310 }, route: [{ lat: 130, lng: 20 }, { lat: 230, lng: 20 }] }] });
  const r2 = viaRoute.ctx.calls.filter((c) => c[0] === 'rotate').map((c) => c[1]);
  assert.ok(r2.some((r) => Math.abs(r - Math.PI / 2) < 1e-9), 'a dogleg stripes along its first leg');
}

// deterministic
assert.deepStrictEqual(paint().ctx.calls, paint().ctx.calls);
assert.notDeepStrictEqual(paint().ctx.calls, paint({ seed: 2 }).ctx.calls);

// nothing on the frame
assert.strictEqual(paint({ surfaces: { fairways: [surface(square(5000, 5000, 10), 1)] } }).shapes, 0);

// trees: placed by the watch's generator, shadowed on the picture
{
  /* Canvas px straight from world px at zoom 20, about 0.12 m/px at this latitude. */
  const zoom = 20, lat0 = -36.9, lng0 = 174.8;
  const w0 = watchCore.worldPx(lat0, lng0, zoom);
  const mpp = 40075016.686 * Math.cos(lat0 * Math.PI / 180) / (256 * Math.pow(2, zoom));
  const ll = (x, y) => watchCore.latLngFromWorldPx({ x: w0.x + x, y: w0.y + y }, zoom);
  const box = (x, y, sx, sy) => [ll(x, y), ll(x + sx, y), ll(x + sx, y + sy), ll(x, y + sy)];
  const spatialRef = { transform: { a: 1, b: 0, tx: -w0.x, ty: -w0.y }, refZoom: zoom, metresPerPixel: mpp, imageWidth: 1600, imageHeight: 1600 };
  const surfaces = {
    trees: [surface(box(100, 100, 800, 800), 1)],
    fairways: [surface(box(400, 400, 200, 200), 1)],
    greens: [], bunkers: [], water: []
  };
  const trees = lib.placeTrees(watchCore, surfaces, spatialRef);
  assert.ok(trees.length > 20, 'a wood becomes trees');
  assert.ok(trees.every((t) => t.x >= -20 && t.x <= 1020 && t.y >= -20 && t.y <= 1020), 'trees stand in the wood, give or take a ragged edge');
  assert.ok(!trees.some((t) => t.x > 410 && t.x < 590 && t.y > 410 && t.y < 590), 'none on the fairway');
  assert.ok(trees.every((t) => t.r > 0 && [0, 1, 2, 3].includes(t.type)));
  assert.deepStrictEqual(lib.placeTrees(watchCore, surfaces, spatialRef), trees, 'the same wood, the same trees');
  assert.deepStrictEqual(lib.placeTrees(null, surfaces, spatialRef), [], 'no generator, no trees');
  assert.deepStrictEqual(lib.placeTrees(watchCore, Object.assign({}, surfaces, { trees: [] }), spatialRef), []);

  /* A real tree marker: a big one drawn as an area (as the overlay's single trees reach the
     package) stays ONE tree at its own crown size, not a filled cluster. */
  const marker = { centre: ll(1200, 1200), rM: 12 };
  const markerArea = [ll(1100, 1100), ll(1300, 1100), ll(1300, 1300), ll(1100, 1300)];
  const withMarker = Object.assign({}, surfaces, { trees: [surface(markerArea, 1)] });
  const filled = lib.placeTrees(watchCore, withMarker, spatialRef);
  assert.ok(filled.length > 1, 'without the marker the area is filled as a wood');
  const single = lib.placeTrees(watchCore, withMarker, spatialRef, [{ lat: marker.centre.lat, lng: marker.centre.lng, r: marker.rM }]);
  assert.strictEqual(single.length, 1, 'one marker, one tree');
  assert.ok(Math.abs(single[0].x - 1200) <= 1 && Math.abs(single[0].y - 1200) <= 1, 'standing where the marker is');
  assert.ok(Math.abs(single[0].r - marker.rM / mpp) <= 1, 'at the marker\'s crown size');
  assert.strictEqual(lib.placeTrees(watchCore, Object.assign({}, surfaces, { trees: [] }), spatialRef, [{ lat: marker.centre.lat, lng: marker.centre.lng, r: 6 }]).length, 1,
    'markers stand with no wood on the map at all');

  const { ctx } = paint({ trees: [{ x: 50, y: 60, r: 5, type: 0 }, { x: 80, y: 90, r: 4, type: 2 }] });
  const shadows = ctx.calls.filter((c) => c[0] === 'arc' && (c[3] === 5 || c[3] === 4));
  assert.strictEqual(shadows.length, 2, 'one shadow per tree');
  assert.ok(shadows[0][1] > 50 && shadows[0][2] > 60, 'shadows fall bottom right');
}

// mesh draw order: far (up the screen) first
{
  global.window = {};
  require(path.join(ROOT, 'app', 'js', 'gd-terrain-mesh.js'));
  const order = global.window.GDTerrainMesh.treeDrawOrder;
  const trees = [{ x: 0, y: 50 }, { x: 0, y: 10 }, { x: 0, y: 90 }];
  assert.deepStrictEqual(order(trees, [0, -1]), [1, 0, 2], 'unrotated: top of the picture first');
  assert.deepStrictEqual(order([{ x: 90, y: 0 }, { x: 10, y: 0 }], [1, 0]), [0, 1], 'rotated: follows up');
  delete global.window;
}

// packageHoles: lite and full
{
  const lite = lib.packageHoles({ holes: [{ holeNumber: 1, tee: { lat: 1, lng: 2 }, green: { lat: 3, lng: 4 }, route: [{ lat: 1, lng: 2 }, { lat: 'x' }] }] });
  assert.deepStrictEqual(lite, [{ holeNumber: 1, tee: { lat: 1, lng: 2 }, green: { lat: 3, lng: 4 }, route: [{ lat: 1, lng: 2 }] }]);
  const full = lib.packageHoles({ status: 'full-map-ready', holes: [{ holeNumber: 2, geometry: { tee: { lat: 5, lng: 6 } } }] });
  assert.deepStrictEqual(full, [{ holeNumber: 2, tee: { lat: 5, lng: 6 }, green: null, route: [] }]);
  assert.deepStrictEqual(lib.packageHoles(null), []);
}

// the setting
function launch(store) {
  const nodes = {};
  const node = (id) => nodes[id] || (nodes[id] = {
    textContent: '', attrs: {}, listeners: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    classList: { add() {}, remove() {} }
  });
  let ready = null;
  const context = {
    localStorage: store,
    document: { getElementById: node, addEventListener: (type, fn) => { if (type === 'DOMContentLoaded') ready = fn; } }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(SETTINGS_SRC, context, { filename: 'gps-settings.js' });
  ready();
  return { settings: context.ClarityApp.gpsSettings, nodes };
}
{
  const data = {};
  const store = { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } };
  const first = launch(store);
  assert.strictEqual(first.settings.mapStyle(), 'auto', 'a fresh device gets auto: hybrid where the hole qualifies');
  first.nodes.setMapStyle.listeners.click();
  assert.strictEqual(first.settings.mapStyle(), 'photo');
  assert.strictEqual(first.nodes.setMapStyle.textContent, 'gpsSettings.mapStylePhoto');
  assert.strictEqual(launch(store).settings.mapStyle(), 'photo', 'a photo picked since auto survives a relaunch');
  launch(store).nodes.setMapStyle.listeners.click();
  assert.strictEqual(launch(store).settings.mapStyle(), 'illustrated');
  launch(store).nodes.setMapStyle.listeners.click();
  assert.strictEqual(launch(store).settings.mapStyle(), 'hybrid');
  launch(store).nodes.setMapStyle.listeners.click();
  assert.strictEqual(launch(store).settings.mapStyle(), 'auto', 'cycles back to auto');
  data['clarity:gps-settings:v1'] = JSON.stringify({ mapStyle: 'cartoon' });
  assert.strictEqual(launch(store).settings.mapStyle(), 'auto', 'unknown value falls back');
  /* Before auto, every save wrote mapStyle "photo" along with whatever had changed. */
  data['clarity:gps-settings:v1'] = JSON.stringify({ mapStyle: 'photo', units: 'yd' });
  assert.strictEqual(launch(store).settings.mapStyle(), 'auto', 'the old default photo riding along becomes auto');
  data['clarity:gps-settings:v1'] = JSON.stringify({ mapStyle: 'illustrated' });
  assert.strictEqual(launch(store).settings.mapStyle(), 'illustrated', 'illustrated was only ever a choice: kept');
  data['clarity:gps-settings:v1'] = JSON.stringify({ mapStyle: 'photo', mapStyleChosen: true });
  assert.strictEqual(launch(store).settings.mapStyle(), 'photo', 'a photo picked since auto is kept');
}

// painter wiring
assert.ok(/aerial: drawn && !hybrid \? drawn\.picture : aerialImg/.test(PAINTER_SRC), 'the drawn map replaces the photo on the mesh (a hybrid keeps the photo under it)');
assert.ok(/meshOptions\.overlay = drawn\.picture/.test(PAINTER_SRC), 'a hybrid lays the drawn map over the photo');
assert.ok(/trees: drawn \? drawn\.trees : null/.test(PAINTER_SRC), 'its trees go to the mesh');
assert.ok(/if \(!drawn \|\| threeD \|\| hybrid\) aerialImg\.src/.test(PAINTER_SRC), 'the photo is not fetched for the plain mesh when drawn (3D mode reads species off it, hybrid blends over it)');
assert.ok(/style !== "illustrated" && style !== "hybrid"/.test(PAINTER_SRC), 'photo style never paints');
assert.ok(/if \(chosen !== "auto"\) return chosen;/.test(PAINTER_SRC) && /lib\.holeQualifies\(pkg, loadedHole\) \? "hybrid" : "photo"/.test(PAINTER_SRC), 'auto is hybrid on a qualifying hole, the photo elsewhere');
assert.ok(/meshStyle === meshLook\(\)/.test(PAINTER_SRC) && /return style \+ \(view3d\(\) \? ":3d" : ""\) \+ \(style === "hybrid"/.test(PAINTER_SRC), 'a style change, 3D on or off, or a new hybrid look rebuilds the mesh');

console.log('illustrated-surface: all assertions passed');
