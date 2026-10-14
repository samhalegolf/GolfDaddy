/* Tree heights round a course, for Studio's tree finder (map-overlay-shapes.js heightMask).
 *
 * Source: Meta / WRI global canopy height v2 - about 1.2m a cell, whole metres as uint8, as
 * Cloud-Optimised GeoTIFFs on Source Cooperative, one per quadkey tile. Licence CC BY 4.0, so
 * Studio credits it wherever the heights are used. Only the course's window of a tile is read
 * (HTTP range requests through geotiff.js), never the whole file.
 *
 * Two things about the data shape how it is used. Its imagery is 2009-2020, older than our
 * aerials, so a height is a gate on what the colour pass found, not a replacement for it. And
 * 0 means both "no tree" and "no data" - Studio reads a window of nothing but 0 as no data.
 *
 * The tile path is CANOPY_TILE_URL below. It was read off the dataset's README and could not
 * be tried from where this was written; if it turns out different, tiles.parquet in the same
 * bucket lists every tile's cog_url, and CANOPY_TILE_URL_TEMPLATE overrides it without a code
 * change. */

const CANOPY_TILE_URL = "https://data.source.coop/tge-labs/meta-chm-v2/chm/{quadkey}.tif";
const CANOPY_QUADKEY_ZOOM = 10;
/* A course's capture is a few hundred metres a side; this is room for a whole course and keeps
   the answer to a couple of megabytes. */
export const CANOPY_MAX_SIDE_CELLS = 2500;
export const CANOPY_CREDIT = "Tree heights: Meta & World Resources Institute, CC BY 4.0";

const R = 6378137;

export function canopyTileUrl(quadkey) {
  return String(process.env.CANOPY_TILE_URL_TEMPLATE || CANOPY_TILE_URL).replace("{quadkey}", quadkey);
}

/* The Web Mercator tile a point is in, as a Bing-style quadkey. */
export function quadkeyAt(lat, lng, z) {
  const n = Math.pow(2, z);
  const s = Math.sin(Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180);
  const x = Math.min(n - 1, Math.max(0, Math.floor((lng + 180) / 360 * n)));
  const y = Math.min(n - 1, Math.max(0, Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n)));
  let key = "";
  for (let i = z; i > 0; i--) {
    const bit = 1 << (i - 1);
    key += String((x & bit ? 1 : 0) + (y & bit ? 2 : 0));
  }
  return key;
}

/* The tiles a box touches - one, or up to four where it straddles a tile edge. */
export function quadkeysFor(bounds, z = CANOPY_QUADKEY_ZOOM) {
  const keys = new Set();
  [[bounds.north, bounds.west], [bounds.north, bounds.east], [bounds.south, bounds.west], [bounds.south, bounds.east]]
    .forEach(([lat, lng]) => keys.add(quadkeyAt(lat, lng, z)));
  return Array.from(keys);
}

function mercator(lat, lng) {
  return { x: lng * Math.PI / 180 * R, y: Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * R };
}

/* The crs a tile is in, from its geokeys: Web Mercator or plain lat/lng, or null for anything
   else (the answer would not line up with the capture). */
function crsOf(image) {
  const keys = (typeof image.getGeoKeys === "function" ? image.getGeoKeys() : image.geoKeys) || {};
  const projected = Number(keys.ProjectedCSTypeGeoKey);
  if (projected === 3857 || projected === 3785 || projected === 900913) return "EPSG:3857";
  if (!projected && Number(keys.GeographicTypeGeoKey) === 4326) return "EPSG:4326";
  return null;
}

/* The box's window of one tile, as a grid Studio's heightMask reads: its crs, top-left corner,
   cell size, size and heights (nodata read as 0). Null when the box misses the tile. */
export async function readTileWindow(tiff, bounds) {
  const image = await tiff.getImage();
  const crs = crsOf(image);
  if (!crs) throw new Error("unexpected projection");
  const [ox, oy] = image.getOrigin();
  const [rx, ry] = image.getResolution();
  const nw = crs === "EPSG:3857" ? mercator(bounds.north, bounds.west) : { x: bounds.west, y: bounds.north };
  const se = crs === "EPSG:3857" ? mercator(bounds.south, bounds.east) : { x: bounds.east, y: bounds.south };
  const w = image.getWidth(), h = image.getHeight();
  const x0 = Math.max(0, Math.floor((nw.x - ox) / rx)), x1 = Math.min(w, Math.ceil((se.x - ox) / rx));
  const y0 = Math.max(0, Math.floor((nw.y - oy) / ry)), y1 = Math.min(h, Math.ceil((se.y - oy) / ry));
  if (!(x1 > x0 && y1 > y0)) return null;
  if (x1 - x0 > CANOPY_MAX_SIDE_CELLS || y1 - y0 > CANOPY_MAX_SIDE_CELLS) throw new Error("area too large");
  const raster = await image.readRasters({ window: [x0, y0, x1, y1], samples: [0], interleave: true });
  const heights = new Uint8Array(raster.length);
  const nodata = typeof image.getGDALNoData === "function" ? image.getGDALNoData() : null;
  for (let i = 0; i < raster.length; i++) {
    const v = raster[i];
    heights[i] = v === nodata || !(v > 0) ? 0 : Math.min(254, Math.round(v));
  }
  return { crs, x0: ox + x0 * rx, y0: oy + y0 * ry, dx: rx, dy: ry, width: x1 - x0, height: y1 - y0, heights };
}

/* Every tile's window for a box. openTiff(url) resolves to a geotiff.js GeoTIFF - injected so
   tests never touch the network. A tile that cannot be read is listed in `missing` with why;
   the rest still answer. */
export async function readCanopy(bounds, { openTiff }) {
  const grids = [], missing = [];
  for (const quadkey of quadkeysFor(bounds)) {
    try {
      const grid = await readTileWindow(await openTiff(canopyTileUrl(quadkey)), bounds);
      if (grid) grids.push(Object.assign({ quadkey }, grid));
    } catch (error) {
      missing.push({ quadkey, reason: String(error && error.message || error).slice(0, 200) });
    }
  }
  return { grids, missing };
}
