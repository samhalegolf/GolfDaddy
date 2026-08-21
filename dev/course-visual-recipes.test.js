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

  console.log("course-visual-recipes passed");
})().catch((error) => {
  console.error("course-visual-recipes failed");
  console.error(error && error.stack || error);
  process.exit(1);
});
