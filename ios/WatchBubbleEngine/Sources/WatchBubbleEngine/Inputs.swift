import Foundation

/* The Watch Bubble Engine's inputs.

 These are the settled half of the contract in docs/WATCH_BUBBLE_ENGINE_SPEC.md
 — what the phone must put on the wire before the wrist can compute anything.
 They exist ahead of the engine itself because the parity fixtures decode into
 them: the fixture format and the engine's input contract are the same shape
 from day one, rather than two descriptions of the same thing that can drift.

 Nothing here has behaviour beyond validation. The engine is a pure function of
 these values (`result = BubbleEngine.calculate(input)`), and everything mutable
 — the current target, the selected club, the club-transition band — belongs to
 WatchPlayState, not here. */

public struct Coordinate: Codable, Equatable, Sendable {
    public let lat: Double
    public let lng: Double

    public init(lat: Double, lng: Double) {
        self.lat = lat
        self.lng = lng
    }

    public var isFinite: Bool { lat.isFinite && lng.isFinite }
}

/* One club, as the phone hands it over. The phone has already normalised and
 sorted the bag and derived each total from the roll-out preset
 (gdNormaliseShotBagRows / gdTotalM), so the wrist consumes finished numbers and
 has no opinion about how they were produced. */
public struct WatchClub: Codable, Equatable, Sendable {
    public let club: String
    public let carryM: Double
    public let totalM: Double

    public init(club: String, carryM: Double, totalM: Double) {
        self.club = club
        self.carryM = carryM
        self.totalM = totalM
    }
}

/* The playable bag at a moment in time.

 `isGhost` is load-bearing and must cross the wire. When the account has no bag
 the phone's engine falls back to a stand-in set of default carries and tags the
 result `ghostBag` — a Bubble built on one is a stand-in, and the wrist has to
 be able to say so rather than presenting invented distances as the player's
 own. Dropping the flag on the way over would make a guess indistinguishable
 from the player's measured bag. */
public struct WatchBagSnapshot: Codable, Equatable, Sendable {
    /* The SCHEMA version is the envelope's (WatchPlayerSnapshot.version). This
       one is a convenience for callers that build a bag directly, and it is
       DECODED WITH A DEFAULT because the wire does not carry it — the phone
       sends `{isGhost, clubs}` and nothing else.

       It was non-optional once, for exactly as long as it took to ship: the
       Watch rejected every snapshot the phone sent, the phone re-sent forever,
       and both sides' tests passed because the Swift one hand-wrote its JSON to
       match these structs. dev/fixtures' `playerWire` now holds the real bytes
       so that cannot recur. */
    public let version: Int
    public let clubs: [WatchClub]
    public let isGhost: Bool

    public init(version: Int = 1, clubs: [WatchClub], isGhost: Bool) {
        self.version = version
        self.clubs = clubs
        self.isGhost = isGhost
    }

    enum CodingKeys: String, CodingKey { case version, clubs, isGhost }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = (try? values.decode(Int.self, forKey: .version)) ?? 1
        clubs = try values.decode([WatchClub].self, forKey: .clubs)
        isGhost = (try? values.decode(Bool.self, forKey: .isGhost)) ?? false
    }

    /// Longest total first, matching `gdNormaliseShotBagRows`. The wrist sorts
    /// rather than trusting arrival order, because a bag that arrived unsorted
    /// would silently change which club a tie resolves to.
    public var byLengthDescending: [WatchClub] {
        clubs.filter { $0.carryM > 0 && !$0.club.isEmpty }.sorted { $0.totalM > $1.totalM }
    }

    public var maxTotalM: Double? { byLengthDescending.first?.totalM }
}

/* The saved My Bubble, reduced to the only two things the GPS Bubble is allowed
 to take from it (Bubble Bible s2): a degree value and a handedness. Size comes
 from the bag. The saved SHAPE is deliberately not used — it used to be, and a
 stored cluster width quietly resized the on-course Bubble.

 `offsetDeg` is genuinely optional and must stay that way. `Number(null)` is 0
 in JavaScript and passes a bare finite check, which is how "no My Bubble" once
 became a fabricated 0.0° aim; both my-bubble.js and GDBubbleEngine.setBubble
 carry an explicit guard against it. Swift's type system does the same job here
 provided nothing ever defaults this field to zero on decode. */
public struct WatchBubbleProfile: Codable, Equatable, Sendable {
    public enum Handedness: String, Codable, Sendable {
        case right, left

        /// Right is +1 and left is −1, and the sign IS the convention — it is
        /// what mirrors the cluster tilt. A left-handed Bubble legitimately
        /// looks like a right-handed one reflected, which is also exactly what
        /// an accidental mirror in a render chain looks like, so this is
        /// asserted in the parity fixtures rather than judged by eye.
        public var sign: Double { self == .left ? -1 : 1 }

        /// Anything that is not exactly "left" is right-handed, matching
        /// `gdHandednessSign`. A malformed value must land on the app-wide
        /// default rather than producing a third behaviour.
        public init(lenient raw: String?) {
            self = raw == "left" ? .left : .right
        }
    }

    /// See the note on WatchBagSnapshot.version — the envelope owns the schema
    /// version and the wire does not carry this one.
    public let version: Int
    public let offsetDeg: Double?
    public let handedness: Handedness

    public init(version: Int = 1, offsetDeg: Double?, handedness: Handedness) {
        self.version = version
        self.offsetDeg = offsetDeg
        self.handedness = handedness
    }

    enum CodingKeys: String, CodingKey { case version, offsetDeg, handedness }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = (try? values.decode(Int.self, forKey: .version)) ?? 1
        /* decodeIfPresent, deliberately: an ABSENT offset is "no My Bubble" and
           must stay nil rather than becoming a fabricated 0.0 degrees. */
        offsetDeg = try values.decodeIfPresent(Double.self, forKey: .offsetDeg)
        handedness = Handedness(lenient: try values.decodeIfPresent(String.self, forKey: .handedness))
    }

    /// The aim to actually use: 0.0° when no My Bubble is set, explicitly, and
    /// never the engine's 1.4°-right placeholder — which used to be applied to
    /// everyone, left-handers included, as a right-hand miss.
    public var effectiveOffsetDeg: Double {
        guard let offsetDeg, offsetDeg.isFinite else { return 0 }
        return offsetDeg
    }
}
