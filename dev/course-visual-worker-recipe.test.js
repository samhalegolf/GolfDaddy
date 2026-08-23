const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

const root = path.join(__dirname, "..");

async function loadTests() {
  const worker = await import(pathToFileURL(path.join(root, "functions", "course-visual-worker-background.mjs")).href);
  const jobs = await import(pathToFileURL(path.join(root, "functions", "course-visual-jobs.mjs")).href);
  return { worker: worker.__test, jobs: jobs.__test };
}

(async function run() {
  const { worker, jobs } = await loadTests();

  const natural = worker.builtInPresetSettings(worker.NATURAL_PRESET_ID);
  assert.strictEqual(natural.id, "clarity-course-natural-v1");
  assert.strictEqual(natural.turf.greenStrength, 0.35);
  assert.strictEqual(natural.lighting.brightnessTarget, 52);
  assert.strictEqual(natural.visualTools.holeTerrainStrength, 0.75);
  assert.strictEqual(natural.visualTools.fairwayAirbrush, true);

  const defaultRecipe = worker.normalizeRecipe({ presetId: worker.NATURAL_PRESET_ID, courseOverrides: {} });
  assert.strictEqual(defaultRecipe.presetId, "clarity-course-natural-v1");
  assert.deepStrictEqual(defaultRecipe.courseOverrides, {});
  assert.strictEqual(defaultRecipe.settings.visualTools.holeTerrainStrength, 0.75);
  assert.strictEqual(defaultRecipe.settings.visualTools.fairwayAirbrush, true);

  const customised = worker.recipeFromPublishedRow({
    preset_id: "clarity-course-natural-v1",
    course_overrides: { visualTools: { holeTerrainStrength: 1.6 } }
  });
  assert.strictEqual(customised.presetId, "clarity-course-natural-v1");
  assert.deepStrictEqual(customised.courseOverrides, { visualTools: { holeTerrainStrength: 1.6 } });
  assert.strictEqual(customised.settings.visualTools.holeTerrainStrength, 1.6);
  assert.strictEqual(customised.settings.visualTools.fairwayAirbrush, true);

  const rawBaseline = worker.recipeFromPublishedRow({ preset_id: "", course_overrides: {} });
  assert.strictEqual(rawBaseline.presetId, "");
  assert.strictEqual(rawBaseline.settings.visualTools.holeTerrainStrength, 0);
  assert.strictEqual(rawBaseline.settings.visualTools.fairwayAirbrush, false);
  assert.strictEqual(rawBaseline.settings.turf.greenStrength, 0);

  const libraryRecipe = worker.recipeFromLibraryRow({
    preset_id: "clarity-course-natural-v1",
    course_overrides: { lighting: { brightnessTarget: 61 } }
  });
  assert.strictEqual(libraryRecipe.presetId, "clarity-course-natural-v1");
  assert.strictEqual(libraryRecipe.settings.lighting.brightnessTarget, 61);
  assert.strictEqual(libraryRecipe.settings.visualTools.fairwayAirbrush, true);

  const exportFailed = jobs.deriveCourseBuildStateFromRows({
    visual: null,
    jobs: [
      { id: "j3", kind: "export", status: "failed", error: "render h16 failed" },
      { id: "j2", kind: "snapshot", status: "done" }
    ]
  });
  assert.strictEqual(exportFailed.state, "failed");
  assert.strictEqual(exportFailed.failedStage, "export");
  assert.strictEqual(exportFailed.snapshotReady, true);
  assert.strictEqual(exportFailed.exportReady, false);
  assert.strictEqual(exportFailed.checkpoint.stage, "export");

  const exportRunning = jobs.deriveCourseBuildStateFromRows({
    visual: null,
    jobs: [
      { id: "j2", kind: "export", status: "running", result: { progress: { holesDone: 14, holesTotal: 27 } } },
      { id: "j1", kind: "snapshot", status: "done" }
    ]
  });
  assert.strictEqual(exportRunning.state, "running");
  assert.strictEqual(exportRunning.live.kind, "export");
  assert.strictEqual(exportRunning.checkpoint.stage, "export");

  const snapshotFailed = jobs.deriveCourseBuildStateFromRows({
    visual: null,
    jobs: [{ id: "j1", kind: "snapshot", status: "failed", error: "tile coverage incomplete" }]
  });
  assert.strictEqual(snapshotFailed.state, "failed");
  assert.strictEqual(snapshotFailed.failedStage, "capture");

  const framesReady = jobs.deriveCourseBuildStateFromRows({
    visual: { published_version: 7 },
    jobs: [{ id: "j1", kind: "export", status: "done" }]
  });
  assert.strictEqual(framesReady.state, "frames-ready");
  assert.strictEqual(framesReady.framesReady, true);
  assert.strictEqual(framesReady.exportReady, true);

  /* A recipe with lighting toggled off makes the normaliser report the tone pass as
     {applied:false, measuredMean} - no blackPoint, whitePoint or gamma. The progress log used
     to read those unconditionally and killed the whole export with "Cannot read properties of
     undefined (reading 'toFixed')" the first time a terrain-only recipe went live. */
  const litLine = worker.normaliseLogLine("h4", {
    tone: { applied: true, measuredMean: 41.234, brightnessTarget: 52, blackPoint: 8.11, whitePoint: 93.77, gamma: 1.2 },
    turf: { applied: true, pull: 1, coverage: 0.42 }
  });
  assert.ok(/mean 41\.2->target 52/.test(litLine) && /black\/white 8\.1\.\.93\.8/.test(litLine), "a lit frame still logs its measured numbers");

  const unlitLine = worker.normaliseLogLine("h4", {
    tone: { applied: false, reason: "lighting-disabled", measuredMean: 41.234 },
    turf: { applied: false, reason: "turf-disabled" }
  });
  assert.ok(/lighting not applied \(lighting-disabled\)/.test(unlitLine), "lighting off logs the reason instead of missing numbers");
  assert.ok(/turf not applied \(turf-disabled\)/.test(unlitLine), "and says the same about turf");

  assert.doesNotThrow(() => worker.normaliseLogLine("overview", {}), "an empty diagnostics block never takes the export down");

  console.log("course-visual-worker-recipe passed");
})().catch((error) => {
  console.error("course-visual-worker-recipe failed");
  console.error(error && error.stack || error);
  process.exit(1);
});
