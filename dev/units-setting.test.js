/*
 * Metres or yards is one setting, and the main app follows it.
 *
 * The player sets it in GPS Play's settings sheet (app/js/gps-settings.js,
 * stored under clarity:gps-settings:v1). The main app has no units toggle of
 * its own any more - its old one lived in the retired in-page GPS Settings
 * panel - so fmt(), the one place the main app converts and labels a distance,
 * reads that same stored setting. A yards player must not see metres on the
 * practice or bubble screens because the two halves kept separate settings.
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
const gpsSettings = fs.readFileSync(path.join(ROOT, 'app', 'js', 'gps-settings.js'), 'utf8');

/* The units lines are lifted out of gd-app-core.js and run for real, rather
   than pattern-matched: a test that only greps cannot tell a followed setting
   from one that looks like it is followed. */
function lineStartingWith(prefix) {
  const line = source.split('\n').find((row) => row.startsWith(prefix));
  assert.ok(line, `gd-app-core.js no longer has a line starting "${prefix}"`);
  return line;
}

const BLOCK = [
  lineStartingWith('function gdStoredUnits()'),
  lineStartingWith('function fmt(m)'),
  'let units=gdStoredUnits();'
].join('\n');

function launch(store) {
  const context = { localStorage: store, JSON };
  vm.createContext(context);
  vm.runInContext(BLOCK + '\nthis.__read=()=>units;\nthis.__fmt=fmt;', context);
  return {
    units: () => context.__read(),
    /* Spread back into this realm: an object built inside the vm is not the
       same Object as ours and deepStrictEqual would fail on the prototype. */
    fmt: (m) => Object.assign({}, context.__fmt(m))
  };
}

function deviceStore(initial) {
  const data = Object.assign({}, initial || {});
  return { getItem: (key) => (key in data ? data[key] : null), setItem: (key, value) => { data[key] = String(value); } };
}
const gpsPlaySetting = (units) => ({ 'clarity:gps-settings:v1': JSON.stringify({ units, aimLine: true }) });

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('a fresh device shows metres', () => {
  const app = launch(deviceStore());
  assert.strictEqual(app.units(), 'm');
  assert.deepStrictEqual(app.fmt(100), { value: 100, unit: 'm' });
});

test('yards set in GPS Play is followed here', () => {
  const app = launch(deviceStore(gpsPlaySetting('yd')));
  assert.strictEqual(app.units(), 'yd');
  assert.deepStrictEqual(app.fmt(100), { value: 109, unit: 'yd' });
});

test('metres set in GPS Play is followed here', () => {
  assert.strictEqual(launch(deviceStore(gpsPlaySetting('m'))).units(), 'm');
});

test('a stored value that is not a unit is ignored', () => {
  assert.strictEqual(launch(deviceStore(gpsPlaySetting('furlongs'))).units(), 'm');
  assert.strictEqual(launch(deviceStore({ 'clarity:gps-settings:v1': 'not json' })).units(), 'm');
});

test('a browser that refuses storage still works', () => {
  const refusing = { getItem() { throw new Error('storage disabled'); } };
  assert.strictEqual(launch(refusing).units(), 'm');
});

test('both halves read the same key', () => {
  assert.ok(/STORE_KEY\s*=\s*"clarity:gps-settings:v1"/.test(gpsSettings), 'GPS Play no longer stores its settings under clarity:gps-settings:v1');
  assert.ok(source.includes('localStorage.getItem("clarity:gps-settings:v1")'), 'the main app no longer reads GPS Play\'s units setting');
  assert.ok(!source.includes('gd_units_v1'), 'the main app has gone back to a units setting of its own');
});

let failures = 0;
tests.forEach(({ name, fn }) => {
  try { fn(); console.log('ok  -', name); }
  catch (error) { failures += 1; console.error('FAIL:', name, '\n     ', error.message); }
});
console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
