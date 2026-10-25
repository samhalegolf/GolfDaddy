/* Clarity Studio — 3D Course Viewer. Studio-only, view-only.
 *
 * What it is for: walking round a hole's 3D model with a camera you control, to see what the
 * terrain mesh, the illustrated map and its trees actually look like as geometry. Nothing here
 * writes anything.
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
 */
(function () {
  "use strict";

  /* Survives leaving and re-entering the page, like Map Viewport. */
  var session = { courseKey: "", courseName: "", course: null, hole: null, style: "photo", exaggeration: 2.5,
    hybrid: defaultHybrid() };

  /* Hybrid style: the illustrated map blended over the photo, to find out how far the two can
     be mixed. Percentages as the sliders show them; shading null is automatic (the photo's
     light and the drawn map's, in proportion to the blend). */
  function defaultHybrid() {
    return {
      blend: 50, method: "mix", detail: 100, saturation: 100, shading: null,
      where: "all", featherM: 2, trees: "realistic",
      surfaces: { greens: true, fairways: true, bunkers: true, water: true, trees: false, tees: true }
    };
  }
  var HYBRID_SURFACES = [["greens", "Greens"], ["fairways", "Fairways"], ["bunkers", "Bunkers"], ["water", "Water"], ["trees", "Woods"], ["tees", "Tees"]];
  var AUTO_SHADING = { photo: 0.22, illustrated: 0.5 };   // 1 - the viewer's ambient for each

  var ASSET_API = "/api/course-visual-assets";

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

  function render(containerEl) {
    var destroyed = false;
    var viewer = null;
    var loadToken = 0;
    var holes = [];
    var pkgPromise = null, pkgKey = "";

    containerEl.innerHTML =
      '<div class="gdStudioLede" style="margin-bottom:12px">' +
      "<p>View only. A hole's 3D model, made from the same published picture, elevation and trees GPS Play uses, " +
      "with a camera you can move anywhere. The same scene is what Play's 3D mode (the cube on its tool rail) plays on. " +
      "Pick a course, then a hole. Each tree's species is guessed from the photo; " +
      "on the photo the nearest trees are the realistic models, the rest low-poly. " +
      "<strong>Hybrid</strong> blends the illustrated map over the photo: how much, how, and where.</p>" +
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
      '<button type="button" class="gdStudioDiagramBtn" data-gd-3d="hCopy">Copy settings</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-3d="hReset">Reset</button>' +
      "</div></div>" +
      '<div class="gdStudioViewportBar">' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-3d="viewOverhead">Overhead</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-3d="viewTee">From the tee</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-3d="viewGreen">Round the green</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-3d="mode">Walk</button>' +
      '<span class="gdStudioViewportCourse" data-gd-3d="course">No course picked</span>' +
      "</div>" +
      '<div class="gdStudioViewportMap" data-gd-3d="stage" tabindex="0" style="position:relative;outline:none">' +
      '<canvas data-gd-3d="canvas" style="display:block;width:100%;height:100%;touch-action:none"></canvas></div>' +
      '<div class="gdStudioViewportReadout" data-gd-3d="readout"></div>';

    var el = {};
    ["pick", "key", "hole", "style", "relief", "reliefValue", "viewOverhead", "viewTee", "viewGreen", "mode", "course", "stage", "canvas", "readout",
      "hybridBar", "hBlend", "hBlendValue", "hMethod", "hDetail", "hDetailValue", "hSaturation", "hSaturationValue", "hShading", "hShadingValue",
      "hShadingAuto", "hWhere", "hSurfaces", "hFeather", "hFeatherValue", "hTrees", "hCopy", "hReset"]
      .forEach(function (name) { el[name] = containerEl.querySelector('[data-gd-3d="' + name + '"]'); });

    try {
      if (!window.GDCourse3D) throw new Error("the 3D viewer (app/js/gd-course-3d.js) did not load");
      viewer = window.GDCourse3D.createViewer(el.stage, el.canvas, {
        exaggeration: session.exaggeration,
        onFrame: readout,
        onMode: function (mode) { el.mode.textContent = mode === "walk" ? "Orbit" : "Walk"; }
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

    function loadHole(holeNumber, keepView) {
      var entry = holes.filter(function (h) { return h.holeNumber === Number(holeNumber); })[0];
      if (!entry) return;
      session.hole = entry.holeNumber;
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
        treeModels: session.style === "hybrid" ? session.hybrid.trees : null
      }, keepView).then(function (built) {
        if (destroyed || !built) return;
        viewer.setLook(hybridLook());
        message = "";
        var bits = [];
        if (built.illustratedUnavailable) {
          bits.push((session.style === "hybrid" ? "Hybrid" : "Illustrated") + " unavailable (" + built.illustratedUnavailable + ") - showing the photo");
        }
        if (built.flat) bits.push("no elevation published for this hole - shown flat");
        if (built.trees.length && !built.standing) {
          bits.push("the tree models did not load, so the " + built.trees.length + " trees are not shown");
        } else if (built.standing) {
          var names = window.GDTreeSpecies ? window.GDTreeSpecies.summary(built.trees.slice(0, built.standing).map(function (t) { return t.species; })) : "";
          bits.push(built.standing + " trees" + (names ? " (" + names + ", guessed from the photo)" : ""));
        }
        if (built.reliefM != null) bits.push(Math.round(built.reliefM) + "m of real relief");
        loadedNote = bits.join(" · ");
        viewer.requestFrame();
      }).catch(function (error) {
        if (!destroyed && session.hole === entry.holeNumber) note("Could not load hole " + entry.holeNumber + " - " + (error.message || error));
      });
    }

    function loadCourse(courseKey, courseName, picked) {
      courseKey = String(courseKey || "").trim().toLowerCase();
      if (!courseKey) return;
      var changed = courseKey !== session.courseKey;
      session.courseKey = courseKey;
      session.courseName = courseName || courseKey;
      session.course = picked || (changed ? null : session.course);
      if (changed) session.hole = null;
      el.key.value = courseKey;
      el.course.textContent = "Loading " + session.courseName + "…";
      var token = ++loadToken;
      fetch("/api/course-visuals?courseId=" + encodeURIComponent(courseKey), { headers: { Accept: "application/json" }, cache: "no-store" })
        .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error("HTTP " + res.status)); })
        .then(function (data) {
          if (destroyed || token !== loadToken) return;
          /* /api/course-visuals answers {visual, storage}: the course_visuals row is under visual. */
          var record = data && data.visual || null;
          holes = holesFromRecord(record);
          el.hole.innerHTML = holes.map(function (h) {
            return '<option value="' + h.holeNumber + '">' + h.holeNumber + (h.meta.elevation ? "" : " (flat)") + "</option>";
          }).join("");
          if (!holes.length) {
            el.course.textContent = session.courseName + " · no baked hole frames yet";
            note("This course has no published visuals to stand up.");
            return;
          }
          var status = record && record.status ? String(record.status) : "";
          el.course.textContent = session.courseName + " · " + holes.length + " holes" + (status ? " · " + status : "");
          var start = holes.some(function (h) { return h.holeNumber === session.hole; }) ? session.hole : holes[0].holeNumber;
          el.hole.value = String(start);
          loadHole(start, false);
        })
        .catch(function (error) {
          if (!destroyed && token === loadToken) el.course.textContent = "Could not load " + courseKey + " - " + (error.message || error);
        });
    }

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
      var h = session.hybrid;
      if (session.style !== "hybrid") return { blend: 0, method: "mix", detail: 1, saturation: 1, shading: null };
      return { blend: h.blend / 100, method: h.method, detail: h.detail / 100, saturation: h.saturation / 100, shading: h.shading };
    }
    function hybridMask() {
      var h = session.hybrid;
      return { where: h.where, surfaces: Object.assign({}, h.surfaces), featherM: h.featherM };
    }
    function autoShading() {
      return AUTO_SHADING.photo + (AUTO_SHADING.illustrated - AUTO_SHADING.photo) * (session.hybrid.blend / 100);
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
      var shading = h.shading == null ? autoShading() : h.shading;
      el.hShading.value = String(Math.round(shading * 100));
      el.hShadingValue.textContent = Math.round(shading * 100) + "%" + (h.shading == null ? " (auto)" : "");
      el.hShadingAuto.disabled = h.shading == null;
      el.hWhere.value = h.where;
      Array.prototype.forEach.call(el.hSurfaces.querySelectorAll("[data-gd-3d-surface]"), function (box) {
        box.checked = !!h.surfaces[box.getAttribute("data-gd-3d-surface")];
        box.disabled = h.where !== "surfaces";
      });
      el.hFeather.value = String(h.featherM); el.hFeatherValue.textContent = h.featherM + "m";
      el.hFeather.disabled = h.where !== "surfaces";
      el.hTrees.value = h.trees;
    }
    function lookChanged() { showHybrid(); viewer.setLook(hybridLook()); }
    function maskChanged() { showHybrid(); viewer.setMask(hybridMask()); }

    el.hBlend.addEventListener("input", function () { session.hybrid.blend = Number(el.hBlend.value) || 0; lookChanged(); });
    el.hMethod.addEventListener("change", function () { session.hybrid.method = el.hMethod.value; lookChanged(); });
    el.hDetail.addEventListener("input", function () { session.hybrid.detail = Number(el.hDetail.value) || 0; lookChanged(); });
    el.hSaturation.addEventListener("input", function () { session.hybrid.saturation = Number(el.hSaturation.value) || 0; lookChanged(); });
    el.hShading.addEventListener("input", function () { session.hybrid.shading = (Number(el.hShading.value) || 0) / 100; lookChanged(); });
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
      session.hybrid.trees = el.hTrees.value;
      showHybrid();
      if (session.hole) loadHole(session.hole, true);
    });
    /* For carrying a blend worth keeping into Play: the settings as JSON on the clipboard. */
    el.hCopy.addEventListener("click", function () {
      var text = JSON.stringify(session.hybrid);
      var done = function () { note("Hybrid settings copied: " + text); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { note(text); });
      else note(text);
    });
    el.hReset.addEventListener("click", function () {
      var trees = session.hybrid.trees;
      session.hybrid = defaultHybrid();
      showHybrid();
      viewer.setLook(hybridLook());
      viewer.setMask(hybridMask());
      if (trees !== session.hybrid.trees && session.hole) loadHole(session.hole, true);
    });
    showHybrid();

    /* ---- controls ---- */

    el.pick.addEventListener("click", pickCourse);
    el.key.addEventListener("change", function () { loadCourse(el.key.value, "", null); });
    el.hole.addEventListener("change", function () { loadHole(el.hole.value, false); });
    el.style.value = session.style;
    el.style.addEventListener("change", function () {
      session.style = el.style.value;
      showHybrid();
      if (session.hole) loadHole(session.hole, true);
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
      if (!viewer.viewTee()) note("This hole's frame carries no tee position.");
    });
    el.viewGreen.addEventListener("click", function () {
      if (!viewer.viewGreen()) note("This hole's frame carries no green position.");
    });
    el.mode.addEventListener("click", viewer.toggleMode);

    if (session.courseKey) loadCourse(session.courseKey, session.courseName, session.course);
    else note("Pick a course to load its holes.");

    return function cleanup() {
      destroyed = true;
      if (window.GDStudioCoursePick) window.GDStudioCoursePick.cancel();
      if (window.GDStudioShell) window.GDStudioShell.show();
      if (viewer) viewer.dispose();
      viewer = null;
    };
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["course-3d"] = render;
})();
