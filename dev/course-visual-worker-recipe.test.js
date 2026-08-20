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

  console.log("course-visual-worker-recipe passed");
})().catch((error) => {
  console.error("course-visual-worker-recipe failed");
  console.error(error && error.stack || error);
  process.exit(1);
});
