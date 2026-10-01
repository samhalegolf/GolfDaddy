/*
 * Terrain relief is a player setting: how far the live-play terrain mesh
 * (app/js/gd-terrain-mesh.js) lifts the ground, from off to 5x.
 *
 * Pinned here: a fresh device gets Enhanced (2.5x, what the mesh always drew
 * before the setting existed); the button cycles Off -> Natural -> Enhanced ->
 * Dramatic and back; the choice survives a relaunch; an unknown stored value
 * falls back to the default; and painter.js reads the setting rather than a
 * hard-coded height, and drops the mesh entirely when relief is off.
 *
 * Run: node dev/terrain-relief-setting.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SETTINGS_SRC = fs.readFileSync(path.join(ROOT, 'app', 'js', 'gps-settings.js'), 'utf8');
const PAINTER_SRC = fs.readFileSync(path.join(ROOT, 'app', 'js', 'painter.js'), 'utf8');

function deviceStore(initial) {
  const data = Object.assign({}, initial || {});
  return {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
    data
  };
}

/* A launch: fresh globals over one device store, with just enough DOM for the
   relief row and its click handler. */
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
    document: {
      getElementById: node,
      addEventListener: (type, fn) => { if (type === 'DOMContentLoaded') ready = fn; }
    }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(SETTINGS_SRC, context, { filename: 'gps-settings.js' });
  ready();
  const settings = context.ClarityApp.gpsSettings;
  return {
    raw: { settings, nodes },
    relief: () => settings.get().relief,
    factor: () => settings.reliefExaggeration(),
    click: () => nodes.setRelief.listeners.click(),
    label: () => nodes.setRelief.textContent,
    sub: () => nodes.setReliefSub.textContent
  };
}

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('ok  - ' + name); }

ok('a fresh device gets Enhanced, the 2.5x the mesh always drew', () => {
  const app = launch(deviceStore());
  assert.strictEqual(app.relief(), 'enhanced');
  assert.strictEqual(app.factor(), 2.5);
  assert.strictEqual(app.label(), 'gpsSettings.reliefEnhanced');
  assert.strictEqual(app.sub(), 'gpsSettings.reliefEnhancedHint');
});

ok('the button cycles Dramatic, Off, Natural and back to Enhanced', () => {
  const app = launch(deviceStore());
  const seen = [];
  for (let i = 0; i < 4; i++) { app.click(); seen.push([app.relief(), app.factor()]); }
  assert.deepStrictEqual(seen, [['dramatic', 5], ['off', 0], ['natural', 1], ['enhanced', 2.5]]);
});

ok('the choice survives a relaunch', () => {
  const store = deviceStore();
  launch(store).click();   // enhanced -> dramatic
  assert.strictEqual(launch(store).relief(), 'dramatic');
});

ok('an unknown stored value falls back to Enhanced', () => {
  const store = deviceStore({ 'clarity:gps-settings:v1': JSON.stringify({ relief: 'extreme' }) });
  assert.strictEqual(launch(store).relief(), 'enhanced');
});

ok('painter takes the height from the setting, not a constant', () => {
  assert.ok(!/mesh\.state\.exaggeration\s*=\s*2\.5/.test(PAINTER_SRC), 'the hard-coded 2.5 is back');
  assert.ok(/mesh\.state\.exaggeration\s*=\s*reliefExaggeration\(\)/.test(PAINTER_SRC));
});

ok('relief off never builds a mesh, and a settings change re-syncs it', () => {
  const attach = PAINTER_SRC.slice(PAINTER_SRC.indexOf('function attachMesh('));
  assert.ok(/if \(!\(reliefExaggeration\(\) > 0\)\) \{ noMesh\(""\); return; \}/.test(attach.slice(0, 600)));
  const handler = PAINTER_SRC.slice(PAINTER_SRC.indexOf('gpsSettings.onChange(function () {')).slice(0, 300);
  assert.ok(/syncMeshRelief\(\);/.test(handler), 'a settings change must re-sync the mesh height');
});

const launchRaw = (store) => launch(store).raw;

ok('the coarse green-lines test switch is off by default and remembered', () => {
  const store = deviceStore();
  const ctx = launchRaw(store);
  assert.strictEqual(ctx.settings.greenLinesCoarse(), false);
  ctx.nodes.setGreenCoarse.listeners.click();   // the panel's own button
  assert.strictEqual(ctx.settings.greenLinesCoarse(), true);
  assert.strictEqual(launchRaw(store).settings.greenLinesCoarse(), true);
});

console.log(`\nterrain-relief-setting: ${passed} passed`);
