import CoreLocation
import Foundation
import WatchConnectivity
import WatchKit

@MainActor
final class WatchSessionManager: NSObject, ObservableObject {
    enum State { case noRound, live, stale }

    @Published private(set) var scene: WatchScene?
    @Published private(set) var state: State = .noRound
    @Published private(set) var pendingCommands: [PendingWatchCommand] = []
    @Published private(set) var lastRejection: WatchCommandAcknowledgement?

    private let outboxKey = "CaddyWatchPendingCommandsV1"
    private var session: WCSession?
    private let locationManager = WatchLocationManager()

    override init() {
        super.init()
        restoreOutbox()
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
        self.session = session
    }

    /* LOCK always resolves against the wrist's own GPS when a recent, accurate
       fix exists — the phone can then stay in the bag. It only falls back to
       the phone-authoritative LOCK when the watch has no trustworthy fix. */
    func send(_ type: CaddyWatchCommand.Kind) {
        guard let scene, let roundId = scene.roundId, !roundId.isEmpty, !isPending(type) else { return }
        lastRejection = nil
        var wireType = type
        var payload = CommandPayload()
        if type == .lock, let fix = locationManager.lastFix, let observation = WatchLocationObservation(fix) {
            wireType = .lockAt
            payload = CommandPayload(location: observation)
        }
        let command = CaddyWatchCommand(commandId: UUID().uuidString, roundId: roundId, baseRevision: scene.revision, createdAt: Date().timeIntervalSince1970 * 1000, device: "apple-watch", type: wireType, payload: payload)
        pendingCommands.append(PendingWatchCommand(command: command, status: .pending, attemptCount: 0, lastAttemptAt: nil))
        persistOutbox()
        attempt(commandId: command.commandId)
    }

    func dismissRejection() { lastRejection = nil }

    /* A wire command's true type may be LOCK_AT rather than LOCK once wrist GPS
       is available; the LOCK button still needs to read "busy" either way. */
    func isPending(_ type: CaddyWatchCommand.Kind) -> Bool {
        pendingCommands.contains { $0.command.type == type || (type == .lock && $0.command.type == .lockAt) }
    }

    private func receive(context: [String: Any]) {
        guard let raw = context["scene"] else { NSLog("[CCWatch] scene key missing in context: %@", context.keys.joined(separator: ",")); return }
        guard JSONSerialization.isValidJSONObject(raw) else { NSLog("[CCWatch] scene is not a valid JSON object"); return }
        guard let data = try? JSONSerialization.data(withJSONObject: raw) else { NSLog("[CCWatch] scene serialization failed"); return }
        let incoming: WatchScene
        do { incoming = try JSONDecoder().decode(WatchScene.self, from: data) }
        catch { NSLog("[CCWatch] scene decode failed: %@ payload: %@", String(describing: error), String(data: data, encoding: .utf8) ?? "?"); return }
        guard incoming.isSupported else { NSLog("[CCWatch] unsupported schemaVersion %d", incoming.schemaVersion); return }
        guard incoming.hasRound else { scene = nil; state = .noRound; locationManager.stop(); return }
        if let current = scene, current.roundId == incoming.roundId, incoming.revision < current.revision { return }
        scene = incoming
        state = .live
        locationManager.start()
    }

    private func receive(acknowledgement raw: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(raw),
              let data = try? JSONSerialization.data(withJSONObject: raw),
              let acknowledgement = try? JSONDecoder().decode(WatchCommandAcknowledgement.self, from: data) else { return }
        /* Both outcomes are definitive. Accepted commands wait for the next
           authoritative Scene to change presentation; rejected commands do not
           loop forever, but their command ID remains retryable on the phone. */
        pendingCommands.removeAll { $0.command.commandId == acknowledgement.commandId }
        persistOutbox()
        if !acknowledgement.accepted {
            lastRejection = acknowledgement
            WKInterfaceDevice.current().play(.failure)
        }
    }

