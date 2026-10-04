/* Clarity Studio — Mapping Overlay. Studio-only.
 *
 * What it is for: placing the fairways, greens and tees that OSM does not have, so the mapper
 * can resolve a course whose OSM data is greens and nothing else. Royal Belfast is the case:
 * eleven greens in OSM, no fairways, no hole lines, and the resolver has nothing to build a
 * centre-line from.
 *
 * How it is used: by eye, not by tracing, in one of two modes. Shapes: a fairway is a line laid
 * down its middle, which becomes a fairway-width polygon with corners to drag into shape. A
 * green is a click the green wand (/api/course-map-wand) turns into an outline; a bunker is a
 * click the same wand outlines on its bunker profile, and bunker outlines that overlap merge
 * into one bunker. A water hazard is either drawn round by hand (press and drag) or clicked for
 * the wand. A tee is a click. Whatever was just placed stays live until it is kept: left and
 * right step the wand's sensitivity, up and down make it smaller or bigger (a fairway narrower
 * or wider), Enter or Space keeps it. Pins: the quick pass - a green, tee, bunker or water
 * hazard is its centre and a fairway is its start and end, nothing more; any pin can be turned
 * into a shape later ("Shape pins"). The tool picked stays picked until another is chosen.
 * Every shape can be dragged, reshaped by its corners, and deleted by
 * dropping it on the bin. Every change saves on its own. Hole numbers are optional: set "Hole"
 * and new shapes carry it, or select a shape and change its number. Unnumbered shapes are
 * numbered by the mapper from the scorecard.
 *
 * Drafts: a session is a draft until "Mark ready" is pressed, and the mapper ignores a draft
 * overlay. Any shape change puts it back to draft, so what the mapper reads is always
 * something a person signed off (supabase/migrations/20260929_add_course_map_overlay_status.sql).
 *
 * What it shows to draw against, none of it copied into the overlay: what OSM has here (the
 * mapper's own query, so exactly what the last run collected), the course's saved objects,
 * and the last mapper run - opened from a failed course, the drawer says why it failed.
 *
 * What it writes: one thing, the course's overlay row (course_map_overlays) through
 * /api/course-map-overlay. The mapper worker merges a ready overlay into the Overpass payload
 * as ordinary golf=fairway / golf=green / golf=tee / golf=bunker ways
 * (functions/lib/gd-map-overlay-core.mjs), so nothing downstream knows the difference. It does
 * NOT write objects, holes, a pin or a package - the overlay changes nothing on the course
 * until a mapper run is requested, which the button at the bottom does through the same
 * /api/course-mapper-jobs path Course Database uses.
 *
 * Borrowed, not owned: the course list (the real picker, through gd-studio-course-pick.js),
 * the provider list (window.GDMapSources from gd-app-core.js), the shape builders
 * (window.GDOverlayShapes, map-overlay-shapes.js), and what OSM has here (asked of the server,
 * which runs the mapper's own query, so the greens drawn under your cursor are the greens the
 * resolver will link your fairway to). */
