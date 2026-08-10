/* Terrain mesh renderer - the hole as geometry rather than a picture of geometry.

   Vanilla WebGL on purpose. painter.js has no build step and no framework; adding three.js
   (600KB) to draw one displaced grid would be a bigger change to how this app is built than
   the feature itself. What follows is about 200 lines and does exactly one thing.

   The idea is small: a flat grid of vertices covering the hole, each pushed up by the height
   the DEM records at that point, textured with the aerial photograph. Because the relief is
   now geometry, the camera can move through it - near ground slides past far ground, a mound
   hides what is behind it, and the light is recomputed every frame instead of painted on at
   bake time. That last part is what the flat frame can never do.

   Elevation arrives as terrain-RGB, the same bytes the tile server sends, decoded in the
   vertex shader. No CPU-side decode, no second format to keep in sync with the bake. */

(function (root) {
  "use strict";

  const VERT = `
    attribute vec2 aGrid;              // 0..1 across the hole
    uniform sampler2D uElevation;
    uniform mat4 uViewProj;
    uniform vec2 uMetres;              // ground size of the patch, metres
    uniform float uExaggeration;
    uniform float uSeaLevel;           // lowest height in the patch, so the model sits at 0
    varying vec2 vUv;
    varying float vHeight;

    /* Mapbox terrain-RGB. The 0.1m quantisation is invisible here because the mesh is
       smoothed by its own interpolation between vertices. */
    float heightAt(vec2 uv) {
      vec3 c = texture2D(uElevation, uv).rgb * 255.0;
      return -10000.0 + (c.r * 65536.0 + c.g * 256.0 + c.b) * 0.1;
    }

    void main() {
      vUv = aGrid;
      float h = (heightAt(aGrid) - uSeaLevel) * uExaggeration;
      vHeight = h;
      /* Centre the patch on the origin so rotation happens about the middle of the hole
         rather than its corner. */
      vec3 pos = vec3((aGrid.x - 0.5) * uMetres.x, h, (aGrid.y - 0.5) * uMetres.y);
      gl_Position = uViewProj * vec4(pos, 1.0);
    }
  `;

  const FRAG = `
    precision highp float;
    uniform sampler2D uAerial;
    uniform sampler2D uElevation;
    uniform vec2 uTexel;               // one elevation texel, in uv
    uniform vec2 uMetresPerTexel;
    uniform float uExaggeration;
    uniform vec3 uLight;               // direction TOWARD the light, world space
    uniform float uAmbient;
    varying vec2 vUv;
    varying float vHeight;

    float heightAt(vec2 uv) {
      vec3 c = texture2D(uElevation, uv).rgb * 255.0;
      return -10000.0 + (c.r * 65536.0 + c.g * 256.0 + c.b) * 0.1;
    }

    void main() {
      /* Normals per fragment rather than per vertex: the mesh is coarser than the DEM, so
         sampling the heightfield here keeps detail the geometry alone would lose. */
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
      vec3 base = texture2D(uAerial, vUv).rgb;
      gl_FragColor = vec4(base * lit, 1.0);
    }
  `;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function program(gl) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  /* A grid of (segments+1)^2 vertices as one triangle strip per row. 192 is where added
     detail stops being visible on a phone - the per-fragment normals carry the fine relief,
     so the mesh only has to carry the silhouette. */
  function grid(gl, segments) {
    const n = segments + 1;
    const verts = new Float32Array(n * n * 2);
    for (let y = 0, i = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        verts[i++] = x / segments;
        verts[i++] = y / segments;
      }
    }
    const idx = [];
    for (let y = 0; y < segments; y++) {
      if (y > 0) idx.push(y * n);                       // degenerate, stitches the rows
      for (let x = 0; x < n; x++) {
        idx.push(y * n + x, (y + 1) * n + x);
      }
      if (y < segments - 1) idx.push((y + 1) * n + (n - 1));
    }
    const Index = n * n > 65535 ? Uint32Array : Uint16Array;
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Index(idx), gl.STATIC_DRAW);
    return { vb, ib, count: idx.length, type: Index === Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT };
  }

  function texture(gl, image, linear) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    /* Elevation must be sampled NEAREST-free but never mipmapped: a mipmapped terrain-RGB
       texture averages the R channel across a 6553.6m step and invents cliffs. */
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  /* ---- minimal 4x4 maths (column-major, as GL wants) ---- */
  function perspective(fovY, aspect, near, far) {
    const f = 1 / Math.tan(fovY / 2);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0];
  }
  function multiply(a, b) {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  }
  /* Camera orbiting the centre of the hole: pitch 0 is straight down, 90 is on the deck. */
  function view(pitchDeg, yawDeg, distance, height) {
    const p = pitchDeg * Math.PI / 180, y = yawDeg * Math.PI / 180;
    const ex = Math.sin(p) * Math.sin(y) * distance;
    const ez = Math.sin(p) * Math.cos(y) * distance;
    const ey = Math.cos(p) * distance + height;
    return lookAt([ex, ey, ez], [0, height * 0.15, 0], [0, 1, 0]);
  }
  function lookAt(eye, at, up) {
    const z = norm([eye[0] - at[0], eye[1] - at[1], eye[2] - at[2]]);
    const x = norm(cross(up, z));
    const y = cross(z, x);
    return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
      -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]),
      -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]),
      -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]), 1];
  }
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

  function create(canvas, options) {
    const gl = canvas.getContext("webgl", { antialias: true, alpha: false });
    if (!gl) throw new Error("WebGL unavailable");
    const prog = program(gl);
    const mesh = grid(gl, options.segments || 192);
    const aGrid = gl.getAttribLocation(prog, "aGrid");
    const u = {};
    ["uElevation", "uAerial", "uViewProj", "uMetres", "uExaggeration", "uSeaLevel", "uTexel", "uMetresPerTexel", "uLight", "uAmbient"]
      .forEach(name => { u[name] = gl.getUniformLocation(prog, name); });

    const elevation = texture(gl, options.elevation);
    const aerial = texture(gl, options.aerial, true);
    if (mesh.type === gl.UNSIGNED_INT) gl.getExtension("OES_element_index_uint");
    gl.enable(gl.DEPTH_TEST);

    const state = {
      pitch: 58, yaw: 0, exaggeration: 2.5, ambient: 0.55,
      metres: options.metres || [300, 300],
      demSize: options.demSize || [1024, 1024],
      seaLevel: options.seaLevel || 0,
      distance: (options.metres ? options.metres[1] : 300) * 1.15,
      light: [-0.6, 0.75, -0.35]
    };

    function render() {
      const w = canvas.width, h = canvas.height;
      gl.viewport(0, 0, w, h);
      gl.clearColor(0.055, 0.075, 0.06, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(prog);

      const proj = perspective(45 * Math.PI / 180, w / h, 1, state.distance * 6);
      const vp = multiply(proj, view(state.pitch, state.yaw, state.distance, 0));

      gl.uniformMatrix4fv(u.uViewProj, false, new Float32Array(vp));
      gl.uniform2f(u.uMetres, state.metres[0], state.metres[1]);
      gl.uniform1f(u.uExaggeration, state.exaggeration);
      gl.uniform1f(u.uSeaLevel, state.seaLevel);
      gl.uniform2f(u.uTexel, 1 / state.demSize[0], 1 / state.demSize[1]);
      gl.uniform2f(u.uMetresPerTexel, state.metres[0] / state.demSize[0], state.metres[1] / state.demSize[1]);
      gl.uniform3fv(u.uLight, new Float32Array(state.light));
      gl.uniform1f(u.uAmbient, state.ambient);

      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, elevation); gl.uniform1i(u.uElevation, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, aerial); gl.uniform1i(u.uAerial, 1);

      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vb);
      gl.enableVertexAttribArray(aGrid);
      gl.vertexAttribPointer(aGrid, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ib);
      gl.drawElements(gl.TRIANGLE_STRIP, mesh.count, mesh.type, 0);
      gl.finish();
    }

    return { gl, state, render };
  }

  root.GDTerrainMesh = { create };
})(typeof window !== "undefined" ? window : this);
