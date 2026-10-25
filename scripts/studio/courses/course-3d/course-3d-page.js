/* Clarity Studio — 3D Course Viewer. Studio-only.
 *
 * What it is for: walking round a hole's 3D model, or the whole course's, with a camera you
 * control, to see what the terrain mesh, the illustrated map and its trees actually look like
 * as geometry - and trimming the course's outline on it. The outline and asking for a course
 * map to be built are the only things it writes (through /api/course-map).
 *
 * The whole course is the course map (functions/lib/gd-course-surface-core.mjs): every hole's
 * captures composited once over the course, with the course terrain, built by the visual
 * worker after each published export. The outline is drawn on it here and cuts the ground
 * outside away - on the whole course and on every hole - and saving it rebuilds the course
 * map cropped to it.
 *
 * The scene, the camera and how the picture and trees are built are app/js/gd-course-3d.js.
 * GPS Play's 3D mode draws its terrain with the same scene (through Play's own framing, not
 * this free camera), so the ground and trees here are what a player sees. This page owns only
 * its controls: the course and hole pickers, style, relief and the views, and the Hybrid
 * style's blend settings (session.hybrid).
 *
 * What it reads, and from where:
 *   - GET /api/course-visuals?courseId=  the course's visual record: each hole's frame and its
 *                                         playSurface metadata, elevation sidecar included
 *   - GET /api/course-visual-assets       the frame JPEG and the elevation PNG themselves
 *   - GET /api/course-package             the shapes the illustrated map and the trees come from
 *   - GET/POST /api/course-map            the course map's build jobs; save the outline, ask for
 *                                         a build (admin, with the Studio session's token)
 * The course map and the saved outline themselves ride on the visual record
 * (course_surface, course_boundary).
 */
