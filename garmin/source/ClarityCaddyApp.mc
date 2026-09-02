using Toybox.Application;
using Toybox.WatchUi;
using Toybox.Lang;
using Toybox.Timer;

// App entry point. Owns the single GarminSessionManager for the process
// lifetime — mirrors how WatchSessionManager.swift is a single
// @MainActor ObservableObject owned by ClarityCaddyWatchApp.swift's App
// struct on watchOS.
class ClarityCaddyApp extends Application.AppBase {
    var session;    // GarminSessionManager
    var refreshTimer;

    function initialize() {
        AppBase.initialize();
    }

    function onStart(state) {
        session = new GarminSessionManager();
        // Periodic redraw so the F/C/B distances and the locked-shot expiry
        // (GarminLockedShot.MAX_UNCONFIRMED_AGE_MS) stay live even with no
        // new Scene or GPS fix in the last tick — matches the cadence
        // Apple's SwiftUI @Published bindings get for free.
        refreshTimer = new Timer.Timer();
        refreshTimer.start(method(:onTick), 1000, true);
    }

    function onTick() {
        WatchUi.requestUpdate();
    }

    function onStop(state) {
        if (refreshTimer != null) { refreshTimer.stop(); }
    }

    function getInitialView() {
        var view = new CaddyAppView(session);
        var delegate = new CaddyInputDelegate(session, view);
        return [view, delegate];
    }
}
