/*
  Course Data screen wiring — structural assertions in the style of the other
  *-owner tests. Run: node dev/course-data-screen-wiring.test.js

  The analysis modules are unit-tested elsewhere. What can still go wrong is the
  join: the screen feeding the analysis a different frame from the one it draws,
  or quietly growing a second copy of the geometry. These pin the join.
*/

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
function read(relative) { return fs.readFileSync(path.join(ROOT, relative), "utf8"); }

const graph = read("scripts/gd-route-audit.js");
const html = read("index.html");
const css = read("styles/inline/gd-shot-data-visual-polish-v1.css");
const scoreSource = read("scripts/course-data/gd-course-transfer-score.js");
const insightSource = read("scripts/course-data/gd-course-implementation-insight.js");

// --- Both modules ship, in dependency order ---------------------------------
{
  const order = [
    "scripts/course-data/gd-course-data-comparison.js",
    "scripts/course-data/gd-course-transfer-score.js",
    "scripts/course-data/gd-course-implementation-insight.js"
  ];
  let previous = -1;
  order.forEach((file) => {
    const at = html.indexOf(file);
    assert(at !== -1, `index.html loads ${file}`);
    assert(at > previous, `index.html loads ${file} after its dependencies`);
    previous = at;
  });

  // The play surface records shots; it does not score them.
  const appHtml = read("app/index.html");
  assert(!appHtml.includes("gd-course-transfer-score.js"), "the score layer does not ship on the play surface");
  assert(!appHtml.includes("gd-course-implementation-insight.js"), "nor does the insight layer");
}

// --- The analysis runs on the drawn frame, against the drawn bubble ---------
{
  assert(graph.includes("const courseEllipse=courseGeo?"), "the screen builds the bubble it draws into an ellipse spec");
  assert(
    graph.includes("rx:courseGeo.baseRx,ry:courseGeo.baseRy"),
    "the analysis grows from the 100% radii, not from the already-scaled ones"
  );
  assert(
    graph.includes("tiltDeg:courseGeo.tilt"),
    "the drawn tilt is handed to the analysis, so inside means the same thing in both"
  );
  assert(
    graph.includes("yAxisDown:true"),
    "the screen declares that its y axis grows downwards, so Short and Long are not inverted"
  );
}

// --- One inside/outside test on the screen ----------------------------------
{
  assert(
    graph.includes("mod.isPointInsideScaledBubble(point,courseEllipse,courseBubbleScale*100)"),
    "dot hydration asks the score module rather than repeating the ellipse maths"
  );
  // The rotated-ellipse expression must not reappear anywhere on this surface.
  const copies = (graph.match(/ux\*ux\)\/\(/g) || []).length;
  assert.strictEqual(copies, 0, "the screen holds no second copy of the rotated-ellipse test");
}

// --- Nothing on this screen resizes the plan --------------------------------
{
  // The slider is gone, and so is every part of it. It was the screen's most
  // misread control: the score came from the automatically found threshold, so
  // dragging moved the picture and not the number and the two looked wrong
  // together. What must not happen is half a removal - a live DOM-patching path
  // left behind would now patch figures the range filter is supposed to own.
  ["gdCourseBubbleApplyScale", "gdCourseBubbleScaleChanged", "gdCourseScaleMarkerHTML",
   "gdCourseBubbleScaleControlHTML", "gd_course_bubble_scale"].forEach((symbol) => {
    assert(!graph.includes(symbol), `the bubble slider is fully removed (${symbol})`);
  });
  assert(graph.includes("const courseBubbleScale=GD_COURSE_BUBBLE_SCALE"), "the bubble draws at its preset size");
  [".gdCourseScaleMarker", ".gdCourseScaleTrack", ".gdCourseScaleSlider"].forEach((selector) => {
    assert(!css.includes(selector), `${selector} went with the slider`);
  });
}

// --- The range filter cuts the rows, and cuts them once ---------------------
{
  assert(
    graph.includes("const records=gdCourseRecordsInRange(suppliedRecords,rangeKey)"),
    "the range filter runs on the incoming rows, before any position is computed"
  );
  const filterAt = graph.indexOf("gdCourseRecordsInRange(suppliedRecords");
  const analyseAt = graph.indexOf("mod.analyse(points,courseEllipse");
  assert(filterAt !== -1 && analyseAt > filterAt, "the analysis sees the filtered subset, not the full set");
  assert(graph.includes('"gd_course_data_range_v1"'), "the choice persists under the agreed key");
  assert(graph.includes("updatedAt"), "stored the same shape as the other course-data preference");
  // No second maths path per pill: the pills only pick a cutoff.
  assert(!/gdCourseRange[A-Za-z]*\s*=[^\n]*transferScore/.test(graph), "no pill computes its own score");
}

