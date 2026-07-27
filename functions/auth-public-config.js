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
      linzBasemapsKey: process.env.LINZ_BASEMAPS_PUBLIC_KEY || process.env.LINZ_BASEMAPS_API_KEY || ""
    })
  };
};
