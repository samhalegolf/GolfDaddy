/* Base imagery for the live-map fallback. Licensed sources only — the
   anonymous Esri World Imagery endpoints are not licensed for commercial use
   (see the mapSources note in the old gd-app-core), so outside a licensed
   source's coverage the drawn OSM map is the honest fallback.

   LINZ Basemaps aerial covers New Zealand (CC BY 4.0, attribution required)
   and needs the api key that /api/auth-public-config publishes. The key is
   prefetched at boot so choosing a base layer stays synchronous; a fetch that
   has not resolved yet just means OSM for that map — no waiting, no retry. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});

  var LINZ_BBOX = { south: -47.5, west: 166.0, north: -34.0, east: 179.0 };
  var linzKey = null;
  var pending = null;

  function configure(config) {
    linzKey = (config && String(config.linzBasemapsKey || "")) || null;
  }

  function inNz(centre) {
    var lat = Number(centre && centre.lat), lng = Number(centre && centre.lng);
    return Number.isFinite(lat) && Number.isFinite(lng)
      && lat >= LINZ_BBOX.south && lat <= LINZ_BBOX.north
      && lng >= LINZ_BBOX.west && lng <= LINZ_BBOX.east;
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
    /* → {kind, layer} for the given course centre. Never throws, never waits. */
    baseFor: function (centre) {
      if (linzKey && inNz(centre)) {
        return {
          kind: "linz",
          layer: L.tileLayer(
            "https://basemaps.linz.govt.nz/v1/tiles/aerial/WebMercatorQuad/{z}/{x}/{y}.webp?api=" + linzKey,
            { maxZoom: 21, attribution: "Sourced from the LINZ Data Service, CC BY 4.0" })
        };
      }
      return {
        kind: "osm",
        layer: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",
          { maxZoom: 19, attribution: "© OpenStreetMap contributors" })
      };
    },
    hasAerialFor: function (centre) { return !!(linzKey && inNz(centre)); }
  };
})();
