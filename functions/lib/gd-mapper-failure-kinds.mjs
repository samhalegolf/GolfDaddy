/* What kind of mapping failure this is, and what Claude is told about it.
 *
 * A job that fails for good is handed to the Claude mapper-debug Routine
 * (functions/alert-utils.js fireClaudeRoutine, docs/CLAUDE_MAPPER_DEBUG_ROUTINE.md).
 * The Routine's own prompt is fixed once, in the Routine. What varies per failure is
 * the task: a course with no OpenStreetMap data at all needs greens and fairways drawn
 * from imagery, a course with eleven greens and no hole lines needs the holes routed
 * between them, a job whose worker died needs a code investigation. So each KIND of
 * failure carries its own operator-written prompt, edited in Studio (Course Mapping >
 * Claude Debug Prompts, stored in mapper_failure_prompts) and falling back to the
 * defaults here when nothing is stored.
 *
 * Pure: the worker, the admin endpoint and the tests all read the same table of kinds
 * and the same text builder, so the payload Claude receives and the outline the
 * operator sees in Studio cannot drift apart. */

/* Placeholders an operator may use in a prompt. Filled from the job's own facts. */
export const PROMPT_PLACEHOLDERS = [
  { token: "{{courseName}}", meaning: "the course's display name" },
  { token: "{{courseId}}", meaning: "the course id (course_maps.course_id)" },
  { token: "{{centre}}", meaning: "the queried centre as lat,lng" },
  { token: "{{expectedHoles}}", meaning: "hole count from the scorecard or OSM, or 'unknown'" },
  { token: "{{greens}}", meaning: "green polygons OSM returned" },
  { token: "{{fairways}}", meaning: "fairway polygons OSM returned" },
  { token: "{{holes}}", meaning: "hole lines OSM returned" },
  { token: "{{numberedHoles}}", meaning: "hole lines that carried a number" },
  { token: "{{error}}", meaning: "the job's error sentence" }
];

const DRAW_FROM_IMAGERY =
  "Two georeferenced captures of the course are linked in the captures block below: the " +
  "satellite view and the OpenStreetMap render, same bounds, same size. Download both and " +
  "look at them. Using the satellite image, trace every green and every fairway you can see as " +
  "polygons, and where the routing is clear give each hole its number using the scorecard " +
  "(par and length per hole) to check yourself: a 150m hole is a par 3, a 500m hole is a par 5. " +
  "Convert pixel positions to coordinates with the formula in the captures block. Return the " +
  "polygons exactly in the shape the output contract block describes.";

/* Ordered: the first matching rule wins in classifyMapperFailure. `label` is the
   Studio heading, `when` says which failures land here, in plain words. */
export const FAILURE_KINDS = [
  {
    kind: "no-osm-data-with-scorecard",
    label: "No OSM data, scorecard found",
    when: "OpenStreetMap returned no greens, fairways, tees or hole lines near the centre, but a scorecard was found.",
    defaultPrompt:
      "{{courseName}} ({{courseId}}) has no golf geometry in OpenStreetMap at all near {{centre}}, " +
      "and the scorecard says it has {{expectedHoles}} holes. First confirm the centre is right: " +
      "if the satellite capture shows no golf course, say so and stop - the course_maps centre is " +
      "wrong and that is the fix. If it does show a course: " + DRAW_FROM_IMAGERY
  },
  {
    kind: "no-osm-data-no-scorecard",
    label: "No OSM data, no scorecard",
    when: "OpenStreetMap returned nothing and no scorecard could be found either.",
    defaultPrompt:
      "{{courseName}} ({{courseId}}) has no golf geometry in OpenStreetMap near {{centre}} and no " +
      "scorecard was found, so the hole count is unknown. First confirm the satellite capture shows " +
      "a golf course at all; if not, the centre is wrong - say so and stop. If it does: search the " +
      "web for the club's scorecard (par and length per hole) and report the URL, then " + DRAW_FROM_IMAGERY
  },
  {
    kind: "surfaces-only",
    label: "Some greens or fairways found, no hole lines",
    when: "OpenStreetMap has green or fairway polygons near the centre but no hole lines, so nothing could be numbered.",
    defaultPrompt:
      "OpenStreetMap has {{greens}} greens and {{fairways}} fairways for {{courseName}} " +
      "({{courseId}}) but no hole lines, so the resolver could not build centre-lines or number " +
      "anything. The scorecard says {{expectedHoles}} holes. The OSM greens are listed in the " +
      "diagnostics; keep them and add what is missing. " + DRAW_FROM_IMAGERY
  },
  {
    kind: "holes-unnumbered",
    label: "Hole lines found, none numbered",
    when: "OpenStreetMap has hole lines but none carries a number, and the geometry resolver could not number them from the scorecard.",
    defaultPrompt:
      "OpenStreetMap has {{holes}} hole lines for {{courseName}} ({{courseId}}) but none is " +
      "numbered, and the geometry resolver could not assign numbers with enough confidence " +
      "(status in the diagnostics). Using the two captures and the scorecard's par and length " +
      "per hole, work out which line is which hole and return the hole lines with their numbers " +
      "in the output contract shape, with a one-line reason per hole. If the resolver should " +
      "have managed this, say what in functions/lib/gd-geometry-resolver-core.mjs stopped it."
  },
  {
    kind: "partial-numbering",
    label: "Some holes numbered, still failed",
    when: "Some hole lines were numbered but the run still ended in an error.",
    defaultPrompt:
      "{{numberedHoles}} of {{holes}} hole lines at {{courseName}} ({{courseId}}) were numbered, " +
      "yet the job failed with: {{error}}. This is more likely a code problem than a data problem. " +
      "Reproduce it with a failing test, make the smallest fix, and open a draft PR. If the " +
      "remaining holes need drawing, use the captures and return them in the output contract shape."
  },
  {
    kind: "no-course-location",
    label: "No course location",
    when: "The job's course has no course_maps row or no centre coordinates.",
    defaultPrompt:
      "The job for {{courseId}} failed because course_maps has no centre for it: {{error}}. Find " +
      "out how a job was queued for a course with no location (course-mapper-jobs.mjs creates the " +
      "row with a centre; something bypassed it or deleted it). Report the row and, if it is a " +
      "code path, fix it with a test."
  },
  {
    kind: "worker-died",
    label: "Worker died mid-job",
    when: "The job was reaped after the worker died running it eight times.",
    defaultPrompt:
      "The worker died eight times running the job for {{courseId}} ({{error}}). That is a crash " +
      "or a timeout, not a data problem: look for an unbounded loop or a payload too large for the " +
      "function's memory in functions/course-mapper-worker-background.mjs and the libraries it " +
      "calls, using this course's diagnostics and Overpass result. Reproduce, fix, draft PR."
  },
  {
    kind: "other",
    label: "Anything else",
    when: "A failure none of the rules above recognised.",
    defaultPrompt:
      "The job for {{courseName}} ({{courseId}}) failed with: {{error}}. Work out whether this is " +
      "a data problem or a code problem, per your standing instructions, and report."
  }
];

