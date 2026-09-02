/* Progress model for every long-running Course Database action - pure arithmetic and string
   parsing, no DOM, no fetch. Loaded two ways, same policy as scripts/gd-watch-map-core.js:
     - browser, via <script data-gd-surface="studio"> in index.html, as window.GDProgressCore
     - node, via require() from dev/ tests
   (and pinned in netlify.toml [functions].included_files if a function ever needs it).

   WHY THIS EXISTS. The Course Database ran three unrelated progress UIs: the visual build had a
   real percentage bar, the three mapper jobs (automap, Collect Extra Objects, Refine Shapes)
   had no bar at all and showed only the word "mapping", and the Watch map bake had an
   indeterminate sliding highlight that could not say how far through it was. Same screen, same
   question ("how far along is this?"), three different answers. This module is the one place
   that turns any of them into the same {pct, label, detail} shape so the screen can draw one
   bar for all of them.

   WHAT A PERCENTAGE IS ALLOWED TO MEAN HERE. Two honest kinds, and nothing else:

     1. Counted work. The server says "7 of 18 holes". That is a real fraction of real items
        and it is used directly.

     2. Phase reached. The server says "resolving-geometry". That is not a fraction, so it is
        mapped to a band (see PHASES) and reported as the START of that band - never
        interpolated inside it, because nothing measures position within a phase. A phase that
        carries its own count ("refining-hole-7-of-18") interpolates across its band using that
        count, which is back to case 1.

   What is NOT allowed is a percentage of elapsed time dressed as a percentage of work. The
   preview strip already draws a timer against its own budget and says so in its own comment;
   that is a timer, honestly labelled. A bar that claims "62%" because 62% of an average
   duration has passed is a lie that looks exactly like the truth, and this screen is used to
   decide whether a job is stuck. So a source with no count and no phase reports pct null, and
   the caller draws an indeterminate bar rather than inventing a number.

   MONOTONICITY. Real pipelines revisit phases: automap re-queries Overpass on a wider frame,
   and a retry legitimately re-enters an earlier stage. A bar that jumps backwards reads as
   "it broke", so applyFloor keeps a per-key high-water mark. The LABEL still shows the true
   current stage, so a retry is visible as text even while the bar holds - the bar answers "how
   much is left", the label answers "what is it doing". */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.ClarityApp = root.ClarityApp || {}; root.ClarityApp.progressCore = api; root.GDProgressCore = api; }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  /* Bands are [from, to] percentages, in the order a healthy run passes through them. They are
     nominal weights, not measurements - their only job is to make "further along" mean a bigger
     number. Keep them summing to 0..100 per kind and keep the LAST band ending at 100.

     Stage names are matched exactly, or by prefix for the counted/rounded ones, and come
     verbatim from functions/course-mapper-worker-background.mjs's heartbeatJob calls. A stage
     this table does not know is not an error: unknownStage keeps the previous percentage and
     shows the raw stage text, which is strictly better than guessing. */
  var PHASES = {
    automap: [
      { stage: "querying-overpass", from: 0, to: 18, label: "Querying OpenStreetMap" },
      { stage: "widening-for-multi-course-site", from: 18, to: 26, label: "Widening for a multi-course site" },
      { stage: "requerying-hole-gaps", from: 26, to: 34, label: "Re-querying hole gaps" },
      { stage: "resolving-geometry", from: 34, to: 50, label: "Resolving geometry" },
      { stage: "resolving-scorecard", from: 50, to: 60, label: "Resolving scorecard" },
      { stage: "geometry-resolver", from: 60, to: 70, label: "Building holes" },
      { stage: "retry-wider-frame", from: 70, to: 76, label: "Retrying on a wider frame" },
      { stage: "gathering-cards-for-facility", from: 76, to: 82, label: "Gathering facility cards" },
      { stage: "resolving-facility-loops", from: 82, to: 88, label: "Resolving facility loops" },
      { stage: "separating-contested-loops", from: 88, to: 92, label: "Separating contested loops" },
      { stage: "publishing-course", from: 92, to: 100, label: "Publishing" }
    ],
    collect_extra_objects: [
      { stage: "querying-overpass", from: 0, to: 50, label: "Querying OpenStreetMap" },
      { stage: "collecting-objects", from: 50, to: 100, label: "Collecting bunkers, fairways and hazards" }
    ],
    refine_surface_shapes: [
      { stage: "reading-published-frames", from: 0, to: 12, label: "Reading published frames" },
      { stage: "refining-hole", from: 12, to: 100, label: "Re-tracing shapes" }
    ],
    /* The Watch bake's own stages, written by functions/course-watch-maps.mjs. Unlike the
       mapper kinds these are ours to choose, so they are already shaped as one long counted
       phase with thin bands either side - which is what the work actually looks like. */
    watch_map: [
      { stage: "reading-course", from: 0, to: 3, label: "Reading course geometry" },
      { stage: "reading-terrain", from: 3, to: 6, label: "Reading terrain index" },
      { stage: "baking-hole", from: 6, to: 96, label: "Baking hole images" },
      { stage: "saving-package", from: 96, to: 100, label: "Saving package" }
    ]
  };

  /* "refining-hole-7-of-18" -> {done:7,total:18}. The trailing "-of-" form is the only counted
     shape the workers emit; a bare trailing number ("gathering-cards-for-facility-2") is a
     round counter with no known total and is deliberately NOT treated as a fraction. */
  function parseCountedStage(stage) {
    var match = /^(.*?)-(\d+)-of-(\d+)$/.exec(String(stage || ""));
    if (!match) return null;
    var done = Number(match[2]), total = Number(match[3]);
    if (!(total > 0) || !(done >= 0)) return null;
    return { base: match[1], done: Math.min(done, total), total: total };
  }

  /* Strips a trailing round counter so "resolving-facility-loops-2" matches its band. */
  function baseStage(stage) {
    var counted = parseCountedStage(stage);
    if (counted) return counted.base;
    return String(stage || "").replace(/-\d+$/, "");
  }

  function bandFor(kind, stage) {
    var bands = PHASES[kind];
    if (!bands) return null;
    var base = baseStage(stage);
    for (var i = 0; i < bands.length; i++) if (bands[i].stage === base) return bands[i];
    return null;
  }

  /* The percentage for one reported stage, or null when the stage is unknown to this kind.
     A counted stage spans its band; an uncounted one reports its band's START - see the header
     on why the middle of a band is never invented. */
  function stagePercent(kind, stage) {
    var band = bandFor(kind, stage);
    if (!band) return null;
    var counted = parseCountedStage(stage);
    if (!counted) return band.from;
    return band.from + (band.to - band.from) * (counted.done / counted.total);
  }

  function stageLabel(kind, stage) {
    var band = bandFor(kind, stage);
    if (band) return band.label;
    /* Unknown stage: show the raw name rather than a friendly lie. Hyphens to spaces so it
       reads as a phrase, first letter up, nothing else rewritten. */
    var raw = String(stage || "").replace(/-/g, " ").trim();
    return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "";
  }

  /* "7/18" when the stage counts, "" when it does not. */
  function stageDetail(stage) {
    var counted = parseCountedStage(stage);
    return counted ? counted.done + "/" + counted.total : "";
  }

  function clampPct(value) {
    if (!Number.isFinite(value)) return null;
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  /* High-water marks, keyed by whatever the caller uses to identify one run (course + kind).
     Cleared when a run ends so the next run starts from zero rather than inheriting the last
     one's ceiling - a fresh bake that opened at 96% would be worse than no bar. */
  var floors = {};
  function applyFloor(key, pct) {
    key = String(key || "");
    if (!key || pct == null) return pct;
    var previous = floors[key];
    var next = Number.isFinite(previous) ? Math.max(previous, pct) : pct;
    floors[key] = next;
    return next;
  }
  function clearFloor(key) { delete floors[String(key || "")]; }
  function resetFloors() { floors = {}; }

  /* ---------------------------------------------------------------- source normalisers

     Each returns the SAME shape, which is the entire point of this module:
       {live, pct, label, detail, stalled, tone}
     pct is null only when the source genuinely cannot say - the caller then draws an
     indeterminate bar. live:false means "nothing is running", and the caller draws no bar. */

  function model(fields) {
    return {
      live: !!fields.live,
      pct: fields.pct == null ? null : clampPct(fields.pct),
      label: String(fields.label || ""),
      detail: String(fields.detail || ""),
      stalled: !!fields.stalled,
      stalledSeconds: Number(fields.stalledSeconds) || 0,
      stage: String(fields.stage || "")
    };
  }

  /* The satellite/visual pipeline: /api/course-visual-jobs. This one has always had real
     counts, so it needs no phase table - capturesDone/capturesTotal IS the percentage. */
  function visualProgress(state, opts) {
    opts = opts || {};
    if (!state) return model({ live: false });
    var live = !!state.building || state.state === "queued";
    if (!live) return model({ live: false });
    var kind = state.activeKind === "export" ? "Baking frames" : state.activeKind === "snapshot" ? "Scanning" : "Building";
    var p = state.progress || null;
    var done = p ? Number(p.capturesDone != null ? p.capturesDone : p.holesDone) : NaN;
    var total = p ? Number(p.capturesTotal != null ? p.capturesTotal : p.holesTotal) : NaN;
    var hasCount = Number.isFinite(done) && Number.isFinite(total) && total > 0;
    var pct = hasCount ? (done / total) * 100 : (state.state === "queued" ? 0 : null);
    if (opts.key && pct != null) pct = applyFloor(opts.key, pct);
    return model({
      live: true,
      pct: pct,
      label: state.state === "queued" ? "Queued" : kind,
      detail: hasCount ? done + "/" + total : (state.state === "queued" ? "waiting for a worker" : "starting"),
      stalled: !!state.stalled,
      stalledSeconds: Number(state.stalledSeconds) || 0,
      stage: (p && p.stage) || ""
    });
  }

  /* The three mapper jobs: /api/course-mapper-jobs. These report a stage NAME, so the phase
     table does the work. jobKind picks the table - the same stage string means a different
     fraction of a different job. */
  function mapperProgress(state, opts) {
    opts = opts || {};
    if (!state) return model({ live: false });
    var live = state.state === "running" || state.state === "queued";
    if (!live) return model({ live: false });
    var jobKind = String(state.activeKind || state.kind || "automap");
    var stage = (state.progress && state.progress.stage) || "";
    var pct = state.state === "queued" ? 0 : stagePercent(jobKind, stage);
    if (opts.key && pct != null) pct = applyFloor(opts.key, pct);
    return model({
      live: true,
      pct: pct,
      label: state.state === "queued" ? "Queued" : (stageLabel(jobKind, stage) || jobLabel(jobKind)),
      detail: state.state === "queued" ? "waiting for a worker" : (stageDetail(stage) || ""),
      stalled: !!state.stalled,
      stalledSeconds: Number(state.stalledSeconds) || 0,
      stage: stage
    });
  }

  /* The Watch bake: the report row from /api/course-watch-maps, whose `progress` block the
     generator writes as it goes. `generating` is the only status that means work in flight;
     everything else is a finished package and draws no bar. */
  function watchProgress(report, opts) {
    opts = opts || {};
    var progress = report && report.progress || null;
    if (!progress || !progress.stage) return model({ live: false });
    var stage = String(progress.stage || "");
    var pct = stagePercent("watch_map", stage);
    if (opts.key && pct != null) pct = applyFloor(opts.key, pct);
    return model({
      live: true,
      pct: pct,
      label: stageLabel("watch_map", stage),
      detail: stageDetail(stage),
      stalled: !!progress.stalled,
      stage: stage
    });
  }

  function jobLabel(jobKind) {
    if (jobKind === "collect_extra_objects") return "Collecting extra objects";
    if (jobKind === "refine_surface_shapes") return "Refining shapes";
    if (jobKind === "automap") return "Mapping";
    return "Working";
  }

  /* One line of text for any model - "Baking hole images 7/18 · 41%". Kept here rather than in
     the renderer so the Course Database and the Watch viewer cannot word it differently. */
  function progressText(m) {
    if (!m || !m.live) return "";
    var parts = [m.label || "Working"];
    if (m.detail) parts.push(m.detail);
    var head = parts.join(" ");
    if (m.pct == null) return head;
    return head + " · " + m.pct + "%";
  }

  /* ---------------------------------------------------------------- the bar itself

     A string builder, not a DOM helper - same category as gd-watch-map-core.js's SVG
     builders, and the reason it can live in a "no DOM" module. It is HERE rather than in
     either Studio file because the Course Database and the Watch Map panel are separate
     scripts: a renderer in one of them would have been copied into the other, and the two
     copies would have drifted the way the three bars this replaced already had. */
  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function stalledSuffix(m) {
    if (!m.stalled) return "";
    var minutes = Math.round(Number(m.stalledSeconds || 0) / 60);
    return minutes > 0 ? " · stalled " + minutes + "m" : " · stalled";
  }

  /* Markup for one model. Empty string when nothing is running, so a caller can concatenate
     it unconditionally and get nothing when there is nothing to say. */
  function barMarkup(m, opts) {
    opts = opts || {};
    if (!m || !m.live) return "";
    var indeterminate = m.pct == null;
    var classes = ["gdAdminProgressBar"];
    if (indeterminate) classes.push("gdAdminProgressBarIndeterminate");
    if (m.stalled) classes.push("gdAdminProgressBarStalled");
    var left = [m.label || "Working", m.detail].filter(Boolean).join(" ") + stalledSuffix(m);
    var right = indeterminate ? "working…" : m.pct + "%";
    /* aria-valuenow only when there IS a value - an indeterminate progressbar that reports a
       number reads that number out to a screen reader as though it meant something. */
    var aria = indeterminate
      ? ' role="progressbar" aria-valuetext="in progress"'
      : ' role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + m.pct + '"';
    var title = opts.title || m.stage || "";
    return '<div class="' + classes.join(" ") + '"' + aria
      + (title ? ' title="' + escapeHtml(title) + '"' : "")
      + ' aria-label="' + escapeHtml(left) + '">'
      + '<span class="gdAdminProgressBarFill"' + (indeterminate ? "" : ' style="width:' + m.pct + '%"') + '></span>'
      + '<span class="gdAdminProgressBarLabel">' + escapeHtml(left) + '</span>'
      + '<span class="gdAdminProgressBarPct">' + escapeHtml(right) + '</span>'
      + '</div>';
  }

  return {
    PHASES: PHASES,
    escapeHtml: escapeHtml,
    barMarkup: barMarkup,
    parseCountedStage: parseCountedStage,
    baseStage: baseStage,
    stagePercent: stagePercent,
    stageLabel: stageLabel,
    stageDetail: stageDetail,
    jobLabel: jobLabel,
    applyFloor: applyFloor,
    clearFloor: clearFloor,
    resetFloors: resetFloors,
    visualProgress: visualProgress,
    mapperProgress: mapperProgress,
    watchProgress: watchProgress,
    progressText: progressText
  };
});
