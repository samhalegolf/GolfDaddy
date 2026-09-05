const assert = require("assert");
const fs = require("fs");
const path = require("path");

global.window = {};
new Function(fs.readFileSync(path.join(__dirname, "..", "scripts", "gd-bag-generator-core.js"), "utf8")).call(global.window);
const generator = global.window.GDBagGenerator;
const legacy = { Driver: 230, "3W": 205, "4H": 180, "4i": 178, "5i": 170, "6i": 160, "7i": 155, "8i": 142, "9i": 130, PW: 115, GW: 98, SW: 82, LW: 66 };
const byClub = (rows, club) => rows.find((row) => row.club === club).baseCarry;

assert.ok(generator, "the pure bag generator is published");
[100, 130, 155, 175].forEach((carry) => assert.ok(generator.inferSevenIronSpeed(carry) > 0, "speed is inferred internally"));

[140, 155, 165].forEach((seven) => {
  const rows = generator.generate(seven);
  Object.entries(legacy).forEach(([club, reference]) => {
    const proportional = Math.round(reference * seven / 155);
    assert.ok(Math.abs(byClub(rows, club) - proportional) <= 4, `${seven}m ${club} stays close to the established ladder`);
  });
});

for (let seven = 90; seven <= 185; seven += 1) {
  const rows = generator.generate(seven);
  assert.strictEqual(byClub(rows, "7i"), seven, `${seven}m 7i is exact`);
  rows.forEach((row, index) => { if (index) assert.ok(rows[index - 1].baseCarry > row.baseCarry, `${seven}m stays strictly monotonic`); });
}

const slow = generator.generate(110);
const proportionalGap = Math.round(230 * 110 / 155) - Math.round(205 * 110 / 155);
assert.ok(byClub(slow, "Driver") - byClub(slow, "3W") < proportionalGap - 2, "slow long clubs compress more than proportional scaling");
assert.ok(byClub(slow, "LW") >= 55, "slow wedge carry remains plausible");

const normalGap = generator.generate(155, ["4i", "5i", "6i"]);
const unusualGap = generator.generate(155, ["4i", "6i"]);
assert.ok(byClub(unusualGap, "4i") - byClub(unusualGap, "6i") > byClub(normalGap, "4i") - byClub(normalGap, "5i"), "local loft gaps affect spacing");
assert.strictEqual(generator.descriptor("Mystery club").headType, "iron", "unrecognised labels safely fall back to iron");

const rest = generator.generateRest([{ club: "7i", baseCarry: 147 }, { club: "PW", baseCarry: 109 }]);
assert.strictEqual(rest.added, 11, "generate rest adds only missing estimates");
assert.strictEqual(byClub(rest.rows, "7i"), 147, "generate rest preserves the manual seven iron");
assert.strictEqual(byClub(rest.rows, "PW"), 109, "generate rest never overwrites a manual club");

/* ---- generate mode: any club can be the measurement ----
   The shell's generate mode hands one club's carry to generateFrom and takes
   back the whole bag. What has to hold: the club that was typed keeps EXACTLY
   the number that was typed, the club set is unchanged, and anchoring on any
   club produces the same ladder as anchoring on the seven iron it implies. */
const bagLabels = ["Driver", "3W", "4H", "5i", "6i", "7i", "8i", "9i", "PW", "GW", "SW", "LW"];

bagLabels.forEach((club) => {
  const reference = generator.generate(155, bagLabels);
  const typed = byClub(reference, club);
  const from = generator.generateFrom(club, typed, bagLabels);
  assert.ok(!from.error, `${club} can anchor the bag`);
  assert.strictEqual(byClub(from.rows, club), typed, `${club} keeps exactly the carry that was typed`);
  assert.deepStrictEqual(from.rows.map((row) => row.club).sort(), bagLabels.slice().sort(),
    `${club} anchoring keeps the club set the player carries`);
  from.rows.forEach((row, index) => {
    if (index) assert.ok(from.rows[index - 1].baseCarry > row.baseCarry, `${club} anchoring stays strictly monotonic`);
  });
  bagLabels.forEach((other) => {
    assert.ok(Math.abs(byClub(from.rows, other) - byClub(reference, other)) <= 2,
      `anchoring on ${club} rebuilds ${other} where the seven-iron ladder puts it`);
  });
});

/* Typing a longer number moves the whole bag out, not just that club. */
const stock = generator.generateFrom("7i", 150, bagLabels).rows;
const longer = generator.generateFrom("Driver", byClub(stock, "Driver") + 20, bagLabels).rows;
assert.ok(byClub(longer, "PW") > byClub(stock, "PW"), "a longer driver lengthens the rest of the bag");
assert.ok(byClub(longer, "7i") > byClub(stock, "7i"), "including the club the ladder is normally measured from");

/* A bag missing half the standard clubs stays that bag. */
const partial = generator.generateFrom("9i", 120, ["Driver", "7i", "9i", "SW"]);
assert.deepStrictEqual(partial.rows.map((row) => row.club), ["Driver", "7i", "9i", "SW"],
  "generate from never adds a club the player does not carry");
assert.strictEqual(byClub(partial.rows, "9i"), 120, "and holds the typed club exactly");

/* The inverse of the model is the model. Wedges are excluded below 130 m on
   purpose: the low-speed wedge guard flattens that part of the curve, so a
   slow player's wedge carry genuinely does not pin down one bag. Everything
   the guard does not touch round-trips. */
[100, 130, 155, 175].forEach((seven) => {
  const rows = generator.generate(seven);
  const clubs = seven < 130 ? ["Driver", "6i"] : ["Driver", "6i", "PW", "SW"];
  clubs.forEach((club) => {
    const solved = generator.sevenIronForCarry(club, byClub(rows, club));
    assert.ok(Math.abs(solved - seven) <= 1.5, `${club} at a ${seven}m bag solves back to its seven iron`);
  });
});
/* Even where the seven iron is uncertain, the club the player typed is not:
   generate mode holds it exactly whatever ladder the model settles on. */
assert.strictEqual(byClub(generator.generateFrom("LW", 64, bagLabels).rows, "LW"), 64,
  "a wedge anchor still keeps the number that was typed");

assert.ok(generator.generateFrom("", 150).error, "a club with no name cannot anchor anything");
assert.ok(generator.generateFrom("7i", 0).error, "and neither can a club with no distance");

console.log("bag generator model tests passed");
