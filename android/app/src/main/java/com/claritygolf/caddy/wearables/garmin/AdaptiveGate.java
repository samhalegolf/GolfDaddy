package com.claritygolf.caddy.wearables.garmin;

/** How much to put in the next message over a link whose limits are not
 *  known in advance - start small, work up, back off.
 *
 *  <p>A Connect IQ link refuses a message it thinks too large
 *  (FAILURE_MESSAGE_TOO_LARGE: a whole course package did, 2026-09-21), drops
 *  out while a phone sleeps in a bag, and differs by watch, phone and SDK. So
 *  rather than guess a fixed size, a delivery starts at one item, doubles the
 *  batch after every success (1, 2, 4, 8 ... up to {@code max}) and halves it
 *  after every failure, resending the same items smaller. A good link drains
 *  in a handful of sends; a strict one settles at what it will take. Pure
 *  arithmetic, no Android, so it is unit-tested as is (AdaptiveGateTest). The
 *  watch's own sender runs the same rule in the other direction
 *  (garmin/source/Session/GarminSender.mc). */
public final class AdaptiveGate {
    /** Clean sends at the edge before the remembered ceiling is probed again. */
    static final int PROBE_AFTER = 8;

    private int max;
    private int size = 1;
    private int ceiling = Integer.MAX_VALUE;   // smallest size known to have been refused
    private int cleanAtEdge = 0;
    private int lastGood = 0;                  // the largest size that last went through

    public AdaptiveGate(int max) { this.max = Math.max(1, max); }

    public int size() { return size; }

    /** The far end can ask for less (the watch's {@code maxPart}: 1 means
     *  hole by hole). Never raises the cap, and never below one. */
    public void limitTo(int requested) {
        if (requested >= 1 && requested < max) { max = requested; }
        if (size > max) { size = max; }
    }

    /* Double until the first refusal (slow start); after one, grow by one at
       a time below the size that was refused, so a link that takes five is
       not offered eight on every other send. PROBE_AFTER clean sends at the
       edge nudge the ceiling up a step - links get better as well as worse. */
    public void succeeded() {
        lastGood = size;
        if (ceiling == Integer.MAX_VALUE) {
            size = Math.min(max, size * 2);
            return;
        }
        if (size + 1 < ceiling) {
            size = Math.min(max, size + 1);
            cleanAtEdge = 0;
            return;
        }
        cleanAtEdge += 1;
        if (cleanAtEdge >= PROBE_AFTER) {
            ceiling += 1;
            cleanAtEdge = 0;
            size = Math.min(max, size + 1);
        }
    }

    /* A refused PROBE (one step past what just worked) goes straight back
       to what worked; any other refusal - the link getting worse - halves. */
    public void failed() {
        boolean probe = lastGood > 0 && size == lastGood + 1;
        ceiling = Math.max(1, size);
        cleanAtEdge = 0;
        size = probe ? lastGood : Math.max(1, size / 2);
        lastGood = 0;
    }
}
