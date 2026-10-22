/* Illustrated map - the hole drawn from the course map instead of photographed.

   The terrain mesh (gd-terrain-mesh.js) stands the hole up from the DEM and drapes a picture
   over it. Normally that picture is the aerial photo. This paints a replacement from the
   shapes the course already carries - fairways, greens, bunkers, water, tree clusters, tees -
   in flat cartoon colours with mown stripes, so the mesh's own light does all the shading and
   the hills read as hills.

   Trees are not painted: placeTrees says where they stand and gd-terrain-mesh.js stands
   them up. The picture carries only the woodland floor and each tree's shadow.

   Only the picture changes. It is painted at the frame's own aspect and in the frame's own
   pixel space (the published surface's mercator origin and zoom), so the mesh's UVs, the
   projector, the overlay lift and tap grounding all stay exactly as they are for the photo.

   What it cannot do is invent what was never mapped: ground with no shape on it is rough.
   That is the trade the player chooses in Settings; the photo is always one tap away.

   Pure apart from the 2D context it is handed: no DOM lookups, no fetches. Everything it
   needs comes in through paint()'s input, which is what dev/illustrated-surface.test.js
   drives with a recording context. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.GDIllustratedSurface = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  var PALETTE = {
    rough: "#4f8b3b",
    roughShade: "#457d33",
    firstCut: "#5f9d43",
    fairway: "#78bc4c",
    fairwayStripe: "#86c858",
    fringe: "#6db04a",
    green: "#8fd264",
    greenStripe: "#98d96d",
    tee: "#82c455",
    sand: "#efe0b4",
    sandLip: "#d2bc85",
    water: "#3d86c6",
    waterShore: "#82b8e2",
    treeFloor: "#3a7432",
    treeShadow: "#1f4a1b"
  };

  /* Sizes in metres, turned into pixels by the frame's own scale. */
  var STRIPE_M = 9;
  var GREEN_STRIPE_M = 4;
  var FIRST_CUT_M = 2.2;
  var FRINGE_M = 1.4;
  var BUNKER_LIP_M = 0.9;
  var SHORE_M = 1.2;
  var TEE_M = [9, 14];
  /* The watch caps a hole at 1500 trees; a frame here can hold neighbouring holes too. */
  var MAX_TREES = 3000;

  /* Same seed, same picture: the map must not shimmer between visits to a hole. */
  function seeded(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function projectRing(ring, project) {
    var out = [];
    for (var i = 0; i < (ring || []).length; i++) {
      var p = project(ring[i]);
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) out.push(p);
    }
    return out.length >= 3 ? out : null;
  }

  function bounds(pts) {
    var b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    pts.forEach(function (p) {
      if (p.x < b.minX) b.minX = p.x;
      if (p.y < b.minY) b.minY = p.y;
      if (p.x > b.maxX) b.maxX = p.x;
      if (p.y > b.maxY) b.maxY = p.y;
    });
    return b;
  }

  function onCanvas(b, w, h, pad) {
    return b.maxX >= -pad && b.maxY >= -pad && b.minX <= w + pad && b.minY <= h + pad;
  }

  function trace(ctx, ring) {
    ctx.beginPath();
    ctx.moveTo(ring[0].x, ring[0].y);
    for (var i = 1; i < ring.length; i++) ctx.lineTo(ring[i].x, ring[i].y);
    ctx.closePath();
  }

  /* Bands across the line of play, alternating two shades, clipped to the shape. */
  function stripes(ctx, ring, b, angle, bandPx, light, dark) {
    var cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    var reach = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2 + bandPx;
    ctx.save();
    trace(ctx, ring);
    ctx.clip();
    ctx.fillStyle = light;
    ctx.fill();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.fillStyle = dark;
    var n = Math.ceil(reach / bandPx);
    for (var i = -n; i < n; i += 2) ctx.fillRect(i * bandPx, -reach, bandPx, reach * 2);
    ctx.restore();
  }

  /* An edge drawn only on the inside of a shape: clip to it, stroke double width. */
  function innerEdge(ctx, ring, widthPx, colour) {
    ctx.save();
    trace(ctx, ring);
    ctx.clip();
    ctx.strokeStyle = colour;
    ctx.lineWidth = widthPx * 2;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.restore();
  }

  function outerBand(ctx, ring, widthPx, colour) {
    trace(ctx, ring);
    ctx.strokeStyle = colour;
    ctx.lineWidth = widthPx * 2;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.fillStyle = colour;
    ctx.fill();
  }

  /* Direction of play per hole, in canvas radians: tee toward the first route point past it,
     or the green. A fairway with no hole (or a hole with no tee) stripes left to right. */
  function playAngles(holes, project) {
    var out = {};
    (holes || []).forEach(function (h) {
      if (!h || !h.tee) return;
      var toward = (h.route && h.route.length > 1 ? h.route[1] : null) || h.green;
      var a = project(h.tee), b = toward ? project(toward) : null;
      if (!a || !b || (a.x === b.x && a.y === b.y)) return;
      out[h.holeNumber] = Math.atan2(b.y - a.y, b.x - a.x);
    });
    return out;
  }

  /* Under each standing tree (gd-terrain-mesh.js draws the trees themselves) a soft shadow
     falling to the bottom right, away from the light the crowns are shaded by. */
  function treeShadows(ctx, trees) {
    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = PALETTE.treeShadow;
    ctx.beginPath();
    trees.forEach(function (t) {
      var x = t.x + t.r * 0.45, y = t.y + t.r * 0.35;
      ctx.moveTo(x + t.r, y);
      ctx.arc(x, y, t.r, 0, Math.PI * 2);
    });
    ctx.fill();
    ctx.restore();
  }

  function teePad(ctx, centre, angle, ppm) {
    var w = TEE_M[0] * ppm, l = TEE_M[1] * ppm, r = Math.min(w, l) * 0.25;
    ctx.save();
    ctx.translate(centre.x, centre.y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(-l / 2 + r, -w / 2);
    ctx.lineTo(l / 2 - r, -w / 2);
    ctx.arcTo(l / 2, -w / 2, l / 2, -w / 2 + r, r);
    ctx.lineTo(l / 2, w / 2 - r);
    ctx.arcTo(l / 2, w / 2, l / 2 - r, w / 2, r);
    ctx.lineTo(-l / 2 + r, w / 2);
    ctx.arcTo(-l / 2, w / 2, -l / 2, w / 2 - r, r);
    ctx.lineTo(-l / 2, -w / 2 + r);
    ctx.arcTo(-l / 2, -w / 2, -l / 2 + r, -w / 2, r);
    ctx.closePath();
    ctx.strokeStyle = PALETTE.firstCut;
    ctx.lineWidth = FIRST_CUT_M * ppm;
    ctx.stroke();
    ctx.fillStyle = PALETTE.tee;
    ctx.fill();
    ctx.restore();
  }

  /* Does this hole have enough on the map to be worth drawing? A green or a fairway of its
     own; without either the picture would be a field of rough with the bubble on it. */
  function holeIsMapped(surfaces, holeNumber) {
    if (!surfaces) return false;
    var n = Number(holeNumber);
    function mine(list) { return (list || []).some(function (s) { return s && Number(s.holeNumber) === n; }); }
    return mine(surfaces.greens) || mine(surfaces.fairways);
  }

  /* input: {
       width, height       canvas pixels
       pxPerMetre          ground scale on this canvas
       project(pt)         {lat,lng} -> {x,y} canvas pixels, unclamped (off-canvas is fine)
       surfaces            GDBubbleHazardCore.collectSurfaces output, whole course
       holes               [{holeNumber, tee, green, route}] lat/lng
       seed                any integer, so a hole paints the same every time
       trees               placeTrees output, for their shadows
     }
     Returns the number of shapes drawn - zero means nothing on this frame was mapped. */
  function paint(ctx, input) {
    var w = input.width, h = input.height, ppm = input.pxPerMetre;
    var project = input.project, s = input.surfaces || {};
    var rand = seeded(input.seed || 1);
    var pad = 40 * ppm;

    function rings(list) {
      var out = [];
      (list || []).forEach(function (surface) {
        var ring = projectRing(surface && surface.ring, project);
        if (!ring) return;
        var b = bounds(ring);
        if (onCanvas(b, w, h, pad)) out.push({ ring: ring, b: b, holeNumber: surface.holeNumber });
      });
      return out;
    }
    var fairways = rings(s.fairways), greens = rings(s.greens), bunkers = rings(s.bunkers);
    var water = rings(s.water), woods = rings(s.trees);
    var angles = playAngles(input.holes, project);

    /* Rough, with a few broad soft patches so it is not a dead flat colour. */
    ctx.fillStyle = PALETTE.rough;
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = PALETTE.roughShade;
    var patches = Math.min(400, Math.round((w * h) / Math.pow(30 * ppm, 2) * 0.4));
    ctx.beginPath();
    for (var i = 0; i < patches; i++) {
      var x = rand() * w, y = rand() * h, r = (10 + rand() * 25) * ppm;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.restore();

    /* Back to front: what sits on top of what on a real course. */
    woods.forEach(function (t) {
      ctx.fillStyle = PALETTE.treeFloor;
      trace(ctx, t.ring);
      ctx.fill();
    });
    treeShadows(ctx, input.trees || []);
    fairways.forEach(function (f) { outerBand(ctx, f.ring, FIRST_CUT_M * ppm, PALETTE.firstCut); });
    fairways.forEach(function (f) {
      var angle = angles[f.holeNumber] || 0;
      stripes(ctx, f.ring, f.b, angle, STRIPE_M * ppm, PALETTE.fairway, PALETTE.fairwayStripe);
    });
    (input.holes || []).forEach(function (hole) {
      var at = hole && hole.tee ? project(hole.tee) : null;
      if (at && onCanvas({ minX: at.x, maxX: at.x, minY: at.y, maxY: at.y }, w, h, pad)) {
        teePad(ctx, at, angles[hole.holeNumber] || 0, ppm);
      }
    });
    water.forEach(function (p) {
      ctx.fillStyle = PALETTE.water;
      trace(ctx, p.ring);
      ctx.fill();
      innerEdge(ctx, p.ring, SHORE_M * ppm, PALETTE.waterShore);
    });
    greens.forEach(function (g) { outerBand(ctx, g.ring, FRINGE_M * ppm, PALETTE.fringe); });
    greens.forEach(function (g) {
      stripes(ctx, g.ring, g.b, (angles[g.holeNumber] || 0) + Math.PI / 4, GREEN_STRIPE_M * ppm, PALETTE.green, PALETTE.greenStripe);
    });
    bunkers.forEach(function (k) {
      outerBand(ctx, k.ring, BUNKER_LIP_M * ppm, PALETTE.firstCut);
      ctx.fillStyle = PALETTE.sand;
      trace(ctx, k.ring);
      ctx.fill();
      innerEdge(ctx, k.ring, BUNKER_LIP_M * ppm, PALETTE.sandLip);
    });

    return fairways.length + greens.length + bunkers.length + water.length + woods.length;
  }

  /* Where the trees stand, in canvas pixels: [{x, y, r, type}], r the crown radius in px and
     type the watch's (0 round, 1 broadleaf, 2 pine, 3 yellow-green).

     The watch's own placement (gd-watch-map-core.js buildHoleTrees) - ragged edges, mixed
     sizes, kept off played ground, seeded from each area's outline - so a wood looks the same
     on the phone as on the wrist. spatialRef is that function's: {transform, refZoom,
     metresPerPixel, imageWidth, imageHeight}, mapping world-mercator pixels at refZoom onto
     this canvas. Greens join the fairways as played ground; a hole's own green is all the
     watch knows, a frame here shows the neighbours' too. */
  function placeTrees(core, surfaces, spatialRef) {
    if (!core || !core.buildHoleTrees || !surfaces || !(surfaces.trees || []).length) return [];
    var rings = function (list) { return (list || []).map(function (s) { return s.ring; }); };
    var geometry = {
      fairways: rings(surfaces.fairways).concat(rings(surfaces.greens)),
      bunkers: rings(surfaces.bunkers),
      water: rings(surfaces.water),
      trees: rings(surfaces.trees)
    };
    var base = core.WATCH_MAP_RECIPE_V1;
    var recipe = Object.assign({}, base, { trees: Object.assign({}, base.trees, { maxTrees: MAX_TREES }) });
    return core.buildHoleTrees(recipe, spatialRef, geometry).c.map(core.unpackTree);
  }

  /* The package's holes as paint() wants them: lite packages carry tee/green/route on the
     hole, full ones under hole.geometry. */
  function packageHoles(pkg) {
    var holes = pkg && Array.isArray(pkg.holes) ? pkg.holes : [];
    function pt(v) {
      var lat = Number(v && v.lat), lng = Number(v && v.lng);
      return Number.isFinite(lat) && Number.isFinite(lng) ? { lat: lat, lng: lng } : null;
    }
    return holes.map(function (hole) {
      var g = (hole && (hole.geometry || hole)) || {};
      return {
        holeNumber: hole && hole.holeNumber,
        tee: pt(g.tee),
        green: pt(g.green),
        route: (Array.isArray(g.route) ? g.route : []).map(pt).filter(Boolean)
      };
    });
  }

  return { paint: paint, placeTrees: placeTrees, packageHoles: packageHoles, holeIsMapped: holeIsMapped, PALETTE: PALETTE };
});
