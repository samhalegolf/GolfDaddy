import Foundation

/* The Bubble's shape, derived from a club and a carry.
 *
 * This is the port of `calculateBubbleProfile` and everything it calls. Two
 * things about it are worth stating before the code, because both look like
 * mistakes and neither is:
 *
 * 1. `faceWindowDeg` and `carryWindowPct` do NOT come from the club's pattern
 *    ratios. `getActiveBubbleProfile` spreads PLACEHOLDER_PLAYER_PROFILE's base
 *    calibration underneath every derivation, and that base supplies 0.7 and
 *    4.2 for every club — so `gdDerivePatternWindow`'s per-club defaults are
 *    always shadowed and never reached on this path. A Driver derives its tilt
 *    with an iron's 0.7 degree window. That is what the phone does.
 *
 * 2. The tilt's own per-club base (`tiltBaseDeg`) IS used, so clubs still
 *    differ — a Driver tilts more than a wedge. Only the window terms are flat.
 */
struct BubbleProfile: Equatable {
    let club: String
    let baseCarryM: Double
    let totalM: Double?
    let faceAlignmentOffsetDeg: Double
    let aimOffsetDeg: Double
    let aimOffsetM: Double
    let clusterWidthM: Double
    let clusterDepthM: Double
    let clusterTiltDeg: Double
    let faceWindowDeg: Double
    let carryWindowPct: Double
    let distanceTendencyPct: Double

    /// `calculateBubbleProfile`, entered the way `getActiveBubbleProfile`
    /// enters it: base calibration underneath, club/carry/aim on top.
    static func derive(club: String,
                       baseCarryM: Double,
                       totalM: Double?,
                       faceAlignmentOffsetDeg: Double,
                       handedness: WatchBubbleProfile.Handedness) -> BubbleProfile {
        let group = BubbleTables.group(for: club)
        let ratios = BubbleTables.ratios(for: group)

        /* gdDerivePatternWindow — see note 1 above: the base calibration's
           values are passed in explicitly, so the club defaults never apply. */
        let faceWindowDeg = JS.round(BubbleTables.BaseCalibration.faceWindowDeg, 2)
        let carryWindowPct = JS.round(BubbleTables.BaseCalibration.carryWindowPct, 2)

        // gdDeriveBasePatternSize
        let multiplier = JS.clamp(BubbleTables.BaseCalibration.dispersionMultiplier, 0.6, 1.8)
        let clusterWidthM = JS.round(baseCarryM * ratios.width * multiplier * BubbleTables.GeometryTuning.widthScale, 1)
        let clusterDepthM = JS.round(baseCarryM * ratios.depth * multiplier * BubbleTables.GeometryTuning.depthScale, 1)

        // gdDeriveAimOffset — tan(deg) x the CARRY, not the shot. The shot-based
        // offset is a separate value applied at render time (see GpsAim).
        let aimOffsetDeg = JS.round(faceAlignmentOffsetDeg, 2)
        let aimOffsetM = JS.round(tan(faceAlignmentOffsetDeg * Double.pi / 180) * baseCarryM, 2)

        /* gdDeriveDistanceTendency, fed the WINDOW as the face delta — the
           JavaScript passes `faceDeltaFromPatternDeg: window.faceWindowDeg`,
           not the player's aim. */
        let hand = handedness.sign
        let strength: Double
        switch group {
        case .driver: strength = 0.42
        case .woodHybrid: strength = 0.36
        case .iron: strength = 0.30
        case .wedge: strength = 0.18
        }
        let distanceTendencyPct = JS.round(JS.clamp(-(hand * faceWindowDeg) * strength, -5, 5), 2)

        // gdDeriveClusterTilt
        let offsetInfluence = abs(faceAlignmentOffsetDeg) * 0.12
        let windowInfluence = abs(faceWindowDeg) * 0.9
        let carryInfluence = abs(carryWindowPct) * 0.08
        let clusterTiltDeg = JS.round(
            JS.clamp(hand * (ratios.tiltBaseDeg + offsetInfluence + windowInfluence + carryInfluence) * BubbleTables.GeometryTuning.tiltScale,
                     -BubbleTables.GeometryTuning.tiltMaxDeg, BubbleTables.GeometryTuning.tiltMaxDeg),
            2)

        return BubbleProfile(
            club: club,
            baseCarryM: JS.round(baseCarryM, 1),
            totalM: totalM.map { JS.round($0, 1) },
            faceAlignmentOffsetDeg: JS.round(faceAlignmentOffsetDeg, 2),
            aimOffsetDeg: aimOffsetDeg,
            aimOffsetM: aimOffsetM,
            clusterWidthM: clusterWidthM,
            clusterDepthM: clusterDepthM,
            clusterTiltDeg: clusterTiltDeg,
            faceWindowDeg: faceWindowDeg,
            carryWindowPct: carryWindowPct,
            distanceTendencyPct: distanceTendencyPct
        )
    }
}

/* `calculateVisualBubbleRender` — the drawn shape, slightly larger and slightly
 more tilted than the derived cluster.

 THE HANDEDNESS QUIRK. On the phone this is called as
 `calculateVisualBubbleRender(profile, {handedness: profile.handedness || "right"})`
 — and `calculateBubbleProfile` does not return a `handedness` key, so
 `profile.handedness` is always undefined and the fallback always wins. The
 visual adjustment therefore uses hand = +1 for EVERY player, including
 left-handers, whose cluster tilt is already negative.

 The visible consequence: a right-hander's 5.35 degree cluster becomes 6.71
 drawn, and a left-hander's -5.35 becomes -3.99 — pulled towards zero rather
 than mirrored to -6.71.

 That is arguably a latent bug in the phone engine. It is NOT this file's to
 fix. A wrist that "corrected" it would draw a visibly different Bubble from the
 phone for every left-handed player, with nothing to say why — the exact
 divergence the parity fixtures exist to prevent. If it should be mirrored, fix
 it in scripts/gd-app-core.js and let both surfaces move together. The
 `left-handed` parity case pins the current behaviour so the decision has to be
 deliberate. */
struct VisualBubble: Equatable {
    let visualWidthM: Double
    let visualDepthM: Double
    let visualTiltDeg: Double
    let visualSkewDeg: Double
    let visualYBias: Double

    static func render(_ profile: BubbleProfile) -> VisualBubble {
        let hand: Double = 1   // see the handedness note above — deliberately not profile handedness
        let offsetNorm = JS.clamp((hand * profile.faceAlignmentOffsetDeg) / 6, -1, 1)
        let windowNorm = JS.clamp((profile.faceWindowDeg == 0 ? 0.7 : profile.faceWindowDeg) / 1.5, 0, 1)
        let carryNorm = JS.clamp((profile.carryWindowPct == 0 ? 4.2 : profile.carryWindowPct) / 8, 0, 1)
        return VisualBubble(
            visualWidthM: JS.round(profile.clusterWidthM * (1 + windowNorm * 0.1 + abs(offsetNorm) * 0.06), 1),
            visualDepthM: JS.round(profile.clusterDepthM * (1 + carryNorm * 0.08 + windowNorm * 0.06), 1),
            visualTiltDeg: JS.round(profile.clusterTiltDeg + offsetNorm * 1.5 + hand * windowNorm * 1.2, 2),
            visualSkewDeg: JS.round(offsetNorm * 5, 2),
            visualYBias: JS.round(offsetNorm * 0.035, 3)
        )
    }
}
