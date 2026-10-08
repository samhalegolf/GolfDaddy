import Foundation
import WatchBubbleEngine

/* Wind, slope and units for the shot in hand - the Apple Watch twin of the
   Garmin app's GarminConditions.mc and DistanceFormat.mc, so both wrists show
   the same numbers.

   UNITS follow the watch's own region setting: yards where the measurement
   system is US or UK, metres otherwise. Nothing in the Scene carries a unit.

   WIND is read by the wrist itself from the same open-meteo current-wind
   endpoint the phone's wind.js uses, for wherever the player is. Its effect is
   the phone engine's own rule (gdWindEffectMeters / gdWindLandingFromAim in
   app/js/bubble-engine.js): the ball is carried downwind by 4.5% of the
   carry, held to 4..12 m, times the wind level 1..3 (13 and 24 km/h, wind.js's
   thresholds). Below 5 km/h it is calm. From that one displacement come the
   along-the-shot estimate the numbers face shows, and the wind ghost the map
   draws where the ball would be carried.

   SLOPE is plays-like.js on the wrist: the open-meteo elevation endpoint, both
   ends in one request, plays = flat + (target - origin) elevation.
   Opportunistic: no answer, no plays number, nothing else changes.

   windApplied (a double-tap or long-press on the numbers face) folds the wind
   into the big number and every plays number. playsMode (the map's plays
   button) turns the map's Bubble into the plays-distance one. */
@MainActor
final class WatchConditions: ObservableObject {
    @Published var windApplied = false
    @Published var playsMode = false
    @Published private(set) var wind: Wind?
    @Published private var elevations: [String: Double] = [:]

    struct Wind: Equatable { let fromDeg: Double; let kmh: Double }

    struct Effect: Equatable {
        /// 0 is calm: no direction, no ghost.
        let level: Int
        let kmh: Double
        /// Metres the shot plays longer (+) or shorter (-).
        let alongM: Double
        /// Where the wind blows TO, relative to the line of play, radians
        /// clockwise with 0 straight at the target.
        let relRad: Double
        /// Where the wind carries a ball aimed at the target.
        let ghost: Coordinate?
    }

    private var windFetchedAt: Date?
    private var windFetchedFor: Coordinate?
    private var windTask: Task<Void, Never>?
    private var elevationTask: Task<Void, Never>?
    private var failedPair: String?
    private var failedAt: Date?

    // MARK: - Units

    nonisolated static var yards: Bool {
        let system = Locale.current.measurementSystem
        return system == .us || system == .uk
    }
    nonisolated static var suffix: String { yards ? "y" : "m" }
    nonisolated static func value(_ metres: Double) -> Int { Int(((yards ? metres * 1.0936133 : metres)).rounded()) }
    nonisolated static func number(_ metres: Double?) -> String { metres.map { "\(value($0))" } ?? "—" }
    nonisolated static func withUnit(_ metres: Double?) -> String { metres.map { "\(value($0))\(suffix)" } ?? "—" }

    // MARK: - Wind

    /// The wind's effect on a shot from `player` to `target`, or nil while the
    /// wrist has no reading. Asks for one when it is missing or old.
    func windEffect(player: Coordinate?, target: Coordinate?, flatM: Double?) -> Effect? {
        guard let player, let target else { return nil }
        refreshWind(near: player)
        guard let wind else { return nil }
        let level = Self.level(kmh: wind.kmh)
        guard level > 0 else { return Effect(level: 0, kmh: wind.kmh, alongM: 0, relRad: 0, ghost: nil) }
        let carry = min(max(flatM ?? 140, 40), 260)
        let effect = min(max(carry * 0.045, 4), 12) * Double(level)
        let fromRad = wind.fromDeg * .pi / 180
        let toRad = fromRad + .pi
        let rel = toRad - Self.trueBearing(player, target)
        return Effect(level: level, kmh: wind.kmh, alongM: -effect * cos(rel), relRad: rel,
                      ghost: Self.project(target, bearing: toRad, metres: effect))
    }

    nonisolated static func level(kmh: Double) -> Int {
        if kmh < 5 { return 0 }
        if kmh >= 24 { return 3 }
        if kmh >= 13 { return 2 }
        return 1
    }

