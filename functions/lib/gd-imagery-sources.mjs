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

   Two further gates, both of which refuse independently of the three rights above:
     SHARE_ALIKE_ACCEPTED - a ShareAlike licence grants all three rights and then demands the
                            same terms back on what we make, so it is a decision about our own
                            course packages rather than about their imagery. One flag, off.
     draft: true          - the entry's endpoints have not been checked against the provider's
                            published form. Kept in the table as research, refused as a source.

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

/* ShareAlike is the case the three booleans below cannot express, and it is not a rare one -
   most open government imagery outside NZ and the US carries it.

   CC BY-SA grants storage AND derivatives AND redistribution, so a ShareAlike source walks
   straight through a storage/derivatives/redistribution check with nothing to catch it. What
   it also does is require that what you make from it be licensed on the same terms - and what
   this pipeline makes is a baked course package shipped inside the app. So accepting ShareAlike
   is a decision about how OUR output is licensed, not about whether we may read theirs.

   That is a product call rather than a licensing fact, so it is one module-level flag rather
   than a per-entry one: flipping it is a single visible, reviewable act that enables every
   ShareAlike source at once, which is exactly what the decision actually means. Leaving it
   false costs only the courses those sources cover, which run live-only - a correct outcome. */
export const SHARE_ALIKE_ACCEPTED = false;

/* All three must be true for a source to be scannable, and ShareAlike must be accepted where
   the licence attaches it. "Credited = allowed" is NOT the rule; attribution is a condition
   some licenses attach, never a right it grants. */
function grantsStorageRights(license) {
  if (!license) return false;
  if (license.shareAlike === true && !SHARE_ALIKE_ACCEPTED) return false;
  return !!(license.storage === true && license.derivatives === true && license.redistribution === true);
}

/* An entry whose endpoints have not been confirmed against the provider's own published form.

   LINZ and NAIP were each checked against the provider's documentation before they were
   trusted, and a draft entry is one that has not had that done to it yet. It sits in the table
   because the research is worth keeping where the next person will find it, and it is refused
   like any other unusable source until someone verifies it and deletes the flag.

   This is a second gate rather than a comment because a wrong endpoint does not fail loudly:
   it fails as a whole course of missing tiles, hours into a scan. It is also independent of
   the licence gate - clearing SHARE_ALIKE_ACCEPTED must not silently promote an entry whose
   URLs nobody has ever opened. */
