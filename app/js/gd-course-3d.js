/* 3D course scene - a hole's 3D model: the ground draped over the terrain-RGB, and every tree
 * stood up as a 3D model of its species. One scene, drawn two ways:
 *
 *   - createViewer  Clarity Studio's 3D Course Viewer
 *                   (scripts/studio/courses/course-3d/course-3d-page.js): a real perspective
 *                   camera you move freely - orbit, walk, preset views. Studio only.
 *   - createFramed  GPS Play's 3D mode (the cube on the tool rail): no camera of its own. It
 *                   draws through Play's framing exactly as app/js/gd-terrain-mesh.js does - the
 *                   published frame, its CSS matrix and the lock tilt - so shot lock, tilt
 *                   framing, the overlays and the taps all work as they do on the plain mesh.
 *                   painter.js swaps it in for that mesh; nothing roams in the app.
 *
 * Same pictures, same heights, same trees either way; only how it is looked at differs.
 *
 * Styles - the first two are the ones GPS Settings offers:
 *   - photo        the published frame, realistic tree models near the camera, low-poly beyond
 *   - illustrated  the hole painted from the course map by app/js/gd-illustrated-surface.js,
 *                  low-poly trees. A hole with no green or fairway mapped shows the photo.
 *   - hybrid       Studio only, for now: the illustrated picture blended over the photo - how
 *                  much, how (setLook) and where (a mask of chosen surfaces, setMask).
 *
 * What the viewer's load needs:
 *   - meta          the frame's playSurface metadata (origin, zoom, size, elevation sidecar)
 *   - frameUrl      the frame JPEG
 *   - elevationUrl  the terrain-RGB PNG (none: the hole stands flat)
 *   - course()      a promise of {pkg, surfaces}: the course package and its collected
 *                   surfaces, for the illustrated picture and for where the trees stand
 * Play hands createFramed the pictures it already has instead.
 *
 * Libraries it reads but does not own: app/js/gd-illustrated-surface.js (painter + tree
 * placement), scripts/gd-watch-map-core.js (the placement recipe), scripts/trees/nz-trees.js
 * and nz-trees-real.js (the tree models), scripts/trees/tree-species.js (species from the
 * photo). Missing ones degrade: no models, no trees; no species guesser, every tree broadleaf.
 */
