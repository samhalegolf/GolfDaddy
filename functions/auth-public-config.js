"use strict";

exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify({
      supabaseUrl: process.env.SUPABASE_URL || "",
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLIC_ANON_KEY || "",
      /* LINZ Basemaps key for the LIVE map only - the display layer a course plays over while
         it has no cloud frames. It is a public, per-domain key by design (it ends up in tile
         URLs the browser fetches), which is why it belongs in the public config rather than
         behind a proxy. Stored frames are shot server-side and never use this. */
      linzBasemapsKey: process.env.LINZ_BASEMAPS_PUBLIC_KEY || process.env.LINZ_BASEMAPS_API_KEY || "",
      /* ArcGIS Location Platform key, same live-map-only role as the LINZ key: it feeds the
         global Esri World Imagery display layer for courses no open regional program covers.
         Also a public, referrer-scoped key by design (it ends up in tile URLs the browser
         fetches) - restrict it to this domain in the ArcGIS dashboard and grant it basemap
         privileges only. The scan pipeline must never read it: Esri's licence here is display,
         not storage. */
      esriApiKey: process.env.ARCGIS_API_KEY || process.env.ESRI_API_KEY || ""
    })
  };
};
