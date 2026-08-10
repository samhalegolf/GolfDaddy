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

// --- Dragging the slider never restates the score ---------------------------
{
  const drag = graph.slice(
    graph.indexOf("function gdCourseBubbleApplyScale"),
    graph.indexOf("function gdCourseBubbleScaleChanged")
  );
  assert(drag.length > 200, "the live drag handler was found");
  assert(drag.includes("analysis.currentSliderCoverage"), "dragging restates what the current size holds");
  assert(!drag.includes("transferScore"), "dragging must never touch the transfer score");
  assert(!drag.includes("requiredScalePercent"), "nor the automatically found threshold");
  assert(!drag.includes("alignmentBias"), "nor any directional conclusion");
}

// --- The threshold is visible, and the insight sits under the graph ---------
{
  assert(graph.includes("function gdCourseScaleMarkerHTML"), "the slider carries a threshold marker");
  assert(
    graph.includes("gdCourseBubbleScaleControlHTML(courseAnalysis)"),
    "the marker is fed the analysis it marks"
  );
  assert(
    graph.includes("</div>${gdCourseInsightHTML(courseAnalysis)}`"),
    "the insight area is emitted after the chart wrap, under the graph"
  );
  [".gdCourseScaleMarker", ".gdCourseScaleTrack", ".gdCourseInsight"].forEach((selector) => {
    assert(css.includes(selector), `${selector} is styled`);
  });
}

// --- No copy anywhere but the insight layer ---------------------------------
{
  assert(
    graph.includes("mod.buildCourseInsight(analysis)"),
    "every sentence on the screen comes from the insight module"
  );
  ["alignment appears", "finished left", "finished short", "well matched", "bubble growth"].forEach((phrase) => {
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