    private func refreshWind(near player: Coordinate) {
        if let at = windFetchedAt, Date().timeIntervalSince(at) < 300,
           let was = windFetchedFor, Self.distance(was, player) < 1000 { return }
        guard windTask == nil else { return }
        windFetchedAt = Date()
        windFetchedFor = player
        let url = URL(string: "https://api.open-meteo.com/v1/forecast?latitude=\(String(format: "%.5f", player.lat))"
            + "&longitude=\(String(format: "%.5f", player.lng))"
            + "&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=kmh&timezone=auto")
        windTask = Task { [weak self] in
            defer { self?.windTask = nil }
            guard let url, let (data, response) = try? await URLSession.shared.data(from: url),
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let current = json["current"] as? [String: Any],
                  let speed = (current["wind_speed_10m"] as? NSNumber)?.doubleValue,
                  let direction = (current["wind_direction_10m"] as? NSNumber)?.doubleValue else { return }
            self?.wind = Wind(fromDeg: direction, kmh: speed)
        }
    }

    // MARK: - Slope

    /// Target elevation less the player's, or nil while unknown.
    func slopeM(player: Coordinate?, target: Coordinate?) -> Double? {
        guard let player, let target else { return nil }
        let kp = Self.key(player), kt = Self.key(target)
        if let ep = elevations[kp], let et = elevations[kt] { return et - ep }
        requestElevations(player, target, keys: (kp, kt))
        return nil
    }

    /// ~11 m: the source is ~90 m, so finer only costs requests.
    private static func key(_ p: Coordinate) -> String { String(format: "%.4f,%.4f", p.lat, p.lng) }

    private func requestElevations(_ a: Coordinate, _ b: Coordinate, keys: (String, String)) {
        guard elevationTask == nil else { return }
        let pair = keys.0 + "|" + keys.1
        if pair == failedPair, let at = failedAt, Date().timeIntervalSince(at) < 30 { return }
        let url = URL(string: "https://api.open-meteo.com/v1/elevation?latitude="
            + String(format: "%.6f,%.6f", a.lat, b.lat) + "&longitude=" + String(format: "%.6f,%.6f", a.lng, b.lng))
        elevationTask = Task { [weak self] in
            defer { self?.elevationTask = nil }
            guard let url, let (data, response) = try? await URLSession.shared.data(from: url),
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let list = json["elevation"] as? [NSNumber], list.count >= 2 else {
                self?.failedPair = pair
                self?.failedAt = Date()
                return
            }
            guard let self else { return }
            if self.elevations.count > 48 { self.elevations = [:] }
            self.elevations[keys.0] = list[0].doubleValue
            self.elevations[keys.1] = list[1].doubleValue
        }
    }

    // MARK: - Plays

    /// What the shot plays to: flat + slope, + the wind while it is folded
    /// in. Nil when there is nothing to add, so no second number is shown.
    func playsLikeM(player: Coordinate?, target: Coordinate?, flatM: Double?, effect: Effect?) -> Double? {
        guard let flatM else { return nil }
        let slope = slopeM(player: player, target: target)
        let withWind = windApplied && (effect?.level ?? 0) > 0
        if slope == nil && !withWind { return nil }
        var out = flatM
        if let slope { out += slope }
        if withWind, let effect { out += effect.alongM }
        return max(out, 0)
    }

    // MARK: - Geometry

    /// Compass bearing a -> b, radians clockwise from north.
    nonisolated static func trueBearing(_ a: Coordinate, _ b: Coordinate) -> Double {
        atan2((b.lng - a.lng) * cos(a.lat * .pi / 180), b.lat - a.lat)
    }

    /// Haversine metres.
    nonisolated static func distance(_ a: Coordinate, _ b: Coordinate) -> Double {
        let dLat = (b.lat - a.lat) * .pi / 180, dLng = (b.lng - a.lng) * .pi / 180
        let h = sin(dLat / 2) * sin(dLat / 2) + cos(a.lat * .pi / 180) * cos(b.lat * .pi / 180) * sin(dLng / 2) * sin(dLng / 2)
        return 2 * 6_371_008.8 * asin(min(1, h.squareRoot()))
    }

    /// Flat-earth step from `origin` along a compass bearing.
    nonisolated static func project(_ origin: Coordinate, bearing: Double, metres: Double) -> Coordinate {
        let lat = origin.lat + cos(bearing) * metres / 111_320
        let lng = origin.lng + sin(bearing) * metres / (111_320 * cos(origin.lat * .pi / 180))
        return Coordinate(lat: lat, lng: lng)
    }
}
