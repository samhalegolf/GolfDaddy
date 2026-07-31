/*
 * The play/capture client stays a faithful subset of the course visual engine.
 *
 * scripts/gd-course-visual-client.js is a generated copy of the 48 engine
 * functions GPS play and on-course capture need. The phone loads it; the studio
 * loads the full 240KB engine. That is only safe while the copies are identical
 * — a fix applied to the engine and not regenerated would leave the phone running
 * the old behaviour, and it would look completely fine in the studio, which is
 * where the tuning is done. That failure mode is why this compares bodies byte
 * for byte instead of just checking the file exists.
 *
 * Regenerate with: node dev/generate-visual-engine-client.js
 * Run: node dev/visual-engine-client.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const engineSource = fs.readFileSync(path.join(ROOT, "scripts", "gd-course-visual-engine.js"), "utf8");
const clientSource = fs.readFileSync(path.join(ROOT, "scripts", "gd-course-visual-client.js"), "utf8");
const index = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function parseFunctions(source) {
  const lines = source.split("\n");
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
      if (started && depth <= 0) { out.set(match[1], lines.slice(i, j + 1).join("\n")); return; }
    }
  });
  return out;
}

const engineFns = parseFunctions(engineSource);
const clientFns = parseFunctions(clientSource);

test("the client is a strict subset of the engine", () => {
  assert.ok(clientFns.size > 20, "client has only " + clientFns.size + " functions — generation looks broken");
  const extra = [...clientFns.keys()].filter((name) => !engineFns.has(name));
  assert.deepStrictEqual(extra, [], "client defines functions the engine does not: " + extra.join(", "));
});

test("every copied function is byte-identical to the engine's", () => {
  const drifted = [...clientFns.entries()]
    .filter(([name, body]) => engineFns.get(name) !== body)
    .map(([name]) => name);
  assert.deepStrictEqual(
    drifted, [],
    "these have diverged — re-run `node dev/generate-visual-engine-client.js`: " + drifted.join(", ")
  );
});

test("the client is closed — it calls nothing it does not define", () => {
  /* An authoring function reachable from the client would be a ReferenceError on
     a phone the moment that path ran, and nothing in the studio would show it. */
  const bodies = [...clientFns.values()].join("\n");
  const dangling = [...engineFns.keys()]
    .filter((name) => !clientFns.has(name))
    .filter((name) => new RegExp("\\b" + name + "\\s*\\(").test(bodies));
  assert.deepStrictEqual(dangling, [], "client calls engine-only functions: " + dangling.join(", "));
});

test("the client exposes the methods the app surface calls", () => {
  /* Kept in step with the real consumers rather than assumed: these are the
     methods gd-app-core.js and gd-captured-hole-frame-camera-v19.js invoke. */
  ["captureImagePath", "saveCaptureImage", "getRecord", "resolveCourseVisual", "pullCourseVisual"]
    .forEach((name) => {
      assert.ok(
        new RegExp("^\\s+" + name + ":" + name + ",?$", "m").test(clientSource),
        "client does not export " + name + ", which the app surface calls"
      );
    });
});

test("no app-surface script calls an authoring method", () => {
  const authoring = [...engineFns.keys()].filter((name) => !clientFns.has(name));
  const appScripts = fs.readdirSync(path.join(ROOT, "scripts"))
    .filter((name) => name.endsWith(".js") && name !== "gd-course-visual-engine.js")
    .map((name) => path.join(ROOT, "scripts", name))
    .concat(fs.readdirSync(path.join(ROOT, "scripts", "inline"))
      .filter((name) => name.endsWith(".js"))
      .map((name) => path.join(ROOT, "scripts", "inline", name)));
  const offenders = [];
  for (const file of appScripts) {
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes("GDCourseVisualEngine")) continue;
    for (const name of authoring) {
      if (new RegExp("(?:GDCourseVisualEngine|engine)\\s*\\??\\.\\s*" + name + "\\b").test(text)) {
        offenders.push(path.relative(ROOT, file) + " -> " + name);
      }
    }
  }
  assert.deepStrictEqual(
    offenders, [],
    "these run on the phone but call studio-only engine methods:\n        " + offenders.join("\n        ")
  );
});

test("exactly one engine loads per surface", () => {
  assert.ok(
    /data-gd-surface="app" src="scripts\/gd-course-visual-client\.js/.test(index),
    "the client is not marked app-only, so the studio would load two engines"
  );
  assert.ok(
    /data-gd-surface="studio" src="scripts\/gd-course-visual-engine\.js/.test(index),
    "the full engine is not marked studio-only, so the phone would still ship it"
  );
});

let failed = 0;
tests.forEach((entry) => {
  try {
    entry.fn();
    console.log("  ok  " + entry.name);
  } catch (error) {
    failed += 1;
    console.error("  FAIL  " + entry.name + "\n        " + (error && error.message));
  }
});
if (failed) process.exit(1);
console.log("visual-engine-client passed: " + tests.length + " checks");
