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
        CAPPluginMethod(name: "publishScene", returnType: CAPPluginReturnPromise)
    ]

    private let queue = DispatchQueue(label: "com.claritygolf.caddy.native-round-bridge")
    private var session: WCSession?

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
            do {
                // Application context deliberately carries only the newest scene.
                try self.session?.updateApplicationContext(["scene": scene])
                call.resolve(["published": true])
            } catch {
                // A later activation/reconnect repeats the latest scene; this is
                // presentation data, so it never needs a command-style outbox.
                call.resolve(["published": false, "queuedForReconciliation": true])
            }
        }
    }

    private func receive(_ command: [String: Any]) {
        // JavaScript applies the generic command through its deduplicating
        // CaddyWatchBridge. Durable Watch command outbox/retry is the next
        // adapter milestone, not silently simulated here.
        notifyListeners("watchCommand", data: ["command": command], retainUntilConsumed: true)
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
    public func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}
    public func sessionReachabilityDidChange(_ session: WCSession) {}
}