function isDraft(entry) {
  return !!(entry && entry.draft === true);
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
    region: { bbox: { south: 24.5, west: -125.0, north: 49.5, east: -66.9 }, country: "US" },
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
      /* Base NAIP is 0.6m. Requesting z19 here would upscale mush and cost the same, so the
         planner steps down to this before it counts tiles. */
      maxUsefulZoom: 17,
      minTrustedZoom: 12,
      /* exportImage caps request size; blocks are assembled by the same compositor as tiles. */
      blockPx: 2048
    },
    /* 3DEP, requested as raw float elevation rather than as a pre-shaded image - shading is
       computed downstream, and the same fetch feeds plays-like. 1m LiDAR where flown, 10m
       nationally, which is comfortably fit for relative elevation over a few hundred metres. */
    dem: {
      adapter: "arcgis-export",
      endpoint: "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage",
      apiKeyEnv: "",
      format: "tiff",
      encoding: "float32",
      nativeResolutionM: 1,
      maxUsefulZoom: 16,
      blockPx: 2048
    },
    attribution: {
      text: "Imagery courtesy of USDA NAIP / USGS The National Map",
      url: "https://www.usgs.gov/the-national-map-data-delivery",
      perSurvey: false
    }
  },
  {
    key: "qld-au",
    label: "Queensland imagery: latest state program",
    /* DRAFT - refused by isDraft, and refused again by the ShareAlike gate. Do not clear
       either flag without doing the work listed at the bottom of this entry.

       Australia has no NAIP and no LINZ. The only national mosaics are Sentinel-2 derived at
       10m, which at the z19-20 this pipeline captures at is the same visible smear the LINZ
       note warns about, so "AU" is not one entry - it is one entry per state, each with its
       own bbox, its own provider and its own licence. Queensland is first because its
       provenance is the cleanest of the states: a single state capture program rather than a
       mosaic of contributed third-party surveys.

       NSW was the obvious first choice on course count and was rejected. Its public imagery
       service is a mixed mosaic - LANDSAT, 50cm standard ortho, 10cm town imagery, plus
       captures by AAM, VEKTA and Jacobs - and its own metadata declines to give a blanket
       grant, saying each image series may carry different copyright permissions and the user
       should check the constraints on each. That is precisely the blanket grant
       grantsStorageRights exists to demand, so NSW cannot be added as a table row at all; it
       needs either written confirmation from Spatial Services or a single named ortho series
       pinned the way LINZ_BASEMAPS_LAYER can pin a survey. */
    draft: true,
    region: {
      /* Mainland Queensland only. Excludes the Torres Strait islands and the Coral Sea
         territories, on the same reasoning that excludes the Chathams from the LINZ entry:
         they are separate captures and this bbox is not the place to discover that. */
      bbox: { south: -29.2, west: 138.0, north: -10.7, east: 153.6 },
      country: "AU"
    },
    license: {
      name: "CC BY-SA",
      url: "https://www.data.qld.gov.au/dataset/queensland-imagery-latest-state-program-public-basemap-service",
      storage: true, derivatives: true, redistribution: true, commercial: true,
      attributionRequired: true,
      /* The whole reason this entry is here. Queensland releases state program imagery openly
         once it is three years or older, but under ShareAlike rather than plain CC BY - so
         every stored frame derived from it is arguably an adaptation that must itself be
         licensed CC BY-SA. See SHARE_ALIKE_ACCEPTED. */
      shareAlike: true
    },
    imagery: {
      /* ImageServer, so the arcgis-export adapter built for NAIP applies unchanged - no new
         adapter, no new geometry. (NSW, by contrast, publishes MapServer, whose export
         operation is spelled differently and would need an adapter variant.) */
      adapter: "arcgis-export",
      endpoint: "https://spatial-img.information.qld.gov.au/arcgis/rest/services/Basemaps/LatestStateProgram_AllUsers/ImageServer/exportImage",
      /* The _AllUsers service is the openly licensed one. There is an SISP-restricted sibling
         carrying newer imagery under subscription terms that grant none of this - do not
         substitute it because it looks like the same service with fresher pixels. */
      apiKeyEnv: "",
      /* PLACEHOLDER. Conservative until read off the service's own reported pixel size; the
         state program mixes resolutions by region and this must not be guessed upward. */
      maxUsefulZoom: 19,
      minTrustedZoom: 12,
      blockPx: 2048
    },
    /* Queensland's own DEM, chosen over Geoscience Australia's national ELVIS coverage only
       because an entry carries ONE licence covering both specs, and GA publishes under plain
       CC BY 4.0 rather than ShareAlike. That is the better DEM and the better licence, and
       taking it would mean giving imagery and dem their own licence blocks. Worth doing - it
       would also let a ShareAlike-blocked state still ship elevation - but it is a change to
       the model, not to this row, so it is not smuggled in here. */
    dem: {
      adapter: "arcgis-export",
      endpoint: "https://spatial-img.information.qld.gov.au/arcgis/rest/services/Elevation/QldDem/ImageServer/exportImage",
      apiKeyEnv: "",
      format: "tiff",
      encoding: "float32",
      /* PLACEHOLDER, as above - ELVIS publishes 1m, 2m and 5m tiers and which one backs this
         service by region is exactly the sort of thing that must be read, not assumed. */
      nativeResolutionM: 1,
      fallbackResolutionM: 5,
      maxUsefulZoom: 16,
      blockPx: 2048
    },
    attribution: {
      /* Wording is a placeholder: the Queensland department that owns this has been renamed
         more than once, and CC BY-SA requires the licensor be named correctly. */
      text: "© State of Queensland, licensed under CC BY-SA",
      url: "https://www.data.qld.gov.au/dataset/queensland-imagery-latest-state-program-public-basemap-service",
      shortText: "© State of Queensland CC BY-SA",
      perSurvey: false
    }
    /* To take this out of draft:
         1. Decide SHARE_ALIKE_ACCEPTED. If ShareAlike on baked course packages is not
            acceptable, delete this entry - no amount of endpoint checking rescues it, and
            the next candidates are the plain-CC-BY states (TAS, SA, WA are believed to be,
            and are themselves unverified).
         2. Open both ImageServer endpoints and confirm: they answer anonymously, exportImage
            is a supported operation, and the extent really covers the bbox above.
         3. Replace both PLACEHOLDER zoom/resolution values with the services' reported pixel
            sizes, the way NAIP's z17 ceiling comes from its 0.6m ground sample.
         4. Confirm the current legal name of the Queensland department for the credit line.
         5. Delete `draft: true`. */
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
    if (isDraft(entry)) continue;
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
  const ready = covering.filter(entry => !isDraft(entry));
  if (!ready.length) return "imagery covering this course is a draft entry with unverified endpoints";
  const licensed = ready.filter(entry => grantsStorageRights(entry.license));
  if (!licensed.length) {
    /* "We may not store this at all" and "we may, but only by licensing our own course
       packages on the same terms" are different answers, and the second one is a decision
       somebody can still go and make. Reporting both as display-only would hide that. */
    if (ready.every(entry => entry.license && entry.license.shareAlike === true)) {
      return "imagery covering this course is ShareAlike and storing it would license our course packages on the same terms";
    }
    return "imagery covering this course is display-only and may not be stored";
  }
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
  if (spec && spec.apiKey) params.set("token", spec.apiKey);
  return String(spec.endpoint) + "?" + params.toString();
}
