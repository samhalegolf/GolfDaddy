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

    @State private var state = WatchPlayState()
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
            .clipped()
            .contentShape(Rectangle())
            .gesture(tapGesture(viewSize: viewSize), including: canAim ? .all : .subviews)
            .gesture(aimGesture(viewSize: viewSize), including: canAim ? .all : .subviews)
            .simultaneousGesture(swipeGesture, including: canAim ? .all : .subviews)
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
                guard canAim, let bag, let profile,
                      let coordinate = coordinate(fromView: value.location, viewSize: viewSize) else { return }
                state.moveTarget(to: coordinate, bag: bag, profile: profile)
                if let target = state.target { onAim(target) }
            }
    }

    /* The page swipe, recognised here because nothing above this view can see
       it once the aim gestures are attached. Only a touch that was never
       picked up by the press-and-hold counts, and only a decisive sideways
       one: a rightward travel of 50pt that outruns its vertical drift. */
    private var swipeGesture: some Gesture {
        DragGesture(minimumDistance: 24)
            .onChanged { _ in
                if dragging { swipeCandidate = false } else if !swipeCandidate { swipeCandidate = true }
            }
            .onEnded { value in
                defer { swipeCandidate = false }
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
                    if !dragging { WKInterfaceDevice.current().play(.click) }
                    dragging = true
                    swipeCandidate = false
                case .second(true, let drag?):
                    dragging = true
                    fingerAt = drag.location
                    if let coordinate = coordinate(fromView: drag.location, viewSize: viewSize) {
                        state.moveTarget(to: coordinate, bag: bag, profile: profile)
                    }
                    updateEdgePan(viewSize: viewSize)
                default:
                    return
                }
            }
            .onEnded { _ in
                guard dragging else { return }
                dragging = false
                fingerAt = nil
                stopEdgePan()
                /* One command, now, with where the target actually landed. */
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
        let direction = WatchMapCamera.edgeDirection(of: fingerAt, viewSize: viewSize)
        guard direction != .zero else { stopEdgePan(); return }
        guard edgePan == nil else { return }
        edgePan = Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(WatchMapCamera.edgeDwell * 1_000_000_000))
            let tick: TimeInterval = 1.0 / 30
            while !Task.isCancelled {
                guard let finger = self.fingerAt, self.dragging else { return }
                let direction = WatchMapCamera.edgeDirection(of: finger, viewSize: viewSize)
                guard direction != .zero else { return }
                let step = WatchMapCamera.edgePanSpeed * tick
                let current = self.camera ?? self.restingCamera(viewSize: viewSize)
                self.camera = current.panned(byScreen: CGVector(dx: direction.dx * step, dy: direction.dy * step),
                                             imageSize: self.imageSize)
                if let bag = self.bag, let profile = self.profile,
                   let coordinate = self.coordinate(fromView: finger, viewSize: viewSize) {
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
       player may fall off the bottom — the aim line still reaches the edge
       and pivots as the target moves, which is what says the origin is a
       fixed point. `play` (player low, hole ahead) remains only for a hole
       with no target at all, where there is no Bubble to frame. */
    private func restingCamera(viewSize: CGSize) -> WatchMapCamera {
        if let ring = state.bubble?.ring, let box = imageBox(of: ring) {
            return WatchMapCamera.bubble(centre: CGPoint(x: box.midX, y: box.midY), extent: box.size,
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
