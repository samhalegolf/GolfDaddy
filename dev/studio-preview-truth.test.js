/* Course Visual Studio preview truth.
 *
 * The Studio's problem was never the renderer. It was that the panel described the
 * recipe in the controls and called it the picture on the screen. Those two are
 * different things for as long as a bake takes, and the gap was where every
 * complaint lived: adjustments dropped because another bake was running, chips
 * green before the image had received the effect, failures that said nothing,
 * sliders yanked backwards by an older render finishing.
 *
 * These tests pin the lifecycle that replaced it. They drive
 * scripts/studio/gd-studio-preview-truth.js on a virtual clock with a fake
 * renderer, so a render can be made to finish late, fail, stall, or produce a
 * frame that never reaches the phone - all the cases that only ever appeared in
 * front of a real operator.
 *
 * Run: node dev/studio-preview-truth.test.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TRUTH = require(path.join(ROOT, "scripts", "studio", "gd-studio-preview-truth.js"));
const STUDIO_SRC = fs.readFileSync(path.join(ROOT, "scripts", "studio", "gd-admin-course-db.js"), "utf8");
const ENGINE_SRC = fs.readFileSync(path.join(ROOT, "scripts", "gd-course-visual-engine.js"), "utf8");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const flush = () => new Promise((resolve) => setImmediate(resolve));

/* A clock the tests own. Real timers would make "stall this render past its
   timeout" a fifteen-second test. */
