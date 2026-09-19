/* Every Garmin product gets a launcher icon, at the size that device asks for.
 *
 * Connect IQ asks a DIFFERENT pixel size per device and does not scale for
 * you at authoring time — it re-encodes whatever source bitmap it is given to
 * the device's native size at compile time. That has two consequences this
 * file exists to hold in place:
 *
 *   1. A wrong-size source still builds. It is simply resampled, and the only
 *      symptom is a soft icon on a device nobody happened to look at. There is
 *      no compiler error and no warning.
 *   2. Because the compiler re-encodes, the .prg is the SAME LENGTH whatever
 *      source you feed it. Comparing build sizes tells you nothing; only the
 *      bytes differ. (Checked by hand on 2026-09-19: fenix6 built from a 40x40
 *      and from a 70x70 source produced two 191,788-byte .prg files with
 *      different SHA-256s.)
 *
 * So the guard has to be on the source files, and that is what this is. It
 * also catches the other half: a product added to manifest.xml with no
 * resourcePath line in monkey.jungle. That one DOES fail the build — `base`
 * deliberately carries no icon — but it fails at the next person's build
 * rather than at the commit that caused it.
 *
 * The expected sizes are read from the installed SDK's own device
 * definitions, never from a list typed in here, because a list typed in here
 * is just a second thing to get wrong. When the SDK is absent (CI), the
 * size checks skip and the wiring checks still run.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const GARMIN = path.join(ROOT, "garmin");
const JUNGLE = path.join(GARMIN, "monkey.jungle");
const MANIFEST = path.join(GARMIN, "manifest.xml");
const DEVICES = path.join(os.homedir(), "Library", "Application Support", "Garmin", "ConnectIQ", "Devices");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function manifestProducts() {
  const xml = fs.readFileSync(MANIFEST, "utf8");
  return Array.from(xml.matchAll(/<iq:product\s+id="([^"]+)"/g)).map(m => m[1]);
}

/* product -> resource folder, from the jungle's per-device resourcePath lines. */
function jungleResourcePaths() {
  const jungle = fs.readFileSync(JUNGLE, "utf8");
  const out = {};
  for (const line of jungle.split("\n")) {
    const m = /^([a-z0-9]+)\.resourcePath\s*=\s*(.+)$/.exec(line.trim());
    if (!m || m[1] === "base") continue;
    /* Take the last segment: the device-specific folder appended after
       $(base.resourcePath). */
    const parts = m[2].split(";").map(s => s.trim()).filter(Boolean);
    out[m[1]] = parts[parts.length - 1];
  }
  return out;
}

/* Width/height straight out of the PNG's IHDR — no image library needed. */
function pngSize(file) {
  const buf = fs.readFileSync(file);
  assert.strictEqual(buf.readUInt32BE(0), 0x89504e47, file + " is not a PNG");
  assert.strictEqual(buf.toString("ascii", 12, 16), "IHDR", file + " has no IHDR where one belongs");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/* What the device itself says it wants. */
function sdkIconSize(product) {
  const file = path.join(DEVICES, product, "compiler.json");
  if (!fs.existsSync(file)) return null;
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  let found = null;
  (function walk(node) {
    if (found || !node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "launcherIcon" && value && typeof value === "object" && value.width) { found = value; return; }
      walk(value);
    }
  })(json);
  return found;
}

test("every product in manifest.xml has its own resourcePath line", function () {
  const products = manifestProducts();
  const paths = jungleResourcePaths();
  assert.ok(products.length > 0, "manifest.xml lists no products at all");
  const missing = products.filter(p => !paths[p]);
  assert.deepStrictEqual(
    missing, [],
    "these products have no resourcePath in monkey.jungle, so they have no launcher icon: " + missing.join(", ")
  );
});

test("base carries no launcher icon, so a missing line fails loudly", function () {
  const jungle = fs.readFileSync(JUNGLE, "utf8");
  const base = /^base\.resourcePath\s*=\s*(.+)$/m.exec(jungle);
  assert.ok(base, "monkey.jungle has no base.resourcePath");
  assert.ok(
    !/resources-icons/.test(base[1]),
    "base.resourcePath must not include an icon folder — a product with no line of its own would " +
    "silently inherit a wrong-size icon instead of failing the build"
  );
  assert.ok(
    !fs.existsSync(path.join(GARMIN, "resources", "drawables")),
    "resources/drawables must not exist: a LauncherIcon there would apply to every device at one size"
  );
});

test("each referenced icon folder has a square PNG and declares LauncherIcon", function () {
  const paths = jungleResourcePaths();
  for (const [product, folder] of Object.entries(paths)) {
    const dir = path.join(GARMIN, folder, "drawables");
    const png = path.join(dir, "launcher_icon.png");
    const xml = path.join(dir, "drawables.xml");
    assert.ok(fs.existsSync(png), product + ": no launcher_icon.png at " + folder);
    assert.ok(fs.existsSync(xml), product + ": no drawables.xml at " + folder);
    assert.ok(/id="LauncherIcon"/.test(fs.readFileSync(xml, "utf8")), product + ": " + folder + " does not declare LauncherIcon");
    const size = pngSize(png);
    assert.strictEqual(size.width, size.height, product + ": " + folder + " icon is not square");
  }
});

test("each product's icon is exactly the size that device asks for", function () {
  if (!fs.existsSync(DEVICES)) {
    console.log("     (skipped: no Connect IQ SDK devices installed on this machine)");
    return;
  }
  const paths = jungleResourcePaths();
  let checked = 0;
  for (const [product, folder] of Object.entries(paths)) {
    const want = sdkIconSize(product);
    if (!want) continue;   /* device not downloaded here */
    const got = pngSize(path.join(GARMIN, folder, "drawables", "launcher_icon.png"));
    assert.strictEqual(
      got.width, want.width,
      product + " wants a " + want.width + "x" + want.height + " launcher icon but " + folder +
      " holds " + got.width + "x" + got.height + ". It would still build — the compiler resamples " +
      "silently — and just look soft on that device."
    );
    checked += 1;
  }
  assert.ok(checked > 0, "no device definitions were available to check against");
  console.log("     (" + checked + " device(s) checked against the installed SDK)");
});

let failed = 0;
tests.forEach(function (t) {
  try { t.fn(); console.log("ok   " + t.name); }
  catch (error) { failed++; console.error("FAIL " + t.name + "\n     " + error.message); }
});
console.log((tests.length - failed) + "/" + tests.length + " passed");
process.exit(failed ? 1 : 0);
