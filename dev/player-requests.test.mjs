/* The player-requested course list (functions/lib/gd-player-requests.mjs): which mapper jobs
   count as a player asking for a course, grouped one item per course. */
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { groupPlayerRequests, isPlayerRequest, loadPlayerRequests } from "../functions/lib/gd-player-requests.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const job = (id, by, at) => ({ course_id: id, requested_by: by, created_at: at });

test("guests and non-admin accounts are players; the admin's own id, admin runs and the nearby sweep are not", () => {
  assert.strictEqual(isPlayerRequest("guest:abc", ["me"]), true);
  assert.strictEqual(isPlayerRequest("user:p1", ["me"]), true);
  assert.strictEqual(isPlayerRequest("user:me", ["me"]), false);
  assert.strictEqual(isPlayerRequest("user:admin-run", []), false);
  assert.strictEqual(isPlayerRequest("nearby:x", []), false);
  assert.strictEqual(isPlayerRequest("", []), false);
});

test("one item per course, newest request first, counting asks and distinct players", () => {
  const items = groupPlayerRequests([
    job("a", "guest:1", "2026-09-01T10:00:00Z"),
    job("b", "user:p1", "2026-10-09T10:00:00Z"),
    job("a", "guest:2", "2026-10-10T11:00:00Z"),
    job("a", "guest:1", "2026-10-02T09:00:00Z"),
    job("c", "user:me", "2026-10-11T09:00:00Z")
  ], ["me"]);
  assert.deepStrictEqual(items.map(i => i.courseId), ["a", "b"]);
  assert.deepStrictEqual(items[0], { courseId: "a", requests: 3, players: 2, requestedAt: "2026-10-10T11:00:00Z", firstRequestedAt: "2026-09-01T10:00:00Z" });
  assert.deepStrictEqual(items[1], { courseId: "b", requests: 1, players: 1, requestedAt: "2026-10-09T10:00:00Z", firstRequestedAt: "2026-10-09T10:00:00Z" });
});

test("loadPlayerRequests reads every automap job with its requester, nothing else", async () => {
  const asked = [];
  const items = await loadPlayerRequests(async (q) => { asked.push(q); return [job("a", "guest:1", "2026-10-10T11:00:00Z")]; }, { adminUserIds: ["me"] });
  assert.strictEqual(asked.length, 1);
  assert.ok(asked[0].startsWith("course_mapper_jobs?select=course_id,requested_by,created_at&kind=eq.automap"), asked[0]);
  assert.ok(!asked[0].includes("created_at=gte"), "no date cut-off: the whole list");
  assert.deepStrictEqual(items.map(i => i.courseId), ["a"]);
});

test("the Course Mapping page is the scoped list, and the endpoint serves it to admins only", () => {
  const page = fs.readFileSync(path.join(ROOT, "scripts/studio/courses/course-mapping/course-mapping-page.js"), "utf8");
  assert.ok(page.includes("/api/course-mapper-jobs?playerRequests=1"));
  assert.ok(page.includes("scope: scopeOf(items)"), "mounts the shared course table with a scope");
  const host = fs.readFileSync(path.join(ROOT, "scripts/studio/courses/course-database/course-database-page.js"), "utf8");
  assert.ok(host.includes("gdAdminCourseDbSetScope(opts.scope || null)"));
  assert.ok(host.includes("gdAdminCourseDbSetScope(null)"), "the scope is cleared on unmount");
  const endpoint = fs.readFileSync(path.join(ROOT, "functions/course-mapper-jobs.mjs"), "utf8");
  const block = endpoint.slice(endpoint.indexOf('searchParams.get("playerRequests")'), endpoint.indexOf("loadPlayerRequests(supabaseFetch"));
  assert.ok(block.includes("user.isAdmin"), "admin check before the read");
  const inbox = fs.readFileSync(path.join(ROOT, "functions/lib/gd-overlay-inbox.mjs"), "utf8");
  assert.ok(inbox.includes('from "./gd-player-requests.mjs"'), "the inbox shares the one definition of a player request");
});

let failed = 0;
for (const t of tests) {
  try { await t.fn(); console.log("  ok  " + t.name); } catch (error) { failed++; console.log("  FAIL " + t.name + "\n      " + error.message); }
}
if (failed) { console.log(failed + " player request checks failed"); process.exit(1); }
console.log("passed " + tests.length + " player request checks");
