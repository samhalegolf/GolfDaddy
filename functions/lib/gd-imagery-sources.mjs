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

   That computation now lands in gd-relief-core.mjs, so the terrain-reference capture is
   planned wherever the DEM has a decode the pipeline speaks - tiled terrain-RGB fetched
   as-is, or arcgis float32 blocks transcoded to terrain-RGB at capture: the planner shoots
   elevation through the same grid it shoots imagery through, and the worker stores a
   terrain-RGB mosaic either way. See reliefSpec below for why that is still narrower than
   "wherever there is a DEM". */

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

/* Imagery and elevation are not always the same provider on the same terms, and pretending
   otherwise costs real coverage. Australia is the case that forced this: Queensland's imagery
   is ShareAlike, but the national elevation from Geoscience Australia is plain CC BY 4.0 - so
   one licence per entry would refuse the elevation for no reason other than the company the
   imagery keeps.

   So each spec may carry its own `license` and falls back to the entry's when it does not.
   The two are then gated separately: imagery that fails takes the entry down, elevation that
   fails simply does not ship, exactly as an unconfigured DEM already behaves. */
function licenseFor(entry, spec) {
  return (spec && spec.license) || (entry && entry.license) || null;
}

/* ---------- registry --------------------------------------------------------------------- */

/* One elevation source for all of Europe: Mapzen/Tilezen Terrain Tiles on AWS Open Data -
   keyless xyz PNG in the terrarium encoding gd-relief-core already decodes, so this rides the
   existing tiled path end to end (the capture normalises terrarium to terrain-RGB before
   storing, so the artefact on disk stays one format - see buildCapture).

   What it actually is over Europe: Copernicus EU-DEM at 25m as the base, with better national
   data patched in where Tilezen ingested it (Austria 10m, Norway 10m, parts of England 2m).
   That is an honest but COARSE answer - "this fairway rolls away left" renders; green-scale
   moulding does not - and it is the deliberate v1 trade: the national LiDAR that would match
   LINZ (AHN 0.5m, RGE ALTI 1m, MDT02 2m) ships as WCS/downloads in national projections,
   which is a new adapter plus reprojection nothing else needs yet. Carried per-spec so the
   licence is the DEM's own (public-domain/attribution mix, NOT the imagery entry's national
   licence) and so swapping in real LiDAR later means editing this one constant.

   z13 is ~13m/px at European golf latitudes - at or finer than the 10m patches, one step of
   honest upscale over the 25m base. Above it there is nothing left to fetch. */
