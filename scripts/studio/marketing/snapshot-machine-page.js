/* Clarity Studio — Marketing › Snapshot Machine. Studio-only.
 *
 * The control room for a marketing screenshot run. It does four things, in order, and none of
 * them takes a picture:
 *
 *   1. BASKET   — the real course picker (window.GDCoursePicker, pick-only mode) adds courses
 *                 one at a time to a basket that persists across reloads. Multi-select is the
 *                 basket, not a multi-select picker: the picker resolves ONE course properly —
 *                 pin, location, canonical key, duplicate guard — and re-using it per course
 *                 is what keeps every row in the basket a real, resolvable course id rather
 *                 than a name somebody typed.
 *   2. BUILD    — the full map build, as a dependency-ordered chain of the SAME six actions
 *                 the Course Database page already exposes one at a time (see gd-admin-course-
 *                 db.js). Nothing new is queued here and no new endpoint exists for it; this
 *                 page only knows what has to finish before what.
 *   3. PLAN     — reads the built package back and chooses two holes per course
 *                 (scripts/gd-marketing-snapshot-core.js), optionally lifted by signature-hole
 *                 evidence from /api/marketing-hole-intel. Every choice is overridable.
 *   4. EMIT     — writes snapshot-plan.json. That file is the whole contract with the camera.
 *
 * WHY THE CAMERA IS NOT HERE. A browser page cannot screenshot itself at a device resolution
 * it is not being displayed at, and marketing needs 1170x2532 from a 390x844 layout. So the
 * pixels come from marketing/run-snapshots.mjs — Playwright, headless Chromium, the real
 * app/index.html — and this page's job ends at the plan. The split is also why the hole
 * choosing lives in a shared pure module: the runner has to reach the same holes hours later
 * with no Studio open.
 *
 * THE BUILDS ARE REAL. Every action in step 2 writes to the live Supabase project, the same as
 * pressing the equivalent button on the Course Database page. The chain is only ever started
 * by an explicit click and says out loud what it is about to do. */
