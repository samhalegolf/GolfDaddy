const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");
const fs = require("fs");

const root = path.join(__dirname, "..");

(async function run() {
  const api = await import(pathToFileURL(path.join(root, "functions", "course-visual-recipes.mjs")).href);
  const helpers = api.__test;

  const recipe = helpers.recipePayload({
    name: "Natural Plus",
    presetId: "clarity-course-natural-v1",
    courseOverrides: { lighting: { brightnessTarget: 58 } },
    sampleCourseId: "north-shore",
    sampleHoleNumber: 7
  });
  assert.strictEqual(recipe.name, "Natural Plus");
  assert.strictEqual(recipe.preset_id, "clarity-course-natural-v1");
  assert.strictEqual(recipe.sample_course_id, "north-shore");
  assert.strictEqual(recipe.sample_hole_number, 7);

  const row = helpers.rowToRecipe({
    id: "recipe-1",
    name: "Natural Plus",
    preset_id: "clarity-course-natural-v1",
    course_overrides: { lighting: { brightnessTarget: 58 } },
    sample_course_id: "north-shore",
    sample_hole_number: 7,
    is_active: true
  });
  assert.strictEqual(row.isActive, true);
  assert.strictEqual(row.sampleCourseId, "north-shore");
  assert.strictEqual(row.sampleHoleNumber, 7);

  const studio = fs.readFileSync(path.join(root, "scripts", "studio", "gd-admin-course-db.js"), "utf8");
  assert.ok(studio.includes("Recipe Lab"), "studio recipe lab entry should be present");
  assert.ok(studio.includes("/api/course-visual-recipes"), "studio should read the shared recipe endpoint");
  assert.ok(studio.includes("Set selected active"), "studio should expose active recipe selection");
  assert.ok(studio.includes("gdAdminCourseVisualRecipeLabAttempted[recipeKey]"), "recipe lab should attempt each donor and recipe combination only once");
  assert.ok(studio.includes("if(!isRecipeLab)gdAdminCourseVisualScheduleHydration"), "recipe lab should not enter the normal course hydration pipeline");
  assert.ok(studio.includes("if(!isRecipeLab){\n    gdAdminCourseVisualScheduleAutoBuild"), "recipe lab should not enter the normal automatic course build pipeline");
  assert.ok(studio.includes("gdAdminCourseDbJobsAt=Date.now();\n      gdAdminCourseDbJobsInflight=null;"), "failed mapper-status reads should cool down instead of redrawing into another request");

  // --- Terrain preview patch regression tests ---

  // 1. Terrain commit must not use buildCourseVisualPreview: the early-return for terrain
  //    must appear before the engine.buildCourseVisualPreview call.
  {
    const committed=studio.slice(studio.indexOf("function gdAdminCourseVisualControlCommitted("));
    const earlyReturn=committed.indexOf('gdAdminCourseVisualActiveTool==="terrain"');
    const localBake=committed.indexOf("engine.buildCourseVisualPreview(");
    assert.ok(earlyReturn>-1,"terrain short-circuit must be present in gdAdminCourseVisualControlCommitted");
    assert.ok(localBake>-1,"buildCourseVisualPreview call must still exist (for non-terrain controls)");
    assert.ok(earlyReturn<localBake,"terrain short-circuit must appear before buildCourseVisualPreview");
  }

  // 2. Successful terrain relief response updates the transient preview used by the main phone.
  assert.ok(studio.includes("gdAdminCourseTerrainTransientPreview[key]={courseId,holeNumber:req.hole,blobUrl:URL.createObjectURL(blob)}"), "relief refresh must store a blob URL for the main phone transient preview");

  // 3. Stale-request protection: older response cannot overwrite a newer one.
  //    The seq guard appears before the transient cache write.
  {
    const refresh=studio.slice(studio.indexOf("function gdAdminCourseVisualReliefRefresh("));
    const seqGuard=refresh.indexOf("if(seq!==gdAdminReliefSeq)return;",refresh.indexOf("const blob=await r.blob()"));
    const cacheWrite=refresh.indexOf("gdAdminCourseTerrainTransientPreview[key]=");
    assert.ok(seqGuard>-1,"seq guard must appear after blob read in gdAdminCourseVisualReliefRefresh");
    assert.ok(cacheWrite>seqGuard,"transient cache write must be after the seq guard, not before");
  }

  // 4. Reset with a cloud frame must not produce an empty/hydrating phone preview:
  //    gdAdminCourseCloudFramesSuppressed must NOT be set to true inside gdAdminCourseVisualResetRecipe.
  {
    const resetFn=studio.slice(studio.indexOf("function gdAdminCourseVisualResetRecipe("));
    const nextFn=resetFn.indexOf("\nfunction ",1);
    const resetBody=nextFn>-1?resetFn.slice(0,nextFn):resetFn.slice(0,2000);
    assert.ok(!resetBody.includes("gdAdminCourseCloudFramesSuppressed["),"Reset Recipe must not suppress cloud frames (cloud frame is the safe fallback when no local raw frame exists)");
  }

  // 5. Terrain preview changes must not enqueue snapshot or export jobs:
  //    gdAdminCourseVisualReliefRefresh must contain neither enqueueSnapshot nor enqueueExport.
  {
    const refresh=studio.slice(studio.indexOf("function gdAdminCourseVisualReliefRefresh("));
    const nextFn=refresh.indexOf("\nfunction ",1);
    const refreshBody=nextFn>-1?refresh.slice(0,nextFn):refresh.slice(0,2000);
    assert.ok(!refreshBody.includes("enqueueSnapshot"),"terrain relief refresh must not enqueue snapshot jobs");
    assert.ok(!refreshBody.includes("enqueueExport"),"terrain relief refresh must not enqueue export jobs");
  }

  console.log("course-visual-recipes passed");
})().catch((error) => {
  console.error("course-visual-recipes failed");
  console.error(error && error.stack || error);
  process.exit(1);
});