(function () {
  "use strict";

  var API = "/api/course-map-overlay";
  var AI_API = "/api/course-map-ai-scan";
  var WAND_API = "/api/course-map-wand";
  var JOBS_API = "/api/course-mapper-jobs";
  /* DEV/TEST: fetch this view from a forced map source (Mapbox) server-side - see
     functions/course-map-source-test.mjs. Mapbox may be looked at, never stored, so a scan of
     its picture is always a dry run. */
  var SOURCE_TEST_API = "/api/course-map-source-test";
  /* The model reads an image at ~1568px on its long side and answers in the pixels it saw,
     so the capture is scaled to that here and georeferenced AFTER scaling - the picture we
     describe is the picture it gets, to the pixel. */
  var AI_MAX_EDGE_PX = 1568;
  /* The API also rescales anything over ~1.15 megapixels, silently, and the model then answers
     in pixels of a picture we never saw. The first live scan was 1536x768 = 1.18MP. Stay under. */
  var AI_MAX_PIXELS = 1100000;
  var AI_MAX_TILES = 110;
  /* A labelled coordinate grid burned into the picture the model reads. A vision model asked
     for pixel coordinates estimates them; given gridlines with numbers on the margins it reads
     them, and the shapes land where the ground is. 128px is coarse enough to leave a 20-40px
     green legible under it. */
  var AI_GRID_PX = 128;
  var AI_POLL_MS = 4000;
  var AI_TIMEOUT_MS = 8 * 60 * 1000;
  /* The wand reads a green best at roughly 0.3m a pixel - a typical green ~45px across its
     radius, the scale its bubble sizes were tuned at - and a bunker at half that, since it is
     under half the size. The picture is sized to hold the largest surface of that kind the
     server will accept (gd-surface-refine-core WAND_PROFILES[kind].areaM2.max) with room. */
  var WAND_TARGET_MPP = { green: 0.3, bunker: 0.15, water: 0.5 };
  var WAND_MAX_M2 = { green: 2500, bunker: 1200, water: 12000 };
  var WAND_KINDS = ["green", "bunker", "water"];
  /* The wand size steps, as a multiple of its profile (gd-surface-refine-core WAND_SCALE bounds
     them server-side). Each wand kind keeps its own. */
  var WAND_SIZES = [0.5, 0.65, 0.8, 1, 1.25, 1.6, 2];
  /* Up and down on the shape just placed: a fairway this many metres narrower or wider, a tee
     or a hand-drawn water hazard this much smaller or bigger, a press. */
  var FAIRWAY_WIDTH_STEP_M = 5;
  var SCALE_STEP = 1.12;
  /* The deepest zoom the map goes to. Past the provider's own imagery the last real tiles are
     blown up rather than requested (see watchImageryCeiling). */
  var DRAW_MAX_ZOOM = 22;
  /* A provider is not chased below this zoom when its tiles fail - a provider with nothing here
     at all is the provider list's problem, not a zoom ceiling. */
  var IMAGERY_CEILING_FLOOR_Z = 16;
  /* Autosave waits for a pause, so a burst of drags is one save. */
  var SAVE_DELAY_MS = 700;
  var SAVE_RETRY_MS = 6000;
  var MAX_POINTS = 64;
  var MAX_FEATURES = 200;

  /* Survives leaving and re-entering the page - the shell tears the DOM down on every route
     change. The save state lives here too, so a save still in flight when the page is left
     lands on the same state the next render reads. */
  var session = {
    course: null, features: [], loadedFor: "", osm: null, objects: [], lastRun: null, courseMap: null, view: null, sourceKey: "",
    showOsm: true, showObjects: true, status: "draft", hole: null,
    dirty: false, rev: 0, saving: false, saveError: "", fairwayWidth: 0,
    mode: "shapes", wandSize: { green: 1, bunker: 1, water: 1 }, waterDraw: false, mergeBunkers: true, fullscreen: false, unsaved: null
  };

  /* ---- persistence ----
     The session also outlives a reload: the course, where the map was, the imagery, the
     toggles and full screen come back as they were left. Shapes live on the server; the only
     shapes kept here are ones that had not saved yet when the page went, and they are put back
     (and saved) the next time that course loads. */
  var STORE_KEY = "gd_studio_map_overlay_v1";
  var rememberTimer = null;

  function slimCourse(course) {
    if (!course) return null;
    var out = {};
    ["courseId", "id", "canonicalKey", "name", "courseName", "lat", "lng", "latitude", "longitude"].forEach(function (k) {
      if (course[k] != null) out[k] = course[k];
    });
    return out;
  }

  function rememberNow() {
    if (rememberTimer) { clearTimeout(rememberTimer); rememberTimer = null; }
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        course: slimCourse(session.course), view: session.view, sourceKey: session.sourceKey,
        showOsm: session.showOsm, showObjects: session.showObjects, mode: session.mode, fairwayWidth: session.fairwayWidth,
        wandSize: session.wandSize, waterDraw: session.waterDraw, mergeBunkers: session.mergeBunkers, fullscreen: !!session.fullscreen,
        unsaved: session.dirty && session.loadedFor ? { courseId: session.loadedFor, features: session.features } : null
      }));
    } catch (e) {}
  }

  function remember() {
    if (rememberTimer) clearTimeout(rememberTimer);
    rememberTimer = setTimeout(rememberNow, 300);
  }

  (function hydrate() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch (e) {}
    if (!saved || typeof saved !== "object") return;
    if (saved.course) { session.course = saved.course; session.view = saved.view || null; }
    ["sourceKey", "showOsm", "showObjects", "mode", "fairwayWidth", "waterDraw", "mergeBunkers", "fullscreen"].forEach(function (k) {
      if (saved[k] != null) session[k] = saved[k];
    });
    if (saved.wandSize && typeof saved.wandSize === "object") {
      WAND_KINDS.forEach(function (kind) { if (WAND_SIZES.indexOf(saved.wandSize[kind]) >= 0) session.wandSize[kind] = saved.wandSize[kind]; });
    }
    if (saved.unsaved && Array.isArray(saved.unsaved.features)) session.unsaved = saved.unsaved;
  })();

  /* Everything that belongs to one course, dropped when another is picked or opened. */
  function forgetCourse() {
    session.features = [];
    session.osm = null;
    session.objects = [];
    session.lastRun = null;
    session.courseMap = null;
    session.loadedFor = "";
    session.dirty = false;
    session.status = "draft";
    session.hole = null;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(v) { var n = Number(v); return Number.isFinite(n) ? n : null; }
  function sourcesApi() { return window.GDMapSources || null; }
  function shapesApi() { return window.GDOverlayShapes || null; }
  function liveSources() { var api = sourcesApi(); return api && Array.isArray(api.list) ? api.list : []; }
  function courseIdOf(course) {
    return String(course && (course.courseId || course.id || course.canonicalKey) || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90);
  }
  function courseLatLng(course) {
    var lat = num(course && (course.lat != null ? course.lat : course.latitude));
    var lng = num(course && (course.lng != null ? course.lng : course.longitude));
    return lat != null && lng != null ? [lat, lng] : null;
  }
  function accessToken() {
    if (typeof window.gdAdminCourseDbAccessToken === "function") return window.gdAdminCourseDbAccessToken();
    try {
      var auth = window.ClaritySupabaseAuth;
      var s = auth && typeof auth.session === "function" ? auth.session() : null;
      return Promise.resolve(String(s && (s.access_token || s.accessToken) || ""));
    } catch (e) { return Promise.resolve(""); }
  }
  function nextFeatureId(features) {
    var n = 0;
    features.forEach(function (f) { var m = /^f-(\d+)$/.exec(f.id || ""); if (m) n = Math.max(n, Number(m[1])); });
    return "f-" + (n + 1);
  }
  function kindLabel(kind) { return kind === "hole" ? "Hole line" : kind === "green" ? "Green" : kind === "tee" ? "Tee" : kind === "bunker" ? "Bunker" : kind === "water" ? "Water hazard" : "Fairway"; }
  function isPolygon(kind) { return kind === "fairway" || kind === "green" || kind === "tee" || kind === "bunker" || kind === "water"; }
  function pct(size) { return Math.round(size * 100) + "%"; }
  function holeNumber(value) { var n = num(value); return n != null && Number.isInteger(n) && n >= 1 && n <= 36 ? n : null; }
  function minPoints(f) { return f.pin ? f.points.length : isPolygon(f.kind) ? 3 : 2; }
  function toLatLngs(points) { return points.map(function (p) { return [p.lat, p.lng]; }); }
  /* A course map is a small schematic; 1200px on the long side is plenty for the model to
     read hole numbers off, and keeps the row it is stored on light. */
  var COURSE_MAP_MAX_EDGE_PX = 1200;

  var STYLE = {
    fairway: { color: "#3cff8d", weight: 2, fillColor: "#3cff8d", fillOpacity: 0.22 },
    fairwaySelected: { color: "#ffffff", weight: 3, fillColor: "#3cff8d", fillOpacity: 0.35 },
    hole: { color: "#3cff8d", weight: 3, dashArray: "8 6" },
    holeSelected: { color: "#ffffff", weight: 4, dashArray: "8 6" },
    green: { color: "#b7ff5c", weight: 2, fillColor: "#b7ff5c", fillOpacity: 0.4 },
    greenSelected: { color: "#ffffff", weight: 3, fillColor: "#b7ff5c", fillOpacity: 0.5 },
    tee: { color: "#6cc7ff", weight: 2, fillColor: "#6cc7ff", fillOpacity: 0.4 },
    teeSelected: { color: "#ffffff", weight: 3, fillColor: "#6cc7ff", fillOpacity: 0.5 },
    bunker: { color: "#f2dfa0", weight: 2, fillColor: "#f2dfa0", fillOpacity: 0.45 },
    bunkerSelected: { color: "#ffffff", weight: 3, fillColor: "#f2dfa0", fillOpacity: 0.55 },
    water: { color: "#4fb3ff", weight: 2, fillColor: "#2f8fff", fillOpacity: 0.4 },
    waterSelected: { color: "#ffffff", weight: 3, fillColor: "#2f8fff", fillOpacity: 0.5 },
    /* The line a water hazard is drawn round with. */
    lasso: { color: "#4fb3ff", weight: 3, dashArray: "6 6", interactive: false },
    draft: { color: "#ffb54c", weight: 3, dashArray: "6 6", interactive: false },
    /* Shapes on the same hole, and the line a Link drag draws. */
    link: { color: "#ffffff", weight: 2, opacity: 0.7, dashArray: "1 7", lineCap: "round", interactive: false },
    linkDraft: { color: "#ffffff", weight: 3, dashArray: "6 6", interactive: false },
    draftPreview: { color: "#ffb54c", weight: 1, fillColor: "#3cff8d", fillOpacity: 0.12, interactive: false },
    draftPoint: { radius: 4, color: "#ffb54c", weight: 2, fillColor: "#1a1a1a", fillOpacity: 1, interactive: false },
    vertex: { radius: 6, color: "#ffffff", weight: 2, fillColor: "#ffb54c", fillOpacity: 1, className: "gdStudioOverlayHandle" },
    midpoint: { radius: 4, color: "#ffffff", weight: 1, opacity: 0.8, fillColor: "#ffffff", fillOpacity: 0.35, className: "gdStudioOverlayHandle" },
    /* The marker on a wand click while the wand works. */
    wandGreen: { radius: 7, color: "#ffffff", weight: 2, fillColor: "#b7ff5c", fillOpacity: 1, interactive: false },
    wandBunker: { radius: 6, color: "#ffffff", weight: 2, fillColor: "#f2dfa0", fillOpacity: 1, interactive: false },
    wandWater: { radius: 7, color: "#ffffff", weight: 2, fillColor: "#2f8fff", fillOpacity: 1, interactive: false },
    /* Pins: a dot on a centre, or a dashed line between a fairway's start and end. */
    pinGreen: { radius: 7, color: "#06120b", weight: 2, fillColor: "#b7ff5c", fillOpacity: 1 },
    pinTee: { radius: 6, color: "#06120b", weight: 2, fillColor: "#6cc7ff", fillOpacity: 1 },
    pinBunker: { radius: 5, color: "#06120b", weight: 2, fillColor: "#f2dfa0", fillOpacity: 1 },
    pinWater: { radius: 7, color: "#06120b", weight: 2, fillColor: "#2f8fff", fillOpacity: 1 },
    pinFairway: { color: "#3cff8d", weight: 4, dashArray: "2 8", lineCap: "round" },
    pinFairwayEnd: { radius: 5, color: "#06120b", weight: 2, fillColor: "#3cff8d", fillOpacity: 1, interactive: false },
    osmGreen: { color: "#b7ff5c", weight: 2, fillColor: "#b7ff5c", fillOpacity: 0.28 },
    osmFairway: { color: "#8fa79c", weight: 1, dashArray: "3 5", fillOpacity: 0 },
    osmTee: { color: "#6cc7ff", weight: 2, fillColor: "#6cc7ff", fillOpacity: 0.3 },
    osmHole: { color: "#ffffff", weight: 1, dashArray: "2 6", opacity: 0.7 },
    osmBunker: { color: "#f2dfa0", weight: 1, fillColor: "#f2dfa0", fillOpacity: 0.25 },
    osmWater: { color: "#4fb3ff", weight: 1, fillColor: "#2f8fff", fillOpacity: 0.22 },
    /* The course's saved objects: thin amber outlines, so they read as "already there" and
       never as something drawn this session. */
    object: { color: "#ffd98a", weight: 1, dashArray: "4 4", fillColor: "#ffd98a", fillOpacity: 0.08 },
    objectPoint: { radius: 4, color: "#ffd98a", weight: 1, fillColor: "#ffd98a", fillOpacity: 0.6 }
  };

  var BIN_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';

  function svgIcon(body) {
    return '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + body + "</svg>";
  }
  var ICON = {
    move: svgIcon('<path d="M5 3l13 7-5.5 1.8L10.7 17z"/><path d="M13 12l5 5"/>'),
    connect: svgIcon('<circle cx="6" cy="18" r="2.6"/><circle cx="18" cy="6" r="2.6"/><path d="M8 16l8-8" stroke-dasharray="2 3"/>'),
    fairway: svgIcon('<path d="M7 21c-1-5 2-7 4-10s2-6 1-8"/><path d="M13 21c-1-5 2-7 4-10s2-6 1-8"/>'),
    green: svgIcon('<path d="M9 18V3l8 3.5L9 10"/><ellipse cx="10" cy="19" rx="7" ry="2.4"/>'),
    tee: svgIcon('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>'),
    bunker: svgIcon('<path d="M3.5 15c0-4 4.2-7 8.5-7s8.5 2.2 8.5 5.3-3.5 4.7-8.5 4.7S3.5 17.4 3.5 15z"/><path d="M9 13h.01M13 12h.01M15 15h.01"/>'),
    water: svgIcon('<path d="M12 3c-2.2 3-3.5 4.8-3.5 6.5a3.5 3.5 0 0 0 7 0C15.5 7.8 14.2 6 12 3z"/><path d="M3 17c2 0 2-1.5 4.5-1.5S9.5 17 12 17s2.5-1.5 4.5-1.5S19 17 21 17"/><path d="M3 21c2 0 2-1.5 4.5-1.5S9.5 21 12 21s2.5-1.5 4.5-1.5S19 21 21 21"/>'),
    expand: svgIcon('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
    shrink: svgIcon('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
    course: svgIcon('<path d="M3 11l9-7 9 7"/><path d="M5.5 9.5V20h13V9.5"/>'),
    search: svgIcon('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>'),
    plus: svgIcon('<path d="M12 5v14M5 12h14"/>'),
    minus: svgIcon('<path d="M5 12h14"/>'),
    chevron: svgIcon('<path d="M6 9l6 6 6-6"/>')
  };
  function railButton(name, icon, label, title) {
    return '<button type="button" class="gdStudioOverlayRailBtn" data-gd-overlay="' + name + '" title="' + esc(title) + '" aria-label="' + esc(label) + '">' + ICON[icon] + "<span>" + esc(label) + "</span></button>";
  }
  function viewButton(name, icon, title) {
    return '<button type="button" class="gdStudioOverlayViewBtn" data-gd-overlay="' + name + '" title="' + esc(title) + '" aria-label="' + esc(title) + '">' + ICON[icon] + "</button>";
  }

  function render(containerEl) {
    var mapObj = null;
    var layer = null;
    var destroyed = false;
    var tool = "move";
    var draft = [];
    var draftLayers = [];
    var cursorLatLng = null;
    var featureLayers = {};
    var osmLayers = [];
    var objectLayers = [];
    var selectedId = "";
    var busy = false;
    var scanning = false;
    var scanFrame = null;
    var scanTimer = null;
    var saveTimer = null;
    var drag = null;
    var dragEndedAt = 0;
    var wandsRunning = 0;
    /* The shape placed last can be dragged straight away, whatever tool is in hand, so a pin
       that landed a little off is nudged into place without switching to Move. */
    var lastPlacedId = "";
    /* Link tool: the shape tapped first, waiting for the one to link it to. */
    var connectFrom = "";
    var connect = null;
    var linkLayers = [];
    var sourceTesting = false;
    var sourceTest = null;

    /* One screen, laid out like the booking app's video workspace: the map takes everything,
       the tools float over it (placing tools down the left, view controls down the right, the
       options for the tool in hand along the top), and everything used now and then - the
       course, imagery, AI, publishing - lives in the pull-down under the header. The page itself
       never scrolls; only the map pans. */
    containerEl.classList.add("gdStudioOverlayHost");
    containerEl.innerHTML =
      '<div class="gdStudioOverlayApp" data-gd-overlay="workspace">' +
      '<div class="gdStudioOverlayTop">' +
      '<header class="gdStudioOverlayHead">' +
      '<button type="button" class="gdStudioOverlayMenuToggle" data-gd-overlay="menu-toggle" aria-expanded="false" title="Course, imagery, AI and publishing">' +
      '<span class="gdStudioOverlayHeadCourse" data-gd-overlay="course">No course picked</span>' + ICON.chevron + "</button>" +
      '<span class="gdStudioOverlayDraft" data-gd-overlay="draft"></span>' +
      '<span class="gdStudioOverlayStatus" data-gd-overlay="status"></span>' +
      '<button type="button" class="gdStudioOverlaySave" data-gd-overlay="save" disabled>Save</button>' +
      "</header>" +
      '<div class="gdStudioOverlayMenu" data-gd-overlay="menu" hidden>' +
      '<div class="gdStudioOverlayRun" data-gd-overlay="last-run"></div>' +
      '<div class="gdStudioViewportBar">' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="pick">Pick course</button>' +
      '<label class="gdStudioViewportField">Imagery <select data-gd-overlay="provider"></select></label>' +
      '<label class="gdStudioViewportField"><input type="checkbox" data-gd-overlay="osm" checked> Show OSM</label>' +
      '<label class="gdStudioViewportField"><input type="checkbox" data-gd-overlay="objects" checked> Show course objects</label>' +
      "</div>" +
      '<div class="gdStudioViewportBar">' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="ai" disabled title="Pins in view: the AI shapes them and fills in the rest. Only shapes in view: it refits them to the ground. Nothing in view: it traces from scratch.">Scan this view with AI</button>' +
      '<label class="gdStudioViewportField gdStudioDiagramBtn">Course map… <input type="file" accept="image/*" data-gd-overlay="course-map" hidden></label>' +
      '<span class="gdStudioViewportField" data-gd-overlay="course-map-state"></span>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="source-test" disabled title="Dev test: fetch this view from Mapbox Satellite and Mapbox Terrain server-side, to judge the imagery. Nothing is stored.">Test Mapbox source</button>' +
      "</div>" +
      '<div class="gdStudioSourceTest" data-gd-overlay="source-panel" hidden></div>' +
      '<div class="gdStudioViewportBar">' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="ready" disabled>Mark ready</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="run" disabled>Run mapper with overlay</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="clear" disabled>Delete all shapes</button>' +
      "</div>" +
      '<div class="gdStudioViewportReadout" data-gd-overlay="readout"></div>' +
      '<div class="gdStudioViewportCredit" data-gd-overlay="credit"></div>' +
      '<details class="gdStudioLede gdStudioOverlayHelp"><summary>How it works</summary>' +
      "<p><strong>Shapes</strong>: <strong>Fairway</strong> - click along its middle and press Finish; <strong>Green</strong> / <strong>Bunker</strong> - click the middle and the wand outlines it " +
      "(then shaped by a few smooth points); <strong>Water</strong> - <em>Draw round</em>: press and drag all the way round it, or <em>Wand</em>: click the middle; <strong>Tee</strong> - click to drop a round tee. " +
      "Whatever you just placed stays live: <strong>← →</strong> step the wand's sensitivity, <strong>↑ ↓</strong> make it smaller or bigger (a fairway narrower or wider), <strong>Enter</strong> or <strong>Space</strong> keeps it, <strong>Esc</strong> removes it - placing the next one keeps it too. " +
      "<strong>Pins</strong>, the quick pass: a fairway is its start then its end and becomes a fairway straight away; a green pin is outlined by the wand straight away; tees, bunkers and water stay pins until <strong>Shape pins</strong>. " +
      "Whatever you just placed can be dragged at once to adjust it. In <strong>Move</strong>, drag shapes and their points, and drop either on the <strong>bin</strong> to delete. " +
      "<strong>Link</strong>: drag from one shape to another (or tap one, then the other) to put them on the same hole; drag a shape onto empty ground to unlink it. " +
      "Everything saves as you go, as a <strong>draft</strong> the mapper ignores - <strong>Mark ready</strong> when the course looks right, then run the mapper. " +
      "Bright outlines are what OSM already has; dashed amber ones are the course's saved objects.</p></details>" +
      "</div>" +
      "</div>" +
      '<div class="gdStudioOverlayStage isTool-move" data-gd-overlay="stage">' +
      '<div class="gdStudioViewportMap gdStudioOverlayMap" data-gd-overlay="map"></div>' +
      '<div class="gdStudioOverlayRail" role="toolbar" aria-label="Tools">' +
      railButton("tool-move", "move", "Move", "Select, move and reshape (V)") +
      railButton("tool-connect", "connect", "Link", "Link shapes to the same hole (C)") +
      '<span class="gdStudioOverlayRailRule"></span>' +
      railButton("tool-fairway", "fairway", "Fairway", "") +
      railButton("tool-green", "green", "Green", "") +
      railButton("tool-tee", "tee", "Tee", "") +
      railButton("tool-bunker", "bunker", "Bunker", "") +
      railButton("tool-water", "water", "Water", "") +
      "</div>" +
      '<div class="gdStudioOverlayOptions">' +
      '<span class="gdStudioOverlayModes">' +
      '<button type="button" data-gd-overlay="mode-shapes" title="Place outlines - fairway lines and the wand (S)">Shapes</button>' +
      '<button type="button" data-gd-overlay="mode-pins" title="Quick pass - fairway start and end, green and tee centres (P)">Pins</button>' +
      "</span>" +
      '<label class="gdStudioOverlayOpt" data-gd-overlay="hole-label">Hole <input type="number" min="1" max="36" step="1" placeholder="–" data-gd-overlay="hole" class="gdStudioOverlayWidth gdStudioOverlayHole"></label>' +
      '<label class="gdStudioOverlayOpt" data-gd-overlay="width-label">Width <input type="number" min="10" max="90" step="1" data-gd-overlay="width" class="gdStudioOverlayWidth"> m</label>' +
      '<span class="gdStudioOverlayModes" data-gd-overlay="water-method" hidden>' +
      '<button type="button" data-gd-overlay="water-wand" title="Click the water and the wand outlines it (W switches)">Wand</button>' +
      '<button type="button" data-gd-overlay="water-draw" title="Press and drag all the way round the water (W switches)">Draw round</button>' +
      "</span>" +
      '<span class="gdStudioOverlayOpt" data-gd-overlay="wand-size-label"><span data-gd-overlay="wand-size-name">Wand</span> ' +
      '<button type="button" class="gdStudioOverlayStep" data-gd-overlay="wand-smaller" title="The wand reaches for a smaller edge (↓ on the shape just placed, [ for the next one)">−</button>' +
      '<span class="gdStudioOverlayStepValue" data-gd-overlay="wand-size"></span>' +
      '<button type="button" class="gdStudioOverlayStep" data-gd-overlay="wand-bigger" title="The wand reaches for a bigger edge (↑ on the shape just placed, ] for the next one)">+</button></span>' +
      '<label class="gdStudioOverlayOpt" data-gd-overlay="merge-label" title="A bunker outline that overlaps one already placed joins it as one bunker"><input type="checkbox" data-gd-overlay="merge"> Merge bunkers</label>' +
      '<button type="button" class="gdStudioOverlayOptBtn" data-gd-overlay="shape-pins" hidden></button>' +
      "</div>" +
      '<div class="gdStudioOverlayViewRail" role="toolbar" aria-label="View">' +
      viewButton("fullscreen", "expand", "Full screen") +
      viewButton("fit", "course", "Fit the whole course (H)") +
      viewButton("zoom-shape", "search", "Zoom to the selected shape (Z)") +
      viewButton("zoom-in", "plus", "Zoom in (+)") +
      viewButton("zoom-out", "minus", "Zoom out (-)") +
      "</div>" +
      '<div class="gdStudioOverlayDock">' +
      '<div class="gdStudioOverlayDraftBar" data-gd-overlay="draft-bar" hidden>' +
      '<button type="button" data-gd-overlay="draft-finish" title="Finish the fairway (Enter, or double-click)">Finish</button>' +
      '<button type="button" data-gd-overlay="draft-undo" title="Take back the last point (Backspace)">Undo point</button>' +
      '<button type="button" data-gd-overlay="draft-cancel" title="Drop this fairway (Esc)">Cancel</button>' +
      "</div>" +
      '<div class="gdStudioOverlayHint" data-gd-overlay="hint"></div>' +
      "</div>" +
      '<button type="button" class="gdStudioOverlayBin" data-gd-overlay="bin" title="Drag a shape or point here to delete it, or click to delete the selected shape">' +
      BIN_ICON + "<span>Bin</span></button>" +
      "</div>" +
      "</div>";

    var el = {};
    ["pick", "course", "provider", "osm", "objects", "ai", "source-test", "source-panel", "course-map", "course-map-state", "last-run", "menu", "menu-toggle", "save", "mode-shapes", "mode-pins", "tool-move", "tool-connect", "tool-fairway", "tool-green", "tool-tee", "tool-bunker", "tool-water", "water-method", "water-wand", "water-draw", "width", "width-label", "wand-size-label", "wand-size-name", "wand-smaller", "wand-size", "wand-bigger", "merge", "merge-label", "hole", "hole-label", "shape-pins", "workspace", "draft-bar", "draft-finish", "draft-undo", "draft-cancel", "fit", "zoom-shape", "zoom-in", "zoom-out", "fullscreen", "stage", "map", "hint", "bin", "readout", "credit", "draft", "ready", "clear", "run", "status"].forEach(function (name) {
      el[name] = containerEl.querySelector('[data-gd-overlay="' + name + '"]');
    });

    if (typeof window.L === "undefined" || !sourcesApi() || !shapesApi()) {
      el.map.innerHTML = '<p class="gdStudioMuted" style="padding:16px">Leaflet, the map source list or the overlay shape builders did not load on this surface.</p>';
      return null;
    }
    var shapes = shapesApi();
    if (!session.fairwayWidth) session.fairwayWidth = shapes.FAIRWAY_WIDTH_M;
    el.width.value = session.fairwayWidth;

    /* ---- providers (borrowed from gd-app-core, same list the app plays over) ---- */

    function centre() { try { return mapObj ? mapObj.getCenter() : null; } catch (e) { return null; } }
    function sourceByKey(key) { return liveSources().filter(function (s) { return s.key === key; })[0] || null; }
    function availability(source, here) {
      var api = sourcesApi();
      if (source.requiresKey && !api.keyValue(source.requiresKey)) return "no key";
      if (here && !api.covers(source, here)) return "no coverage here";
      return "";
    }
    var providerSignature = "";
    function buildProviderOptions() {
      var here = centre();
      var rows = liveSources().map(function (s) {
        var why = availability(s, here);
        return { key: s.key, text: s.name + (why ? " — " + why : "") };
      });
      var signature = rows.map(function (r) { return r.key + "|" + r.text; }).join("\n");
      if (signature === providerSignature) return;
      providerSignature = signature;
      var current = el.provider.value || session.sourceKey;
      el.provider.innerHTML = rows.map(function (r) { return '<option value="' + esc(r.key) + '">' + esc(r.text) + "</option>"; }).join("");
      if (current) el.provider.value = current;
    }
    /* Imagery first: shapes are placed by eye off the ground, and the OSM line guide has no
       ground to look at. First covering source in list order is the app's own preference, which
       puts regional aerial before the global fallback; the line guide is what is left when
       nothing aerial covers the view. */
    function bestSourceKey() {
      var here = centre();
      var api = sourcesApi();
      var covering = liveSources().filter(function (s) { return api.ready(s, here); });
      var aerial = covering.filter(function (s) { return !/osm|line|guide|street/i.test(String(s.key) + " " + String(s.name)); })[0];
      var found = aerial || covering[0];
      return found ? found.key : (liveSources()[0] || {}).key || "";
    }
    function useSource(key) {
      var source = sourceByKey(key) || liveSources()[0];
      if (!source) return;
      session.sourceKey = source.key;
      el.provider.value = source.key;
      if (layer) { try { mapObj.removeLayer(layer); } catch (e) {} }
      layer = sourcesApi().buildLayer(source);
      /* The layer's options are its own copy (buildLayer copies the source's), so the zoom
         settings below change this map only. */
      layer.options.maxZoom = DRAW_MAX_ZOOM;
      watchImageryCeiling(layer);
      layer.addTo(mapObj);
      try { mapObj.setMaxZoom(DRAW_MAX_ZOOM); } catch (e) {}
      el.credit.innerHTML = esc(source.label) + (source.attribution ? " — " + esc(source.attribution) : "");
      remember();
    }

    /* Zoomed past the deepest level a provider has here, every tile fails and the map goes
       black. The first zoom at which tiles fail and none has loaded is taken as that ceiling:
       the layer's native zoom drops below it, and Leaflet blows up the last real imagery
       instead of asking for more. The wand reads the same ceiling (captureAround), so it never
       asks for a level that is not there either. */
    function watchImageryCeiling(tiles) {
      var seen = {};
      tiles.on("tileload tileerror", function (e) {
        if (tiles !== layer || !e.coords) return;
        var z = e.coords.z;
        var count = seen[z] || (seen[z] = { loads: 0, errors: 0 });
        if (e.type === "tileload") { count.loads++; return; }
        count.errors++;
        var native = num(tiles.options.maxNativeZoom);
        if (count.loads || count.errors < 3 || z <= IMAGERY_CEILING_FLOOR_Z || (native != null && native < z)) return;
        tiles.options.maxNativeZoom = z - 1;
        tiles.redraw();
        updateReadout();
      });
    }

    /* ---- tools ---- */

    /* Shapes can only change once the course's saved overlay is on screen and no AI scan is
       about to replace it - an edit made under a scan would be overwritten by its result. */
    function canEdit() {
      return !!session.course && session.loadedFor === courseIdOf(session.course) && !scanning && !busy;
    }

    var TOOLS = ["move", "connect", "fairway", "green", "tee", "bunker", "water"];

    /* The tool picked stays picked: placing a shape never switches to another tool, so a run
       of greens or bunkers is a run of clicks. */
    function setTool(next) {
      if (adjust) commitAdjust(true);
      tool = TOOLS.indexOf(next) >= 0 ? next : "move";
      TOOLS.forEach(function (name) {
        el["tool-" + name].classList.toggle("isActive", tool === name);
        el.stage.classList.toggle("isTool-" + name, tool === name);
      });
      if (draft.length && tool !== "fairway") cancelDraft();
      lastPlacedId = "";
      if (connectFrom) { connectFrom = ""; drawFeatures(); }
      if (tool !== "move" && selectedId) select("");
      /* Double-click zooms, except while laying a fairway line, where it would move the ground
         under the last point. */
      if (mapObj) { try { if (tool === "fairway") mapObj.doubleClickZoom.disable(); else mapObj.doubleClickZoom.enable(); } catch (e) {} }
      renderOptions();
      syncMapDragging();
      updateHint();
    }

    /* ---- modes: shapes, or pins only ---- */

    var TOOL_TEXT = {
      shapes: {
        fairway: "Lay a line down the fairway (F)",
        green: "Click a green and the wand outlines it (G)",
        tee: "Drop a round tee (T)",
        bunker: "Click a bunker and the wand outlines it (B)",
        water: "Draw round a water hazard, or click it for the wand (W)"
      },
      pins: {
        fairway: "Click where the fairway starts, then where it ends - it becomes a fairway (F)",
        green: "Pin the middle of a green - the wand outlines it (G)",
        tee: "Pin the middle of a tee (T)",
        bunker: "Pin the middle of a bunker (B)",
        water: "Pin the middle of a water hazard (W)"
      }
    };

    function setMode(next) {
      if (adjust) commitAdjust(true);
      session.mode = next === "pins" ? "pins" : "shapes";
      if (draft.length) cancelDraft();
      el["mode-shapes"].classList.toggle("isActive", session.mode === "shapes");
      el["mode-pins"].classList.toggle("isActive", session.mode === "pins");
      ["fairway", "green", "tee", "bunker", "water"].forEach(function (name) {
        el["tool-" + name].title = TOOL_TEXT[session.mode][name];
      });
      renderOptions();
      syncMapDragging();
      remember();
      updateHint();
    }

    /* The options along the top that belong to the tool and mode in hand. The wand size shows
       for a tool that uses the wand: any of them in Shapes, the green in Pins too (a green pin
       is outlined at once). */
    function renderOptions() {
      var shapesMode = session.mode === "shapes";
      el["width-label"].hidden = !shapesMode;
      el["merge-label"].hidden = !shapesMode;
      el["water-method"].hidden = !shapesMode || tool !== "water";
      el["water-wand"].classList.toggle("isActive", !session.waterDraw);
      el["water-draw"].classList.toggle("isActive", !!session.waterDraw);
      el["wand-size-label"].hidden = WAND_KINDS.indexOf(tool) < 0 || waterDrawing() || !(shapesMode || tool === "green");
      renderWandSize();
    }

    /* ---- water: drawn round, or the wand ---- */

    function waterDrawing() { return tool === "water" && !!session.waterDraw && session.mode === "shapes"; }

    function setWaterDraw(on) {
      session.waterDraw = !!on;
      renderOptions();
      syncMapDragging();
      remember();
      updateHint();
    }

    /* Drawing round water is a press-and-drag, so the map does not pan under it; any other tool
       pans as usual. */
    function syncMapDragging() {
      if (!mapObj || drag || connect || lasso) return;
      try { if (waterDrawing()) mapObj.dragging.disable(); else mapObj.dragging.enable(); } catch (e) {}
    }

    var lasso = null;

    function beginLasso(event) {
      if (!waterDrawing() || event.button || drag || connect || lasso || !mapObj) return;
      if (Date.now() - dragEndedAt < 300) return;
      if (!canEdit()) { setStatus(scanning ? "Wait for the AI scan to finish." : "Still loading this course's overlay…"); return; }
      if (session.features.length >= MAX_FEATURES) { setStatus("That is the most shapes one course can hold (" + MAX_FEATURES + "). Bin some first.", true); return; }
      if (adjust) commitAdjust(true);
      event.preventDefault();
      lasso = { points: [mapObj.mouseEventToLatLng(event)], x: event.clientX, y: event.clientY, line: L.polyline([], STYLE.lasso).addTo(mapObj) };
      document.addEventListener("pointermove", onLassoMove);
      document.addEventListener("pointerup", onLassoEnd);
      document.addEventListener("pointercancel", onLassoEnd);
    }

    function onLassoMove(event) {
      if (!lasso || destroyed) return;
      if (Math.hypot(event.clientX - lasso.x, event.clientY - lasso.y) < 4) return;
      lasso.x = event.clientX;
      lasso.y = event.clientY;
      lasso.points.push(mapObj.mouseEventToLatLng(event));
      lasso.line.setLatLngs(lasso.points.concat([lasso.points[0]]));
    }

    function onLassoEnd(event) {
      document.removeEventListener("pointermove", onLassoMove);
      document.removeEventListener("pointerup", onLassoEnd);
      document.removeEventListener("pointercancel", onLassoEnd);
      var drawn = lasso;
      lasso = null;
      if (destroyed || !drawn) return;
      try { mapObj.removeLayer(drawn.line); } catch (e) {}
      /* The click that ends the press must not count as one on the map. */
      dragEndedAt = Date.now();
      syncMapDragging();
      if (event.type === "pointercancel") return;
      var ring = shapes.simplifyOutline(drawn.points.map(function (p) { return { lat: p.lat, lng: p.lng }; }), shapes.WATER_MAX_POINTS);
      if (!ring) { setStatus("Press and drag all the way round the water to outline it.", true); return; }
      var f = addFeature({ kind: "water", points: ring });
      startAdjust(f, { base: ring });
      setStatus("Water hazard placed.");
    }

    /* ---- the wand's size ----
       One size per wand kind. The − and + here set it for the next click; on a wand shape just
       placed they (and up / down) run the wand again at the new size. */

    function wandKind() { return WAND_KINDS.indexOf(tool) >= 0 ? tool : "green"; }

    function renderWandSize() {
      var kind = wandKind(), size = session.wandSize[kind];
      el["wand-size-name"].textContent = (kind === "water" ? "Water" : kindLabel(kind)) + " wand";
      el["wand-size"].textContent = pct(size);
      el["wand-smaller"].disabled = size <= WAND_SIZES[0];
      el["wand-bigger"].disabled = size >= WAND_SIZES[WAND_SIZES.length - 1];
    }

    function nextWandSize(size, by) {
      var at = WAND_SIZES.indexOf(size);
      if (at < 0) at = WAND_SIZES.indexOf(1);
      return WAND_SIZES[Math.max(0, Math.min(WAND_SIZES.length - 1, at + by))];
    }

    function stepWandSize(by) {
      var kind = wandKind();
      if (adjusted() && adjust.seed && adjust.kind === kind) { stepSize(by); return; }
      session.wandSize[kind] = nextWandSize(session.wandSize[kind], by);
      renderWandSize();
      remember();
      setStatus(kindLabel(kind) + " wand at " + pct(session.wandSize[kind]) + " - the next one you click uses it.");
    }

    /* ---- adjusting what was just placed ----
       The shape placed last stays live until it is kept: left and right step the wand's
       sensitivity through the edges it found, up and down make it smaller or bigger (a fairway
       narrower or wider, a wand shape run again at the next wand size, anything else scaled
       about its middle). Enter or Space keeps it, Esc bins it; placing the next shape, picking
       a tool or selecting another shape keeps it too. A bunker merges with any it overlaps
       only once it is kept, so stepping it never swallows a neighbour. */

    var adjust = null;

    function adjusted() {
      var f = adjust ? findFeature(adjust.id) : null;
      if (adjust && !f) adjust = null;
      return f;
    }

    /* opts: seed and wand (a wand shape: its click and the wand's answer), size (the wand size
       it ran at), line (a fairway's centre line), base (anything else: the outline to scale). */
    function startAdjust(f, opts) {
      if (adjust) commitAdjust(true);
      if (!f || f.pin) return;
      adjust = {
        id: f.id, kind: f.kind, seed: opts.seed || null, size: opts.size || 1, line: opts.line || null,
        base: opts.base || null, steps: 0, candidates: [], index: 0, running: false
      };
      if (opts.wand) takeWand(opts.wand);
      drawFeatures();
      updateHint();
    }

    function takeWand(result) {
      adjust.candidates = result.shape ? result.candidates : [];
      adjust.index = result.shape ? result.pick : 0;
    }

    function commitAdjust(quiet) {
      var f = adjusted();
      adjust = null;
      if (!f) return;
      var into = f.kind === "bunker" ? mergeBunker(f.points, f.hole, f) : null;
      if (into) {
        session.features = session.features.filter(function (g) { return g !== f; });
        if (selectedId === f.id) selectedId = "";
        if (lastPlacedId === f.id) lastPlacedId = into.id;
        changed();
        setStatus("Bunker merged with the one it overlaps.");
      } else if (!quiet) setStatus(kindLabel(f.kind) + " kept.");
      drawFeatures();
      updateHint();
    }

    function discardAdjust() {
      var f = adjusted();
      if (!f) return;
      removeFeature(f.id);
      setStatus(kindLabel(f.kind) + " removed.");
      updateHint();
    }

    function stepSensitivity(by) {
      var f = adjusted();
      if (!f || adjust.running) return;
      var n = adjust.candidates.length;
      if (n < 2) { setStatus(adjust.seed ? "The wand found just one edge here - up and down change its size." : "Only up and down (smaller / bigger) work on this one."); return; }
      var next = Math.max(0, Math.min(n - 1, adjust.index + by));
      if (next === adjust.index) { setStatus(by < 0 ? "That is the wand's lowest sensitivity here." : "That is the wand's highest sensitivity here."); return; }
      adjust.index = next;
      f.points = shapes.smoothOutline(adjust.candidates[next], f.kind);
      f.source = "wand";
      drawFeatures();
      changed();
      updateHint();
      setStatus("Wand sensitivity " + (next + 1) + " of " + n + ".");
    }

    function stepSize(by) {
      var f = adjusted();
      if (!f || adjust.running) return;
      if (f.kind === "fairway" && adjust.line) {
        var width = Math.max(10, Math.min(90, session.fairwayWidth + by * FAIRWAY_WIDTH_STEP_M));
        var ring = width !== session.fairwayWidth ? shapes.fairwayFromLine(adjust.line, width) : null;
        if (!ring) { setStatus(by < 0 ? "That is as narrow as a fairway goes." : "That is as wide as a fairway goes."); return; }
        session.fairwayWidth = width;
        el.width.value = width;
        remember();
        f.points = ring;
        drawFeatures();
        changed();
        updateHint();
        setStatus("Fairway " + width + "m wide - the next one starts at this width too.");
        return;
      }
      if (adjust.seed) { rerunWand(f, by); return; }
      if (!adjust.base) adjust.base = f.points.slice();
      var steps = Math.max(-6, Math.min(6, adjust.steps + by));
      if (steps === adjust.steps) { setStatus(by < 0 ? "That is as small as it goes - drag its corners for more." : "That is as big as it goes - drag its corners for more."); return; }
      adjust.steps = steps;
      f.points = shapes.scaleAbout(adjust.base, Math.pow(SCALE_STEP, steps));
      drawFeatures();
      changed();
      updateHint();
    }

    /* Up or down on a wand shape: the wand again on the same click, a size step smaller or
       bigger. The size sticks for the next one of that kind. */
    function rerunWand(f, by) {
      var kind = f.kind;
      var size = nextWandSize(adjust.size, by);
      if (size === adjust.size) { setStatus(by < 0 ? "That is the smallest the wand goes." : "That is the biggest the wand goes."); return; }
      session.wandSize[kind] = size;
      renderWandSize();
      remember();
      var mine = adjust;
      mine.running = true;
      mine.size = size;
      updateHint();
      var id = session.loadedFor;
      wandOutline(mine.seed, kind, size).then(function (result) {
        mine.running = false;
        if (destroyed || adjust !== mine || session.loadedFor !== id) return;
        var live = findFeature(mine.id);
        if (!live) { adjust = null; updateHint(); return; }
        if (!result.shape) { setStatus(result.note + " Kept the outline you had.", true); updateHint(); return; }
        takeWand(result);
        live.points = shapes.smoothOutline(result.candidates[result.pick], kind);
        live.source = "wand";
        drawFeatures();
        changed();
        updateHint();
        setStatus(kindLabel(kind) + " wand at " + pct(size) + ". " + result.note);
      });
    }

    /* The live shape dragged whole: what it is rebuilt from moves with it. */
    function shiftAdjust(dLat, dLng) {
      function move(p) { return { lat: p.lat + dLat, lng: p.lng + dLng }; }
      if (adjust.seed) adjust.seed = move(adjust.seed);
      if (adjust.line) adjust.line = adjust.line.map(move);
      if (adjust.base) adjust.base = adjust.base.map(move);
      adjust.candidates = adjust.candidates.map(function (ring) { return ring.map(move); });
    }

    /* Arrow keys, Enter, Space and Esc belong to the live shape while there is one - ahead of
       the map's own arrow-key panning, hence the capture phase. */
    function onAdjustKey(event) {
      if (!adjust || event.metaKey || event.ctrlKey || event.altKey) return;
      var target = event.target;
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
      if (!containerEl.isConnected || !adjusted() || !canEdit() || drag) return;
      var key = event.key;
      if (key === "ArrowLeft") stepSensitivity(-1);
      else if (key === "ArrowRight") stepSensitivity(1);
      else if (key === "ArrowUp") stepSize(1);
      else if (key === "ArrowDown") stepSize(-1);
      else if (key === "Enter" || key === " " || key === "Spacebar") commitAdjust(false);
      else if (key === "Escape") discardAdjust();
      else return;
      event.preventDefault();
      event.stopPropagation();
    }

    /* ---- navigation ---- */

    var fullscreen = false;
    function setFullscreen(on) {
      fullscreen = !!on;
      session.fullscreen = fullscreen;
      el.workspace.classList.toggle("isFullscreen", fullscreen);
      el.fullscreen.innerHTML = fullscreen ? ICON.shrink : ICON.expand;
      el.fullscreen.title = fullscreen ? "Leave full screen (Esc)" : "Full screen";
      el.fullscreen.setAttribute("aria-label", el.fullscreen.title);
      el.fullscreen.classList.toggle("isActive", fullscreen);
      document.documentElement.classList.toggle("gdStudioOverlayNoScroll", fullscreen);
      remember();
      remeasure();
    }

    function setMenu(open) {
      el.menu.hidden = !open;
      el["menu-toggle"].setAttribute("aria-expanded", open ? "true" : "false");
      el["menu-toggle"].classList.toggle("isOpen", !!open);
    }

    function fitCourse() {
      var pts = [];
      session.features.forEach(function (f) { pts = pts.concat(toLatLngs(f.points)); });
      if (session.osm && !session.osm.error) (session.osm.greens || []).forEach(function (g) { pts = pts.concat(toLatLngs(g.points || [])); });
      if (pts.length) { try { mapObj.fitBounds(L.latLngBounds(pts).pad(0.08)); return; } catch (e) {} }
      var point = courseLatLng(session.course);
      if (point) mapObj.setView(point, 16);
    }

    function zoomToSelected() {
      var f = selectedId ? findFeature(selectedId) : null;
      if (!f) { setStatus("Click a shape first, then zoom to it."); return; }
      try { mapObj.fitBounds(L.latLngBounds(toLatLngs(f.points)).pad(f.kind === "fairway" ? 0.15 : 1.2), { maxZoom: 20 }); } catch (e) {}
    }

    function handleMapClick(latlng) {
      if (Date.now() - dragEndedAt < 300) return;
      if (!session.course) { setStatus("Pick a course first."); return; }
      if (tool === "connect") { if (connectFrom) { connectFrom = ""; drawFeatures(); updateHint(); } return; }
      if (tool === "move") { if (selectedId) select(""); return; }
      if (!canEdit()) { setStatus(scanning ? "Wait for the AI scan to finish." : "Still loading this course's overlay…"); return; }
      if (session.features.length >= MAX_FEATURES) { setStatus("That is the most shapes one course can hold (" + MAX_FEATURES + "). Bin some first.", true); return; }
      /* Moving on to the next shape keeps the one just placed. */
      if (adjust) commitAdjust(true);
      var point = { lat: latlng.lat, lng: latlng.lng };
      if (tool === "fairway") addDraftPoint(point);
      else if (session.mode === "pins") {
        var pin = addFeature({ kind: tool, pin: true, points: [point] });
        /* A green pin is outlined by the wand at once; drag the pin while it works and the
           wand runs again where it is dropped. */
        if (tool === "green") { setStatus("Green pinned - finding its edge…"); wandPin(pin.id); }
        else setStatus(kindLabel(tool) + " pinned.");
      }
      else if (waterDrawing()) setStatus("Press and drag all the way round the water - or switch Water to Wand to click it.");
      else if (WAND_KINDS.indexOf(tool) >= 0) placeWand(point, tool);
      else if (tool === "tee") {
        var tee = addFeature({ kind: "tee", points: shapes.teeAt(point) });
        startAdjust(tee, { base: tee.points.slice() });
      }
    }

    /* ---- fairway line ---- */

    function clearDraftLayers() {
      draftLayers.forEach(function (l) { try { mapObj.removeLayer(l); } catch (e) {} });
      draftLayers = [];
    }

    /* The line so far, the rubber band to the cursor, and the fairway it would make - so the
       width is visible before the line is finished. */
    function drawDraft() {
      clearDraftLayers();
      if (!draft.length) return;
      var line = cursorLatLng ? draft.concat([cursorLatLng]) : draft;
      if (line.length >= 2) {
        var preview = session.mode === "shapes" ? shapes.fairwayFromLine(line, session.fairwayWidth) : null;
        if (preview) draftLayers.push(L.polygon(toLatLngs(preview), STYLE.draftPreview).addTo(mapObj));
        draftLayers.push(L.polyline(toLatLngs(line), STYLE.draft).addTo(mapObj));
      }
      draft.forEach(function (p) { draftLayers.push(L.circleMarker([p.lat, p.lng], STYLE.draftPoint).addTo(mapObj)); });
    }

    function addDraftPoint(point) {
      var last = draft[draft.length - 1];
      /* A double-click delivers two clicks first; the second lands on the first's point and
         would leave a zero-length segment behind the finish. */
      if (last && Math.abs(last.lat - point.lat) < 1e-7 && Math.abs(last.lng - point.lng) < 1e-7) return;
      draft.push(point);
      /* A fairway pin is two clicks: its start, then its end. */
      if (session.mode === "pins" && draft.length >= 2) { finishFairway(); return; }
      drawDraft();
      updateDraftUi();
    }

    function undoDraftPoint() {
      draft.pop();
      drawDraft();
      updateDraftUi();
    }

    function cancelDraft() {
      draft = [];
      cursorLatLng = null;
      clearDraftLayers();
      updateDraftUi();
    }

    /* Finish, Undo point and Cancel on the map as well as on Enter, Backspace and Esc: a phone
       has no keyboard, and a double-tap to finish also lands a stray point. */
    function updateDraftUi() {
      el["draft-bar"].hidden = !draft.length;
      el["draft-finish"].hidden = session.mode === "pins";
      el["draft-finish"].disabled = draft.length < 2;
      updateActions();
      updateHint();
    }

    function finishFairway() {
      if (draft.length < 2) return;
      var line = draft.slice();
      cancelDraft();
      if (session.mode === "pins" && shapes.distanceM(line[0], line[1]) < 5) { setStatus("The start and end are too close together to be a fairway.", true); return; }
      var ring = shapes.fairwayFromLine(line, session.fairwayWidth);
      if (!ring) { setStatus("That line is too short to be a fairway.", true); return; }
      var f = addFeature({ kind: "fairway", points: ring });
      startAdjust(f, { line: line });
      setStatus(session.mode === "pins" ? "Fairway placed from its start and end. Click the next fairway's start, or drag this one to adjust it." : "Fairway placed. Lay the next one, or press Move (V) to drag its corners to fit.");
    }

    /* ---- the wand ---- */

    function defaultRadius(kind) { return kind === "bunker" ? shapes.BUNKER_RADIUS_M : kind === "water" ? shapes.WATER_RADIUS_M : shapes.GREEN_RADIUS_M; }

    /* The outline the wand finds around a point at a wand size, or null with the reason, plus
       every edge it found on the way (weakest reach first) and which one it picked - what left
       and right step through. Shows a marker on the point while it works. */
    function wandOutline(point, kind, size) {
      var marker = L.circleMarker([point.lat, point.lng], STYLE["wand" + kind.charAt(0).toUpperCase() + kind.slice(1)] || STYLE.wandGreen).addTo(mapObj);
      marker.bindTooltip("Finding the " + kindLabel(kind).toLowerCase() + "'s edge…", { permanent: true, direction: "top", className: "gdStudioOverlayLabel" });
      wandsRunning++;
      updateHint();
      /* The provider's sharpest zoom first; where that has gaps or the wand finds no edge, one
         zoom coarser - some providers' top zoom is patchy, and a green reads fine at 0.6m/px. */
      function attempt(coarser) {
        return captureAround(point, coarser, kind, size).then(function (capture) {
          return api("POST", "", { image: { data: capture.data, mediaType: capture.mediaType }, georef: capture.georef, seed: point, kind: kind, scale: size }, WAND_API);
        });
      }
      return attempt(0).then(function (data) {
        return data && data.ok ? data : attempt(1).catch(function () { return data; });
      }, function () { return attempt(1); }).then(function (data) {
        if (!(data && data.ok && Array.isArray(data.shape) && data.shape.length >= 3)) {
          return { shape: null, note: "The wand could not find an edge here (" + ((data && data.reason) || "no answer") + ")." };
        }
        var candidates = Array.isArray(data.candidates) ? data.candidates.map(function (c) { return c && c.shape; }) : [];
        var whole = candidates.length && candidates.every(function (ring) { return Array.isArray(ring) && ring.length >= 3; });
        var pick = num(data.pick);
        return {
          shape: data.shape,
          candidates: whole ? candidates : [data.shape],
          pick: whole && pick != null && pick >= 0 && pick < candidates.length ? pick : 0,
          note: data.stable === false ? "The wand was unsure of this edge - check it." : ""
        };
      }, function (error) {
        return { shape: null, note: "The wand could not run: " + (error && error.message || error) + "." };
      }).then(function (result) {
        try { mapObj && mapObj.removeLayer(marker); } catch (e) {}
        wandsRunning--;
        if (!destroyed) updateHint();
        return result;
      });
    }

    /* A bunker outline joins every placed bunker it overlaps, when merging is on: the first
       one it touches takes the merged outline and the rest go. Returns that bunker, or null
       when it overlapped none. `except` is a feature the outline must not merge with (the pin
       it came from). */
    function mergeBunker(points, hole, except) {
      if (!session.mergeBunkers) return null;
      var into = null, merged = points;
      session.features.slice().forEach(function (f) {
        if (f.kind !== "bunker" || f.pin || f === except) return;
        var ring = shapes.mergeOverlapping(f.points, merged);
        if (!ring) return;
        merged = ring;
        if (!into) { into = f; return; }
        if (!into.hole && f.hole) into.hole = f.hole;
        session.features = session.features.filter(function (g) { return g !== f; });
        if (selectedId === f.id) selectedId = "";
      });
      if (!into) return null;
      into.points = shapes.smoothOutline(merged, "bunker");
      into.source = "wand";
      if (!into.hole && hole) into.hole = hole;
      return into;
    }

    /* What a wand answer is kept as: the edge it picked, as a smooth outline for a green or a
       bunker, or a round default where it found none. */
    function wandShape(kind, point, result) {
      var ring = result.shape ? result.candidates[result.pick] : shapes.circle(point, defaultRadius(kind));
      return shapes.smoothOutline(ring, kind);
    }

    function placeWand(point, kind) {
      var id = session.loadedFor;
      var hole = session.hole;
      var size = session.wandSize[kind];
      wandOutline(point, kind, size).then(function (result) {
        if (destroyed || session.loadedFor !== id) return;
        if (session.features.length >= MAX_FEATURES) { setStatus("That is the most shapes one course can hold.", true); return; }
        var word = kindLabel(kind);
        var f = addFeature({ kind: kind, points: wandShape(kind, point, result), source: result.shape ? "wand" : "", hole: hole });
        startAdjust(f, { seed: point, wand: result, size: size });
        setStatus(result.shape ? word + " placed. " + result.note : result.note + " Placed a round " + word.toLowerCase() + " instead.", !result.shape);
      });
    }

    /* ---- pins into shapes ----
       A green, bunker or water pin goes through the wand, a fairway pin becomes a fairway around its
       line, a tee pin a tee box facing the nearest green. The shape keeps the pin's id and hole
       number; a bunker that overlaps one already placed merges into it. */

    var shapingPins = 0;

    /* By id: a save that lands while the wand runs swaps in the server's copy of every shape.
       Resolves with the wand's answer when the pin went through the wand and became a shape. */
    function shapePin(pinId) {
      var f = findFeature(pinId);
      if (!f || !f.pin) return Promise.resolve();
      if (f.kind === "fairway") {
        var ring = shapes.fairwayFromLine(f.points, session.fairwayWidth);
        if (ring) { f.points = ring; delete f.pin; }
        return Promise.resolve();
      }
      if (f.kind === "tee") {
        f.points = shapes.teeAt(f.points[0]);
        delete f.pin;
        return Promise.resolve();
      }
      var id = session.loadedFor;
      var point = f.points[0];
      var size = session.wandSize[f.kind];
      return wandOutline(point, f.kind, size).then(function (result) {
        if (destroyed || session.loadedFor !== id) return;
        /* The pin may have been moved, binned or saved over while the wand ran. */
        var live = findFeature(pinId);
        if (!live || !live.pin || live.points[0].lat !== point.lat || live.points[0].lng !== point.lng) return;
        var points = wandShape(live.kind, point, result);
        if (live.kind === "bunker" && mergeBunker(points, live.hole, live)) {
          session.features = session.features.filter(function (g) { return g !== live; });
          if (selectedId === live.id) selectedId = "";
          return;
        }
        live.points = points;
        delete live.pin;
        if (result.shape) live.source = "wand"; else delete live.source;
        return { seed: point, wand: result, size: size };
      });
    }

    /* One pin through the wand, then saved - the pins-mode green, outlined as soon as it lands,
       and live for the arrow keys like any wand shape. */
    function wandPin(pinId) {
      shapePin(pinId).then(function (wanded) {
        if (destroyed) return;
        var f = findFeature(pinId);
        drawFeatures();
        changed();
        if (f && !f.pin) {
          if (wanded) startAdjust(f, wanded);
          setStatus(kindLabel(f.kind) + " outlined - drag its points to fit.");
        }
      });
    }

    function shapePins() {
      if (!canEdit()) return;
      var selected = selectedId ? findFeature(selectedId) : null;
      var list = (selected && selected.pin ? [selected] : session.features.filter(function (f) { return f.pin; })).map(function (f) { return f.id; });
      if (!list.length) return;
      shapingPins++;
      updateActions();
      setStatus("Shaping " + list.length + " pin" + (list.length === 1 ? "" : "s") + "…");
      /* One wand at a time, so a whole course of pins does not fire every request at once. */
      list.reduce(function (chain, pinId) {
        return chain.then(function () { return shapePin(pinId); }).then(function () {
          if (destroyed) return;
          drawFeatures();
          changed();
        });
      }, Promise.resolve()).then(function () {
        shapingPins--;
        if (destroyed) return;
        updateActions();
        setStatus("Pins shaped. Check each outline and drag its corners to fit.");
      });
    }

    /* ---- shapes ---- */

    function findFeature(id) { return session.features.filter(function (f) { return f.id === id; })[0] || null; }

    /* New shapes carry the hole number being worked on, when numbering is on. A wand pin keeps
       the number it was placed under, even if the number has moved on by the time it lands. */
    function addFeature(raw, quiet) {
      var hole = Object.prototype.hasOwnProperty.call(raw, "hole") ? raw.hole : session.hole;
      var f = { id: nextFeatureId(session.features), kind: raw.kind, hole: holeNumber(hole), points: raw.points.slice(0, MAX_POINTS) };
      if (raw.source) f.source = raw.source;
      if (raw.pin) f.pin = true;
      session.features.push(f);
      if (!quiet) { lastPlacedId = f.id; selectedId = tool === "move" ? f.id : selectedId; drawFeatures(); changed(); }
      return f;
    }

    function removeFeature(id) {
      if (adjust && adjust.id === id) adjust = null;
      session.features = session.features.filter(function (f) { return f.id !== id; });
      if (selectedId === id) selectedId = "";
      drawFeatures();
      changed();
    }

    function removeVertex(f, index) {
      if (isSmooth(f)) { setStatus("A " + kindLabel(f.kind).toLowerCase() + " keeps its " + shapes.SMOOTH[f.kind].handles + " points - bin the whole shape instead.", true); return false; }
      if (f.points.length <= minPoints(f)) { setStatus(f.pin ? "A pin keeps its points - bin the whole pin instead." : "A " + kindLabel(f.kind).toLowerCase() + " needs at least " + minPoints(f) + " corners - bin the whole shape instead.", true); return false; }
      f.points.splice(index, 1);
      drawFeatures();
      changed();
      return true;
    }

    function clearFeatureLayers() {
      Object.keys(featureLayers).forEach(function (id) {
        var entry = featureLayers[id];
        [entry.shape].concat(entry.vertices, entry.mids, entry.ends).forEach(function (l) { try { mapObj.removeLayer(l); } catch (e) {} });
      });
      featureLayers = {};
      clearLinkLayers();
    }

    function midpoints(f) {
      var out = [];
      if (f.pin || isSmooth(f)) return out;
      var n = f.points.length;
      var last = isPolygon(f.kind) ? n : n - 1;
      for (var i = 0; i < last; i++) {
        var a = f.points[i], b = f.points[(i + 1) % n];
        out.push({ after: i, lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 });
      }
      return out;
    }

    /* A green or bunker is edited by its few handles; anything else by every corner. */
    function isSmooth(f) { return !f.pin && !!shapes.SMOOTH[f.kind]; }
    function handlePoints(f) {
      var smooth = shapes.SMOOTH[f.kind];
      return isSmooth(f) ? shapes.ringHandles(f.points, smooth.handles, smooth.steps) : f.points;
    }

    function canDrag(f) { return !!f && canEdit() && (tool === "move" || f.id === lastPlacedId); }

    function drawFeatures() {
      clearFeatureLayers();
      session.features.forEach(function (f) {
        var selected = f.id === selectedId || f.id === connectFrom || (!!adjust && f.id === adjust.id);
        var latlngs = toLatLngs(f.points);
        var shape;
        if (f.pin && f.points.length === 1) {
          shape = L.circleMarker(latlngs[0], pinStyle(f.kind, selected));
        } else if (f.pin) {
          shape = L.polyline(latlngs, Object.assign({ className: "gdStudioOverlayShape" }, STYLE.pinFairway, selected ? { color: "#ffffff" } : {}));
        } else {
          var style = Object.assign({ className: "gdStudioOverlayShape" }, STYLE[f.kind + (selected ? "Selected" : "")] || STYLE.fairway);
          shape = isPolygon(f.kind) ? L.polygon(latlngs, style) : L.polyline(latlngs, style);
        }
        shape.addTo(mapObj);
        /* So the Link tool can tell which shape a drag was dropped on. */
        var node = shape.getElement && shape.getElement();
        if (node) node.setAttribute("data-gd-feature", f.id);
        shape.on("click", function (e) {
          /* Selecting a shape must not also count as a click on the map under it. */
          if (e && e.originalEvent) L.DomEvent.stop(e.originalEvent);
          if (tool !== "move") { handleMapClick(e.latlng); return; }
          if (Date.now() - dragEndedAt < 300) return;
          select(f.id);
        });
        onPress(shape, function (e) {
          if (tool === "connect") { if (canEdit()) beginConnect(f.id, e); return; }
          if (!canDrag(f)) return;
          if (tool === "move" && selectedId !== f.id) select(f.id);
          beginDrag(f.id, "body", -1, e);
        });
        if (f.hole) shape.bindTooltip(String(f.hole), { permanent: true, direction: "center", className: "gdStudioOverlayLabel" });
        var entry = { shape: shape, vertices: [], mids: [], ends: [] };
        /* A fairway pin's start and end, always shown, so it reads as two pins and a line. */
        if (f.pin && f.points.length === 2 && !selected) {
          f.points.forEach(function (p) { entry.ends.push(L.circleMarker([p.lat, p.lng], STYLE.pinFairwayEnd).addTo(mapObj)); });
        }
        if (f.id === selectedId && canEdit() && f.points.length > 1 && bigEnoughForHandles(f)) {
          handlePoints(f).forEach(function (p, i) {
            var v = L.circleMarker([p.lat, p.lng], STYLE.vertex).addTo(mapObj);
            onPress(v, function (e) { beginDrag(f.id, "vertex", i, e); });
            v.on("click", function (e) { if (e && e.originalEvent) L.DomEvent.stop(e.originalEvent); });
            v.on("contextmenu", function (e) {
              if (e && e.originalEvent) L.DomEvent.stop(e.originalEvent);
              removeVertex(f, i);
            });
            entry.vertices.push(v);
          });
          if (f.points.length < MAX_POINTS) {
            midpoints(f).forEach(function (m) {
              var h = L.circleMarker([m.lat, m.lng], STYLE.midpoint).addTo(mapObj);
              onPress(h, function (e) {
                if (tool !== "move" || !canEdit()) return;
                f.points.splice(m.after + 1, 0, { lat: m.lat, lng: m.lng });
                drawFeatures();
                beginDrag(f.id, "vertex", m.after + 1, e, true);
              });
              h.on("click", function (e) { if (e && e.originalEvent) L.DomEvent.stop(e.originalEvent); });
              entry.mids.push(h);
            });
          }
        }
        featureLayers[f.id] = entry;
      });
      drawLinks();
      updateBin();
      updateReadout();
      renderHoleField();
    }

    function pinStyle(kind, selected) {
      var style = Object.assign({ className: "gdStudioOverlayShape" }, STYLE["pin" + kind.charAt(0).toUpperCase() + kind.slice(1)] || STYLE.pinGreen);
      if (selected) { style.color = "#ffffff"; style.weight = 3; style.radius += 2; }
      return style;
    }

    /* Corner handles on a shape only a few pixels across would cover it entirely and make it
       impossible to grab by its body; zoomed out, a small shape is moved whole, and zooming in
       brings its corners back. */
    function bigEnoughForHandles(f) {
      try {
        var b = L.latLngBounds(toLatLngs(f.points));
        var a = mapObj.latLngToLayerPoint(b.getNorthWest()), c = mapObj.latLngToLayerPoint(b.getSouthEast());
        return Math.max(Math.abs(c.x - a.x), Math.abs(c.y - a.y)) >= 36;
      } catch (e) { return true; }
    }

    /* Mid-drag, only the dragged shape moves: its outline and handles follow the points
       without rebuilding every layer on the map. */
    function refreshFeature(f) {
      var entry = featureLayers[f.id];
      if (!entry) return;
      if (f.pin && f.points.length === 1) entry.shape.setLatLng([f.points[0].lat, f.points[0].lng]);
      else entry.shape.setLatLngs(toLatLngs(f.points));
      entry.ends.forEach(function (m, i) { if (f.points[i]) m.setLatLng([f.points[i].lat, f.points[i].lng]); });
      var handles = handlePoints(f);
      entry.vertices.forEach(function (v, i) { if (handles[i]) v.setLatLng([handles[i].lat, handles[i].lng]); });
      midpoints(f).forEach(function (m, i) { if (entry.mids[i]) entry.mids[i].setLatLng([m.lat, m.lng]); });
    }

    function select(id) {
      if (adjust && adjust.id !== id) commitAdjust(true);
      selectedId = id || "";
      drawFeatures();
      updateHint();
      updateActions();
    }

    /* ---- hole numbers ----
       One field, two jobs, said by its label: with a shape selected it is that shape's number;
       with nothing selected it is the number new shapes get. Empty means unnumbered - the
       mapper numbers those from the scorecard. */

    function setHole(n) {
      session.hole = holeNumber(n);
      renderHoleField();
    }

    function renderHoleField() {
      if (destroyed || !el.hole) return;
      var f = selectedId ? findFeature(selectedId) : null;
      var value = f ? f.hole : session.hole;
      if (document.activeElement !== el.hole) el.hole.value = value ? String(value) : "";
      el["hole-label"].firstChild.nodeValue = f ? kindLabel(f.kind) + " hole " : "Hole ";
      el.hole.title = f ? "This shape's hole number - empty leaves it for the mapper to number" : "Number new shapes with this hole - empty leaves them unnumbered";
    }

    function holeFieldChanged() {
      var n = holeNumber(el.hole.value);
      var f = selectedId ? findFeature(selectedId) : null;
      if (f) {
        if (f.hole === n) return;
        f.hole = n;
        drawFeatures();
        changed();
        setStatus(kindLabel(f.kind) + (n ? " numbered hole " + n + "." : " left unnumbered."));
      } else {
        setHole(n);
        setStatus(n ? "New shapes will be numbered hole " + n + "." : "New shapes will be left unnumbered.");
      }
    }

    /* ---- dragging and the bin ---- */

    function overBin(event) {
      var r = el.bin.getBoundingClientRect();
      var pad = 10;
      return event.clientX >= r.left - pad && event.clientX <= r.right + pad && event.clientY >= r.top - pad && event.clientY <= r.bottom + pad;
    }

    /* A press that can start a drag is a pointer press, so a finger drags a shape or a corner
       the way a mouse does - a touch sends no mousedown until it lifts. Primary button only. */
    function onPress(layer, fn) {
      var node = layer.getElement && layer.getElement();
      if (!node) return;
      node.addEventListener("pointerdown", function (event) {
        if (event.button || !mapObj) return;
        fn({ originalEvent: event, latlng: mapObj.mouseEventToLatLng(event) });
      });
    }

    function beginDrag(id, mode, index, e, inserted) {
      var f = findFeature(id);
      if (!canDrag(f) || !e || !e.originalEvent) return;
      L.DomEvent.stop(e.originalEvent);
      mapObj.dragging.disable();
      drag = {
        id: id, mode: mode, index: index, inserted: !!inserted, moved: false,
        start: e.latlng, x: e.originalEvent.clientX, y: e.originalEvent.clientY,
        orig: f.points.map(function (p) { return { lat: p.lat, lng: p.lng }; })
      };
      document.addEventListener("pointermove", onDragMove);
      document.addEventListener("pointerup", onDragEnd);
      document.addEventListener("pointercancel", onDragEnd);
    }

    function onDragMove(event) {
      if (!drag || destroyed) return;
      if (!drag.moved) {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 3) return;
        drag.moved = true;
        el.bin.classList.add("isArmed");
      }
      var f = findFeature(drag.id);
      if (!f) return;
      var ll = mapObj.mouseEventToLatLng(event);
      if (drag.mode === "body") {
        var dLat = ll.lat - drag.start.lat, dLng = ll.lng - drag.start.lng;
        f.points = drag.orig.map(function (p) { return { lat: p.lat + dLat, lng: p.lng + dLng }; });
      } else if (isSmooth(f)) {
        var smooth = shapes.SMOOTH[f.kind];
        var handles = shapes.ringHandles(drag.orig, smooth.handles, smooth.steps);
        handles[drag.index] = { lat: ll.lat, lng: ll.lng };
        f.points = shapes.smoothRing(handles, smooth.steps);
      } else {
        f.points[drag.index] = { lat: ll.lat, lng: ll.lng };
      }
      refreshFeature(f);
      el.bin.classList.toggle("isHot", overBin(event));
    }

    function onDragEnd(event) {
      document.removeEventListener("pointermove", onDragMove);
      document.removeEventListener("pointerup", onDragEnd);
      document.removeEventListener("pointercancel", onDragEnd);
      var d = drag;
      drag = null;
      if (destroyed) return;
      syncMapDragging();
      el.bin.classList.remove("isArmed", "isHot");
      if (!d) return;
      var f = findFeature(d.id);
      /* Also on a plain click: the mousedown may have re-drawn the shape under the pointer, and
         the click that follows would land on the map and undo the selection it just made. */
      dragEndedAt = Date.now();
      if (!d.moved) {
        if (d.inserted) changed();
        return;
      }
      if (!f) return;
      if (event.type !== "pointercancel" && overBin(event)) {
        if (d.mode === "body") { removeFeature(f.id); setStatus(kindLabel(f.kind) + " deleted."); return; }
        f.points = d.orig;
        if (d.inserted) { f.points.splice(d.index, 1); drawFeatures(); return; }
        if (removeVertex(f, d.index)) setStatus("Corner deleted.");
        else drawFeatures();
        return;
      }
      /* The live shape dragged whole keeps its arrow keys; reshaped by a corner, it is kept as
         the hand left it. */
      if (adjust && adjust.id === f.id) {
        if (d.mode === "body") shiftAdjust(f.points[0].lat - d.orig[0].lat, f.points[0].lng - d.orig[0].lng);
        else commitAdjust(true);
      }
      drawFeatures();
      changed();
      if (f.pin && f.kind === "green") wandPin(f.id);
    }

    /* ---- linking shapes to a hole ----
       Drag from one shape to another, or tap one and then the other: the second joins the
       first's hole (or the first joins the second's, when only that one is numbered; when
       neither is, both take the lowest number no shape uses yet). Dropped on empty ground, the
       shape dragged from leaves its hole. */

    function featureAt(x, y) {
      var node = document.elementFromPoint(x, y);
      while (node && node !== el.stage) {
        var id = node.getAttribute && node.getAttribute("data-gd-feature");
        if (id) return findFeature(id);
        node = node.parentNode;
      }
      return null;
    }

    function freeHole() {
      var used = {};
      session.features.forEach(function (f) { if (f.hole) used[f.hole] = true; });
      for (var n = 1; n <= 36; n++) if (!used[n]) return n;
      return null;
    }

    function linkFeatures(a, b) {
      var hole = a.hole || b.hole || freeHole();
      if (!hole) { setStatus("Every hole number is in use.", true); return; }
      a.hole = hole;
      b.hole = hole;
      drawFeatures();
      changed();
      setStatus(kindLabel(a.kind) + " and " + kindLabel(b.kind).toLowerCase() + " are on hole " + hole + ".");
    }

    function beginConnect(id, e) {
      var f = findFeature(id);
      if (!f || !e || !e.originalEvent) return;
      L.DomEvent.stop(e.originalEvent);
      mapObj.dragging.disable();
      var from = shapes.centroid(f.points);
      connect = {
        id: id, moved: false, x: e.originalEvent.clientX, y: e.originalEvent.clientY,
        line: L.polyline([[from.lat, from.lng], [from.lat, from.lng]], STYLE.linkDraft).addTo(mapObj), from: from
      };
      document.addEventListener("pointermove", onConnectMove);
      document.addEventListener("pointerup", onConnectEnd);
      document.addEventListener("pointercancel", onConnectEnd);
    }

    function onConnectMove(event) {
      if (!connect || destroyed) return;
      if (!connect.moved && Math.hypot(event.clientX - connect.x, event.clientY - connect.y) < 6) return;
      connect.moved = true;
      var ll = mapObj.mouseEventToLatLng(event);
      connect.line.setLatLngs([[connect.from.lat, connect.from.lng], ll]);
    }

    function onConnectEnd(event) {
      document.removeEventListener("pointermove", onConnectMove);
      document.removeEventListener("pointerup", onConnectEnd);
      document.removeEventListener("pointercancel", onConnectEnd);
      var c = connect;
      connect = null;
      if (destroyed || !c) return;
      try { mapObj.removeLayer(c.line); } catch (e) {}
      syncMapDragging();
      dragEndedAt = Date.now();
      var from = findFeature(c.id);
      if (!from || event.type === "pointercancel") return;
      if (!c.moved) {
        /* A tap: the first picks the shape to link from, the second links it. */
        var first = connectFrom ? findFeature(connectFrom) : null;
        if (first && first.id !== from.id) { connectFrom = ""; linkFeatures(first, from); }
        else { connectFrom = connectFrom === from.id ? "" : from.id; drawFeatures(); }
        updateHint();
        return;
      }
      connectFrom = "";
      var to = featureAt(event.clientX, event.clientY);
      if (to && to.id !== from.id) { linkFeatures(from, to); updateHint(); return; }
      if (!to && from.hole) {
        var was = from.hole;
        from.hole = null;
        drawFeatures();
        changed();
        setStatus(kindLabel(from.kind) + " taken off hole " + was + ".");
      } else drawFeatures();
      updateHint();
    }

    function clearLinkLayers() {
      linkLayers.forEach(function (l) { try { mapObj.removeLayer(l); } catch (e) {} });
      linkLayers = [];
    }

    /* Shapes on one hole are joined by a dotted line - tee to fairway to green, and each bunker
       to the nearest of those - so what belongs together reads at a glance. */
    var LINK_ORDER = { tee: 0, hole: 1, fairway: 2, green: 3 };
    function drawLinks() {
      clearLinkLayers();
      var groups = {};
      session.features.forEach(function (f) { if (f.hole && f.points.length) (groups[f.hole] = groups[f.hole] || []).push(f); });
      Object.keys(groups).forEach(function (hole) {
        var list = groups[hole];
        if (list.length < 2) return;
        var spine = list.filter(function (f) { return f.kind !== "bunker"; }).sort(function (a, b) { return LINK_ORDER[a.kind] - LINK_ORDER[b.kind]; }).map(function (f) { return shapes.centroid(f.points); });
        var bunkers = list.filter(function (f) { return f.kind === "bunker"; }).map(function (f) { return shapes.centroid(f.points); });
        var segments = [];
        for (var i = 1; i < spine.length; i++) segments.push([spine[i - 1], spine[i]]);
        bunkers.forEach(function (b, k) {
          var anchors = spine.length ? spine : bunkers.slice(0, k);
          if (!anchors.length) return;
          var near = anchors.slice().sort(function (p, q) { return shapes.distanceM(b, p) - shapes.distanceM(b, q); })[0];
          segments.push([near, b]);
        });
        segments.forEach(function (seg) {
          var line = L.polyline(toLatLngs(seg), STYLE.link).addTo(mapObj);
          try { line.bringToBack(); } catch (e) {}
          linkLayers.push(line);
        });
      });
    }

    function updateBin() {
      el.bin.classList.toggle("hasSelection", !!selectedId);
      el.bin.hidden = !session.course;
    }

    /* ---- autosave ---- */

    function changed() {
      session.dirty = true;
      session.rev++;
      scheduleSave(SAVE_DELAY_MS);
      updateActions();
      updateReadout();
      remember();
    }

    function scheduleSave(delay) {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(function () { saveTimer = null; saveOverlay(); }, delay);
    }

    function renderSaveState() {
      if (destroyed) return;
      /* One button says it all: what is waiting, what is going, and what failed. Changes save
         by themselves after a pause; the button saves now. */
      var save = el.save;
      save.textContent = session.saving ? "Saving…" : session.saveError ? "Retry save" : session.dirty ? "Save" : "Saved";
      save.disabled = !session.loadedFor || session.saving || (!session.dirty && !session.saveError);
      save.classList.toggle("isDirty", !!session.dirty && !session.saveError);
      save.classList.toggle("isWarn", !!session.saveError);
      save.title = session.saveError ? "Not saved - " + session.saveError : session.dirty ? "Save now (changes also save by themselves)" : "Everything is saved";
      var shown = !!session.loadedFor && session.features.length > 0;
      var ready = shown && session.status === "ready" && !session.dirty;
      el.draft.textContent = !shown ? "" : ready ? "Ready" : "Draft";
      el.draft.title = ready ? "Ready - the mapper uses this" : "Draft - the mapper ignores this until it is marked ready";
      el.draft.classList.toggle("isReady", ready);
    }

    /* Saves what is on screen. If anything changed while the save was in flight, the local
       shapes win and another save follows; only a save of the current revision adopts the
       server's normalised copy. Finishes even if the page is left mid-save. */
    function saveOverlay() {
      var id = session.loadedFor;
      if (!id || !session.dirty) { renderSaveState(); return Promise.resolve(); }
      if (session.saving) { session.saveAgain = true; return session.savePromise; }
      var sentRev = session.rev;
      session.saving = true;
      renderSaveState();
      session.savePromise = api("POST", "", { courseId: id, features: session.features }).then(function (data) {
        session.saveError = "";
        if (session.loadedFor !== id) return;
        /* Every save is a draft again: a changed shape has not been signed off. */
        session.status = (data && data.overlay && data.overlay.status) || "draft";
        if (session.rev === sentRev) {
          session.dirty = false;
          if (!drag) session.features = (data && data.overlay && data.overlay.features) || [];
          if (!destroyed && !drag) { if (selectedId && !findFeature(selectedId)) selectedId = ""; drawFeatures(); }
        }
        if (!destroyed && data && data.dropped) setStatus(data.dropped + " shape" + (data.dropped === 1 ? " was" : "s were") + " too small to keep and dropped.", true);
      }).catch(function (error) {
        session.saveError = String(error && error.message || error);
        if (!destroyed) scheduleSave(SAVE_RETRY_MS);
      }).then(function () {
        session.saving = false;
        remember();
        var again = session.saveAgain || (session.dirty && session.rev !== sentRev);
        session.saveAgain = false;
        if (!destroyed) { renderSaveState(); updateActions(); }
        /* The promise settles once the follow-up save has too, so a caller waiting on it (the
           AI scan, leaving the page) sees the last change saved, not the one before it. */
        if (again && session.loadedFor === id) return saveOverlay();
      });
      return session.savePromise;
    }

    function flushSave() {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      return session.dirty ? saveOverlay() : Promise.resolve();
    }

    /* Draft -> ready: the one step that lets the mapper read this overlay. Saves first, so what
       is marked is what is on screen. */
    function markReady() {
      var id = session.loadedFor;
      if (!canEdit() || !session.features.length) return Promise.resolve(false);
      busy = true; updateActions();
      setStatus("Saving, then marking ready…");
      return flushSave().then(function () {
        if (session.dirty) throw new Error("the overlay did not save (" + (session.saveError || "unknown") + ")");
        return api("POST", "", { courseId: id, status: "ready" });
      }).then(function (data) {
        if (session.loadedFor !== id) return false;
        session.status = (data && data.status) || "ready";
        if (!destroyed) setStatus("Marked ready. The next mapper run will use these " + session.features.length + " shapes.");
        return true;
      }).catch(function (error) {
        if (!destroyed) setStatus("Not marked ready: " + (error && error.message || error), true);
        return false;
      }).then(function (ok) {
        busy = false;
        if (!destroyed) { updateActions(); drawFeatures(); }
        return ok;
      });
    }

    function deleteOverlay() {
      if (!canEdit()) return;
      if (!window.confirm("Delete every overlay shape for this course? The mapper will go back to reading OSM alone.")) return;
      session.features = [];
      selectedId = "";
      adjust = null;
      cancelDraft();
      drawFeatures();
      changed();
      flushSave();
    }

    /* ---- what OSM has here ---- */

    function clearOsmLayers() {
      osmLayers.forEach(function (l) { try { mapObj.removeLayer(l); } catch (e) {} });
      osmLayers = [];
    }

    function drawOsm() {
      clearOsmLayers();
      var osm = session.osm;
      if (!osm || !session.showOsm) return;
      function add(list, style, closed) {
        (list || []).forEach(function (item) {
          var latlngs = (item.points || []).map(function (p) { return [p.lat, p.lng]; });
          if (latlngs.length < 2) return;
          var shape = closed && latlngs.length >= 3 ? L.polygon(latlngs, Object.assign({ interactive: false }, style)) : L.polyline(latlngs, Object.assign({ interactive: false }, style));
          shape.addTo(mapObj);
          if (item.ref) shape.bindTooltip(String(item.ref), { permanent: true, direction: "center", className: "gdStudioOverlayLabel isOsm" });
          osmLayers.push(shape);
        });
      }
      add(osm.fairways, STYLE.osmFairway, true);
      add(osm.greens, STYLE.osmGreen, true);
      add(osm.tees, STYLE.osmTee, true);
      add(osm.bunkers, STYLE.osmBunker, true);
      add(osm.water, STYLE.osmWater, true);
      add(osm.holes, STYLE.osmHole, false);
      /* OSM sits under the overlay, so a placed shape is never hidden behind what OSM has. */
      osmLayers.forEach(function (l) { try { l.bringToBack(); } catch (e) {} });
    }

    /* ---- what the course already has saved ----
       Reference only, like OSM: drawn under everything, never clickable, never copied into the
       overlay. A failed run writes no objects, so these are what an earlier run left. */

    function clearObjectLayers() {
      objectLayers.forEach(function (l) { try { mapObj.removeLayer(l); } catch (e) {} });
      objectLayers = [];
    }

    function drawObjects() {
      clearObjectLayers();
      if (!session.showObjects) return;
      (session.objects || []).forEach(function (o) {
        var shape = o.points && o.points.length >= 3
          ? L.polygon(toLatLngs(o.points), Object.assign({ interactive: false }, STYLE.object))
          : o.point ? L.circleMarker([o.point.lat, o.point.lng], Object.assign({ interactive: false }, STYLE.objectPoint)) : null;
        if (!shape) return;
        shape.addTo(mapObj);
        if (o.hole && (o.type === "green" || o.type === "tee")) shape.bindTooltip(String(o.hole), { permanent: true, direction: "center", className: "gdStudioOverlayLabel isObject" });
        objectLayers.push(shape);
      });
      objectLayers.forEach(function (l) { try { l.bringToBack(); } catch (e) {} });
    }

    /* The last mapper run, above the map: why it failed and what it found. */
    function renderLastRun() {
      var run = session.lastRun;
      var box = el["last-run"];
      box.classList.toggle("isFailed", !!run && run.status === "failed");
      if (!run) { box.innerHTML = ""; return; }
      var found = run.osmFeatures;
      var bits = ["Last mapper run: <strong>" + esc(run.status) + "</strong>" + (run.kind ? " (" + esc(run.kind) + ")" : "") +
        (run.finishedAt ? " · " + esc(new Date(run.finishedAt).toLocaleString()) : "")];
      if (found) bits.push("found in OSM: " + [["greens", "greens"], ["fairways", "fairways"], ["tees", "tees"], ["bunkers", "bunkers"], ["holes", "hole lines"]].map(function (k) { return (found[k[0]] || 0) + " " + k[1]; }).join(", "));
      if (run.overlay && run.overlay.draft) bits.push("the overlay was a draft, so the run ignored it");
      var html = bits.join(" · ");
      if (run.status === "failed" && run.error) html += '<br><span class="gdStudioWarnText">' + esc(run.error) + "</span>";
      var scorecard = run.scorecardResolve;
      if (scorecard) {
        var facility = scorecard.facility || {};
        var loops = (facility.loops || []).map(function (loop) { return loop.name; }).filter(Boolean);
        if (scorecard.cards) {
          html += '<br><span class="gdStudioOkText">Scorecard matched: ' + esc((scorecard.trace && (scorecard.trace.canonicalCourseName || scorecard.trace.originalCourseName)) || "course")
            + (facility.holeCount ? " · " + esc(facility.holeCount) + " holes" : "")
            + (loops.length ? " · " + esc(loops.join(" / ")) : "") + "</span>";
        } else {
          html += '<br><span class="gdStudioWarnText">Scorecard not resolved</span>';
        }
        /* Which route the resolver took: the HTML tables, or the picture fallback
           and how far it got. */
        var STAGE_LABELS = {
          "html-resolved": "read from page HTML",
          "html-extraction-failed": "HTML extraction failed",
          "scorecard-image-found": "scorecard image found",
          "visual-extraction-failed": "visual extraction failed",
          "visual-scorecard-resolved": "visual scorecard resolved"
        };
        var stages = (scorecard.stages || []).map(function (stage) { return STAGE_LABELS[stage] || stage; });
        if (stages.length) html += '<br><span>Scorecard route: ' + esc(stages.join(" → ")) + "</span>";
        var visual = scorecard.visual;
        if (visual && visual.status && visual.status !== "unavailable") {
          var accepted = (visual.accepted || [])[0];
          html += '<br><span>' + (accepted
            ? "Visual card: " + esc(accepted.holes) + " holes, confidence " + esc(Math.round(accepted.confidence * 100)) + "% (" + esc((accepted.layout || []).length > 2 ? "hole graphics" : (accepted.layout || []).join(" + ")) + ")"
            : "Visual: " + esc(visual.status) + ((visual.rejected || [])[0] ? " — " + esc(visual.rejected[0].reason) : "")) + "</span>";
          if (visual.imageSearch) {
            html += '<br><span>Image search "' + esc(visual.imageSearch.query) + '": ' + esc(visual.imageSearch.results) + " results, "
              + esc((visual.imageSearch.kept || []).length) + " kept" + (visual.imageSearch.error ? " — " + esc(visual.imageSearch.error) : "") + "</span>";
          }
        } else if (visual && visual.status === "unavailable") {
          html += '<br><span>Visual fallback unavailable (no vision key)</span>';
        }
        var trace = scorecard.trace || {};
        var candidates = trace.candidates || [];
        var attempts = scorecard.attempts || [];
        html += '<details class="gdStudioScorecardTrace"><summary>Scorecard search details</summary>'
          + '<div><strong>Original:</strong> ' + esc(trace.originalCourseName || "—") + "</div>"
          + '<div><strong>Aliases:</strong> ' + esc((trace.aliases || []).join(" · ") || "—") + "</div>"
          + '<div><strong>Transliterations:</strong> ' + esc((trace.transliterations || []).join(" · ") || "—") + "</div>"
          + '<div><strong>Location:</strong> ' + esc([trace.location && trace.location.city, trace.location && trace.location.region, trace.location && trace.location.country].filter(Boolean).join(", ") || "—") + "</div>"
          + '<div><strong>Queries:</strong><ol>' + (trace.queries || []).map(function (query) {
            return "<li>" + esc(query.query || query) + (query.error ? " — " + esc(query.error) : "") + "</li>";
          }).join("") + "</ol></div>"
          + '<div><strong>Domains:</strong> ' + esc((trace.domainsDiscovered || []).join(" · ") || "—") + "</div>"
          + '<div><strong>Candidates:</strong><ol>' + candidates.map(function (candidate) {
            return "<li>" + esc(candidate.url) + " — " + esc(candidate.score) + " (" + esc((candidate.reasons || []).join(", ")) + ")</li>";
          }).join("") + "</ol></div>"
          + '<div><strong>Page decisions:</strong><ol>' + attempts.map(function (attempt) {
            return "<li>" + esc(attempt.url) + " — scorecard " + esc(attempt.scorecardConfidence || 0)
              + (attempt.usable ? " — accepted" : " — rejected: " + esc(attempt.rejected || attempt.reason || (attempt.stage ? STAGE_LABELS[attempt.stage] : "no readable structure"))) + "</li>";
          }).join("") + "</ol></div>"
          + (visual && (visual.images || []).length ? '<div><strong>Scorecard images:</strong><ol>' + visual.images.map(function (image) {
            return "<li>" + esc(image.url) + " — " + esc(image.kind) + (image.hole ? " " + esc(image.hole) : "") + "</li>";
          }).join("") + "</ol></div>" : "")
          + (visual && (visual.rejected || []).length ? '<div><strong>Visual rejections:</strong><ol>' + visual.rejected.map(function (entry) {
            return "<li>" + esc(entry.url) + " — " + esc(entry.reason) + "</li>";
          }).join("") + "</ol></div>" : "")
          + "</details>";
      }
      box.innerHTML = html;
    }

    /* ---- readouts ---- */

    function setStatus(text, warn) {
      el.status.innerHTML = warn ? '<span class="gdStudioWarnText">' + esc(text) + "</span>" : esc(text);
    }

    function updateHint() {
      if (destroyed) return;
      var text = "";
      if (!session.course) text = "Pick a course to start";
      else if (scanning) text = "AI scan running - shapes are locked until it finishes";
      else if (tool === "connect") text = connectFrom ? "Now tap the shape to link it to" : "Drag from one shape to another to put them on the same hole · or tap one, then the other · drag onto empty ground to unlink";
      else if (tool === "fairway" && session.mode === "pins") text = draft.length ? "Click where the fairway ends · Esc cancels" : "Click where the fairway starts";
      else if (tool === "fairway") text = draft.length ? (draft.length >= 2 ? "Keep clicking along the fairway · Finish (or Enter / double-click) when done" : "Click the next point along the fairway") : "Click at the tee end of the fairway, then along its middle";
      else if (tool === "green" && session.mode === "pins") text = "Click the middle of each green - the wand outlines it";
      else if (tool !== "move" && session.mode === "pins") text = "Click the middle of each " + kindLabel(tool).toLowerCase() + " to pin it";
      else if (waterDrawing()) text = "Press and drag all the way round the water · W switches to the wand";
      else if (tool === "water") text = "Click the middle of the water - the wand outlines it · W switches to drawing round it";
      else if (tool === "green") text = "Click the middle of a green";
      else if (tool === "bunker") text = "Click the middle of a bunker";
      else if (tool === "tee") text = "Click where the tee is";
      if (lastPlacedId && tool !== "move" && tool !== "connect" && !draft.length && findFeature(lastPlacedId)) text += " · drag the one you just placed to adjust it";
      else if (selectedId && isSmooth(findFeature(selectedId) || {})) text = "Drag to move · drag its " + shapes.SMOOTH[findFeature(selectedId).kind].handles + " points to reshape · Delete or the bin removes it";
      else if (selectedId && (findFeature(selectedId) || {}).pin) text = "Drag to move · Shape this pin turns it into an outline · Delete or the bin removes it";
      else if (selectedId && !bigEnoughForHandles(findFeature(selectedId) || { points: [] })) text = "Drag to move · zoom in to reshape its corners · Delete or the bin removes it";
      else if (selectedId) text = "Drag to move · drag corners to reshape · faint dots add a corner · right-click a corner or drag it to the bin to remove it · Delete or the bin removes the shape";
      else text = "Choose Fairway, Green, Tee or Bunker to place · click a shape in Move to adjust it · Link puts shapes on one hole";
      if (adjusted()) text = adjustHint();
      if (wandsRunning) text = "Finding the edge… · " + text;
      el.hint.textContent = text;
    }

    function adjustHint() {
      var bits = [];
      if (adjust.candidates.length > 1) bits.push("← → sensitivity " + (adjust.index + 1) + " of " + adjust.candidates.length);
      if (adjust.kind === "fairway" && adjust.line) bits.push("↑ ↓ narrower / wider (" + session.fairwayWidth + "m)");
      else if (adjust.seed) bits.push("↑ ↓ wand size (" + pct(adjust.size) + ")");
      else bits.push("↑ ↓ smaller / bigger");
      bits.push("Enter or Space keeps it · Esc removes it");
      return bits.join(" · ");
    }

    function updateReadout() {
      if (destroyed || !mapObj) return;
      var bits = [];
      var here = centre();
      if (here) bits.push("centre " + here.lat.toFixed(6) + ", " + here.lng.toFixed(6));
      bits.push("z" + mapObj.getZoom());
      var native = layer ? num(layer.options.maxNativeZoom) : null;
      if (native != null && mapObj.getZoom() > native) bits.push("imagery stops at z" + native + " here - blown up past it");
      if (session.course) {
        var count = function (kind) { return session.features.filter(function (f) { return f.kind === kind; }).length; };
        var holes = count("hole");
        var water = count("water");
        bits.push("placed: " + count("fairway") + " fairways, " + count("green") + " greens, " + count("tee") + " tees, " + count("bunker") + " bunkers" + (water ? ", " + water + " water" : "") + (holes ? ", " + holes + " hole lines" : ""));
      }
      var osm = session.osm;
      if (osm && !osm.error) bits.push("OSM here: " + (osm.greens || []).length + " greens, " + (osm.fairways || []).length + " fairways, " + (osm.bunkers || []).length + " bunkers, " + (osm.water || []).length + " water, " + (osm.holes || []).length + " hole lines");
      if (session.objects && session.objects.length) bits.push("saved objects: " + session.objects.length);
      else if (osm && osm.error) bits.push("OSM: " + osm.error);
      el.readout.textContent = bits.join(" · ");
      session.view = here ? { lat: here.lat, lng: here.lng, zoom: mapObj.getZoom() } : session.view;
      remember();
    }

    function updateActions() {
      var has = !!session.course && !busy;
      el.ai.disabled = !has || scanning || !!draft.length;
      el.ai.title = draft.length ? "Finish or cancel the fairway you are placing first" : scanning ? "A scan is running" : "";
      el["source-test"].disabled = !has || scanning || sourceTesting;
      var sourceScan = el["source-panel"].querySelector('[data-gd-source-test="scan"]');
      if (sourceScan) sourceScan.disabled = scanning;
      el.clear.disabled = !canEdit() || !session.features.length;
      el.run.disabled = !has || session.dirty;
      el.run.title = session.dirty ? "Wait for the overlay to save - the mapper reads what is saved" : "";
      el.ready.disabled = !canEdit() || !session.features.length || (session.status === "ready" && !session.dirty);
      el.ready.title = session.status === "ready" && !session.dirty ? "Already ready - change a shape and it goes back to draft" : "Let the mapper use this overlay";
      ["tool-connect", "tool-fairway", "tool-green", "tool-tee", "tool-bunker", "tool-water"].forEach(function (name) { el[name].disabled = !canEdit() || !!shapingPins; });
      var pins = session.features.filter(function (f) { return f.pin; }).length;
      var selected = selectedId ? findFeature(selectedId) : null;
      el["shape-pins"].hidden = !pins;
      el["shape-pins"].disabled = !canEdit() || !!shapingPins;
      el["shape-pins"].textContent = shapingPins ? "Shaping pins…" : selected && selected.pin ? "Shape this pin" : "Shape pins (" + pins + ")";
      el["shape-pins"].title = "Turn " + (selected && selected.pin ? "this pin" : "every pin") + " into an outline: greens, bunkers and water through the wand, fairways and tees from their points";
      renderSaveState();
    }

    /* ---- course map: the club's schematic, stored on the course and sent to the AI as image 2 ---- */

    function renderCourseMapState() {
      var m = session.courseMap;
      el["course-map-state"].innerHTML = m
        ? esc((m.name || "course map") + " · " + (m.width || "?") + "×" + (m.height || "?") + " · sent to the AI as image 2 ") +
          '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="course-map-clear">remove</button>'
        : "no course map";
      var clear = el["course-map-state"].querySelector('[data-gd-overlay="course-map-clear"]');
      if (clear) clear.addEventListener("click", function () {
        if (!window.confirm("Remove the course map from this course?")) return;
        saveCourseMap(null);
      });
    }

    function uploadCourseMap(file) {
      if (!session.course) { setStatus("Pick a course first.", true); return; }
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          var scale = Math.min(1, COURSE_MAP_MAX_EDGE_PX / Math.max(img.width, img.height));
          var c = document.createElement("canvas");
          c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          var dataUrl = c.toDataURL("image/jpeg", 0.85);
          saveCourseMap({ data: dataUrl.replace(/^data:[^,]+,/, ""), mediaType: "image/jpeg", name: String(file.name || "").slice(0, 80), width: c.width, height: c.height });
        };
        img.onerror = function () { setStatus("That file is not an image the browser can read.", true); };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    }

    function saveCourseMap(courseMap) {
      var id = courseIdOf(session.course);
      if (!id) return;
      setStatus(courseMap ? "Saving course map…" : "Removing course map…");
      api("POST", "", { courseId: id, courseMap: courseMap }).then(function (data) {
        if (destroyed) return;
        session.courseMap = (data && data.courseMap) || null;
        renderCourseMapState();
        setStatus(session.courseMap ? "Course map saved - the next AI scan will see it." : "Course map removed.");
      }).catch(function (error) {
        if (destroyed) return;
        setStatus("Course map not saved: " + (error && error.message || error), true);
      });
    }

    /* ---- server ---- */

    function api(method, query, body, endpoint) {
      return accessToken().then(function (token) {
        if (!token) throw new Error("Sign in again - no session token");
        return fetch((endpoint || API) + (query || ""), {
          method: method,
          headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: "Bearer " + token },
          cache: "no-store",
          body: body ? JSON.stringify(body) : undefined
        });
      }).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          if (!res.ok) throw new Error((data && (data.detail || data.error)) || ("HTTP " + res.status));
          return data;
        });
      });
    }

    function loadOverlay(course) {
      var id = courseIdOf(course);
      if (!id) { setStatus("This course has no id to store an overlay under.", true); return; }
      busy = true; updateActions();
      setStatus("Loading overlay and OSM features…");
      api("GET", "?courseId=" + encodeURIComponent(id) + "&osm=1").then(function (data) {
        if (destroyed || courseIdOf(session.course) !== id) return;
        session.features = (data && data.overlay && data.overlay.features) || [];
        session.status = (data && data.overlay && data.overlay.status) || "draft";
        session.osm = (data && data.osm) || null;
        session.objects = (data && data.objects) || [];
        session.lastRun = (data && data.lastRun) || null;
        session.courseMap = (data && data.courseMap) || null;
        renderCourseMapState();
        renderLastRun();
        session.loadedFor = id;
        session.dirty = false;
        session.saveError = "";
        /* Shapes that had not saved when the page was last left go back on, and save. */
        var unsaved = session.unsaved;
        session.unsaved = null;
        var restored = !!(unsaved && unsaved.courseId === id);
        if (restored) { session.features = unsaved.features; session.dirty = true; session.rev++; }
        selectedId = "";
        busy = false;
        drawOsm();
        drawObjects();
        drawFeatures();
        renderHoleField();
        /* A scan started before the page was left (or from another tab) is picked back up. */
        var scan = data && data.aiScan;
        if (scan && (scan.status === "queued" || scan.status === "running") && !scanning) {
          var since = Date.parse(scan.requestedAt || "") || Date.now();
          if (Date.now() - since < AI_TIMEOUT_MS) { scanning = true; pollScan(id, since); }
        }
        var when = data && data.overlay && data.overlay.updatedAt ? " · saved " + new Date(data.overlay.updatedAt).toLocaleString() : "";
        if (restored) { scheduleSave(SAVE_DELAY_MS); setStatus("Put back the changes that had not saved last time - saving them now."); }
        else setStatus(session.features.length ? session.features.length + " saved shape" + (session.features.length === 1 ? "" : "s") + " (" + session.status + ")" + when : "Nothing placed on this course yet.");
      }).catch(function (error) {
        if (destroyed) return;
        setStatus("Could not load: " + (error && error.message || error), true);
      }).then(function () {
        busy = false;
        if (!destroyed) { updateActions(); updateReadout(); updateHint(); updateBin(); }
      });
    }

    function runMapper() {
      var id = courseIdOf(session.course);
      if (!id || busy || session.dirty) return;
      var name = session.course.name || session.course.courseName || id;
      /* A draft is not read by the mapper, so running "with this overlay" means marking it
         ready first - asked, never assumed. */
      if (session.features.length && session.status !== "ready") {
        if (!window.confirm("This overlay is still a draft, and the mapper ignores drafts.\n\nMark it ready and run the mapper on " + name + "?\n\nThis clears the course's existing geometry and resolves it again from OSM plus the overlay. Visuals are not touched.")) return;
        markReady().then(function (ok) { if (ok && !destroyed) queueMapper(id); });
        return;
      }
      if (!window.confirm("Run the mapper on " + name + (session.features.length ? " with this overlay" : "") + "?\n\nThis clears the course's existing geometry and resolves it again from OSM" + (session.features.length ? " plus the overlay" : "") + ". Visuals are not touched.")) return;
      queueMapper(id);
    }

    function queueMapper(id) {
      busy = true; updateActions();
      setStatus("Queueing mapper run…");
      accessToken().then(function (token) {
        return fetch(JOBS_API, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify({ courseId: id, kind: "remap" })
        });
      }).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          if (res.status === 403) throw new Error("Admin only");
          if (!res.ok) throw new Error((data && (data.detail || data.error)) || ("HTTP " + res.status));
          setStatus(data && data.deduped ? "A mapper run is already in progress - it will pick up the saved overlay." : "Mapper run queued. Watch it in Course Database → this course → Debug (Mapping Diagnostics).");
        });
      }).catch(function (error) {
        if (destroyed) return;
        setStatus("Could not queue the mapper: " + (error && error.message || error), true);
      }).then(function () { busy = false; if (!destroyed) { updateActions(); drawFeatures(); } });
    }

    /* ---- imagery capture ----
       Pictures are built from the mounted provider's own tiles, re-fetched with CORS so a
       canvas can read them (every source in GDMapSources sets crossOrigin for this reason).
       Tiles at one zoom, nothing resampled; the tile grid's top-left mercator pixel and that
       zoom ARE the georeference - the same playSurface shape a published frame carries, exact
       to the pixel. */
    /* Leaflet's template layers fill {z} from the zoom the MAP is showing (_getZoomForUrl
       reads _tileZoom), not from coords.z - so asking for a tile at any other zoom silently
       fetched the wrong ground. That is why the green wand only worked when the map happened
       to sit at its capture zoom. The layer's tile zoom is pointed at z for the one call. */
    function tileUrlAt(cx, cy, z) {
      var saved = layer._tileZoom;
      layer._tileZoom = z;
      try { return layer.getTileUrl({ x: cx, y: cy, z: z }); }
      finally { layer._tileZoom = saved; }
    }

    function stitchTiles(z, x0, y0, x1, y1) {
      var full = document.createElement("canvas");
      full.width = (x1 - x0 + 1) * 256; full.height = (y1 - y0 + 1) * 256;
      var ctx = full.getContext("2d");
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, full.width, full.height);
      var loads = [];
      var failed = 0;
      for (var ty = y0; ty <= y1; ty++) {
        for (var tx = x0; tx <= x1; tx++) {
          loads.push(new Promise(function (done) {
            var img = new Image();
            var cx = tx, cy = ty;
            img.crossOrigin = "anonymous";
            img.onload = function () { try { ctx.drawImage(img, (cx - x0) * 256, (cy - y0) * 256, 256, 256); } catch (e) { failed++; } done(); };
            img.onerror = function () { failed++; done(); };
            try { img.src = tileUrlAt(cx, cy, z); } catch (e) { failed++; done(); }
          }));
        }
      }
      return Promise.all(loads).then(function () { return { canvas: full, tiles: loads.length, failed: failed }; });
    }

    /* The picture the wand reads: a few tiles around a pin at the zoom nearest the kind's
       WAND_TARGET_MPP the provider really has, unscaled. */
    function captureAround(point, coarser, kind, size) {
      return new Promise(function (resolve, reject) {
        if (!mapObj || !layer || typeof layer.getTileUrl !== "function") return reject(new Error("this provider cannot be captured - switch provider"));
        var native = num(layer.options && layer.options.maxNativeZoom) || num(layer.options && layer.options.maxZoom) || 19;
        var mppZ0 = 156543.03392 * Math.cos(point.lat * Math.PI / 180);
        var z = Math.max(14, Math.min(native, Math.round(Math.log2(mppZ0 / WAND_TARGET_MPP[kind]))) - (coarser || 0));
        var mpp = mppZ0 / Math.pow(2, z);
        var half = Math.ceil(Math.sqrt(WAND_MAX_M2[kind] * (size || 1) * (size || 1) / Math.PI) / mpp * 1.6 + 24);
        var p = mapObj.project(L.latLng(point.lat, point.lng), z);
        var x0 = Math.floor((p.x - half) / 256), y0 = Math.floor((p.y - half) / 256);
        var x1 = Math.floor((p.x + half) / 256), y1 = Math.floor((p.y + half) / 256);
        stitchTiles(z, x0, y0, x1, y1).then(function (out) {
          /* A missing tile is a black square next to the green, and the wand reads its edge as
             the green's. Refuse rather than send it; the caller tries a coarser zoom. */
          if (out.failed) return reject(new Error(out.failed === out.tiles ? "no imagery loaded here" : out.failed + " of " + out.tiles + " tiles did not load"));
          var dataUrl;
          try { dataUrl = out.canvas.toDataURL("image/jpeg", 0.92); }
          catch (e) { return reject(new Error("this provider's tiles cannot be read back (no CORS) - switch provider")); }
          resolve({
            data: dataUrl.replace(/^data:[^,]+,/, ""),
            mediaType: "image/jpeg",
            georef: { playSurface: { originPx: { x: x0 * 256, y: y0 * 256 }, captureZoom: z, outputDimensions: { width: out.canvas.width, height: out.canvas.height } } }
          });
        });
      });
    }

    /* ---- AI scan: the current view, as the model will see it ----
       Tiles at the layer's effective zoom, then one downscale to the model's edge limit,
       folded into the zoom as a fraction, so the georef still describes the picture that is
       actually sent. */
    function captureView() {
      return new Promise(function (resolve, reject) {
        if (!mapObj || !layer || typeof layer.getTileUrl !== "function") return reject(new Error("no tile layer to capture"));
        var native = num(layer.options && layer.options.maxNativeZoom);
        var z = num(layer._tileZoom);
        if (z == null) z = Math.round(mapObj.getZoom());
        if (native && z > native) z = native;
        var bounds = mapObj.getBounds();
        var nw = mapObj.project(bounds.getNorthWest(), z), se = mapObj.project(bounds.getSouthEast(), z);
        var x0 = Math.floor(nw.x / 256), y0 = Math.floor(nw.y / 256);
        var x1 = Math.floor((se.x - 1) / 256), y1 = Math.floor((se.y - 1) / 256);
        var cols = x1 - x0 + 1, rows = y1 - y0 + 1;
        if (cols < 1 || rows < 1) return reject(new Error("nothing in view"));
        if (cols * rows > AI_MAX_TILES) return reject(new Error("too much ground in view (" + cols * rows + " tiles) - zoom in"));
        stitchTiles(z, x0, y0, x1, y1).then(function (stitched) {
          var full = stitched.canvas;
          if (stitched.failed === stitched.tiles) return reject(new Error("no tiles loaded for this view"));
          var scale = Math.min(1, AI_MAX_EDGE_PX / Math.max(full.width, full.height), Math.sqrt(AI_MAX_PIXELS / (full.width * full.height)));
          var out = full;
          if (scale < 1) {
            out = document.createElement("canvas");
            out.width = Math.round(full.width * scale); out.height = Math.round(full.height * scale);
            out.getContext("2d").drawImage(full, 0, 0, out.width, out.height);
            scale = out.width / full.width;
          }
          /* Pixel position in the SENT picture of a ground point: tile-grid origin, then scale. */
          function toPx(latlng) {
            var p = mapObj.project(latlng, z);
            return { x: (p.x - x0 * 256) * scale, y: (p.y - y0 * 256) * scale };
          }
          var anchors = drawAnchors(out, toPx);
          drawGrid(out, AI_GRID_PX);
          var dataUrl;
          try { dataUrl = out.toDataURL("image/jpeg", 0.88); }
          catch (e) { return reject(new Error("this provider's tiles cannot be read back (no CORS) - switch provider")); }
          resolve({
            data: dataUrl.replace(/^data:[^,]+,/, ""),
            mediaType: "image/jpeg",
            width: out.width, height: out.height, tiles: stitched.tiles, failed: stitched.failed,
            anchors: anchors, grid: AI_GRID_PX,
            bounds: L.latLngBounds(mapObj.unproject(L.point(x0 * 256, y0 * 256), z), mapObj.unproject(L.point((x1 + 1) * 256, (y1 + 1) * 256), z)),
            georef: {
              playSurface: {
                originPx: { x: x0 * 256 * scale, y: y0 * 256 * scale },
                captureZoom: z + Math.log2(scale),
                outputDimensions: { width: out.width, height: out.height }
              }
            }
          });
        });
      });
    }

    /* What the model is shown that is not ground: the greens OSM already has (bright outline,
       G1..), the shapes already recorded (thin white outline, S1..) and the pins (white-ringed
       dot or dashed line, P1..). Recorded shapes and pins carry their id, so the answer can
       name the one it replaces; which of them are in the picture decides the scan's job
       (gd-ai-scan-core scanJob). Only what is inside the picture is drawn or listed. */
    function drawAnchors(canvas, toPx) {
      var ctx = canvas.getContext("2d");
      var anchors = [];
      function pixels(points) { return points.map(function (p) { return toPx(L.latLng(p.lat, p.lng)); }); }
      function inside(px) { return px.some(function (p) { return p.x >= 0 && p.y >= 0 && p.x <= canvas.width && p.y <= canvas.height; }); }
      function centreOf(px) {
        return {
          x: Math.round(px.reduce(function (a, p) { return a + p.x; }, 0) / px.length),
          y: Math.round(px.reduce(function (a, p) { return a + p.y; }, 0) / px.length)
        };
      }
      function tag(label, c, colour) {
        ctx.font = "bold 14px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        var w = ctx.measureText(label).width + 8;
        ctx.fillStyle = "rgba(0,0,0,0.65)"; ctx.fillRect(c.x - w / 2, c.y - 9, w, 18);
        ctx.fillStyle = colour; ctx.fillText(label, c.x, c.y);
      }
      function path(px, close, width, dash, colour) {
        ctx.strokeStyle = colour; ctx.lineWidth = width; ctx.setLineDash(dash);
        ctx.beginPath();
        px.forEach(function (p, i) { if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
        if (close) ctx.closePath();
        ctx.stroke();
      }
      function dot(p) {
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = "#ff3df2"; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = "#ffffff"; ctx.stroke();
      }
      ctx.save();
      var osm = session.osm && !session.osm.error ? session.osm : null;
      ((osm && osm.greens) || []).forEach(function (g, i) {
        var px = pixels(g.points || []);
        if (px.length < 3 || !inside(px)) return;
        path(px, true, 3, [], "#39ff14");
        var c = centreOf(px);
        tag("G" + (i + 1), c, "#39ff14");
        anchors.push({ kind: "green", label: "G" + (i + 1), x: c.x, y: c.y, ref: g.ref || "" });
      });
      var shapeCount = 0, pinCount = 0;
      session.features.forEach(function (f) {
        var px = pixels(f.points);
        if (!px.length || !inside(px)) return;
        var label, c;
        if (f.pin) {
          label = "P" + (++pinCount);
          if (px.length > 1) path(px, false, 2, [8, 6], "#ffffff");
          px.forEach(dot);
          c = centreOf(px);
          tag(label, { x: c.x, y: c.y - 16 }, "#ffffff");
        } else {
          label = "S" + (++shapeCount);
          /* Thin, so the edge the model is asked to judge is not hidden under the line. */
          path(px, isPolygon(f.kind), 1.5, [], "#ffffff");
          c = centreOf(px);
          tag(label, c, "#ffffff");
        }
        anchors.push({ kind: f.kind, label: label, id: f.id, x: c.x, y: c.y, saved: true });
      });
      ctx.restore();
      return anchors;
    }

    function drawGrid(canvas, step) {
      var ctx = canvas.getContext("2d");
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 1;
      ctx.font = "bold 13px monospace"; ctx.textBaseline = "top";
      for (var x = 0; x < canvas.width; x += step) {
        ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, canvas.height); ctx.stroke();
        ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(x + 2, 1, 42, 15);
        ctx.fillStyle = "#ffe14d"; ctx.textAlign = "left"; ctx.fillText(String(x), x + 4, 2);
      }
      for (var y = 0; y < canvas.height; y += step) {
        ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(canvas.width, y + 0.5); ctx.stroke();
        ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(1, y + 2, 42, 15);
        ctx.fillStyle = "#ffe14d"; ctx.textAlign = "left"; ctx.fillText(String(y), 3, y + 3);
      }
      ctx.restore();
    }

    function stopScanPoll() {
      if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
      if (scanFrame) { try { mapObj.removeLayer(scanFrame); } catch (e) {} scanFrame = null; }
      scanning = false;
      if (!destroyed) { updateActions(); updateHint(); drawFeatures(); }
    }

    function describeScan(scan) {
      var s = scan.summary || {};
      if (scan.dryRun) {
        var from = scan.provenance && scan.provenance.imageryProvider ? " on " + scan.provenance.imageryProvider + " imagery" : "";
        return "AI dry run" + from + " - nothing saved: found " + (scan.found || 0) + " (" + (s.fairways || 0) + " fairways, " + (s.greens || 0) + " greens, " + (s.tees || 0) + " tees, " + (s.bunkers || 0) + " bunkers)" +
          (scan.dropped && scan.dropped.length ? " · " + scan.dropped.length + " dropped" : "") + (scan.notes ? " · model notes: " + scan.notes : "");
      }
      var job = scan.job === "refine" ? "AI refine pass: " : scan.job === "complete" ? "AI complete pass: " : "AI trace: ";
      var bits = [job + (scan.replaced || 0) + " shape" + (scan.replaced === 1 ? "" : "s") + " refitted or pins shaped, " + (scan.added || 0) + " added" +
        " · overlay now " + (scan.overlayTotal || 0) + " (" + (s.fairways || 0) + " fairways, " + (s.greens || 0) + " greens, " + (s.tees || 0) + " tees, " + (s.bunkers || 0) + " bunkers" + (s.pins ? ", " + s.pins + " pins left" : "") + ")"];
      if (scan.dropped && scan.dropped.length) bits.push(scan.dropped.length + " dropped: " + scan.dropped.map(function (d) { return d.reason; }).join("; "));
      if (scan.usage) bits.push((scan.usage.inputTokens || 0) + " in / " + (scan.usage.outputTokens || 0) + " out tokens");
      if (scan.notes) bits.push("model notes: " + scan.notes);
      return bits.join(" · ");
    }

    function pollScan(id, startedAt) {
      updateHint();
      scanTimer = setTimeout(function () {
        if (destroyed || courseIdOf(session.course) !== id) return stopScanPoll();
        api("GET", "?courseId=" + encodeURIComponent(id)).then(function (data) {
          if (destroyed || courseIdOf(session.course) !== id) return stopScanPoll();
          var scan = data && data.aiScan;
          var state = scan && scan.status;
          if (state === "done" || state === "failed") {
            if (state === "failed") { stopScanPoll(); setStatus("AI scan failed: " + (scan.error || "unknown"), true); return; }
            session.features = (data.overlay && data.overlay.features) || [];
            session.status = (data.overlay && data.overlay.status) || "draft";
            session.dirty = false;
            selectedId = "";
            adjust = null;
            stopScanPoll();
            setStatus(describeScan(scan), !!(scan.dropped && scan.dropped.length));
            if (scan.dryRun) drawDryRun(scan);
            return;
          }
          if (Date.now() - startedAt > AI_TIMEOUT_MS) { stopScanPoll(); setStatus("AI scan is taking too long - pick the course again to check on it", true); return; }
          setStatus("AI scan " + (state || "queued") + "… " + Math.round((Date.now() - startedAt) / 1000) + "s");
          pollScan(id, startedAt);
        }).catch(function (error) {
          stopScanPoll();
          setStatus("Lost track of the scan: " + (error && error.message || error), true);
        });
      }, AI_POLL_MS);
    }

    function scanWithAi() {
      var id = courseIdOf(session.course);
      if (!id || scanning || draft.length) return;
      scanning = true;
      selectedId = "";
      setTool("move");
      drawFeatures();
      updateActions();
      /* The scan appends to what is SAVED, so anything still waiting to save goes first. */
      setStatus("Saving, then capturing the view…");
      flushSave().then(function () {
        if (session.dirty) throw new Error("the overlay did not save (" + (session.saveError || "unknown") + ")");
        return captureView();
      }).then(function (capture) {
        var recorded = capture.anchors.filter(function (a) { return a.saved; });
        var pins = recorded.filter(function (a) { return /^P/.test(a.label); }).length;
        var job = pins ? "complete pass - shaping " + pins + " pin" + (pins === 1 ? "" : "s") + " and filling in the rest"
          : recorded.length ? "refine pass - fitting the " + recorded.length + " shape" + (recorded.length === 1 ? "" : "s") + " in view"
          : "full trace";
        setStatus("Sending " + capture.width + "×" + capture.height + " px (" + capture.tiles + " tiles" + (capture.failed ? ", " + capture.failed + " missing" : "") + "), " + job + "…");
        scanFrame = L.rectangle(capture.bounds, { color: "#ffb54c", weight: 1, dashArray: "6 6", fill: false, interactive: false }).addTo(mapObj);
        return api("POST", "", { courseId: id, image: { data: capture.data, mediaType: capture.mediaType }, georef: capture.georef, anchors: capture.anchors, grid: capture.grid }, AI_API);
      }).then(function (data) {
        if (destroyed) return;
        setStatus("AI scan queued (" + Math.round(((data && data.georef && data.georef.metresPerPixel) || 0) * 100) / 100 + " m/px). Waiting for the model…");
        pollScan(id, Date.now());
      }).catch(function (error) {
        stopScanPoll();
        setStatus("AI scan not started: " + (error && error.message || error), true);
      });
    }

    /* ---- map source test (dev) ----
       The view's bounds go to the server, which fetches them from the forced source and sends
       back the picture, its georef and the terrain read. The picture is already sized to the AI
       scan's limits; the only thing added here is the same coordinate grid captureView burns
       in, so the dry-run scan reads it exactly as it reads a normal capture. No anchors: the
       scan is a trace from scratch, which is the honest test of what the imagery shows. */
    function fmt(v, unit) { return v == null ? "–" : String(v) + (unit || ""); }

    function renderSourceTest() {
      var t = sourceTest;
      var panel = el["source-panel"];
      if (!t) { panel.hidden = true; panel.innerHTML = ""; return; }
      panel.hidden = false;
      var im = t.imagery || {}, te = t.terrain || {};
      function failed(part) { return '<span class="gdStudioWarnText">' + esc((part.error && (part.error.code + ": " + part.error.message)) || "failed") + "</span>"; }
      var rb = t.requestedBounds || {};
      var rows = [
        ["Course", esc(t.course.name || t.course.id) + " · " + t.course.lat.toFixed(5) + ", " + t.course.lng.toFixed(5)],
        ["Requested bounds", [rb.north, rb.south, rb.west, rb.east].map(function (v) { return Number(v).toFixed(5); }).join(" / ") + " (N/S/W/E)"],
        ["Imagery", im.ok ? esc(im.label) + " · " + esc(im.product) + (im.storable ? "" : ' · <strong>not storable - test only</strong>') : failed(im)],
        ["", im.ok ? "zoom " + im.zoom + " @" + im.pixelRatio + "x · " + im.tilesRequested + " tiles · " + im.width + "×" + im.height + " px · " + fmt(im.metresPerPixel, " m/px") : ""],
        ["Terrain", te.ok ? esc(te.label) + " · " + esc(te.product) + (te.storable ? "" : ' · <strong>not storable - test only</strong>') : failed(te)],
        ["", te.ok ? "zoom " + te.zoom + " · " + te.tilesRequested + " tiles · " + te.width + "×" + te.height + " samples · " + fmt(te.metresPerSample, " m/sample") +
          " · " + fmt(te.minElevation, "m") + " – " + fmt(te.maxElevation, "m") + " · centre " + fmt(te.centre && te.centre.elevation, "m") + " · course pin " + fmt(te.courseLocationElevation, "m") + " · largest neighbour step " + fmt(te.maxNeighbourStep, "m") : ""]
      ].filter(function (r) { return r[1]; });
      panel.innerHTML =
        '<table class="gdStudioSourceTestTable">' + rows.map(function (r) { return "<tr><th>" + esc(r[0]) + "</th><td>" + r[1] + "</td></tr>"; }).join("") + "</table>" +
        '<div class="gdStudioViewportBar">' +
        (im.ok ? '<button type="button" class="gdStudioDiagramBtn" data-gd-source-test="scan">AI scan this picture (dry run)</button>' : "") +
        '<button type="button" class="gdStudioDiagramBtn" data-gd-source-test="close">Close</button>' +
        '<span class="gdStudioViewportField">' + esc([im.ok ? im.attribution : "", te.ok && te.attribution !== im.attribution ? te.attribution : ""].filter(Boolean).join(" · ")) + "</span>" +
        "</div>" +
        '<div class="gdStudioSourceTestImages">' +
        (im.ok ? '<figure><div class="gdStudioSourceTestFrame"><img alt="Source imagery" src="data:' + im.image.mediaType + ";base64," + im.image.data + '"><svg data-gd-source-test="shapes" viewBox="0 0 ' + im.width + " " + im.height + '" preserveAspectRatio="none"></svg></div><figcaption>Source imagery · AI dry-run shapes drawn over it when a scan finishes</figcaption></figure>' : "") +
        (te.ok && te.preview ? '<figure><img alt="Terrain" src="data:' + te.preview.mediaType + ";base64," + te.preview.data + '"><figcaption>Terrain (hillshade of the decoded heights, 3× exaggerated)</figcaption></figure>' : "") +
        "</div>";
      var scanBtn = panel.querySelector('[data-gd-source-test="scan"]');
      if (scanBtn) { scanBtn.disabled = scanning; scanBtn.addEventListener("click", scanSourceTest); }
      panel.querySelector('[data-gd-source-test="close"]').addEventListener("click", function () { sourceTest = null; renderSourceTest(); });
    }

    function runSourceTest() {
      var id = courseIdOf(session.course);
      if (!id || !mapObj || sourceTesting) return;
      var b = mapObj.getBounds();
      sourceTesting = true; updateActions();
      setStatus("Fetching this view from Mapbox Satellite and Mapbox Terrain…");
      api("POST", "", {
        courseId: id, imagery: "mapbox", terrain: "mapbox",
        bounds: { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() }
      }, SOURCE_TEST_API).then(function (data) {
        if (destroyed) return;
        sourceTest = data;
        renderSourceTest();
        var im = data.imagery || {}, te = data.terrain || {};
        setStatus("Source test: imagery " + (im.ok ? "ok" : "failed (" + (im.error && im.error.code) + ")") + ", terrain " + (te.ok ? "ok" : "failed (" + (te.error && te.error.code) + ")"), !(im.ok && te.ok));
      }).catch(function (error) {
        if (destroyed) return;
        setStatus("Source test failed: " + (error && error.message || error), true);
      }).then(function () { sourceTesting = false; if (!destroyed) updateActions(); });
    }

    function scanSourceTest() {
      var id = courseIdOf(session.course);
      var im = sourceTest && sourceTest.imagery;
      if (!id || !im || !im.ok || scanning) return;
      scanning = true; updateActions();
      setStatus("Preparing the Mapbox picture for a dry-run scan…");
      new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = function () { reject(new Error("the picture did not decode")); };
        img.src = "data:" + im.image.mediaType + ";base64," + im.image.data;
      }).then(function (img) {
        var canvas = document.createElement("canvas");
        canvas.width = im.width; canvas.height = im.height;
        canvas.getContext("2d").drawImage(img, 0, 0, im.width, im.height);
        drawGrid(canvas, AI_GRID_PX);
        var data = canvas.toDataURL("image/jpeg", 0.88).replace(/^data:[^,]+,/, "");
        return api("POST", "", { courseId: id, image: { data: data, mediaType: "image/jpeg" }, georef: im.georef, anchors: [], grid: AI_GRID_PX, dryRun: true, provenance: sourceTest.provenance }, AI_API);
      }).then(function (data) {
        if (destroyed) return;
        setStatus("AI dry run queued (" + Math.round(((data && data.georef && data.georef.metresPerPixel) || 0) * 100) / 100 + " m/px). Waiting for the model…");
        pollScan(id, Date.now());
      }).catch(function (error) {
        stopScanPoll();
        setStatus("AI dry run not started: " + (error && error.message || error), true);
      });
    }

    /* The dry run's shapes, over the picture they were read from, in that picture's pixels. */
    function drawDryRun(scan) {
      var svg = el["source-panel"].querySelector('[data-gd-source-test="shapes"]');
      if (!svg) return;
      var colour = { fairway: "#7CFC00", green: "#00e5ff", tee: "#ffffff", bunker: "#ffe14d", hole: "#ff6ad5" };
      svg.innerHTML = (scan.pixels || []).map(function (f) {
        var pts = (f.pixels || []).map(function (p) { return Math.round(p.x) + "," + Math.round(p.y); }).join(" ");
        var tag = f.kind === "hole" ? "polyline" : "polygon";
        return "<" + tag + ' points="' + pts + '" fill="none" stroke="' + (colour[f.kind] || "#fff") + '" stroke-width="3" vector-effect="non-scaling-stroke"></' + tag + ">";
      }).join("");
    }

    /* ---- course ---- */

    function showCourse(course, opts) {
      var restoring = !!(opts && opts.restoring);
      session.course = course;
      var point = courseLatLng(course);
      el.course.textContent = String(course && (course.name || course.courseName) || "Course");
      el.course.title = point ? point[0].toFixed(5) + ", " + point[1].toFixed(5) : "No coordinates";
      remember();
      if (!point) { setStatus("This course has no coordinates - set its location first.", true); return; }
      if (!restoring) {
        mapObj.setView(point, 16);
        useSource(bestSourceKey());
      }
      var id = courseIdOf(course);
      if (restoring && session.loadedFor === id) {
        drawOsm();
        drawObjects();
        renderLastRun();
        renderHoleField();
        drawFeatures();
        updateActions();
        updateHint();
        if (session.dirty && !session.saving) scheduleSave(SAVE_DELAY_MS);
        return;
      }
      if (session.loadedFor !== id) {
        forgetCourse();
        sourceTest = null;
        renderSourceTest();
        selectedId = "";
        adjust = null;
        clearOsmLayers();
        clearObjectLayers();
        clearFeatureLayers();
        renderLastRun();
        renderHoleField();
      }
      loadOverlay(course);
    }

    function remeasure() {
      setTimeout(function () { if (!destroyed && mapObj) { try { mapObj.invalidateSize(); } catch (e) {} } }, 60);
    }

    function pickCourse() {
      if (session.saveError && session.dirty && !window.confirm("The last change has not saved (" + session.saveError + "). Pick another course and lose it?")) return;
      flushSave();
      var pick = window.GDStudioCoursePick;
      var opened = pick && typeof pick.open === "function" && pick.open({
        source: "studio-map-overlay",
        onReturn: remeasure,
        onPick: function (course) { if (!destroyed) { cancelDraft(); setTool("move"); setMenu(false); showCourse(course); } }
      });
      if (!opened) setStatus("The course picker is not loaded on this surface.", true);
    }

    /* ---- boot ---- */

    mapObj = L.map(el.map, {
      zoomControl: false,
      attributionControl: false,
      doubleClickZoom: true,
      scrollWheelZoom: true,
      /* Quarter-step zoom so the wheel eases in rather than jumping a whole level, and a
         trackpad pinch lands where it stops. */
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      wheelPxPerZoomLevel: 90,
      wheelDebounceTime: 20,
      maxZoom: 22
    }).setView([0, 0], 2);

    buildProviderOptions();
    useSource(session.sourceKey || bestSourceKey());

    mapObj.on("click", function (e) { handleMapClick(e.latlng); });
    mapObj.on("dblclick", function (e) {
      if (e && e.originalEvent) L.DomEvent.stop(e.originalEvent);
      if (tool === "fairway") finishFairway();
    });
    mapObj.on("mousemove", function (e) {
      if (tool !== "fairway" || !draft.length) return;
      cursorLatLng = { lat: e.latlng.lat, lng: e.latlng.lng };
      drawDraft();
    });
    mapObj.on("mouseout", function () { if (cursorLatLng) { cursorLatLng = null; drawDraft(); } });
    mapObj.on("moveend zoomend", function () { buildProviderOptions(); updateReadout(); });
    mapObj.on("zoomend", function () { if (selectedId && !drag) { drawFeatures(); updateHint(); } });

    /* Arrow keys pan and +/- zoom from anywhere on the page, not only once the map has focus
       (Leaflet's own keyboard handler covers that case, so it is left to it). */
    function navKey(event) {
      if (!mapObj || (event.target && el.map.contains(event.target))) return false;
      var step = 160;
      var pan = { ArrowUp: [0, -step], ArrowDown: [0, step], ArrowLeft: [-step, 0], ArrowRight: [step, 0] }[event.key];
      if (pan) { event.preventDefault(); mapObj.panBy(pan); return true; }
      if (event.key === "+" || event.key === "=") { event.preventDefault(); mapObj.zoomIn(0.5); return true; }
      if (event.key === "-" || event.key === "_") { event.preventDefault(); mapObj.zoomOut(0.5); return true; }
      return false;
    }

    function onKey(event) {
      var target = event.target;
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (!containerEl.isConnected) return;
      if (event.key === "Escape" && !el.menu.hidden) { event.preventDefault(); setMenu(false); return; }
      if (event.key === "Escape" && fullscreen && !draft.length && !selectedId && tool === "move") { event.preventDefault(); setFullscreen(false); return; }
      if (navKey(event)) return;
      if (draft.length) {
        if (event.key === "Enter") { event.preventDefault(); finishFairway(); }
        else if (event.key === "Escape") { event.preventDefault(); cancelDraft(); }
        else if (event.key === "Backspace") { event.preventDefault(); undoDraftPoint(); }
        return;
      }
      if (!session.course || !containerEl.isConnected) return;
      if ((event.key === "Delete" || event.key === "Backspace") && selectedId && canEdit() && !drag) {
        event.preventDefault();
        var f = findFeature(selectedId);
        removeFeature(selectedId);
        if (f) setStatus(kindLabel(f.kind) + " deleted.");
        return;
      }
      if (event.key === "Escape") { setTool("move"); if (selectedId) select(""); return; }
      var key = String(event.key || "").toLowerCase();
      if (key === "h") { fitCourse(); return; }
      if (key === "z") { zoomToSelected(); return; }
      if (key === "s" || key === "p") { setMode(key === "p" ? "pins" : "shapes"); return; }
      if (key === "[" || key === "]") { stepWandSize(key === "]" ? 1 : -1); return; }
      /* W again on the water tool switches between drawing round it and the wand. */
      if (key === "w" && tool === "water" && session.mode === "shapes" && canEdit()) { setWaterDraw(!session.waterDraw); return; }
      var shortcut = { v: "move", c: "connect", f: "fairway", g: "green", t: "tee", b: "bunker", w: "water" }[key];
      if (shortcut && (shortcut === "move" || canEdit())) setTool(shortcut);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("keydown", onAdjustKey, true);

    el.pick.addEventListener("click", pickCourse);
    el.provider.addEventListener("change", function () { useSource(el.provider.value); });
    el.osm.checked = session.showOsm;
    el.osm.addEventListener("change", function () { session.showOsm = el.osm.checked; drawOsm(); remember(); });
    el.objects.checked = session.showObjects;
    el.objects.addEventListener("change", function () { session.showObjects = el.objects.checked; drawObjects(); remember(); });
    el.ai.addEventListener("click", scanWithAi);
    el["source-test"].addEventListener("click", runSourceTest);
    el["tool-move"].addEventListener("click", function () { setTool("move"); });
    el["tool-connect"].addEventListener("click", function () { setTool("connect"); });
    el["tool-fairway"].addEventListener("click", function () { setTool("fairway"); });
    el["tool-green"].addEventListener("click", function () { setTool("green"); });
    el["tool-tee"].addEventListener("click", function () { setTool("tee"); });
    el["tool-bunker"].addEventListener("click", function () { setTool("bunker"); });
    el["tool-water"].addEventListener("click", function () { setTool("water"); });
    el["water-wand"].addEventListener("click", function () { setWaterDraw(false); });
    el["water-draw"].addEventListener("click", function () { setWaterDraw(true); });
    el.map.addEventListener("pointerdown", beginLasso);
    el.hole.addEventListener("change", holeFieldChanged);
    el.width.addEventListener("change", function () {
      var w = num(el.width.value);
      session.fairwayWidth = w && w >= 10 && w <= 90 ? w : shapes.FAIRWAY_WIDTH_M;
      el.width.value = session.fairwayWidth;
      drawDraft();
      remember();
    });
    el["mode-shapes"].addEventListener("click", function () { setMode("shapes"); });
    el["mode-pins"].addEventListener("click", function () { setMode("pins"); });
    el["wand-smaller"].addEventListener("click", function () { stepWandSize(-1); });
    el["wand-bigger"].addEventListener("click", function () { stepWandSize(1); });
    el.merge.checked = session.mergeBunkers;
    el.merge.addEventListener("change", function () { session.mergeBunkers = el.merge.checked; remember(); });
    el["shape-pins"].addEventListener("click", shapePins);
    el["draft-finish"].addEventListener("click", finishFairway);
    el["draft-undo"].addEventListener("click", undoDraftPoint);
    el["draft-cancel"].addEventListener("click", cancelDraft);
    el["menu-toggle"].addEventListener("click", function () { setMenu(el.menu.hidden); });
    /* Back to the map closes the pull-down. */
    el.stage.addEventListener("pointerdown", function () { if (!el.menu.hidden) setMenu(false); });
    el.save.addEventListener("click", function () {
      flushSave().then(function () {
        if (destroyed) return;
        setStatus(session.dirty ? "Not saved yet - " + (session.saveError || "try again") : "Saved.", !!session.dirty);
      });
    });
    el["zoom-in"].addEventListener("click", function () { mapObj.zoomIn(1); });
    el["zoom-out"].addEventListener("click", function () { mapObj.zoomOut(1); });
    el.fit.addEventListener("click", fitCourse);
    el["zoom-shape"].addEventListener("click", zoomToSelected);
    el.fullscreen.addEventListener("click", function () { setFullscreen(!fullscreen); });
    if (session.fullscreen) setFullscreen(true);
    /* Nothing to work on yet: open the pull-down, where the course is picked. */
    setMenu(!session.course);
    el.bin.addEventListener("click", function () {
      if (!selectedId || !canEdit()) { setStatus("Drag a shape or a corner onto the bin to delete it."); return; }
      var f = findFeature(selectedId);
      removeFeature(selectedId);
      if (f) setStatus(kindLabel(f.kind) + " deleted.");
    });
    el["course-map"].addEventListener("change", function () {
      var file = el["course-map"].files && el["course-map"].files[0];
      el["course-map"].value = "";
      if (file) uploadCourseMap(file);
    });
    el.clear.addEventListener("click", deleteOverlay);
    el.ready.addEventListener("click", markReady);
    el.run.addEventListener("click", runMapper);

    setMode(session.mode);
    renderWandSize();

    if (session.course) {
      var restoring = !!session.view;
      showCourse(session.course, { restoring: restoring });
      if (session.view) { try { mapObj.setView([session.view.lat, session.view.lng], session.view.zoom); } catch (e) {} }
      if (restoring) useSource(session.sourceKey || bestSourceKey());
    }
    updateActions();
    updateReadout();
    updateHint();
    updateBin();
    renderHoleField();
    remeasure();

    return function cleanup() {
      /* Whatever is waiting to save goes now - leaving the page must not lose the last drag. */
      flushSave();
      destroyed = true;
      if (scanTimer) clearTimeout(scanTimer);
      if (saveTimer) clearTimeout(saveTimer);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("keydown", onAdjustKey, true);
      document.removeEventListener("pointermove", onLassoMove);
      document.removeEventListener("pointerup", onLassoEnd);
      document.removeEventListener("pointercancel", onLassoEnd);
      document.documentElement.classList.remove("gdStudioOverlayNoScroll");
      containerEl.classList.remove("gdStudioOverlayHost");
      rememberNow();
      document.removeEventListener("pointermove", onConnectMove);
      document.removeEventListener("pointerup", onConnectEnd);
      document.removeEventListener("pointercancel", onConnectEnd);
      document.removeEventListener("pointermove", onDragMove);
      document.removeEventListener("pointerup", onDragEnd);
      document.removeEventListener("pointercancel", onDragEnd);
      if (window.GDStudioCoursePick) window.GDStudioCoursePick.cancel();
      if (window.GDStudioShell) window.GDStudioShell.show();
      if (mapObj) { try { mapObj.remove(); } catch (e) {} }
      mapObj = null;
      layer = null;
      draftLayers = [];
      featureLayers = {};
      osmLayers = [];
      objectLayers = [];
    };
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["map-overlay"] = render;

  /* The way in from Course Database - the "Draw" button on a course's row and the "Draw
     overlay" button in its location panel. Seeds the course and routes; the page's own render
     loads the overlay, what OSM has, the course's saved objects and the last mapper run, so a
     course opened from a failed row arrives with everything that run saw. Takes any object
     carrying a courseId, lat/lng and a name. */
  window.GDStudioMapOverlay = {
    open: function (course) {
      if (course && courseIdOf(course) !== courseIdOf(session.course)) forgetCourse();
      session.course = course || null;
      session.view = null;
      if (window.GDStudioRouter && typeof window.GDStudioRouter.go === "function") {
        return window.GDStudioRouter.go("map-overlay");
      }
      return false;
    }
  };
})();
