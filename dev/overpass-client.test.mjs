/* Overpass's "200 but cut short" answer must be retried, not mapped or cached. */
import assert from "node:assert/strict";
import { fetchOverpass, __overpassClientTest } from "../functions/lib/gd-overpass-client.mjs";

const realFetch = globalThis.fetch;
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn) => realTimeout(fn, 0);

const answers = [
  { remark: "runtime error: Query timed out in \"query\" at line 1 after 19 seconds.", elements: [{ type: "way", id: 1, tags: { leisure: "golf_course" } }] },
  { elements: Array.from({ length: 40 }, (_, i) => ({ type: "way", id: i + 1, tags: { golf: "hole", ref: String(i % 18 + 1) } })) }
];
let calls = 0;
globalThis.fetch = async () => {
  const body = answers[Math.min(calls++, answers.length - 1)];
  return { ok: true, status: 200, json: async () => body };
};

const data = await fetchOverpass("[out:json];way(1);out;");
assert.equal(calls, 2, "a timed-out answer is retried");
assert.equal(data.elements.length, 40, "the complete answer is the one returned");
assert.equal(__overpassClientTest.responseCache.get("[out:json];way(1);out;"), data);

calls = 0;
answers.splice(1);
await assert.rejects(fetchOverpass("[out:json];way(2);out;"), /incomplete answer/);
assert.equal(__overpassClientTest.responseCache.has("[out:json];way(2);out;"), false, "a cut-short answer is never cached");

globalThis.fetch = realFetch;
globalThis.setTimeout = realTimeout;
console.log("overpass-client: ok");