function makeClock() {
  let t = 1000, nextId = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++nextId; timers.set(id, { at: t + Math.max(0, Number(ms) || 0), fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    async advance(ms) {
      const target = t + ms;
      for (; ;) {
        let pickId = null, pickAt = Infinity;
        for (const [id, timer] of timers) {
          if (timer.at <= target && timer.at < pickAt) { pickAt = timer.at; pickId = id; }
        }
        if (pickId == null) break;
        t = pickAt;
        const timer = timers.get(pickId);
        timers.delete(pickId);
        timer.fn();
        await flush();
      }
      t = target;
      await flush();
    }
  };
}

/* One course, one hole, a record that holds at most one styled frame, and a
   renderer whose every request is completed by hand. `paint` stands in for
   gdAdminCoursePreviewRefreshFrame: it reports what the phone is showing now. */
function makeHarness(options) {
  options = options || {};
  const clock = makeClock();
  const record = { frame: null };
  const runs = [];
  const reasons = [];
  const paint = options.paint || (() => (record.frame ? Object.assign({ kind: "bake" }, record.frame) : null));
  const truth = TRUTH.createPreviewTruth({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onChange(courseId, reason) {
      reasons.push(reason);
      /* Same set the Studio repaints on - "stale" included, because an abandoned
         render arriving late has usually just written a frame onto the record. */
      if (reason === "rendered" || reason === "displayed" || reason === "failed"
        || reason === "timed-out" || reason === "stale") {
        truth.noteDisplayedFrame(courseId, paint(courseId, record));
      }
    }
  });

  function commit(spec) {
    spec = spec || {};
    return truth.commit({
      courseId: "c",
      holeNumber: spec.hole == null ? 7 : spec.hole,
      presetId: spec.presetId || "p1",
      overrides: spec.overrides || {},
      control: spec.control || "brightness",
      label: spec.label || (spec.control ? spec.control[0].toUpperCase() + spec.control.slice(1) : "Preview"),
      kind: spec.kind || "bake",
      run(request) { return new Promise((resolve) => { runs.push({ request, resolve }); }); }
    });
  }
  /* Completing a render writes the frame onto the record first, exactly as the
     engine does, so the repaint that follows has something to find. */
  async function complete(requestId, opts) {
    opts = opts || {};
    const index = runs.findIndex((r) => r.request.requestId === requestId);
    assert.notStrictEqual(index, -1, "no in-flight run with requestId " + requestId);
    const run = runs.splice(index, 1)[0];
    if (opts.ok !== false && opts.writeFrame !== false) {
      record.frame = {
        presetId: run.request.presetId,
        overrideHash: run.request.overrideHash,
        holeNumber: run.request.holeNumber
      };
    }
    run.resolve(opts.ok === false ? { ok: false, error: { message: opts.message || "bake failed" } } : { ok: true });
    await flush();
    await flush();
  }
  const started = () => runs.map((r) => r.request.requestId);
  return { clock, truth, commit, complete, started, record, reasons };
}

const BRIGHT = (v) => ({ lighting: { brightnessTarget: v, contrastTarget: 1.04 } });

/* ------------------------------------------------------------------ A ---- */
test("A · a commit made while a render is in flight is queued, not dropped", async () => {
  const h = makeHarness();
  const a = h.commit({ control: "brightness", overrides: BRIGHT(56) });
  const b = h.commit({ control: "contrast", overrides: { lighting: { brightnessTarget: 56, contrastTarget: 1.12 } } });

  assert.deepStrictEqual(h.started(), [a.requestId], "only A may be running");
  assert.strictEqual(h.truth.queued("c").requestId, b.requestId, "B must be queued, not discarded");

  await h.complete(a.requestId);
  assert.strictEqual(a.state, TRUTH.STATE.DISPLAYED);
  assert.deepStrictEqual(h.started(), [b.requestId], "B must start the moment A leaves the slot");

  await h.complete(b.requestId);
  assert.strictEqual(b.state, TRUTH.STATE.DISPLAYED);
  assert.strictEqual(h.truth.displayed("c").overrideHash, b.overrideHash, "the phone must end on B");
});

/* ------------------------------------------------------------------ B ---- */
test("B · four rapid changes collapse to the last one, and the last one renders", async () => {
  const h = makeHarness();
  const a = h.commit({ control: "brightness", overrides: BRIGHT(53) });
  const b = h.commit({ control: "contrast", overrides: BRIGHT(54) });
  const c = h.commit({ control: "turf", overrides: BRIGHT(55) });
  const d = h.commit({ control: "brightness", overrides: BRIGHT(56) });

  assert.strictEqual(b.state, TRUTH.STATE.SUPERSEDED, "B is allowed to be skipped");
  assert.strictEqual(c.state, TRUTH.STATE.SUPERSEDED, "C is allowed to be skipped");
  assert.strictEqual(h.truth.queued("c").requestId, d.requestId, "D must be the one waiting");

  await h.complete(a.requestId);
  await h.complete(d.requestId);

  assert.strictEqual(d.state, TRUTH.STATE.DISPLAYED);
  assert.strictEqual(h.truth.displayed("c").overrideHash, d.overrideHash,
    "the displayed frame must be D's recipe, not A's");
});

/* ------------------------------------------------------------------ C ---- */
test("C · a stale render finishing last cannot take the preview back", async () => {
  const h = makeHarness();
  const a = h.commit({ control: "brightness", overrides: BRIGHT(56) });
  await h.clock.advance(TRUTH.TIMEOUT_BAKE + 10);
  assert.strictEqual(a.state, TRUTH.STATE.TIMED_OUT, "A is abandoned once its budget is gone");

  const b = h.commit({ control: "contrast", overrides: BRIGHT(60) });
  await h.complete(b.requestId);
  assert.strictEqual(b.state, TRUTH.STATE.DISPLAYED);

  /* A now finishes, long after. It must not become the displayed state. */
  const late = h.truth.settle(a.requestId, { ok: true });
  assert.strictEqual(late.stale, true, "the abandoned request must be ignored on arrival");
  assert.strictEqual(a.state, TRUTH.STATE.TIMED_OUT, "and must not be resurrected");
  assert.strictEqual(h.truth.displayed("c").overrideHash, b.overrideHash, "B stays on screen");
});

/* ------------------------------------------------------------------ D ---- */
test("D · an ingredient is 'applying', not green, until the frame carries it", async () => {
  const h = makeHarness();
  h.record.frame = { presetId: "p1", overrideHash: TRUTH.overrideHash(BRIGHT(52)), holeNumber: 7 };
  h.truth.noteDisplayedFrame("c", Object.assign({ kind: "bake" }, h.record.frame));

  h.commit({ control: "brightness", overrides: BRIGHT(64) });

  const chips = TRUTH.ingredientStates({
    current: { lighting: { brightnessTarget: 64, contrastTarget: 1.04 } },
    displayed: { lighting: { brightnessTarget: 52, contrastTarget: 1.04 } },
    pipeline: h.truth.status("c")
  });
  const brightness = chips.find((c) => c.id === "brightness");
  assert.strictEqual(brightness.state, "applying", "brightness must not be confirmed before the frame arrives");
  assert.match(brightness.text, /^Applying Brightness/);
  assert.strictEqual(h.truth.statusText("c").startsWith("Applying Brightness…"), true);
});

/* ------------------------------------------------------------------ E ---- */
test("E · the ingredient turns green when the matching frame is on screen", async () => {
  const h = makeHarness();
  const a = h.commit({ control: "brightness", overrides: BRIGHT(64) });
  await h.complete(a.requestId);

  assert.strictEqual(a.state, TRUTH.STATE.DISPLAYED);
  const chips = TRUTH.ingredientStates({
    current: { lighting: { brightnessTarget: 64, contrastTarget: 1.04 } },
    displayed: { lighting: { brightnessTarget: 64, contrastTarget: 1.04 } },
    pipeline: h.truth.status("c")
  });
  assert.strictEqual(chips.find((c) => c.id === "brightness").state, "confirmed");
  assert.match(h.truth.statusText("c"), /^✓ Brightness applied to H7/);
});

/* ------------------------------------------------------------------ F ---- */
test("F · a failed bake keeps the old image, says so, and unlocks the queue", async () => {
  const h = makeHarness();
  const seed = h.commit({ control: "brightness", overrides: BRIGHT(56) });
  await h.complete(seed.requestId);
  const goodFrame = h.truth.displayed("c").overrideHash;

  const bad = h.commit({ control: "contrast", overrides: BRIGHT(70) });
  await h.complete(bad.requestId, { ok: false, message: "no base frame for hole 7" });

  assert.strictEqual(bad.state, TRUTH.STATE.FAILED);
  assert.strictEqual(h.truth.displayed("c").overrideHash, goodFrame, "the previous image must still be shown");
  assert.match(h.truth.statusText("c"), /^✕ Contrast failed — previous preview retained/);

  const chips = TRUTH.ingredientStates({
    current: { lighting: { brightnessTarget: 70, contrastTarget: 1.04 } },
    displayed: { lighting: { brightnessTarget: 56, contrastTarget: 1.04 } },
    pipeline: h.truth.status("c")
  });
  assert.strictEqual(chips.find((c) => c.id === "brightness").state, "failed",
    "a failed bake must not leave its settings looking present");

  /* Unlocked: the next adjustment starts immediately. */
  const next = h.commit({ control: "brightness", overrides: BRIGHT(58) });
  assert.deepStrictEqual(h.started(), [next.requestId]);
});

/* ------------------------------------------------------------------ G ---- */
test("G · a stalled render times out, keeps the image, and does not wedge the Studio", async () => {
  const h = makeHarness();
  const seed = h.commit({ control: "brightness", overrides: BRIGHT(56) });
  await h.complete(seed.requestId);
  const goodFrame = h.truth.displayed("c").overrideHash;

  const stalled = h.commit({ control: "contrast", overrides: BRIGHT(70) });
  await h.clock.advance(TRUTH.SLOW_AFTER + 10);
  assert.strictEqual(h.truth.status("c").slow, true, "it should say it is taking longer than usual first");
  assert.match(h.truth.statusText("c"), /taking longer than usual/);

  await h.clock.advance(TRUTH.TIMEOUT_BAKE);
  assert.strictEqual(stalled.state, TRUTH.STATE.TIMED_OUT);
  assert.strictEqual(h.truth.displayed("c").overrideHash, goodFrame, "the previous image must still be shown");
  assert.match(h.truth.statusText("c"), /^⚠ Contrast timed out — previous preview retained/);
  assert.strictEqual(h.truth.active("c"), null, "nothing may be left holding the slot");

  const after = h.commit({ control: "brightness", overrides: BRIGHT(58) });
  /* The abandoned render's promise is still pending - nothing can cancel it - but it
     no longer holds the slot, which is the whole point. */
  assert.strictEqual(h.truth.active("c").requestId, after.requestId, "a later adjustment renders normally");
  assert.ok(h.started().includes(stalled.requestId), "the abandoned render is still out there, ignored");
  await h.complete(after.requestId);
  assert.strictEqual(after.state, TRUTH.STATE.DISPLAYED);
});

/* ----------------------------------------------------------- G (part 2) -- */
test("G · a timeout does not put a doomed render straight back into the slot", async () => {
  const h = makeHarness();
  const stalled = h.commit({ control: "brightness", overrides: BRIGHT(70) });
  await h.clock.advance(TRUTH.TIMEOUT_BAKE + 10);
  assert.strictEqual(stalled.state, TRUTH.STATE.TIMED_OUT);
  /* Retrying here would make the operator's next adjustment queue behind a render
     that has already proved it will not finish. */
  assert.strictEqual(h.truth.needsReconcile("c"), false, "a timeout must not trigger a retry");
  assert.strictEqual(h.truth.active("c"), null, "the slot must be free the moment the clock runs out");
});

test("an abandoned render landing late is noticed and put right, once", async () => {
  const h = makeHarness();
  const seed = h.commit({ control: "brightness", overrides: BRIGHT(52) });
  await h.complete(seed.requestId);

  const abandoned = h.commit({ control: "brightness", overrides: BRIGHT(70) });
  await h.clock.advance(TRUTH.TIMEOUT_BAKE + 10);
  assert.strictEqual(abandoned.state, TRUTH.STATE.TIMED_OUT);
  assert.strictEqual(h.truth.needsReconcile("c"), false);

  /* Now it finishes anyway, and writes its own (by-now stale) frame over the record.
     The picture on screen has changed into something that is not what the controls
     are asking for - that IS worth putting right. */
  const wanted = h.commit({ control: "contrast", overrides: BRIGHT(58) });
  await h.complete(wanted.requestId);
  assert.strictEqual(h.truth.displayed("c").overrideHash, TRUTH.overrideHash(BRIGHT(58)));

  h.record.frame = { presetId: "p1", overrideHash: TRUTH.overrideHash(BRIGHT(70)), holeNumber: 7 };
  h.truth.settle(abandoned.requestId, { ok: true });
  await flush();

  assert.strictEqual(h.truth.displayed("c").overrideHash, TRUTH.overrideHash(BRIGHT(70)),
    "the record really did get overwritten - that is the situation being recovered from");
  assert.strictEqual(h.truth.needsReconcile("c"), true, "the disagreement must be noticed");
  h.truth.markReconciled("c");
  assert.strictEqual(h.truth.needsReconcile("c"), false, "and acted on once, not in a loop");
});

/* ------------------------------------------------------------------ I ---- */
test("I · mowing visibility is an enum, and every value is read correctly", () => {
  assert.strictEqual(TRUTH.mowingActive("Unknown"), false);
  assert.strictEqual(TRUTH.mowingActive("Low"), true);
  assert.strictEqual(TRUTH.mowingActive("Clear"), true);
  assert.strictEqual(TRUTH.mowingActive("Prominent"), true);
  assert.strictEqual(TRUTH.mowingActive(0), false);
  assert.strictEqual(TRUTH.mowingActive(undefined), false);

  /* The old test was Number(value) > .02, which is NaN for every real setting - so
     the chip was off at Prominent. */
  assert.strictEqual(Number("Prominent") > 0.02, false, "the reason the old test never fired");

  const on = TRUTH.ingredientStates({
    current: { mowingVisibility: "Prominent" },
    displayed: { mowingVisibility: "Prominent" },
    pipeline: { state: "idle" }
  }).find((c) => c.id === "mow");
  assert.strictEqual(on.state, "confirmed");

  const changing = TRUTH.ingredientStates({
    current: { mowingVisibility: "Prominent" },
    displayed: { mowingVisibility: "Unknown" },
    pipeline: { state: TRUTH.STATE.RENDERING }
  }).find((c) => c.id === "mow");
  assert.strictEqual(changing.state, "applying");
});

/* ------------------------------------------------------------------ J ---- */
test("J · Terrain is confirmed by the main phone, never by its own small preview", async () => {
  /* The main preview keeps showing the styled bake: the small Terrain tool preview
     updating is a diagnostic, not a claim about the course preview. */
  let showTerrain = false;
  const h = makeHarness({
    paint(courseId, record) {
      if (showTerrain && record.terrainRequestId) {
        return { kind: "terrain", requestId: record.terrainRequestId, holeNumber: 7 };
      }
      return record.frame ? Object.assign({ kind: "bake" }, record.frame) : null;
    }
  });

  const first = h.truth.commit({
    courseId: "c", holeNumber: 7, presetId: "p1", overrides: { visualTools: { holeTerrainStrength: 0.9 } },
    control: "terrain", label: "Terrain", kind: "terrain",
    run(request) { h.record.terrainRequestId = request.requestId; return Promise.resolve({ ok: true }); }
  });
  await flush(); await flush();
  await h.clock.advance(2000);

  assert.strictEqual(h.truth.terrainConfirmed("c"), false,
    "the small preview succeeded but the phone never swapped - not confirmed");
  const unconfirmed = TRUTH.ingredientStates({
    current: { visualTools: { holeTerrainStrength: 0.9 } },
    displayed: null,
    pipeline: h.truth.status("c"),
    terrain: { confirmed: h.truth.terrainConfirmed("c") }
  }).find((c) => c.id === "terrain");
  assert.strictEqual(unconfirmed.state, "unconfirmed");
  assert.match(unconfirmed.text, /not in displayed frame/);
  assert.strictEqual(first.state, TRUTH.STATE.RENDERED, "rendered, but not what the phone is showing");

  /* Now the main preview does swap to the terrain render. */
  showTerrain = true;
  const second = h.truth.commit({
    courseId: "c", holeNumber: 7, presetId: "p1", overrides: { visualTools: { holeTerrainStrength: 0.9 } },
    control: "terrain", label: "Terrain", kind: "terrain",
    run(request) { h.record.terrainRequestId = request.requestId; return Promise.resolve({ ok: true }); }
  });
  await flush(); await flush();

  assert.strictEqual(second.state, TRUTH.STATE.DISPLAYED);
  assert.strictEqual(h.truth.terrainConfirmed("c"), true);
  const confirmed = TRUTH.ingredientStates({
    current: { visualTools: { holeTerrainStrength: 0.9 } },
    displayed: null,
    pipeline: h.truth.status("c"),
    terrain: { confirmed: h.truth.terrainConfirmed("c") }
  }).find((c) => c.id === "terrain");
  assert.strictEqual(confirmed.state, "confirmed");
  assert.strictEqual(confirmed.text, "Terrain — preview confirmed");
});

/* ------------------------------------------------------------------ K ---- */
test("K · Reset Recipe committed mid-render is the recipe that ends up on screen", async () => {
  const h = makeHarness();
  const inflight = h.commit({ control: "brightness", overrides: BRIGHT(70) });
  const reset = h.commit({ control: "reset", label: "Reset recipe", overrides: BRIGHT(52) });

  assert.strictEqual(h.truth.queued("c").requestId, reset.requestId);
  await h.complete(inflight.requestId);
  await h.complete(reset.requestId);

  assert.strictEqual(reset.state, TRUTH.STATE.DISPLAYED);
  assert.strictEqual(h.truth.displayed("c").overrideHash, TRUTH.overrideHash(BRIGHT(52)),
    "the frame on screen must be the reset recipe, not the request it interrupted");
  assert.match(h.truth.statusText("c"), /^✓ Reset recipe applied to H7/);
});

/* ------------------------------------------------------- confirmation rule - */
test("a frame whose recipe cannot be identified confirms nothing", () => {
  const chips = TRUTH.ingredientStates({
    current: { lighting: { brightnessTarget: 64, contrastTarget: 1.2 }, floodlight: { enabled: true } },
    displayed: null,                       /* cloud frame / raw capture */
    pipeline: { state: "idle" }
  });
  chips.filter((c) => c.wanted).forEach((chip) => {
    assert.notStrictEqual(chip.state, "confirmed", chip.id + " must not be green against an unidentified frame");
  });
});

test("a request snapshot is immutable - moving the form cannot rewrite it", async () => {
  const h = makeHarness();
  const overrides = BRIGHT(56);
  const a = h.commit({ control: "brightness", overrides });
  overrides.lighting.brightnessTarget = 99;      /* the form moves on */
  assert.strictEqual(a.overrides.lighting.brightnessTarget, 56, "the snapshot must not follow the form");
  await h.complete(a.requestId);
  assert.strictEqual(h.truth.displayed("c").overrideHash, TRUTH.overrideHash(BRIGHT(56)));
});

test("the override hash matches the one the engine stamps onto a baked frame", () => {
  const start = ENGINE_SRC.indexOf("function hashString(value){");
  const end = ENGINE_SRC.indexOf("function readJson(");
  assert.ok(start > -1 && end > start, "engine hashString not found");
  // eslint-disable-next-line no-new-func
  const engineHash = new Function(ENGINE_SRC.slice(start, end) + "\nreturn hashString;")();
  [
    {}, { a: 1 },
    { lighting: { brightnessTarget: 56, contrastTarget: 1.12 } },
    { turf: { hueMin: 86, hueMax: 142 }, mowingVisibility: "Clear" }
  ].forEach((value) => {
    assert.strictEqual(TRUTH.overrideHash(value), engineHash(value),
      "hash drift would silently stop every frame confirming: " + JSON.stringify(value));
  });
});

/* ---------------------------------------------------------------- H (DOM) - */
/* The controls jumping had two causes, and this covers the one that could be
   reproduced without a browser: a full panel rebuild reconstructs every control
   from the saved recipe, so a control moved since the last save is reset by
   whatever async render happens to land next. */
function makeFakeDom(values) {
  const elements = {};
  Object.keys(values).forEach((id) => {
    const spec = values[id];
    elements[id] = {
      id,
      type: spec.type || "range",
      value: spec.value,
      checked: !!spec.checked,
      focus() { document.activeElement = this; }
    };
  });
  const document = {
    activeElement: null,
    getElementById: (id) => elements[id] || null,
    querySelector: (sel) => (sel === ".gdAdminCourseVisualControls" ? {} : null)
  };
  return { document, elements };
}

function liftFormGuards(document) {
  const start = STUDIO_SRC.indexOf("const GD_VISUAL_CONTROL_IDS=[");
  const end = STUDIO_SRC.indexOf("function gdAdminCoursePreviewSelectedFor(");
  assert.ok(start > -1 && end > start, "form-guard region not found in gd-admin-course-db.js");
  // eslint-disable-next-line no-new-func
  return new Function("document", STUDIO_SRC.slice(start, end)
    + "\nreturn {gdAdminCourseVisualFormSnapshot,gdAdminCourseVisualRestoreForm,"
    + "gdAdminCourseVisualControlsBusy,gdAdminCourseVisualNoteInteraction,GD_VISUAL_CONTROL_IDS};")(document);
}

test("H · a render completing does not drag a slider back to its saved value", () => {
  const dom = makeFakeDom({
    gdCourseVisualBrightness: { value: "56" },
    gdCourseVisualContrast: { value: "1.04" },
    gdCourseVisualFloodOn: { type: "checkbox", checked: true }
  });
  const guards = liftFormGuards(dom.document);

  /* Slider A (brightness) was released at 56 and is baking. The operator has since
     moved slider B (contrast) to 1.30 - not yet released, so nothing has saved it. */
  dom.elements.gdCourseVisualContrast.value = "1.30";

  /* A's bake finishes and the panel is rebuilt from the SAVED recipe. */
  const snapshot = guards.gdAdminCourseVisualFormSnapshot();
  dom.elements.gdCourseVisualContrast.value = "1.04";   // what a rebuild puts back
  dom.elements.gdCourseVisualFloodOn.checked = false;
  guards.gdAdminCourseVisualRestoreForm(snapshot);

  assert.strictEqual(dom.elements.gdCourseVisualContrast.value, "1.30",
    "the contrast slider must not jump back to the value A's bake started from");
  assert.strictEqual(dom.elements.gdCourseVisualFloodOn.checked, true,
    "checkbox state must survive a rebuild too");
});

test("H · a full render is deferred while a control is being worked", () => {
  const dom = makeFakeDom({ gdCourseVisualBrightness: { value: "56" } });
  const guards = liftFormGuards(dom.document);
  assert.strictEqual(guards.gdAdminCourseVisualControlsBusy(), false, "idle to start with");
  guards.gdAdminCourseVisualNoteInteraction(true);
  assert.strictEqual(guards.gdAdminCourseVisualControlsBusy(), true, "pointer down on the dock is busy");
  guards.gdAdminCourseVisualNoteInteraction(false);
  assert.strictEqual(guards.gdAdminCourseVisualControlsBusy(), true,
    "and stays busy for a short tail after release, while the commit runs");
});

/* ------------------------------------------------------------------ L ---- */
/* Cloud-built courses. The server worker captures and composes frames entirely
   server-side, so a browser that never scanned locally holds an EMPTY visual record -
   and the scoped bake died with hole-frame-missing on every commit. The fix acquires
   the hole's published cloud frame as the bake base. This lifts the acquisition
   function and runs it against a stubbed engine + assets API. */
function liftEnsureBakeBase(env) {
  const start = STUDIO_SRC.indexOf("const gdAdminCourseVisualBaseEnsurePending={};");
  const end = STUDIO_SRC.indexOf("/* Every non-terrain preview goes through here", start);
  assert.ok(start > -1 && end > start, "base-acquisition region not found");
  // eslint-disable-next-line no-new-func
  return new Function("window", "fetch", "FileReader", "gdAdminCourseVisualRecord",
    "GD_VISUAL_RECIPE_LAB_ID", "gdAdminCourseRecipeLabSelected",
    STUDIO_SRC.slice(start, end)
    + "\nreturn {gdAdminCourseVisualEnsureBakeBase,gdAdminCourseVisualBaseEntryFor};")(
    env.window, env.fetch, env.FileReader, env.gdAdminCourseVisualRecord,
    "recipe-lab", env.recipeLabSelected || (() => ({ donor: null })));
}

function makeCloudEnv(options) {
  options = options || {};
  const stored = { records: {} };
  const assetStore = {};
  const engine = {
    saveCaptureImage: (path, dataUrl) => { assetStore[path] = dataUrl; return Promise.resolve(true); },
    loadCaptureImage: (path) => Promise.resolve(assetStore[path] || null),
    getRecord: (id) => JSON.parse(JSON.stringify(stored.records[id] || { courseId: id, holeFrameVisuals: [] })),
    loadStore: () => ({ records: JSON.parse(JSON.stringify(stored.records)) }),
    saveStore: (store) => { stored.records = store.records; return store; }
  };
  const fetches = [];
  const env = {
    stored, assetStore, fetches,
    window: { GDCourseVisualEngine: engine },
    gdAdminCourseVisualRecord: (id) => stored.records[id] || null,
    fetch: (url) => {
      fetches.push(String(url));
      const path = decodeURIComponent(String(url).split("path=")[1] || "");
      if (options.index && path.endsWith("/frames/index.json")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(options.index) });
      }
      if (options.index && (options.index.holes || []).some((h) => h.path === path)) {
        return Promise.resolve({
          ok: true,
          headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "image/jpeg" : "") },
          blob: () => Promise.resolve({ __frame: path })
        });
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.reject(new Error("404")) });
    },
    FileReader: class {
      readAsDataURL(blob) { this.result = "data:image/jpeg;base64,FRAME:" + blob.__frame; setImmediate(() => this.onload()); }
    }
  };
  return env;
}

