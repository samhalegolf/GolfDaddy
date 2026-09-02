import CoreGraphics
import Foundation

/* The Framing Engine: where the shot appears on screen, and when the map moves.
 *
 * Strictly separate from the Bubble Engine, and the separation runs one way.
 * The Bubble Engine answers where the Bubble IS, in metres and degrees, and
 * never calls anything here — no pan, no zoom, no centre. This file answers
 * where that lands on a 176pt screen, and never has an opinion about golf.
 *
 * It works entirely in the lite map's IMAGE pixels. Geography is the Bubble
 * Engine's; screen points are the renderer's; this is the middle. That keeps it
 * pure and testable — no view, no gesture, no SwiftUI.
 *
 * WHY NOT WatchMapFrame. That type fits a static span into a view and is
 * exactly right for the Ready face, which draws a hole nobody is touching. It
 * is a viewport chooser, not a camera: it has no memory, so it cannot answer
 * "should the map move", which is the only interesting question once a finger
 * is on the target.
 */
public struct WatchMapCamera: Equatable {

    /// Never magnify a 448px-wide bake past this — the flat vector edges turn
    /// to mush and the map reads as broken rather than close-up. Same ceiling
    /// WatchMapFrame uses, for the same reason.
    public static let maximumScale: CGFloat = 3

    /// The fraction of the view kept clear at each edge. A target inside this
    /// inset does not move the map; one that reaches it pushes the map along.
    /// 0.22 leaves a little over half the view as free travel.
    public static let comfortInset: CGFloat = 0.22

    /// Where the camera is looking, in image pixels.
    public var focus: CGPoint
    /// Image pixels per screen point.
    public var scale: CGFloat

    public init(focus: CGPoint, scale: CGFloat) {
        self.focus = focus
        self.scale = scale
    }

    // MARK: - Resting framing

    /* The view to settle on when nobody is touching anything: fit the span that
       matters — the player, the target, and the Bubble's own extent — with
       proportional padding so a 20m chip and a 500m par 5 both get room.
     *
     * This is what a hole change and a Reset land on, and it is the answer §16
     * of the spec asks for: the Bubble centred and readable, rather than the
     * whole hole shrunk to a speck. */
    public static func resting(interest: [CGPoint], imageSize: CGSize, viewSize: CGSize) -> WatchMapCamera {
        guard imageSize.width > 0, imageSize.height > 0, viewSize.width > 0, viewSize.height > 0 else {
            return WatchMapCamera(focus: CGPoint(x: imageSize.width / 2, y: imageSize.height / 2), scale: 1)
        }
        let fitScale = min(viewSize.width / imageSize.width, viewSize.height / imageSize.height)
        let points = interest.filter { $0.x.isFinite && $0.y.isFinite }
        guard points.count >= 2 else {
            let focus = points.first ?? CGPoint(x: imageSize.width / 2, y: imageSize.height / 2)
            return WatchMapCamera(focus: focus, scale: min(max(fitScale, 1.4), maximumScale))
        }

        let xs = points.map(\.x), ys = points.map(\.y)
        let minX = xs.min()!, maxX = xs.max()!, minY = ys.min()!, maxY = ys.max()!
        let padding = max(24, 0.22 * max(maxX - minX, maxY - minY))
        let boxWidth = (maxX - minX) + padding * 2
        let boxHeight = (maxY - minY) + padding * 2
        let chosen = min(max(min(viewSize.width / boxWidth, viewSize.height / boxHeight), fitScale), maximumScale)
        return WatchMapCamera(focus: CGPoint(x: (minX + maxX) / 2, y: (minY + maxY) / 2), scale: chosen)
    }

