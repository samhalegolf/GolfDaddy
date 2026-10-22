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
  assert.ok(ctx.calls.some((c) => c[0] === 'arc'), 'tree crowns drawn');
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
  assert.strictEqual(first.settings.mapStyle(), 'photo', 'a fresh device gets the photo');
  first.nodes.setMapStyle.listeners.click();
  assert.strictEqual(first.settings.mapStyle(), 'illustrated');
  assert.strictEqual(first.nodes.setMapStyle.textContent, 'gpsSettings.mapStyleIllustrated');
  assert.strictEqual(launch(store).settings.mapStyle(), 'illustrated', 'survives a relaunch');
  launch(store).nodes.setMapStyle.listeners.click();
  assert.strictEqual(launch(store).settings.mapStyle(), 'photo', 'cycles back');
  data['clarity:gps-settings:v1'] = JSON.stringify({ mapStyle: 'cartoon' });
  assert.strictEqual(launch(store).settings.mapStyle(), 'photo', 'unknown value falls back');
}

// painter wiring
assert.ok(/aerial: drawn \|\| aerialImg/.test(PAINTER_SRC), 'the drawn map replaces the photo on the mesh');
assert.ok(/if \(!drawn\) aerialImg\.src/.test(PAINTER_SRC), 'the photo is not fetched for the mesh when drawn');
assert.ok(/mapStyle\(\) !== "illustrated"/.test(PAINTER_SRC), 'photo style never paints');
assert.ok(/meshStyle === mapStyle\(\)/.test(PAINTER_SRC), 'a style change rebuilds the mesh');

console.log('illustrated-surface: all assertions passed');
