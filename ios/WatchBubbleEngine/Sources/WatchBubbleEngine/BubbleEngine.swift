import Foundation

/* The Watch Bubble Engine.
 *
 * One function: player + target + bag + My Bubble + hole reference in, the
 * Bubble the Watch draws out. Stateless — `BubbleEngine.calculate(input)`,
 * never `engine.moveSomething()`. Everything mutable (the current target, the
 * selected club, the club-transition band) belongs to WatchPlayState.
 *
 * It answers where the Bubble is, what shape it is, which club and what
 * distance. It says nothing about the screen: no panning, no zoom, no camera.
 * That boundary is strict — see docs/WATCH_BUBBLE_ENGINE_SPEC.md §11.
 */
public enum BubbleEngine {

    // MARK: - Input

    public struct Input {
        public let player: Coordinate
        public let target: Coordinate
        public let bag: WatchBagSnapshot
        public let bubble: WatchBubbleProfile
        /* A club to use instead of the one the distance would resolve to.
           WatchPlayState passes the club it is HOLDING through its transition
           band; the engine itself still has no memory and no hysteresis. */
        public let heldClub: String?

        public init(player: Coordinate, target: Coordinate, bag: WatchBagSnapshot,
                    bubble: WatchBubbleProfile, heldClub: String? = nil) {
            self.player = player
            self.target = target
            self.bag = bag
            self.bubble = bubble
            self.heldClub = heldClub
        }
    }

    // MARK: - Output

    public struct ClubSelection: Equatable {
        public let club: String
        public let carryM: Double
        public let totalM: Double
        public let isGhost: Bool
    }

    public struct Result: Equatable {
        public let target: Coordinate
        public let targetDistanceM: Double
        public let shotBearingDeg: Double
        public let club: ClubSelection

        /// Where the Bubble is drawn — the target with the aim offset applied,
        /// which is NOT the target itself whenever the player has a My Bubble.
        public let centre: Coordinate
        /// The ring, in world coordinates. `ringImagePoints` on the lite map
        /// turns it into image pixels; nothing here knows about a screen.
        public let ring: [Coordinate]

        public let widthM: Double
        public let depthM: Double
        public let tiltDeg: Double
        public let aimOffsetDeg: Double
        public let aimOffsetM: Double

        public let engineVersion: String
    }

    // MARK: - Calculate

    /* Cheap enough to run on every frame of a drag: coordinate maths, a bag
       lookup, the profile derivation and a 168-point ring. No allocation beyond
       the ring itself, no I/O of any kind. */
    public static func calculate(_ input: Input) -> Result? {
        let distanceM = Geo.distance(input.player, input.target)
        guard distanceM.isFinite, distanceM > 0 else { return nil }
        guard let row = Bag.resolveClub(in: input.bag, targetDistanceM: distanceM, named: input.heldClub) else { return nil }

        let profile = BubbleProfile.derive(
            club: row.club,
            baseCarryM: JS.round(row.carryM),
            totalM: row.totalM,
            faceAlignmentOffsetDeg: input.bubble.effectiveOffsetDeg,
            handedness: input.bubble.handedness
        )
        let payload = BubblePayload
            .build(profile: profile, isGhostBag: input.bag.isGhost)
            .normalised()
            .displayed(shotDistanceM: distanceM)

        let shotBearing = Geo.bearing(input.player, input.target)
        let aimOffsetM = gpsAimOffsetM(payload: payload, shotDistanceM: distanceM)
        let centre = renderCentre(target: input.target, payload: payload, shotBearing: shotBearing, aimOffsetM: aimOffsetM)

        return Result(
            target: input.target,
            targetDistanceM: distanceM,
            shotBearingDeg: compassBearingDeg(from: input.player, to: input.target),
            club: ClubSelection(club: row.club, carryM: row.carryM, totalM: row.totalM, isGhost: input.bag.isGhost),
            centre: centre,
            ring: buildRing(centre: centre, payload: payload, shotBearing: shotBearing),
            widthM: payload.visual.visualWidthM,
            depthM: payload.visual.visualDepthM,
            tiltDeg: payload.visual.visualTiltDeg,
            aimOffsetDeg: payload.aimOffsetDeg,
            aimOffsetM: aimOffsetM,
            engineVersion: BubbleEngineVersion.current
        )
    }

    // MARK: - Aim

