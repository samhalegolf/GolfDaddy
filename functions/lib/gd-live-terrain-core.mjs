/* The live terrain frame's geometry: one rectangle of web-mercator pixels, and the DEM resampled
   onto exactly that rectangle. Pure - no fetch, no sharp - so the alignment can be tested on its
   own (dev/live-terrain-frame.test.js).

   The window is the whole contract. The browser asks for z/x/y/w/h - an integer zoom and a
   pixel rectangle at it - and both the picture and the elevation are cut to that rectangle, so
   they cover the same ground by construction rather than by two bounds that happen to agree.
   The picture is fetched at z itself. The elevation is cut from the course's baked terrain
   asset (or, outside one, from the terrain resolver's best source) and resampled onto a grid
   spanning the same rectangle, so pixel (0,0) of either image is the window's north-west corner
   and pixel (w,h) its south-east one. */

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

/* The DEM grid for a window: the window's own rectangle at its own zoom, sampled more coarsely.
   About a metre a sample (finer would only upsample a DEM), never below DEM_MIN_SIDE on the
   long side (smooth per-fragment normals) or above DEM_MAX_SIDE or the picture itself. The
   aspect is the window's, so pixel (0,0) of the picture and of the grid are the same corner.

   The result is a target grid in gd-terrain-normalise's shape, so the course asset or any
   terrain source is resampled onto exactly the window by the same code the bake uses. */
export function demGrid(win) {
  const metres = windowMetres(win);
  const longPx = Math.max(win.w, win.h);
  const longM = longPx * metres.metresPerPixel;
  const longOut = Math.min(DEM_MAX_SIDE, longPx, Math.max(DEM_MIN_SIDE, Math.ceil(longM / 1.0)));
  const scale = longOut / longPx;
  const width = Math.max(2, Math.round(win.w * scale)), height = Math.max(2, Math.round(win.h * scale));
  return { zoom: win.z, originPx: { x: win.x, y: win.y }, width, height, stepX: win.w / width, stepY: win.h / height };
}
