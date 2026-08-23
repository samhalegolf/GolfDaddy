/* Pull real published course data down for the green-slope preview.

   Reads only - it touches nothing in Supabase and writes only into ./data, which is
   gitignored. Run it, then run render-green-slope.mjs.

     node dev/green-slope-preview/fetch-green-data.mjs
     node dev/green-slope-preview/fetch-green-data.mjs --course=north-shore --holes=1,4,9

   For each hole it wants three things:
     h{n}.jpg.json        the frame sidecar - carries the green polygon and the elevation meta
     h{n}.elevation.png   terrain-RGB heights, cropped to the hole
     green-surround.jpg   the HD green capture, which is a far better base image than the
                          published hole frame (that frame is sized for a whole hole, so a
                          green lands in it about 80px across)
   Falling back down that last list rather than failing, so a hole with no green capture
   still previews off its frame. */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "data");
const BASE = "https://zcevluithwoumvafhmct.supabase.co/storage/v1/object/public/course-visuals";

const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const COURSE = arg("course", "jacks-point");
const HOLES = arg("holes", "1,6,13,18").split(",").map(n => parseInt(n, 10)).filter(Number.isFinite);

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

async function save(name, buf) {
  await writeFile(path.join(OUT, name), buf);
  return buf.length;
}

const kb = n => (n / 1024).toFixed(0) + "KB";

async function main() {
  await mkdir(OUT, { recursive: true });

  /* The course-level frames index names the live version directory. Reading it rather than
     hardcoding a version means this keeps working after the next export. */
  const indexRaw = await get(`${BASE}/${COURSE}/frames/index.json`);
  if (!indexRaw) throw new Error(`no frames index for ${COURSE} - is the course published?`);
  const framesIndex = JSON.parse(indexRaw.toString("utf8"));
  const version = framesIndex.exportVersion;
  await save("frames-index.json", indexRaw);
  console.log(`${COURSE}: export ${version}, ${framesIndex.holes.length} holes, source ${framesIndex.source?.key || "?"}`);

  /* Capture geometry: bounds/originPx/captureZoom per capture. The renderer needs it to place
     the green polygon on the HD capture's pixels. */
  const capturesRaw = await get(`${BASE}/${COURSE}/captures/index.json`);
  let captures = [];
  if (capturesRaw) {
    await save("captures-index.json", capturesRaw);
    captures = JSON.parse(capturesRaw.toString("utf8")).captures || [];
  }

  const greens = captures.filter(c => c.role === "green-surround");
  if (greens.length) {
    console.log("\ngreen-surround captures actually in storage:");
    console.log("  hole  zoom   size        (z20 would be ~0.15m/px at NZ latitudes)");
    greens.sort((a, b) => a.holeNumber - b.holeNumber).forEach(c => {
      console.log(`  h${String(c.holeNumber).padEnd(4)} z${c.captureZoom}   ${c.width}x${c.height}`);
    });
  }

  console.log("");
  for (const hole of HOLES) {
    const sidecar = await get(`${BASE}/${COURSE}/frames/${version}/h${hole}.jpg.json`);
    if (!sidecar) { console.log(`h${hole}: no frame sidecar, skipped`); continue; }
    await save(`h${hole}.meta.json`, sidecar);

    const meta = JSON.parse(sidecar.toString("utf8"));
    const elevPath = meta.playSurface?.elevation?.path;
    let elevBytes = 0;
    if (elevPath) {
      const elev = await get(`${BASE}/${elevPath}`);
      if (elev) elevBytes = await save(`h${hole}.elevation.png`, elev);
    }

    /* Best available base image, in descending order of sharpness. */
    const candidates = [
      { label: "green master", url: `${BASE}/${COURSE}/captures/${COURSE}/h${hole}/green-surround.jpg`, kind: "green-surround" },
      { label: "green 3072", url: `${BASE}/${COURSE}/captures/3072/${COURSE}/h${hole}/green-surround.jpg`, kind: "green-surround" },
      { label: "hole frame", url: `${BASE}/${COURSE}/frames/${version}/h${hole}.jpg`, kind: "frame" }
    ];
    let base = null;
    for (const c of candidates) {
      const buf = await get(c.url);
      if (buf) { base = { ...c, bytes: await save(`h${hole}.base.jpg`, buf) }; break; }
    }
    await writeFile(path.join(OUT, `h${hole}.base.json`), JSON.stringify({ kind: base?.kind || null, label: base?.label || null }));

    const green = captures.find(c => c.role === "green-surround" && Number(c.holeNumber) === hole);
    console.log(
      `h${String(hole).padEnd(3)} elevation ${elevBytes ? kb(elevBytes) : "MISSING"}` +
      `  base ${base ? base.label + " " + kb(base.bytes) : "MISSING"}` +
      (green ? `  (green capture z${green.captureZoom} ${green.width}x${green.height})` : "  (no green capture - corridor swallowed it)")
    );
  }

  console.log(`\nwritten to ${path.relative(process.cwd(), OUT)}`);
  console.log("next: node dev/green-slope-preview/render-green-slope.mjs");
}

main().catch(err => { console.error(String(err && err.message || err)); process.exit(1); });
