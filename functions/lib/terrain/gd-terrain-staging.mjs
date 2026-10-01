/* Staging a file-based elevation provider into Clarity storage - the pure half.

   Some approved sources publish no service at all, only files (OSNI's 10m DTM: zipped TXT
   sheets in Irish Grid). Those are staged ONCE - parsed, validated, re-tiled into fixed squares
   in the provider's own CRS - and every course bake then reads only the few tiles under it
   (gd-terrain-adapters.mjs clarity-staged). scripts/terrain/stage-terrain-source.mjs is the
   CLI around this; everything here is pure so the parsing rules are tested on strings.

   Readers (sniffed per file, never guessed from the extension):
     ESRI ASCII grid - "ncols / nrows / xllcorner|xllcenter / yllcorner|yllcenter / cellsize /
                       NODATA_value" header, then rows north to south
     XYZ points      - one "x y z" per line (space, tab, comma or semicolon separated), any
                       order, a regular lattice; non-numeric header lines are skipped
   Both land in the same parsed grid: pixel-is-area, origin at the north-west CORNER.

   Nodata is never ground: NODATA_value, the common sentinels and anything outside plausible
   Earth heights become NaN, and a file that is mostly NaN is reported, not staged. */

const PLAUSIBLE = v => Number.isFinite(v) && v > -500 && v < 9000;
const SENTINELS = new Set([-9999, -99999, -32768, -3.4028234663852886e38, 3.4028234663852886e38]);

function clean(v, nodata) {
  if (!Number.isFinite(v)) return NaN;
  if (nodata != null && Math.abs(v - nodata) < 1e-6) return NaN;
  if (SENTINELS.has(v)) return NaN;
  return PLAUSIBLE(v) ? v : NaN;
}

/* -> { kind, width, height, originX, originY, pixelSize, heights, valid } or { error } */
export function parseElevationText(text) {
  const head = text.slice(0, 2000).toLowerCase();
  if (/^\s*ncols\s/m.test(head)) return parseAsciiGrid(text);
  return parseXyz(text);
}

export function parseAsciiGrid(text) {
  const lines = text.split(/\r?\n/);
  const header = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const m = /^\s*([a-z_]+)\s+(-?[\d.eE+-]+)\s*$/i.exec(lines[i]);
    if (!m) break;
    header[m[1].toLowerCase()] = Number(m[2]);
  }
  const width = header.ncols, height = header.nrows, cell = header.cellsize;
  if (!(width > 0 && height > 0 && cell > 0)) return { error: "ASCII grid header is missing ncols/nrows/cellsize" };
  const xll = "xllcorner" in header ? header.xllcorner : "xllcenter" in header ? header.xllcenter - cell / 2 : NaN;
  const yll = "yllcorner" in header ? header.yllcorner : "yllcenter" in header ? header.yllcenter - cell / 2 : NaN;
  if (!Number.isFinite(xll) || !Number.isFinite(yll)) return { error: "ASCII grid header is missing its lower-left corner" };
  const nodata = "nodata_value" in header ? header.nodata_value : null;
  const heights = new Float32Array(width * height).fill(NaN);
  let n = 0, valid = 0;
  for (; i < lines.length && n < width * height; i++) {
    const parts = lines[i].trim().split(/\s+/);
    if (parts.length === 1 && parts[0] === "") continue;
    for (const p of parts) {
      if (n >= width * height) break;
      const v = clean(Number(p), nodata);
      heights[n++] = v;
      if (Number.isFinite(v)) valid++;
    }
  }
  if (n < width * height) return { error: "ASCII grid has " + n + " values, header promises " + width * height };
  return { kind: "ascii-grid", width, height, originX: xll, originY: yll + height * cell, pixelSize: cell, heights, valid };
}

