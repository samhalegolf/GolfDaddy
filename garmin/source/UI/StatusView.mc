using Toybox.Lang;
using Toybox.WatchUi;
using Toybox.Graphics;

// The non-playing faces — mirrors WatchSessionManager.Face's noRound/
// ready/taking states (ios/App/ClarityCaddyWatch/WatchSessionManager.swift),
// drawn as plain status text since Phase 1 has no SwiftUI-style per-face
// view hierarchy to lean on. Apple's `receiving` face is absent on purpose
// — see GarminSessionManager's Face constants for why.
class StatusView extends WatchUi.View {
    var session;   // GarminSessionManager

    function initialize(session) {
        View.initialize();
        self.session = session;
    }

    function onUpdate(dc) {
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_BLACK);
        dc.clear();

        var face = session.face();
        var line1 = "Clarity Caddy";
        var line2 = "";

        if (face.equals(GarminSessionManager.FACE_READY) && session.scene != null && session.scene.canDemo()) {
            drawDemoBrowser(dc);
            return;
        }

        if (face.equals(GarminSessionManager.FACE_NO_ROUND)) {
            line2 = "Waiting for round";
        } else if (face.equals(GarminSessionManager.FACE_READY)) {
            line2 = "Ready - press SELECT";
        } else if (face.equals(GarminSessionManager.FACE_TAKING)) {
            line2 = "Taking over...";
        }

        dc.drawText(dc.getWidth() / 2, dc.getHeight() * 0.42, Graphics.FONT_MEDIUM, line1, Graphics.TEXT_JUSTIFY_CENTER);
        dc.drawText(dc.getWidth() / 2, dc.getHeight() * 0.55, Graphics.FONT_SMALL, line2, Graphics.TEXT_JUSTIFY_CENTER);

        if (session.handoverNotice != null) {
            dc.drawText(dc.getWidth() / 2, dc.getHeight() * 0.75, Graphics.FONT_XTINY, session.handoverNotice, Graphics.TEXT_JUSTIFY_CENTER);
        }
    }

    // Preview on the wrist: the phone is off the course, so every hole can
    // be stepped through (UP/DOWN) and demoed (SELECT) - the phone puts the
    // player 100-130m short of that green and hands the round here, onto the
    // same Playing face a real round reaches. Mirrors Apple's DemoBrowserFace.
    function drawDemoBrowser(dc) {
        var w = dc.getWidth();
        var h = dc.getHeight();
        var hole = session.demoHole();
        var par = session.scene.parFor(hole);
        dc.setColor(Graphics.COLOR_GREEN, Graphics.COLOR_TRANSPARENT);
        dc.drawText(w / 2, h * 0.14, Graphics.FONT_XTINY, "PREVIEW", Graphics.TEXT_JUSTIFY_CENTER);
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(w / 2, h * 0.27, Graphics.FONT_MEDIUM, "Hole " + hole.toString(), Graphics.TEXT_JUSTIFY_CENTER);
        if (par != null) {
            dc.setColor(Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
            dc.drawText(w / 2, h * 0.43, Graphics.FONT_SMALL, "PAR " + par.toString(), Graphics.TEXT_JUSTIFY_CENTER);
        }
        var busy = session.outbox.isPending(GarminCommandKind.DEMO_APPROACH);
        dc.setColor(Graphics.COLOR_BLACK, Graphics.COLOR_GREEN);
        dc.fillRoundedRectangle(w * 0.2, h * 0.58, w * 0.6, h * 0.13, 6);
        dc.setColor(Graphics.COLOR_BLACK, Graphics.COLOR_TRANSPARENT);
        dc.drawText(w / 2, h * 0.595, Graphics.FONT_SMALL, busy ? "..." : "DEMO", Graphics.TEXT_JUSTIFY_CENTER);
        dc.setColor(Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
        var hint = (session.lastRejection != null) ? "Couldn't start demo" : "UP/DOWN hole  SELECT demo";
        dc.drawText(w / 2, h * 0.76, Graphics.FONT_XTINY, hint, Graphics.TEXT_JUSTIFY_CENTER);
    }
}
