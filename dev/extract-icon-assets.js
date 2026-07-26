/*
 * Generates scripts/gd-icon-assets.js and the files in assets/icons/.
 *
 * The manifest used to be 4.46MB of base64 data URIs - 14 PNGs and 2 SVGs
 * inlined into JavaScript, the single heaviest thing the phone app loaded.
 * base64-in-JS is the worst container for image data: ~33% size overhead over
 * the raw bytes, and the whole 4.5MB string is parsed by the JS engine on every
 * boot, before anything is drawn. All three consumers only ever do
 * `<img src="' + ICONS[key] + '">`, so a file URL is a drop-in replacement and
 * lets the webview cache and decode each icon lazily instead.
 *
 * The PNGs were 512x512 RGBA stored near-uncompressed (~260KB each). Nothing
 * renders them above 76px - see MAX_RENDER_PX - so they are downscaled to 256px
 * and re-encoded lossless full-colour. 4457KB -> ~634KB with no visible change
 * at any device pixel ratio up to 3.3x.
 *
 * The 512px originals are kept in dev/icon-originals/ (not deployed) so the set
 * can be regenerated at a different size later. This script reads from there
 * when it exists, so re-running never downscales an already-downscaled icon.
 *
 * Run: node dev/extract-icon-assets.js
 *
 * Re-run it after replacing any icon; the ?v= in the manifest is the file's
 * content hash and dev/icon-assets.test.js fails if the two drift.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");

const ROOT = path.join(__dirname, "..");
const MANIFEST = path.join(ROOT, "scripts", "gd-icon-assets.js");
const ICON_DIR = path.join(ROOT, "assets", "icons");
const ORIGINAL_DIR = path.join(__dirname, "icon-originals");
/* Prefix per set, so the two sets can hold different images under one key. */
const SETS = { icons: "", gd66Icons: "gd66-" };

/* The largest any of these icons is ever rendered, measured across every CSS
   rule that sizes them: #gdV62Home .tile img at 76px. Others are 70, 54, 48, 44,
   42, 40, 38, 34, 24, 22, 20. */
const MAX_RENDER_PX = 76;
const TARGET_PX = 256;
if (TARGET_PX < MAX_RENDER_PX * 3) throw new Error("TARGET_PX must cover MAX_RENDER_PX at 3x device pixel ratio");

function hash(buffer) { return crypto.createHash("sha1").update(buffer).digest("hex").slice(0, 8); }

