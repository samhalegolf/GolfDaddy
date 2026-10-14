/*
 * "Ask AI for this card", locked.
 *
 * The point is the hand-off: the model answers in the paste box's own layout, the server runs
 * the paste box's parser over it, Studio drops it into the paste box, and the operator presses
 * Import exactly as for a card they pasted themselves. Each half has a cheap way to drift - a
 * model asked for JSON the paste box cannot read, a background half that trusts its request,
 * a Studio button that stores the card instead of showing it - so they are pinned here.
 *
 * Pure checks on the core, static source checks on the wiring, in the style of
 * dev/course-map-ai-scan.test.js. The model call itself is not exercised.
 *
 * Run: node dev/course-scorecard-ask.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), "utf8"); }

let core = null;

const CARD = [
  "Hole\t1\t2\t3\t4\t5\t6\t7\t8\t9\t10\t11\t12\t13\t14\t15\t16\t17\t18",
  "Par\t4\t3\t5\t4\t4\t3\t4\t5\t4\t4\t3\t5\t4\t4\t3\t4\t5\t4",
  "SI\t7\t15\t1\t9\t3\t17\t11\t5\t13\t8\t16\t2\t10\t4\t18\t12\t6\t14",
  "White\t354\t148\t512\t389\t401\t160\t372\t498\t366\t350\t150\t510\t380\t400\t165\t370\t495\t360",
  "Yellow\t340\t138\t495\t372\t388\t150\t360\t480\t350\t338\t140\t496\t366\t388\t152\t358\t480\t348"
].join("\n");

test("the prompt asks for the paste box's own layout, with sources, and names the site's other courses", () => {
  const prompt = core.buildScorecardAskPrompt({ course: { name: "Foyle Golf Club", lat: 55.03, lng: -7.28 }, siblings: ["Foyle Golf Club", "Foyle Woodlands"] });
  assert.ok(prompt.includes("Foyle Golf Club") && prompt.includes("latitude 55.03000"));
  assert.ok(prompt.includes("Search the web"), "the numbers come from a source, not memory");
  assert.ok(prompt.includes("Hole\\t1\\t2\\t3") || prompt.includes("Hole\t1\t2\t3"), "the layout example is tab-separated like a pasted card");
  assert.ok(prompt.includes("UNIT:") && prompt.includes("SOURCE:") && prompt.includes("CONFIDENCE:") && prompt.includes("NOTES:"), "the header lines are asked for");
  assert.ok(prompt.includes("Foyle Woodlands") && prompt.includes("Return the card for Foyle Golf Club only"), "the site's other courses are named so the right card comes back");
  assert.ok(!prompt.includes("JSON"), "no JSON - the answer is what gets pasted");
});

test("the answer is read with the paste box's own parser; the header lines come off the top", () => {
  const read = core.readAskAnswer("COURSE: Foyle Golf Club\nUNIT: yards\nSOURCE: https://foylegolf.example/scorecard\nCONFIDENCE: high\nNOTES: the White tee is the men's standard\n---\n" + CARD + "\n");
  assert.strictEqual(read.error, undefined);
  assert.strictEqual(read.cardText, CARD, "the card part alone goes to the paste box");
  assert.deepStrictEqual([read.unit, read.source, read.confidence, read.courseName], ["yards", "https://foylegolf.example/scorecard", "high", "Foyle Golf Club"]);
  assert.strictEqual(read.notes, "the White tee is the men's standard");
  assert.strictEqual(read.cards, 1);
  assert.strictEqual(read.holes, 18);
  assert.strictEqual(read.readable, true);
  /* Fenced, metres, spaces for tabs, no SI: still read. */
  const loose = core.readAskAnswer("```\nUNIT: metres\nCONFIDENCE: medium\n---\nHole  1  2  3  4  5  6  7  8  9\nPar  4  3  5  4  4  3  4  5  4\nWhite  320  135  470  355  366  146  340  455  334\n```");
  assert.strictEqual(loose.unit, "metres");
  assert.strictEqual(loose.confidence, "medium");
  assert.ok(loose.cardText.includes("\t"), "runs of spaces become tabs for the paste box");
  assert.strictEqual(loose.readable, true);
  /* Prose instead of a card: kept for the operator to see, but flagged. */
  const prose = core.readAskAnswer("I could not find a scorecard for this course.");
  assert.strictEqual(prose.readable, false);
  assert.strictEqual(prose.cardText, "I could not find a scorecard for this course.");
  assert.strictEqual(core.readAskAnswer("").error, "the model answered with nothing");
});

