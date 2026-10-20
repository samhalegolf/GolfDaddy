/* Studio's Mapping Queue (functions/lib/gd-mapper-queue.mjs): waiting jobs in the worker's own
   claim order, stalled runs flagged, the last day's results, people waiting on a map, and the
   admin-only GET ?queue=1 route. */
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildMapperQueue, loadMapperQueue, requesterLabel } from "../functions/lib/gd-mapper-queue.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const NOW = Date.parse("2026-10-20T12:00:00Z");
const IDLE = ["nearby_automap", "find_trees", "resolve_scorecards"];
const at = minutesAgo => new Date(NOW - minutesAgo * 60000).toISOString();
const job = (id, kind, status, created, updated, extra) => Object.assign({ id, course_id: "c-" + id, kind, status, requested_by: "guest:x", created_at: at(created), updated_at: at(updated == null ? created : updated) }, extra || {});

test("player jobs go first, oldest first, then idle kinds in the worker's order", () => {
  const q = buildMapperQueue({
    jobs: [
      job("tree", "find_trees", "queued", 50),
      job("near-new", "nearby_automap", "queued", 5),
      job("player-new", "automap", "queued", 1),
      job("card", "resolve_scorecards", "queued", 90),
      job("near-old", "nearby_automap", "queued", 30),
      job("player-old", "remap", "queued", 10)
    ],
    idleKinds: IDLE, now: NOW
  });
  assert.deepStrictEqual(q.queued.map(j => j.id), ["player-old", "player-new", "near-old", "near-new", "tree", "card"]);
  assert.deepStrictEqual(q.queued.map(j => j.position), [1, 2, 3, 4, 5, 6]);
  assert.deepStrictEqual(q.queued.map(j => j.lane), ["player", "player", "background", "background", "background", "background"]);
  assert.strictEqual(q.counts.playerQueued, 2);
});

test("a running job the worker has gone quiet on is stalled", () => {
  const q = buildMapperQueue({ jobs: [job("busy", "automap", "running", 3, 1), job("stuck", "automap", "running", 20, 10)], idleKinds: IDLE, now: NOW, stallSeconds: 120 });
  assert.deepStrictEqual(q.running.map(j => [j.id, j.stalled]), [["stuck", true], ["busy", false]]);
  assert.strictEqual(q.counts.stalled, 1);
});

test("the last day's results, newest first; older ones drop off", () => {
  const q = buildMapperQueue({
    recentJobs: [job("ok", "automap", "done", 60, 30), job("bad", "automap", "failed", 20, 10, { error: "Overpass 502" }), job("old", "automap", "done", 3000, 2000)],
    idleKinds: IDLE, now: NOW
  });
  assert.deepStrictEqual(q.recent.map(j => j.id), ["bad", "ok"]);
  assert.strictEqual(q.recent[0].error, "Overpass 502");
  assert.deepStrictEqual([q.counts.doneToday, q.counts.failedToday], [1, 1]);
});

test("people waiting on a map are counted per course, longest wait first", () => {
  const q = buildMapperQueue({
    waitingRows: [
      { course_id: "a", course_name: "Akarana", created_at: at(10) },
      { course_id: "b", course_name: null, created_at: at(500) },
      { course_id: "a", course_name: null, created_at: at(100) }
    ],
    names: { b: "Balmoral" }, idleKinds: IDLE, now: NOW
  });
  assert.deepStrictEqual(q.waiting.map(w => [w.courseId, w.courseName, w.addresses]), [["b", "Balmoral", 1], ["a", "Akarana", 2]]);
});

test("who asked is shown in words, never as an id", () => {
  assert.strictEqual(requesterLabel("guest:abc123"), "Player (guest)");
  assert.strictEqual(requesterLabel("user:p1", ["me"]), "Player");
  assert.strictEqual(requesterLabel("user:me", ["me"]), "You");
  assert.strictEqual(requesterLabel("user:admin-run"), "Admin");
  assert.strictEqual(requesterLabel("nearby:x"), "Nearby sweep");
  assert.strictEqual(requesterLabel("region:user:me"), "Regional scan");
});

test("loadMapperQueue reads live jobs, the last day, waiting requests and names", async () => {
  const asked = [];
  const fetchStub = async url => {
    asked.push(url);
    if (url.startsWith("course_mapper_jobs") && url.includes("status=in.(queued,running)")) return [job("q", "automap", "queued", 5)];
    if (url.startsWith("course_mapper_jobs")) return [job("d", "automap", "done", 30, 20)];
    if (url.startsWith("course_map_notify_requests")) return [{ course_id: "c-q", created_at: at(40) }];
    if (url.startsWith("course_maps")) return [{ course_id: "c-q", course_name: "Queued Course" }, { course_id: "c-d", course_name: "Done Course" }];
    return [];
  };
  const q = await loadMapperQueue(fetchStub, { idleKinds: IDLE, now: NOW });
  assert.strictEqual(q.queued[0].courseName, "Queued Course");
  assert.strictEqual(q.recent[0].courseName, "Done Course");
  assert.strictEqual(q.waiting[0].courseName, "Queued Course");
  assert.ok(asked.some(u => u.startsWith("course_map_notify_requests") && u.includes("notified_at=is.null")));
});

test("GET ?queue=1 is admin only and uses the worker's idle order", () => {
  const src = fs.readFileSync(path.join(ROOT, "functions", "course-mapper-jobs.mjs"), "utf8");
  const route = src.slice(src.indexOf('searchParams.get("queue") === "1"'));
  assert.ok(/user && user\.isAdmin/.test(route.slice(0, 300)), "admin check");
  assert.ok(route.includes("idleKinds: [NEARBY_AUTOMAP_KIND, TREE_KIND, SCORECARD_KIND]"));
  const worker = fs.readFileSync(path.join(ROOT, "functions", "course-mapper-worker-background.mjs"), "utf8");
  assert.ok(worker.includes('const IDLE_KINDS = "(" + NEARBY_AUTOMAP_KIND + "," + TREE_KIND + "," + SCORECARD_KIND + ")"'), "the worker's idle kinds changed - update the queue's order to match");
});

let failed = 0;
for (const t of tests) {
  try { await t.fn(); console.log("ok - " + t.name); }
  catch (error) { failed++; console.error("not ok - " + t.name + "\n", error); }
}
if (failed) { console.error(failed + " failed"); process.exit(1); }
console.log("mapper-queue: " + tests.length + " passed");
