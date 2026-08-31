import Foundation
import WatchConnectivity

@MainActor
final class WatchSessionManager: NSObject, ObservableObject {
    enum State { case noRound, live, stale }

    @Published private(set) var scene: WatchScene?
    @Published private(set) var state: State = .noRound
    private var session: WCSession?

    override init() {
        super.init()
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
        self.session = session
    }

    private func receive(context: [String: Any]) {
        guard let raw = context["scene"], JSONSerialization.isValidJSONObject(raw),
              let data = try? JSONSerialization.data(withJSONObject: raw),
              let incoming = try? JSONDecoder().decode(WatchScene.self, from: data),
              incoming.isSupported else { return }
        guard incoming.hasRound else { scene = nil; state = .noRound; return }
        if let current = scene, current.roundId == incoming.roundId, incoming.revision < current.revision { return }
        scene = incoming
        state = .live
    }
}

extension WatchSessionManager: WCSessionDelegate {
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        let context = session.receivedApplicationContext
        Task { @MainActor [weak self] in
            self?.receive(context: context)
            if self?.scene != nil && activationState != .activated { self?.state = .stale }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        Task { @MainActor [weak self] in self?.receive(context: applicationContext) }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        Task { @MainActor [weak self] in
            guard let self, self.scene != nil else { return }
            self.state = session.isReachable ? .live : .stale
        }
    }
}