test("the endpoint queues and polls, admin only; the background half trusts only the course id and never stores a scorecard", () => {
  const sync = read("functions/course-scorecard-ask.mjs");
  const background = read("functions/course-scorecard-ask-background.mjs");
  const store = read("functions/lib/gd-scorecard-ask-store.mjs");
  const toml = read("netlify.toml");
  assert.ok(sync.includes('path: "/api/course-scorecard-ask"') && toml.includes("/api/course-scorecard-ask"), "the endpoint is not routed");
  assert.ok(sync.includes("verifiedAdminEmail(req)") && sync.includes("if (!admin) return json(403"), "a non-admin must be refused");
  assert.ok(sync.includes("process.env.ANTHROPIC_API_KEY"), "an unconfigured site says so instead of queueing an ask that never runs");
  assert.ok(sync.includes("an ask is already running"), "a second ask on a running one is refused, not stacked");
  assert.ok(sync.includes("/.netlify/functions/course-scorecard-ask-background"), "the sync half pings the background half");
  assert.ok(background.includes('import Anthropic from "@anthropic-ai/sdk"'), "the model is called through the official SDK");
  assert.ok(background.includes("const courseId = slug(payload && payload.courseId)") && !/payload\.(prompt|name|course_name)/.test(background), "the request body contributes only the course id");
  assert.ok(background.includes('type: "web_search_20260209", name: "web_search"'), "web search is on, so the card comes from the club's site");
  assert.ok(background.includes('betas: ["server-side-fallback-2026-07-01"]') && background.includes('fallbacks: "default"'), "server-side fallback is on");
  assert.ok(background.includes('DEFAULT_MODEL = "claude-opus-5-5"'), "the default model is Claude Opus 5.5");
  assert.ok(background.includes('stop_reason !== "pause_turn"') && background.includes('messages.push({ role: "assistant", content: message.content })'), "a paused search turn is continued, not read as empty");
  assert.ok(background.includes('stopReason === "refusal"') && background.includes('stopReason === "max_tokens"'), "refusal and truncation are failures, not empty cards");
  assert.ok(background.includes("readAskAnswer(answer.text)"), "the answer goes through the core's reader");
  assert.ok(!/SCORECARDS_TABLE|course_scorecards|storeFacilityCards/.test(background) && !/course_scorecards/.test(store), "the AI never writes a scorecard - the operator Imports");
  assert.ok(fs.existsSync(path.join(ROOT, "supabase/migrations/20261014_create_course_scorecard_asks.sql")), "no migration creates course_scorecard_asks");
});

test("Studio: the button asks, polls, and drops the answer in the paste box with its unit - Import is still the operator's", () => {
  const studio = read("scripts/studio/gd-admin-course-db.js");
  assert.ok(studio.includes('data-gd-scorecard-ask="${id}"') && studio.includes(">Ask AI for this card</button>"), "no Ask AI button in the Add scorecard panel");
  assert.ok(studio.includes("function gdAdminCourseScorecardAsk(") && studio.includes('"/api/course-scorecard-ask"'), "the page does not talk to the ask endpoint");
  assert.ok(studio.includes('gdAdminCourseScorecardSetDraft(courseId,ask.cardText||"",ask.unit||"")'), "the answer lands in the paste box as a draft, with its unit");
  assert.ok(studio.includes("if(gdAdminScorecardDraftUnits[courseId])pasted.unit=gdAdminScorecardDraftUnits[courseId];"), "Import passes the AI's unit on, so the parser is told rather than left to guess");
  assert.ok(studio.includes("GD_SCORECARD_ASK_TIMEOUT_MS"), "the poll gives up eventually");
  const ask = studio.slice(studio.indexOf("async function gdAdminCourseScorecardAsk("), studio.indexOf("/* A failure is toasted as well"));
  assert.ok(!ask.includes("gdAdminCourseScorecardSend(") && !ask.includes("course-scorecard-upload"), "asking never imports - the operator presses Import");
});

test("the test runs in CI", () => {
  assert.ok(read(".github/workflows/structural-smoke.yml").includes("node dev/course-scorecard-ask.test.js"));
});

(async () => {
  core = await import(path.join(ROOT, "functions", "lib", "gd-scorecard-ask-core.mjs"));
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (error) { failed++; console.log("FAIL  " + t.name + "\n      " + (error && error.stack || error)); }
  }
  console.log((failed ? "FAILED " + failed + "/" : "passed ") + tests.length + " scorecard ask checks");
  process.exit(failed ? 1 : 0);
})();