function parseSet(source, setName) {
  const anchor = "window.GDIconAssets." + setName + " = {";
  const start = source.indexOf(anchor);
  if (start < 0) throw new Error("no " + setName + " object in the manifest");
  let depth = 0;
  let end = -1;
  for (let i = start + anchor.length - 1; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error("unterminated " + setName + " object");
  return JSON.parse(source.slice(start + anchor.length - 1, end));
}

/* Full-resolution bytes for a key: the kept original if we have one, else
   whatever the manifest currently points at (a data URI on the first run). */
function originalBytes(name, value) {
  const kept = fs.readdirSync(ORIGINAL_DIR).find((file) => file.replace(/\.[^.]+$/, "") === name);
  if (kept) return { ext: path.extname(kept).slice(1), bytes: fs.readFileSync(path.join(ORIGINAL_DIR, kept)), kept: true };
  const dataUri = /^data:image\/([a-z+]+);base64,(.*)$/.exec(value);
  if (dataUri) return { ext: dataUri[1] === "svg+xml" ? "svg" : dataUri[1], bytes: Buffer.from(dataUri[2], "base64"), kept: false };
  const filePath = path.join(ROOT, String(value).split("?")[0]);
  if (!fs.existsSync(filePath)) throw new Error("no original and no resolvable source for " + name);
  return { ext: path.extname(filePath).slice(1), bytes: fs.readFileSync(filePath), kept: false };
}

(async () => {
  const source = fs.readFileSync(MANIFEST, "utf8");
  fs.mkdirSync(ICON_DIR, { recursive: true });
  fs.mkdirSync(ORIGINAL_DIR, { recursive: true });

  /* Identical bytes under two keys share one file. `wand` is byte-identical in
     both sets, so it would otherwise ship twice. */
  const writtenByHash = new Map();
  const out = {};
  let before = 0;
  let after = 0;

  for (const [setName, prefix] of Object.entries(SETS)) {
    const set = parseSet(source, setName);
    out[setName] = {};
    for (const [key, value] of Object.entries(set)) {
      const name = prefix + key;
      const original = originalBytes(name, value);
      before += original.bytes.length;
      if (!original.kept) fs.writeFileSync(path.join(ORIGINAL_DIR, name + "." + original.ext), original.bytes);

      let bytes = original.bytes;
      let note = "svg";
      if (original.ext === "png") {
        const meta = await sharp(original.bytes).metadata();
        bytes = await sharp(original.bytes)
          .resize({ width: TARGET_PX, height: TARGET_PX, fit: "inside", withoutEnlargement: true })
          .png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
          .toBuffer();
        const result = await sharp(bytes).metadata();
        /* Full-colour with alpha, not quantised: these sit on dark gradients and
           a 256-colour palette bands the soft shadows in them. */
        if (result.channels !== 4) throw new Error(name + ": lost the alpha channel");
        if (Math.max(result.width, result.height) > TARGET_PX) throw new Error(name + ": downscale did not apply");
        note = meta.width + "x" + meta.height + " -> " + result.width + "x" + result.height;
      }

      const digest = hash(bytes);
      let relative = writtenByHash.get(digest);
      if (!relative) {
        const file = name + "." + original.ext;
        relative = path.posix.join("assets", "icons", file);
        fs.writeFileSync(path.join(ROOT, "assets", "icons", file), bytes);
        writtenByHash.set(digest, relative);
        after += bytes.length;
      }
      /* ?v= is the file's own content hash. /assets/* is cached for a week, so a
         replaced icon under an unchanged URL would stay stale in every browser
         that already has it. */
      out[setName][key] = relative + "?v=" + digest;
      console.log(
        "  " + (setName + "." + key).padEnd(22) +
        String(Math.round(original.bytes.length / 1024) + "KB").padStart(7) + " -> " +
        String(Math.round(bytes.length / 1024) + "KB").padStart(6) + "  " + note
      );
    }
  }

  const manifest = `/* GolfDaddy icon asset dictionaries.

   URLs, not data URIs. These were 4.46MB of inline base64 - the heaviest thing
   the phone app loaded, parsed as a JS string on every boot before anything was
   drawn. Every consumer only ever puts the value in an <img src>, so files cost
   nothing and let the webview cache and decode them lazily.

   \`icons\` = former ICONS (bag) set; \`gd66Icons\` = the rail/profile set.
   Images identical across both sets are written once and shared.

   GENERATED by dev/extract-icon-assets.js - do not hand-edit. The 512px sources
   are in dev/icon-originals/ (not deployed). To change an icon, replace its
   original and re-run the script; the ?v= is the file's content hash and
   dev/icon-assets.test.js fails if it goes stale. */
(function(){
  "use strict";
  window.GDIconAssets = window.GDIconAssets || {};
  window.GDIconAssets.icons = ${JSON.stringify(out.icons, null, 2).replace(/\n/g, "\n  ")};
  window.GDIconAssets.gd66Icons = ${JSON.stringify(out.gd66Icons, null, 2).replace(/\n/g, "\n  ")};
})();
`;
  fs.writeFileSync(MANIFEST, manifest);

  console.log(
    "\nicon payload: " + Math.round(before / 1024) + "KB of source image data -> " +
    Math.round(after / 1024) + "KB shipped in " + writtenByHash.size + " files"
  );
  console.log("manifest: " + Math.round(source.length / 1024) + "KB -> " + Math.round(manifest.length / 1024) + "KB");
})().catch((error) => { console.error("extract-icon-assets failed:", error && error.message); process.exit(1); });