(function () {
  "use strict";

  var STORE_KEY = "clarity:studio:marketing-snapshots:v1";

  /* The chain, in dependency order, and what each step waits for. `kind` picks the endpoint;
     `done` is asked of the polled state and answers "may the next step start".

     Ordering is not cosmetic. Scorecards before object collection because the hole picker
     needs par to obey Sam's "par 4 or 5 for the tee shot" rule and a scorecard resolve can
     rename holes. Collection before the visual snapshot because collection writes the surfaces
     the frames are captured over. Export after snapshot because the export composites the
     captures. Refine LAST because it re-traces those surfaces against the exported frames —
     run earlier it 409s with "no frames to trace against", which is a precondition, not a
     failure (see gdAdminCourseRefineShapes). */
  var CHAIN = [
    { id: "remap", label: "Map from OpenStreetMap", api: "mapper", kind: "remap",
      why: "Tees, greens and hole routes. Everything below depends on this." },
    { id: "scorecard", label: "Update scorecards", api: "scorecard", kind: null,
      why: "Par per hole — the tee-shot frame has to land on a par 4 or 5." },
    { id: "collect_extra_objects", label: "Collect extra objects", api: "mapper", kind: "collect_extra_objects",
      why: "Bunkers, fairways and water. This is what the hole picker scores." },
    { id: "snapshot", label: "Capture imagery & terrain", api: "visual", kind: "snapshot",
      why: "Owned pixels per hole. Without these the run shoots an OSM basemap." },
    { id: "export", label: "Apply visual treatment", api: "visual", kind: "export",
      why: "The flattened play surface the screenshots actually show." },
    { id: "refine_surface_shapes", label: "Refine shapes", api: "mapper", kind: "refine_surface_shapes",
      why: "Re-traces the collected shapes against this course's own frames." }
  ];

  /* ------------------------------------------------------------------ storage */

  function readStore() {
    try {
      var raw = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (!raw || !Array.isArray(raw.courses)) return { courses: [], intel: true, baseUrl: "" };
      return { courses: raw.courses, intel: raw.intel !== false, baseUrl: String(raw.baseUrl || "") };
    } catch (e) { return { courses: [], intel: true, baseUrl: "" }; }
  }

  function writeStore(state) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  /* ------------------------------------------------------------------ small helpers */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function el(tag, className, html) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (html != null) node.innerHTML = html;
    return node;
  }

  function num(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  async function accessToken() {
    /* The Course Database's own resolver, already loaded on this surface. Duplicating it here
       would be a second place for the "signed in but the token expired" case to be handled. */
    if (typeof window.gdAdminCourseDbAccessToken === "function") return window.gdAdminCourseDbAccessToken();
    try {
      var auth = window.ClaritySupabaseAuth;
      if (auth && typeof auth.freshAccessToken === "function") return (await auth.freshAccessToken()) || "";
    } catch (e) {}
    return "";
  }

  /* ------------------------------------------------------------------ the page */

  function render(containerEl) {
    var state = readStore();
    var destroyed = false;
    var pollTimer = null;
    var pickerWatch = null;
    var pickerTimer = null;
    /* Per-course run state, keyed by courseId. Deliberately NOT persisted: a build chain that
       was mid-flight when the tab closed is not still mid-flight in this page's sense — the
       server job may well have finished, and resuming a remembered "step 4 of 6" would lie
       about what has been checked. Reopening the page re-reads the server. */
    var runs = {};

    var root = el("div", "gdMktRoot");
    containerEl.appendChild(root);

    var intro = el("div", "gdStudioLede",
      "<p>Marketing screenshot runs. Pick courses with the real course search, build their maps, " +
      "then let the machine choose the holes and write the plan. The screenshots themselves are taken by " +
      "<code>npm run marketing:snapshots</code>, which reads that plan — a browser page cannot capture " +
      "itself at phone resolution.</p>");
    root.appendChild(intro);

    var warn = el("div", "gdMktWarn",
      "<strong>These builds are real.</strong> Every step below queues the same production job the " +
      "Course Database buttons queue, against the live Supabase project.");
    root.appendChild(warn);

    // ---- section 1: the basket
    var basketHead = el("div", "gdMktSectionHead");
    basketHead.appendChild(el("h3", null, "1 &middot; Courses"));
    var addBtn = el("button", "gdStudioDiagramBtn", "Add a course");
    addBtn.type = "button";
    var clearBtn = el("button", "gdStudioDiagramBtn", "Clear all");
    clearBtn.type = "button";
    basketHead.appendChild(addBtn);
    basketHead.appendChild(clearBtn);
    root.appendChild(basketHead);

    var basketEl = el("div", "gdMktBasket");
    root.appendChild(basketEl);

    // ---- section 2: the build
    var buildHead = el("div", "gdMktSectionHead");
    buildHead.appendChild(el("h3", null, "2 &middot; Full map build"));
    var buildBtn = el("button", "gdStudioDiagramBtn", "Build selected courses");
    buildBtn.type = "button";
    var buildStopBtn = el("button", "gdStudioDiagramBtn", "Stop watching");
    buildStopBtn.type = "button";
    buildHead.appendChild(buildBtn);
    buildHead.appendChild(buildStopBtn);
    root.appendChild(buildHead);

    var chainNote = el("p", "gdStudioMuted",
      "Six steps per course, in dependency order: " +
      CHAIN.map(function (s) { return esc(s.label); }).join(" &rarr; ") +
      ". Already-satisfied steps are skipped. A course that is already fully built can go straight to step 3.");
    root.appendChild(chainNote);

    var buildEl = el("div", "gdMktBuild");
    root.appendChild(buildEl);

    // ---- section 3: the plan
    var planHead = el("div", "gdMktSectionHead");
    planHead.appendChild(el("h3", null, "3 &middot; Hole selection"));
    var planBtn = el("button", "gdStudioDiagramBtn", "Plan selected courses");
    planBtn.type = "button";
    var intelLabel = el("label", "gdMktToggle",
      '<input type="checkbox" id="gdMktIntel"' + (state.intel ? " checked" : "") + "> Look up the signature hole first");
    planHead.appendChild(planBtn);
    planHead.appendChild(intelLabel);
    root.appendChild(planHead);

    var planNote = el("p", "gdStudioMuted",
      "Signature-hole evidence outranks terrain when a club actually names one. When the search finds " +
      "nothing — the ordinary case — the tee-shot hole is the par 4 or 5 with the most varied corridor " +
      "terrain, and the approach hole is the one with the most varied green surrounds.");
    root.appendChild(planNote);

    var planEl = el("div", "gdMktPlan");
    root.appendChild(planEl);

    // ---- section 4: the plan file
    var outHead = el("div", "gdMktSectionHead");
    outHead.appendChild(el("h3", null, "4 &middot; Run it"));
    var downloadBtn = el("button", "gdStudioDiagramBtn", "Download snapshot-plan.json");
    downloadBtn.type = "button";
    var copyBtn = el("button", "gdStudioDiagramBtn", "Copy JSON");
    copyBtn.type = "button";
    outHead.appendChild(downloadBtn);
    outHead.appendChild(copyBtn);
    root.appendChild(outHead);

    var outEl = el("div", "gdMktOut");
    root.appendChild(outEl);

    // ------------------------------------------------------------ basket rendering

    function selected() {
      return state.courses.filter(function (c) { return c.include !== false; });
    }

    function renderBasket() {
      if (!state.courses.length) {
        basketEl.innerHTML = '<p class="gdStudioMuted">No courses yet. <strong>Add a course</strong> opens the ' +
          "real course search — pick one, and it lands here. Repeat for as many as you want in the run.</p>";
        return;
      }
      basketEl.innerHTML = "";
      state.courses.forEach(function (course, index) {
        var row = el("div", "gdMktRow");
        var check = el("input");
        check.type = "checkbox";
        check.checked = course.include !== false;
        check.addEventListener("change", function () {
          state.courses[index].include = check.checked;
          persist();
          renderAll();
        });
        var body = el("div", "gdMktRowBody",
          "<strong>" + esc(course.name || course.courseId) + "</strong>" +
          '<span class="gdStudioMuted"> &middot; <code>' + esc(course.courseId) + "</code>" +
          (course.lat != null && course.lng != null
            ? " &middot; " + course.lat.toFixed(4) + ", " + course.lng.toFixed(4)
            : " &middot; no coordinates") + "</span>");
        var remove = el("button", "gdStudioCopyPath", "Remove");
        remove.type = "button";
        remove.addEventListener("click", function () {
          state.courses.splice(index, 1);
          persist();
          renderAll();
        });
        row.appendChild(check);
        row.appendChild(body);
        row.appendChild(remove);
        basketEl.appendChild(row);
      });
    }

    function persist() {
      state.intel = !!document.getElementById("gdMktIntel").checked;
      writeStore(state);
    }

    // ------------------------------------------------------------ the picker hand-off

    /* Same shape as the Studio map viewport's hand-off, and for the same reason: the picker is
       a full-screen app surface, and it closes two ways — a pick, which calls back, and Back
       or Home, which do not. Only the DOM sees both. */
    function stopWatch() {
      if (pickerWatch) { try { pickerWatch.disconnect(); } catch (e) {} pickerWatch = null; }
      if (pickerTimer) { clearTimeout(pickerTimer); pickerTimer = null; }
    }

    function restoreStudio() {
      if (window.GDStudioShell) window.GDStudioShell.show();
    }

    function watchPicker() {
      stopWatch();
      var screen = document.getElementById("courseScreen");
      if (!screen) return;
      var seenOpen = false;
      pickerWatch = new MutationObserver(function () {
        if (!screen.classList.contains("hidden")) { seenOpen = true; return; }
        if (!seenOpen) return;
        stopWatch();
        restoreStudio();
      });
      pickerWatch.observe(screen, { attributes: true, attributeFilter: ["class"] });
      pickerTimer = setTimeout(function () { if (!seenOpen) { stopWatch(); restoreStudio(); } }, 4000);
    }

    addBtn.addEventListener("click", function () {
      if (!window.GDCoursePicker || typeof window.GDCoursePicker.open !== "function") {
        basketEl.innerHTML = '<p class="gdStudioMuted">The course picker is not loaded on this surface.</p>';
        return;
      }
      watchPicker();
      if (window.GDStudioShell) window.GDStudioShell.hide();
      window.GDCoursePicker.open({
        source: "studio-marketing-snapshots",
        returnTarget: "home",
        onPick: function (course) {
          stopWatch();
          restoreStudio();
          if (destroyed) return;
          var courseId = String((course && (course.courseId || course.canonicalKey)) || "");
          if (!courseId) return;
          if (state.courses.some(function (c) { return c.courseId === courseId; })) { renderAll(); return; }
          state.courses.push({
            courseId: courseId,
            name: String((course && (course.name || course.courseName)) || courseId),
            lat: num(course && (course.lat != null ? course.lat : course.latitude)),
            lng: num(course && (course.lng != null ? course.lng : course.longitude)),
            include: true
          });
          persist();
          renderAll();
        }
      });
    });

    clearBtn.addEventListener("click", function () {
      if (!state.courses.length) return;
      if (!window.confirm("Remove all " + state.courses.length + " courses from the basket?")) return;
      state.courses = [];
      runs = {};
      persist();
      renderAll();
    });

    // ------------------------------------------------------------ build chain

    async function queueMapper(courseId, kind) {
      var token = await accessToken();
      if (!token) return { ok: false, detail: "Sign in again — no access token." };
      var res = await fetch("/api/course-mapper-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ courseId: courseId, kind: kind })
      });
      var data = await res.json().catch(function () { return null; });
      if (res.ok) return { ok: true, deduped: !!(data && data.deduped) };
      /* 409 is a precondition, not a failure — "nothing to refine yet" means an earlier step
         has not produced its output. The chain reports it and stops that course cleanly. */
      return { ok: false, status: res.status, detail: (data && (data.detail || data.error)) || ("HTTP " + res.status) };
    }

    async function queueVisual(courseId, kind) {
      var token = await accessToken();
      if (!token) return { ok: false, detail: "Sign in again — no access token." };
      var res = await fetch("/api/course-visual-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ courseId: courseId, kind: kind, recipe: null })
      });
      var data = await res.json().catch(function () { return null; });
      if (res.ok && data && data.job) return { ok: true, deduped: !!data.deduped };
      return { ok: false, status: res.status, detail: (data && (data.detail || data.error)) || ("HTTP " + res.status) };
    }

    async function queueScorecard(courseId) {
      var token = await accessToken();
      if (!token) return { ok: false, detail: "Sign in again — no access token." };
      var res = await fetch("/api/course-scorecard-update", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ courseId: courseId })
      });
      var data = await res.json().catch(function () { return null; });
      if (res.ok) return { ok: true, message: (data && data.message) || "" };
      return { ok: false, status: res.status, detail: (data && (data.error || data.detail)) || ("HTTP " + res.status) };
    }

    async function mapperState(courseId) {
      try {
        var res = await fetch("/api/course-mapper-jobs?courseId=" + encodeURIComponent(courseId),
          { headers: { Accept: "application/json" }, cache: "no-store" });
        if (!res.ok) return null;
        var data = await res.json();
        /* The endpoint answers two shapes: a single-course body, and the whole-database map
           keyed by course id when no courseId is given. Accept both so a server change to the
           narrower call cannot silently produce "never finishes". */
        return (data && data.courses && data.courses[courseId]) || data || null;
      } catch (e) { return null; }
    }

    async function visualState(courseId) {
      try {
        var res = await fetch("/api/course-visual-jobs?courseId=" + encodeURIComponent(courseId),
          { headers: { Accept: "application/json" }, cache: "no-store" });
        return res.ok ? await res.json() : null;
      } catch (e) { return null; }
    }

    /* Is this step already satisfied, still running, or not started? Answered from the server
       every poll rather than from what this page queued, so a course somebody built yesterday
       skips straight through and a job queued from the Course Database tab is seen here.
     *
     * The mapper endpoint reports its three kinds in TWO different places, and reading the
     * wrong one is the difference between waiting for a step and walking past it.
     * mapperBuildState's `state`/`activeKind` describe MAPPING only (isMappingJob) — a running
     * Collect Extra Objects or Refine Shapes deliberately does not make a mapped course read as
     * "Processing", so it is reported separately under `maintenance`. Ask each kind where it
     * actually lives. */
    async function stepState(step, courseId) {
      if (step.api === "scorecard") return { phase: "unknown" };   // no queue row; fire and move on
      if (step.api === "mapper") {
        var m = await mapperState(courseId);
        if (!m) return { phase: "unknown" };

        if (step.kind === "remap") {
          /* Geometry already on the course IS the finished state of this step, and it is what
             lets an already-mapped course skip straight to the enrichment steps. It also means
             this chain never re-runs a destructive remap on a course that has geometry — that
             stays a deliberate, separately-confirmed action on the Course Database page. */
          if (m.hasGeometry) return { phase: "done", raw: m };
          if (m.state === "running" || m.state === "queued") return { phase: "running", raw: m };
          if (m.state === "failed") return { phase: "failed", detail: m.lastError || "", raw: m };
          return { phase: "idle", raw: m };
        }

        var maintenance = m.maintenance || null;
        if (maintenance && String(maintenance.kind) === step.kind) {
          /* Shaped for GDProgressCore.mapperProgress, which reads {state, activeKind, progress}
             — the maintenance block carries the same three facts under different names. */
          return { phase: "running", raw: { state: maintenance.state, activeKind: maintenance.kind, progress: maintenance.progress, stalled: maintenance.stalled } };
        }
        if (maintenance) return { phase: "busy-other", raw: m };
        /* A mapping run in flight blocks the enrichment steps too: both read the geometry the
           run is rewriting. */
        if (m.state === "running" || m.state === "queued") return { phase: "busy-other", raw: m };
        return { phase: "idle", raw: m };
      }
      var v = await visualState(courseId);
      if (!v) return { phase: "unknown" };
      var live = !!v.building || v.state === "queued";
      if (live && v.activeKind === step.kind) return { phase: "running", raw: v };
      if (live) return { phase: "busy-other", raw: v };
      if (step.kind === "snapshot" && (v.snapshotReady || v.framesReady)) return { phase: "done", raw: v };
      if (step.kind === "export" && v.framesReady) return { phase: "done", raw: v };
      if (v.failedStage === (step.kind === "snapshot" ? "capture" : "export")) {
        return { phase: "failed", detail: v.lastError || "", raw: v };
      }
      return { phase: "idle", raw: v };
    }

    function startRun(course) {
      runs[course.courseId] = { stepIndex: 0, started: false, status: "starting", log: [], courseId: course.courseId };
    }

    /* One tick of one course's chain. Deliberately not a loop with awaits inside: each tick
       asks the server where the course actually is and does at most ONE thing, so the page can
       be closed and reopened, and a job somebody else queued is picked up rather than doubled. */
    async function advance(course) {
      var run = runs[course.courseId];
      if (!run || run.status === "done" || run.status === "failed") return;
      var step = CHAIN[run.stepIndex];
      if (!step) { run.status = "done"; run.live = null; return; }

      var s = await stepState(step, course.courseId);
      run.live = { step: step, phase: s.phase, raw: s.raw || null };

      if (s.phase === "running") { run.status = "running"; return; }
      if (s.phase === "busy-other") { run.status = "waiting"; return; }
      if (s.phase === "failed" && run.started) {
        run.status = "failed";
        run.log.push(step.label + " failed" + (s.detail ? ": " + s.detail : ""));
        return;
      }
      if (s.phase === "done") {
        /* "already done" only when this page did not queue it — a step we started and then
           watched reach its finished state is finished, not pre-existing, and reading the log
           afterwards is how you tell what this run actually did. */
        run.log.push(step.label + (run.started ? " — finished" : " — already done"));
        run.stepIndex += 1;
        run.started = false;
        return;
      }
      if (run.started) {
        /* Queued by us and now idle with nothing to show for it: for a mapper kind that is a
           finished run, for a scorecard it always is. Move on either way — the next step's own
           precondition check is what catches a step that silently produced nothing. */
        run.log.push(step.label + " — finished");
        run.stepIndex += 1;
        run.started = false;
        return;
      }

      run.status = "running";
      var result = step.api === "scorecard" ? await queueScorecard(course.courseId)
        : step.api === "mapper" ? await queueMapper(course.courseId, step.kind)
          : await queueVisual(course.courseId, step.kind);
      if (!result.ok) {
        /* A 409 here means an earlier step did not produce what this one needs. Say so and
           stop this course — carrying on would queue work with nothing to work on. */
        run.status = "failed";
        run.log.push(step.label + " could not start: " + (result.detail || "unknown"));
        return;
      }
      run.started = true;
      run.log.push(step.label + (result.deduped ? " — already in progress" : " — queued"));
    }

    function anyRunLive() {
      return Object.keys(runs).some(function (id) {
        var r = runs[id];
        return r && r.status !== "done" && r.status !== "failed";
      });
    }

    function poll() {
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
      if (destroyed || !anyRunLive()) { renderBuild(); return; }
      Promise.all(selected().map(function (course) {
        return runs[course.courseId] ? advance(course).catch(function () {}) : Promise.resolve();
      })).then(function () {
        if (destroyed) return;
        renderBuild();
        pollTimer = setTimeout(poll, 6000);
      });
    }

    buildBtn.addEventListener("click", function () {
      var list = selected();
      if (!list.length) return;
      if (!window.confirm("Queue a full map build for " + list.length + " course" + (list.length === 1 ? "" : "s") +
        " on the live project?\n\n" + CHAIN.map(function (s) { return "• " + s.label; }).join("\n"))) return;
      list.forEach(startRun);
      renderBuild();
      poll();
    });

    buildStopBtn.addEventListener("click", function () {
      /* Stops this page watching. It cannot stop the server jobs, and says so rather than
         implying a cancel that does not exist. */
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
      Object.keys(runs).forEach(function (id) {
        if (runs[id].status !== "done" && runs[id].status !== "failed") runs[id].status = "detached";
      });
      renderBuild();
    });

    function renderBuild() {
      var list = selected();
      if (!list.length) {
        buildEl.innerHTML = '<p class="gdStudioMuted">Select at least one course above.</p>';
        return;
      }
      buildEl.innerHTML = "";
      list.forEach(function (course) {
        var run = runs[course.courseId];
        var card = el("div", "gdMktCard");
        card.appendChild(el("div", "gdMktCardHead", "<strong>" + esc(course.name) + "</strong>"));
        if (!run) {
          card.appendChild(el("p", "gdStudioMuted", "Not started. Skip this section entirely if the course is already built."));
          buildEl.appendChild(card);
          return;
        }
        var stepNo = Math.min(run.stepIndex + 1, CHAIN.length);
        var step = CHAIN[run.stepIndex] || CHAIN[CHAIN.length - 1];
        card.appendChild(el("div", "gdMktStepLine",
          run.status === "done" ? "All six steps complete."
            : run.status === "failed" ? "Stopped at step " + stepNo + " of " + CHAIN.length + "."
              : run.status === "detached" ? "Detached — the server job carries on without this page."
                : "Step " + stepNo + " of " + CHAIN.length + " &middot; " + esc(step.label) +
                  '<span class="gdStudioMuted"> — ' + esc(step.why) + "</span>"));

        /* The one bar, from the same module the Course Database uses. A step with no queue row
           of its own (scorecards) has nothing to draw, which is honest — an indeterminate
           sweep for a call that is either finished or not would be worse. */
        var progressCore = window.GDProgressCore;
        var live = run.live;
        if (progressCore && live && live.raw && live.phase === "running") {
          var model = live.step.api === "visual"
            ? progressCore.visualProgress(live.raw, { key: course.courseId + ":" + live.step.id })
            : progressCore.mapperProgress(live.raw, { key: course.courseId + ":" + live.step.id });
          var markup = progressCore.barMarkup(model);
          if (markup) card.appendChild(el("div", null, markup));
        }

        if (run.log.length) {
          card.appendChild(el("ul", "gdMktLog", run.log.map(function (line) {
            return "<li>" + esc(line) + "</li>";
          }).join("")));
        }
        buildEl.appendChild(card);
      });
    }

    // ------------------------------------------------------------ planning

    async function fetchPackage(course) {
      var token = await accessToken();
      var params = "courseId=" + encodeURIComponent(course.courseId);
      if (course.lat != null && course.lng != null) {
        params += "&courseLat=" + encodeURIComponent(course.lat) + "&courseLng=" + encodeURIComponent(course.lng);
      }
      if (course.name) params += "&courseName=" + encodeURIComponent(course.name);
      var headers = { Accept: "application/json" };
      if (token) headers.Authorization = "Bearer " + token;
      var res = await fetch("/api/course-package?" + params, { headers: headers, cache: "no-store" });
      if (!res.ok) throw new Error("course-package returned " + res.status);
      return res.json();
    }

    async function fetchIntel(course, holeCount) {
      var token = await accessToken();
      if (!token) return { intel: null, note: "Not signed in — signature-hole lookup skipped." };
      var url = "/api/marketing-hole-intel?name=" + encodeURIComponent(course.name) +
        "&holes=" + encodeURIComponent(holeCount);
      var res = await fetch(url, { headers: { Accept: "application/json", Authorization: "Bearer " + token }, cache: "no-store" });
      var data = await res.json().catch(function () { return null; });
      if (res.status === 503) return { intel: null, note: "No search provider configured — terrain only." };
      if (res.status === 403) return { intel: null, note: "Admin only — terrain only." };
      if (!res.ok) return { intel: null, note: "Signature-hole lookup failed (" + res.status + ") — terrain only." };
      return { intel: (data && data.intel) || [], note: "" };
    }

    async function planCourse(course) {
      var core = window.GDMarketingSnapshotCore;
      if (!core) return { courseId: course.courseId, error: "Snapshot core not loaded." };
      var pkg;
      try { pkg = await fetchPackage(course); }
      catch (e) { return { courseId: course.courseId, name: course.name, error: String(e.message || e) }; }

      var recs = core.holeRecords(pkg);
      if (!recs.length) {
        return { courseId: course.courseId, name: course.name, error: "The package has no hole with a green yet — build it first." };
      }

      var intelNote = "";
      var intel = null;
      if (document.getElementById("gdMktIntel").checked) {
        var got = await fetchIntel(course, recs.length);
        intel = got.intel;
        intelNote = got.note;
      }

      var picked = core.pickHoles(pkg, { intel: intel });
      var centre = core.packageCentre(pkg) || (course.lat != null ? { lat: course.lat, lng: course.lng } : null);
      var unitCall = core.unitsForPoint(centre);
      var approachRec = recs.find(function (r) { return r.holeNumber === picked.approachHole; }) || null;
      var stand = approachRec ? core.standingPoint(approachRec, core.constants.APPROACH_M) : null;

      return {
        courseId: course.courseId,
        name: course.name,
        lat: course.lat,
        lng: course.lng,
        holeCount: recs.length,
        teeHole: picked.teeHole,
        approachHole: picked.approachHole,
        approachFromM: core.constants.APPROACH_M,
        standingPoint: stand,
        units: unitCall.units,
        unitsReason: unitCall.reason,
        notes: picked.notes.concat(intelNote ? [intelNote] : []),
        scores: picked.scores,
        intel: intel || [],
        /* Kept so an override can re-derive the standing point without another network call.
           Double-underscored and never copied into planFile() — it is working state, not part
           of the contract with the runner. */
        __recs: recs
      };
    }

    var plans = [];

    planBtn.addEventListener("click", async function () {
      var list = selected();
      if (!list.length) return;
      persist();
      planBtn.disabled = true;
      planEl.innerHTML = '<p class="gdStudioMuted">Planning ' + list.length + " course" + (list.length === 1 ? "" : "s") + "…</p>";
      plans = [];
      for (var i = 0; i < list.length; i += 1) {
        /* Serial on purpose: each course can fire a web search, and the search key is shared
           with the scorecard resolver. Six parallel lookups is how a quota gets spent. */
        plans.push(await planCourse(list[i]));
        if (destroyed) return;
      }
      planBtn.disabled = false;
      renderPlan();
      renderOut();
    });

    function renderPlan() {
      if (!plans.length) {
        planEl.innerHTML = '<p class="gdStudioMuted">Nothing planned yet.</p>';
        return;
      }
      planEl.innerHTML = "";
      plans.forEach(function (plan, index) {
        var card = el("div", "gdMktCard");
        card.appendChild(el("div", "gdMktCardHead", "<strong>" + esc(plan.name || plan.courseId) + "</strong>"));
        if (plan.error) {
          card.appendChild(el("p", "gdMktErr", esc(plan.error)));
          planEl.appendChild(card);
          return;
        }

        var fields = el("div", "gdMktFields");
        [
          { key: "teeHole", label: "Tee-shot hole", min: 1, max: plan.holeCount },
          { key: "approachHole", label: "Approach hole", min: 1, max: plan.holeCount },
          { key: "approachFromM", label: "Approach from (m)", min: 30, max: 260 }
        ].forEach(function (field) {
          var wrap = el("label", "gdStudioViewportField", esc(field.label) + " ");
          var input = el("input");
          input.type = "number";
          input.min = String(field.min);
          input.max = String(field.max);
          input.value = String(plan[field.key] == null ? "" : plan[field.key]);
          input.addEventListener("change", function () {
            var v = num(input.value);
            plans[index][field.key] = v;
            /* The standing point is derived from BOTH the approach hole and the distance, so
               it has to be re-derived here rather than left at whatever the picker computed. */
            recomputeStanding(plans[index]);
            renderOut();
          });
          wrap.appendChild(input);
          fields.appendChild(wrap);
        });

        var unitWrap = el("label", "gdStudioViewportField", "Units ");
        var unitSel = el("select");
        [["m", "Metres"], ["yd", "Yards"]].forEach(function (pair) {
          var opt = el("option", null, pair[1]);
          opt.value = pair[0];
          if (plan.units === pair[0]) opt.selected = true;
          unitSel.appendChild(opt);
        });
        unitSel.addEventListener("change", function () {
          plans[index].units = unitSel.value;
          plans[index].unitsReason = "Set by hand in Studio.";
          renderOut();
        });
        unitWrap.appendChild(unitSel);
        fields.appendChild(unitWrap);
        card.appendChild(fields);

        card.appendChild(el("ul", "gdMktLog", plan.notes.map(function (n) {
          return "<li>" + esc(n) + "</li>";
        }).concat(['<li class="gdStudioMuted">' + esc(plan.unitsReason) + "</li>"]).join("")));

        var details = el("details", "gdMktScores");
        details.appendChild(el("summary", null, "Terrain scores for all " + plan.holeCount + " holes"));
        details.appendChild(el("table", "gdStudioJobTable",
          "<thead><tr><th>Hole</th><th>Par</th><th>Length</th><th>Tee-shot</th><th>Approach</th><th>In frame</th></tr></thead><tbody>" +
          plan.scores.map(function (s) {
            var bits = [];
            if (s.counts.corridorBunkers) bits.push(s.counts.corridorBunkers + " bunker" + (s.counts.corridorBunkers === 1 ? "" : "s"));
            if (s.counts.corridorWater) bits.push(s.counts.corridorWater + " water");
            if (s.counts.doglegPct >= 8) bits.push(s.counts.doglegPct + "% dogleg");
            if (s.counts.greenBunkers) bits.push(s.counts.greenBunkers + " greenside");
            return "<tr><td>" + s.holeNumber + "</td><td>" + (s.par == null ? "—" : s.par) + "</td><td>" +
              s.lengthM + "m</td><td>" + s.teeShot + "</td><td>" + s.approach + "</td><td>" +
              esc(bits.join(", ") || "—") + "</td></tr>";
          }).join("") + "</tbody></table>"));
        card.appendChild(details);
        planEl.appendChild(card);
      });
    }

    /* Re-derives the 130m standing point after an override. Needs the package again, so it is
       cached on the plan when it is first built — re-fetching on every keystroke would put a
       course-package call behind a number input. */
    function recomputeStanding(plan) {
      var core = window.GDMarketingSnapshotCore;
      if (!core || !plan || !plan.__recs) return;
      var rec = plan.__recs.find(function (r) { return r.holeNumber === plan.approachHole; });
      plan.standingPoint = rec ? core.standingPoint(rec, plan.approachFromM) : null;
    }

    // ------------------------------------------------------------ plan file

    function planFile() {
      return {
        version: 1,
        createdAt: new Date().toISOString(),
        /* The camera's own settings live in the runner's defaults, not here — this file says
           WHICH holes and WHICH units, which is the part a human decided. */
        courses: plans.filter(function (p) { return !p.error; }).map(function (p) {
          return {
            courseId: p.courseId,
            name: p.name,
            lat: p.lat,
            lng: p.lng,
            units: p.units,
            teeHole: p.teeHole,
            approachHole: p.approachHole,
            approachFromM: p.approachFromM,
            standingPoint: p.standingPoint,
            notes: p.notes
          };
        })
      };
    }

    function renderOut() {
      var file = planFile();
      var ready = file.courses.length;
      outEl.innerHTML = "";
      if (!ready) {
        outEl.innerHTML = '<p class="gdStudioMuted">Plan some courses first.</p>';
        return;
      }
      outEl.appendChild(el("p", "gdStudioMuted",
        ready + " course" + (ready === 1 ? "" : "s") + " &rarr; " + (ready * 3) + " screenshots " +
        "(pre-lock frame, Head To the Tee, and the 130m approach with the bubble nudged up and left)."));
      outEl.appendChild(el("pre", "gdMktJson", esc(JSON.stringify(file, null, 2))));
      outEl.appendChild(el("p", "gdStudioMuted",
        "Save it as <code>marketing/snapshot-plan.json</code>, then run:"));
      outEl.appendChild(el("pre", "gdMktCmd", "npm run marketing:snapshots"));
    }

    downloadBtn.addEventListener("click", function () {
      var blob = new Blob([JSON.stringify(planFile(), null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "snapshot-plan.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });

    copyBtn.addEventListener("click", function () {
      try { navigator.clipboard.writeText(JSON.stringify(planFile(), null, 2)); } catch (e) {}
    });

    document.getElementById("gdMktIntel").addEventListener("change", persist);

    function renderAll() {
      renderBasket();
      renderBuild();
      renderPlan();
      renderOut();
    }

    renderAll();

    return function cleanup() {
      destroyed = true;
      if (pollTimer) clearTimeout(pollTimer);
      stopWatch();
    };
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["marketing-snapshots"] = render;
})();
