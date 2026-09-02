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
    let course: Course?
    let hole: Hole?
    let distance: Distance?
    let suggestion: Suggestion?
    let shot: Shot?
    let target: GeoPoint?
    let location: Location?
    let bubble: Bubble?
    let geometry: Geometry?
    let score: Score?
    let holeComplete: HoleComplete?
    let queued: Queued?
    let controls: Controls?
    let surface: Surface?
    let connection: Connection?

    /* Which surface is driving the round. The phone owns the answer and both
       ends may ask to change it (TAKE_OVER / HAND_BACK); this is presentation
       state, never permission - LOCK works from the wrist either way. A
       handover from the phone is `offered` until this app answers, so a phone
       can tell a Watch that has the round from one that is still in a drawer. */
    struct Surface: Codable, Equatable { let active: String?; let handover: Handover?; let watch: Presence? }
    struct Handover: Codable, Equatable { let id: String?; let state: String?; let from: String? }
    struct Presence: Codable, Equatable { let paired: Bool?; let appInstalled: Bool?; let reachable: Bool?; let maps: Maps? }
    /* The phone's count of the lite-map package: how many holes it has and
       how many this wrist holds. Zero total means the phone knows of no
       package (or does not know yet), and the Ready face need not wait. */
    struct Maps: Codable, Equatable { let total: Int?; let have: Int? }

    /* Which course is in play, so a delivered lite-map package is only ever
       drawn for the course it was baked from. Optional because an older phone
       build, or a round with no course key, must still produce a usable scene. */
    /* `pars` is par for every hole in the round, keyed by hole number as a
       string (it crosses as a JSON object). It is the one fact the wrist needs
       in order to run the between-holes screens by itself — tee and green for
       every hole it already holds, in its lite-map package — so it rides on
       every Scene rather than being asked for. Holes with no par are absent,
       never null. */
    struct Course: Codable, Equatable {
        let key: String?
        let name: String?
        let pars: [String: Int]?
        func par(_ hole: Int) -> Int? { pars?[String(hole)] }
    }
    /* `teeToGreenM` is the hole's own length, for the Ready face before anyone
       is standing anywhere. */
    struct Hole: Codable, Equatable { let number: Int?; let par: Int?; let live: Bool?; let teeToGreenM: Double? }
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
    /* The phone's own fix, used to place the player on a lite map when the
       wrist has none. `fresh` is the phone's staleness verdict, not a second
       opinion formed here. */
    struct Location: Codable, Equatable { let coordinate: GeoPoint?; let source: String?; let fresh: Bool? }
    /* `engineVersion` says which Bubble engine drew these numbers. The wrist
       compares it with the engine it implements before computing anything of
       its own (BubbleEngineVersion.agreement); a difference means render these
       values rather than form a second opinion. Optional because an older phone
       build does not declare one, which is not an error - it simply means the
       wrist does not compute. */
    struct Bubble: Codable, Equatable { let widthM: Double?; let depthM: Double?; let tiltDeg: Double?; let club: String?; let carryM: Double?; let totalM: Double?; let centre: GeoPoint?; let engineVersion: String? }
    struct Geometry: Codable, Equatable { let origin: GeoPoint?; let approachBearingDeg: Double?; let greenPolygon: [LocalPoint]?; let target: LocalPoint?; let player: LocalPoint?; let route: [LocalPoint]? }
    struct Score: Codable, Equatable { let strokes: Int? }
    /* The phone's own between-holes state, so a wrist that is NOT driving
       shows what the phone is showing. A wrist that IS driving runs both
       screens off WatchHoleFlow and ignores these — which costs nothing,
       because neither screen depends on a position for either surface. */
    struct HoleComplete: Codable, Equatable { let hole: Int?; let par: Int?; let score: Int?; let nextHole: Int? }
    struct Queued: Codable, Equatable { let hole: Int?; let par: Int?; let lengthM: Double?; let arrivalM: Double?; let atTee: Bool? }
    struct Controls: Codable, Equatable {
        let canLock: Bool?; let canUnlock: Bool?; let canAim: Bool?; let canShotEnd: Bool?
        let canPreviousHole: Bool?; let canNextHole: Bool?
        /* The wrist's own way through a hole. Each is something the wrist can
           already decide for itself while driving; these say whether the PHONE
           would accept being told about it, which is what stops a command
           being queued that can only ever be rejected. */
        let canBallMove: Bool?; let canLogFinish: Bool?; let canComplete: Bool?
        let canScore: Bool?; let canPlay: Bool?; let playHole: Int?
    }
    struct Connection: Codable, Equatable { let status: String? }

    var isSupported: Bool { schemaVersion == Self.supportedSchemaVersion }
    var hasRound: Bool { roundId?.isEmpty == false }
    var isBubble: Bool { mode == "bubble" && bubble != nil }
    var isDriving: Bool { surface?.active == "watch" }
}

