/* Guest Practice contract: two stored sessions and a minimal preview handoff. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

function storage() {
  const data = new Map();
  return {
    getItem: (key) => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key)
  };
}

const localStorage = storage();
const sessionStorage = storage();
const document = { readyState: 'complete', addEventListener: () => {}, getElementById: () => null };
const window = {
  localStorage, sessionStorage, document, console,
  GolfDaddyProfiles: { active: () => ({ id: 'guest1234', name: 'Guest' }) },
  GDGuestAccess: { isGuest: () => true, practiceSessionLimit: 2 },
  addEventListener: () => {}, dispatchEvent: () => {}, location: { href: '' }
};
window.window = window;
Object.assign(window, { Date, Math, JSON, Number, Object, Array, String, Promise, RegExp, Error, Boolean, isNaN, parseFloat, parseInt, setTimeout, clearTimeout });
const context = vm.createContext(window);
function load(file) { vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file }); }
load('scripts/gd-launch-monitor-data.js');
load('scripts/gd-practice-bubble-preview.js');

const library = window.GolfDaddyLaunchMonitorData;
for (let i = 1; i <= 3; i += 1) {
  library.importCapture({
    sessionId: 'session-' + i,
    captureId: 'capture-' + i,
    timestamp: new Date(Date.UTC(2026, 8, i)).toISOString(),
    clubGroups: [{ shotId: 'shot-' + i, candidateClub: '7 Iron', expectedDistanceM: 150, metrics: [] }]
  });
}
const scoped = library.getScopedStore();
assert.deepStrictEqual(Array.from(scoped.sessions, (row) => row.sessionId), ['session-2', 'session-3']);
assert.deepStrictEqual(Array.from(scoped.captures, (row) => row.captureId), ['capture-2', 'capture-3']);
assert.deepStrictEqual(Array.from(scoped.shots, (row) => row.shotId), ['shot-2', 'shot-3']);

const preview = window.GolfDaddyPracticeBubblePreview.stage({
  offsetDeg: 2.4, handedness: 'left', source: 'practice_data', club: '7i', guest: true,
  shots: [{ private: true }], capture: { private: true }
});
assert.strictEqual(preview.offsetDeg, 2.4);
assert.strictEqual(preview.handedness, 'left');
assert.strictEqual(preview.previewOnly, true);
assert.strictEqual(preview.guest, true);
assert.strictEqual(Object.prototype.hasOwnProperty.call(preview, 'shots'), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(preview, 'capture'), false);
window.GolfDaddyPracticeBubblePreview.createAccount();
assert.strictEqual(window.location.href, '/?login=1');
console.log('guest-practice-preview.test.js passed');
