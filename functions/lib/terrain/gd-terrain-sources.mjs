/* Terrain Source Registry - every elevation source Clarity may use automatically.

   An entry here is an APPROVAL: someone has checked the licence, the endpoint and the
   resolution, and from then on every course the source covers can use it with no further
   work. Nothing here is discovered at runtime and nothing outside this table is ever fetched
   by a bake. A region with no entry runs on the global source and shows up in the admin
   terrain report as an upgrade opportunity (see gd-terrain-resolver.mjs).

   Elevation used to ride along as a `dem` field on each IMAGERY entry
   (gd-imagery-sources.mjs). That tied a course's terrain to whether its imagery was licensed,
   which is a licensing answer applied to a question nobody asked - a Northern Ireland course
   has no storable imagery and so had no baked terrain at all, while OSNI publishes an open 10m
   DTM. Terrain now has its own table, its own licence gate and its own resolver.

   Shape of an entry:
     id, name                - stable key (stored in provenance - never rename) and label
     regions                 - ISO 3166 country codes (or region tags like "GB-NIR") it serves,
                               used for the upgrade report; coverage decides actual use
     coverage                - { type: "global" } | { type: "region", bboxes: [...] }
                               | { type: "polygon", rings: [[[lng, lat], ...]] }
     sourceType              - which adapter reads it (gd-terrain-adapters.mjs):
                               "xyz-elevation" | "arcgis-image-server" | "clarity-staged"
                               (geotiff / cog / wcs / las-laz / arcgis-map-server are reserved
                               names: an entry using one is refused until its adapter exists)
     resolutionM             - the best real sample spacing the source has
     fallbackResolutionM     - the worst it falls back to inside its coverage (LINZ: 1m LiDAR
                               over an 8m national DEM). Equal to resolutionM when uniform.
     horizontalCrs           - the CRS the adapter receives samples in
     verticalDatum           - heights are relative to this; sources on different datums are
                               never blended (see gd-terrain-normalise.mjs)
     licence                 - storage/derivatives/redistribution must all be true
     attribution             - the credit line a baked asset carries
     priority                - tie-break between otherwise equal candidates (higher wins)
     qualityClass            - ceiling on what the source can be: global|regional|high-resolution|lidar
     enabled                 - false keeps the entry as research, refused as a source
     datasetVersion          - provider dataset/version recorded in provenance; for
                               clarity-staged sources this also names WHICH staged copy is read,
                               and null means "not staged yet"

   Adapter-specific fields (urlTemplate, endpoint, encoding, maxUsefulZoom, apiKeyEnv, layerEnv,
   defaultLayer, blockPx, staged) are read only by that adapter. */

const OPEN_GOV = (name, url) => ({
  name, url, storage: true, derivatives: true, redistribution: true, commercial: true, attributionRequired: true
});

/* The global fallback. Mapzen/Tilezen Terrain Tiles on AWS Open Data - keyless terrarium PNG.
   Copernicus EU-DEM 25m over Europe, SRTM ~30m elsewhere, with better national data patched in
   where Tilezen ingested it (Austria/Norway 10m, parts of England 2m). Honest but coarse: a
   fairway's roll renders, a green's moulding does not. z13 is ~13m/px at European golf
   latitudes; above it there is nothing left to fetch. */
export const GLOBAL_TERRAIN_SOURCE_ID = "global-terrain-tiles";

