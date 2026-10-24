/* How a course's trees are stored (the course_trees table) and read back. Apart from
 * gd-course-trees-core.mjs, which finds them, so a reader - the course package, the watch bake,
 * Studio's tree API - does not pull in the finder's image pipeline. */

export const TREES_TABLE = "course_trees";
/* The sensitivity a fresh run goes live at - Studio's default (shapes.TREE_FINDER_LEVELS[2]). */
export const TREE_DEFAULT_LEVEL = 2;

/* Stored as [lat, lng, radius, level, fromHeight] - about 30 bytes a tree. */
export function packTrees(trees) {
  return (trees || []).map(t => [Number(t.lat.toFixed(7)), Number(t.lng.toFixed(7)), Math.round(t.r * 10) / 10, t.l | 0, t.h ? 1 : 0]);
}
export function unpackTrees(packed) {
  return (Array.isArray(packed) ? packed : []).filter(a => Array.isArray(a) && a.length >= 4 && Number.isFinite(Number(a[0])) && Number.isFinite(Number(a[1])) && Number(a[2]) > 0)
    .map(a => ({ lat: Number(a[0]), lng: Number(a[1]), r: Number(a[2]), l: Number(a[3]) | 0, h: a[4] ? 1 : 0 }));
}

/* The trees a course_trees row puts on the watch: every one at or under its level. */
export function liveTrees(row) {
  if (!row) return [];
  const level = Number.isFinite(Number(row.level)) ? Number(row.level) : TREE_DEFAULT_LEVEL;
  return unpackTrees(row.trees).filter(t => t.l <= level);
}
