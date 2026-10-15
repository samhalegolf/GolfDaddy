/* Course Data backfill: rounds GPS Play saved only as raw snapshots.
 *
 * Before GPS Play filed shots for the Course Data screen, a round reached
 * gd_shot_snapshots_v1 and nowhere else, so the screen never showed it.
 * gd-shot-events.js brings those snapshots across once, on load. These run the
 * real modules in a vm and read the result back the way the screen does
 * (gd-shot-cluster-analysis.js analyzeCurrent).
 *
 * Run: node dev/course-data-snapshot-backfill.test.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k)
  };
}

/* Loads the screen's modules over a given localStorage, as a fresh page would. */
function boot(storage) {
  const context = { console, localStorage: storage, sessionStorage: memoryStorage(), Date, Math, JSON, Number, Object, Array, String, Error };
  context.window = context;
  vm.createContext(context);
  ["scripts/gd-shot-outcomes.js", "scripts/gd-shot-events.js", "scripts/gd-shot-cluster-analysis.js"]
    .forEach((rel) => vm.runInContext(read(rel), context, { filename: rel }));
  return context;
}

const START = { lat: 0, lng: 0 };
const AIM = { lat: 0.0012, lng: 0 };      /* ~133 m north */
const LANDING = { lat: 0.001, lng: 0 };   /* ~22 m short of the aim, on line */

function snapshot(id, extra = {}) {
  return Object.assign({
    shotId: id,
    roundId: "round:akarana:1760000000000",
    holeNumber: 3,
    capturedAt: "2026-10-14T01:00:00.000Z",
    clubId: "7i",
    playerId: null,
    shotStartPosition: START,
    shotLandingPosition: LANDING,
    targetPosition: AIM,
    myBubbleGeometry: null,
    gpsAccuracy: 4,
    shotCaptureMethod: "lock"
  }, extra);
}

function snapshotStore(list) {
  const snapshots = {};
  list.forEach((s) => { snapshots[s.shotId] = { signature: "x", receivedAt: s.capturedAt, snapshot: s }; });
  return JSON.stringify({ version: 1, snapshots });
}

const PROFILES = JSON.stringify({ activeId: "p-sam", profiles: [{ id: "p-sam", name: "Sam" }] });

/* 1. An old app/ round with no bubble recorded comes back measured against the
      aim point, filed under the active player, and stays out of the bubble fit. */
{
  const storage = memoryStorage({
    gd_player_profiles_v27: PROFILES,
    gd_shot_snapshots_v1: snapshotStore([
      snapshot("round:akarana:1:h3:s1"),
      snapshot("round:akarana:1:h3:s2", { capturedAt: "2026-10-14T01:03:00.000Z", shotStartPosition: LANDING, targetPosition: { lat: 0.0015, lng: 0 }, shotLandingPosition: { lat: 0.0015, lng: 0.00001 } })
    ])
  });
  const ctx = boot(storage);
  const records = ctx.GolfDaddyShotClusterAnalysis.analyzeCurrent().records;
  assert.strictEqual(records.length, 2, "both old shots are on the screen");

  const r = records.find((x) => x.shotId === "round:akarana:1:h3:s1");
  assert.strictEqual(r.playerId, "p-sam", "filed under the active player, so the screen keeps it");
  assert.strictEqual(r.club, "7i", "club as recorded");
  assert.strictEqual(r.holeId, "hole-3", "hole as recorded");
  assert.ok(Math.abs(r.depthM - -22.2) < 1, "~22 m short of where the player aimed, got " + r.depthM);
  assert.ok(Math.abs(r.lateralM) < 0.5, "on line, got " + r.lateralM);
  assert.strictEqual(r.bubbleWasSet, false, "no bubble was recorded, so none is claimed");
  assert.strictEqual(r.insideBubble, false, "nothing to be inside");
  assert.strictEqual(r.presumedBubbleWidthM, 0, "no bubble size is made up");

  const fit = ctx.GolfDaddyShotClusterAnalysis.analyzeCurrent().bubbleFit;
  assert.strictEqual(fit.length, 0, "aim-only shots do not feed the bubble fit");
}

