#!/usr/bin/env node
/* Fill in region and country for course maps published before those columns
 * existed.
 *
 * Every course saved from now on gets its place resolved as it is written
 * (functions/course-maps.mjs, ensureCoursePlace). This is the one-off pass for
 * everything already in the table. It is safe to run repeatedly: it only looks
 * at rows where country_code is null, so a second run does nothing unless new
 * gaps appeared - which makes it a reasonable thing to leave on a schedule if
 * a route ever writes a course without a place.
 *
 * Nominatim's usage policy allows one request a second from one client. That
 * is the real constraint here, so the run is deliberately serial and paced -
 * a few hundred courses is a few minutes, once.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/backfill-course-places.mjs
 *   ... --dry-run     resolve and report, write nothing
 *   ... --limit 25    stop after N courses
 */

import { reverseGeocodePlace, placeLabel } from "../functions/lib/gd-course-place.mjs";

const TABLE = "course_maps";
const REQUEST_SPACING_MS = 1100;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitArg = args.indexOf("--limit");
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : 0;

const base = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");

if (!base || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  process.exit(1);
}

async function supabase(path, options = {}) {
  const response = await fetch(base + "/rest/v1/" + path, Object.assign({}, options, {
    headers: Object.assign({
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json"
    }, options.headers || {})
  }));
  const body = await response.text();
  if (!response.ok) throw new Error("Supabase " + response.status + ": " + body.slice(0, 300));
  return body ? JSON.parse(body) : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const rows = await supabase(
    TABLE
    + "?select=id,course_id,course_name,course_lat,course_lng,finder_lat,finder_lng"
    + "&country_code=is.null&order=updated_at.desc"
    + (limit > 0 ? "&limit=" + limit : "&limit=2000")
  );
  const courses = Array.isArray(rows) ? rows : [];
  if (!courses.length) {
    console.log("Nothing to backfill - every course map already has a country.");
    return;
  }
  console.log("Courses missing a place: " + courses.length + (dryRun ? " (dry run)" : ""));

  let resolved = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of courses) {
    const lat = row.course_lat ?? row.finder_lat;
    const lng = row.course_lng ?? row.finder_lng;
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
      /* A course with no coordinate cannot be placed, and inventing one from
         the name would be worse than an empty subtitle. */
      console.log("  skip  " + row.course_name + " - no coordinate");
      skipped += 1;
      continue;
    }

    const place = await reverseGeocodePlace(lat, lng, { timeoutMs: 8000 });
    await sleep(REQUEST_SPACING_MS);

    if (!place) {
      console.log("  fail  " + row.course_name + " - geocoder had no answer");
      failed += 1;
      continue;
    }

    const label = placeLabel(place);
    if (dryRun) {
      console.log("  would " + row.course_name + " -> " + label);
      resolved += 1;
      continue;
    }

    try {
      await supabase(TABLE + "?id=eq." + encodeURIComponent(row.id), {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          region: place.region || null,
          country: place.country || null,
          country_code: place.countryCode || null
        })
      });
      console.log("  ok    " + row.course_name + " -> " + label);
      resolved += 1;
    } catch (error) {
      console.log("  fail  " + row.course_name + " - " + (error && error.message || error));
      failed += 1;
    }
  }

  console.log("");
  console.log("Resolved " + resolved + ", skipped " + skipped + ", failed " + failed + ".");
  /* Failures are re-runnable, not fatal: the rows still have a null
     country_code, so the next run picks exactly them back up. */
  if (failed) console.log("Re-run to retry the failures.");
}

main().catch((error) => {
  console.error(error && error.message || error);
  process.exit(1);
});
