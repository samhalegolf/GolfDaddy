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
 * Two framings for a shot (Sam, 2026-10-13; the Garmin's GarminMapCamera has
 * the same two). SHOT: the Bubble fitted to the glass with the target in the
 * middle, and the map TURNED so the shot runs straight up the screen — the
 * aim line comes up from the bottom edge and says where the shot comes from,
 * always vertical, never across the face, whichever way the bake was cut.
 * The player is on the glass for a chip and off the bottom for a drive: the
 * Bubble is what the shot is about, so the Bubble is what fits. PLAY, for a
 * hole with no target yet: the player low with the ground ahead above them,
 * in the bake's own orientation.
 *
 * Everything downstream places a point through `frame`: one affine, so a
 * turned framing costs the same per point as an unturned one.
 */
public struct WatchMapCamera: Equatable {

    /// Never magnify a 448px-wide bake past this — the flat vector edges turn
    /// to mush and the map reads as broken rather than close-up.
    public static let maximumScale: CGFloat = 3

    /// How much of the view's shorter side the Bubble's longest reach takes
    /// on the SHOT framing: the ring whole on the glass, the chrome still
    /// clear of it. The target is always at 0.5.
    public static let bubbleFraction: CGFloat = 0.6
    /// A Bubble's worth of ground for a target with no ring computed yet:
    /// about a Driver's cluster at its longest, in metres.
    public static let nominalBubbleExtentM: CGFloat = 55

    /* Edge panning. A tap or a drag moves the TARGET and nothing else — the
       map under it stays put, so what the finger is placing stays where the
       finger is. The map moves only when the finger reaches the very edge of
       the view and holds there for a beat, and then it creeps.

       `edgeInset` is how close to the edge counts, in points. `edgeDwell` is
       the beat: long enough that a finger sweeping across to the far side does
       not start the map moving on its way past, short enough that a finger
       parked on the edge is not left wondering. `edgePanSpeed` is deliberately
       slow — the finger is still holding a target, and a map racing under it
       moves that target faster than anyone can aim. */
    public static let edgeInset: CGFloat = 16
    public static let edgeDwell: TimeInterval = 0.4
    public static let edgePanSpeed: CGFloat = 45

    /// Where the camera is looking, in image pixels.
    public var focus: CGPoint
    /// Image pixels per screen point.
    public var scale: CGFloat
    /// Screen rotation applied about the focus, radians, clockwise positive
    /// in screen space (y down). 0 for the PLAY and green framings.
    public var rotation: CGFloat
    /// Whether the view may show past the image's edges. Play and resting
    /// framings keep to the picture; the SHOT framing does not, because the
    /// target belongs in the middle of the screen even when it sits at the
    /// edge of the baked corridor - the views fill the overspill with the
    /// map's own dark green, so it reads as more rough, not as a hole.
    public var clampsToImage: Bool

    public init(focus: CGPoint, scale: CGFloat, rotation: CGFloat = 0, clampsToImage: Bool = true) {
        self.focus = focus
        self.scale = scale
        self.rotation = rotation
        self.clampsToImage = clampsToImage
    }

    // MARK: - Shot framing

    /* SHOT framing (Sam, 2026-10-13): the target centred, the map turned so
       the shot runs straight up, and the scale whatever fits the Bubble -
       `bubbleExtent`, its longest reach across the target in image pixels -
       at `bubbleFraction` of the glass, capped at `maximumScale`. The aim
       line comes up from the bottom edge and says where the shot comes from;
       the player lands wherever that puts them, on the glass for a chip and
       off the bottom for a drive. The Bubble is what the shot is about, so
       the Bubble is what fits: sizing the shot to put the player's dot at
       six o'clock instead shrank a drive's Bubble to a speck. */
    public static func shot(player: CGPoint, target: CGPoint, bubbleExtent: CGFloat, imageSize: CGSize, viewSize: CGSize) -> WatchMapCamera {
        let shorterView = min(viewSize.width, viewSize.height)
        let scale = bubbleExtent > 0 && bubbleExtent.isFinite && shorterView > 0
            ? min((shorterView * bubbleFraction) / bubbleExtent, maximumScale)
            : maximumScale
        let dx = target.x - player.x, dy = target.y - player.y
        /* The angle that turns the player->target vector to straight up
           (0, -1): up is -pi/2 in y-down screen space. A player standing on
           the target has no direction to turn to. */
        let rotation: CGFloat = hypot(dx, dy) >= 1 ? -CGFloat.pi / 2 - atan2(dy, dx) : 0
        return WatchMapCamera(focus: target, scale: scale, rotation: rotation, clampsToImage: false)
    }

