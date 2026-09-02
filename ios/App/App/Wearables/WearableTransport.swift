import Foundation

/* The wearable platforms Caddy can hand an active round to. */
enum WearablePlatform: String {
    case apple
    case garmin
}

/* Connection/presence facts about one wearable transport, independent of any
   round-specific state. The dictionary shape matches exactly what
   NativeRoundBridge has always reported to JavaScript as "watchState"
   (supported/activated/paired/appInstalled/reachable), so wiring this
   through the coordinator stays behaviour-preserving for Apple. */
struct WearableTransportState {
    let supported: Bool
    let activated: Bool
    let paired: Bool
    let appInstalled: Bool
    let reachable: Bool

    static let unsupported = WearableTransportState(
        supported: false, activated: false, paired: false, appInstalled: false, reachable: false
    )

    var asDictionary: [String: Any] {
        [
            "supported": supported,
            "activated": activated,
            "paired": paired,
            "appInstalled": appInstalled,
            "reachable": reachable
        ]
    }
}

/* Events a transport pushes upward, independent of which platform produced
   them. WearableCoordinator forwards these to NativeRoundBridge, which is
   the only thing that talks to JavaScript. */
protocol WearableTransportDelegate: AnyObject {
    func wearableTransport(_ transport: WearableTransport, didReceiveCommand command: [String: Any])
    func wearableTransport(_ transport: WearableTransport, didReceiveMapInventory inventory: [String: Any])
    func wearableTransport(_ transport: WearableTransport, didReceivePlayerInventory inventory: [String: Any])
    func wearableTransportStateDidChange(_ transport: WearableTransport)
}

/* Common intent every wearable transport supports. Map ASSET delivery is
   deliberately not part of this contract: Apple moves raw bytes over a
   queued WatchConnectivity file transfer, while Garmin is expected to pull
   imagery from a URL (see the Garmin Phase 1 plan's GarminMapDownloader).
   Forcing one shape onto both would misrepresent whichever transport didn't
   originate it - see WearableFileAssetTransport below for the Apple-only
   capability. */
protocol WearableTransport: AnyObject {
    var platform: WearablePlatform { get }
    var delegate: WearableTransportDelegate? { get set }

    func activate()
    func publishScene(_ scene: [String: Any], completion: @escaping (Bool) -> Void)
    func publishMapManifest(_ manifest: [String: Any], completion: @escaping (Bool) -> Void)
    func publishPlayer(_ player: [String: Any], completion: @escaping (Bool) -> Void)
    func acknowledge(_ acknowledgement: [String: Any], completion: @escaping () -> Void)
    func state() -> WearableTransportState
}

/* Apple-specific capability: a hole image is small enough to mirror live and
   durable enough to need a queued file transfer, both keyed off raw bytes.
   Garmin fetches its own imagery instead, so this stays outside the shared
   WearableTransport contract rather than being stubbed out on transports
   that don't work this way. */
protocol WearableFileAssetTransport: WearableTransport {
    func publishMapAsset(
        courseKey: String,
        version: String,
        asset: String,
        bytes: Data,
        completion: @escaping (Result<Bool, Error>) -> Void
    )
}
