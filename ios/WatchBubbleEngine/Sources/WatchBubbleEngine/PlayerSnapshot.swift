import Foundation

/* The player half of what the wrist needs: the playable bag and the saved My
 Bubble, in one small versioned payload.

 WHY IT IS ITS OWN TRANSPORT. There are already two, and this fits neither. The
 Scene is a few hundred bytes republished many times a minute — putting a bag on
 it would drag the player's equipment behind every distance update. The lite-map
 package is ~100KB per COURSE and changes when a course is regenerated; a bag
 changes when the player edits it, and belongs to the player rather than the
 course. So: a third payload, small, sent on round start and on change.

 CHANGE DETECTION IS A FINGERPRINT, NOT A COUNTER. A counter has to be stored
 somewhere and kept in step, and the moment the phone and wrist disagree about
 it a stale bag looks current. The fingerprint is derived from the content
 itself, so "has this changed" is answerable by either end with no memory of
 what went before. The wrist reports the fingerprint it holds; the phone sends
 only when it differs.

 It is a readable string rather than a hash on purpose. There are no collisions
 to reason about, and when a bag delivery misbehaves the fingerprint in the log
 says what the wrist actually has. */
public struct WatchPlayerSnapshot: Codable, Equatable, Sendable {
    public static let supportedVersion = 1

    public let version: Int
    public let fingerprint: String
    public let bag: WatchBagSnapshot
    public let bubble: WatchBubbleProfile
    /// Which Bubble engine the phone's numbers came from. The wrist compares it
    /// with its own before computing anything locally; a mismatch means render
    /// the phone's Bubble rather than a second opinion.
    public let engineVersion: String

    public init(version: Int, fingerprint: String, bag: WatchBagSnapshot, bubble: WatchBubbleProfile, engineVersion: String) {
        self.version = version
        self.fingerprint = fingerprint
        self.bag = bag
        self.bubble = bubble
        self.engineVersion = engineVersion
    }

    /* A snapshot is usable when it is this schema, its fingerprint matches its
       own contents, and its bag is not empty.

       Recomputing the fingerprint is the integrity check. WatchConnectivity
       payloads cross a Capacitor bridge, a plist encoding and a radio, and a
       snapshot that lost half its clubs on the way would otherwise be cached
       and played on — a silently short bag picks the wrong club for every shot.
       Verifying costs one string build. */
    public var isUsable: Bool {
        guard version == Self.supportedVersion else { return false }
        guard !bag.byLengthDescending.isEmpty else { return false }
        guard !engineVersion.isEmpty else { return false }
        return fingerprint == Self.fingerprint(bag: bag, bubble: bubble, engineVersion: engineVersion)
    }

    /* The canonical fingerprint.

       MUST match watchPlayerFingerprint() in app/js/watch-player-delivery.js
       exactly — the two are pinned against shared cases in
       dev/fixtures/bubble-engine-parity.json, because a quiet disagreement here
       means the phone re-sends a bag the wrist already has on every Scene, or
       (worse) never re-sends one it does not.

       Shape:  v1|g<0|1>|<club>:<carry>:<total>|…|b:<deg|->:<hand>|e:<engine>

       Clubs are emitted longest-total-first, which is the bag's own order
       (gdNormaliseShotBagRows), so a bag that merely arrived shuffled has the
       same fingerprint and does not provoke a pointless re-send. Distances are
       rounded to whole metres because that is the precision the bag is edited
       and displayed in; a float artefact must not read as an equipment change.
       `-` for the aim means NO My Bubble, and is deliberately distinct from
       `0` — which is a real, saved, zero-degree aim. */
    public static func fingerprint(bag: WatchBagSnapshot, bubble: WatchBubbleProfile, engineVersion: String) -> String {
        var parts = ["v1", bag.isGhost ? "g1" : "g0"]
        for club in bag.byLengthDescending {
            parts.append("\(club.club):\(Int(club.carryM.rounded())):\(Int(club.totalM.rounded()))")
        }
        let aim: String
        if let offset = bubble.offsetDeg, offset.isFinite {
            aim = String(format: "%.2f", offset)
        } else {
            aim = "-"
        }
        parts.append("b:\(aim):\(bubble.handedness.rawValue)")
        parts.append("e:\(engineVersion)")
        return parts.joined(separator: "|")
    }

    /* What the wrist reports back so the phone can skip a re-send. Empty string
       means "I have nothing", which is a real answer and not an error — a fresh
       install, or a wrist whose cache was cleared. */
    public var inventory: [String: String] { ["fingerprint": fingerprint] }
}
