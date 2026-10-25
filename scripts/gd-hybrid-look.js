/* Hybrid look - the illustrated map blended over the photo, and the settings that say how.

   One owner for everything the blend means, so the Studio that tunes it, the server that
   stores it and GPS Play that shows it can never disagree:

     - normalize(raw)    the stored shape, cleaned: what Studio > 3D Course Viewer saves through
                         /api/play-view and what Play reads back. Anything unknown falls back.
     - look(settings)    the blend as the renderers take it (0..1 fractions)
     - GLSL              the fragment code both renderers include: hybridColour(photo, uv)
     - setUniforms()     binds that code's textures and uniforms on a GL context
     - drawMask()        where the illustrated picture applies, white on black (browser only)
     - meanLuma()        the photo's average brightness, the detail blend's 1.0 (browser only)
     - holeQualifies()   the Auto map style's rule: the same as watch maps'

   Renderers: app/js/gd-terrain-mesh.js (Play's plain mesh) and app/js/gd-course-3d.js (Play's
   3D mode and the Studio viewer). Pure apart from the two browser-only helpers, which only run
   where there is a document; node requires the rest (functions/play-view.mjs, the tests). */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.GDHybridLook = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  /* The surfaces a mask can be drawn from, by the names the course package's collected
     surfaces use; tees are the holes' tee points, drawn as a pad TEE_PAD_M round. */
  var SURFACES = ["greens", "fairways", "bunkers", "water", "trees", "tees"];
  var TEE_PAD_M = 8;
  var METHODS = { mix: 0, detail: 1, overlay: 2 };
  var TREES = ["realistic", "low"];

  /* Percentages as the Studio's sliders show them. shading null is automatic: the photo's
     light and the drawn map's, in proportion to the blend. */
  var DEFAULTS = {
    blend: 50, method: "mix", detail: 100, saturation: 100, shading: null,
    where: "all", featherM: 2, trees: "realistic",
    surfaces: { greens: true, fairways: true, bunkers: true, water: true, trees: false, tees: true }
  };

  function number(value, lo, hi, fallback) {
    var n = Number(value);
    if (value === null || value === "" || !Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
  }

  function normalize(raw) {
    raw = raw && typeof raw === "object" ? raw : {};
    var rawSurfaces = raw.surfaces && typeof raw.surfaces === "object" ? raw.surfaces : {};
    var surfaces = {};
    SURFACES.forEach(function (kind) {
      surfaces[kind] = typeof rawSurfaces[kind] === "boolean" ? rawSurfaces[kind] : DEFAULTS.surfaces[kind];
    });
    return {
      blend: number(raw.blend, 0, 100, DEFAULTS.blend),
      method: METHODS[raw.method] != null ? raw.method : DEFAULTS.method,
      detail: number(raw.detail, 0, 200, DEFAULTS.detail),
      saturation: number(raw.saturation, 0, 150, DEFAULTS.saturation),
      shading: raw.shading == null ? null : number(raw.shading, 0, 100, null),
      where: raw.where === "surfaces" ? "surfaces" : "all",
      featherM: number(raw.featherM, 0, 15, DEFAULTS.featherM),
      trees: TREES.indexOf(raw.trees) >= 0 ? raw.trees : DEFAULTS.trees,
      surfaces: surfaces
    };
  }

  /* {blend, method, detail, saturation, shading}: fractions, method as its name. */
  function look(settings) {
    var s = normalize(settings);
    return {
      blend: s.blend / 100, method: s.method, detail: s.detail / 100, saturation: s.saturation / 100,
      shading: s.shading == null ? null : s.shading / 100
    };
  }

  /* The ground's ambient light under a look: set by hand, or between the photo's and the drawn
     map's by the blend. */
  function ambient(lookValues, photoAmbient, drawnAmbient) {
    if (lookValues && lookValues.shading != null) return 1 - lookValues.shading;
    var blend = lookValues ? Number(lookValues.blend) || 0 : 0;
    return photoAmbient + (drawnAmbient - photoAmbient) * blend;
  }

  /* Fragment code: include it, then colour = hybridColour(photo, uv). With uBlend 0 and
     uSaturation 1 (setUniforms with no overlay) it is the photo, untouched. */
  var GLSL = `
    uniform sampler2D uOverlay;        // the illustrated picture
    uniform sampler2D uMask;           // where it applies
    uniform float uBlend;
    uniform float uMethod;             // 0 mix, 1 illustrated colour with photo detail, 2 overlay
    uniform float uDetail;             // how much of the photo's light and dark the detail keeps
    uniform float uLumaMean;           // the photo's average brightness, the detail's 1.0
    uniform float uSaturation;         // the photo's colour, 1 as taken
    vec3 hybridColour(vec3 photo, vec2 uv) {
      float luma = dot(photo, vec3(0.299, 0.587, 0.114));
      photo = clamp(mix(vec3(luma), photo, uSaturation), 0.0, 1.0);
      if (uBlend <= 0.0) return photo;
      vec3 drawn = texture2D(uOverlay, uv).rgb;
      vec3 target = drawn;
      if (uMethod > 1.5) {
        target = mix(2.0 * photo * drawn, 1.0 - 2.0 * (1.0 - photo) * (1.0 - drawn), step(0.5, photo));
      } else if (uMethod > 0.5) {
        target = clamp(drawn * mix(1.0, luma / max(uLumaMean, 0.02), uDetail), 0.0, 1.0);
      }
      return mix(photo, target, texture2D(uMask, uv).r * uBlend);
    }
  `;
  var UNIFORMS = ["uOverlay", "uMask", "uBlend", "uMethod", "uDetail", "uLumaMean", "uSaturation"];

  /* textures: {overlay, mask, fallback} - fallback (any texture) is bound where there is no
     overlay, so the samplers never read another unit's texture. Units 2 and 3 are the blend's
     in both renderers. A hole with no overlay is the plain picture whatever the look says. */
  function setUniforms(gl, loc, textures, lookValues, lumaMean) {
    var on = !!(textures.overlay && textures.mask);
    var l = lookValues || {};
    gl.uniform1f(loc.uBlend, on ? Math.max(0, Math.min(1, Number(l.blend) || 0)) : 0);
    gl.uniform1f(loc.uMethod, METHODS[l.method] != null ? METHODS[l.method] : 0);
    gl.uniform1f(loc.uDetail, l.detail != null ? Number(l.detail) : 1);
    gl.uniform1f(loc.uLumaMean, Number(lumaMean) > 0 ? Number(lumaMean) : 0.35);
    gl.uniform1f(loc.uSaturation, on && l.saturation != null ? Number(l.saturation) : 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, textures.overlay || textures.fallback); gl.uniform1i(loc.uOverlay, 2);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, textures.mask || textures.fallback); gl.uniform1i(loc.uMask, 3);
  }

  /* Where the illustrated picture applies, white on black at the picture's size: everywhere,
     or only on the chosen surfaces. featherM softens the edge by that many metres (a blur where
     the browser has canvas filters, a hard edge where it has not).
     data: {width, height, pxPerMetre, project(latLng) -> {x, y}, surfaces, holes}
     settings: normalize()'s, or anything it cleans. */
  function drawMask(data, settings) {
    var s = normalize(settings);
    var c = document.createElement("canvas");
    c.width = data.width;
    c.height = data.height;
    var ctx = c.getContext("2d");
    if (s.where !== "surfaces") {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      return c;
    }
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, c.width, c.height);
    var ppm = Number(data.pxPerMetre) || 1;
    var feather = s.featherM * ppm;
    if (feather > 0 && "filter" in ctx) ctx.filter = "blur(" + feather.toFixed(1) + "px)";
    ctx.fillStyle = "#fff";
    SURFACES.forEach(function (kind) {
      if (!s.surfaces[kind]) return;
      if (kind === "tees") {
        (data.holes || []).forEach(function (hole) {
          var at = hole && hole.tee ? data.project(hole.tee) : null;
          if (!at) return;
          ctx.beginPath();
          ctx.arc(at.x, at.y, TEE_PAD_M * ppm, 0, Math.PI * 2);
          ctx.fill();
        });
        return;
      }
      ((data.surfaces && data.surfaces[kind]) || []).forEach(function (surface) {
        var ring = (surface && surface.ring || []).map(data.project).filter(Boolean);
        if (ring.length < 3) return;
        ctx.beginPath();
        ctx.moveTo(ring[0].x, ring[0].y);
        for (var i = 1; i < ring.length; i++) ctx.lineTo(ring[i].x, ring[i].y);
        ctx.closePath();
        ctx.fill();
      });
    });
    return c;
  }

  /* The picture's average brightness, read small. A picture the browser will not let us read
     answers a grass-ish guess. */
  function meanLuma(source) {
    try {
      var c = document.createElement("canvas");
      c.width = c.height = 32;
      var ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(source, 0, 0, 32, 32);
      var d = ctx.getImageData(0, 0, 32, 32).data, sum = 0;
      for (var i = 0; i < d.length; i += 4) sum += (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
      return sum / (d.length / 4);
    } catch (e) {
      return 0.35;
    }
  }

  /* The Auto map style shows Hybrid on a hole that meets the watch maps' criteria, and the
     photo everywhere else. Those criteria (functions/course-watch-maps.mjs, and the frame
     builder in scripts/gd-watch-map-core.js) are: the course has a published map with
     geometry, and the hole has a green. A course package is only ever built from a published
     map with geometry - full-map-ready and lite-geo-ready are exactly that
     (functions/lib/gd-course-package-shape.mjs) - so the course half is its status, and the
     hole half is the hole's own green, wherever the package shape keeps it. */
  function holeQualifies(pkg, holeNumber) {
    if (!pkg || (pkg.status !== "full-map-ready" && pkg.status !== "lite-geo-ready")) return false;
    var n = Number(holeNumber);
    var hole = (Array.isArray(pkg.holes) ? pkg.holes : []).filter(function (h) { return h && Number(h.holeNumber) === n; })[0];
    var g = hole && (hole.geometry || hole);
    return !!(g && g.green && Number.isFinite(Number(g.green.lat)) && Number.isFinite(Number(g.green.lng)));
  }

  return {
    DEFAULTS: DEFAULTS, SURFACES: SURFACES, METHODS: METHODS,
    normalize: normalize, look: look, ambient: ambient,
    GLSL: GLSL, UNIFORMS: UNIFORMS, setUniforms: setUniforms,
    drawMask: drawMask, meanLuma: meanLuma, holeQualifies: holeQualifies
  };
});
