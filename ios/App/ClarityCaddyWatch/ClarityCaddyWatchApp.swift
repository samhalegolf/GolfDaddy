import SwiftUI

@main
struct ClarityCaddyWatchApp: App {
    @StateObject private var session = WatchSessionManager()

    var body: some Scene {
        WindowGroup {
            ContentView(session: session)
        }
    }
}