    /* PLAY framing: the shot, filling the screen.
     *
     * `resting` above fits the whole span with padding, and that is right for a
     * hole nobody is standing on. It is wrong for playing one, because of an
     * aspect ratio nothing can argue with: a par 5 bakes to roughly 1:7.7 and a
     * 42mm watch is 1:1.2. Containing the image makes Millbrook's 1st 28pt wide
     * with 84% of the screen as black bars — technically the whole hole, and
     * useless.
     *
     * So this fills the width and shows the part being played, oriented the way
     * the bake already is: tee at the bottom, green at the top, player low on
     * the screen with the ground ahead above them. That is how every golf GPS
     * presents a long hole, and it is what the player is actually looking for.
     *
     * When the shot IS short enough for both ends to fit — an approach, a chip —
     * the span wins and both dots are on screen. The choice is made by the
     * geometry, not by a mode the player has to think about. */
    public static func play(player: CGPoint?, target: CGPoint?,
                            imageSize: CGSize, viewSize: CGSize) -> WatchMapCamera {
        guard imageSize.width > 0, imageSize.height > 0, viewSize.width > 0, viewSize.height > 0 else {
            return WatchMapCamera(focus: CGPoint(x: imageSize.width / 2, y: imageSize.height / 2), scale: 1)
        }
        /* The floor: never narrower than the view. Black bars down both sides
           are the thing being fixed, so they are not an option at any zoom. */
        let fillWidth = viewSize.width / imageSize.width
        let centre = CGPoint(x: imageSize.width / 2, y: imageSize.height / 2)

        guard let player else {
            let focus = target ?? centre
            return WatchMapCamera(focus: CGPoint(x: centre.x, y: focus.y),
                                  scale: min(fillWidth, maximumScale))
        }
        guard let target else {
            return low(player: player, centreX: centre.x, scale: min(fillWidth, maximumScale), viewSize: viewSize)
        }

        /* Would both ends fit, with margin, at a scale that still fills the
           width? `spanFraction` leaves room top and bottom so the dots are not
           against the bezel. */
        let spanFraction: CGFloat = 0.72
        let span = abs(target.y - player.y)
        let spanScale = span > 0 ? (viewSize.height * spanFraction) / span : maximumScale
        let scale = min(max(spanScale, fillWidth), maximumScale)

        if span * scale <= viewSize.height * spanFraction {
            /* Both fit: centre on the shot. */
            return WatchMapCamera(focus: CGPoint(x: centre.x, y: (player.y + target.y) / 2), scale: scale)
        }
        return low(player: player, centreX: centre.x, scale: scale, viewSize: viewSize)
    }

    /* BUBBLE framing: the shot being shaped, with its surroundings.
     *
     * `play` anchors the player low and lets the target run off the top. That
     * is right for a picture nobody can touch and wrong the moment the wrist
     * is aiming: the thing being moved is off screen, and every re-fit around
     * the player slides the map under the dot the player is not looking at —
     * which reads as the origin wandering. So this frames the Bubble itself
     * (its computed ring, or a nominal extent around a target with no ring yet)
     * at a fixed share of the view and lets the PLAYER fall off the bottom.
     * The aim line still reaches the edge and pivots as the target moves,
     * which is exactly the cue that the origin is a fixed point in the world.
     *
     * `bubbleFraction` is how much of the view's shorter side the Bubble's
     * longer side takes. 0.42 leaves better than a Bubble's width of ground
     * on every side — the bunker short of it, the rough wide of it — which is
     * the "surroundings". Floored at the width fill (no black bars, the same
     * rule as `play`) and capped at the mush ceiling; `origin` then refuses to
     * show background past an edge, so a Bubble near the top of the bake sits
     * off-centre rather than floating. */
    public static let bubbleFraction: CGFloat = 0.42

    public static func bubble(centre: CGPoint, extent: CGSize,
                              imageSize: CGSize, viewSize: CGSize) -> WatchMapCamera {
        guard imageSize.width > 0, imageSize.height > 0, viewSize.width > 0, viewSize.height > 0 else {
            return WatchMapCamera(focus: CGPoint(x: imageSize.width / 2, y: imageSize.height / 2), scale: 1)
        }
        let fillWidth = viewSize.width / imageSize.width
        let longest = max(extent.width, extent.height)
        let wanted = longest > 0 && longest.isFinite
            ? (min(viewSize.width, viewSize.height) * bubbleFraction) / longest
            : maximumScale
        let scale = min(max(wanted, fillWidth), maximumScale)
        return WatchMapCamera(focus: centre, scale: scale)
    }

    /* The player sitting low, with the hole running up the screen.
     *
     * `playerHeightFraction` is how far down the view the player sits: 0.78
     * gives roughly three quarters of the screen to the ground ahead, which is
     * the direction being played, and still leaves the player clear of the
     * bottom bezel and of the button that sits over it. */
    private static func low(player: CGPoint, centreX: CGFloat, scale: CGFloat, viewSize: CGSize) -> WatchMapCamera {
        let playerHeightFraction: CGFloat = 0.78
        let visibleImageHeight = viewSize.height / scale
        let focusY = player.y - (playerHeightFraction - 0.5) * visibleImageHeight
        return WatchMapCamera(focus: CGPoint(x: centreX, y: focusY), scale: scale)
    }

    // MARK: - Following a drag

