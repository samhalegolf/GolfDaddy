/* Who owns the resume hole.

   The bug this pins: resume.js used to be written from the Marshal's
   holeEntered effect, which is a VIEW effect - every arrow, picker tap and
   return-to-live reaches it. So the resume note held the last hole on screen,
   and the next time the course was opened boot.js handed it to RESUME_HOLE,
   which (correctly) makes a hole live. A hole browsed in Preview at Royal
   Belfast came back as LIVE 12 for a player nowhere near Ireland.

   Now the note is written only by liveHoleChanged, which the Marshal fires
   only from startHole - the one door into Live. These checks drive the real
   Marshal and the real resume.js, wired the way boot.js wires them, and
   reopen the course the way openPlay does. The browser half (the real boot,
   a real reload, the real badge) is in gps-play-continuity.test.js.

   Run: node dev/resume-live-hole.test.js */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const createMarshal = require(path.join(__dirname, "..", "app", "js", "marshal.js"));

const ROOT = path.join(__dirname, "..");
const RESUME_SRC = fs.readFileSync(path.join(ROOT, "app", "js", "resume.js"), "utf8");
const BOOT_SRC = fs.readFileSync(path.join(ROOT, "app", "js", "boot.js"), "utf8");
const PICKER_SRC = fs.readFileSync(path.join(ROOT, "scripts", "inline", "gd-resume-round-picker-v1.js"), "utf8");
const KEY = "clarity:resume-round:v1";

function offsetM(base, northM, eastM) {
  return {
    lat: base.lat + northM / 111320,
    lng: base.lng + eastM / (111320 * Math.cos(base.lat * Math.PI / 180))
  };
}

/* Royal Belfast-ish, eighteen holes laid out in a line so every hole number
   the checks use exists in the package (RESUME_HOLE refuses a hole that does
   not). The player, meanwhile, is in Auckland. */
const BELFAST = { lat: 54.6566, lng: -5.7969 };
const AUCKLAND = { lat: -36.9174, lng: 174.7400 };
function course18(origin) {
  const holes = [];
  for (let n = 1; n <= 18; n += 1) {
    const tee = offsetM(origin, -(n - 1) * 400, 0);
    holes.push({ holeNumber: n, par: 4, tee, green: offsetM(tee, -320, 0), greenShape: [], route: [] });
  }
  return { status: "lite-geo-ready", holes };
}
const PKG = course18(BELFAST);
const TEE = (n) => PKG.holes[n - 1].tee;
const COURSE = { courseId: "royal-belfast", courseName: "Royal Belfast", courseLat: BELFAST.lat, courseLng: BELFAST.lng };

let passed = 0;
function check(name, fn) {
  try { fn(); console.log("  PASS  " + name); passed += 1; }
  catch (e) { console.log("  FAIL  " + name + "\n        " + e.message); process.exitCode = 1; }
}

/* One "device": localStorage that outlives page loads. Each page() is a fresh
   load of resume.js against it, which is what a reload is. */
function device() {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); }
  };
  return {
    localStorage,
    saved: () => JSON.parse(localStorage.getItem(KEY) || "null"),
    writeRaw: (obj) => localStorage.setItem(KEY, JSON.stringify(obj))
  };
}

function loadResume(dev) {
  const window = {};
  vm.runInNewContext(RESUME_SRC, { window, localStorage: dev.localStorage, Date, Number, String, JSON });
  return window.ClarityApp.resume;
}

/* openPlay(), step for step: read the note BEFORE setCourse resets it, open
   the round, then RESUME_HOLE whatever live hole the note (or the URL) gave.
   The effects are boot.js's: holeEntered is view-only, liveHoleChanged writes
   the note. `views` and `lives` record what each effect saw. */
function openPlay(dev, urlHole) {
  const resume = loadResume(dev);
  const log = { views: [], lives: [] };
  let resumeHole = urlHole;
  if (!(Number(resumeHole) >= 1)) {
    const saved = resume.read();
    if (saved && String(saved.courseId) === COURSE.courseId) resumeHole = saved.liveHole;
  }
  resume.setCourse(COURSE);
  const m = createMarshal({
    effects: {
      holeEntered: (hole) => log.views.push(hole),
      liveHoleChanged: (hole) => { log.lives.push(hole); resume.setLiveHole(hole); }
    },
    canLogShots: () => true,
    now: () => 1000
  });
  m.signal("ROUND_OPENED", { courseKey: COURSE.courseId, courseName: COURSE.courseName, pkg: PKG, centre: BELFAST });
  if (Number(resumeHole) >= 1) m.signal("RESUME_HOLE", { hole: Number(resumeHole) });
  return { m, resume, log };
}

/* Live on `hole` the legitimate way: arrive at the course, walk to near its
   tee and press Play. */