// --- Behaviour: the range filter, run for real ------------------------------
{
  // Source assertions cannot catch a preference that reads back wrong, and this
  // one decides which shots exist - a silent fallback to the wrong window would
  // change every figure on the screen without erroring anywhere.
  const vm = require("vm");
  const block = graph.slice(
    graph.indexOf("  const GD_COURSE_RANGE_KEY="),
    graph.indexOf("  function gdCourseDataSurfaceSvg(")
  );
  assert(block.length > 500, "the range block was found");

  let store = {};
  const sandbox = {
    console, Date, Array, Number, Math, JSON,
    safe: (fn, fallback) => { try { const v = fn(); return v === undefined ? fallback : v; } catch (e) { return fallback; } },
    gdEscapeHTML: (s) => String(s),
    gdCourseImplementationInsight: () => null,
    gdStatsShotTime: (r) => { const t = Date.parse((r && r.timestamp) || ""); return Number.isFinite(t) ? t : 0; },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; }
    }
  };
  sandbox.window = sandbox;
  vm.runInNewContext(
    block + "\nthis.__api={gdCourseRangeKey,gdCourseSetRangeKey,gdCourseRangeRowHTML,gdCourseRecordsInRange};",
    sandbox
  );
  const api = sandbox.__api;

  assert.strictEqual(api.gdCourseRangeKey(), "month", "month is the default with nothing stored");
  api.gdCourseSetRangeKey("year");
  assert.strictEqual(api.gdCourseRangeKey(), "year", "the choice persists");
  assert(JSON.parse(store.gd_course_data_range_v1).updatedAt, "stored as a blob with updatedAt");
  api.gdCourseSetRangeKey("nonsense");
  assert.strictEqual(api.gdCourseRangeKey(), "month", "an unknown range falls back to the default");
  store.gd_course_data_range_v1 = "{ not json";
  assert.strictEqual(api.gdCourseRangeKey(), "month", "so does unreadable storage");

  const DAY = 24 * 60 * 60 * 1000;
  const stamp = (days) => ({ timestamp: new Date(Date.now() - days * DAY).toISOString() });
  const rows = [stamp(2), stamp(20), stamp(200), { timestamp: "" }];
  assert.strictEqual(api.gdCourseRecordsInRange(rows, "week").length, 2, "a week keeps the recent row");
  assert.strictEqual(api.gdCourseRecordsInRange(rows, "month").length, 3, "a month reaches further back");
  assert.strictEqual(api.gdCourseRecordsInRange(rows, "year").length, 4, "a year holds all of them");
  assert.strictEqual(api.gdCourseRecordsInRange(rows, "all").length, 4, "and All applies no cutoff at all");
  // An undated row is never binned: dropping it would leave the graph and the
  // shot list disagreeing about how many shots there are.
  assert(api.gdCourseRecordsInRange(rows, "week").some((r) => !r.timestamp), "an undated row survives every range");

  store.gd_course_data_range_v1 = JSON.stringify({ range: "week" });
  assert(
    /gdCourseRangePill active" aria-pressed="true" onclick="return gdCourseRangeChanged\('week'\)/.test(api.gdCourseRangeRowHTML()),
    "the stored range is the lit pill"
  );
}