    /* Pans — and ONLY pans — to keep a region inside the comfort rect.
     *
     * The scale is deliberately untouched. Zooming while a finger is moving the
     * target scales the world under that finger: the target stops tracking the
     * touch, and the player is fighting the map instead of aiming. So during a
     * drag the map slides and never breathes; the resting fit is applied when
     * the finger lifts, where a scale change is something the player watches
     * rather than something that happens to them.
     *
     * Minimal movement, too: the camera moves by exactly as much as it takes to
     * bring the region back inside, and not to re-centre. A camera that
     * re-centres on every frame drags the whole hole past the player for a
     * one-pixel adjustment. */
    public func following(region: CGRect, viewSize: CGSize) -> WatchMapCamera {
        guard viewSize.width > 0, viewSize.height > 0, scale > 0 else { return self }
        let insetX = viewSize.width * Self.comfortInset
        let insetY = viewSize.height * Self.comfortInset

        /* The region in screen points, relative to the current focus. */
        let half = CGPoint(x: viewSize.width / 2, y: viewSize.height / 2)
        let minPoint = CGPoint(x: half.x + (region.minX - focus.x) * scale, y: half.y + (region.minY - focus.y) * scale)
        let maxPoint = CGPoint(x: half.x + (region.maxX - focus.x) * scale, y: half.y + (region.maxY - focus.y) * scale)

        var moved = focus
        /* A region wider than the comfort rect cannot be satisfied on both
           sides. Prefer the leading edge — the one the target is pushing
           against — rather than oscillating between the two. */
        if maxPoint.x > viewSize.width - insetX { moved.x += (maxPoint.x - (viewSize.width - insetX)) / scale }
        else if minPoint.x < insetX { moved.x -= (insetX - minPoint.x) / scale }
        if maxPoint.y > viewSize.height - insetY { moved.y += (maxPoint.y - (viewSize.height - insetY)) / scale }
        else if minPoint.y < insetY { moved.y -= (insetY - minPoint.y) / scale }

        return WatchMapCamera(focus: moved, scale: scale)
    }

    /* The Digital Crown, as a zoom.
     *
     * Bounded below by "the whole image fits" and above by the magnification
     * ceiling, so the crown can never spin the map into a blur or into a speck
     * floating in background. */
    public func zoomed(by factor: CGFloat, imageSize: CGSize, viewSize: CGSize) -> WatchMapCamera {
        guard factor.isFinite, factor > 0, imageSize.width > 0, imageSize.height > 0 else { return self }
        let fitScale = min(viewSize.width / imageSize.width, viewSize.height / imageSize.height)
        return WatchMapCamera(focus: focus, scale: min(max(scale * factor, fitScale), Self.maximumScale))
    }

    // MARK: - Rendering

    /* Where image pixel (0,0) sits in view coordinates.
     *
     * Centres on the focus, then refuses to show background past an edge — an
     * off-centre hole is better than a map that appears to float. Same rule
     * WatchMapFrame applies, kept identical so the Ready face and the play page
     * do not frame the same hole two different ways. */
    public func origin(imageSize: CGSize, viewSize: CGSize) -> CGPoint {
        CGPoint(
            x: Self.axisOrigin(scaledLength: imageSize.width * scale, viewLength: viewSize.width, focus: focus.x * scale),
            y: Self.axisOrigin(scaledLength: imageSize.height * scale, viewLength: viewSize.height, focus: focus.y * scale)
        )
    }

    public func place(_ imagePoint: CGPoint, imageSize: CGSize, viewSize: CGSize) -> CGPoint {
        let o = origin(imageSize: imageSize, viewSize: viewSize)
        return CGPoint(x: o.x + imagePoint.x * scale, y: o.y + imagePoint.y * scale)
    }

    /* The inverse — a touch, back to the image pixel under it. This is the
       whole interaction path: finger -> image pixel -> (spatial reference) ->
       coordinate -> Bubble Engine. */
    public func imagePoint(fromView point: CGPoint, imageSize: CGSize, viewSize: CGSize) -> CGPoint? {
        guard scale > 0 else { return nil }
        let o = origin(imageSize: imageSize, viewSize: viewSize)
        return CGPoint(x: (point.x - o.x) / scale, y: (point.y - o.y) / scale)
    }

    private static func axisOrigin(scaledLength: CGFloat, viewLength: CGFloat, focus: CGFloat) -> CGFloat {
        guard scaledLength > viewLength else { return (viewLength - scaledLength) / 2 }
        return min(0, max(viewLength - scaledLength, viewLength / 2 - focus))
    }
}
