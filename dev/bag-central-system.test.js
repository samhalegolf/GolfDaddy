/* One bag, one order, one set of edit rules.
 *
 * Three doors lead to the bag - the home tile, the in-play rail icon, and the
 * bag tool on the player's profile - across two shells: /index.html and the
 * play surface at /app/index.html. They always shared the stored clubs; what
 * they did not share was the presentation, so the same bag came back in a
 * different order with different totals depending on the door.
 *
 * These assertions describe the shared answer in terms someone can check
 * against a screen:
 *
 *   the longest club is top-left
 *   the left column fills top to bottom before the right column starts
 *   the shortest club ends the right column
 *   a club can be renamed wherever it is edited
 *   a new club is asked for its name before its distance
 *
 * Run: node dev/bag-central-system.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/* The core only reaches for `document` inside its renderers, so the pure rules
   can be exercised with nothing but a window object. */
global.window = {};
new Function(read("scripts/gd-bag-core.js")).call(global.window);
const core = global.window.GDBagCore;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function bag(pairs) { return pairs.map(([club, carry]) => ({ club, baseCarry: carry })); }

test("the core loaded and owns the two-column rule", () => {
  assert.ok(core, "scripts/gd-bag-core.js must publish window.GDBagCore");
  assert.strictEqual(core.COLUMNS, 2);
});

test("longest club first, shortest last", () => {
  const rows = core.sortRows(bag([["9i", 130], ["Driver", 230], ["7i", 155]]));
  assert.deepStrictEqual(rows.map((r) => r.club), ["Driver", "7i", "9i"]);
});

test("an even bag fills the left column before the right", () => {
  /* Six clubs, two columns of three. Reading the grid row by row you should see
     the left column running 230/180/150 down, and the right 120/90/60 down. */
  const rows = core.sortRows(bag([["A", 230], ["B", 180], ["C", 150], ["D", 120], ["E", 90], ["F", 60]]));
  const cells = core.columnOrder(rows, 2);
  assert.deepStrictEqual(cells.map((c) => c.row.club), ["A", "D", "B", "E", "C", "F"],
    "DOM order for a row-major grid: left[0], right[0], left[1], right[1] ...");
  const first = cells[0];
  assert.strictEqual(first.column, 0);
  assert.strictEqual(first.line, 0);
  assert.strictEqual(first.row.club, "A", "the longest club is top-left");
  const last = cells[cells.length - 1];
  assert.strictEqual(last.column, 1, "the shortest club ends the RIGHT column");
  assert.strictEqual(last.row.club, "F");
});

test("an odd bag puts the extra club on the left, not the right", () => {
  const rows = core.sortRows(bag([["A", 230], ["B", 180], ["C", 150], ["D", 120], ["E", 90]]));
  const cells = core.columnOrder(rows, 2);
  const left = cells.filter((c) => c.column === 0).map((c) => c.row.club);
  const right = cells.filter((c) => c.column === 1).map((c) => c.row.club);
  assert.deepStrictEqual(left, ["A", "B", "C"], "left column takes the ceiling half");
  assert.deepStrictEqual(right, ["D", "E"]);
  assert.strictEqual(right[right.length - 1], "E", "the shortest club still ends the right column");
});

test("every column reads top to bottom, longest to shortest", () => {
  const rows = core.sortRows(bag([
    ["Driver", 230], ["3W", 205], ["4H", 180], ["5i", 170], ["6i", 160], ["7i", 155],
    ["8i", 142], ["9i", 130], ["PW", 115], ["GW", 98], ["SW", 82], ["LW", 66]
  ]));
  const cells = core.columnOrder(rows, 2);
  [0, 1].forEach((column) => {
    const carries = cells.filter((c) => c.column === column).map((c) => c.row.baseCarry);
    carries.forEach((carry, i) => {
      if (i) assert.ok(carry <= carries[i - 1], "column " + column + " must descend, saw " + carries.join(","));
    });
  });
});

test("a club can be renamed, and keeps its distance", () => {
  const rows = core.sortRows(bag([["Driver", 230], ["4i", 178]]));
  const result = core.renameRow(rows, "4i", "4H");
  assert.ok(!result.error, result.error);
  assert.strictEqual(result.club, "4H");
  const renamed = result.rows.filter((r) => r.club === "4H")[0];
  assert.ok(renamed, "the club is now called 4H");
  assert.strictEqual(renamed.baseCarry, 178, "renaming must not move the carry");
  assert.strictEqual(result.rows.filter((r) => r.club === "4i").length, 0);
});

test("renaming re-derives the total, because roll-out belongs to the club", () => {
  const rows = core.sortRows(bag([["4i", 180]]));
  const asHybrid = core.renameRow(rows, "4i", "4H").rows[0];
  assert.ok(asHybrid.totalM > rows[0].totalM,
    "a hybrid runs on further than an iron off the same carry");
});