(function () {
  "use strict";

  var MAX_PICTURE_PX = 4096;      // most GPUs' texture ceiling; the frame is downscaled past it
  var ILLUSTRATED_PX = 2048;      // the app's MESH_MAX_PX - the picture is painted at this size
  var EYE_HEIGHT_M = 1.7;
  var FOV = 50 * Math.PI / 180;   // the free viewer's vertical field of view
  var AMBIENT = { photo: 0.78, illustrated: 0.5, live: 0.42 };   // painter.js: the published photo carries baked relief, a live frame does not

  /* World-mercator pixels at an integer zoom: the projection every published frame is cut in. */
  function worldPx(lat, lng, zoom) {
    var scale = 256 * Math.pow(2, zoom);
    var latRad = (Math.max(-85.05112878, Math.min(85.05112878, Number(lat))) * Math.PI) / 180;
    return {
      x: ((Number(lng) + 180) / 360) * scale,
      y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale
    };
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

  /* Play's mesh drops the frame's outermost ring back to the ground plane, so a lifted edge
     never opens a seam onto the background (gd-terrain-mesh.js). Drawn through Play's framing
     this does the same, which is also what the overlays' lift assumes. Off for the Studio. */
  var TUCK = `
    uniform float uEdgeTuck;
    float tuck(vec2 uv) {
      if (uEdgeTuck < 0.5) return 1.0;
      vec2 e = min(uv, 1.0 - uv);
      return smoothstep(0.0, 0.012, min(e.x, e.y));
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
  ` + DECODE + TUCK + `
    void main() {
      vUv = aGrid;
      float h = (heightAt(aGrid) - uSeaLevel) * uExaggeration * tuck(aGrid);
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
    /* Hybrid (the Studio's photo/illustrated blend): the illustrated picture over the photo,
       through a mask of where it applies. uBlend 0 is the picture alone - Play and the plain
       styles never take the blend branch. */
    uniform sampler2D uOverlay;
    uniform sampler2D uMask;
    uniform float uBlend;
    uniform float uMethod;             // 0 mix, 1 illustrated colour with photo detail, 2 overlay
    uniform float uDetail;             // how much of the photo's light and dark the detail keeps
    uniform float uLumaMean;           // the photo's average brightness, the detail's 1.0
    uniform float uSaturation;         // the photo's colour, 1 as taken
    /* The course outline (setClip): white inside. uClipMode 0 off, 1 the ground outside is
       cut away, 2 it is shown dimmed (while the outline is being trimmed). */
    uniform sampler2D uClip;
    uniform float uClipMode;
    varying vec2 vUv;
    varying vec3 vWorld;
  ` + DECODE + `
    void main() {
      float inside = texture2D(uClip, vUv).r;
      if (uClipMode > 0.5 && uClipMode < 1.5 && inside < 0.5) discard;
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
      vec3 photo = texture2D(uPicture, vUv).rgb;
      float luma = dot(photo, vec3(0.299, 0.587, 0.114));
      photo = clamp(mix(vec3(luma), photo, uSaturation), 0.0, 1.0);
      vec3 colour = photo;
      if (uBlend > 0.0) {
        vec3 drawn = texture2D(uOverlay, vUv).rgb;
        vec3 target = drawn;
        if (uMethod > 1.5) {
          target = mix(2.0 * photo * drawn, 1.0 - 2.0 * (1.0 - photo) * (1.0 - drawn), step(0.5, photo));
        } else if (uMethod > 0.5) {
          target = clamp(drawn * mix(1.0, luma / max(uLumaMean, 0.02), uDetail), 0.0, 1.0);
        }
        colour = mix(photo, target, texture2D(uMask, vUv).r * uBlend);
      }
      colour *= lit;
      if (uClipMode > 1.5 && inside < 0.5) colour = mix(vec3(dot(colour, vec3(0.299, 0.587, 0.114))), colour, 0.25) * 0.45;
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
  ` + DECODE + TUCK + `
    void main() {
      float c = cos(aInst.w), s = sin(aInst.w);
      vec3 p = aPos * vec3(aInst.z, aInst.z * aStretch, aInst.z);
      p = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
      float h = (heightAt(aInst.xy) - uSeaLevel) * uExaggeration * tuck(aInst.xy);
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
    uniform sampler2D uClip;
    uniform float uClipMode;
    varying vec3 vNormal;
    varying vec3 vColour;
    varying vec2 vUv;
    varying vec2 vFootUv;
    varying vec3 vWorld;
    void main() {
      if (uClipMode > 0.5 && texture2D(uClip, vFootUv).r < 0.5) discard;
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
    varying vec2 vFootUv;
  ` + DECODE + TUCK + `
    void main() {
      float r = aTree.z;
      vFootUv = aTree.xy;
      float seed = fract(sin(dot(aTree.xy, vec2(12.9898, 78.233))) * 43758.5453);
      float crown = aTree.w * 0.6;
      vec2 dir = normalize(uShadowDir), side = vec2(-dir.y, dir.x);
      float len = length(uShadowDir) * crown;
      vec2 q = vec2(aCorner.x, aCorner.y * 2.0 - 1.0);
      vec2 foot = vec2((aTree.x - 0.5) * uMetres.x, (aTree.y - 0.5) * uMetres.y);
      vec2 p = foot + dir * len * 0.6 + dir * q.y * (r * 1.1 + len * 0.5) + side * q.x * r * 1.1;
      vec2 uv = clamp(p / uMetres + 0.5, 0.0, 1.0);
      float h = (heightAt(uv) - uSeaLevel) * uExaggeration * tuck(uv) + 0.25;
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
    uniform sampler2D uClip;
    uniform float uClipMode;
    varying vec2 vQ;
    varying float vSeed;
    varying vec3 vWorld;
    varying vec2 vFootUv;
  ` + NOISE + `
    void main() {
      if (uClipMode > 0.5 && texture2D(uClip, vFootUv).r < 0.5) discard;
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
      ["uElevation", "uViewProj", "uMetres", "uExaggeration", "uSeaLevel", "uEdgeTuck", "uPicture", "uTexel", "uMetresPerTexel", "uLight", "uAmbient", "uEye", "uSky", "uFogFar",
       "uOverlay", "uMask", "uBlend", "uMethod", "uDetail", "uLumaMean", "uSaturation", "uClip", "uClipMode"]);
    var mesh = program(gl, MESH_VERT, MESH_FRAG, ["aPos", "aNor", "aCol", "aUv", "aInst", "aStretch"],
      ["uElevation", "uViewProj", "uMetres", "uExaggeration", "uSeaLevel", "uEdgeTuck", "uTex", "uPicture", "uTextured", "uLeaf", "uTint", "uLight", "uEye", "uSky", "uFogFar", "uClip", "uClipMode"]);
    var shadows = program(gl, SHADOW_VERT, SHADOW_FRAG, ["aTree", "aCorner"],
      ["uElevation", "uViewProj", "uMetres", "uExaggeration", "uSeaLevel", "uEdgeTuck", "uShadowDir", "uEye", "uFogFar", "uClip", "uClipMode"]);
    var instanced = gl.getExtension("ANGLE_instanced_arrays");
    var wideIndex = !!gl.getExtension("OES_element_index_uint");
    var instanceBuffer = gl.createBuffer();
    var LIGHT = norm([-0.6, 0.75, -0.35]);
    var sky = [0.62, 0.74, 0.84];
    /* How a hybrid hole is blended (setLook). shading null is automatic: the photo's light
       and the drawn map's, in proportion to the blend. */
    var look = { blend: 0, method: 0, detail: 1, saturation: 1, shading: null };
    var METHODS = { mix: 0, detail: 1, overlay: 2 };
    var hole = null;   // {mesh, elevation, picture, trees, metres, demSize, seaLevel, ambient, heightAt, clip, clipMode}
    /* Bound wherever a clip is sampled with none set: one white texel is "all inside". */
    var allInside = (function () {
      var c = document.createElement("canvas");
      c.width = c.height = 1;
      var ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, 1, 1);
      return texture(gl, c);
    })();

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
      if (hole.overlay) gl.deleteTexture(hole.overlay);
      if (hole.mask) gl.deleteTexture(hole.mask);
      if (hole.clip) gl.deleteTexture(hole.clip);
      gl.deleteBuffer(hole.mesh.vb);
      gl.deleteBuffer(hole.mesh.ib);
      if (hole.trees) { gl.deleteBuffer(hole.trees.shadowVb); gl.deleteBuffer(hole.trees.shadowIb); }
      hole = null;
    }

    /* input: {picture, elevation (image|null), demSize, metres, seaLevel, ambient, realistic,
       edgeTuck, trees:[{u, v, r, species}], overlay, mask, lumaMean} - realistic is the photo:
       realistic models near the camera, and the trees' shadows on the ground. edgeTuck is
       Play's: the frame's edge held on the ground plane. overlay and mask make it a hybrid
       hole: the illustrated picture, where the mask is white, blended over the photo by
       setLook. lumaMean is the photo's average brightness, for the detail blend. */
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
        edgeTuck: !!input.edgeTuck,
        overlay: input.overlay ? texture(gl, input.overlay) : null,
        mask: input.overlay && input.mask ? texture(gl, input.mask) : null,
        lumaMean: Number(input.lumaMean) > 0 ? Number(input.lumaMean) : 0.35,
        heightAt: heightAt,
        clip: null,
        clipMode: 0
      };
      return trees ? trees.list.length : 0;
    }

    /* The hole's own light, or on a hybrid hole the look's: the photo carries baked relief and
       the drawn map none, so automatic shading follows the blend between them. */
    function holeAmbient() {
      if (look.shading != null) return 1 - look.shading;
      if (!hole.overlay) return hole.ambient;
      return AMBIENT.photo + (AMBIENT.illustrated - AMBIENT.photo) * look.blend;
    }

    /* {blend 0..1, method "mix"|"detail"|"overlay", detail 0..2, saturation 0..1.5,
       shading 0..1 or null}: uniforms only, so a slider is live. */
    function setLook(next) {
      next = next || {};
      if (next.blend != null) look.blend = Math.max(0, Math.min(1, Number(next.blend) || 0));
      if (next.method != null) look.method = METHODS[next.method] != null ? METHODS[next.method] : 0;
      if (next.detail != null) look.detail = Math.max(0, Number(next.detail) || 0);
      if (next.saturation != null) look.saturation = Math.max(0, Number(next.saturation) || 0);
      if ("shading" in next) look.shading = next.shading == null ? null : Math.max(0, Math.min(1, Number(next.shading) || 0));
      if (onChange) onChange();
    }

    /* A new mask for the hole's overlay (where the illustrated picture applies). */
    function setMask(canvas2d) {
      if (!hole || !hole.overlay || !canvas2d) return;
      if (hole.mask) gl.deleteTexture(hole.mask);
      hole.mask = texture(gl, canvas2d);
      if (onChange) onChange();
    }

    /* The course outline over this hole's frame: canvas2d white inside, black outside, any
       size (it is stretched over the frame); mode "cut" hides the ground and trees outside,
       "show" dims the ground outside and hides the trees (for trimming). No canvas: off. */
    var CLIP_MODES = { cut: 1, show: 2 };
    function setClip(canvas2d, mode) {
      if (!hole) return;
      if (canvas2d !== undefined) {
        if (hole.clip) gl.deleteTexture(hole.clip);
        hole.clip = canvas2d ? texture(gl, canvas2d) : null;
      }
      hole.clipMode = hole.clip ? (CLIP_MODES[mode] || CLIP_MODES.cut) : 0;
      if (onChange) onChange();
    }

    /* Metres of relief above the lowest point, exaggerated, at world x/z. */
    function groundAt(x, z, exaggeration) {
      if (!hole) return 0;
      var u = x / hole.metres[0] + 0.5, v = z / hole.metres[1] + 0.5;
      u = Math.min(1, Math.max(0, u)); v = Math.min(1, Math.max(0, v));
      return (hole.heightAt(u, v) - hole.seaLevel) * exaggeration;
    }

    /* Through a real perspective camera, for the Studio's free viewer. */
    function render(camera, exaggeration) {
      var span = hole ? Math.max(hole.metres[0], hole.metres[1]) : 1;
      var view = lookAt(camera.eye, camera.target);
      var aspect = canvas.width / Math.max(1, canvas.height);
      var viewProj = multiply(perspective(FOV, aspect, 0.5, span * 4), view.matrix);
      draw({ viewProj: viewProj, eye: camera.eye, fogFar: span * 2.2, clear: sky }, exaggeration);
      /* What the frame was drawn through, so the viewer can put things on it and pick from it. */
      return { viewProj: viewProj, eye: camera.eye, right: view.right, up: view.up, back: view.back, aspect: aspect, far: span * 4 };
    }

    /* Through Play's own framing instead of a camera (createFramed below): the canvas IS the
       frame, and the frame's CSS matrix and lock tilt put it on screen exactly as they put the
       flat picture there. So ground at height zero lands on its own frame pixel, and height
       moves a point up the screen by gd-terrain-mesh.js's shear, h . pxPerMetre . tan(tilt)
       along the way that becomes screen-up - the same offset the overlays' lift applies. That
       is one affine map of the world, so it is a matrix like any other and the scene draws
       through it unchanged. Depth is distance along the leaning view: further up the screen
       is further away, higher is nearer. Flat (tilt 0) that is the hole seen from above.

       frame: {tiltDeg, frameRotationDeg, exaggeration, ambient, focusUv} - focusUv is where
       the realistic tree models gather (the player), the frame's centre without one. */
    var FRAME_CLEAR = [0.055, 0.075, 0.06];   // gd-terrain-mesh.js's background
    function renderFramed(frame) {
      var exaggeration = Number(frame.exaggeration) || 0;
      if (!hole) { draw({ clear: FRAME_CLEAR }, exaggeration); return; }
      var mx = hole.metres[0], mz = hole.metres[1], w = canvas.width, h = canvas.height;
      var tilt = (Number(frame.tiltDeg) || 0) * Math.PI / 180;
      var rot = -(Number(frame.frameRotationDeg) || 0) * Math.PI / 180;
      var up = [Math.sin(rot), -Math.cos(rot)];
      var shearPx = (w / mx) * Math.tan(tilt);
      var sin = Math.sin(tilt), cos = Math.cos(tilt), depth = Math.max(mx, mz) * 2 + 4000;
      var viewProj = [
        2 / mx, 0, sin * up[0] / depth, 0,
        2 * up[0] * shearPx / w, -2 * up[1] * shearPx / h, -cos / depth, 0,
        0, -2 / mz, sin * up[1] / depth, 0,
        0, 0, 0, 1
      ];
      var f = frame.focusUv;
      var fx = f ? (f[0] - 0.5) * mx : 0, fz = f ? (f[1] - 0.5) * mz : 0;
      draw({
        viewProj: viewProj, eye: [fx, groundAt(fx, fz, exaggeration), fz], fogFar: 1e9,
        clear: FRAME_CLEAR, ambient: frame.ambient
      }, exaggeration);
    }

    /* view: {viewProj, eye, fogFar, clear, ambient (the hole's own when left out)}. */
    function draw(view, exaggeration) {
      var w = canvas.width, h = canvas.height;
      gl.viewport(0, 0, w, h);
      gl.clearColor(view.clear[0], view.clear[1], view.clear[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!hole) return;
      var viewProj = view.viewProj, fogFar = view.fogFar, eye = view.eye;
      var tuck = hole.edgeTuck ? 1 : 0;

      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.useProgram(ground.program);
      gl.uniformMatrix4fv(ground.uViewProj, false, new Float32Array(viewProj));
      gl.uniform2f(ground.uMetres, hole.metres[0], hole.metres[1]);
      gl.uniform1f(ground.uExaggeration, exaggeration);
      gl.uniform1f(ground.uSeaLevel, hole.seaLevel);
      gl.uniform1f(ground.uEdgeTuck, tuck);
      gl.uniform2f(ground.uTexel, 1 / hole.demSize[0], 1 / hole.demSize[1]);
      gl.uniform2f(ground.uMetresPerTexel, hole.metres[0] / hole.demSize[0], hole.metres[1] / hole.demSize[1]);
      gl.uniform3fv(ground.uLight, new Float32Array(LIGHT));
      gl.uniform1f(ground.uAmbient, view.ambient != null ? view.ambient : holeAmbient());
      gl.uniform3fv(ground.uEye, new Float32Array(eye));
      gl.uniform3fv(ground.uSky, new Float32Array(sky));
      gl.uniform1f(ground.uFogFar, fogFar);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, hole.elevation); gl.uniform1i(ground.uElevation, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, hole.picture); gl.uniform1i(ground.uPicture, 1);
      var blending = hole.overlay && hole.mask && look.blend > 0;
      gl.uniform1f(ground.uBlend, blending ? look.blend : 0);
      gl.uniform1f(ground.uMethod, look.method);
      gl.uniform1f(ground.uDetail, look.detail);
      gl.uniform1f(ground.uLumaMean, hole.lumaMean);
      gl.uniform1f(ground.uSaturation, look.saturation);
      /* Bound whether or not they are used: a sampler left on another unit's texture is legal
         but reads the wrong thing the moment the branch is taken. */
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, hole.overlay || hole.picture); gl.uniform1i(ground.uOverlay, 2);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, hole.mask || hole.picture); gl.uniform1i(ground.uMask, 3);
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, hole.clip || allInside); gl.uniform1i(ground.uClip, 4);
      gl.uniform1f(ground.uClipMode, hole.clipMode);
      gl.bindBuffer(gl.ARRAY_BUFFER, hole.mesh.vb);
      gl.enableVertexAttribArray(ground.aGrid);
      gl.vertexAttribPointer(ground.aGrid, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, hole.mesh.ib);
      gl.drawElements(gl.TRIANGLE_STRIP, hole.mesh.count, gl.UNSIGNED_SHORT, 0);
      gl.disableVertexAttribArray(ground.aGrid);

      if (!hole.trees) return;
      if (hole.realistic) drawShadows(viewProj, exaggeration, eye, fogFar);
      drawTrees(viewProj, exaggeration, eye, fogFar);
    }

    /* Shadows first, lying on the ground: away from the sun by each tree's height. */
    function drawShadows(viewProj, exaggeration, eye, fogFar) {
      gl.useProgram(shadows.program);
      gl.uniformMatrix4fv(shadows.uViewProj, false, new Float32Array(viewProj));
      gl.uniform2f(shadows.uMetres, hole.metres[0], hole.metres[1]);
      gl.uniform1f(shadows.uExaggeration, exaggeration);
      gl.uniform1f(shadows.uSeaLevel, hole.seaLevel);
      gl.uniform1f(shadows.uEdgeTuck, hole.edgeTuck ? 1 : 0);
      gl.uniform2f(shadows.uShadowDir, -LIGHT[0] / LIGHT[1], -LIGHT[2] / LIGHT[1]);
      gl.uniform3fv(shadows.uEye, new Float32Array(eye));
      gl.uniform1f(shadows.uFogFar, fogFar);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, hole.elevation); gl.uniform1i(shadows.uElevation, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, hole.clip || allInside); gl.uniform1i(shadows.uClip, 1);
      gl.uniform1f(shadows.uClipMode, hole.clipMode);
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
      gl.uniform1f(mesh.uEdgeTuck, hole.edgeTuck ? 1 : 0);
      gl.uniform3fv(mesh.uLight, new Float32Array(LIGHT));
      gl.uniform3fv(mesh.uEye, new Float32Array(eye));
      gl.uniform3fv(mesh.uSky, new Float32Array(sky));
      gl.uniform1f(mesh.uFogFar, fogFar);
      gl.uniform1f(mesh.uTint, hole.realistic ? 0.12 : 0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, hole.elevation); gl.uniform1i(mesh.uElevation, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, hole.picture); gl.uniform1i(mesh.uPicture, 1);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, hole.clip || allInside); gl.uniform1i(mesh.uClip, 3);
      gl.uniform1f(mesh.uClipMode, hole.clipMode);
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
        gl.deleteTexture(allInside);
        gl.deleteProgram(ground.program);
        gl.deleteProgram(mesh.program);
        gl.deleteProgram(shadows.program);
        var lose = gl.getExtension("WEBGL_lose_context");
        if (lose) lose.loseContext();
      } catch (e) { /* already gone */ }
    }

    return {
      setHole: setHole, render: render, renderFramed: renderFramed, dispose: dispose, groundAt: groundAt,
      setLook: setLook, setMask: setMask, setClip: setClip,
      clear: function () { release(); if (onChange) onChange(); },
      metres: function () { return hole ? hole.metres : null; },
      /* The DEM's own heights (not exaggerated) at frame uv, sampled as the GPU samples them. */
      heightAt: function (u, v) { return hole ? hole.heightAt(u, v) : 0; },
      /* Realistic species still being built, for the readout. */
      pending: function () { return realQueue.length; },
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE)
    };
  }

  /* ------------------------------------------------------------------ the hole's picture */

  /* Ground metres across the frame: from the elevation sidecar, or with no elevation from
     the frame's own zoom and latitude. */
  function holeMetres(meta) {
    var elevation = meta.elevation || null, out = meta.outputDimensions || {};
    var mx = elevation ? Number(elevation.metresPerPixel) * Number(elevation.width) : 0;
    var my = elevation ? Number(elevation.metresPerPixel) * Number(elevation.height) : 0;
    if (mx && my) return [mx, my];
    var lat = meta.anchorPins && meta.anchorPins.green ? Number(meta.anchorPins.green.lat) : 0;
    var mpp = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, Number(meta.captureZoom) || 18);
    return [mpp * (Number(out.width) || 1024), mpp * (Number(out.height) || 1024)];
  }

  /* The frame's own pixel space at a given canvas size: world-mercator pixels at the frame's
     capture zoom, shifted to its origin and scaled. Null when the frame carries no projection. */
  function frameSpace(meta, maxPx) {
    var zoom = Number(meta.captureZoom), out = meta.outputDimensions || {};
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
  function placeTrees(space, surfaces, metresX, pkg) {
    var lib = window.GDIllustratedSurface;
    return lib.placeTrees(window.GDWatchMapCore, surfaces, {
      transform: { a: space.scale, b: 0, tx: -space.ox * space.scale, ty: -space.oy * space.scale },
      refZoom: space.zoom,
      metresPerPixel: metresX / space.width,
      imageWidth: space.width,
      imageHeight: space.height
    }, lib.singleTrees(pkg));
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
  function withSpecies(trees, space, metresX, photoImage, surfaces, meta) {
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
    var green = meta.anchorPins && meta.anchorPins.green;
    var ppm = space.width / metresX;
    var ids = lib.classify(trees.map(function (t) { return { x: t.x, y: t.y, r: t.r / ppm }; }), {
      image: image, pxPerMetre: ppm, water: water, lat: green ? Number(green.lat) : NaN
    });
    return trees.map(function (t, i) { return Object.assign({}, t, { species: ids[i] }); });
  }

  function courseSurfaces(input) {
    if (!window.GDIllustratedSurface) return Promise.reject(new Error("the illustrated map library did not load"));
    return Promise.resolve(input.course ? input.course() : null).then(function (course) {
      if (!course || !course.pkg) throw new Error("no course package for this course");
      return { pkg: course.pkg, surfaces: course.surfaces || {} };
    });
  }

  /* The illustrated picture and its trees, painted exactly as painter.js illustratedPicture
     paints them for Play: same library, same frame pixel space, same tree placement. */
  function illustrated(input, metresX) {
    var lib = window.GDIllustratedSurface, core = window.GDBubbleHazardCore;
    var meta = input.meta;
    var space = frameSpace(meta, ILLUSTRATED_PX);
    if (!space) return Promise.reject(new Error("this frame has no projection to paint in"));
    var photoImage = loadImage(input.frameUrl).catch(function () { return null; });
    return Promise.all([courseSurfaces(input), photoImage]).then(function (res) {
      var course = res[0];
      var surfaces = course.surfaces;
      /* A whole-course surface (no hole number) needs only something mapped somewhere on it. */
      if (!core || !core.hasAnySurface(surfaces) || (input.holeNumber != null && !lib.holeIsMapped(surfaces, input.holeNumber))) {
        throw new Error("this hole has no green or fairway on the map");
      }
      var picture = document.createElement("canvas");
      picture.width = space.width;
      picture.height = space.height;
      var trees = placeTrees(space, surfaces, metresX, course.pkg);
      var drawn = lib.paint(picture.getContext("2d"), {
        width: space.width,
        height: space.height,
        pxPerMetre: space.width / metresX,
        project: space.project,
        surfaces: surfaces,
        holes: lib.packageHoles(course.pkg),
        seed: Number(input.holeNumber) || 1,
        trees: trees
      });
      if (!drawn) throw new Error("nothing mapped falls inside this frame");
      var standing = withSpecies(trees, space, metresX, res[1], surfaces, meta);
      return { picture: picture, illustrated: true, trees: treesInMetres(standing, space, metresX) };
    });
  }

  /* The frame JPEG, scaled down if it is bigger than this GPU can hold as a texture, with the
     same trees the illustrated map stands up: the real tree markers where they stand, and the
     mapped woods with none in them filled. No trees is still a complete picture: any failure
     finding them leaves the photo bare. */
  function photo(input, metresX, maxTexture) {
    var space = frameSpace(input.meta, ILLUSTRATED_PX);
    var imagePromise = loadImage(input.frameUrl);
    var treesPromise = space ? Promise.all([
      courseSurfaces(input).catch(function () { return { pkg: null, surfaces: {} }; }),
      imagePromise.catch(function () { return null; })
    ]).then(function (res) {
      var surfaces = res[0].surfaces, trees = placeTrees(space, surfaces, metresX, res[0].pkg);
      return treesInMetres(withSpecies(trees, space, metresX, res[1], surfaces, input.meta), space, metresX);
    }).catch(function () { return []; }) : Promise.resolve([]);
    return Promise.all([fitTexture(imagePromise, maxTexture), treesPromise]).then(function (res) {
      return { picture: res[0], trees: res[1] };
    });
  }

  /* The frame JPEG as a texture can take it: downscaled past this GPU's ceiling. */
  function fitTexture(imagePromise, maxTexture) {
    return imagePromise.then(function (img) {
      var max = Math.min(MAX_PICTURE_PX, maxTexture || MAX_PICTURE_PX);
      var big = Math.max(img.naturalWidth, img.naturalHeight);
      if (big <= max) return img;
      var s = max / big, c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * s);
      c.height = Math.round(img.naturalHeight * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      return c;
    });
  }

  /* Hybrid: the photo underneath and the illustrated picture over it, both in the frame's own
     space, with what it takes to redraw the mask later (hybridMask) and the photo's average
     brightness for the detail blend. The trees are the illustrated map's, which are the
     photo's too - one placement. Rejects as illustrated() does, and the caller shows the
     photo. */
  function hybrid(input, metresX, maxTexture) {
    var space = frameSpace(input.meta, ILLUSTRATED_PX);
    return Promise.all([illustrated(input, metresX), fitTexture(loadImage(input.frameUrl), maxTexture), courseSurfaces(input)]).then(function (res) {
      return {
        picture: res[1],
        overlay: res[0].picture,
        trees: res[0].trees,
        lumaMean: meanLuma(res[1]),
        hybrid: { space: space, metresX: metresX, surfaces: res[2].surfaces, holes: window.GDIllustratedSurface.packageHoles(res[2].pkg) }
      };
    });
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

  /* The surfaces a hybrid mask can take, by the names the Studio shows. tees are points on the
     package's holes, drawn as a pad of TEE_PAD_M round each. */
  var MASK_SURFACES = ["greens", "fairways", "bunkers", "water", "trees", "tees"];
  var TEE_PAD_M = 8;

  /* Where the illustrated picture applies, white on black at the illustrated picture's size:
     everywhere, or only on the chosen surfaces. featherM softens the edge by that many metres
     (a blur where the browser has canvas filters, a hard edge where it has not).
     opts: {where: "all"|"surfaces", surfaces: {greens: true, ...}, featherM} */
  function hybridMask(data, opts) {
    opts = opts || {};
    var space = data.space;
    var c = document.createElement("canvas");
    c.width = space.width;
    c.height = space.height;
    var ctx = c.getContext("2d");
    if (opts.where !== "surfaces") {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      return c;
    }
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, c.width, c.height);
    var ppm = space.width / data.metresX;
    var feather = Math.max(0, Number(opts.featherM) || 0) * ppm;
    if (feather > 0 && "filter" in ctx) ctx.filter = "blur(" + feather.toFixed(1) + "px)";
    ctx.fillStyle = "#fff";
    var chosen = opts.surfaces || {};
    MASK_SURFACES.forEach(function (kind) {
      if (!chosen[kind]) return;
      if (kind === "tees") {
        (data.holes || []).forEach(function (hole) {
          if (!hole || !hole.tee) return;
          var at = space.project(hole.tee);
          ctx.beginPath();
          ctx.arc(at.x, at.y, TEE_PAD_M * ppm, 0, Math.PI * 2);
          ctx.fill();
        });
        return;
      }
      ((data.surfaces && data.surfaces[kind]) || []).forEach(function (surface) {
        var ring = (surface && surface.ring || []).map(space.project);
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

  /* Lat/lng to world metres from the frame's centre (x east, z south). Null when the frame
     carries no projection. */
  function frameWorld(meta, metres) {
    var zoom = Number(meta.captureZoom), out = meta.outputDimensions || {}, w = Number(out.width), h = Number(out.height);
    if (!meta.originPx || !Number.isInteger(zoom) || !w || !h) return null;
    return function (pt) {
      if (!pt || !Number.isFinite(Number(pt.lat)) || !Number.isFinite(Number(pt.lng))) return null;
      var p = worldPx(pt.lat, pt.lng, zoom);
      return [((p.x - meta.originPx.x) / w - 0.5) * metres[0], ((p.y - meta.originPx.y) / h - 0.5) * metres[1]];
    };
  }

  /* World metres from the frame's centre back to lat/lng: frameWorld's inverse. */
  function frameUnworld(meta, metres) {
    var zoom = Number(meta.captureZoom), out = meta.outputDimensions || {}, w = Number(out.width), h = Number(out.height);
    if (!meta.originPx || !Number.isInteger(zoom) || !w || !h) return null;
    var scale = 256 * Math.pow(2, zoom);
    return function (x, z) {
      var px = (x / metres[0] + 0.5) * w + Number(meta.originPx.x);
      var py = (z / metres[1] + 0.5) * h + Number(meta.originPx.y);
      var n = Math.PI - 2 * Math.PI * py / scale;
      return { lat: 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lng: px / scale * 360 - 180 };
    };
  }

  /* ------------------------------------------------------------------ the course outline */

  var CLIP_PX = 2048;   // the outline's mask over the frame: ~1 m a pixel on a whole course

  /* The outline as the scene's clip: white inside, over this frame's own pixel space. Null
     when there is no outline or the frame carries no projection. */
  function clipCanvas(meta, ring) {
    if (!ring || ring.length < 3) return null;
    var space = frameSpace(meta, CLIP_PX);
    if (!space) return null;
    var c = document.createElement("canvas");
    c.width = space.width;
    c.height = space.height;
    var ctx = c.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ring.forEach(function (p, i) {
      var at = space.project(p);
      if (i) ctx.lineTo(at.x, at.y); else ctx.moveTo(at.x, at.y);
    });
    ctx.closePath();
    ctx.fill();
    return c;
  }

  /* ------------------------------------------------------------------ Play's 3D mode */

  /* Where the trees stand on a frame and which species each is, as the scene takes them:
     the same placement and the same guess the viewer makes, for the frame Play has up.
     photo is the frame's aerial (the species are read from it; null guesses on size alone).
     Empty when anything it needs is missing - the hole still stands up, bare. */
  function frameTrees(opts) {
    var meta = opts.meta || {};
    var space = frameSpace(meta, ILLUSTRATED_PX), metresX = holeMetres(meta)[0];
    if (!space || !metresX || !window.GDIllustratedSurface) return [];
    try {
      var surfaces = opts.surfaces || {};
      var trees = placeTrees(space, surfaces, metresX, opts.pkg || null);
      return treesInMetres(withSpecies(trees, space, metresX, opts.photo || null, surfaces, meta), space, metresX);
    } catch (e) {
      return [];
    }
  }

  /* GPS Play's terrain drawn by this scene - the 3D tree models, their shadows on the photo,
     the realistic ones round the player - but through Play's own framing (renderFramed), so
     shot lock, the tilt, the overlays and the taps are exactly what they are on Play's plain
     mesh. Same contract as GDTerrainMesh.create, which painter.js swaps it in for:
     {state, render, dispose, lift, ground, offsetAt}, with the lift being that mesh's own
     displacer over this scene's heights.

     options: GDTerrainMesh.create's (aerial, elevation, metres, demSize, imagePx, framePx,
     seaLevel), plus trees (frameTrees) and illustrated (the aerial is the drawn map: low-poly
     trees, no shadows - the picture paints its own). state.focusPx (frame pixels) is where the
     realistic models gather. */
  function createFramed(canvas, options) {
    var framePx = options.framePx || null;
    var state = {
      tiltDeg: 32, frameRotationDeg: 0, exaggeration: 2.5, ambient: 0.55,
      metres: options.metres || [300, 300],
      demSize: options.demSize || [1024, 1024],
      imagePx: options.imagePx || [canvas.width, canvas.height],
      seaLevel: options.seaLevel || 0,
      focusPx: null
    };
    var scene = createScene(canvas, render);
    scene.setHole({
      picture: options.aerial,
      elevation: options.elevation,
      demSize: state.demSize,
      metres: state.metres,
      seaLevel: state.seaLevel,
      ambient: state.ambient,
      realistic: !options.illustrated,
      edgeTuck: true,
      trees: options.trees || []
    });
    var disposed = false;
    function render() {
      if (disposed) return;
      var f = state.focusPx;
      scene.renderFramed({
        tiltDeg: state.tiltDeg, frameRotationDeg: state.frameRotationDeg,
        exaggeration: state.exaggeration, ambient: state.ambient,
        focusUv: f && framePx ? [f.x / framePx[0], f.y / framePx[1]] : null
      });
    }
    var mesh = window.GDTerrainMesh;
    var displacer = framePx && mesh && mesh.makeDisplacer
      ? mesh.makeDisplacer({ heightAt: scene.heightAt, framePx: framePx, metres: state.metres, state: state })
      : { lift: function (px) { return px; }, ground: function (px) { return px; }, offsetAt: function () { return { x: 0, y: 0 }; } };
    return {
      state: state,
      render: render,
      dispose: function () {
        if (disposed) return;
        disposed = true;
        scene.dispose();
      },
      lift: displacer.lift,
      ground: displacer.ground,
      offsetAt: displacer.offsetAt
    };
  }

  /* ------------------------------------------------------------------ the viewer */

  /* The scene on a canvas inside stage, with the camera and its input. Throws when WebGL is
     not available. opts.onFrame runs after every drawn frame (for a readout), opts.onMode when
     the camera switches between orbit and walk. */
  function createViewer(stage, canvas, opts) {
    opts = opts || {};
    var destroyed = false;
    var frame = 0;
    var loadToken = 0;
    var keys = {};
    var anchors = null;          // {tee:[x,z], green:[x,z]} in world metres, for the views
    var toWorld = null;
    var fromWorld = null;
    var meta = null;             // the frame up, for redrawing the outline's mask
    var lastView = null;         // what the last frame was drawn through (scene.render)
    var exaggeration = opts.exaggeration != null ? Number(opts.exaggeration) : 2.5;
    var scene = createScene(canvas, requestFrame);

    /* Orbit: round a target. Walk: standing on the ground, looking where you like. */
    var cam = { mode: "orbit", target: [0, 0, 0], yaw: 0, pitch: 0.6, dist: 400, pos: [0, 0, 0] };

    /* Every listener goes through here so dispose can take it off again: the app keeps its
       stage between openings. */
    var listeners = [];
    function on(target, type, fn, options) {
      target.addEventListener(type, fn, options);
      listeners.push([target, type, fn, options]);
    }

    /* ---- camera ---- */

    function ground(x, z) { return scene.groundAt(x, z, exaggeration); }

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
      if (outline.dirty) applyOutline();
      lastView = scene.render(camera(), exaggeration);
      drawOutline();
      if (opts.onFrame) opts.onFrame();
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
      var w = Math.max(1, Math.round(stage.clientWidth * dpr)), h = Math.max(1, Math.round(stage.clientHeight * dpr));
      var key = w + "x" + h;
      if (key === resizeKey) return;
      resizeKey = key;
      canvas.width = w;
      canvas.height = h;
    }

    /* ---- preset views ---- */

    function setMode(mode) {
      cam.mode = mode;
      stage.style.cursor = mode === "walk" ? "crosshair" : "grab";
      if (opts.onMode) opts.onMode(mode);
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

    /* False when the frame carries no tee: the caller says so, the view goes overhead. */
    function viewTee() {
      if (!anchors || !anchors.tee) { viewOverhead(); return false; }
      setMode("walk");
      cam.pos = [anchors.tee[0], 0, anchors.tee[1]];
      cam.yaw = anchors.green ? headingFrom(anchors.tee, anchors.green) : 0;
      cam.pitch = -0.05;
      requestFrame();
      return true;
    }

    function viewGreen() {
      if (!anchors || !anchors.green) { viewOverhead(); return false; }
      setMode("orbit");
      cam.target = [anchors.green[0], 0, anchors.green[1]];
      cam.yaw = anchors.tee ? headingFrom(anchors.tee, anchors.green) : 0;
      cam.pitch = 0.4;
      cam.dist = 70;
      requestFrame();
      return true;
    }

    /* Standing at a lat/lng, looking at another (the green when none is given). False when
       the point is not on this hole's frame. */
    function viewFrom(point, toward) {
      var m = scene.metres(), at = toWorld && toWorld(point);
      if (!m || !at || Math.abs(at[0]) > m[0] / 2 || Math.abs(at[1]) > m[1] / 2) return false;
      var look = (toward && toWorld(toward)) || (anchors && anchors.green);
      setMode("walk");
      cam.pos = [at[0], 0, at[1]];
      if (look) cam.yaw = headingFrom(at, look);
      cam.pitch = -0.05;
      requestFrame();
      return true;
    }

    function toggleMode() {
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
    }

    /* ---- input ---- */

    /* Slide the view along the ground by a screen drag: the orbit's target, or the walker. */
    function slide(dx, dy) {
      var p = cam.mode === "walk" ? cam.pos : cam.target;
      var k = cam.mode === "walk" ? 0.08 : cam.dist / Math.max(200, stage.clientHeight) * 1.2;
      var sx = Math.sin(cam.yaw), cz = -Math.cos(cam.yaw);
      p[0] += (-cz * -dx + sx * dy) * k;
      p[2] += (sx * -dx + cz * dy) * k;
      clampToHole(p);
    }

    var drag = null;
    function onDown(e) {
      stage.focus();
      if (outline.trimming && trimDown(e)) return;
      drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey, id: e.pointerId };
      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
      if (cam.mode === "orbit") stage.style.cursor = "grabbing";
    }
    function onMove(e) {
      if (outline.trimming && trimMove(e)) return;
      if (!drag || drag.id !== e.pointerId || touches.size > 1) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (cam.mode === "orbit" && drag.pan) {
        slide(dx, dy);
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
      if (outline.drag && outline.drag.id === e.pointerId) trimUp();
      if (drag && drag.id === e.pointerId) drag = null;
      if (cam.mode === "orbit") stage.style.cursor = "grab";
    }
    /* Scroll zooms the orbit; in walk mode it steps forward or back along the view. */
    function step(metres) {
      cam.pos[0] += Math.sin(cam.yaw) * metres;
      cam.pos[2] -= Math.cos(cam.yaw) * metres;
      clampToHole(cam.pos);
    }
    function onWheel(e) {
      e.preventDefault();
      if (cam.mode === "orbit") cam.dist = Math.max(4, Math.min(4000, cam.dist * Math.exp(e.deltaY * 0.0012)));
      else step(-e.deltaY * 0.05);
      requestFrame();
    }

    /* Two fingers: pinch zooms (walks, in walk mode) and dragging both slides. One finger goes
       through the pointer handlers above. */
    var touches = new Map();
    var pinch = 0, mid = null;
    function onTouchDown(e) { if (e.pointerType === "touch") touches.set(e.pointerId, [e.clientX, e.clientY]); }
    function onTouchMove(e) {
      if (e.pointerType !== "touch" || !touches.has(e.pointerId)) return;
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (touches.size !== 2) { pinch = 0; mid = null; return; }
      var pts = Array.from(touches.values());
      var d = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
      var m = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
      if (pinch) {
        if (cam.mode === "orbit") cam.dist = Math.max(4, Math.min(4000, cam.dist * pinch / Math.max(1, d)));
        else step((d - pinch) * 0.15);
      }
      if (mid) slide(m[0] - mid[0], m[1] - mid[1]);
      pinch = d;
      mid = m;
      requestFrame();
    }
    /* Lifting one of two fingers hands the drag to the one left, from where it is now, so
       the view does not jump to where that finger first went down. */
    function onTouchUp(e) {
      touches.delete(e.pointerId);
      pinch = 0;
      mid = null;
      if (e.pointerType === "touch" && touches.size === 1) {
        var left = touches.entries().next().value;
        drag = { x: left[1][0], y: left[1][1], pan: false, id: left[0] };
      }
    }

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

    on(canvas, "pointerdown", function (e) { onTouchDown(e); onDown(e); });
    on(canvas, "pointermove", function (e) { onTouchMove(e); onMove(e); });
    on(canvas, "pointerup", function (e) { onUp(e); onTouchUp(e); });
    on(canvas, "pointercancel", function (e) { onUp(e); onTouchUp(e); });
    on(canvas, "contextmenu", function (e) { e.preventDefault(); });
    on(canvas, "wheel", onWheel, { passive: false });
    on(stage, "keydown", onKey(true));
    on(stage, "keyup", onKey(false));
    on(stage, "blur", function () { keys = {}; });
    var resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(requestFrame) : null;
    if (resizeObserver) resizeObserver.observe(stage);
    stage.style.cursor = "grab";

    /* ---- the course outline ---- */

    /* The outline drawn round the course: lat/lng points, cut out of the ground (setClip) and,
       while trimming, drawn over the 3D view as a line along the ground with a handle at each
       point and a smaller one halfway along each edge. Drag a handle to move the point, drag
       a halfway handle to add a point there, right-click (or long-press) a handle to take the
       point out. Undo steps back one edit. opts.onOutline(ring) runs after every change. */
    var outline = { ring: null, trimming: false, dirty: false, drag: null, history: [] };
    var overlay = document.createElement("canvas");
    overlay.setAttribute("data-gd-3d-overlay", "");
    overlay.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none";
    stage.appendChild(overlay);
    var HANDLE_PX = 7, HIT_PX = 12, EDGE_STEP_M = 8, LONG_PRESS_MS = 550;

    function copyRing(ring) { return ring ? ring.map(function (p) { return { lat: p.lat, lng: p.lng }; }) : null; }
    function outlineChanged() {
      outline.dirty = true;
      requestFrame();
      if (opts.onOutline) opts.onOutline(copyRing(outline.ring));
    }
    function applyOutline() {
      outline.dirty = false;
      var mask = meta ? clipCanvas(meta, outline.ring) : null;
      scene.setClip(mask, outline.trimming ? "show" : "cut");
    }
    function setOutline(ring) {
      outline.ring = ring && ring.length >= 3 ? copyRing(ring) : null;
      outline.history = [];
      outline.drag = null;
      outlineChanged();
    }
    function trim(on) {
      outline.trimming = !!on;
      outline.drag = null;
      stage.style.cursor = cam.mode === "walk" ? "crosshair" : "grab";
      outline.dirty = true;
      requestFrame();
    }
    function undoOutline() {
      if (!outline.history.length) return false;
      outline.ring = outline.history.pop();
      outlineChanged();
      return true;
    }
    function remember() {
      outline.history.push(copyRing(outline.ring));
      if (outline.history.length > 100) outline.history.shift();
    }

    /* A screen point (CSS px in the stage) to the ground under it: march the camera ray until
       it goes under the ground, then halve the step till it sits on it. Null off the ground. */
    function pick(sx, sy) {
      var v = lastView, m = scene.metres();
      if (!v || !m) return null;
      var tanHalf = Math.tan(FOV / 2);
      var nx = (sx / Math.max(1, stage.clientWidth)) * 2 - 1, ny = 1 - (sy / Math.max(1, stage.clientHeight)) * 2;
      var dir = norm([
        -v.back[0] + v.right[0] * nx * tanHalf * v.aspect + v.up[0] * ny * tanHalf,
        -v.back[1] + v.right[1] * nx * tanHalf * v.aspect + v.up[1] * ny * tanHalf,
        -v.back[2] + v.right[2] * nx * tanHalf * v.aspect + v.up[2] * ny * tanHalf
      ]);
      var step = Math.max(0.5, Math.max(m[0], m[1]) / 1500), prev = 0;
      function below(t) {
        var x = v.eye[0] + dir[0] * t, y = v.eye[1] + dir[1] * t, z = v.eye[2] + dir[2] * t;
        return y <= ground(x, z);
      }
      for (var t = step; t < v.far; t += step) {
        if (below(t)) {
          var lo = prev, hi = t;
          for (var i = 0; i < 24; i++) { var mid = (lo + hi) / 2; if (below(mid)) hi = mid; else lo = mid; }
          var x = v.eye[0] + dir[0] * hi, z = v.eye[2] + dir[2] * hi;
          if (Math.abs(x) > m[0] / 2 || Math.abs(z) > m[1] / 2) return null;
          return [x, z];
        }
        prev = t;
        step *= 1.004;
      }
      return null;
    }

    /* World x, y, z to stage CSS px through the last frame, or null behind the camera. */
    function screenOf(x, y, z) {
      var M = lastView && lastView.viewProj;
      if (!M) return null;
      var cw = M[3] * x + M[7] * y + M[11] * z + M[15];
      if (cw <= 0.5) return null;
      var cx = (M[0] * x + M[4] * y + M[8] * z + M[12]) / cw, cy = (M[1] * x + M[5] * y + M[9] * z + M[13]) / cw;
      return [(cx * 0.5 + 0.5) * stage.clientWidth, (0.5 - cy * 0.5) * stage.clientHeight];
    }
    function onGround(p) {
      var at = toWorld && toWorld(p);
      return at ? [at[0], ground(at[0], at[1]) + 0.4, at[1]] : null;
    }
    function handles() {
      var ring = outline.ring || [], points = [], mids = [];
      ring.forEach(function (p, i) {
        var a = onGround(p), b = onGround(ring[(i + 1) % ring.length]);
        points.push(a ? screenOf(a[0], a[1], a[2]) : null);
        if (a && b) {
          var mx = (a[0] + b[0]) / 2, mz = (a[2] + b[2]) / 2;
          mids.push(screenOf(mx, ground(mx, mz) + 0.4, mz));
        } else mids.push(null);
      });
      return { points: points, mids: mids };
    }
    function nearest(list, sx, sy) {
      var best = -1, bestD = HIT_PX * HIT_PX;
      list.forEach(function (p, i) {
        if (!p) return;
        var d = (p[0] - sx) * (p[0] - sx) + (p[1] - sy) * (p[1] - sy);
        if (d < bestD) { bestD = d; best = i; }
      });
      return best;
    }
    function local(e) {
      var r = stage.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    }

    function removePoint(i) {
      if (!outline.ring || outline.ring.length <= 3) return false;
      remember();
      outline.ring.splice(i, 1);
      outlineChanged();
      return true;
    }

    /* True when the press was the outline's (on a handle); anything else moves the camera. */
    function trimDown(e) {
      var at = local(e), h = handles();
      var i = nearest(h.points, at[0], at[1]);
      if (i >= 0 && (e.button === 2 || e.ctrlKey || e.metaKey)) { removePoint(i); return true; }
      if (e.button !== 0 || e.shiftKey) return false;
      if (i >= 0) {
        remember();
        outline.drag = { id: e.pointerId, index: i, moved: false, timer: setTimeout(function () {
          /* Held without moving: take the point out (touch has no right button). */
          if (outline.drag && !outline.drag.moved) { var k = outline.drag.index; outline.drag = null; outline.history.pop(); removePoint(k); }
        }, LONG_PRESS_MS) };
      } else {
        var k = nearest(h.mids, at[0], at[1]);
        if (k < 0) return false;
        remember();
        var a = outline.ring[k], b = outline.ring[(k + 1) % outline.ring.length];
        outline.ring.splice(k + 1, 0, { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 });
        outline.drag = { id: e.pointerId, index: k + 1, moved: true, timer: 0 };
        outlineChanged();
      }
      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
      return true;
    }
    function trimMove(e) {
      var at = local(e);
      if (!outline.drag) {
        var h = handles(), over = nearest(h.points, at[0], at[1]) >= 0 || nearest(h.mids, at[0], at[1]) >= 0;
        if (!drag) stage.style.cursor = over ? "move" : (cam.mode === "walk" ? "crosshair" : "grab");
        return false;
      }
      if (outline.drag.id !== e.pointerId) return true;
      var hit = pick(at[0], at[1]);
      if (!hit || !fromWorld) return true;
      if (outline.drag.timer) { clearTimeout(outline.drag.timer); outline.drag.timer = 0; }
      outline.drag.moved = true;
      outline.ring[outline.drag.index] = fromWorld(hit[0], hit[1]);
      outlineChanged();
      return true;
    }
    function trimUp() {
      if (outline.drag && outline.drag.timer) clearTimeout(outline.drag.timer);
      if (outline.drag && !outline.drag.moved) outline.history.pop();   // a click on a handle changed nothing
      outline.drag = null;
    }

    /* The outline over the 3D view while trimming: each edge stepped along the ground so it
       lies over the hills rather than cutting through them. */
    function drawOutline() {
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      var w = Math.round(stage.clientWidth * dpr), h = Math.round(stage.clientHeight * dpr);
      if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h; }
      var ctx = overlay.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      var ring = outline.ring;
      if (!outline.trimming || !ring || !toWorld) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.beginPath();
      var open = false;
      ring.forEach(function (p, i) {
        var a = toWorld(p), b = toWorld(ring[(i + 1) % ring.length]);
        if (!a || !b) { open = false; return; }
        var n = Math.max(1, Math.min(64, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / EDGE_STEP_M)));
        for (var k = 0; k <= n; k++) {
          var x = a[0] + (b[0] - a[0]) * k / n, z = a[1] + (b[1] - a[1]) * k / n;
          var sp = screenOf(x, ground(x, z) + 0.4, z);
          if (!sp) { open = false; continue; }
          if (open) ctx.lineTo(sp[0], sp[1]); else ctx.moveTo(sp[0], sp[1]);
          open = true;
        }
      });
      ctx.lineJoin = "round";
      ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.lineWidth = 5; ctx.stroke();
      ctx.strokeStyle = "#ffd23f"; ctx.lineWidth = 2.5; ctx.stroke();
      var hs = handles();
      hs.mids.forEach(function (p) {
        if (!p) return;
        ctx.beginPath(); ctx.arc(p[0], p[1], HANDLE_PX * 0.6, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,210,63,0.35)"; ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = "#ffd23f"; ctx.stroke();
      });
      hs.points.forEach(function (p, i) {
        if (!p) return;
        ctx.beginPath(); ctx.arc(p[0], p[1], HANDLE_PX, 0, Math.PI * 2);
        ctx.fillStyle = outline.drag && outline.drag.index === i ? "#ffd23f" : "#fff"; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = "#1b1b1b"; ctx.stroke();
      });
    }

    /* ---- loading ---- */

    /* Stand a hole up. Resolves with what was built - {illustrated, hybrid,
       illustratedUnavailable, flat, trees, standing, reliefM} - or null when a later load
       overtook this one. An Illustrated or Hybrid hole that cannot be painted shows the photo,
       and says why. input.style is "photo", "illustrated" or "hybrid"; a hybrid load also takes
       mask (hybridMask's opts) and treeModels. */
    var hybridData = null;
    function load(input, keepView) {
      var token = ++loadToken;
      var meta0 = input.meta || {};
      var elevation = meta0.elevation || null;
      var metres = holeMetres(meta0);
      var surfaces = null;
      var once = Object.assign({}, input, {
        course: function () { return surfaces || (surfaces = Promise.resolve(input.course ? input.course() : null)); }
      });
      var unavailable = "";
      function orPhoto(error) {
        unavailable = String((error && error.message) || error);
        return photo(once, metres[0], scene.maxTexture);
      }
      var picturePromise = input.style === "illustrated" ? illustrated(once, metres[0]).catch(orPhoto)
        : input.style === "hybrid" ? hybrid(once, metres[0], scene.maxTexture).catch(orPhoto)
        : photo(once, metres[0], scene.maxTexture);
      var elevationPromise = elevation && input.elevationUrl
        ? loadImage(input.elevationUrl).catch(function () { return null; })
        : Promise.resolve(null);
      return Promise.all([picturePromise, elevationPromise]).then(function (res) {
        if (destroyed || token !== loadToken) return null;
        var drawn = res[0], dem = res[1];
        hybridData = drawn.hybrid || null;
        var standing = scene.setHole({
          picture: drawn.picture,
          elevation: dem,
          demSize: elevation ? [Number(elevation.width), Number(elevation.height)] : [1, 1],
          metres: metres,
          seaLevel: elevation && elevation.elevationRange ? Number(elevation.elevationRange.min) : 0,
          ambient: drawn.illustrated ? AMBIENT.illustrated : meta0.liveTerrain ? AMBIENT.live : AMBIENT.photo,
          /* treeModels ("realistic" | "low") overrides the style's own choice. */
          realistic: input.treeModels ? input.treeModels === "realistic" : !drawn.illustrated,
          trees: drawn.trees,
          overlay: drawn.overlay || null,
          mask: hybridData ? hybridMask(hybridData, input.mask) : null,
          lumaMean: drawn.lumaMean
        });
        meta = meta0;
        toWorld = frameWorld(meta, metres);
        fromWorld = frameUnworld(meta, metres);
        /* The outline goes with the frame: a new frame, a new mask from the outline given. */
        outline.ring = input.outline && input.outline.length >= 3 ? copyRing(input.outline) : null;
        outline.history = [];
        outline.drag = null;
        applyOutline();
        var pins = meta.anchorPins || {};
        anchors = toWorld ? { tee: toWorld(input.tee || pins.tee), green: toWorld(input.green || pins.green) } : null;
        if (!keepView) viewOverhead(); else requestFrame();
        return {
          illustrated: !!drawn.illustrated,
          hybrid: !!hybridData,
          illustratedUnavailable: unavailable,
          flat: !dem,
          trees: drawn.trees || [],
          standing: standing,
          reliefM: elevation && elevation.elevationRange
            ? Number(elevation.elevationRange.max) - Number(elevation.elevationRange.min) : null
        };
      }, function (error) {
        if (destroyed || token !== loadToken) return null;
        throw error;
      });
    }

    function dispose() {
      destroyed = true;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (resizeObserver) resizeObserver.disconnect();
      listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2], l[3]); });
      listeners = [];
      if (outline.drag && outline.drag.timer) clearTimeout(outline.drag.timer);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      scene.dispose();
    }

    requestFrame();

    return {
      load: load,
      viewOverhead: viewOverhead,
      viewTee: viewTee,
      viewGreen: viewGreen,
      viewFrom: viewFrom,
      toggleMode: toggleMode,
      mode: function () { return cam.mode; },
      /* Nothing up: a load in flight is dropped and the stage shows the sky. */
      clear: function () {
        loadToken++;
        scene.clear();
        meta = toWorld = fromWorld = anchors = null;
        outline.ring = null;
        outline.history = [];
        outline.drag = null;
        outline.trimming = false;
        requestFrame();
      },
      exaggeration: function () { return exaggeration; },
      /* Hybrid: the blend (scene setLook), live; and where it applies (hybridMask's opts),
         redrawn from the hole already up. */
      setLook: function (next) { scene.setLook(next); },
      setMask: function (opts) { if (hybridData) scene.setMask(hybridMask(hybridData, opts)); },
      setExaggeration: function (value) { exaggeration = Math.max(0, Number(value) || 0); requestFrame(); },
      /* The course outline: [{lat, lng}] or null (setOutline), editing it on the view (trim),
         stepping back one edit (undoOutline), and the outline as it stands (outline). */
      setOutline: setOutline,
      trim: trim,
      trimming: function () { return outline.trimming; },
      undoOutline: undoOutline,
      outline: function () { return copyRing(outline.ring); },
      /* Ground under a stage point (CSS px), as lat/lng - null off the ground. */
      pickLatLng: function (sx, sy) { var hit = pick(sx, sy); return hit && fromWorld ? fromWorld(hit[0], hit[1]) : null; },
      requestFrame: requestFrame,
      /* Where the camera is, for a readout. Null until a hole is up. */
      status: function () {
        var m = scene.metres();
        if (!m) return null;
        var c = camera();
        return {
          mode: cam.mode,
          aboveGroundM: c.eye[1] - ground(c.eye[0], c.eye[2]),
          headingDeg: ((cam.yaw * 180 / Math.PI) % 360 + 360) % 360,
          metres: m,
          pendingSpecies: scene.pending()
        };
      },
      dispose: dispose
    };
  }

  window.GDCourse3D = { createViewer: createViewer, createFramed: createFramed, frameTrees: frameTrees };
})();
