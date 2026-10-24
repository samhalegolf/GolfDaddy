/* Clarity Studio — 3D Course Viewer. Studio-only, view-only.
 *
 * What it is for: walking round a hole's 3D model with a camera you control, to see what the
 * terrain mesh, the illustrated map and its trees actually look like as geometry. Nothing here
 * writes anything.
 *
 * Why it has its own renderer rather than reusing app/js/gd-terrain-mesh.js: the app's mesh
 * deliberately owns no camera. It shears height inside the published frame so the projector
 * and the tap maths stay untouched, which is right for Play and useless for looking round a
 * hill. This draws the same inputs - the published frame (or the illustrated picture) draped
 * over the published terrain-RGB, trees from the same placement - through a real perspective
 * camera. Same pictures, same heights, same trees; only the viewpoint is free.
 *
 * What it reads, and from where:
 *   - GET /api/course-visuals?courseId=  the course's visual record: each hole's frame and its
 *                                         playSurface metadata, elevation sidecar included
 *   - GET /api/course-visual-assets       the frame JPEG and the elevation PNG themselves
 *   - GET /api/course-package             only for Illustrated: the shapes it is painted from
 *   - app/js/gd-illustrated-surface.js    the app's own painter and tree placement, not a copy
 */
(function () {
  "use strict";

  /* Survives leaving and re-entering the page, like Map Viewport. */
  var session = { courseKey: "", courseName: "", course: null, hole: null, style: "photo", exaggeration: 2.5 };

  var ASSET_API = "/api/course-visual-assets";
  var MAX_PICTURE_PX = 4096;      // most GPUs' texture ceiling; the frame is downscaled past it
  var ILLUSTRATED_PX = 2048;      // the app's MESH_MAX_PX - the picture is painted at this size
  var EYE_HEIGHT_M = 1.7;
  var AMBIENT = { photo: 0.78, illustrated: 0.5 };   // painter.js: the photo carries baked relief

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

  /* World-mercator pixels at an integer zoom: the projection every published frame is cut in. */
  function worldPx(lat, lng, zoom) {
    var scale = 256 * Math.pow(2, zoom);
    var latRad = (Math.max(-85.05112878, Math.min(85.05112878, Number(lat))) * Math.PI) / 180;
    return {
      x: ((Number(lng) + 180) / 360) * scale,
      y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale
    };
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

  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error("could not load " + url)); };
      img.src = url;
    });
  }

  /* ------------------------------------------------------------------ matrices */

  function perspective(fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function norm(a) { var l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function lookAt(eye, target) {
    var z = norm(sub(eye, target)), x = norm(cross([0, 1, 0], z)), y = cross(z, x);
    return {
      matrix: [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1],
      right: x, up: y
    };
  }
  function multiply(a, b) {
    var out = new Array(16);
    for (var c = 0; c < 4; c++) {
      for (var r = 0; r < 4; r++) {
        out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ shaders */

  var DECODE = `
    float heightAt(vec2 uv) {
      vec3 c = texture2D(uElevation, uv).rgb * 255.0;
      return -10000.0 + (c.r * 65536.0 + c.g * 256.0 + c.b) * 0.1;
    }
  `;

  /* Ground: x east and z south in metres from the frame's centre, y up. */
  var GROUND_VERT = `
    attribute vec2 aGrid;
    uniform sampler2D uElevation;
    uniform mat4 uViewProj;
    uniform vec2 uMetres;
    uniform float uExaggeration;
    uniform float uSeaLevel;
    varying vec2 vUv;
    varying vec3 vWorld;
  ` + DECODE + `
    void main() {
      vUv = aGrid;
      float h = (heightAt(aGrid) - uSeaLevel) * uExaggeration;
      vWorld = vec3((aGrid.x - 0.5) * uMetres.x, h, (aGrid.y - 0.5) * uMetres.y);
      gl_Position = uViewProj * vec4(vWorld, 1.0);
    }
  `;

  var GROUND_FRAG = `
    precision highp float;
    uniform sampler2D uPicture;
    uniform sampler2D uElevation;
    uniform vec2 uTexel;
    uniform vec2 uMetresPerTexel;
    uniform float uExaggeration;
    uniform vec3 uLight;
    uniform float uAmbient;
    uniform vec3 uEye;
    uniform vec3 uSky;
    uniform float uFogFar;
    varying vec2 vUv;
    varying vec3 vWorld;
  ` + DECODE + `
    void main() {
      /* Normals from the heightfield per fragment, as the app's mesh does: the grid is coarser
         than the DEM and this keeps the fine relief the geometry alone would lose. */
      float hL = heightAt(vUv - vec2(uTexel.x, 0.0));
      float hR = heightAt(vUv + vec2(uTexel.x, 0.0));
      float hD = heightAt(vUv - vec2(0.0, uTexel.y));
      float hU = heightAt(vUv + vec2(0.0, uTexel.y));
      vec3 n = normalize(vec3(
        (hL - hR) * uExaggeration / (2.0 * uMetresPerTexel.x),
        1.0,
        (hD - hU) * uExaggeration / (2.0 * uMetresPerTexel.y)
      ));
      float lit = uAmbient + (1.0 - uAmbient) * max(dot(n, normalize(uLight)), 0.0);
      vec3 colour = texture2D(uPicture, vUv).rgb * lit;
      float fog = smoothstep(uFogFar * 0.45, uFogFar, distance(vWorld, uEye));
      gl_FragColor = vec4(mix(colour, uSky, fog), 1.0);
    }
  `;

  /* Trees: a camera-facing quad standing on the ground, drawn as the app's mesh draws them -
     a ball of foliage or a cone, with a trunk once the view leans - but in metres and from the
     camera's actual angle: from straight above a tree is a disc, from the ground a tree. Real
     size: the relief is exaggerated, the trees are not. */
  var TREE_VERT = `
    attribute vec4 aTree;              // u, v, crown radius (m), type
    attribute vec2 aCorner;            // -1..1 across, 0..1 bottom to top
    uniform sampler2D uElevation;
    uniform mat4 uViewProj;
    uniform vec2 uMetres;
    uniform float uExaggeration;
    uniform float uSeaLevel;
    uniform vec3 uRight;
    uniform vec3 uUp;
    uniform float uSinT;
    varying vec2 vLocal;
    varying vec3 vTree;
    varying vec3 vWorld;
  ` + DECODE + `
    void main() {
      float r = aTree.z, type = aTree.w;
      float h = (heightAt(aTree.xy) - uSeaLevel) * uExaggeration;
      vec3 foot = vec3((aTree.x - 0.5) * uMetres.x, h, (aTree.y - 0.5) * uMetres.y);
      float top = (type == 2.0 ? 3.6 * r : 1.6 * r) * uSinT + r * 1.15;
      float x = aCorner.x * r * 1.15;
      float y = mix(-r * 1.05, top, aCorner.y);
      vLocal = vec2(x, y);
      vTree = vec3(r, type, fract(sin(dot(aTree.xy, vec2(12.9898, 78.233))) * 43758.5453));
      vWorld = foot + uRight * x + uUp * y;
      gl_Position = uViewProj * vec4(vWorld, 1.0);
    }
  `;

  var TREE_FRAG = `
    precision highp float;
    uniform float uSinT;
    uniform float uCosT;
    uniform vec3 uEye;
    uniform vec3 uSky;
    uniform float uFogFar;
    varying vec2 vLocal;
    varying vec3 vTree;
    varying vec3 vWorld;

    float cover(float d, float r) { return clamp(0.5 - d / (r * 0.06), 0.0, 1.0); }

    void main() {
      float r = vTree.x, type = vTree.y, seed = vTree.z;
      float x = vLocal.x, y = vLocal.y;
      vec3 light = normalize(vec3(-0.5, 0.6, 0.62));
      vec3 colour = vec3(0.0);
      float alpha = 0.0;
      if (type == 2.0) {
        float yb = 0.4 * r * uSinT, ya = 3.6 * r * uSinT;
        float ry = max(r * uCosT, 0.001);
        float e = length(vec2(x / r, (y - yb) / ry));
        float a = cover((e - 1.0) * r, r);
        if (ya - yb > r * 0.05) {
          float t = clamp((y - yb) / (ya - yb), 0.0, 1.0);
          float inside = y >= yb && y <= ya ? cover(abs(x) - r * (1.0 - t), r) : 0.0;
          a = max(a, inside);
        }
        float lit = 0.62 + 0.38 * clamp(0.5 - x / r * 0.6 + (y - yb) / max(ya - yb, r) * 0.25, 0.0, 1.0);
        colour = vec3(0.17, 0.40, 0.21) * (0.9 + 0.2 * seed) * lit;
        alpha = a;
      } else {
        float wide = type == 1.0 ? 1.1 : 1.0;
        float yc = 1.6 * r * uSinT;
        vec2 d = vec2(x / wide, y - yc) / r;
        float lobes = type == 1.0 ? 1.0 + 0.07 * sin(atan(d.y, d.x) * 6.0 + seed * 6.283) : 1.0 + 0.03 * sin(atan(d.y, d.x) * 9.0 + seed * 6.283);
        float dist = length(d) / lobes;
        float a = cover((dist - 1.0) * r, r);
        vec3 n = vec3(d.x, d.y, sqrt(max(0.0, 1.0 - min(1.0, dist * dist))));
        float lit = 0.5 + 0.6 * max(dot(normalize(n), light), 0.0);
        vec3 base = type == 3.0 ? vec3(0.45, 0.57, 0.23) : type == 1.0 ? vec3(0.26, 0.53, 0.21) : vec3(0.23, 0.49, 0.20);
        colour = base * (0.9 + 0.2 * seed) * lit;
        alpha = a;
        if (alpha < 1.0 && yc > r * 0.05) {
          float trunk = cover(abs(x) - 0.13 * r, r) * (y >= 0.0 && y <= yc ? 1.0 : 0.0);
          colour = mix(vec3(0.33, 0.24, 0.16), colour, alpha);
          alpha = max(alpha, trunk);
        }
      }
      if (alpha <= 0.02) discard;
      float fog = smoothstep(uFogFar * 0.45, uFogFar, distance(vWorld, uEye));
      gl_FragColor = vec4(mix(colour, uSky, fog), alpha);
    }
  `;

  /* ------------------------------------------------------------------ renderer */

  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(gl, vert, frag, attribs, uniforms) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vert));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    var loc = { program: p };
    attribs.forEach(function (n) { loc[n] = gl.getAttribLocation(p, n); });
    uniforms.forEach(function (n) { loc[n] = gl.getUniformLocation(p, n); });
    return loc;
  }
  function texture(gl, source) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    /* Never mipmapped: averaging terrain-RGB across a channel step invents cliffs. */
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  /* (segments+1)^2 vertices, one strip per row stitched with degenerates. Kept under 65536
     vertices so a 16-bit index serves on every WebGL1 device. */
  function gridMesh(gl, segments) {
    var n = segments + 1, verts = new Float32Array(n * n * 2), i = 0;
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) { verts[i++] = x / segments; verts[i++] = y / segments; }
    var idx = [];
    for (y = 0; y < segments; y++) {
      if (y > 0) idx.push(y * n);
      for (x = 0; x < n; x++) idx.push(y * n + x, (y + 1) * n + x);
      if (y < segments - 1) idx.push((y + 1) * n + (n - 1));
    }
    var vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    var ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
    return { vb: vb, ib: ib, count: idx.length };
  }

  /* A flat 1x1 terrain-RGB texel at height 0, for a hole published without elevation. */
  function flatElevation() {
    var c = document.createElement("canvas");
    c.width = c.height = 1;
    var ctx = c.getContext("2d");
    ctx.fillStyle = "rgb(1,134,160)";   // (1*65536 + 134*256 + 160) * 0.1 - 10000 = 0
    ctx.fillRect(0, 0, 1, 1);
    return c;
  }

  /* CPU copy of the heights, sampled the way LINEAR filtering samples them, so the camera can
     stand on the ground and stay out of it. */
  function heightSampler(image, w, h) {
    var c = document.createElement("canvas");
    c.width = w; c.height = h;
    var ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, w, h);
    var data = ctx.getImageData(0, 0, w, h).data;
    function at(x, y) {
      var i = (Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4;
      return -10000 + (data[i] * 65536 + data[i + 1] * 256 + data[i + 2]) * 0.1;
    }
    return function (u, v) {
      var x = u * w - 0.5, y = v * h - 0.5, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      var top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
      var bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
      return top * (1 - fy) + bottom * fy;
    };
  }

  function createScene(canvas) {
    var gl = canvas.getContext("webgl", { antialias: true, alpha: false });
    if (!gl) throw new Error("WebGL is not available in this browser");
    var ground = program(gl, GROUND_VERT, GROUND_FRAG, ["aGrid"],
      ["uElevation", "uViewProj", "uMetres", "uExaggeration", "uSeaLevel", "uPicture", "uTexel", "uMetresPerTexel", "uLight", "uAmbient", "uEye", "uSky", "uFogFar"]);
    var treeProg = program(gl, TREE_VERT, TREE_FRAG, ["aTree", "aCorner"],
      ["uElevation", "uViewProj", "uMetres", "uExaggeration", "uSeaLevel", "uRight", "uUp", "uSinT", "uCosT", "uEye", "uSky", "uFogFar"]);
    var sky = [0.62, 0.74, 0.84];
    var hole = null;   // {mesh, elevation, picture, trees, metres, demSize, seaLevel, ambient, heightAt}

    function release() {
      if (!hole) return;
      gl.deleteTexture(hole.elevation);
      gl.deleteTexture(hole.picture);
      gl.deleteBuffer(hole.mesh.vb);
      gl.deleteBuffer(hole.mesh.ib);
      if (hole.trees) { gl.deleteBuffer(hole.trees.vb); gl.deleteBuffer(hole.trees.ib); }
      hole = null;
    }

    /* input: {picture, elevation (image|null), demSize, metres, seaLevel, ambient, trees:[{u,v,r,type}]} */
    function setHole(input) {
      release();
      var dem = input.elevation;
      var demSize = dem ? input.demSize : [1, 1];
      var heightAt = dem ? heightSampler(dem, demSize[0], demSize[1]) : function () { return 0; };
      var segments = Math.max(16, Math.min(254, Math.max(demSize[0], demSize[1]) - 1));
      var trees = null;
      var list = (input.trees || []).slice(0, 16383);
      if (list.length) {
        var verts = new Float32Array(list.length * 4 * 6), i = 0;
        var corners = [[-1, 0], [1, 0], [1, 1], [-1, 1]];
        list.forEach(function (t) {
          corners.forEach(function (c) {
            verts[i++] = t.u; verts[i++] = t.v; verts[i++] = t.r; verts[i++] = t.type;
            verts[i++] = c[0]; verts[i++] = c[1];
          });
        });
        var vb = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vb);
        gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
        trees = { vb: vb, ib: gl.createBuffer(), list: list, count: list.length * 6 };
      }
      hole = {
        mesh: gridMesh(gl, segments),
        elevation: texture(gl, dem || flatElevation()),
        picture: texture(gl, input.picture),
        trees: trees,
        metres: input.metres,
        demSize: demSize,
        seaLevel: dem ? input.seaLevel : 0,
        ambient: input.ambient,
        heightAt: heightAt
      };
    }

    /* Metres of relief above the lowest point, exaggerated, at world x/z. */
    function groundAt(x, z, exaggeration) {
      if (!hole) return 0;
      var u = x / hole.metres[0] + 0.5, v = z / hole.metres[1] + 0.5;
      u = Math.min(1, Math.max(0, u)); v = Math.min(1, Math.max(0, v));
      return (hole.heightAt(u, v) - hole.seaLevel) * exaggeration;
    }

    /* Far trees first, so near ones paint over them with depth writes off. */
    function sortTrees(eye) {
      var t = hole.trees, list = t.list, mx = hole.metres[0], mz = hole.metres[1];
      var dist = list.map(function (tree, i) {
        var dx = (tree.u - 0.5) * mx - eye[0], dz = (tree.v - 0.5) * mz - eye[2];
        return { i: i, d: dx * dx + dz * dz };
      });
      dist.sort(function (a, b) { return b.d - a.d; });
      var idx = new Uint16Array(list.length * 6);
      dist.forEach(function (entry, k) {
        var v = entry.i * 4;
        idx[k * 6] = v; idx[k * 6 + 1] = v + 1; idx[k * 6 + 2] = v + 2;
        idx[k * 6 + 3] = v; idx[k * 6 + 4] = v + 2; idx[k * 6 + 5] = v + 3;
      });
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, t.ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.DYNAMIC_DRAW);
    }

    function render(camera, exaggeration) {
      var w = canvas.width, h = canvas.height;
      gl.viewport(0, 0, w, h);
      gl.clearColor(sky[0], sky[1], sky[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!hole) return;
      var span = Math.max(hole.metres[0], hole.metres[1]);
      var fogFar = span * 2.2;
      var view = lookAt(camera.eye, camera.target);
      var viewProj = multiply(perspective(50 * Math.PI / 180, w / Math.max(1, h), 0.5, span * 4), view.matrix);

      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.useProgram(ground.program);
      gl.uniformMatrix4fv(ground.uViewProj, false, new Float32Array(viewProj));
      gl.uniform2f(ground.uMetres, hole.metres[0], hole.metres[1]);
      gl.uniform1f(ground.uExaggeration, exaggeration);
      gl.uniform1f(ground.uSeaLevel, hole.seaLevel);
      gl.uniform2f(ground.uTexel, 1 / hole.demSize[0], 1 / hole.demSize[1]);
      gl.uniform2f(ground.uMetresPerTexel, hole.metres[0] / hole.demSize[0], hole.metres[1] / hole.demSize[1]);
      gl.uniform3f(ground.uLight, -0.6, 0.75, -0.35);
      gl.uniform1f(ground.uAmbient, hole.ambient);
      gl.uniform3fv(ground.uEye, new Float32Array(camera.eye));
      gl.uniform3fv(ground.uSky, new Float32Array(sky));
      gl.uniform1f(ground.uFogFar, fogFar);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, hole.elevation); gl.uniform1i(ground.uElevation, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, hole.picture); gl.uniform1i(ground.uPicture, 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, hole.mesh.vb);
      gl.enableVertexAttribArray(ground.aGrid);
      gl.vertexAttribPointer(ground.aGrid, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, hole.mesh.ib);
      gl.drawElements(gl.TRIANGLE_STRIP, hole.mesh.count, gl.UNSIGNED_SHORT, 0);
      gl.disableVertexAttribArray(ground.aGrid);

      if (hole.trees) {
        sortTrees(camera.eye);
        /* How far the view leans from straight down: 0 overhead (a disc), 1 level (a tree). */
        var look = norm(sub(camera.target, camera.eye));
        var sinT = Math.sqrt(Math.max(0, 1 - look[1] * look[1])), cosT = Math.max(0.0001, Math.abs(look[1]));
        gl.useProgram(treeProg.program);
        gl.uniformMatrix4fv(treeProg.uViewProj, false, new Float32Array(viewProj));
        gl.uniform2f(treeProg.uMetres, hole.metres[0], hole.metres[1]);
        gl.uniform1f(treeProg.uExaggeration, exaggeration);
        gl.uniform1f(treeProg.uSeaLevel, hole.seaLevel);
        gl.uniform3fv(treeProg.uRight, new Float32Array(view.right));
        gl.uniform3fv(treeProg.uUp, new Float32Array(view.up));
        gl.uniform1f(treeProg.uSinT, sinT);
        gl.uniform1f(treeProg.uCosT, cosT);
        gl.uniform3fv(treeProg.uEye, new Float32Array(camera.eye));
        gl.uniform3fv(treeProg.uSky, new Float32Array(sky));
        gl.uniform1f(treeProg.uFogFar, fogFar);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, hole.elevation); gl.uniform1i(treeProg.uElevation, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, hole.trees.vb);
        gl.enableVertexAttribArray(treeProg.aTree);
        gl.vertexAttribPointer(treeProg.aTree, 4, gl.FLOAT, false, 24, 0);
        gl.enableVertexAttribArray(treeProg.aCorner);
        gl.vertexAttribPointer(treeProg.aCorner, 2, gl.FLOAT, false, 24, 16);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, hole.trees.ib);
        gl.depthMask(false);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawElements(gl.TRIANGLES, hole.trees.count, gl.UNSIGNED_SHORT, 0);
        gl.disable(gl.BLEND);
        gl.depthMask(true);
        gl.disableVertexAttribArray(treeProg.aTree);
        gl.disableVertexAttribArray(treeProg.aCorner);
      }
    }

    function dispose() {
      release();
      try {
        gl.deleteProgram(ground.program);
        gl.deleteProgram(treeProg.program);
        var lose = gl.getExtension("WEBGL_lose_context");
        if (lose) lose.loseContext();
      } catch (e) { /* already gone */ }
    }

    return {
      setHole: setHole, render: render, dispose: dispose, groundAt: groundAt,
      metres: function () { return hole ? hole.metres : null; },
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE)
    };
  }

  /* ------------------------------------------------------------------ the page */

  function render(containerEl) {
    var destroyed = false;
    var scene = null;
    var loadToken = 0;
    var holes = [];
    var pkgPromise = null, pkgKey = "";
    var anchors = null;          // {tee:[x,z], green:[x,z]} in world metres, for the views
    var keys = {};
    var frame = 0;

    /* Orbit: round a target. Walk: standing on the ground, looking where you like. */
    var cam = { mode: "orbit", target: [0, 0, 0], yaw: 0, pitch: 0.6, dist: 400, pos: [0, 0, 0] };

    containerEl.innerHTML =
      '<div class="gdStudioLede" style="margin-bottom:12px">' +
      "<p>View only. A hole's 3D model, made from the same published picture, elevation and trees GPS Play uses, " +
      "with a camera you can move anywhere. Pick a course, then a hole.</p>" +
      "<p><strong>Orbit</strong>: drag to turn, right-drag or shift-drag to slide, scroll to zoom. " +
      "<strong>Walk</strong>: drag to look, W A S D to walk, shift to run. Both: W A S D move, Q E turn, R F up and down.</p></div>" +
      '<div class="gdStudioViewportBar">' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-3d="pick">Pick course</button>' +
      '<label class="gdStudioViewportField">Course key <input data-gd-3d="key" type="text" placeholder="course-key" style="width:180px"></label>' +
      '<label class="gdStudioViewportField">Hole <select data-gd-3d="hole"></select></label>' +
      '<label class="gdStudioViewportField">Style <select data-gd-3d="style">' +
      '<option value="photo">Photo</option><option value="illustrated">Illustrated</option></select></label>' +
      '<label class="gdStudioViewportField">Relief <input data-gd-3d="relief" type="range" min="0" max="6" step="0.25"> <span data-gd-3d="reliefValue"></span></label>' +
      "</div>" +
      '<div class="gdStudioViewportBar">' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-3d="viewOverhead">Overhead</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-3d="viewTee">From the tee</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-3d="viewGreen">Round the green</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-3d="mode">Walk</button>' +
      '<span class="gdStudioViewportCourse" data-gd-3d="course">No course picked</span>' +
      "</div>" +
      '<div class="gdStudioViewportMap" data-gd-3d="stage" tabindex="0" style="position:relative;outline:none;cursor:grab">' +
      '<canvas data-gd-3d="canvas" style="display:block;width:100%;height:100%;touch-action:none"></canvas></div>' +
      '<div class="gdStudioViewportReadout" data-gd-3d="readout"></div>';

    var el = {};
    ["pick", "key", "hole", "style", "relief", "reliefValue", "viewOverhead", "viewTee", "viewGreen", "mode", "course", "stage", "canvas", "readout"]
      .forEach(function (name) { el[name] = containerEl.querySelector('[data-gd-3d="' + name + '"]'); });

    try { scene = createScene(el.canvas); } catch (e) {
      el.stage.innerHTML = '<p class="gdStudioMuted" style="padding:16px">' + esc(e.message || e) + "</p>";
      return null;
    }

    /* A one-off message rides along in the readout until the next hole loads. */
    var message = "";
    function note(text) {
      message = text || "";
      el.readout.textContent = message;
      requestFrame();
    }

    /* ---- camera ---- */

    function ground(x, z) { return scene.groundAt(x, z, session.exaggeration); }

    function camera() {
      if (cam.mode === "walk") {
        var eye = [cam.pos[0], ground(cam.pos[0], cam.pos[2]) + EYE_HEIGHT_M + cam.pos[1], cam.pos[2]];
        var cp = Math.cos(cam.pitch);
        return { eye: eye, target: [eye[0] + Math.sin(cam.yaw) * cp, eye[1] + Math.sin(cam.pitch), eye[2] - Math.cos(cam.yaw) * cp] };
      }
      var t = [cam.target[0], ground(cam.target[0], cam.target[2]) + cam.target[1], cam.target[2]];
      var c = Math.cos(cam.pitch);
      var eyeO = [t[0] - Math.sin(cam.yaw) * c * cam.dist, t[1] + Math.sin(cam.pitch) * cam.dist, t[2] + Math.cos(cam.yaw) * c * cam.dist];
      /* Never under the ground: a camera inside a hill shows the inside of the hill. */
      eyeO[1] = Math.max(eyeO[1], ground(eyeO[0], eyeO[2]) + 2);
      return { eye: eyeO, target: t };
    }

    function requestFrame() {
      if (!frame && !destroyed) frame = requestAnimationFrame(tick);
    }

    var lastTick = 0;
    function tick(now) {
      frame = 0;
      if (destroyed) return;
      var dt = lastTick ? Math.min(0.1, (now - lastTick) / 1000) : 0;
      var moving = applyKeys(dt);
      lastTick = moving ? now : 0;
      resize();
      scene.render(camera(), session.exaggeration);
      readout();
      if (moving) requestFrame();
    }

    function applyKeys(dt) {
      var fwd = (keys.w || keys.arrowup ? 1 : 0) - (keys.s || keys.arrowdown ? 1 : 0);
      var side = (keys.d || keys.arrowright ? 1 : 0) - (keys.a || keys.arrowleft ? 1 : 0);
      var turn = (keys.e ? 1 : 0) - (keys.q ? 1 : 0);
      var lift = (keys.r ? 1 : 0) - (keys.f ? 1 : 0);
      if (!fwd && !side && !turn && !lift) return false;
      if (!dt) return true;
      var fast = keys.shift ? 4 : 1;
      var speed = (cam.mode === "walk" ? 8 : Math.max(10, cam.dist * 0.6)) * fast * dt;
      var sx = Math.sin(cam.yaw), cz = -Math.cos(cam.yaw);
      var p = cam.mode === "walk" ? cam.pos : cam.target;
      p[0] += (sx * fwd - cz * side) * speed;
      p[2] += (cz * fwd + sx * side) * speed;
      p[1] = Math.max(0, p[1] + lift * speed * 0.5);
      cam.yaw += turn * 1.4 * dt;
      clampToHole(p);
      return true;
    }

    function clampToHole(p) {
      var m = scene.metres();
      if (!m) return;
      var mx = m[0] * 0.75, mz = m[1] * 0.75;
      p[0] = Math.max(-mx, Math.min(mx, p[0]));
      p[2] = Math.max(-mz, Math.min(mz, p[2]));
    }

    var resizeKey = "";
    function resize() {
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      var w = Math.max(1, Math.round(el.stage.clientWidth * dpr)), h = Math.max(1, Math.round(el.stage.clientHeight * dpr));
      var key = w + "x" + h;
      if (key === resizeKey) return;
      resizeKey = key;
      el.canvas.width = w;
      el.canvas.height = h;
    }

    function readout() {
      var c = camera();
      var m = scene.metres();
      if (!m) return;
      var under = ground(c.eye[0], c.eye[2]);
      el.readout.textContent = (cam.mode === "walk" ? "Walking" : "Orbit") +
        " · " + Math.round(c.eye[1] - under) + "m above the ground" +
        " · heading " + Math.round(((cam.yaw * 180 / Math.PI) % 360 + 360) % 360) + "°" +
        " · frame " + Math.round(m[0]) + " × " + Math.round(m[1]) + "m" +
        (loadedNote ? " · " + loadedNote : "") +
        (message ? " · " + message : "");
    }

    /* ---- preset views ---- */

    function setMode(mode) {
      cam.mode = mode;
      el.mode.textContent = mode === "walk" ? "Orbit" : "Walk";
      el.stage.style.cursor = mode === "walk" ? "crosshair" : "grab";
    }

    function headingFrom(a, b) { return Math.atan2(b[0] - a[0], -(b[1] - a[1])); }

    function viewOverhead() {
      var m = scene.metres();
      if (!m) return;
      setMode("orbit");
      var centre = anchors && anchors.tee && anchors.green
        ? [(anchors.tee[0] + anchors.green[0]) / 2, (anchors.tee[1] + anchors.green[1]) / 2] : [0, 0];
      cam.target = [centre[0], 0, centre[1]];
      cam.yaw = anchors && anchors.tee && anchors.green ? headingFrom(anchors.tee, anchors.green) : 0;
      cam.pitch = 0.95;
      cam.dist = Math.max(m[0], m[1]) * 0.85;
      requestFrame();
    }

    function viewTee() {
      if (!anchors || !anchors.tee) { viewOverhead(); note("This hole's frame carries no tee position."); return; }
      setMode("walk");
      cam.pos = [anchors.tee[0], 0, anchors.tee[1]];
      cam.yaw = anchors.green ? headingFrom(anchors.tee, anchors.green) : 0;
      cam.pitch = -0.05;
      requestFrame();
    }

    function viewGreen() {
      if (!anchors || !anchors.green) { viewOverhead(); note("This hole's frame carries no green position."); return; }
      setMode("orbit");
      cam.target = [anchors.green[0], 0, anchors.green[1]];
      cam.yaw = anchors.tee ? headingFrom(anchors.tee, anchors.green) : 0;
      cam.pitch = 0.4;
      cam.dist = 70;
      requestFrame();
    }

    /* ---- input ---- */

    var drag = null;
    function onDown(e) {
      el.stage.focus();
      drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey, id: e.pointerId };
      try { el.canvas.setPointerCapture(e.pointerId); } catch (err) {}
      if (cam.mode === "orbit") el.stage.style.cursor = "grabbing";
    }
    function onMove(e) {
      if (!drag || drag.id !== e.pointerId || touches.size > 1) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (cam.mode === "orbit" && drag.pan) {
        var k = cam.dist / Math.max(200, el.stage.clientHeight) * 1.2;
        var sx = Math.sin(cam.yaw), cz = -Math.cos(cam.yaw);
        cam.target[0] += (-cz * -dx + sx * dy) * k;
        cam.target[2] += (sx * -dx + cz * dy) * k;
        clampToHole(cam.target);
      } else if (cam.mode === "orbit") {
        cam.yaw += dx * 0.006;
        cam.pitch = Math.max(0.03, Math.min(1.55, cam.pitch + dy * 0.005));
      } else {
        cam.yaw += dx * 0.004;
        cam.pitch = Math.max(-1.4, Math.min(1.4, cam.pitch - dy * 0.004));
      }
      requestFrame();
    }
    function onUp(e) {
      if (drag && drag.id === e.pointerId) drag = null;
      if (cam.mode === "orbit") el.stage.style.cursor = "grab";
    }
    function onWheel(e) {
      e.preventDefault();
      var factor = Math.exp(e.deltaY * 0.0012);
      if (cam.mode === "orbit") {
        cam.dist = Math.max(4, Math.min(4000, cam.dist * factor));
      } else {
        /* Scroll in walk mode steps forward or back along the view. */
        var step = -e.deltaY * 0.05;
        cam.pos[0] += Math.sin(cam.yaw) * step;
        cam.pos[2] -= Math.cos(cam.yaw) * step;
        clampToHole(cam.pos);
      }
      requestFrame();
    }

    /* Two fingers: pinch to zoom. One finger goes through the pointer handlers above. */
    var touches = new Map();
    var pinch = 0;
    function onTouchDown(e) { if (e.pointerType === "touch") touches.set(e.pointerId, [e.clientX, e.clientY]); }
    function onTouchMove(e) {
      if (e.pointerType !== "touch" || !touches.has(e.pointerId)) return;
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (touches.size !== 2) { pinch = 0; return; }
      var pts = Array.from(touches.values());
      var d = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
      if (pinch && cam.mode === "orbit") { cam.dist = Math.max(4, Math.min(4000, cam.dist * pinch / d)); requestFrame(); }
      pinch = d;
    }
    function onTouchUp(e) { touches.delete(e.pointerId); pinch = 0; }

    function onKey(down) {
      return function (e) {
        var k = e.key.toLowerCase();
        if (k === "shift") { keys.shift = down; return; }
        if (["w", "a", "s", "d", "q", "e", "r", "f", "arrowup", "arrowdown", "arrowleft", "arrowright"].indexOf(k) < 0) return;
        e.preventDefault();
        keys[k] = down;
        if (down) requestFrame();
      };
    }
    function onBlur() { keys = {}; }

    el.canvas.addEventListener("pointerdown", function (e) { onTouchDown(e); onDown(e); });
    el.canvas.addEventListener("pointermove", function (e) { onTouchMove(e); onMove(e); });
    el.canvas.addEventListener("pointerup", function (e) { onTouchUp(e); onUp(e); });
    el.canvas.addEventListener("pointercancel", function (e) { onTouchUp(e); onUp(e); });
    el.canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    el.canvas.addEventListener("wheel", onWheel, { passive: false });
    var keyDown = onKey(true), keyUp = onKey(false);
    el.stage.addEventListener("keydown", keyDown);
    el.stage.addEventListener("keyup", keyUp);
    el.stage.addEventListener("blur", onBlur);
    var resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(requestFrame) : null;
    if (resizeObserver) resizeObserver.observe(el.stage);

    /* ---- loading ---- */

    var loadedNote = "";

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

    /* The illustrated picture and its trees, painted exactly as painter.js illustratedPicture
       paints them for Play: same library, same frame pixel space, same tree placement. */
    function illustrated(entry, metresX) {
      var lib = window.GDIllustratedSurface, core = window.GDBubbleHazardCore;
      var meta = entry.meta, zoom = Number(meta.captureZoom), out = meta.outputDimensions || {};
      var frameW = Number(out.width) || 0, frameH = Number(out.height) || 0;
      if (!lib || !core) return Promise.reject(new Error("the illustrated map library did not load"));
      if (!meta.originPx || !Number.isInteger(zoom) || !frameW || !frameH) return Promise.reject(new Error("this frame has no projection to paint in"));
      return fetchPackage().then(function (pkg) {
        if (!pkg) throw new Error("no course package for this course");
        var surfaces = core.collectPackageSurfaces(pkg);
        if (!core.hasAnySurface(surfaces) || !lib.holeIsMapped(surfaces, entry.holeNumber)) {
          throw new Error("this hole has no green or fairway on the map, so Play shows the photo");
        }
        var scale = Math.min(1, ILLUSTRATED_PX / Math.max(frameW, frameH));
        var picture = document.createElement("canvas");
        picture.width = Math.max(1, Math.round(frameW * scale));
        picture.height = Math.max(1, Math.round(frameH * scale));
        var ox = Number(meta.originPx.x), oy = Number(meta.originPx.y);
        var trees = lib.placeTrees(window.GDWatchMapCore, surfaces, {
          transform: { a: scale, b: 0, tx: -ox * scale, ty: -oy * scale },
          refZoom: zoom,
          metresPerPixel: metresX / picture.width,
          imageWidth: picture.width,
          imageHeight: picture.height
        });
        var drawn = lib.paint(picture.getContext("2d"), {
          width: picture.width,
          height: picture.height,
          pxPerMetre: picture.width / metresX,
          project: function (pt) {
            var w = worldPx(pt.lat, pt.lng, zoom);
            return { x: (w.x - ox) * scale, y: (w.y - oy) * scale };
          },
          surfaces: surfaces,
          holes: lib.packageHoles(pkg),
          seed: Number(entry.holeNumber) || 1,
          trees: trees
        });
        if (!drawn) throw new Error("nothing mapped falls inside this frame");
        var ppm = picture.width / metresX;
        return {
          picture: picture,
          illustrated: true,
          trees: trees.map(function (t) { return { u: t.x / picture.width, v: t.y / picture.height, r: t.r / ppm, type: t.type }; })
        };
      });
    }

    /* The frame JPEG, scaled down if it is bigger than this GPU can hold as a texture. */
    function photo(entry) {
      return loadImage(assetUrl(entry.path)).then(function (img) {
        var max = Math.min(MAX_PICTURE_PX, scene.maxTexture || MAX_PICTURE_PX);
        var big = Math.max(img.naturalWidth, img.naturalHeight);
        if (big <= max) return { picture: img, trees: [] };
        var s = max / big, c = document.createElement("canvas");
        c.width = Math.round(img.naturalWidth * s);
        c.height = Math.round(img.naturalHeight * s);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        return { picture: c, trees: [] };
      });
    }

    function anchorsFor(entry, metres) {
      var meta = entry.meta, pins = meta.anchorPins || {}, zoom = Number(meta.captureZoom);
      var out = meta.outputDimensions || {}, w = Number(out.width), h = Number(out.height);
      if (!meta.originPx || !Number.isInteger(zoom) || !w || !h) return null;
      function at(pt) {
        if (!pt || !Number.isFinite(Number(pt.lat))) return null;
        var p = worldPx(pt.lat, pt.lng, zoom);
        return [((p.x - meta.originPx.x) / w - 0.5) * metres[0], ((p.y - meta.originPx.y) / h - 0.5) * metres[1]];
      }
      return { tee: at(pins.tee), green: at(pins.green) };
    }

    function loadHole(holeNumber, keepView) {
      var entry = holes.filter(function (h) { return h.holeNumber === Number(holeNumber); })[0];
      if (!entry) return;
      session.hole = entry.holeNumber;
      var token = ++loadToken;
      var elevation = entry.meta.elevation || null;
      var style = session.style;

      var out = entry.meta.outputDimensions || {};
      var metresX = elevation ? Number(elevation.metresPerPixel) * Number(elevation.width) : 0;
      var metresY = elevation ? Number(elevation.metresPerPixel) * Number(elevation.height) : 0;
      if (!metresX || !metresY) {
        /* No elevation: the ground scale from the frame's own zoom and latitude instead. */
        var lat = entry.meta.anchorPins && entry.meta.anchorPins.green ? Number(entry.meta.anchorPins.green.lat) : 0;
        var mpp = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, Number(entry.meta.captureZoom) || 18);
        metresX = mpp * (Number(out.width) || 1024);
        metresY = mpp * (Number(out.height) || 1024);
      }

      var picturePromise = style === "illustrated"
        ? illustrated(entry, metresX).catch(function (error) {
            loadedNote = "Illustrated unavailable (" + (error.message || error) + ") - showing the photo";
            return photo(entry);
          })
        : photo(entry);
      var elevationPromise = elevation && elevation.path
        ? loadImage(assetUrl(elevation.path)).catch(function () { return null; })
        : Promise.resolve(null);

      loadedNote = "";
      note("Loading hole " + entry.holeNumber + "…");
      Promise.all([picturePromise, elevationPromise]).then(function (res) {
        if (destroyed || token !== loadToken) return;
        var drawn = res[0], dem = res[1];
        var metres = [metresX, metresY];
        scene.setHole({
          picture: drawn.picture,
          elevation: dem,
          demSize: elevation ? [Number(elevation.width), Number(elevation.height)] : [1, 1],
          metres: metres,
          seaLevel: elevation && elevation.elevationRange ? Number(elevation.elevationRange.min) : 0,
          ambient: drawn.illustrated ? AMBIENT.illustrated : AMBIENT.photo,
          trees: drawn.trees
        });
        anchors = anchorsFor(entry, metres);
        message = "";
        var bits = [];
        if (!dem) bits.push("no elevation published for this hole - shown flat");
        if (drawn.trees && drawn.trees.length) bits.push(drawn.trees.length + " trees");
        if (elevation && elevation.elevationRange) {
          bits.push(Math.round(Number(elevation.elevationRange.max) - Number(elevation.elevationRange.min)) + "m of real relief");
        }
        loadedNote = [loadedNote].concat(bits).filter(Boolean).join(" · ");
        if (!keepView) viewOverhead(); else requestFrame();
      }).catch(function (error) {
        if (!destroyed && token === loadToken) note("Could not load hole " + entry.holeNumber + " - " + (error.message || error));
      });
    }

    function loadCourse(courseKey, courseName, course) {
      courseKey = String(courseKey || "").trim().toLowerCase();
      if (!courseKey) return;
      var changed = courseKey !== session.courseKey;
      session.courseKey = courseKey;
      session.courseName = courseName || courseKey;
      session.course = course || (changed ? null : session.course);
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
        onReturn: requestFrame,
        onPick: function (course) {
          if (destroyed) return;
          var key = slug(course);
          if (!key) { note("That course has no key to look its visuals up by."); return; }
          loadCourse(key, course && (course.name || course.courseName), course);
        }
      });
      if (!opened) note("The course picker is not loaded on this surface - type a course key instead.");
    }

    /* ---- controls ---- */

    el.pick.addEventListener("click", pickCourse);
    el.key.addEventListener("change", function () { loadCourse(el.key.value, "", null); });
    el.hole.addEventListener("change", function () { loadHole(el.hole.value, false); });
    el.style.value = session.style;
    el.style.addEventListener("change", function () {
      session.style = el.style.value;
      if (session.hole) loadHole(session.hole, true);
    });
    el.relief.value = String(session.exaggeration);
    el.reliefValue.textContent = session.exaggeration + "×";
    el.relief.addEventListener("input", function () {
      session.exaggeration = Number(el.relief.value) || 0;
      el.reliefValue.textContent = session.exaggeration + "×";
      requestFrame();
    });
    el.viewOverhead.addEventListener("click", viewOverhead);
    el.viewTee.addEventListener("click", viewTee);
    el.viewGreen.addEventListener("click", viewGreen);
    el.mode.addEventListener("click", function () {
      if (cam.mode === "orbit") {
        var c = camera();
        cam.pos = [c.target[0], 0, c.target[2]];
        cam.pitch = -0.05;
        setMode("walk");
      } else {
        cam.target = [cam.pos[0], 0, cam.pos[2]];
        cam.pitch = 0.5;
        cam.dist = 120;
        setMode("orbit");
      }
      requestFrame();
    });

    if (session.courseKey) loadCourse(session.courseKey, session.courseName, session.course);
    else note("Pick a course to load its holes.");
    requestFrame();

    return function cleanup() {
      destroyed = true;
      if (frame) cancelAnimationFrame(frame);
      if (resizeObserver) resizeObserver.disconnect();
      if (window.GDStudioCoursePick) window.GDStudioCoursePick.cancel();
      if (window.GDStudioShell) window.GDStudioShell.show();
      if (scene) scene.dispose();
      scene = null;
    };
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["course-3d"] = render;
})();
