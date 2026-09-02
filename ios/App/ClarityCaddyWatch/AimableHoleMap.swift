import SwiftUI
import WatchBubbleEngine

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

    @State private var state = WatchPlayState()
    @State private var camera: WatchMapCamera?
    @State private var dragging = false
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
            .gesture(aimGesture(viewSize: viewSize), including: canAim ? .all : .subviews)
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
                syncFromScene(viewSize: viewSize)
            }
            .onChange(of: sceneTarget) { _, _ in
                /* The phone moved the target, or corrected ours. Not while a
                   finger is down: the player's own drag wins until they lift,
                   and the correction lands on the next Scene after that. */
                if !dragging { syncFromScene(viewSize: viewSize) }
            }
        }
    }

    // MARK: - Interaction

    private func aimGesture(viewSize: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                guard canAim, let bag, let profile else { return }
                dragging = true
                guard let coordinate = coordinate(fromView: value.location, viewSize: viewSize) else { return }
                state.moveTarget(to: coordinate, bag: bag, profile: profile)
                follow(viewSize: viewSize)
            }
            .onEnded { _ in
                dragging = false
                /* One command, now, with where the target actually landed. */
                if let target = state.target { onAim(target) }
                /* And settle the framing, which was held still through the
                   drag on purpose. */
                withAnimation(.easeOut(duration: 0.25)) {
                    camera = restingCamera(viewSize: viewSize)
                }
            }
    }

    /* Pans to keep the Bubble in the comfort rect while the finger moves — pan
       only, never zoom. See WatchMapCamera.following. */
    private func follow(viewSize: CGSize) {
        guard let ring = state.bubble?.ring, !ring.isEmpty else { return }
        let points = ring.compactMap { imagePoint(lat: $0.lat, lng: $0.lng) }
        guard let first = points.first else { return }
        var box = CGRect(origin: first, size: .zero)
        points.dropFirst().forEach { box = box.union(CGRect(origin: $0, size: .zero)) }
        camera = (camera ?? restingCamera(viewSize: viewSize)).following(region: box, viewSize: viewSize)
    }

    /* The Scene is the truth when the wrist is not aiming: adopt its target and
       compute against it, so the map shows the wrist's own Bubble for the shot
       the phone has placed. */
    private func syncFromScene(viewSize: CGSize) {
        guard canAim, let bag, let profile,
              let fix = player, let lat = fix.lat, let lng = fix.lng else { return }
        state.update(player: Coordinate(lat: lat, lng: lng))
        guard let target = sceneTarget, let tLat = target.lat, let tLng = target.lng else { return }
        state.moveTarget(to: Coordinate(lat: tLat, lng: tLng), bag: bag, profile: profile)
        camera = restingCamera(viewSize: viewSize)
    }

    // MARK: - Framing

    /* PLAY framing, the same as the read-only map page uses.
       `WatchMapCamera.resting` fits a whole span with padding and is right for a
       hole nobody is standing on; on a par 5 it draws the map 28pt wide with
       black bars down 84% of the screen, because the bake is 1:7.7 and this
       screen is 1:1.2. `play` fills the screen and shows the part being played,
       and still fits both ends when the shot is short enough. */
    private func restingCamera(viewSize: CGSize) -> WatchMapCamera {
        WatchMapCamera.play(
            player: imagePoint(player),
            target: imagePoint(currentTarget) ?? imagePoint(green),
            imageSize: imageSize, viewSize: viewSize)
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
