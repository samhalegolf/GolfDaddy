#!/usr/bin/env node
/* Turns dev/fixtures/bubble-engine-parity.json into a Monkey C constant table.
 *
 * WHY A GENERATOR AND NOT A READ. The JavaScript half reads the fixture with
 * require(), and the Swift half walks up from #filePath to find the very same
 * file — neither copies it, because a copied fixture is a second source of
 * truth. Monkey C cannot do that: there is no filesystem a .prg can read from
 * and no JSON parser in the SDK. A watch app only has data that was compiled
 * into it or arrived over a message. So the fixture has to become source code,
 * and the protection against drift moves from "there is only one file" to
 * "the generated file is checked against the one file in CI":
 *
 *     node dev/generate-garmin-parity-fixture.js            rewrite it
 *     node dev/generate-garmin-parity-fixture.js --check    fail if stale
 *
 * The --check form runs inside `npm run test:garmin`, so editing the fixture
 * without regenerating fails a test rather than quietly testing the old
 * numbers on the wrist.
 *
 * EVERY NUMBER IS EMITTED AS A STRING, and the harness calls toDouble() on it.
 * That is not fussiness. A bare `-36.9168751` in Monkey C source is a Float —
 * 32-bit, ~7 significant digits — and these latitudes have nine. The fixture's
 * coordinate tolerance is 1e-7 degrees (~11mm), so a Float literal would lose
 * the comparison before the engine ever ran, and the failure would look like
 * an engine bug. String -> toDouble() parses at full Double precision and, as
 * a bonus, the generated file shows the fixture's exact decimal text.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FIXTURE = path.join(ROOT, "dev", "fixtures", "bubble-engine-parity.json");
const OUT = path.join(ROOT, "garmin", "source", "Test", "GarminParityFixture.mc");
const REL_FIXTURE = "dev/fixtures/bubble-engine-parity.json";
const REL_SELF = "dev/generate-garmin-parity-fixture.js";

/* A number as Monkey C source: a quoted decimal the harness parses. Written
   out of the JSON's own text where possible so the generated file can be read
   against the fixture by eye. */
function num(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("not a finite number: " + JSON.stringify(value));
  }
  return '"' + String(value) + '"';
}

function str(value) {
  if (value === null || value === undefined) return "null";
  return JSON.stringify(String(value));
}

function coord(c) {
  if (!c) return "null";
  return "[" + num(c.lat) + ", " + num(c.lng) + "]";
}

function coordList(list) {
  if (!list || !list.length) return "[]";
  return "[\n" + list.map(c => "                " + coord(c)).join(",\n") + "\n            ]";
}

/* The bag the WRIST is given. Deliberately expect.bagSent, not input.bag: the
   phone resolves the ghost stand-in and the roll-out totals before anything
   leaves it, so a wrist that started from input.bag would be answering a
   different question than the one the fixture asks. Same choice the Swift
   half makes. */
function bagRows(bagSent) {
  return "[\n" + bagSent.map(row =>
    "                [" + str(row.club) + ", " + num(row.carryM) + ", " + num(row.totalM) + "]"
  ).join(",\n") + "\n            ]";
}

