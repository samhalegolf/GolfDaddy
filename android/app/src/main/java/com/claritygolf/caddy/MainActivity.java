package com.claritygolf.caddy;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    /* NativeRoundBridge is not an npm-published Capacitor plugin, so it is
       not picked up by capacitor.build.gradle's auto-registration (that
       only scans installed @capacitor/* packages) the way it is on iOS via
       registerPlugin(NativeRoundBridge.class) before super.onCreate() is
       the correct hook: registerPlugin() only accumulates the class into
       bridgeBuilder, and super.onCreate() is what finally builds the
       Bridge from it (BridgeActivity.load(), called at the end of its
       onCreate) — see com.getcapacitor.BridgeActivity's own source for why
       registration must land before that point. */
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeRoundBridge.class);
        super.onCreate(savedInstanceState);
    }
}
