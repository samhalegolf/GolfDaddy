import Capacitor
import Foundation
import UIKit
import WatchConnectivity

/*
 NativeRoundBridge is the single native boundary for active-round consumers.
 It does not interpret golf rules: JavaScript Marshal validates every command
 and publishes the portable CaddyWatchScene. A future Live Activity/Lock Screen
 surface shares this bridge rather than reconstructing round state.
*/
@objc(NativeRoundBridge)
public final class NativeRoundBridge: CAPPlugin, CAPBridgedPlugin, WCSessionDelegate {
    public let identifier = "NativeRoundBridge"
    public let jsName = "NativeRoundBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "publishScene", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acknowledgeCommand", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "publishWatchMap", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "publishWatchMapAsset", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "watchMapInventory", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "watchState", returnType: CAPPluginReturnPromise)
    ]

    private let queue = DispatchQueue(label: "com.claritygolf.caddy.native-round-bridge")
    private var session: WCSession?
    private var latestScene: [String: Any]?
    /* The last inventory the Watch reported. Only a hint: JavaScript uses it to
       skip re-sending a package the wrist already has, and sending everything
       again is always a correct fallback. */
    private var watchMapInventoryReport: [String: Any]?

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
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
        self.session = session
    }

    @objc public func publishScene(_ call: CAPPluginCall) {
        guard let scene = call.getObject("scene") else {
            call.reject("A CaddyWatchScene is required")
            return
        }
        queue.async { [weak self] in
            guard let self else { return }
            let payload = (Self.withoutNulls(scene) as? [String: Any]) ?? [:]
            self.latestScene = payload
            /* A reachable Watch also gets the scene as a live message: the
               application-context store can lag (or, on the simulator, fail to
               hand its data to the client), and the newest scene always wins. */
            if let session = self.session, session.isReachable {
                session.sendMessage(["scene": payload], replyHandler: nil, errorHandler: nil)
            }
            do {
                // Application context deliberately carries only the newest scene.
                try self.session?.updateApplicationContext(["scene": payload])
                call.resolve(["published": true])
            } catch {
                // A later activation/reconnect repeats the latest scene; this is
                // presentation data, so it never needs a command-style outbox.
                call.resolve(["published": false, "queuedForReconciliation": true])
            }
        }
    }

    private func republishLatestScene() {
        queue.async { [weak self] in
            guard let self, let scene = self.latestScene else { return }
            /* updateApplicationContext silently skips a dictionary identical to
               the last one, but a Watch app (re)launch can drop the context that
               arrived before its session activated. The nonce defeats that
               dedupe so a reconnect always re-delivers the latest scene. */
            let payload: [String: Any] = ["scene": scene, "sentAt": Date().timeIntervalSince1970]
            if let session = self.session, session.isReachable {
                session.sendMessage(["scene": scene], replyHandler: nil, errorHandler: nil)
            }
            try? self.session?.updateApplicationContext(payload)
        }
    }

    // MARK: - Watch lite maps

    /* Course imagery is deliberately NOT part of the Scene. A Scene is small,
       arrives many times a minute, and rides the application context; a Watch
       map package is ~100KB of image that changes only when a course is
       regenerated. So the manifest goes over transferUserInfo and each hole
       image over transferFile — both durable queues that survive a closed Watch
       app, a locked phone, and a walk out of Bluetooth range.

       This bridge does not fetch, decode or validate a package: JavaScript owns
       the API call, and the Watch validates what it stores. Native is transport. */
    @objc public func publishWatchMap(_ call: CAPPluginCall) {
        guard let manifest = call.getObject("manifest") else {
            call.reject("A Watch map manifest is required")
            return
        }
        queue.async { [weak self] in
            guard let self, let session = self.session else { call.resolve(["published": false]); return }
            let payload = (Self.withoutNulls(manifest) as? [String: Any]) ?? [:]
            /* Mirrored live and queued durably, exactly as publishScene does and
               for the same reason: the queued stores do not reach the Watch app
               reliably, and the Watch's adoption of a manifest is idempotent. */
            if session.isReachable {
                session.sendMessage(["watchMapManifest": payload], replyHandler: nil, errorHandler: nil)
            }
            session.transferUserInfo(["watchMapManifest": payload])
            call.resolve(["published": true])
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
        queue.async { [weak self] in
            guard let self, let session = self.session else { call.resolve(["sent": false]); return }
            let bytes = Self.watchDecodableBytes(bytes)
            let descriptor: [String: Any] = ["courseKey": courseKey, "version": version, "asset": asset]
            do {
                /* A hole bakes to a few kilobytes, comfortably inside the
                   sendMessage payload limit, so a reachable Watch gets it
                   immediately and the queued file transfer is the fallback for
                   everything else. Writing the same bytes twice is a no-op on
                   the Watch's side. */
                if session.isReachable {
                    var live = descriptor
                    live["bytes"] = bytes
                    session.sendMessage(["watchMapAsset": live], replyHandler: nil, errorHandler: nil)
                }
                let outbox = Self.watchMapOutbox()
                try FileManager.default.createDirectory(at: outbox, withIntermediateDirectories: true)
                let url = outbox.appendingPathComponent("\(courseKey)__v\(version)__\(asset)")
                try bytes.write(to: url, options: .atomic)
                session.transferFile(url, metadata: descriptor)
                call.resolve(["sent": true])
            } catch {
                call.reject("Watch map asset could not be queued: \(error.localizedDescription)")
            }
        }
    }

    @objc public func watchMapInventory(_ call: CAPPluginCall) {
        queue.async { [weak self] in
            call.resolve(["inventory": self?.watchMapInventoryReport as Any])
        }
    }

    // MARK: - Watch presence

    /* Whether there is a wrist to hand the round to. JavaScript puts the answer
       on the Scene so the phone's Send to Watch and the Watch's own status strip
       read one fact. Pushed on activation and on every pairing/reachability
       change, and answerable on demand for a bridge that attaches late. */
    private func watchStateData() -> [String: Any] {
        guard let session else {
            return ["supported": false, "activated": false, "paired": false, "appInstalled": false, "reachable": false]
        }
        return [
            "supported": true,
            "activated": session.activationState == .activated,
            "paired": session.isPaired,
            "appInstalled": session.isWatchAppInstalled,
            "reachable": session.isReachable
        ]
    }

    @objc public func watchState(_ call: CAPPluginCall) {
        call.resolve(watchStateData())
    }

    private func publishWatchState() {
        notifyListeners("watchState", data: watchStateData())
    }

    /* The bake is WebP, and watchOS ImageIO has no WebP decoder: the wrist
       logged "createImageAtIndex: could not find plugin for image source
       ... 'RIFF'" on every hole and drew "This hole has no map" over a
       complete package. iOS decodes it fine, so the phone re-encodes each
       hole on the way past. The asset keeps its manifest name - the Watch
       files by name and UIImage sniffs content, not extensions.

       JPEG, not PNG: a 448x1536 hole came out at 50-68KB as PNG, over the
       sendMessage payload limit (WCErrorCodePayloadTooLarge on 14 of 18
       holes), and the queued file path is not something this Watch app can
       lean on. At quality 0.8 the same holes are 15-20KB, and the bake has no
       alpha to lose. */
    private static func watchDecodableBytes(_ bytes: Data) -> Data {
        guard let image = UIImage(data: bytes), let jpeg = image.jpegData(compressionQuality: 0.8) else { return bytes }
        return jpeg
    }

    private static func watchMapOutbox() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("CaddyWatchMapOutbox", isDirectory: true)
    }

    private func receive(_ command: [String: Any]) {
        // JavaScript applies the generic command through its deduplicating
        // CaddyWatchBridge. Durable Watch command outbox/retry is the next
        // adapter milestone, not silently simulated here.
        notifyListeners("watchCommand", data: ["command": command], retainUntilConsumed: true)
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
        queue.async { [weak self] in
            guard let self else { return }
            /* An accepted command acknowledges with `reason: null`, which
               Capacitor bridges as NSNull and WatchConnectivity refuses outright
               (WCErrorCodePayloadUnsupportedTypes) - on BOTH the live and the
               queued path, so the Watch never heard that its LOCK or hole change
               went through and kept the button reading busy. Same fix as
               publishScene: the Watch decoder treats an absent key as nil. */
            let payload = (Self.withoutNulls(acknowledgement) as? [String: Any]) ?? [:]
            let message: [String: Any] = ["acknowledgement": payload]
            if let session = self.session, session.isReachable {
                session.sendMessage(message, replyHandler: nil) { _ in
                    session.transferUserInfo(message)
                }
            } else {
                self.session?.transferUserInfo(message)
            }
            call.resolve()
        }
    }

    /* The Watch's count of the holes it holds. Kept for the delivery module's
       next errand and pushed to JavaScript now, so the phone's handover card
       counts the same holes the wrist does. Arrives as a live message when the
       Watch is reachable and as queued user info otherwise. */
    private func receive(inventory: [String: Any]) {
        queue.async { [weak self] in self?.watchMapInventoryReport = inventory }
        notifyListeners("watchMapInventory", data: ["inventory": inventory])
    }

    public func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        if let command = message["command"] as? [String: Any] { receive(command) }
        if let inventory = message["watchMapHave"] as? [String: Any] { receive(inventory: inventory) }
    }

    public func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        if let command = userInfo["command"] as? [String: Any] { receive(command) }
        if let inventory = userInfo["watchMapHave"] as? [String: Any] { receive(inventory: inventory) }
    }

    /* The queued copy exists only to hand WatchConnectivity a stable file. Once
       the transfer is done — or has definitively failed — it is dead weight in
       the temporary directory. */
    public func session(_ session: WCSession, didFinish fileTransfer: WCSessionFileTransfer, error: Error?) {
        if let error { NSLog("[CaddyWatch] map asset transfer failed: %@", String(describing: error)) }
        try? FileManager.default.removeItem(at: fileTransfer.file.fileURL)
    }

    public func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {}
    public func sessionDidBecomeInactive(_ session: WCSession) {}
    public func sessionDidDeactivate(_ session: WCSession) { session.activate() }
    public func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        if activationState == .activated { republishLatestScene() }
        publishWatchState()
    }
    public func sessionReachabilityDidChange(_ session: WCSession) {
        if session.isReachable { republishLatestScene() }
        publishWatchState()
    }
    public func sessionWatchStateDidChange(_ session: WCSession) {
        publishWatchState()
    }
}