    /* The Bubble's longest reach across the target, in image pixels: twice
       the farthest ring point from the target, so a ring the engine sits off
       to one side of the target is still whole whichever way the map is
       turned. nil for no ring. */
    public static func bubbleExtent(ring: [CGPoint], target: CGPoint) -> CGFloat? {
        let farthest = ring.map { hypot($0.x - target.x, $0.y - target.y) }.max() ?? 0
        return farthest > 0 ? farthest * 2 : nil
    }

    /// `nominalBubbleExtentM` of ground in image pixels, for a target with no
    /// ring yet; a bake with no metresPerPixel is taken as 0.5 m/px.
    public static func nominalBubbleExtent(metresPerPixel: Double?) -> CGFloat {
        nominalBubbleExtentM / CGFloat(metresPerPixel ?? 0.5)
    }

    // MARK: - Resting framing

    /* The view to settle on for a span nobody is touching: fit the points that
       matter with proportional padding so a 20m chip and a 500m par 5 both get
       room. The demo browser frames an approach with it. */
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

    /* How much of the screen the green-focus band is given. The band is where
     * the ball may be placed, so the whole of it has to be reachable by a
     * finger: framing tighter than this puts part of it off the bezel, and
     * the ball is the one thing on that face you have to be able to touch. */
    public static let greenFraction: CGFloat = 0.92

    /* Green focus: the band the ball may be placed in, filling the screen.
     *
     * `radiusPx` is Marshal's GREEN_FOCUS_M expressed in this bake's pixels —
     * measured rather than converted, exactly as the phone does it, because
     * the projection is the only thing that knows the scale.
     *
     * It frames the BAND and not the green, which is the same correction the
     * phone's zoom stage got: a green polygon is 15m across and the band is
     * 80m, so framing the polygon left a ball 30m short of the green sitting
     * off the edge of a screen you were being asked to drag it on. */
    public static func green(centre: CGPoint, radiusPx: CGFloat,
                             imageSize: CGSize, viewSize: CGSize) -> WatchMapCamera {
        guard imageSize.width > 0, imageSize.height > 0, viewSize.width > 0, viewSize.height > 0,
              radiusPx > 0, radiusPx.isFinite else {
            return WatchMapCamera(focus: centre, scale: 1)
        }
        let wanted = (min(viewSize.width, viewSize.height) * greenFraction) / (radiusPx * 2)
        let fillWidth = viewSize.width / imageSize.width
        return WatchMapCamera(focus: centre, scale: min(max(wanted, fillWidth), maximumScale))
    }

    /* The player sitting low, with the hole running up the screen.
     *
     * `playerHeightFraction` here is how far down the view the player sits on
     * the PLAY framing: 0.78 gives roughly three quarters of the screen to the
     * ground ahead, which is the direction being played, and still leaves the
     * player clear of the bottom bezel and of the button that sits over it. */
    private static func low(player: CGPoint, centreX: CGFloat, scale: CGFloat, viewSize: CGSize) -> WatchMapCamera {
        let playerHeightFraction: CGFloat = 0.78
        let visibleImageHeight = viewSize.height / scale
        let focusY = player.y - (playerHeightFraction - 0.5) * visibleImageHeight
        return WatchMapCamera(focus: CGPoint(x: centreX, y: focusY), scale: scale)
    }

    // MARK: - Edge panning

    /// Which way the map should travel for a finger at `point`: each component
    /// is -1, 0 or 1, and both are 0 anywhere inside the edge inset.
    public static func edgeDirection(of point: CGPoint, viewSize: CGSize) -> CGVector {
        guard viewSize.width > 0, viewSize.height > 0 else { return .zero }
        let dx: CGFloat = point.x <= edgeInset ? -1 : (point.x >= viewSize.width - edgeInset ? 1 : 0)
        let dy: CGFloat = point.y <= edgeInset ? -1 : (point.y >= viewSize.height - edgeInset ? 1 : 0)
        return CGVector(dx: dx, dy: dy)
    }

