/* Fetching the DEM (and imagery) for a window of web-mercator pixels, shared by the two
   endpoints that shade on demand: relief-preview (one hole, for tuning in Studio) and
   relief-tile (the live map's hillshade layer). Both shade with gd-relief-core; this is the
   fetch leg only, so the two cannot drift on how a window is assembled. */

import sharp from "sharp";
import { heightsFromFloat32Tiff, terrainRgbPngFromHeights } from "./gd-relief-core.mjs";
import { exportImageUrl } from "./gd-imagery-sources.mjs";

const TILE = 256;
const TILE_CONCURRENCY = 12;
const TILE_TIMEOUT_MS = 10000;

/* ---- tiles ----
   A simpler fetcher than the worker's on purpose. The worker refuses a capture with any
   missing tile, because a stored master with a hole in it is a permanent artefact; a preview
   is transient, so a missing edge tile draws dark and the picture is still useful. Different
   requirement, not a duplicated one. The live relief tiles (relief-tile.mjs) ask for
   requireAll instead: a missing DEM tile inside one of those is a cliff along its edge. */
async function fetchTile(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TILE_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function tileUrl(spec, z, x, y) {
  return spec.urlTemplate
    .replace(/\{ *z *\}/g, z).replace(/\{ *x *\}/g, x).replace(/\{ *y *\}/g, y);
}

export async function mosaic(spec, zoom, originPx, size, options = {}) {
  /* arcgis-export sources (US) answer the whole preview window in ONE exportImage request -
     a preview is at most 1536px against the service's 4000px cap, so there is no grid to
     assemble. A float32 elevation answer is transcoded to terrain-RGB here, exactly as the
     capture path does, so everything downstream of mosaic() stays one format. */
  if (spec.adapter === "arcgis-export") {
    const buf = await fetchTile(exportImageUrl(spec, { left: originPx.x, top: originPx.y, width: size, height: size }, zoom));
    if (!buf) return null;
    if (spec.encoding !== "float32") return buf;
    const { heights, width, height } = await heightsFromFloat32Tiff(buf);
    return terrainRgbPngFromHeights(heights, width, height);
  }
  const tx0 = Math.floor(originPx.x / TILE), ty0 = Math.floor(originPx.y / TILE);
  const tx1 = Math.floor((originPx.x + size - 1) / TILE), ty1 = Math.floor((originPx.y + size - 1) / TILE);
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push({ tx, ty });

  const placed = new Array(jobs.length).fill(null);
  let cursor = 0;
  async function pump() {
    while (cursor < jobs.length) {
      const i = cursor++;
      const { tx, ty } = jobs[i];
      const buf = await fetchTile(tileUrl(spec, zoom, tx, ty));
      if (buf) placed[i] = { input: buf, left: (tx - tx0) * TILE, top: (ty - ty0) * TILE };
    }
  }
  await Promise.all(Array.from({ length: Math.min(TILE_CONCURRENCY, jobs.length) }, pump));
  const layers = placed.filter(Boolean);
  if (!layers.length || (options.requireAll && layers.length < jobs.length)) return null;

  const sheet = await sharp({
    create: { width: (tx1 - tx0 + 1) * TILE, height: (ty1 - ty0 + 1) * TILE, channels: 3, background: { r: 16, g: 19, b: 15 } },
    limitInputPixels: false
  }).composite(layers).png().toBuffer();

  return sharp(sheet, { limitInputPixels: false }).extract({
    left: Math.round(originPx.x - tx0 * TILE),
    top: Math.round(originPx.y - ty0 * TILE),
    width: size, height: size
  }).png().toBuffer();
}
