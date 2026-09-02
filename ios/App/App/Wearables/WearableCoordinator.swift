import Foundation

/* Mirrors WearableTransportDelegate one level up: NativeRoundBridge is the
   only thing that talks to JavaScript, so it is the only conformer. */
protocol WearableCoordinatorDelegate: AnyObject {
    func wearableCoordinator(_ coordinator: WearableCoordinator, didReceiveCommand command: [String: Any])
    func wearableCoordinator(_ coordinator: WearableCoordinator, didReceiveMapInventory inventory: [String: Any])
    func wearableCoordinator(_ coordinator: WearableCoordinator, didReceivePlayerInventory inventory: [String: Any])
    func wearableCoordinatorStateDidChange(_ coordinator: WearableCoordinator)
}

/* Routes NativeRoundBridge's Capacitor calls to whichever wearable
   transports are registered, and forwards transport events back up.

   FAN-OUT: every publish/acknowledge call now broadcasts to every
   registered transport, not just the first. This matters starting now,
   not hypothetically - NativeRoundBridge.load() registers both
   AppleWatchTransport and GarminTransport, so a `transports.first`-only
   coordinator would have left Garmin registered but never actually sent
   to. `state()` is OR-aggregated across transports for the same reason:
   JavaScript's watchState answers "is there a wrist to hand the round to",
   Apple or Garmin alike - see WatchScene.isDriving's own "watch" convention,
   which already treats either platform as one fact. This is deliberately
   NOT the full multi-wearable schema (Garmin Phase 1 plan step 6,
   surface.active.platform/deviceId) - that is for telling the two apart in
   the UI, which nothing needs yet. Acknowledge is broadcast to every
   transport rather than routed to whichever one a command actually came
   from, because NativeRoundBridge does not currently record that
   provenance; a transport with no matching pending command simply has
   nothing to do with an ack that was never its own attempt. */
final class WearableCoordinator: WearableTransportDelegate {
    weak var delegate: WearableCoordinatorDelegate?
    private var transports: [WearableTransport] = []

    func register(_ transport: WearableTransport) {
        transport.delegate = self
        transports.append(transport)
    }

    func activateAll() {
        transports.forEach { $0.activate() }
    }

    func publishScene(_ scene: [String: Any], completion: @escaping (Bool) -> Void) {
        broadcast(completion) { $0.publishScene(scene, completion: $1) }
    }

    func publishMapManifest(_ manifest: [String: Any], completion: @escaping (Bool) -> Void) {
        broadcast(completion) { $0.publishMapManifest(manifest, completion: $1) }
    }

    func publishPlayer(_ player: [String: Any], completion: @escaping (Bool) -> Void) {
        broadcast(completion) { $0.publishPlayer(player, completion: $1) }
    }

    func publishMapAsset(
        courseKey: String,
        version: String,
        asset: String,
        bytes: Data,
        completion: @escaping (Result<Bool, Error>) -> Void
    ) {
        guard let transport = transports.compactMap({ $0 as? WearableFileAssetTransport }).first else {
            completion(.success(false))
            return
        }
        transport.publishMapAsset(courseKey: courseKey, version: version, asset: asset, bytes: bytes, completion: completion)
    }

    func acknowledge(_ acknowledgement: [String: Any], completion: @escaping () -> Void) {
        guard !transports.isEmpty else { completion(); return }
        let remaining = Counter(transports.count)
        for transport in transports {
            transport.acknowledge(acknowledgement) {
                if remaining.decrementAndCheckZero() { completion() }
            }
        }
    }

    func state() -> [String: Any] {
        guard !transports.isEmpty else { return WearableTransportState.unsupported.asDictionary }
        let states = transports.map { $0.state() }
        return WearableTransportState(
            supported: states.contains { $0.supported },
            activated: states.contains { $0.activated },
            paired: states.contains { $0.paired },
            appInstalled: states.contains { $0.appInstalled },
            reachable: states.contains { $0.reachable }
        ).asDictionary
    }

    /* Sends to every transport in parallel and resolves once all have
       answered, true if ANY reported success - "did the Scene/manifest/bag
       reach at least one live wearable" is the question a caller actually
       has, not "did every registered transport individually succeed". */
    private func broadcast(_ completion: @escaping (Bool) -> Void, _ send: @escaping (WearableTransport, @escaping (Bool) -> Void) -> Void) {
        guard !transports.isEmpty else { completion(false); return }
        let remaining = Counter(transports.count)
        let anySucceeded = FlagBox()
        for transport in transports {
            send(transport) { published in
                if published { anySucceeded.set(true) }
                if remaining.decrementAndCheckZero() { completion(anySucceeded.value) }
            }
        }
    }

    // MARK: - WearableTransportDelegate

    func wearableTransport(_ transport: WearableTransport, didReceiveCommand command: [String: Any]) {
        delegate?.wearableCoordinator(self, didReceiveCommand: command)
    }

    func wearableTransport(_ transport: WearableTransport, didReceiveMapInventory inventory: [String: Any]) {
        delegate?.wearableCoordinator(self, didReceiveMapInventory: inventory)
    }

    func wearableTransport(_ transport: WearableTransport, didReceivePlayerInventory inventory: [String: Any]) {
        delegate?.wearableCoordinator(self, didReceivePlayerInventory: inventory)
    }

    func wearableTransportStateDidChange(_ transport: WearableTransport) {
        delegate?.wearableCoordinatorStateDidChange(self)
    }
}

/* Each transport calls its own completion back on its own private serial
   queue (AppleWatchTransport's, GarminTransport's), potentially
   concurrently with one another - these two small boxes exist only to make
   counting "how many of N async replies have landed" and "did any succeed"
   safe across those queues, with no other behaviour. */
private final class Counter {
    private var value: Int
    private let lock = NSLock()
    init(_ value: Int) { self.value = value }
    /// Returns true exactly once, on the call that brings the count to zero.
    func decrementAndCheckZero() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        value -= 1
        return value == 0
    }
}

private final class FlagBox {
    private var flag = false
    private let lock = NSLock()
    var value: Bool {
        lock.lock()
        defer { lock.unlock() }
        return flag
    }
    func set(_ newValue: Bool) {
        lock.lock()
        flag = flag || newValue
        lock.unlock()
    }
}
