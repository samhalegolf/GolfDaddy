#!/usr/bin/env node
/* Stage a file-based terrain source into Clarity storage - run ONCE per provider dataset.

     node scripts/terrain/stage-terrain-source.mjs --source osni-ni-dtm10 --version 2026-10 \
       --input ~/Downloads/osni-dtm [--out ./staged] [--upload] [--dry-run]

   --source   a clarity-staged entry in functions/lib/terrain/gd-terrain-sources.mjs
   --version  the dataset version to record (provenance) - e.g. the download date or the
              provider's release name. A new version is a new folder; nothing is overwritten.
   --input    a directory (searched recursively) or files: .zip (needs `unzip` on PATH),
              .txt / .asc / .xyz / .csv - ESRI ASCII grid or XYZ points, sniffed per file
   --out      also write the staged tiles to this local folder (default when not uploading)
   --upload   upload to the Supabase bucket named on the source (terrain-sources); needs
              SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment
   --dry-run  parse and validate only; report what would be staged

   What it checks before anything is written:
     - every file parses, and its spacing matches the registry's resolutionM
     - heights are plausible ground; NODATA and sentinels become nodata, never 0
     - every file lands inside the source's declared coverage once projected from its CRS
       (a file in the wrong CRS shows up here as ground in the wrong country)

   The tiles go up first and index.json last, so a bake can never read a half-staged copy.
   When it finishes it prints the one line to change in the registry: set datasetVersion. */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { sourceById } from "../../functions/lib/terrain/gd-terrain-sources.mjs";
import { toLngLat } from "../../functions/lib/terrain/gd-terrain-crs.mjs";
import { declaredCoverage } from "../../functions/lib/terrain/gd-terrain-resolver.mjs";
import { encodeStagedTile } from "../../functions/lib/terrain/gd-terrain-adapters.mjs";
import { parseElevationText, addToTiles, stagedIndex } from "../../functions/lib/terrain/gd-terrain-staging.mjs";
import { createSupabaseStorage } from "../../functions/lib/gd-supabase-storage.mjs";

function args(argv) {
  const out = { input: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") out.source = argv[++i];
    else if (a === "--version") out.version = argv[++i];
    else if (a === "--input") out.input.push(argv[++i]);
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--upload") out.upload = true;
    else if (a === "--dry-run") out.dryRun = true;
    else throw new Error("unknown argument " + a);
  }
  return out;
}

function collect(paths, tmp) {
  const files = [];
  const visit = p => {
    const st = fs.statSync(p);
    if (st.isDirectory()) { for (const name of fs.readdirSync(p)) visit(path.join(p, name)); return; }
    const ext = path.extname(p).toLowerCase();
    if (ext === ".zip") {
      const dest = fs.mkdtempSync(path.join(tmp, "zip-"));
      execFileSync("unzip", ["-q", "-o", p, "-d", dest]);
      visit(dest);
    } else if ([".txt", ".asc", ".xyz", ".csv"].includes(ext)) files.push(p);
  };
  paths.forEach(visit);
  return files.sort();
}