export const TERRAIN_SOURCES = Object.freeze([
  {
    id: "linz-nz-elevation",
    name: "LINZ NZ Elevation (1m LiDAR / 8m DEM)",
    regions: ["NZ"],
    /* Mainland NZ. Excludes the Chathams, which straddle the antimeridian. */
    coverage: { type: "region", bboxes: [{ south: -47.5, west: 166.0, north: -34.0, east: 179.0 }] },
    sourceType: "xyz-elevation",
    /* pipeline=terrain-rgb is not optional: without it the tileset returns its own rendering
       rather than elevation packed into RGB. */
    urlTemplate: "https://basemaps.linz.govt.nz/v1/tiles/{layer}/WebMercatorQuad/{z}/{x}/{y}.png?pipeline=terrain-rgb&api={key}",
    layerEnv: "LINZ_ELEVATION_LAYER",
    defaultLayer: "elevation",
    apiKeyEnv: ["LINZ_BASEMAPS_API_KEY", "LINZ_BASEMAPS_PUBLIC_KEY"],
    encoding: "terrain-rgb",
    /* z17 is ~0.95m/px at NZ latitudes - native for the 1m LiDAR. */
    maxUsefulZoom: 17,
    resolutionM: 1,
    fallbackResolutionM: 8,
    horizontalCrs: "EPSG:3857",
    verticalDatum: "NZVD2016",
    licence: OPEN_GOV("CC BY 4.0", "https://www.linz.govt.nz/data/linz-data/linz-data-copyright"),
    attribution: {
      text: "Elevation sourced from the LINZ Data Service and licensed for re-use under CC BY 4.0",
      url: "https://www.linz.govt.nz/data/linz-data/linz-data-copyright"
    },
    priority: 90,
    qualityClass: "lidar",
    enabled: true,
    datasetVersion: "basemaps-elevation"
  },
  {
    id: "usgs-3dep",
    name: "USGS 3DEP (1m LiDAR / 10m)",
    regions: ["US"],
    /* The ImageServer's own CONUS extent (as read for NAIP, 2026-07-28). 3DEP itself reaches
       Alaska and Hawaii; widen this once those are checked. */
    coverage: { type: "region", bboxes: [{ south: 24.49, west: -124.83, north: 49.57, east: -66.86 }] },
    sourceType: "arcgis-image-server",
    endpoint: "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage",
    /* Raw float elevation - the service also publishes hillshade/slope raster functions, and
       leaving renderingRule unset is what gets measurements rather than a picture of them. */
    format: "tiff",
    encoding: "float32",
    maxUsefulZoom: 17,
    blockPx: 2048,
    resolutionM: 1,
    fallbackResolutionM: 10,
    horizontalCrs: "EPSG:3857",
    verticalDatum: "NAVD88",
    licence: Object.assign(OPEN_GOV("Public domain (USGS)", "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits"), { attributionRequired: false }),
    attribution: { text: "Elevation courtesy of USGS 3D Elevation Program", url: "https://www.usgs.gov/3d-elevation-program" },
    priority: 90,
    qualityClass: "lidar",
    enabled: true,
    datasetVersion: "3DEPElevation"
  },
  {
    id: "osni-ni-dtm10",
    name: "OSNI Open Data 10m DTM",
    regions: ["GB-NIR"],
    /* Northern Ireland's extent. The box also takes in parts of Donegal, Monaghan and Louth;
       those courses are refused by MEASURED coverage instead - the staged index only holds
       OSNI's sheets, so ground outside Northern Ireland comes back as nodata and the course
       falls to the next source (gd-terrain-normalise.mjs coverage check). */
    coverage: { type: "region", bboxes: [{ south: 54.0, west: -8.2, north: 55.32, east: -5.4 }] },
    /* OSNI publishes this as zipped TXT sheets in Irish Grid with no tile or image service, so
       it is staged ONCE into Clarity's own storage (scripts/terrain/stage-terrain-source.mjs)
       and every bake reads only the staged tiles under its course. */
    sourceType: "clarity-staged",
    staged: { bucket: "terrain-sources", tileSizeM: 2000 },
    resolutionM: 10,
    fallbackResolutionM: 10,
    horizontalCrs: "EPSG:29902",
    /* Mean sea level at Belfast Lough (EPSG:5732). Not the same surface as the global tiles'
       EGM96-ish mean sea level, so the two are never blended. */
    verticalDatum: "Belfast",
    licence: OPEN_GOV("Open Government Licence v3.0", "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/"),
    attribution: {
      text: "Contains public sector information licensed under the Open Government Licence v3.0 (OSNI Open Data, © Crown copyright)",
      url: "https://www.nidirect.gov.uk/articles/osni-open-data-product-list"
    },
    priority: 70,
    qualityClass: "regional",
    enabled: true,
    /* Set to the version the staging script prints once the sheets are staged. Null means
       "approved but not staged": the resolver reports it and bakes fall back to global. */
    datasetVersion: null
  },
  {
    id: "gsi-jp-dem10b",
    name: "GSI Japan DEM10B",
    regions: ["JP"],
    /* Two boxes, the same ones the GSI imagery entries use: one box cannot hold the archipelago
       without swallowing South Korea. */
    coverage: { type: "region", bboxes: [
      { south: 30.1, west: 129.6, north: 45.65, east: 146.0 },
      { south: 23.9, west: 122.8, north: 28.6, east: 130.1 }
    ] },
    sourceType: "xyz-elevation",
    /* Heights packed as centimetres in RGB with RGB(128,0,0) as the NoData sentinel over the
       sea. dem_png is the nationwide 10m grid, capped at z14. The 5m dem5a_png tier covers only
       part of the country - pin GSI_DEM_LAYER to it per-bake if a course is known covered. */
    urlTemplate: "https://cyberjapandata.gsi.go.jp/xyz/{layer}/{z}/{x}/{y}.png",
    layerEnv: "GSI_DEM_LAYER",
    defaultLayer: "dem_png",
    apiKeyEnv: "",
    encoding: "gsi-dem-png",
    maxUsefulZoom: 14,
    resolutionM: 10,
    fallbackResolutionM: 10,
    horizontalCrs: "EPSG:3857",
    verticalDatum: "JGD2011-TP",
    licence: OPEN_GOV("Government of Japan Standard Terms of Use (CC BY 4.0 compatible)", "https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html"),
    attribution: { text: "Elevation: GSI Japan (出典：国土地理院)", url: "https://maps.gsi.go.jp/development/ichiran.html" },
    priority: 70,
    qualityClass: "regional",
    enabled: true,
    datasetVersion: "dem_png"
  },
  {
    id: "ga-au-dem-lidar-5m",
    name: "Geoscience Australia DEM LiDAR 5m",
    regions: ["AU"],
    coverage: { type: "region", bboxes: [{ south: -43.7, west: 112.9, north: -10.6, east: 153.7 }] },
    sourceType: "arcgis-image-server",
    endpoint: "https://services.ga.gov.au/gis/rest/services/DEM_LiDAR_5m/ImageServer/exportImage",
    format: "tiff",
    encoding: "float32",
    maxUsefulZoom: 15,
    blockPx: 2048,
    resolutionM: 5,
    fallbackResolutionM: 30,
    horizontalCrs: "EPSG:3857",
    verticalDatum: "AHD",
    licence: OPEN_GOV("CC BY 4.0", "https://www.ga.gov.au/scientific-topics/national-location-information/digital-elevation-data"),
    attribution: { text: "Elevation © Commonwealth of Australia (Geoscience Australia), CC BY 4.0", url: "https://www.ga.gov.au/scientific-topics/national-location-information/digital-elevation-data" },
    priority: 80,
    qualityClass: "high-resolution",
    /* DISABLED: the ImageServer 404s (checked 2026-08-19). GA's catalogue now points at a
       DEM_LiDAR_5m_2025 MapServer/WMS that serves a rendered picture, not floats; its WCS is
       the real replacement and needs the wcs adapter. Kept so the research is where the next
       person looks, and so Australian courses are reported as upgrade opportunities. */
    enabled: false,
    disabledReason: "endpoint retired (404 since 2026-08-19); replacement is WCS",
    datasetVersion: "DEM_LiDAR_5m"
  },
  {
    id: GLOBAL_TERRAIN_SOURCE_ID,
    name: "Global terrain tiles (Copernicus EU-DEM / SRTM)",
    regions: ["*"],
    coverage: { type: "global" },
    sourceType: "xyz-elevation",
    urlTemplate: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
    apiKeyEnv: "",
    encoding: "terrarium",
    maxUsefulZoom: 13,
    resolutionM: 25,
    fallbackResolutionM: 30,
    horizontalCrs: "EPSG:3857",
    /* SRTM is referenced to EGM96 and EU-DEM to EVRS-ish mean sea level; Tilezen does not
       harmonise them. Recorded as what it is. */
    verticalDatum: "mixed-msl",
    licence: OPEN_GOV("Open (Mapzen Terrain Tiles: SRTM public domain, EU-DEM Copernicus attribution)", "https://github.com/tilezen/joerd/blob/master/docs/attribution.md"),
    /* Only the wording Copernicus requires; the joerd doc's other lines are courtesies. */
    attribution: {
      text: "Elevation: Produced using Copernicus data and information funded by the European Union - EU-DEM layers",
      url: "https://github.com/tilezen/joerd/blob/master/docs/attribution.md"
    },
    priority: 0,
    qualityClass: "global",
    enabled: true,
    datasetVersion: "terrarium"
  }
]);

