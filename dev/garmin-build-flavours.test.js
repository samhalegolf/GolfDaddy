/* The three Garmin build flavours, and the annotation trap between them.
 *
 * THE BUG THIS EXISTS TO STOP COMING BACK. A jungle's `excludeAnnotations` is
 * an ASSIGNMENT, not an addition. monkey.jungle excludes `tx_muted;parity`;
 * each overlay replaces that line wholesale. So when the parity harness was
 * added, monkey-sim-mute.jungle still said only `tx_live` — which silently
 * un-excluded the parity half, and `CIQ_MUTE_TX=1 ./build.sh build` died with
 * "Redefinition of 'run' in '$.GarminParityPolicy'". The store package was
 * fine, the parity build was fine, and the one flavour nobody rebuilt was
 * broken.
 *
 * Every annotation in this project comes in a two-definitions pair: one is
 * compiled, the other excluded. The rule that follows is simple and is what
 * this file checks — every jungle must name exactly one annotation out of
 * every pair. Miss one and both definitions compile; name both and neither
 * does.
 *
 * Compiling is the only real proof, and that needs the SDK. This is the cheap
 * guard that runs everywhere and catches the mistake at the commit that makes
 * it.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const GARMIN = path.join(ROOT, "garmin");

/* Both halves of each pair, as the source actually spells them. Read out of
   the .mc files rather than typed here, so a renamed annotation cannot leave
   this test quietly checking a name nobody uses any more. */
function annotationPairs() {
  const files = [
    path.join(GARMIN, "source", "Session", "GarminTransmitPolicy.mc"),
    path.join(GARMIN, "source", "Test", "GarminParityPolicy.mc")
  ];
  return files.map(file => {
    const source = fs.readFileSync(file, "utf8");
    const found = Array.from(source.matchAll(/^\s*\(:([a-z_]+)\)\s*$/gm)).map(m => m[1]);
    const unique = Array.from(new Set(found));
    assert.ok(
      unique.length === 2,
      path.basename(file) + " should define exactly one annotation pair, found: " + unique.join(", ")
    );
    return { file: path.basename(file), pair: unique };
  });
}

function excluded(jungle) {
  const source = fs.readFileSync(path.join(GARMIN, jungle), "utf8");
  const line = /^base\.excludeAnnotations\s*=\s*(.+)$/m.exec(source);
  assert.ok(line, jungle + " has no base.excludeAnnotations line");
  return line[1].split(";").map(s => s.trim()).filter(Boolean);
}

const JUNGLES = ["monkey.jungle", "monkey-sim-mute.jungle", "monkey-parity.jungle"];

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("every jungle excludes exactly one annotation out of every pair", function () {
  const pairs = annotationPairs();
  JUNGLES.forEach(jungle => {
    const list = excluded(jungle);
    pairs.forEach(({ file, pair }) => {
      const named = pair.filter(a => list.indexOf(a) >= 0);
      assert.strictEqual(
        named.length, 1,
        jungle + " names " + named.length + " of " + file + "'s pair (" + pair.join(" / ") + "). " +
        "It must name exactly one: naming neither compiles both definitions " +
        "(\"Redefinition of 'run'\"), naming both compiles neither."
      );
    });
  });
});

test("the default build excludes the parity harness, and the parity build does not", function () {
  const base = excluded("monkey.jungle");
  const parity = excluded("monkey-parity.jungle");
  assert.ok(
    base.indexOf("parity") >= 0,
    "monkey.jungle must exclude `parity`, or the fixture table and harness ship in the store package"
  );
  assert.ok(
    parity.indexOf("parity_off") >= 0 && parity.indexOf("parity") < 0,
    "monkey-parity.jungle must exclude `parity_off` (and not `parity`), or the harness never runs"
  );
});

test("a parity build is also muted", function () {
  /* The harness has no business transmitting to a phone, and the simulator
     segfaults on transmit while tethered (UPLOAD.md, "Known simulator bug"). */
  assert.ok(
    excluded("monkey-parity.jungle").indexOf("tx_live") >= 0,
    "monkey-parity.jungle must exclude `tx_live` so a parity build cannot transmit"
  );
});

test("build.sh knows both overlays, and package knows neither", function () {
  const build = fs.readFileSync(path.join(GARMIN, "build.sh"), "utf8");
  const cmdBuild = build.slice(build.indexOf("cmd_build()"), build.indexOf("cmd_package()"));
  const cmdPackage = build.slice(build.indexOf("cmd_package()"));
  assert.ok(/monkey-sim-mute\.jungle/.test(cmdBuild), "cmd_build lost the muted overlay");
  assert.ok(/monkey-parity\.jungle/.test(cmdBuild), "cmd_build lost the parity overlay");
  assert.ok(
    !/monkey-(sim-mute|parity)\.jungle/.test(cmdPackage),
    "cmd_package must never chain an overlay — the store binary is the plain build"
  );
});

let failed = 0;
tests.forEach(function (t) {
  try { t.fn(); console.log("ok   " + t.name); }
  catch (error) { failed++; console.error("FAIL " + t.name + "\n     " + error.message); }
});
console.log((tests.length - failed) + "/" + tests.length + " passed");
process.exit(failed ? 1 : 0);
