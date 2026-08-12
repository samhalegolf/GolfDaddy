/*
 * The home/brand images stay small, and every reference to them stays cache-correct.
 *
 * These were authored and shipped at 1024px while nothing renders them above
 * 235px. They are now downscaled to the size they are actually drawn at, and
 * every reference carries the file's own content hash.
 *
 * The hash is the part that rots silently. /assets/* is served with
 * max-age=604800, so replacing an image under an unchanged URL leaves returning
 * users on the old one for up to a week - the app looks fine to whoever tested
 * it in a fresh browser. Before this, some references carried a hand-written
 * ?v=clarity-20260531 and some carried nothing at all.
 *
 * Regenerate with: node dev/optimise-image-assets.js
 * Run: node dev/image-assets.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");

/* Mirrors PLAN in dev/optimise-image-assets.js. maxShipped is the longest edge
   allowed on disk; the comments there explain how each was derived. */
const EXPECTED = [
  { file: "assets/home/play.png", maxShipped: 768 },
  { file: "assets/home/bag.png", maxShipped: 768 },
  { file: "assets/home/profile.png", maxShipped: 768 },
  { file: "assets/home/clarity-caddy-course-library-icon.png", maxShipped: 256 },
  { file: "assets/home/clarity-caddy-shot-end-icon.png", maxShipped: 216 },
  { file: "assets/home/tool-rail.png", maxShipped: 256 },
  { file: "assets/home/clarity-caddy-lock-shot-icon.png", maxShipped: 216 },
  { file: "assets/home/clarity-caddy-unlock-shot-icon.png", maxShipped: 216 },
  { file: "assets/brand/cg-logo-white-g.png", maxShipped: 256 },
  { file: "assets/brand/cg-gps-pin.png", maxShipped: 256 },
  { file: "assets/brand/clarity-app-icon.png", maxShipped: 512 },
  { file: "assets/brand/clarity-member-badge.png", maxShipped: 512 },
  { file: "assets/brand/clarity-month-pass-badge.png", maxShipped: 512 }
];

const REF_EXTENSIONS = [".js", ".mjs", ".html", ".css", ".json"];
const SKIP_DIRS = new Set([
  "node_modules", "dist", ".git", "archive", "_to_delete", "future-projects",
  "image-originals", "icon-originals", "android", "ios"
]);
/* Both of these quote the paths as data, not as references to fetch. */
const SKIP_FILES = new Set([
  path.join(__dirname, "optimise-image-assets.js"),
  path.join(__dirname, "image-assets.test.js")
]);

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function sourceFiles() {
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (REF_EXTENSIONS.includes(path.extname(entry.name))) {
        const file = path.join(dir, entry.name);
        if (!SKIP_FILES.has(file)) out.push(file);
      }
    }
  })(ROOT);
  return out;
}

const files = sourceFiles();
const digests = new Map(EXPECTED.map((item) => [
  item.file,
  crypto.createHash("sha1").update(fs.readFileSync(path.join(ROOT, item.file))).digest("hex").slice(0, 8)
]));

test("every planned image exists and is within its shipped size", () => {
  const oversized = EXPECTED.filter((item) => {
    const bytes = fs.readFileSync(path.join(ROOT, item.file));
    /* IHDR width/height sit at fixed offsets in every PNG. */
    return Math.max(bytes.readUInt32BE(16), bytes.readUInt32BE(20)) > item.maxShipped;
  }).map((item) => item.file);
  assert.deepStrictEqual(oversized, [], "these exceed the size they are ever rendered at: " + oversized.join(", "));
});

test("every reference carries the file's current content hash", () => {
  const wrong = [];
  for (const [relative, digest] of digests) {
    const pattern = new RegExp("/?" + relative.replace(/[.]/g, "\\.") + "(\\?v=([^\"'`\\s)>]*))?", "g");
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      let match;
      while ((match = pattern.exec(text))) {
        if (match[2] !== digest) {
          wrong.push(path.relative(ROOT, file) + " -> " + relative + " ?v=" + (match[2] || "(none)"));
        }
      }
    }
  }
  assert.deepStrictEqual(
    wrong, [],
    "stale or missing cache keys — re-run `node dev/optimise-image-assets.js`:\n        " + wrong.join("\n        ")
  );
});

test("each planned image is still referenced by something", () => {
  const orphans = [...digests.keys()].filter((relative) => !files.some((file) =>
    fs.readFileSync(file, "utf8").includes(relative)));
  assert.deepStrictEqual(orphans, [], "no longer referenced anywhere, so it should not ship: " + orphans.join(", "));
});

test("the home and brand payload stays small", () => {
  const total = ["assets/home", "assets/brand"].reduce((sum, dir) => sum +
    fs.readdirSync(path.join(ROOT, dir))
      .map((name) => path.join(ROOT, dir, name))
      .filter((file) => fs.statSync(file).isFile())
      .reduce((inner, file) => inner + fs.statSync(file).size, 0), 0);
  assert.ok(
    total < 2700 * 1024,
    "assets/home + assets/brand total " + Math.round(total / 1024) + "KB — they were 4457KB, do not let that return"
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
console.log("image-assets passed: " + tests.length + " checks");