const EU_TERRAIN_TILES_DEM = {
  adapter: "xyz",
  urlTemplate: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
  apiKeyEnv: "",
  encoding: "terrarium",
  nativeResolutionM: 10,
  fallbackResolutionM: 25,
  maxUsefulZoom: 13,
  license: {
    name: "Open (Mapzen Terrain Tiles: SRTM public domain, EU-DEM Copernicus attribution)",
    url: "https://github.com/tilezen/joerd/blob/master/docs/attribution.md",
    storage: true, derivatives: true, redistribution: true, commercial: true,
    attributionRequired: true
  }
};
const EU_TERRAIN_TILES_ATTRIBUTION = {
  /* The wording Copernicus itself asks for, plus the courtesy credits the joerd attribution
     doc lists for the patched-in sources. */
  text: "Elevation: Mapzen Terrain Tiles. Produced using Copernicus data and information funded by the European Union - EU-DEM layers; SRTM data courtesy of the U.S. Geological Survey",
  url: "https://github.com/tilezen/joerd/blob/master/docs/attribution.md",
  perSurvey: false
};

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
      apiKeyEnv: ["LINZ_BASEMAPS_API_KEY", "LINZ_BASEMAPS_PUBLIC_KEY"],
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
      apiKeyEnv: ["LINZ_BASEMAPS_API_KEY", "LINZ_BASEMAPS_PUBLIC_KEY"],
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
      perSurvey: true,
      perSurveyText: "Sourced from the LINZ Data Service and licensed by {licensor} for re-use under CC BY 4.0"
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
    /* Geoscience Australia's national elevation rather than Queensland's own, and carrying its
       OWN licence: ELVIS is plain CC BY 4.0 with no ShareAlike, so the elevation here is not
       infected by the imagery's copyleft and is gated separately. This is the entire point of
       per-spec licences - a state blocked on imagery can still ship plays-like. */
    dem: {
      adapter: "arcgis-export",
      endpoint: "https://services.ga.gov.au/gis/rest/services/DEM_LiDAR_5m/ImageServer/exportImage",
      apiKeyEnv: "",
      format: "tiff",
      encoding: "float32",
      license: {
        name: "CC BY 4.0",
        url: "https://www.ga.gov.au/scientific-topics/national-location-information/digital-elevation-data",
        storage: true, derivatives: true, redistribution: true, commercial: true,
        attributionRequired: true
      },
      /* PLACEHOLDER - ELVIS publishes 1m, 2m and 5m tiers and which one backs this service by
         region is exactly the sort of thing that must be read, not assumed. */
      nativeResolutionM: 5,
      fallbackResolutionM: 30,
      maxUsefulZoom: 15,
      blockPx: 2048
    },
    /* Credited to GA, not to Queensland - a different licensor under a different licence. */
    demAttribution: {
      text: "Elevation © Commonwealth of Australia (Geoscience Australia), CC BY 4.0",
      url: "https://www.ga.gov.au/scientific-topics/national-location-information/digital-elevation-data",
      perSurvey: false
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
  },
  {
    key: "nsw-au",
    label: "NSW Imagery (pinned ortho series)",
    /* DRAFT, and structurally different from every other entry: NSW is the source that cannot
       be trusted as a whole, only one named layer at a time.

       The public NSW_Imagery service is a mixed mosaic - LANDSAT satellite, 50cm standard
       ortho, 10cm town imagery, and captures by AAM, VEKTA and Jacobs - and its own metadata
       explicitly declines to give a blanket grant, stating each image series may carry
       different copyright permissions and that the user should check the constraints on each.
       A blanket grant is exactly what grantsStorageRights demands, so the service AS PUBLISHED
       is not addable.

       What is addable is one series at a time. `layerRequired` makes the pin mandatory: with
       no NSW_IMAGERY_LAYER set, resolveSpec returns null and this entry is as dead as an
       unlicensed one - the mixed mosaic is never the fallback, because there is no fallback.
       That is the same shape as LINZ_BASEMAPS_LAYER pinning a survey, but enforced rather than
       merely available, because here the unpinned default is the unsafe one.

       Read the licence block below as a claim about A CORRECTLY PINNED SERIES, not about the
       service. It is only true once someone has confirmed the specific series is Spatial
       Services' own CC BY ortho rather than a contributed capture - which is step 1 below, and
       why this is still draft. */
    draft: true,
    region: {
      /* Mainland NSW. Excludes Lord Howe Island, on the same reasoning as the Chathams and the
         Torres Strait. NOTE: the ACT is an enclave fully inside this bbox and is a separate
         jurisdiction with its own imagery - a Canberra course would match here and find no
         NSW coverage. Confirm before this leaves draft. */
      bbox: { south: -37.51, west: 141.0, north: -28.16, east: 153.65 },
      country: "AU"
    },
    license: {
      /* Service metadata cites CC BY 3.0; Spatial Services' general published-material
         statement is CC BY 4.0. Both grant all three rights. Which applies is per series. */
      name: "CC BY (per pinned series)",
      url: "https://www.spatial.nsw.gov.au/products_and_services/web_services",
      storage: true, derivatives: true, redistribution: true, commercial: true,
      attributionRequired: true
    },
    imagery: {
      /* MapServer, not ImageServer - hence the adapter added for this entry. */
      adapter: "arcgis-map-export",
      endpoint: "https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Imagery/MapServer/export",
      apiKeyEnv: "",
      /* No defaultLayer, deliberately. A default here would be the blend. */
      layerEnv: "NSW_IMAGERY_LAYER",
      layerRequired: true,
      /* PLACEHOLDER. 10cm town imagery would justify z20 and 50cm rural would not, so this
         cannot be set until the pinned series is known - it is per series, not per service. */
      maxUsefulZoom: 19,
      minTrustedZoom: 12,
      blockPx: 2048
    },
    /* Same national CC BY 4.0 elevation as Queensland, under its own licence. NSW imagery may
       stay blocked indefinitely on the per-series question while elevation is never in doubt. */
    dem: {
      adapter: "arcgis-export",
      endpoint: "https://services.ga.gov.au/gis/rest/services/DEM_LiDAR_5m/ImageServer/exportImage",
      apiKeyEnv: "",
      format: "tiff",
      encoding: "float32",
      license: {
        name: "CC BY 4.0",
        url: "https://www.ga.gov.au/scientific-topics/national-location-information/digital-elevation-data",
        storage: true, derivatives: true, redistribution: true, commercial: true,
        attributionRequired: true
      },
      nativeResolutionM: 5,
      fallbackResolutionM: 30,
      maxUsefulZoom: 15,
      blockPx: 2048
    },
    attribution: {
      /* Per series, like LINZ: CC BY names the licensor and the licensor is whoever captured
         the pinned survey, which is the whole reason the series must be named. */
      text: "© State of New South Wales (Spatial Services, DCS)",
      url: "https://www.spatial.nsw.gov.au/products_and_services/web_services",
      shortText: "© Spatial Services NSW CC BY",
      perSurvey: true,
      perSurveyText: "© State of New South Wales (Spatial Services, DCS), imagery captured by {licensor}, licensed CC BY"
    },
    demAttribution: {
      text: "Elevation © Commonwealth of Australia (Geoscience Australia), CC BY 4.0",
      url: "https://www.ga.gov.au/scientific-topics/national-location-information/digital-elevation-data",
      perSurvey: false
    }
    /* To take this out of draft:
         1. Identify one Spatial Services ortho series that is theirs, openly licensed, and
            covers courses worth having - then confirm in writing, via the Customer Hub, that
            storing and redistributing derivatives of THAT series is granted. The per-image
            disclaimer means nothing else counts as confirmation.
         2. Record its layer id and set NSW_IMAGERY_LAYER. Verify `export` returns only that
            layer and that `layers=show:<id>` is honoured - a MapServer that ignores the pin
            and draws the stack would silently store the blend.
         3. Set maxUsefulZoom from that series' ground sample, not the service's best.
         4. Resolve the ACT enclave - either confirm coverage or carve it out of the bbox.
         5. Confirm whether attributionFor needs a NSW-specific per-survey string; today its
            perSurvey branch is hardcoded to LINZ wording.
         6. Delete `draft: true`. */
  },

  /* ---------- Europe -----------------------------------------------------------------------

     Three national programmes whose imagery clears the storage/derivative/redistribution bar
     the way LINZ and NAIP do: the Netherlands (Beeldmateriaal via PDOK, CC BY 4.0), Spain
     (PNOA via IGN-E, CC BY 4.0), and France (IGN via the Geoplateforme, Licence Ouverte 2.0 -
     Etalab's open licence, attribution-only and explicitly commercial-reuse, the reason all
     three can exist here at all). The countries NOT here are absent for licensing, not
     oversight: the UK and Ireland publish no openly licensed national aerial imagery
     (Getmapping/APGB and OSi are both restricted), Germany is per-Land with no national grant,
     Italy is regional, and the Nordics outside Denmark are mixed - those courses run
     live-only, which is the truthful answer.

     Regions are BOXES, and western Europe does not partition into boxes. The entries are
     ordered most-specific-first (NL, then ES, then FR) and each comment names exactly which
     foreign ground its box swallows. A course that mis-matches fails LOUDLY: WMTS tiles
     outside a national mosaic 404 (or fall outside the layer's TileMatrixSetLimits), and
     buildCapture's all-or-nothing coverage check refuses the capture rather than baking
     blank frames. Polygon regions are the real fix if border-zone courses ever matter.

     Elevation: every entry shares EU_TERRAIN_TILES_DEM below - honest but coarse. The
     national LiDAR that would match LINZ quality (AHN 0.5m, RGE ALTI 1m, MDT02 2m) ships as
     WCS/download services in national projections, which is a new adapter plus reprojection;
     until that exists, 25m relief that says "this rolls away from you" beats no relief, and
     the DEM is gated per-spec so improving it later touches one constant. */
  {
    key: "pdok-nl",
    label: "Beeldmateriaal Nederland aerial (PDOK)",
    /* The Netherlands minus nothing - the box is naturally tight. It still swallows Flanders
       north of 50.74 and a strip of Germany east of the border; those courses 404 on the
       mosaic edge and are refused, not blank-baked. */
    region: { bbox: { south: 50.74, west: 3.35, north: 53.56, east: 7.23 }, country: "NL" },
    license: {
      name: "CC BY 4.0",
      /* "Deze luchtfotoservices zijn voor iedereen kosteloos en vrij beschikbaar voor alle
         toepassingen, onder hantering van het CC BY 4.0 gebruiksrecht" - PDOK's own wording,
         read 2026-08-19. Licensor is the Beeldmateriaal partnership (Het Waterschapshuis). */
      url: "https://www.pdok.nl/introductie/-/article/luchtfoto-pdok",
      storage: true, derivatives: true, redistribution: true, commercial: true,
      attributionRequired: true
    },
    imagery: {
      adapter: "xyz",
      /* RESTful WMTS read off the service's own capabilities, 2026-08-19: the EPSG:3857
         matrix set runs to level 21 and the path is {TileMatrix}/{TileCol}/{TileRow} - i.e.
         plain z/x/y. Actueel_orthoHR is the 8cm current-year national mosaic; the layer env
         exists to pin a vintage year (e.g. "2024_orthoHR") the way LINZ_BASEMAPS_LAYER pins
         a survey. */
      urlTemplate: "https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/{layer}/EPSG:3857/{z}/{x}/{y}.jpeg",
      layerEnv: "PDOK_LUCHTFOTO_LAYER",
      defaultLayer: "Actueel_orthoHR",
      apiKeyEnv: "",
      /* 8cm source. z20 is 0.091m/px at Dutch latitudes - just coarser than native - so z21
         (0.046m/px) is the first zoom at or finer than the mosaic, same rule as NAIP's z19.
         The frame ceiling almost always binds below this anyway. */
      maxUsefulZoom: 21,
      minTrustedZoom: 13
    },
    dem: { ...EU_TERRAIN_TILES_DEM },
    demAttribution: EU_TERRAIN_TILES_ATTRIBUTION,
    attribution: {
      text: "Luchtfoto © Beeldmateriaal Nederland, via PDOK, CC BY 4.0",
      url: "https://www.pdok.nl/introductie/-/article/luchtfoto-pdok",
      shortText: "© Beeldmateriaal Nederland CC BY 4.0",
      perSurvey: false
    }
  },
  {
    key: "pnoa-es",
    label: "PNOA orthophotos (IGN España)",
    /* Mainland Spain plus the Balearics, minus everything a box cannot keep out of Portugal:
       the west edge sits at -6.0 because Portugal's own border reaches -6.19, and that costs
       Galicia and the far west of Andalucía (Huelva). The north edge at 43.60 keeps the whole
       Cantabrian coast (Gijón 43.55, Santander 43.46) at the price of the French Basque coast
       below it - Biarritz (43.47) lands in this box, fails on empty PNOA coverage, and runs
       live-only until regions are polygons. The Canaries are a separate PNOA capture and a
       separate bbox if ever wanted. Ordered BEFORE france-fr so Catalonia and the Cantabrian
       coast resolve here rather than into France's wider box. */
    region: { bbox: { south: 36.0, west: -6.0, north: 43.6, east: 4.34 }, country: "ES" },
    license: {
      name: "CC BY 4.0",
      /* The service's own GetCapabilities AccessConstraints read "CC BY 4.0 scne.es",
         2026-08-19 - IGN-E moved its geographic services to attribution-only in 2015. The
         licensor to name is the Sistema Cartográfico Nacional (scne.es). */
      url: "https://www.scne.es/",
      storage: true, derivatives: true, redistribution: true, commercial: true,
      attributionRequired: true
    },
    imagery: {
      adapter: "xyz",
      /* KVP GetTile, which the xyz adapter speaks unchanged - it only substitutes {z}/{x}/{y}
         and a WMTS KVP URL is just a template with those in TILEMATRIX/TILECOL/TILEROW
         clothing. Layer, matrix set and formats read off the service's capabilities,
         2026-08-19: GoogleMapsCompatible to level 20, jpeg pre-generated to 19.

         OI.OrthoimageCoverage is "máxima actualidad": PNOA orthophoto at capture zooms,
         Sentinel-2 fill at LOW zooms only - which is what minTrustedZoom fences off, same
         reasoning as the LINZ satellite-fill note. 25cm source: z19 is 0.229m/px at Spanish
         latitudes, the first zoom at or finer than native. */
      urlTemplate: "https://www.ign.es/wmts/pnoa-ma?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&LAYER={layer}&STYLE=default&TILEMATRIXSET=GoogleMapsCompatible&FORMAT=image/jpeg&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}",
      layerEnv: "PNOA_WMTS_LAYER",
      defaultLayer: "OI.OrthoimageCoverage",
      apiKeyEnv: "",
      maxUsefulZoom: 19,
      minTrustedZoom: 13
    },
    dem: { ...EU_TERRAIN_TILES_DEM },
    demAttribution: EU_TERRAIN_TILES_ATTRIBUTION,
    attribution: {
      text: "PNOA orthophotography © Instituto Geográfico Nacional de España, CC BY 4.0 scne.es",
      url: "https://www.ign.es/",
      shortText: "PNOA © IGN España CC BY 4.0",
      perSurvey: false
    }
  },
  {
    key: "geopf-fr",
    label: "IGN France BD ORTHO (Géoplateforme)",
    /* Mainland France and Corsica. The box swallows southern Belgium, Luxembourg, western
       Switzerland and the Ligurian corner of Italy - all fail loudly on missing coverage -
       and its south edge reaches 41.3 for Corsica, which would also cover Catalonia were
       pnoa-es not ordered first. French Basque coast north of 43.60 (Hossegor and up)
       resolves here correctly; Biarritz itself is inside pnoa-es's box - see that entry. */
    region: { bbox: { south: 41.3, west: -5.15, north: 51.1, east: 9.57 }, country: "FR" },
    license: {
      /* Etalab's Licence Ouverte 2.0 - the French state open licence: free reuse, including
         commercial, including redistribution and derivatives, requiring attribution and the
         last-updated date. IGN moved ALL its public data (BD ORTHO included) under it on
         2021-01-01; the Géoplateforme WMTS serves those datasets keylessly. Deliberately
         recorded under its own name rather than "CC BY equivalent" - the licence itself
         declares CC BY 2.0 compatibility, but the obligation wording is Etalab's. */
      name: "Licence Ouverte 2.0 (Etalab)",
      url: "https://www.etalab.gouv.fr/licence-ouverte-open-licence/",
      storage: true, derivatives: true, redistribution: true, commercial: true,
      attributionRequired: true
    },
    imagery: {
      adapter: "xyz",
      /* KVP GetTile built VERBATIM from IGN's own capabilities annexe
         (data.geopf.fr/annexes/ressources/wmts/ortho.xml, read 2026-08-19): layer
         HR.ORTHOIMAGERY.ORTHOPHOTOS (the 20cm BD ORTHO), style "normal", matrix set
         "PM_6_19" (web-mercator, levels 6-19), image/jpeg.

         CAVEAT, deliberately loud: an automated proxy fetch of one tile answered 400, which
         is more likely the proxy re-encoding the query than the template - every field is
         quoted from the annexe - but "more likely" is not "verified". Open ONE tile URL in a
         browser before the first French scan; a wrong template fails a whole course loudly,
         never silently. */
      urlTemplate: "https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&LAYER={layer}&STYLE=normal&TILEMATRIXSET=PM_6_19&FORMAT=image/jpeg&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}",
      layerEnv: "GEOPF_ORTHO_LAYER",
      defaultLayer: "HR.ORTHOIMAGERY.ORTHOPHOTOS",
      apiKeyEnv: "",
      /* 20cm source, and the layer's matrix set also stops at 19: z19 is 0.20m/px at central
         French latitudes - exactly native, the ceiling twice over. */
      maxUsefulZoom: 19,
      minTrustedZoom: 13
    },
    dem: { ...EU_TERRAIN_TILES_DEM },
    demAttribution: EU_TERRAIN_TILES_ATTRIBUTION,
    attribution: {
      text: "Orthophotographie © IGN France, Licence Ouverte 2.0 (Etalab)",
      url: "https://www.ign.fr/geoplateforme",
      shortText: "© IGN France Licence Ouverte 2.0",
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

/* A key may be published under more than one name. LINZ is: the live map reads
   LINZ_BASEMAPS_PUBLIC_KEY or LINZ_BASEMAPS_API_KEY, and requiring only the
   second here meant rotating the key under the first name left the map working
   while every NZ capture failed as unconfigured - a split failure that looks
   fine from the app. Accepting both names removes the trap rather than
   documenting it. First name set wins; order is preference, not precedence. */
function envNames(spec) {
  if (!spec || !spec.apiKeyEnv) return [];
  return (Array.isArray(spec.apiKeyEnv) ? spec.apiKeyEnv : [spec.apiKeyEnv]).filter(Boolean);
}

function firstEnv(names, envs) {
  for (const name of names) {
    const value = env(name, envs);
    if (value) return value;
  }
  return "";
}

/* Fill {layer} and {key} from the environment. Returns null when a required key is absent -
   an unconfigured source is deliberately as unusable as an unlicensed one. */
function resolveSpec(spec, envs) {
  if (!spec) return null;
  const out = Object.assign({}, spec);
  const keyNames = envNames(out);
  const key = keyNames.length ? firstEnv(keyNames, envs) : "";
  if (keyNames.length && !key) return null;
  out.apiKey = key;
  const layer = (out.layerEnv && env(out.layerEnv, envs)) || out.defaultLayer || "";
  /* layerRequired is for a source whose default view is a blend we may not store. Without a
     named layer there is no safe thing to fall back TO, so absence is refusal rather than a
     default - see the NSW entry, where the unnamed view is the mixed mosaic. */
  if (out.layerRequired && !layer) return null;
  out.layer = layer;
  if (out.urlTemplate) {
    out.urlTemplate = out.urlTemplate.replace(/\{ *layer *\}/g, layer).replace(/\{ *key *\}/g, key);
  }
  return out;
}

/* Every environment variable an entry needs before it can be used, for the status endpoint to
   name. A required layer is as load-bearing as a key and is reported the same way. */
function missingConfig(spec, envs) {
  if (!spec) return [];
  const names = [];
  const keyNames = envNames(spec);
  /* Reported as one alternative rather than several missing things, so the
     status line reads as the single decision it is. */
  if (keyNames.length && !firstEnv(keyNames, envs)) names.push(keyNames.join(" or "));
  if (spec.layerRequired && !((spec.layerEnv && env(spec.layerEnv, envs)) || spec.defaultLayer)) {
    names.push(spec.layerEnv || "layer");
  }
  return names;
}

/* Resolve an entry's endpoints, or null when it cannot be used right now - which in practice
   means its imagery API key is not configured. The DEM is resolved on the same terms but is
   NOT required: a region with usable imagery and an unconfigured DEM still scans, and simply
   ships no elevation grid and no computed relief. */
export function resolveEndpoints(entry, envs) {
  if (!entry || !entry.imagery) return null;
  if (!grantsStorageRights(licenseFor(entry, entry.imagery))) return null;
  const imagery = resolveSpec(entry.imagery, envs);
  if (!imagery) return null;
  /* The DEM is gated on its own licence and dropped on its own, never taking imagery with it. */
  const demLicensed = entry.dem && grantsStorageRights(licenseFor(entry, entry.dem));
  const dem = demLicensed ? resolveSpec(entry.dem, envs) : null;
  return {
    key: entry.key, label: entry.label,
    license: licenseFor(entry, entry.imagery),
    demLicense: dem ? licenseFor(entry, entry.dem) : null,
    attribution: entry.attribution, imagery, dem,
    terrain: reliefSpec(dem)
  };
}

/* The relief source, which is the DEM wearing a different hat.

   The note at the top of this file rules out fetching a hillshade raster: relief is computed
   from elevation, so there is nothing to add to the table for it. What the capture planner
   needs is a spec it can grid and fetch tiles from, and the DEM already is one - the planner
   shoots terrain-RGB tiles exactly as it shoots imagery tiles, and the worker turns the
   mosaic into shading before it is stored. Hence: same spec, tagged so the fetcher knows the
   bytes are heights rather than a picture.

   Two shapes qualify. Tiled terrain-RGB (LINZ) is fetched and stored as-is. ArcGIS float32
   exports (US 3DEP, AU ELVIS) carry the same information as measurements rather than packed
   RGB, so they are tagged with their encoding and the capture path transcodes the floats to
   terrain-RGB before anything is stored (gd-relief-core's heightsFromFloat32Tiff /
   terrainRgbPngFromHeights) - the stored artefact is then identical in kind to a LINZ one and
   every consumer after the fetch is unchanged. Feeding float bytes to the terrain-RGB decoder
   directly would produce shading from noise, which is why the encoding tag travels on the
   spec instead of being sniffed later. Anything else - no DEM, or a shape without a decode -
   returns null: that region plans no relief capture and composites no relief, rather than
   shipping something wrong. */
function reliefSpec(dem) {
  if (!dem) return null;
  /* terrarium (the EU terrain tiles) qualifies alongside terrain-rgb because the decoder
     already speaks it - the capture normalises it to terrain-RGB before storage, so only the
     fetch leg ever sees the difference. */
  const tiled = dem.adapter === "xyz" && (dem.encoding === "terrain-rgb" || dem.encoding === "terrarium");
  const floatExport = dem.adapter === "arcgis-export" && dem.encoding === "float32";
  if (!tiled && !floatExport) return null;
  return { ...dem, role: "relief", computed: "hillshade-from-dem" };
}

/* The gate. Returns a usable, licensed source for these course bounds, or null.
   Null means "do not scan this course" - never "fall back to something else". */
export function resolveImagerySource(bounds, options = {}) {
  const table = Array.isArray(options.sources) ? options.sources : IMAGERY_SOURCES;
  for (const entry of table) {
    if (isDraft(entry)) continue;
    if (!grantsStorageRights(licenseFor(entry, entry && entry.imagery))) continue;
    if (!regionCovers(entry.region, bounds)) continue;
    const resolved = resolveEndpoints(entry, options.env);
    if (resolved) return resolved;
  }
  return null;
}

/* Elevation, asked for on its own.

   Plays-like distance is elevation arithmetic - it needs a DEM and does not care whether a
   single pixel of imagery was ever stored. Tying the two together meant a course whose imagery
   is unlicensed got no elevation either, which is a licensing answer applied to a question
   nobody asked. This resolves a DEM for bounds independently: same containment, same draft
   gate, same rights test, run against the dem spec's own licence.

   NOTE: nothing consumes this yet. The snapshot worker still enters through
   resolveImagerySource, so wiring elevation-only packages into the course build is follow-up
   work - this is the mechanism, not the feature. */
export function resolveElevationSource(bounds, options = {}) {
  const table = Array.isArray(options.sources) ? options.sources : IMAGERY_SOURCES;
  for (const entry of table) {
    if (isDraft(entry) || !entry.dem) continue;
    if (!grantsStorageRights(licenseFor(entry, entry.dem))) continue;
    if (!regionCovers(entry.region, bounds)) continue;
    const dem = resolveSpec(entry.dem, options.env);
    if (dem) return { key: entry.key, label: entry.label, license: licenseFor(entry, entry.dem), attribution: entry.demAttribution || entry.attribution, dem };
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
  const licensed = ready.filter(entry => grantsStorageRights(licenseFor(entry, entry.imagery)));
  if (!licensed.length) {
    /* "We may not store this at all" and "we may, but only by licensing our own course
       packages on the same terms" are different answers, and the second one is a decision
       somebody can still go and make. Reporting both as display-only would hide that. */
    if (ready.every(entry => (licenseFor(entry, entry.imagery) || {}).shareAlike === true)) {
      return "imagery covering this course is ShareAlike and storing it would license our course packages on the same terms";
    }
    return "imagery covering this course is display-only and may not be stored";
  }
  const missing = licensed.reduce((names, entry) => names.concat(missingConfig(entry.imagery, options.env)), []);
  return missing.length ? "imagery source is not configured (" + missing.join(", ") + ")" : "imagery source is unavailable";
}

/* Credit line for a capture. perSurvey sources fold in the licensor the worker read off the
   survey metadata; without one the generic statement stands. */
export function attributionFor(source, survey) {
  const base = source && source.attribution || {};
  const licensor = survey && (survey.licensor || survey.attribution) || "";
  /* The per-survey wording belongs to the source, not to this function. It used to be LINZ's
     sentence hardcoded here, which was harmless while LINZ was the only perSurvey entry and
     became a false credit the moment a second one existed - a NSW capture would have been
     announced as "Sourced from the LINZ Data Service". A perSurvey source with no wording of
     its own falls back to its generic statement rather than borrowing someone else's. */
  const template = String(base.perSurveyText || "");
  const text = base.perSurvey && licensor && template
    ? template.replace(/\{ *licensor *\}/g, licensor)
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

/* One export URL for a pixel-space block. Requested in 3857 at exactly the block's pixel size,
   so the returned image drops onto the capture canvas at (left, top) with no resampling.

   Two ArcGIS server types, one geometry. ImageServer exposes exportImage over a single raster
   dataset; MapServer exposes export over a stack of layers, takes no interpolation hint, and
   defaults to drawing EVERY layer in the stack. For a source whose stack blends imagery we may
   not store, drawing everything is precisely the wrong default, so arcgis-map-export always
   pins `layers=show:<id>` and refuses to build a URL without one. */
export function exportImageUrl(spec, rect, zoom) {
  const nw = pixelToMercator(rect.left, rect.top, zoom);
  const se = pixelToMercator(rect.left + rect.width, rect.top + rect.height, zoom);
  const mapExport = spec && spec.adapter === "arcgis-map-export";
  const params = new URLSearchParams({
    bbox: [nw.x, se.y, se.x, nw.y].join(","),
    bboxSR: "3857",
    imageSR: "3857",
    size: rect.width + "," + rect.height,
    /* Elevation is requested as tiff so it arrives as measurements rather than as a picture of
       measurements; imagery stays jpg. */
    format: String(spec && spec.format || "jpg"),
    f: "image"
  });
  if (mapExport) {
    const layer = String(spec.layer || "");
    if (!layer) throw new Error("arcgis-map-export requires a pinned layer: " + (spec.layerEnv || "layer") + " is not set");
    params.set("layers", "show:" + layer);
    params.set("transparent", "false");
  } else {
    params.set("interpolation", "RSP_BilinearInterpolation");
    /* Only where the entry pins one. An absent rule means "the service's raw default", which is
       what elevation wants - 3DEP's own function list is all hillshades and slope maps, and any
       of those would store a picture of the terrain instead of the terrain.

       Inside the else on purpose: renderingRule is an ImageServer concept. A MapServer export
       ignores it, so honouring one on that path would read as a pinned rendering while the
       server quietly drew whatever it liked - which is the same failure `layers=show:` exists
       to prevent. An arcgis-map-export entry pins its rendering by pinning its layer. */
    if (spec && spec.renderingRule) params.set("renderingRule", JSON.stringify(spec.renderingRule));
  }
  if (spec && spec.apiKey) params.set("token", spec.apiKey);
  return String(spec.endpoint) + "?" + params.toString();
}
