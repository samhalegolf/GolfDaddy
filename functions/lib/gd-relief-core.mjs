/* Shaded relief, computed from elevation rather than fetched as a picture.

   The design note in gd-imagery-sources.mjs settles the "where does relief come from"
   question: hillshade is a lighting computation over elevation, not a thing to download.
   One DEM fetch feeds both the elevation grid and the relief, under one licence, and the
   shading recipe stays ours instead of being whatever the provider's cartographer chose.
   This module is that computation.

   Input is a stitched terrain-RGB tile mosaic - the same bytes buildCapture already
   produces for any other capture, just fetched from the dem spec instead of the imagery
   spec. Output is a greyscale PNG, mid-grey where the ground is flat, that the export
   compositor lays over the aerial. Nothing here fetches, so the caller keeps its retry,
   cache and coverage rules and this stays testable on a buffer.

   Why the numbers are what they are. A golf hole is 300m of ground that moves maybe six
   metres. Shade that honestly and you get a flat green rectangle: true relief at true
   scale is invisible at the only scale a golfer looks at. So the surface is exaggerated
   before it is lit, which is a drawing decision, not a measurement - the relief says
   "this rolls away from you", never "this is 1.4 metres". Anything reading slope as a
   number must go to the elevation grid, not to these pixels. */

import sharp from "sharp";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* Terrain-RGB (Mapbox encoding, which is what LINZ serves behind pipeline=terrain-rgb):
     h = -10000 + (R*65536 + G*256 + B) * 0.1
   Terrarium (Mapzen) packs the same information differently and is included because it
   costs four lines and turns a silent wrong-answer into a caught one: a provider that
   quietly switches encoding would otherwise decode as noise that still looks like terrain.

   Both are tried and the one landing in a plausible range wins. "Plausible" is deliberately
   generous - it is a sanity gate against reading a rendered hillshade or an error page as
   elevation, not an assertion about any particular course. */
const ENCODINGS = {
  "terrain-rgb": (R, G, B) => -10000 + (R * 65536 + G * 256 + B) * 0.1,
  terrarium: (R, G, B) => R * 256 + G + B / 256 - 32768
};

/* Earth's land runs -430m (Dead Sea shore) to 8849m. A DEM tile covering a few hundred
   metres of golf course that claims 3km of relief is not elevation, it is a picture. */
function plausible(heights) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < heights.length; i++) {
    const v = heights[i];
    if (!Number.isFinite(v)) return null;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return { lo, hi, ok: lo > -500 && hi < 9000 && hi - lo < 3000 };
}

export function decodeElevation(raw, width, height, channels, declaredEncoding) {
  const names = declaredEncoding && ENCODINGS[declaredEncoding]
    ? [declaredEncoding, ...Object.keys(ENCODINGS).filter(n => n !== declaredEncoding)]
    : Object.keys(ENCODINGS);
  const attempts = [];
  for (const name of names) {
    const decode = ENCODINGS[name];
    const heights = new Float32Array(width * height);
    for (let i = 0, p = 0; i < heights.length; i++, p += channels) {
      heights[i] = decode(raw[p], raw[p + 1], raw[p + 2]);
    }
    const range = plausible(heights);
    if (range && range.ok) return { heights, encoding: name, min: range.lo, max: range.hi };
    attempts.push(name + " " + (range ? range.lo.toFixed(0) + ".." + range.hi.toFixed(0) + "m" : "non-finite"));
  }
  throw new Error("elevation decode failed - no encoding produced plausible ground: " + attempts.join(", "));
}

/* Separable Gaussian. Present because of a specific failure, not for general tidiness:
   terrain-RGB quantises height to 0.1m steps, and once the surface is exaggerated those
   steps become gradient discontinuities that light up as concentric contour rings. The
   result reads as a topographic map printed on the fairway. Blurring below the step size
   before differentiating is what stops that, so sigma is chosen against the upsample
   factor rather than tuned by eye - see reliefFromTerrainRgb. */