(function () {
  "use strict";

  /* Hybrid style: the illustrated map blended over the photo, to find out how far the two can
     be mixed. The settings' shape and defaults are scripts/gd-hybrid-look.js's; Save stores
     them through /api/play-view, and Play's Auto map style draws with what is saved on every
     hole that meets the watch maps' criteria. hybridSaved is the last saved (or loaded) copy,
     for Reset and for the note beside Save. */
  var HYBRID = window.GDHybridLook;
  function defaultHybrid() { return HYBRID ? HYBRID.normalize(null) : null; }

  /* Survives leaving and re-entering the page, like Map Viewport. */
  /* hole is a hole number or WHOLE. surface and boundary are the record's course map and saved
     outline; draft is the outline as trimmed and not yet saved (null: nothing unsaved). */
  var WHOLE = "course";
  var session = { courseKey: "", courseName: "", course: null, hole: null, style: "photo", exaggeration: 2.5,
    hybrid: defaultHybrid(), surface: null, boundary: null, draft: null };
  var hybridSaved = { settings: null, updatedAt: null, loaded: false, touched: false };
  var HYBRID_SURFACES = [["greens", "Greens"], ["fairways", "Fairways"], ["bunkers", "Bunkers"], ["water", "Water"], ["trees", "Woods"], ["tees", "Tees"]];

  var ASSET_API = "/api/course-visual-assets";
  var MAP_API = "/api/course-map";
  var POLL_MS = 5000;
  var OUTLINE_PAD_M = 35;       // Start from the holes: this far round everything mapped
  var OUTLINE_SIMPLIFY_M = 6;   // and no point that bends the line by less than this

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function assetUrl(path) { return ASSET_API + "?path=" + encodeURIComponent(String(path || "")); }
  function slug(course) {
    return String(course && (course.courseId || course.id || course.canonicalKey || course.courseKey) || "")
      .toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90);
  }

  /* Every published hole frame in the record (the role the visual worker writes for Play). */
  function holesFromRecord(record) {
    var assets = record && (Array.isArray(record.uploaded_assets) ? record.uploaded_assets
      : Array.isArray(record.uploadedAssets) ? record.uploadedAssets : []) || [];
    var byHole = {};
    assets.forEach(function (asset) {
      var meta = asset && asset.metadata && asset.metadata.playSurface;
      var n = Number(asset && asset.holeNumber);
      if (asset && asset.role === "hole-frame-published" && meta && n > 0 && asset.path) byHole[n] = { holeNumber: n, path: String(asset.path), meta: meta };
    });
    return Object.keys(byHole).map(Number).sort(function (a, b) { return a - b; }).map(function (n) { return byHole[n]; });
  }

  function savedRing() { return session.boundary && Array.isArray(session.boundary.ring) ? session.boundary.ring : null; }
  function sameRing(a, b) {
    if (!a || !b) return !a && !b;
    return a.length === b.length && a.every(function (p, i) { return Math.abs(p.lat - b[i].lat) < 1e-7 && Math.abs(p.lng - b[i].lng) < 1e-7; });
  }

  /* ---- Start from the holes: an outline round everything mapped ----
     The convex hull of every green, fairway, bunker and tee and each hole's tee, route and
     green, grown by OUTLINE_PAD_M (the hull of a circle round each hull point) and thinned
     to the points that matter. A starting shape to trim, never the answer: a dogleg round
     houses keeps the houses until they are cut out. */
  function hull(points) {
    var pts = points.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    if (pts.length < 3) return pts;
    function turn(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
    var lower = [], upper = [];
    pts.forEach(function (p) {
      while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    });
    for (var i = pts.length - 1; i >= 0; i--) {
      var p = pts[i];
      while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    return lower.slice(0, -1).concat(upper.slice(0, -1));
  }
  /* Douglas-Peucker on a closed ring of metres. */
  function simplify(ring, tolerance) {
    if (ring.length <= 4) return ring;
    function drop(a, b, pts) {
      var best = -1, bestD = tolerance;
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
        var d = Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
        if (d > bestD) { bestD = d; best = i; }
      }
      if (best < 0) return [a];
      return drop(a, pts[best], pts.slice(0, best)).concat(drop(pts[best], b, pts.slice(best + 1)));
    }
    var half = Math.floor(ring.length / 2);
    return drop(ring[0], ring[half], ring.slice(1, half)).concat(drop(ring[half], ring[0], ring.slice(half + 1)));
  }
  function outlineAround(latlngs) {
    if (latlngs.length < 3) return null;
    var lat0 = latlngs[0].lat, lng0 = latlngs[0].lng, ky = 111320, kx = 111320 * Math.cos(lat0 * Math.PI / 180);
    var grown = [];
    hull(latlngs.map(function (p) { return [(p.lng - lng0) * kx, (p.lat - lat0) * ky]; })).forEach(function (p) {
      for (var k = 0; k < 16; k++) {
        var a = k / 16 * Math.PI * 2;
        grown.push([p[0] + Math.cos(a) * OUTLINE_PAD_M, p[1] + Math.sin(a) * OUTLINE_PAD_M]);
      }
    });
    var ring = simplify(hull(grown), OUTLINE_SIMPLIFY_M);
    return ring.length >= 3 ? ring.map(function (p) { return { lat: lat0 + p[1] / ky, lng: lng0 + p[0] / kx }; }) : null;
  }

  function render(containerEl) {
    var destroyed = false;
    var viewer = null;
    var loadToken = 0;
    var holes = [];
    var pkgPromise = null, pkgKey = "";
    var jobs = [], pollTimer = 0, busy = "";

    containerEl.innerHTML =
      '<div class="gdStudioLede" style="margin-bottom:12px">' +
      "<p>View only. A hole's 3D model, made from the same published picture, elevation and trees GPS Play uses, " +
      "with a camera you can move anywhere. The same scene is what Play's 3D mode (the cube on its tool rail) plays on. " +
      "Pick a course, then a hole. Each tree's species is guessed from the photo; " +
      "on the photo the nearest trees are the realistic models, the rest low-poly. " +
      "<strong>Hybrid</strong> blends the illustrated map over the photo: how much, how, and where.</p>" +
      "<p><strong>Whole course</strong> (top of the hole list) stands the course map up: every hole's scan composited into one surface. " +
      "<strong>Trim outline</strong> draws the course's outline on it - drag a point to move it, drag a halfway dot to add one, " +
      "right-click or hold a point to remove it. Ground outside the outline is cut away, here and on every hole. " +
      "<strong>Save outline</strong> keeps it and rebuilds the course map to it.</p>" +
      "<p><strong>Orbit</strong>: drag to turn, right-drag or shift-drag to slide, scroll to zoom. " +
      "<strong>Walk</strong>: drag to look, W A S D to walk, shift to run. Both: W A S D move, Q E turn, R F up and down.</p></div>" +
      '<div class="gdStudioViewportBar">' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-3d="pick">Pick course</button>' +
      '<label class="gdStudioViewportField">Course key <input data-gd-3d="key" type="text" placeholder="course-key" style="width:180px"></label>' +
      '<label class="gdStudioViewportField">Hole <select data-gd-3d="hole"></select></label>' +
      '<label class="gdStudioViewportField">Style <select data-gd-3d="style">' +
      '<option value="photo">Photo</option><option value="illustrated">Illustrated</option><option value="hybrid">Hybrid</option></select></label>' +
      '<label class="gdStudioViewportField">Relief <input data-gd-3d="relief" type="range" min="0" max="6" step="0.25"> <span data-gd-3d="reliefValue"></span></label>' +
      "</div>" +
      /* Hybrid only. The blend row is live (uniforms); the mask row redraws the mask; Trees
         rebuilds the hole. */
      '<div data-gd-3d="hybridBar">' +
      '<div class="gdStudioViewportBar">' +
      '<label class="gdStudioViewportField">Blend <input data-gd-3d="hBlend" type="range" min="0" max="100" step="1"> <span data-gd-3d="hBlendValue"></span></label>' +
      '<label class="gdStudioViewportField">Method <select data-gd-3d="hMethod">' +
      '<option value="mix">Mix</option><option value="detail">Illustrated colour, photo detail</option><option value="overlay">Overlay</option></select></label>' +
      '<label class="gdStudioViewportField" title="Illustrated colour, photo detail: how much of the photo\'s light and dark shows through">Detail <input data-gd-3d="hDetail" type="range" min="0" max="200" step="5"> <span data-gd-3d="hDetailValue"></span></label>' +
      '<label class="gdStudioViewportField">Photo colour <input data-gd-3d="hSaturation" type="range" min="0" max="150" step="5"> <span data-gd-3d="hSaturationValue"></span></label>' +
      '<label class="gdStudioViewportField" title="How much the sun shades the relief">Shading <input data-gd-3d="hShading" type="range" min="0" max="100" step="1"> <span data-gd-3d="hShadingValue"></span></label>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-3d="hShadingAuto">Auto shading</button>' +
      "</div>" +
      '<div class="gdStudioViewportBar">' +
      '<label class="gdStudioViewportField">Apply to <select data-gd-3d="hWhere">' +
      '<option value="all">Whole frame</option><option value="surfaces">Chosen surfaces</option></select></label>' +
      '<span data-gd-3d="hSurfaces">' + HYBRID_SURFACES.map(function (kind) {
        return '<label class="gdStudioViewportField"><input type="checkbox" data-gd-3d-surface="' + kind[0] + '"> ' + kind[1] + "</label>";
      }).join(" ") + "</span>" +
      '<label class="gdStudioViewportField">Feather <input data-gd-3d="hFeather" type="range" min="0" max="15" step="0.5"> <span data-gd-3d="hFeatherValue"></span></label>' +
      '<label class="gdStudioViewportField">Trees <select data-gd-3d="hTrees">' +
      '<option value="realistic">Realistic (with shadows)</option><option value="low">Low-poly</option></select></label>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-3d="hSave" title="Play draws with this on its Auto map style, on holes that meet the watch maps\' criteria">Save for Play</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-3d="hReset">Back to saved</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-3d="hCopy">Copy settings</button>' +
      '<span class="gdStudioViewportCourse" data-gd-3d="hSaved"></span>' +
      "</div></div>" +
      '<div class="gdStudioViewportBar">' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-3d="viewOverhead">Overhead</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-3d="viewTee">From the tee</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-3d="viewGreen">Round the green</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-3d="mode">Walk</button>' +
      '<span class="gdStudioViewportCourse" data-gd-3d="course">No course picked</span>' +
      "</div>" +
      /* Whole course only: the course map and its outline. */
      '<div class="gdStudioViewportBar" data-gd-3d="mapBar">' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-3d="build">Build course map</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-3d="trim">Trim outline</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-3d="fromHoles">Start from the holes</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-3d="undo">Undo</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-3d="save">Save outline</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-3d="revert">Discard changes</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-3d="clear">Remove outline</button>' +
      '<label class="gdStudioViewportField">Go to <select data-gd-3d="jump"></select></label>' +
      '<span class="gdStudioViewportCourse" data-gd-3d="mapStatus"></span>' +
      "</div>" +
      '<div class="gdStudioViewportMap" data-gd-3d="stage" tabindex="0" style="position:relative;outline:none">' +
      '<canvas data-gd-3d="canvas" style="display:block;width:100%;height:100%;touch-action:none"></canvas></div>' +
      '<div class="gdStudioViewportReadout" data-gd-3d="readout"></div>';

    var el = {};
    ["pick", "key", "hole", "style", "relief", "reliefValue", "viewOverhead", "viewTee", "viewGreen", "mode", "course", "stage", "canvas", "readout",
      "hybridBar", "hBlend", "hBlendValue", "hMethod", "hDetail", "hDetailValue", "hSaturation", "hSaturationValue", "hShading", "hShadingValue",
      "hShadingAuto", "hWhere", "hSurfaces", "hFeather", "hFeatherValue", "hTrees", "hCopy", "hReset", "hSave", "hSaved",
      "mapBar", "build", "trim", "fromHoles", "undo", "save", "revert", "clear", "jump", "mapStatus"]
      .forEach(function (name) { el[name] = containerEl.querySelector('[data-gd-3d="' + name + '"]'); });

    try {
      if (!window.GDCourse3D) throw new Error("the 3D viewer (app/js/gd-course-3d.js) did not load");
      if (!HYBRID) throw new Error("the hybrid look (scripts/gd-hybrid-look.js) did not load");
      viewer = window.GDCourse3D.createViewer(el.stage, el.canvas, {
        exaggeration: session.exaggeration,
        onFrame: readout,
        onMode: function (mode) { el.mode.textContent = mode === "walk" ? "Orbit" : "Walk"; },
        /* Every trim edit: the outline as it now stands is the unsaved draft. */
        onOutline: function (ring) {
          session.draft = sameRing(ring, savedRing()) ? null : ring;
          showMapBar();
        }
      });
    } catch (e) {
      el.stage.innerHTML = '<p class="gdStudioMuted" style="padding:16px">' + esc(e.message || e) + "</p>";
      return null;
    }

    /* A one-off message rides along in the readout until the next hole loads. */
    var message = "";
    var loadedNote = "";
    function note(text) {
      message = text || "";
      el.readout.textContent = message;
      viewer.requestFrame();
    }

    function readout() {
      var s = viewer.status();
      if (!s) return;
      el.readout.textContent = (s.mode === "walk" ? "Walking" : "Orbit") +
        " · " + Math.round(s.aboveGroundM) + "m above the ground" +
        " · heading " + Math.round(s.headingDeg) + "°" +
        " · frame " + Math.round(s.metres[0]) + " × " + Math.round(s.metres[1]) + "m" +
        (loadedNote ? " · " + loadedNote : "") +
        (s.pendingSpecies ? " · building realistic trees (" + s.pendingSpecies + " species to go)" : "") +
        (message ? " · " + message : "");
    }

    /* ---- loading ---- */

    function fetchPackage() {
      if (pkgKey === session.courseKey && pkgPromise) return pkgPromise;
      pkgKey = session.courseKey;
      var client = window.GDCoursePackageClient;
      var c = session.course || {};
      pkgPromise = client && client.fetchPackage ? client.fetchPackage({
        courseId: session.courseKey,
        courseName: session.courseName,
        courseLat: c.lat != null ? c.lat : c.latitude,
        courseLng: c.lng != null ? c.lng : c.longitude,
        timeoutMs: 15000
      }).then(function (pkg) {
        return pkg && (pkg.status === "full-map-ready" || pkg.status === "lite-geo-ready") ? pkg : null;
      }) : Promise.resolve(null);
      return pkgPromise;
    }

    /* The package and the surfaces collected from it, as the viewer asks for them. */
    function course() {
      var core = window.GDBubbleHazardCore;
      return fetchPackage().then(function (pkg) {
        return pkg ? { pkg: pkg, surfaces: core ? core.collectPackageSurfaces(pkg) : {} } : null;
      });
    }

    /* The hole picker's choice: a hole, or the whole course. */
    function loadSelection(value, keepView) {
      if (String(value) === WHOLE) loadWhole(keepView);
      else loadHole(value, keepView);
    }

    /* What a load came back with, for the readout. */
    function builtNote(built, extra) {
      var bits = extra ? [extra] : [];
      if (built.illustratedUnavailable) {
        bits.push((session.style === "hybrid" ? "Hybrid" : "Illustrated") + " unavailable (" + built.illustratedUnavailable + ") - showing the photo");
      }
      if (built.flat) bits.push("no elevation published for this " + (session.hole === WHOLE ? "course map" : "hole") + " - shown flat");
      if (built.trees.length && !built.standing) {
        bits.push("the tree models did not load, so the " + built.trees.length + " trees are not shown");
      } else if (built.standing) {
        var names = window.GDTreeSpecies ? window.GDTreeSpecies.summary(built.trees.slice(0, built.standing).map(function (t) { return t.species; })) : "";
        bits.push(built.standing + " trees" + (names ? " (" + names + ", guessed from the photo)" : ""));
      }
      if (built.reliefM != null) bits.push(Math.round(built.reliefM) + "m of real relief");
      return bits.join(" · ");
    }

    /* The course map, with the outline being trimmed (or the saved one) cutting it. */
    function loadWhole(keepView) {
      session.hole = WHOLE;
      showMapBar();
      var surface = session.surface;
      if (!surface || !surface.playSurface || !surface.path) {
        viewer.clear();
        loadedNote = "";
        note(busy ? "The course map is being built…" : "No course map yet - Build course map draws one from this course's hole scans.");
        return;
      }
      var elevation = surface.playSurface.elevation || null;
      loadedNote = "";
      note("Loading the course map…");
      var trimming = viewer.trimming();
      viewer.load({
        holeNumber: null,
        meta: surface.playSurface,
        frameUrl: assetUrl(surface.path),
        elevationUrl: elevation && elevation.path ? assetUrl(elevation.path) : null,
        style: session.style,
        course: course,
        mask: hybridMask(),
        treeModels: session.style === "hybrid" ? session.hybrid.trees : null,
        outline: session.draft || savedRing()
      }, keepView).then(function (built) {
        if (destroyed || !built) return;
        viewer.setLook(hybridLook());
        if (trimming) viewer.trim(true);
        message = "";
        loadedNote = builtNote(built, "course map " + surface.width + " × " + surface.height + " px");
        viewer.requestFrame();
      }).catch(function (error) {
        if (!destroyed && session.hole === WHOLE) note("Could not load the course map - " + (error.message || error));
      });
    }

    function loadHole(holeNumber, keepView) {
      var entry = holes.filter(function (h) { return h.holeNumber === Number(holeNumber); })[0];
      if (!entry) return;
      if (viewer.trimming()) viewer.trim(false);
      session.hole = entry.holeNumber;
      showMapBar();
      var elevation = entry.meta.elevation || null;
      loadedNote = "";
      note("Loading hole " + entry.holeNumber + "…");
      viewer.load({
        holeNumber: entry.holeNumber,
        meta: entry.meta,
        frameUrl: assetUrl(entry.path),
        elevationUrl: elevation && elevation.path ? assetUrl(elevation.path) : null,
        style: session.style,
        course: course,
        mask: hybridMask(),
        treeModels: session.style === "hybrid" ? session.hybrid.trees : null,
        outline: savedRing()
      }, keepView).then(function (built) {
        if (destroyed || !built) return;
        viewer.setLook(hybridLook());
        message = "";
        loadedNote = builtNote(built, "");
        viewer.requestFrame();
      }).catch(function (error) {
        if (!destroyed && session.hole === entry.holeNumber) note("Could not load hole " + entry.holeNumber + " - " + (error.message || error));
      });
    }

    function fetchRecord(courseKey) {
      return fetch("/api/course-visuals?courseId=" + encodeURIComponent(courseKey), { headers: { Accept: "application/json" }, cache: "no-store" })
        .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error("HTTP " + res.status)); })
        /* /api/course-visuals answers {visual, storage}: the course_visuals row is under visual. */
        .then(function (data) { return data && data.visual || null; });
    }

    function loadCourse(courseKey, courseName, picked) {
      courseKey = String(courseKey || "").trim().toLowerCase();
      if (!courseKey) return;
      var changed = courseKey !== session.courseKey;
      if (changed && session.draft && !window.confirm("Leave the outline you have not saved?")) { el.key.value = session.courseKey; return; }
      session.courseKey = courseKey;
      session.courseName = courseName || courseKey;
      session.course = picked || (changed ? null : session.course);
      if (changed) { session.hole = null; session.draft = null; jobs = []; busy = ""; }
      if (viewer.trimming()) viewer.trim(false);
      el.key.value = courseKey;
      el.course.textContent = "Loading " + session.courseName + "…";
      var token = ++loadToken;
      fetchRecord(courseKey)
        .then(function (record) {
          if (destroyed || token !== loadToken) return;
          holes = holesFromRecord(record);
          session.surface = record && record.course_surface || null;
          session.boundary = record && record.course_boundary || null;
          el.hole.innerHTML = (holes.length ? '<option value="' + WHOLE + '">Whole course' + (session.surface ? "" : " (not built)") + "</option>" : "") +
            holes.map(function (h) {
              return '<option value="' + h.holeNumber + '">' + h.holeNumber + (h.meta.elevation ? "" : " (flat)") + "</option>";
            }).join("");
          fillJump();
          loadJobs();
          if (!holes.length) {
            el.course.textContent = session.courseName + " · no baked hole frames yet";
            showMapBar();
            note("This course has no published visuals to stand up.");
            return;
          }
          var status = record && record.status ? String(record.status) : "";
          el.course.textContent = session.courseName + " · " + holes.length + " holes" + (status ? " · " + status : "");
          /* A course with a course map opens on the whole course. */
          var start = session.hole === WHOLE || holes.some(function (h) { return h.holeNumber === session.hole; }) ? session.hole
            : session.surface ? WHOLE : holes[0].holeNumber;
          el.hole.value = String(start);
          loadSelection(start, false);
        })
        .catch(function (error) {
          if (!destroyed && token === loadToken) el.course.textContent = "Could not load " + courseKey + " - " + (error.message || error);
        });
    }

    /* ---- the course map and its outline ---- */

    /* accessToken (the Hybrid section's, above): the Studio session's bearer token. */
    function mapRequest(method, query, body) {
      return accessToken().then(function (t) {
        if (!t) throw new Error("sign in again - no session token");
        return fetch(MAP_API + (query || ""), {
          method: method,
          headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: "Bearer " + t },
          cache: "no-store",
          body: body ? JSON.stringify(body) : undefined
        });
      }).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
          return data;
        });
      });
    }

    function liveJob() { return jobs.filter(function (j) { return j.status === "queued" || j.status === "running"; })[0] || null; }

    /* The course map's jobs, polled while one is queued or running. When one finishes the
       record is read again and, on the whole course, the new course map stood up in place. */
    function loadJobs() {
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = 0; }
      var key = session.courseKey;
      if (!key) return;
      var wasLive = !!liveJob();
      mapRequest("GET", "?courseId=" + encodeURIComponent(key)).then(function (data) {
        if (destroyed || key !== session.courseKey) return;
        jobs = data && Array.isArray(data.jobs) ? data.jobs : [];
        var live = liveJob();
        busy = live ? (live.stage || live.status) : "";
        var latest = jobs[0];
        if (wasLive && !live && latest) {
          if (latest.status === "failed") note("The course map did not build - " + (latest.error || "no reason given"));
          refreshSurface();
        }
        showMapBar();
        if (live) pollTimer = setTimeout(loadJobs, POLL_MS);
      }).catch(function (error) {
        if (destroyed || key !== session.courseKey) return;
        busy = "";
        jobs = [];
        el.mapStatus.textContent = "Course map jobs unavailable - " + (error.message || error);
      });
    }

    function refreshSurface() {
      var key = session.courseKey;
      fetchRecord(key).then(function (record) {
        if (destroyed || key !== session.courseKey) return;
        var before = session.surface && session.surface.version;
        session.surface = record && record.course_surface || null;
        session.boundary = record && record.course_boundary || session.boundary;
        var whole = el.hole.querySelector('option[value="' + WHOLE + '"]');
        if (whole) whole.textContent = "Whole course" + (session.surface ? "" : " (not built)");
        fillJump();
        showMapBar();
        if (session.hole === WHOLE && (session.surface && session.surface.version) !== before) loadWhole(true);
      }).catch(function () {});
    }

    function build() {
      mapRequest("POST", "", { courseId: session.courseKey, action: "build" }).then(function (data) {
        note(data && data.existing ? "A course map build is already waiting." : "Course map build queued.");
        loadJobs();
      }).catch(function (error) { note("Course map build not started - " + (error.message || error)); });
    }

    function saveOutline(ring) {
      el.save.disabled = el.clear.disabled = true;
      mapRequest("POST", "", { courseId: session.courseKey, action: "boundary", ring: ring }).then(function (data) {
        session.boundary = data && data.boundary || null;
        session.draft = null;
        viewer.setOutline(savedRing());
        note(ring ? "Outline saved - the course map is being rebuilt to it." : "Outline removed - the course map is being rebuilt without it.");
        loadJobs();
      }).catch(function (error) {
        note("Outline not saved - " + (error.message || error));
        showMapBar();
      });
    }

    /* Each hole's tee, for walking the course map from tee to green. */
    function fillJump() {
      var list = session.surface && Array.isArray(session.surface.holes) ? session.surface.holes : [];
      el.jump.innerHTML = '<option value="">Overhead</option>' + list.filter(function (h) { return h.tee; }).map(function (h) {
        return '<option value="' + h.holeNumber + '">Hole ' + h.holeNumber + " tee</option>";
      }).join("");
    }

    function showMapBar() {
      var whole = session.hole === WHOLE;
      el.mapBar.style.display = whole ? "" : "none";
      var built = !!(session.surface && session.surface.path);
      var trimming = viewer.trimming();
      var saved = savedRing();
      var live = liveJob();
      el.build.textContent = built ? "Rebuild course map" : "Build course map";
      el.build.disabled = !!live || !session.courseKey;
      el.trim.textContent = trimming ? "Done trimming" : "Trim outline";
      el.trim.disabled = !built;
      el.fromHoles.disabled = !built || !trimming;
      el.undo.disabled = !trimming;
      el.save.disabled = !session.draft;
      el.revert.disabled = !session.draft;
      el.clear.disabled = !saved || !!session.draft;
      el.jump.disabled = !built;
      var draft = session.draft || saved;
      var bits = [];
      if (live) bits.push("building the course map (" + busy + ")…");
      else if (built) bits.push("built " + String(session.surface.builtAt || "").slice(0, 10) + (session.surface.boundaryHash ? ", cut to the saved outline" : ""));
      bits.push(draft ? "outline: " + draft.length + " points" + (session.draft ? " (not saved)" : "") : "no outline");
      el.mapStatus.textContent = bits.join(" · ");
    }

    el.build.addEventListener("click", build);
    el.trim.addEventListener("click", function () {
      var on = !viewer.trimming();
      viewer.trim(on);
      if (on && !viewer.outline()) note("No outline yet - Start from the holes draws one round everything mapped to trim from.");
      showMapBar();
    });
    el.fromHoles.addEventListener("click", function () {
      if (viewer.outline() && !window.confirm("Replace the outline with a fresh one round the holes?")) return;
      fetchPackage().then(function (pkg) {
        var points = [];
        var add = function (p) { if (p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng))) points.push({ lat: Number(p.lat), lng: Number(p.lng) }); };
        (session.surface.holes || []).forEach(function (h) { add(h.tee); add(h.green); });
        if (pkg && window.GDBubbleHazardCore) {
          var surfaces = window.GDBubbleHazardCore.collectPackageSurfaces(pkg);
          ["greens", "fairways", "bunkers", "tees"].forEach(function (kind) {
            (surfaces[kind] || []).forEach(function (sf) { (sf && sf.ring || []).forEach(add); });
          });
        }
        if (pkg && window.GDIllustratedSurface) {
          window.GDIllustratedSurface.packageHoles(pkg).forEach(function (h) { add(h.tee); add(h.green); (h.route || []).forEach(add); });
        }
        var ring = outlineAround(points);
        if (!ring) { note("Not enough of the course is mapped to draw an outline round."); return; }
        viewer.setOutline(ring);
        note("Outline drawn round the holes - " + ring.length + " points. Drag them in to cut away what is not the course.");
      });
    });
    el.undo.addEventListener("click", function () { if (!viewer.undoOutline()) note("Nothing to undo."); });
    el.save.addEventListener("click", function () { if (session.draft) saveOutline(session.draft); });
    el.revert.addEventListener("click", function () {
      session.draft = null;
      viewer.setOutline(savedRing());
      showMapBar();
    });
    el.clear.addEventListener("click", function () {
      if (window.confirm("Remove the saved outline? The whole course map will show again, here and on every hole.")) saveOutline(null);
    });
    el.jump.addEventListener("change", function () {
      var n = Number(el.jump.value);
      var hole = (session.surface && session.surface.holes || []).filter(function (h) { return h.holeNumber === n; })[0];
      if (!hole) { viewer.viewOverhead(); return; }
      if (!viewer.viewFrom(hole.tee, hole.green)) note("Hole " + n + "'s tee is not on the course map.");
    });

    function pickCourse() {
      var pick = window.GDStudioCoursePick;
      var opened = pick && typeof pick.open === "function" && pick.open({
        source: "studio-course-3d",
        onReturn: viewer.requestFrame,
        onPick: function (picked) {
          if (destroyed) return;
          var key = slug(picked);
          if (!key) { note("That course has no key to look its visuals up by."); return; }
          loadCourse(key, picked && (picked.name || picked.courseName), picked);
        }
      });
      if (!opened) note("The course picker is not loaded on this surface - type a course key instead.");
    }

    /* ---- hybrid ---- */

    /* The blend as the scene takes it. Any other style gets the plain look, so the photo
       style's colour is never the hybrid's saturation. */
    function hybridLook() {
      if (session.style !== "hybrid") return { blend: 0, method: "mix", detail: 1, saturation: 1, shading: null };
      return HYBRID.look(session.hybrid);
    }
    function hybridMask() { return session.hybrid; }
    /* The automatic shading in the sliders' percent: 1 - the viewer's ambient for the blend. */
    function autoShading() {
      return 100 - HYBRID.ambient(HYBRID.look(Object.assign({}, session.hybrid, { shading: null })), 0.78, 0.5) * 100;
    }

    /* Every control shows the session, and only the ones that mean something are enabled. */
    function showHybrid() {
      var h = session.hybrid, on = session.style === "hybrid";
      el.hybridBar.style.display = on ? "" : "none";
      el.hBlend.value = String(h.blend); el.hBlendValue.textContent = h.blend + "%";
      el.hMethod.value = h.method;
      el.hDetail.value = String(h.detail); el.hDetailValue.textContent = h.detail + "%";
      el.hDetail.disabled = h.method !== "detail";
      el.hSaturation.value = String(h.saturation); el.hSaturationValue.textContent = h.saturation + "%";
      var shading = Math.round(h.shading == null ? autoShading() : h.shading);
      el.hShading.value = String(shading);
      el.hShadingValue.textContent = shading + "%" + (h.shading == null ? " (auto)" : "");
      el.hShadingAuto.disabled = h.shading == null;
      el.hWhere.value = h.where;
      Array.prototype.forEach.call(el.hSurfaces.querySelectorAll("[data-gd-3d-surface]"), function (box) {
        box.checked = !!h.surfaces[box.getAttribute("data-gd-3d-surface")];
        box.disabled = h.where !== "surfaces";
      });
      el.hFeather.value = String(h.featherM); el.hFeatherValue.textContent = h.featherM + "m";
      el.hFeather.disabled = h.where !== "surfaces";
      el.hTrees.value = h.trees;
      var same = hybridSaved.settings && JSON.stringify(hybridSaved.settings) === JSON.stringify(HYBRID.normalize(h));
      el.hSaved.textContent = !hybridSaved.loaded ? "Reading what Play has…"
        : hybridSaved.failed ? "Could not read what Play has - Save still works"
        : !hybridSaved.updatedAt ? "Nothing saved yet - Play uses the defaults"
        : (same ? "Play shows this · saved " : "Changed since the save of ") + new Date(hybridSaved.updatedAt).toLocaleString();
    }
    function lookChanged() { hybridSaved.touched = true; showHybrid(); viewer.setLook(hybridLook()); }
    function maskChanged() { hybridSaved.touched = true; showHybrid(); viewer.setMask(hybridMask()); }
    /* Whole settings in, as a load or a reset brings them: the look, the mask, and the trees
       if those changed. */
    function adoptHybrid(settings) {
      var trees = session.hybrid.trees;
      session.hybrid = HYBRID.normalize(settings);
      showHybrid();
      viewer.setLook(hybridLook());
      viewer.setMask(hybridMask());
      if (trees !== session.hybrid.trees && session.style === "hybrid" && session.hole) loadSelection(session.hole, true);
    }

    el.hBlend.addEventListener("input", function () { session.hybrid.blend = Number(el.hBlend.value) || 0; lookChanged(); });
    el.hMethod.addEventListener("change", function () { session.hybrid.method = el.hMethod.value; lookChanged(); });
    el.hDetail.addEventListener("input", function () { session.hybrid.detail = Number(el.hDetail.value) || 0; lookChanged(); });
    el.hSaturation.addEventListener("input", function () { session.hybrid.saturation = Number(el.hSaturation.value) || 0; lookChanged(); });
    el.hShading.addEventListener("input", function () { session.hybrid.shading = Number(el.hShading.value) || 0; lookChanged(); });
    el.hShadingAuto.addEventListener("click", function () { session.hybrid.shading = null; lookChanged(); });
    el.hWhere.addEventListener("change", function () { session.hybrid.where = el.hWhere.value; maskChanged(); });
    el.hSurfaces.addEventListener("change", function (e) {
      var kind = e.target && e.target.getAttribute("data-gd-3d-surface");
      if (!kind) return;
      session.hybrid.surfaces[kind] = !!e.target.checked;
      maskChanged();
    });
    el.hFeather.addEventListener("input", function () { session.hybrid.featherM = Number(el.hFeather.value) || 0; maskChanged(); });
    el.hTrees.addEventListener("change", function () {
      hybridSaved.touched = true;
      session.hybrid.trees = el.hTrees.value;
      showHybrid();
      if (session.hole) loadSelection(session.hole, true);
    });
    /* For carrying a blend worth keeping into Play: the settings as JSON on the clipboard. */
    el.hCopy.addEventListener("click", function () {
      var text = JSON.stringify(session.hybrid);
      var done = function () { note("Hybrid settings copied: " + text); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { note(text); });
      else note(text);
    });
    el.hReset.addEventListener("click", function () { adoptHybrid(hybridSaved.settings || defaultHybrid()); });

    async function accessToken() {
      if (typeof window.gdAdminCourseDbAccessToken === "function") return window.gdAdminCourseDbAccessToken();
      try {
        var auth = window.ClaritySupabaseAuth;
        if (auth && typeof auth.freshAccessToken === "function") return (await auth.freshAccessToken()) || "";
      } catch (e) {}
      return "";
    }
    el.hSave.addEventListener("click", async function () {
      el.hSave.disabled = true;
      try {
        var token = await accessToken();
        if (!token) throw new Error("sign in as an admin first");
        var res = await fetch("/api/play-view", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify({ hybrid: session.hybrid }),
          cache: "no-store"
        });
        var data = await res.json().catch(function () { return null; });
        if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
        hybridSaved = { settings: data.hybrid, updatedAt: data.updatedAt, loaded: true, touched: hybridSaved.touched };
        session.hybrid = HYBRID.normalize(data.hybrid);
        if (!destroyed) note("Saved - Play's Auto map style draws with this look (players pick it up within a minute)");
      } catch (error) {
        if (!destroyed) note("Could not save the hybrid look - " + (error.message || error));
      }
      if (!destroyed) { el.hSave.disabled = false; showHybrid(); }
    });

    /* What Play is drawing with now. It becomes the starting look unless this page's sliders
       have already been moved. */
    fetch("/api/play-view", { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error("HTTP " + res.status)); })
      .then(function (data) {
        if (destroyed) return;
        hybridSaved = { settings: data && data.saved ? data.hybrid : null, updatedAt: data && data.saved ? data.updatedAt : null, loaded: true, touched: hybridSaved.touched };
        if (hybridSaved.settings && !hybridSaved.touched) adoptHybrid(hybridSaved.settings);
        else showHybrid();
      })
      .catch(function () { if (!destroyed) { hybridSaved.loaded = true; hybridSaved.failed = true; showHybrid(); } });
    showHybrid();

    /* ---- controls ---- */

    el.pick.addEventListener("click", pickCourse);
    el.key.addEventListener("change", function () { loadCourse(el.key.value, "", null); });
    el.hole.addEventListener("change", function () {
      if (session.hole === WHOLE && session.draft && !window.confirm("Leave the outline you have not saved?")) { el.hole.value = WHOLE; return; }
      if (session.hole === WHOLE) session.draft = null;
      loadSelection(el.hole.value, false);
    });
    el.style.value = session.style;
    el.style.addEventListener("change", function () {
      session.style = el.style.value;
      showHybrid();
      if (session.hole) loadSelection(session.hole, true);
    });
    el.relief.value = String(session.exaggeration);
    el.reliefValue.textContent = session.exaggeration + "×";
    el.relief.addEventListener("input", function () {
      session.exaggeration = Number(el.relief.value) || 0;
      el.reliefValue.textContent = session.exaggeration + "×";
      viewer.setExaggeration(session.exaggeration);
    });
    el.viewOverhead.addEventListener("click", viewer.viewOverhead);
    el.viewTee.addEventListener("click", function () {
      if (!viewer.viewTee()) note(session.hole === WHOLE ? "On the whole course, Go to picks the hole." : "This hole's frame carries no tee position.");
    });
    el.viewGreen.addEventListener("click", function () {
      if (!viewer.viewGreen()) note(session.hole === WHOLE ? "On the whole course, Go to picks the hole." : "This hole's frame carries no green position.");
    });
    el.mode.addEventListener("click", viewer.toggleMode);

    showMapBar();
    if (session.courseKey) loadCourse(session.courseKey, session.courseName, session.course);
    else note("Pick a course to load its holes.");

    return function cleanup() {
      destroyed = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (window.GDStudioCoursePick) window.GDStudioCoursePick.cancel();
      if (window.GDStudioShell) window.GDStudioShell.show();
      if (viewer) viewer.dispose();
      viewer = null;
    };
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["course-3d"] = render;
})();
