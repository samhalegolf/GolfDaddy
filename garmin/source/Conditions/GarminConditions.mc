using Toybox.Lang;
using Toybox.Math;
using Toybox.System;
using Toybox.WatchUi;
using Toybox.Communications;
using Toybox.Application;

// Wind and slope for the shot in hand, both read by the watch itself so they
// are there on every shot whether or not the phone is speaking.
//
// WIND comes from Garmin's own weather (Toybox.Weather, CIQ 3.2+: Garmin
// Connect's current conditions). Its effect is the phone engine's own rule,
// gdWindEffectMeters / gdWindLandingFromAim in app/js/bubble-engine.js: the
// ball is carried downwind by 4.5% of the carry, held to 4..12 m, times the
// wind level 1..3 (13 and 24 km/h, wind.js's thresholds). Below CALM_KMH there
// is no wind to speak of; the phone never meets that case because there wind
// is a player's choice, here it is always read.
//
// From that one displacement come the two things the faces show:
//   - the along-the-shot part, as a +/- metres estimate (into the wind plays
//     longer, so a headwind is +);
//   - the GHOST: the aim moved downwind by the whole displacement - where the
//     wind takes the ball (gdWindLandingFromAim). The map draws a second
//     Bubble there, wind streaks blowing from the main Bubble to it, and the
//     player moves the aim until the ghost lands as near the target as they
//     trust the wind to carry it - the phone's own counteract gesture.
// Wind never changes the Bubble the engine computes, so the engine version and
// its parity fixture are untouched. It only joins the plays-like number when
// the player turns on the app setting windInPlaysLike.
//
// SLOPE is plays-like.js on the wrist: the same open-meteo elevation endpoint,
// both ends in one request, adjusted = flat + (target - origin) elevation.
// Opportunistic the same way: a request that fails or never answers leaves
// the plays number off and nothing else changes.
class GarminConditions {
    static const ELEVATION_ENDPOINT = "https://api.open-meteo.com/v1/elevation";
    static const CALM_KMH = 5.0;
    static const LEVEL2_KMH = 13.0;
    static const LEVEL3_KMH = 24.0;
    static const WEATHER_REFRESH_MS = 60000;
    static const RETRY_MS = 30000;
    static const MAX_POINTS = 48;

    var logged = null;           // simulator trace: the last wind logged
    // The player folded the wind into the numbers (a double-tap / long-press
    // on the numbers face, CaddyInputDelegate): the big number turns blue and
    // every plays number - numbers face and map, and the map's plays Bubble -
    // includes the wind, as the windInPlaysLike setting makes it always do.
    var windApplied = false;
    var windCache = null;        // { "fromDeg", "kmh" } or null
    var windReadAt = null;

    var elevations = {};         // point key -> metres
    var pending = false;
    var failedKey = null;
    var failedAt = 0;

    function initialize() {}

    // ------------------------------------------------------------- wind

    // { "fromDeg" => compass degrees the wind blows FROM, "kmh" } or null.
    function wind() {
        var now = System.getTimer();
        if (windReadAt != null && now - windReadAt < WEATHER_REFRESH_MS) { return windCache; }
        windReadAt = now;
        windCache = readWeather();
        return windCache;
    }

    function readWeather() {
        if (!(Toybox has :Weather)) { return null; }
        var current = null;
        try { current = Toybox.Weather.getCurrentConditions(); } catch (e) { return null; }
        if (current == null) { return null; }
        var speed = current.windSpeed;      // metres per second
        var bearing = current.windBearing;  // degrees, where it blows from
        if (speed == null || bearing == null) { return null; }
        return { "fromDeg" => bearing.toFloat(), "kmh" => speed.toFloat() * 3.6 };
    }

    function level(kmh) {
        if (kmh < CALM_KMH) { return 0; }
        if (kmh >= LEVEL3_KMH) { return 3; }
        if (kmh >= LEVEL2_KMH) { return 2; }
        return 1;
    }

