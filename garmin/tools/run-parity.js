#!/usr/bin/env node
/* Runs the Bubble Engine parity fixtures on the simulated watch and reports.
 *
 *     node garmin/tools/run-parity.js              # approachs62
 *     CIQ_DEVICE=fenix6 node garmin/tools/run-parity.js
 *
 * Needs the Connect IQ simulator already running (`connectiq &`) — this
 * pushes an app to it, it does not start it. Exits 0 on PASS, 1 on anything
 * else, so it can gate a commit.
 *
 * WHY IT SHELLS OUT TO monkeydo AND READS STDOUT. There is no way to get a
 * value back out of a .prg. `monkeyc -t` builds a unit-test binary, but its
 * results land in the simulator's own console window rather than on a pipe,
 * which is why the fixtures went unrun for so long. What does come back is
 * System.println: when monkeydo is launched from a shell against an
 * already-running simulator, the app's prints arrive on monkeydo's stdout.
 * So GarminParityHarness prints its verdict on a line of its own and this
 * reads it. Ugly, and the only thing that works.
 *
 * Nothing here ships. The harness and its fixture table are annotated
 * (:parity) and compiled only by `CIQ_PARITY=1 ./build.sh build`.
 */
"use strict";
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const GARMIN = path.join(__dirname, "..");
const DEVICE = process.env.CIQ_DEVICE || "approachs62";
const PRG = path.join(GARMIN, "build", "ClarityCaddy-" + DEVICE + "-parity.prg");
const TIMEOUT_MS = Number(process.env.PARITY_TIMEOUT_MS || 60000);

/* The SDK the simulator is running matters more than the newest installed
   one: monkeydo talks to whichever simulator is up, and mixing a 9.x monkeydo
   with an 8.x simulator is asking for trouble. Prefer a running simulator's
   own SDK, fall back to current-sdk.cfg. */
function sdkRoot() {
  if (process.env.CIQ_SDK) return process.env.CIQ_SDK;
  const ps = spawnSync("pgrep", ["-lf", "ConnectIQ.app/Contents/MacOS/simulator"], { encoding: "utf8" });
  /* The path holds a space ("Application Support"), so this has to anchor on
     the leading slash of the argument rather than on non-space runs. */
  const match = (ps.stdout || "").match(/\s(\/.+?connectiq-sdk-[^/]+)\//);
  if (match) return match[1];
  const cfg = path.join(os.homedir(), "Library", "Application Support", "Garmin", "ConnectIQ", "current-sdk.cfg");
  if (fs.existsSync(cfg)) return fs.readFileSync(cfg, "utf8").trim();
  return null;
}

/* monkeydo is a Java launcher and there is NO system Java on this Mac — the
   bare command dies with "Unable to locate a Java Runtime". Every documented
   build step here works around it by putting Android Studio's bundled JBR on
   PATH (garmin/UPLOAD.md §0), so do the same rather than making the caller
   remember. */
function javaBin() {
  if (spawnSync("java", ["-version"], { encoding: "utf8" }).status === 0) return null;
  const candidates = [
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin",
    "/Library/Java/JavaVirtualMachines"
  ];
  if (fs.existsSync(candidates[0])) return candidates[0];
  const home = spawnSync("/usr/libexec/java_home", [], { encoding: "utf8" });
  if (home.status === 0 && home.stdout.trim()) return path.join(home.stdout.trim(), "bin");
  return null;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const root = sdkRoot();
if (!root) fail("No Connect IQ SDK found. Set CIQ_SDK, or install one with the SDK Manager.");
const monkeydo = path.join(root, "bin", "monkeydo");
if (!fs.existsSync(monkeydo)) fail("No monkeydo at " + monkeydo);
if (!fs.existsSync(PRG)) {
  fail("No parity build at " + path.relative(process.cwd(), PRG) +
    "\n  Build it first:  cd garmin && CIQ_PARITY=1 ./build.sh build" +
    (DEVICE === "approachs62" ? "" : "   (CIQ_DEVICE=" + DEVICE + ")"));
}

console.log("parity: pushing " + path.basename(PRG) + " to the running simulator (" + DEVICE + ")");

const extraPath = javaBin();
if (extraPath === null && spawnSync("java", ["-version"]).status !== 0) {
  fail("No Java runtime, and none bundled with Android Studio either.\n" +
    "  monkeydo needs a JDK on PATH — see garmin/UPLOAD.md, section 0.");
}
const env = Object.assign({}, process.env);
if (extraPath) env.PATH = extraPath + ":" + env.PATH;

const child = spawn(monkeydo, [PRG, DEVICE], { stdio: ["ignore", "pipe", "pipe"], env: env });
let buffer = "";
let verdict = null;
const failures = [];

function consume(chunk) {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    if (line.startsWith("parity FAIL")) { failures.push(line); console.log("  " + line); }
    else if (line.startsWith("parity: RESULT")) { verdict = line; }
    else if (line.startsWith("parity:") || line.startsWith("trace ")) console.log("  " + line);
    else if (/^(Error|Details|Stack|Encountered)/.test(line)) console.log("  " + line);
    if (verdict) finish();
  }
}

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  try { child.kill(); } catch (e) {}
  if (!verdict) {
    console.error("parity: no verdict — the app crashed or never reached the harness (is the simulator running?)");
    process.exit(1);
  }
  console.log(verdict);
  process.exit(verdict.indexOf("PASS") >= 0 ? 0 : 1);
}

child.stdout.on("data", consume);
child.stderr.on("data", consume);
child.on("exit", () => setTimeout(finish, 250));

const timer = setTimeout(() => {
  console.error("parity: timed out after " + TIMEOUT_MS + "ms with no verdict." +
    "\n  The simulator must already be running:  \"" + path.join(root, "bin", "connectiq") + "\" &");
  try { child.kill(); } catch (e) {}
  process.exit(1);
}, TIMEOUT_MS);
