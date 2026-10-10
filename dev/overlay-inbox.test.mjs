/* The Mapping Overlay inbox (functions/lib/gd-overlay-inbox.mjs): which player requests show,
   as a fix or an upgrade, and what takes them out. */
import assert from "assert";
import { buildInbox } from "../functions/lib/gd-overlay-inbox.mjs";

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const course = (id, name) => ({ course_id: id, course_name: name, course_lat: 54.6, course_lng: -5.9 });
const job = (id, by, at, status = "done") => ({ course_id: id, requested_by: by, status, created_at: at });

test("player requests show, newest first: failed is a fix, mapped is an upgrade", () => {
  const items = buildInbox({
    requests: [job("a", "guest:1", "2026-10-08T10:00:00Z", "failed"), job("b", "user:p1", "2026-10-09T10:00:00Z")],
    latestRuns: [{ course_id: "a", status: "failed", error: "no greens" }, { course_id: "b", status: "done" }],
    courses: [course("a", "Alpha"), course("b", "Bravo")]
  });
  assert.deepStrictEqual(items.map(i => [i.courseId, i.need, i.name]), [["b", "upgrade", "Bravo"], ["a", "fix", "Alpha"]]);
  assert.strictEqual(items[1].lastError, "no greens");
  assert.strictEqual(items[0].lat, 54.6);
});

test("the admin's own requests and admin runs are not player requests", () => {
  const items = buildInbox({
    requests: [job("a", "user:me", "2026-10-08T10:00:00Z"), job("b", "user:admin-run", "2026-10-08T10:00:00Z"), job("c", "nearby:x", "2026-10-08T10:00:00Z")],
    adminUserIds: ["me"]
  });
  assert.deepStrictEqual(items, []);
});

test("one course asked for several times is one item, counting its players", () => {
  const items = buildInbox({ requests: [job("a", "guest:1", "2026-10-08T10:00:00Z"), job("a", "guest:2", "2026-10-09T10:00:00Z"), job("a", "guest:1", "2026-10-09T11:00:00Z")] });
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].requests, 3);
  assert.strictEqual(items[0].players, 2);
  assert.strictEqual(items[0].requestedAt, "2026-10-09T11:00:00Z");
});

test("a ready overlay or a dismissal after the request takes it out; a newer request brings it back", () => {
  const requests = [job("a", "guest:1", "2026-10-09T10:00:00Z")];
  assert.strictEqual(buildInbox({ requests, overlays: [{ course_id: "a", status: "ready", updated_at: "2026-10-09T12:00:00Z" }] }).length, 0);
  assert.strictEqual(buildInbox({ requests, overlays: [{ course_id: "a", status: "draft", updated_at: "2026-10-09T12:00:00Z" }] }).length, 1, "a draft is not done");
  assert.strictEqual(buildInbox({ requests, dismissals: [{ course_id: "a", dismissed_at: "2026-10-09T12:00:00Z" }] }).length, 0);
  assert.strictEqual(buildInbox({ requests, dismissals: [{ course_id: "a", dismissed_at: "2026-10-09T09:00:00Z" }] }).length, 1, "asked again after the dismissal");
});

let failed = 0;
for (const t of tests) {
  try { t.fn(); console.log("  ok  " + t.name); } catch (error) { failed++; console.log("  FAIL " + t.name + "\n      " + error.message); }
}
if (failed) { console.log(failed + " overlay inbox checks failed"); process.exit(1); }
console.log("passed " + tests.length + " overlay inbox checks");
