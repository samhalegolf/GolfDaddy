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
 *   - scripts/trees/nz-trees.js            low-poly tree models, one per species
 *   - scripts/trees/nz-trees-real.js       realistic tree models (bark + leaf cards), for the photo
 *   - scripts/trees/tree-species.js        which species each tree is, guessed from the photo
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
      right: x, up: y, back: z
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

  /* Trees: real 3D models, one per species (scripts/trees), stood on the ground at each tree
     marker, turned by a seed from its position and scaled so the model's crown matches the
     marker's. aInst is per tree: frame u, v, scale, turn; aStretch lifts a realistic model to
     the low-poly one's height, so a tree does not change size as it changes detail. The relief
     is exaggerated, the trees are not.

     One program for both sets: the realistic models are textured (bark, and leaf cards cut
     out by alpha), the low-poly ones are vertex colour only. Leaf cards carry normals pointing
     out of the crown, so they are lit softly from all round (wrap lighting) and never flipped;
     everything else lights its back faces as fronts. On the photo the foliage leans a little
     towards the colour of the ground it stands on, so a dry course's trees are not a fresh
     green sticker. */
  var MESH_VERT = `
    attribute vec3 aPos;
    attribute vec3 aNor;
    attribute vec3 aCol;
    attribute vec2 aUv;
    attribute vec4 aInst;              // u, v, scale, turn (radians)
    attribute float aStretch;          // extra height scale, so near and far models stand equally tall
    uniform sampler2D uElevation;
    uniform mat4 uViewProj;
    uniform vec2 uMetres;
    uniform float uExaggeration;
    uniform float uSeaLevel;
    varying vec3 vNormal;
    varying vec3 vColour;
    varying vec2 vUv;
    varying vec2 vFootUv;
    varying vec3 vWorld;
  ` + DECODE + `
    void main() {
      float c = cos(aInst.w), s = sin(aInst.w);
      vec3 p = aPos * vec3(aInst.z, aInst.z * aStretch, aInst.z);
      p = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
      float h = (heightAt(aInst.xy) - uSeaLevel) * uExaggeration;
      vWorld = vec3((aInst.x - 0.5) * uMetres.x, h, (aInst.y - 0.5) * uMetres.y) + p;
      vNormal = vec3(c * aNor.x + s * aNor.z, aNor.y, -s * aNor.x + c * aNor.z);
      vColour = aCol;
      vUv = aUv;
      vFootUv = aInst.xy;
      gl_Position = uViewProj * vec4(vWorld, 1.0);
    }
  `;

  var MESH_FRAG = `
    precision highp float;
    uniform sampler2D uTex;
    uniform sampler2D uPicture;
    uniform float uTextured;
    uniform float uLeaf;
    uniform float uTint;
    uniform vec3 uLight;
    uniform vec3 uEye;
    uniform vec3 uSky;
    uniform float uFogFar;
    varying vec3 vNormal;
    varying vec3 vColour;
    varying vec2 vUv;
    varying vec2 vFootUv;
    varying vec3 vWorld;
    void main() {
      vec4 t = uTextured > 0.5 ? texture2D(uTex, vUv) : vec4(1.0);
      if (t.a < 0.45) discard;
      vec3 n = normalize(vNormal);
      if (uLeaf < 0.5 && !gl_FrontFacing) n = -n;
      float d = dot(n, normalize(uLight));
      float diffuse = uLeaf > 0.5 ? max(d * 0.6 + 0.4, 0.0) : max(d, 0.0);
      vec3 hemi = mix(vec3(0.32, 0.31, 0.27), vec3(0.72, 0.8, 0.9), n.y * 0.5 + 0.5);
      vec3 albedo = pow(t.rgb, vec3(2.2)) * vColour;
      if (uTint > 0.0) albedo = mix(albedo, pow(texture2D(uPicture, vFootUv).rgb, vec3(2.2)) * 0.7, uTint);
      vec3 colour = pow(albedo * (hemi * 0.55 + diffuse * vec3(1.0, 0.97, 0.9) * 0.95), vec3(1.0 / 2.2));
      float fog = smoothstep(uFogFar * 0.45, uFogFar, distance(vWorld, uEye));
      gl_FragColor = vec4(mix(colour, uSky, fog), 1.0);
    }
  `;

  var NOISE = `
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
    }
    float fbm(vec2 p) {
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.07 + vec2(1.7, 9.2); a *= 0.5; }
      return v;
    }
  `;

  /* Each aerial tree's shadow: a soft patch lying on the ground, thrown away from the sun by
     the tree's own height. Only with the aerial - the Illustrated picture paints its own. */
  var SHADOW_VERT = `
    attribute vec4 aTree;              // u, v, crown radius (m), tree height (m)
    attribute vec2 aCorner;
    uniform sampler2D uElevation;
    uniform mat4 uViewProj;
    uniform vec2 uMetres;
    uniform float uExaggeration;
    uniform float uSeaLevel;
    uniform vec2 uShadowDir;           // ground metres of shadow per metre of height
    varying vec2 vQ;
    varying float vSeed;
    varying vec3 vWorld;
  ` + DECODE + `
    void main() {
      float r = aTree.z;
      float seed = fract(sin(dot(aTree.xy, vec2(12.9898, 78.233))) * 43758.5453);
      float crown = aTree.w * 0.6;
      vec2 dir = normalize(uShadowDir), side = vec2(-dir.y, dir.x);
      float len = length(uShadowDir) * crown;
      vec2 q = vec2(aCorner.x, aCorner.y * 2.0 - 1.0);
      vec2 foot = vec2((aTree.x - 0.5) * uMetres.x, (aTree.y - 0.5) * uMetres.y);
      vec2 p = foot + dir * len * 0.6 + dir * q.y * (r * 1.1 + len * 0.5) + side * q.x * r * 1.1;
      float h = (heightAt(clamp(p / uMetres + 0.5, 0.0, 1.0)) - uSeaLevel) * uExaggeration + 0.25;
      vQ = q;
      vSeed = seed;
      vWorld = vec3(p.x, h, p.y);
      gl_Position = uViewProj * vec4(vWorld, 1.0);
    }
  `;

  var SHADOW_FRAG = `
    precision highp float;
    uniform vec3 uEye;
    uniform float uFogFar;
    varying vec2 vQ;
    varying float vSeed;
    varying vec3 vWorld;
  ` + NOISE + `
    void main() {
      float d = length(vQ) + (fbm(vQ * 3.0 + vSeed * 40.0) - 0.5) * 0.3;
      float fog = smoothstep(uFogFar * 0.45, uFogFar, distance(vWorld, uEye));
      float a = (1.0 - smoothstep(0.45, 1.0, d)) * 0.42 * (1.0 - fog);
      if (a <= 0.01) discard;
      gl_FragColor = vec4(0.02, 0.04, 0.02, a);
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
    /* The first attribute listed is always an enabled array: attribute 0 left as a constant
       is slow on desktop GL. */
    attribs.forEach(function (n, i) { gl.bindAttribLocation(p, i, n); });
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

  /* ------------------------------------------------------------------ tree models */

  /* The 3D trees come from the generators in scripts/trees, built here in the browser - the
     same code the .glb exports are made from. Low-poly models are quick to build and always
     ready; the realistic ones take a moment each, so they are built one species at a time
     after the hole is up and swap in as they arrive. Built models are kept for the page's
     life, across holes and leaving and re-entering the viewer. */
  var REAL_NEAR_M = 180;       // realistic models within this distance of the camera, on the photo
  var REAL_MAX = 300;          // and never more than this many at once, nearest first
  var SCALE_MIN = 0.45, SCALE_MAX = 1.8;
  var models = { low: {}, real: {} };

  function lowModel(id) {
    if (!models.low[id] && window.NZTrees) models.low[id] = window.NZTrees.build(id);
    return models.low[id] || null;
  }
  function realModel(id) {
    if (!models.real[id] && window.NZTreesReal) models.real[id] = window.NZTreesReal.build(id);
    return models.real[id] || null;
  }
  /* The model's own crown sized to the marker's, within reason: a tiny marker is a young tree,
     not a bonsai. */
  function scaleFor(model, r) {
    return Math.min(SCALE_MAX, Math.max(SCALE_MIN, r / Math.max(0.5, model.meta.crownRadiusM)));
  }
  /* A fixed turn per tree from where it stands, so a row is not a row of clones. */
  function turnFor(u, v) {
    var x = Math.sin(u * 12.9898 + v * 78.233) * 43758.5453;
    return (x - Math.floor(x)) * Math.PI * 2;
  }

  function createScene(canvas, onChange) {
    var gl = canvas.getContext("webgl", { antialias: true, alpha: false });
    if (!gl) throw new Error("WebGL is not available in this browser");
    var ground = program(gl, GROUND_VERT, GROUND_FRAG, ["aGrid"],
      ["uElevation", "uViewProj", "uMetres", "uExaggeration", "uSeaLevel", "uPicture", "uTexel", "uMetresPerTexel", "uLight", "uAmbient", "uEye", "uSky", "uFogFar"]);
    var mesh = program(gl, MESH_VERT, MESH_FRAG, ["aPos", "aNor", "aCol", "aUv", "aInst", "aStretch"],
      ["uElevation", "uViewProj", "uMetres", "uExaggeration", "uSeaLevel", "uTex", "uPicture", "uTextured", "uLeaf", "uTint", "uLight", "uEye", "uSky", "uFogFar"]);
    var shadows = program(gl, SHADOW_VERT, SHADOW_FRAG, ["aTree", "aCorner"],
      ["uElevation", "uViewProj", "uMetres", "uExaggeration", "uSeaLevel", "uShadowDir", "uEye", "uFogFar"]);
    var instanced = gl.getExtension("ANGLE_instanced_arrays");
    var wideIndex = !!gl.getExtension("OES_element_index_uint");
    var instanceBuffer = gl.createBuffer();
    var LIGHT = norm([-0.6, 0.75, -0.35]);
    var sky = [0.62, 0.74, 0.84];
    var hole = null;   // {mesh, elevation, picture, trees, metres, demSize, seaLevel, ambient, heightAt}

    /* ---- tree models on the GPU: per species, low and realistic ---- */

    var gpu = { low: {}, real: {} };
    var realQueue = [], realTimer = 0;

    function arrayBuffer(data) {
      var b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      return b;
    }
    /* Bark mipmaps the usual way; leaf atlases get NZTreesReal.mipLevels, which keeps the cut-out
       leaves from thinning to nothing at a distance. */
    function modelTexture(img, repeat) {
      var t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      if (repeat) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, img.data);
        gl.generateMipmap(gl.TEXTURE_2D);
      } else {
        window.NZTreesReal.mipLevels(img).forEach(function (level, i) {
          gl.texImage2D(gl.TEXTURE_2D, i, gl.RGBA, level.width, level.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, level.data);
        });
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      var wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
      return t;
    }
    /* One drawable part: buffers, optional uvs, indices and texture. */
    function part(g, tex, leaf) {
      var p = { pos: arrayBuffer(g.positions), nor: arrayBuffer(g.normals), col: arrayBuffer(g.colors), uv: g.uvs ? arrayBuffer(g.uvs) : null, tex: tex || null, leaf: !!leaf };
      if (g.indices) {
        p.ib = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, p.ib);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.indices, gl.STATIC_DRAW);
        p.count = g.indices.length;
        p.wide = g.indices instanceof Uint32Array;
      } else p.count = g.positions.length / 3;
      return p;
    }
    function lowGpu(id) {
      if (gpu.low[id] === undefined) {
        var m = null;
        try { m = lowModel(id); } catch (e) { m = null; }
        gpu.low[id] = m ? { meta: m.meta, parts: [part(m)] } : null;
      }
      return gpu.low[id];
    }
    function uploadReal(id) {
      var m = realModel(id);
      if (!m || ((m.bark.indices instanceof Uint32Array || m.leaves.indices instanceof Uint32Array) && !wideIndex)) { gpu.real[id] = null; return; }
      var parts = [];
      try {
        parts.push(part(m.bark, modelTexture(m.textures.bark, true), false));
        parts.push(part(m.leaves, modelTexture(m.textures.leaves, false), true));
      } catch (e) {
        parts.forEach(deletePart);
        throw e;
      }
      gpu.real[id] = { meta: m.meta, parts: parts };
    }
    /* Realistic models one species per tick, so the page never freezes for long. */
    function queueReal(ids) {
      ids.forEach(function (id) { if (gpu.real[id] === undefined && realQueue.indexOf(id) < 0) realQueue.push(id); });
      if (!realTimer && realQueue.length) realTimer = setTimeout(pump, 30);
    }
    function pump() {
      realTimer = 0;
      var id = realQueue.shift();
      if (!id) return;
      try { uploadReal(id); } catch (e) { gpu.real[id] = null; }
      if (onChange) onChange();
      if (realQueue.length) realTimer = setTimeout(pump, 30);
    }

    function deletePart(p) {
      [p.pos, p.nor, p.col, p.uv, p.ib].forEach(function (b) { if (b) gl.deleteBuffer(b); });
      if (p.tex) gl.deleteTexture(p.tex);
    }

    function release() {
      if (!hole) return;
      gl.deleteTexture(hole.elevation);
      gl.deleteTexture(hole.picture);
      gl.deleteBuffer(hole.mesh.vb);
      gl.deleteBuffer(hole.mesh.ib);
      if (hole.trees) { gl.deleteBuffer(hole.trees.shadowVb); gl.deleteBuffer(hole.trees.shadowIb); }
      hole = null;
    }

    /* input: {picture, elevation (image|null), demSize, metres, seaLevel, ambient, realistic,
       trees:[{u, v, r, species}]} - realistic is the photo: realistic models near the camera,
       and the trees' shadows on the ground. */
    function setHole(input) {
      release();
      /* Realistic models are only for the photo: switching to Illustrated stops building them. */
      if (!input.realistic) {
        if (realTimer) clearTimeout(realTimer);
        realTimer = 0;
        realQueue = [];
      }
      var dem = input.elevation;
      var demSize = dem ? input.demSize : [1, 1];
      var heightAt = dem ? heightSampler(dem, demSize[0], demSize[1]) : function () { return 0; };
      var segments = Math.max(16, Math.min(254, Math.max(demSize[0], demSize[1]) - 1));
      var trees = null;
      /* 16383 trees: four shadow corners each keeps the shadow index under 65536. */
      var list = (input.trees || []).slice(0, 16383).filter(function (t) { return lowGpu(t.species); });
      if (list.length) {
        var shadow = new Float32Array(list.length * 4 * 6), idx = new Uint16Array(list.length * 6), i = 0;
        var corners = [[-1, 0], [1, 0], [1, 1], [-1, 1]];
        var placed = list.map(function (t, k) {
          /* The low-poly model sets each tree's size, near or far: its crown and its height. */
          var low = lowGpu(t.species), scale = scaleFor(low, t.r), height = low.meta.heightM * scale;
          corners.forEach(function (c) {
            shadow[i++] = t.u; shadow[i++] = t.v; shadow[i++] = low.meta.crownRadiusM * scale; shadow[i++] = height;
            shadow[i++] = c[0]; shadow[i++] = c[1];
          });
          var v = k * 4;
          idx.set([v, v + 1, v + 2, v, v + 2, v + 3], k * 6);
          return { u: t.u, v: t.v, r: t.r, species: t.species, turn: turnFor(t.u, t.v), height: height };
        });
        var vb = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vb);
        gl.bufferData(gl.ARRAY_BUFFER, shadow, gl.STATIC_DRAW);
        var ib = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
        trees = { list: placed, shadowVb: vb, shadowIb: ib, shadowCount: idx.length };
        if (input.realistic) {
          queueReal(placed.map(function (t) { return t.species; }).filter(function (id, k, all) { return all.indexOf(id) === k; }));
        }
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
        realistic: !!input.realistic,
        heightAt: heightAt
      };
      return trees ? trees.list.length : 0;
    }

    /* Metres of relief above the lowest point, exaggerated, at world x/z. */
    function groundAt(x, z, exaggeration) {
      if (!hole) return 0;
      var u = x / hole.metres[0] + 0.5, v = z / hole.metres[1] + 0.5;
      u = Math.min(1, Math.max(0, u)); v = Math.min(1, Math.max(0, v));
      return (hole.heightAt(u, v) - hole.seaLevel) * exaggeration;
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
      gl.uniform3fv(ground.uLight, new Float32Array(LIGHT));
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

      if (!hole.trees) return;
      if (hole.realistic) drawShadows(viewProj, exaggeration, camera.eye, fogFar);
      drawTrees(viewProj, exaggeration, camera.eye, fogFar);
    }

    /* Shadows first, lying on the ground: away from the sun by each tree's height. */
    function drawShadows(viewProj, exaggeration, eye, fogFar) {
      gl.useProgram(shadows.program);
      gl.uniformMatrix4fv(shadows.uViewProj, false, new Float32Array(viewProj));
      gl.uniform2f(shadows.uMetres, hole.metres[0], hole.metres[1]);
      gl.uniform1f(shadows.uExaggeration, exaggeration);
      gl.uniform1f(shadows.uSeaLevel, hole.seaLevel);
      gl.uniform2f(shadows.uShadowDir, -LIGHT[0] / LIGHT[1], -LIGHT[2] / LIGHT[1]);
      gl.uniform3fv(shadows.uEye, new Float32Array(eye));
      gl.uniform1f(shadows.uFogFar, fogFar);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, hole.elevation); gl.uniform1i(shadows.uElevation, 0);
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-2, -2);
      gl.bindBuffer(gl.ARRAY_BUFFER, hole.trees.shadowVb);
      gl.enableVertexAttribArray(shadows.aTree);
      gl.vertexAttribPointer(shadows.aTree, 4, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(shadows.aCorner);
      gl.vertexAttribPointer(shadows.aCorner, 2, gl.FLOAT, false, 24, 16);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, hole.trees.shadowIb);
      gl.drawElements(gl.TRIANGLES, hole.trees.shadowCount, gl.UNSIGNED_SHORT, 0);
      gl.disableVertexAttribArray(shadows.aTree);
      gl.disableVertexAttribArray(shadows.aCorner);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
    }

    /* Every tree in view as its species' model: realistic for the nearest on the photo once
       that species' model is built, low-poly for the rest. Trees off screen are skipped, and
       each model is one draw. */
    function drawTrees(viewProj, exaggeration, eye, fogFar) {
      var list = hole.trees.list, mx = hole.metres[0], mz = hole.metres[1], M = viewProj;
      var seen = [];
      list.forEach(function (t, i) {
        var x = (t.u - 0.5) * mx, z = (t.v - 0.5) * mz;
        var y = (hole.heightAt(t.u, t.v) - hole.seaLevel) * exaggeration + t.height / 2;
        /* Clip-space test against a sphere round the tree, with room to spare. */
        var cx = M[0] * x + M[4] * y + M[8] * z + M[12], cy = M[1] * x + M[5] * y + M[9] * z + M[13];
        var cw = M[3] * x + M[7] * y + M[11] * z + M[15], rad = Math.max(t.height, t.r * 2) * 1.5;
        if (cw < -rad || cx > cw + rad * 2 || cx < -cw - rad * 2 || cy > cw + rad * 2 || cy < -cw - rad * 2) return;
        var dx = x - eye[0], dy = y - eye[1], dz = z - eye[2];
        seen.push({ i: i, d: dx * dx + dy * dy + dz * dz });
      });
      var near = {};
      if (hole.realistic) {
        seen.filter(function (e) { return gpu.real[list[e.i].species] && e.d < REAL_NEAR_M * REAL_NEAR_M; })
          .sort(function (a, b) { return a.d - b.d; })
          .slice(0, REAL_MAX)
          .forEach(function (e) { near[e.i] = true; });
      }
      var groups = {};
      seen.forEach(function (e) {
        var t = list[e.i], set = near[e.i] ? "real" : "low", model = gpu[set][t.species], key = set + ":" + t.species;
        var g = groups[key] || (groups[key] = { model: model, data: [] });
        var scale = scaleFor(model, t.r);
        g.data.push(t.u, t.v, scale, t.turn, set === "real" ? t.height / (model.meta.heightM * scale) : 1);
      });

      gl.useProgram(mesh.program);
      gl.uniformMatrix4fv(mesh.uViewProj, false, new Float32Array(viewProj));
      gl.uniform2f(mesh.uMetres, mx, mz);
      gl.uniform1f(mesh.uExaggeration, exaggeration);
      gl.uniform1f(mesh.uSeaLevel, hole.seaLevel);
      gl.uniform3fv(mesh.uLight, new Float32Array(LIGHT));
      gl.uniform3fv(mesh.uEye, new Float32Array(eye));
      gl.uniform3fv(mesh.uSky, new Float32Array(sky));
      gl.uniform1f(mesh.uFogFar, fogFar);
      gl.uniform1f(mesh.uTint, hole.realistic ? 0.12 : 0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, hole.elevation); gl.uniform1i(mesh.uElevation, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, hole.picture); gl.uniform1i(mesh.uPicture, 1);
      gl.uniform1i(mesh.uTex, 2);
      Object.keys(groups).forEach(function (key) {
        var g = groups[key], data = new Float32Array(g.data);
        g.model.parts.forEach(function (p) { drawPart(p, data); });
      });
    }

    /* One part (bark, leaves, or a whole low-poly tree) at every instance in data. Instanced
       where the browser can; one draw per tree where it cannot. */
    var PER_TREE = 5;   // u, v, scale, turn, stretch
    function drawPart(p, data) {
      var count = data.length / PER_TREE;
      [[p.pos, mesh.aPos, 3], [p.nor, mesh.aNor, 3], [p.col, mesh.aCol, 3]].forEach(function (a) {
        gl.bindBuffer(gl.ARRAY_BUFFER, a[0]);
        gl.enableVertexAttribArray(a[1]);
        gl.vertexAttribPointer(a[1], a[2], gl.FLOAT, false, 0, 0);
      });
      if (p.uv) {
        gl.bindBuffer(gl.ARRAY_BUFFER, p.uv);
        gl.enableVertexAttribArray(mesh.aUv);
        gl.vertexAttribPointer(mesh.aUv, 2, gl.FLOAT, false, 0, 0);
      } else {
        gl.disableVertexAttribArray(mesh.aUv);
        gl.vertexAttrib2f(mesh.aUv, 0, 0);
      }
      gl.uniform1f(mesh.uTextured, p.tex ? 1 : 0);
      gl.uniform1f(mesh.uLeaf, p.leaf ? 1 : 0);
      if (p.tex) { gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, p.tex); }
      if (p.ib) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, p.ib);
      var type = p.wide ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      /* Leaf cards are written front and back; culling draws each once. */
      if (p.leaf) gl.enable(gl.CULL_FACE);
      if (instanced) {
        gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(mesh.aInst);
        gl.vertexAttribPointer(mesh.aInst, 4, gl.FLOAT, false, PER_TREE * 4, 0);
        gl.enableVertexAttribArray(mesh.aStretch);
        gl.vertexAttribPointer(mesh.aStretch, 1, gl.FLOAT, false, PER_TREE * 4, 16);
        instanced.vertexAttribDivisorANGLE(mesh.aInst, 1);
        instanced.vertexAttribDivisorANGLE(mesh.aStretch, 1);
        if (p.ib) instanced.drawElementsInstancedANGLE(gl.TRIANGLES, p.count, type, 0, count);
        else instanced.drawArraysInstancedANGLE(gl.TRIANGLES, 0, p.count, count);
        instanced.vertexAttribDivisorANGLE(mesh.aInst, 0);
        instanced.vertexAttribDivisorANGLE(mesh.aStretch, 0);
        gl.disableVertexAttribArray(mesh.aInst);
        gl.disableVertexAttribArray(mesh.aStretch);
      } else {
        gl.disableVertexAttribArray(mesh.aInst);
        gl.disableVertexAttribArray(mesh.aStretch);
        for (var k = 0; k < count; k++) {
          var o = k * PER_TREE;
          gl.vertexAttrib4f(mesh.aInst, data[o], data[o + 1], data[o + 2], data[o + 3]);
          gl.vertexAttrib1f(mesh.aStretch, data[o + 4]);
          if (p.ib) gl.drawElements(gl.TRIANGLES, p.count, type, 0);
          else gl.drawArrays(gl.TRIANGLES, 0, p.count);
        }
      }
      if (p.leaf) gl.disable(gl.CULL_FACE);
      [mesh.aPos, mesh.aNor, mesh.aCol, mesh.aUv].forEach(function (loc) { gl.disableVertexAttribArray(loc); });
    }

    function dispose() {
      if (realTimer) clearTimeout(realTimer);
      realQueue = [];
      release();
      try {
        ["low", "real"].forEach(function (set) {
          Object.keys(gpu[set]).forEach(function (id) { if (gpu[set][id]) gpu[set][id].parts.forEach(deletePart); });
        });
        gl.deleteBuffer(instanceBuffer);
        gl.deleteProgram(ground.program);
        gl.deleteProgram(mesh.program);
        gl.deleteProgram(shadows.program);
        var lose = gl.getExtension("WEBGL_lose_context");
        if (lose) lose.loseContext();
      } catch (e) { /* already gone */ }
    }

    return {
      setHole: setHole, render: render, dispose: dispose, groundAt: groundAt,
      metres: function () { return hole ? hole.metres : null; },
      /* Realistic species still being built, for the readout. */
      pending: function () { return realQueue.length; },
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
      "with a camera you can move anywhere. Pick a course, then a hole. Each tree's species is guessed from the photo; " +
      "on the photo the nearest trees are the realistic models, the rest low-poly.</p>" +
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

    try { scene = createScene(el.canvas, requestFrame); } catch (e) {
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
        (scene.pending() ? " · building realistic trees (" + scene.pending() + " species to go)" : "") +
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
    /* The frame's own pixel space at a given canvas size: world-mercator pixels at the frame's
       capture zoom, shifted to its origin and scaled. Null when the frame carries no projection. */
    function frameSpace(entry, maxPx) {
      var meta = entry.meta, zoom = Number(meta.captureZoom), out = meta.outputDimensions || {};
      var frameW = Number(out.width) || 0, frameH = Number(out.height) || 0;
      if (!meta.originPx || !Number.isInteger(zoom) || !frameW || !frameH) return null;
      var scale = Math.min(1, maxPx / Math.max(frameW, frameH));
      var ox = Number(meta.originPx.x), oy = Number(meta.originPx.y);
      return {
        zoom: zoom, scale: scale, ox: ox, oy: oy,
        width: Math.max(1, Math.round(frameW * scale)),
        height: Math.max(1, Math.round(frameH * scale)),
        project: function (pt) {
          var w = worldPx(pt.lat, pt.lng, zoom);
          return { x: (w.x - ox) * scale, y: (w.y - oy) * scale };
        }
      };
    }

    /* Where the trees stand, in canvas pixels for this frame space, through the app's own
       placement (the watch's): every real tree marker where it is at its own crown size, then
       the mapped woods with no marker in them filled. A marker is one tree however big. */
    function placeTrees(space, surfaces, metresX, singleTrees) {
      return window.GDIllustratedSurface.placeTrees(window.GDWatchMapCore, surfaces, {
        transform: { a: space.scale, b: 0, tx: -space.ox * space.scale, ty: -space.oy * space.scale },
        refZoom: space.zoom,
        metresPerPixel: metresX / space.width,
        imageWidth: space.width,
        imageHeight: space.height
      }, singleTrees);
    }

    /* The course's real tree markers from the package (course-package.mjs singleTrees, [lat,
       lng, r] each, r the crown radius in metres) - the same list GPS Play stands. */
    function packageSingleTrees(pkg) {
      var list = pkg && Array.isArray(pkg.singleTrees) ? pkg.singleTrees : [];
      return list.filter(function (t) {
        return Array.isArray(t) && Number.isFinite(Number(t[0])) && Number.isFinite(Number(t[1])) && Number(t[2]) > 0;
      }).map(function (t) { return { lat: Number(t[0]), lng: Number(t[1]), r: Number(t[2]) }; });
    }

    /* Canvas-pixel trees as the renderer takes them: frame uv, crown radius in metres, species. */
    function treesInMetres(trees, space, metresX) {
      var ppm = space.width / metresX;
      return trees.map(function (t) { return { u: t.x / space.width, v: t.y / space.height, r: t.r / ppm, species: t.species }; });
    }

    /* Which species each tree is, guessed from the photo under its crown (and mapped water
       nearby, and the latitude) by scripts/trees/tree-species.js - nobody tags them. The photo
       is read at the same frame space the trees were placed in. No photo, or a photo the
       browser will not let us read, and the guess goes on size alone. */
    function withSpecies(trees, space, metresX, photoImage, surfaces, entry) {
      var lib = window.GDTreeSpecies;
      var fallback = lib ? lib.FALLBACK : "native-broadleaf";
      if (!lib || !trees.length) return trees.map(function (t) { return Object.assign({}, t, { species: fallback }); });
      var image = null;
      if (photoImage) {
        try {
          var c = document.createElement("canvas");
          c.width = space.width; c.height = space.height;
          var ctx = c.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(photoImage, 0, 0, space.width, space.height);
          image = ctx.getImageData(0, 0, space.width, space.height);
        } catch (e) { image = null; }
      }
      var water = ((surfaces && surfaces.water) || []).map(function (s) { return (s && s.ring || []).map(space.project); });
      var green = entry.meta.anchorPins && entry.meta.anchorPins.green;
      var ppm = space.width / metresX;
      var ids = lib.classify(trees.map(function (t) { return { x: t.x, y: t.y, r: t.r / ppm }; }), {
        image: image, pxPerMetre: ppm, water: water, lat: green ? Number(green.lat) : NaN
      });
      return trees.map(function (t, i) { return Object.assign({}, t, { species: ids[i] }); });
    }

    function packageSurfaces() {
      var core = window.GDBubbleHazardCore;
      if (!window.GDIllustratedSurface || !core) return Promise.reject(new Error("the illustrated map library did not load"));
      return fetchPackage().then(function (pkg) {
        if (!pkg) throw new Error("no course package for this course");
        return { pkg: pkg, surfaces: core.collectPackageSurfaces(pkg) };
      });
    }

    /* The illustrated picture and its trees, painted exactly as painter.js illustratedPicture
       paints them for Play: same library, same frame pixel space, same tree placement. */
    function illustrated(entry, metresX) {
      var lib = window.GDIllustratedSurface, core = window.GDBubbleHazardCore;
      var space = frameSpace(entry, ILLUSTRATED_PX);
      if (!space) return Promise.reject(new Error("this frame has no projection to paint in"));
      var photoImage = loadImage(assetUrl(entry.path)).catch(function () { return null; });
      return Promise.all([packageSurfaces(), photoImage]).then(function (res) {
        var course = res[0];
        var surfaces = course.surfaces;
        if (!core.hasAnySurface(surfaces) || !lib.holeIsMapped(surfaces, entry.holeNumber)) {
          throw new Error("this hole has no green or fairway on the map, so Play shows the photo");
        }
        var picture = document.createElement("canvas");
        picture.width = space.width;
        picture.height = space.height;
        var trees = placeTrees(space, surfaces, metresX, packageSingleTrees(course.pkg));
        var drawn = lib.paint(picture.getContext("2d"), {
          width: space.width,
          height: space.height,
          pxPerMetre: space.width / metresX,
          project: space.project,
          surfaces: surfaces,
          holes: lib.packageHoles(course.pkg),
          seed: Number(entry.holeNumber) || 1,
          trees: trees
        });
        if (!drawn) throw new Error("nothing mapped falls inside this frame");
        var standing = withSpecies(trees, space, metresX, res[1], surfaces, entry);
        return { picture: picture, illustrated: true, trees: treesInMetres(standing, space, metresX) };
      });
    }

    /* The frame JPEG, scaled down if it is bigger than this GPU can hold as a texture, with the
       same trees the illustrated map stands up: the real tree markers where they stand, and the
       mapped woods with none in them filled. No trees is still a complete picture: any failure
       finding them leaves the photo bare. */
    function photo(entry, metresX) {
      var space = frameSpace(entry, ILLUSTRATED_PX);
      var imagePromise = loadImage(assetUrl(entry.path));
      var treesPromise = space ? Promise.all([
        packageSurfaces().catch(function () { return { surfaces: {} }; }),
        imagePromise.catch(function () { return null; })
      ]).then(function (res) {
        var surfaces = res[0].surfaces, trees = placeTrees(space, surfaces, metresX, packageSingleTrees(res[0].pkg));
        return treesInMetres(withSpecies(trees, space, metresX, res[1], surfaces, entry), space, metresX);
      }).catch(function () { return []; }) : Promise.resolve([]);
      var picturePromise = imagePromise.then(function (img) {
        var max = Math.min(MAX_PICTURE_PX, scene.maxTexture || MAX_PICTURE_PX);
        var big = Math.max(img.naturalWidth, img.naturalHeight);
        if (big <= max) return img;
        var s = max / big, c = document.createElement("canvas");
        c.width = Math.round(img.naturalWidth * s);
        c.height = Math.round(img.naturalHeight * s);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        return c;
      });
      return Promise.all([picturePromise, treesPromise]).then(function (res) {
        return { picture: res[0], trees: res[1] };
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
            return photo(entry, metresX);
          })
        : photo(entry, metresX);
      var elevationPromise = elevation && elevation.path
        ? loadImage(assetUrl(elevation.path)).catch(function () { return null; })
        : Promise.resolve(null);

      loadedNote = "";
      note("Loading hole " + entry.holeNumber + "…");
      Promise.all([picturePromise, elevationPromise]).then(function (res) {
        if (destroyed || token !== loadToken) return;
        var drawn = res[0], dem = res[1];
        var metres = [metresX, metresY];
        var standing = scene.setHole({
          picture: drawn.picture,
          elevation: dem,
          demSize: elevation ? [Number(elevation.width), Number(elevation.height)] : [1, 1],
          metres: metres,
          seaLevel: elevation && elevation.elevationRange ? Number(elevation.elevationRange.min) : 0,
          ambient: drawn.illustrated ? AMBIENT.illustrated : AMBIENT.photo,
          realistic: !drawn.illustrated,
          trees: drawn.trees
        });
        anchors = anchorsFor(entry, metres);
        message = "";
        var bits = [];
        if (!dem) bits.push("no elevation published for this hole - shown flat");
        if (drawn.trees && drawn.trees.length && !standing) {
          bits.push("the tree models did not load, so the " + drawn.trees.length + " trees are not shown");
        } else if (standing) {
          var names = window.GDTreeSpecies ? window.GDTreeSpecies.summary(drawn.trees.slice(0, standing).map(function (t) { return t.species; })) : "";
          bits.push(standing + " trees" + (names ? " (" + names + ", guessed from the photo)" : ""));
        }
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
