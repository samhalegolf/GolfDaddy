import Foundation

/* The engine's constants, copied from app/js/bubble-engine.js.
 *
 * These are not tuning knobs to be adjusted on the Watch. They are the numbers
 * the phone plays by, and the only correct way to change one is to change it in
 * scripts/gd-app-core.js, re-run the client generator, re-record the parity
 * fixtures and bump the engine version — at which point this file changes too,
 * with the same value.
 */
enum BubbleTables {

    /* GD_DEFAULT_CLUB_CARRY_M. Order matters: JavaScript object keys iterate in
       insertion order, and `gdDefaultStandInBag()` builds the ghost bag from
       Object.entries, so this is the order a ghost bag arrives in before it is
       sorted. It is sorted by total anyway, but a shorter list that happened to
       tie would resolve differently, so the order is preserved rather than
       alphabetised. */
    static let defaultClubCarryM: [(club: String, carryM: Double)] = [
        ("Driver", 230), ("3W", 205), ("4H", 180), ("4i", 178), ("5i", 170),
        ("6i", 160), ("7i", 155), ("8i", 142), ("9i", 130),
        ("PW", 115), ("GW", 98), ("SW", 82), ("LW", 66)
    ]

    enum ClubGroup: String {
        case driver, woodHybrid, iron, wedge
    }

    /* GD_CLUB_GROUPS, as ordered case-insensitive tests. The ORDER is the
       JavaScript's if-chain order — driver, then wood/hybrid, then wedge, then
       iron as the default — and it decides overlaps: "4H" matches woodHybrid
       before anything else can claim it. */
    static func group(for club: String) -> ClubGroup {
        let name = club.lowercased()
        if name.contains("driver") { return .driver }
        for token in ["3w", "wood", "hybrid", "4h"] where name.contains(token) { return .woodHybrid }
        for token in ["pw", "gw", "sw", "lw", "wedge"] where name.contains(token) { return .wedge }
        return .iron
    }

    struct PatternRatios {
        let width: Double
        let depth: Double
        let carryWindowPct: Double
        let faceWindowDeg: Double
        let tiltBaseDeg: Double
    }

    /// GD_CLUB_PATTERN_RATIOS.
    static func ratios(for group: ClubGroup) -> PatternRatios {
        switch group {
        case .driver:     return .init(width: 0.19,  depth: 0.23,  carryWindowPct: 5.4, faceWindowDeg: 0.95, tiltBaseDeg: 5)
        case .woodHybrid: return .init(width: 0.17,  depth: 0.215, carryWindowPct: 4.9, faceWindowDeg: 0.85, tiltBaseDeg: 4.5)
        case .iron:       return .init(width: 0.148, depth: 0.195, carryWindowPct: 4.2, faceWindowDeg: 0.7,  tiltBaseDeg: 4)
        case .wedge:      return .init(width: 0.12,  depth: 0.16,  carryWindowPct: 3.4, faceWindowDeg: 0.55, tiltBaseDeg: 2.5)
        }
    }

    /// Roll-out as a fraction of carry, before the firmness multiplier.
    /// `gdRolloutBasePct` — wood/hybrid is the iron value times 1.35, which is
    /// why it is not simply a fourth entry in a table.
    static func rolloutBasePct(for club: String) -> Double {
        switch group(for: club) {
        case .driver:     return 0.11
        case .woodHybrid: return 0.075 * 1.35
        case .wedge:      return 0.047
        case .iron:       return 0.075
        }
    }

    /* The firmness preset multiplier. The phone reads a stored preference; the
       wrist has no such setting and never will — the bag it receives has
       already had the player's own preset applied on the phone
       (`gdBagTotalForCarry` runs there). This constant exists only for the one
       place the wrist derives a total itself: a bag row that arrived without
       one. Medium, the shipped default, is the only honest choice for that. */
    static let firmnessMultiplier: Double = 1

    /// PLACEHOLDER_PLAYER_PROFILE.baseCalibration — the shape every GPS Bubble
    /// is derived from, with only the club, carry and aim replaced per shot.
    enum BaseCalibration {
        static let faceWindowDeg: Double = 0.7
        static let carryWindowPct: Double = 4.2
        static let dispersionMultiplier: Double = 1
    }

    /* DEV_DEFAULTS, the shipped values. The Watch has no admin board to
       override them from, so unlike the phone these are simply the numbers. */
    enum Dev {
        static let bubbleRadiusPct: Double = 0.082
        static let minimumBubbleRadiusM: Double = 7
    }

    /* gdBubbleGeometryTuning() with no admin overrides — DEV_DEFAULTS ships
       `bubbleGeometry: {}`, so every lookup is NaN and every value falls back.
       Written out rather than computed so the fallbacks are visible. */
    enum GeometryTuning {
        static let widthScale: Double = 1
        static let depthScale: Double = 1
        static let tiltScale: Double = 1
        static let tiltMaxDeg: Double = 14
        static let gpsMaxLateralPct: Double = 0.13
        static let gpsMaxDepthPct: Double = 0.18
        static let gpsMaxLateralM: Double = 28
        static let gpsMaxDepthM: Double = 38
    }

    /// The ring's fixed resolution. Changing it changes every recorded ring
    /// sample in the parity fixtures, which is the intended alarm.
    static let ringSteps = 168

    /* DEV_DEFAULTS.bubbleVisuals. The phone draws three concentric rings and
       the MAIN one — the Bubble's actual outline, and the one the fixtures
       record — is drawn at 1.02, not 1. Two percent looks like nothing and is
       0.2m on a 10m radius, which is twenty times the parity tolerance: this
       was the whole of the first ring mismatch. The outer and inner rings are
       shading the wrist does not draw, so only mainScale is ported. */
    static let mainRingScale: Double = 1.02
}
