import SwiftUI

struct ContentView: View {
    @ObservedObject var session: WatchSessionManager
    @ObservedObject private var maps: WatchMapStore

    /* The store publishes on its own schedule (a file lands, a manifest is
       adopted), so the view observes it alongside the session rather than
       waiting for the next Scene revision to notice. */
    init(session: WatchSessionManager) {
        _session = ObservedObject(wrappedValue: session)
        _maps = ObservedObject(wrappedValue: session.maps)
    }

    var body: some View {
        Group {
            if let scene = session.scene {
                /* The numbers face stays page one and keeps LOCK a single tap
                   away. The lite map is a second page rather than a replacement
                   or a background: it is a picture of a hole, and it earns the
                   whole screen when it is the thing being looked at. */
                TabView {
                    ShotView(scene: scene, stale: session.state == .stale, pending: session.pendingCommands, rejection: session.lastRejection, send: session.send, dismissRejection: session.dismissRejection)
                    if let holeNumber = scene.hole?.number {
                        HoleMapPage(
                            scene: scene,
                            map: maps.hole(holeNumber, courseKey: scene.course?.key),
                            player: session.playerPoint,
                            deliveryHint: deliveryHint(for: scene)
                        )
                    }
                }
                .tabViewStyle(.page)
            } else {
                VStack(spacing: 7) {
                    Text("CLARITY CADDY").font(.caption2.weight(.semibold)).foregroundStyle(.mint)
                    Text("Start a round\non iPhone").font(.headline).multilineTextAlignment(.center)
                }
                .padding()
            }
        }
        .containerBackground(.black, for: .navigation)
    }

    /* Says which of the three honest reasons applies instead of one blank
       "no map" for all of them: nothing sent, still arriving, or a package for
       a course that is not the one being played. */
    private func deliveryHint(for scene: WatchScene) -> String {
        guard let courseKey = scene.course?.key, !courseKey.isEmpty else { return "No hole map for this round" }
        guard let installed = maps.installed else { return "Waiting for hole maps\nfrom iPhone" }
        guard installed.manifest.courseKey == courseKey else { return "Hole maps are for\nanother course" }
        if !installed.isComplete { return "Hole maps arriving…\n\(installed.readyHoles.count) of \(installed.manifest.holes.count)" }
        return "This hole has no map"
    }
}