    // The wind's effect on a shot from `player` to `target`, or null when
    // the watch has no weather. "level" 0 is calm: no arrow, no ghost.
    //   alongM  metres the shot plays longer (+) or shorter (-)
    //   relRad  where the wind blows TO, relative to the line of play
    //           (0 = straight at the target, clockwise)
    //   ghost   GarminCoordinate where the wind carries a ball aimed at `target`
    function windEffect(player, target, flatM) {
        var w = wind();
        if (w == null || player == null || target == null) { return null; }
        var lvl = level(w["kmh"]);
        if (lvl == 0) { return { "level" => 0, "alongM" => 0.0, "relRad" => 0.0, "ghost" => null, "kmh" => w["kmh"] }; }
        var carry = (flatM != null) ? flatM : 140.0;
        if (carry < 40) { carry = 40.0; } else if (carry > 260) { carry = 260.0; }
        var base = carry * 0.045;
        if (base < 4) { base = 4.0; } else if (base > 12) { base = 12.0; }
        var effect = base * lvl;
        var fromRad = Math.toRadians(w["fromDeg"]);
        var toRad = fromRad + Math.PI;
        var rel = toRad - trueBearing(player, target);
        if (GarminTransmitPolicy.muted() && logged != w["fromDeg"]) {
            logged = w["fromDeg"];
            System.println("wind: from " + w["fromDeg"] + " " + w["kmh"] + "km/h, shot bearing "
                + Math.toDegrees(trueBearing(player, target)) + ", origin on face " + Math.toDegrees(rel + Math.PI));
        }
        return {
            "level" => lvl,
            "kmh" => w["kmh"],
            "alongM" => -effect * Math.cos(rel),
            "relRad" => rel,
            "ghost" => GarminGeo.project(target, toRad, effect)
        };
    }

    // Compass bearing a -> b, radians clockwise from north, cosine-corrected
    // (unlike GarminGeo.bearing, which keeps the engine's own
    // degree-space convention for laying the Bubble down).
    function trueBearing(a, b) {
        var dLat = b.lat - a.lat;
        var dLng = (b.lng - a.lng) * Math.cos(Math.toRadians(a.lat));
        return Math.atan2(dLng, dLat);
    }

    // The windInPlaysLike app setting (Garmin Connect > the app's settings).
    function windInPlaysLike() {
        try {
            var v = Application.Properties.getValue("windInPlaysLike");
            return v == true;
        } catch (e) {
            return false;
        }
    }

    // ------------------------------------------------------------ slope

    // Target elevation less the player's, or null while unknown. Asks for
    // whatever is missing; the answer arrives later and redraws.
    function slopeM(player, target) {
        if (player == null || target == null) { return null; }
        var kp = key(player);
        var kt = key(target);
        var ep = elevations[kp];
        var et = elevations[kt];
        if (ep != null && et != null) { return et - ep; }
        request(player, target, kp + "|" + kt);
        return null;
    }

    // ~11 m: the source is ~90 m, so finer only costs requests.
    function key(p) {
        return p.lat.format("%.4f") + "," + p.lng.format("%.4f");
    }

    var requestedPoints = null;
    var requestedKey = null;

    function request(player, target, pairKey) {
        if (pending) { return; }
        var now = System.getTimer();
        if (pairKey.equals(failedKey) && now - failedAt < RETRY_MS) { return; }
        var lat = player.lat.format("%.6f") + "," + target.lat.format("%.6f");
        var lng = player.lng.format("%.6f") + "," + target.lng.format("%.6f");
        requestedPoints = [key(player), key(target)];
        requestedKey = pairKey;
        pending = true;
        try {
            Communications.makeWebRequest(ELEVATION_ENDPOINT, { "latitude" => lat, "longitude" => lng },
                { :method => Communications.HTTP_REQUEST_METHOD_GET,
                  :responseType => Communications.HTTP_RESPONSE_CONTENT_TYPE_JSON },
                method(:onElevation));
        } catch (e) {
            pending = false;
            failedKey = pairKey;
            failedAt = now;
        }
    }

    function onElevation(code as Lang.Number, data as Lang.Dictionary or Lang.String or Null) as Void {
        pending = false;
        var list = (code == 200 && data instanceof Lang.Dictionary) ? data["elevation"] : null;
        if (!(list instanceof Lang.Array) || list.size() < 2 || requestedPoints == null) {
            failedKey = requestedKey;
            failedAt = System.getTimer();
            if (GarminTransmitPolicy.muted()) { System.println("elevation: failed " + code); }
            return;
        }
        if (elevations.size() > MAX_POINTS) { elevations = {}; }
        for (var i = 0; i < 2; i += 1) {
            var v = list[i];
            if (v instanceof Lang.Number || v instanceof Lang.Float || v instanceof Lang.Double) {
                elevations[requestedPoints[i]] = v.toFloat();
            }
        }
        if (GarminTransmitPolicy.muted()) { System.println("elevation: " + requestedPoints + " = " + list); }
        WatchUi.requestUpdate();
    }

    // ------------------------------------------------------------ plays

    // What the shot plays to: flat + slope, + wind when the player asked for
    // it (windApplied, or the setting). Null when there is nothing to add (no slope known and wind off),
    // so the face shows no second number rather than a copy of the first.
    function playsLikeM(player, target, flatM, effect) {
        if (flatM == null) { return null; }
        var slope = slopeM(player, target);
        var withWind = (windApplied || windInPlaysLike()) && effect != null && effect["level"] > 0;
        if (slope == null && !withWind) { return null; }
        var out = flatM;
        if (slope != null) { out += slope; }
        if (withWind) { out += effect["alongM"]; }
        return out > 0 ? out : 0;
    }
}