    /* `gdGpsAimOffsetM` — tan(My Bubble degrees) x the SHOT distance.
     *
     * Not the club's carry. The payload's own `aimOffsetM` is carry-based,
     * which is what the studio and the charts want because they draw the Bubble
     * at its own base distance. On the course the Bubble sits at the target, so
     * a carry-based offset drew the aim short by carry/distance and stepped
     * with whichever club the distance resolved to — 3 degrees drew the same
     * 12.05m at 260m, 300m and 350m, because nothing in a bag is longer than
     * the driver.
     *
     * The quarter-of-the-shot bound is geometric sanity and nothing else: a
     * quarter is 14.04 degrees, far outside any aim a player can set. */
    static func gpsAimOffsetM(payload: BubblePayload, shotDistanceM: Double) -> Double {
        let deg = payload.aimOffsetDeg
        guard shotDistanceM > 0 else { return JS.round(payload.aimOffsetM, 2) }
        let limit = max(2, shotDistanceM * 0.25)
        return JS.round(JS.clamp(tan(deg * Double.pi / 180) * shotDistanceM, -limit, limit), 2)
    }

    /* `gdBubbleRenderCenter` — the target, pushed sideways by the aim and
       forward by the visual Y bias.

       The side offset is bounded a second time, at a quarter of the aim base,
       which is the bound the JavaScript applies at this seam on top of the one
       in gpsAimOffsetM. Both are reproduced because either can bind first
       depending on the shot. */
    static func renderCentre(target: Coordinate, payload: BubblePayload, shotBearing: Double, aimOffsetM: Double) -> Coordinate {
        let aimBase = max(1, payload.baseCarryM > 0 ? payload.baseCarryM : payload.radiusM * 10)
        let sideLimit = max(2, aimBase * 0.25)
        let sideOffset = JS.clamp(aimOffsetM, -sideLimit, sideLimit)
        let forwardBias = JS.clamp(payload.visual.visualYBias, -0.18, 0.18) * max(1, payload.depthRadiusM)
        return Geo.projectOffset(target, shotBearing, forwardBias, sideOffset)
    }

    // MARK: - The ring

    /* `bubbleRadiusFactor` — the distance tendency, breathing the ring in and
       out by at most 4% front to back. `bubbleTextureFactor` is deliberately
       NOT ported: it is gated on `bubbleOrganic` and the bias modes, which are
       phone display state the wrist has no equivalent of, and the fixtures were
       recorded with it inactive. */
    static func radiusFactor(rel: Double, payload: BubblePayload) -> Double {
        let front = cos(rel)
        let frontPos = max(0, front)
        let backPos = max(0, -front)
        let tendency = JS.clamp(payload.distanceTendencyPct, -5, 5) / 5
        let factor = 1 + tendency * (0.026 * frontPos - 0.018 * backPos)
        return max(0.96, min(1.04, factor))
    }

    /* `buildBubbleShape` + `gdSmoothBubbleLocalRing` + `gdBubbleLocalToLatLng`.
     *
     * ORIENTATION, which this codebase has been bitten by once: the ACROSS axis
     * (lateral) lies on x, square to the shot, and the ALONG axis (depth) lies
     * on y. Writing it the other way round lays the Bubble's longer axis
     * straight down the target line — the 90 degrees GPS Play was visibly out
     * by, in an object that was never itself wrong. rel = 0 is Long, rel = pi/2
     * is Right; see scripts/gd-bubble-frame-core.js for the shared definition.
     */
    static func buildRing(centre: Coordinate, payload: BubblePayload, shotBearing: Double) -> [Coordinate] {
        /* `gdBubbleAxes(payload, scale)` — the main ring's own scale, applied
           to both half-axes before anything else. */
        let lateral = max(1, payload.lateralRadiusM) * BubbleTables.mainRingScale
        let depth = max(1, payload.depthRadiusM) * BubbleTables.mainRingScale
        let steps = BubbleTables.ringSteps

        var points: [(x: Double, y: Double)] = []
        points.reserveCapacity(steps)
        for i in 0..<steps {
            let rel = (Double.pi * 2 * Double(i)) / Double(steps)
            let rf = radiusFactor(rel: rel, payload: payload)
            points.append((x: cos(rel) * lateral * rf, y: sin(rel) * depth * rf))
        }

        /* Two smoothing passes, each a weighted average with both neighbours
           around the closed ring. The weights do not sum to 1 (0.72 + 0.14 x 2
           = 1.0 exactly, in fact) — they are copied as written. */
        var smoothed = points
        for _ in 0..<2 {
            let all = smoothed
            for index in all.indices {
                let previous = all[(index - 1 + all.count) % all.count]
                let next = all[(index + 1) % all.count]
                smoothed[index] = (
                    x: all[index].x * 0.72 + (previous.x + next.x) * 0.14,
                    y: all[index].y * 0.72 + (previous.y + next.y) * 0.14
                )
            }
        }

        let tilt = payload.visual.visualTiltDeg * Double.pi / 180
        let skew = payload.visual.visualSkewDeg * Double.pi / 180
        return smoothed.map { point in
            let skewedY = point.y + tan(skew) * point.x * 0.42
            let rx = point.x * cos(tilt) - skewedY * sin(tilt)
            let ry = point.x * sin(tilt) + skewedY * cos(tilt)
            return Geo.localPointToLatLng(centre, shotBearing, rx, ry)
        }
    }