test("a rename is refused rather than silently dropped", () => {
  const rows = core.sortRows(bag([["Driver", 230], ["3W", 205]]));
  assert.ok(core.renameRow(rows, "3W", "   ").error, "a club needs a name");
  assert.ok(core.renameRow(rows, "3W", "Driver").error, "and cannot become one already in the bag");
  assert.deepStrictEqual(core.renameRow(rows, "3W", "3W").rows.map((r) => r.club), ["Driver", "3W"],
    "renaming a club to what it is already called is a no-op, not an error");
});

test("adding needs a name AND a distance, and refuses a duplicate", () => {
  const rows = core.sortRows(bag([["7i", 155]]));
  assert.ok(core.addRow(rows, "", 150).error, "no name, no club");
  assert.ok(core.addRow(rows, "6i", 0).error, "no distance, no club");
  assert.ok(core.addRow(rows, "7I", 150).error, "already in the bag, whatever the case");
  const added = core.addRow(rows, "6i", 165);
  assert.ok(!added.error, added.error);
  assert.deepStrictEqual(added.rows.map((r) => r.club), ["6i", "7i"], "and lands in distance order");
});

test("a carry edit re-sorts the bag", () => {
  const rows = core.sortRows(bag([["Driver", 230], ["3W", 205], ["4H", 180]]));
  const result = core.setCarry(rows, "4H", 250);
  assert.deepStrictEqual(result.rows.map((r) => r.club), ["4H", "Driver", "3W"]);
  assert.strictEqual(result.club, "4H", "the caller needs the name back to keep the row open");
});

test("a carry step is exactly one metre", () => {
  const rows = core.sortRows(bag([["7i", 155]]));
  assert.strictEqual(core.setCarry(rows, "7i", 156).rows[0].baseCarry, 156);
  assert.strictEqual(core.setCarry(rows, "7i", 154).rows[0].baseCarry, 154);
});

test("both surfaces keep an open editor anchored until Done", () => {
  const coreSource = read("scripts/gd-bag-core.js");
  assert.ok(coreSource.includes("anchorEditing") && coreSource.includes("anchorRows"),
    "the shared renderer supports a fixed visual edit slot");
  ["app/js/bag.js", "scripts/clarity-support.js"].forEach((file) => {
    assert.ok(read(file).includes("editingAnchorRows"), file + " keeps the editor slot across carry steps");
  });
});

test("removing addresses the club by name, not by where it sat", () => {
  const rows = core.sortRows(bag([["Driver", 230], ["3W", 205], ["4H", 180]]));
  const result = core.removeRow(rows, "3W");
  assert.deepStrictEqual(result.rows.map((r) => r.club), ["Driver", "4H"]);
});

/* ---- roll-out parity: the same club must run on the same distance in both
   shells, so the core's constants have to be the shells' constants ---- */

test("the club grouping is the shells' grouping, verbatim", () => {
  const patterns = ["/driver/i", "/3w|wood|hybrid|4h/i", "/pw|gw|sw|lw|wedge/i"];
  const sources = {
    "scripts/gd-bag-core.js": read("scripts/gd-bag-core.js"),
    "scripts/gd-app-core.js": read("scripts/gd-app-core.js"),
    "app/js/bubble-engine.js": read("app/js/bubble-engine.js")
  };
  Object.keys(sources).forEach((file) => {
    patterns.forEach((pattern) => {
      assert.ok(sources[file].includes(pattern),
        file + " must classify clubs with " + pattern + " - roll-out is derived from it");
    });
  });
});

test("the core's roll-out matches the shell's, club by club", () => {
  /* Rebuilt from gd-app-core's own literals rather than retyped, so this fails
     the moment the shell retunes roll-out and the core is left behind. */
  const shell = read("scripts/gd-app-core.js");
  const pct = {};
  /(?:const|let|var)\s+fallback\s*=\s*\{([^}]*)\}/.exec(shell)[1].split(",").forEach((pair) => {
    const [k, v] = pair.split(":");
    pct[k.trim()] = Number(v);
  });
  const multiplier = {};
  const presets = /GD_BAG_FIRMNESS_PRESETS\s*=\s*([^;]+);/.exec(shell)[1];
  presets.replace(/(\w+)\s*:\s*\{[^{}]*?multiplier\s*:\s*([\d.]+)/g, (all, name, value) => {
    multiplier[name] = Number(value);
    return all;
  });
  assert.deepStrictEqual(Object.keys(pct).sort(), ["driver", "iron", "wedge", "woodHybrid"]);
  assert.deepStrictEqual(Object.keys(multiplier).sort(), ["hard", "medium", "soft"]);

  const group = (club) => /driver/i.test(club) ? "driver"
    : /3w|wood|hybrid|4h/i.test(club) ? "woodHybrid"
    : /pw|gw|sw|lw|wedge/i.test(club) ? "wedge" : "iron";
  const clubs = [["Driver", 230], ["3W", 205], ["4H", 180], ["7i", 155], ["PW", 115], ["SW", 82]];
  Object.keys(multiplier).forEach((preset) => {
    clubs.forEach(([club, carry]) => {
      /* woodHybrid is the shell's one special case: it scales the IRON
         percentage rather than reading its own. */
      const base = group(club) === "woodHybrid" ? pct.iron * 1.35 : pct[group(club)];
      const expected = Math.max(carry, Math.round(carry * (1 + base * multiplier[preset])));
      assert.strictEqual(core.totalForCarry(club, carry, preset), expected,
        club + " at " + carry + "m on " + preset + " must run on to " + expected);
    });
  });
});

