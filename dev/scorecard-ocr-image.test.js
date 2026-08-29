/*
 * End to end, on real pixels: rendered scorecard -> scan -> grids ->
 * gd-scorecard-parse-core -> engine cards.
 *
 * This is the test the practice photo scanner never had. Its geometry is tested
 * headlessly and its import hand-off is tested headlessly, but the run from
 * pixels to the thing the app consumes only ever happened in a browser on a
 * deploy preview — which is why "no known structural blockers, remaining risk is
 * ordinary accuracy tuning" was as much as anyone could say about it.
 *
 * Run:  node dev/scorecard-ocr-image.test.js
 */
"use strict";
const assert = require("assert");
const { renderCard, makeRecognizer, standardCardSpec } = require("./scorecard-image-fixture.js");
const { scanScorecard } = require("../scripts/clarity-scorecard-scan.js");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("PASS  " + name); }
  catch (error) { failures += 1; console.log("FAIL  " + name + "\n      " + error.message); }
}

async function parseCore() {
  return import("../functions/lib/gd-scorecard-parse-core.mjs");
}

async function scan(spec, options = {}) {
  const image = renderCard(spec, options.render);
  const recognize = makeRecognizer(options.recognizer);
  const result = await scanScorecard(image, Object.assign({ recognize }, options.scan));
  return { image, result };
}

