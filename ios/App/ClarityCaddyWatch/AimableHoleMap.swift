import SwiftUI
import WatchBubbleEngine
import WatchKit

/* The map you can aim on.
 *
 * The whole interaction path, in one place:
 *
 *     finger  ->  view point
 *             ->  image pixel        (WatchMapCamera.imagePoint)
 *             ->  coordinate         (WatchMapSpatialReference.coordinate)
 *             ->  Bubble             (WatchPlayState.moveTarget)
 *             ->  drawn immediately
 *     lift    ->  AIM_AT to the phone, once
 *
 * `WatchMapSpatialReference.coordinate(atImageX:y:)` was written as the half
 * that proves the transform round-trips and was marked "only used for
 * diagnostics today". This is the day it becomes load-bearing.
 *
 * AIMING ONLY. Dragging moves the TARGET. Nothing here can move the player —
 * that comes from GPS and only from GPS. Tap-to-place is not part of geo-mapped
 * play, and a drag that could relocate the golfer would be exactly that.
 */
struct AimableHoleMap: View {
    let map: WatchMapStore.LoadedHoleMap
    let player: WatchScene.GeoPoint?
    let green: WatchScene.GeoPoint?
    /// The Scene's target — what is drawn while the wrist is not aiming, and
    /// what a drag starts from.
    let sceneTarget: WatchScene.GeoPoint?
    let bag: WatchBagSnapshot?
    let profile: WatchBubbleProfile?
    /// Whether the wrist may compute at all (the version handshake). False and
    /// the map is a picture: no drag, no local Bubble, the phone's numbers.
    let canAim: Bool
    let onAim: (Coordinate) -> Void
    /// A quick swipe towards the numbers page. The TabView cannot see a swipe
    /// through this view's own gestures, so the map reports it and the page
    /// state does the rest — which, while the shot is locked, is the UNLOCK.
    var onSwipeBack: () -> Void = {}
    /// Set while a shot is locked: the bottom strip of the screen is UNLOCK.
    /// A thumb going for the button often lands just under it, or drags, and
    /// this view's own aim gestures would otherwise take that as a re-aim. A
    /// tap, a swipe or a press-and-drag that STARTS in the strip lets the
    /// shot go instead. It has to live here: an overlay above this view never
    /// sees those touches once the aim gestures are attached.
    var bottomEdgeUnlock: (() -> Void)? = nil
    /// The readout drawn just above the unlock band.
    var holeNumber: Int? = nil
    var distanceM: Double? = nil

    /* The three bands of a locked map, top to bottom:
         flag    the demo banner / clock row. Nothing aims from here.
         aim     tap: the Bubble goes there, the camera stays put.
                 press-and-drag: the Bubble follows, and the camera pans only
                 when the finger reaches the edge.
         unlock  one UNLOCK across the bottom; split Unlock | Reset once the
                 Bubble has been moved from where the lock put it. */
    static let topBandM: CGFloat = 30
    static let bottomEdgeM: CGFloat = 40
    /// The "HOLE n · distance" readout that sits on top of the band.
    static let readoutM: CGFloat = 38

    @State private var state = WatchPlayState()
    @State private var edgeTouch = false
    @State private var topTouch = false
    /// A touch on the band moved: its button must not fire on release.
    @State private var bandDragged = false
    /// When the Bubble was last tapped or dragged. A slide on the band soon
    /// after is the tail of that interaction, never an unlock.
    @State private var lastAimAt: Date?
    /// Where the lock put the Bubble, so Reset has somewhere to go back to.
    /// Kept by the session (WatchSessionManager.aimOrigin) so a relaunch
    /// cannot replace it with an aim the player has since moved.
    var origin: Coordinate? = nil
    @State private var camera: WatchMapCamera?
    @State private var dragging = false
    /// Where the finger is, in view points, while it is down. Read by the edge
    /// pan so a map creeping under a held finger keeps the target under it.
    @State private var fingerAt: CGPoint?
    @State private var edgePan: Task<Void, Never>?
    /// True from the first movement of a touch until a press-and-hold claims
    /// it. A touch that ends still a candidate, having travelled sideways, was
    /// a swipe.
    @State private var swipeCandidate = false
    /// Zoom, driven by the Digital Crown. Held separately from the camera so a
    /// resting re-fit does not fight a zoom the player just chose.
    @State private var crownZoom: Double = 1
    @FocusState private var crownFocused: Bool

