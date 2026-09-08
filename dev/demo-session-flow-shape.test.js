/* Demo Mode, the shape of the guided flow rather than its isolation
   (dev/demo-session-*-isolation.test.js own that half).

   Four properties the demo's refinement depends on:

   1. The synthetic practice session is varied enough to be worth looking at -
      the real cluster engine still finds a pattern, and MOST of the shots miss
      the drawn bubble rather than sitting inside it.
   2. Course Data is more varied still: more clubs, and a bigger share outside
      the plan than the practice side.
   3. The bag suggestion never renders while a demo is running.
   4. Course Data renders what it was handed - no unresolvable `safe()` calls in
      gd-app-core.js, and the plan/pair counts behind the same demo gate as the
      analysis.
   5. Coming back from GPS Play during a demo lands on Course Data, and a real
      round still lands where it set off from.

   Runs headless: no browser, no network.
   Run: node dev/demo-session-flow-shape.test.js */
'use strict';

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

/* The bubble both charts draw is the preset iron shape, and both of its ratios
   are ratios OF the carry - so its half-axes are the same numbers on every
   club and at every carry. This is the same arithmetic the two providers do,
   restated here on purpose: if one of them drifts, this test is what notices. */
const BUBBLE_ANGLE_RADIUS_DEG = Math.atan(0.148 / 2) * 180 / Math.PI;
const BUBBLE_DEPTH_RADIUS_PCT = 0.195 / 2;
const outsideBubble = (angleDeg, depthPct) => {
  const a = angleDeg / BUBBLE_ANGLE_RADIUS_DEG;
  const d = depthPct / (BUBBLE_DEPTH_RADIUS_PCT * 100);
  return a * a + d * d > 1;
};
const median = (values) => {
  const sorted = values.slice().sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const mid = sorted.length / 2;
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function browserlessSandbox(extra) {
  const sessionStore = {};
  const sandbox = Object.assign({
    console,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: {
      getItem: (k) => (k in sessionStore ? sessionStore[k] : null),
      setItem: (k, v) => { sessionStore[k] = String(v); },
      removeItem: (k) => { delete sessionStore[k]; }
    },
    document: { readyState: 'complete', addEventListener() {}, getElementById: () => null },
    location: { search: '' },
    URLSearchParams,
    setTimeout,
    clearTimeout
  }, extra || {});
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  sandbox.__sessionStore = sessionStore;
  return sandbox;
}

/* ---------- 1. Practice: a pattern is still findable, and most shots miss ---------- */

const practice = browserlessSandbox();
vm.runInContext('var root = window;', practice);
vm.runInContext(read('scripts/gd-launch-monitor-data.js'), practice, { filename: 'gd-launch-monitor-data.js' });
vm.runInContext(read('scripts/gd-demo-session.js'), practice, { filename: 'gd-demo-session.js' });

const CARRIES = [95, 120, 150, 185, 210];
const practiceRuns = [];
let practiceNoPattern = 0;
let practiceRejected = 0;
CARRIES.forEach((carry) => {
  for (let i = 0; i < 40; i += 1) {
    const started = practice.window.GDDemoSession.start(carry);
    const analysis = practice.window.GDDemoSession.practiceAnalysis;
    const offsetDeg = Number(analysis && analysis.recommendation && analysis.recommendation.offsetDeg);
    if (!started || !Number.isFinite(offsetDeg)) { practiceNoPattern += 1; continue; }
    practiceRejected += analysis.totals.rejected;
    const shots = analysis.acceptedShots;
    /* No bag exists during a demo (gdPracticeAutoBagFromData refuses to seed
       one), so the chart anchors its distance axis on the median measured
       carry. Same anchor here, or "outside" would be measured against a frame
       the player never sees. */
    const anchor = median(shots.map((shot) => Number(shot.carryM)));
    const outside = shots.filter((shot) => outsideBubble(
      Number(shot.normalizedDeg) - offsetDeg,
      (Number(shot.carryM) - anchor) / anchor * 100
    )).length;
    practiceRuns.push({ carry, offsetDeg, shots: shots.length, outsideShare: outside / shots.length, centre: practice.window.GDDemoSession.patternCenterDeg });
  }
});

check(practiceNoPattern === 0,
  'every demo start produced a pattern the real engine could anchor on (' + practiceRuns.length + ' runs)');
check(practiceRejected === 0,
  'no synthetic practice shot was rejected by the engine gates - the variety stays on the chart');
check(Math.min.apply(null, practiceRuns.map((r) => r.shots)) >= 24,
  'each session carries a range-sized set of shots (min ' + Math.min.apply(null, practiceRuns.map((r) => r.shots)) + ')');
check(practiceRuns.every((r) => r.outsideShare >= 0.5),
  'at least half of every session lands outside the bubble (worst run '
    + Math.round(Math.min.apply(null, practiceRuns.map((r) => r.outsideShare)) * 100) + '%)');
check(practiceRuns.every((r) => Math.abs(r.offsetDeg - r.centre) <= 1.5),
  'the bubble still lands on the pattern, not on a bunch of misses (worst drift '
    + Math.max.apply(null, practiceRuns.map((r) => Math.abs(r.offsetDeg - r.centre))).toFixed(2) + ' deg)');

/* ---------- 2. Course Data: more clubs, and further outside than practice ---------- */

const course = browserlessSandbox({
  GolfDaddyCourseDataIntake: { submitShotSnapshot: () => { throw new Error('durable intake must not be called'); } }
});
vm.runInContext('var root = window;', course);
vm.runInContext(read('scripts/gd-shot-cluster-analysis.js'), course, { filename: 'gd-shot-cluster-analysis.js' });
vm.runInContext(read('scripts/gd-demo-course-data-provider.js'), course, { filename: 'gd-demo-course-data-provider.js' });

/* Sampled through _buildDemoCourseStore + the real engine rather than through
   analysis(), which memoises one round per session on purpose (asserted below) -
   going through it would collapse 200 samples into a handful of stores. */
const courseRuns = [];
CARRIES.forEach((carry) => {
  for (let i = 0; i < 40; i += 1) {
    const session = { sevenIronCarryM: carry, patternCenterDeg: [-4.4, -2, 0.6, 2.9, 4.2][i % 5], patternSpreadDeg: 1 };
    const store = course.window.GDDemoCourseDataProvider._buildDemoCourseStore(session);
    const analysis = course.window.GolfDaddyShotClusterAnalysis.analyzeStore(store, { consistencyPct: 68 });
    const records = (analysis && analysis.records) || [];
    if (!records.length) { courseRuns.push({ clubs: 0, outsideShare: 0, excluded: 0, records: 0 }); continue; }
    const outside = records.filter((record) => outsideBubble(
      Number(record.normalizedDeg),
      Number(record.depthM) / Number(record.expectedDistanceM) * 100
    )).length;
    courseRuns.push({
      records: records.length,
      clubs: new Set(records.map((record) => record.club)).size,
      outsideShare: outside / records.length,
      excluded: records.filter((record) => record.counted === false).length
    });
  }
});

const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
check(courseRuns.every((r) => r.records >= 20), 'every demo round carries at least 20 paired shots');
check(courseRuns.every((r) => r.clubs >= 4), 'a demo round is played with at least four clubs, not one');
check(courseRuns.every((r) => r.outsideShare >= 0.6),
  'the round scatters further than the range did (worst run '
    + Math.round(Math.min.apply(null, courseRuns.map((r) => r.outsideShare)) * 100) + '% outside)');
check(mean(courseRuns.map((r) => r.outsideShare)) > mean(practiceRuns.map((r) => r.outsideShare)),
  'Course Data is more varied than Practice Data, which is the story it is there to tell ('
    + Math.round(mean(courseRuns.map((r) => r.outsideShare)) * 100) + '% vs '
    + Math.round(mean(practiceRuns.map((r) => r.outsideShare)) * 100) + '%)');
check(courseRuns.every((r) => r.excluded <= 2),
  'at most a couple of shots a round fall past the counted distance window');

/* One round per demo, not one per reader. Course Data asks for its analysis
   several times over a single render; a fresh store per call put a 30-dot chart
   above a count that had never seen those dots. */
const stableSession = { sevenIronCarryM: 150, patternCenterDeg: 2.9, adoptedBubble: { offsetDeg: 2.9 } };
const idsOf = (session) => ((course.window.GDDemoCourseDataProvider.analysis(session, { consistencyPct: 68 }) || {}).records || [])
  .map((record) => record.shotId).join(',');
const firstRead = idsOf(stableSession);
check(!!firstRead && firstRead === idsOf(stableSession),
  'every reader of one demo session gets the same round, shot for shot');
check(idsOf(Object.assign({}, stableSession, { sevenIronCarryM: 165 })) !== firstRead,
  'a different demo session builds a new round');
const fitPctAt = (pct) => (((course.window.GDDemoCourseDataProvider.analysis(stableSession, { consistencyPct: pct }) || {}).bubbleFit || [])[0] || {}).consistencyPct;
check(fitPctAt(51) === 51 && fitPctAt(80) === 80,
  'and the consistency slider still re-analyses that held round rather than being ignored');

/* ---------- 3. The bag stays out of the demo ---------- */

const routeAudit = read('scripts/gd-route-audit.js');
check(/function gdPracticeBagSuggestionHTML\(analysis\)\{\s*if\(gdPracticeDemoSuppressesBag\(\)\)return""/.test(routeAudit),
  'the bag suggestion panel/icon is suppressed at its source while a demo runs');
check(/function gdPracticeBagSuggestionNoticeHTML\(analysis\)\{\s*if\(gdPracticeDemoSuppressesBag\(\)\)return""/.test(routeAudit),
  'the "Distance Suggestion Available" notice is suppressed too');

const guard = browserlessSandbox();
vm.runInContext('function safe(fn,fallback){try{return fn()}catch(e){return fallback}}\n'
  + routeAudit.slice(routeAudit.indexOf('  function gdPracticeDemoSuppressesBag(){'),
    routeAudit.indexOf('  function gdPracticeBagSuggestionHTML(analysis){')), guard);
check(guard.gdPracticeDemoSuppressesBag() === false, 'with no demo running the bag is left alone');
guard.window.GDDemoSession = { active: true };
check(guard.gdPracticeDemoSuppressesBag() === true, 'with a demo running the bag is suppressed');

/* ---------- 4. Course Data actually renders what it was handed ---------- */

/* gd-app-core.js has no `safe()` - that name is a local inside
   gd-route-audit.js's IIFE - so a bare call to it there is a ReferenceError the
   moment the line runs. gdRenderCourseClubGroups had one on its first line, and
   its caller's try/catch turned the crash into a Course Shot Library that
   silently rendered nothing and an empty-state message under a full chart, for
   real rounds as much as demo ones. Guarding the class, not the one line. */
const appCore = read('scripts/gd-app-core.js');
/* Prose about safe() is not a call to it - block comments and //-lines come out
   first so the guard reads code, not the paragraph above gdSafe explaining why
   the guard exists. */
const appCoreCode = appCore
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
const bareSafeCalls = (appCoreCode.match(/[^A-Za-z0-9_.$]safe\s*\(/g) || []).length;
check(bareSafeCalls === 0,
  'gd-app-core.js calls no bare safe() - the name does not resolve in that file ('
    + bareSafeCalls + ' found)');
check(/function gdSafe\(fn,fallback\)\{/.test(appCore),
  'it has its own gdSafe() for the job instead');

/* Course Data reads a store for its plan/pair counts and an analysis for
   everything else. Both need the demo gate or the screen mixes a demo round's
   chart with the durable store's (empty) counts. */
check(/function gdCourseDataStore\(\)\{[\s\S]{0,400}GDDemoCourseDataProvider/.test(appCore),
  'the plan/pair counts go through the same demo gate the analysis does');

/* ---------- 5. Coming back from GPS Play ---------- */

function runRestore(demoState, search) {
  const opened = [];
  const sandbox = browserlessSandbox({
    GDShell: { openModule: (name) => { opened.push('module:' + name); return true; }, showHome: () => { opened.push('home'); return true; } },
    gdOpenCourseData: (opts) => { opened.push('courseData:' + JSON.stringify(opts)); return false; },
    ClaritySession: { get: () => ({ ownProfileId: 'p1', viewedProfileId: 'p1', accountName: 'Player' }) }
  });
  sandbox.location = { search: search || '' };
  sandbox.sessionStorage.setItem('clarity:play-context:v1', JSON.stringify({
    version: 1, playerId: 'p1', playerName: 'Player', ownProfileId: 'p1',
    returnContext: { surface: 'practice' }, createdAt: Date.now()
  }));
  if (demoState) sandbox.sessionStorage.setItem('gd_demo_session_v1', JSON.stringify(demoState));
  vm.runInContext(read('scripts/gd-play-context.js'), sandbox, { filename: 'gd-play-context.js' });
  const result = sandbox.window.GDPlayContext.restore();
  const after = sandbox.sessionStorage.getItem('gd_demo_session_v1');
  return { opened, result, demoAfter: after ? JSON.parse(after) : null };
}

let back = runRestore(null);
check(back.opened.join() === 'module:practiceData',
  'a real round still returns to the surface it set off from');

back = runRestore({ active: true, adopted: true, courseDataActive: false });
check(back.opened.length === 1 && back.opened[0].indexOf('courseData:') === 0,
  'a demo returns to Course Data instead of Practice Data');
check(back.opened[0].indexOf('"demo":true') > -1, 'and it opens it as the demo view');
check(back.demoAfter && back.demoAfter.courseDataActive === true,
  'courseDataActive is set before the screen opens, so the demo analysis is what it reads');

back = runRestore({ active: false, adopted: false, courseDataActive: false });
check(back.opened.join() === 'module:practiceData',
  'a demo that has been exited returns to Practice Data like any other session');

back = runRestore({ active: true, adopted: true, courseDataActive: true }, '?openDemoCourseData=1');
check(back.opened.length === 0,
  'the "See Course Data" route is left to open the screen once, not twice');

if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\ndemo-session-flow-shape passed: varied practice data with a findable pattern, '
  + 'a wider-scattering multi-club round, no bag mid-demo, and a return that lands on Course Data');
