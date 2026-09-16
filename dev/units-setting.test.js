/*
 * Metres or yards is a setting, and a setting is remembered.
 *
 * It was not. `units` was a plain in-memory variable that started at "m" on
 * every launch, so a yards player re-toggled it every time they opened the app
 * - and because fmt() is the one place the whole app converts and labels a
 * distance, every number on every screen silently came back in metres with it.
 *
 * What is pinned here is the whole round trip: a fresh device defaults to
 * metres, toggling writes the choice to the device, the next launch restores
 * it, fmt() follows it, the Settings row says what is actually set, and a
 * browser that refuses storage still works rather than throwing.
 *
 * Run: node dev/units-setting.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'scripts', 'gd-app-core.js'), 'utf8');

/* The units block is lifted out of gd-app-core.js and run for real, rather
   than pattern-matched: a test that only greps cannot tell a remembered
   setting from one that looks like it is remembered. */
function lineStartingWith(prefix) {
  const line = source.split('\n').find((row) => row.startsWith(prefix));
  assert.ok(line, `gd-app-core.js no longer has a line starting "${prefix}"`);
  return line;
}

const BLOCK = [
  lineStartingWith('const GD_UNITS_KEY='),
  lineStartingWith('function gdStoredUnits()'),
  lineStartingWith('function gdUnitsLabel('),
  lineStartingWith('function gdSyncUnitsButtons()'),
  lineStartingWith('function toggleUnits()'),
  lineStartingWith('function fmt(m)'),
  'let units=gdStoredUnits();'
].join('\n');

/* A launch: fresh globals, one device store carried across launches. */
function launch(store) {
  const row = { unitsToggle: { textContent: '' }, unitsSub: { textContent: '' } };
  const context = {
    localStorage: store,
    document: { getElementById: (id) => row[id] || null },
    greenPolygon: null,
    renderShot() {},
    renderScorecard() {},
    drawGreenDistances() {}
  };
  vm.createContext(context);
  vm.runInContext(BLOCK + '\nthis.__read=()=>units;\nthis.__sync=gdSyncUnitsButtons;\nthis.__toggle=toggleUnits;\nthis.__fmt=fmt;', context);
  context.__sync();
  return {
    units: () => context.__read(),
    toggle: () => context.__toggle(),
    /* Spread back into this realm: an object built inside the vm is not the
       same Object as ours and deepStrictEqual would fail on the prototype
       rather than on anything the app got wrong. */
    fmt: (m) => Object.assign({}, context.__fmt(m)),
    toggleLabel: () => row.unitsToggle.textContent,
    subLabel: () => row.unitsSub.textContent
  };
}

function deviceStore(initial) {
  const data = Object.assign({}, initial || {});
  return {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
    data
  };
}

const refusingStore = {
  getItem() { throw new Error('storage disabled'); },
  setItem() { throw new Error('storage disabled'); }
};

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('a fresh device opens in metres', () => {
  const app = launch(deviceStore());
  assert.strictEqual(app.units(), 'm');
  assert.deepStrictEqual(app.fmt(100), { value: 100, unit: 'm' });
  assert.strictEqual(app.toggleLabel(), 'Meters');
  assert.strictEqual(app.subLabel(), 'Meters');
});

test('toggling to yards converts every distance and says so on the row', () => {
  const app = launch(deviceStore());
  app.toggle();
  assert.strictEqual(app.units(), 'yd');
  assert.deepStrictEqual(app.fmt(100), { value: 109, unit: 'yd' });
  assert.strictEqual(app.toggleLabel(), 'Yards');
  assert.strictEqual(app.subLabel(), 'Yards');
});

test('the choice is written to the device', () => {
  const store = deviceStore();
  launch(store).toggle();
  assert.strictEqual(store.data.gd_units_v1, 'yd');
});

test('the next launch opens in yards - the bug this fixes', () => {
  const store = deviceStore();
  launch(store).toggle();
  const relaunched = launch(store);
  assert.strictEqual(relaunched.units(), 'yd');
  assert.deepStrictEqual(relaunched.fmt(100), { value: 109, unit: 'yd' });
  assert.strictEqual(relaunched.toggleLabel(), 'Yards', 'the Settings row still claims Meters');
  assert.strictEqual(relaunched.subLabel(), 'Yards');
});

test('toggling back to metres is remembered too', () => {
  const store = deviceStore();
  launch(store).toggle();
  launch(store).toggle();
  assert.strictEqual(store.data.gd_units_v1, 'm');
  assert.strictEqual(launch(store).units(), 'm');
});

test('a stored value that is not a unit is ignored', () => {
  assert.strictEqual(launch(deviceStore({ gd_units_v1: 'furlongs' })).units(), 'm');
  assert.strictEqual(launch(deviceStore({ gd_units_v1: '' })).units(), 'm');
});

test('a browser that refuses storage still works', () => {
  const app = launch(refusingStore);
  assert.strictEqual(app.units(), 'm');
  app.toggle();
  assert.strictEqual(app.units(), 'yd', 'a refused write must not stop the toggle');
  assert.strictEqual(app.toggleLabel(), 'Yards');
});

test('the restore runs where units is declared, not in a later hook', () => {
  assert.ok(
    /let units=gdStoredUnits\(\)/.test(source),
    'units no longer restores at its declaration - something can read it before the setting is applied'
  );
});

test('the Settings row is synced on boot', () => {
  assert.ok(
    /DOMContentLoaded",gdSyncUnitsButtons\)/.test(source) && /else gdSyncUnitsButtons\(\)/.test(source),
    'nothing syncs the Units row at boot, so a restored yards setting shows as Meters'
  );
});

test('the label is written in one place', () => {
  const others = source.split('\n').filter((row) => /"Meters"/.test(row) && !row.startsWith('function gdUnitsLabel('));
  assert.deepStrictEqual(others, [], 'a second place still hard-codes the Units label: ' + others.join(' | '));
});

let failures = 0;
tests.forEach(({ name, fn }) => {
  try { fn(); console.log('ok  -', name); }
  catch (error) { failures += 1; console.error('FAIL:', name, '\n     ', error.message); }
});
console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
