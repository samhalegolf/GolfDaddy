/* Imagery source registry - the licensing gate on every stored pixel.

   A snapshot does not "look at" imagery, it STORES a derivative of it and serves that
   derivative to players. That is a different right from displaying a tile, and most web
   imagery grants only the latter. The anonymous Esri World Imagery endpoints this pipeline
   started on grant neither - they are not licensed for commercial use at all - so they are
   gone from the scan path entirely.

   The rule this module enforces, in code rather than in a comment: the snapshot worker may
   only fetch imagery from an entry whose license grants storage AND derivatives AND
   redistribution. resolveImagerySource refuses anything else, so adding a display-only source
   to the table below cannot accidentally make it a scan source. No entry covering a course's
   bounds means no scan - that course runs live-only, indefinitely, which is a correct outcome
   and not a failure.

   Adapters:
     xyz            - slippy tiles, the existing fetch path
     arcgis-export  - ArcGIS ImageServer exportImage: one request per image block instead of
                      hundreds of tiles. Emitted as a block grid so the compositor that
                      assembles tiles assembles these unchanged.

   Each region carries `imagery` and `dem`, and NOT a hillshade source. Hillshade is a lighting
   computation over elevation, not a thing to fetch: one DEM fetch feeds both terrain shading
   in frames and the offline plays-like maths, so a separate hillshade raster would be a second
   download of the same information under a second licence. The DEM is also what the elevation
   grid shipped with each course package is resampled from.

   Until that computation lands, no hillshade raster exists for any region, so the tile-based
   terrain-reference capture is simply not planned. That costs nothing on the automatic route:
   the natural recipe - the only recipe it ever bakes - has terrain strength 0 and never
   composites relief at all. */

/* ---------- license predicate ------------------------------------------------------------ */

/* All three must be true for a source to be scannable. "Credited = allowed" is NOT the rule;
   attribution is a condition some licenses attach, never a right it grants. */
function grantsStorageRights(license) {
  return !!(license && license.storage === true && license.derivatives === true && license.redistribution === true);
}

/* ---------- registry --------------------------------------------------------------------- */

