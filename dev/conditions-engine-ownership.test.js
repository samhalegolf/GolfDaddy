/*
  Conditions Engine ownership boundaries.

  Structural assertions in the style of the other *-owner tests: these pin the
  architecture rather than the behaviour. They exist so a later change cannot
  quietly move environmental adjustment back into GPS Play, reintroduce a second
  correction path, or leak recommendation copy into the engine.

  Run: node dev/conditions-engine-ownership.test.js
*/

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

/* Reach-into-other-domains checks are about executable code, not prose: the
   engine header legitimately says it never retrains My Bubble. */
function readCode(relative) {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/* Every single- double- and back-quoted literal in already-decommented source. */
function stringLiterals(code) {
  return (code.match(/'[^'\n]*'|"[^"\n]*"|`[^`\n]*`/g) || []).map((raw) => raw.slice(1, -1));
}

const ENGINE_FILES = [
  "scripts/course-data/conditions-engine/gd-conditions-tolerance-profile.js",
  "scripts/course-data/conditions-engine/gd-conditions-geometry.js",
  "scripts/course-data/conditions-engine/gd-conditions-engine.js"
];

const COURSE_DATA_FILES = ENGINE_FILES.concat([
  "scripts/course-data/gd-course-data-intake.js",
  "scripts/course-data/gd-course-data-comparison.js",
  "scripts/course-data/gd-conditions-debug.js"
]);

const appCore = read("scripts/gd-app-core.js");
const html = read("index.html");

// --- The engine lives inside the Course Data domain -------------------------
{
  COURSE_DATA_FILES.forEach((file) => {
    assert(fs.existsSync(path.join(ROOT, file)), `${file} exists`);
    assert(file.indexOf("scripts/course-data/") === 0, `${file} lives under the Course Data domain`);
  });

  ENGINE_FILES.forEach((file) => {
    assert(
      file.indexOf("scripts/course-data/conditions-engine/") === 0,
      `${file} lives in the conditions-engine module boundary`
    );
  });
}

// --- Every module is loaded, engine before the intake that invokes it -------
{
  const order = [
    "scripts/gd-shot-snapshot.js",
    "scripts/course-data/conditions-engine/gd-conditions-tolerance-profile.js",
    "scripts/course-data/conditions-engine/gd-conditions-geometry.js",
    "scripts/course-data/conditions-engine/gd-conditions-engine.js",
    "scripts/course-data/gd-course-data-intake.js",
    "scripts/course-data/gd-course-data-comparison.js",
    "scripts/course-data/gd-conditions-debug.js"
  ];

  let previous = -1;
  order.forEach((file) => {
    const at = html.indexOf(file);
    assert(at !== -1, `index.html loads ${file}`);
    assert(at > previous, `index.html loads ${file} after its dependencies`);
    previous = at;
  });
}

// --- GPS Play emits the Shot Snapshot and nothing more ----------------------
{
  assert(
    appCore.includes("function gdSubmitCourseDataShotSnapshot"),
    "GPS Play builds and submits a Shot Snapshot"
  );
  assert(
    appCore.includes("intake.submitShotSnapshot(snapshot)"),
    "GPS Play hands the snapshot to the single Course Data intake path"
  );
  assert(
    appCore.includes("gdSubmitCourseDataShotSnapshot(ll,gpsAccuracyM,reason,logged)") &&
      appCore.includes("gdSubmitCourseDataShotSnapshot(ll,gpsAccuracyM,reason,result)"),
    "both shot-completion branches emit a snapshot"
  );

  // GPS Play must never run the analysis itself, compare against My Bubble for
  // conditions purposes, or select a variant.
  //
  // It MAY declare the engine's admin tuning config: DEV_DEFAULTS is the
  // app-wide tuning store the Course Data admin sliders read from, and holding
  // a namespace of numbers is not the same as implementing the engine. What
  // stays forbidden is reaching for the engine module or naming any of its
  // analytical concepts.
  assert(
    !appCore.includes("ConditionsEngine"),
    "GPS Play must not reference the Conditions Engine module"
  );
  assert(
    !appCore.includes("modules.conditionsEngine"),
    "GPS Play must not resolve the Conditions Engine through the module registry"
  );
  assert(
    appCore.includes("conditionsEngine:{"),
    "the engine's admin tuning defaults are declared in the shared tuning store"
  );

  [
    "windNormalised",
    "slopeNormalised",
    "combinedNormalised",
    "selectedVariant",
    "normalisationApplied",
    "bubbleFitImprovement",
    "evaluateBubbleFit"
  ].forEach((token) => {
    assert(
      !appCore.includes(token),
      `GPS Play must not reference Conditions Engine concept "${token}"`
    );
  });
}

// --- The engine is pure: it owns no persistence and no DOM ------------------
{
  ENGINE_FILES.forEach((file) => {
    const source = read(file);
    assert(!source.includes("localStorage"), `${file} does not persist state; the intake path owns storage`);
    assert(!source.includes("document."), `${file} touches no DOM`);
    assert(!source.includes("fetch("), `${file} performs no network access`);
  });
}

// --- My Bubble is read-only to the engine -----------------------------------
{
  const forbidden = [
    "retrain",
    "practiceBubbleSource",
    "practiceBubblePendingSource",
    "bubbleProfiles",
    "previewBubbleSet",
    "gdPracticeSyncBubbleSourcesToBag",
    "gdPracticeRescaleBubbleSourceToCarry"
  ];

  COURSE_DATA_FILES.forEach((file) => {
    const source = readCode(file);
    forbidden.forEach((token) => {
      assert(
        !source.includes(token),
        `${file} must not reach into My Bubble or practice state ("${token}")`
      );
    });
  });
}

// --- No magic numbers: thresholds come from the versioned tolerance profile --
{
  const engineSource = read("scripts/course-data/conditions-engine/gd-conditions-engine.js");
  [
    "profile.minimumWindScaleLevel",
    "profile.minimumWindConfidence",
    "profile.minimumWindEffectMetres",
    "profile.minimumSlopeConfidence",
    "profile.minimumSlopeEffectMetres",
    "profile.minimumBubbleFitImprovement",
    "profile.maximumCorrectionDistanceMetres",
    "profile.maximumCorrectionDegrees",
    "profile.minimumSelectionConfidence",
    "profile.maximumEnvironmentalDataAge",
    "profile.windModel",
    "profile.slopeModel"
  ].forEach((token) => {
    assert(engineSource.includes(token), `engine reads "${token}" from the tolerance profile`);
  });

  // The wind model constants must live in the profile, not the engine.
  const profileSource = read("scripts/course-data/conditions-engine/gd-conditions-tolerance-profile.js");
  assert(!engineSource.includes("0.045"), "engine does not hard-code the wind carry factor");
  assert(
    profileSource.includes("carryFactor: 0.045"),
    "the wind carry factor lives in the versioned tolerance profile"
  );

  // The directional wind model is admin-tunable, so its coefficients and the
  // crosswind gate angle must be profile data, never literals in the engine.
  ["headwindFactor", "tailwindFactor", "crosswindFactor", "crosswindGateDegrees"].forEach((key) => {
    assert(engineSource.includes("model." + key), `the engine reads ${key} from the wind model`);
    assert(profileSource.includes(key + ":"), `${key} is declared in the tolerance profile`);
  });
  assert(!engineSource.includes("0.65"), "engine does not hard-code the crosswind factor");
  assert(!engineSource.includes("0.55"), "engine does not hard-code the tailwind factor");
  assert(
    !/crosswindGateDegrees,\s*45/.test(engineSource),
    "engine does not hard-code the crosswind gate angle as a fallback"
  );

  // Older profiles must stay resolvable so historical analyses remain
  // explainable and reprocessing can compare wind models.
  assert(profileSource.includes("version: '1.0.0'"), "profile 1.0.0 is still registered");
  assert(profileSource.includes("version: '1.1.0'"), "profile 1.1.0 is registered");
  assert(
    profileSource.includes("var DEFAULT_VERSION"),
    "the default profile is declared explicitly, not derived by sorting version strings"
  );

  // Admin edits must derive a new profile version, never mutate a published
  // one, or historical analyses stop being explainable.
  assert(profileSource.includes("function derive"), "the profile module can derive an overridden profile");
  assert(
    profileSource.includes("derived.derivedFrom = base.version"),
    "a derived profile records the base it came from"
  );
  const intakeSourceForProfiles = read("scripts/course-data/gd-course-data-intake.js");
  assert(
    intakeSourceForProfiles.includes("readAdminWindOverrides"),
    "the intake reads the admin dials rather than the pure profile module doing so"
  );
  assert(
    intakeSourceForProfiles.includes("effectiveWindModel"),
    "the coefficients actually used are stored on the analysis record"
  );

  // The admin surface has to expose the dials, or they are not settable.
  const routeAuditSource = read("scripts/gd-route-audit.js");
  ["conditionsEngine.headwindFactor", "conditionsEngine.tailwindFactor",
    "conditionsEngine.crosswindFactor", "conditionsEngine.crosswindGateDeg"].forEach((path) => {
    assert(routeAuditSource.includes(path), `the Course Data admin surface exposes ${path}`);
    assert(appCore.includes('"' + path + '"'), `${path} has a tuning field definition`);
  });
}

// --- One shared Bubble-fit comparison, not one per variant ------------------
{
  const geometrySource = read("scripts/course-data/conditions-engine/gd-conditions-geometry.js");
  const definitions = geometrySource.match(/function evaluateBubbleFit/g) || [];
  assert.strictEqual(definitions.length, 1, "exactly one Bubble-fit comparison is defined");

  const engineSource = read("scripts/course-data/conditions-engine/gd-conditions-engine.js");
  const fitCalls = engineSource.match(/geo\.evaluateBubbleFit\(/g) || [];
  assert.strictEqual(
    fitCalls.length,
    1,
    "the engine scores every variant through the single shared fit call in buildVariant"
  );
}

// --- One intake entry point -------------------------------------------------
{
  const intakeSource = read("scripts/course-data/gd-course-data-intake.js");
  const definitions = intakeSource.match(/function submitShotSnapshot/g) || [];
  assert.strictEqual(definitions.length, 1, "exactly one Course Data submission entry point is defined");

  // The raw snapshot is written once and never replaced.
  assert(
    intakeSource.includes("// Idempotent re-submission"),
    "the idempotency contract is documented at the persistence site"
  );
  assert(intakeSource.includes("deepFreeze"), "submitted snapshots are frozen");
}

// --- The comparison layer consumes the engine, and owns the choice ----------
{
  const routeAudit = read("scripts/gd-route-audit.js");

  assert(
    routeAudit.includes("comparison.comparisonValues(record)"),
    "gdCompareCoursePoints delegates to the Course Bubble / Comparison Layer"
  );
  assert(
    routeAudit.includes("function gdCourseDataComparison()"),
    "the comparison layer is resolved through a single accessor"
  );

  // The comparison layer must not re-derive what the engine already decided.
  const comparisonSource = read("scripts/course-data/gd-course-data-comparison.js");
  ["evaluateBubbleFit", "windEffectMetres", "adjustmentVector"].forEach((token) => {
    assert(
      !comparisonSource.includes(token),
      `the comparison layer must not re-implement engine logic ("${token}")`
    );
  });

  // Raw must survive the comparison, not be replaced by it.
  ["rawActualDistanceM", "rawLateralM"].forEach((field) => {
    assert(comparisonSource.includes(field), `the comparison layer carries ${field} through`);
    assert(routeAudit.includes(field), `course comparison points carry ${field} through`);
  });
}

// --- Option C: counterfactual recorded, selection policy explicit -----------
{
  const engineSource = read("scripts/course-data/conditions-engine/gd-conditions-engine.js");

  // Physical validity and the directional policy must stay separable, so the
  // counterfactual can be computed without changing what gets selected.
  assert(engineSource.includes("physicallyValid"), "physical validity is assessed separately from policy");
  assert(engineSource.includes("passesRescueOnly"), "the rescue-only policy outcome is computed");
  assert(engineSource.includes("passesSymmetric"), "the symmetric policy outcome is computed");
  assert(engineSource.includes("function assessDirection"), "boundary-crossing direction is assessed");

  // The policy is data, not a hard-coded branch: flipping to symmetric is a
  // tolerance profile change, not a code change.
  assert(
    engineSource.includes("profile.variantSelectionPolicy"),
    "the selection policy is read from the tolerance profile"
  );

  // Rescue-only must remain the default until the decision is made.
  assert(
    engineSource.includes("|| 'rescue-only'"),
    "rescue-only is the default when a profile does not specify a policy"
  );

  // The counterfactual has to reach storage and the comparison layer, or it
  // cannot be aggregated into a decision.
  assert(
    read("scripts/course-data/gd-course-data-intake.js").includes("symmetricEvaluation"),
    "the counterfactual is persisted on the analysis record"
  );
  const comparisonSource = read("scripts/course-data/gd-course-data-comparison.js");
  assert(comparisonSource.includes("biasReadout"), "the comparison layer exposes the bias readout");
  assert(
    comparisonSource.includes("wouldDemoteUnderSymmetric"),
    "the comparison layer surfaces the demotion counterfactual"
  );
}

// --- The engine stays analytical and silent ---------------------------------
{
  const banned = [
    "you did not", "you should", "your swing", "misread", "club up", "club down",
    "recommend", "suggest", "coaching", "well done", "nice shot", "praise",
    "show this insight", "tell the player", "message", "headline", "copy:"
  ];

  // Only string literals matter here: those are what the engine can emit.
  // Comments legitimately describe the prohibition, and identifiers such as
  // buildRecommendationsHandoff name the neutral handoff itself.
  COURSE_DATA_FILES.forEach((file) => {
    stringLiterals(readCode(file)).forEach((literal) => {
      const lowered = literal.toLowerCase();
      banned.forEach((phrase) => {
        assert(
          !lowered.includes(phrase),
          `${file} must not emit recommendation or coaching language ("${phrase}" in ${literal})`
        );
      });
    });
  });

  // Stronger invariant for the engine itself: player-facing copy needs
  // multi-word strings, and the engine emits none. Everything it produces is a
  // machine code, a variant name or a property key.
  stringLiterals(readCode("scripts/course-data/conditions-engine/gd-conditions-engine.js")).forEach((literal) => {
    if (literal === "use strict") return;
    assert(
      literal.indexOf(" ") === -1,
      `the Conditions Engine must not emit multi-word strings, found "${literal}"`
    );
  });

  // The handoff exposes evidence for the Recommendations Engine but implements
  // none of its responsibilities.
  const intakeSource = read("scripts/course-data/gd-course-data-intake.js");
  assert(intakeSource.includes("buildRecommendationsHandoff"), "a neutral handoff is exposed");
  ["shouldNotify", "notification", "priority", "repetition", "detectPattern"].forEach((token) => {
    assert(
      !intakeSource.includes(token),
      `intake must not implement Recommendations Engine responsibility "${token}"`
    );
  });
}

// --- The in-round aim tools remain, and record what the player chose ---------
{
  // The wind picker and slope readout are player aiming aids, not analysis.
  // They stay; what they were set to is captured on the snapshot instead.
  assert(appCore.includes("function gdWindToolPressed"), "the wind aim tool is retained");
  assert(appCore.includes("function gdWindPickDirection"), "the wind direction picker is retained");
  assert(appCore.includes("function gdRenderShotCardSlope"), "the slope readout is retained");

  assert(
    appCore.includes("let gdWindSelectionSource=null;"),
    "GPS Play tracks whether wind came from live evidence or the player"
  );
  assert(
    appCore.includes('gdWindSelectionSource="live"'),
    "applying live wind records a live provenance"
  );
  assert(
    appCore.includes('gdWindSelectionSource="user"'),
    "manual wind selection records a user provenance"
  );
  assert(
    appCore.includes('const userSelectedWind=!!gdWindActive&&gdWindSelectionSource==="user";'),
    "the snapshot distinguishes user-selected wind from live wind"
  );
}

console.log("conditions-engine-ownership tests passed");