/* Adapters that exist. A sourceType outside this list is refused by the resolver with that
   reason, so adding an entry before its adapter cannot silently do nothing. */
export const IMPLEMENTED_SOURCE_TYPES = Object.freeze(["xyz-elevation", "arcgis-image-server", "clarity-staged"]);

export function sourceById(id, sources = TERRAIN_SOURCES) {
  return sources.find(s => s.id === id) || null;
}

/* All three rights must be granted. Attribution is a condition a licence attaches, never a
   right it grants. ShareAlike is refused for the same reason the imagery registry refuses it:
   accepting it would license our course packages on the same terms. */
export function licenceGrantsStorage(licence) {
  if (!licence || licence.shareAlike === true) return false;
  return licence.storage === true && licence.derivatives === true && licence.redistribution === true;
}

function envValue(name, env) {
  const store = env || (typeof process !== "undefined" && process.env) || {};
  return String(store[name] || "");
}

function keyNames(source) {
  if (!source || !source.apiKeyEnv) return [];
  return (Array.isArray(source.apiKeyEnv) ? source.apiKeyEnv : [source.apiKeyEnv]).filter(Boolean);
}

/* Fill {layer} and {key} from the environment, or explain why the source cannot be read. A
   source whose key is not configured is as unusable as an unlicensed one. */