    /* Moves the focus by a screen-point delta — and ONLY the focus.
     *
     * The scale is untouched for the same reason it always was: zooming while
     * a finger is moving the target scales the world under that finger. The
     * delta is a SCREEN direction, turned into the bake's own axes for a
     * turned framing (`imageDirection`), so a finger held at the top of the
     * glass creeps the map up the glass whichever way the bake lies. The
     * focus is kept inside the image, so a long hold at an edge parks at the
     * end of the bake instead of drifting off into nothing and needing to be
     * dragged all the way back. */
    public func panned(byScreen delta: CGVector, imageSize: CGSize) -> WatchMapCamera {
        guard scale > 0, delta.dx.isFinite, delta.dy.isFinite else { return self }
        let d = imageDirection(screenDx: delta.dx, screenDy: delta.dy)
        let moved = CGPoint(
            x: min(max(focus.x + d.dx / scale, 0), max(imageSize.width, 0)),
            y: min(max(focus.y + d.dy / scale, 0), max(imageSize.height, 0)))
        return WatchMapCamera(focus: moved, scale: scale, rotation: rotation, clampsToImage: clampsToImage)
    }

    /* The Digital Crown, as a zoom.
     *
     * Bounded below by "the whole image fits" and above by the magnification
     * ceiling, so the crown can never spin the map into a blur or into a speck
     * floating in background. */
    public func zoomed(by factor: CGFloat, imageSize: CGSize, viewSize: CGSize) -> WatchMapCamera {
        guard factor.isFinite, factor > 0, imageSize.width > 0, imageSize.height > 0 else { return self }
        let fitScale = min(viewSize.width / imageSize.width, viewSize.height / imageSize.height)
        return WatchMapCamera(focus: focus, scale: min(max(scale * factor, fitScale), Self.maximumScale),
                              rotation: rotation, clampsToImage: clampsToImage)
    }

    /// A screen-space direction in the bake's own axes (unscaled): what an
    /// edge pan in screen terms means on the image.
    public func imageDirection(screenDx: CGFloat, screenDy: CGFloat) -> CGVector {
        let c = cos(rotation), s = sin(rotation)
        return CGVector(dx: screenDx * c + screenDy * s, dy: screenDy * c - screenDx * s)
    }

    // MARK: - Rendering

    /* Where image pixel (0,0) sits in view coordinates, for an UNTURNED framing.
     *
     * Centres on the focus, then refuses to show background past an edge — an
     * off-centre hole is better than a map that appears to float. */
    public func origin(imageSize: CGSize, viewSize: CGSize) -> CGPoint {
        guard clampsToImage else {
            return CGPoint(x: viewSize.width / 2 - focus.x * scale, y: viewSize.height / 2 - focus.y * scale)
        }
        return CGPoint(
            x: Self.axisOrigin(scaledLength: imageSize.width * scale, viewLength: viewSize.width, focus: focus.x * scale),
            y: Self.axisOrigin(scaledLength: imageSize.height * scale, viewLength: viewSize.height, focus: focus.y * scale)
        )
    }

    /* The image->screen affine for this framing. Rotation 0 is the plain
       origin + point * scale of before; a turned framing turns about the
       focus, which sits at the centre of the glass. The picture is drawn
       through it (GraphicsContext.transform) and every marker through
       `place`, so the two can never disagree. */
    public func frame(imageSize: CGSize, viewSize: CGSize) -> CGAffineTransform {
        guard rotation != 0 else {
            let o = origin(imageSize: imageSize, viewSize: viewSize)
            return CGAffineTransform(a: scale, b: 0, c: 0, d: scale, tx: o.x, ty: o.y)
        }
        let a = cos(rotation) * scale, b = sin(rotation) * scale
        return CGAffineTransform(a: a, b: b, c: -b, d: a,
                                 tx: viewSize.width / 2 - (focus.x * a - focus.y * b),
                                 ty: viewSize.height / 2 - (focus.x * b + focus.y * a))
    }

    public func place(_ imagePoint: CGPoint, imageSize: CGSize, viewSize: CGSize) -> CGPoint {
        imagePoint.applying(frame(imageSize: imageSize, viewSize: viewSize))
    }

    /* The inverse — a touch, back to the image pixel under it. This is the
       whole interaction path: finger -> image pixel -> (spatial reference) ->
       coordinate -> Bubble Engine. */
    public func imagePoint(fromView point: CGPoint, imageSize: CGSize, viewSize: CGSize) -> CGPoint? {
        guard scale > 0 else { return nil }
        return point.applying(frame(imageSize: imageSize, viewSize: viewSize).inverted())
    }

    private static func axisOrigin(scaledLength: CGFloat, viewLength: CGFloat, focus: CGFloat) -> CGFloat {
        guard scaledLength > viewLength else { return (viewLength - scaledLength) / 2 }
        return min(0, max(viewLength - scaledLength, viewLength / 2 - focus))
    }
}
