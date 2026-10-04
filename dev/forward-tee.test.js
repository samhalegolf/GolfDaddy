/* Forward-tee lengths, for courses OSM mapped without tees.
 *
 * With no tee to start from, the mapper measures a par 4 or 5 from the far end of its
 * fairway - about where the card's forward tee plays from. So the card now keeps every
 * tee's lengths, and the mapper's second check compares those holes against the forward
 * tee. Par 3s keep the card's own length.
 *
 * Run: node dev/forward-tee.test.js */

const assert = require("assert");
const path = require("path");
const lib = name => "file://" + path.join(__dirname, "..", "functions", "lib", name);

(async () => {
  const parse = await import(lib("gd-scorecard-parse-core.mjs"));
  const resolve = await import(lib("gd-scorecard-resolve.mjs"));

  /* Every tee survives onto the engine card, in the preferred tee's unit. */
  const tr = cells => "<tr>" + cells.map(c => "<td>" + c + "</td>").join("") + "</tr>";
  const html = "<table>" + tr(["Hole", 1, 2, 3, 4, 5, 6, 7, 8, 9])
    + tr(["Par", 4, 5, 3, 4, 3, 4, 5, 4, 4])
    + tr(["Blue", 390, 510, 175, 371, 156, 311, 524, 424, 384])
    + tr(["White", 375, 498, 165, 363, 152, 300, 482, 374, 376])
    + tr(["Red", 361, 337, 160, 351, 127, 292, 450, 305, 305]) + "</table>";
  const card = parse.parseScorecardCardsHtml(html, { name: "Cebu Country Club", unit: "yards" })[0];
  assert.deepStrictEqual(Object.keys(card.holes[0].teesM).sort(), ["Blue", "Red", "White"]);
  assert.strictEqual(card.holes[0].teesM.Red, Math.round(361 * 0.9144), "the forward tee is converted from yards too");
  assert.strictEqual(card.holes[0].distanceM, Math.round(375 * 0.9144), "the preferred (second-longest) tee is unchanged");

  /* Stored with the card, in the store's { name: { metres } } shape. */
  const stored = resolve.toStorePayload(card, "Cebu Country Club");
  assert.deepStrictEqual(stored.holes[0].tees.Red, { metres: Math.round(361 * 0.9144) });

  /* Par 4s and 5s take the forward tee; par 3s keep the card's length. */
  const forward = resolve.forwardTeeHoles(card.holes);
  assert.strictEqual(forward.tee, "Red");
  assert.strictEqual(forward.holes[0].distanceM, Math.round(361 * 0.9144), "par 4 from the forward tee");
  assert.strictEqual(forward.holes[2].distanceM, card.holes[2].distanceM, "par 3 keeps its own length");

  /* The same from a stored row. */
  const fromStore = resolve.forwardTeeHoles(stored.holes.map(h => ({ hole: h.hole, par: h.par, metres: h.metres, tees: h.tees })));
  assert.strictEqual(fromStore.holes[1].distanceM, Math.round(337 * 0.9144));

  /* Nothing to change on a card with one tee, or none recorded. */
  assert.strictEqual(resolve.forwardTeeHoles([{ par: 4, teesM: { Blue: 350 } }]), null);
  assert.strictEqual(resolve.forwardTeeHoles([{ par: 4, metres: 350, tees: {} }]), null);

  console.log("forward-tee tests passed");
})().catch(error => { console.error(error); process.exit(1); });
