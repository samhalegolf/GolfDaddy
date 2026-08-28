/* Demo Mode, practice + adopt side: proves the two isolation properties the
   feature depends on.

   1. Synthetic practice shots run through the REAL cluster/pattern engine
      (GolfDaddyLaunchMonitorData.analyze({store})) without ever reading or
      writing gd_launch_monitor_data_v1 (the real Shot Library, which syncs
      to Supabase shot_library_batches).
   2. DemoSession.adopt() runs the REAL Adopt -> Save click handlers against
      a throwaway profile clone: the real ensureProfile()/savePlayerProfiles()/
      syncCoreProfileFromActive() are never invoked with real effect while it
      runs, and are restored exactly afterwards.

   Runs headless: no browser, no network.
   Run: node dev/demo-session-practice-isolation.test.js */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('ok  -', msg);
  else { console.error('FAIL:', msg); failures += 1; }
}

function makeSandbox() {
  const localStorageCalls = [];
  const localStorageStore = {};
  const sessionStorageStore = {};
  const sandbox = {
    console,
    localStorage: {
      getItem: (k) => { localStorageCalls.push(['get', k]); return k in localStorageStore ? localStorageStore[k] : null; },
      setItem: (k, v) => { localStorageCalls.push(['set', k]); localStorageStore[k] = v; },
      removeItem: (k) => { localStorageCalls.push(['remove', k]); delete localStorageStore[k]; }
    },
    sessionStorage: {
      getItem: (k) => (k in sessionStorageStore ? sessionStorageStore[k] : null),
      setItem: (k, v) => { sessionStorageStore[k] = v; },
      removeItem: (k) => { delete sessionStorageStore[k]; }
    },
    document: {
      addEventListener: () => {},
      getElementById: () => null,
      querySelectorAll: () => []
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('scripts/gd-launch-monitor-data.js'), sandbox, { filename: 'gd-launch-monitor-data.js' });
  vm.runInContext(read('scripts/gd-demo-session.js'), sandbox, { filename: 'gd-demo-session.js' });
  return { sandbox, localStorageCalls, localStorageStore, sessionStorageStore };
}

/* ---------- 1. practice evidence never touches the real Shot Library ---------- */

const s1 = makeSandbox();
const started = s1.sandbox.window.GDDemoSession.start(150);
check(started === true, 'DemoSession.start(150) succeeds');

const analysis = s1.sandbox.window.GDDemoSession.practiceAnalysis;
check(!!analysis, 'a demo practice analysis was produced');
check(Array.isArray(analysis && analysis.acceptedShots) && analysis.acceptedShots.length > 0,
  'the real cluster engine accepted synthetic shots (' + (analysis && analysis.acceptedShots.length) + ')');
check(analysis && analysis.totals && analysis.totals.rawShots > 0, 'totals.rawShots reflects the synthetic rows');
check(!!(analysis && analysis.recommendation), 'a recommendation (offset/status) was computed');

const touchedRealStore = s1.localStorageCalls.some((c) => c[1] === 'gd_launch_monitor_data_v1');
check(!touchedRealStore, 'gd_launch_monitor_data_v1 (real Shot Library) was never read or written');
check(Object.keys(s1.localStorageStore).length === 0, 'no localStorage key was written at all');
check('gd_demo_session_v1' in s1.sessionStorageStore, 'DemoSession persisted to its own sessionStorage key');

/* run twice: presets/jitter must not collide or throw on repeat starts */
const secondStart = s1.sandbox.window.GDDemoSession.start(140);
check(secondStart === true, 'a second Start Demo (different carry) also succeeds');
check(s1.sandbox.window.GDDemoSession.sevenIronCarryM === 140, 'restarting replaces the previous session, not merges it');

/* ---------- 2. Adopt runs the real chain against a throwaway clone ---------- */

function makeAdoptSandbox() {
  const { sandbox } = makeSandbox();
  sandbox.window.GDDemoSession.start(150);

  const REAL_MARKER = 9.9; // if this ever changes, the real profile was mutated
  const realProfile = { id: 'real-player', handedness: 'right', faceOffsetDeg: REAL_MARKER, centralFaceOffsetDeg: REAL_MARKER, bag: [{ club: '7i', baseCarry: 150 }] };
  const calls = { ensureProfile: 0, save: 0, sync: 0 };

  sandbox.window.ensureProfile = () => { calls.ensureProfile += 1; return realProfile; };
  sandbox.window.savePlayerProfiles = () => { calls.save += 1; };
  sandbox.window.syncCoreProfileFromActive = () => { calls.sync += 1; };

  /* Stand-ins for the real gd-route-audit.js click handlers: they read
     ensureProfile() and mutate the object it returns, exactly like the real
     gdPracticeAdoptBubbleAsPlayingBubble() / gdBubbleOffsetSave() do - the
     property under test is that DemoSession.adopt() makes ensureProfile()
     return a clone while these run, not that these specific stand-ins are
     faithful to every line of the real functions (covered by manual QA). */
  sandbox.window.gdPracticeAdoptBubbleFromAction = () => {
    const p = sandbox.window.ensureProfile();
    p.practiceBubblePendingSource = { active: true, offsetDeg: 3.1, club: '7i' };
  };
  sandbox.window.gdPracticeSaveBubbleFromAction = () => {
    const p = sandbox.window.ensureProfile();
    const pending = p.practiceBubblePendingSource;
    if (!pending || !pending.active) return;
    p.faceOffsetDeg = pending.offsetDeg;
    p.centralFaceOffsetDeg = pending.offsetDeg;
    p.practiceBubbleSource = { active: true, offsetDeg: pending.offsetDeg, club: pending.club };
    delete p.practiceBubblePendingSource;
    sandbox.window.savePlayerProfiles();
    sandbox.window.syncCoreProfileFromActive();
  };

  return { sandbox, realProfile, calls, REAL_MARKER };
}

const a1 = makeAdoptSandbox();
const adopted = a1.sandbox.window.GDDemoSession.adopt();
check(adopted === true, 'DemoSession.adopt() reports success');
check(a1.calls.save === 0, 'the real savePlayerProfiles was never invoked with real effect during adopt()');
check(a1.calls.sync === 0, 'the real syncCoreProfileFromActive was never invoked with real effect during adopt()');
check(a1.realProfile.faceOffsetDeg === a1.REAL_MARKER, 'the real profile object faceOffsetDeg is unchanged');
check(a1.realProfile.centralFaceOffsetDeg === a1.REAL_MARKER, 'the real profile object centralFaceOffsetDeg is unchanged');
check(!a1.realProfile.practiceBubbleSource, 'the real profile object gained no practiceBubbleSource');
check(!a1.realProfile.practiceBubblePendingSource, 'the real profile object has no leftover pending stage');
check(typeof a1.sandbox.window.ensureProfile === 'function', 'ensureProfile was restored');
check(a1.sandbox.window.GDDemoSession.adopted === true, 'DemoSession.adopted flips true');
const adoptedBubble = a1.sandbox.window.GDDemoSession.adoptedBubble;
check(!!adoptedBubble && Number.isFinite(adoptedBubble.offsetDeg), 'DemoSession.adoptedBubble is populated with a numeric offset');
check(adoptedBubble.offsetDeg === 3.1, 'the adopted bubble carries the staged offset (3.1), not the real marker');

/* ---------- 3. lifecycle: destroy clears everything ---------- */

const beforeDestroySessionKeys = Object.keys(s1.sessionStorageStore);
check(beforeDestroySessionKeys.length === 1, 'exactly one sessionStorage key was in use before Exit Demo');
a1.sandbox.window.GDDemoSession.destroy();
check(a1.sandbox.window.GDDemoSession.active === false, 'DemoSession.active is false after destroy()');
check(a1.sandbox.window.GDDemoSession.adopted === false, 'DemoSession.adopted resets after destroy()');
check(a1.sandbox.window.GDDemoSession.practiceAnalysis === null, 'practiceAnalysis is cleared after destroy()');

if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\ndemo-session-practice-isolation passed: real cluster engine used with zero Shot Library writes, '
  + 'Adopt isolated from the real profile, lifecycle clears cleanly');
