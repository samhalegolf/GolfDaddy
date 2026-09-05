/* Which holes a marketing snapshot should be taken on, and where to stand for the approach.
   Pure arithmetic over a course package - no DOM, no fetch, no clock. Loaded two ways, same
   policy as scripts/gd-progress-core.js:
     - browser, via <script data-gd-surface="studio"> in index.html, as window.GDMarketingSnapshotCore
     - node, via require() from marketing/run-snapshots.mjs and dev/marketing-snapshot-core.test.js

   WHY IT IS PURE. The Studio page proposes holes so an operator can see and override the
   choice before a run; the runner has to arrive at the SAME holes hours later without the
   Studio open. Two callers, one answer, so the choosing cannot live in either of them.

   WHAT A SCORE MEANS HERE. Nothing about how good a hole is to play. These scores answer one
   narrow question - "will this hole put something other than green grass in the frame" - and
   they answer it only from geometry the package already carries. A hole with three bunkers, a
   pond and a dogleg photographs better than a straight corridor, and that is the whole claim.
   Signature-hole evidence from the web (functions/marketing-hole-intel.mjs) outranks it when
   it exists, because a club naming its own famous hole is better evidence than a bunker count.
   Absent intel is the ordinary case, not a failure - see pickHoles' `reason` on every result,
   which says which of the two decided.

   TWO DIFFERENT QUESTIONS. The tee-shot snapshot wants variety along the CORRIDOR (that is
   what a driver frame shows); the approach snapshot wants variety around the GREEN (that is
   what a 130m frame shows). A hole can be strong at one and dull at the other, so they are
   scored separately and picked separately. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.ClarityApp = root.ClarityApp || {}; root.ClarityApp.marketingSnapshotCore = api; root.GDMarketingSnapshotCore = api; }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  var EARTH_M = 6371000;
  var RAD = Math.PI / 180;

  /* Deliberately local rather than imported from app/js/distance.js: this module is loaded by
     the Studio surface and by a node runner, and app/ is the phone app's tree. Three short
     formulas duplicated is a smaller cost than a load-order dependency between two trees that
     otherwise never touch. marshal.js made the same call for the same reason. */
  function metresBetween(a, b) {
    if (!a || !b) return null;
    var dLat = (b.lat - a.lat) * RAD;
    var dLng = (b.lng - a.lng) * RAD;
    var lat1 = a.lat * RAD, lat2 = b.lat * RAD;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function bearing(from, to) {
    if (!from || !to) return null;
    var lat1 = from.lat * RAD, lat2 = to.lat * RAD;
    var dLng = (to.lng - from.lng) * RAD;
    var y = Math.sin(dLng) * Math.cos(lat2);
    var x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return Math.atan2(y, x);
  }

  function destination(from, bearingRad, distanceM) {
    if (!from || !Number.isFinite(bearingRad) || !Number.isFinite(distanceM)) return null;
    var d = distanceM / EARTH_M;
    var lat1 = from.lat * RAD, lng1 = from.lng * RAD;
    var lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(bearingRad));
    var lng2 = lng1 + Math.atan2(
      Math.sin(bearingRad) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );
    return { lat: lat2 / RAD, lng: ((lng2 / RAD + 540) % 360) - 180 };
  }

  function pt(value) {
    if (!value) return null;
    var lat = Number(value.lat), lng = Number(value.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat: lat, lng: lng } : null;
  }

  /* ------------------------------------------------------------------ package reading */

  /* Both package shapes, the same way marshal.js's holeRecord reads them: lite holes are flat,
     full holes carry {geometry, visual}. Anything without a green is dropped - a hole with no
     green cannot be framed, cannot be stood 130m from, and cannot be scored. */
  function holeRecords(pkg) {
    var holes = pkg && Array.isArray(pkg.holes) ? pkg.holes : [];
    return holes.map(function (h) {
      var geometry = (h && h.geometry) || h || {};
      var green = pt(geometry.green);
      if (!green) return null;
      var parRaw = h && h.par != null ? h.par : geometry.par;
      var par = Number(parRaw);
      return {
        holeNumber: Number(h && h.holeNumber),
        par: Number.isFinite(par) ? par : null,
        tee: pt(geometry.tee),
        green: green,
        greenShape: (Array.isArray(geometry.greenShape) ? geometry.greenShape : []).map(pt).filter(Boolean),
        route: (Array.isArray(geometry.route) ? geometry.route : []).map(pt).filter(Boolean),
        surfaces: geometry.surfaces || null,
        hasVisual: !!(h && h.visual && h.visual.playSurface)
      };
    }).filter(function (r) { return r && Number.isFinite(r.holeNumber); });
  }

  function surfaceCentres(group) {
    return (Array.isArray(group) ? group : []).map(function (item) {
      var centre = pt(item && (item.centre || item.center));
      if (centre) return centre;
      /* An OSM ring with no centre still has a shape; its first vertex is close enough for a
         "is this near the green" question and keeps a thinly-tagged course scoreable. */
      var shape = Array.isArray(item && item.shape) ? item.shape : [];
      return pt(shape[0]);
    }).filter(Boolean);
  }

  /* ------------------------------------------------------------------ scoring */

  /* The corridor is the line a tee shot is framed along: tee, route points, green. Surfaces
     count toward the tee-shot score when they sit within CORRIDOR_M of any of those points. */
  var CORRIDOR_M = 70;
  /* The green area is what a 130m approach frame shows. Wider than the green itself so a
     greenside bunker complex or a fronting pond counts. */
  var GREEN_AREA_M = 65;

  /* Point to POLYLINE, not point to vertices. A straight hole's corridor has exactly two
     vertices - the tee and the green - so measuring to vertices alone put the entire middle of
     the fairway out of range, and every bunker where a drive actually finishes scored zero on
     a hole with no route points. Flattening to local metres is safe at hole scale: the error
     of treating one hole as a plane is millimetres. */
  function localPlane(origin) {
    var mPerDegLat = 111320;
    var mPerDegLng = 111320 * Math.cos(origin.lat * RAD);
    return function (p) {
      return { x: (p.lng - origin.lng) * mPerDegLng, y: (p.lat - origin.lat) * mPerDegLat };
    };
  }

  function distanceToSegment(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    var t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function nearAny(point, line, withinM) {
    if (!point || !line.length) return false;
    if (line.length === 1) return metresBetween(point, line[0]) <= withinM;
    var toPlane = localPlane(line[0]);
    var p = toPlane(point);
    var flat = line.map(toPlane);
    for (var i = 0; i < flat.length - 1; i += 1) {
      if (distanceToSegment(p, flat[i], flat[i + 1]) <= withinM) return true;
    }
    return false;
  }

  /* How far off a straight tee-green line the route bends, as a fraction of hole length. Zero
     for a hole with no route points. A dogleg is the single most photogenic thing a corridor
     can do, which is why it is scored separately from the surface counts. */
  function doglegFraction(rec) {
    if (!rec.tee || !rec.route.length) return 0;
    var straight = metresBetween(rec.tee, rec.green);
    if (!straight) return 0;
    var maxOffset = 0;
    var axis = bearing(rec.tee, rec.green);
    rec.route.forEach(function (p) {
      var d = metresBetween(rec.tee, p);
      var b = bearing(rec.tee, p);
      if (d === null || b === null) return;
      var offset = Math.abs(d * Math.sin(b - axis));
      if (offset > maxOffset) maxOffset = offset;
    });
    return maxOffset / straight;
  }

  /* One hole, two scores, and the counts they were built from so the Studio can show its
     working rather than a bare number. Weights are nominal - their only job is to order holes
     - but the ordering they encode is deliberate: water outranks bunkers, and having THREE
     kinds of thing in frame outranks having many of one kind. */
  function scoreHole(rec) {
    var surfaces = rec.surfaces || {};
    var bunkers = surfaceCentres(surfaces.bunkers);
    var water = surfaceCentres(surfaces.water);
    var fairways = surfaceCentres(surfaces.fairways);

    var corridor = [rec.tee].concat(rec.route, [rec.green]).filter(Boolean);
    var corridorBunkers = bunkers.filter(function (p) { return nearAny(p, corridor, CORRIDOR_M); });
    var corridorWater = water.filter(function (p) { return nearAny(p, corridor, CORRIDOR_M); });
    var corridorFairways = fairways.filter(function (p) { return nearAny(p, corridor, CORRIDOR_M); });

    var greenBunkers = bunkers.filter(function (p) { return metresBetween(p, rec.green) <= GREEN_AREA_M; });
    var greenWater = water.filter(function (p) { return metresBetween(p, rec.green) <= GREEN_AREA_M; });

    var dogleg = doglegFraction(rec);
    var lengthM = rec.tee ? (metresBetween(rec.tee, rec.green) || 0) : 0;

    /* Kinds present, not items present. Two bunkers and a pond beat five bunkers. */
    var corridorKinds = (corridorBunkers.length ? 1 : 0) + (corridorWater.length ? 1 : 0) + (corridorFairways.length ? 1 : 0);
    var greenKinds = (greenBunkers.length ? 1 : 0) + (greenWater.length ? 1 : 0);

    var teeShot =
      corridorKinds * 10 +
      Math.min(corridorBunkers.length, 6) * 2 +
      Math.min(corridorWater.length, 3) * 5 +
      Math.min(dogleg * 100, 25) +
      /* A hole long enough that the tee frame has something in the middle of it. Capped so a
         900m par 5 does not simply win on length. */
      Math.min(lengthM / 40, 10);

    var approach =
      greenKinds * 10 +
      Math.min(greenBunkers.length, 5) * 4 +
      Math.min(greenWater.length, 2) * 8 +
      /* A traced green outline is worth points on its own: it is the shape the bubble is drawn
         against, and an untraced green renders as a bare circle. */
      Math.min(rec.greenShape.length, 24) * 0.4;

    return {
      holeNumber: rec.holeNumber,
      par: rec.par,
      lengthM: Math.round(lengthM),
      hasVisual: rec.hasVisual,
      teeShot: Math.round(teeShot * 10) / 10,
      approach: Math.round(approach * 10) / 10,
      counts: {
        corridorBunkers: corridorBunkers.length,
        corridorWater: corridorWater.length,
        corridorFairways: corridorFairways.length,
        greenBunkers: greenBunkers.length,
        greenWater: greenWater.length,
        greenShapePoints: rec.greenShape.length,
        doglegPct: Math.round(dogleg * 100)
      }
    };
  }

  function scoreCourse(pkg) {
    return holeRecords(pkg).map(scoreHole);
  }

  /* ------------------------------------------------------------------ intel merge */

  /* Web evidence, shaped by functions/marketing-hole-intel.mjs: [{hole, confidence, source}].
     Confidence is 0..1 and is the endpoint's own; this module only decides how much a hole is
     lifted by it. INTEL_WEIGHT is set so a confidently-named signature hole beats any
     geometry score a course can produce (the busiest realistic hole scores in the 60s), and a
     weakly-named one only breaks ties. */
  var INTEL_WEIGHT = 120;

  function intelBoost(intel, holeNumber) {
    if (!Array.isArray(intel)) return null;
    var hit = null;
    intel.forEach(function (entry) {
      if (!entry || Number(entry.hole) !== Number(holeNumber)) return;
      var c = Number(entry.confidence);
      if (!Number.isFinite(c) || c <= 0) return;
      if (!hit || c > hit.confidence) hit = { confidence: Math.min(c, 1), source: entry.source || "" };
    });
    return hit;
  }

  /* ------------------------------------------------------------------ the pick */

  var APPROACH_M = 130;

  /* Sam's rule: the tee-shot snapshot is taken on a par 4 or 5, because Head To the Tee on a
     par 3 frames a hole with no corridor to show. If a course has no par data at all (a lite
     package, or a scorecard that never resolved), fall back to length - anything over 200m
     from tee to green is not a par 3. Stated as a reason on the result so the Studio can say
     which rule applied rather than showing an unexplained hole number. */
  function eligibleForTee(score) {
    if (Number.isFinite(score.par)) return score.par >= 4;
    return score.lengthM > 200;
  }

  /* The approach frame stands APPROACH_M back from the green, so the hole has to be longer than
     that by enough to still be on it. Learned the hard way on Akarana: hole 5 won the approach
     score, and it is 151m tee to green - standing 130m out put the player behind the tee, off
     the end of the hole's published raster, and projectToSurface answers null outside that
     raster. The app then draws NO BUBBLE AT ALL (app/js/painter.js drawShot -> buildBubbleParts),
     which is the one thing this frame exists to show. Verified as a clean boundary: on that hole
     the bubble renders at 50/70/90m and vanishes at 110/130/150m, exactly tracking whether the
     start point is inside the image.

     TEE_ROOM_M is how much hole must remain behind the player. 40m keeps the standing point off
     the tee box and comfortably inside a raster that was framed around the hole. */
  var TEE_ROOM_M = 40;

  function eligibleForApproach(score, approachM) {
    var d = Number.isFinite(approachM) ? approachM : APPROACH_M;
    /* No length at all (a green with no tee) cannot be judged; let it through rather than
       silently emptying the candidate pool - the runner checks the frame itself. */
    if (!score.lengthM) return true;
    return score.lengthM >= d + TEE_ROOM_M;
  }

  function best(list, key) {
    var top = null;
    list.forEach(function (item) {
      if (!top || item[key] > top[key]) top = item;
    });
    return top;
  }

  /* Returns {teeHole, approachHole, scores, notes} — nulls where a course cannot supply one,
     which is a normal outcome for a thin package and must stay distinguishable from hole 0.
     `notes` is plain English for the Studio's readout and the runner's report. */
  function pickHoles(pkg, opts) {
    opts = opts || {};
    var intel = opts.intel || null;
    var scores = scoreCourse(pkg);
    var notes = [];

    if (!scores.length) return { teeHole: null, approachHole: null, scores: [], notes: ["No hole in this package has a green - nothing to frame."] };

    var recs = holeRecords(pkg);

    var ranked = scores.map(function (s) {
      var hit = intelBoost(intel, s.holeNumber);
      return {
        holeNumber: s.holeNumber,
        par: s.par,
        lengthM: s.lengthM,
        teeRank: s.teeShot + (hit ? hit.confidence * INTEL_WEIGHT : 0),
        approachRank: s.approach + (hit ? hit.confidence * INTEL_WEIGHT : 0),
        signature: hit
      };
    });

    var teeCandidates = ranked.filter(function (r) {
      var score = scores.find(function (s) { return s.holeNumber === r.holeNumber; });
      return eligibleForTee(score);
    });
    if (!teeCandidates.length) {
      notes.push("No par 4 or 5 found - the tee-shot frame falls back to the longest hole.");
      teeCandidates = ranked.slice().sort(function (a, b) { return b.lengthM - a.lengthM; }).slice(0, 1);
    }

    var teePick = best(teeCandidates, "teeRank");
    notes.push(teePick && teePick.signature
      ? "Tee shot on " + teePick.holeNumber + " - named as a signature hole (" + Math.round(teePick.signature.confidence * 100) + "% confidence)."
      : "Tee shot on " + (teePick ? teePick.holeNumber : "?") + " - most varied corridor terrain.");

    /* A different hole for the approach where there is one. Two frames of the same hole is a
       worse marketing set than a slightly duller second hole, so difference wins over score. */
    var approachM = Number.isFinite(opts.approachM) ? opts.approachM : APPROACH_M;
    /* Length is a proxy for "is the standing point still on the hole". A caller that can answer
       the real question - is that point inside this hole's PUBLISHED RASTER, which is what
       app/js/play-surface.js projectToSurface will accept - passes approachUsable and gets the
       exact answer instead. The runner does (it plans inside the app page, where
       ClarityApp.playSurface is loaded); the Studio page has no play-surface code on its
       surface and falls back to length alone. */
    var usable = typeof opts.approachUsable === "function" ? opts.approachUsable : null;
    var longEnough = ranked.filter(function (r) {
      var score = scores.find(function (s) { return s.holeNumber === r.holeNumber; });
      if (!eligibleForApproach(score, approachM)) return false;
      if (!usable) return true;
      var rec = recs.find(function (x) { return x.holeNumber === r.holeNumber; });
      var stand = rec ? standingPoint(rec, approachM) : null;
      return !stand || usable(r.holeNumber, stand) !== false;
    });
    if (!longEnough.length) {
      notes.push("No hole is long enough to stand " + approachM + "m back from the green - the approach frame will be short of the hole.");
      longEnough = ranked;
    } else if (longEnough.length < ranked.length) {
      notes.push((ranked.length - longEnough.length) + " hole(s) cannot be played from " + approachM + "m back - excluded.");
    }
    var approachPool = longEnough.filter(function (r) { return !teePick || r.holeNumber !== teePick.holeNumber; });
    if (!approachPool.length) {
      approachPool = longEnough;
      notes.push("Only one hole available - both frames come from it.");
    }
    var approachPick = best(approachPool, "approachRank");
    notes.push(approachPick && approachPick.signature
      ? "Approach on " + approachPick.holeNumber + " - named as a signature hole (" + Math.round(approachPick.signature.confidence * 100) + "% confidence)."
      : "Approach on " + (approachPick ? approachPick.holeNumber : "?") + " - most varied green surrounds.");

    return {
      teeHole: teePick ? teePick.holeNumber : null,
      approachHole: approachPick ? approachPick.holeNumber : null,
      scores: scores,
      ranked: ranked,
      notes: notes
    };
  }

  /* Where to stand for the approach frame.
   *
   * TWO things have to be true at once, and the old version only managed one. The shot must
   * READ 130m — that is the number on the card, and the app measures it straight-line to the
   * green — and the player must be ON THE FAIRWAY. The old version took a straight bearing from
   * the green towards the last route point and stepped 130m down it, which on a dogleg sails
   * straight past that point and lands in whatever is beyond: rough, trees, a car park.
   *
   * So: walk the hole's own line (tee → route → green) back from the green and find the point
   * on it whose STRAIGHT-LINE distance to the green is the approach distance. On the line by
   * construction, and 130m by measurement. On a straight hole the two definitions coincide and
   * this returns exactly what the old one did.
   *
   * 130m is Sam's number and is deliberately NOT clamped to the bag: the frame is meant to show
   * the bubble sitting on the green, which is what a 130m shot does for every bag. */

  /* How far off the hole's line the standing point is allowed to be. Zero by construction here;
     the constant exists so callers can VERIFY rather than trust, and so a future placement rule
     has one number to honour. */
  var FAIRWAY_OFFSET_M = 30;

  /* The line the hole plays along, green LAST. Null when there is nothing to walk. */
  function holeLine(rec) {
    if (!rec || !rec.green) return null;
    var route = Array.isArray(rec.route) ? rec.route.filter(Boolean) : [];
    var line = [];
    if (rec.tee) line.push(rec.tee);
    route.forEach(function (p) { line.push(p); });
    line.push(rec.green);
    return line.length >= 2 ? line : null;
  }

  /* Interpolate a fraction along a segment, in local metres so it is a straight line on the
     ground rather than in degrees. */
  function alongSegment(a, b, t) {
    return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
  }

  function standingPoint(rec, distanceM) {
    if (!rec || !rec.green) return null;
    var d = Number.isFinite(distanceM) ? distanceM : APPROACH_M;
    var line = holeLine(rec);
    if (!line) return null;
    var green = rec.green;

    /* Walk segments from the green backwards. The first segment whose far end is at least `d`
       from the green contains the answer; bisect inside it. Bisection rather than trigonometry
       because the target is "straight-line distance to the green", which is not linear along a
       segment that is not pointing at the green. 40 halvings is sub-millimetre. */
    for (var i = line.length - 2; i >= 0; i -= 1) {
      var near = line[i + 1], far = line[i];
      var farD = metresBetween(far, green);
      if (farD === null) continue;
      if (farD < d) continue;                       /* whole segment is inside d - keep walking back */
      var lo = 0, hi = 1;                            /* lo = near end, hi = far end */
      for (var step = 0; step < 40; step += 1) {
        var mid = (lo + hi) / 2;
        var at = alongSegment(near, far, mid);
        if (metresBetween(at, green) < d) lo = mid; else hi = mid;
      }
      return alongSegment(near, far, (lo + hi) / 2);
    }

    /* The whole hole is shorter than the approach distance. Rather than inventing a point off
       the end of it, extend the FIRST segment's bearing - the tee-ward direction - which is at
       least the direction the hole plays. eligibleForApproach normally keeps such a hole out of
       the running entirely; this only runs when a caller overrode that. */
    var back = bearing(green, line[0]);
    if (!Number.isFinite(back)) return null;
    return destination(green, back, d);
  }

  /* How far a point sits off the hole's line, in metres. Null when the hole has no line.
     Exported so the Studio, the runner and the tests can all check the same thing rather than
     each deciding what "on the fairway" means. */
  function offsetFromHoleLine(rec, point) {
    var line = holeLine(rec);
    if (!line || !point) return null;
    var toPlane = localPlane(line[0]);
    var p = toPlane(point);
    var flat = line.map(toPlane);
    var best = Infinity;
    for (var i = 0; i < flat.length - 1; i += 1) {
      var dist = distanceToSegment(p, flat[i], flat[i + 1]);
      if (dist < best) best = dist;
    }
    return best === Infinity ? null : best;
  }

  /* ------------------------------------------------------------------ units by region */

  /* Which unit the screenshot should display, from where the course is. Yards where golf is
     played and sold in yards; metres everywhere else. Boxes, not a geocode: the question is
     "which of two words goes on the card", and a course 50km outside a box is a course whose
     operator can flip the override in the Studio. Ordered most-specific first.

     Deliberately NOT a list of every yard-using country. Ireland, South Africa and much of
     Asia are genuinely mixed and a wrong guess there is worse than the honest default, so they
     fall through to metres and the Studio shows the unit it chose so it can be corrected. */
  var YARD_BOXES = [
    { name: "United States (contiguous)", south: 24.5, north: 49.5, west: -125.0, east: -66.9 },
    { name: "Alaska", south: 51.0, north: 71.5, west: -170.0, east: -129.0 },
    { name: "Hawaii", south: 18.5, north: 22.5, west: -160.5, east: -154.5 },
    { name: "Canada", south: 41.5, north: 70.0, west: -141.0, east: -52.0 },
    { name: "United Kingdom", south: 49.8, north: 60.9, west: -8.7, east: 1.8 },
    { name: "Japan", south: 24.0, north: 45.6, west: 122.9, east: 146.0 }
  ];

  function unitsForPoint(point) {
    var p = pt(point);
    if (!p) return { units: "m", region: null, reason: "No course centre - defaulting to metres." };
    for (var i = 0; i < YARD_BOXES.length; i += 1) {
      var box = YARD_BOXES[i];
      if (p.lat >= box.south && p.lat <= box.north && p.lng >= box.west && p.lng <= box.east) {
        return { units: "yd", region: box.name, reason: box.name + " plays in yards." };
      }
    }
    return { units: "m", region: null, reason: "Outside the yard-playing regions - metres." };
  }

  /* The mean of every hole's tee and green, same rule as marshal.js packageCentre. Used only
     to ask the units question, so a centroid is as good as a library row's own centre. */
  function packageCentre(pkg) {
    var recs = holeRecords(pkg);
    var sumLat = 0, sumLng = 0, n = 0;
    recs.forEach(function (r) {
      [r.tee, r.green].filter(Boolean).forEach(function (p) { sumLat += p.lat; sumLng += p.lng; n += 1; });
    });
    return n ? { lat: sumLat / n, lng: sumLng / n } : null;
  }

  return {
    holeRecords: holeRecords,
    scoreHole: scoreHole,
    scoreCourse: scoreCourse,
    pickHoles: pickHoles,
    standingPoint: standingPoint,
    holeLine: holeLine,
    offsetFromHoleLine: offsetFromHoleLine,
    unitsForPoint: unitsForPoint,
    packageCentre: packageCentre,
    metresBetween: metresBetween,
    bearing: bearing,
    destination: destination,
    constants: { CORRIDOR_M: CORRIDOR_M, GREEN_AREA_M: GREEN_AREA_M, APPROACH_M: APPROACH_M,
      INTEL_WEIGHT: INTEL_WEIGHT, TEE_ROOM_M: TEE_ROOM_M, FAIRWAY_OFFSET_M: FAIRWAY_OFFSET_M }
  };
});