test("L · a cloud-built course acquires its bake base from the published frame", async () => {
  const index = {
    exportVersion: "rtest1", presetId: "p1",
    holes: [{ holeNumber: 7, path: "nc/frames/rtest1/h7.jpg", width: 400, height: 400, bounds: { south: 1 }, playSurface: { model: "mercator-image" } }]
  };
  const env = makeCloudEnv({ index });
  const lifted = liftEnsureBakeBase(env);

  const result = await lifted.gdAdminCourseVisualEnsureBakeBase("nc", 7);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.acquired, true);

  const rec = env.stored.records.nc;
  const base = rec.holeFrameVisuals.find((f) => f.holeNumber === 7);
  assert.ok(base, "a base frame entry must be installed on the record");
  assert.strictEqual(base.path, "nc/frames/rtest1/h7.jpg");
  assert.strictEqual(base.dataUrl, undefined, "the record entry is path-only - pixels stay in the asset store");
  assert.strictEqual(base.metadata.baseSource, "cloud-frame", "provenance must be recorded");
  assert.ok(env.assetStore["nc/frames/rtest1/h7.jpg"].startsWith("data:image/jpeg"), "pixels must land in the asset store under the same path");

  /* Second commit: the pixel probe finds the stored frame - no refetch. */
  const before = env.fetches.length;
  const again = await lifted.gdAdminCourseVisualEnsureBakeBase("nc", 7);
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.acquired, undefined, "already present - nothing downloaded");
  assert.strictEqual(env.fetches.length, before, "no network traffic on the second pass");

  /* A path-only entry whose PIXELS are gone is reacquired, not trusted. */
  delete env.assetStore["nc/frames/rtest1/h7.jpg"];
  const healed = await lifted.gdAdminCourseVisualEnsureBakeBase("nc", 7);
  assert.strictEqual(healed.ok, true);
  assert.strictEqual(healed.acquired, true, "an empty probe must trigger reacquisition");
  assert.ok(env.assetStore["nc/frames/rtest1/h7.jpg"], "the pixels are back in the asset store");
});