export const IMAGERY_SOURCES = [
  {
    key: "linz-nz",
    label: "LINZ Basemaps aerial",
    /* Mainland New Zealand. Deliberately excludes the Chathams, which straddle the
       antimeridian and would need bounds logic this test does not have. */
    region: { bbox: { south: -47.5, west: 166.0, north: -34.0, east: 179.0 }, country: "NZ" },
    license: {
      name: "CC BY 4.0",
      url: "https://www.linz.govt.nz/data/linz-data/linz-data-copyright",
      storage: true, derivatives: true, redistribution: true, commercial: true,
      /* CC BY names the licensor, and LINZ's licensor differs per aerial survey, so the
         statement is built per capture rather than being one fixed string. */
      attributionRequired: true
    },
    imagery: {
      adapter: "xyz",
      /* Verified against LINZ's own MapLibre example, 2026-07-28.

         The `aerial` tileset is a mosaic, and the licensing question is what else is in it.
         Checked against linz/basemaps-config: of its 137 layers, 124 are real aerial
         photography (Rural from z13, Urban from z14), and everything that is NOT open aerial is
         either capped below our capture zooms - GEBCO bathymetry and the 8m DEM shades all stop
         at z14 - or covers offshore islands (Chatham, Auckland, Antipodes, Bounty, Campbell,
         Kermadec, Snares). So a mainland course shot at z19-20 gets LINZ aerial photography,
         not the satellite fill.

         The one layer to keep an eye on is "New Zealand 10m Satellite Imagery", the uncapped
         national background. It only surfaces where no aerial survey exists, and at z19 a 10m
         source is a visible smear rather than a subtle substitution - but a course that lands
         on it must not be published. Set LINZ_BASEMAPS_LAYER to a specific survey if one ever
         does. */
      urlTemplate: "https://basemaps.linz.govt.nz/v1/tiles/{layer}/WebMercatorQuad/{z}/{x}/{y}.webp?api={key}",
      layerEnv: "LINZ_BASEMAPS_LAYER",
      defaultLayer: "aerial",
      apiKeyEnv: "LINZ_BASEMAPS_API_KEY",
      /* Urban surveys run 0.05-0.1m and rural 0.2-0.3m; z20 (~0.15m/px at NZ latitudes) is the
         last zoom carrying real detail for a rural course rather than resampled pixels. */
      maxUsefulZoom: 20,
      minTrustedZoom: 14
    },
    /* LINZ elevation - source of both the course elevation grid and the computed relief.

       The `pipeline=terrain-rgb` parameter is not optional: without it the tileset returns its
       own rendering rather than elevation packed into RGB, i.e. a picture of the terrain
       instead of the terrain. URL taken verbatim from LINZ's MapLibre elevation example. */
    dem: {
      adapter: "xyz",
      urlTemplate: "https://basemaps.linz.govt.nz/v1/tiles/{layer}/WebMercatorQuad/{z}/{x}/{y}.png?pipeline=terrain-rgb&api={key}",
      layerEnv: "LINZ_ELEVATION_LAYER",
      defaultLayer: "elevation",
      apiKeyEnv: "LINZ_BASEMAPS_API_KEY",
      encoding: "terrain-rgb",
      /* Two-tier, per linz/basemaps-config: an 8m national DEM with 1m LiDAR laid over most
         populated regions. Course-wide grids are fine on either; the fine green-surround grid
         only exists where the LiDAR does, which is what nativeResolutionM vs fallback records. */
      nativeResolutionM: 1,
      fallbackResolutionM: 8,
      /* z17 is ~0.95m/px at NZ latitudes - native for the 1m LiDAR. Higher only upscales. */
      maxUsefulZoom: 17
    },
    attribution: {
      text: "Sourced from the LINZ Data Service and licensed for re-use under CC BY 4.0",
      url: "https://www.linz.govt.nz/data/linz-data/linz-data-copyright",
      /* LINZ's own suggested short form, for places too small for the full statement. */
      shortText: "© LINZ CC BY 4.0 © Imagery Basemap contributors",
      /* Per-survey licensor, resolved at capture time where available, so the rendered credit
         reads "...licensed by <licensor> for re-use under CC BY 4.0". */
      perSurvey: true
    }
  },
  {
    key: "naip-us",
    label: "NAIP via USGS National Map",
    /* The ImageServer's OWN published extent, rounded inward, not a hand-drawn CONUS box.
       Read off .../USGSNAIPImagery/ImageServer?f=json on 2026-07-28: in 3857 it runs
       x -13896162.9..-7441890.6, y 2812730.7..6372359.7, i.e. -124.8314..-66.8516 by
       24.4859..49.5713. The old box claimed west to -125.0, which is 0.17 degrees of ocean the
       service has no rasters for - and because this bbox IS the containment gate, a course out
       there would have passed it and come back as empty blocks rather than as a refusal.
       Alaska, Hawaii and the territories are outside NAIP; those courses run live-only. */
    region: { bbox: { south: 24.49, west: -124.83, north: 49.57, east: -66.86 }, country: "US" },
    license: {
      name: "Public domain (USDA/USGS)",
      url: "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits",
      storage: true, derivatives: true, redistribution: true, commercial: true,
      /* No conditions attach. Credited anyway as good practice, not as compliance. */
      attributionRequired: false
    },
    imagery: {
      adapter: "arcgis-export",
      /* Pure NAIP, not NAIPPlus. Plus blends contributed state orthos down to ~15cm, and those
         contributions do not all carry the same terms - it may only be substituted once each
         contributing layer is confirmed unrestricted. */
      endpoint: "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage",
      apiKeyEnv: "",
      /* The mosaic is 4-band (R,G,B,NIR) and publishes FalseColorComposite and NDVI_Color
         alongside NaturalColor. With no renderingRule the server picks its own default, which
         today renders natural colour - verified byte-identical against an explicit
         NaturalColor request - but that is the server's choice, not ours, and these pixels are
         stored and served for years. Pin it, for the same reason the LINZ DEM pins
         pipeline=terrain-rgb: a stored derivative must not depend on a remote default. */
      renderingRule: { rasterFunction: "NaturalColor" },
      /* The service reports pixelSizeX 0.3m, NOT the 0.6m the source imagery is usually quoted
         at - the mosaic is served at 0.3. z19 is 0.24m/px at US latitudes, the first zoom at or
         finer than that; z20 is 0.12m/px and comes back as a smooth upscale for 2.6x the bytes.

         This was 17 (0.96m/px), which was not a saving but a defect: hole frames render at z18
         on the standard 3072px output, so EVERY stored US frame was being composited from
         imagery upscaled 2x linearly. The frame ceiling in captureGrid still binds first, so
         raising this does not shoot above what the compositor keeps - it just stops the source
         ceiling from silently landing below it. */
      maxUsefulZoom: 19,
      minTrustedZoom: 12,
      /* exportImage caps request size; blocks are assembled by the same compositor as tiles.
         The service's published cap is maxImageWidth/Height 4000 - 4001 is refused outright
         with "The requested image exceeds the size limit" - and 4000 would cut an 18-hole plan
         from 146 requests to 37. Not taken: a 4000px block is 48MB of decoded RGB, and at
         TILE_CONCURRENCY 16 that is 768MB in a 1024MB worker, which is the OOM this pipeline
         has already been bitten by once. 2048 is 12.6MB a block. Raise only alongside the
         concurrency. */
      blockPx: 2048
    },
    /* 3DEP, requested as raw float elevation rather than as a pre-shaded image - shading is
       computed downstream, and the same fetch feeds plays-like. 1m LiDAR where flown, 10m
       nationally, which is comfortably fit for relative elevation over a few hundred metres.

       Requesting raw is not the default here either: the service publishes Hillshade Gray,
       Hillshade Multidirectional, Slope and Contour raster functions, so leaving renderingRule
       unset is what gets measurements rather than a picture of them. Confirmed against a live
       block: 32-bit sampleFormat 3, sensible metres. */
    dem: {
      adapter: "arcgis-export",
      endpoint: "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage",
      apiKeyEnv: "",
      format: "tiff",
      encoding: "float32",
      nativeResolutionM: 1,
      fallbackResolutionM: 10,
      /* The service reports pixelSize 1.0m. z17 is ~0.96m/px at US latitudes - native - which
         is the same number and the same reasoning as the LINZ 1m LiDAR above. 16 was 1.92m/px,
         throwing away half the elevation detail the service actually holds. */
      maxUsefulZoom: 17,
      blockPx: 2048
    },
    attribution: {
      text: "Imagery courtesy of USDA NAIP / USGS The National Map",
      url: "https://www.usgs.gov/the-national-map-data-delivery",
      perSurvey: false
    }
  }
];

