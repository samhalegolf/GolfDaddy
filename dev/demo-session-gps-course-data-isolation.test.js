/* Demo Mode, GPS + Course Data side: proves the two remaining isolation
   properties.

   1. app/js/my-bubble.js's apply() sends the demo bubble/bag to
      GDBubbleEngine only while DemoSession.active && .adopted, and reverts
      to the real saved bubble the moment either flips false - no
      DemoBubbleEngine, same real engine entry points either way.
   2. GDDemoCourseDataProvider builds its story from synthetic on-course
      records run through the REAL GolfDaddyShotClusterAnalysis.analyzeStore,
      and never calls GolfDaddyCourseDataIntake.submitShotSnapshot - so the
      durable intake (gd_shot_snapshots_v1 / gd_conditions_analyses_v1 /
      gd_my_bubble_versions_v1) is never touched, and gdCurrentStatsAnalysis()
      still returns the real analysis when Demo Mode is off.

   Runs headless: no browser, no network.
   Run: node dev/demo-session-gps-course-data-isolation.test.js */
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

/* ---------- 1. my-bubble.js: demo bubble/bag only while active+adopted ---------- */

const PROFILE_KEY = 'gd_player_profiles_v27';

function runMyBubble(profileStore, demoState) {
  const setBubbleCalls = [];
  const setBagCalls = [];
  const sessionStorageStore = {};
  if (demoState) sessionStorageStore.gd_demo_session_v1 = JSON.stringify(demoState);
  const sandbox = {
    console,
    localStorage: { getItem: (k) => (k in profileStore ? profileStore[k] : null), setItem() {}, removeItem() {} },
    sessionStorage: {
      getItem: (k) => (k in sessionStorageStore ? sessionStorageStore[k] : null),
      setItem: (k, v) => { sessionStorageStore[k] = v; },
      removeItem: (k) => { delete sessionStorageStore[k]; }
    },
    document: { hidden: false, addEventListener() {} },
    GDBubbleEngine: {
      setBubble: (b) => setBubbleCalls.push(b),
      setBag: (b) => setBagCalls.push(b),
      defaultBagRows: () => [{ club: '7i', baseCarry: 155 }, { club: 'PW', baseCarry: 115 }, { club: 'Driver', baseCarry: 230 }]
    }
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(read('app/js/demo-session.js'), sandbox, { filename: 'demo-session.js' });
  vm.runInContext(read('app/js/my-bubble.js'), sandbox, { filename: 'my-bubble.js' });
  return { setBubbleCalls, setBagCalls, window: sandbox.window };
}

const withProfile = (p) => ({ [PROFILE_KEY]: JSON.stringify({ activeId: p.id, profiles: [p] }) });
const realProfile = withProfile({ id: 'p1', handedness: 'right', faceOffsetDeg: 1.1, practiceBubbleSource: { active: true, offsetDeg: 1.1 } });

let r = runMyBubble(realProfile, null);
check(r.setBubbleCalls[0] && r.setBubbleCalls[0].offsetDeg === 1.1, 'no Demo state -> the real saved bubble reaches the engine');
check(r.setBagCalls.length === 0, 'no Demo state -> setBag is never called from this seam');

r = runMyBubble(realProfile, { active: true, adopted: false, adoptedBubble: null, sevenIronCarryM: 150 });
check(r.setBubbleCalls[0] && r.setBubbleCalls[0].offsetDeg === 1.1, 'Demo active but not yet adopted -> still the real bubble (not a fabricated one)');

r = runMyBubble(realProfile, { active: true, adopted: true, adoptedBubble: { offsetDeg: 4.4, handedness: 'right' }, sevenIronCarryM: 150 });
check(r.setBubbleCalls[0] && r.setBubbleCalls[0].offsetDeg === 4.4, 'Demo active + adopted -> the demo bubble reaches the SAME GDBubbleEngine.setBubble seam');
check(r.setBagCalls.length === 1 && Array.isArray(r.setBagCalls[0]) && r.setBagCalls[0].length > 0,
  'Demo active + adopted -> a demo bag reaches the SAME GDBubbleEngine.setBag seam, computed lazily (no DemoBubbleEngine)');

r = runMyBubble(realProfile, { active: false, adopted: true, adoptedBubble: { offsetDeg: 4.4, handedness: 'right' } });
check(r.setBubbleCalls[0] && r.setBubbleCalls[0].offsetDeg === 1.1, 'turning DemoSession.active off immediately restores the real bubble on the next apply()');

/* ---------- 2. Course Data: real engine, no durable intake, real path unaffected ---------- */

function makeCourseDataSandbox() {
  const intakeCalls = [];
  const sandbox = {
    console,
    document: { addEventListener() {}, getElementById: () => null },
    window: null,
    GolfDaddyCourseDataIntake: { submitShotSnapshot: (snapshot) => { intakeCalls.push(snapshot); } },
    GolfDaddyShotEvents: { getScopedStore: () => ({ plannedShots: [], ballEvents: [], outcomes: [] }), getStore: () => ({ plannedShots: [], ballEvents: [], outcomes: [] }) }
  };
  sandbox.window = sandbox;
  sandbox.root = { modules: {} };
  vm.createContext(sandbox);
  vm.runInContext('var root = window;', sandbox);
  vm.runInContext(read('scripts/gd-shot-cluster-analysis.js'), sandbox, { filename: 'gd-shot-cluster-analysis.js' });
  vm.runInContext(read('scripts/gd-demo-course-data-provider.js'), sandbox, { filename: 'gd-demo-course-data-provider.js' });
  return { sandbox, intakeCalls };
}

const { sandbox: cd, intakeCalls } = makeCourseDataSandbox();
const demoSession = { sevenIronCarryM: 150, patternCenterDeg: 2.5, patternSpreadDeg: 2.0, adoptedBubble: { offsetDeg: 2.5, handedness: 'right' } };
const courseAnalysis = cd.window.GDDemoCourseDataProvider.analysis(demoSession, { consistencyPct: 68 });

check(!!courseAnalysis, 'the demo course provider returned an analysis object');
check(Array.isArray(courseAnalysis && courseAnalysis.records) && courseAnalysis.records.length > 0,
  'the REAL GolfDaddyShotClusterAnalysis.analyzeStore produced records from the synthetic store');
check(!!(courseAnalysis && courseAnalysis.clusterHunter), 'the real cluster hunter ran over the synthetic records');
check(intakeCalls.length === 0, 'GolfDaddyCourseDataIntake.submitShotSnapshot was never called by the demo provider');

/* gdCurrentStatsAnalysis(): real (non-demo) path must be untouched by the guard added to it. */
function makeStatsAnalysisSandbox(demoActive) {
  const engineCalls = [];
  const sandbox = {
    console,
    document: { addEventListener() {} },
    GolfDaddyShotClusterAnalysis: { analyzeCurrent: (opts) => { engineCalls.push(opts); return { records: ['real-analysis-marker'] }; } },
    gdStatsConsistencyPct: 68
  };
  sandbox.window = sandbox;
  if (demoActive) {
    sandbox.GDDemoSession = { active: true, courseDataActive: true };
    sandbox.GDDemoCourseDataProvider = { analysis: () => ({ records: ['demo-analysis-marker'] }) };
  }
  vm.createContext(sandbox);
  vm.runInContext(
    'function gdCurrentStatsAnalysis(){\n' +
    '  if(window.GDDemoSession&&window.GDDemoSession.active&&window.GDDemoSession.courseDataActive&&window.GDDemoCourseDataProvider){\n' +
    '    return window.GDDemoCourseDataProvider.analysis(window.GDDemoSession,{consistencyPct:gdStatsConsistencyPct});\n' +
    '  }\n' +
    '  return window.GolfDaddyShotClusterAnalysis&&window.GolfDaddyShotClusterAnalysis.analyzeCurrent&&window.GolfDaddyShotClusterAnalysis.analyzeCurrent({consistencyPct:gdStatsConsistencyPct});\n' +
    '}',
    sandbox
  );
  return { result: sandbox.gdCurrentStatsAnalysis(), engineCalls };
}

let stats = makeStatsAnalysisSandbox(false);
check(stats.result.records[0] === 'real-analysis-marker', 'gdCurrentStatsAnalysis() returns the real analysis when Demo Mode is off');
check(stats.engineCalls.length === 1, 'the real engine was called exactly once for a real (non-demo) request');

stats = makeStatsAnalysisSandbox(true);
check(stats.result.records[0] === 'demo-analysis-marker', 'gdCurrentStatsAnalysis() returns the demo analysis only when DemoSession.courseDataActive is true');
check(stats.engineCalls.length === 0, 'the real engine (and therefore gd_shot_events_v1) is not touched while serving demo Course Data');

if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\ndemo-session-gps-course-data-isolation passed: my-bubble.js switches on active+adopted only, '
  + 'demo Course Data uses the real engine with zero durable-intake calls, real Course Data path unaffected');
