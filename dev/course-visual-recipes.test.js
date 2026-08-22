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

  // --- Active-recipe area + one-button update ------------------------------------------------

  assert.ok(studio.includes('{id:"recipe",icon:"📋",label:"Recipe"'), "the tuning dock should carry a dedicated Recipe tab");
  assert.ok(studio.includes("function gdAdminCourseVisualRecipeCenterMarkup("), "the active-recipe area should be one markup function, shared by the dock and the strip");
  assert.ok(studio.includes("function gdAdminCourseVisualActiveRecipeStrip("), "the phone should show which recipe is active while tuning");
  assert.ok(studio.includes("gdAdminCourseVisualActiveRecipeStrip(selected.id)}${gdAdminCourseVisualStatusMarkup"), "the strip must be rendered into the phone info block");
  assert.ok(studio.includes("gdAdminCourseVisualUpdateButton(selected&&selected.id||\"\",\"primary\")"), "the course action rail should carry the pipeline update button");
  assert.ok(!/>Update<\/button>/.test(studio), "only one button may be called Update, and it is the pipeline one");

  {
    const fn = studio.slice(studio.indexOf("async function gdAdminCourseVisualUpdateWithActiveRecipe("));
    const body = fn.slice(0, fn.indexOf("\nfunction gdAdminCourseVisualCourseName("));
    assert.ok(body.length > 200 && body.length < 4000, "update function body should have been isolated");
    // The whole point: the ACTIVE recipe is passed explicitly. An export queued with a null
    // recipe falls back to the course's own last published recipe in the worker
    // (latestPublishedRecipe), which is the stale treatment this button replaces.
    assert.ok(body.includes('gdAdminCourseVisualEnqueueCloudJob(id,"export",{presetId:presetId,overrides:overrides})'),
      "the update must hand the active recipe to the export job explicitly");
    assert.ok(!/gdAdminCourseVisualEnqueueCloudJob\(id,"export",null\)/.test(body),
      "the update must never queue an export with no recipe");
    // Re-read before acting: a 20-second-stale "active" would bake the treatment somebody just replaced.
    const reload = body.indexOf("gdAdminCourseVisualRecipeReload()");
    const enqueue = body.indexOf("gdAdminCourseVisualEnqueueCloudJob");
    assert.ok(reload > -1 && reload < enqueue, "the active recipe must be re-read from the server before anything is queued");
    // No captures on the server means an export has nothing to bake from.
    assert.ok(body.includes('state.framesReady||state.snapshotReady||state.state==="captures-ready"'),
      "the update must check for captures before queueing an export");
    assert.ok(body.includes('gdAdminCourseVisualEnqueueCloudJob(id,"snapshot",null)'),
      "a course with no captures should be scanned first rather than exported into nothing");
    assert.ok(body.includes("if(state&&state.building)"), "the update must refuse to stack on a build already in flight");
  }

  {
    const worker = fs.readFileSync(path.join(root, "functions", "course-visual-worker-background.mjs"), "utf8");
    const fallback = worker.slice(worker.indexOf("async function latestPublishedRecipe("));
    assert.ok(fallback.indexOf("activeLibraryRecipe()") > -1,
      "a course with no published recipe must fall back to the shared active recipe - that is what makes the active recipe the pipeline default for new courses");
  }

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
  assert.ok(studio.includes("gdAdminCourseTerrainTransientPreview[key]={courseId,holeNumber:req.hole,blobUrl:URL.createObjectURL(blob),requestId:Number(request&&request.requestId)||0}"), "relief refresh must store a blob URL, and the request that produced it, for the main phone transient preview");

  // 3. Stale-request protection: older response cannot overwrite a newer one.
  //    The seq guard appears before the transient cache write.
  {
    const refresh=studio.slice(studio.indexOf("function gdAdminCourseVisualReliefFetch("));
    const seqGuard=refresh.indexOf("if(seq!==gdAdminReliefSeq)return",refresh.indexOf("const blob=await r.blob()"));
    const cacheWrite=refresh.indexOf("gdAdminCourseTerrainTransientPreview[key]=");
    assert.ok(seqGuard>-1,"seq guard must appear after blob read in gdAdminCourseVisualReliefFetch");
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
    const refresh=studio.slice(studio.indexOf("function gdAdminCourseVisualReliefRefresh("),studio.indexOf("function gdAdminCourseVisualControlChanged("));
    assert.ok(!refresh.includes("enqueueSnapshot"),"terrain relief refresh must not enqueue snapshot jobs");
    assert.ok(!refresh.includes("enqueueExport"),"terrain relief refresh must not enqueue export jobs");
  }

  console.log("course-visual-recipes passed");
})().catch((error) => {
  console.error("course-visual-recipes failed");
  console.error(error && error.stack || error);
  process.exit(1);
});