function blur(src, width, height, sigma) {
  if (!(sigma > 0)) return src;
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let total = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    total += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= total;

  const pass = new Float32Array(width * height);
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += src[row + clamp(x + k, 0, width - 1)] * kernel[k + radius];
      pass[row + x] = acc;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += pass[clamp(y + k, 0, height - 1) * width + x] * kernel[k + radius];
      out[y * width + x] = acc;
    }
  }
  return out;
}

/* Standard Horn hillshade. `multi` blends four lights instead of one: softer and more
   even, the way a printed relief map reads, at the cost of the crisp single-source
   moulding that makes a green look like it was pressed out of a sheet. Single light is
   the default because the latter is the point. */
export function hillshade(heights, width, height, metresPerPixel, options = {}) {
  const exaggeration = options.exaggeration > 0 ? options.exaggeration : 1;
  const azimuth = Number.isFinite(options.azimuth) ? options.azimuth : 315;
  const altitude = Number.isFinite(options.altitude) ? options.altitude : 42;
  const smoothed = blur(heights, width, height, options.smoothPx || 0);

  const zenith = ((90 - altitude) * Math.PI) / 180;
  const cosZenith = Math.cos(zenith);
  const sinZenith = Math.sin(zenith);
  const lights = options.multi
    ? [[azimuth - 45, 0.25], [azimuth, 0.35], [azimuth + 45, 0.25], [azimuth + 180, 0.15]]
    : [[azimuth, 1]];
  /* Compass bearing to the trigonometric angle the aspect is measured in. */
  const directions = lights.map(([deg, weight]) => [((360 - deg + 90) * Math.PI) / 180, weight]);

  const at = (x, y) => smoothed[clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)];
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dzdx = ((at(x + 1, y) - at(x - 1, y)) * exaggeration) / (2 * metresPerPixel);
      const dzdy = ((at(x, y + 1) - at(x, y - 1)) * exaggeration) / (2 * metresPerPixel);
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(dzdy, -dzdx);
      const sinSlope = Math.sin(slope);
      const cosSlope = Math.cos(slope);
      let lit = 0;
      for (const [angle, weight] of directions) {
        lit += weight * (cosZenith * cosSlope + sinZenith * sinSlope * Math.cos(angle - aspect));
      }
      out[y * width + x] = clamp(lit, 0, 1);
    }
  }
  return out;
}

/* Hollows read as dents rather than as grey patches when there is a little contact shadow
   in them. This is the cheap approximation: how far a point sits below its neighbourhood,
   normalised. Not real occlusion - no rays are cast - but at these slopes the difference
   is not visible and the real thing costs orders of magnitude more. */
export function ambientOcclusion(heights, width, height, exaggeration, radiusPx = 28) {
  const local = blur(heights, width, height, radiusPx / 3);
  const delta = new Float32Array(width * height);
  let mean = 0;
  for (let i = 0; i < delta.length; i++) {
    delta[i] = (heights[i] - local[i]) * exaggeration;
    mean += delta[i];
  }
  mean /= delta.length || 1;
  let variance = 0;
  for (let i = 0; i < delta.length; i++) variance += (delta[i] - mean) * (delta[i] - mean);
  const sd = Math.sqrt(variance / (delta.length || 1)) || 1;
  const out = new Float32Array(width * height);
  for (let i = 0; i < delta.length; i++) out[i] = clamp(0.5 + delta[i] / (4 * sd), 0, 1);
  return out;
}

/* Ground resolution of a web-mercator pixel. Latitude matters: the same zoom is ~0.6m/px
   at the equator and ~0.48m/px at Auckland, and feeding the wrong one in scales every
   gradient. */
export function metresPerPixel(latitude, zoom) {
  return (156543.03392804097 * Math.cos((latitude * Math.PI) / 180)) / Math.pow(2, zoom);
}

