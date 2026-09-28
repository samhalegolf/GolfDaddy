/* Temporary, georeferenced pictures of a course for the Claude mapper-debug Routine.
 *
 * A Routine fire carries text only, so the pictures go to the public course-visuals
 * bucket and the fire carries their URLs plus the bounds that make a pixel a place.
 * Two captures, same grid: the satellite view (Esri World Imagery, the same source the
 * app's live map draws) and the OpenStreetMap render, so Claude can see what OSM is
 * missing against what the ground shows and draw the greens and fairways itself.
 *
 * Temporary means it: everything lands under mapper-debug/<date>/<job id>/ and the
 * mapper sweeper deletes date folders older than RETENTION_DAYS. Nothing here is
 * course data and nothing reads it back.
 *
 * Injected fetch/upload/sharp so the grid maths and the purge are testable without a
 * network, in keeping with the rest of lib/. Best-effort by contract: a capture that
 * fails reports {reason} and the hand-off still goes out. */

export const CAPTURE_ZOOM = 16;
export const TILE_PX = 256;
export const GRID_TILES = 4;
export const RETENTION_DAYS = 7;
export const CAPTURE_FOLDER = "mapper-debug";
export const SATELLITE_ATTRIBUTION = "Esri World Imagery";
export const OSM_ATTRIBUTION = "(c) OpenStreetMap contributors, ODbL";

const SATELLITE_TILE = "https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token={key}";
const OSM_TILE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_USER_AGENT = "ClarityCaddyMapperDebug/1 (one-off course capture for a failed mapping job; contact samhalegolf@gmail.com)";

const DEG = Math.PI / 180;

function tileX(lng, zoom) { return (Number(lng) + 180) / 360 * Math.pow(2, zoom); }
function tileY(lat, zoom) {
  const rad = Number(lat) * DEG;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, zoom);
}
function tileLng(x, zoom) { return x / Math.pow(2, zoom) * 360 - 180; }
function tileLat(y, zoom) {
  const n = Math.PI - 2 * Math.PI * y / Math.pow(2, zoom);
  return Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))) / DEG;
}

/* A GRID_TILES x GRID_TILES block of web-mercator tiles centred on the point. Whole
   tiles, so the image is exactly what the tile servers hand back and the bounds are
   exact tile edges rather than a crop nobody can reproduce. */
export function captureGridFor(centre, options = {}) {
  const zoom = Number(options.zoom) || CAPTURE_ZOOM;
  const tiles = Number(options.tiles) || GRID_TILES;
  const lat = Number(centre && centre.lat);
  const lng = Number(centre && centre.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 85 || Math.abs(lng) > 180) return null;
  const x0 = Math.round(tileX(lng, zoom) - tiles / 2);
  const y0 = Math.round(tileY(lat, zoom) - tiles / 2);
  const list = [];
  for (let row = 0; row < tiles; row++) {
    for (let col = 0; col < tiles; col++) list.push({ x: x0 + col, y: y0 + row, col, row });
  }
  return {
    zoom, tiles: list,
    width: tiles * TILE_PX, height: tiles * TILE_PX,
    bounds: { west: tileLng(x0, zoom), east: tileLng(x0 + tiles, zoom), north: tileLat(y0, zoom), south: tileLat(y0 + tiles, zoom) }
  };
}

/* The rule the payload text states, in code, so a test can prove the words are right. */
export function pixelToLatLng(grid, px, py) {
  const b = grid.bounds;
  const m = lat => Math.log(Math.tan(Math.PI / 4 + lat * DEG / 2));
  const top = m(b.north), bottom = m(b.south);
  const lng = b.west + (px / grid.width) * (b.east - b.west);
  const lat = (2 * Math.atan(Math.exp(top - (py / grid.height) * (top - bottom))) - Math.PI / 2) / DEG;
  return { lat, lng };
}

export function satelliteTileUrl(tile, zoom, key) {
  return SATELLITE_TILE.replace("{z}", zoom).replace("{y}", tile.y).replace("{x}", tile.x).replace("{key}", encodeURIComponent(key));
}
export function osmTileUrl(tile, zoom) {
  return OSM_TILE.replace("{z}", zoom).replace("{x}", tile.x).replace("{y}", tile.y);
}

/* One PNG from the grid's tiles. fetchTile(url, headers) -> Buffer, throws on failure;
   a single missing tile fails the capture, because a black square where a green was
   is worse than no picture. */
export async function composeTiles(grid, urlFor, fetchTile, sharp, headers) {
  const buffers = await Promise.all(grid.tiles.map(tile => fetchTile(urlFor(tile), headers)));
  return sharp({ create: { width: grid.width, height: grid.height, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite(grid.tiles.map((tile, index) => ({ input: buffers[index], left: tile.col * TILE_PX, top: tile.row * TILE_PX })))
    .png()
    .toBuffer();
}

export function captureFolder(jobId, now) {
  const date = new Date(now || Date.now()).toISOString().slice(0, 10);
  return CAPTURE_FOLDER + "/" + date + "/" + String(jobId || "job").replace(/[^a-zA-Z0-9_-]+/g, "-");
}

/* deps: { fetchTile(url, headers) -> Buffer, upload(path, buffer, contentType) -> path,
   publicUrl(path) -> string, sharp, esriKey, now } */
export async function captureMapperDebugImagery({ centre, jobId }, deps) {
  const grid = captureGridFor(centre);
  if (!grid) return { reason: "no-centre" };
  const folder = captureFolder(jobId, deps.now);
  const out = { zoom: grid.zoom, width: grid.width, height: grid.height, bounds: grid.bounds, folder, capturedAt: new Date(deps.now || Date.now()).toISOString() };
  const one = async (name, urlFor, headers, attribution) => {
    try {
      const png = await composeTiles(grid, urlFor, deps.fetchTile, deps.sharp, headers);
      const path = folder + "/" + name + ".png";
      await deps.upload(path, png, "image/png");
      return { url: deps.publicUrl(path), path, attribution };
    } catch (error) {
      return { reason: String(error && error.message || error).slice(0, 160) };
    }
  };
  out.satellite = deps.esriKey
    ? await one("satellite", tile => satelliteTileUrl(tile, grid.zoom, deps.esriKey), {}, SATELLITE_ATTRIBUTION)
    : { reason: "no-esri-key: set ARCGIS_API_KEY" };
  out.osm = await one("osm", tile => osmTileUrl(tile, grid.zoom), { "User-Agent": OSM_USER_AGENT }, OSM_ATTRIBUTION);
  return out;
}

/* Delete date folders older than RETENTION_DAYS. list(prefix) -> [{name, id}] as the
   Storage list API returns them (a folder has id null); remove(paths) deletes files. */
export async function purgeMapperDebugCaptures(deps, options = {}) {
  const days = Number(options.days) || RETENTION_DAYS;
  const cutoff = new Date((options.now || Date.now()) - days * 86400000).toISOString().slice(0, 10);
  const dates = (await deps.list(CAPTURE_FOLDER + "/"))
    .map(entry => String(entry && entry.name || ""))
    .filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name) && name < cutoff);
  const removed = [];
  for (const date of dates) {
    const jobs = await deps.list(CAPTURE_FOLDER + "/" + date + "/");
    for (const job of jobs) {
      const files = await deps.list(CAPTURE_FOLDER + "/" + date + "/" + job.name + "/");
      const paths = files.filter(file => file && file.id).map(file => CAPTURE_FOLDER + "/" + date + "/" + job.name + "/" + file.name);
      if (paths.length) { await deps.remove(paths); removed.push(...paths); }
    }
  }
  return { cutoff, dates, removed };
}
