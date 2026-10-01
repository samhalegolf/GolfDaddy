/* The live terrain frame's geometry: one rectangle of web-mercator pixels, and the DEM resampled
   onto exactly that rectangle. Pure - no fetch, no sharp - so the alignment can be tested on its
   own (dev/live-terrain-frame.test.js).

   The window is the whole contract. The browser asks for z/x/y/w/h - an integer zoom and a
   pixel rectangle at it - and both the picture and the elevation are cut to that rectangle, so
   they cover the same ground by construction rather than by two bounds that happen to agree.
   The picture is fetched at z itself. The DEM is fetched at its own best zoom (coarser) and
   resampled onto a grid spanning the same rectangle, so pixel (0,0) of either image is the
   window's north-west corner and pixel (w,h) its south-east one. */

const TILE = 256;

/* Golf zooms only: below 14 a hole is a few hundred pixels, above 19 the window for a par 5 is
   past the limits below. */
export const LIVE_MIN_Z = 14;
export const LIVE_MAX_Z = 19;
/* The picture's size limit. 2048 matches the mesh's own canvas cap (painter MESH_MAX_PX), so
   nothing fetched is thrown away by the renderer. */
export const LIVE_MAX_SIDE = 2048;
export const LIVE_MAX_PIXELS = 2048 * 2048;
/* The DEM grid. The floor keeps the mesh's per-fragment normals smooth when the DEM is coarse
   (the global tiles are ~10-25m); the ceiling is where a phone's texture upload starts to show. */
export const DEM_MIN_SIDE = 256;
export const DEM_MAX_SIDE = 1024;

/* {z,x,y,w,h} from query parameters, or {error}. */
export function parseWindow(params) {
  const get = k => (params && typeof params.get === "function" ? params.get(k) : params && params[k]);
  /* Number(null) is 0, so a missing parameter has to be refused before it is converted. */
  const raw = ["z", "x", "y", "w", "h"].map(get);
  if (raw.some(v => v == null || String(v).trim() === "")) return { error: "z, x, y, w and h must be integers" };
  const [z, x, y, w, h] = raw.map(Number);
  if (![z, x, y, w, h].every(Number.isInteger)) return { error: "z, x, y, w and h must be integers" };
  if (z < LIVE_MIN_Z || z > LIVE_MAX_Z) return { error: "z must be " + LIVE_MIN_Z + "-" + LIVE_MAX_Z };
  if (w < 16 || h < 16 || w > LIVE_MAX_SIDE || h > LIVE_MAX_SIDE || w * h > LIVE_MAX_PIXELS) {
    return { error: "window must be 16-" + LIVE_MAX_SIDE + "px a side" };
  }
  const world = TILE * Math.pow(2, z);
  if (x < 0 || y < 0 || x + w > world || y + h > world) return { error: "window is off the map" };
  return { z, x, y, w, h };
}

function latAt(py, z) {
  const n = Math.PI * (1 - (2 * py) / (TILE * Math.pow(2, z)));
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}
function lngAt(px, z) {
  return (px / (TILE * Math.pow(2, z))) * 360 - 180;
}

export function windowBounds(win) {
  return {
    north: latAt(win.y, win.z), south: latAt(win.y + win.h, win.z),
    west: lngAt(win.x, win.z), east: lngAt(win.x + win.w, win.z)
  };
}

/* Ground metres across the window, at its middle latitude. */
export function windowMetres(win) {
  const b = windowBounds(win);
  const lat = (b.north + b.south) / 2;
  const mpp = (156543.03392804097 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, win.z);
  return { width: mpp * win.w, height: mpp * win.h, metresPerPixel: mpp };
}

/* Where to fetch the DEM and how big the resampled grid is.

   demZoom is the source's own best zoom, never finer than the window. The fetch rectangle is
   the window scaled to demZoom with a two-pixel margin, so the cubic resample below always has
   its neighbours. The grid keeps the window's aspect and is never larger than the picture. */
export function demPlan(win, maxUsefulZoom) {
  const demZoom = Math.min(win.z, Math.max(1, Number(maxUsefulZoom) || 17));
  const k = Math.pow(2, win.z - demZoom);
  const x0 = win.x / k, y0 = win.y / k, x1 = (win.x + win.w) / k, y1 = (win.y + win.h) / k;
  const left = Math.floor(x0) - 2, top = Math.floor(y0) - 2;
  const fetch = { left, top, width: Math.ceil(x1) + 2 - left, height: Math.ceil(y1) + 2 - top };
  const longNative = Math.max(win.w, win.h) / k;
  const longOut = Math.min(DEM_MAX_SIDE, Math.max(win.w, win.h), Math.max(DEM_MIN_SIDE, Math.ceil(longNative)));
  const scale = longOut / Math.max(win.w, win.h);
  const grid = { width: Math.max(2, Math.round(win.w * scale)), height: Math.max(2, Math.round(win.h * scale)) };
  return { demZoom, k, window: { x0, y0, x1, y1 }, fetch, grid };
}

/* Catmull-Rom weights: smooth (no facets in the mesh's lighting when the DEM is upsampled 8x)
   and exact at the samples, so a measured height is never moved. */
function cubicWeights(t) {
  const t2 = t * t, t3 = t2 * t;
  return [
    -0.5 * t3 + t2 - 0.5 * t,
    1.5 * t3 - 2.5 * t2 + 1,
    -1.5 * t3 + 2 * t2 + 0.5 * t,
    0.5 * t3 - 0.5 * t2
  ];
}

/* Heights of the fetched DEM rectangle -> heights on the plan's grid, covering exactly the
   window. Grid pixel (i, j)'s centre is the ground at window fraction ((i+.5)/W, (j+.5)/H). */
export function resampleToWindow(heights, srcW, srcH, plan) {
  const { window: wnd, fetch, grid } = plan;
  const out = new Float32Array(grid.width * grid.height);
  const at = (x, y) => heights[Math.min(srcH - 1, Math.max(0, y)) * srcW + Math.min(srcW - 1, Math.max(0, x))];
  const sx = (wnd.x1 - wnd.x0) / grid.width, sy = (wnd.y1 - wnd.y0) / grid.height;
  for (let j = 0; j < grid.height; j++) {
    /* DEM pixel centres sit at +0.5, hence the -0.5 into sample space. */
    const fy = wnd.y0 + (j + 0.5) * sy - fetch.top - 0.5;
    const y0 = Math.floor(fy), wy = cubicWeights(fy - y0);
    for (let i = 0; i < grid.width; i++) {
      const fx = wnd.x0 + (i + 0.5) * sx - fetch.left - 0.5;
      const x0 = Math.floor(fx), wx = cubicWeights(fx - x0);
      let v = 0;
      for (let m = 0; m < 4; m++) {
        const row = y0 - 1 + m;
        v += wy[m] * (wx[0] * at(x0 - 1, row) + wx[1] * at(x0, row) + wx[2] * at(x0 + 1, row) + wx[3] * at(x0 + 2, row));
      }
      out[j * grid.width + i] = v;
    }
  }
  return out;
}

export function heightRange(heights) {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < heights.length; i++) {
    const v = heights[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}
