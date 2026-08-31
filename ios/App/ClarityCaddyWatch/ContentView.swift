import SwiftUI

struct ContentView: View {
    @ObservedObject var session: WatchSessionManager

    var body: some View {
        Group {
            if let scene = session.scene {
                ShotView(scene: scene, stale: session.state == .stale)
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
}
