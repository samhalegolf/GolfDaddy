/* Base imagery for the live-map fallback. Licensed sources only — the
   anonymous Esri World Imagery endpoints are not licensed for commercial use
   (see the mapSources note in the old gd-app-core), so outside every covered
   region the drawn OSM map is the honest fallback.

   Regions (mirroring the old app's registry, one entry per licence):
   - LINZ Basemaps aerial — New Zealand, CC BY 4.0, needs the api key that
     /api/auth-public-config publishes. Prefetched at boot so base choice
     stays synchronous.
   - USDA NAIP / USGS — United States, public domain. No tile cache exists, so
     each tile is a mercator-bbox exportImage request (golf-grade to z19).
   - Queensland state program aerial — QLD Australia, CC BY-SA. Live display
     only: a stored composite would be Adapted Material, but drawing a fetched
     tile adapts and redistributes nothing.
   - Esri World Imagery — global, PAID (ArcGIS Location Platform, keyed via
     /api/auth-public-config like LINZ). The licence the key buys is display,
     which is why this layer exists here and must never exist in the scan
     registry. It is what the regions no open program covers — the UK, Ireland,
     Canada, the rest of Australia — play over instead of the drawn map. NOT
     the anonymous arcgisonline endpoint the first paragraph is about: that one
     grants nothing; ibasemaps-api with a token grants display.
   - OSM — global, last, always able to draw. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});

  var MERCATOR_HALF_M = 20037508.342789244;
  var linzKey = null;
  var esriKey = null;
  var pending = null;

  /* An ArcGIS ImageServer answers a bbox, not a {z}/{x}/{y} cell: the tile's
     own mercator bbox at 256px lands on Leaflet's grid unresampled. coords are
     already at native zoom when maxNativeZoom clamps, so no offset applies. */
  var BboxTileLayer = typeof L !== "undefined" ? L.TileLayer.extend({
    getTileUrl: function (coords) {
      var spec = this.options.gdSource || {};
      var mpp = (MERCATOR_HALF_M * 2) / (256 * Math.pow(2, coords.z));
      var left = coords.x * 256, top = coords.y * 256;
      var west = left * mpp - MERCATOR_HALF_M, east = (left + 256) * mpp - MERCATOR_HALF_M;
      var north = MERCATOR_HALF_M - top * mpp, south = MERCATOR_HALF_M - (top + 256) * mpp;
      var params = new URLSearchParams({
        bbox: [west, south, east, north].join(","),
        bboxSR: "3857", imageSR: "3857", size: "256,256", format: "jpg",
        interpolation: "RSP_BilinearInterpolation", f: "image"
      });
      if (spec.renderingRule) params.set("renderingRule", JSON.stringify(spec.renderingRule));
      return String(spec.bboxEndpoint) + "?" + params.toString();
    }
  }) : null;

  var SOURCES = [
    {
      kind: "linz",
      requiresLinzKey: true,
      bbox: { south: -47.5, west: 166.0, north: -34.0, east: 179.0 },
      tileUrl: "https://basemaps.linz.govt.nz/v1/tiles/aerial/WebMercatorQuad/{z}/{x}/{y}.webp?api={linzKey}",
      attribution: "Sourced from the LINZ Data Service, CC BY 4.0",
      options: { maxZoom: 21, crossOrigin: true }
    },
    {
      kind: "naip",
      bbox: { south: 24.49, west: -124.83, north: 49.57, east: -66.86 },
      bboxEndpoint: "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage",
      renderingRule: { rasterFunction: "NaturalColor" },
      attribution: "Imagery courtesy of USDA NAIP / USGS The National Map",
      /* maxNativeZoom 19 = 0.24m/px against a 0.3m mosaic; past it Leaflet
         upscales rather than paying for a request that returns a blur. */
      options: { maxZoom: 21, maxNativeZoom: 19, crossOrigin: true }
    },
    {
      kind: "qld",
      bbox: { south: -29.2, west: 138.0, north: -10.7, east: 153.6 },
      tileUrl: "https://spatial-img.information.qld.gov.au/arcgis/rest/services/Basemaps/LatestStateProgram_AllUsers/MapServer/tile/{z}/{y}/{x}",
      attribution: "© State of Queensland, licensed CC BY-SA",
      options: { maxZoom: 21, crossOrigin: true }
    },
    {
      kind: "esri",
      requiresEsriKey: true,
      /* No bbox: global, so it answers exactly where every open region above
         has declined. Esri's tile order is {z}/{y}/{x} — y before x — and
         Leaflet substitutes by name, so do not "fix" the template against a
         slippy-map example. maxNativeZoom 19: same policy as NAIP, upscale
         past the mosaic instead of paying for tiles it does not have. */
      tileUrl: "https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token={esriKey}",
      attribution: "Powered by Esri — Maxar, Earthstar Geographics, and the GIS User Community",
      options: { maxZoom: 21, maxNativeZoom: 19, crossOrigin: true }
    },
    {
      kind: "osm",
      tileUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      attribution: "© OpenStreetMap contributors",
      options: { maxZoom: 19 }
    }
  ];

  function configure(config) {
    linzKey = (config && String(config.linzBasemapsKey || "")) || null;
    esriKey = (config && String(config.esriApiKey || "")) || null;
  }

  function covers(source, centre) {
    if (!source.bbox) return true;   // global fallback
    var lat = Number(centre && centre.lat), lng = Number(centre && centre.lng);
    return Number.isFinite(lat) && Number.isFinite(lng)
      && lat >= source.bbox.south && lat <= source.bbox.north
      && lng >= source.bbox.west && lng <= source.bbox.east;
  }

  function pick(centre) {
    for (var i = 0; i < SOURCES.length; i++) {
      var source = SOURCES[i];
      if (source.requiresLinzKey && !linzKey) continue;
      if (source.requiresEsriKey && !esriKey) continue;
      if (covers(source, centre)) return source;
    }
    return SOURCES[SOURCES.length - 1];
  }

  function buildLayer(source) {
    var options = Object.assign({ attribution: source.attribution }, source.options);
    if (source.bboxEndpoint) {
      options.gdSource = source;
      return new BboxTileLayer("", options);
    }
    return L.tileLayer(String(source.tileUrl).replace("{linzKey}", linzKey || "").replace("{esriKey}", esriKey || ""), options);
  }

  app.basemap = {
    configure: configure,
    prefetch: function () {
      if (linzKey || pending || typeof fetch !== "function") return pending;
      pending = fetch("/api/auth-public-config", { headers: { Accept: "application/json" } })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(configure, function () {});
      return pending;
    },
    /* Settles when the LINZ key fetch is done, one way or the other. The key
       decides whether New Zealand gets aerial imagery or the drawn OSM map, and
       it arrives over the network — so the first map is built before the answer
       exists and picks OSM. Callers use this to re-pick once, which is why
       hole 1 no longer opens on OSM and then swaps to satellite. */
    ready: function () {
      return pending || Promise.resolve();
    },
    /* Which source is up, for the on-screen source tag. */
    kindFor: function (centre) { return pick(centre).kind; },
    /* → {kind, layer, attribution} for the given course centre. Never throws,
       never waits. The attribution string comes back separately because the
       stage camera rotates the map element, which would carry Leaflet's own
       attribution control off-screen with it — play.js renders it as fixed
       chrome instead, and every source here is licensed on the condition that
       it stays visible. */
    baseFor: function (centre) {
      var source = pick(centre);
      return { kind: source.kind, layer: buildLayer(source), attribution: source.attribution };
    }
  };
})();