test("L · a wrong-course index or non-image frame is refused, never installed", async () => {
  /* The production incident: the assets endpoint 502ed for uncaptured courses, and the
     CDN's stale-if-error served NORTH SHORE's cached index for ANY course's URL - so
     the Studio installed north-shore imagery as balgove's bake base. Neither half of
     that may ever be trusted again. */
  const poisoned = makeCloudEnv({
    index: { courseId: "north-shore", exportVersion: "rq3mud4", holes: [{ holeNumber: 7, path: "north-shore/frames/rq3mud4/h7.jpg", width: 400, height: 400 }] }
  });
  const lifted = liftEnsureBakeBase(poisoned);
  const result = await lifted.gdAdminCourseVisualEnsureBakeBase("balgove", 7);
  assert.strictEqual(result.ok, false, "an index naming a different course must be refused");
  assert.match(result.reason, /wrong course/i);
  assert.ok(!poisoned.stored.records.balgove, "nothing may be installed from it");

  /* A frame URL answering with JSON (the stale index body) is not an image. */
  const jsonFrame = makeCloudEnv({
    index: { courseId: "nc", exportVersion: "r1", holes: [{ holeNumber: 7, path: "nc/frames/r1/h7.jpg" }] }
  });
  jsonFrame.fetch = ((real) => (url) => real(url).then((res) => {
    const path = decodeURIComponent(String(url).split("path=")[1] || "");
    if (path.endsWith(".jpg")) return { ok: true, headers: { get: () => "application/json" }, blob: () => Promise.resolve({}) };
    return res;
  }))(jsonFrame.fetch);
  const lifted2 = liftEnsureBakeBase(jsonFrame);
  const result2 = await lifted2.gdAdminCourseVisualEnsureBakeBase("nc", 7);
  assert.strictEqual(result2.ok, false);
  assert.match(result2.reason, /not an image/i);

  /* A cloud-frame base already installed under another course's path is dropped and
     reacquired, not trusted - this heals browsers poisoned during the incident. */
  const healed = makeCloudEnv({
    index: { courseId: "nc", exportVersion: "r2", holes: [{ holeNumber: 7, path: "nc/frames/r2/h7.jpg", width: 400, height: 400 }] }
  });
  healed.stored.records.nc = { courseId: "nc", holeFrameVisuals: [
    { path: "north-shore/frames/rq3mud4/h7.jpg", holeNumber: 7, metadata: { baseSource: "cloud-frame" } }
  ] };
  healed.assetStore["north-shore/frames/rq3mud4/h7.jpg"] = "data:image/jpeg;base64,WRONGCOURSE";
  const lifted3 = liftEnsureBakeBase(healed);
  const result3 = await lifted3.gdAdminCourseVisualEnsureBakeBase("nc", 7);
  assert.strictEqual(result3.ok, true);
  assert.strictEqual(result3.acquired, true, "the foreign base must be replaced, not reused");
  const base = healed.stored.records.nc.holeFrameVisuals.find((f) => f.holeNumber === 7);
  assert.strictEqual(base.path, "nc/frames/r2/h7.jpg", "the record now points at this course's own frame");
});