export function failureKind(kind) {
  return FAILURE_KINDS.find(entry => entry.kind === kind) || FAILURE_KINDS[FAILURE_KINDS.length - 1];
}

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/* The one place a failure becomes a kind. `error` is the job's error sentence,
   `diagnostics` what the run saved before it died (may be null for a reaped job). */
export function classifyMapperFailure({ error, diagnostics } = {}) {
  const message = String(error || "");
  const d = diagnostics && typeof diagnostics === "object" ? diagnostics : null;
  const f = (d && d.osmFeatures) || {};
  const evidence = {
    greens: count(f.greens), fairways: count(f.fairways), tees: count(f.tees),
    holes: count(f.holes), numberedHoles: count(f.numberedHoles),
    scorecardFound: !!(d && d.scorecardFound),
    expectedHoles: d && Number.isFinite(Number(d.expectedHoles)) && Number(d.expectedHoles) > 0 ? Number(d.expectedHoles) : null,
    resolverStatus: (d && d.resolverStatus && d.resolverStatus.status) || null,
    hasOsmCounts: !!(d && d.osmFeatures)
  };
  let kind = "other";
  if (/stale-running-reaped/i.test(message)) kind = "worker-died";
  else if (/no known location/i.test(message)) kind = "no-course-location";
  else if (evidence.hasOsmCounts) {
    const surfaces = evidence.greens + evidence.fairways + evidence.tees;
    if (evidence.holes === 0 && surfaces === 0) kind = evidence.scorecardFound ? "no-osm-data-with-scorecard" : "no-osm-data-no-scorecard";
    else if (evidence.holes === 0) kind = "surfaces-only";
    else if (evidence.numberedHoles === 0) kind = "holes-unnumbered";
    else kind = "partial-numbering";
  }
  return { kind, label: failureKind(kind).label, evidence };
}

export function fillPromptTemplate(template, values) {
  const v = values || {};
  return String(template || "").replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(v, key) && v[key] != null && v[key] !== "" ? String(v[key]) : match);
}

function fmtCentre(centre) {
  return centre && Number.isFinite(Number(centre.lat)) && Number.isFinite(Number(centre.lng))
    ? Number(centre.lat).toFixed(5) + "," + Number(centre.lng).toFixed(5) : "unknown";
}

/* The values the placeholders resolve to for one job. */
export function promptValues({ job, failure, classified, courseName, centre }) {
  const e = (classified && classified.evidence) || {};
  return {
    courseName: courseName || (failure && failure.diagnostics && failure.diagnostics.courseName) || (job && job.course_id) || "unknown",
    courseId: (job && job.course_id) || "unknown",
    centre: fmtCentre(centre || (failure && failure.diagnostics && failure.diagnostics.centre)),
    expectedHoles: e.expectedHoles || "unknown",
    greens: e.greens || 0, fairways: e.fairways || 0, holes: e.holes || 0, numberedHoles: e.numberedHoles || 0,
    error: String((failure && failure.message) || "").slice(0, 300)
  };
}

