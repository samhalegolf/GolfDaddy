/* Terrain mesh renderer - the hole as geometry rather than a picture of geometry.

   Vanilla WebGL on purpose. painter.js has no build step and no framework; adding three.js
   (600KB) to draw one displaced grid would be a bigger change to how this app is built than
   the feature itself. What follows is about 200 lines and does exactly one thing.

   The idea is small: a flat grid of vertices covering the hole, each pushed up by the height
   the DEM records at that point, textured with the aerial photograph. Because the relief is
   geometry rather than paint, a mound has an edge that hides what is behind it, the green
   pad stands off the ground it sits on, and the light is recomputed every frame instead of
   being fixed at bake time. A flat frame can do none of those, however well it is shaded.

   Elevation arrives as terrain-RGB, the same bytes the tile server sends, decoded in the
   vertex shader. No CPU-side decode, no second format to keep in sync with the bake.

   What it deliberately does NOT do is own a camera. The published surface is already framed
   by stageFrame's 2D similarity and tilted by CSS, and that framing is correct - ground at
   elevation zero belongs exactly where it lands today. So height is applied as an offset
   INSIDE the frame rather than by moving a viewpoint: d = h . pxPerMetre . tan(tilt), which
   after the tilt compresses it by cos(tilt) lands where a true vertical would. The surface
   gains relief and the projector, the tap maths and the framing rule all stay untouched.

   The cost of that choice is honest: no parallax from the player moving, because the camera
   never moves. What you get is the hole standing up inside its own frame. */

(function (root) {
  "use strict";

  const VERT = `
    attribute vec2 aGrid;              // 0..1 across the frame
    uniform sampler2D uElevation;
    uniform float uExaggeration;
    uniform float uSeaLevel;           // lowest height in the patch, so the model sits at 0
    uniform vec2 uShear;               // image-space pixels per metre of height
    uniform vec2 uImagePx;             // frame size in image pixels
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
      /* Drop the outermost ring back to the ground plane. Displacing the patch edge lifts it
         off the frame and opens a gap onto the background - a hard bright seam along the top
         of the hole. Tucking the border down hides it behind the terrain instead. */
      vec2 edge = min(aGrid, 1.0 - aGrid);
      h *= smoothstep(0.0, 0.012, min(edge.x, edge.y));
      vHeight = h;
      /* The frame stays exactly the frame the 2D solver produced. Ground at elevation zero
         lands on the pixel it lands on today; only height moves anything, and it moves it
         WITHIN the image, along the direction that becomes screen-up once the existing CSS
         matrix has rotated the surface. So the published transform, the projector and the
         tap maths all keep working untouched - the picture gains relief without the camera
         gaining a single degree of freedom. */
      vec2 px = aGrid * uImagePx + uShear * h;
      vec2 clip = vec2(px.x / uImagePx.x * 2.0 - 1.0, 1.0 - px.y / uImagePx.y * 2.0);
      /* Depth from height so a mound occludes what is behind it. */
      gl_Position = vec4(clip, -h * 0.0004, 1.0);
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

  /* No camera maths here on purpose. The frame is solved by play-surface.js's stageFrame and
     written to the element as a CSS matrix, exactly as it is for the flat image; this renderer
     only fills that frame in. A projection of its own would be a second framing rule to keep
     in step with the first. */

  function create(canvas, options) {
    const gl = canvas.getContext("webgl", { antialias: true, alpha: false });
    if (!gl) throw new Error("WebGL unavailable");
    const prog = program(gl);
    const mesh = grid(gl, options.segments || 192);
    const aGrid = gl.getAttribLocation(prog, "aGrid");
    const u = {};
    ["uElevation", "uAerial", "uExaggeration", "uSeaLevel", "uShear", "uImagePx", "uTexel", "uMetresPerTexel", "uLight", "uAmbient"]
      .forEach(name => { u[name] = gl.getUniformLocation(prog, name); });

    const elevation = texture(gl, options.elevation);
    const aerial = texture(gl, options.aerial, true);
    if (mesh.type === gl.UNSIGNED_INT) gl.getExtension("OES_element_index_uint");
    gl.enable(gl.DEPTH_TEST);

    const state = {
      /* Everything the frame already knows. tiltDeg and frameRotationDeg come straight from
         the CSS custom property and the solved matrix - this renderer never decides them. */
      tiltDeg: 32, frameRotationDeg: 0,
      exaggeration: 2.5, ambient: 0.55,
      metres: options.metres || [300, 300],
      demSize: options.demSize || [1024, 1024],
      imagePx: options.imagePx || [1024, 1024],
      seaLevel: options.seaLevel || 0,
      light: [-0.6, 0.75, -0.35]
    };

    function render() {
      const w = canvas.width, h = canvas.height;
      gl.viewport(0, 0, w, h);
      gl.clearColor(0.055, 0.075, 0.06, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(prog);

      /* d = h . pxPerMetre . tan(tilt): the in-image offset that, after the CSS tilt has
         compressed it by cos(tilt), lands where a real vertical of that height would.
         Directed along image-space "up after rotation", so it survives the frame's own
         rotation without the renderer knowing anything about the framing rule. */
      const pxPerMetre = state.imagePx[0] / state.metres[0];
      const shearPx = pxPerMetre * Math.tan(state.tiltDeg * Math.PI / 180);
      const rot = -state.frameRotationDeg * Math.PI / 180;
      gl.uniform2f(u.uShear, Math.sin(rot) * shearPx, -Math.cos(rot) * shearPx);
      gl.uniform2f(u.uImagePx, state.imagePx[0], state.imagePx[1]);
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

    function dispose() {
      /* GPU memory is not garbage collected on a timescale that matters here: a round walks
         eighteen holes, and a context per hole is how a phone reaches CONTEXT_LOST somewhere
         around the twelfth with nothing in the log to say why. */
      try {
        gl.deleteTexture(elevation);
        gl.deleteTexture(aerial);
        gl.deleteBuffer(mesh.vb);
        gl.deleteBuffer(mesh.ib);
        gl.deleteProgram(prog);
        var lose = gl.getExtension("WEBGL_lose_context");
        if (lose) lose.loseContext();
      } catch (e) { /* already gone */ }
    }

    return { gl, state, render, dispose };
  }

  /* Cheap enough to call before committing to the mesh path, and the answer is the whole
     decision: no WebGL means the flat frame stays up, which is a complete picture already. */
  function supported() {
    try {
      var probe = document.createElement("canvas");
      return !!(probe.getContext("webgl") || probe.getContext("experimental-webgl"));
    } catch (e) { return false; }
  }

  root.GDTerrainMesh = { create: create, supported: supported };
})(typeof window !== "undefined" ? window : this);
