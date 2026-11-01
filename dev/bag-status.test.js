/* scripts/gd-bag-status.js: whether a stored bag is really the player's own, from the
 * distances alone. The cases are the bag shapes actually stored on 2 Nov 2026 (52 active
 * players), plus the edges: an empty bag, a stock set missing a club, a quick set with one
 * club edited. The old flag-based answer called the 21 stock bags synced without flags
 * "real" and called players who later typed their own clubs "generated". */

const assert = require("assert");
const path = require("path");
const { bagStatus } = require(path.join(__dirname, "..", "scripts", "gd-bag-status.js"));

const bag = s => s.split(" ").map(p => { const [club, carry] = p.split(":"); return { club, baseCarry: Number(carry) }; });
const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (error) { results.push({ name, ok: false, error }); }
}

check("no clubs is not set", () => {
  assert.deepStrictEqual(bagStatus([]), { status: "none", set: false, clubs: 0, sevenIron: null });
  assert.strictEqual(bagStatus(null).status, "none");
  assert.strictEqual(bagStatus([{ club: "7i", baseCarry: 0 }]).status, "none", "a club with no carry is no club");
});

check("the stock distances are not set, with or without the lob wedge", () => {
  const stock = bagStatus(bag("Driver:230 3W:205 4H:180 4i:178 5i:170 6i:160 7i:155 8i:142 9i:130 PW:115 GW:98 SW:82"));
  assert.strictEqual(stock.status, "stock");
  assert.strictEqual(stock.set, false);
  assert.strictEqual(bagStatus(bag("Driver:230 7i:155 PW:115 LW:66")).status, "stock");
});

check("the old quick set left at the default 155 m 7-iron is not set", () => {
  const r = bagStatus(bag("Driver:245 3W:210 4H:190 5i:175 6i:165 7i:155 8i:145 9i:133 PW:115 GW:100 SW:83 LW:67"));
  assert.strictEqual(r.status, "quick-default");
  assert.strictEqual(r.set, false);
});

check("a quick set from the player's own 7-iron is set, from either generator", () => {
  for (const [s, seven] of [
    ["Driver:227 3W:202 4H:178 4i:176 5i:168 6i:158 7i:153 8i:140 9i:128 PW:113 GW:97 SW:81 LW:65", 153],
    ["Driver:231 3W:196 4H:176 5i:161 6i:151 7i:141 8i:131 9i:119 PW:101 GW:86 SW:69 LW:53", 141],
    ["Driver:238 3W:203 4H:183 5i:168 6i:158 7i:148 8i:138 9i:126 PW:108 GW:93 SW:76 LW:60", 148],
    ["Driver:248 3W:213 4H:193 5i:178 6i:168 7i:158 8i:148 9i:136 PW:118 GW:103 SW:86 LW:70", 158]
  ]) {
    const r = bagStatus(bag(s));
    assert.strictEqual(r.status, "quick", s);
    assert.strictEqual(r.set, true);
    assert.strictEqual(r.sevenIron, seven);
  }
});

check("distances the player typed or edited are set", () => {
  for (const s of [
    "Driver:230 3H:180 5H:173 7W:173 6i:150 7i:146 8i:126 9i:117 PW:115 GW:98 SW:82 LW:61",
    "Driver:180 3W:161 4H:144 4i:145 5i:137 6i:128 7i:124 8i:112 9i:102 PW:92 GW:78 SW:69 LW:68",
    "Driver:205 5W:190 3W:195 5i:175 6i:165 7i:155 8i:145 9i:133 PW:115 GW:100 SW:83 LW:67",
    "Driver:231 7i:155"
  ]) {
    const r = bagStatus(bag(s));
    assert.strictEqual(r.status, "custom", s);
    assert.strictEqual(r.set, true);
  }
});

console.log("— Bag status —");
let failed = 0;
results.forEach(r => {
  if (r.ok) console.log("  PASS  " + r.name);
  else { failed += 1; console.log("  FAIL  " + r.name + "\n        " + (r.error && r.error.message)); }
});
if (failed) { console.log(failed + " check(s) failed."); process.exit(1); }
console.log(results.length + " bag status checks passed.");
