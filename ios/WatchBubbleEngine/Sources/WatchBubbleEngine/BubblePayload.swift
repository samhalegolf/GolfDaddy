import Foundation

/* The rendered Bubble: a shape with real radii, ready to be laid on the map.
 *
 * Ports `getGDBForClub` (profile plus roll-out to radii),
 * `gdNormalizeGpsBubblePayload` (the floors) and `gdGpsBubbleDisplayPayload`
 * (the caps). What it deliberately does NOT port is the pixel clamp at the end
 * of the display payload — that measures the Bubble against the phone's map
 * viewport, which is a framing question and belongs to the Framing Engine.
 * The parity fixtures are recorded with no projection installed, which is
 * exactly that un-clamped path.
 */
struct BubblePayload: Equatable {
    let club: String
    let baseCarryM: Double
    let totalM: Double
    let rolloutM: Double
    let aimOffsetDeg: Double
    let aimOffsetM: Double
    let clusterWidthM: Double
    let clusterDepthM: Double
    let clusterTiltDeg: Double
    let distanceTendencyPct: Double
    let visual: VisualBubble
    let radiusM: Double
    let lateralRadiusM: Double
    let depthRadiusM: Double
    let isGhostBag: Bool

    /* `getGDBForClub`.

       The roll-out term is the interesting part: a club that runs after landing
       gets a DEEPER Bubble, because the ball's resting place spreads down the
       shot line. A Driver carrying 205 and finishing at 228 gets 23m of
       roll-out folded into its depth; a wedge that stops dead gets none. */
    static func build(profile: BubbleProfile, isGhostBag: Bool) -> BubblePayload {
        let carryM = max(0, profile.baseCarryM)
        let totalM = max(carryM, profile.totalM ?? Bag.totalForCarry(club: profile.club, carryM: carryM))
        let rolloutM = max(0, totalM - carryM)

        let baseVisual = VisualBubble.render(profile)
        let lateralRadius = max(1, profile.clusterWidthM / 2)
        let baseDepthRadius = max(1, profile.clusterDepthM / 2)
        let totalDepthRadius = rolloutM > 0
            ? max(baseDepthRadius, rolloutM + min(7, baseDepthRadius * 0.22))
            : baseDepthRadius

        let visual = VisualBubble(
            visualWidthM: baseVisual.visualWidthM,
            visualDepthM: JS.round(max(baseVisual.visualDepthM, totalDepthRadius * 2), 1),
            visualTiltDeg: baseVisual.visualTiltDeg,
            visualSkewDeg: baseVisual.visualSkewDeg,
            visualYBias: baseVisual.visualYBias
        )
        let depthRadius = max(totalDepthRadius, visual.visualDepthM / 2)
        let radius = max(BubbleTables.Dev.minimumBubbleRadiusM, lateralRadius, depthRadius)

        return BubblePayload(
            club: profile.club,
            baseCarryM: carryM,
            totalM: JS.round(totalM, 1),
            rolloutM: JS.round(rolloutM, 1),
            aimOffsetDeg: profile.aimOffsetDeg,
            aimOffsetM: profile.aimOffsetM,
            clusterWidthM: profile.clusterWidthM,
            clusterDepthM: profile.clusterDepthM,
            clusterTiltDeg: profile.clusterTiltDeg,
            distanceTendencyPct: profile.distanceTendencyPct,
            visual: visual,
            radiusM: JS.round(radius, 1),
            lateralRadiusM: JS.round(lateralRadius, 1),
            depthRadiusM: JS.round(depthRadius, 1),
            isGhostBag: isGhostBag
        )
    }

