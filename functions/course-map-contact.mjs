/* "Leave an email so we can tell you when a map is updated."

   The course picker asks for an address once per device, before the first typed search
   (scripts/gd-course-search-email.js). The player can skip it. The tap lands here as
   POST {email} and is stored in course_map_update_contacts, one row per address. A signed-in
   player's bearer token, when the app has one, links the row to their user id as well; a bad
   or missing token just leaves it unlinked. Giving the same address again is harmless.

   The address is only for telling the player about an updated map. */

import { createSupabaseFetch } from "./lib/gd-supabase-fetch.mjs";
import { cleanEmail, verifiedUser } from "./course-map-notify.mjs";

const TABLE = "course_map_update_contacts";

function env(name) { return process.env[name] || ""; }
function supabaseBase() { return env("SUPABASE_URL").replace(/\/+$/, ""); }
function supabaseKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); }
function hasSupabase() { return !!(supabaseBase() && supabaseKey()); }

const supabaseFetch = createSupabaseFetch({ base: supabaseBase, key: supabaseKey, label: "course-map-contact" });

export default async function courseMapContact(req) {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!hasSupabase()) return json(503, { error: "Supabase is not configured" });
  let payload = {};
  try { payload = await req.json(); } catch (error) { return json(400, { error: "Invalid JSON" }); }
  const email = cleanEmail(payload && payload.email);
  if (!email) return json(400, { error: "Enter a valid email address" });
  const user = await verifiedUser(req);
  const row = { email, updated_at: new Date().toISOString() };
  /* Only a verified sign-in sets user_id, and an unlinked repeat never clears one. */
  if (user) row.user_id = user.id;
  try {
    await supabaseFetch(TABLE + "?on_conflict=email", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(row)
    });
    return json(200, { saved: true, email });
  } catch (error) {
    console.warn("course-map-contact: could not save", error && error.message || error);
    return json(502, { error: "Could not save your email" });
  }
}

export const config = {
  path: "/api/course-map-contact",
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
