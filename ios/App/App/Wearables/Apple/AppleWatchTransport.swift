import Foundation
import UIKit
import WatchConnectivity

/* All Apple Watch / WatchConnectivity behaviour, extracted unchanged from
   NativeRoundBridge. This class does not redesign anything - it is the same
   session management, mirrored-live-plus-queued delivery, and JPEG
   re-encoding that shipped before, just behind the WearableTransport
   contract so WearableCoordinator can also hold a Garmin transport later. */
final class AppleWatchTransport: NSObject, WearableTransport, WCSessionDelegate {
    let platform: WearablePlatform = .apple
    weak var delegate: WearableTransportDelegate?

    private let queue = DispatchQueue(label: "com.claritygolf.caddy.apple-watch-transport")
    private var session: WCSession?
    private var latestScene: [String: Any]?

    func activate() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
        self.session = session
    }

    // MARK: - Scene

    func publishScene(_ scene: [String: Any], completion: @escaping (Bool) -> Void) {
        queue.async { [weak self] in
            guard let self else { return }
            self.latestScene = scene
            /* A reachable Watch also gets the scene as a live message: the
               application-context store can lag (or, on the simulator, fail
               to hand its data to the client), and the newest scene always
               wins. */
            if let session = self.session, session.isReachable {
                session.sendMessage(["scene": scene], replyHandler: nil, errorHandler: nil)
            }
            do {
                // Application context deliberately carries only the newest scene.
                try self.session?.updateApplicationContext(["scene": scene])
                completion(true)
            } catch {
                // A later activation/reconnect repeats the latest scene; this is
                // presentation data, so it never needs a command-style outbox.
                completion(false)
            }
        }
    }

    private func republishLatestScene() {
        queue.async { [weak self] in
            guard let self, let scene = self.latestScene else { return }
            /* updateApplicationContext silently skips a dictionary identical
               to the last one, but a Watch app (re)launch can drop the
               context that arrived before its session activated. The nonce
               defeats that dedupe so a reconnect always re-delivers the
               latest scene. */
            let payload: [String: Any] = ["scene": scene, "sentAt": Date().timeIntervalSince1970]
            if let session = self.session, session.isReachable {
                session.sendMessage(["scene": scene], replyHandler: nil, errorHandler: nil)
            }
            try? self.session?.updateApplicationContext(payload)
        }
    }

    // MARK: - Watch lite maps

    /* Course imagery is deliberately NOT part of the Scene. A Scene is small,
       arrives many times a minute, and rides the application context; a
       Watch map package is ~100KB of image that changes only when a course
       is regenerated. So the manifest goes over transferUserInfo and each
       hole image over transferFile - both durable queues that survive a
       closed Watch app, a locked phone, and a walk out of Bluetooth range. */
    func publishMapManifest(_ manifest: [String: Any], completion: @escaping (Bool) -> Void) {
        queue.async { [weak self] in
            guard let self, let session = self.session else { completion(false); return }
            /* Mirrored live and queued durably, exactly as scene publication
               is and for the same reason: the queued stores do not reach the
               Watch app reliably, and the Watch's adoption of a manifest is
               idempotent. */
            if session.isReachable {
                session.sendMessage(["watchMapManifest": manifest], replyHandler: nil, errorHandler: nil)
            }
            session.transferUserInfo(["watchMapManifest": manifest])
            completion(true)
        }
    }

    func publishMapAsset(
        courseKey: String,
        version: String,
        asset: String,
        bytes: Data,
        completion: @escaping (Result<Bool, Error>) -> Void
    ) {
        queue.async { [weak self] in
            guard let self, let session = self.session else { completion(.success(false)); return }
            let bytes = Self.watchDecodableBytes(bytes)
            let descriptor: [String: Any] = ["courseKey": courseKey, "version": version, "asset": asset]
            do {
                /* A hole bakes to a few kilobytes, comfortably inside the
                   sendMessage payload limit, so a reachable Watch gets it
                   immediately and the queued file transfer is the fallback
                   for everything else. Writing the same bytes twice is a
                   no-op on the Watch's side. */
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
                completion(.success(true))
            } catch {
                completion(.failure(error))
            }
        }
    }

    // MARK: - Watch player snapshot

    /* The player's bag and saved My Bubble. A third payload, because it fits
       neither of the other two: the Scene is small and arrives many times a
       minute, so equipment riding it would trail every distance update; the
       lite-map package is ~100KB per COURSE, while a bag belongs to the
       PLAYER and changes when they edit it.

       Mirrored live and queued durably, exactly as scene and map manifest
       publication are and for the same reason - the queued stores do not
       reach this two-target Watch app reliably, and the Watch's adoption of
       a snapshot is idempotent, so the mirror and the queue cannot
       disagree. */
    func publishPlayer(_ player: [String: Any], completion: @escaping (Bool) -> Void) {
        queue.async { [weak self] in
            guard let self, let session = self.session else { completion(false); return }
            if session.isReachable {
                session.sendMessage(["watchPlayer": player], replyHandler: nil, errorHandler: nil)
            }
            session.transferUserInfo(["watchPlayer": player])
            completion(true)
        }
    }

    // MARK: - Presence

    func state() -> WearableTransportState {
        guard let session else { return .unsupported }
        return WearableTransportState(
            supported: true,
            activated: session.activationState == .activated,
            paired: session.isPaired,
            appInstalled: session.isWatchAppInstalled,
            reachable: session.isReachable
        )
    }

    private func publishState() {
        delegate?.wearableTransportStateDidChange(self)
    }

    /* The wrist's own answer to "which bag do you already hold" / "which
       holes do you already have". NativeRoundBridge caches these for the
       inventory-polling Capacitor methods; this transport just relays them
       as they arrive. */
    private func receive(mapInventory: [String: Any]) {
        delegate?.wearableTransport(self, didReceiveMapInventory: mapInventory)
    }

    private func receive(playerInventory: [String: Any]) {
        delegate?.wearableTransport(self, didReceivePlayerInventory: playerInventory)
    }

    private func receive(command: [String: Any]) {
        delegate?.wearableTransport(self, didReceiveCommand: command)
    }

    /* This is the only authoritative acknowledgement path. Native transport
       does not infer success: JavaScript returns the result after Marshal
       has accepted or rejected the command. */
    func acknowledge(_ acknowledgement: [String: Any], completion: @escaping () -> Void) {
        queue.async { [weak self] in
            guard let self else { completion(); return }
            let message: [String: Any] = ["acknowledgement": acknowledgement]
            if let session = self.session, session.isReachable {
                session.sendMessage(message, replyHandler: nil) { _ in
                    session.transferUserInfo(message)
                }
            } else {
                self.session?.transferUserInfo(message)
            }
            completion()
        }
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
       lean on. At quality 0.8 the same holes are 15-20KB, and the bake has
       no alpha to lose. */
    private static func watchDecodableBytes(_ bytes: Data) -> Data {
        guard let image = UIImage(data: bytes), let jpeg = image.jpegData(compressionQuality: 0.8) else { return bytes }
        return jpeg
    }

    private static func watchMapOutbox() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("CaddyWatchMapOutbox", isDirectory: true)
    }

    // MARK: - WCSessionDelegate

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        if let command = message["command"] as? [String: Any] { receive(command: command) }
        if let inventory = message["watchMapHave"] as? [String: Any] { receive(mapInventory: inventory) }
        if let held = message["watchPlayerHave"] as? [String: Any] { receive(playerInventory: held) }
    }

    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        if let command = userInfo["command"] as? [String: Any] { receive(command: command) }
        if let inventory = userInfo["watchMapHave"] as? [String: Any] { receive(mapInventory: inventory) }
        if let held = userInfo["watchPlayerHave"] as? [String: Any] { receive(playerInventory: held) }
    }

    /* The queued copy exists only to hand WatchConnectivity a stable file.
       Once the transfer is done - or has definitively failed - it is dead
       weight in the temporary directory. */
    func session(_ session: WCSession, didFinish fileTransfer: WCSessionFileTransfer, error: Error?) {
        if let error { NSLog("[CaddyWatch] map asset transfer failed: %@", String(describing: error)) }
        try? FileManager.default.removeItem(at: fileTransfer.file.fileURL)
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {}
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { session.activate() }
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        if activationState == .activated { republishLatestScene() }
        publishState()
    }
    func sessionReachabilityDidChange(_ session: WCSession) {
        if session.isReachable { republishLatestScene() }
        publishState()
    }
    func sessionWatchStateDidChange(_ session: WCSession) {
        publishState()
    }
}

extension AppleWatchTransport: WearableFileAssetTransport {}
