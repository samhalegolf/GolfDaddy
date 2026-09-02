using Toybox.WatchUi;
using Toybox.Lang;

// Root view. Chooses between StatusView (no round / receiving / ready /
// taking), NumbersView and GarminMapView (playing) based on
// GarminSessionManager.face() plus the player's own Numbers<->Map choice —
// mirroring WatchSessionManager.Face's role driving which SwiftUI face
// shows on the Apple Watch, and the Garmin Phase 1+2 plan step 23's "two
// main surfaces, no deep menu hierarchy" requirement.
//
// Composed rather than pushed via WatchUi.pushView/popView: there is
// exactly one screen showing at a time and no navigation stack to manage —
// see CaddyInputDelegate for how MENU/BACK move between Numbers and Map.
class CaddyAppView extends WatchUi.View {
    var session;      // GarminSessionManager
    var statusView;
    var numbersView;
    var mapView;
    var showingMap;

    function initialize(session) {
        View.initialize();
        self.session = session;
        statusView = new StatusView(session);
        numbersView = new NumbersView(session);
        mapView = new GarminMapView(session);
        showingMap = false;
    }

    function onUpdate(dc) {
        if (session.face().equals(GarminSessionManager.FACE_PLAYING)) {
            if (showingMap) { mapView.onUpdate(dc); } else { numbersView.onUpdate(dc); }
        } else {
            // Leaving the playing face resets the Numbers<->Map choice, so
            // a new round or a hand-back always opens on Numbers rather
            // than resuming wherever the player last left the map.
            showingMap = false;
            statusView.onUpdate(dc);
        }
    }

    function showMap() { showingMap = true; }
    function showNumbers() { showingMap = false; }
    function toggleMapNumbers() { showingMap = !showingMap; }
}