function playHole(m, hole) {
  m.signal("FIX_RECEIVED", { point: BELFAST });
  m.signal("FIX_RECEIVED", { point: offsetM(TEE(hole), 35, 0) });
  if (m.state().viewHole !== hole) m.signal("VIEW_HOLE_CHANGED", { hole });
  assert.strictEqual(m.signal("PLAY_PRESSED"), true, `Play should start hole ${hole}`);
  assert.strictEqual(m.state().live.hole, hole);
}

console.log("\n— the ownership boundary —");

check("boot.js: holeEntered no longer writes the resume note", () => {
  const start = BOOT_SRC.indexOf("holeEntered: function");
  const end = BOOT_SRC.indexOf("liveHoleChanged: function");
  assert(start > 0 && end > start, "holeEntered then liveHoleChanged effects expected in boot.js");
  assert(!/app\.resume/.test(BOOT_SRC.slice(start, end)), "holeEntered must not touch app.resume");
  assert(/liveHoleChanged: function \(hole\) \{\s*if \(app\.resume\) app\.resume\.setLiveHole\(hole\);/.test(BOOT_SRC),
    "liveHoleChanged is what writes it");
  assert(!/resume\.setHole\b/.test(BOOT_SRC), "the old view-driven writer is gone");
  assert(/resumeHole = savedRound\.liveHole;/.test(BOOT_SRC), "openPlay resumes the LIVE hole field");
});

check("the picker's Continue Round reads liveHole, never v1's viewed `hole`", () => {
  assert(!/saved\.hole\b/.test(PICKER_SRC), "no reads of the v1 field");
  assert(/liveHoleOf\(saved\)/.test(PICKER_SRC));
});

console.log("\n— 1. Preview cannot poison resume —");

check("live on 2, preview 12: view 12, live 2, note still says 2", () => {
  const dev = device();
  const { m } = openPlay(dev);
  playHole(m, 2);
  m.signal("VIEW_HOLE_CHANGED", { hole: 12 });
  assert.strictEqual(m.state().viewHole, 12);
  assert.strictEqual(m.state().live.hole, 2);
  assert.strictEqual(dev.saved().liveHole, 2);
  assert.strictEqual(dev.saved().version, 2);
  assert(!("hole" in dev.saved()), "the ambiguous v1 field is not written");
});

console.log("\n— 2. Reload restores the live hole, not the previewed one —");

check("reopening after the above resumes LIVE 2 and shows 2", () => {
  const dev = device();
  const first = openPlay(dev);
  playHole(first.m, 2);
  first.m.signal("VIEW_HOLE_CHANGED", { hole: 12 });
  const { m } = openPlay(dev);
  assert.strictEqual(m.state().live.hole, 2);
  assert.strictEqual(m.state().viewHole, 2);
  assert.strictEqual(m.scene().flow, "live");
  assert.strictEqual(dev.saved().liveHole, 2, "and the note survives the reopen");
});

console.log("\n— 3. Pure Preview creates no live round —");

check("open a course, browse to 12 without playing: nothing resumable as live", () => {
  const dev = device();
  const { m, log } = openPlay(dev);
  for (let i = 0; i < 11; i += 1) m.signal("NEXT_HOLE");
  assert.strictEqual(m.state().viewHole, 12);
  assert.strictEqual(m.state().live.hole, null);
  assert.deepStrictEqual(log.lives, [], "no hole became live");
  const saved = dev.saved();
  assert.strictEqual(saved.courseId, COURSE.courseId, "the course is still noted, as a way back in");
  assert.strictEqual(saved.liveHole, null, "opening a course is not playing hole 1, and browsing is not playing 12");
});

console.log("\n— 4. Genuine resume still works —");

check("live on 12 through Play, reopen: live 12 again", () => {
  const dev = device();
  const first = openPlay(dev);
  playHole(first.m, 12);
  assert.strictEqual(dev.saved().liveHole, 12);
  const { m } = openPlay(dev);
  assert.strictEqual(m.state().live.hole, 12);
  assert.strictEqual(m.scene().flow, "live");
});

check("the picker's ?hole= hand-off resumes it too", () => {
  const dev = device();
  const first = openPlay(dev);
  playHole(first.m, 12);
  const { m } = openPlay(dev, String(dev.saved().liveHole));
  assert.strictEqual(m.state().live.hole, 12);
});

console.log("\n— 5. The badge's return-to-live —");

check("live 2, preview 12: badge reads PREVIEW 12 → 2; returning moves only the view", () => {
  const dev = device();
  const { m, log } = openPlay(dev);
  playHole(m, 2);
  const livesBefore = log.lives.length;
  m.signal("VIEW_HOLE_CHANGED", { hole: 12 });
  const banner = m.scene().banner;
  assert.strictEqual(banner.flow, "preview");
  assert.strictEqual(banner.hole, 12);
  assert.strictEqual(banner.returnTo, 2);
  /* painter.js's #playerBadgeReturn sends exactly this. */
  m.signal("VIEW_HOLE_CHANGED", { hole: banner.returnTo });
  assert.strictEqual(m.state().viewHole, 2);
  assert.strictEqual(m.state().live.hole, 2);
  assert.strictEqual(m.scene().flow, "live");
  assert.strictEqual(log.lives.length, livesBefore, "returning is not starting the hole again");
  /* And the watch's VIEW_LIVE_HOLE, the other way back. */
  m.signal("VIEW_HOLE_CHANGED", { hole: 12 });
  m.signal("VIEW_LIVE_HOLE");
  assert.strictEqual(m.state().viewHole, 2);
  assert.strictEqual(log.lives.length, livesBefore);
});

console.log("\n— 6. Royal Belfast: a stale preview cannot become live on reopen —");

check("browsed 12 at Royal Belfast from Auckland, reopened: still Preview, no LIVE badge", () => {
  const dev = device();
  const first = openPlay(dev);
  first.m.signal("FIX_RECEIVED", { point: AUCKLAND });
  first.m.signal("VIEW_HOLE_CHANGED", { hole: 12 });
  const { m } = openPlay(dev);
  m.signal("FIX_RECEIVED", { point: AUCKLAND });
  assert.strictEqual(m.state().live.hole, null);
  assert.strictEqual(m.scene().flow, "preview");
  assert.strictEqual(m.scene().banner.returnTo, null, "the badge has no live hole to offer");
});

check("a v1 note from before the fix (hole: 12) keeps its course and drops its hole", () => {
  const dev = device();
  dev.writeRaw({
    version: 1, courseId: COURSE.courseId, courseName: COURSE.courseName,
    courseLat: BELFAST.lat, courseLng: BELFAST.lng, hole: 12,
    updatedAt: Date.now(), expiresAt: Date.now() + 3600000
  });
  const read = loadResume(dev).read();
  assert.strictEqual(read.courseId, COURSE.courseId);
  assert.strictEqual(read.liveHole, null, "v1 `hole` was the viewed hole and cannot be trusted as live");
  const { m } = openPlay(dev);
  m.signal("FIX_RECEIVED", { point: AUCKLAND });
  assert.strictEqual(m.state().live.hole, null);
  assert.strictEqual(m.scene().banner.returnTo, null);
});

check("expiry still applies", () => {
  const dev = device();
  dev.writeRaw({ version: 2, courseId: COURSE.courseId, liveHole: 4, updatedAt: 1, expiresAt: Date.now() - 1 });
  assert.strictEqual(loadResume(dev).read(), null);
});

check("the player-scoped store is still the one written and read", () => {
  const writes = [];
  const window = { GDPlayContext: {
    writeJson: (name, value) => writes.push({ name, value }),
    readJson: (name) => (writes.length ? writes[writes.length - 1].value : null),
    remove: () => {}
  } };
  vm.runInNewContext(RESUME_SRC, { window, localStorage: device().localStorage, Date, Number, String, JSON });
  window.ClarityApp.resume.setCourse(COURSE);
  window.ClarityApp.resume.setLiveHole(3);
  assert.deepStrictEqual(writes.map((w) => w.name), ["resume-round", "resume-round"]);
  assert.strictEqual(window.ClarityApp.resume.read().liveHole, 3);
});

console.log("\n— 7. The note moves only when the live hole does —");

check("arrows, picker, return, queueing and catch-up never write it", () => {
  const dev = device();
  const { m, log } = openPlay(dev);
  playHole(m, 2);
  assert.deepStrictEqual(log.lives, [2]);
  const stamp = dev.saved().updatedAt;
  m.signal("NEXT_HOLE");
  m.signal("NEXT_HOLE");
  m.signal("PREV_HOLE");
  m.signal("VIEW_HOLE_CHANGED", { hole: 9 });
  m.signal("VIEW_LIVE_HOLE");
  m.signal("ADVANCE_TO_HOLE", { hole: 3 });
  m.signal("PACKAGE_UPDATED", { pkg: PKG });
  assert(log.views.length > 3, "the view effect did fire on every one of those");
  assert.deepStrictEqual(log.lives, [2], "the live effect did not");
  assert.strictEqual(dev.saved().liveHole, 2);
  assert.strictEqual(dev.saved().updatedAt, stamp, "not even rewritten");
});

check("Play, the tee zone and a genuine resume all do", () => {
  const dev = device();
  const first = openPlay(dev);
  playHole(first.m, 2);                                       // PLAY_PRESSED
  first.m.signal("ADVANCE_TO_HOLE", { hole: 3 });              // queue 3...
  assert.strictEqual(dev.saved().liveHole, 2, "queueing is not starting");
  first.m.signal("FIX_RECEIVED", { point: TEE(3) });           // ...and walk onto its tee
  assert.strictEqual(first.m.state().live.hole, 3);
  assert.deepStrictEqual(first.log.lives, [2, 3]);
  assert.strictEqual(dev.saved().liveHole, 3);
  const second = openPlay(dev);                                // RESUME_HOLE
  assert.deepStrictEqual(second.log.lives, [3]);
  assert.strictEqual(dev.saved().liveHole, 3);
});

console.log(`\n${passed} checks passed${process.exitCode ? ", with failures" : ""}`);
