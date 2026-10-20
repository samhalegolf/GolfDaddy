/* The Public Facing Hub's rules (Studio > Marketing > Public Facing Hub), pure.
 *
 * Two rules of the same shape:
 *   hub          which courses land in the hub to get their header snapshots
 *   autoPublish  which courses "Run publishing" switches on at /courses/<courseId>
 * and `held`: courses an admin took down by hand, which publishing never switches back on.
 *
 * A rule is a set of conditions that must ALL hold. An empty country list means any country;
 * a minimum of 0 means no minimum. The autoPublish default is exactly what made a course page
 * live before the hub existed (functions/course-page.mjs): the map is published and the
 * visual has a published version. Headers are not required by default, matching that.
 *
 * The page function still checks published map + published visual itself, whatever these
 * say, so a loosened rule can switch a page on but cannot make an unfinished course render. */

export const COUNTS = [
  { key: "minHoles", field: "holeCount", label: "holes" },
  { key: "minObjects", field: "objectCount", label: "objects" },
  { key: "minBunkers", field: "bunkerCount", label: "bunkers" },
  { key: "minWater", field: "waterCount", label: "water" },
  { key: "minTrees", field: "treeCount", label: "trees" }
];

export const HEADER_FRAMES = ["01-pre-lock", "02-head-to-tee", "03-approach"];

function baseRule() {
  return { countries: [], minHoles: 0, minObjects: 0, minBunkers: 0, minWater: 0, minTrees: 0,
    publishedMap: true, publishedVisual: true, headers: false };
}

export function defaultRules() {
  return { hub: baseRule(), autoPublish: Object.assign(baseRule(), { enabled: true }), held: [] };
}

function count(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100000) : 0;
}

function countryList(value) {
  const list = Array.isArray(value) ? value : [];
  return Array.from(new Set(list.map((c) => String(c || "").trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)))).sort();
}

function normalizeRule(raw, base) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = Object.assign({}, base);
  out.countries = countryList(src.countries);
  COUNTS.forEach(({ key }) => { out[key] = count(src[key]); });
  ["publishedMap", "publishedVisual", "headers", "enabled"].forEach((key) => {
    if (key in base && typeof src[key] === "boolean") out[key] = src[key];
  });
  return out;
}

/* Whatever is stored (or posted), made safe and complete. Unknown keys are dropped. */
export function normalizeRules(raw) {
  const base = defaultRules();
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    hub: normalizeRule(src.hub, base.hub),
    autoPublish: normalizeRule(src.autoPublish, base.autoPublish),
    held: Array.from(new Set((Array.isArray(src.held) ? src.held : []).map((id) => String(id || "").trim()).filter(Boolean))).sort()
  };
}

/* Why a course fails a rule, in plain words; an empty list means it passes. */
export function ruleMisses(rule, course) {
  const misses = [];
  if (rule.countries.length && !rule.countries.includes(String(course.countryCode || "").toUpperCase())) {
    misses.push("not in " + rule.countries.join(", "));
  }
  COUNTS.forEach(({ key, field, label }) => {
    if (rule[key] > 0 && !(Number(course[field]) >= rule[key])) misses.push((Number(course[field]) || 0) + " " + label + " (needs " + rule[key] + ")");
  });
  if (rule.publishedMap && !course.published) misses.push("map not published");
  if (rule.publishedVisual && !course.visualPublished) misses.push("no published visual");
  if (rule.headers && !(course.headerCount >= HEADER_FRAMES.length)) misses.push("headers " + (course.headerCount || 0) + "/" + HEADER_FRAMES.length);
  return misses;
}

/* Every course, with what the rules make of it:
 *   inHub          passes the hub rule
 *   autoMatch      passes the autoPublish rule
 *   live           the page actually renders (page_public + published map + published visual)
 *   held           taken down by hand
 *   hubMisses / autoMisses   why not, for the Studio to show */
export function evaluate(rules, courses) {
  const held = new Set(rules.held);
  return courses.map((course) => {
    const hubMisses = ruleMisses(rules.hub, course);
    const autoMisses = ruleMisses(rules.autoPublish, course);
    return Object.assign({}, course, {
      inHub: hubMisses.length === 0,
      autoMatch: autoMisses.length === 0,
      held: held.has(course.courseId),
      live: !!(course.pagePublic && course.published && course.visualPublished),
      hubMisses,
      autoMisses
    });
  });
}

/* What "Run publishing" would do: switch on every auto match that is not already on and not
   held. It never switches a page off - a course that stops matching is listed so a person can
   decide, because taking a live page down loses its search ranking. */
export function publishPlan(rules, evaluated) {
  const toPublish = rules.autoPublish.enabled
    ? evaluated.filter((c) => c.autoMatch && !c.pagePublic && !c.held)
    : [];
  const notMatching = evaluated.filter((c) => c.pagePublic && !c.autoMatch);
  return { toPublish, notMatching };
}
