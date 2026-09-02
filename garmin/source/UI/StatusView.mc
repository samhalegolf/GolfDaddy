using Toybox.Lang;
using Toybox.WatchUi;
using Toybox.Graphics;

// The non-playing faces — mirrors WatchSessionManager.Face's noRound/
// receiving/ready/taking states (ios/App/ClarityCaddyWatch/
// WatchSessionManager.swift), drawn as plain status text since Phase 1 has
// no SwiftUI-style per-face view hierarchy to lean on.
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

        if (face.equals(GarminSessionManager.FACE_NO_ROUND)) {
            line2 = "Waiting for round";
        } else if (face.equals(GarminSessionManager.FACE_RECEIVING)) {
            var have = session.mapsHeldCount();
            var total = session.mapsExpectedCount();
            line2 = "Receiving course " + have.toString() + "/" + total.toString();
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
}