    // MARK: - The default target

    /* `gdTargetForGreenCentre`, reduced to the part the wrist can honestly
       answer.
     *
     * The green when the bag reaches it (plus the phone's 3m of grace), and
     * otherwise a point down the hole's own ROUTE at the edge of the bag —
     * never a point on the straight line to the green, which on a dogleg is
     * through the trees.
     *
     * WHAT IS NOT PORTED. The phone gates the fairway-line grab on
     * `gdStartIsInMappedTeeArea`, and falls back to a straight-line projection
     * when the gate is shut. The wrist cannot evaluate that gate — it needs the
     * mapped tee area, which is not in the hole reference — so it does not
     * pretend to: with a route it uses the route, and with no route it returns
     * nil and the caller keeps the phone's target. That gate has been supplied
     * under the wrong name once already, and when it silently never opened
     * every out-of-reach hole laid up across the dogleg. Returning nil is the
     * honest version of not knowing.
     *
     * Called on hole change and on Reset only. It never overrides a target the
     * player or the phone has placed. */
    public static func defaultTarget(player: Coordinate,
                                     green: Coordinate,
                                     route: [Coordinate],
                                     bag: WatchBagSnapshot) -> Coordinate? {
        guard let maxM = Bag.maxPlayableM(in: bag), maxM > 0 else { return nil }
        let toGreen = Geo.distance(player, green)
        guard toGreen.isFinite else { return nil }
        if toGreen <= maxM + 3 { return green }
        return layupAlong(route: route, player: player, maxM: maxM)
    }

    /* `fairwayLayupTargetByShotDistance` — walk the route in 7m steps, ignore
       everything behind the player, and take the sample closest to the edge of
       the bag without exceeding it.
     *
     * The `+6` on the minimum progress keeps the answer ahead of where the
     * player already stands rather than beside them, and the final floor
     * (`max(45, maxM * 0.58)`) refuses an answer so short it would be a worse
     * suggestion than none — at which point the caller keeps the phone's. */
    static func layupAlong(route: [Coordinate], player: Coordinate, maxM: Double) -> Coordinate? {
        let samples = sampleRoute(route, stepM: 7)
        guard samples.count >= 2 else { return nil }

        var nearest = samples[0]
        var nearestScore = Geo.distance(player, nearest.point)
        for sample in samples {
            let score = Geo.distance(player, sample.point)
            if score < nearestScore { nearest = sample; nearestScore = score }
        }
        let minProgress = max(0, nearest.progress)

        var best: (point: Coordinate, progress: Double, direct: Double, score: Double)?
        for sample in samples {
            guard sample.progress >= minProgress + 6 else { continue }
            let direct = Geo.distance(player, sample.point)
            guard direct.isFinite, direct <= maxM + 3 else { continue }
            let score = abs(maxM - direct)
            if best == nil
                || score < best!.score - 0.75
                || (abs(score - best!.score) <= 0.75 && sample.progress > best!.progress) {
                best = (sample.point, sample.progress, direct, score)
            }
        }
        guard let best, best.direct >= max(45, maxM * 0.58) else { return nil }
        return best.point
    }

    /// `sampleRouteProgress` — evenly spaced points along the route, each
    /// carrying how far along the hole it sits.
    static func sampleRoute(_ route: [Coordinate], stepM: Double) -> [(point: Coordinate, progress: Double)] {
        guard let first = route.first else { return [] }
        var samples: [(point: Coordinate, progress: Double)] = [(first, 0)]
        var progress: Double = 0
        for i in 1..<max(1, route.count) {
            let a = route[i - 1], b = route[i]
            let segment = Geo.distance(a, b)
            guard segment.isFinite, segment > 0 else { continue }
            let brg = Geo.bearing(a, b)
            let steps = max(1, Int(ceil(segment / max(3, stepM))))
            for s in 1...steps {
                let along = segment * (Double(s) / Double(steps))
                samples.append((Geo.project(a, brg, along), progress + along))
            }
            progress += segment
        }
        return samples
    }

    // MARK: - Reporting

    /* The compass bearing player -> target, cosine-corrected, for display and
       for the parity fixtures. Deliberately NOT `Geo.bearing`, which is the
       engine's own uncorrected convention used to lay the Bubble down: this one
       is a number a person might read, and it should be a real bearing. */
    static func compassBearingDeg(from: Coordinate, to: Coordinate) -> Double {
        let north = (to.lat - from.lat) * Geo.metresPerDegree
        let east = (to.lng - from.lng) * Geo.metresPerDegree * cos(((from.lat + to.lat) / 2) * Double.pi / 180)
        return JS.round((atan2(east, north) * 180 / Double.pi + 360).truncatingRemainder(dividingBy: 360), 2)
    }
}