test("L · the Recipe Lab captures its sample from the borrowed donor", async () => {
  const index = {
    exportVersion: "rtest1", presetId: "p1",
    holes: [{ holeNumber: 7, path: "nc/frames/rtest1/h7.jpg", width: 400, height: 400 }]
  };
  const env = makeCloudEnv({ index });
  env.recipeLabSelected = () => ({ donor: { courseId: "nc", holeNumber: 7 } });
  const lifted = liftEnsureBakeBase(env);

  const result = await lifted.gdAdminCourseVisualEnsureBakeBase("recipe-lab", 7);
  assert.strictEqual(result.ok, true, "the lab must be able to capture something new for the sample");
  const rec = env.stored.records["recipe-lab"];
  const base = rec && rec.holeFrameVisuals.find((f) => f.holeNumber === 7);
  assert.ok(base, "the sample lands on the LAB record");
  assert.strictEqual(base.path, "nc/frames/rtest1/h7.jpg", "under the donor's own asset path - no rewrite to break hydration");
  assert.strictEqual(base.metadata.baseSource, "cloud-frame");

  /* No donor picked yet: a plain reason, not a mystery. */
  const bare = makeCloudEnv({ index });
  bare.recipeLabSelected = () => ({ donor: null });
  const liftedBare = liftEnsureBakeBase(bare);
  const refused = await liftedBare.gdAdminCourseVisualEnsureBakeBase("recipe-lab", 7);
  assert.strictEqual(refused.ok, false);
  assert.match(refused.reason, /borrow a hole into the lab/i);
});

