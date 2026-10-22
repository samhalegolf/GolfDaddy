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

  /* Trees: one quad per tree, standing on the ground the terrain shader puts under it.

     The view is an orthographic tilt (the CSS lean), so a tree is drawn the way that camera
     sees it, worked out in "screen" units - pixels across, and pixels up the screen before the
     lean squashes them by cos(tilt). A crown of radius r whose middle stands z above the
     ground shows as a circle of radius r lifted z.sin(tilt) up the screen; a trunk is the
     strip under it. Flat (tilt 0) that collapses to a circle on the ground: the tree seen
     from above, so the same quads serve both views.

     Types follow the watch's sprite sets (gd-watch-map-core.js TREE_TYPES): 0 round,
     1 broadleaf, 2 pine, 3 yellow-green (a round tree in a lighter green). */
  const TREE_VERT = `
    attribute vec4 aTree;              // x, y (image px), crown radius (px), type
    attribute vec2 aCorner;            // -1..1 across, 0..1 bottom to top
    uniform sampler2D uElevation;
    uniform float uExaggeration;
    uniform float uSeaLevel;
    uniform vec2 uShear;
    uniform vec2 uImagePx;
    uniform vec2 uUp;                  // unit, image space: the way that becomes screen-up
    uniform float uSinT;
    uniform float uCosT;
    varying vec2 vLocal;               // screen px from the tree's foot
    varying vec3 vTree;                // radius, type, seed

    float heightAt(vec2 uv) {
      vec3 c = texture2D(uElevation, uv).rgb * 255.0;
      return -10000.0 + (c.r * 65536.0 + c.g * 256.0 + c.b) * 0.1;
    }

    void main() {
      float r = aTree.z;
      float type = aTree.w;
      vec2 uv = aTree.xy / uImagePx;
      float h = (heightAt(uv) - uSeaLevel) * uExaggeration;
      vec2 edge = min(uv, 1.0 - uv);
      h *= smoothstep(0.0, 0.012, min(edge.x, edge.y));
      vec2 foot = aTree.xy + uShear * h;

      /* Tall enough for the tallest shape: a round crown peaks at 2.6r, a pine at 3.6r. */
      float top = (type == 2.0 ? 3.6 * r : 1.6 * r) * uSinT + r * 1.15;
      float x = aCorner.x * r * 1.15;
      float y = mix(-r * 1.05, top, aCorner.y);
      vLocal = vec2(x, y);
      vTree = vec3(r, type, fract(sin(dot(aTree.xy, vec2(12.9898, 78.233))) * 43758.5453));

      vec2 side = vec2(-uUp.y, uUp.x);
      vec2 px = foot + side * x + uUp * (y / uCosT);
      gl_Position = vec4(px.x / uImagePx.x * 2.0 - 1.0, 1.0 - px.y / uImagePx.y * 2.0, 0.0, 1.0);
    }
  `;

  const TREE_FRAG = `
    precision highp float;
    uniform float uSinT;
    uniform float uCosT;
    varying vec2 vLocal;
    varying vec3 vTree;

    /* 0..1 coverage of a signed distance in px: soft edge one pixel wide. */
    float cover(float d) { return clamp(0.5 - d, 0.0, 1.0); }

    void main() {
      float r = vTree.x, type = vTree.y, seed = vTree.z;
      float x = vLocal.x, y = vLocal.y;
      vec3 light = normalize(vec3(-0.5, 0.6, 0.62));   // from the screen's top left
      vec3 colour = vec3(0.0);
      float alpha = 0.0;

      if (type == 2.0) {
        /* Pine: a cone. Base ellipse 0.4r up, apex 3.6r up. */
        float yb = 0.4 * r * uSinT, ya = 3.6 * r * uSinT;
        float ry = max(r * uCosT, 0.001);
        float e = length(vec2(x / r, (y - yb) / ry));
        float a = cover((e - 1.0) * r);
        if (ya - yb > 0.5) {
          float t = clamp((y - yb) / (ya - yb), 0.0, 1.0);
          float halfW = r * (1.0 - t);
          float inside = y >= yb && y <= ya ? cover(abs(x) - halfW) : 0.0;
          a = max(a, inside);
        }
        float lit = 0.62 + 0.38 * clamp(0.5 - x / r * 0.6 + (y - yb) / max(ya - yb, r) * 0.25, 0.0, 1.0);
        colour = vec3(0.17, 0.40, 0.21) * (0.9 + 0.2 * seed) * lit;
        alpha = a;
      } else {
        /* Round, broadleaf and yellow-green: a ball of foliage. Broadleaf is wider and lobed. */
        float wide = type == 1.0 ? 1.1 : 1.0;
        float yc = 1.6 * r * uSinT;
        vec2 d = vec2(x / wide, y - yc) / r;
        float lobes = type == 1.0 ? 1.0 + 0.07 * sin(atan(d.y, d.x) * 6.0 + seed * 6.283) : 1.0 + 0.03 * sin(atan(d.y, d.x) * 9.0 + seed * 6.283);
        float dist = length(d) / lobes;
        float a = cover((dist - 1.0) * r);
        vec3 n = vec3(d.x, d.y, sqrt(max(0.0, 1.0 - min(1.0, dist * dist))));
        float lit = 0.5 + 0.6 * max(dot(normalize(n), light), 0.0);
        vec3 base = type == 3.0 ? vec3(0.45, 0.57, 0.23)
          : type == 1.0 ? vec3(0.26, 0.53, 0.21) : vec3(0.23, 0.49, 0.20);
        colour = base * (0.9 + 0.2 * seed) * lit;
        alpha = a;
        /* Trunk under the crown, seen only once the view leans. */
        if (alpha < 1.0 && yc > 0.5) {
          float trunk = cover(abs(x) - 0.13 * r) * (y >= 0.0 && y <= yc ? 1.0 : 0.0);
          colour = mix(vec3(0.33, 0.24, 0.16), colour, alpha);
          alpha = max(alpha, trunk);
        }
      }
      if (alpha <= 0.0) discard;
      gl_FragColor = vec4(colour, alpha);
    }
  `;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function program(gl, vert, frag) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vert));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
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

  /* Four corners per tree. The index order is the draw order and is rebuilt by sortTrees,
     so only the vertices are made here. */
  function treeQuads(gl, trees) {
    const verts = new Float32Array(trees.length * 4 * 6);
    const corners = [[-1, 0], [1, 0], [1, 1], [-1, 1]];
    let i = 0;
    trees.forEach(function (t) {
      corners.forEach(function (c) {
        verts[i++] = t.x; verts[i++] = t.y; verts[i++] = t.r; verts[i++] = t.type;
        verts[i++] = c[0]; verts[i++] = c[1];
      });
    });
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    return { vb, ib: gl.createBuffer(), count: trees.length * 6, order: null };
  }

  /* Far trees first so near ones paint over them. Far is further along up: the top of the
     screen once the frame is rotated. Pure, for the test. */
  function treeDrawOrder(trees, up) {
    const idx = trees.map(function (t, i) { return i; });
    idx.sort(function (a, b) {
      return (trees[b].x * up[0] + trees[b].y * up[1]) - (trees[a].x * up[0] + trees[a].y * up[1]);
    });
    return idx;
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

  /* The vertex shader's displacement, restated for the overlays.

     Every pixel of the picture moves by uShear * h once the lock tilt is on, but the dot,
     the pin, the bubble and the hazard fills are projected by the flat frame at height zero,
     so in lock they sat on the ground plane while the ground itself had stood up. The bubble
     ring is small and hid it; a bunker or a pond fill spans tens of metres and did not - the
     colour sat a few metres off the sand it was meant to reveal.

     Pure: no GL, no DOM. heightAt(uv) is whatever samples the DEM (create() wires a 2D-canvas
     read of the same terrain-RGB the texture holds; a test hands in a function). Works in
     FRAME pixels (the published outputDimensions), which is the space the projector already
     speaks, so pxPerMetre is framePx / metres rather than the shader's canvas figure - the
     canvas is styled to the frame's size, so the two agree on screen.

     lift(px) is the shader's px + uShear * h. ground(px) is its inverse for taps: the height
     under a screen point depends on where the tap lands on the ground, so it is solved by a
     few fixed-point steps - the field is smooth and the offset is a few metres, so three
     rounds are well inside a pixel. */
  function makeDisplacer(opts) {
    const heightAt = opts.heightAt;
    const framePx = opts.framePx;
    const metres = opts.metres;
    const state = opts.state;
    function edgeFade(u, v) {
      const e = Math.min(u, 1 - u, v, 1 - v);
      const t = Math.min(1, Math.max(0, e / 0.012));
      return t * t * (3 - 2 * t);
    }
    function offsetAt(px) {
      const tilt = Number(state.tiltDeg) || 0;
      if (!(tilt > 0) || !framePx || !metres || !(metres[0] > 0)) return { x: 0, y: 0 };
      const u = px.x / framePx[0], v = px.y / framePx[1];
      if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return { x: 0, y: 0 };
      let h = (heightAt(u, v) - (Number(state.seaLevel) || 0)) * (Number(state.exaggeration) || 0);
      h *= edgeFade(u, v);
      const shear = (framePx[0] / metres[0]) * Math.tan(tilt * Math.PI / 180);
      const rot = -(Number(state.frameRotationDeg) || 0) * Math.PI / 180;
      return { x: Math.sin(rot) * shear * h, y: -Math.cos(rot) * shear * h };
    }
    return {
      offsetAt: offsetAt,
      lift: function (px) {
        if (!px) return px;
        const d = offsetAt(px);
        return { x: px.x + d.x, y: px.y + d.y };
      },
      ground: function (px) {
        if (!px) return px;
        let g = { x: px.x, y: px.y };
        for (let i = 0; i < 8; i++) {
          const d = offsetAt(g);
          const next = { x: px.x - d.x, y: px.y - d.y };
          const step = Math.hypot(next.x - g.x, next.y - g.y);
          g = next;
          if (step < 0.01) break;
        }
        return g;
      }
    };
  }

  /* Terrain-RGB decoded on the CPU from the same image the texture was built from, sampled
     bilinearly the way LINEAR filtering samples it on the GPU - the decode is linear in the
     channels, so interpolating first and decoding after gives the same height. */
  function demSampler(image, demSize) {
    try {
      const w = Number(demSize[0]) || image.naturalWidth, h = Number(demSize[1]) || image.naturalHeight;
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(image, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      function at(x, y) {
        const i = (Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4;
        return -10000 + (data[i] * 65536 + data[i + 1] * 256 + data[i + 2]) * 0.1;
      }
      return function (u, v) {
        const x = u * w - 0.5, y = v * h - 0.5;
        const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
        const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
        const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
        return top * (1 - fy) + bottom * fy;
      };
    } catch (e) {
      /* A tainted canvas (no CORS on the sidecar) cannot be read. The picture still stands
         up; the overlays simply stay on the ground plane as they did before. */
      return null;
    }
  }

  /* No camera maths here on purpose. The frame is solved by play-surface.js's stageFrame and
     written to the element as a CSS matrix, exactly as it is for the flat image; this renderer
     only fills that frame in. A projection of its own would be a second framing rule to keep
     in step with the first. */

  function create(canvas, options) {
    const gl = canvas.getContext("webgl", { antialias: true, alpha: false });
    if (!gl) throw new Error("WebGL unavailable");
    const prog = program(gl, VERT, FRAG);
    const mesh = grid(gl, options.segments || 192);
    /* Trees come with the illustrated map only (gd-illustrated-surface.js placeTrees). A
       16-bit index holds 16383 quads; a frame carries a few thousand at most. */
    const trees = Array.isArray(options.trees) ? options.trees.slice(0, 16383) : [];
    const treeProg = trees.length ? program(gl, TREE_VERT, TREE_FRAG) : null;
    const treeMesh = trees.length ? treeQuads(gl, trees) : null;
    const tu = {};
    if (treeProg) {
      ["aTree", "aCorner"].forEach(name => { tu[name] = gl.getAttribLocation(treeProg, name); });
      ["uElevation", "uExaggeration", "uSeaLevel", "uShear", "uImagePx", "uUp", "uSinT", "uCosT"]
        .forEach(name => { tu[name] = gl.getUniformLocation(treeProg, name); });
    }
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
      gl.disableVertexAttribArray(aGrid);

      if (treeProg) drawTrees(Math.sin(rot) * shearPx, -Math.cos(rot) * shearPx, rot);
      gl.finish();
    }

    function drawTrees(shearX, shearY, rot) {
      const up = [Math.sin(rot), -Math.cos(rot)];
      const key = up[0].toFixed(4) + "," + up[1].toFixed(4);
      if (treeMesh.order !== key) {
        const idx = new Uint16Array(trees.length * 6);
        treeDrawOrder(trees, up).forEach(function (n, i) {
          const v = n * 4;
          idx.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
        });
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, treeMesh.ib);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.DYNAMIC_DRAW);
        treeMesh.order = key;
      }
      const tilt = state.tiltDeg * Math.PI / 180;
      gl.useProgram(treeProg);
      gl.uniform2f(tu.uShear, shearX, shearY);
      gl.uniform2f(tu.uImagePx, state.imagePx[0], state.imagePx[1]);
      gl.uniform1f(tu.uExaggeration, state.exaggeration);
      gl.uniform1f(tu.uSeaLevel, state.seaLevel);
      gl.uniform2f(tu.uUp, up[0], up[1]);
      gl.uniform1f(tu.uSinT, Math.sin(tilt));
      gl.uniform1f(tu.uCosT, Math.cos(tilt));
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, elevation); gl.uniform1i(tu.uElevation, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, treeMesh.vb);
      gl.enableVertexAttribArray(tu.aTree);
      gl.vertexAttribPointer(tu.aTree, 4, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(tu.aCorner);
      gl.vertexAttribPointer(tu.aCorner, 2, gl.FLOAT, false, 24, 16);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, treeMesh.ib);
      /* Painted over the ground in draw order, not depth tested: the ground's depth is its
         height, which says nothing about which of two trees is nearer. */
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawElements(gl.TRIANGLES, treeMesh.count, gl.UNSIGNED_SHORT, 0);
      gl.disable(gl.BLEND);
      gl.enable(gl.DEPTH_TEST);
      gl.disableVertexAttribArray(tu.aTree);
      gl.disableVertexAttribArray(tu.aCorner);
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
        if (treeMesh) { gl.deleteBuffer(treeMesh.vb); gl.deleteBuffer(treeMesh.ib); }
        if (treeProg) gl.deleteProgram(treeProg);
        var lose = gl.getExtension("WEBGL_lose_context");
        if (lose) lose.loseContext();
      } catch (e) { /* already gone */ }
    }

    /* framePx is the published frame's outputDimensions - the projector's space. Without it
       (or without a readable DEM) lift/ground are the identity and nothing changes. */
    const sampler = options.framePx ? demSampler(options.elevation, state.demSize) : null;
    const displacer = sampler ? makeDisplacer({ heightAt: sampler, framePx: options.framePx, metres: state.metres, state: state })
      : { lift: function (px) { return px; }, ground: function (px) { return px; }, offsetAt: function () { return { x: 0, y: 0 }; } };

    return { gl, state, render, dispose, lift: displacer.lift, ground: displacer.ground, offsetAt: displacer.offsetAt };
  }

  /* Cheap enough to call before committing to the mesh path, and the answer is the whole
     decision: no WebGL means the flat frame stays up, which is a complete picture already. */
  function supported() {
    try {
      var probe = document.createElement("canvas");
      return !!(probe.getContext("webgl") || probe.getContext("experimental-webgl"));
    } catch (e) { return false; }
  }

  root.GDTerrainMesh = { create: create, supported: supported, makeDisplacer: makeDisplacer, treeDrawOrder: treeDrawOrder };
})(typeof window !== "undefined" ? window : this);
