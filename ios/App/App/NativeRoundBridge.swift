import Capacitor
import Foundation
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
        CAPPluginMethod(name: "acknowledgeCommand", returnType: CAPPluginReturnPromise)
    ]

    private let queue = DispatchQueue(label: "com.claritygolf.caddy.native-round-bridge")
    private var session: WCSession?
    private var latestScene: [String: Any]?

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
            let message: [String: Any] = ["acknowledgement": acknowledgement]
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

    public func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        if let command = message["command"] as? [String: Any] { receive(command) }
    }

    public func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        if let command = userInfo["command"] as? [String: Any] { receive(command) }
    }

    public func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {}
    public func sessionDidBecomeInactive(_ session: WCSession) {}
    public func sessionDidDeactivate(_ session: WCSession) { session.activate() }
    public func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        if activationState == .activated { republishLatestScene() }
    }
    public func sessionReachabilityDidChange(_ session: WCSession) {
        if session.isReachable { republishLatestScene() }
    }
}
