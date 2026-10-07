using Toybox.Lang;
using Toybox.WatchUi;
using Toybox.Graphics;
using Toybox.Math;
using Toybox.System;

// The playing face, drawn to Sam's mockup (2026-10-08):
//
//              144            back of the green
//        (   Back   )         dark-green crescent
//            Hole 7
//        130y      9i         target distance + club
//         [ (+) AIM ]         SELECT: aim on the map
//        (   Front  )         dark-green crescent
//              121            front of the green
//
// Values come from GarminSessionManager: the authoritative Scene's F/B,
// target and club when no local Bubble is available, or the locally
// computed Bubble (GarminSessionManager.localBubble()) when the
// engine-version gate allows it — the same authoritative-vs-local split
// WatchSessionManager's SwiftUI faces make.
//
// Built-in fonts only: a custom font would need its own bitmap per screen
// resolution across the device matrix. Every size is picked by measuring
// against the box the mockup gives it, so the face keeps its proportions
// from a 218 px Instinct to a 454 px fenix.
class NumbersView extends WatchUi.View {
    var session;   // GarminSessionManager
    var aimable;   // Method: GarminMapView.canEnterAimMode, set by CaddyAppView

    // Touch state (CaddyInputDelegate.onTap / onHold drive it):
    //   windZoom     the compass drawn big in the middle, to read it
    //   windApplied  the big number includes the wind, and turns blue
    var windZoom = false;
    var windApplied = false;
    // Where the last draw put the things a finger can hit.
    var numberBox = null;    // [x0, y0, x1, y1]
    var windHit = null;      // [x, y, radius]

    // The mockup's colours. A 64-colour MIP panel would snap the dark
    // crescent green to a loud one, so it gets its own nearest dark green.
    static const PILL_EDGE = 0x1F2A1F;
    static const INK = 0x231F20;
    var crescentColour;
    var pillColour;

    function initialize(session) {
        View.initialize();
        self.session = session;
        var settings = System.getDeviceSettings();
        var amoled = (settings has :requiresBurnInProtection) && settings.requiresBurnInProtection;
        crescentColour = amoled ? 0x0A3F22 : 0x005500;
        pillColour = amoled ? 0x00BF63 : 0x00AA55;
    }

    function onUpdate(dc) {
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_BLACK);
        dc.clear();
        if (dc has :setAntiAlias) { dc.setAntiAlias(true); }

        var w = dc.getWidth();
        var h = dc.getHeight();
        var cx = w / 2;