async function main() {
  const opt = args(process.argv);
  if (!opt.source || !opt.version || !opt.input.length) {
    console.error("usage: --source <id> --version <name> --input <dir|file> [--out dir] [--upload] [--dry-run]");
    process.exit(2);
  }
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(opt.version)) throw new Error("--version must be a short folder-safe name");
  const source = sourceById(opt.source);
  if (!source) throw new Error("no terrain source " + opt.source + " in the registry");
  if (source.sourceType !== "clarity-staged") throw new Error(source.id + " is " + source.sourceType + ", not a clarity-staged source");
  const tileSizeM = (source.staged && source.staged.tileSizeM) || 2000;
  const pixelSize = Number(source.resolutionM);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "terrain-stage-"));
  const files = collect(opt.input, tmp);
  if (!files.length) throw new Error("no elevation files found under " + opt.input.join(", "));
  console.log("staging " + source.id + "@" + opt.version + " from " + files.length + " file(s), " + tileSizeM + "m tiles at " + pixelSize + "m");

  const tiles = new Map();
  const report = [];
  let refused = 0;
  for (const file of files) {
    const grid = parseElevationText(fs.readFileSync(file, "utf8"));
    const name = path.basename(file);
    if (grid.error) { refused++; console.error("  REFUSED " + name + ": " + grid.error); continue; }
    const validFraction = grid.valid / (grid.width * grid.height);
    if (validFraction < 0.01) { refused++; console.error("  REFUSED " + name + ": " + (validFraction * 100).toFixed(1) + "% real ground"); continue; }
    /* CRS sanity: the file's centre, projected from the source's CRS, must be ground the source
       says it covers. */
    const cx = grid.originX + grid.width * grid.pixelSize / 2, cy = grid.originY - grid.height * grid.pixelSize / 2;
    const ll = toLngLat(source.horizontalCrs, cx, cy);
    const e = 1e-5;
    if (declaredCoverage(source, { north: ll.lat + e, south: ll.lat - e, west: ll.lng - e, east: ll.lng + e }) === "none") {
      refused++;
      console.error("  REFUSED " + name + ": centre projects to " + ll.lat.toFixed(4) + "," + ll.lng.toFixed(4) + ", outside " + source.name + " - wrong CRS?");
      continue;
    }
    try {
      const placed = addToTiles(tiles, grid, { tileSizeM, pixelSize });
      report.push({ file: name, kind: grid.kind, width: grid.width, height: grid.height, valid: grid.valid, placed });
      console.log("  ok " + name + " " + grid.kind + " " + grid.width + "x" + grid.height + " (" + (validFraction * 100).toFixed(1) + "% ground)");
    } catch (error) {
      refused++;
      console.error("  REFUSED " + name + ": " + error.message);
    }
  }
  const index = stagedIndex({ source, datasetVersion: opt.version, tiles, tileSizeM, pixelSize, files: report.map(r => r.file) });
  const tileKeys = Object.keys(index.tiles);
  console.log(tileKeys.length + " tile(s) to stage" + (refused ? ", " + refused + " file(s) refused" : ""));
  if (opt.dryRun || !tileKeys.length) { console.log(opt.dryRun ? "dry run - nothing written" : "nothing to stage"); return; }

  const prefix = source.id + "/" + opt.version + "/";
  const outDir = opt.out || (!opt.upload ? path.resolve("staged-terrain") : null);
  let storage = null;
  if (opt.upload) {
    const base = () => String(process.env.SUPABASE_URL || "");
    const key = () => String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
    if (!base() || !key()) throw new Error("--upload needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    storage = createSupabaseStorage({ base, key, bucket: (source.staged && source.staged.bucket) || "terrain-sources" });
  }
  let done = 0;
  const queue = tileKeys.slice();
  async function pump() {
    while (queue.length) {
      const key = queue.shift();
      const body = encodeStagedTile(tiles.get(key).heights);
      if (outDir) {
        const p = path.join(outDir, prefix, "tiles", key + ".f32.gz");
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, body);
      }
      if (storage) await storage.upload(prefix + "tiles/" + key + ".f32.gz", body, "application/gzip");
      if (++done % 100 === 0) console.log("  " + done + "/" + tileKeys.length + " tiles");
    }
  }
  await Promise.all(Array.from({ length: 6 }, pump));
  const indexBody = Buffer.from(JSON.stringify(index));
  if (outDir) fs.writeFileSync(path.join(outDir, prefix, "index.json"), indexBody);
  if (storage) await storage.upload(prefix + "index.json", indexBody, "application/json");
  console.log("\nstaged " + tileKeys.length + " tiles" + (outDir ? " to " + path.join(outDir, prefix) : "") + (storage ? " and uploaded" : ""));
  console.log("\nNext: in functions/lib/terrain/gd-terrain-sources.mjs set\n  datasetVersion: \"" + opt.version + "\"\non the " + source.id + " entry. Every course it covers then bakes from it on its next snapshot,\nor queue them now: POST /api/course-terrain {action:\"rebuild-source\", sourceId:\"" + source.id + "\"}.");
}

main().catch(error => { console.error(error && error.message || error); process.exit(1); });