(async function main() {
  const { parseScorecardCards } = await parseCore();

  // ---------------------------------------------------------------- case 1
  // A standard 18-across card with Out / In / Total columns and three tee rows.
  {
    const spec = standardCardSpec();
    const { image, result } = await scan(spec);
    console.log(`\n[standard card] ${image.width}x${image.height}, ${result.diagnostics ? result.diagnostics.boxes : 0} boxes`);
    check("standard card scans", () => assert.ok(result.ok, `stage ${result.stage}: ${result.error}`));
    if (!result.ok) { console.log(result.detail); process.exit(1); }
    console.log("  strips:", result.strips.map(s => `${s.kind || "?"}(${s.label || "-"})[${s.values.length}]`).join(" "));

    check("one strip is the hole numbers", () =>
      assert.strictEqual(result.strips.filter(s => s.kind === "holes").length, 1));
    check("one strip is par", () =>
      assert.strictEqual(result.strips.filter(s => s.kind === "par").length, 1));
    check("one strip is the stroke index", () =>
      assert.strictEqual(result.strips.filter(s => s.kind === "index").length, 1));
    check("three strips are tee distances", () =>
      assert.strictEqual(result.strips.filter(s => s.kind === "distance").length, 3));
    check("18 hole columns found (Out/In/Total excluded)", () => {
      const holes = result.strips.find(s => s.kind === "holes");
      assert.strictEqual(holes.values.length, 18, "hole strip values: " + holes.values.map(v => v.n).join(","));
    });
    check("hole numbers read 1..18 in order", () => {
      const holes = result.strips.find(s => s.kind === "holes").values.map(v => v.n);
      assert.deepStrictEqual(holes, spec.truth.holes);
    });

    const cards = parseScorecardCards(result.grids, { unit: result.unit });
    check("the parse core returns one card", () => assert.strictEqual(cards.length, 1));
    const card = cards[0];
    console.log("  card:", card.holeCount, "holes, par", card.par, "tee", card.teeName, "of", card.teeOptions.join("/"));
    check("card has 18 holes", () => assert.strictEqual(card.holeCount, 18));
    check("par row survived intact", () =>
      assert.deepStrictEqual(card.holes.map(h => h.par), spec.truth.par));
    check("total par is the sum of the par row", () =>
      assert.strictEqual(card.par, spec.truth.par.reduce((s, v) => s + v, 0)));
    check("stroke index survived intact", () =>
      assert.deepStrictEqual(card.holes.map(h => h.strokeIndex), spec.truth.index));
    check("the second-longest tee is preferred", () =>
      assert.strictEqual(card.teeName, "MEMBERS"));
    check("distances converted yards -> metres", () => {
      const expected = spec.truth.members.map(y => Math.round(y * 0.9144));
      assert.deepStrictEqual(card.holes.map(h => h.distanceM), expected);
    });
    check("every hole carries a distance", () =>
      assert.strictEqual(card.holes.filter(h => Number.isFinite(h.distanceM)).length, 18));
  }

  // ---------------------------------------------------------------- case 2
  // A card printed in two stacked halves, the 18Birdies shape. Two hole rows
  // whose numbers do NOT collide are one card, not two.
  {
    const base = standardCardSpec();
    const half = (list, from, to) => list.slice(from, to).map(String);
    const spec = {
      columns: Array.from({ length: 9 }, (_, i) => String(i + 1)),
      rows: [
        { label: "HOLE", cells: half(base.truth.holes, 0, 9) },
        { label: "PAR", cells: half(base.truth.par, 0, 9) },
        { label: "CHAMP", cells: half(base.truth.champ, 0, 9) },
        { label: "MEMBERS", cells: half(base.truth.members, 0, 9) },
        { label: "HOLE", cells: half(base.truth.holes, 9, 18) },
        { label: "PAR", cells: half(base.truth.par, 9, 18) },
        { label: "CHAMP", cells: half(base.truth.champ, 9, 18) },
        { label: "MEMBERS", cells: half(base.truth.members, 9, 18) }
      ]
    };
    const { result } = await scan(spec);
    console.log("\n[stacked halves]", result.ok ? result.strips.map(s => s.kind || "?").join(" ") : `${result.stage}: ${result.error}`);
    check("stacked card scans", () => assert.ok(result.ok, `stage ${result.stage}: ${result.error}`));
    if (result.ok) {
      check("two hole strips found", () =>
        assert.strictEqual(result.strips.filter(s => s.kind === "holes").length, 2));
      check("two grids emitted, the second a continuation", () => {
        assert.strictEqual(result.grids.length, 2);
        assert.strictEqual(result.grids[1].continuation, true);
      });
      const cards = parseScorecardCards(result.grids);
      check("the halves merge into ONE 18-hole card", () => {
        assert.strictEqual(cards.length, 1, "cards: " + cards.length);
        assert.strictEqual(cards[0].holeCount, 18);
      });
      check("merged par matches both halves", () =>
        assert.deepStrictEqual(cards[0].holes.map(h => h.par), base.truth.par));
    }
  }

  // ---------------------------------------------------------------- case 3
  // Two courses on one page. Two hole rows that BOTH start at 1 are two cards,
  // and merging them would produce 36 holes of nonsense.
  {
    const base = standardCardSpec();
    const nine = (list, from) => list.slice(from, from + 9).map(String);
    const spec = {
      columns: Array.from({ length: 9 }, (_, i) => String(i + 1)),
      rows: [
        { label: "HOLE", cells: nine(base.truth.holes, 0) },
        { label: "PAR", cells: nine(base.truth.par, 0) },
        { label: "CHAMP", cells: nine(base.truth.champ, 0) },
        { label: "HOLE", cells: nine(base.truth.holes, 0) },
        { label: "PAR", cells: nine(base.truth.par, 9) },
        { label: "CHAMP", cells: nine(base.truth.champ, 9) }
      ]
    };
    const { result } = await scan(spec);
    console.log("\n[two courses]", result.ok ? result.grids.map(g => `${g.label || "(cont)"}`).join(" ") : `${result.stage}: ${result.error}`);
    check("two-course page scans", () => assert.ok(result.ok, `stage ${result.stage}: ${result.error}`));
    if (result.ok) {
      check("the second block is labelled, not a continuation", () => {
        assert.strictEqual(result.grids.length, 2);
        assert.strictEqual(result.grids[1].continuation, false);
        assert.ok(result.grids[1].label, "second grid needs a label to stay separate");
      });
      const cards = parseScorecardCards(result.grids);
      check("two cards, nine holes each", () => {
        assert.strictEqual(cards.length, 2, "cards: " + cards.length);
        assert.deepStrictEqual(cards.map(c => c.holeCount), [9, 9]);
      });
    }
  }

  // ---------------------------------------------------------------- case 4
  // A tee row printed white-on-colour. The practice reader's fixed dark-ink mask
  // erases this row completely; the polarity-picking mask keeps it.
  {
    const base = standardCardSpec();
    const spec = {
      columns: Array.from({ length: 9 }, (_, i) => String(i + 1)),
      rows: [
        { label: "HOLE", cells: base.truth.holes.slice(0, 9).map(String) },
        { label: "PAR", cells: base.truth.par.slice(0, 9).map(String) },
        { label: "BLUE", cells: base.truth.champ.slice(0, 9).map(String), fill: [28, 48, 92] },
        { label: "WHITE", cells: base.truth.members.slice(0, 9).map(String) }
      ]
    };
    const { result } = await scan(spec);
    console.log("\n[reversed-out tee row]", result.ok ? result.strips.map(s => `${s.kind}(${s.label})`).join(" ") : `${result.stage}: ${result.error}`);
    check("card with a reversed-out row scans", () => assert.ok(result.ok, `stage ${result.stage}: ${result.error}`));
    if (result.ok) {
      const cards = parseScorecardCards(result.grids);
      check("both tee rows reach the card", () => {
        assert.strictEqual(cards.length, 1);
        assert.strictEqual(cards[0].teeOptions.length, 2, "tees: " + cards[0].teeOptions.join(","));
      });
      check("the reversed-out row's numbers are right", () => {
        const distance = result.strips.find(s => s.kind === "distance");
        assert.deepStrictEqual(distance.values.map(v => v.n), base.truth.champ.slice(0, 9));
      });
    }
  }

  // ---------------------------------------------------------------- case 5
  // Gaps are tolerated. Three cells scrubbed out of the card entirely: the scan
  // reports what it read rather than failing an 18-hole gate.
  {
    const base = standardCardSpec();
    const blankOut = (list, holes) => list.map((v, i) => (holes.includes(i) ? "" : String(v)));
    const spec = {
      columns: Array.from({ length: 9 }, (_, i) => String(i + 1)),
      rows: [
        { label: "HOLE", cells: blankOut(base.truth.holes.slice(0, 9), [4]) },
        { label: "PAR", cells: blankOut(base.truth.par.slice(0, 9), [4, 6]) },
        { label: "CHAMP", cells: blankOut(base.truth.champ.slice(0, 9), [4]) },
        { label: "MEMBERS", cells: blankOut(base.truth.members.slice(0, 9), [4, 2]) }
      ]
    };
    const { result } = await scan(spec);
    console.log("\n[gappy card]", result.ok ? `${result.strips.filter(s => s.kind).length} strips identified` : `${result.stage}: ${result.error}`);
    check("gappy card still scans", () => assert.ok(result.ok, `stage ${result.stage}: ${result.error}`));
    if (result.ok) {
      const cards = parseScorecardCards(result.grids);
      check("eight holes come back, not zero", () => {
        assert.strictEqual(cards.length, 1);
        assert.strictEqual(cards[0].holeCount, 8);
      });
      check("no value shifted into a neighbour's hole", () => {
        const byHole = new Map(cards[0].holes.map(h => [h.hole, h]));
        assert.strictEqual(byHole.get(1).par, base.truth.par[0]);
        assert.strictEqual(byHole.get(9).par, base.truth.par[8]);
        assert.strictEqual(byHole.get(6).par, base.truth.par[5]);
        assert.ok(!byHole.has(5), "hole 5 was blanked and must not appear");
      });
    }
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL TESTS PASSED");
  process.exit(failures ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });
