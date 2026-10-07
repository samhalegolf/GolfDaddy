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

        // Crescents first; their labels and everything else sit on top.
        drawCrescent(dc, cx, h * 0.415, w * 0.445, h * 0.295, h * 0.235, true);
        drawCrescent(dc, cx, h * 0.585, w * 0.445, h * 0.305, h * 0.25, false);
        var c = Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER;
        dc.setColor(Graphics.COLOR_BLACK, Graphics.COLOR_TRANSPARENT);
        var labelFont = font(dc, h * 0.04, "Front", w * 0.3, [Graphics.FONT_SMALL, Graphics.FONT_TINY, Graphics.FONT_XTINY]);
        if (fits(labelFont, h * 0.04)) {
            dc.drawText(cx, h * 0.149, labelFont, "Back", c);
            dc.drawText(cx, h * 0.852, labelFont, "Front", c);
        }

        // Back and front of the green, at the very top and bottom of the glass.
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        var edgeFont = font(dc, h * 0.052, "888", w * 0.3, [Graphics.FONT_NUMBER_MILD, Graphics.FONT_MEDIUM, Graphics.FONT_SMALL, Graphics.FONT_TINY]);
        dc.drawText(cx, h * 0.072, edgeFont, DistanceFormat.number(back), c);
        dc.drawText(cx, h * 0.93, edgeFont, DistanceFormat.number(front), c);

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

        drawDistanceAndClub(dc, targetDistanceM, club, w, h);
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
    function drawDistanceAndClub(dc, targetDistanceM, club, w, h) {
        var y = h * 0.47;
        var distance = DistanceFormat.number(targetDistanceM);
        var clubText = shortClub(club);
        var unit = DistanceFormat.suffix();

        var cap = h * 0.2;
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
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(left, y, numberFont, distance, vc);
        if (digitsW > 0) { dc.drawText(clubLeft, y, numberFont, clubDigits, vc); }
        if (lettersW > 0) {
            // Letters after borrowed digits share the digits' baseline;
            // a club that is all letters centres on the row like the rest.
            var lettersY = (digitsW > 0) ? baselineY(numberFont, y) - baselineY(clubFont, 0) : y;
            dc.drawText(clubLeft + digitsW, lettersY, clubFont, clubLetters, vc);
        }
        // The unit hangs off the digits' baseline, as in the mockup.
        dc.drawText(left + numberW, baselineY(numberFont, y), unitFont, unit, vc);
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

        var left = w * 0.28;
        var top = h * 0.625;
        var bw = w * 0.45;
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