/* ---------- resolution -------------------------------------------------------------------- */

function validBounds(b) {
  return !!(b && [b.south, b.west, b.north, b.east].every(v => Number.isFinite(Number(v))));
}

/* Containment, not intersection. A course straddling a region edge would be scanned partly
   from a source that does not cover it, and the missing half would come back as tile failures
   or - worse - as another provider's fill. */
function regionCovers(region, bounds) {
  const box = region && region.bbox;
  if (!box || !validBounds(bounds)) return false;
  return Number(bounds.south) >= box.south && Number(bounds.north) <= box.north
    && Number(bounds.west) >= box.west && Number(bounds.east) <= box.east;
}

function env(name, envs) {
  const store = envs || (typeof process !== "undefined" && process.env) || {};
  return String(store[name] || "");
}

/* Fill {layer} and {key} from the environment. Returns null when a required key is absent -
   an unconfigured source is deliberately as unusable as an unlicensed one. */
function resolveSpec(spec, envs, { required }) {
  if (!spec) return null;
  const out = Object.assign({}, spec);
  const key = out.apiKeyEnv ? env(out.apiKeyEnv, envs) : "";
  if (out.apiKeyEnv && !key) return required ? null : null;
  out.apiKey = key;
  if (out.urlTemplate) {
    const layer = (out.layerEnv && env(out.layerEnv, envs)) || out.defaultLayer || "";
    out.urlTemplate = out.urlTemplate.replace(/\{ *layer *\}/g, layer).replace(/\{ *key *\}/g, key);
  }
  return out;
}

/* Resolve an entry's endpoints, or null when it cannot be used right now - which in practice
   means its imagery API key is not configured. The DEM is resolved on the same terms but is
   NOT required: a region with usable imagery and an unconfigured DEM still scans, and simply
   ships no elevation grid and no computed relief. */
