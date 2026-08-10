/*
 * Generates scripts/gd-course-visual-client.js — the play/capture subset of the
 * course visual engine, for the phone build.
 *
 * gd-course-visual-engine.js is 240KB and the app surface uses six methods of
 * it. The rest is authoring: building masters and previews, presets, stitching,
 * terrain/floodlight/birds-eye rendering, publishing and cloud sync. That work
 * happens in the browser studio, and published frames are rendered server-side
 * by the worker, so GPS play only ever reads records and caches capture pixels.
 *
 * Why a generated subset instead of splitting the closure in two:
 *
 * The dependency between the halves is strictly one-directional - the play
 * closure never calls an authoring function (verified: seam of 0) - so a real
 * split is possible. But the two halves share mutable module state
 * (transientAssetDataByPath, and the caches around it), and splitting a closure
 * that renders course visuals is exactly the kind of change that produces a
 * subtle, only-visible-on-a-course bug. This instead copies the needed functions
 * VERBATIM into their own closure, and dev/visual-engine-client.test.js asserts
 * every copied function is byte-identical to the engine's. Divergence becomes a
 * CI failure rather than a maintenance hazard, and the engine stays the single
 * authoritative source.
 *
 * Only one of the two ever loads: index.html marks the engine
 * data-gd-surface="studio" and the client data-gd-surface="app", so each build
 * has exactly one GDCourseVisualEngine.
 *
 * Run: node dev/generate-visual-engine-client.js  (after editing the engine)
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ENGINE = path.join(ROOT, "scripts", "gd-course-visual-engine.js");
const CLIENT = path.join(ROOT, "scripts", "gd-course-visual-client.js");

/* What the app surface actually calls, plus the read/cache methods next to them
   that cost nothing extra because they are already inside the closure. Anything
   added here must not pull in authoring code - the generator reports the size so
   a mistake is visible. */
const PLAY_API = [
  "captureImagePath", "saveCaptureImage", "loadCaptureImage", "hydrateCaptureImages",
  "getRecord", "resolveCourseVisual", "pullCourseVisual", "loadStore", "saveStore",
  "beta3dTiltPolicy",
  /* Cloud frames - the app surface's visual source. All consumers: read the build state,
     start a build, download frames, read cached ones, and fill a record's assets from the
     store so a downloaded frame reaches the renderer (and reaches it offline). None of them
     author anything. */
  "courseAssetUrl", "courseBuildState", "requestCourseBuild",
  "cachedCourseFrames", "downloadCourseFrames", "ensureCourseFrames",
  "hydrateCourseVisualAssets"
];
/* Constants the API object exposes as values rather than functions. */
const CONSTANTS = ["version:VERSION", "rendererVersion:RENDERER_VERSION", "storeKey:STORE_KEY",
  "presetKey:PRESET_KEY", "apiEndpoint:API_ENDPOINT", "jobsEndpoint:JOBS_ENDPOINT",
  "assetEndpoint:ASSET_ENDPOINT", "framesWaitMode:FRAMES_WAIT_MODE"];

/* Top-level function declarations inside the factory (two-space indent). */
function parseFunctions(lines) {
  const out = new Map();
  lines.forEach((line, i) => {
    const match = /^ {2}function ([A-Za-z0-9_$]+)\s*\(/.exec(line);
    if (!match) return;
    let depth = 0;
    let started = false;
    for (let j = i; j < lines.length; j += 1) {
      for (const ch of lines[j]) {
        if (ch === "{") { depth += 1; started = true; }
        else if (ch === "}") depth -= 1;
      }
      if (started && depth <= 0) {
        out.set(match[1], { start: i, end: j, source: lines.slice(i, j + 1).join("\n") });
        return;
      }
    }
  });
  return out;
}

/* Module-level `var NAME=...` declarations, i.e. those outside every function. */
function parseModuleVars(lines, functions) {
  const inside = new Set();
  for (const info of functions.values()) {
    for (let i = info.start; i <= info.end; i += 1) inside.add(i);
  }
  const out = new Map();
  lines.forEach((line, i) => {
    if (inside.has(i)) return;
    const match = /^ {2}(?:var|let|const) ([A-Za-z0-9_$]+)\s*=/.exec(line);
    if (match) out.set(match[1], line);
  });
  return out;
}

const source = fs.readFileSync(ENGINE, "utf8");
const lines = source.split("\n");
const functions = parseFunctions(lines);
const moduleVars = parseModuleVars(lines, functions);

const missing = PLAY_API.filter((name) => !functions.has(name));
if (missing.length) throw new Error("engine no longer defines: " + missing.join(", "));

/* Transitive closure of the play API over the call graph. */
const needed = new Set();
const stack = PLAY_API.slice();
while (stack.length) {
  const name = stack.pop();
  if (needed.has(name)) continue;
  needed.add(name);
  const body = functions.get(name).source;
  for (const other of functions.keys()) {
    if (other !== name && !needed.has(other) && new RegExp("\\b" + other + "\\b").test(body)) stack.push(other);
  }
}

/* Emit in the engine's own declaration order, so the generated file reads as a
   subset of the original rather than a reshuffle. */
const kept = [...functions.keys()].filter((name) => needed.has(name));
const keptSource = kept.map((name) => functions.get(name).source);
const allBodies = keptSource.join("\n");
const keptVars = [...moduleVars.entries()]
  .filter(([name]) => new RegExp("\\b" + name + "\\b").test(allBodies) ||
    CONSTANTS.some((entry) => entry.endsWith(":" + name)))
  .map(([, line]) => line);

const api = CONSTANTS.concat(PLAY_API.map((name) => name + ":" + name));

const output = `/* Clarity Caddy course visual engine - PLAY/CAPTURE CLIENT.

   APP SURFACE ONLY. index.html loads this with data-gd-surface="app" and the full
   engine with data-gd-surface="studio", so exactly one GDCourseVisualEngine
   exists per build. See docs/APP_STUDIO_SPLIT.md.

   The phone reads course visual records and caches capture pixels; it does not
   author them. Authoring - masters, previews, presets, stitching, terrain and
   floodlight rendering, publishing, cloud sync - is ${Math.round((source.length - allBodies.length) / 1024)}KB of
   gd-course-visual-engine.js that only the studio needs, and published frames
   are rendered server-side by the worker anyway.

   GENERATED by dev/generate-visual-engine-client.js - do not hand-edit. Every
   function below is copied verbatim from the engine and
   dev/visual-engine-client.test.js fails if any of them drifts. Change the
   engine, then re-run the generator. */
(function(root,factory){
  if(typeof module==="object"&&module.exports)module.exports=factory();
  else root.GDCourseVisualEngine=factory(root);
})(typeof window!=="undefined"?window:globalThis,function(root){
  "use strict";
  root=root||typeof window!=="undefined"&&window||typeof globalThis!=="undefined"&&globalThis||{};

${keptVars.join("\n")}

${keptSource.join("\n")}

  return {
${api.map((entry) => "    " + entry).join(",\n")}
  };
});
`;

fs.writeFileSync(CLIENT, output);
console.log(
  "play/capture client: " + kept.length + " of " + functions.size + " engine functions, " +
  keptVars.length + " module vars"
);
console.log(
  "  engine " + Math.round(source.length / 1024) + "KB  ->  client " +
  Math.round(output.length / 1024) + "KB"
);
console.log("  API: " + PLAY_API.join(", "));