        var scene = session.scene;
        if (scene == null || !scene.hasRound()) {
            dc.drawText(cx, h / 2, Graphics.FONT_MEDIUM, "No round", Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
            return;
        }

        // The phone's numbers while its Scene speaks for this hole, this
        // wrist's own (course skeleton + its GPS) once it has gone quiet.
        var green = session.greenDistances();
        var front = (green != null) ? green["front"] : null;
        var centre = (green != null) ? green["centre"] : null;
        var back = (green != null) ? green["back"] : null;

        // Prefer Garmin's own locally computed Bubble when the engine
        // versions agree and a trustworthy fix exists; otherwise fall back
        // to the phone-authoritative numbers already on the Scene — never a
        // locally invented approximation (Garmin Phase 1 plan step 10).
        var local = session.localBubble();
        // On a hole the wrist walked onto by itself the Scene's target and
        // club belong to the hole before; the green centre stands in.
        var ownHole = session.localHole != null;
        var targetDistanceM = (local != null) ? local.targetDistanceM : (ownHole ? centre : scene.distanceTargetM());
        var club = (local != null) ? local.club.club : (ownHole ? null : scene.suggestedClub());

        // Wind and slope, the wrist's own (GarminConditions), for the shot
        // to the same point the big number measures to.
        var player = session.playerPoint();
        var aimAt = (local != null) ? local.target : session.aimTarget();
        if (aimAt == null) { aimAt = session.greenPoint(); }
        var effect = session.conditions.windEffect(player, aimAt, targetDistanceM);

        // The big compass covers everything while it is open.
        if (windZoom) {
            if (effect != null) { drawWindZoom(dc, effect, w, h); return; }
            windZoom = false;
        }

        // Crescents first; their labels and everything else sit on top.
        drawCrescent(dc, cx, h * 0.415, w * 0.445, h * 0.295, h * 0.235, true);
        drawCrescent(dc, cx, h * 0.585, w * 0.445, h * 0.305, h * 0.25, false);
        var c = Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER;
        // The labels sit at the very top and bottom of the glass and the
        // values on the crescents, so a wind marker parked at 12 or 6
        // o'clock (drawWindFromRim) only ever covers a label, never a number.
        dc.setColor(Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
        var labelFont = font(dc, h * 0.036, "Front", w * 0.3, [Graphics.FONT_SMALL, Graphics.FONT_TINY, Graphics.FONT_XTINY]);
        if (fits(labelFont, h * 0.036)) {
            dc.drawText(cx, h * 0.07, labelFont, "Back", c);
            dc.drawText(cx, h * 0.93, labelFont, "Front", c);
        }

        // The wind marker goes here in the stack: over the crescents and
        // the labels, under every value and button drawn after it, so where
        // it meets a number it slips underneath rather than hiding it.
        if (effect != null) { drawWindFromRim(dc, effect, w, h); } else { windHit = null; }

        // Back and front of the green, on the crescents.
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        var edgeFont = font(dc, h * 0.05, "888", w * 0.3, [Graphics.FONT_NUMBER_MILD, Graphics.FONT_MEDIUM, Graphics.FONT_SMALL, Graphics.FONT_TINY]);
        dc.drawText(cx, h * 0.15, edgeFont, DistanceFormat.number(back), c);
        dc.drawText(cx, h * 0.852, edgeFont, DistanceFormat.number(front), c);

        var holeNumber = session.currentHole();
        var holeFont = font(dc, h * 0.062, "Hole 18", w * 0.5, [Graphics.FONT_LARGE, Graphics.FONT_MEDIUM, Graphics.FONT_SMALL]);
        dc.drawText(cx, h * 0.29, holeFont, "Hole " + (holeNumber != null ? holeNumber.toString() : "-"), c);

        // A demo says so, and says how to leave it (BACK; see
        // CaddyInputDelegate). A wrist carrying the round alone says that.
        // Between the top crescent and the hole, where nothing else draws.
        var note = null;
        if (scene.isDemo()) { note = "DEMO - BACK ends"; }
        else if (green != null && green["fromWatch"]) { note = "WATCH GPS"; }
        var noteFont = font(dc, h * 0.03, (note != null) ? note : "", w * 0.6, [Graphics.FONT_XTINY]);
        if (note != null) {
            dc.setColor(scene.isDemo() ? Graphics.COLOR_GREEN : Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
            dc.drawText(cx, h * 0.222, noteFont, note, c);
            dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        }

        // Wind applied (double-tap / long-press): the big number is the
        // distance plus the wind's +/-, in the wind blue.
        var windOn = windApplied && effect != null && effect["level"] > 0 && targetDistanceM != null;
        drawDistanceAndClub(dc, windOn ? targetDistanceM + effect["alongM"] : targetDistanceM, club, w, h, windOn);

        var plays = session.conditions.playsLikeM(player, aimAt, targetDistanceM, effect);
        if (plays != null) {
            // The map's slope orange (GarminMapView.SLOPE_ORANGE).
            dc.setColor(0xFFAA00, Graphics.COLOR_TRANSPARENT);
            var playsText = "plays " + DistanceFormat.number(plays);
            dc.drawText(cx, h * 0.575, font(dc, h * 0.042, playsText, w * 0.5, [Graphics.FONT_SMALL, Graphics.FONT_TINY, Graphics.FONT_XTINY]), playsText, c);
        }
        drawAimButton(dc, w, h);

    }

    // A lens between two half-ellipses that share their tips: the outer
    // edge bulges `outerReach` from the tips' line, the inner `innerReach`.
    // `up` points the bulge at the top of the glass.
    function drawCrescent(dc, cx, tipY, halfSpan, outerReach, innerReach, up) {
        var steps = 24;
        var sign = up ? -1 : 1;
        var points = new [steps * 2 + 2];
        for (var i = 0; i <= steps; i += 1) {
            var a = Math.PI * i / steps;
            var x = cx - halfSpan * Math.cos(a);
            var s = Math.sin(a);
            points[i] = [x, tipY + sign * outerReach * s];
            points[steps * 2 + 1 - i] = [x, tipY + sign * innerReach * s];
        }
        dc.setColor(crescentColour, crescentColour);
        dc.fillPolygon(points);
    }

    // "130y   9i": the number to the target with its unit tucked at the
    // baseline, and the club in the same type, as big as the band allows.
    function drawDistanceAndClub(dc, targetDistanceM, club, w, h, windOn) {
        var y = h * 0.45;
        var distance = DistanceFormat.number(targetDistanceM);
        var clubText = shortClub(club);
        var unit = DistanceFormat.suffix();

        var cap = h * 0.18;
        var numberFont = font(dc, cap, "888", w * 0.5,
            [Graphics.FONT_NUMBER_HOT, Graphics.FONT_NUMBER_MEDIUM, Graphics.FONT_NUMBER_MILD, Graphics.FONT_LARGE]);
        // Built-in text fonts stop well short of the number fonts, so on a
        // watch without vector type the club is as big as text gets.
        var clubFont = font(dc, cap, "PW", w * 0.3, [Graphics.FONT_LARGE, Graphics.FONT_MEDIUM, Graphics.FONT_SMALL]);
        var unitFont = font(dc, h * 0.05, "y", w, [Graphics.FONT_TINY]);

        // Without vector type the text fonts stop well short of the number
        // fonts, so a club's leading digits ("9" of "9i") borrow the number
        // font and only its letters drop to text.
        var clubDigits = "";
        var clubLetters = clubText;
        if (clubFont instanceof Lang.Number) {
            var n = 0;
            while (n < clubText.length() && "0123456789".find(clubText.substring(n, n + 1)) != null) { n += 1; }
            clubDigits = clubText.substring(0, n);
            clubLetters = clubText.substring(n, clubText.length());
        }

        var numberW = dc.getTextDimensions(distance, numberFont)[0];
        var unitSize = dc.getTextDimensions(unit, unitFont);
        var digitsW = (clubDigits.length() > 0) ? dc.getTextDimensions(clubDigits, numberFont)[0] : 0;
        var lettersW = (clubLetters.length() > 0) ? dc.getTextDimensions(clubLetters, clubFont)[0] : 0;
        var gap = w * 0.06;
        var left = (w - (numberW + unitSize[0] + gap + digitsW + lettersW)) / 2;
        var clubLeft = left + numberW + unitSize[0] + gap;

        var vc = Graphics.TEXT_JUSTIFY_LEFT | Graphics.TEXT_JUSTIFY_VCENTER;
        dc.setColor(windOn ? 0x55AAFF : Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(left, y, numberFont, distance, vc);
        numberBox = [left - w * 0.03, y - cap * 0.75, left + numberW + unitSize[0] + w * 0.03, y + cap * 0.75];
        // The unit stays with its number's colour; the club is always white.
        dc.drawText(left + numberW, baselineY(numberFont, y), unitFont, unit, vc);
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        if (digitsW > 0) { dc.drawText(clubLeft, y, numberFont, clubDigits, vc); }
        if (lettersW > 0) {
            // Letters after borrowed digits share the digits' baseline;
            // a club that is all letters centres on the row like the rest.
            var lettersY = (digitsW > 0) ? baselineY(numberFont, y) - baselineY(clubFont, 0) : y;
            dc.drawText(clubLeft + digitsW, lettersY, clubFont, clubLetters, vc);
        }
    }

    // Where a VCENTER-drawn line at `y` puts its baseline: VCENTER centres
    // the whole line box, and the baseline sits `ascent` below its top.
    function baselineY(f, y) {
        return y - Graphics.getFontHeight(f) / 2.0 + Graphics.getFontAscent(f);
    }

    // The bag's own short names ("9i", "PW", "3W") already fit; only the
    // driver is spelled out.
    function shortClub(club) {
        if (club == null) { return "-"; }
        if (club.equals("Driver")) { return "Dr"; }
        return club;
    }

    // The mockup's AIM pill: SELECT (or a tap) opens the map in Aim Mode.
    // Where the wrist cannot aim locally yet, SELECT still LOCKs, as this
    // face always has (CaddyInputDelegate.handleSelect), and the pill says so.
    function drawAimButton(dc, w, h) {
        var canAim = aimable != null && aimable.invoke();
        var canLock = session.scene != null && session.scene.canLock();
        var busy = session.outbox.isPending(GarminCommandKind.LOCK);
        var label = canAim ? "AIM" : (busy ? "..." : (session.lockedShot != null ? "LOCKED" : "LOCK"));
        var live = canAim || canLock || session.lockedShot != null;

        var left = w * 0.3;
        var top = h * 0.625;
        var bw = w * 0.4;
        var bh = h * 0.165;
        var r = bh / 2;
        var edge = (w >= 300) ? 3 : 2;
        dc.setColor(PILL_EDGE, PILL_EDGE);
        dc.fillRoundedRectangle(left - edge, top - edge, bw + edge * 2, bh + edge * 2, r + edge);
        dc.setColor(live ? pillColour : Graphics.COLOR_DK_GRAY, Graphics.COLOR_TRANSPARENT);
        dc.fillRoundedRectangle(left, top, bw, bh, r);

        // Crosshair: a ring broken where the cross passes, the cross
        // running past the pill top and bottom, a dot in the middle.
        var ccx = left + r;
        var ccy = top + bh / 2;
        var ring = bh * 0.36;
        var line = (w >= 300) ? 2 : 1;
        dc.setColor(INK, Graphics.COLOR_TRANSPARENT);
        dc.setPenWidth(line);
        for (var q = 0; q < 4; q += 1) {
            dc.drawArc(ccx, ccy, ring, Graphics.ARC_COUNTER_CLOCKWISE, q * 90 + 6, q * 90 + 84);
        }
        var stub = bh * 0.06;
        dc.drawLine(ccx, top - bh * 0.08, ccx, ccy - stub);
        dc.drawLine(ccx, ccy + stub, ccx, top + bh * 1.08);
        dc.drawLine(left, ccy, ccx - stub, ccy);
        dc.drawLine(ccx + stub, ccy, ccx + bh * 0.58, ccy);
        dc.fillCircle(ccx, ccy, (w >= 300) ? 3 : 2);
        dc.setPenWidth(1);

        var textLeft = ccx + bh * 0.62;
        var textRight = left + bw - r * 0.55;
        var labelFont = font(dc, bh * 0.5, label, textRight - textLeft, [Graphics.FONT_LARGE, Graphics.FONT_MEDIUM, Graphics.FONT_SMALL, Graphics.FONT_TINY]);
        dc.setColor(Graphics.COLOR_BLACK, Graphics.COLOR_TRANSPARENT);
        dc.drawText((textLeft + textRight) / 2, ccy, labelFont, label, Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
    }

    // The wind marker at (x, ay), `dial` its scale - small in the corner
    // the wind comes from (windCorner), big in drawWindZoom. The arrow shows
    // where the wind blows, turned to the line of play (up is at the target);
    // the hub says how far it moves the shot along the line, in the watch's
    // own unit. Always shown when the watch has weather; whether it joins
    // the big number is windApplied, the plays number the windInPlaysLike
    // setting.
    function drawWind(dc, effect, x, ay, dial, w) {
        // Sized as one piece that fits its corner: the hub, the shaft just
        // clearing it at the tail, the point a head's length past it.
        var r = dial * 1.05;      // the tail
        var tipR = dial * 1.3;    // the point

        var big = dial > w * 0.15;

        // The arrow, turning about the hub: tail and head both well out
        // past it. The map's wind blue (GarminMapView.WIND_BLUE).
        if (effect["level"] > 0) {
            var a = effect["relRad"];
            var sinA = Math.sin(a);
            var cosA = Math.cos(a);
            // Screen y grows downward; the tip is "forward".
            var tipX = x + sinA * tipR;
            var tipY = ay - cosA * tipR;
            var tailX = x - sinA * r;
            var tailY = ay + cosA * r;
            var headBackX = x + sinA * dial * 0.82;
            var headBackY = ay - cosA * dial * 0.82;
            var side = dial * 0.32;
            dc.setColor(0x55AAFF, 0x55AAFF);
            dc.setPenWidth(big ? 9 : ((w >= 300) ? 4 : 3));
            dc.drawLine(tailX, tailY, headBackX, headBackY);
            dc.setPenWidth(1);
            dc.fillPolygon([
                [tipX, tipY],
                [headBackX + cosA * side, headBackY + sinA * side],
                [headBackX - cosA * side, headBackY - sinA * side]
            ]);
        }

        drawWindHub(dc, effect, x, ay, dial * 0.66, big);
    }

    // The distance on a dark hub the shaft runs under: the number owns the
    // circle, the unit a tiny tag after it.
    function drawWindHub(dc, effect, x, ay, hub, big) {
        dc.setColor(0x1A1A1A, 0x1A1A1A);
        dc.fillCircle(x, ay, hub);
        dc.setColor(0x55AAFF, Graphics.COLOR_TRANSPARENT);
        dc.setPenWidth(big ? 3 : 1);
        dc.drawCircle(x, ay, hub);
        dc.setPenWidth(1);
        var shown = DistanceFormat.value(effect["alongM"] < 0 ? -effect["alongM"] : effect["alongM"]);
        // No sign: where the marker sits and which way its arrow points
        // already say with or against. The number owns the hub; the unit is
        // a tiny tag after it, there only to say "a distance", not a speed.
        var digits = shown.toString();
        var unit = DistanceFormat.suffix();
        var numFont = font(dc, hub * 1.05, "12", hub * 1.5,
            big ? [Graphics.FONT_NUMBER_HOT, Graphics.FONT_NUMBER_MEDIUM, Graphics.FONT_LARGE]
                : [Graphics.FONT_MEDIUM, Graphics.FONT_SMALL, Graphics.FONT_TINY, Graphics.FONT_XTINY]);
        var unitFont = font(dc, hub * 0.32, "y", hub, big ? [Graphics.FONT_SMALL, Graphics.FONT_TINY] : [Graphics.FONT_XTINY]);
        var dw = dc.getTextDimensions(digits, numFont)[0];
        var uw = dc.getTextDimensions(unit, unitFont)[0];
        var left = x - (dw + uw) / 2.0;
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(left, ay, numFont, digits, Graphics.TEXT_JUSTIFY_LEFT | Graphics.TEXT_JUSTIFY_VCENTER);
        dc.setColor(Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
        dc.drawText(left + dw, baselineY(numFont, ay) - baselineY(unitFont, 0), unitFont, unit, Graphics.TEXT_JUSTIFY_LEFT | Graphics.TEXT_JUSTIFY_VCENTER);
    }

    // The wind on the face: the distance hub sits hard against the edge of
    // the glass at the exact point the wind comes FROM, with up as the
    // target - anywhere round the edge - with a pointed bump on its rim
    // aimed at the middle of the face, which is the way the wind blows.
    // "Against the edge" is worked out per watch (round or rectangular
    // glass); the bump stands a little prouder on a big screen
    // (windTipLength). Calm: the hub alone at 4 o'clock, no bump.
    function drawWindFromRim(dc, effect, w, h) {
        var hubR = h * 0.078 * 0.66;
        var phi = (effect["level"] > 0) ? effect["relRad"] + Math.PI : Math.toRadians(120);
        var hub = edgePoint(phi, hubR + 2, w, h);
        var hx = hub[0];
        var hy = hub[1];

        if (effect["level"] > 0) {
            var dx = w / 2.0 - hx;
            var dy = h / 2.0 - hy;
            var d = Math.sqrt(dx * dx + dy * dy);
            var ux = (d > 0) ? dx / d : 0.0;
            var uy = (d > 0) ? dy / d : -1.0;
            // The bump: a point standing off the rim, its sides meeting the
            // circle about 40 degrees either side so it grows out of it.
            var tip = hubR + windTipLength(w, hubR);
            var spread = Math.toRadians(40);
            var c = Math.cos(spread);
            var sn = Math.sin(spread);
            var lx = ux * c - uy * sn;
            var ly = ux * sn + uy * c;
            var rx = ux * c + uy * sn;
            var ry = -ux * sn + uy * c;
            dc.setColor(0x55AAFF, 0x55AAFF);
            dc.fillPolygon([
                [hx + ux * tip, hy + uy * tip],
                [hx + lx * hubR, hy + ly * hubR],
                [hx + rx * hubR, hy + ry * hubR]
            ]);
        }
        drawWindHub(dc, effect, hx, hy, hubR, false);
        windHit = [hx, hy, hubR * 1.8];
    }

    // How far the bump stands off the hub: prouder the more glass there is.
    function windTipLength(w, hubR) {
        if (w >= 390) { return hubR * 0.75; }
        if (w >= 260) { return hubR * 0.65; }
        return hubR * 0.55;
    }

    // Where a circle of radius `inset` touches the glass's edge from the
    // inside, along the ray at `phi` (clockwise from up): the inscribed
    // circle on a round (or semi-round) face, the frame on a rectangle.
    function edgePoint(phi, inset, w, h) {
        var cx = w / 2.0;
        var cy = h / 2.0;
        var sx = Math.sin(phi);
        var sy = -Math.cos(phi);
        var reach;
        if (DeviceCapabilities.screenShape().equals("rectangle")) {
            var ax = (sx < 0) ? -sx : sx;
            var ay = (sy < 0) ? -sy : sy;
            var tx = (ax > 0.001) ? (cx - inset) / ax : 99999.0;
            var ty = (ay > 0.001) ? (cy - inset) / ay : 99999.0;
            reach = (tx < ty) ? tx : ty;
        } else {
            reach = ((cx < cy) ? cx : cy) - inset;
        }
        return [cx + sx * reach, cy + sy * reach];
    }


    // The compass opened up: big in the middle with the wind's strength
    // under it, in the watch's own unit (mph for yards, km/h for metres).
    function drawWindZoom(dc, effect, w, h) {
        dc.setColor(Graphics.COLOR_BLACK, Graphics.COLOR_BLACK);
        dc.clear();
        var dial = h * 0.25;
        drawWind(dc, effect, w / 2, h * 0.46, dial, w);
        windHit = [w / 2, h * 0.46, dial * 1.4];
        var kmh = effect["kmh"];
        var speed = DistanceFormat.yards() ? (kmh / 1.609344 + 0.5).toNumber().toString() + " mph" : (kmh + 0.5).toNumber().toString() + " km/h";
        dc.setColor(Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
        dc.drawText(w / 2, h * 0.88, font(dc, h * 0.045, speed, w * 0.5, [Graphics.FONT_SMALL, Graphics.FONT_TINY]), speed,
            Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
    }

    // What a finger at (x, y) is on: "zoom" (anywhere, while the big compass
    // is open), "wind" (the compass), "number" (the big number), or null.
    function hit(x, y) {
        if (windZoom) { return "zoom"; }
        if (windHit != null) {
            var dx = x - windHit[0];
            var dy = y - windHit[1];
            if (dx * dx + dy * dy <= windHit[2] * windHit[2]) { return "wind"; }
        }
        if (numberBox != null && x >= numberBox[0] && x <= numberBox[2] && y >= numberBox[1] && y <= numberBox[3]) {
            return "number";
        }
        return null;
    }

    // Heavy condensed vector type, the nearest thing on the watch to the
    // mockup's face: whichever of these the watch carries (CIQ 4.2.1+).
    // Not BionicBold, heavier though it is: on the fenix 7 and others it
    // is a digits-only file, and "9i" drew as "9".
    static const FACES = ["RobotoCondensedBold", "RobotoBlack", "NanumGothicExtraBold", "NanumGothicBold"];
    var vectorCache = {};

    // A font whose capitals stand `capPx` tall and whose `sample` fits in
    // `maxWidth`: vector type where the watch has it, otherwise the largest
    // of the built-in `fallbacks` (largest first) that fits the same box.
    function font(dc, capPx, sample, maxWidth, fallbacks) {
        if (Graphics has :getVectorFont) {
            // A capital is about 0.72 of the em in all of FACES.
            var size = (capPx / 0.72).toNumber();
            var vf = vector(size);
            if (vf != null) {
                var wide = dc.getTextDimensions(sample, vf)[0];
                if (wide > maxWidth) {
                    vf = vector((size * maxWidth / wide).toNumber());
                }
                if (vf != null) { return vf; }
            }
        }
        for (var i = 0; i < fallbacks.size(); i += 1) {
            var size = dc.getTextDimensions(sample, fallbacks[i]);
            // Ascent rather than the line box: number fonts pad theirs heavily.
            if (size[0] <= maxWidth && Graphics.getFontAscent(fallbacks[i]) <= capPx * 1.3) { return fallbacks[i]; }
        }
        return fallbacks[fallbacks.size() - 1];
    }

    // Whether a font stands no taller than its box allows. Vector type was
    // sized to it; a built-in font (a Number) may still be too big on a
    // watch whose smallest font is large, and then the caller leaves the
    // text off rather than run it into its neighbours.
    function fits(f, capPx) {
        return !(f instanceof Lang.Number) || Graphics.getFontAscent(f as Graphics.FontDefinition) <= capPx * 1.6;
    }

    function vector(size) {
        var f = vectorCache[size];
        if (f == null) {
            f = Graphics.getVectorFont({ :face => FACES, :size => size });
            if (f == null) { return null; }
            vectorCache[size] = f;
        }
        return f;
    }
}
