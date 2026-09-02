import Capacitor
import Foundation

/*
 NativeRoundBridge is the single native boundary for active-round consumers.
 It does not interpret golf rules: JavaScript Marshal validates every command
 and publishes the portable CaddyWatchScene. A future Live Activity/Lock Screen
 surface shares this bridge rather than reconstructing round state.

 It also does not own any wearable transport itself. It:
   - receives a Capacitor call
   - validates required top-level input
   - forwards the sanitised payload to WearableCoordinator
   - resolves the Capacitor call
   - publishes incoming wearable events to JavaScript

 Apple Watch's WatchConnectivity behaviour lives in
 Wearables/Apple/AppleWatchTransport.swift; a Garmin transport is a sibling
 registered with the same coordinator. JavaScript does not need to learn
 which platform it is talking to for ordinary Scene publication.
*/
@objc(NativeRoundBridge)
public final class NativeRoundBridge: CAPPlugin, CAPBridgedPlugin, WearableCoordinatorDelegate {
    public let identifier = "NativeRoundBridge"
    public let jsName = "NativeRoundBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "publishScene", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acknowledgeCommand", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "publishWatchMap", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "publishWatchMapAsset", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "watchMapInventory", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "publishWatchPlayer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "watchPlayerInventory", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "watchState", returnType: CAPPluginReturnPromise)
    ]

    private let coordinator = WearableCoordinator()
    private let queue = DispatchQueue(label: "com.claritygolf.caddy.native-round-bridge")
    /* The last inventory each side reported. Only a hint: JavaScript uses it
       to skip re-sending a package the wrist already has, and sending
       everything again is always a correct fallback. */
    private var watchMapInventoryReport: [String: Any]?
    private var watchPlayerInventoryReport: [String: Any]?

    /* Capacitor bridges JavaScript null as NSNull, which WatchConnectivity
       refuses (WCErrorCodePayloadUnsupportedTypes). The wearable decoder treats
       an absent key exactly like an explicit null, so dropping them is lossless. */
    private static func withoutNulls(_ value: Any) -> Any? {
        if value is NSNull { return nil }
        if let dictionary = value as? [String: Any] {
            var out = [String: Any]()
            for (key, item) in dictionary {
                if let kept = withoutNulls(item) { out[key] = kept }
            }
            return out
        }
        if let array = value as? [Any] {
            return array.compactMap { withoutNulls($0) }
        }
        return value
    }

    public override func load() {
        coordinator.delegate = self
        coordinator.register(AppleWatchTransport())
        coordinator.activateAll()
    }

    @objc public func publishScene(_ call: CAPPluginCall) {
        guard let scene = call.getObject("scene") else {
            call.reject("A CaddyWatchScene is required")
            return
        }
        let payload = (Self.withoutNulls(scene) as? [String: Any]) ?? [:]
        coordinator.publishScene(payload) { published in
            if published {
                call.resolve(["published": true])
            } else {
                call.resolve(["published": false, "queuedForReconciliation": true])
            }
        }
    }

    // MARK: - Watch lite maps

    @objc public func publishWatchMap(_ call: CAPPluginCall) {
        guard let manifest = call.getObject("manifest") else {
            call.reject("A Watch map manifest is required")
            return
        }
        let payload = (Self.withoutNulls(manifest) as? [String: Any]) ?? [:]
        coordinator.publishMapManifest(payload) { published in
            call.resolve(["published": published])
        }
    }

    @objc public func publishWatchMapAsset(_ call: CAPPluginCall) {
        guard let courseKey = call.getString("courseKey"), !courseKey.isEmpty,
              let asset = call.getString("asset"), !asset.isEmpty,
              let base64 = call.getString("base64"),
              let bytes = Data(base64Encoded: base64), !bytes.isEmpty else {
            call.reject("A Watch map asset requires courseKey, asset and base64 bytes")
            return
        }
        /* The package version is a millisecond timestamp. It crosses the
           Capacitor bridge as a string so it cannot be rounded on the way, and
           stays a string in the transfer metadata, which only carries
           property-list types. */
        let version = call.getString("version") ?? call.getInt("version").map(String.init) ?? ""
        guard !version.isEmpty else {
            call.reject("A Watch map asset requires a package version")
            return
        }
        coordinator.publishMapAsset(courseKey: courseKey, version: version, asset: asset, bytes: bytes) { result in
            switch result {
            case .success(let sent):
                call.resolve(["sent": sent])
            case .failure(let error):
                call.reject("Watch map asset could not be queued: \(error.localizedDescription)")
            }
        }
    }

    @objc public func watchMapInventory(_ call: CAPPluginCall) {
        queue.async { [weak self] in
            call.resolve(["inventory": self?.watchMapInventoryReport as Any])
        }
    }

    // MARK: - Watch player snapshot

    @objc public func publishWatchPlayer(_ call: CAPPluginCall) {
        guard let player = call.getObject("player") else {
            call.reject("A Watch player snapshot is required")
            return
        }
        /* An omitted My Bubble offset is the whole point of the field (see
           Bubble Bible s8) and Capacitor bridges a JS null as NSNull, which
           makes the entire send throw WCErrorCodePayloadUnsupportedTypes.
           Stripping is lossless: the Watch reads a missing key as nil. */
        let payload = (Self.withoutNulls(player) as? [String: Any]) ?? [:]
        coordinator.publishPlayer(payload) { published in
            call.resolve(["published": published])
        }
    }

    @objc public func watchPlayerInventory(_ call: CAPPluginCall) {
        queue.async { [weak self] in
            call.resolve(["inventory": self?.watchPlayerInventoryReport as Any])
        }
    }

    // MARK: - Watch presence

    @objc public func watchState(_ call: CAPPluginCall) {
        call.resolve(coordinator.state())
    }

    /* This is the only authoritative acknowledgement path. Native transport
       does not infer success: JavaScript returns the result after Marshal has
       accepted or rejected the command. */
    @objc public func acknowledgeCommand(_ call: CAPPluginCall) {
        guard let acknowledgement = call.getObject("acknowledgement"),
              acknowledgement["commandId"] as? String != nil else {
            call.reject("A command acknowledgement is required")
            return
        }
        /* An accepted command acknowledges with `reason: null`, which
           Capacitor bridges as NSNull and WatchConnectivity refuses outright
           (WCErrorCodePayloadUnsupportedTypes) - on BOTH the live and the
           queued path, so the Watch never heard that its LOCK or hole change
           went through and kept the button reading busy. Same fix as
           publishScene: the Watch decoder treats an absent key as nil. */
        let payload = (Self.withoutNulls(acknowledgement) as? [String: Any]) ?? [:]
        coordinator.acknowledge(payload) {
            call.resolve()
        }
    }

    // MARK: - WearableCoordinatorDelegate

    func wearableCoordinator(_ coordinator: WearableCoordinator, didReceiveCommand command: [String: Any]) {
        // JavaScript applies the generic command through its deduplicating
        // CaddyWatchBridge. Durable Watch command outbox/retry is the next
        // adapter milestone, not silently simulated here.
        notifyListeners("watchCommand", data: ["command": command], retainUntilConsumed: true)
    }

    /* The Watch's count of the holes it holds. Kept for the delivery module's
       next errand and pushed to JavaScript now, so the phone's handover card
       counts the same holes the wrist does. */
    func wearableCoordinator(_ coordinator: WearableCoordinator, didReceiveMapInventory inventory: [String: Any]) {
        queue.async { [weak self] in self?.watchMapInventoryReport = inventory }
        notifyListeners("watchMapInventory", data: ["inventory": inventory])
    }

    /* The wrist's own answer to "which bag do you already hold". Kept for a
       delivery module that attaches late and pushed to JavaScript now, so an
       unchanged bag is never re-sent. */
    func wearableCoordinator(_ coordinator: WearableCoordinator, didReceivePlayerInventory inventory: [String: Any]) {
        queue.async { [weak self] in self?.watchPlayerInventoryReport = inventory }
        notifyListeners("watchPlayerInventory", data: ["inventory": inventory])
    }

    /* Whether there is a wrist to hand the round to. JavaScript puts the answer
       on the Scene so the phone's Send to Watch and the Watch's own status strip
       read one fact. Pushed on activation and on every pairing/reachability
       change, and answerable on demand via watchState for a bridge that
       attaches late. */
    func wearableCoordinatorStateDidChange(_ coordinator: WearableCoordinator) {
        notifyListeners("watchState", data: coordinator.state())
    }
}
