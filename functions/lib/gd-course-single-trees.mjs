/* A course's real trees: each one where it stands and at its own crown size.

   Two sources, both outside course_maps (a tree-lined course holds thousands, and the course
   objects are synced whole to every phone and Studio):
     - the single trees placed by hand in the course's Studio overlay (on the facility owner's
       row, lib/gd-overlay-owner.mjs)
     - the trees the course's tree run found that are live at its tree layer's level
       (lib/gd-course-trees-store.mjs)

   Read by the watch bake (course-watch-maps.mjs) and carried in the course package
   (course-package.mjs) for the app's illustrated map. Both stand them through watch-map-core
   buildHoleTrees as geometry.singleTrees: one tree per marker, and a wood with a marker in it
   is drawn as those trees rather than filled. The OPCD export (lib/gd-opcd-export-job.mjs)
   writes them to trees.csv, with where each came from. Best-effort: with none, or nothing to
   read, the woods are made up as before. Each caller passes its own supabaseFetch. */

import watchMapCore from "../../scripts/gd-watch-map-core.js";
import { overlayOwnerId } from "./gd-overlay-owner.mjs";
import { liveTrees, TREES_TABLE } from "./gd-course-trees-store.mjs";

const OVERLAYS_TABLE = "course_map_overlays";

/* -> [{lat, lng, r, source, level?}], r the crown radius in metres, source "studio" (placed by
   hand) or "finder" (found by the tree run, with the level it was found at). */
export async function courseSingleTrees(supabaseFetch, courseId) {
  const [placed, found] = await Promise.all([
    overlayOwnerId(supabaseFetch, courseId)
      .then(ownerId => supabaseFetch(OVERLAYS_TABLE + "?select=features&course_id=eq." + encodeURIComponent(ownerId) + "&limit=1"))
      .then(rows => watchMapCore.singleTreesFromOverlay(Array.isArray(rows) && rows[0] ? rows[0].features : []).map(t => ({ lat: t.lat, lng: t.lng, r: t.r, source: "studio" })))
      .catch(() => []),
    supabaseFetch(TREES_TABLE + "?select=trees,level&course_id=eq." + encodeURIComponent(courseId) + "&limit=1")
      .then(rows => liveTrees(Array.isArray(rows) ? rows[0] : null).map(t => ({ lat: t.lat, lng: t.lng, r: t.r, level: t.l, source: "finder" })))
      .catch(() => [])
  ]);
  return placed.concat(found);
}

/* The package's compact form, [lat, lng, r] each: about 30 bytes a tree at 7 decimal places
   (centimetres) and a tenth of a metre of crown. */
export function packSingleTrees(trees) {
  return (trees || []).filter(t => t && Number.isFinite(t.lat) && Number.isFinite(t.lng) && t.r > 0)
    .map(t => [Number(t.lat.toFixed(7)), Number(t.lng.toFixed(7)), Math.round(t.r * 10) / 10]);
}
