using Toybox.Lang;
using Toybox.WatchUi;
using Toybox.Graphics;

// Phase 1's playing face — numbers-first, per the Garmin Phase 1 plan step
// 25:
//
//   HOLE 7
//   F   142
//   C   151
//   B   160
//        154 m
//        7 IRON
//       [ LOCK ]
//
// Deliberately does not draw a map (that is Phase 2). Values come from
// GarminSessionManager: the authoritative Scene's F/C/B/target/club when no
// local Bubble is available, or the locally computed Bubble
// (GarminSessionManager.localBubble()) when the engine-version gate allows
// it — the same authoritative-vs-local split WatchSessionManager's SwiftUI
// faces make, just drawn imperatively here since Monkey C has no
// declarative view layer.
class NumbersView extends WatchUi.View {
    var session;   // GarminSessionManager

    function initialize(session) {
        View.initialize();
        self.session = session;
    }

    function onUpdate(dc) {
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_BLACK);
        dc.clear();

        var scene = session.scene;
        if (scene == null || !scene.hasRound()) {
            drawCentered(dc, "No round", dc.getHeight() / 2);
            return;
        }

        var inset = LayoutProfile.horizontalInsetPx();
        var width = dc.getWidth();
        var y = dc.getHeight() * 0.12;
        var lineHeight = dc.getHeight() * (LayoutProfile.isCompactHeight() ? 0.15 : 0.13);

        var holeNumber = session.currentHole();
        drawCentered(dc, "HOLE " + (holeNumber != null ? holeNumber.toString() : "-"), y);
        // A demo says so, and says how to leave it (BACK; see
        // CaddyInputDelegate). Above the hole, where nothing else draws.
        if (scene.isDemo()) {
            dc.setColor(Graphics.COLOR_GREEN, Graphics.COLOR_TRANSPARENT);
            dc.drawText(width / 2, y - lineHeight * 0.45, Graphics.FONT_XTINY, "DEMO - BACK ends", Graphics.TEXT_JUSTIFY_CENTER);
            dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        }
        y += lineHeight;

        // The phone's numbers while its Scene speaks for this hole, this
        // wrist's own (course skeleton + its GPS) once it has gone quiet -
        // marked, so a player knows the watch is carrying the round alone.
        var green = session.greenDistances();
        var front = (green != null) ? green["front"] : null;
        var centre = (green != null) ? green["centre"] : null;
        var back = (green != null) ? green["back"] : null;
        if (green != null && green["fromWatch"] && !scene.isDemo()) {
            dc.setColor(Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
            dc.drawText(width / 2, y - lineHeight * 0.45, Graphics.FONT_XTINY, "WATCH GPS", Graphics.TEXT_JUSTIFY_CENTER);
            dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        }
        drawRow(dc, "F", front, inset, y, width);
        y += lineHeight * 0.75;
        drawRow(dc, "C", centre, inset, y, width);
        y += lineHeight * 0.75;
        drawRow(dc, "B", back, inset, y, width);
        y += lineHeight;

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

        drawCentered(dc, formatMetres(targetDistanceM), y);
        y += lineHeight;
        drawCentered(dc, (club != null) ? club.toUpper() : "-", y);
        y += lineHeight;

        drawLockButton(dc, y, width);
    }

    function drawRow(dc, label, valueM, inset, y, width) {
        dc.drawText(inset, y, Graphics.FONT_SMALL, label, Graphics.TEXT_JUSTIFY_LEFT);
        dc.drawText(width - inset, y, Graphics.FONT_SMALL, formatMetres(valueM), Graphics.TEXT_JUSTIFY_RIGHT);
    }

    function drawCentered(dc, text, y) {
        dc.drawText(dc.getWidth() / 2, y, Graphics.FONT_MEDIUM, text, Graphics.TEXT_JUSTIFY_CENTER);
    }

    function drawLockButton(dc, y, width) {
        var locked = session.lockedShot != null;
        var busy = session.outbox.isPending(GarminCommandKind.LOCK);
        var label = locked ? "LOCKED" : (busy ? "..." : "LOCK");
        dc.setColor(Graphics.COLOR_BLACK, locked ? Graphics.COLOR_GREEN : Graphics.COLOR_DK_GRAY);
        dc.fillRoundedRectangle(width * 0.2, y, width * 0.6, dc.getHeight() * 0.12, 6);
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(dc.getWidth() / 2, y + dc.getHeight() * 0.02, Graphics.FONT_SMALL, label, Graphics.TEXT_JUSTIFY_CENTER);
    }

    function formatMetres(value) {
        if (value == null) { return "-"; }
        return (value + 0.5).toNumber().toString() + " m";
    }
}
