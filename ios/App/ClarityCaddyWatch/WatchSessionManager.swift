import Foundation
import WatchConnectivity

@MainActor
final class WatchSessionManager: NSObject, ObservableObject {
    enum State { case noRound, live, stale }

    @Published private(set) var scene: WatchScene?
    @Published private(set) var state: State = .noRound
    @Published private(set) var pendingCommands: [PendingWatchCommand] = []
    @Published private(set) var lastRejection: WatchCommandAcknowledgement?

    private let outboxKey = "CaddyWatchPendingCommandsV1"
    private var session: WCSession?

    override init() {
        super.init()
        restoreOutbox()
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
        self.session = session
    }

    func send(_ type: CaddyWatchCommand.Kind) {
        guard let scene, let roundId = scene.roundId, !roundId.isEmpty, !isPending(type) else { return }
        let command = CaddyWatchCommand(commandId: UUID().uuidString, roundId: roundId, baseRevision: scene.revision, createdAt: Date().timeIntervalSince1970 * 1000, device: "apple-watch", type: type, payload: [:])
        pendingCommands.append(PendingWatchCommand(command: command, status: .pending, attemptCount: 0, lastAttemptAt: nil))
        persistOutbox()
        attempt(commandId: command.commandId)
    }

    func isPending(_ type: CaddyWatchCommand.Kind) -> Bool {
        pendingCommands.contains { $0.command.type == type }
    }

    private func receive(context: [String: Any]) {
        guard let raw = context["scene"] else { NSLog("[CCWatch] scene key missing in context: %@", context.keys.joined(separator: ",")); return }
        guard JSONSerialization.isValidJSONObject(raw) else { NSLog("[CCWatch] scene is not a valid JSON object"); return }
        guard let data = try? JSONSerialization.data(withJSONObject: raw) else { NSLog("[CCWatch] scene serialization failed"); return }
        let incoming: WatchScene
        do { incoming = try JSONDecoder().decode(WatchScene.self, from: data) }
        catch { NSLog("[CCWatch] scene decode failed: %@ payload: %@", String(describing: error), String(data: data, encoding: .utf8) ?? "?"); return }
        guard incoming.isSupported else { NSLog("[CCWatch] unsupported schemaVersion %d", incoming.schemaVersion); return }
        guard incoming.hasRound else { scene = nil; state = .noRound; return }
        if let current = scene, current.roundId == incoming.roundId, incoming.revision < current.revision { return }
        scene = incoming
        state = .live
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
        if !acknowledgement.accepted { lastRejection = acknowledgement }
    }

    private func attempt(commandId: String) {
        guard let index = pendingCommands.firstIndex(where: { $0.command.commandId == commandId }),
              let message = commandMessage(pendingCommands[index].command), let session else { return }
        pendingCommands[index].attemptCount += 1
        pendingCommands[index].lastAttemptAt = Date().timeIntervalSince1970 * 1000
        persistOutbox()
        if session.isReachable {
            session.sendMessage(message, replyHandler: nil) { [weak self] _ in
                // A transport error is deliberately not an acknowledgement. The
                // durable command remains available for a later retry.
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