    private var imageSize: CGSize {
        CGSize(width: map.spatialReference.imageWidth, height: map.spatialReference.imageHeight)
    }

    var body: some View {
        GeometryReader { proxy in
            let viewSize = proxy.size
            let camera = camera ?? restingCamera(viewSize: viewSize)
            let ring = state.bubble?.ring ?? []

            ZStack(alignment: .topLeading) {
                Image(uiImage: map.image)
                    .resizable()
                    .interpolation(.medium)
                    .frame(width: imageSize.width * camera.scale, height: imageSize.height * camera.scale)
                    .offset(x: camera.origin(imageSize: imageSize, viewSize: viewSize).x,
                            y: camera.origin(imageSize: imageSize, viewSize: viewSize).y)

                Canvas { context, _ in
                    let place = { (p: CGPoint) in camera.place(p, imageSize: imageSize, viewSize: viewSize) }
                    let playerAt = imagePoint(player).map(place)
                    let targetAt = imagePoint(currentTarget).map(place)

                    /* Laying up, exactly as the phone draws it (painter.js
                       drawShot): the hole's fairway line, faint, and a dotted
                       guide from the Bubble on to the green with how far is
                       left. Only when the green is out of the bag's reach and
                       the Bubble is genuinely short of it - the same three
                       tests, so the two surfaces show it at the same moments. */
                    if let layup = layupGuide() {
                        let line = layup.line.compactMap { imagePoint(lat: $0.lat, lng: $0.lng) }.map(place)
                        if line.count >= 2 {
                            var path = Path()
                            path.move(to: line[0])
                            line.dropFirst().forEach { path.addLine(to: $0) }
                            context.stroke(path, with: .color(Color(red: 0.92, green: 1, blue: 0.95).opacity(0.35)),
                                           style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round, dash: [1, 7]))
                        }
                        if let from = imagePoint(lat: layup.from.lat, lng: layup.from.lng).map(place),
                           let to = imagePoint(lat: layup.green.lat, lng: layup.green.lng).map(place) {
                            let dx = to.x - from.x, dy = to.y - from.y
                            let length = max(hypot(dx, dy), 1)
                            let trim = min(10, length * 0.05)
                            var guide = Path()
                            guide.move(to: CGPoint(x: from.x + dx / length * trim, y: from.y + dy / length * trim))
                            guide.addLine(to: CGPoint(x: to.x - dx / length * trim, y: to.y - dy / length * trim))
                            context.stroke(guide, with: .color(.white.opacity(0.52)),
                                           style: StrokeStyle(lineWidth: 1.8, lineCap: .round, dash: [2, 8]))
                            let label = Text("Green \(Int(layup.gapM.rounded())) m")
                                .font(.system(size: 10, weight: .bold, design: .rounded))
                            /* The phone puts this halfway to the green; on a
                               wrist that is usually off the glass. So: just
                               past the Bubble along the guide, kept on screen. */
                            let at = Self.guideLabelPoint(from: from, to: to, viewSize: viewSize)
                            for o in [CGPoint(x: 0.8, y: 0.8), CGPoint(x: -0.8, y: 0.8), CGPoint(x: 0.8, y: -0.8), CGPoint(x: -0.8, y: -0.8)] {
                                context.draw(label.foregroundStyle(.black.opacity(0.75)), at: CGPoint(x: at.x + o.x, y: at.y + o.y))
                            }
                            context.draw(label.foregroundStyle(.white.opacity(0.9)), at: at)
                        }
                    }

                    if let playerAt, let targetAt {
                        var line = Path()
                        line.move(to: playerAt)
                        line.addLine(to: targetAt)
                        context.stroke(line, with: .color(.mint.opacity(0.75)),
                                       style: StrokeStyle(lineWidth: 1.5, dash: [3, 3]))
                    }

                    /* The Bubble the WRIST computed, drawn as its real shape
                       rather than an ellipse approximating it — every one of
                       the 168 points is a coordinate the engine produced. */
                    if ring.count >= 3 {
                        var path = Path()
                        let points = ring.compactMap { imagePoint(lat: $0.lat, lng: $0.lng) }.map(place)
                        if points.count >= 3 {
                            path.move(to: points[0])
                            points.dropFirst().forEach { path.addLine(to: $0) }
                            path.closeSubpath()
                            context.fill(path, with: .color(.mint.opacity(0.22)))
                            context.stroke(path, with: .color(.mint), lineWidth: 1.5)
                        }
                    }

                    /* The club, live, inside the Bubble it was chosen for —
                       so the answer is read where the eye already is, not
                       off a strip somewhere else. Name and the distance to
                       the target, over a dark ghost so it reads on any
                       ground. */
                    if let bubble = state.bubble, let at = imagePoint(lat: bubble.centre.lat, lng: bubble.centre.lng).map(place) {
                        drawLabel(context, club: bubble.club.club, metres: bubble.targetDistanceM, at: at)
                    }

                    if let greenAt = imagePoint(green).map(place) {
                        let rect = CGRect(x: greenAt.x - 6, y: greenAt.y - 6, width: 12, height: 12)
                        context.stroke(Path(ellipseIn: rect), with: .color(.mint.opacity(0.9)), lineWidth: 1.8)
                    }
                    if let targetAt {
                        /* Bigger while it is being dragged: the thing under the
                           finger should be visible beside the finger. */
                        let r: CGFloat = dragging ? 6 : 4
                        let rect = CGRect(x: targetAt.x - r, y: targetAt.y - r, width: r * 2, height: r * 2)
                        context.fill(Path(ellipseIn: rect), with: .color(.mint))
                        context.stroke(Path(ellipseIn: rect), with: .color(.black.opacity(0.7)), lineWidth: 1)
                    }
                    if let playerAt {
                        let rect = CGRect(x: playerAt.x - 4.5, y: playerAt.y - 4.5, width: 9, height: 9)
                        context.fill(Path(ellipseIn: rect), with: .color(.white))
                        context.stroke(Path(ellipseIn: rect), with: .color(.black.opacity(0.8)), lineWidth: 1)
                    }
                }
            }
            /* topLeading for the same reason as HoleMapView: the image is
               taller than the view at play scale, and a centring frame would
               slide it off the drawn content. */
            .frame(width: viewSize.width, height: viewSize.height, alignment: .topLeading)
            /* Past the bake's edge (the Bubble framing may look there):
               the map's own dark green, so it reads as more rough. */
            .background(Color(red: 0.16, green: 0.29, blue: 0.19))
            .clipped()
            .contentShape(Rectangle())
            .gesture(tapGesture(viewSize: viewSize), including: canAim ? .all : .subviews)
            .gesture(aimGesture(viewSize: viewSize), including: canAim ? .all : .subviews)
            .simultaneousGesture(swipeGesture(viewSize: viewSize), including: canAim ? .all : .subviews)
            .overlay(alignment: .bottom) {
                if bottomEdgeUnlock != nil { band(viewSize: viewSize) }
            }
            .focusable(canAim)
            .focused($crownFocused)
            .digitalCrownRotation($crownZoom, from: 0.5, through: 3.0, by: 0.05,
                                  sensitivity: .low, isContinuous: false, isHapticFeedbackEnabled: true)
            .onChange(of: crownZoom) { _, zoom in
                guard canAim else { return }
                var next = self.camera ?? restingCamera(viewSize: viewSize)
                next.scale = min(max(CGFloat(zoom), 0.5), WatchMapCamera.maximumScale)
                self.camera = next
            }
            .onAppear {
                crownFocused = canAim
                settle(viewSize: viewSize)
            }
            /* A new hole is a new shot: everything about the old one goes, and
               the Bubble is placed afresh — from the Scene if the phone has
               one, otherwise by the wrist's own default rule. */
            .onChange(of: map.holeNumber) { _, hole in
                state.enter(hole: hole)
                settle(viewSize: viewSize)
            }
            /* The Scene's target is adopted only while the wrist has none of
               its own. Once the wrist has placed one — by its default rule or
               by a drag — a Scene revision neither moves it nor re-frames the
               map. The wrist is driving; a picture that re-fits itself around
               the phone on every revision is the phone driving by proxy. */
            .onChange(of: sceneTarget) { _, _ in
                guard !dragging, state.target == nil else { return }
                settle(viewSize: viewSize)
            }
            /* The bag can arrive after the page: the first moment the wrist
               may compute is the moment to place its Bubble. */
            .onChange(of: canAim) { _, may in
                crownFocused = may
                if may, state.target == nil { settle(viewSize: viewSize) }
            }
            /* A fresh fix moves the player and re-sizes the Bubble for the new
               distance. It never moves the target and never moves the camera:
               walking towards a target you placed is the point. The first fix
               is the exception — nothing could be placed before it. */
            .onChange(of: player) { _, _ in
                guard !dragging else { return }
                if state.player == nil { settle(viewSize: viewSize); return }
                guard let bag, let profile, let fix = player, let lat = fix.lat, let lng = fix.lng else { return }
                state.update(player: Coordinate(lat: lat, lng: lng))
                if let target = state.target { state.moveTarget(to: target, bag: bag, profile: profile) }
            }
        }
    }

    // MARK: - Interaction

    /* A tap puts the target under the finger, and sends it. Nothing moves but
       the target: what is being placed stays where it is being placed. */
    private func tapGesture(viewSize: CGSize) -> some Gesture {
        SpatialTapGesture()
            .onEnded { value in
                if inBottomEdge(value.location, viewSize) { bandAction(atX: value.location.x, viewSize: viewSize); return }
                if inTopBand(value.location) { return }
                guard canAim, let bag, let profile,
                      let coordinate = coordinate(fromView: value.location, viewSize: viewSize) else { return }
                /* Pin the framing first. With no camera of its own the map
                   re-fits the Bubble on every frame, so moving the Bubble
                   used to drag the whole picture after it. */
                if camera == nil { camera = restingCamera(viewSize: viewSize) }
                state.moveTarget(to: coordinate, bag: bag, profile: profile)
                lastAimAt = Date()
                if let target = state.target { onAim(target) }
            }
    }

    /* The page swipe, recognised here because nothing above this view can see
       it once the aim gestures are attached. Only a touch that was never
       picked up by the press-and-hold counts, and only a decisive sideways
       one: a rightward travel of 50pt that outruns its vertical drift. */
    private func inBottomEdge(_ point: CGPoint, _ viewSize: CGSize) -> Bool {
        bottomEdgeUnlock != nil && point.y >= viewSize.height - Self.bottomEdgeM
    }
    /* The readout, then the band: one UNLOCK, or Unlock | Reset. Real buttons
       for the eye and for Double Tap; the map's gestures above route any touch
       that starts down here to the same bandAction. */
    @ViewBuilder
    private func band(viewSize: CGSize) -> some View {
        VStack(spacing: 4) {
            HStack(spacing: 5) {
                Text(holeNumber.map { "HOLE \($0)" } ?? "HOLE")
                    .font(.caption2.weight(.semibold)).foregroundStyle(.white.opacity(0.85))
                if let distanceM {
                    Text("\(Int(distanceM.rounded())) m").font(.caption2.monospacedDigit().weight(.bold)).foregroundStyle(.mint)
                }
            }
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(.black.opacity(0.55), in: Capsule())
            .allowsHitTesting(false)
            HStack(spacing: 0) {
                /* Half-transparent, edge to edge: the map shows through, and
                   the whole bottom of the glass reads as the button it is.
                   Split, each half has its own colour - mint lets the shot
                   go, amber puts the Bubble back - and smaller words. */
                bandButton(moved ? "Unlock" : "UNLOCK", symbol: moved ? nil : "lock.open.fill", tint: .mint, small: moved, primary: true,
                           slide: { slideUnlock(viewSize) }) { bottomEdgeUnlock?() }
                if moved {
                    bandButton("Reset", symbol: nil, tint: .orange, small: true, primary: false,
                               slide: { slideUnlock(viewSize) }) { resetAim(viewSize: viewSize) }
                }
            }
            .frame(height: Self.bottomEdgeM)
            .frame(maxWidth: .infinity)
        }
        .animation(.easeOut(duration: 0.15), value: moved)
        .ignoresSafeArea()
    }

    @ViewBuilder
    private func bandButton(_ title: String, symbol: String?, tint: Color, small: Bool, primary: Bool,
                            slide: @escaping () -> Void, action: @escaping () -> Void) -> some View {
        let button = Button(action: {
            guard !bandDragged else { return }
            action()
        }) {
            /* Split halves are words only, and shrink rather than truncate:
               "Unlock" has to fit half a 41mm screen at any text size. */
            Group {
                if let symbol { Label(title, systemImage: symbol) } else { Text(title) }
            }
                .font(small ? .caption2.weight(.heavy) : .caption.weight(.heavy))
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .padding(.horizontal, 6)
                .foregroundStyle(.white)
                .shadow(color: .black.opacity(0.5), radius: 2)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(.bottom, 6)
                .background(tint.opacity(0.5))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        /* A slide never presses the button it crosses. It may unlock - the
           swipe-off-the-bottom the band was given for - but only when it
           cannot be the tail of aiming (slideUnlock decides). Reset is
           tap-only. */
        .simultaneousGesture(DragGesture(minimumDistance: 6)
            .onChanged { _ in bandDragged = true }
            .onEnded { _ in
                slide()
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { bandDragged = false }
            })
        if primary, #available(watchOS 11.0, *) { button.handGestureShortcut(.primaryAction) } else { button }
    }

    /* The part of the screen a Bubble can be dragged in. While the bands are
       up (a locked shot) that is between them: the edge pan starts at the
       unlock band's top line - or the flag band's bottom one - rather than at
       the glass, and the Bubble is held inside, so it is never dragged out of
       sight under the band it would otherwise disappear beneath. */
    private func aimArea(_ viewSize: CGSize) -> CGRect {
        guard bottomEdgeUnlock != nil else { return CGRect(origin: .zero, size: viewSize) }
        let top = Self.topBandM
        /* Above the readout as well as the band, so a Bubble parked at the
           bottom of its range still shows its club and distance. */
        let height = max(viewSize.height - top - Self.bottomEdgeM - Self.readoutM, 1)
        return CGRect(x: 0, y: top, width: viewSize.width, height: height)
    }

    private func inAimArea(_ point: CGPoint, _ viewSize: CGSize) -> CGPoint {
        let area = aimArea(viewSize)
        return CGPoint(x: min(max(point.x, area.minX), area.maxX),
                       y: min(max(point.y, area.minY + 2), area.maxY - 2))
    }

    private func edgeDirection(of point: CGPoint, _ viewSize: CGSize) -> CGVector {
        let area = aimArea(viewSize)
        return WatchMapCamera.edgeDirection(of: CGPoint(x: point.x - area.minX, y: point.y - area.minY), viewSize: area.size)
    }

    /* A slide on the unlock band lets the shot go - unless it could be part
       of aiming: a Bubble being dragged, one tapped or dragged in the last two
       seconds, or a Bubble sitting down by the band where a thumb working it
       would naturally run on to the band. */
    private func slideUnlock(_ viewSize: CGSize) {
        guard !dragging else { return }
        if let lastAimAt, Date().timeIntervalSince(lastAimAt) < 2.0 { return }
        guard !bubbleNearBand(viewSize) else { return }
        bottomEdgeUnlock?()
    }

    /* The Bubble's CENTRE, not its ring: a Driver's ring reaches well down
       the screen from a centre in the middle, and that is the ordinary
       resting case the slide is meant to work in. Near = its centre in the
       bottom quarter of the aiming area or lower. */
    private func bubbleNearBand(_ viewSize: CGSize) -> Bool {
        let cam = camera ?? restingCamera(viewSize: viewSize)
        let centre = state.bubble.flatMap { imagePoint(lat: $0.centre.lat, lng: $0.centre.lng) } ?? imagePoint(currentTarget)
        guard let centre else { return false }
        let y = cam.place(centre, imageSize: imageSize, viewSize: viewSize).y
        let area = aimArea(viewSize)
        return y >= area.maxY - area.height * 0.25
    }

    private func inTopBand(_ point: CGPoint) -> Bool { point.y < Self.topBandM }

    /// The Bubble has been moved off where the lock put it (more than a metre).
    private var moved: Bool {
        guard let origin, let now = state.target else { return false }
        return WatchHoleFlow.metres(origin, now).map { $0 > 3 } ?? false
    }

    /* The band, whichever way it was reached - its buttons, or a touch the
       map's own gestures caught first. Split only once there is something to
       reset: left half lets the shot go, right half puts the Bubble back. */
    private func bandAction(atX x: CGFloat, viewSize: CGSize) {
        if moved && x > viewSize.width / 2 { resetAim(viewSize: viewSize) }
        else { bottomEdgeUnlock?() }
    }

    private func resetAim(viewSize: CGSize) {
        guard let origin, let bag, let profile else { return }
        state.moveTarget(to: origin, bag: bag, profile: profile)
        onAim(origin)
        camera = restingCamera(viewSize: viewSize)
        WKInterfaceDevice.current().play(.click)
    }

    private func swipeGesture(viewSize: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 24)
            .onChanged { _ in
                if dragging { swipeCandidate = false } else if !swipeCandidate { swipeCandidate = true }
            }
            .onEnded { value in
                defer { swipeCandidate = false }
                /* A slide that starts on the band: an unlock only when it
                   cannot be part of aiming (slideUnlock). */
                if inBottomEdge(value.startLocation, viewSize) { slideUnlock(viewSize); return }
                guard swipeCandidate, !dragging else { return }
                let travel = value.translation
                guard travel.width > 50, abs(travel.width) > abs(travel.height) * 1.5 else { return }
                onSwipeBack()
            }
    }

    /* Press, hold a beat, then drag: the target follows the finger.
     *
     * The hold is what lets this page be swiped away. A drag gesture that
     * started on touch-down took every horizontal swipe for itself, so the
     * page could never be swiped back to the numbers — and swiping back is
     * the UNLOCK. A quick swipe fails the press (it travels too far, too
     * soon) and falls through to the TabView; a finger that stays put for
     * 0.2s has picked the target up, and a click says so.
     *
     * The map itself never moves under the finger except at the very edge —
     * see `edgePan`. */
    private func aimGesture(viewSize: CGSize) -> some Gesture {
        LongPressGesture(minimumDuration: 0.2, maximumDistance: 12)
            .sequenced(before: DragGesture(minimumDistance: 0))
            .onChanged { value in
                guard canAim, let bag, let profile else { return }
                switch value {
                case .first:
                    return
                case .second(true, nil):
                    if camera == nil { camera = restingCamera(viewSize: viewSize) }
                    if !dragging { WKInterfaceDevice.current().play(.click) }
                    dragging = true
                    swipeCandidate = false
                case .second(true, let drag?) where edgeTouch || inBottomEdge(drag.startLocation, viewSize):
                    /* Picked up in the unlock band: not an aim. */
                    edgeTouch = true
                    dragging = false
                case .second(true, let drag?) where topTouch || inTopBand(drag.startLocation):
                    /* Picked up in the flag band: nothing aims from there. */
                    topTouch = true
                    dragging = false
                case .second(true, let drag?):
                    dragging = true
                    fingerAt = drag.location
                    if let coordinate = coordinate(fromView: inAimArea(drag.location, viewSize), viewSize: viewSize) {
                        state.moveTarget(to: coordinate, bag: bag, profile: profile)
                    }
                    updateEdgePan(viewSize: viewSize)
                default:
                    return
                }
            }
            .onEnded { _ in
                if topTouch { topTouch = false; return }
                if edgeTouch {
                    /* Picked up on the band and moved: the same rule as a
                       swipe there. */
                    edgeTouch = false
                    slideUnlock(viewSize)
                    return
                }
                guard dragging else { return }
                dragging = false
                fingerAt = nil
                stopEdgePan()
                /* One command, now, with where the target actually landed. */
                lastAimAt = Date()
                if let target = state.target { onAim(target) }
                /* The framing STAYS. A re-fit here slid the map under a
                   player who had just put the target where they wanted it,
                   and that slide read as the origin wandering. */
            }
    }

    /* The edge pan: dwell, then creep.
     *
     * Starts a pan the moment the finger enters the edge inset and stops it
     * the moment the finger leaves — but the pan itself does nothing for
     * `edgeDwell` first, so a finger sweeping across to the far side does not
     * set the map moving on its way past. After the dwell the map creeps at
     * `edgePanSpeed` in the edge's direction, and on every step the target is
     * put back under the finger, because the world under a held finger has
     * moved and the target must go with it. */
    private func updateEdgePan(viewSize: CGSize) {
        guard let fingerAt else { stopEdgePan(); return }
        let direction = edgeDirection(of: fingerAt, viewSize)
        guard direction != .zero else { stopEdgePan(); return }
        guard edgePan == nil else { return }
        edgePan = Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(WatchMapCamera.edgeDwell * 1_000_000_000))
            let tick: TimeInterval = 1.0 / 30
            while !Task.isCancelled {
                guard let finger = self.fingerAt, self.dragging else { return }
                let direction = self.edgeDirection(of: finger, viewSize)
                guard direction != .zero else { return }
                let step = WatchMapCamera.edgePanSpeed * tick
                let current = self.camera ?? self.restingCamera(viewSize: viewSize)
                self.camera = current.panned(byScreen: CGVector(dx: direction.dx * step, dy: direction.dy * step),
                                             imageSize: self.imageSize)
                if let bag = self.bag, let profile = self.profile,
                   let coordinate = self.coordinate(fromView: self.inAimArea(finger, viewSize), viewSize: viewSize) {
                    self.state.moveTarget(to: coordinate, bag: bag, profile: profile)
                }
                try? await Task.sleep(nanoseconds: UInt64(tick * 1_000_000_000))
            }
        }
    }

    private func stopEdgePan() {
        edgePan?.cancel()
        edgePan = nil
    }

    /* Places the wrist's shot for this hole, and frames it.
     *
     * The Scene's target is taken when the phone has one — after LOCK that is
     * the phone's own default layup, from the same rule. When it has none (a
     * hole just entered, nothing locked yet) the wrist places its own Bubble
     * by the engine's default rule: the green when the bag reaches it, the
     * fairway-line layup when it does not, off the green and route the package
     * carries for this hole. A long hole therefore opens on a Driver Bubble on
     * the fairway line rather than a dashed line to a green nobody can reach.
     *
     * This is the ONLY place the camera is set besides the crown and a drag:
     * on appear, on a new hole, on the first fix, and on the first Scene
     * target while the wrist still has none. Never on a Scene revision. */
    private func settle(viewSize: CGSize) {
        guard canAim, let bag, let profile,
              let fix = player, let lat = fix.lat, let lng = fix.lng else { return }
        state.update(player: Coordinate(lat: lat, lng: lng))
        if let own = state.target {
            /* Re-appearing (the app came back from the background) with a
               target of its own: keep it, refresh the ring for the fix. */
            state.moveTarget(to: own, bag: bag, profile: profile)
        } else if let origin {
            /* A locked shot opens where the lock put it - the same point
               Reset returns to, so a fresh page never reads as moved. */
            state.moveTarget(to: origin, bag: bag, profile: profile)
        } else if let target = sceneTarget, let tLat = target.lat, let tLng = target.lng {
            state.moveTarget(to: Coordinate(lat: tLat, lng: tLng), bag: bag, profile: profile)
        } else if let reference = map.reference {
            state.reset(
                green: Coordinate(lat: reference.green.lat, lng: reference.green.lng),
                route: (reference.playLine?.route ?? []).map { Coordinate(lat: $0.lat, lng: $0.lng) },
                bag: bag, profile: profile)
        }
        camera = restingCamera(viewSize: viewSize)
    }

    // MARK: - Framing

    /* BUBBLE framing: the shot being shaped, with its surroundings. The
       centre is the END OF THE AIM LINE - the geo target - never the middle
       of the Bubble: the engine may sit the Bubble off to one side of the
       target by the player's offset, and the target is what the screen is
       about. The extent is the ring's box measured symmetrically about the
       target, so an offset Bubble still fits whole. The player may fall off
       the bottom - the aim line still reaches the edge and pivots as the
       target moves, which is what says the origin is a fixed point. `play`
       (player low, hole ahead) remains only for a hole with no target at
       all, where there is no Bubble to frame. */
    private func restingCamera(viewSize: CGSize) -> WatchMapCamera {
        if let ring = state.bubble?.ring, let box = imageBox(of: ring) {
            let centre = imagePoint(currentTarget) ?? CGPoint(x: box.midX, y: box.midY)
            let extent = CGSize(width: 2 * max(abs(box.minX - centre.x), abs(box.maxX - centre.x)),
                                height: 2 * max(abs(box.minY - centre.y), abs(box.maxY - centre.y)))
            return WatchMapCamera.bubble(centre: centre, extent: extent,
                                         imageSize: imageSize, viewSize: viewSize)
        }
        if let target = imagePoint(currentTarget) {
            return WatchMapCamera.bubble(centre: target, extent: nominalBubbleExtent,
                                         imageSize: imageSize, viewSize: viewSize)
        }
        return WatchMapCamera.play(player: imagePoint(player), target: imagePoint(green),
                                   imageSize: imageSize, viewSize: viewSize)
    }

    /// A Bubble's worth of image for a target with no computed ring yet:
    /// about a Driver's cluster, 45m by 55m.
    private var nominalBubbleExtent: CGSize {
        let metresPerPixel = map.spatialReference.metresPerPixel ?? 0.5
        return CGSize(width: 45 / metresPerPixel, height: 55 / metresPerPixel)
    }

    private func drawLabel(_ context: GraphicsContext, club: String, metres: Double, at point: CGPoint) {
        let name = Text(club).font(.system(size: 12, weight: .heavy, design: .rounded))
        let distance = Text("\(Int(metres.rounded())) m").font(.system(size: 10, weight: .semibold, design: .rounded).monospacedDigit())
        let nameAt = CGPoint(x: point.x, y: point.y - 12)
        let distanceAt = CGPoint(x: point.x, y: point.y + 11)
        for offset in [CGPoint(x: 0.8, y: 0.8), CGPoint(x: -0.8, y: 0.8), CGPoint(x: 0.8, y: -0.8), CGPoint(x: -0.8, y: -0.8)] {
            context.draw(name.foregroundStyle(.black.opacity(0.85)), at: CGPoint(x: nameAt.x + offset.x, y: nameAt.y + offset.y))
            context.draw(distance.foregroundStyle(.black.opacity(0.85)), at: CGPoint(x: distanceAt.x + offset.x, y: distanceAt.y + offset.y))
        }
        context.draw(name.foregroundStyle(.white), at: nameAt)
        context.draw(distance.foregroundStyle(.white.opacity(0.92)), at: distanceAt)
    }

    private func imageBox(of ring: [Coordinate]) -> CGRect? {
        let points = ring.compactMap { imagePoint(lat: $0.lat, lng: $0.lng) }
        guard let first = points.first else { return nil }
        var box = CGRect(origin: first, size: .zero)
        points.dropFirst().forEach { box = box.union(CGRect(origin: $0, size: .zero)) }
        return box
    }

    // MARK: - Layup guide

    /// Just past the Bubble along the guide to the green, kept on screen.
    static func guideLabelPoint(from: CGPoint, to: CGPoint, viewSize: CGSize) -> CGPoint {
        let dx: CGFloat = to.x - from.x
        let dy: CGFloat = to.y - from.y
        let length: CGFloat = max(hypot(dx, dy), 1)
        let reach: CGFloat = min(length * 0.52, 58)
        let ux: CGFloat = dx / length
        let uy: CGFloat = dy / length
        let rawX: CGFloat = from.x + ux * reach - uy * 12
        let rawY: CGFloat = from.y + uy * reach + ux * 12
        let x: CGFloat = min(max(rawX, 34), viewSize.width - 34)
        let y: CGFloat = min(max(rawY, topBandM + 8), viewSize.height - bottomEdgeM - 30)
        return CGPoint(x: x, y: y)
    }

    /* painter.js drawShot's test, ported: the green is beyond the bag
       (raw > max + 3), the Bubble is a real distance short of it (gap > 4) and
       nearer the player than the green is (raw > playable + 4). The bag's max
       is its longest total, which is what the phone's maxPlayableCarryM is. */
    private func layupGuide() -> (line: [Coordinate], from: Coordinate, green: Coordinate, gapM: Double)? {
        guard let reference = map.reference, let maxM = bag?.maxTotalM, maxM > 0,
              let p = player, let pLat = p.lat, let pLng = p.lng,
              let aim = currentTarget, let aLat = aim.lat, let aLng = aim.lng else { return nil }
        let start = Coordinate(lat: pLat, lng: pLng)
        let centre = state.bubble?.centre ?? Coordinate(lat: aLat, lng: aLng)
        let green = Coordinate(lat: reference.green.lat, lng: reference.green.lng)
        guard let raw = WatchHoleFlow.metres(start, green),
              let playable = WatchHoleFlow.metres(start, centre),
              let gap = WatchHoleFlow.metres(centre, green),
              raw > maxM + 3, gap > 4, raw > playable + 4 else { return nil }
        var line: [Coordinate] = []
        if let playLine = reference.playLine {
            line.append(Coordinate(lat: playLine.tee.lat, lng: playLine.tee.lng))
            line.append(contentsOf: playLine.route.map { Coordinate(lat: $0.lat, lng: $0.lng) })
        }
        line.append(green)
        return (line, centre, green, gap)
    }

    // MARK: - Coordinates

    private var currentTarget: WatchScene.GeoPoint? {
        if let local = state.target { return WatchScene.GeoPoint(lat: local.lat, lng: local.lng) }
        return sceneTarget
    }

    private func imagePoint(_ point: WatchScene.GeoPoint?) -> CGPoint? {
        guard let lat = point?.lat, let lng = point?.lng else { return nil }
        return imagePoint(lat: lat, lng: lng)
    }
    private func imagePoint(lat: Double, lng: Double) -> CGPoint? {
        map.spatialReference.imagePoint(lat: lat, lng: lng)
    }

    private func coordinate(fromView point: CGPoint, viewSize: CGSize) -> Coordinate? {
        let camera = self.camera ?? restingCamera(viewSize: viewSize)
        guard let image = camera.imagePoint(fromView: point, imageSize: imageSize, viewSize: viewSize),
              let geo = map.spatialReference.coordinate(atImageX: image.x, y: image.y) else { return nil }
        return Coordinate(lat: geo.lat, lng: geo.lng)
    }
}