test("L · a hole with no published frame fails with a reason, not a mystery", async () => {
  const env = makeCloudEnv({ index: { exportVersion: "r1", holes: [{ holeNumber: 1, path: "nc/frames/r1/h1.jpg" }] } });
  const lifted = liftEnsureBakeBase(env);
  const result = await lifted.gdAdminCourseVisualEnsureBakeBase("nc", 9);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /No capture for hole 9/);
  assert.match(result.reason, /Build course visual/);
});

test("L · the failure reason reaches the status line", () => {
  /* The commit run turns {ok:false,reason} into the request error, and statusText
     prints it - assert the wiring exists in both files. */
  assert.ok(STUDIO_SRC.includes('base&&base.ok===false)return {ok:false,error:{message:base.reason'),
    "an acquisition failure must become the request's failure");
  const truthSrc = fs.readFileSync(path.join(ROOT, "scripts", "studio", "gd-studio-preview-truth.js"), "utf8");
  assert.ok(truthSrc.includes('" · " + why'), "the failed status line must carry the reason");
});

test("the Recipe Lab is an explicit place - one button in, one button out, drafts", () => {
  /* Back used to land on the lab itself, making the shell's Back button read as the
     engine's entry point; the only deliberate way in was a borrow button buried on a
     course preview. */
  assert.ok(STUDIO_SRC.includes("let gdAdminCourseVisualLabOpen=false"), "the lab renders only when explicitly opened");
  assert.ok(STUDIO_SRC.includes(">Open Recipe Lab<"), "the doorway panel carries the one button in");
  assert.ok(STUDIO_SRC.includes("gdAdminCourseExitRecipeLab"), "and there is a button out");
  assert.ok(!STUDIO_SRC.includes("Borrow for Recipe Lab</button>"), "the borrow button moved inside the lab as the donor picker");
  assert.ok(STUDIO_SRC.includes('id="gdRecipeLabDonorCourse"') && STUDIO_SRC.includes('id="gdRecipeLabDonorHole"'), "donor choice lives inside the lab");
  assert.ok(STUDIO_SRC.includes("gdAdminCourseRecipeLabSaveDraft") && STUDIO_SRC.includes("gdAdminCourseRecipeLabResumeDraft") && STUDIO_SRC.includes("gdAdminCourseRecipeLabDiscardDraft"), "draft save/resume/discard exist");
  assert.ok(STUDIO_SRC.includes("gdAdminCourseRecipeLabStashIfDirty()"), "leaving the lab stashes unsaved tweaks");
  const exitFn = STUDIO_SRC.slice(STUDIO_SRC.indexOf("function gdAdminCourseExitRecipeLab("), STUDIO_SRC.indexOf("function gdAdminCourseRecipeLabSetDonor("));
  assert.ok(exitFn.includes("gdAdminCourseRecipeLabStashIfDirty()"), "Exit stashes before leaving");
  assert.ok(exitFn.includes("gdAdminCourseVisualLabReturnTo"), "Exit returns to the course you came from");
});