    private func attempt(commandId: String) {
        guard let index = pendingCommands.firstIndex(where: { $0.command.commandId == commandId }),
              let message = commandMessage(pendingCommands[index].command), let session else { return }
        pendingCommands[index].attemptCount += 1
        pendingCommands[index].lastAttemptAt = Date().timeIntervalSince1970 * 1000
        persistOutbox()
        if session.isReachable {
            session.sendMessage(message, replyHandler: nil) { [weak self] _ in
                // A transport error is deliberately not an acknowledgement, but it
                // must not strand the command either: transferUserInfo is durable
                // and delivers once the phone can process it, the same fallback
                // NativeRoundBridge.acknowledgeCommand already uses for the
                // phone -> watch direction. Without this, a single transient
                // sendMessage failure left the command - and isPending's block on
                // retapping the same button - stuck until reachability happened
                // to change again, which is what made Next/Previous/Lock feel
                // unreliable rather than merely slow.
                session.transferUserInfo(message)
                Task { @MainActor in
                    guard let self else { return }
                    self.state = self.scene == nil ? .noRound : .stale
                }
            }
        } else {
            session.transferUserInfo(message)
        }
    }

    private func retryPending() { pendingCommands.forEach { attempt(commandId: $0.command.commandId) } }

    private func commandMessage(_ command: CaddyWatchCommand) -> [String: Any]? {
        guard let data = try? JSONEncoder().encode(command),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return ["command": object]
    }

    private func restoreOutbox() {
        guard let data = UserDefaults.standard.data(forKey: outboxKey),
              let stored = try? JSONDecoder().decode([PendingWatchCommand].self, from: data) else { return }
        pendingCommands = stored
    }

    private func persistOutbox() {
        guard let data = try? JSONEncoder().encode(pendingCommands) else { return }
        UserDefaults.standard.set(data, forKey: outboxKey)
    }
}

extension WatchSessionManager: WCSessionDelegate {
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        let context = session.receivedApplicationContext
        Task { @MainActor [weak self] in
            self?.receive(context: context)
            if activationState == .activated { self?.retryPending() }
            else if self?.scene != nil { self?.state = .stale }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        Task { @MainActor [weak self] in self?.receive(context: applicationContext) }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        /* The phone mirrors every scene as a live message because the
           application-context store can lag behind a reconnect. Same payload
           shape, same authoritative receive path. */
        if message["scene"] != nil {
            Task { @MainActor [weak self] in self?.receive(context: message) }
            return
        }
        guard let acknowledgement = message["acknowledgement"] as? [String: Any] else { return }
        Task { @MainActor [weak self] in self?.receive(acknowledgement: acknowledgement) }
    }

    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        guard let acknowledgement = userInfo["acknowledgement"] as? [String: Any] else { return }
        Task { @MainActor [weak self] in self?.receive(acknowledgement: acknowledgement) }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        Task { @MainActor [weak self] in
            guard let self, self.scene != nil else { return }
            self.state = session.isReachable ? .live : .stale
            if session.isReachable { self.retryPending() }
        }
    }
}

extension WatchLocationObservation {
    /* Mirrors locationObservation()'s own acceptance bound in caddy-watch.js so
       a stale or coarse wrist fix falls back to phone-authoritative LOCK
       instead of round-tripping a command Marshal will just reject. */
    init?(_ location: CLLocation, maxAgeSeconds: TimeInterval = 30) {
        guard location.horizontalAccuracy >= 0, location.horizontalAccuracy <= 100 else { return nil }
        guard Date().timeIntervalSince(location.timestamp) <= maxAgeSeconds else { return nil }
        coordinate = WatchCoordinate(lat: location.coordinate.latitude, lng: location.coordinate.longitude)
        source = "apple-watch"
        horizontalAccuracy = location.horizontalAccuracy
        timestamp = location.timestamp.timeIntervalSince1970 * 1000
    }
}

/* Keeps one fresh, best-effort GPS fix while a round is live so LOCK can mark
   the ball from the wrist. Foreground-only: there is deliberately no
   background location mode here (§ no golf-state transitions belong here). */
@MainActor
final class WatchLocationManager: NSObject, ObservableObject {
    @Published private(set) var lastFix: CLLocation?

    private let manager = CLLocationManager()

    override init() {
        super.init()
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = 5
        manager.delegate = self
    }

    func start() {
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse, .authorizedAlways: manager.startUpdatingLocation()
        default: break
        }
    }

    func stop() { manager.stopUpdatingLocation() }
}

extension WatchLocationManager: CLLocationManagerDelegate {
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            if status == .authorizedWhenInUse || status == .authorizedAlways { manager.startUpdatingLocation() }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let latest = locations.last else { return }
        Task { @MainActor [weak self] in self?.lastFix = latest }
    }
}