export function parseXyz(text) {
  const xs = [], ys = [], zs = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/[\s,;]+/);
    if (parts.length < 3) continue;
    const x = Number(parts[0]), y = Number(parts[1]), z = Number(parts[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;   // a header line
    xs.push(x); ys.push(y); zs.push(z);
  }
  if (xs.length < 4) return { error: "no x y z rows found" };
  const step = arr => {
    const u = [...new Set(arr)].sort((a, b) => a - b);
    let s = Infinity;
    for (let k = 1; k < u.length; k++) { const d = u[k] - u[k - 1]; if (d > 1e-6 && d < s) s = d; }
    return { step: s, min: u[0], max: u[u.length - 1] };
  };
  const sx = step(xs), sy = step(ys);
  if (!Number.isFinite(sx.step) || !Number.isFinite(sy.step)) return { error: "XYZ points do not form a lattice" };
  if (Math.abs(sx.step - sy.step) > 1e-6 * Math.max(sx.step, sy.step)) return { error: "XYZ lattice is not square (" + sx.step + " x " + sy.step + ")" };
  const cell = sx.step;
  const width = Math.round((sx.max - sx.min) / cell) + 1, height = Math.round((sy.max - sy.min) / cell) + 1;
  if (width * height > 50e6) return { error: "XYZ lattice is implausibly large (" + width + "x" + height + ")" };
  const heights = new Float32Array(width * height).fill(NaN);
  let valid = 0;
  for (let k = 0; k < xs.length; k++) {
    const col = Math.round((xs[k] - sx.min) / cell), row = Math.round((sy.max - ys[k]) / cell);
    const v = clean(zs[k], null);
    if (Number.isFinite(v) && !Number.isFinite(heights[row * width + col])) valid++;
    heights[row * width + col] = v;
  }
  /* Points are sample centres: the corner is half a cell out. */
  return { kind: "xyz", width, height, originX: sx.min - cell / 2, originY: sy.max + cell / 2, pixelSize: cell, heights, valid };
}

/* Retile one parsed grid into fixed tiles on the global lattice (tile edges at multiples of
   tileSizeM, pixels at multiples of pixelSize), merging into `tiles` (Map key -> tile). A
   later file fills only what an earlier one left empty, so overlapping sheet edges are
   idempotent. */
export function addToTiles(tiles, grid, { tileSizeM, pixelSize }) {
  if (Math.abs(grid.pixelSize - pixelSize) > 1e-6 * pixelSize) {
    throw new Error("file spacing " + grid.pixelSize + " does not match the source's " + pixelSize);
  }
  const per = Math.round(tileSizeM / pixelSize);
  if (Math.abs(per * pixelSize - tileSizeM) > 1e-6) throw new Error("tileSizeM must be a whole number of pixels");
  /* Global pixel indices of the grid's first column/row (pixel centres on the lattice). */
  const gx0 = Math.round(grid.originX / pixelSize), gy0 = Math.round(grid.originY / pixelSize);
  let placed = 0;
  for (let j = 0; j < grid.height; j++) {
    const gy = gy0 - j - 1;               // global row index counting up from y=0 (pixel's south edge / pixelSize)
    const row = Math.floor(gy / per);
    const inRow = per - 1 - (gy - row * per);   // tiles are stored north-to-south
    for (let i = 0; i < grid.width; i++) {
      const v = grid.heights[j * grid.width + i];
      if (!Number.isFinite(v)) continue;
      const gx = gx0 + i;
      const col = Math.floor(gx / per);
      const inCol = gx - col * per;
      const key = col + "_" + row;
      let tile = tiles.get(key);
      if (!tile) {
        tile = { key, col, row, width: per, height: per, originX: col * tileSizeM, originY: (row + 1) * tileSizeM, heights: new Float32Array(per * per).fill(NaN), valid: 0 };
        tiles.set(key, tile);
      }
      const k = inRow * per + inCol;
      if (!Number.isFinite(tile.heights[k])) { tile.heights[k] = v; tile.valid++; placed++; }
    }
  }
  return placed;
}

/* The staged index. Written last, so a half-finished upload is never read. */
export function stagedIndex({ source, datasetVersion, tiles, tileSizeM, pixelSize, files }) {
  const out = {};
  for (const t of tiles.values()) {
    if (!t.valid) continue;
    out[t.key] = { path: "tiles/" + t.key + ".f32.gz", width: t.width, height: t.height, originX: t.originX, originY: t.originY, valid: t.valid };
  }
  return {
    formatVersion: 1,
    sourceId: source.id,
    datasetVersion,
    crs: source.horizontalCrs,
    verticalDatum: source.verticalDatum || null,
    resolutionM: pixelSize,
    pixelSize,
    tileSizeM,
    stagedAt: new Date().toISOString(),
    files: files || [],
    tiles: out
  };
}
