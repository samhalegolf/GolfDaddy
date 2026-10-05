package com.claritygolf.caddy.wearables.garmin;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class AdaptiveGateTest {
    @Test public void startsAtOneAndDoublesUpToTheCap() {
        AdaptiveGate gate = new AdaptiveGate(18);
        assertEquals(1, gate.size());
        gate.succeeded(); assertEquals(2, gate.size());
        gate.succeeded(); assertEquals(4, gate.size());
        gate.succeeded(); assertEquals(8, gate.size());
        gate.succeeded(); assertEquals(16, gate.size());
        gate.succeeded(); assertEquals(18, gate.size());
        gate.succeeded(); assertEquals(18, gate.size());
    }

    @Test public void halvesOnFailureButNeverBelowOne() {
        AdaptiveGate gate = new AdaptiveGate(18);
        gate.succeeded(); gate.succeeded(); gate.succeeded();
        gate.failed(); assertEquals(4, gate.size());
        gate.failed(); assertEquals(2, gate.size());
        gate.failed(); assertEquals(1, gate.size());
        gate.failed(); assertEquals(1, gate.size());
    }

    @Test public void settlesUnderALinkThatRefusesBigMessages() {
        // A link that refuses anything over 5 items: after the first refusal
        // the gate climbs one at a time and spends most sends at what fits.
        AdaptiveGate gate = new AdaptiveGate(18);
        int sent = 0, refused = 0;
        for (int i = 0; i < 40; i++) {
            if (gate.size() <= 5) { sent += gate.size(); gate.succeeded(); }
            else { refused += 1; gate.failed(); }
        }
        assertEquals(true, refused <= 6);
        assertEquals(true, sent >= 150);
    }

    @Test public void theWatchCanAskForHoleByHole() {
        AdaptiveGate gate = new AdaptiveGate(18);
        gate.limitTo(1);
        for (int i = 0; i < 5; i++) { gate.succeeded(); assertEquals(1, gate.size()); }
        gate.failed(); assertEquals(1, gate.size());
    }

    @Test public void aLargerRequestNeverRaisesTheCap() {
        AdaptiveGate gate = new AdaptiveGate(3);
        gate.limitTo(10);
        for (int i = 0; i < 5; i++) { gate.succeeded(); }
        assertEquals(3, gate.size());
    }
}