export const RELIEF_DEFAULTS = {
  /* Six metres over three hundred is what a golf hole actually does. Lit honestly that is
     a flat rectangle, so the surface is exaggerated to draw it. Below about 4x nothing is
     visible; above about 8x the DEM's own noise starts reading as ground and the fairway
     goes crunchy. Five sits where the landform reads and the noise does not. */
  exaggeration: 5,
  /* Light from the north-west. Cartographic convention, and not arbitrary: lit from below
     the eye inverts relief - hollows pop out as mounds - for most people looking at it. */
  azimuth: 315,
  altitude: 42,
  ambient: 0.18,
  multi: false
};

/**
 * Compute a relief raster from a stitched terrain-RGB mosaic.
 *
 * @param {Buffer} buffer      stitched DEM tiles, any format sharp reads
 * @param {object} geo         { latitude, zoom } of the mosaic - zoom is the DEM's own
 *                             capture zoom, not the export zoom
 * @param {object} [options]   overrides for RELIEF_DEFAULTS, plus:
 *                             encoding - declared encoding, tried first
 *                             outputWidth/outputHeight - resize the relief to the surface
 * @returns {Promise<{png: Buffer, width, height, encoding, elevation: {min, max},
 *                    metresPerPixel, exaggeration}>}
 */
export async function reliefFromTerrainRgb(buffer, geo = {}, options = {}) {
  const settings = { ...RELIEF_DEFAULTS, ...options };
  const image = sharp(buffer, { limitInputPixels: false });
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  if (!width || !height) throw new Error("relief source has no pixels");

  const decoded = decodeElevation(data, width, height, info.channels, options.encoding);
  const mpp = metresPerPixel(Number.isFinite(geo.latitude) ? geo.latitude : 0, geo.zoom || 16);

  /* The relief is drawn at the DEM's own resolution and resized afterwards rather than the
     DEM being upscaled first: gradients computed on interpolated heights are gradients of
     the interpolation, and the smoothing that hides the 0.1m quantisation would also have
     to grow to cover it. Shade at source, then scale the picture. */
  const outputWidth = options.outputWidth || width;
  const upsample = outputWidth / width;
  const smoothPx = Math.max(1, upsample > 1 ? 1.2 : 1.2 / upsample);

  const shade = hillshade(decoded.heights, width, height, mpp, { ...settings, smoothPx });
  if (settings.ambient > 0) {
    const ao = ambientOcclusion(decoded.heights, width, height, settings.exaggeration);
    for (let i = 0; i < shade.length; i++) shade[i] = shade[i] * (1 - settings.ambient) + ao[i] * settings.ambient;
  }

  const grey = Buffer.allocUnsafe(width * height);
  for (let i = 0; i < shade.length; i++) grey[i] = Math.round(shade[i] * 255);

  let out = sharp(grey, { raw: { width, height, channels: 1 }, limitInputPixels: false });
  if (options.outputWidth && options.outputHeight) {
    out = out.resize({ width: options.outputWidth, height: options.outputHeight, fit: "fill" });
  }
  const png = await out.png({ compressionLevel: 9 }).toBuffer();

  return {
    png,
    width: options.outputWidth || width,
    height: options.outputHeight || height,
    encoding: decoded.encoding,
    elevation: { min: decoded.min, max: decoded.max },
    metresPerPixel: mpp,
    exaggeration: settings.exaggeration
  };
}

/* Ground bearing from one point to another, degrees clockwise from north.
   Used to keep the light where the eye expects it - see reliefAzimuthForPlayAxis. */
export function bearingDeg(from, to) {
  if (!from || !to) return 0;
  const toRad = Math.PI / 180;
  const dLng = (to.lng - from.lng) * toRad;
  const lat1 = from.lat * toRad, lat2 = to.lat * toRad;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}

