import Combine
import Foundation
import WatchBubbleEngine

/* The player's bag and saved My Bubble, cached on the wrist.

 Small enough to be a single file. Unlike the lite-map package there is nothing
 partial about a snapshot: it arrives whole or not at all, so there is no
 inventory to reconcile and no half-delivered state to report — only "which
 fingerprint do I hold", which is what the phone needs to decide whether to send
 anything at all.

 It is durable because the point of the whole exercise is a wrist that keeps
 working with the phone in a bag. A snapshot that lived only in memory would be
 gone at the next launch and the wrist would be back to asking.

 Nothing here decides anything about equipment. The bag was normalised on the
 phone — sorted, roll-out applied — and this stores what it was handed after
 checking the payload is internally consistent. */
final class WatchPlayerStore: ObservableObject {

    /// The snapshot in force, or nil when none has arrived (or the stored one
    /// was written by a build whose schema this one does not understand).
    @Published private(set) var snapshot: WatchPlayerSnapshot?

    /// What to tell the phone we hold. An absent snapshot reports an empty
    /// fingerprint rather than nothing at all — "I have none" is a real answer
    /// and it is what makes the phone send one.
    var inventory: [String: String] { ["fingerprint": snapshot?.fingerprint ?? ""] }

    private static let fileName = "player.json"

    init() { refresh() }

    /* Adopts a snapshot pushed by the phone.

       Refuses anything malformed, and `isUsable` includes recomputing the
       fingerprint from the contents: a payload that lost clubs crossing the
       Capacitor bridge, the plist encoding and the radio would otherwise be
       cached and played on, and a silently short bag picks the wrong club for
       every shot of the round. Verifying costs one string build.

       Adoption is idempotent, so the live mirror and the durable queue
       delivering the same snapshot twice is a no-op rather than a conflict. */
    func receive(player raw: Any) {
        guard JSONSerialization.isValidJSONObject(raw),
              let data = try? JSONSerialization.data(withJSONObject: raw),
              let incoming = try? JSONDecoder().decode(WatchPlayerSnapshot.self, from: data),
              incoming.isUsable else {
            NSLog("[CCWatch] watch player snapshot rejected")
            return
        }
        guard incoming.fingerprint != snapshot?.fingerprint else { return }
        do {
            try FileManager.default.createDirectory(at: Self.directory(), withIntermediateDirectories: true)
            try JSONEncoder().encode(incoming).write(to: Self.fileURL(), options: .atomic)
        } catch {
            /* A snapshot that cannot be written is still usable for this
               launch — losing it costs a re-send next time, never a wrong bag. */
            NSLog("[CCWatch] watch player write failed: %@", String(describing: error))
        }
        DispatchQueue.main.async { self.snapshot = incoming }
    }

    /// Re-reads the cache from disk. A stored snapshot that no longer validates
    /// — an older schema, or a file truncated by a crash mid-write — is
    /// discarded rather than trusted, and the phone is asked for a fresh one.
    func refresh() {
        guard let data = try? Data(contentsOf: Self.fileURL()),
              let stored = try? JSONDecoder().decode(WatchPlayerSnapshot.self, from: data),
              stored.isUsable else {
            if snapshot != nil { DispatchQueue.main.async { self.snapshot = nil } }
            return
        }
        if stored.fingerprint != snapshot?.fingerprint {
            DispatchQueue.main.async { self.snapshot = stored }
        }
    }

    private static func directory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("CaddyWatchPlayer", isDirectory: true)
    }
    private static func fileURL() -> URL { directory().appendingPathComponent(fileName) }
}
