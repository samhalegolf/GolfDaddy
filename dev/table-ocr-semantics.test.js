/*
 * Headless tests for Stage 2 (header allocation) and Stage 3 (cell parsing +
 * validation) of clarity-table-ocr. Uses the real alias registry and the
 * ground-truth fixture. Proves headers map to the right metrics and that
 * garbage reads (e.g. launch=942031) are rejected before they can be saved.
 *
 * Run:  node dev/table-ocr-semantics.test.js
 */
require("../scripts/gd-launch-monitor-alias-registry.js"); // sets globalThis.LaunchMonitorAliasRegistry
const ocr = require("../scripts/clarity-table-ocr.js");
const resolver = globalThis.LaunchMonitorAliasRegistry.canonicalKey;

let allOk = true;
function check(name, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: got ${JSON.stringify(got)}${ok ? "" : `, expected ${JSON.stringify(expected)}`}`);
  if (!ok) allOk = false;
}

// ---- Stage 2: header allocation ----
const headers = ["BALL SPEED", "LAUNCH ANGLE", "SIDE ANGLE", "BACKSPIN", "SIDESPIN", "DESCENT ANGLE", "OFFLINE", "PEAK", "CARRY", "TOTAL", "TO PIN"];
const expectedKeys = ["ballSpeed", "launch", "sideAngle", "backspin", "sideSpin", "descent", "offline", "peakHeight", "carry", "total", "toPin"];
const cols = ocr.allocateHeaders(headers.map(() => ({})), headers, { resolver });
check("header allocation (11 real headers)", cols.map(c => c.metricKey), expectedKeys);

// Fuzzy: OCR typos still resolve.
const typos = ["BALL SPEED", "LAUNEH ANGLE", "SIOE ANGLE", "BACKSPlN"];
const fuzzy = ocr.allocateHeaders(typos.map(() => ({})), typos, { registry: globalThis.LaunchMonitorAliasRegistry });
check("fuzzy header resolve (typos)", fuzzy.map(c => c.metricKey), ["ballSpeed", "launch", "sideAngle", "backspin"]);

// Trim: a phantom club column on the left (no metric) is dropped.
const withClub = [{ metricKey: "" }, { metricKey: "ballSpeed" }, { metricKey: "launch" }, { metricKey: "carry" }];
check("trim phantom club/edge columns", ocr.trimUnresolvedEdges(withClub).map(c => c.metricKey), ["ballSpeed", "launch", "carry"]);

// ---- Stage 3: cell parsing + validation ----
function cell(text, key) { const r = ocr.parseCell(text, key); return { v: r.value, d: r.direction, valid: r.valid }; }

check("94.4 ballSpeed", cell("94.4", "ballSpeed"), { v: 94.4, d: "", valid: true });
check("11.2 deg launch", cell("11.2°", "launch"), { v: 11.2, d: "", valid: true });
check("3.7 deg R side angle", cell("3.7°R", "sideAngle"), { v: 3.7, d: "R", valid: true });
check("377 L sidespin", cell("377 L", "sideSpin"), { v: 377, d: "L", valid: true });
check("1018 L sidespin (was garbled)", cell("1018 L", "sideSpin"), { v: 1018, d: "L", valid: true });
check("4596 backspin", cell("4596", "backspin"), { v: 4596, d: "", valid: true });
check("19.2 L offline", cell("19.2 L", "offline"), { v: 19.2, d: "L", valid: true });
check("implied decimal 112 -> 11.2 launch", cell("112", "launch"), { v: 11.2, d: "", valid: true });

// The failure that started all this: a fused/garbled launch read must be rejected.
check("GARBAGE launch=942031 rejected", cell("942031", "launch").valid, false);
check("dash cell rejected", cell("-", "offline").valid, false);
check("empty cell rejected", cell("", "carry").valid, false);

// ---- End-to-end sanity against the ground truth ----
const truth = require("./fixtures/launch-monitor-7i.groundtruth.json");
let gtOk = 0, gtTotal = 0;
truth.rows.forEach(row => {
  [["ballSpeed", "ballSpeed"], ["launchAngle", "launch"], ["backspin", "backspin"], ["sideSpin", "sideSpin"], ["carry", "carry"], ["total", "total"]].forEach(([field, key]) => {
    gtTotal += 1;
    if (ocr.parseCell(String(row[field]), key).valid) gtOk += 1;
  });
});
check(`ground-truth values all plausible (${gtOk}/${gtTotal})`, gtOk, gtTotal);

console.log(allOk ? "\nALL TESTS PASSED" : "\nTESTS FAILED");
process.exit(allOk ? 0 : 1);