/* Where to put the sun so it lands upper-left ON SCREEN.

   Frames are baked north-up, and Play rotates them so the hole plays up the screen. A light
   fixed in world space therefore swings around the screen hole by hole: a hole playing north
   gets it from the upper left, a hole playing south from the lower right. That second case is
   not a cosmetic difference - light from below inverts perceived relief, so the greens on
   roughly half a course would read as craters. Shading is baked, so it cannot be recomputed
   per frame; the light has to be aimed per hole instead, offset by the play axis.

   Exact only for the stages that frame on the tee-green axis. The lock stage aims at the
   player's target, so the light drifts by however far the aim is off the hole's axis - a few
   degrees usually, and a wrong-by-degrees light still reads correctly where a wrong-by-180
   one does not. The real fix for the residue is a mesh, where nothing is baked at all. */
export function reliefAzimuthForPlayAxis(tee, green, baseAzimuth = RELIEF_DEFAULTS.azimuth) {
  return (baseAzimuth + bearingDeg(tee, green) + 360) % 360;
}

/* Cut a lat/lng window out of a north-up mercator raster.

   Web mercator is linear in longitude but not in latitude, so the vertical edges are found
   through the same projection the raster was built with rather than by proportion. Getting
   that wrong shifts the relief against the imagery by a few metres, which reads as the
   shading being "slightly off" rather than as a projection bug. */
export async function cropByBounds(buffer, sourceBounds, targetBounds, options = {}) {
  const mercY = lat => {
    const s = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  };
  const image = sharp(buffer, { limitInputPixels: false });
  const meta = await image.metadata();
  const W = meta.width, H = meta.height;
  if (!W || !H) throw new Error("crop source has no pixels");

  const spanX = (sourceBounds.east - sourceBounds.west) || 1e-12;
  const y0 = mercY(sourceBounds.north), y1 = mercY(sourceBounds.south);
  const spanY = (y1 - y0) || 1e-12;

  const pad = Number.isFinite(options.padPx) ? options.padPx : 2;
  const left = Math.floor((targetBounds.west - sourceBounds.west) / spanX * W) - pad;
  const right = Math.ceil((targetBounds.east - sourceBounds.west) / spanX * W) + pad;
  const top = Math.floor((mercY(targetBounds.north) - y0) / spanY * H) - pad;
  const bottom = Math.ceil((mercY(targetBounds.south) - y0) / spanY * H) + pad;

  const cl = Math.max(0, Math.min(W - 1, left));
  const ct = Math.max(0, Math.min(H - 1, top));
  const cw = Math.max(1, Math.min(W - cl, right - cl));
  const chh = Math.max(1, Math.min(H - ct, bottom - ct));

  /* A window that barely overlaps the source clamps down to a sliver, and a sliver stretched
     back across a hole is a smear the compositor would lay over the imagery as if it meant
     something. Refuse instead, and let the caller ship the hole unshaded. */
  const minPx = Number.isFinite(options.minPx) ? options.minPx : 16;
  if (cw < minPx || chh < minPx) {
    throw new Error("crop window overlaps the source by only " + cw + "x" + chh + "px (need " + minPx + ")");
  }

  /* The bounds returned describe the pixels actually cut, not the window asked for - the
     window is clamped to the source, and a consumer that placed the crop with the requested
     bounds would smear it across the difference. */
  const unmercY = t => {
    const n = Math.PI - 2 * Math.PI * t;
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  };
  return {
    buffer: await sharp(buffer, { limitInputPixels: false })
      .extract({ left: cl, top: ct, width: cw, height: chh }).png({ compressionLevel: 9 }).toBuffer(),
    width: cw, height: chh,
    bounds: {
      west: sourceBounds.west + (cl / W) * spanX,
      east: sourceBounds.west + ((cl + cw) / W) * spanX,
      north: unmercY(y0 + (ct / H) * spanY),
      south: unmercY(y0 + ((ct + chh) / H) * spanY)
    }
  };
}
