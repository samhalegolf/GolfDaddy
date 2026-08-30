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

console.log("bag generator model tests passed");
