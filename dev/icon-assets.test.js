/*
 * The icon manifest points at files, and those files are what it says they are.
 *
 * scripts/gd-icon-assets.js was 4.46MB of base64 data URIs. Every consumer only
 * ever puts the value in an <img src>, so it is now a 2KB manifest of URLs and
 * the images live in assets/icons/. Two things can silently rot after that
 * change, and neither shows up in review:
 *
 *  1. A data URI creeping back in - one hand-edit and the boot cost returns.
 *  2. A replaced PNG under an unchanged ?v=. /assets/* is cached for a week, so
 *     every browser that already has the old icon keeps it. The ?v= is the
 *     file's content hash; if the two drift, the cache key has stopped working.
 *
 * Run: node dev/icon-assets.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const MANIFEST = path.join(ROOT, "scripts", "gd-icon-assets.js");
/* Nothing renders these above 76px (#gdV62Home .tile img); the sources are
   downscaled to 256, which covers that at 3.3x device pixel ratio. */
const TARGET_PX = 256;

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

const source = fs.readFileSync(MANIFEST, "utf8");
const sandbox = { window: { GDIconAssets: {} } };
new Function("window", source.replace(/^\/\*[\s\S]*?\*\//, ""))(sandbox.window);
const sets = sandbox.window.GDIconAssets;
const entries = Object.entries(sets).flatMap(([setName, set]) =>
  Object.entries(set).map(([key, url]) => ({ label: setName + "." + key, url: url })));

test("both icon sets are exposed and populated", () => {
  assert.ok(sets.icons && sets.gd66Icons, "window.GDIconAssets is missing a set");
  assert.strictEqual(entries.length, 16, "expected 16 icon entries, found " + entries.length);
});

test("no icon is inlined as a data URI", () => {
  const inlined = entries.filter((entry) => /^data:/.test(entry.url)).map((entry) => entry.label);
  assert.deepStrictEqual(inlined, [], "these icons are back to base64 in JS: " + inlined.join(", "));
  assert.ok(source.length < 20000, "the manifest is " + source.length + " bytes — image data has crept back in");
});

test("every icon URL resolves to a file that exists", () => {
  entries.forEach((entry) => {
    const file = path.join(ROOT, entry.url.split("?")[0]);
    assert.ok(fs.existsSync(file), entry.label + " points at a missing file: " + entry.url);
  });
});

test("every ?v= matches its file's content hash", () => {
  const stale = entries.filter((entry) => {
    const [relative, query] = entry.url.split("?");
    const bytes = fs.readFileSync(path.join(ROOT, relative));
    const digest = crypto.createHash("sha1").update(bytes).digest("hex").slice(0, 8);
    return query !== "v=" + digest;
  }).map((entry) => entry.label);
  assert.deepStrictEqual(
    stale, [],
    "these ?v= hashes no longer match the file — re-run `node dev/extract-icon-assets.js`: " + stale.join(", ")
  );
});

test("no shipped icon is larger than it is ever rendered", () => {
  const oversized = entries.filter((entry) => {
    const relative = entry.url.split("?")[0];
    if (!relative.endsWith(".png")) return false;
    const bytes = fs.readFileSync(path.join(ROOT, relative));
    /* IHDR width/height live at fixed offsets in every PNG. */
    return Math.max(bytes.readUInt32BE(16), bytes.readUInt32BE(20)) > TARGET_PX;
  }).map((entry) => entry.label);
  assert.deepStrictEqual(oversized, [], "these icons exceed " + TARGET_PX + "px: " + oversized.join(", "));
});

test("the whole icon payload stays small", () => {
  const unique = new Set(entries.map((entry) => entry.url.split("?")[0]));
  const total = [...unique].reduce((sum, relative) => sum + fs.statSync(path.join(ROOT, relative)).size, 0);
  assert.ok(
    total < 900 * 1024,
    "icons total " + Math.round(total / 1024) + "KB — they were 4457KB inline, do not let that return"
  );
});

let failed = 0;
tests.forEach((entry) => {
  try {
    entry.fn();
    console.log("  ok  " + entry.name);
  } catch (error) {
    failed += 1;
    console.error("  FAIL  " + entry.name + "\n        " + (error && error.message));
  }
});
if (failed) process.exit(1);
console.log("icon-assets passed: " + tests.length + " checks");
