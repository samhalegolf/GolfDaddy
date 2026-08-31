import Foundation

/* Mirrors CaddyWatchScene v1. All display values are optional because the
 phone may legitimately have a partial course package or no Bubble model. */
struct WatchScene: Codable, Equatable {
    static let supportedSchemaVersion = 1
    let schemaVersion: Int
    let roundId: String?
    let revision: Int
    let flow: String?
    let mode: String?
    let hole: Hole?
    let distance: Distance?
    let suggestion: Suggestion?
    let shot: Shot?
    let target: GeoPoint?
    let bubble: Bubble?
    let geometry: Geometry?
    let score: Score?
    let controls: Controls?
    let connection: Connection?

    struct Hole: Codable, Equatable { let number: Int?; let par: Int?; let live: Bool? }
    struct Distance: Codable, Equatable { let target: Double?; let front: Double?; let centre: Double?; let back: Double? }
    struct Suggestion: Codable, Equatable { let club: String?; let carryM: Double?; let totalM: Double? }
    struct Shot: Codable, Equatable { let locked: Bool?; let open: Bool? }
    struct GeoPoint: Codable, Equatable { let lat: Double?; let lng: Double? }
    /* Course data is remote input. A malformed coordinate must become an
       omitted point, not make an otherwise useful scene undecodable. */
    struct LocalPoint: Codable, Equatable {
        let x: Double?
        let y: Double?
        enum CodingKeys: String, CodingKey { case x, y }
        init(x: Double?, y: Double?) { self.x = x; self.y = y }
        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            x = try? values.decode(Double.self, forKey: .x)
            y = try? values.decode(Double.self, forKey: .y)
        }
    }
    struct Bubble: Codable, Equatable { let widthM: Double?; let depthM: Double?; let tiltDeg: Double?; let club: String?; let carryM: Double?; let totalM: Double?; let centre: GeoPoint? }
    struct Geometry: Codable, Equatable { let origin: GeoPoint?; let approachBearingDeg: Double?; let greenPolygon: [LocalPoint]?; let target: LocalPoint?; let player: LocalPoint?; let route: [LocalPoint]? }
    struct Score: Codable, Equatable { let strokes: Int? }
    struct Controls: Codable, Equatable { let canLock: Bool?; let canUnlock: Bool?; let canAim: Bool?; let canShotEnd: Bool?; let canPreviousHole: Bool?; let canNextHole: Bool? }
    struct Connection: Codable, Equatable { let status: String? }

    var isSupported: Bool { schemaVersion == Self.supportedSchemaVersion }
    var hasRound: Bool { roundId?.isEmpty == false }
    var isBubble: Bool { mode == "bubble" && bubble != nil }
}

/* The Watch sends only this existing, platform-neutral command vocabulary.
 There are deliberately no Swift golf-state transitions behind these values. */
struct CaddyWatchCommand: Codable, Equatable {
    enum Kind: String, Codable, CaseIterable { case lock = "LOCK", unlock = "UNLOCK", previousHole = "VIEW_PREVIOUS_HOLE", nextHole = "VIEW_NEXT_HOLE" }
    let commandId: String
    let roundId: String
    let baseRevision: Int
    let createdAt: Double
    let device: String
    let type: Kind
    let payload: [String: String]
}

struct WatchCommandAcknowledgement: Codable, Equatable {
    let commandId: String
    let accepted: Bool
    let reason: String?
    let revision: Int?
}

struct PendingWatchCommand: Codable, Equatable, Identifiable {
    enum Status: String, Codable { case pending }
    let command: CaddyWatchCommand
    var status: Status
    var attemptCount: Int
    var lastAttemptAt: Double?
    var id: String { command.commandId }
}