    /* `gdNormalizeGpsBubblePayload` — floors, applied after the engine has had
       its say. `minRadius * 0.55` rather than `minRadius` on the half-axes: the
       floor is on the Bubble as a whole, and a shape whose two half-axes were
       each floored at 7m could never be smaller than 14m across. */
    func normalised() -> BubblePayload {
        let minRadius = max(1, BubbleTables.Dev.minimumBubbleRadiusM)
        let visualWidthM = visual.visualWidthM
        let visualDepthM = visual.visualDepthM
        guard visualWidthM > 0, visualDepthM > 0 else { return self }

        let lateral = max(minRadius * 0.55, visualWidthM / 2)
        let depth = max(minRadius * 0.55, visualDepthM / 2)
        let radius = max(minRadius, radiusM, lateral, depth)

        return BubblePayload(
            club: club, baseCarryM: baseCarryM, totalM: totalM, rolloutM: rolloutM,
            aimOffsetDeg: aimOffsetDeg, aimOffsetM: JS.round(aimOffsetM, 2),
            clusterWidthM: clusterWidthM, clusterDepthM: clusterDepthM, clusterTiltDeg: clusterTiltDeg,
            distanceTendencyPct: JS.round(JS.clamp(distanceTendencyPct, -10, 10), 2),
            visual: VisualBubble(
                visualWidthM: JS.round(visualWidthM, 1),
                visualDepthM: JS.round(visualDepthM, 1),
                visualTiltDeg: JS.round(JS.clamp(visual.visualTiltDeg, -18, 18), 2),
                visualSkewDeg: JS.round(JS.clamp(visual.visualSkewDeg, -16, 16), 2),
                visualYBias: JS.round(JS.clamp(visual.visualYBias, -0.18, 0.18), 3)
            ),
            radiusM: JS.round(radius, 1),
            lateralRadiusM: JS.round(lateral, 1),
            depthRadiusM: JS.round(depth, 1),
            isGhostBag: isGhostBag
        )
    }

    /* `gdGpsBubbleDisplayPayload`, minus the pixel clamp.

       Caps first, then floors, then the whole thing is bounded to [0.42, 1.08]
       — and a scale within 1.5% of 1 is left alone entirely rather than
       re-rounding every radius for nothing. The order matters: a Bubble can be
       pushed UP by the floors after being pushed down by the caps, which is why
       `minScale` is compared against the already-reduced scale rather than
       applied independently. */
    func displayed(shotDistanceM: Double) -> BubblePayload {
        let d = max(1, shotDistanceM.isFinite ? shotDistanceM : 155)
        var lateral = max(1, lateralRadiusM)
        var depth = max(1, depthRadiusM)

        let maxLateral = JS.clamp(d * BubbleTables.GeometryTuning.gpsMaxLateralPct, 9, BubbleTables.GeometryTuning.gpsMaxLateralM)
        let maxDepth = JS.clamp(d * BubbleTables.GeometryTuning.gpsMaxDepthPct, 12, BubbleTables.GeometryTuning.gpsMaxDepthM)
        let minLateral = JS.clamp(d * 0.028, 3.8, 7.5)
        let minDepth = JS.clamp(d * 0.038, 5.2, 11)

        var scale = min(1, maxLateral / lateral, maxDepth / depth)
        if scale < 1 {
            lateral *= scale
            depth *= scale
        }
        let minScale = min(1, max(minLateral / lateral, minDepth / depth))
        if minScale > scale {
            scale = minScale
        }
        scale = JS.clamp(scale, 0.42, 1.08)

        guard abs(scale - 1) >= 0.015 else { return self }
        return scaledForDisplay(scale)
    }

    /// `gdScaleGpsBubblePayloadForDisplay`.
    private func scaledForDisplay(_ scale: Double) -> BubblePayload {
        BubblePayload(
            club: club, baseCarryM: baseCarryM, totalM: totalM, rolloutM: rolloutM,
            aimOffsetDeg: aimOffsetDeg, aimOffsetM: aimOffsetM,
            clusterWidthM: clusterWidthM, clusterDepthM: clusterDepthM, clusterTiltDeg: clusterTiltDeg,
            distanceTendencyPct: distanceTendencyPct,
            visual: VisualBubble(
                visualWidthM: JS.round(max(1, visual.visualWidthM) * scale, 1),
                visualDepthM: JS.round(max(1, visual.visualDepthM) * scale, 1),
                visualTiltDeg: visual.visualTiltDeg,
                visualSkewDeg: visual.visualSkewDeg,
                visualYBias: visual.visualYBias
            ),
            radiusM: JS.round(max(1, radiusM) * scale, 1),
            lateralRadiusM: JS.round(max(1, lateralRadiusM) * scale, 1),
            depthRadiusM: JS.round(max(1, depthRadiusM) * scale, 1),
            isGhostBag: isGhostBag
        )
    }
}
