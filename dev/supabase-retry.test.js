#!/usr/bin/env node
"use strict";

/* The 17 Sep caddy outage: Postgres restarted, PostgREST came back first and
   answered PGRST002 for ninety seconds. Every function failed hard. These
   checks pin down when a request is allowed to be asked again. */

const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

let checks = 0;
function ok(name) { checks += 1; console.log("  ok  " + name); }

function stubFetch(responses) {
  const calls = [];
  global.fetch = async function (url, options) {
    calls.push({ url: String(url), method: (options && options.method) || "GET" });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra fetch call");
    if (next.throw) throw new Error(next.throw);
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => (next.body === undefined ? "" : JSON.stringify(next.body))
    };
  };
  return calls;
}

(async function run() {
  const { createSupabaseFetch } = await import(
    pathToFileURL(path.join(__dirname, "..", "functions", "lib", "gd-supabase-fetch.mjs")).href
  );
  const fetcher = createSupabaseFetch({ base: "https://db.example.co", key: "service-key", label: "test" });
  const realFetch = global.fetch;

  // PGRST002 is raised before PostgREST reaches the database, so the retry is safe
  // and the caller should never see the outage at all.
  let calls = stubFetch([
    { status: 503, body: { code: "PGRST002", message: "Could not query the database for the schema cache. Retrying." } },
    { status: 503, body: { code: "PGRST002", message: "Could not query the database for the schema cache. Retrying." } },
    { status: 200, body: [{ course_id: "cromwell" }] }
  ]);
  let result = await fetcher("course_maps?select=course_id");
  assert.deepStrictEqual(result, [{ course_id: "cromwell" }]);
  assert.strictEqual(calls.length, 3);
  ok("a schema-cache failure is retried until it clears");

  // Nothing executed, so a write may be replayed too.
  calls = stubFetch([
    { status: 503, body: { code: "PGRST000", message: "Database connection error. Retrying the connection." } },
    { status: 201, body: [] }
  ]);
  await fetcher("course_maps", { method: "POST", body: "{}" });
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1].method, "POST");
  ok("a write is replayed when the database was provably never reached");

  // A bare 503 could have arrived after the row landed. Replaying it writes twice.
  calls = stubFetch([{ status: 503, body: "upstream unavailable" }]);
  await assert.rejects(
    fetcher("course_maps", { method: "POST", body: "{}" }),
    (error) => error.status === 503
  );
  assert.strictEqual(calls.length, 1, "a POST behind an unexplained 503 must not be replayed");
  ok("an unexplained 503 does not replay a write");

  // The same 503 on a read is harmless to repeat.
  calls = stubFetch([{ status: 503, body: "upstream unavailable" }, { status: 200, body: [] }]);
  assert.deepStrictEqual(await fetcher("course_maps?select=id"), []);
  assert.strictEqual(calls.length, 2);
  ok("an unexplained 503 is retried on a read");

  // A real error is a real error - retrying a 400 just delays the answer.
  calls = stubFetch([{ status: 400, body: { code: "PGRST100", message: "unexpected argument" } }]);
  await assert.rejects(fetcher("course_maps?select=nope"), (error) => error.status === 400);
  assert.strictEqual(calls.length, 1);
  ok("a client error fails immediately");

  // Give up rather than hang forever.
  calls = stubFetch(new Array(4).fill({ status: 503, body: { code: "PGRST002", message: "down" } }));
  await assert.rejects(fetcher("course_maps?select=id"), (error) => error.status === 503);
  assert.strictEqual(calls.length, 4, "attempts are bounded");
  ok("retries are bounded and the last error is surfaced");

  // The structured error shape course-maps.mjs relies on survives.
  calls = stubFetch([{ status: 404, body: { code: "PGRST116", message: "no rows" } }]);
  await assert.rejects(fetcher("course_maps?id=eq.nope"), (error) =>
    error.status === 404 && error.body && error.body.code === "PGRST116");
  ok("errors carry .status and .body for callers that read them");

  global.fetch = realFetch;
  console.log("supabase-retry passed: " + checks + " checks");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