export function resolveEndpoints(entry, envs) {
  if (!entry || !entry.imagery) return null;
  const imagery = resolveSpec(entry.imagery, envs, { required: true });
  if (!imagery) return null;
  const dem = resolveSpec(entry.dem, envs, { required: false });
  return { key: entry.key, label: entry.label, license: entry.license, attribution: entry.attribution, imagery, dem };
}

/* The gate. Returns a usable, licensed source for these course bounds, or null.
   Null means "do not scan this course" - never "fall back to something else". */
export function resolveImagerySource(bounds, options = {}) {
  const table = Array.isArray(options.sources) ? options.sources : IMAGERY_SOURCES;
  for (const entry of table) {
    if (!grantsStorageRights(entry && entry.license)) continue;
    if (!regionCovers(entry.region, bounds)) continue;
    const resolved = resolveEndpoints(entry, options.env);
    if (resolved) return resolved;
  }
  return null;
}

/* Why a course could not be scanned, in words a status endpoint can pass on. Separated from
   resolveImagerySource so the caller gets one answer and can ask for the reason only when it
   is null. */
export function unscannableReason(bounds, options = {}) {
  const table = Array.isArray(options.sources) ? options.sources : IMAGERY_SOURCES;
  if (!validBounds(bounds)) return "course bounds are unusable";
  const covering = table.filter(entry => regionCovers(entry.region, bounds));
  if (!covering.length) return "no licensed imagery source covers this course";
  const licensed = covering.filter(entry => grantsStorageRights(entry.license));
  if (!licensed.length) return "imagery covering this course is display-only and may not be stored";
  const missing = licensed.map(entry => entry.imagery && entry.imagery.apiKeyEnv).filter(Boolean);
  return missing.length ? "imagery source is not configured (" + missing.join(", ") + ")" : "imagery source is unavailable";
}

/* Credit line for a capture. perSurvey sources fold in the licensor the worker read off the
   survey metadata; without one the generic statement stands. */
export function attributionFor(source, survey) {
  const base = source && source.attribution || {};
  const licensor = survey && (survey.licensor || survey.attribution) || "";
  const text = base.perSurvey && licensor
    ? "Sourced from the LINZ Data Service and licensed by " + licensor + " for re-use under CC BY 4.0"
    : String(base.text || "");
  return { text, url: String(base.url || ""), sourceKey: source && source.key || "", license: source && source.license && source.license.name || "" };
}

/* ---------- adapter geometry -------------------------------------------------------------- */

const MERCATOR_HALF_M = 20037508.342789244;

/* Slippy pixel coordinate at a zoom -> EPSG:3857 metres. exportImage speaks bbox, the planner
   speaks pixels, and this is the only place the two meet. */
export function pixelToMercator(px, py, zoom) {
  const mpp = (MERCATOR_HALF_M * 2) / (256 * Math.pow(2, zoom));
  return { x: px * mpp - MERCATOR_HALF_M, y: MERCATOR_HALF_M - py * mpp };
}

/* One exportImage URL for a pixel-space block. Requested in 3857 at exactly the block's pixel
   size, so the returned image drops onto the capture canvas at (left, top) with no resampling. */
export function exportImageUrl(spec, rect, zoom) {
  const nw = pixelToMercator(rect.left, rect.top, zoom);
  const se = pixelToMercator(rect.left + rect.width, rect.top + rect.height, zoom);
  const params = new URLSearchParams({
    bbox: [nw.x, se.y, se.x, nw.y].join(","),
    bboxSR: "3857",
    imageSR: "3857",
    size: rect.width + "," + rect.height,
    /* Elevation is requested as tiff so it arrives as measurements rather than as a picture of
       measurements; imagery stays jpg. */
    format: String(spec && spec.format || "jpg"),
    interpolation: "RSP_BilinearInterpolation",
    f: "image"
  });
  /* Only where the entry pins one. An absent rule means "the service's raw default", which is
     what elevation wants - 3DEP's own function list is all hillshades and slope maps, and any
     of those would store a picture of the terrain instead of the terrain. */
  if (spec && spec.renderingRule) params.set("renderingRule", JSON.stringify(spec.renderingRule));
  if (spec && spec.apiKey) params.set("token", spec.apiKey);
  return String(spec.endpoint) + "?" + params.toString();
}