test("the preview zoom is view-only and survives repaints", () => {
  /* Wheel zoom + drag pan on the phone preview. It must be a CSS transform on the
     frame host - never anything that changes which frame is displayed or how the
     truth model identifies it. */
  assert.ok(STUDIO_SRC.includes("function gdAdminPhoneZoomApply("), "zoom apply exists");
  assert.ok(STUDIO_SRC.includes('document.addEventListener("wheel",gdAdminPhoneZoomWheel,{capture:true,passive:false})'),
    "wheel must be non-passive or preventDefault is ignored");
  const zoomRegion = STUDIO_SRC.slice(STUDIO_SRC.indexOf("const gdAdminPhoneZoom={"), STUDIO_SRC.indexOf("function gdAdminPhoneZoomDblClick("));
  assert.ok(!zoomRegion.includes("noteDisplayedFrame") && !zoomRegion.includes("CommitBake"),
    "zoom must not touch the truth pipeline");
  const refresh = STUDIO_SRC.slice(STUDIO_SRC.indexOf("function gdAdminCoursePreviewRefreshFrame("), STUDIO_SRC.indexOf("function gdAdminCoursePreviewNoteDisplayedFrame("));
  assert.ok(refresh.includes("gdAdminPhoneZoomApply()"), "a repaint must reinstate the viewing transform");
  assert.ok(STUDIO_SRC.includes('id="gdVisualZoomChip"'), "the zoom chip with Reset exists");
});

