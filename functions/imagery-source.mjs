/* GET /api/imagery-source?lat=&lng=[&spanM=] — which SCAN source covers a point, if any.
 *
 * Read-only and deliberately thin. The answer comes from the same
 * lib/gd-imagery-sources.mjs registry the mapper and the visual worker scan through, so
 * "what the scanner would use here" cannot drift from what the scanner actually does. A
 * hardcoded copy of that table in the browser would drift the first time a bbox moved.
 *
 * Studio's map viewport is the only caller today. It asks once per course, then uses the
 * answer to pick a live provider and a sensible zoom ceiling before anyone starts panning.
 *
 * Resolved endpoints and API keys are NOT returned. A key in a JSON body is a key in a
 * browser's network log, and nothing here needs one to describe a source: the caller is
 * drawing licensed LIVE tiles from scripts/gd-app-core.js's own list, not scan tiles.
 *
 * Bounds, not a point, because the registry answers containment - a source covers a course
 * only when it covers the WHOLE course (see regionCovers). spanM is the square drawn around
 * the point for that question; 600m is roughly a course-sized box and errs on the safe side
 * of "would this actually scan".
 */

import { resolveImagerySource, unscannableReason } from "./lib/gd-imagery-sources.mjs";

const DEFAULT_SPAN_M = 600;
const MIN_SPAN_M = 50;
const MAX_SPAN_M = 20000;
const M_PER_DEG_LAT = 111320;

function json(status, body) {
  return new Response(body == null ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

/* A square of ground around the point, in degrees. Longitude degrees shrink with latitude,
   hence the cosine; clamped so a point near a pole cannot divide the span to infinity. */
function boundsAround(lat, lng, spanM) {
  const half = spanM / 2;
  const dLat = half / M_PER_DEG_LAT;
  const cos = Math.max(0.01, Math.cos(lat * Math.PI / 180));
  const dLng = half / (M_PER_DEG_LAT * cos);
  return {
    south: lat - dLat,
    north: lat + dLat,
    west: lng - dLng,
    east: lng + dLng
  };
}

/* Everything the caller may see. Explicit allow-list rather than deleting the secrets from
   the resolved object: a new field added to resolveEndpoints later should default to hidden,
   not to published. */
function publicView(source) {
  const imagery = (source && source.imagery) || {};
  const license = (source && source.license) || {};
  const attribution = (source && source.attribution) || {};
  return {
    key: String(source.key || ""),
    label: String(source.label || ""),
    adapter: String(imagery.adapter || ""),
    /* The two numbers the viewport actually uses: past maxUsefulZoom the scan is upscaling
       imagery it already has, below minTrustedZoom it is looking at a mosaic's filler. */
    maxUsefulZoom: Number(imagery.maxUsefulZoom) || null,
    minTrustedZoom: Number(imagery.minTrustedZoom) || null,
    hasElevation: !!source.dem,
    license: {
      name: String(license.name || ""),
      url: String(license.url || ""),
      shareAlike: license.shareAlike === true
    },
    attribution: {
      text: String(attribution.text || ""),
      url: String(attribution.url || "")
    }
  };
}

export default async function imagerySource(req) {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (req.method !== "GET") return json(405, { error: "Method not allowed" });

  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return json(400, { error: "lat and lng are required" });
  }
  const asked = Number(url.searchParams.get("spanM"));
  const spanM = Number.isFinite(asked) && asked > 0
    ? Math.min(MAX_SPAN_M, Math.max(MIN_SPAN_M, asked))
    : DEFAULT_SPAN_M;

  const bounds = boundsAround(lat, lng, spanM);
  const resolved = resolveImagerySource(bounds);

  /* Not an error. Most of the planet has no licensed scan source, and a course there still
     plays perfectly well over live tiles - so this returns 200 with a reason in words, the
     same shape /api/course-maps already reports it in. */
  if (!resolved) {
    return json(200, {
      point: { lat, lng },
      spanM,
      bounds,
      scannable: false,
      source: null,
      reason: unscannableReason(bounds)
    });
  }

  return json(200, {
    point: { lat, lng },
    spanM,
    bounds,
    scannable: true,
    source: publicView(resolved),
    reason: ""
  });
}

export const config = {
  path: "/api/imagery-source"
};