/* What Claude must hand back when it draws or numbers geometry. Stated in the payload
   every time so the operator's prompt never has to repeat it. There is no automatic
   ingest yet: the operator pastes the block into Studio. */
export const OUTPUT_CONTRACT = [
  "--- output contract ---",
  "If you draw or number geometry, put it in your report as one fenced ```geojson block:",
  "a FeatureCollection in WGS84, coordinates as [lng, lat]. Each Feature is a Polygon",
  "(greens, fairways, tees) or a LineString (a hole line from tee to green centre) with",
  "properties { \"golf\": \"green\" | \"fairway\" | \"tee\" | \"hole\", \"hole\": <number or null>,",
  "\"confidence\": 0..1, \"note\": \"<why>\" }. Close every ring, keep rings under 60 points,",
  "and include the OSM greens you kept unchanged so the block is the whole course.",
  "Nothing ingests this automatically: an operator reads the report and applies it."
].join("\n");

/* Pixel <-> coordinate rule for the captures, in words Claude can apply. */
function georeferenceLines(captures) {
  const b = captures && captures.bounds;
  if (!b) return [];
  return [
    "bounds: north " + b.north.toFixed(6) + ", south " + b.south.toFixed(6) + ", west " + b.west.toFixed(6) + ", east " + b.east.toFixed(6),
    "size: " + captures.width + "x" + captures.height + " px, web-mercator zoom " + captures.zoom + ", north up",
    "pixel to coordinate: lng = west + (x / width) * (east - west);",
    "  with m(lat) = ln(tan(pi/4 + lat/2)) in radians, mTop = m(north), mBottom = m(south):",
    "  lat = 2 * atan(exp(mTop - (y / height) * (mTop - mBottom))) - pi/2, then convert to degrees.",
    "Both images share these bounds, so a pixel means the same place in each."
  ];
}

function captureLine(name, entry) {
  if (!entry) return name + ": not captured";
  if (entry.url) return name + ": " + entry.url + (entry.attribution ? "  (" + entry.attribution + ")" : "");
  return name + ": not captured (" + (entry.reason || "unknown") + ")";
}

/* The text the Routine is fired with. Order matters because fireClaudeRoutine cuts
   at 16000 characters: the operator's prompt, the facts, the captures and the contract
   come first; the diagnostics JSON takes whatever budget is left. */
export const ROUTINE_TEXT_LIMIT = 15500;

export function buildMapperDebugText({ job, failure, classified, prompt, captures, courseName, centre }) {
  const values = promptValues({ job, failure, classified, courseName, centre });
  const head = [
    fillPromptTemplate(prompt || failureKind(classified.kind).defaultPrompt, values).trim(),
    "",
    "--- failure ---",
    "failure_kind: " + classified.kind + " (" + classified.label + ")",
    "job_id: " + (job && job.id),
    "course_id: " + values.courseId,
    "course_name: " + values.courseName,
    "centre: " + values.centre,
    "kind: " + ((job && job.kind) || "automap"),
    "attempts: " + ((failure && failure.attempts) || 1),
    "error: " + String((failure && failure.message) || "").slice(0, 900),
    "osm_features: greens " + values.greens + ", fairways " + values.fairways + ", hole lines " + values.holes + ", numbered " + values.numberedHoles
      + ", scorecard " + (classified.evidence.scorecardFound ? "found" : "not found") + ", expected holes " + values.expectedHoles,
    "",
    "--- captures ---",
    captureLine("satellite", captures && captures.satellite),
    captureLine("osm", captures && captures.osm)
  ].concat(georeferenceLines(captures), [
    "",
    OUTPUT_CONTRACT,
    "",
    "Other courses may have failed in the same window and been throttled; check course_mapper_jobs for every status=failed row from the last hour, not only this one.",
    "",
    "--- diagnostics ---"
  ]).join("\n");
  const budget = Math.max(0, ROUTINE_TEXT_LIMIT - head.length - 1);
  const diagnostics = JSON.stringify((failure && failure.diagnostics) || null);
  return head + "\n" + (diagnostics.length > budget ? diagnostics.slice(0, budget) : diagnostics);
}

/* What Studio shows under the prompt editor, so the operator knows what follows their
   words. Built from the same builder with placeholder-looking facts, not a hand copy. */
export function routineTextOutline(kind) {
  const entry = failureKind(kind);
  return buildMapperDebugText({
    job: { id: "<job id>", course_id: "<course id>", kind: "automap" },
    failure: { message: "<error sentence>", attempts: 1, diagnostics: { note: "<the diagnostics the run saved>" } },
    classified: { kind: entry.kind, label: entry.label, evidence: { scorecardFound: true } },
    prompt: "<your prompt for this kind, placeholders filled>",
    captures: { satellite: { url: "<public png url>" }, osm: { url: "<public png url>" }, bounds: { north: 0, south: 0, west: 0, east: 0 }, width: 1024, height: 1024, zoom: 16 },
    courseName: "<course name>"
  });
}