test("every effect group has an explicit on/off switch plus its adjustments", () => {
  ["gdCourseVisualTurfOn", "gdCourseVisualLightingOn", "gdCourseVisualFloodOn", "gdCourseVisualTerrainOn", "gdCourseVisualMowingOn"].forEach((id) => {
    assert.ok(STUDIO_SRC.includes('"' + id + '"'), id + " switch must exist");
  });
  assert.ok(STUDIO_SRC.includes("function gdAdminCourseVisualEffectToggled("), "switches route through one handler");
  assert.ok(STUDIO_SRC.includes("gdAdminCourseVisualCommitBake(courseId,{")
    && STUDIO_SRC.slice(STUDIO_SRC.indexOf("function gdAdminCourseVisualEffectToggled(")).slice(0, 3000).includes("gdAdminCourseVisualCommitBake("),
    "a toggle is an adjustment like any other - it commits through the truth queue");
  /* Off must be the group's REAL off-values (the ones Reset uses), not merely a dimmed panel. */
  const offFn = STUDIO_SRC.slice(STUDIO_SRC.indexOf("function gdAdminCourseVisualEffectApplyOff("), STUDIO_SRC.indexOf("function gdAdminCourseVisualEffectApplyOn("));
  assert.ok(offFn.includes('set("gdCourseVisualTargetPull",0)') && offFn.includes("greenStrength:0"), "turf off");
  assert.ok(offFn.includes('set("gdCourseVisualBrightness",52)') && offFn.includes('set("gdCourseVisualContrast",1)'), "lighting off");
  assert.ok(offFn.includes('set("gdCourseVisualTerrainStrength",0)'), "terrain off");
  assert.ok(offFn.includes('set("gdCourseVisualMowing","Unknown")'), "mow lines off");
  /* And the switch state is read with the SAME predicates the ingredient chips use. */
  assert.ok(STUDIO_SRC.includes("function gdAdminCourseVisualEffectIsOn("), "switch state is derived from the recipe, not stored separately");
});

test("the Recipe Lab's terrain preview shades the donor's hole, not 'recipe-lab'", () => {
  const src = STUDIO_SRC.slice(STUDIO_SRC.indexOf("function gdAdminCourseVisualReliefSrc("), STUDIO_SRC.indexOf("function gdAdminCourseVisualReliefRefresh("));
  assert.ok(src.includes("GD_VISUAL_RECIPE_LAB_ID") && src.includes("donor.courseId"),
    "the server does not know 'recipe-lab' - relief must target the donor course and hole");
});

/* --------------------------------------------------------- source contract - */
test("the dropped-adjustment guard is gone from the commit path", () => {
  const start = STUDIO_SRC.indexOf("function gdAdminCourseVisualControlCommitted(");
  const end = STUDIO_SRC.indexOf("function gdAdminCourseVisualPresetChanged(", start);
  assert.ok(start > -1 && end > start);
  const body = STUDIO_SRC.slice(start, end);
  assert.ok(!body.includes("gdAdminCourseVisualBakePending["),
    "a committed adjustment must never be discarded because another bake is running");
  assert.ok(body.includes("gdAdminCourseVisualCommitBake("),
    "committed adjustments must go through the queue");
  /* Terrain still short-circuits before the local bake. */
  assert.ok(body.indexOf('gdAdminCourseVisualActiveTool==="terrain"') < body.indexOf("gdAdminCourseVisualCommitBake("));
});

test("the ingredient list is not computed from the settings any more", () => {
  assert.ok(!STUDIO_SRC.includes("function gdAdminCourseVisualActiveEffects("),
    "the settings-derived ingredient list must be gone");
  assert.ok(!STUDIO_SRC.includes("Number(settings.mowingVisibility||0)>.02"),
    "the NaN mowing test must be gone");
  assert.ok(STUDIO_SRC.includes("function gdAdminCourseVisualIngredients("),
    "ingredients must come from the truth model");
  assert.ok(STUDIO_SRC.includes("function gdAdminCoursePreviewNoteDisplayedFrame("),
    "the displayed frame must be reported to the truth model");
});

test("the recipe controls have exactly one handler", () => {
  assert.ok(!STUDIO_SRC.includes('oninput="return gdAdminCourseVisualControlChanged'),
    "inline oninput duplicated the delegated listener");
  assert.ok(!STUDIO_SRC.includes('onchange="return gdAdminCourseVisualControlCommitted'),
    "inline onchange committed a second time after the delegated listener");
  assert.ok(STUDIO_SRC.includes("document.addEventListener(\"change\",gdAdminCourseVisualControlEvent,true)"),
    "the delegated listener is the single owner");
});

test("a bake completing does not rebuild the whole panel", () => {
  const start = STUDIO_SRC.indexOf("function gdAdminCourseVisualPreviewChanged(");
  const end = STUDIO_SRC.indexOf("function gdAdminCourseVisualReconcile(", start);
  assert.ok(start > -1 && end > start);
  const body = STUDIO_SRC.slice(start, end);
  assert.ok(!body.includes("gdRenderAdminCourseDatabase("),
    "preview completion must update the image, status and chips - not the controls");
  assert.ok(body.includes("gdAdminCoursePreviewRefreshFrame(")
    && body.includes("gdAdminCourseVisualSyncPreviewChrome("));
});

test("the full render defends the live control values", () => {
  const start = STUDIO_SRC.indexOf("function gdRenderAdminCourseDatabase(){");
  const end = STUDIO_SRC.indexOf("function gdRenderAdminCourseDatabaseNow(){", start);
  assert.ok(start > -1 && end > start, "the render guard must wrap the render");
  const body = STUDIO_SRC.slice(start, end);
  assert.ok(body.includes("gdAdminCourseVisualControlsBusy()"), "deferred while a control is being worked");
  assert.ok(body.includes("gdAdminCourseVisualFormSnapshot()") && body.includes("gdAdminCourseVisualRestoreForm("),
    "live values lifted and put back around the rebuild");
});

(async function run() {
  let passed = 0;
  const failures = [];
  for (const t of tests) {
    try { await t.fn(); passed += 1; console.log("  ok   " + t.name); }
    catch (error) { failures.push({ name: t.name, error }); console.log("  FAIL " + t.name); }
  }
  console.log("\n" + passed + "/" + tests.length + " passed");
  if (failures.length) {
    failures.forEach((f) => { console.error("\n" + f.name + "\n" + (f.error && f.error.stack || f.error)); });
    process.exit(1);
  }
  console.log("studio-preview-truth passed");
})();