function caseFunction(index, entry) {
  const input = entry.input;
  const expect = entry.expect;
  const bubble = input.bubble || null;
  const lines = [];
  lines.push("    // " + entry.name);
  (Array.isArray(entry.why) ? entry.why : [entry.why || ""]).forEach(w => {
    String(w).replace(/(.{1,72})(\s|$)/g, (m, chunk) => { lines.push("    // " + chunk.trim()); return m; });
  });
  lines.push("    function case" + index + "() {");
  lines.push("        return {");
  lines.push("            \"name\" => " + str(entry.name) + ",");
  lines.push("            \"bag\" => " + bagRows(expect.bagSent) + ",");
  lines.push("            \"ghostBag\" => " + (expect.ghostBag ? "true" : "false") + ",");
  lines.push("            \"offsetDeg\" => " + num(bubble ? bubble.offsetDeg : null) + ",");
  lines.push("            \"handedness\" => " + str(bubble ? bubble.handedness : null) + ",");
  lines.push("            \"green\" => " + coord(input.hole.green) + ",");
  lines.push("            \"route\" => " + coordList(input.hole.route) + ",");
  lines.push("            \"player\" => " + coord(input.player) + ",");
  lines.push("            \"target\" => " + coord(input.target) + ",");
  lines.push("            \"expect\" => {");
  lines.push("                \"defaultTarget\" => " + coord(expect.defaultTarget) + ",");
  lines.push("                \"targetDistanceM\" => " + num(expect.targetDistanceM) + ",");
  lines.push("                \"shotBearingDeg\" => " + num(expect.shotBearingDeg) + ",");
  lines.push("                \"club\" => " + str(expect.club) + ",");
  lines.push("                \"carryM\" => " + num(expect.carryM) + ",");
  lines.push("                \"totalM\" => " + num(expect.totalM) + ",");
  lines.push("                \"aimOffsetDeg\" => " + num(expect.aimOffsetDeg) + ",");
  lines.push("                \"visualWidthM\" => " + num(expect.visualWidthM) + ",");
  lines.push("                \"visualDepthM\" => " + num(expect.visualDepthM) + ",");
  lines.push("                \"visualTiltDeg\" => " + num(expect.visualTiltDeg) + ",");
  lines.push("                \"bubbleCentre\" => " + coord(expect.bubbleCentre) + ",");
  lines.push("                \"ringResolution\" => " + expect.ringResolution + ",");
  lines.push("                \"ringSample\" => " + coordList(expect.ringSample).replace(/^ {16}/gm, "                    ") + "");
  lines.push("            }");
  lines.push("        };");
  lines.push("    }");
  return lines.join("\n");
}

function generate() {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  const cases = fixture.cases || [];
  const t = fixture.tolerances || {};

  const head = [
    "// GENERATED FILE — DO NOT EDIT BY HAND.",
    "//",
    "//     source:    " + REL_FIXTURE,
    "//     generator: " + REL_SELF,
    "//     regenerate: node " + REL_SELF,
    "//",
    "// The fixture is one file read by three engines: the JavaScript one it was",
    "// recorded from (dev/bubble-engine-parity.test.js), the Swift wrist engine",
    "// (ios/WatchBubbleEngine/Tests/.../BubbleEngineParityTests.swift, which",
    "// walks up to the same path), and this one. Monkey C cannot read a file, so",
    "// this table is the fixture compiled in — and `npm run test:garmin` fails if",
    "// it has fallen behind the JSON.",
    "//",
    "// Numbers are STRINGS parsed with toDouble() at runtime: a bare decimal",
    "// literal in Monkey C is a 32-bit Float, and a nine-significant-digit",
    "// latitude compared at a 1e-7 tolerance cannot survive that.",
    "//",
    "// Annotated (:parity) so it is excluded from every ordinary build — see",
    "// monkey.jungle. It is compiled only by `CIQ_PARITY=1 ./build.sh build`.",
    "(:parity)",
    "module GarminParityFixture {",
    "",
    "    function bubbleEngineVersion() { return " + str(fixture.bubbleEngineVersion) + "; }",
    "",
    "    // Per-field, because 0.1 means different things to a metre, a degree",
    "    // and a latitude. Same four the other two harnesses use.",
    "    function toleranceMetres()    { return " + num(t.metres) + "; }",
    "    function toleranceDegrees()   { return " + num(t.degrees) + "; }",
    "    function toleranceDistanceM() { return " + num(t.distanceM) + "; }",
    "    function toleranceCoord()     { return " + num(t.coordinate) + "; }",
    "",
    "    function count() { return " + cases.length + "; }",
    "",
    "    function caseAt(index) {"
  ];
  cases.forEach((_, i) => {
    head.push("        if (index == " + i + ") { return case" + i + "(); }");
  });
  head.push("        return null;");
  head.push("    }");
  head.push("");

  const body = cases.map((entry, i) => caseFunction(i, entry)).join("\n\n");
  return head.join("\n") + body + "\n}\n";
}

const generated = generate();
const check = process.argv.includes("--check");
const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : null;

if (check) {
  if (existing === generated) {
    console.log("ok   " + path.relative(ROOT, OUT) + " is current");
    process.exit(0);
  }
  console.error("FAIL " + path.relative(ROOT, OUT) + " is stale against " + REL_FIXTURE +
    "\n     regenerate with: node " + REL_SELF);
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, generated);
console.log("wrote " + path.relative(ROOT, OUT) + " (" + (JSON.parse(fs.readFileSync(FIXTURE, "utf8")).cases || []).length + " cases)");