/* ---- the wiring: both shells must reach the same core ---- */

test("both shells load the bag core before the code that uses it", () => {
  const shell = read("index.html");
  const play = read("app/index.html");
  const shellCore = shell.indexOf("scripts/gd-bag-core.js");
  const shellUser = shell.indexOf("scripts/clarity-support.js");
  assert.ok(shellCore > -1, "/index.html must load scripts/gd-bag-core.js");
  assert.ok(shellCore < shellUser, "and load it before clarity-support.js");

  const playCore = play.indexOf("../scripts/gd-bag-core.js");
  const playUser = play.indexOf('src="js/bag.js"');
  assert.ok(playCore > -1, "/app/index.html must load the same core");
  assert.ok(playCore < playUser, "and load it before js/bag.js");
});

test("the play surface shares the list stylesheet rather than laying it out itself", () => {
  const play = read("app/index.html");
  assert.ok(play.includes("../styles/inline/gd-editable-bag-panel-v1.css"),
    "/app/ must load the shared bag list CSS");
  assert.ok(!/\.bagList\s*\{[^}]*display:\s*flex/.test(read("app/styles.css")),
    "and must not re-lay-out .bagList locally - GDBagCore owns the grid");
});

test("neither shell keeps its own club-row renderer", () => {
  const support = read("scripts/clarity-support.js");
  assert.ok(support.includes("GDBagCore.renderList"),
    "clarity-support.js must render the club list through the core");
  assert.ok(!support.includes("function rowHTML"), "and must not keep its own row markup");
  assert.ok(read("app/js/bag.js").includes("core().renderList"),
    "app/js/bag.js must render the club list through the core");
});

test("the three doors into the bag are one panel", () => {
  const shell = read("index.html");
  /* Home tile, and the profile tool and in-play rail button, all through the
     same openBag() and therefore the same #bagPanel. */
  assert.ok(/gdBagTile[^>]*onclick="try\{openBag\(\)/.test(shell), "the home tile opens the bag panel");
  assert.ok(read("scripts/inline/gd-brand-icon-render.js").includes("openBag()"),
    "the in-play rail icon opens the same bag panel");
  assert.ok(read("scripts/inline/gd-auth-account-shell.js").includes("openBag({fromProfile:true})"),
    "the profile's bag tool opens the same bag panel");
});

test("adding a club asks for the label first", () => {
  const support = read("scripts/clarity-support.js");
  assert.ok(support.includes("What is the club called?"), "step one is the name");
  assert.ok(support.includes("ui.addStep = 2"), "the distance is a second step");
  assert.ok(!/quickBag\(seven\)\.find\(/.test(support),
    "Add a club must not guess a club and drop it straight into the bag");

  const play = read("app/index.html");
  const clubField = play.indexOf('id="bagAddClub"');
  const carryField = play.indexOf('id="bagAddCarry"');
  assert.ok(clubField > -1 && clubField < carryField, "the play surface asks for the name first too");
  assert.ok(/id="bagAddCarry"[^>]*class="hiddenState"/.test(play),
    "and keeps the distance out of the way until there is a name");
});

test("the row editor can rename the club it has open", () => {
  const coreSource = read("scripts/gd-bag-core.js");
  assert.ok(coreSource.includes("gdBagRowName"), "the expanded row carries a club name field");
  assert.ok(coreSource.indexOf("gdBagRowName") < coreSource.indexOf("gdBagRowStep"),
    "and it sits above the carry stepper - name first, then distance");
  assert.ok(read("styles/inline/gd-editable-bag-panel-v1.css").includes(".gdBagRowName"),
    "and it is styled in the shared stylesheet both shells load");
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("bag-central-system failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("bag-central-system passed: " + tests.length + " checks");
})();