/* 2. A snapshot that froze its bubble (the old main-app play did) uses it. */
{
  const storage = memoryStorage({
    gd_player_profiles_v27: PROFILES,
    gd_shot_snapshots_v1: snapshotStore([
      snapshot("snap-1", { playerId: "p-sam", myBubbleGeometry: { centerLat: AIM.lat, centerLng: AIM.lng, orientationDeg: 0, widthM: 20, depthM: 40 } })
    ])
  });
  const r = boot(storage).GolfDaddyShotClusterAnalysis.analyzeCurrent().records[0];
  assert.strictEqual(r.bubbleWasSet, true, "the recorded bubble counts");
  assert.ok(Math.abs(r.presumedBubbleDepthM - 40) < 0.5 && Math.abs(r.presumedBubbleWidthM - 20) < 0.5,
    "at the size it was recorded: " + r.presumedBubbleDepthM + " x " + r.presumedBubbleWidthM);
}

/* 3. Once only. Shots already on the screen are not doubled, and a shot the
      player deleted afterwards is not brought back on the next load. */
{
  const storage = memoryStorage({
    gd_player_profiles_v27: PROFILES,
    gd_shot_snapshots_v1: snapshotStore([snapshot("a"), snapshot("b", { capturedAt: "2026-10-14T01:05:00.000Z" })])
  });
  const first = boot(storage);
  assert.strictEqual(first.GolfDaddyShotClusterAnalysis.analyzeCurrent().records.length, 2, "first load brings both across");
  assert.strictEqual(first.GolfDaddyShotEvents.deleteShot("a"), true, "the player deletes one");

  const second = boot(storage);
  const ids = second.GolfDaddyShotClusterAnalysis.analyzeCurrent().records.map((x) => x.shotId);
  assert.deepStrictEqual(ids, ["b"], "the deleted shot stays deleted and nothing is doubled");
}

/* 4. A shot already filed for the screen (by GPS Play since the fix) is skipped. */
{
  const storage = memoryStorage({
    gd_player_profiles_v27: PROFILES,
    gd_shot_snapshots_v1: snapshotStore([snapshot("already")]),
    gd_shot_events_v1: JSON.stringify({ version: 1, ballEvents: [], plannedShots: [{ shotId: "already", playerId: "p-sam" }], outcomes: [] })
  });
  const store = boot(storage).GolfDaddyShotEvents.getStore();
  assert.strictEqual(store.plannedShots.length, 1, "not filed a second time");
}

/* 5. An empty snapshot read (nothing yet, or storage mid-restore) does not mark
      the backfill done, so it still runs once the snapshots are there. */
{
  const storage = memoryStorage({ gd_player_profiles_v27: PROFILES });
  boot(storage);
  assert.strictEqual(storage.getItem("gd_shot_events_v1"), null, "nothing written on an empty read");
  storage.setItem("gd_shot_snapshots_v1", snapshotStore([snapshot("late")]));
  assert.strictEqual(boot(storage).GolfDaddyShotClusterAnalysis.analyzeCurrent().records.length, 1, "brought across once they arrive");
}

/* 6. The screen's store survives a WebView eviction. */
{
  const durable = read("scripts/inline/gd-durable-storage.js");
  const list = (durable.match(/var DURABLE_KEYS = \[([\s\S]*?)\];/) || [])[1] || "";
  assert.ok(/"gd_shot_events_v1"/.test(list), "gd_shot_events_v1 must be mirrored to durable storage");
}

console.log("course-data-snapshot-backfill passed: old snapshot-only rounds reach the Course Data screen once, "
  + "aim-only where no bubble was recorded, deletions respected, store durable");