// --- The insight sits under the graph ---------------------------------------
{
  assert(
    graph.includes("</div>${gdCourseInsightHTML(courseAnalysis)}`"),
    "the insight area is emitted after the chart wrap, under the graph"
  );
  assert(
    graph.indexOf("gdCourseRangeRowHTML()") < graph.indexOf('<div class="gdCourseChartWrap">'),
    "the range row is emitted above the chart"
  );
  [".gdCourseInsight", ".gdCourseRangePill", ".gdCourseRailSeg"].forEach((selector) => {
    assert(css.includes(selector), `${selector} is styled`);
  });
  // The score's colour is a band the insight module named, resolved to a hex in
  // the stylesheet. The screen maps tone to an attribute and stops there.
  assert(graph.includes('data-tone="${gdEscapeHTML(score.tone'), "the screen carries the tone, it does not choose it");
  ["#ff5a5f", "#ffb347", "#37f28d"].forEach((hex) => {
    assert(css.includes(`[data-tone=`) && css.includes(hex), `${hex} is held by the stylesheet`);
  });
  // Same rule for the rail: each segment wears the band it sits in, and the
  // screen is handed that band rather than working out where red becomes amber.
  assert(graph.includes('data-band="${gdEscapeHTML(seg.band)}"'), "the rail's bands come built");
  const railBlock = graph.slice(graph.indexOf("const rail="), graph.indexOf("const note="));
  ["4", "7", "#"].forEach((token) => {
    assert(!railBlock.includes(token), `the screen holds no second copy of the band table (${token})`);
  });
  ['[data-band="low"]', '[data-band="mid"]', '[data-band="high"]'].forEach((selector) => {
    assert(css.includes(selector), `${selector} is styled`);
  });
}

// --- The quadrant read is drawn, not recomputed -----------------------------
{
  ["longLeftShare", "longRightShare", "shortLeftShare", "shortRightShare"].forEach((key) => {
    assert(graph.includes(`courseAnalysis.${key}`), `the ${key} corner reads the analysis`);
  });
  assert(
    graph.includes("courseAnalysis.config?.quadrantThresholds?.noticeableMinPercent"),
    "the colour threshold is read from the config, never written as a literal 35"
  );
  const quadrant = graph.slice(graph.indexOf("const quadrantSvg="), graph.indexOf("const courseBubbleSvg="));
  assert(quadrant.length > 400, "the quadrant layer was found");
  // It draws the analysis. It never walks the shots again - a second pass over
  // the rows here is how a corner ends up disagreeing with the score above it.
  ["plottedRows", "relativeRows", "dataRows", "records"].forEach((rows) => {
    assert(!quadrant.includes(rows), `the quadrant layer does not re-walk ${rows}`);
  });
  assert(
    graph.indexOf("${quadrantSvg}") < graph.indexOf("${courseBubbleSvg}"),
    "the wash is drawn before the bubble, so dots and the ellipse stay on top"
  );
}

// --- The graph shows the player, and says nothing twice ---------------------
{
  assert(!graph.includes("gdCourseContainmentPct"), "containment moved off the graph into the info tab");
  assert(!graph.includes("gdCourseContainmentSub"), "and so did its sub-line");
  assert(
    !graph.includes('gdShotDataGraphTitle("Course Data")'),
    "the card header says Course Data; the graph does not repeat it"
  );
  assert(!graph.includes("Every club, scaled"), "the subtitle went with it");
  assert(graph.includes("gdShotDataPlayerLabel()"), "the graph carries the player name only");
  // The club key belongs to a distinction this screen no longer draws.
  assert(!graph.includes("clubColourMap"), "the Course Data call site deals no club colours");
  assert(
    graph.includes('const clubKeySvg=typeof opts?.keySvg==="string"?opts.keySvg:""'),
    "a caller colouring by something else still supplies its own key"
  );
  assert(graph.includes("GD_COURSE_DOT_INSIDE"), "dots are neutral: inside or outside, nothing else");
}

// --- No copy anywhere but the insight layer ---------------------------------
{
  assert(
    graph.includes("mod.buildCourseInsight(analysis)"),
    "every sentence on the screen comes from the insight module"
  );
  [
    "alignment appears", "finished left", "finished short", "well matched", "bubble growth",
    // The score block's own two sentences. Both are short enough to look
    // harmless inlined into the markup, which is exactly how the copy rules
    // stop applying to them.
    "finished inside the bubble", "how close your course performance"
  ].forEach((phrase) => {
    assert(!graph.includes(phrase), `the screen must not phrase its own copy ("${phrase}")`);
  });
}

// --- The unread reading object is gone, not left lying around ---------------
{
  assert(
    !graph.includes("gdCourseBubbleReading"),
    "the old published-but-never-read reading object was removed, not kept alongside the analysis"
  );
  assert(graph.includes("window.gdCourseBubbleAnalysis"), "the full analysis is what gets published now");
}

// --- Layer boundaries -------------------------------------------------------
{
  assert(!scoreSource.includes("document."), "the score layer touches no DOM");
  assert(!insightSource.includes("document."), "the insight layer touches no DOM");
  assert(!scoreSource.includes("gdCourse"), "the score layer knows nothing about the screen that calls it");
}

console.log("course-data-screen-wiring tests passed");
