/* functions/marketing-hole-intel.js — the extraction, which is the part with rules. The search
   itself is functions/lib/gd-web-search.js and is not exercised here; what is pinned is what a
   hole number next to a phrase is allowed to mean.

   node dev/marketing-hole-intel.test.js */
"use strict";

const assert = require("node:assert");
const intel = require("../functions/marketing-hole-intel.js");

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (error) { console.error(`FAIL  ${name}\n      ${error.message}`); process.exitCode = 1; }
}

const NAME = "Te Arai Links";
const extract = (results) => intel.extractHoles(results, NAME, 18);
const result = (title, snippet, url) => ({ title, snippet, url: url || "https://example.test/" + Math.random() });

test("a plainly named signature hole is found", () => {
  const got = extract([result("Te Arai Links", "The signature hole is the par 3 7th, played over the dunes.")]);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].hole, 7);
  assert.ok(got[0].confidence > 0.5, `confidence was only ${got[0].confidence}`);
});

test("hole numbers with no signature language nearby are not evidence", () => {
  const got = extract([result("Te Arai Links", "Hole 4 is closed for maintenance. Hole 12 reopens Monday.")]);
  assert.deepStrictEqual(got, []);
});

test("all three ways of naming a hole are read", () => {
  ["The signature hole 9 plays downhill.",
    "Our signature 9th hole plays downhill.",
    "Downhill all the way: the 9th is the signature."]
    .forEach((snippet) => {
      const got = extract([result("Te Arai Links", snippet)]);
      assert.strictEqual(got.length, 1, `no hole found in: ${snippet}`);
      assert.strictEqual(got[0].hole, 9, `wrong hole from: ${snippet}`);
    });
});

test("a result about a different course is discarded", () => {
  const got = extract([result("Top 100 golf holes", "Pebble Beach's signature 7th is the most photographed in golf.")]);
  assert.deepStrictEqual(got, [], "a listicle about another course was treated as evidence");
});

test("phrases too far from the hole number do not count", () => {
  const filler = " and then a long stretch of unrelated prose about the clubhouse and the pro shop ".repeat(4);
  const got = extract([result("Te Arai Links", "Our signature hole is worth the trip." + filler + "Hole 11 has a coffee cart.")]);
  assert.deepStrictEqual(got, [], "a phrase 300 characters away was linked to a hole");
});

test("two pages agreeing outrank one page saying it once", () => {
  const once = extract([result("Te Arai Links", "The famous 5th runs along the coast.")]);
  const twice = extract([
    result("Te Arai Links", "The famous 5th runs along the coast."),
    result("Te Arai Links review", "Playing the famous 5th at Te Arai Links.")
  ]);
  assert.strictEqual(once[0].hole, 5);
  assert.strictEqual(twice[0].hole, 5);
  assert.ok(twice[0].confidence > once[0].confidence, "agreement added nothing");
  assert.strictEqual(twice[0].agreement, 2);
});

test("stronger language outranks weaker for the same hole count", () => {
  const strong = extract([result("Te Arai Links", "The most photographed hole here is the 14th.")]);
  const weak = extract([result("Te Arai Links", "The toughest hole here is the 14th.")]);
  assert.ok(strong[0].confidence > weak[0].confidence,
    `"most photographed" (${strong[0].confidence}) did not beat "toughest" (${weak[0].confidence})`);
});

test("confidence never exceeds 1", () => {
  const many = Array.from({ length: 8 }, (_, i) =>
    result("Te Arai Links", "The most photographed postcard hole is the 3rd.", "https://example.test/" + i));
  const got = extract(many);
  assert.ok(got[0].confidence <= 1, `confidence was ${got[0].confidence}`);
});

test("a hole number beyond the course's hole count is ignored", () => {
  const got = intel.extractHoles([result("Te Arai Links", "The signature hole is the 23rd.")], NAME, 18);
  assert.deepStrictEqual(got, []);
});

test("one result naming a hole twice counts once, not twice", () => {
  const got = extract([result("Te Arai Links",
    "The signature 6th. The signature 6th again. Our famous 6th.")]);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].agreement, 1, "one page was counted as three sources");
});

test("results are ordered strongest first", () => {
  const got = extract([
    result("Te Arai Links", "The toughest hole is the 2nd."),
    result("Te Arai Links", "The signature hole is the 8th.")
  ]);
  assert.strictEqual(got[0].hole, 8, "the weaker phrase sorted first");
});

test("empty and malformed input answers with an empty list, never a throw", () => {
  assert.deepStrictEqual(extract([]), []);
  assert.deepStrictEqual(extract(null), []);
  assert.deepStrictEqual(extract([{}, { title: null, snippet: null }]), []);
});

test("the bare-ordinal pattern does not turn dates or addresses into holes", () => {
  /* Each of these puts signature language right beside an ordinal, so the proximity gate alone
     would let them through - the suffix guard is what has to catch them. */
  [
    "Our famous clubhouse, built in the 18th century, overlooks the course.",
    "The signature restaurant on 5th Avenue is worth a visit.",
    "Celebrating our famous 10th anniversary this year."
  ].forEach((snippet) => {
    assert.deepStrictEqual(extract([result("Te Arai Links", snippet)]), [],
      `treated as a hole: ${snippet}`);
  });
});

test("holeMentions records where in the text each number sat", () => {
  const found = intel.holeMentions("nothing here yet, then hole 7 arrives", 18);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].hole, 7);
  assert.ok(found[0].at > 10, "the offset was not recorded");
});

if (!process.exitCode) console.log(`marketing-hole-intel: ${passed} checks passed`);
