import SwiftUI

@main
struct ClarityCaddyWatchApp: App {
    @StateObject private var session = WatchSessionManager()

    var body: some Scene {
        WindowGroup {
            #if DEBUG
            if CommandLine.arguments.contains("-fixture") {
                FixtureHarness()
            } else {
                ContentView(session: session)
            }
            #else
            ContentView(session: session)
            #endif
        }
    }
}