export function configureSource(source, env) {
  const names = keyNames(source);
  let key = "";
  for (const n of names) { key = envValue(n, env); if (key) break; }
  if (names.length && !key) return { error: "not configured (" + names.join(" or ") + " is not set)" };
  if (source.sourceType === "clarity-staged" && !source.datasetVersion) {
    return { error: "approved but not staged (run scripts/terrain/stage-terrain-source.mjs, then set datasetVersion)" };
  }
  const layer = (source.layerEnv && envValue(source.layerEnv, env)) || source.defaultLayer || "";
  const out = Object.assign({}, source, { apiKey: key, layer });
  if (out.urlTemplate) out.urlTemplate = out.urlTemplate.replace(/\{ *layer *\}/g, layer).replace(/\{ *key *\}/g, key);
  return { source: out };
}

/* The provenance a baked asset records about a source: what it was, never how to reach it
   (no URLs with keys, no tokens). */
export function sourceProvenance(source) {
  return {
    id: source.id,
    name: source.name,
    datasetVersion: source.datasetVersion || null,
    layer: source.layer || source.defaultLayer || null,
    sourceType: source.sourceType,
    resolutionM: source.resolutionM,
    fallbackResolutionM: source.fallbackResolutionM || source.resolutionM,
    horizontalCrs: source.horizontalCrs,
    verticalDatum: source.verticalDatum || null,
    licence: source.licence ? source.licence.name : null,
    licenceUrl: source.licence ? source.licence.url || null : null,
    attribution: source.attribution || null,
    qualityClass: source.qualityClass
  };
}

/* A fingerprint of everything about a source that would change its terrain. Stored with the
   asset; when it differs from the registry's current one, the asset can be rebuilt. */
export function sourceFingerprint(source) {
  return [source.id, source.datasetVersion || "", source.layer || source.defaultLayer || "", source.resolutionM, source.verticalDatum || ""].join("|");
}
