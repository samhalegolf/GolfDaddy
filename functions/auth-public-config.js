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
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLIC_ANON_KEY || ""
    })
  };
};
