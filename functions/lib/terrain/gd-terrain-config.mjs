/* Terrain tuning, in one place.

   Every number here is a working threshold, not a scientific guarantee. A 2m DTM is not
   automatically good enough to read a green, and a 20m one is not useless - these lines decide
   what Clarity OFFERS by default, and the measured green fit (scripts/gd-green-contours-core.js)
   still has the last word on any individual green. Change them here and every resolver, bake
   and gate reads the new value. */

export const TERRAIN_CONFIG = Object.freeze({
  /* Ground fetched beyond the mapped course (tees, greens, routes, green outlines).

     450m because the tilted 3D lock view looks well past the green: the live frame pads a hole
     by max(90m, a third of its length) and throws a further max(150m, half its length) beyond
     the green (app/js/live-terrain.js frameWindow). For a 500m par 5 that is ~165m + 250m past
     the green. 450m covers it with a little to spare, so a hole's 3D frame is cut from the baked
     asset instead of going back to a provider. */
  marginM: 450,

  /* The baked grid. Never coarser than the best source can carry, never finer than this - past
     ~0.75m there is nothing left to resolve and the asset only grows. maxSidePx keeps a large
     36-hole facility from producing a grid a function cannot hold, and keeps the
     heights PNG inside the course-visuals bucket's 10MB object limit. */
  minSampleM: 0.75,
  oversample: 2,
  minZoom: 13,
  maxZoom: 17,
  maxSidePx: 3072,

  /* Coverage a source must reach to be used alone for a course.
       core  - the mapped course itself (bounds without the margin). 0.98, not 1, because links
               courses have sea and beach inside their bounds that a land DTM marks as nodata.
       frame - the whole fetched area, margin included. Partial is fine here: the margin is
               context, and a lower-quality source fills it (or the nearest real ground does). */
  minCoreCoverage: 0.98,
  minFrameCoverage: 0.6,

  /* A fetched grid that is mostly gaps after a "successful" request is a broken response, not
     terrain. */
  minUsableFraction: 0.05,

  /* Quality classes by EFFECTIVE source resolution (metres between real samples). A source's
     declared class is a ceiling: a "lidar" source that only delivered 8m here is regional. */
  quality: {
    greenDetailMaxM: 2.5,   // slope lines and tier paint on by default
    courseTerrainMaxM: 15,  // fairway shape, green surrounds; slope lines off by default
    // anything coarser is broad landscape only
  },

  /* Network behaviour for provider adapters. */
  http: {
    timeoutMs: 15000,
    retries: 3,
    retryBaseMs: 400,
    maxRetryAfterMs: 20000,
    concurrency: 8
  },

  /* Batch rebuilds are queued, never run inline, and capped per request. */
  maxBatchEnqueue: 25
});

export const QUALITY_CLASSES = Object.freeze(["global", "regional", "high-resolution", "lidar"]);

export function qualityRank(cls) {
  const i = QUALITY_CLASSES.indexOf(cls);
  return i < 0 ? 0 : i;
}

/* The class a resolution actually earns, capped by what the source claims to be. */
export function effectiveQualityClass(declared, resolutionM, config = TERRAIN_CONFIG) {
  const m = Number(resolutionM);
  const q = config.quality;
  const byResolution = !(m > 0) ? "global"
    : m <= 2 ? "lidar"
    : m <= 5 ? "high-resolution"
    : m <= q.courseTerrainMaxM ? "regional"
    : "global";
  const cap = QUALITY_CLASSES.includes(declared) ? declared : "global";
  return qualityRank(byResolution) <= qualityRank(cap) ? byResolution : cap;
}

/* What the terrain may be used for. greenDetail:
     "allowed"     - slope lines on by default
     "conditional" - the source is fine somewhere and coarse elsewhere (LINZ: 1m LiDAR over an 8m
                     national DEM), so lines are allowed but only where the green fit's own
                     measured gate passes
     "coarse"      - green surround shape is meaningful; slope lines off by default
     "none"        - broad landscape only */
export function terrainCapabilities({ resolutionM, fallbackResolutionM, coreCoverage }, config = TERRAIN_CONFIG) {
  const m = Number(resolutionM);
  const fb = Number(fallbackResolutionM) || m;
  const q = config.quality;
  let greenDetail = "none";
  if (m > 0 && m <= q.greenDetailMaxM) greenDetail = fb > q.greenDetailMaxM ? "conditional" : "allowed";
  else if (m > 0 && m <= q.courseTerrainMaxM) greenDetail = "coarse";
  if (Number.isFinite(coreCoverage) && coreCoverage < config.minCoreCoverage && greenDetail !== "none") {
    greenDetail = greenDetail === "allowed" ? "conditional" : greenDetail;
  }
  return {
    broadTerrain: true,
    courseTerrain: m > 0 && fb <= q.courseTerrainMaxM,
    greenDetail,
    greenSlopeLinesDefault: greenDetail === "allowed" || greenDetail === "conditional"
  };
}

/* 0..1, for display and ranking only. Resolution dominates; patched/filled ground and a coarser
   fallback tier pull it down. */
export function terrainConfidence({ resolutionM, fallbackResolutionM, coreCoverage, filledFraction }) {
  const m = Math.max(0.5, Number(resolutionM) || 30);
  const fb = Math.max(m, Number(fallbackResolutionM) || m);
  const effective = Math.sqrt(m * fb);
  const fromResolution = Math.max(0.05, Math.min(1, 1.15 - Math.log10(effective) * 0.55));
  const cover = Number.isFinite(coreCoverage) ? Math.max(0, Math.min(1, coreCoverage)) : 1;
  const filled = Number.isFinite(filledFraction) ? Math.max(0, Math.min(1, filledFraction)) : 0;
  return Math.round(fromResolution * cover * (1 - filled * 0.8) * 100) / 100;
}