/* The Watch sends only this existing, platform-neutral command vocabulary.
 There are deliberately no Swift golf-state transitions behind these values. */
struct CaddyWatchCommand: Codable, Equatable {
    enum Kind: String, Codable, CaseIterable {
        case lock = "LOCK", unlock = "UNLOCK", previousHole = "VIEW_PREVIOUS_HOLE", nextHole = "VIEW_NEXT_HOLE"
        case lockAt = "LOCK_AT", aimAt = "AIM_AT", takeOver = "TAKE_OVER", handBack = "HAND_BACK"
        /* The between-holes vocabulary. Sending one is how the phone's record
           catches up with a decision the wrist has already made and drawn; it
           is never how the wrist gets permission to draw it. */
        case ballMoved = "BALL_MOVED", logFinish = "LOG_FINISH", holeComplete = "HOLE_COMPLETE"
        case stepScore = "STEP_SCORE", advance = "ADVANCE_TO_HOLE", playHole = "PLAY_HOLE"
    }
    let commandId: String
    let roundId: String
    let baseRevision: Int
    let createdAt: Double
    let device: String
    let type: Kind
    let payload: CommandPayload
}

/* Mirrors the payload shapes CaddyWatchBridge.receiveCommand reads out of
 command.payload: `location` for LOCK_AT, and `point` for AIM_AT — which
 Marshal's AIM_DRAGGED reads as `p.point`.

 NOTE the aim is sent RAW. The roof that stops a target being dragged past the
 bag lives in Marshal (clampAim, with maxAimM injected), and a second clamp on
 the wrist is precisely how two ends start disagreeing about where the target
 is. The wrist sends where the finger went and accepts the phone's correction
 on the next Scene. */
struct CommandPayload: Codable, Equatable {
    var location: WatchLocationObservation?
    var point: WatchCoordinate?
    /* `hole` and `delta` are read straight off the payload by Marshal's
       ADVANCE_TO_HOLE, HOLE_COMPLETED and SCORE_STEP (p.hole, p.delta). Both
       are omitted when absent rather than encoded as null — a null crossing
       WatchConnectivity arrives as NSNull and throws the whole send. */
    var hole: Int?
    var delta: Int?
    init(location: WatchLocationObservation? = nil, point: WatchCoordinate? = nil,
         hole: Int? = nil, delta: Int? = nil) {
        self.location = location
        self.point = point
        self.hole = hole
        self.delta = delta
    }
}

struct WatchCoordinate: Codable, Equatable { let lat: Double; let lng: Double }

/* Mirrors the shape locationObservation() in caddy-watch.js validates:
 coordinate, source, horizontalAccuracy (<=100m), timestamp (<=5min old). */
struct WatchLocationObservation: Codable, Equatable {
    let coordinate: WatchCoordinate
    let source: String
    let horizontalAccuracy: Double
    let timestamp: Double
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
