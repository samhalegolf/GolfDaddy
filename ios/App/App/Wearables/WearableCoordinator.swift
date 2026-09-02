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
   Phase 1 registers exactly one transport (Apple), so fan-out semantics for
   multiple simultaneous wearables are deliberately left undefined here -
   see the Garmin Phase 1 plan, step 6, for where that gets decided. */
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
        guard let transport = transports.first else { completion(false); return }
        transport.publishScene(scene, completion: completion)
    }

    func publishMapManifest(_ manifest: [String: Any], completion: @escaping (Bool) -> Void) {
        guard let transport = transports.first else { completion(false); return }
        transport.publishMapManifest(manifest, completion: completion)
    }

    func publishPlayer(_ player: [String: Any], completion: @escaping (Bool) -> Void) {
        guard let transport = transports.first else { completion(false); return }
        transport.publishPlayer(player, completion: completion)
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
        guard let transport = transports.first else { completion(); return }
        transport.acknowledge(acknowledgement, completion: completion)
    }

    func state() -> [String: Any] {
        (transports.first?.state() ?? .unsupported).asDictionary
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
