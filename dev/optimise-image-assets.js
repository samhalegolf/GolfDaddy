/*
 * Downscales and re-encodes the home/brand PNGs, then re-stamps every reference
 * to them with the new file's content hash.
 *
 * Same problem as the icon blob, one level up: these were authored at 1024px and
 * shipped at 1024px, while nothing renders them above 235px. Unlike the icons
 * they are referenced by literal path from ten different files - index.html, six
 * scripts, two Netlify functions - so the size fix and the cache fix have to
 * happen together.
 *
 * The cache fix is the part that is easy to get wrong. /assets/* is served with
 * max-age=604800, so replacing the bytes under an unchanged URL leaves every
 * returning user on the old image for up to a week. Some references already
 * carried a hand-written ?v=clarity-20260531, some carried nothing at all. Now
 * every one of them carries the file's own content hash, rewritten here and
 * checked by dev/image-assets.test.js.
 *
 * Run: node dev/optimise-image-assets.js
 *
 * Originals are kept in dev/image-originals/ (not deployed), so re-running never
 * downscales an already-downscaled file and the set can be re-rendered larger
 * later.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");

const ROOT = path.join(__dirname, "..");
const ORIGINAL_DIR = path.join(__dirname, "image-originals");

/* target = longest edge to ship. maxRender = the largest this image is ever
   drawn, measured in the running app, not guessed:
   - home tile art tops out at 235px; the tile grid is capped at 680px wide, so
     it does not grow past that at any viewport. On a phone the tile is smaller
     (~215px), so 3x DPR there is ~645 device pixels - 768 covers both.
   - cg-logo-white-g renders at 62px on the home header, 34px in the auth card,
     and 44px in transactional email (clarity-email.js and the two Netlify
     functions all hardcode width="44").
   - clarity-app-icon is favicon and apple-touch-icon only; the native launcher
     icons are separate files under android/app/src/main/res and
     ios/App/App/Assets.xcassets. apple-touch-icon tops out at 180px. */
const PLAN = [
  { file: "assets/home/play.png", target: 768, maxRender: 235 },
  { file: "assets/home/bag.png", target: 768, maxRender: 235 },
  { file: "assets/home/profile.png", target: 768, maxRender: 235 },
  { file: "assets/brand/cg-logo-white-g.png", target: 256, maxRender: 62 },
  { file: "assets/brand/cg-gps-pin.png", target: 256, maxRender: 46 },
  /* headroom 1: apple-touch-icon and favicon sizes are already device pixels -
     the OS does not multiply them by the display's pixel ratio. 512 is the
     largest size a PWA install prompt asks for, so it is the ceiling. */
  { file: "assets/brand/clarity-app-icon.png", target: 512, maxRender: 180, headroom: 1 }
];

/* Where a reference can live. Markdown is excluded on purpose - the docs discuss
   these filenames in prose and must not gain query strings. */
const REF_EXTENSIONS = [".js", ".mjs", ".html", ".css", ".json"];
const SKIP_DIRS = new Set([
  "node_modules", "dist", ".git", "archive", "_to_delete", "future-projects",
  "image-originals", "icon-originals", "android", "ios"
]);
/* This script and its test both quote the asset paths as data. Without this they
   rewrite their own PLAN and expectations into ...png?v=<hash> on the first run. */
const SKIP_FILES = new Set([
  path.join(__dirname, "optimise-image-assets.js"),
  path.join(__dirname, "image-assets.test.js")
]);

function hash(buffer) { return crypto.createHash("sha1").update(buffer).digest("hex").slice(0, 8); }

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

/* Rewrite every reference to `relative`, with or without a leading slash and
   with or without an existing ?v=, so it carries the current content hash. */
function restampReferences(files, relative, digest) {
  const pattern = new RegExp("(/?" + relative.replace(/[.]/g, "\\.") + ")(\\?v=[^\"'`\\s)>]*)?", "g");
  let touched = 0;
  let occurrences = 0;
  for (const file of files) {
    const before = fs.readFileSync(file, "utf8");
    const after = before.replace(pattern, (whole, pathPart) => {
      occurrences += 1;
      return pathPart + "?v=" + digest;
    });
    if (after !== before) { fs.writeFileSync(file, after); touched += 1; }
  }
  return { touched: touched, occurrences: occurrences };
}

(async () => {
  fs.mkdirSync(ORIGINAL_DIR, { recursive: true });
  const files = sourceFiles();
  let before = 0;
  let after = 0;

  for (const item of PLAN) {
    const headroom = item.headroom === undefined ? 3 : item.headroom;
    if (item.target < item.maxRender * headroom) {
      throw new Error(item.file + ": target must cover maxRender at " + headroom + "x");
    }
    const shipped = path.join(ROOT, item.file);
    const keptName = item.file.replace(/^assets\//, "").replace(/\//g, "-");
    const kept = path.join(ORIGINAL_DIR, keptName);
    if (!fs.existsSync(kept)) fs.copyFileSync(shipped, kept);

    const original = fs.readFileSync(kept);
    const meta = await sharp(original).metadata();
    const encoded = await sharp(original)
      .resize({ width: item.target, height: item.target, fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
      .toBuffer();
    const result = await sharp(encoded).metadata();
    /* Full colour, not quantised, and alpha preserved - these sit on dark
       gradients where a 256-colour palette bands the soft shadows. */
    if (meta.hasAlpha && result.channels !== 4) throw new Error(item.file + ": lost the alpha channel");
    if (Math.max(result.width, result.height) > item.target) throw new Error(item.file + ": downscale did not apply");

    fs.writeFileSync(shipped, encoded);
    const digest = hash(encoded);
    const refs = restampReferences(files, item.file, digest);
    before += original.length;
    after += encoded.length;
    console.log(
      "  " + item.file.replace("assets/", "").padEnd(26) +
      (meta.width + "x" + meta.height).padStart(10) + " " + (Math.round(original.length / 1024) + "KB").padStart(7) +
      "  ->  " + (result.width + "x" + result.height).padStart(9) + " " + (Math.round(encoded.length / 1024) + "KB").padStart(7) +
      "   ?v=" + digest + "  (" + refs.occurrences + " refs in " + refs.touched + " files)"
    );
  }

  console.log(
    "\nhome/brand payload: " + Math.round(before / 1024) + "KB -> " + Math.round(after / 1024) + "KB"
  );
})().catch((error) => { console.error("optimise-image-assets failed:", error && error.message); process.exit(1); });
