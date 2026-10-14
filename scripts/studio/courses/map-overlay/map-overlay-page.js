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
 * Play orders: where the mapper splits a site into courses wrongly or names them badly, the
 * courses are said by hand. "+ New play order", name it, and click its holes in the order they
 * are played - an OSM hole line, or a hole linked from overlay shapes. A hole can be in several
 * play orders. With play orders on a ready overlay the mapper publishes exactly those, one
 * course each, under the names given (functions/lib/gd-play-order-core.mjs).
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
  /* When the imagery in view was taken (functions/course-map-capture-date.mjs). */
  var CAPTURE_API = "/api/course-map-capture-date";
  /* Tree heights under a capture, for the tree finder near play (functions/course-map-canopy-height.mjs). */
  var CANOPY_API = "/api/course-map-canopy-height";
  /* The course's tree layer (functions/course-trees.mjs): what a tree run found, edited here and
     published to the watch. */
  var TREES_API = "/api/course-trees";
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
  /* Bunkers and water reach much further: a links waste bunker or a lake is many times the
     profile's size. gd-surface-refine-core WAND_SCALE.max allows it; captureAround coarsens the
     zoom so the picture stays a sensible size. */
  var WAND_SIZES_BIG = WAND_SIZES.concat([2.5, 3.2, 4, 5, 6]);
  function wandSizes(kind) { return kind === "bunker" || kind === "water" ? WAND_SIZES_BIG : WAND_SIZES; }
  /* captureAround stays under this many pixels a side; past it, one zoom coarser per doubling. */
  var WAND_CAPTURE_MAX_HALF_PX = 900;
  /* How each tool that has a choice places a shape. Wand: click the middle. Draw round: press
     and drag all the way round it. Line + wand: click a line down its middle, Finish, and the
     line wand (GDOverlayShapes.growFromLine) grows it out to the edge. Width: the fairway line
     made into a fairway of the set width. Round: a tee dropped as a round marker.
     Every tool has the colour wand too: press on it and drag, and everything connected of
     that colour is picked (see "the colour wand" below). */
  var METHODS = {
    fairway: ["width", "line", "colour"], green: ["wand", "colour"], tee: ["round", "colour"],
    bunker: ["wand", "draw", "line", "colour"], water: ["wand", "draw", "line", "colour"],
    /* Trees: one tree a click, a cluster stretched as an oval, a wood drawn round, the tree
       finder - a box dragged over ground with trees like the ones placed by hand - or the
       finder run along the edges of the fairways and greens with nothing placed first. */
    trees: ["single", "oval", "draw", "find", "auto", "colour"],
    /* Hazard (gorse, scrub, a ravine): drawn round by hand. */
    hazard: ["draw", "colour"],
    /* Waste area: drawn round roughly and grown out to its edge. */
    waste: ["grow", "colour"]
  };
  var METHOD_LABEL = { width: "Width", wand: "Wand", round: "Round", draw: "Draw round", line: "Line + wand", single: "Tree", oval: "Cluster", find: "Find trees", auto: "Near play", grow: "Draw + grow", colour: "Colour wand" };
  var METHOD_NAMES = ["width", "wand", "round", "draw", "line", "single", "oval", "find", "auto", "grow", "colour"];
  /* The line wand: how far from the line an edge may be at size 1 (metres), the picture's
     metres a pixel, and the size steps up / down take it through. */
  var LINE_WAND_REACH_M = { fairway: 35, bunker: 12, water: 50, waste: 25 };
  var LINE_WAND_MPP = { fairway: 0.4, bunker: 0.2, water: 0.5, waste: 0.4 };
  var LINE_WAND_SIZES = [0.4, 0.55, 0.7, 0.85, 1, 1.25, 1.6, 2, 2.5, 3.2, 4];
  var LINE_WAND_MAX_SIDE_PX = 2400;
  /* Up and down on the shape just placed: a fairway this many metres narrower or wider, a tee
     or a hand-drawn water hazard this much smaller or bigger, a press. */
  var FAIRWAY_WIDTH_STEP_M = 5;
  var SCALE_STEP = 1.12;
  /* ↑ ↓ on a green or a fairway: the outline grows or shrinks evenly, stepM a press, up to max
     presses either way (GDOverlayShapes.reshapeOutline). A fairway's presses first bridge the
     cut-ins along its edge (closeM) - an overhanging tree, a shadow, the wand stopping short -
     so its first ↑ only smooths, and each one after adds a metre. */
  var RESHAPE = { green: { stepM: 0.5, max: 16, closeM: 0 }, fairway: { stepM: 1, max: 12, closeM: 5 } };
  /* + Collar: the fringe round a finished green, found by growing out from COLLAR_M past its edge
     up to COLLAR_REACH_M further, then necked out to the hole's fairway at COLLAR_NECK_M wide. */
  var COLLAR_M = 2;
  var COLLAR_REACH_M = 3;
  var COLLAR_NECK_M = 8;
  var COLLAR_FAIRWAY_MAX_M = 120;
  /* With a linked tee, the neck heads for it: the fairway counts only within this cone either
     side of the line to the tee (cos 40°), and with no fairway there it runs this far past the
     green's edge towards the tee. */
  var COLLAR_TOWARD_TEE_COS = 0.766;
  var COLLAR_TOWARD_TEE_M = 12;
  /* The deepest zoom the map goes to. Past the provider's own imagery the last real tiles are
     blown up rather than requested (see watchImageryCeiling). */
  var DRAW_MAX_ZOOM = 22;
  /* A provider is not chased below this zoom when its tiles fail - a provider with nothing here
     at all is the provider list's problem, not a zoom ceiling. */
  var IMAGERY_CEILING_FLOOR_Z = 16;
  /* Autosave waits for a pause, so a burst of drags is one save. */
  var SAVE_DELAY_MS = 700;
  var SAVE_RETRY_MS = 6000;
  /* gd-map-overlay-core OVERLAY_MAX_POINTS - room for a wand outline that follows the ground. */
  var MAX_POINTS = 256;
  /* A grab on a detailed outline's edge bends it this far round the edge each way, in screen
     pixels - so zoomed in, the bend is finer. */
  var EDGE_BEND_PX = 45;
  /* Areas that meet along a seam (GDOverlayShapes.seamPair): a gap narrower than
     shapes.SEAM_GAP_M between two of them, or a thin overlap, closes in the middle and the line
     there is held by both. Greens, bunkers and tees sit on top of a fairway, not beside it,
     so they never seam. */
  var SEAM_KINDS = ["fairway", "water", "hazard", "waste", "trees"];
  /* gd-map-overlay-core OVERLAY_MAX_FEATURES and OVERLAY_MAX_TREES: single trees are counted
     apart from every other shape, against a cap of their own. */
  var MAX_FEATURES = 1200;
  var MAX_TREES = 3000;
  /* The tree finder reads the box at about this many metres a pixel (a crown ~25px across), up
     to this many pixels a side, and learns what a tree looks like from at most this many of the
     trees placed by hand this session - the latest ones. */
  var TREE_FINDER_MPP = 0.3;
  /* Near play reads every picture at about this, so one fairway's tiles serve the next shape's
     too, and a crown is still ~20px across. */
  var NEAR_PLAY_MPP = 0.45;
  var TREE_FINDER_MAX_SIDE_PX = 1400;
  var TREE_SAMPLE_MAX = 12;
  /* Near play, the band looked along each fairway and green can be set this wide, in metres. */
  var TREE_BAND_MIN_M = 10;
  var TREE_BAND_MAX_M = 120;
  /* The colour wand reads the view on screen, at most this many pixels a side; dragging this
     many screen pixels from the press adds one unit of colour tolerance. */
  var COLOUR_WAND_MAX_SIDE_PX = 1400;
  var COLOUR_WAND_TOL_START = 10;
  var COLOUR_WAND_TOL_PER_PX = 0.3;
  var COLOUR_WAND_TOL_MAX = 140;

  /* Survives leaving and re-entering the page - the shell tears the DOM down on every route
     change. The save state lives here too, so a save still in flight when the page is left
     lands on the same state the next render reads. */
  var session = {
    course: null, features: [], loadedFor: "", osm: null, objects: [], lastRun: null, courseMap: null, view: null, sourceKey: "",
    showOsm: true, showObjects: true, status: "draft", hole: null,
    /* What the mapper reads with this overlay: "include" - OSM and the overlay, as always - or
       "exclude" - the overlay alone (functions/course-map-overlay.mjs). Drawing a course
       entirely by hand, OSM is hidden here and kept out of the run. */
    osmMode: "include",
    /* Hand-built courses: [{id, name, courseId, holes: ["osm:way/N" | "link:ID"]}], and the one
       being edited. Saved with the shapes. */
    playOrders: [], activeOrder: "",
    /* A facility shares one overlay (functions/lib/gd-overlay-owner.mjs): the courses drawing on
       it, from the API, and the one being looked at. */
    facility: null, variant: "",
    /* The Number tool: the number the next hole clicked gets, and whether it then steps on. */
    numberNext: 1, numberAuto: true,
    dirty: false, rev: 0, saving: false, saveError: "", fairwayWidth: 0,
    mode: "shapes", wandSize: { green: 1, bunker: 1, water: 1 }, method: { fairway: "width", green: "wand", tee: "round", bunker: "wand", water: "wand", trees: "single", hazard: "draw", waste: "grow" }, lineWandSize: { fairway: 1, bunker: 1, water: 1, waste: 1 }, mergeBunkers: true, seams: true, fullscreen: false, unsaved: null,
    /* The size the next single tree is dropped at, and the tree finder's sensitivity. Near
       play: how far out from the fairways and greens it looks, and whether tree heights gate
       what it finds. */
    treeRadius: 0, treeFinderLevel: 2, treeBandM: 0, treeHeights: true,
    /* Trees placed by hand on this course this session: what the tree finder learns from. Not
       remembered past a reload - the imagery and the light it was taken in can change. */
    treeSamples: []
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
        wandSize: session.wandSize, method: session.method, lineWandSize: session.lineWandSize, mergeBunkers: session.mergeBunkers, seams: session.seams, fullscreen: !!session.fullscreen,
        treeRadius: session.treeRadius, treeFinderLevel: session.treeFinderLevel, treeBandM: session.treeBandM, treeHeights: session.treeHeights, numberAuto: session.numberAuto,
        unsaved: session.dirty && session.loadedFor ? { courseId: session.loadedFor, features: session.features, playOrders: session.playOrders } : null
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
    ["sourceKey", "showOsm", "showObjects", "mode", "fairwayWidth", "mergeBunkers", "seams", "fullscreen", "googleSplit", "treeRadius", "treeFinderLevel", "treeBandM", "treeHeights", "numberAuto"].forEach(function (k) {
      if (saved[k] != null) session[k] = saved[k];
    });
    if (saved.wandSize && typeof saved.wandSize === "object") {
      WAND_KINDS.forEach(function (kind) { if (wandSizes(kind).indexOf(saved.wandSize[kind]) >= 0) session.wandSize[kind] = saved.wandSize[kind]; });
    }
    /* waterDraw is the old single switch, from before bunkers and fairways had methods too. */
    if (saved.waterDraw) session.method.water = "draw";
    if (saved.method && typeof saved.method === "object") {
      Object.keys(METHODS).forEach(function (kind) { if (METHODS[kind].indexOf(saved.method[kind]) >= 0) session.method[kind] = saved.method[kind]; });
    }
    if (saved.lineWandSize && typeof saved.lineWandSize === "object") {
      Object.keys(session.lineWandSize).forEach(function (kind) { if (LINE_WAND_SIZES.indexOf(saved.lineWandSize[kind]) >= 0) session.lineWandSize[kind] = saved.lineWandSize[kind]; });
    }
    if (saved.unsaved && Array.isArray(saved.unsaved.features)) session.unsaved = saved.unsaved;
  })();

  /* Everything that belongs to one course, dropped when another is picked or opened. */
  function forgetCourse() {
    session.features = [];
    session.playOrders = [];
    session.activeOrder = "";
    session.facility = null;
    session.variant = "";
    session.osmMode = "include";
    session.osm = null;
    session.objects = [];
    session.lastRun = null;
    session.courseMap = null;
    session.loadedFor = "";
    session.dirty = false;
    session.status = "draft";
    session.hole = null;
    session.numberNext = 1;
    session.treeSamples = [];
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
  function kindLabel(kind) { return kind === "hole" ? "Hole line" : kind === "green" ? "Green" : kind === "tee" ? "Tee" : kind === "bunker" ? "Bunker" : kind === "water" ? "Water hazard" : kind === "trees" ? "Trees" : kind === "tree" ? "Tree" : kind === "hazard" ? "Hazard" : kind === "waste" ? "Waste area" : "Fairway"; }
  function isPolygon(kind) { return kind === "fairway" || kind === "green" || kind === "tee" || kind === "bunker" || kind === "water" || kind === "trees" || kind === "tree" || kind === "hazard" || kind === "waste"; }
  /* Tools with no pin form: their methods work the same in Pins as in Shapes. */
  var NO_PIN_KINDS = ["trees", "hazard", "waste"];
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
    trees: { color: "#2fbf5a", weight: 2, fillColor: "#1f8a3c", fillOpacity: 0.4 },
    treesSelected: { color: "#ffffff", weight: 3, fillColor: "#1f8a3c", fillOpacity: 0.5 },
    hazard: { color: "#ffa04d", weight: 2, fillColor: "#ff8a1f", fillOpacity: 0.35 },
    hazardSelected: { color: "#ffffff", weight: 3, fillColor: "#ff8a1f", fillOpacity: 0.45 },
    tree: { color: "#0d2a14", weight: 1.5, fillColor: "#2e9e4f", fillOpacity: 0.6 },
    treeSelected: { color: "#ffffff", weight: 2.5, fillColor: "#2e9e4f", fillOpacity: 0.7 },
    waste: { color: "#e0b97a", weight: 2, dashArray: "5 4", fillColor: "#c99a5b", fillOpacity: 0.35 },
    wasteSelected: { color: "#ffffff", weight: 3, dashArray: "5 4", fillColor: "#c99a5b", fillOpacity: 0.45 },
    /* The line a water hazard, trees or a hazard is drawn round with. */
    lasso: { color: "#4fb3ff", weight: 3, dashArray: "6 6", interactive: false },
    lassoTrees: { color: "#2fbf5a", weight: 3, dashArray: "6 6", interactive: false },
    lassoHazard: { color: "#ffa04d", weight: 3, dashArray: "6 6", interactive: false },
    lassoWaste: { color: "#e0b97a", weight: 3, dashArray: "6 6", interactive: false },
    /* A cluster oval while it is stretched, and the box the tree finder looks in. */
    stretchOval: { color: "#2fbf5a", weight: 2, dashArray: "6 6", fillColor: "#1f8a3c", fillOpacity: 0.2, interactive: false },
    stretchBox: { color: "#ffffff", weight: 2, dashArray: "6 6", fill: false, interactive: false },
    /* The box everything inside goes to the bin from (Shift-drag in Move). */
    stretchBin: { color: "#ff6a5c", weight: 2, dashArray: "6 6", fillColor: "#ff6a5c", fillOpacity: 0.12, interactive: false },
    draft: { color: "#ffb54c", weight: 3, dashArray: "6 6", interactive: false },
    /* Shapes on the same hole, and the line a Link drag draws. */
    link: { color: "#ffffff", weight: 2, opacity: 0.7, dashArray: "1 7", lineCap: "round", interactive: false },
    draftPreview: { color: "#ffb54c", weight: 1, fillColor: "#3cff8d", fillOpacity: 0.12, interactive: false },
    draftPoint: { radius: 4, color: "#ffb54c", weight: 2, fillColor: "#1a1a1a", fillOpacity: 1, interactive: false },
    vertex: { radius: 6, color: "#ffffff", weight: 2, fillColor: "#ffb54c", fillOpacity: 1, className: "gdStudioOverlayHandle" },
    midpoint: { radius: 4, color: "#ffffff", weight: 1, opacity: 0.8, fillColor: "#ffffff", fillOpacity: 0.35, className: "gdStudioOverlayHandle" },
    /* An invisible band along a detailed outline's edge: a press on it bends the edge there. */
    edge: { weight: 16, opacity: 0, fill: false, className: "gdStudioOverlayEdge" },
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
    /* An OSM hole line in the play order being built, and the wide band that makes any of them
       easy to click. */
    orderHole: { color: "#3cff8d", weight: 4, opacity: 0.95 },
    orderHit: { weight: 18, opacity: 0, className: "gdStudioOverlayOrderHit" },
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
    number: svgIcon('<path d="M9 4L7 20M17 4l-2 16M4.5 9h15M3.5 15h15"/>'),
    order: svgIcon('<path d="M10 6h10M10 12h10M10 18h10"/><path d="M4 4.5l1.5-.8V8M4 11h2.5L4 14.5h2.5M4 16.5h2.5v3.5H4M4 18.2h2"/>'),
    connect: svgIcon('<circle cx="6" cy="18" r="2.6"/><circle cx="18" cy="6" r="2.6"/><path d="M8 16l8-8" stroke-dasharray="2 3"/>'),
    fairway: svgIcon('<path d="M7 21c-1-5 2-7 4-10s2-6 1-8"/><path d="M13 21c-1-5 2-7 4-10s2-6 1-8"/>'),
    green: svgIcon('<path d="M9 18V3l8 3.5L9 10"/><ellipse cx="10" cy="19" rx="7" ry="2.4"/>'),
    tee: svgIcon('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>'),
    bunker: svgIcon('<path d="M3.5 15c0-4 4.2-7 8.5-7s8.5 2.2 8.5 5.3-3.5 4.7-8.5 4.7S3.5 17.4 3.5 15z"/><path d="M9 13h.01M13 12h.01M15 15h.01"/>'),
    water: svgIcon('<path d="M12 3c-2.2 3-3.5 4.8-3.5 6.5a3.5 3.5 0 0 0 7 0C15.5 7.8 14.2 6 12 3z"/><path d="M3 17c2 0 2-1.5 4.5-1.5S9.5 17 12 17s2.5-1.5 4.5-1.5S19 17 21 17"/><path d="M3 21c2 0 2-1.5 4.5-1.5S9.5 21 12 21s2.5-1.5 4.5-1.5S19 21 21 21"/>'),
    trees: svgIcon('<path d="M12 3l-5 7h3l-4 6h12l-4-6h3z"/><path d="M12 16v5"/>'),
    hazard: svgIcon('<path d="M12 4L2.5 20h19z"/><path d="M12 10v4.5M12 17.5h.01"/>'),
    waste: svgIcon('<path d="M3.5 15.5c.5-4 4-7.5 8.5-7.5s8 2.5 8.5 5.5-2.5 5.5-8.5 5.5-9-.5-8.5-3.5z" stroke-dasharray="3 2.4"/><path d="M8 14h.01M12 12h.01M15.5 14.5h.01M11 16h.01"/>'),
    expand: svgIcon('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
    shrink: svgIcon('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
    course: svgIcon('<path d="M3 11l9-7 9 7"/><path d="M5.5 9.5V20h13V9.5"/>'),
    search: svgIcon('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>'),
    plus: svgIcon('<path d="M12 5v14M5 12h14"/>'),
    minus: svgIcon('<path d="M5 12h14"/>'),
    undo: svgIcon('<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
    chevron: svgIcon('<path d="M6 9l6 6 6-6"/>'),
    split: svgIcon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>')
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
    /* The tool the line being laid belongs to: a fairway, or a bunker / water on Line + wand. */
    var draftKind = "";
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
    /* Link tool: the shapes clicked so far, waiting for Enter or Space to link them. */
    var linkPick = [];
    /* Whether the map was last drawn for the Play order tool (clickable OSM hole lines). */
    var wasOrdering = false;
    var linkLayers = [];
    /* One hole number tag per hole, and the one open for typing into (its group key). */
    var holeTagLayers = [];
    var editingTag = "";
    var editingValue = null;
    var clearingTags = false;
    var sourceTesting = false;
    var sourceTest = null;
    /* The press-and-drag gestures: a cluster oval or a tree-finder box being stretched, and the
       colour wand's press. */
    var stretch = null;
    var colourPress = null;
    /* Trees the finder just dropped, live for left / right / Enter / Esc like a placed shape. */
    var finder = null;
    /* The colour wand's selection, waiting for Enter. */
    var colourSel = null;
    var colourCap = null;

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
      '<span class="gdStudioOverlayHeadCourse" data-gd-overlay="course">No course picked</span>' +
      '<span class="gdStudioOverlayInboxCount" data-gd-overlay="inbox-count" title="Courses players asked to map - open the pull-down" hidden></span>' + ICON.chevron + "</button>" +
      '<span class="gdStudioOverlayDraft" data-gd-overlay="draft"></span>' +
      '<span class="gdStudioOverlayStatus" data-gd-overlay="status"></span>' +
      '<button type="button" class="gdStudioOverlaySave" data-gd-overlay="save" disabled>Save</button>' +
      "</header>" +
      '<div class="gdStudioOverlayCourses" data-gd-overlay="courses" hidden></div>' +
      '<div class="gdStudioOverlayMenu" data-gd-overlay="menu" hidden>' +
      '<div class="gdStudioOverlayInbox" data-gd-overlay="inbox"></div>' +
      '<div class="gdStudioOverlayRun" data-gd-overlay="last-run"></div>' +
      '<div class="gdStudioViewportBar">' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="pick">Pick course</button>' +
      '<label class="gdStudioViewportField">Imagery <select data-gd-overlay="provider"></select></label>' +
      '<label class="gdStudioViewportField"><input type="checkbox" data-gd-overlay="osm" checked> Show OSM</label>' +
      '<label class="gdStudioViewportField" title="My shapes only: the mapper does not read OpenStreetMap at all - just the shapes drawn here and the scorecard. OSM is hidden while you draw.">Mapper reads <select data-gd-overlay="osm-mode"><option value="include">OSM + my shapes</option><option value="exclude">My shapes only</option></select></label>' +
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
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="convert" disabled title="Add what OSM has here - greens, tees, fairways, bunkers, water, trees, hole lines - and the mapper\'s default fairways to the overlay as shapes you can reshape. Once saved and ready, each replaces the OSM shape it came from.">Make OSM editable</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="fresh" disabled title="Copy everything OSM has here into the overlay as your own shapes, then stop reading OSM for this course: from here on the mapper reads only the shapes drawn here, starting from OSM\'s.">Start fresh from OSM</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="ready" disabled>Mark ready</button>' +
      '<span class="gdStudioOverlayReadyChoice" data-gd-overlay="ready-choice" hidden>' +
      '<button type="button" class="gdStudioDiagramBtn" data-ready-osm="include" title="The mapper reads OpenStreetMap and your shapes, yours winning where they overlap">With OSM</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-ready-osm="exclude" title="The mapper reads only your shapes and the scorecard - no OpenStreetMap">My shapes only</button>' +
      "</span>" +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="run" disabled>Run mapper with overlay</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="unnumber" disabled title="Take every hole number off the overlay - shapes and links stay - so the mapper numbers them fresh from the scorecard">Clear hole numbers</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="clear" disabled>Delete all shapes</button>' +
      "</div>" +
      '<div class="gdStudioViewportReadout" data-gd-overlay="readout"></div>' +
      '<div class="gdStudioViewportCredit" data-gd-overlay="credit"></div>' +
      '<details class="gdStudioLede gdStudioOverlayHelp"><summary>How it works</summary>' +
      "<p><strong>Shapes</strong>: <strong>Fairway</strong> - click along its middle and press Finish; <strong>Green</strong> / <strong>Bunker</strong> - click the middle and the wand outlines it " +
      "(then shaped by a few smooth points); <strong>Water</strong> / <strong>Bunker</strong> - <em>Wand</em>: click the middle, <em>Draw round</em>: press and drag all the way round it, or <em>Line + wand</em>: click a line down its middle and Finish, and the line wand grows it out to the edge (the tool's key again switches method); <strong>Fairway</strong> has <em>Line + wand</em> too, instead of a set width; <strong>Tee</strong> - click to drop a round tee; <strong>Hazard</strong> (gorse, scrub - anything that is not water) - press and drag all the way round it. " +
      "Every tool also has the <em>Colour wand</em>: press on the thing and drag - the further you drag, the more of that colour it takes (Shift-drag adds more, ← → tighter / looser), Enter keeps it. " +
      "<strong>Trees</strong> - <em>Tree</em>: click to drop one tree, ↑ ↓ to size it; <em>Cluster</em>: press and drag to stretch an oval over a group (Shift for a circle); <em>Draw round</em>: press and drag round a wood; <em>Find trees</em>: drag a box and the trees in it that look like the ones you placed by hand this session are dropped for you (← → fewer / more, Enter keeps them, Esc takes them away). " +
      "<strong>Waste</strong> - <em>Draw + grow</em>: draw roughly round it and it is pushed out to the edge of the ground it sits on. " +
      "Whatever you just placed stays live: <strong>← →</strong> step the wand's sensitivity, <strong>↑ ↓</strong> make it smaller or bigger (a fairway narrower or wider), <strong>Enter</strong> or <strong>Space</strong> keeps it, <strong>Esc</strong> removes it - placing the next one keeps it too. " +
      "<strong>Pins</strong>, the quick pass: a fairway is its start then its end and becomes a fairway straight away; greens, tees, bunkers and water stay pins until <strong>Shape pins</strong>. " +
      "Whatever you just placed can be dragged at once to adjust it. In <strong>Move</strong>, drag shapes and their points, and drop either on the <strong>bin</strong> to delete. A detailed outline shows only its key points - grab its edge anywhere and it bends there, the key points either side staying put. " +
      "<strong>Seams</strong> (on by default): a fairway, water, hazard, waste area or trees kept within a few metres of another - or just overlapping it - meets it in the middle, and that line is shared; drag it and both shapes follow, so it only changes which ground is which. " +
      "<strong>Link</strong>: click the shapes that belong to one hole (click again to drop one), then <strong>Enter</strong> or <strong>Space</strong> links them and the next click starts a new link. A link only says they are one hole - it never numbers them. One shape and Enter takes it out of its link; <strong>Esc</strong> clears the pick. " +
      "<strong>Number</strong>: click each hole's fairway (or any shape on it) and the whole hole takes the <em>Next hole</em> number; with <em>Auto</em> on, the number then moves on, so 1 to 18 is eighteen clicks. Each hole shows one number on its fairway - click it with any tool to type a different one. A number on two holes shows red. " +
      "<strong>Play order</strong>: where the mapper gets a site's courses wrong, say them by hand. <strong>+ New play order</strong>, name it, then click its holes in the order they are played - an OSM hole line, or any shape of a hole you have linked (link a hole's tee and green first). Click a hole again to take it out. A hole can be in several play orders, so the same nines played in a different order are just another play order. With play orders on a ready overlay, the mapper publishes exactly those courses under those names. " +
      "<strong>Undo</strong> (the arrow at the top of the right-hand buttons, or Ctrl+Z / ⌘Z) takes back the last change, one at a time. " +
      "Everything saves as you go, as a <strong>draft</strong> the mapper ignores - <strong>Mark ready</strong> when the course looks right, then run the mapper. " +
      "Bright outlines are what OSM already has; dashed amber ones are the course's saved objects.</p></details>" +
      "</div>" +
      "</div>" +
      '<div class="gdStudioOverlaySplit">' +
      '<div class="gdStudioOverlayStage isTool-move" data-gd-overlay="stage">' +
      '<div class="gdStudioViewportMap gdStudioOverlayMap" data-gd-overlay="map"></div>' +
      '<div class="gdStudioOverlayRail" role="toolbar" aria-label="Tools">' +
      railButton("tool-move", "move", "Move", "Select, move and reshape (V)") +
      railButton("tool-connect", "connect", "Link", "Link shapes to the same hole (C)") +
      railButton("tool-number", "number", "Number", "Click each hole to number it - Auto steps 1, 2, 3... (N)") +
      railButton("tool-order", "order", "Play order", "Build a course by hand: name it, then click its holes in the order they are played (O)") +
      '<span class="gdStudioOverlayRailRule"></span>' +
      railButton("tool-fairway", "fairway", "Fairway", "") +
      railButton("tool-green", "green", "Green", "") +
      railButton("tool-tee", "tee", "Tee", "") +
      railButton("tool-bunker", "bunker", "Bunker", "") +
      railButton("tool-water", "water", "Water", "") +
      railButton("tool-trees", "trees", "Trees", "") +
      railButton("tool-hazard", "hazard", "Hazard", "") +
      railButton("tool-waste", "waste", "Waste", "") +
      "</div>" +
      '<div class="gdStudioOverlayOptions">' +
      '<span class="gdStudioOverlayModes">' +
      '<button type="button" data-gd-overlay="mode-shapes" title="Place outlines - fairway lines and the wand (S)">Shapes</button>' +
      '<button type="button" data-gd-overlay="mode-pins" title="Quick pass - fairway start and end, green and tee centres (P)">Pins</button>' +
      "</span>" +
      '<span class="gdStudioOverlayOpt" data-gd-overlay="number-label" hidden>Next hole <input type="number" min="1" max="36" step="1" data-gd-overlay="number-next" class="gdStudioOverlayWidth gdStudioOverlayHole">' +
      '<label title="Each click numbers a hole and moves on to the next number"><input type="checkbox" data-gd-overlay="number-auto"> Auto</label></span>' +
      '<label class="gdStudioOverlayOpt" data-gd-overlay="hole-label">Hole <input type="number" min="1" max="36" step="1" placeholder="–" data-gd-overlay="hole" class="gdStudioOverlayWidth gdStudioOverlayHole"></label>' +
      '<label class="gdStudioOverlayOpt" data-gd-overlay="width-label">Width <input type="number" min="10" max="90" step="1" data-gd-overlay="width" class="gdStudioOverlayWidth"> m</label>' +
      '<span class="gdStudioOverlayModes" data-gd-overlay="method" hidden>' +
      '<button type="button" data-gd-overlay="method-width" title="Click a line down the fairway; it becomes a fairway of the set width (F again switches)">Width</button>' +
      '<button type="button" data-gd-overlay="method-wand" title="Click the middle and the wand outlines it (press the tool key again to switch)">Wand</button>' +
      '<button type="button" data-gd-overlay="method-round" title="Click to drop a round tee (T again switches)">Round</button>' +
      '<button type="button" data-gd-overlay="method-draw" title="Press and drag all the way round it (press the tool key again to switch)">Draw round</button>' +
      '<button type="button" data-gd-overlay="method-line" title="Click a line down its middle, Finish, and the line wand grows it out to the edge (press the tool key again to switch)">Line + wand</button>' +
      '<button type="button" data-gd-overlay="method-single" title="Click to drop one tree; up and down make it smaller or bigger (E again switches)">Tree</button>' +
      '<button type="button" data-gd-overlay="method-oval" title="Press and drag across a cluster of trees to stretch an oval over it - hold Shift for a circle (E again switches)">Cluster</button>' +
      '<button type="button" data-gd-overlay="method-find" title="Drag a box: trees in it that look like the ones you placed by hand this session are dropped as trees (E again switches)">Find trees</button>' +
      '<button type="button" data-gd-overlay="method-auto" title="Trees along the edges of the fairways and greens already placed, found with nothing placed by hand first - into the course tree layer, to publish from there (E again switches)">Near play</button>' +
      '<button type="button" data-gd-overlay="method-grow" title="Draw roughly round the waste area; it is pushed out to the edge of the ground it sits on (A again switches)">Draw + grow</button>' +
      '<button type="button" data-gd-overlay="method-colour" title="Press on it and drag - further selects more of the same colour. Shift-drag adds. Enter keeps it (press the tool key again to switch)">Colour wand</button>' +
      "</span>" +
      '<span class="gdStudioOverlayOpt" data-gd-overlay="wand-size-label"><span data-gd-overlay="wand-size-name">Wand</span> ' +
      '<button type="button" class="gdStudioOverlayStep" data-gd-overlay="wand-smaller" title="The wand reaches for a smaller edge (↓ on the shape just placed, [ for the next one)">−</button>' +
      '<span class="gdStudioOverlayStepValue" data-gd-overlay="wand-size"></span>' +
      '<button type="button" class="gdStudioOverlayStep" data-gd-overlay="wand-bigger" title="The wand reaches for a bigger edge (↑ on the shape just placed, ] for the next one)">+</button></span>' +
      '<span class="gdStudioOverlayOpt" data-gd-overlay="tree-auto-label" hidden>' +
      '<label title="How far out from each fairway and green to look for trees">Band <input type="number" min="' + TREE_BAND_MIN_M + '" max="' + TREE_BAND_MAX_M + '" step="5" data-gd-overlay="tree-band" class="gdStudioOverlayWidth"> m</label>' +
      '<label title="Keep only what the canopy height map says stands 3m or more, and add trees it finds from their height alone"><input type="checkbox" data-gd-overlay="tree-heights"> Heights</label>' +
      '<button type="button" class="gdStudioOverlayOptBtn" data-gd-overlay="tree-auto"></button></span>' +
      '<label class="gdStudioOverlayOpt" data-gd-overlay="merge-label" title="A bunker outline that overlaps one already placed joins it as one bunker"><input type="checkbox" data-gd-overlay="merge"> Merge bunkers</label>' +
      '<label class="gdStudioOverlayOpt" data-gd-overlay="seams-label" title="A fairway, water, hazard, waste area or trees kept within a few metres of another meets it in the middle, and the line between them is shared - drag it and both follow"><input type="checkbox" data-gd-overlay="seams"> Seams</label>' +
      '<button type="button" class="gdStudioOverlayOptBtn" data-gd-overlay="shape-pins" hidden></button>' +
      '<button type="button" class="gdStudioOverlayOptBtn" data-gd-overlay="collar" title="A collar round this green - the fringe found with the wand, necked out to its fairway (K)" hidden>+ Collar</button>' +
      "</div>" +
      '<div class="gdStudioOverlayOrders" data-gd-overlay="orders" hidden></div>' +
      '<div class="gdStudioOverlayViewRail" role="toolbar" aria-label="View">' +
      viewButton("undo", "undo", "Undo the last change (Ctrl+Z / ⌘Z)") +
      viewButton("fullscreen", "expand", "Full screen") +
      viewButton("google", "split", "Google satellite alongside, following this map") +
      viewButton("trees", "trees", "Trees") +
      viewButton("fit", "course", "Fit the whole course (H)") +
      viewButton("zoom-shape", "search", "Zoom to the selected shape (Z)") +
      viewButton("zoom-in", "plus", "Zoom in (+)") +
      viewButton("zoom-out", "minus", "Zoom out (-)") +
      "</div>" +
      '<div class="gdStudioOverlayDock">' +
      '<div class="gdStudioOverlayDraftBar" data-gd-overlay="draft-bar" hidden>' +
      '<button type="button" data-gd-overlay="draft-finish" title="Finish the line (Enter, or double-click)">Finish</button>' +
      '<button type="button" data-gd-overlay="draft-undo" title="Take back the last point (Backspace)">Undo point</button>' +
      '<button type="button" data-gd-overlay="draft-cancel" title="Drop this line (Esc)">Cancel</button>' +
      "</div>" +
      '<div class="gdStudioOverlayDraftBar gdStudioOverlayTreeBar" data-gd-overlay="tree-bar" hidden>' +
      '<span class="gdStudioOverlayTreeText" data-gd-overlay="tree-text"></span>' +
      '<button type="button" data-gd-overlay="tree-less" title="Fewer trees - a stricter look (←)">Less</button>' +
      '<button type="button" data-gd-overlay="tree-more" title="More trees - a looser look (→)">More</button>' +
      '<button type="button" data-gd-overlay="tree-publish" title="Put these trees live on the watch">Publish tree changes</button>' +
      '<button type="button" data-gd-overlay="tree-rerun" title="Find this course\'s trees again from its imagery">Run again</button>' +
      '<button type="button" data-gd-overlay="tree-close" title="Stop editing trees (Esc)">Done</button>' +
      "</div>" +
      '<div class="gdStudioOverlayHint" data-gd-overlay="hint"></div>' +
      "</div>" +
      '<button type="button" class="gdStudioOverlayBin" data-gd-overlay="bin" title="Drag a shape or point here to delete it, or click to delete the selected shape">' +
      BIN_ICON + "<span>Bin</span></button>" +
      "</div>" +
      '<div class="gdStudioOverlayGoogle" data-gd-overlay="google-pane" hidden>' +
      '<div class="gdStudioOverlayGoogleMap" data-gd-overlay="google-map"></div>' +
      '<div class="gdStudioOverlayGoogleCredit" data-gd-overlay="google-credit">Google</div>' +
      "</div>" +
      "</div>" +
      "</div>";

    var el = {};
    ["courses", "inbox", "inbox-count", "pick", "convert", "fresh", "course", "provider", "osm", "objects", "ai", "source-test", "source-panel", "course-map", "course-map-state", "last-run", "menu", "menu-toggle", "save", "mode-shapes", "mode-pins", "tool-move", "tool-connect", "tool-number", "tool-order", "orders", "tool-fairway", "tool-green", "tool-tee", "tool-bunker", "tool-water", "tool-trees", "tool-hazard", "tool-waste", "method", "method-width", "method-wand", "method-round", "method-draw", "method-line", "method-single", "method-oval", "method-find", "method-auto", "method-grow", "method-colour", "tree-auto-label", "tree-band", "tree-heights", "tree-auto", "width", "width-label", "wand-size-label", "wand-size-name", "wand-smaller", "wand-size", "wand-bigger", "merge", "merge-label", "seams", "seams-label", "collar", "hole", "hole-label", "number-label", "number-next", "number-auto", "shape-pins", "workspace", "draft-bar", "draft-finish", "draft-undo", "draft-cancel", "tree-bar", "tree-text", "tree-less", "tree-more", "tree-publish", "tree-rerun", "tree-close", "undo", "trees", "fit", "zoom-shape", "zoom-in", "zoom-out", "fullscreen", "google", "google-pane", "google-map", "google-credit", "stage", "map", "hint", "bin", "readout", "credit", "draft", "ready", "ready-choice", "osm-mode", "unnumber", "clear", "run", "status"].forEach(function (name) {
      el[name] = containerEl.querySelector('[data-gd-overlay="' + name + '"]');
    });

    if (typeof window.L === "undefined" || !sourcesApi() || !shapesApi()) {
      el.map.innerHTML = '<p class="gdStudioMuted" style="padding:16px">Leaflet, the map source list or the overlay shape builders did not load on this surface.</p>';
      return null;
    }
    var shapes = shapesApi();
    if (!session.fairwayWidth) session.fairwayWidth = shapes.FAIRWAY_WIDTH_M;
    el.width.value = session.fairwayWidth;
    if (!session.treeBandM) session.treeBandM = shapes.TREE_BAND_M;
    el["tree-band"].value = session.treeBandM;
    el["tree-heights"].checked = session.treeHeights !== false;

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
      renderCredit();
      refreshCaptureDate();
      remember();
    }

    /* ---- when the imagery was taken ----
       Shapes are placed by eye off the ground, so the credit line says how old the picture is:
       the server asks the mounted provider about the view's centre (CAPTURE_API) and the answer
       is kept per provider, zoom and ~100m cell, so panning around one course asks once. */
    var captureCache = {};
    var captureAsk = 0;
    var captureTimer = null;
    function captureKey() {
      var here = centre();
      if (!here || !mapObj) return "";
      return session.sourceKey + "|" + Math.floor(mapObj.getZoom()) + "|" + here.lat.toFixed(3) + "," + here.lng.toFixed(3);
    }
    function renderCredit() {
      var source = sourceByKey(session.sourceKey);
      if (!source) { el.credit.innerHTML = ""; return; }
      var got = captureCache[captureKey()];
      var when = !got ? "asking when this was taken…"
        : got.status === "ok" ? "taken " + got.text + (got.detail ? " (" + got.detail + ")" : "")
        : got.status === "none" ? "capture date: " + got.text
        : got.status === "unsupported" ? got.text
        : "capture date unavailable: " + got.text;
      el.credit.innerHTML = esc(source.label) + (source.attribution ? " — " + esc(source.attribution) : "") +
        ' · <span class="gdStudioOverlayCaptured' + (got && got.status === "ok" ? "" : " isMuted") + '">' + esc(when) + "</span>" +
        (canopyCredit ? " · " + esc(canopyCredit) : "");
    }
    function refreshCaptureDate() {
      if (captureTimer) clearTimeout(captureTimer);
      captureTimer = setTimeout(askCaptureDate, 400);
    }
    function askCaptureDate() {
      captureTimer = null;
      if (destroyed || !mapObj) return;
      var key = captureKey();
      if (!key || captureCache[key]) { renderCredit(); return; }
      var here = centre();
      var b = mapObj.getBounds();
      var asked = ++captureAsk;
      var query = "?source=" + encodeURIComponent(session.sourceKey) + "&lat=" + here.lat.toFixed(6) + "&lng=" + here.lng.toFixed(6) + "&zoom=" + mapObj.getZoom() +
        "&north=" + b.getNorth().toFixed(6) + "&south=" + b.getSouth().toFixed(6) + "&east=" + b.getEast().toFixed(6) + "&west=" + b.getWest().toFixed(6);
      api("GET", query, null, CAPTURE_API).then(function (data) {
        captureCache[key] = data && data.status ? data : { status: "error", text: "no answer" };
      }).catch(function (error) {
        captureCache[key] = { status: "error", text: String(error && error.message || error) };
      }).then(function () {
        if (destroyed || asked !== captureAsk) return;
        renderCredit();
      });
    }
    /* Why the mounted provider's pixels cannot be read, or "". `scan` is the AI scan, whose
       shapes are stored - a provider marked noAiScan (Mapbox) is wand-only. */
    function captureRefusal(scan) {
      if (!mapObj || !layer || typeof layer.getTileUrl !== "function") return "this provider cannot be captured - switch provider";
      var source = sourceByKey(session.sourceKey);
      if (scan && source && source.noAiScan) return "the AI scan does not run over " + source.name + " - switch provider to scan";
      return "";
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

    var TOOLS = ["move", "connect", "number", "order", "fairway", "green", "tee", "bunker", "water", "trees", "hazard", "waste"];

    /* Whatever was just placed is kept: the live shape, and the trees the finder dropped. The
       colour wand's selection is not a shape yet - it goes, unless `keepColour`. */
    function settle(keepColour) {
      if (adjust) commitAdjust(true);
      if (finder) keepFinder(true);
      if (colourSel && !keepColour) clearColourSel();
    }

    /* The tool picked stays picked: placing a shape never switches to another tool, so a run
       of greens or bunkers is a run of clicks. */
    function setTool(next) {
      settle();
      tool = TOOLS.indexOf(next) >= 0 ? next : "move";
      TOOLS.forEach(function (name) {
        el["tool-" + name].classList.toggle("isActive", tool === name);
        el.stage.classList.toggle("isTool-" + name, tool === name);
      });
      if (draft.length && draftKind && draftKind !== tool) cancelDraft();
      lastPlacedId = "";
      if (linkPick.length) { linkPick = []; drawFeatures(); }
      if (tool !== "move" && selectedId) select("");
      /* OSM hole lines are clickable only while a play order is being built, and the hole tags
         show its order instead of the hole numbers. */
      var ordering = tool === "order";
      if (ordering !== wasOrdering) { wasOrdering = ordering; drawOsm(); drawHoleTags(); }
      renderOrders();
      /* Double-click zooms, except while laying a fairway line, where it would move the ground
         under the last point. */
      syncDoubleClick();
      renderOptions();
      syncMapDragging();
      updateHint();
    }

    /* ---- modes: shapes, or pins only ---- */

    var TOOL_TEXT = {
      shapes: {
        fairway: "Lay a line down the fairway - at the set width, or wanded out to its edge - or pick it with the colour wand (F)",
        green: "Click a green and the wand outlines it, or pick it with the colour wand (G)",
        tee: "Drop a round tee, or pick it with the colour wand (T)",
        bunker: "Click a bunker for the wand, draw round it, lay a line and wand it out, or the colour wand (B)",
        water: "Click water for the wand, draw round it, lay a line and wand it out, or the colour wand (W)",
        trees: "A tree a click, a cluster as an oval, a wood drawn round, find trees in a box, or the colour wand (E)",
        hazard: "Draw round a non-water hazard - gorse, scrub, a ravine - or pick it with the colour wand (X)",
        waste: "Draw round a waste area and grow it out, or pick it with the colour wand (A)"
      },
      pins: {
        fairway: "Click where the fairway starts, then where it ends - it becomes a fairway (F)",
        green: "Pin the middle of a green (G)",
        tee: "Pin the middle of a tee (T)",
        bunker: "Pin the middle of a bunker (B)",
        water: "Pin the middle of a water hazard (W)",
        trees: "A tree a click, a cluster as an oval, a wood drawn round, find trees in a box, or the colour wand - trees have no pin (E)",
        hazard: "Draw round a non-water hazard, or pick it with the colour wand - hazards have no pin (X)",
        waste: "Draw round a waste area and grow it out, or pick it with the colour wand - waste has no pin (A)"
      }
    };

    function setMode(next) {
      settle();
      session.mode = next === "pins" ? "pins" : "shapes";
      if (draft.length) cancelDraft();
      el["mode-shapes"].classList.toggle("isActive", session.mode === "shapes");
      el["mode-pins"].classList.toggle("isActive", session.mode === "pins");
      ["fairway", "green", "tee", "bunker", "water", "trees", "hazard", "waste"].forEach(function (name) {
        el["tool-" + name].title = TOOL_TEXT[session.mode][name];
      });
      renderOptions();
      syncMapDragging();
      remember();
      updateHint();
    }

    /* The options along the top that belong to the tool and mode in hand. The wand size shows
       for a tool on the wand, in Shapes. */
    function renderOptions() {
      var shapesMode = session.mode === "shapes";
      el["merge-label"].hidden = !shapesMode;
      el["seams-label"].hidden = !shapesMode;
      var methods = methodOf(tool) ? METHODS[tool] : null;
      el.method.hidden = !methods;
      METHOD_NAMES.forEach(function (m) {
        var b = el["method-" + m];
        b.hidden = !methods || methods.indexOf(m) < 0;
        b.classList.toggle("isActive", !!methods && session.method[tool] === m);
      });
      el["width-label"].hidden = !shapesMode || (tool === "fairway" && session.method.fairway !== "width");
      el["number-label"].hidden = tool !== "number";
      el["hole-label"].hidden = tool === "number";
      if (tool === "number") renderNumberField();
      el["tree-auto-label"].hidden = methodOf(tool) !== "auto";
      renderTreeAuto();
      el["wand-size-label"].hidden = !(growWanding() || (shapesMode && WAND_KINDS.indexOf(tool) >= 0 && (!METHODS[tool] || methodOf(tool) === "wand")));
      renderWandSize();
    }

    /* ---- methods: wand, draw round, line + wand, width ---- */

    /* How the tool in hand places a shape. Pins mode has no methods - a pin is a pin - except
       on the tools that have no pin. */
    function methodOf(kind) { return METHODS[kind] && (session.mode === "shapes" || NO_PIN_KINDS.indexOf(kind) >= 0) ? session.method[kind] : null; }
    /* The kind a press-and-drag draws round right now, or null when the tool clicks instead. A
       waste area on Draw + grow is drawn round first, then grown. */
    function drawRoundKind() { return methodOf(tool) === "draw" || methodOf(tool) === "grow" ? tool : null; }
    /* What a press-and-drag on the map does with the tool in hand, or null when it pans. */
    function pressGesture() {
      if (drawRoundKind()) return "lasso";
      var m = methodOf(tool);
      return m === "oval" ? "oval" : m === "find" ? "box" : m === "colour" ? "colour" : null;
    }
    /* Whether clicks lay a line: for a fairway unless it is on the colour wand, for bunkers and
       water on Line + wand. */
    function lineTool() { return tool === "fairway" ? methodOf("fairway") !== "colour" : methodOf(tool) === "line"; }
    /* Whether the shape is grown out by a wand with a reach: a finished line on Line + wand,
       or a waste area drawn round on Draw + grow. */
    function growWanding() { return methodOf(tool) === "line" || methodOf(tool) === "grow"; }

    function setMethod(kind, m) {
      if (!METHODS[kind] || METHODS[kind].indexOf(m) < 0) return;
      settle();
      if (draft.length) cancelDraft();
      session.method[kind] = m;
      renderOptions();
      syncMapDragging();
      syncDoubleClick();
      remember();
      updateHint();
    }

    function cycleMethod(kind) {
      var list = METHODS[kind];
      setMethod(kind, list[(list.indexOf(session.method[kind]) + 1) % list.length]);
      setStatus(kindLabel(kind) + ": " + METHOD_LABEL[session.method[kind]] + ".");
    }

    /* Double-click zooms, except while laying a line, where it would move the ground under the
       last point (and finishes the line instead). */
    function syncDoubleClick() {
      if (!mapObj) return;
      try { if (lineTool()) mapObj.doubleClickZoom.disable(); else mapObj.doubleClickZoom.enable(); } catch (e) {}
    }

    /* Drawing round, stretching an oval or a box, and the colour wand are a press-and-drag, so
       the map does not pan under them; any other tool pans as usual. */
    function syncMapDragging() {
      if (!mapObj || drag || lasso || stretch || colourPress) return;
      try { if (pressGesture()) mapObj.dragging.disable(); else mapObj.dragging.enable(); } catch (e) {}
    }

    var lasso = null;

    /* A press on the map starts the tool's gesture, if it has one. */
    function onMapPress(event) {
      /* In Move, Shift and a press on open map stretches the bin box. */
      var gesture = pressGesture() || (tool === "move" && event.shiftKey ? "bin" : null);
      if (!gesture || event.button || drag || lasso || stretch || colourPress || !mapObj) return;
      if (Date.now() - dragEndedAt < 300) return;
      if (!canEdit()) { setStatus(scanning ? "Wait for the AI scan to finish." : "Still loading this course's overlay…"); return; }
      if (gesture !== "bin" && full(gesture === "box" ? "tree" : tool)) return;
      event.preventDefault();
      if (gesture === "colour") { settle(true); beginColourWand(event); return; }
      settle();
      if (gesture === "lasso") beginLasso(event);
      else beginStretch(event, gesture);
    }

    function beginLasso(event) {
      var kind = drawRoundKind();
      var lassoStyle = STYLE["lasso" + kind.charAt(0).toUpperCase() + kind.slice(1)] || STYLE.lasso;
      lasso = { kind: kind, points: [mapObj.mouseEventToLatLng(event)], x: event.clientX, y: event.clientY, line: L.polyline([], lassoStyle).addTo(mapObj) };
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
      var noun = drawn.kind === "water" ? "the water" : drawn.kind === "bunker" ? "the bunker" : drawn.kind === "trees" ? "the trees" : drawn.kind === "waste" ? "the waste area" : "the hazard";
      if (!ring) { setStatus("Press and drag all the way round " + noun + " to outline it.", true); return; }
      /* A waste area drawn round roughly is pushed out to the edge of the ground it sits on. */
      if (drawn.kind === "waste") { growPlace({ ring: ring }, "waste"); return; }
      /* A bunker is edited by its smooth handles like every other bunker. */
      if (drawn.kind === "bunker") ring = shapes.smoothOutline(ring, "bunker");
      var f = addFeature({ kind: drawn.kind, points: ring });
      startAdjust(f, { base: ring });
      setStatus(kindLabel(drawn.kind) + " placed.");
    }

    /* ---- stretching: a cluster of trees as an oval, the tree finder's box ----
       Press at one corner and drag to the other. The oval fills the box (Shift: a circle);
       the box is where the finder looks. */

    function beginStretch(event, mode) {
      var start = mapObj.mouseEventToLatLng(event);
      var preview = mode === "oval" ? L.polygon([], STYLE.stretchOval) : L.rectangle(L.latLngBounds(start, start), mode === "bin" ? STYLE.stretchBin : STYLE.stretchBox);
      stretch = { mode: mode, start: { lat: start.lat, lng: start.lng }, end: null, round: false, layer: preview.addTo(mapObj) };
      /* Move leaves the map draggable; the box must not pan it. syncMapDragging puts it back. */
      try { mapObj.dragging.disable(); } catch (e) {}
      document.addEventListener("pointermove", onStretchMove);
      document.addEventListener("pointerup", onStretchEnd);
      document.addEventListener("pointercancel", onStretchEnd);
    }

    function onStretchMove(event) {
      if (!stretch || destroyed) return;
      var ll = mapObj.mouseEventToLatLng(event);
      stretch.end = { lat: ll.lat, lng: ll.lng };
      stretch.round = !!event.shiftKey;
      if (stretch.mode === "oval") stretch.layer.setLatLngs(toLatLngs(shapes.ellipseInBox(stretch.start, stretch.end, stretch.round)));
      else stretch.layer.setBounds(L.latLngBounds([stretch.start.lat, stretch.start.lng], [ll.lat, ll.lng]));
    }

    function onStretchEnd(event) {
      document.removeEventListener("pointermove", onStretchMove);
      document.removeEventListener("pointerup", onStretchEnd);
      document.removeEventListener("pointercancel", onStretchEnd);
      var done = stretch;
      stretch = null;
      if (destroyed || !done) return;
      try { mapObj.removeLayer(done.layer); } catch (e) {}
      dragEndedAt = Date.now();
      syncMapDragging();
      if (event.type === "pointercancel") return;
      var a = done.start, b = done.end;
      var wide = !!b && shapes.distanceM(a, { lat: a.lat, lng: b.lng }) >= 2, tall = !!b && shapes.distanceM(a, { lat: b.lat, lng: a.lng }) >= 2;
      if (done.mode === "bin") {
        if (!(wide && tall)) { setStatus("Shift-drag a box round the shapes to delete - everything wholly inside it goes.", true); return; }
        binBox(a, b);
        return;
      }
      if (done.mode === "oval") {
        if (done.round ? !(wide || tall) : !(wide && tall)) { setStatus("Press and drag across the cluster of trees to stretch an oval over it.", true); return; }
        var ring = shapes.ellipseInBox(a, b, done.round);
        var f = addFeature({ kind: "trees", points: ring });
        startAdjust(f, { base: ring });
        setStatus("Cluster of trees placed. ↑ ↓ smaller / bigger, or drag its corners in Move.");
        return;
      }
      if (!(wide && tall)) { setStatus("Drag a box over the ground to look for trees in.", true); return; }
      runTreeFinder(a, b);
    }

    /* ---- the bin box ----
       Every shape wholly inside the box goes - wholly, so a fairway the box only clips stays.
       Undo puts them back, which is why there is no "are you sure". */
    function binBox(a, b) {
      var bounds = L.latLngBounds([a.lat, a.lng], [b.lat, b.lng]);
      var gone = session.features.filter(function (f) { return f.points.every(function (p) { return bounds.contains([p.lat, p.lng]); }); });
      if (!gone.length) { setStatus("Nothing lies wholly inside that box."); return; }
      var ids = {};
      gone.forEach(function (f) { ids[f.id] = true; });
      session.features = session.features.filter(function (f) { return !ids[f.id]; });
      if (selectedId && ids[selectedId]) selectedId = "";
      if (adjust && ids[adjust.id]) adjust = null;
      if (finder) finder = null;
      drawFeatures();
      changed();
      updateHint();
      setStatus("Deleted " + gone.length + " shape" + (gone.length === 1 ? "" : "s") + " in the box. Undo puts them back.");
    }

    /* ---- single trees ----
       A click drops a tree at the size the last one was left at; up and down size it. Trees
       placed by hand are what the tree finder learns from. */

    function placeTree(point) {
      var f = addFeature({ kind: "tree", points: shapes.treeAt(point, session.treeRadius || shapes.TREE_RADIUS_M) });
      session.treeSamples.push(f.id);
      startAdjust(f, { base: f.points.slice() });
      setStatus("Tree placed. ↑ ↓ smaller / bigger - the next one starts at this size.");
    }

    /* The hand-placed trees still on the map, latest last. */
    function sampleTrees() {
      return session.treeSamples.map(findFeature).filter(function (f) { return f && f.kind === "tree"; });
    }

    /* ---- the tree finder ----
       A box dragged over the ground: the trees placed by hand this session say what a tree
       looks like here (their colour and size), and the finder (GDOverlayShapes.treeFinder)
       drops a tree on every crown in the box that looks like them. The trees it drops stay
       live: left and right drop fewer or more (its sensitivity), Enter keeps them, Esc takes
       them all away; placing anything else keeps them. */

    function runTreeFinder(a, b) {
      var samples = sampleTrees().slice(-TREE_SAMPLE_MAX);
      if (!samples.length) { setStatus("Place a tree or two by hand first (Tree), on trees like the ones you want found - the finder looks for more like them.", true); return; }
      if (full("tree")) return;
      var room = Math.min(shapes.TREE_FINDER_MAX, roomFor("tree"));
      var id = session.loadedFor;
      var hole = session.hole;
      var marker = L.rectangle(L.latLngBounds([a.lat, a.lng], [b.lat, b.lng]), STYLE.stretchBox).addTo(mapObj);
      marker.bindTooltip("Looking for trees…", { permanent: true, direction: "center", className: "gdStudioOverlayLabel" });
      wandsRunning++;
      updateHint();
      var corners = [a, b, { lat: a.lat, lng: b.lng }, { lat: b.lat, lng: a.lng }];
      captureBox(corners, { mpp: TREE_FINDER_MPP, maxSidePx: TREE_FINDER_MAX_SIDE_PX, marginPx: 8 }).then(function (cap) {
        /* Each sample tree read at the box's own zoom, so its crown is the same size in pixels. */
        return Promise.all(samples.map(function (t) {
          return captureBox(t.points, { z: cap.z, maxSidePx: 512, marginPx: 4 }).then(function (patch) {
            var c = shapes.centroid(t.points), rM = shapes.ringRadiusM(t.points);
            return { samples: shapes.circleSamples(patch.image, patch.toPx(c), rM * 0.75 / patch.mpp, 1), radiusM: rM };
          }, function () { return null; });
        })).then(function (read) {
          read = read.filter(Boolean);
          if (!read.length) throw new Error("the trees placed by hand could not be read off the imagery");
          var pool = { L: [], A: [], B: [] };
          read.forEach(function (r) { pool.L = pool.L.concat(r.samples.L); pool.A = pool.A.concat(r.samples.A); pool.B = pool.B.concat(r.samples.B); });
          var radii = read.map(function (r) { return r.radiusM; }).sort(function (x, y) { return x - y; });
          var radiusPx = radii[radii.length >> 1] / cap.mpp;
          var pa = cap.toPx(a), pb = cap.toPx(b);
          var avoid = session.features.filter(function (f) { return f.kind === "tree"; }).map(function (f) {
            var c = cap.toPx(shapes.centroid(f.points));
            return { x: c.x, y: c.y, r: shapes.ringRadiusM(f.points) / cap.mpp };
          });
          return { cap: cap, run: shapes.treeFinder(cap.image, shapes.colourModel(pool), { radiusPx: radiusPx, box: { x0: pa.x, y0: pa.y, x1: pb.x, y1: pb.y }, avoid: avoid, max: room }) };
        });
      }).then(function (found) {
        if (destroyed || session.loadedFor !== id) return;
        settle(true);
        finder = { ids: [], runs: [{ cap: found.cap, run: found.run, hole: hole }] };
        dropFinderTrees(session.treeFinderLevel);
        if (!finder.ids.length) setStatus("No trees like the ones you placed were found in that box. → looks harder.");
      }, function (error) {
        if (!destroyed) setStatus("The tree finder could not run: " + (error && error.message || error) + ".", true);
      }).then(function () {
        try { mapObj && mapObj.removeLayer(marker); } catch (e) {}
        wandsRunning--;
        if (!destroyed) updateHint();
      });
    }

    /* The finder's trees at one sensitivity, in place of the ones it dropped before. Each run
       is one picture read (one box, or one fairway or green near play); where two runs' pictures
       overlap, a tree is dropped once. Trees found by colour come first, then the ones found
       from their height alone, where nothing by colour already stands. */
    function dropFinderTrees(level) {
      var levels = shapes.TREE_FINDER_LEVELS;
      level = Math.max(0, Math.min(levels.length - 1, Math.round(Number(level)) || 0));
      var gone = {};
      finder.ids.forEach(function (fid) { gone[fid] = true; });
      session.features = session.features.filter(function (f) { return !gone[f.id]; });
      if (gone[selectedId]) selectedId = "";
      finder.level = level;
      session.treeFinderLevel = level;
      var kept = [], room = roomFor("tree");
      finder.runs.forEach(function (run) {
        run.run.find(levels[level]).forEach(function (t) {
          if (kept.length >= room) return;
          var ll = run.cap.toLL(t), rM = t.r * run.cap.mpp;
          if (kept.some(function (k) { return shapes.distanceM(k.ll, ll) < (k.rM + rM) * 0.75; })) return;
          kept.push({ ll: ll, rM: rM, hole: run.hole });
        });
      });
      finder.ids = kept.map(function (k) {
        return addFeature({ kind: "tree", points: shapes.treeAt(k.ll, k.rM), source: "finder", hole: k.hole }, true).id;
      });
      drawFeatures();
      changed();
      updateHint();
      setStatus("Found " + kept.length + " tree" + (kept.length === 1 ? "" : "s") + " (sensitivity " + (level + 1) + " of " + levels.length + "). ← → fewer / more · Enter keeps them · Esc takes them away.");
    }

    function stepFinder(by) {
      var next = Math.max(0, Math.min(shapes.TREE_FINDER_LEVELS.length - 1, finder.level + by));
      if (next === finder.level) { setStatus(by < 0 ? "That is as strict as the finder goes." : "That is as loose as the finder goes."); return; }
      dropFinderTrees(next);
    }

    function keepFinder(quiet) {
      var n = finder.ids.filter(findFeature).length;
      finder = null;
      if (!quiet) setStatus(n + " tree" + (n === 1 ? "" : "s") + " kept.");
      updateHint();
    }

    function discardFinder() {
      var gone = {};
      finder.ids.forEach(function (fid) { gone[fid] = true; });
      finder = null;
      session.features = session.features.filter(function (f) { return !gone[f.id]; });
      if (gone[selectedId]) selectedId = "";
      drawFeatures();
      changed();
      updateHint();
      setStatus("The trees the finder dropped are gone.");
    }

    /* ---- trees near play ----
       The finder with nothing placed by hand and no box: it looks along the edge of each
       fairway and green already on the overlay - the hole being numbered, or every hole when
       none is - and learns what a tree looks like from the turf inside them
       (GDOverlayShapes.playBand, autoTreeModel). One picture is read per fairway and per green,
       since a whole hole at the finder's detail would not fit in one. Where tree heights are to
       hand (CANOPY_API) and Heights is on, only what stands TREE_MIN_HEIGHT_M or more is kept,
       and trees the height map has that the colour missed (a bare winter crown) are added. What
       it finds goes into the course's tree layer (below), for More / Less and Publish tree
       changes - the same layer the server's tree run fills on its own. */

    var NEAR_PLAY_KINDS = ["fairway", "green"];
    /* Everything a tree near play keeps clear of. */
    var SURFACE_KINDS = ["fairway", "green", "tee", "bunker", "water", "waste"];
    /* Credit for the tree heights, once they have been used here (CC BY - see renderCredit). */
    var canopyCredit = "";

    /* A shape as an outline - a pin as the default shape it stands for. */
    function outlineOf(f) {
      if (!f.pin) return f.points.length >= 3 ? f.points : null;
      if (f.kind === "fairway") return f.points.length >= 2 ? shapes.fairwayFromLine(f.points, shapes.FAIRWAY_WIDTH_M) : null;
      return f.kind === "tee" ? shapes.teeAt(f.points[0]) : shapes.circle(f.points[0], defaultRadius(f.kind), 16);
    }

    /* The fairways and greens near play looks along: the hole in hand, or all of them. */
    function nearPlayShapes() {
      return session.features.filter(function (f) {
        return NEAR_PLAY_KINDS.indexOf(f.kind) >= 0 && (!session.hole || f.hole === session.hole) && outlineOf(f);
      }).sort(function (a, b) { return (a.hole || 99) - (b.hole || 99) || NEAR_PLAY_KINDS.indexOf(a.kind) - NEAR_PLAY_KINDS.indexOf(b.kind); });
    }

    function renderTreeAuto() {
      if (destroyed || !el["tree-auto"]) return;
      el["tree-auto"].textContent = session.hole ? "Find trees near hole " + session.hole : "Find trees near every hole";
      el["tree-auto"].disabled = !!wandsRunning;
    }

    /* Tree heights round an outline, out to padM: {grids, credit}, or {why} when there are
       none. Asked for alongside the picture, not after it - the box is the outline's, padded
       a little past the picture's own room so it covers the picture whatever its tile edges. */
    function canopyFor(ring, padM) {
      if (session.treeHeights === false) return Promise.resolve({ grids: null, why: "" });
      var b = L.latLngBounds(toLatLngs(ring)), lat = b.getCenter().lat;
      var dLat = (padM + 60) / 111320, dLng = (padM + 60) / (111320 * Math.cos(lat * Math.PI / 180));
      var query = "?north=" + (b.getNorth() + dLat).toFixed(6) + "&south=" + (b.getSouth() - dLat).toFixed(6) +
        "&east=" + (b.getEast() + dLng).toFixed(6) + "&west=" + (b.getWest() - dLng).toFixed(6);
      return api("GET", query, null, CANOPY_API).then(function (data) {
        var grids = (data && data.grids || []).map(function (g) {
          var raw = atob(g.heights), heights = new Uint8Array(raw.length);
          for (var i = 0; i < raw.length; i++) heights[i] = raw.charCodeAt(i);
          return { crs: g.crs, x0: g.x0, y0: g.y0, dx: g.dx, dy: g.dy, width: g.width, height: g.height, heights: heights };
        });
        return { grids: grids, credit: data && data.credit };
      }, function (error) {
        return { grids: null, why: "tree heights unavailable (" + (error && error.message || error) + ")" };
      });
    }

    /* Those heights on a picture: a 0/1 mask the size of it, or null with why. */
    function canopyMask(cap, canopy) {
      if (!canopy.grids) return { mask: null, why: canopy.why };
      var mask = shapes.heightMask({ width: cap.image.width, height: cap.image.height, z: cap.z, ox: cap.ox, oy: cap.oy }, canopy.grids, shapes.TREE_MIN_HEIGHT_M);
      if (mask && canopy.credit) canopyCredit = canopy.credit;
      return { mask: mask, why: mask ? "" : "no tree heights here" };
    }

    /* What one fairway or green needs off the network - its picture and its tree heights,
       both at once. */
    function nearPlayFetch(item, bandM, reuse) {
      var ring = outlineOf(item);
      return Promise.all([
        captureBox(ring, { mpp: NEAR_PLAY_MPP, padM: bandM, maxSidePx: TREE_FINDER_MAX_SIDE_PX, marginPx: 8, reuse: reuse }),
        canopyFor(ring, bandM)
      ]);
    }

    /* One fairway or green, its picture and heights in hand: where to look round it, and the
       finder over that. */
    function nearPlayRun(item, bandM, cap, canopy) {
      var ring = outlineOf(item);
      var w = cap.image.width, h = cap.image.height;
      function px(points) { return points.map(cap.toPx); }
      /* Only the shapes on this picture are painted - a course holds hundreds. */
      function onPicture(xy) {
        var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        xy.forEach(function (p) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); });
        return x1 >= 0 && y1 >= 0 && x0 < w && y0 < h;
      }
      var surfaces = [], woods = [], turf = [], avoid = [];
      session.features.forEach(function (f) {
        if (f.id === item.id) return;
        if (f.kind === "tree") {
          var c = cap.toPx(shapes.centroid(f.points));
          if (c.x > -50 && c.y > -50 && c.x < w + 50 && c.y < h + 50) avoid.push({ x: c.x, y: c.y, r: shapes.ringRadiusM(f.points) / cap.mpp });
          return;
        }
        var outline = SURFACE_KINDS.indexOf(f.kind) >= 0 || f.kind === "trees" ? outlineOf(f) : null;
        var xy = outline && px(outline);
        if (!xy || !onPicture(xy)) return;
        if (f.kind === "trees") woods.push(xy);
        else surfaces.push(xy);
        if (NEAR_PLAY_KINDS.indexOf(f.kind) >= 0) turf.push(xy);
      });
      var played = px(ring);
      turf.push(played);
      var radiusPx = shapes.TREE_AUTO_RADIUS_M / cap.mpp;
      var band = shapes.playBand(w, h, { play: [played], surfaces: surfaces, woods: woods, bandPx: bandM / cap.mpp, clearPx: shapes.TREE_CLEAR_M / cap.mpp });
      var heights = canopyMask(cap, canopy);
      var auto = shapes.autoTreeModel(cap.image, shapes.ringsMask(w, h, turf), band, { radiusPx: radiusPx, tall: heights.mask });
      var byHeight = [];
      if (heights.mask) {
        var tall = new Uint8Array(w * h);
        for (var i = 0; i < tall.length; i++) tall[i] = heights.mask[i] && band[i] ? 1 : 0;
        byHeight = shapes.treesInMask(tall, w, h, { radiusPx: radiusPx, avoid: avoid });
      }
      var finder = auto.model ? shapes.treeFinder(cap.image, auto.model, { radiusPx: radiusPx, inside: auto.allow, avoid: avoid }) : null;
      /* Every sensitivity at once (shapes.nestedTrees), so More / Less in the tree layer need
         nothing read again, as lat/lng: the picture can go. */
      function toTree(t, l, fromHeight) { var ll = cap.toLL(t); return { lat: ll.lat, lng: ll.lng, r: t.r * cap.mpp, l: l, h: fromHeight ? 1 : 0 }; }
      var found = (finder ? shapes.nestedTrees(finder) : []).map(function (t) { return toTree(t, t.l, false); })
        .concat(byHeight.map(function (t) { return toTree(t, 0, true); }));
      return { cap: cap, w: w, h: h, band: band, hole: item.hole, trees: found, why: heights.why };
    }

    function runNearPlay() {
      if (!canEdit()) { setStatus(scanning ? "Wait for the AI scan to finish." : "Still loading this course's overlay…"); return; }
      if (wandsRunning) return;
      var items = nearPlayShapes();
      if (!items.length) { setStatus("No fairways or greens " + (session.hole ? "on hole " + session.hole + " " : "") + "to look along yet - place them first.", true); return; }
      settle(true);
      var id = session.loadedFor, bandM = session.treeBandM || shapes.TREE_BAND_M;
      var runs = [], failed = 0, notes = {}, level = treeLevel(session.treeFinderLevel);
      wandsRunning++;
      updateHint();
      renderTreeAuto();
      /* The next shape's picture and heights load while this one is worked out, and tiles the
         last two pictures used are kept for the next to share. */
      var reuse = new Map(), recent = [], fetched = [];
      function fetchItem(k) {
        if (k < items.length && !fetched[k]) {
          fetched[k] = nearPlayFetch(items[k], bandM, reuse);
          fetched[k].catch(function () {});
        }
        return fetched[k];
      }
      function keepTiles(cap) {
        recent = recent.concat([cap.urls]).slice(-2);
        var keep = new Set([].concat.apply([], recent));
        Array.from(reuse.keys()).forEach(function (url) { if (!keep.has(url)) reuse.delete(url); });
      }
      var walk = items.reduce(function (prev, item, k) {
        return prev.then(function () {
          if (destroyed || session.loadedFor !== id) return;
          var where = (item.hole ? "hole " + item.hole + "'s " : "an unnumbered ") + item.kind;
          setStatus("Looking for trees along " + where + " (" + (k + 1) + " of " + items.length + ")…");
          return fetchItem(k).then(function (got) {
            keepTiles(got[0]);
            fetchItem(k + 1);
            var run = nearPlayRun(item, bandM, got[0], got[1]);
            /* Read: from here on the run needs where its pixels are, not the pixels. */
            got[0].image = null;
            return run;
          }).then(function (run) {
            runs.push(run);
            if (run.why) notes[run.why] = true;
            var n = run.trees.filter(function (t) { return t.h || t.l <= level; }).length;
            setStatus((item.hole ? "Hole " + item.hole : "Unnumbered") + " " + item.kind + ": " + n + " tree" + (n === 1 ? "" : "s") + (k + 1 < items.length ? " · looking at the next…" : "."));
          }, function (error) {
            failed++;
            notes[String(error && error.message || error)] = true;
          });
        });
      }, Promise.resolve());
      walk.then(function () {
        wandsRunning--;
        if (destroyed || session.loadedFor !== id) return;
        updateHint();
        renderTreeAuto();
        renderCredit();
        var said = Object.keys(notes);
        var note = (failed ? failed + " of " + items.length + " could not be read" + (said.length ? " (" + said.join("; ") + ")" : "") + "." : said.length ? "(" + said.join("; ") + ")" : "");
        if (!runs.length) { setStatus("The tree finder could not run" + (said.length ? ": " + said.join("; ") : "") + ".", true); return; }
        /* Into the course's tree layer: what was found here replaces whatever the layer had on
           the ground just looked at, and the rest of the course keeps its trees. */
        function looked(t) {
          return runs.some(function (run) {
            var p = run.cap.toPx(t), x = Math.floor(p.x), y = Math.floor(p.y);
            return x >= 0 && y >= 0 && x < run.w && y < run.h && run.band[y * run.w + x];
          });
        }
        var base = treeEdit ? treeEdit.all.filter(function (t) { return !t.gone; }) : trees.row ? unpackTrees(trees.row.trees) : [];
        var found = mergeTrees([].concat.apply([], runs.map(function (run) { return run.trees; })));
        var kept = base.filter(function (t) { return !looked(t); });
        var live = found.filter(function (t) { return t.h || t.l <= level; }).length;
        openTreeEdit(kept.concat(found), session.treeFinderLevel, true,
          "Found " + live + " tree" + (live === 1 ? "" : "s") + " near play" + (note ? " " + note : "") + ". More / Less (← →), click a tree to drop it, then Publish tree changes to put them on the watch.");
      });
    }

    /* ---- the course's trees ----
       A course's trees are their own layer (functions/lib/gd-course-trees-core.mjs), not
       shapes in the overlay: found by a tree run on the server after the course's first
       publish (or by Near play here), stored with every sensitivity at once, live on the watch
       at the layer's level. The Trees button says where that stands - none yet, being found,
       or done - and opens the layer for editing: More / Less move the level, a click drops a
       tree (and a second click keeps it), and Publish tree changes puts it live. */
    var trees = { id: "", row: null, job: null, timer: null };
    var treeEdit = null;
    var treeRenderer = null;
    var TREE_LEVELS = shapes.TREE_FINDER_LEVELS.length;

    function treeLevel(level) { return Math.max(0, Math.min(TREE_LEVELS - 1, Math.round(Number(level)) || 0)); }
    function unpackTrees(packed) {
      return (Array.isArray(packed) ? packed : []).filter(function (a) { return Array.isArray(a) && a.length >= 4 && Number(a[2]) > 0; })
        .map(function (a) { return { lat: Number(a[0]), lng: Number(a[1]), r: Number(a[2]), l: Number(a[3]) | 0, h: a[4] ? 1 : 0 }; });
    }
    function packTrees(list) { return list.map(function (t) { return [t.lat, t.lng, Math.round(t.r * 10) / 10, t.l, t.h ? 1 : 0]; }); }
    function liveTree(t, level) { return !t.gone && (t.h || t.l <= level); }
    /* Trees found on overlapping pictures as one each - the one found at the stricter level. */
    function mergeTrees(list) {
      var out = [];
      list.slice().sort(function (a, b) { return a.l - b.l; }).forEach(function (t) {
        if (!out.some(function (k) { return shapes.distanceM(k, t) < (k.r + t.r) * 0.75; })) out.push(t);
      });
      return out;
    }
    function treesRunning() { return !!(trees.job && (trees.job.status === "queued" || trees.job.status === "running")); }

    function loadTrees(id) {
      if (trees.timer) { clearTimeout(trees.timer); trees.timer = null; }
      if (trees.id !== id) { closeTreeEdit(true); trees = { id: id, row: null, job: null, timer: null }; renderTreesButton(); }
      if (!id) return;
      api("GET", "?courseId=" + encodeURIComponent(id), null, TREES_API).then(function (data) {
        if (destroyed || trees.id !== id) return;
        var wasRunning = treesRunning();
        trees.row = (data && data.row) || null;
        trees.job = (data && data.job) || null;
        renderTreesButton();
        if (treesRunning()) trees.timer = setTimeout(function () { loadTrees(id); }, 5000);
        else if (wasRunning) {
          if (trees.job && trees.job.status === "failed") setStatus("The tree run failed: " + (trees.job.error || "no reason given") + ".", true);
          else if (trees.row) setStatus("Trees found: " + unpackTrees(trees.row.trees).filter(function (t) { return liveTree(t, trees.row.level); }).length + " live on the watch. Click the tree button to make more or fewer.");
        }
      }).catch(function () { if (!destroyed && trees.id === id) renderTreesButton(); });
    }

    function renderTreesButton() {
      var b = el.trees;
      if (destroyed || !b) return;
      var running = treesRunning(), row = trees.row;
      b.classList.toggle("isTreesDone", !!row && !running);
      b.classList.toggle("isTreesBusy", running);
      b.classList.toggle("isActive", !!treeEdit);
      var stage = running && trees.job.stage ? /trees-hole-(\d+)-of-(\d+)/.exec(trees.job.stage) : null;
      var live = row ? unpackTrees(row.trees).filter(function (t) { return liveTree(t, row.level); }).length : 0;
      var title = !trees.id ? "Trees" : running ? "Finding this course's trees" + (stage ? " - hole " + stage[1] + " of " + stage[2] : "") + "…"
        : row ? live + " trees live on the watch (" + (row.status === "edited" ? "published from here" : "found automatically") + ")" + (row.publishedAt ? ", " + new Date(row.publishedAt).toLocaleString() : "") + " - click to make more or fewer, drop any, and publish"
        : "No trees yet - click to find them along the fairways and greens";
      b.title = title;
      b.setAttribute("aria-label", title);
    }

    function onTreesButton() {
      if (!session.loadedFor || !canEdit()) return;
      if (treeEdit) { closeTreeEdit(false); return; }
      if (treesRunning()) { setStatus(el.trees.title); return; }
      if (trees.row) { openTreeEdit(unpackTrees(trees.row.trees), trees.row.level, false, ""); return; }
      runTrees("Find the trees along this course's fairways and greens now?\n\nThey are read off its own frames, or Esri where it has none, and go live on the watch when found.");
    }

    function runTrees(question) {
      var id = trees.id;
      if (!id || !window.confirm(question)) return;
      accessToken().then(function (token) {
        return fetch(JOBS_API, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify({ courseId: id, kind: "find_trees" })
        });
      }).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          if (!res.ok) throw new Error((data && (data.detail || data.error)) || ("HTTP " + res.status));
          if (destroyed || trees.id !== id) return;
          closeTreeEdit(true);
          trees.job = { status: "queued" };
          renderTreesButton();
          setStatus(data && data.deduped ? "A tree run is already going for this course." : "Finding this course's trees - the tree button shows when they are done.");
          trees.timer = setTimeout(function () { loadTrees(id); }, 4000);
        });
      }).catch(function (error) {
        if (!destroyed) setStatus("Could not start the tree run: " + (error && error.message || error), true);
      });
    }

    function openTreeEdit(list, level, dirty, said) {
      settle(true);
      if (treeEdit) treeEdit.layer.remove();
      if (!treeRenderer) treeRenderer = L.canvas({ padding: 0.5 });
      treeEdit = { all: list.map(function (t) { return { lat: t.lat, lng: t.lng, r: t.r, l: t.l, h: t.h, gone: false }; }), level: treeLevel(level), dirty: !!dirty, layer: L.layerGroup().addTo(mapObj) };
      drawTreeEdit();
      renderTreesButton();
      updateHint();
      setStatus(said || treeEditText() + ". More / Less (← →), click a tree to drop it, then Publish tree changes.");
    }

    function closeTreeEdit(silent) {
      if (!treeEdit) return true;
      if (!silent && treeEdit.dirty && !window.confirm("Drop the tree changes you have not published?")) return false;
      treeEdit.layer.remove();
      treeEdit = null;
      if (!destroyed) { el["tree-bar"].hidden = true; renderTreesButton(); updateHint(); }
      return true;
    }

    function treeEditText() {
      var live = treeEdit.all.filter(function (t) { return liveTree(t, treeEdit.level); }).length;
      var dropped = treeEdit.all.filter(function (t) { return t.gone; }).length;
      return live + " tree" + (live === 1 ? "" : "s") + (dropped ? " (" + dropped + " dropped)" : "") + " · sensitivity " + (treeEdit.level + 1) + " of " + TREE_LEVELS + (treeEdit.dirty ? " · not published" : "");
    }

    function drawTreeEdit() {
      treeEdit.layer.clearLayers();
      treeEdit.all.forEach(function (t) {
        if (!t.gone && !liveTree(t, treeEdit.level)) return;
        var circle = L.circle([t.lat, t.lng], t.gone
          ? { renderer: treeRenderer, radius: t.r, color: "#ff6a6a", weight: 1, dashArray: "3 3", fillOpacity: 0, interactive: true }
          : { renderer: treeRenderer, radius: t.r, color: "#7dff9a", weight: 1.5, fillColor: "#1f8a3c", fillOpacity: 0.45, interactive: true });
        circle.on("click", function (e) {
          if (e && e.originalEvent) L.DomEvent.stop(e.originalEvent);
          t.gone = !t.gone;
          treeEdit.dirty = true;
          drawTreeEdit();
        });
        treeEdit.layer.addLayer(circle);
      });
      el["tree-bar"].hidden = false;
      el["tree-text"].textContent = treeEditText();
      el["tree-less"].disabled = treeEdit.level <= 0;
      el["tree-more"].disabled = treeEdit.level >= TREE_LEVELS - 1;
      el["tree-publish"].disabled = !treeEdit.dirty;
    }

    function stepTreeLevel(by) {
      var next = treeLevel(treeEdit.level + by);
      if (next === treeEdit.level) { setStatus(by < 0 ? "That is as strict as the finder goes." : "That is as loose as the finder goes."); return; }
      treeEdit.level = next;
      session.treeFinderLevel = next;
      treeEdit.dirty = true;
      drawTreeEdit();
      remember();
    }

    function publishTrees() {
      if (!treeEdit || !treeEdit.dirty) return;
      var id = trees.id, keep = treeEdit.all.filter(function (t) { return !t.gone; }), level = treeEdit.level;
      el["tree-publish"].disabled = true;
      setStatus("Publishing the trees…");
      api("POST", "", { courseId: id, action: "publish", trees: packTrees(keep), level: level }, TREES_API).then(function (data) {
        if (destroyed || trees.id !== id) return;
        trees.row = (data && data.row) || trees.row;
        if (treeEdit) { treeEdit.all = keep; treeEdit.dirty = false; drawTreeEdit(); }
        renderTreesButton();
        var live = keep.filter(function (t) { return t.h || t.l <= level; }).length;
        setStatus("Published " + live + " tree" + (live === 1 ? "" : "s") + ". The Garmin map rebuilds with them by itself; Apple Watch maps take them on their next Generate.");
      }).catch(function (error) {
        if (destroyed) return;
        if (treeEdit) el["tree-publish"].disabled = false;
        setStatus("The trees did not publish: " + (error && error.message || error), true);
      });
    }

    /* ---- the colour wand ----
       Like Instant Alpha in Preview: press on the thing and drag - the further from the press,
       the more of that colour it takes in (connected to where you pressed). Shift-drag adds to
       what is already picked. The pick is shown over the map until Enter makes it a shape of
       the tool in hand; left and right tighten or loosen the last drag; Esc drops it. The
       picture is the view on screen, read once and reused until the map moves. The outline
       keeps its detail (shapes.DETAIL_MAX_POINTS) - it is reshaped by its key corners and by
       bending its edge, not corner by corner. */

    /* What the colour wand's pick becomes, in a sentence: "a green", "a wood". */
    function colourNoun(kind) { return kind === "trees" ? "a wood" : "a " + kindLabel(kind).toLowerCase(); }
    /* What to press on: "the green", "the trees". */
    function colourThing(kind) { return kind === "trees" ? "trees" : kindLabel(kind).toLowerCase(); }
    /* The key that steps the tool in hand through its methods. */
    function methodKey(kind) { return { hazard: "X", waste: "A", trees: "E" }[kind] || kind.charAt(0).toUpperCase(); }

    function colourCapture() {
      var b = mapObj.getBounds(), z = Math.round(mapObj.getZoom());
      var key = b.toBBoxString() + "|" + z + "|" + session.sourceKey;
      if (colourCap && colourCap.key === key) return colourCap.promise;
      var nw = b.getNorthWest(), se = b.getSouthEast();
      var promise = captureBox([{ lat: nw.lat, lng: nw.lng }, { lat: se.lat, lng: se.lng }], { z: z, maxSidePx: COLOUR_WAND_MAX_SIDE_PX, marginPx: 0 }).then(function (cap) {
        cap.field = shapes.colourField(cap.image, 1);
        return cap;
      });
      colourCap = { key: key, promise: promise };
      promise.catch(function () { if (colourCap && colourCap.promise === promise) colourCap = null; });
      return promise;
    }

    function beginColourWand(event) {
      var ll = mapObj.mouseEventToLatLng(event);
      colourPress = { latlng: { lat: ll.lat, lng: ll.lng }, x: event.clientX, y: event.clientY, tol: COLOUR_WAND_TOL_START, add: !!event.shiftKey, cap: null, frame: 0, done: false };
      var press = colourPress;
      document.addEventListener("pointermove", onColourMove);
      document.addEventListener("pointerup", onColourEnd);
      document.addEventListener("pointercancel", onColourEnd);
      wandsRunning++;
      updateHint();
      colourCapture().then(function (cap) {
        if (destroyed || press.cancelled) return;
        press.cap = cap;
        press.seed = cap.toPx(press.latlng);
        /* Shift-drag adds within one picture; once the map has moved it starts afresh. */
        press.base = press.add && colourSel && colourSel.cap === cap ? colourSel.mask : null;
        showColourPress(press);
        if (press.done) finishColourPress(press);
      }, function (error) {
        if (!destroyed) setStatus("The colour wand could not read the imagery: " + (error && error.message || error) + ".", true);
      }).then(function () {
        wandsRunning--;
        if (!destroyed) updateHint();
      });
    }

    function onColourMove(event) {
      var press = colourPress;
      if (!press || destroyed) return;
      press.tol = Math.min(COLOUR_WAND_TOL_MAX, COLOUR_WAND_TOL_START + Math.hypot(event.clientX - press.x, event.clientY - press.y) * COLOUR_WAND_TOL_PER_PX);
      if (press.frame || !press.cap) return;
      press.frame = requestAnimationFrame(function () { press.frame = 0; if (!destroyed && colourPress === press) showColourPress(press); });
    }

    function onColourEnd(event) {
      document.removeEventListener("pointermove", onColourMove);
      document.removeEventListener("pointerup", onColourEnd);
      document.removeEventListener("pointercancel", onColourEnd);
      var press = colourPress;
      colourPress = null;
      if (destroyed || !press) return;
      if (press.frame) { cancelAnimationFrame(press.frame); press.frame = 0; }
      dragEndedAt = Date.now();
      syncMapDragging();
      if (event.type === "pointercancel") {
        press.cancelled = true;
        if (!colourSel) clearColourOverlay(); else drawColourOverlay(colourSel.cap, colourSel.mask);
        return;
      }
      press.done = true;
      if (press.cap) finishColourPress(press);
    }

    function colourMask(press) {
      var mask = shapes.floodSelect(press.cap.field, press.seed.x, press.seed.y, press.tol);
      if (press.base) for (var i = 0; i < mask.length; i++) if (press.base[i]) mask[i] = 1;
      return mask;
    }

    function showColourPress(press) {
      drawColourOverlay(press.cap, colourMask(press));
    }

    function finishColourPress(press) {
      var mask = colourMask(press);
      colourSel = { cap: press.cap, seed: press.seed, tol: press.tol, base: press.base, mask: mask };
      drawColourOverlay(press.cap, mask);
      updateHint();
      setStatus("Enter makes it " + colourNoun(tool) + " · ← → tighter / looser · Shift-drag adds more · Esc drops it.");
    }

    function stepColourTolerance(by) {
      var sel = colourSel;
      sel.tol = Math.max(1, Math.min(COLOUR_WAND_TOL_MAX, sel.tol * (by > 0 ? 1.18 : 1 / 1.18)));
      sel.mask = colourMask({ cap: sel.cap, seed: sel.seed, tol: sel.tol, base: sel.base });
      drawColourOverlay(sel.cap, sel.mask);
      setStatus("Colour tolerance " + Math.round(sel.tol) + ". Enter makes it " + colourNoun(tool) + ".");
    }

    /* The pick drawn over the map as a tinted picture on the capture's own footprint, coarser
       than the capture so redrawing it while dragging stays quick. */
    var colourOverlay = null;
    function drawColourOverlay(cap, mask) {
      var w = cap.image.width, h = cap.image.height;
      var step = Math.max(1, Math.ceil(Math.max(w, h) / 700));
      var cw = Math.ceil(w / step), ch = Math.ceil(h / step);
      var canvas = document.createElement("canvas");
      canvas.width = cw; canvas.height = ch;
      var ctx = canvas.getContext("2d"), img = ctx.createImageData(cw, ch), px = img.data;
      for (var y = 0; y < ch; y++) {
        for (var x = 0; x < cw; x++) {
          if (!mask[Math.min(h - 1, y * step) * w + Math.min(w - 1, x * step)]) continue;
          var i = (y * cw + x) * 4;
          px[i] = 255; px[i + 1] = 150; px[i + 2] = 40; px[i + 3] = 120;
        }
      }
      ctx.putImageData(img, 0, 0);
      var url = canvas.toDataURL("image/png");
      var a = cap.toLL({ x: 0, y: 0 }), b = cap.toLL({ x: w, y: h });
      var bounds = L.latLngBounds([a.lat, a.lng], [b.lat, b.lng]);
      if (colourOverlay && colourOverlay.cap === cap) { colourOverlay.layer.setUrl(url); return; }
      clearColourOverlay();
      colourOverlay = { cap: cap, layer: L.imageOverlay(url, bounds, { interactive: false }).addTo(mapObj) };
    }

    function clearColourOverlay() {
      if (colourOverlay) { try { mapObj.removeLayer(colourOverlay.layer); } catch (e) {} }
      colourOverlay = null;
    }

    function clearColourSel() {
      colourSel = null;
      clearColourOverlay();
      updateHint();
    }

    function keepColourSel() {
      var sel = colourSel, cap = sel.cap, kind = tool;
      var ring = shapes.maskOutline(sel.mask, cap.image.width, cap.image.height, shapes.DETAIL_MAX_POINTS);
      clearColourSel();
      if (!ring) { setStatus("Nothing picked yet - press on it and drag.", true); return; }
      var points = ring.map(cap.toLL);
      if (full(kind)) return;
      var merged = kind === "bunker" ? mergeBunker(points, session.hole, null, true) : null;
      if (merged) { lastPlacedId = merged.id; drawFeatures(); changed(); setStatus("Bunker joined the one it overlaps. Grab its edge in Move to tidy it."); return; }
      var f = addFeature({ kind: kind, points: points, source: "colour" });
      var joined = sealSeams(f);
      if (joined) { drawFeatures(); changed(); }
      setStatus(kindLabel(kind) + " placed" + seamWords(joined) + ". Grab its edge in Move to tidy it.");
    }

    /* ---- the wand's size ----
       One size per wand kind. The − and + here set it for the next click; on a wand shape just
       placed they (and up / down) run the wand again at the new size. */

    function wandKind() { return WAND_KINDS.indexOf(tool) >= 0 ? tool : "green"; }

    function renderWandSize() {
      var kind = wandKind(), size = session.wandSize[kind];
      if (growWanding()) {
        var reachSize = session.lineWandSize[tool];
        el["wand-size-name"].textContent = tool === "waste" ? "Grow reach" : (tool === "water" ? "Water" : kindLabel(tool)) + " line wand reach";
        el["wand-size"].textContent = Math.round(LINE_WAND_REACH_M[tool] * reachSize) + "m";
        el["wand-smaller"].disabled = reachSize <= LINE_WAND_SIZES[0];
        el["wand-bigger"].disabled = reachSize >= LINE_WAND_SIZES[LINE_WAND_SIZES.length - 1];
        return;
      }
      var sizes = wandSizes(kind);
      el["wand-size-name"].textContent = (kind === "water" ? "Water" : kindLabel(kind)) + " wand";
      el["wand-size"].textContent = pct(size);
      el["wand-smaller"].disabled = size <= sizes[0];
      el["wand-bigger"].disabled = size >= sizes[sizes.length - 1];
    }

    function stepIn(list, value, by) {
      var at = list.indexOf(value);
      if (at < 0) at = list.indexOf(1);
      return list[Math.max(0, Math.min(list.length - 1, at + by))];
    }
    function nextWandSize(size, by, kind) { return stepIn(wandSizes(kind), size, by); }

    function stepWandSize(by) {
      if (growWanding()) {
        if (adjusted() && adjust.grow && adjust.kind === tool) { stepSize(by); return; }
        session.lineWandSize[tool] = stepIn(LINE_WAND_SIZES, session.lineWandSize[tool], by);
        renderWandSize();
        remember();
        setStatus(kindLabel(tool) + (tool === "waste" ? " grows up to " : " line wand reaches ") + Math.round(LINE_WAND_REACH_M[tool] * session.lineWandSize[tool]) + (tool === "waste" ? "m past what you draw - the next one uses it." : "m from the line - the next line uses it."));
        return;
      }
      var kind = wandKind();
      if (adjusted() && adjust.seed && adjust.kind === kind) { stepSize(by); return; }
      session.wandSize[kind] = nextWandSize(session.wandSize[kind], by, kind);
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
       it ran at), line (a fairway's centre line), grow (a shape grown from a line or a drawn
       area: what it grew from, the reach and the picture), base (anything else: the outline to
       scale). */
    function startAdjust(f, opts) {
      settle();
      if (!f || f.pin) return;
      adjust = {
        id: f.id, kind: f.kind, seed: opts.seed || null, size: opts.size || 1, line: opts.line || null,
        base: opts.base || null, grow: opts.grow || null, steps: 0, candidates: [], index: 0, running: false,
        /* ↑ ↓ on a green or fairway: the outline they grow from, and how many presses out. */
        reshape: null
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
      } else {
        var joined = sealSeams(f);
        if (joined) changed();
        if (joined) setStatus(kindLabel(f.kind) + " kept" + seamWords(joined) + ".");
        else if (!quiet) setStatus(kindLabel(f.kind) + " kept.");
      }
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
      /* The new edge is what bigger / smaller now grow from, by the presses already made. */
      if (adjust.reshape) { adjust.reshape.base = f.points.slice(); if (adjust.reshape.steps) applyReshape(f, adjust.reshape, adjust.reshape.steps); }
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
      if (RESHAPE[f.kind]) { reshapeStep(f, by, adjust.reshape || (adjust.reshape = { base: f.points.slice(), steps: 0 })); return; }
      if (adjust.seed) { rerunWand(f, by); return; }
      if (adjust.grow) { regrow(f, by); return; }
      if (!adjust.base) adjust.base = f.points.slice();
      var steps = Math.max(-6, Math.min(6, adjust.steps + by));
      if (steps === adjust.steps) { setStatus(by < 0 ? "That is as small as it goes - drag its corners for more." : "That is as big as it goes - drag its corners for more."); return; }
      adjust.steps = steps;
      f.points = shapes.scaleAbout(adjust.base, Math.pow(SCALE_STEP, steps));
      /* The next tree is dropped at the size this one was left at. */
      if (f.kind === "tree") {
        session.treeRadius = Math.round(shapes.ringRadiusM(f.points) * 10) / 10;
        remember();
        setStatus("Tree " + Math.round(session.treeRadius * 2) + "m across - the next one starts at this size.");
      }
      drawFeatures();
      changed();
      updateHint();
    }

    /* Up or down on a green or a fairway: the shape as it is, grown or shrunk evenly - never the
       wand run again, which drifts a green rounder. Counted from the outline it had when the
       first press came, so up then down is exactly where it started. r is {base, steps}: the
       live shape's (adjust.reshape), or a selected saved one's (selReshape). */
    function reshapeGrowM(kind, steps) {
      var spec = RESHAPE[kind];
      return spec.closeM && steps > 0 ? (steps - 1) * spec.stepM : steps * spec.stepM;
    }
    function applyReshape(f, r, steps) {
      var spec = RESHAPE[f.kind];
      if (!steps) { f.points = r.base.slice(); return true; }
      var ring = shapes.reshapeOutline([r.base], { growM: reshapeGrowM(f.kind, steps), closeM: spec.closeM });
      if (!ring) return false;
      f.points = shapes.smoothOutline(ring, f.kind);
      return true;
    }
    function reshapeStep(f, by, r) {
      var spec = RESHAPE[f.kind];
      var steps = Math.max(-spec.max, Math.min(spec.max, r.steps + by));
      if (steps === r.steps || !applyReshape(f, r, steps)) {
        setStatus(by < 0 ? "That is as small as it goes - drag its edge for more." : "That is as big as it goes - drag its edge for more.");
        return;
      }
      r.steps = steps;
      f.source = f.source || "wand";
      drawFeatures();
      changed();
      updateHint();
      setStatus(kindLabel(f.kind) + " " + reshapeWords(f.kind, steps) + ".");
    }
    /* The same on a saved green or fairway, selected in Move: ↑ ↓ size it instead of panning.
       Its starting outline is kept while the presses run; once anything else changes the shape
       - a drag, an undo, a save swapping in the server's copy - the next press starts afresh. */
    var selReshape = null;
    function stepSelectedSize(by) {
      var f = selectedId && tool === "move" && canEdit() ? findFeature(selectedId) : null;
      if (!f || f.pin || !RESHAPE[f.kind] || f.points.length < 3) return false;
      if (!selReshape || selReshape.id !== f.id || selReshape.last !== f.points) selReshape = { id: f.id, base: f.points.slice(), steps: 0, last: null };
      reshapeStep(f, by, selReshape);
      selReshape.last = f.points;
      return true;
    }

    function reshapeWords(kind, steps) {
      if (!steps) return "back to the edge the wand found";
      var grow = reshapeGrowM(kind, steps);
      var smooth = RESHAPE[kind].closeM ? "cut-ins smoothed" : "";
      var size = grow ? (grow > 0 ? grow + "m bigger" : -grow + "m smaller") + " all round" : "";
      return [smooth, size].filter(Boolean).join(", ");
    }

    /* Up or down on a wand shape: the wand again on the same click, a size step smaller or
       bigger. The size sticks for the next one of that kind. */
    function rerunWand(f, by) {
      var kind = f.kind;
      var size = nextWandSize(adjust.size, by, kind);
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
      if (adjust.grow) {
        if (adjust.grow.line) adjust.grow.line = adjust.grow.line.map(move);
        if (adjust.grow.ring) adjust.grow.ring = adjust.grow.ring.map(move);
      }
      if (adjust.base) adjust.base = adjust.base.map(move);
      if (adjust.reshape) adjust.reshape.base = adjust.reshape.base.map(move);
      adjust.candidates = adjust.candidates.map(function (ring) { return ring.map(move); });
    }

    /* Arrow keys, Enter, Space and Esc belong to the live shape while there is one - or the
       trees the finder just dropped, or the colour wand's pick - ahead of the map's own
       arrow-key panning, hence the capture phase. */
    function onAdjustKey(event) {
      if (!(adjust || finder || colourSel || selectedId || treeEdit) || event.metaKey || event.ctrlKey || event.altKey) return;
      var target = event.target;
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
      if (!containerEl.isConnected || !canEdit() || drag) return;
      var key = event.key;
      /* The tree layer, open for editing, has the arrows to itself. */
      if (treeEdit && !adjust && !finder && !colourSel) {
        if (key === "ArrowLeft") stepTreeLevel(-1);
        else if (key === "ArrowRight") stepTreeLevel(1);
        else if (key === "Escape") closeTreeEdit(false);
        else return;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (finder || colourSel) {
        var live = finder ? { step: stepFinder, keep: function () { keepFinder(false); }, drop: discardFinder }
          : { step: stepColourTolerance, keep: keepColourSel, drop: function () { clearColourSel(); setStatus("Colour pick dropped."); } };
        if (key === "ArrowLeft") live.step(-1);
        else if (key === "ArrowRight") live.step(1);
        else if (key === "Enter" || key === " " || key === "Spacebar") live.keep();
        else if (key === "Escape") live.drop();
        else return;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!adjusted()) {
        if ((key === "ArrowUp" || key === "ArrowDown") && stepSelectedSize(key === "ArrowUp" ? 1 : -1)) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
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
      if (open && el.menu.hidden) loadInbox();
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
      /* Empty ground under the Link tool does nothing: the pick waits for Enter or Esc. */
      if (tool === "connect" || tool === "number" || tool === "order") return;
      if (tool === "move") { if (selectedId) select(""); return; }
      if (!canEdit()) { setStatus(scanning ? "Wait for the AI scan to finish." : "Still loading this course's overlay…"); return; }
      if (methodOf(tool) === "auto") { setStatus("Find trees near play looks along every fairway and green on its own - press the button up top.", false); return; }
      if (full(methodOf(tool) === "single" ? "tree" : tool)) return;
      /* Moving on to the next shape keeps the one just placed. A click with the colour wand
         is a press too short to drag - its pick stays. */
      settle(pressGesture() === "colour");
      var point = { lat: latlng.lat, lng: latlng.lng };
      if (lineTool()) addDraftPoint(point);
      else if (methodOf(tool) === "single") placeTree(point);
      else if (pressGesture()) setStatus(pressHint());
      else if (session.mode === "pins") {
        addFeature({ kind: tool, pin: true, points: [point] });
        setStatus(kindLabel(tool) + " pinned.");
      }
      else if (WAND_KINDS.indexOf(tool) >= 0) placeWand(point, tool);
      else if (tool === "tee") {
        var tee = addFeature({ kind: "tee", points: shapes.teeAt(point) });
        startAdjust(tee, { base: tee.points.slice() });
      }
    }

    /* What a press-and-drag tool wants, said when it is only clicked. */
    function pressHint() {
      var m = methodOf(tool);
      if (m === "oval") return "Press and drag across the cluster of trees to stretch an oval over it.";
      if (m === "find") return "Drag a box over the ground to look for trees in.";
      if (m === "colour") return colourSel ? "Enter makes the pick " + colourNoun(tool) + " · drag again to change it · Shift-drag adds." : "Press on the " + colourThing(tool) + " and drag - the further you drag, the more it takes.";
      var noun = tool === "trees" ? "trees" : tool === "waste" ? "waste area" : kindLabel(tool).toLowerCase();
      return "Press and drag all the way round the " + noun + " to outline it.";
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
        var preview = session.mode === "shapes" && draftKind === "fairway" && session.method.fairway === "width" ? shapes.fairwayFromLine(line, session.fairwayWidth) : null;
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
      if (!draft.length) draftKind = tool;
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
      draftKind = "";
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
      var kind = draftKind || "fairway";
      cancelDraft();
      if (session.mode === "shapes" && session.method[kind] === "line") { growPlace({ line: line }, kind); return; }
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

    /* ---- seams ----
       A shape kept beside another (SEAM_KINDS) meets it in the middle of any small gap or thin
       overlap, and the line there becomes the same corners in both (shapes.seamPair). Corners
       a shape already shares with a third one are locked, so one seam never breaks another. */

    function canSeam(f) { return !!f && !f.pin && SEAM_KINDS.indexOf(f.kind) >= 0 && f.points.length >= 3; }

    /* Every corner on the map, by its exact coordinates: the ids of the shapes that have it. */
    function cornerOwners() {
      var owners = {};
      session.features.forEach(function (f) {
        f.points.forEach(function (p) { var k = shapes.pointKey(p); (owners[k] = owners[k] || []).push(f.id); });
      });
      return owners;
    }

    /* Which of f's corners are shared with a shape other than `other`. */
    function lockedCorners(f, other, owners) {
      return f.points.map(function (p) {
        return (owners[shapes.pointKey(p)] || []).some(function (id) { return id !== f.id && id !== other.id; });
      });
    }

    function nearBox(f, g, metres) {
      var a = L.latLngBounds(toLatLngs(f.points)), b = L.latLngBounds(toLatLngs(g.points));
      var dLat = metres / 111320, dLng = dLat / Math.max(0.2, Math.cos(a.getCenter().lat * Math.PI / 180));
      return a.getSouth() - dLat <= b.getNorth() && b.getSouth() <= a.getNorth() + dLat && a.getWest() - dLng <= b.getEast() && b.getWest() <= a.getEast() + dLng;
    }

    /* Join f to every seamable shape it meets. Returns how many it joined. */
    function sealSeams(f) {
      if (!session.seams || !canSeam(f)) return 0;
      var joined = 0;
      session.features.forEach(function (g) {
        if (g === f || !canSeam(g) || !nearBox(f, g, shapes.SEAM_GAP_M * 1.5)) return;
        var owners = cornerOwners();
        var res = shapes.seamPair(f.points, g.points, { lockedA: lockedCorners(f, g, owners), lockedB: lockedCorners(g, f, owners), maxPoints: MAX_POINTS });
        if (!res) return;
        f.points = res.a;
        g.points = res.b;
        joined++;
      });
      return joined;
    }

    function seamWords(joined) { return !joined ? "" : joined === 1 ? " - joined to the shape beside it" : " - joined to the " + joined + " shapes beside it"; }

    /* A bunker outline joins every placed bunker it overlaps, when merging is on: the first
       one it touches takes the merged outline and the rest go. Returns that bunker, or null
       when it overlapped none. `except` is a feature the outline must not merge with (the pin
       it came from). `detailed`: the outline is the colour wand's, and the merged bunker keeps
       its detail rather than becoming a smooth one - as it does when any bunker it joins is. */
    function mergeBunker(points, hole, except, detailed) {
      if (!session.mergeBunkers) return null;
      var into = null, merged = points;
      session.features.slice().forEach(function (f) {
        if (f.kind !== "bunker" || f.pin || f === except) return;
        var ring = shapes.mergeOverlapping(f.points, merged, shapes.DETAIL_MAX_POINTS);
        if (!ring) return;
        merged = ring;
        if (f.source === "colour" || f.source === "osm") detailed = true;
        if (!into) { into = f; return; }
        if (!into.hole && f.hole) into.hole = f.hole;
        if (!into.link && f.link) into.link = f.link;
        session.features =session.features.filter(function (g) { return g !== f; });
        if (selectedId === f.id) selectedId = "";
      });
      if (!into) return null;
      into.points = detailed ? merged : shapes.smoothOutline(merged, "bunker");
      into.source = detailed ? "colour" : "wand";
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
        if (full(kind)) return;
        var word = kindLabel(kind);
        var f = addFeature({ kind: kind, points: wandShape(kind, point, result), source: result.shape ? "wand" : "", hole: hole });
        startAdjust(f, { seed: point, wand: result, size: size });
        setStatus(result.shape ? word + " placed. " + result.note : result.note + " Placed a round " + word.toLowerCase() + " instead.", !result.shape);
      });
    }

    /* ---- growing: the line wand and the area wand ----
       A line laid down the middle of a fairway, a bunker or water (GDOverlayShapes.growFromLine),
       or a rough shape drawn round a waste area (growFromArea), grown out to the surface's edge
       in the browser from the imagery - no server round trip, so up / down (reach) and left /
       right (sensitivity) answer at once. `grow` is {line} or {ring}: what it grows from. The
       picture is kept on the live shape so up / down only grows again; it is captured afresh
       only when the reach outgrows it. */

    /* The picture over some points: tiles at one zoom, stitched, unscaled, with the points'
       pixel <-> lat/lng conversions. opts: z (that zoom; otherwise the zoom nearest `mpp` metres
       a pixel the provider has), padM (metres of room round the points), marginPx (extra pixels
       of room, 24 unless given), maxSidePx (one zoom coarser until the picture fits), reuse
       (tiles shared with other pictures - see stitchTiles; the picture's own come back as
       its `urls`). */
    function captureBox(points, opts) {
      return new Promise(function (resolve, reject) {
        var refused = captureRefusal();
        if (refused) return reject(new Error(refused));
        var native = num(layer.options && layer.options.maxNativeZoom) || num(layer.options && layer.options.maxZoom) || 19;
        var mid = points[Math.floor(points.length / 2)];
        var mppZ0 = 156543.03392 * Math.cos(mid.lat * Math.PI / 180);
        var z = opts.z != null ? Math.max(14, Math.min(native, opts.z)) : Math.max(14, Math.min(native, Math.round(Math.log2(mppZ0 / opts.mpp))));
        var margin = opts.marginPx != null ? opts.marginPx : 24;
        var box;
        for (;;) {
          var mpp = mppZ0 / Math.pow(2, z), pad = (opts.padM || 0) / mpp + margin;
          var pts = points.map(function (p) { return mapObj.project(L.latLng(p.lat, p.lng), z); });
          box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, z: z, mpp: mpp };
          pts.forEach(function (q) { box.x0 = Math.min(box.x0, q.x - pad); box.y0 = Math.min(box.y0, q.y - pad); box.x1 = Math.max(box.x1, q.x + pad); box.y1 = Math.max(box.y1, q.y + pad); });
          if ((box.x1 - box.x0 <= opts.maxSidePx && box.y1 - box.y0 <= opts.maxSidePx) || z <= 14) break;
          z--;
        }
        var tx0 = Math.floor(box.x0 / 256), ty0 = Math.floor(box.y0 / 256), tx1 = Math.floor(box.x1 / 256), ty1 = Math.floor(box.y1 / 256);
        stitchTiles(z, tx0, ty0, tx1, ty1, opts.reuse).then(function (out) {
          if (out.failed) return reject(new Error(out.failed === out.tiles ? "no imagery loaded here" : out.failed + " of " + out.tiles + " tiles did not load"));
          var image;
          try { image = out.canvas.getContext("2d").getImageData(0, 0, out.canvas.width, out.canvas.height); }
          catch (e) { return reject(new Error("this provider's tiles cannot be read back (no CORS) - switch provider")); }
          var ox = tx0 * 256, oy = ty0 * 256;
          resolve({
            image: image, z: z, mpp: box.mpp, ox: ox, oy: oy, urls: out.urls,
            toPx: function (p) { var q = mapObj.project(L.latLng(p.lat, p.lng), z); return { x: q.x - ox, y: q.y - oy }; },
            toLL: function (q) { var ll = mapObj.unproject(L.point(q.x + ox, q.y + oy), z); return { lat: ll.lat, lng: ll.lng }; }
          });
        });
      });
    }

    function growFrom(grow) { return grow.line || grow.ring; }

    /* Grow at a reach, on a capture that covers it. Resolves {capture, result} where result is
       shaped like the point wand's: {shape, candidates (lat/lng), pick, note}. A drawn waste area
       keeps the shape as drawn as its first candidate, so left goes all the way back to it. */
    function growRun(grow, kind, size, capture) {
      var reachM = LINE_WAND_REACH_M[kind] * size;
      var from = growFrom(grow);
      var noun = grow.line ? "line wand" : "grow";
      var fresh = capture && capture.reachM >= reachM && capture.from === from ? Promise.resolve(capture)
        : captureBox(from, { padM: reachM, mpp: LINE_WAND_MPP[kind], maxSidePx: LINE_WAND_MAX_SIDE_PX }).then(function (cap) { cap.from = from; cap.reachM = reachM; return cap; });
      wandsRunning++;
      updateHint();
      return fresh.then(function (cap) {
        var opts = {
          reachPx: reachM / cap.mpp,
          blurPx: Math.max(1, Math.round(0.6 / cap.mpp)),
          openPx: Math.max(1, Math.round((kind === "bunker" ? 0.6 : 1.5) / cap.mpp)),
          minAreaPx: Math.round((kind === "bunker" ? 6 : kind === "waste" ? 20 : 60) / (cap.mpp * cap.mpp))
        };
        var grown = grow.line ? shapes.growFromLine(cap.image, from.map(cap.toPx), opts) : shapes.growFromArea(cap.image, from.map(cap.toPx), opts);
        var candidates = grown.candidates.map(function (ring) { return ring.map(cap.toLL); });
        var pick = grown.pick;
        if (grow.ring) { candidates.unshift(grow.ring); pick = candidates.length > 1 ? pick + 1 : 0; }
        var found = grown.candidates.length > 0;
        return {
          capture: cap,
          result: candidates.length
            ? { shape: candidates[pick], candidates: candidates, pick: pick, note: !found ? "Found no edge to grow to - kept it as drawn." : grown.stable ? "" : "The " + noun + " was unsure of this edge - check it." }
            : { shape: null, note: "The line wand found no edge along this line (" + (grown.reason || "no answer") + ")." }
        };
      }, function (error) {
        return { capture: null, result: grow.ring ? { shape: grow.ring, candidates: [grow.ring], pick: 0, note: "Could not grow it (" + (error && error.message || error) + ") - kept it as drawn." } : { shape: null, note: "The line wand could not run: " + (error && error.message || error) + "." } };
      }).then(function (out) {
        wandsRunning--;
        if (!destroyed) updateHint();
        return out;
      });
    }

    function growPlace(grow, kind) {
      var id = session.loadedFor;
      var hole = session.hole;
      var size = session.lineWandSize[kind];
      var from = growFrom(grow);
      var marker = (grow.line ? L.polyline(toLatLngs(from), STYLE.draft) : L.polygon(toLatLngs(from), STYLE.lassoWaste)).addTo(mapObj);
      marker.bindTooltip(grow.line ? "Growing the " + kindLabel(kind).toLowerCase() + " out from the line…" : "Growing it out to the edge…", { permanent: true, direction: "top", className: "gdStudioOverlayLabel" });
      growRun(grow, kind, size, null).then(function (out) {
        try { mapObj && mapObj.removeLayer(marker); } catch (e) {}
        if (destroyed || session.loadedFor !== id) return;
        if (full(kind)) return;
        var result = out.result, word = kindLabel(kind);
        var points = result.shape ? shapes.smoothOutline(result.shape, kind) : kind === "fairway" ? shapes.fairwayFromLine(from, session.fairwayWidth) : null;
        if (!points) { setStatus(result.note, true); return; }
        var wanded = result.shape && result.shape !== grow.ring;
        var f = addFeature({ kind: kind, points: points, source: wanded ? "wand" : "", hole: hole });
        startAdjust(f, { wand: result.shape ? result : null, grow: { line: grow.line || null, ring: grow.ring || null, size: size, capture: out.capture }, line: kind === "fairway" && !result.shape ? from : null });
        var how = grow.line ? " grown from the line." : " grown out to its edge.";
        setStatus(result.shape ? word + how + " ← → sensitivity, ↑ ↓ " + (RESHAPE[kind] ? "smooth and size" : "reach") + ". " + result.note : result.note + (kind === "fairway" ? " Placed a fairway of the set width instead." : ""), !result.shape);
      });
    }

    /* Up or down on a grown shape: grow again from the same line or drawn shape with more or
       less reach. */
    function regrow(f, by) {
      var mine = adjust, g = mine.grow, kind = f.kind;
      var size = stepIn(LINE_WAND_SIZES, g.size, by);
      if (size === g.size) { setStatus(by < 0 ? "That is the shortest it reaches." : "That is the furthest it reaches."); return; }
      session.lineWandSize[kind] = size;
      renderWandSize();
      remember();
      mine.running = true;
      updateHint();
      var id = session.loadedFor;
      /* A shape dragged since it was grown has moved off its picture: capture again. */
      var capture = g.capture && g.capture.from === growFrom(g) ? g.capture : null;
      growRun(g, kind, size, capture).then(function (out) {
        mine.running = false;
        if (destroyed || adjust !== mine || session.loadedFor !== id) return;
        var live = findFeature(mine.id);
        if (!live) { adjust = null; updateHint(); return; }
        if (!out.result.shape) { setStatus(out.result.note + " Kept the outline you had.", true); updateHint(); return; }
        g.size = size;
        if (out.capture) g.capture = out.capture;
        takeWand(out.result);
        live.points = shapes.smoothOutline(out.result.candidates[out.result.pick], kind);
        live.source = "wand";
        drawFeatures();
        changed();
        updateHint();
        setStatus(kindLabel(kind) + (g.line ? " line wand reaching " : " growing up to ") + Math.round(LINE_WAND_REACH_M[kind] * size) + "m. " + out.result.note);
      });
    }

    /* ---- the collar ----
       The fringe round a finished green, as a fairway shape on the green's hole: the green's
       outline grown COLLAR_M, then grown on the imagery up to COLLAR_REACH_M further to the edge
       of the short grass (the area wand), and necked out to the hole's fairway so the two
       meet. It lies under the green (drawOrder), so the green stays clickable. */
    function collarGreen() {
      var f = adjusted() || (selectedId ? findFeature(selectedId) : null);
      return f && f.kind === "green" && !f.pin && f.points.length >= 3 ? f : null;
    }
    /* Where the neck runs to. With a tee linked to the green, the neck points at the tee: it
       meets the hole's fairway where the fairway lies that way, or runs COLLAR_TOWARD_TEE_M past
       the green towards the tee when no fairway does. Without one, the nearest point of the
       hole's fairway: one linked to the green, else one numbered for its hole, else the nearest
       - and only one close enough to be its own. A fairway already round the green is a
       collar, never the target. Null when there is nowhere to neck to. */
    function collarTarget(green) {
      var centre = shapes.centroid(green.points);
      var fairways = session.features.filter(function (f) { return f.kind === "fairway" && !f.pin && f.points.length >= 3 && !shapes.insideLatLngRing(centre, f.points); });
      var same = fairways.filter(function (f) { return green.link && f.link === green.link; });
      if (!same.length) same = fairways.filter(function (f) { return green.hole && f.hole === green.hole; });
      var pool = same.length ? same : fairways;
      var tee = green.link ? session.features.filter(function (f) { return f.kind === "tee" && f.link === green.link && f.points.length; })[0] : null;
      var teeAt = tee ? shapes.centroid(tee.points) : null;
      var k = Math.cos(centre.lat * Math.PI / 180);
      function along(p) { return { x: (p.lng - centre.lng) * 111320 * k, y: (p.lat - centre.lat) * 111320 }; }
      var dir = null;
      if (teeAt) { var t = along(teeAt), tl = Math.hypot(t.x, t.y); if (tl > 1) dir = { x: t.x / tl, y: t.y / tl, len: tl }; }
      var best = null;
      pool.forEach(function (f) {
        f.points.forEach(function (p) {
          var d = shapes.distanceM(centre, p);
          if (d > COLLAR_FAIRWAY_MAX_M) return;
          if (dir) {
            var v = along(p), cos = (v.x * dir.x + v.y * dir.y) / Math.max(d, 1e-6);
            if (cos < COLLAR_TOWARD_TEE_COS) return;
          }
          if (!best || d < best.d) best = { d: d, at: p, by: dir ? "tee" : "fairway" };
        });
      });
      if (best || !dir) return best;
      var reach = shapes.ringRadiusM(green.points) + COLLAR_TOWARD_TEE_M;
      var u = Math.min(0.9, reach / dir.len);
      return { at: { lat: centre.lat + (teeAt.lat - centre.lat) * u, lng: centre.lng + (teeAt.lng - centre.lng) * u }, by: "tee" };
    }
    function addCollar() {
      var green = collarGreen();
      if (!green || !canEdit()) return;
      if (full("green")) return;
      if (adjust) commitAdjust(true);
      var start = shapes.reshapeOutline([green.points], { growM: COLLAR_M });
      if (!start) { setStatus("This green is too small to put a collar round.", true); return; }
      var target = collarTarget(green);
      var id = session.loadedFor;
      setStatus("Finding the collar round the green…");
      growRun({ ring: start }, "fairway", COLLAR_REACH_M / LINE_WAND_REACH_M.fairway, null).then(function (out) {
        if (destroyed || session.loadedFor !== id) return;
        var live = findFeature(green.id);
        if (!live) return;
        var found = out.result.shape || start;
        var ring = shapes.collarOutline(live.points, found, target ? target.at : null, { neckM: COLLAR_NECK_M });
        if (!ring) { setStatus("Could not make a collar here.", true); return; }
        var collar = addFeature({ kind: "fairway", points: shapes.smoothOutline(ring, "fairway"), source: "wand", hole: live.hole });
        if (live.link) collar.link = live.link;
        startAdjust(collar, { base: collar.points.slice() });
        drawFeatures();
        changed();
        setStatus("Collar added" + (target ? (target.by === "tee" ? ", necked out towards the tee" : ", necked out to the fairway") : " - no fairway near enough to neck out to") + (out.result.shape && out.result.shape !== start ? "" : " (the wand found no edge, so it is " + COLLAR_M + "m all round)") + ". ↑ ↓ smooth and size it, Enter keeps it.");
      });
    }
    function renderCollar() {
      if (!el.collar) return;
      var green = canEdit() ? collarGreen() : null;
      el.collar.hidden = !green;
      el.collar.disabled = !green || !!wandsRunning;
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
      if (raw.osm) f.osm = raw.osm;
      session.features.push(f);
      if (!quiet) { lastPlacedId = f.id; selectedId = tool === "move" ? f.id : selectedId; drawFeatures(); changed(); }
      return f;
    }

    /* Room left for another shape of a kind: single trees have a cap of their own. full() says
       so when there is none. */
    function roomFor(kind) {
      var tree = kind === "tree";
      var held = session.features.filter(function (f) { return (f.kind === "tree") === tree; }).length;
      return (tree ? MAX_TREES : MAX_FEATURES) - held;
    }

    function full(kind) {
      if (roomFor(kind) > 0) return false;
      setStatus(kind === "tree" ? "That is the most single trees one course can hold (" + MAX_TREES + "). Bin some first." : "That is the most shapes one course can hold (" + MAX_FEATURES + ", besides single trees). Bin some first.", true);
      return true;
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
        [entry.shape].concat(entry.edge ? [entry.edge] : [], entry.vertices, entry.mids, entry.ends).forEach(function (l) { try { mapObj.removeLayer(l); } catch (e) {} });
      });
      featureLayers = {};
      clearLinkLayers();
      clearHoleTags();
    }

    function midpoints(f) {
      var out = [];
      if (f.pin || isSmooth(f) || isDetailed(f) || f.kind === "tree") return out;
      var n = f.points.length;
      var last = isPolygon(f.kind) ? n : n - 1;
      for (var i = 0; i < last; i++) {
        var a = f.points[i], b = f.points[(i + 1) % n];
        out.push({ after: i, lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 });
      }
      return out;
    }

    /* A green or bunker is edited by its few smooth handles - unless the colour wand outlined
       it, when it keeps the detail it found and is edited like any detailed outline. */
    /* A colour-wand or OSM outline keeps the corners it was traced with: rebuilt as a smooth curve
       through a handful of handles, the first drag would throw that detail away. */
    function isSmooth(f) { return !f.pin && !!shapes.SMOOTH[f.kind] && f.source !== "colour" && f.source !== "osm"; }
    /* Any other area is a detailed outline - a wand's can have a couple of hundred corners. It
       shows only its key corners (shapes.keyCorners, worked out on screen, so zooming in shows
       more), and its edge can be grabbed anywhere and bent there (shapes.bendRing). A hole line
       keeps a handle on every corner. */
    function isDetailed(f) { return !!f && !f.pin && !isSmooth(f) && f.kind !== "tree" && isPolygon(f.kind); }
    function screenRing(points) {
      return points.map(function (p) { var c = mapObj.latLngToContainerPoint([p.lat, p.lng]); return { x: c.x, y: c.y }; });
    }
    function fromScreen(xy) {
      return xy.map(function (c) { var ll = mapObj.containerPointToLatLng([c.x, c.y]); return { lat: ll.lat, lng: ll.lng }; });
    }
    /* The corners of f that carry a handle, as indices into f.points. */
    function handleIndices(f) {
      if (isSmooth(f)) return null;
      if (isDetailed(f)) return shapes.keyCorners(screenRing(f.points));
      return f.points.map(function (p, i) { return i; });
    }
    function handlePoints(f, keys) {
      var smooth = shapes.SMOOTH[f.kind];
      if (isSmooth(f)) return shapes.ringHandles(f.points, smooth.handles, smooth.steps);
      return (keys || handleIndices(f)).map(function (i) { return f.points[i]; });
    }

    function canDrag(f) { return !!f && canEdit() && (tool === "move" || f.id === lastPlacedId); }

    /* Painted bottom to top: the big surfaces first, a green last, so a green sitting on its
       fairway or collar is the shape a click finds - linking, numbering and play orders all
       need to reach it. The shape in hand goes on top of everything, handles and all. */
    var DRAW_ORDER = { waste: 0, hazard: 1, trees: 2, water: 3, fairway: 4, bunker: 5, tee: 6, tree: 7, green: 8 };
    function drawOrder() {
      var held = function (f) { return f.id === selectedId || (!!adjust && f.id === adjust.id) ? 1 : 0; };
      return session.features.map(function (f, i) { return { f: f, i: i }; }).sort(function (a, b) {
        return held(a.f) - held(b.f) || (a.f.pin ? 1 : 0) - (b.f.pin ? 1 : 0)
          || (DRAW_ORDER[a.f.kind] != null ? DRAW_ORDER[a.f.kind] : 4) - (DRAW_ORDER[b.f.kind] != null ? DRAW_ORDER[b.f.kind] : 4) || a.i - b.i;
      }).map(function (x) { return x.f; });
    }
    function drawFeatures() {
      clearFeatureLayers();
      drawOrder().forEach(function (f) {
        var selected = f.id === selectedId || linkPick.indexOf(f.id) >= 0 || (!!adjust && f.id === adjust.id);
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
        /* So the linked flash can find the shapes it plays on. */
        var node = shape.getElement && shape.getElement();
        if (node) node.setAttribute("data-gd-feature", f.id);
        shape.on("click", function (e) {
          /* Selecting a shape must not also count as a click on the map under it. */
          if (e && e.originalEvent) L.DomEvent.stop(e.originalEvent);
          if (tool === "connect") { if (canEdit() && Date.now() - dragEndedAt >= 300) toggleLinkPick(f.id); return; }
          if (tool === "number") { numberHole(f); return; }
          if (tool === "order") { allocateShape(f); return; }
          if (tool !== "move") { handleMapClick(e.latlng); return; }
          if (Date.now() - dragEndedAt < 300) return;
          select(f.id);
        });
        onPress(shape, function (e) {
          if (!canDrag(f)) return;
          if (tool === "move" && selectedId !== f.id) select(f.id);
          beginDrag(f.id, "body", -1, e);
        });
        var entry = { shape: shape, edge: null, keys: null, vertices: [], mids: [], ends: [] };
        /* A fairway pin's start and end, always shown, so it reads as two pins and a line. */
        if (f.pin && f.points.length === 2 && !selected) {
          f.points.forEach(function (p) { entry.ends.push(L.circleMarker([p.lat, p.lng], STYLE.pinFairwayEnd).addTo(mapObj)); });
        }
        /* A single tree is moved whole and sized with up / down - it has no corners to drag. */
        if (f.id === selectedId && canEdit() && f.points.length > 1 && f.kind !== "tree" && bigEnoughForHandles(f)) {
          var keys = entry.keys = handleIndices(f);
          if (isDetailed(f)) {
            entry.edge = L.polygon(latlngs, STYLE.edge).addTo(mapObj);
            onPress(entry.edge, function (e) { beginDrag(f.id, "edge", -1, e); });
            entry.edge.on("click", function (e) { if (e && e.originalEvent) L.DomEvent.stop(e.originalEvent); });
          }
          handlePoints(f, keys).forEach(function (p, k) {
            var i = keys ? keys[k] : k;
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
      drawHoleTags();
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
      if (entry.edge) entry.edge.setLatLngs(toLatLngs(f.points));
      entry.ends.forEach(function (m, i) { if (f.points[i]) m.setLatLng([f.points[i].lat, f.points[i].lng]); });
      var handles = entry.vertices.length ? handlePoints(f, entry.keys) : [];
      entry.vertices.forEach(function (v, i) { if (handles[i]) v.setLatLng([handles[i].lat, handles[i].lng]); });
      midpoints(f).forEach(function (m, i) { if (entry.mids[i]) entry.mids[i].setLatLng([m.lat, m.lng]); });
    }

    function select(id) {
      if (adjust && adjust.id !== id) commitAdjust(true);
      if (finder) keepFinder(true);
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
      renderTreeAuto();
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

    /* ---- hole number tags ----
       One number per hole, sat on its fairway the way OSM shows a hole's ref (on the green or
       tee, or whatever it has, when there is no fairway yet). A hole is a link group, or the
       unlinked shapes sharing a number. Click a tag to type its number: every shape on that
       hole takes it, which is what the mapper reads. A linked hole with no number shows "?" so
       it can be numbered the same way. A number used by two holes, or a hole whose shapes
       disagree, shows red until it is fixed. */

    var TAG_ANCHOR = { fairway: 0, hole: 1, green: 2, tee: 3 };

    function clearHoleTags() {
      /* Taking an open box off the map can blur it; that is a redraw, not the person leaving it. */
      clearingTags = true;
      holeTagLayers.forEach(function (l) { try { mapObj.removeLayer(l); } catch (e) {} });
      clearingTags = false;
      holeTagLayers = [];
    }

    function holeGroups() {
      var byKey = {}, out = [];
      session.features.forEach(function (f) {
        var k = linkKey(f);
        if (!k || !f.points.length) return;
        if (!byKey[k]) { byKey[k] = { key: k, members: [], numbers: [] }; out.push(byKey[k]); }
        byKey[k].members.push(f);
        if (f.hole && byKey[k].numbers.indexOf(f.hole) < 0) byKey[k].numbers.push(f.hole);
      });
      out.forEach(function (g) { g.numbers.sort(function (a, b) { return a - b; }); });
      return out;
    }

    function tagAnchor(members) {
      /* Not on a single tree: a stand of them is no place for a hole's number. */
      var list = members.filter(function (f) { return f.kind !== "tree"; });
      if (!list.length) return null;
      var rank = function (f) { return Object.prototype.hasOwnProperty.call(TAG_ANCHOR, f.kind) ? TAG_ANCHOR[f.kind] : 9; };
      var best = list.slice().sort(function (a, b) { return rank(a) - rank(b); })[0];
      var c = shapes.centroid(best.points);
      return [c.lat, c.lng];
    }

    function drawHoleTags() {
      clearHoleTags();
      if (tool === "order") { drawOrderTags(); return; }
      var groups = holeGroups();
      var uses = {};
      groups.forEach(function (g) { g.numbers.forEach(function (n) { uses[n] = (uses[n] || 0) + 1; }); });
      groups.forEach(function (g) {
        var at = tagAnchor(g.members);
        if (!at) return;
        var clash = g.numbers.length > 1 || g.numbers.some(function (n) { return uses[n] > 1; });
        var editing = editingTag === g.key && canEdit();
        var text = g.numbers.length ? g.numbers.join("/") : "?";
        var html = editing
          ? '<input type="number" min="1" max="36" step="1" value="' + esc(editingValue != null ? editingValue : g.numbers.length === 1 ? g.numbers[0] : "") + '" aria-label="Hole number">'
          : "<span>" + esc(text) + "</span>";
        /* A tooltip, not a marker: the app's own stylesheet hides every Leaflet marker icon on
           the screens Studio runs over. */
        var tag = L.tooltip({ permanent: true, interactive: true, direction: "center", className: "gdStudioOverlayHoleTag" + (clash ? " isClash" : "") + (g.numbers.length ? "" : " isEmpty") + (editing ? " isEditing" : "") })
          .setLatLng(at).setContent(html);
        mapObj.addLayer(tag);
        holeTagLayers.push(tag);
        var node = tag.getElement();
        if (!node) return;
        node.title = clash ? (g.numbers.length > 1 ? "These shapes carry different numbers - click to give the hole one" : "Another hole has this number too") : "Click to change this hole's number";
        /* A press on a tag is never a press on the map under it. */
        L.DomEvent.disableClickPropagation(node);
        node.addEventListener("pointerdown", function (event) { event.stopPropagation(); });
        if (!editing) {
          node.addEventListener("click", function (event) {
            L.DomEvent.stop(event);
            if (!canEdit()) return;
            if (tool === "number") { numberHole(g.members[0]); return; }
            editingTag = g.key;
            editingValue = null;
            drawHoleTags();
          });
          return;
        }
        var input = node.querySelector("input");
        var done = function (keep) {
          if (editingTag !== g.key || clearingTags) return;
          editingTag = "";
          editingValue = null;
          if (keep) setGroupHole(g, input.value);
          else drawHoleTags();
        };
        input.addEventListener("keydown", function (event) {
          event.stopPropagation();
          if (event.key === "Enter") { event.preventDefault(); done(true); }
          else if (event.key === "Escape") { event.preventDefault(); done(false); }
        });
        input.addEventListener("input", function () { editingValue = input.value; });
        input.addEventListener("blur", function () { done(true); });
        setTimeout(function () { try { input.focus(); input.select(); } catch (e) {} }, 0);
      });
    }

    /* The Number tool: a click on any shape of a hole gives the whole hole the next number,
       and on Auto the number moves on, so a course is numbered 1 to 18 in eighteen clicks. A
       shape on no hole yet (unlinked and unnumbered) is numbered on its own. */
    function numberHole(f) {
      if (!f || !canEdit() || Date.now() - dragEndedAt < 300) return;
      var n = holeNumber(session.numberNext) || 1;
      var key = linkKey(f);
      var members = key ? session.features.filter(function (x) { return linkKey(x) === key; }) : [f];
      members.forEach(function (x) { x.hole = n; });
      if (session.numberAuto && n < 36) session.numberNext = n + 1;
      drawFeatures();
      changed();
      renderNumberField();
      updateHint();
      var taken = holeGroups().filter(function (g) { return g.numbers.indexOf(n) >= 0; }).length > 1;
      setStatus("Hole " + n + " numbered." + (taken ? " Another hole has " + n + " too - it shows red." : "") + (session.numberAuto ? " Next: " + session.numberNext + "." : ""), taken);
    }

    function renderNumberField() {
      if (destroyed || !el["number-next"]) return;
      if (document.activeElement !== el["number-next"]) el["number-next"].value = String(session.numberNext);
    }

    /* Every shape on the hole takes the number - or loses it, when the box is left empty. */
    function setGroupHole(g, value) {
      var n = holeNumber(value);
      if (String(value).trim() && !n) { drawHoleTags(); setStatus("A hole number is 1 to 36.", true); return; }
      var members = session.features.filter(function (f) { return linkKey(f) === g.key; });
      if (!members.length || members.every(function (f) { return f.hole === n; })) { drawHoleTags(); return; }
      members.forEach(function (f) { f.hole = n; });
      drawFeatures();
      changed();
      var taken = n && holeGroups().filter(function (other) { return other.numbers.indexOf(n) >= 0; }).length > 1;
      setStatus(n ? "Hole numbered " + n + "." + (taken ? " Another hole has " + n + " too - it shows red until one is changed." : "") : "Hole number taken off.", !!taken);
    }

    /* ---- play orders ----
       A play order is a course said by hand: a name, and its holes in the order they are played.
       A hole is an OSM hole line ("osm:way/N") or the overlay shapes linked as one hole
       ("link:ID"), and it can be in any number of play orders. While the Play order tool is in
       hand, OSM hole lines are clickable, the hole tags show the order being built, and a click
       on a hole adds it next - or takes it out if it is already in. */

    var PLAY_ORDER_MAX = 12;
    var PLAY_ORDER_MAX_HOLES = 36;

    function hasOverlay() { return session.features.length > 0 || session.playOrders.length > 0; }
    function activeOrder() { return session.playOrders.filter(function (o) { return o.id === session.activeOrder; })[0] || null; }
    function osmHoleById(id) { return ((session.osm && session.osm.holes) || []).filter(function (h) { return h.id === id; })[0] || null; }

    /* Where a hole's tag goes and what the list calls it. `problem` is anything that will stop the
       mapper building it - the same checks the server makes. */
    function describeRef(ref) {
      var osm = /^osm:(.+)$/.exec(ref);
      if (osm) {
        var hole = osmHoleById(osm[1]);
        /* Made editable, the line in the overlay is where the hole is now. */
        var own = session.features.filter(function (f) { return f.kind === "hole" && f.osm === osm[1]; })[0];
        if (!hole && !own) return { label: "OSM hole", problem: "not found in OSM here", at: null };
        var pts = own ? own.points : hole.points;
        var a = pts[0], b = pts[pts.length - 1];
        if (!hole) hole = { ref: own.hole || "" };
        return { label: "OSM hole " + (hole.ref || "(unnumbered)"), problem: "", at: [(a.lat + b.lat) / 2, (a.lng + b.lng) / 2] };
      }
      var link = /^link:(.+)$/.exec(ref);
      var members = link ? session.features.filter(function (f) { return f.link === link[1]; }) : [];
      if (!members.length) return { label: "Linked hole", problem: "its shapes are gone", at: null };
      var count = function (kind) { return members.filter(function (f) { return f.kind === kind; }).length; };
      var drawn = count("hole") > 0;
      var problem = drawn ? "" : count("green") !== 1 ? (count("green") ? "two greens" : "no green") : !count("tee") ? "no tee" : "";
      return { label: "Linked hole (" + members.map(function (f) { return kindLabel(f.kind).toLowerCase(); }).join(", ") + ")", problem: problem, at: tagAnchor(members) };
    }

    /* OSM hole lines while a play order is built: the line, brighter when it is in the order,
       and a wide invisible band over it so it is easy to click. */
    function drawOrderOsmHoles(holes) {
      var order = activeOrder();
      (holes || []).forEach(function (item) {
        var latlngs = (item.points || []).map(function (p) { return [p.lat, p.lng]; });
        if (latlngs.length < 2) return;
        var ref = "osm:" + item.id;
        var inOrder = !!order && order.holes.indexOf(ref) >= 0;
        var line = L.polyline(latlngs, Object.assign({ interactive: false }, inOrder ? STYLE.orderHole : STYLE.osmHole)).addTo(mapObj);
        osmLayers.push(line);
        if (!inOrder && item.ref) {
          line.bindTooltip(String(item.ref), { permanent: true, direction: "center", className: "gdStudioOverlayLabel isOsm" });
        }
        var hit = L.polyline(latlngs, STYLE.orderHit).addTo(mapObj);
        hit.on("click", function (e) {
          if (e && e.originalEvent) L.DomEvent.stop(e.originalEvent);
          toggleOrderHole(ref);
        });
        osmLayers.push(hit);
      });
    }

    /* The active play order's positions, one tag per hole. Clicking a tag takes the hole out. */
    function drawOrderTags() {
      var order = activeOrder();
      if (!order) return;
      order.holes.forEach(function (ref, index) {
        var d = describeRef(ref);
        if (!d.at) return;
        var tag = L.tooltip({ permanent: true, interactive: true, direction: "center", className: "gdStudioOverlayHoleTag isOrder" + (d.problem ? " isClash" : "") })
          .setLatLng(d.at).setContent("<span>" + (index + 1) + "</span>");
        mapObj.addLayer(tag);
        holeTagLayers.push(tag);
        var node = tag.getElement();
        if (!node) return;
        node.title = d.problem ? "Hole " + (index + 1) + ": " + d.problem + " - click to take it out" : "Hole " + (index + 1) + " - click to take it out of " + order.name;
        L.DomEvent.disableClickPropagation(node);
        node.addEventListener("pointerdown", function (event) { event.stopPropagation(); });
        node.addEventListener("click", function (event) { L.DomEvent.stop(event); toggleOrderHole(ref); });
      });
    }

    function orderChanged() {
      changed();
      drawOsm();
      drawHoleTags();
      renderOrders();
      renderCourses();
      updateHint();
    }

    function toggleOrderHole(ref) {
      if (!canEdit()) return;
      var order = activeOrder();
      if (!order) { setStatus("Make a play order first: + New play order.", true); return; }
      var at = order.holes.indexOf(ref);
      if (at >= 0) {
        order.holes.splice(at, 1);
        orderChanged();
        setStatus("Hole " + (at + 1) + " taken out of " + order.name + (at < order.holes.length ? " - the holes after it move up one." : "."));
        return;
      }
      if (order.holes.length >= PLAY_ORDER_MAX_HOLES) { setStatus("A play order holds at most " + PLAY_ORDER_MAX_HOLES + " holes.", true); return; }
      order.holes.push(ref);
      orderChanged();
      var d = describeRef(ref);
      setStatus(order.name + ": hole " + order.holes.length + " is " + d.label + "." + (d.problem ? " It has " + d.problem + ", so the mapper cannot build it yet." : ""), !!d.problem);
    }

    /* A shape counts as a hole once it is linked: the link is what says which tee, fairway and
       green belong together. Linking two nines' "hole 3" shapes for it would guess. */
    function allocateShape(f) {
      if (!f || !canEdit() || Date.now() - dragEndedAt < 300) return;
      /* An OSM hole line made editable is still that OSM hole to a play order. */
      if (f.kind === "hole" && f.osm) { toggleOrderHole("osm:" + f.osm); return; }
      if (!f.link) { setStatus("This " + kindLabel(f.kind).toLowerCase() + " is not on a linked hole. Link the hole's tee and green first (Link, C), then click it here.", true); return; }
      toggleOrderHole("link:" + f.link);
    }

    function orderHint() {
      var order = activeOrder();
      if (!session.playOrders.length) return "+ New play order, name it, then click its holes in the order they are played";
      if (!order) return "Pick a play order to edit";
      return order.name + ": click hole " + (order.holes.length + 1) + " - an OSM hole line, or a linked hole · click a hole again to take it out";
    }

    function renderOrders() {
      if (destroyed || !el.orders) return;
      el.orders.hidden = tool !== "order" || !session.loadedFor;
      if (el.orders.hidden) return;
      /* Never rebuilt under someone typing a name - an autosave landing would take the box away. */
      if (el.orders.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
      var editable = canEdit();
      var off = editable ? "" : " disabled";
      var forVariant = session.variant && !orderFor(session.variant) ? variantCourse(session.variant) : null;
      var html = '<div class="gdStudioOverlayOrdersHead"><strong>Play orders</strong>' +
        '<button type="button" class="gdStudioOverlayOptBtn" data-order-act="new"' + (editable && session.playOrders.length < PLAY_ORDER_MAX ? "" : " disabled") + ">" +
        (forVariant ? "+ Play order for " + esc(variantLabel(forVariant)) : "+ New play order") + "</button></div>";
      if (!session.playOrders.length) {
        html += '<p class="gdStudioOverlayOrdersNote">None yet - the mapper works out this site\'s courses by itself. Make a play order to say them by hand.</p>';
      }
      session.playOrders.forEach(function (order) {
        var active = order.id === session.activeOrder;
        var problems = order.holes.filter(function (ref) { return describeRef(ref).problem; }).length;
        html += '<div class="gdStudioOverlayOrder' + (active ? " isActive" : "") + '">' +
          '<button type="button" class="gdStudioOverlayOrderPick" data-order-act="pick" data-order-id="' + esc(order.id) + '">' +
          "<span>" + esc(order.name) + "</span><em>" + order.holes.length + " hole" + (order.holes.length === 1 ? "" : "s") + (problems ? " · " + problems + " to fix" : "") + "</em></button>";
        if (active) {
          html += '<label class="gdStudioOverlayOrderName">Name <input type="text" maxlength="80" data-order-field="name" value="' + esc(order.name) + '"' + off + "></label>";
          if (order.courseId) html += '<p class="gdStudioOverlayOrdersNote">Publishes as <code>' + esc(order.courseId) + "</code>" + (order.courseId === session.loadedFor ? " (this course)" : "") + "</p>";
          if (!order.holes.length) html += '<p class="gdStudioOverlayOrdersNote">Click holes on the map in the order they are played.</p>';
          else {
            html += "<ol>";
            order.holes.forEach(function (ref, i) {
              var d = describeRef(ref);
              html += '<li class="' + (d.problem ? "isProblem" : "") + '"><span>' + (i + 1) + ". " + esc(d.label) + (d.problem ? " - " + esc(d.problem) : "") + "</span>" +
                '<button type="button" data-order-act="up" data-order-i="' + i + '" title="Play it earlier"' + (i && editable ? "" : " disabled") + ">↑</button>" +
                '<button type="button" data-order-act="down" data-order-i="' + i + '" title="Play it later"' + (i < order.holes.length - 1 && editable ? "" : " disabled") + ">↓</button>" +
                '<button type="button" data-order-act="remove" data-order-i="' + i + '" title="Take it out"' + off + ">×</button></li>";
            });
            html += "</ol>";
          }
          html += '<button type="button" class="gdStudioOverlayOrderDelete" data-order-act="delete"' + off + ">Delete play order</button>";
        }
        html += "</div>";
      });
      el.orders.innerHTML = html;
    }

    /* ---- the facility's courses ----
       One overlay, several courses: each is a play order over the same ground. The strip under
       the header switches between them - the map moves to the course and the Play order tool
       shows its holes. A course with no play order yet gets one from the panel's + button. */
    function variantCourse(courseId) {
      var list = (session.facility && session.facility.courses) || [];
      return list.filter(function (c) { return c.courseId === courseId; })[0] || null;
    }
    function variantLabel(course) {
      var name = String((course && course.name) || "");
      var cut = name.indexOf(" - ");
      return cut > 0 ? name.slice(cut + 3) : name;
    }
    function orderFor(courseId) {
      return session.playOrders.filter(function (o) { return o.courseId === courseId; })[0] || null;
    }
    function renderCourses() {
      if (destroyed || !el.courses) return;
      var list = (session.facility && session.facility.courses) || [];
      el.courses.hidden = list.length < 2 || !session.loadedFor;
      if (el.courses.hidden) { el.courses.innerHTML = ""; return; }
      el.courses.innerHTML = '<span class="gdStudioOverlayCoursesLabel">Courses on this overlay</span>' + list.map(function (c) {
        var order = orderFor(c.courseId);
        var note = (order ? order.holes.length + " hole" + (order.holes.length === 1 ? "" : "s") + " in its play order" : "no play order yet") + (c.published ? "" : " · unpublished");
        return '<button type="button" class="gdStudioOverlayCourseChip' + (c.courseId === session.variant ? " isActive" : "") + (order ? "" : " isEmpty") + '" data-variant="' + esc(c.courseId) + '" title="' + esc(c.name + " - " + note) + '">' +
          esc(variantLabel(c)) + "<em>" + (order ? order.holes.length : "–") + "</em></button>";
      }).join("");
    }
    function onCoursesClick(event) {
      var button = event.target.closest && event.target.closest("[data-variant]");
      if (!button) return;
      var id = button.getAttribute("data-variant");
      var course = variantCourse(id);
      if (!course) return;
      session.variant = id;
      var order = orderFor(id);
      if (order) session.activeOrder = order.id;
      var lat = num(course.lat), lng = num(course.lng);
      if (lat != null && lng != null && mapObj) mapObj.setView([lat, lng], mapObj.getZoom());
      if (tool !== "order") setTool("order"); else { drawOsm(); drawHoleTags(); renderOrders(); updateHint(); }
      renderCourses();
      setStatus(order ? variantLabel(course) + ": " + order.holes.length + " hole" + (order.holes.length === 1 ? "" : "s") + " in its play order."
        : variantLabel(course) + " has no play order yet - press + Play order for " + variantLabel(course) + ", then click its holes in the order they are played.");
    }

    function onOrdersClick(event) {
      var button = event.target.closest && event.target.closest("[data-order-act]");
      if (!button || button.disabled) return;
      var act = button.getAttribute("data-order-act");
      if (act === "pick") {
        session.activeOrder = button.getAttribute("data-order-id");
        var picked = activeOrder();
        if (picked && picked.courseId) session.variant = picked.courseId;
        renderCourses();
        drawOsm();
        drawHoleTags();
        renderOrders();
        updateHint();
        return;
      }
      if (!canEdit()) return;
      if (act === "new") {
        if (session.playOrders.length >= PLAY_ORDER_MAX) return;
        /* For the course being looked at, if it has no play order yet - otherwise the server
           would hand the facility's own id to the first play order, and with it that course's
           rounds and visuals. */
        var forVariant = session.variant && !orderFor(session.variant) ? variantCourse(session.variant) : null;
        var order = { id: "po-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6), name: forVariant ? variantLabel(forVariant) : "Play order " + (session.playOrders.length + 1), courseId: forVariant ? forVariant.courseId : "", holes: [] };
        session.playOrders.push(order);
        session.activeOrder = order.id;
        orderChanged();
        var input = el.orders.querySelector('[data-order-field="name"]');
        if (input) { input.focus(); input.select(); }
        setStatus("New play order - name it, then click its holes in the order they are played.");
        return;
      }
      var active = activeOrder();
      if (!active) return;
      var i = Number(button.getAttribute("data-order-i"));
      if (act === "up" && i > 0) active.holes.splice(i - 1, 0, active.holes.splice(i, 1)[0]);
      else if (act === "down" && i < active.holes.length - 1) active.holes.splice(i + 1, 0, active.holes.splice(i, 1)[0]);
      else if (act === "remove") active.holes.splice(i, 1);
      else if (act === "delete") {
        if (!window.confirm("Delete the play order \"" + active.name + "\"?" + (active.courseId ? "\n\nThe next mapper run unpublishes its course (" + active.courseId + ")." : ""))) return;
        session.playOrders = session.playOrders.filter(function (o) { return o !== active; });
        session.activeOrder = session.playOrders.length ? session.playOrders[0].id : "";
      }
      else return;
      orderChanged();
    }

    function onOrdersChange(event) {
      var field = event.target && event.target.getAttribute && event.target.getAttribute("data-order-field");
      var active = activeOrder();
      if (field !== "name" || !active || !canEdit()) return;
      var name = String(event.target.value || "").replace(/\s+/g, " ").trim().slice(0, 80);
      if (!name || name === active.name) { event.target.value = active.name; return; }
      active.name = name;
      changed();
      renderOrders();
      updateHint();
      setStatus("Renamed to " + name + (active.courseId ? " - it keeps its course id, so its rounds and visuals stay with it." : "."));
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
      if (isDetailed(f) && mode !== "body") beginBend(f, e);
      document.addEventListener("pointermove", onDragMove);
      document.addEventListener("pointerup", onDragEnd);
      document.addEventListener("pointercancel", onDragEnd);
    }

    /* A detailed outline is bent rather than moved corner by corner: from a key corner, the
       edge either side follows in proportion as far as the next key corners; from a grab on
       the edge, it bends as a smooth curve round the grab. */
    function beginBend(f, e) {
      var entry = featureLayers[f.id];
      var xy = screenRing(f.points);
      var keys = (entry && entry.keys) || shapes.keyCorners(xy);
      var start = mapObj.latLngToContainerPoint(e.latlng);
      var at = drag.mode === "edge" ? shapes.nearestOnRing(xy, { x: start.x, y: start.y }) : { index: drag.index };
      var bend = shapes.bendRing(xy, at, { keys: keys, maxReachPx: drag.mode === "edge" ? EDGE_BEND_PX : 0, maxPoints: MAX_POINTS });
      drag.bend = { ring: bend.ring, weights: bend.weights, added: bend.added, from: bend.from, start: start, last: null, welds: [] };
      /* The handles follow the corners they sit on. */
      if (entry && entry.keys) entry.keys = entry.keys.map(function (k) { return bend.from.indexOf(k); });
      /* A seam moves for both: every shape sharing corners with f follows them. */
      session.features.forEach(function (g) {
        if (g === f) return;
        var runs = shapes.weldRuns(g.points, f.points);
        if (runs.length) drag.bend.welds.push({ id: g.id, orig: g.points.slice(), runs: runs });
      });
    }

    /* The bent outline at this drag: each corner the drag did not move keeps its exact
       coordinates, so a seam with a shape not being dragged stays whole. */
    function bendTo(f, ll) {
      var b = drag.bend, now = mapObj.latLngToContainerPoint(ll);
      var dx = now.x - b.start.x, dy = now.y - b.start.y;
      b.last = b.ring.map(function (p, i) {
        var w = b.weights[i], j = b.from[i], q = { x: p.x + dx * w, y: p.y + dy * w, from: j };
        q.ll = !w && j >= 0 ? drag.orig[j] : fromScreen([q])[0];
        return q;
      });
      setBent(f, b.last, b);
    }

    /* f and every shape welded to it, to the bent corners `pts` (with .ll and .from). */
    function setBent(f, pts, bend) {
      f.points = pts.map(function (p) { return { lat: p.ll.lat, lng: p.ll.lng }; });
      var from = pts.map(function (p) { return p.from; });
      bend.welds.forEach(function (w) {
        var g = findFeature(w.id);
        if (!g) return;
        g.points = shapes.applyWeld(w.orig, w.runs, f.points, from);
        refreshFeature(g);
      });
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
      } else if (drag.bend) {
        bendTo(f, ll);
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
        if (d.bend) drawFeatures();
        if (d.inserted) changed();
        return;
      }
      if (!f) return;
      if (event.type !== "pointercancel" && overBin(event)) {
        if (d.mode === "body") { removeFeature(f.id); setStatus(kindLabel(f.kind) + " deleted."); return; }
        f.points = d.orig;
        /* Shapes welded to it go back too. */
        if (d.bend) d.bend.welds.forEach(function (w) { var g = findFeature(w.id); if (g) g.points = w.orig; });
        if (d.mode === "edge") { drawFeatures(); return; }
        if (d.inserted) { f.points.splice(d.index, 1); drawFeatures(); return; }
        if (removeVertex(f, d.index)) setStatus("Corner deleted.");
        else drawFeatures();
        return;
      }
      /* A bend keeps only the corners it needs, and closes any small gap it now leaves to a
         shape beside it. */
      if (d.bend && d.bend.last) {
        setBent(f, shapes.tidyBend(d.bend.last, d.bend.added), d.bend);
        sealSeams(f);
      }
      /* The live shape dragged whole keeps its arrow keys; reshaped by a corner, it is kept as
         the hand left it. */
      if (adjust && adjust.id === f.id) {
        if (d.mode === "body") shiftAdjust(f.points[0].lat - d.orig[0].lat, f.points[0].lng - d.orig[0].lng);
        else commitAdjust(true);
      }
      var followed = d.mode === "body" && f.kind === "tee" ? followTee(f, d.orig) : 0;
      drawFeatures();
      changed();
      if (followed) setStatus("Tee moved - its hole line moved with it.");
    }

    /* ---- a tee's hole line follows it ----
       A hole line runs tee to green, so its first point is the tee end - OSM's convention and
       the one this page draws by. Drag a tee that end sits at and the end goes with it, by the
       same distance: the overlay's own hole lines, and OSM's, which is first made editable so
       the moved line is what the mapper reads instead of OSM's. Only ever the tee end, so the
       green end of the hole before, which often sits as close, is never touched; and never a
       line numbered or linked to a different hole. A line whose tee end is not at this tee (a
       forward tee on a line from the back tee) is left alone. */
    var TEE_LINE_REACH_M = 30;

    function centreOf(points) {
      var sum = points.reduce(function (acc, p) { return { lat: acc.lat + p.lat, lng: acc.lng + p.lng }; }, { lat: 0, lng: 0 });
      return { lat: sum.lat / points.length, lng: sum.lng / points.length };
    }

    function osmHoleNumber(h) { var m = /\d+/.exec(String(h && h.ref || "")); return m ? holeNumber(m[0]) : null; }

    /* Whether a line's tee end sits at this tee, and the line is not another hole's. */
    function startsAtTee(points, number, link, tee, from) {
      if (tee.hole && number && number !== tee.hole) return false;
      if (tee.link && link && link !== tee.link) return false;
      return points.length >= 2 && shapes.distanceM(points[0], from) <= TEE_LINE_REACH_M;
    }

    function followTee(tee, orig) {
      var from = centreOf(orig);
      var dLat = tee.points[0].lat - orig[0].lat, dLng = tee.points[0].lng - orig[0].lng;
      var lines = session.features.filter(function (g) { return g.kind === "hole" && !g.pin && startsAtTee(g.points, g.hole, g.link, tee, from); });
      /* OSM's line from this tee, not yet editable: made so, under the id the server would give it. */
      if (session.osm && !session.osm.error && session.osmMode !== "exclude") {
        var converted = {};
        session.features.forEach(function (f) { if (f.osm) converted[f.osm] = true; });
        (session.osm.holes || []).forEach(function (h) {
          if (converted[h.id] || !h.points || !startsAtTee(h.points, osmHoleNumber(h), null, tee, from)) return;
          if (roomFor("hole") <= 0) return;
          var f = { id: ("osm-" + String(h.id).replace("/", "-")).slice(0, 40), kind: "hole", hole: osmHoleNumber(h), points: h.points.map(function (p) { return { lat: p.lat, lng: p.lng }; }), source: "osm", osm: h.id };
          session.features.push(f);
          lines.push(f);
        });
      }
      lines.forEach(function (line) { line.points[0] = { lat: line.points[0].lat + dLat, lng: line.points[0].lng + dLng }; });
      if (lines.length) drawOsm();
      return lines.length;
    }

    /* ---- linking shapes to a hole ----
       Click the shapes that belong to one hole, then Enter or Space: they share a link id and
       are drawn joined. A link says "one hole", never which - hole numbers are left exactly as
       they were, for a person to set or the mapper to take from the scorecard. Picking a shape
       already in a link brings its whole link along, so two links merge into one. One shape
       and Enter takes it out of its link. */

    function linkKey(f) {
      return f.link ? "l:" + f.link : f.hole ? "h:" + f.hole : "";
    }

    function newLinkId() {
      return "l-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
    }

    function toggleLinkPick(id) {
      var at = linkPick.indexOf(id);
      if (at >= 0) linkPick.splice(at, 1);
      else linkPick.push(id);
      drawFeatures();
      updateHint();
    }

    function clearLinkPick() {
      if (!linkPick.length) return;
      linkPick = [];
      drawFeatures();
      updateHint();
    }

    function commitLink() {
      var picked = linkPick.map(findFeature).filter(Boolean);
      linkPick = [];
      if (picked.length === 1) {
        var only = picked[0];
        if (!only.link) { drawFeatures(); updateHint(); setStatus("Pick at least two shapes to link them."); return; }
        delete only.link;
        drawFeatures();
        changed();
        updateHint();
        setStatus(kindLabel(only.kind) + " taken out of its link." + (only.hole ? " It still carries hole " + only.hole + "." : ""));
        return;
      }
      if (!picked.length) { updateHint(); return; }
      var keys = {};
      picked.forEach(function (f) { var k = linkKey(f); if (k) keys[k] = true; });
      var id = (picked.filter(function (f) { return f.link; })[0] || {}).link || newLinkId();
      var members = session.features.filter(function (f) { return picked.indexOf(f) >= 0 || (linkKey(f) && keys[linkKey(f)]); });
      members.forEach(function (f) { f.link = id; });
      drawFeatures();
      changed();
      updateHint();
      flashLinked(members);
      var numbers = [];
      members.forEach(function (f) { if (f.hole && numbers.indexOf(f.hole) < 0) numbers.push(f.hole); });
      setStatus("Linked " + members.length + " shapes as one hole." +
        (numbers.length > 1 ? " They carry different hole numbers (" + numbers.sort(function (a, b) { return a - b; }).join(", ") + ") - fix the wrong one, or the mapper numbers them from the scorecard." : ""), numbers.length > 1);
    }

    /* The quick "linked" confirmation: the shapes pulse and a tick shows over them, so it is
       plain the link was made and the next click starts a new one. */
    function flashLinked(members) {
      members.forEach(function (f) {
        var node = el.stage.querySelector('[data-gd-feature="' + f.id + '"]');
        if (!node) return;
        node.classList.remove("gdStudioOverlayLinkedFlash");
        void node.getBoundingClientRect();
        node.classList.add("gdStudioOverlayLinkedFlash");
      });
      var pts = [];
      members.forEach(function (f) { pts = pts.concat(toLatLngs(f.points)); });
      if (!pts.length) return;
      var centre = L.latLngBounds(pts).getCenter();
      /* A tooltip, not a marker - see drawHoleTags. */
      var badge = L.tooltip({ permanent: true, direction: "center", className: "gdStudioOverlayLinkedBadge" }).setLatLng(centre).setContent("<span>✓ Linked</span>");
      mapObj.addLayer(badge);
      setTimeout(function () { try { mapObj.removeLayer(badge); } catch (e) {} }, 900);
    }

    function clearLinkLayers() {
      linkLayers.forEach(function (l) { try { mapObj.removeLayer(l); } catch (e) {} });
      linkLayers = [];
    }

    /* Shapes on one hole are joined by a dotted line - tee to fairway to green, and each bunker,
       water hazard, tree or waste area to the nearest of those - so what belongs together reads
       at a glance. */
    var LINK_ORDER = { tee: 0, hole: 1, fairway: 2, green: 3 };
    function drawLinks() {
      clearLinkLayers();
      var groups = {};
      session.features.forEach(function (f) { var k = linkKey(f); if (k && f.points.length && f.kind !== "tree") (groups[k] = groups[k] || []).push(f); });
      Object.keys(groups).forEach(function (hole) {
        var list = groups[hole];
        if (list.length < 2) return;
        var onSpine = function (f) { return Object.prototype.hasOwnProperty.call(LINK_ORDER, f.kind); };
        var spine = list.filter(onSpine).sort(function (a, b) { return LINK_ORDER[a.kind] - LINK_ORDER[b.kind]; }).map(function (f) { return shapes.centroid(f.points); });
        var bunkers = list.filter(function (f) { return !onSpine(f); }).map(function (f) { return shapes.centroid(f.points); });
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

    /* ---- undo ----
       Every change to the shapes comes through changed(), so the shapes as they were before it
       are kept: Undo (the button, Ctrl+Z / ⌘Z) puts them back and saves. The changes one
       action makes in one go (a shape placed and joined to its neighbours) are one step. The
       history is this course's, from when it was opened. */
    var UNDO_MAX = 50;
    var undoStack = [], undoBase = shapesNow(), undoPending = false, undoing = false;

    /* Play orders ride in the same undo history as the shapes. */
    function shapesNow() { return JSON.stringify({ features: session.features, playOrders: session.playOrders }); }

    function resetUndo() {
      undoStack = [];
      undoBase = shapesNow();
      undoPending = false;
      renderUndo();
    }

    function noteUndo() {
      if (undoPending) return;
      undoPending = true;
      setTimeout(commitUndo, 0);
    }

    function commitUndo() {
      if (!undoPending) return;
      undoPending = false;
      var now = shapesNow();
      if (undoBase == null || now === undoBase) { undoBase = now; return; }
      undoStack.push(undoBase);
      if (undoStack.length > UNDO_MAX) undoStack.shift();
      undoBase = now;
      if (!destroyed) renderUndo();
    }

    function renderUndo() {
      if (destroyed || !el.undo) return;
      el.undo.disabled = !draft.length && (!undoStack.length && !undoPending || !canEdit());
    }

    function undo() {
      /* A line being laid takes back its last point first. */
      if (draft.length) { undoDraftPoint(); return; }
      if (drag) return;
      if (!canEdit()) { setStatus(scanning ? "Wait for the AI scan to finish." : "Nothing to undo yet."); return; }
      if (colourSel) clearColourSel();
      commitUndo();
      if (!undoStack.length) { setStatus("Nothing to undo."); renderUndo(); return; }
      /* Whatever was live goes as it is - the undo puts back the shapes from before it. */
      adjust = null;
      finder = null;
      lastPlacedId = "";
      var back = JSON.parse(undoStack.pop());
      session.features = back.features;
      session.playOrders = back.playOrders;
      renderOrders();
      undoBase = shapesNow();
      if (selectedId && !findFeature(selectedId)) selectedId = "";
      undoing = true;
      changed();
      undoing = false;
      drawFeatures();
      updateHint();
      renderUndo();
      setStatus("Undone." + (undoStack.length ? "" : " That was the last change to undo."));
    }

    /* ---- autosave ---- */

    function changed() {
      if (!undoing) noteUndo();
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
      var shown = !!session.loadedFor && hasOverlay();
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
      session.savePromise = api("POST", "", { courseId: id, features: session.features, playOrders: session.playOrders }).then(function (data) {
        session.saveError = "";
        if (session.loadedFor !== id) return;
        /* Every save is a draft again: a changed shape has not been signed off. */
        session.status = (data && data.overlay && data.overlay.status) || "draft";
        if (session.rev === sentRev) {
          session.dirty = false;
          if (!drag) session.features = (data && data.overlay && data.overlay.features) || [];
          /* The server gives each new play order its course id; adopt it. */
          session.playOrders = (data && data.overlay && data.overlay.playOrders) || session.playOrders;
          renderCourses();
          if (!destroyed) renderOrders();
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
    /* osm: "include" or "exclude" - what the mapper reads with it; the choice already made
       when not given (Run mapper marks a draft ready this way). */
    function markReady(osm) {
      var id = session.loadedFor;
      if (!canEdit() || !hasOverlay()) return Promise.resolve(false);
      var choice = osm === "exclude" || osm === "include" ? osm : session.osmMode;
      el["ready-choice"].hidden = true;
      busy = true; updateActions();
      setStatus("Saving, then marking ready…");
      return flushSave().then(function () {
        if (session.dirty) throw new Error("the overlay did not save (" + (session.saveError || "unknown") + ")");
        return api("POST", "", { courseId: id, status: "ready", osm: choice });
      }).then(function (data) {
        if (session.loadedFor !== id) return false;
        session.status = (data && data.status) || "ready";
        session.osmMode = (data && data.osm) === "exclude" ? "exclude" : "include";
        el["osm-mode"].value = session.osmMode;
        drawOsm();
        if (!destroyed) setStatus("Marked ready. The next mapper run will use these " + session.features.length + " shapes" +
          (session.osmMode === "exclude" ? " and the scorecard only - no OSM" : " with what OSM has here") +
          (session.playOrders.length ? ", and publish " + session.playOrders.length + " play order" + (session.playOrders.length === 1 ? "" : "s") + " as courses" : "") + ".");
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

    /* A fresh start on numbering without losing any drawing: every shape and link stays, only
       the numbers go, and the next mapper run numbers the holes from the scorecard. */
    function clearHoleNumbers() {
      if (!canEdit()) return;
      var numbered = session.features.filter(function (f) { return f.hole; });
      if (!numbered.length) return;
      if (!window.confirm("Take the hole number off all " + numbered.length + " numbered shapes? Shapes and links stay; the mapper numbers them from the scorecard.")) return;
      numbered.forEach(function (f) { f.hole = null; });
      setHole(null);
      drawFeatures();
      changed();
      flushSave();
      setStatus("Hole numbers cleared from " + numbered.length + " shapes. Mark ready and run the mapper to number them fresh.");
    }

    /* OSM's shapes made editable: what OSM has here that the overlay does not (the server's
       osmToOverlayFeatures, in gd-map-overlay-core), added as overlay shapes under the ids the
       server gave them, so the same shape is never offered twice. Saved and marked ready, each
       replaces the OSM shape it came from when the mapper runs. */
    function convertibleOsm() {
      var list = (session.osm && !session.osm.error && session.osm.convertible) || [];
      var have = {};
      session.features.forEach(function (f) { have[f.id] = true; });
      return list.filter(function (f) { return !have[f.id]; });
    }

    /* Copies what OSM has here into the overlay. Returns what was said about it, or "" when
       there was nothing to add. */
    function addOsmShapes() {
      var list = convertibleOsm();
      if (!list.length) return "";
      var room = { tree: roomFor("tree"), other: roomFor("") };
      var added = list.filter(function (f) { return room[f.kind === "tree" ? "tree" : "other"]-- > 0; });
      added.forEach(function (f) { session.features.push(JSON.parse(JSON.stringify(f))); });
      var counts = {};
      added.forEach(function (f) { var k = f.source === "auto" ? "default fairway" : f.kind === "trees" ? "tree area" : kindLabel(f.kind).toLowerCase(); counts[k] = (counts[k] || 0) + 1; });
      var said = Object.keys(counts).map(function (k) { return counts[k] + " " + k + (counts[k] === 1 ? "" : "s"); }).join(", ");
      return said + "." + (added.length < list.length ? " " + (list.length - added.length) + " more did not fit (" + MAX_FEATURES + " shapes and " + MAX_TREES + " single trees a course)." : "");
    }

    function convertOsm(auto) {
      if (!canEdit()) return;
      var said = addOsmShapes();
      if (!said) { if (!auto) setStatus("Everything OSM has here is already in the overlay."); return; }
      drawOsm();
      drawFeatures();
      changed();
      setStatus((auto ? "OSM's shapes are in the overlay, ready to reshape: " : "Added from OSM: ") + said + " Mark ready when they look right.");
    }

    /* Start fresh from OSM: everything OSM has here becomes the overlay's own shapes, and from
       then on the mapper reads only those - OSM is hidden and never read again for this course.
       The opposite of "My shapes only" from the menu, which offers to throw OSM's shapes away:
       here they are the starting point. */
    function startFresh() {
      var id = session.loadedFor;
      if (!canEdit() || !id) return;
      var list = convertibleOsm();
      if (!window.confirm("Start fresh from OSM?\n\n" + (list.length ? list.length + " shape" + (list.length === 1 ? "" : "s") + " OSM has here " + (list.length === 1 ? "is" : "are") + " copied into the overlay as your own" : "Everything OSM has here is already in the overlay") +
        ", and from now on the mapper reads only the shapes drawn here. OSM is hidden and not read again for this course (you can turn it back on under Mapper reads).")) return;
      var said = addOsmShapes();
      session.osmMode = "exclude";
      el["osm-mode"].value = "exclude";
      drawOsm();
      drawFeatures();
      changed();
      updateActions();
      saveOsmMode(id, "exclude", "Started fresh from OSM" + (said ? ": " + said : ".") + " The mapper now reads only your shapes. Mark ready when they look right.");
    }

    function saveOsmMode(id, mode, said) {
      api("POST", "", { courseId: id, osm: mode }).then(function (data) {
        if (session.loadedFor !== id) return;
        session.status = (data && data.status) || "draft";
        renderSaveState();
        setStatus(said);
      }).catch(function (error) {
        setStatus("Could not save the OSM choice: " + (error && error.message || error), true);
      });
    }

    function deleteOverlay() {
      if (!canEdit()) return;
      if (!window.confirm("Delete every overlay shape for this course? The mapper will go back to reading OSM alone.")) return;
      session.features = [];
      selectedId = "";
      adjust = null;
      finder = null;
      if (colourSel) clearColourSel();
      cancelDraft();
      drawFeatures();
      changed();
      flushSave();
    }

    /* "My shapes only" from the menu: OSM is hidden and kept out of the run. Shapes copied in
       from OSM can go too - asked, since some may have been reshaped by hand. The overlay goes
       back to draft: what the mapper reads has changed. */
    function setOsmMode(mode) {
      var id = session.loadedFor;
      if (!canEdit() || !id) { el["osm-mode"].value = session.osmMode; return; }
      mode = mode === "exclude" ? "exclude" : "include";
      if (mode === session.osmMode) return;
      session.osmMode = mode;
      if (mode === "exclude") {
        var fromOsm = session.features.filter(function (f) { return f.osm || f.source === "osm"; });
        if (fromOsm.length && window.confirm("Take out the " + fromOsm.length + " shape" + (fromOsm.length === 1 ? "" : "s") + " that came from OSM too?\n\nOK removes them. Cancel keeps them as your own shapes.")) {
          session.features = session.features.filter(function (f) { return fromOsm.indexOf(f) < 0; });
          selectedId = "";
          drawFeatures();
          changed();
        }
      }
      drawOsm();
      updateActions();
      saveOsmMode(id, mode, mode === "exclude" ? "My shapes only: OSM is hidden and the mapper will not read it. Mark ready when the drawing is done." : "The mapper reads OSM with your shapes again.");
    }
    function toggleReadyChoice() {
      if (!canEdit() || !hasOverlay()) return;
      el["ready-choice"].hidden = !el["ready-choice"].hidden;
      el["ready-choice"].querySelectorAll("[data-ready-osm]").forEach(function (b) { b.classList.toggle("isActive", b.getAttribute("data-ready-osm") === session.osmMode); });
    }

    /* ---- what OSM has here ---- */

    function clearOsmLayers() {
      osmLayers.forEach(function (l) { try { mapObj.removeLayer(l); } catch (e) {} });
      osmLayers = [];
    }

    function drawOsm() {
      clearOsmLayers();
      var osm = session.osm;
      if (!osm || !session.showOsm || session.osmMode === "exclude") return;
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
      /* An OSM shape already made editable is drawn as the overlay shape, not twice. */
      var converted = {};
      session.features.forEach(function (f) { if (f.osm) converted[f.osm] = true; });
      function own(list) { return (list || []).filter(function (item) { return !converted[item.id]; }); }
      add(own(osm.fairways), STYLE.osmFairway, true);
      add(own(osm.greens), STYLE.osmGreen, true);
      add(own(osm.tees), STYLE.osmTee, true);
      add(own(osm.bunkers), STYLE.osmBunker, true);
      add(own(osm.water), STYLE.osmWater, true);
      if (tool === "order") drawOrderOsmHoles(own(osm.holes));
      else add(own(osm.holes), STYLE.osmHole, false);
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
      else if (tool === "connect") text = linkPick.length > 1 ? linkPick.length + " picked · Enter or Space links them · Esc clears" : linkPick.length ? "Click the other shapes on this hole · Enter alone takes this one out of its link · Esc clears" : "Click the shapes that belong to one hole, then Enter or Space";
      else if (tool === "order") text = orderHint();
      else if (tool === "number") text = "Click each hole's fairway (or any shape on it) to give it hole " + session.numberNext + (session.numberAuto ? " · Auto moves on to the next number" : "") + " · click a number to type it";
      else if (tool === "fairway" && session.mode === "pins") text = draft.length ? "Click where the fairway ends · Esc cancels" : "Click where the fairway starts";
      else if (lineTool() && session.mode === "shapes") {
        var thing = tool === "fairway" ? "fairway" : kindLabel(tool).toLowerCase();
        var then = growWanding() ? " - the line wand grows it out to the edge" : "";
        text = draft.length ? (draft.length >= 2 ? "Keep clicking along the " + thing + " · Finish (or Enter / double-click) when done" + then : "Click the next point along the " + thing) : (tool === "fairway" ? "Click at the tee end of the fairway, then along its middle" : "Click a line down the middle of the " + thing) + then;
      }
      else if (methodOf(tool) === "colour") text = colourSel ? "Enter makes it " + colourNoun(tool) + " · ← → tighter / looser · Shift-drag adds · Esc drops it" : "Press on the " + colourThing(tool) + " and drag - further takes more of its colour · " + methodKey(tool) + " switches method";
      else if (tool === "trees" && methodOf("trees") === "single") text = "Click a tree to drop one · ↑ ↓ size it · E switches method";
      else if (tool === "trees" && methodOf("trees") === "oval") text = "Press and drag across a cluster of trees - Shift for a circle · E switches method";
      else if (tool === "trees" && methodOf("trees") === "auto") text = (session.hole ? "Finds trees along hole " + session.hole + "'s fairway and green" : "Finds trees along every fairway and green - set a hole number for just one") + ", out to " + (session.treeBandM || shapes.TREE_BAND_M) + "m · E switches method";
      else if (tool === "trees" && methodOf("trees") === "find") text = sampleTrees().length ? "Drag a box - trees in it like the " + sampleTrees().length + " you placed by hand are found · E switches method" : "Place a tree or two by hand first (Tree), then drag a box to find more like them";
      else if (tool === "trees") text = "Press and drag all the way round an area of dense trees · E switches method";
      else if (tool === "waste") text = "Draw roughly round the waste area - it grows out to the edge · A switches method";
      else if (tool === "hazard") text = "Press and drag all the way round a non-water hazard - gorse, scrub, a ravine · X switches method";
      else if (tool !== "move" && session.mode === "pins") text = "Click the middle of each " + kindLabel(tool).toLowerCase() + " to pin it";
      else if (drawRoundKind() && METHODS[tool]) text = "Press and drag all the way round the " + kindLabel(tool).toLowerCase() + " · " + tool.charAt(0).toUpperCase() + " switches method";
      else if (tool === "water") text = "Click the middle of the water - the wand outlines it · W switches method";
      else if (tool === "green") text = "Click the middle of a green";
      else if (tool === "bunker") text = "Click the middle of a bunker - the wand outlines it · B switches method";
      else if (tool === "tee") text = "Click where the tee is";
      if (lastPlacedId && tool !== "move" && tool !== "connect" && tool !== "number" && tool !== "order" && !draft.length && findFeature(lastPlacedId)) text += " · drag the one you just placed to adjust it";
      else if (selectedId && (findFeature(selectedId) || {}).kind === "tree") text = "Drag to move · Delete or the bin removes it";
      else if (selectedId && isSmooth(findFeature(selectedId) || {})) text = "Drag to move · drag its " + shapes.SMOOTH[findFeature(selectedId).kind].handles + " points to reshape · Delete or the bin removes it";
      else if (selectedId && (findFeature(selectedId) || {}).pin) text = "Drag to move · Shape this pin turns it into an outline · Delete or the bin removes it";
      else if (selectedId && !bigEnoughForHandles(findFeature(selectedId) || { points: [] })) text = "Drag to move · zoom in to reshape its corners · Delete or the bin removes it";
      else if (selectedId && isDetailed(findFeature(selectedId))) text = "Drag to move · grab the edge anywhere to bend it · drag a point to pull that stretch · zoom in for finer control · Delete or the bin removes it";
      else if (selectedId) text = "Drag to move · drag corners to reshape · faint dots add a corner · right-click a corner or drag it to the bin to remove it · Delete or the bin removes the shape";
      else text = "Choose Fairway, Green, Tee or Bunker to place · click a shape in Move to adjust it · Shift-drag a box to delete everything inside it · Link puts shapes on one hole";
      var held = selectedId && tool === "move" && canEdit() ? findFeature(selectedId) : null;
      if (held && !held.pin && RESHAPE[held.kind] && !adjusted()) text = "↑ ↓ " + (held.kind === "fairway" ? "smooth the edge, then " : "") + "smaller / bigger · " + text;
      if (adjusted()) text = adjustHint();
      if (finder) text = "← → fewer / more trees · Enter keeps them · Esc takes them away";
      else if (treeEdit && !adjusted()) text = "Trees: click one to drop it (again to keep it) · ← → fewer / more · Publish tree changes puts them on the watch · Esc closes";
      if (wandsRunning) text = "Working… · " + text;
      el.hint.textContent = text;
      renderCollar();
    }

    function adjustHint() {
      var bits = [];
      if (adjust.candidates.length > 1) bits.push("← → sensitivity " + (adjust.index + 1) + " of " + adjust.candidates.length);
      if (adjust.kind === "fairway" && adjust.line) bits.push("↑ ↓ narrower / wider (" + session.fairwayWidth + "m)");
      else if (RESHAPE[adjust.kind]) bits.push("↑ ↓ " + (adjust.kind === "fairway" ? "smooth the edge, then " : "") + "smaller / bigger" + (adjust.reshape && adjust.reshape.steps ? " (" + reshapeWords(adjust.kind, adjust.reshape.steps) + ")" : ""));
      else if (adjust.seed) bits.push("↑ ↓ wand size (" + pct(adjust.size) + ")");
      else if (adjust.grow) bits.push("↑ ↓ reach (" + Math.round(LINE_WAND_REACH_M[adjust.kind] * adjust.grow.size) + "m)");
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
        var water = count("water"), trees = count("trees"), single = count("tree"), hazards = count("hazard"), waste = count("waste");
        bits.push("placed: " + count("fairway") + " fairways, " + count("green") + " greens, " + count("tee") + " tees, " + count("bunker") + " bunkers" + (water ? ", " + water + " water" : "") + (single ? ", " + single + " trees" : "") + (trees ? ", " + trees + " tree clusters" : "") + (hazards ? ", " + hazards + " hazards" : "") + (waste ? ", " + waste + " waste areas" : "") + (holes ? ", " + holes + " hole lines" : ""));
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
      renderUndo();
      var has = !!session.course && !busy;
      el.ai.disabled = !has || scanning || !!draft.length;
      el.ai.title = draft.length ? "Finish or cancel the fairway you are placing first" : scanning ? "A scan is running" : "";
      el["source-test"].disabled = !has || scanning || sourceTesting;
      var sourceScan = el["source-panel"].querySelector('[data-gd-source-test="scan"]');
      if (sourceScan) sourceScan.disabled = scanning;
      el.clear.disabled = !canEdit() || !session.features.length;
      var convertible = session.course ? convertibleOsm().length : 0;
      el.convert.disabled = !canEdit() || !convertible || session.osmMode === "exclude";
      el["osm-mode"].disabled = !canEdit();
      el.convert.textContent = convertible ? "Make OSM editable (" + convertible + ")" : "Make OSM editable";
      el.fresh.disabled = !canEdit() || !session.loadedFor || session.osmMode === "exclude";
      el.fresh.title = session.osmMode === "exclude" ? "Already reading your shapes only - switch Mapper reads back to OSM + my shapes to start again from OSM"
        : "Copy everything OSM has here into the overlay as your own shapes, then stop reading OSM for this course: from here on the mapper reads only the shapes drawn here, starting from OSM's.";
      el.unnumber.disabled = !canEdit() || !session.features.some(function (f) { return f.hole; });
      el.run.disabled = !has || session.dirty;
      el.run.title = session.dirty ? "Wait for the overlay to save - the mapper reads what is saved" : "";
      el.ready.disabled = !canEdit() || !hasOverlay() || (session.status === "ready" && !session.dirty);
      el.ready.title = session.status === "ready" && !session.dirty ? "Already ready - change a shape and it goes back to draft" : "Let the mapper use this overlay";
      ["tool-connect", "tool-number", "tool-order", "tool-fairway", "tool-green", "tool-tee", "tool-bunker", "tool-water", "tool-trees", "tool-hazard", "tool-waste"].forEach(function (name) { el[name].disabled = !canEdit() || !!shapingPins; });
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
      loadTrees(id);
      busy = true; updateActions();
      setStatus("Loading overlay and OSM features…");
      api("GET", "?courseId=" + encodeURIComponent(id) + "&osm=1").then(function (data) {
        if (destroyed || courseIdOf(session.course) !== id) return;
        session.features = (data && data.overlay && data.overlay.features) || [];
        session.playOrders = (data && data.overlay && data.overlay.playOrders) || [];
        session.facility = (data && data.facility) || null;
        session.variant = id;
        session.status = (data && data.overlay && data.overlay.status) || "draft";
        session.osmMode = (data && data.overlay && data.overlay.osm) === "exclude" ? "exclude" : "include";
        el["osm-mode"].value = session.osmMode;
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
        if (restored) {
          session.features = unsaved.features;
          if (Array.isArray(unsaved.playOrders)) session.playOrders = unsaved.playOrders;
          session.dirty = true;
          session.rev++;
        }
        if (!session.playOrders.some(function (o) { return o.id === session.activeOrder; })) session.activeOrder = session.playOrders.length ? session.playOrders[0].id : "";
        var own = orderFor(id);
        if (own) session.activeOrder = own.id;
        renderCourses();
        resetUndo();
        selectedId = "";
        busy = false;
        drawOsm();
        drawObjects();
        drawFeatures();
        renderHoleField();
        renderOrders();
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
        if (destroyed) return;
        /* A course with nothing in its overlay yet starts from what OSM has, ready to reshape. It
           saves as a draft, which the mapper ignores until it is marked ready. */
        if (session.loadedFor === id && !hasOverlay() && session.osmMode !== "exclude") convertOsm(true);
        updateActions(); updateReadout(); updateHint(); updateBin();
      });
    }

    function runMapper() {
      var id = courseIdOf(session.course);
      if (!id || busy || session.dirty) return;
      var name = session.course.name || session.course.courseName || id;
      /* A draft is not read by the mapper, so running "with this overlay" means marking it
         ready first - asked, never assumed. */
      if (hasOverlay() && session.status !== "ready") {
        if (!window.confirm("This overlay is still a draft, and the mapper ignores drafts.\n\nMark it ready and run the mapper on " + name + "?\n\nThis clears the course's existing geometry and resolves it again from " + (session.osmMode === "exclude" ? "your shapes and the scorecard only - no OSM" : "OSM plus the overlay") + ". Visuals are not touched.")) return;
        markReady().then(function (ok) { if (ok && !destroyed) queueMapper(id); });
        return;
      }
      if (!window.confirm("Run the mapper on " + name + (hasOverlay() ? " with this overlay" : "") + "?\n\nThis clears the course's existing geometry and resolves it again from " + (hasOverlay() && session.osmMode === "exclude" && session.status === "ready" ? "your shapes and the scorecard only - no OSM" : "OSM" + (hasOverlay() ? " plus the overlay" : "")) + "." +
        (session.playOrders.length ? " It publishes the " + session.playOrders.length + " play order" + (session.playOrders.length === 1 ? "" : "s") + " as this facility's courses, and unpublishes any other course listed under it." : "") + " Visuals are not touched.")) return;
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

    /* One tile, loaded: the image, or null when it would not load. */
    function loadTile(url) {
      return new Promise(function (done) {
        var img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = function () { done(img); };
        img.onerror = function () { done(null); };
        img.src = url;
      });
    }

    /* `reuse` (a Map of tile url -> loadTile promise, optional) lets pictures taken one after
       another share the tiles they overlap on - the tree finder near play reads a fairway and
       then its green, most of the same ground. The urls this picture used come back as
       `urls`, so the caller can let go of the rest. */
    function stitchTiles(z, x0, y0, x1, y1, reuse) {
      var full = document.createElement("canvas");
      full.width = (x1 - x0 + 1) * 256; full.height = (y1 - y0 + 1) * 256;
      var ctx = full.getContext("2d");
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, full.width, full.height);
      var loads = [], urls = [];
      var failed = 0;
      for (var ty = y0; ty <= y1; ty++) {
        for (var tx = x0; tx <= x1; tx++) {
          (function (cx, cy) {
            var url;
            try { url = tileUrlAt(cx, cy, z); } catch (e) { failed++; return; }
            var tile = reuse && reuse.get(url);
            if (!tile) { tile = loadTile(url); if (reuse) reuse.set(url, tile); }
            urls.push(url);
            loads.push(tile.then(function (img) {
              if (!img) { failed++; if (reuse) reuse.delete(url); return; }
              try { ctx.drawImage(img, (cx - x0) * 256, (cy - y0) * 256, 256, 256); } catch (e) { failed++; }
            }));
          })(tx, ty);
        }
      }
      return Promise.all(loads).then(function () { return { canvas: full, tiles: (x1 - x0 + 1) * (y1 - y0 + 1), failed: failed, urls: urls }; });
    }

    /* The picture the wand reads: a few tiles around a pin at the zoom nearest the kind's
       WAND_TARGET_MPP the provider really has, unscaled. */
    function captureAround(point, coarser, kind, size) {
      return new Promise(function (resolve, reject) {
        var refused = captureRefusal();
        if (refused) return reject(new Error(refused));
        var native = num(layer.options && layer.options.maxNativeZoom) || num(layer.options && layer.options.maxZoom) || 19;
        var mppZ0 = 156543.03392 * Math.cos(point.lat * Math.PI / 180);
        var z = Math.max(14, Math.min(native, Math.round(Math.log2(mppZ0 / WAND_TARGET_MPP[kind]))) - (coarser || 0));
        var mpp = mppZ0 / Math.pow(2, z);
        var half = Math.ceil(Math.sqrt(WAND_MAX_M2[kind] * (size || 1) * (size || 1) / Math.PI) / mpp * 1.6 + 24);
        /* A big wand size reaches a long way: one zoom coarser per doubling past the cap, so a
           lake at 6x is a picture the wand can still read and the request can still carry. */
        while (half > WAND_CAPTURE_MAX_HALF_PX && z > 14) { z--; mpp *= 2; half = Math.ceil(half / 2); }
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
        var refused = captureRefusal(true);
        if (refused) return reject(new Error(refused));
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
            resetUndo();
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
        loadTrees(id);
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
      setTimeout(function () {
        if (destroyed) return;
        if (mapObj) { try { mapObj.invalidateSize(); } catch (e) {} }
        if (google) { try { google.map.invalidateSize(); syncGoogle(); } catch (e) {} }
      }, 60);
    }

    /* ---- Google alongside ----
       Google satellite in a pane beside the drawing map, to compare the ground against - never
       drawn on, never read by a wand (Google's terms license it for display). The two maps
       follow each other: pan or zoom either and the other goes to the same place. `following`
       stops the echo, since setView fires the other map's move events straight away. */
    var google = null;
    var following = false;
    function follow(from, to) {
      if (!google || following) return;
      following = true;
      try { to.setView(from.getCenter(), from.getZoom(), { animate: false }); } catch (e) {}
      following = false;
    }
    function syncGoogle() { if (google) follow(mapObj, google.map); }

    /* The same spot on both maps: a box under the pointer on either, mirrored on the other,
       so a green seen on Google can be found on the drawing map. A click on Google parks it
       there on both until the next click or Google is closed. Only a marker - nothing is
       placed or traced from Google, which is licensed for display. */
    var spot = { hover: null, parked: null, markers: [] };
    function spotIcon(parked) {
      return L.divIcon({ className: "gdStudioOverlaySpot" + (parked ? " isParked" : ""), iconSize: [22, 22], iconAnchor: [11, 11] });
    }
    function drawSpot() {
      var at = google && (spot.hover || spot.parked);
      if (!at) {
        spot.markers.forEach(function (m) { try { m.remove(); } catch (e) {} });
        spot.markers = [];
        return;
      }
      var parked = !spot.hover;
      if (!spot.markers.length) {
        spot.markers = [mapObj, google.map].map(function (map) {
          return L.marker([at.lat, at.lng], { icon: spotIcon(parked), interactive: false, keyboard: false }).addTo(map);
        });
        spot.parkedIcon = parked;
        return;
      }
      spot.markers.forEach(function (m) {
        m.setLatLng([at.lat, at.lng]);
        if (spot.parkedIcon !== parked) m.setIcon(spotIcon(parked));
      });
      spot.parkedIcon = parked;
    }
    function spotHover(e) { spot.hover = e && e.latlng ? { lat: e.latlng.lat, lng: e.latlng.lng } : null; drawSpot(); }
    function syncMain() { if (google) follow(google.map, mapObj); }
    function setGoogle(on) {
      var api = sourcesApi();
      if (on && !(api.googleReady && api.googleReady())) {
        setStatus("Google satellite needs GOOGLE_MAP_TILES_KEY on the site.", true);
        on = false;
      }
      session.googleSplit = !!on;
      el.google.classList.toggle("isActive", !!on);
      el["google-pane"].hidden = !on;
      if (on && !google) {
        var map = L.map(el["google-map"], {
          zoomControl: false, attributionControl: false, doubleClickZoom: true, scrollWheelZoom: true,
          zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 90, wheelDebounceTime: 20, maxZoom: 22
        }).setView(mapObj.getCenter(), mapObj.getZoom());
        var tiles = api.googleLayer().addTo(map);
        /* Google publishes no capture date through the Map Tiles API, so the pane says so
           rather than looking like the one source nobody asked. */
        tiles.on("gdcredit", function (e) { el["google-credit"].textContent = e.text + " · capture date not published"; });
        google = { map: map };
        map.on("move", syncMain);
        map.on("mousemove", spotHover);
        map.on("mouseout", function () { spotHover(null); });
        map.on("click", function (e) { spot.parked = { lat: e.latlng.lat, lng: e.latlng.lng }; drawSpot(); });
      } else if (!on && google) {
        spot.hover = spot.parked = null;
        drawSpot();
        try { google.map.remove(); } catch (e) {}
        google = null;
      }
      remember();
      remeasure();
    }

    /* Leaving the course: a change that has not saved is asked about first. */
    function canLeaveCourse() {
      if (session.saveError && session.dirty && !window.confirm("The last change has not saved (" + session.saveError + "). Pick another course and lose it?")) return false;
      flushSave();
      return true;
    }

    function pickCourse() {
      if (!canLeaveCourse()) return;
      var pick = window.GDStudioCoursePick;
      var opened = pick && typeof pick.open === "function" && pick.open({
        source: "studio-map-overlay",
        onReturn: remeasure,
        onPick: function (course) { if (!destroyed) { cancelDraft(); setTool("move"); setMenu(false); showCourse(course); } }
      });
      if (!opened) setStatus("The course picker is not loaded on this surface.", true);
    }

    /* ---- the inbox ----
       Courses players asked the app to map (functions/lib/gd-overlay-inbox.mjs): Map fix when
       the latest run failed, Upgrade objects when it mapped. Open picks the course; Dismiss
       takes it out until a player asks for it again; marking its overlay ready takes it out
       too. Read when the page opens and each time the pull-down opens. */

    var inbox = { items: [], loading: false, error: "" };

    function loadInbox() {
      if (inbox.loading) return;
      inbox.loading = true;
      api("GET", "?inbox=1").then(function (data) {
        inbox.items = (data && data.items) || [];
        inbox.error = "";
      }, function (error) {
        inbox.error = String(error && error.message || error);
      }).then(function () {
        inbox.loading = false;
        if (!destroyed) renderInbox();
      });
    }

    function ago(iso) {
      var mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
      if (mins < 60) return mins + "m ago";
      if (mins < 48 * 60) return Math.round(mins / 60) + "h ago";
      return Math.round(mins / 1440) + "d ago";
    }

    function renderInbox() {
      var items = inbox.items;
      el["inbox-count"].hidden = !items.length;
      el["inbox-count"].textContent = items.length;
      var current = courseIdOf(session.course);
      var html = '<div class="gdStudioOverlayInboxHead"><strong>Inbox</strong> · courses players asked to map' +
        (inbox.error ? ' · <span class="gdStudioWarnText">' + esc(inbox.error) + "</span>" : "") + "</div>";
      if (!items.length) html += inbox.error ? "" : '<div class="gdStudioMuted">Nothing waiting.</div>';
      items.forEach(function (item) {
        var fix = item.need === "fix";
        var bits = ["asked " + ago(item.requestedAt)];
        if (item.players > 1) bits.push(item.players + " players");
        if (item.overlay) bits.push("overlay " + item.overlay);
        html += '<div class="gdStudioOverlayInboxItem' + (item.courseId === current ? " isCurrent" : "") + '">' +
          '<span class="gdStudioOverlayInboxTag' + (fix ? " isFix" : "") + '">' + (fix ? "Map fix" : "Upgrade objects") + "</span>" +
          '<span class="gdStudioOverlayInboxName"><strong>' + esc(item.name) + "</strong> " + '<span class="gdStudioMuted">' + esc(bits.join(" · ")) + "</span>" +
          (fix && item.lastError ? '<br><span class="gdStudioWarnText">' + esc(item.lastError) + "</span>" : "") + "</span>" +
          '<button type="button" class="gdStudioDiagramBtn" data-inbox-act="open" data-inbox-id="' + esc(item.courseId) + '">Open</button>' +
          '<button type="button" class="gdStudioDiagramBtn" data-inbox-act="dismiss" data-inbox-id="' + esc(item.courseId) + '" title="Take it out of the inbox - it comes back if a player asks for it again">Dismiss</button>' +
          "</div>";
      });
      el.inbox.innerHTML = html;
    }

    function onInboxClick(event) {
      var button = event.target.closest && event.target.closest("[data-inbox-act]");
      if (!button) return;
      var id = button.getAttribute("data-inbox-id");
      var item = inbox.items.filter(function (i) { return i.courseId === id; })[0];
      if (!item) return;
      if (button.getAttribute("data-inbox-act") === "open") {
        if (!canLeaveCourse()) return;
        cancelDraft();
        setTool("move");
        setMenu(false);
        showCourse({ courseId: item.courseId, name: item.name, lat: item.lat, lng: item.lng });
        return;
      }
      button.disabled = true;
      api("POST", "", { courseId: id, inboxDismiss: true }).then(function () {
        inbox.items = inbox.items.filter(function (i) { return i.courseId !== id; });
        if (!destroyed) renderInbox();
      }, function (error) {
        button.disabled = false;
        setStatus("Could not dismiss it: " + (error && error.message || error), true);
      });
    }

    /* ---- boot ---- */

    mapObj = L.map(el.map, {
      zoomControl: false,
      attributionControl: false,
      /* Shift-drag is the bin box in Move, not Leaflet's box zoom. */
      boxZoom: false,
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
      if (lineTool()) finishFairway();
    });
    mapObj.on("mousemove", function (e) { if (google) spotHover(e); });
    mapObj.on("mouseout", function () { if (google) spotHover(null); });
    mapObj.on("mousemove", function (e) {
      if (!lineTool() || !draft.length) return;
      cursorLatLng = { lat: e.latlng.lat, lng: e.latlng.lng };
      drawDraft();
    });
    mapObj.on("mouseout", function () { if (cursorLatLng) { cursorLatLng = null; drawDraft(); } });
    mapObj.on("moveend zoomend", function () { buildProviderOptions(); updateReadout(); refreshCaptureDate(); });
    /* The colour wand reads the view on screen: a moved map is a new picture. */
    mapObj.on("movestart zoomstart", function () { colourCap = null; });
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
      if (!containerEl.isConnected) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && String(event.key || "").toLowerCase() === "z") {
        if (!session.course) return;
        event.preventDefault();
        undo();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape" && !el.menu.hidden) { event.preventDefault(); setMenu(false); return; }
      if (event.key === "Escape" && fullscreen && !draft.length && !selectedId && tool === "move") { event.preventDefault(); setFullscreen(false); return; }
      if (tool === "connect" && linkPick.length && session.course && canEdit()) {
        if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") { event.preventDefault(); commitLink(); return; }
        if (event.key === "Escape") { event.preventDefault(); clearLinkPick(); return; }
      }
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
      if (key === "k" && collarGreen()) { addCollar(); return; }
      /* The tool's own key again steps through its methods: wand, draw round, line + wand. */
      var own = { f: "fairway", g: "green", t: "tee", b: "bunker", w: "water", e: "trees", x: "hazard", a: "waste" }[key];
      if (own && own === tool && methodOf(own) && canEdit()) { cycleMethod(own); return; }
      var shortcut = { v: "move", c: "connect", n: "number", o: "order", f: "fairway", g: "green", t: "tee", b: "bunker", w: "water", e: "trees", x: "hazard", a: "waste" }[key];
      if (shortcut && (shortcut === "move" || canEdit())) setTool(shortcut);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("keydown", onAdjustKey, true);

    el.pick.addEventListener("click", pickCourse);
    el.inbox.addEventListener("click", onInboxClick);
    loadInbox();
    el.provider.addEventListener("change", function () { useSource(el.provider.value); });
    el.osm.checked = session.showOsm;
    el.osm.addEventListener("change", function () { session.showOsm = el.osm.checked; drawOsm(); remember(); });
    el.objects.checked = session.showObjects;
    el.objects.addEventListener("change", function () { session.showObjects = el.objects.checked; drawObjects(); remember(); });
    el.ai.addEventListener("click", scanWithAi);
    el["source-test"].addEventListener("click", runSourceTest);
    el["tool-move"].addEventListener("click", function () { setTool("move"); });
    el["tool-connect"].addEventListener("click", function () { setTool("connect"); });
    el["tool-number"].addEventListener("click", function () { setTool("number"); });
    el["tool-order"].addEventListener("click", function () { setTool("order"); });
    el.orders.addEventListener("click", onOrdersClick);
    el.courses.addEventListener("click", onCoursesClick);
    el.orders.addEventListener("change", onOrdersChange);
    el["number-auto"].checked = !!session.numberAuto;
    el["number-auto"].addEventListener("change", function () { session.numberAuto = el["number-auto"].checked; remember(); updateHint(); });
    el["number-next"].addEventListener("change", function () {
      var n = holeNumber(el["number-next"].value);
      if (n) session.numberNext = n;
      renderNumberField();
      updateHint();
    });
    el["tool-fairway"].addEventListener("click", function () { setTool("fairway"); });
    el["tool-green"].addEventListener("click", function () { setTool("green"); });
    el["tool-tee"].addEventListener("click", function () { setTool("tee"); });
    el["tool-bunker"].addEventListener("click", function () { setTool("bunker"); });
    el["tool-water"].addEventListener("click", function () { setTool("water"); });
    el["tool-trees"].addEventListener("click", function () { setTool("trees"); });
    el["tool-hazard"].addEventListener("click", function () { setTool("hazard"); });
    el["tool-waste"].addEventListener("click", function () { setTool("waste"); });
    METHOD_NAMES.forEach(function (m) {
      el["method-" + m].addEventListener("click", function () { setMethod(tool, m); });
    });
    el.map.addEventListener("pointerdown", onMapPress);
    el.hole.addEventListener("change", holeFieldChanged);
    el["tree-auto"].addEventListener("click", runNearPlay);
    el.trees.addEventListener("click", onTreesButton);
    el["tree-less"].addEventListener("click", function () { if (treeEdit) stepTreeLevel(-1); });
    el["tree-more"].addEventListener("click", function () { if (treeEdit) stepTreeLevel(1); });
    el["tree-publish"].addEventListener("click", publishTrees);
    el["tree-close"].addEventListener("click", function () { closeTreeEdit(false); });
    el["tree-rerun"].addEventListener("click", function () {
      runTrees("Find this course's trees again from its imagery?\n\nThe new run replaces these trees, edits included, and goes live on the watch when it finishes.");
    });
    renderTreesButton();
    el["tree-band"].addEventListener("change", function () {
      var b = num(el["tree-band"].value);
      session.treeBandM = b && b >= TREE_BAND_MIN_M && b <= TREE_BAND_MAX_M ? Math.round(b) : shapes.TREE_BAND_M;
      el["tree-band"].value = session.treeBandM;
      updateHint();
      remember();
    });
    el["tree-heights"].addEventListener("change", function () {
      session.treeHeights = !!el["tree-heights"].checked;
      remember();
    });
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
    el.seams.checked = session.seams;
    el.seams.addEventListener("change", function () { session.seams = el.seams.checked; remember(); });
    el["shape-pins"].addEventListener("click", shapePins);
    el.collar.addEventListener("click", addCollar);
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
    el.undo.addEventListener("click", undo);
    el["zoom-shape"].addEventListener("click", zoomToSelected);
    el.fullscreen.addEventListener("click", function () { setFullscreen(!fullscreen); });
    el.google.addEventListener("click", function () { setGoogle(!google); });
    mapObj.on("move", syncGoogle);
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
    el.convert.addEventListener("click", function () { convertOsm(false); });
    el.fresh.addEventListener("click", startFresh);
    el.unnumber.addEventListener("click", clearHoleNumbers);
    el.ready.addEventListener("click", toggleReadyChoice);
    el["ready-choice"].addEventListener("click", function (event) {
      var b = event.target.closest && event.target.closest("[data-ready-osm]");
      if (b) markReady(b.getAttribute("data-ready-osm"));
    });
    el["osm-mode"].addEventListener("change", function () { setOsmMode(el["osm-mode"].value); });
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
    if (session.googleSplit && sourcesApi().googleReady && sourcesApi().googleReady()) setGoogle(true);
    remeasure();

    return function cleanup() {
      /* Whatever is waiting to save goes now - leaving the page must not lose the last drag. */
      flushSave();
      destroyed = true;
      if (scanTimer) clearTimeout(scanTimer);
      if (trees.timer) clearTimeout(trees.timer);
      if (saveTimer) clearTimeout(saveTimer);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("keydown", onAdjustKey, true);
      document.removeEventListener("pointermove", onLassoMove);
      document.removeEventListener("pointerup", onLassoEnd);
      document.removeEventListener("pointercancel", onLassoEnd);
      document.removeEventListener("pointermove", onStretchMove);
      document.removeEventListener("pointerup", onStretchEnd);
      document.removeEventListener("pointercancel", onStretchEnd);
      document.removeEventListener("pointermove", onColourMove);
      document.removeEventListener("pointerup", onColourEnd);
      document.removeEventListener("pointercancel", onColourEnd);
      if (colourPress && colourPress.frame) cancelAnimationFrame(colourPress.frame);
      document.documentElement.classList.remove("gdStudioOverlayNoScroll");
      containerEl.classList.remove("gdStudioOverlayHost");
      rememberNow();
      document.removeEventListener("pointermove", onDragMove);
      document.removeEventListener("pointerup", onDragEnd);
      document.removeEventListener("pointercancel", onDragEnd);
      if (window.GDStudioCoursePick) window.GDStudioCoursePick.cancel();
      if (window.GDStudioShell) window.GDStudioShell.show();
      if (google) { try { google.map.remove(); } catch (e) {} }
      google = null;
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
