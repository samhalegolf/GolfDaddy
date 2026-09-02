/* The player half of the Watch package: the playable bag and the saved My
   Bubble, delivered to the wrist as one small versioned snapshot.

   WHY A THIRD TRANSPORT. It fits neither of the two that exist. The Scene is a
   few hundred bytes republished many times a minute, so a bag riding it would
   drag the player's equipment behind every distance update. The lite-map
   package is ~100KB per COURSE and changes only when a course is regenerated;
   a bag belongs to the player and changes when they edit it. So this is its
   own small payload, sent on round start and whenever it changes.

   WHAT IT DOES NOT DO. It does not edit a bag, adopt a Bubble, or decide
   anything about either. The bag comes from the engine's own playable bag
   (account bag, or the ghost stand-in when there is none) and the aim comes
   from the saved My Bubble - a degree value and a handedness, and nothing else
   (Bubble Bible s2). Size is derived on the wrist from the bag, exactly as it
   is here.

   Pure and inert off-native, the same as watch-map-delivery.js: with no
   NativeRoundBridge plugin present, deliver() resolves with a reason and
   touches nothing. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else {
    root.ClarityApp = root.ClarityApp || {};
    root.ClarityApp.watchPlayerDelivery = factory();
    root.GDWatchPlayerDelivery = root.ClarityApp.watchPlayerDelivery;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  var SCHEMA_VERSION = 1;

  /* Which Bubble engine the numbers on this phone come from. The wrist refuses
     to compute locally against an engine it does not implement and renders the
     phone's Bubble instead, so this travelling with the bag is what makes that
     check possible at all.

     READ from caddy-watch.js rather than declared here. That module owns the
     wearable contract and puts the same value on the Scene; a second literal
     in this file is exactly the drift the handshake exists to catch, and it
     would be invisible - the two would simply stop agreeing and the wrist
     would quietly stop computing. There is deliberately NO fallback string: a
     snapshot with no engine version cannot take part in the handshake, so not
     being able to read it is a reason to send nothing. */
  function engineVersion() {
    var factory = (typeof window !== "undefined") && window.ClarityApp && window.ClarityApp.createCaddyWatchBridge;
    var value = factory && factory.BUBBLE_ENGINE_VERSION;
    return typeof value === "string" && value ? value : null;
  }

  function finite(n) { return Number.isFinite(Number(n)); }
  function whole(n) { return Math.round(Number(n) || 0); }

  /* One club, as the wrist receives it: a name and two finished distances. The
     phone has already applied the roll-out preset, so the wrist consumes the
     numbers and has no opinion about how they were produced. */
  function club(row) {
    var name = String(row && (row.club || row.name) || "").trim();
    var carryM = whole(row && (row.baseCarry != null ? row.baseCarry : row.carry));
    if (!name || !(carryM > 0)) return null;
    var totalM = whole(row && row.totalM);
    /* A row with no stored total is not a broken row - a total below the carry
       is simply not a total, and the carry stands in. */
    return { club: name, carryM: carryM, totalM: totalM >= carryM ? totalM : carryM };
  }

  /* Longest total first, which is the bag's own order (gdNormaliseShotBagRows).
     Sorting here rather than trusting arrival order means a shuffled bag has
     the same fingerprint and does not provoke a pointless re-send. */
  function bagFrom(rows) {
    var clubs = (Array.isArray(rows) ? rows : []).map(club).filter(Boolean);
    clubs.sort(function (a, b) { return b.totalM - a.totalM; });
    return {
      isGhost: (Array.isArray(rows) ? rows : []).some(function (row) { return row && row.ghostBag === true; }),
      clubs: clubs
    };
  }

  /* The aim, and only the aim. `offsetDeg` is OMITTED when no My Bubble is set
     - not zero. Bubble Bible s8: a fabricated 0.0 deg reads as a real saved aim
     and was once applied to left-handers as a right-hand miss. The wrist
     applies 0.0 for a missing offset itself, so the maths is identical; what
     the omission buys is the wrist being able to SAY there is no My Bubble. */
  function bubbleFrom(saved, handedness) {
    var out = { handedness: handedness === "left" ? "left" : "right" };
    var deg = saved == null ? null : saved.offsetDeg;
    if (deg !== null && deg !== undefined && deg !== "" && finite(deg)) out.offsetDeg = Number(deg);
    return out;
  }

  /* MUST match WatchPlayerSnapshot.fingerprint(bag:bubble:engineVersion:) in
     ios/WatchBubbleEngine exactly. Pinned on both sides against the shared
     cases in dev/fixtures/bubble-engine-parity.json, because a quiet
     disagreement means the phone re-sends a bag the wrist already has on every
     Scene - or never re-sends one it does not.

     Whole metres, because that is the precision a bag is edited and displayed
     in and a float artefact must not read as an equipment change. `-` for the
     aim means no My Bubble, deliberately distinct from `0`, which is a real
     saved zero-degree aim. */
  function fingerprint(bag, bubble, engineVersion) {
    var parts = ["v1", bag.isGhost ? "g1" : "g0"];
    bag.clubs.forEach(function (row) { parts.push(row.club + ":" + row.carryM + ":" + row.totalM); });
    var aim = finite(bubble.offsetDeg) ? Number(bubble.offsetDeg).toFixed(2) : "-";
    parts.push("b:" + aim + ":" + bubble.handedness);
    parts.push("e:" + engineVersion);
    return parts.join("|");
  }

  function snapshotFrom(rows, saved, handedness, engine) {
    var version = engine || engineVersion();
    if (!version) return null;
    var bag = bagFrom(rows);
    if (!bag.clubs.length) return null;
    var bubble = bubbleFrom(saved, handedness);
    return {
      version: SCHEMA_VERSION,
      fingerprint: fingerprint(bag, bubble, version),
      bag: bag,
      bubble: bubble,
      engineVersion: version
    };
  }

  function createDelivery(options) {
    options = options || {};
    var log = options.log || function () {};
    /* Sources are injected so this module can be exercised without a play
       surface. In the app they are the engine's own playable bag and the one
       module that reads the saved My Bubble. */
    var readBag = options.bag || function () {
      var engine = (typeof window !== "undefined") && window.GDBubbleEngine;
      return engine && typeof engine.playableBag === "function" ? engine.playableBag() : [];
    };
    var readBubble = options.bubble || function () {
      var my = (typeof window !== "undefined") && window.ClarityApp && window.ClarityApp.myBubble;
      if (!my) return { saved: null, handedness: "right" };
      return {
        saved: typeof my.current === "function" ? my.current() : null,
        handedness: typeof my.handedness === "function" ? my.handedness() : "right"
      };
    };
    var readEngineVersion = options.engineVersion || engineVersion;
    var nativePlugin = options.plugin || function () {
      var cap = (typeof window !== "undefined") && window.Capacitor;
      return cap && cap.Plugins && cap.Plugins.NativeRoundBridge;
    };

    /* What the wrist last told us it holds, and what we last handed native.
       Both are needed: the wrist's answer is authoritative but arrives late (or
       never, on a wrist that has not reported yet), and without the local note
       every Scene would re-publish the same snapshot until it did. */
    var wristHas = null;
    var wristEngine = null;
    var sent = null;

    function pluginOrNull() {
      var plugin = typeof nativePlugin === "function" ? nativePlugin() : nativePlugin;
      return plugin && typeof plugin.publishWatchPlayer === "function" ? plugin : null;
    }

    return {
      /* Builds the current snapshot and publishes it if the wrist does not
         already have exactly it. Cheap enough to call on every Scene: it is a
         bag read, a sort and a string compare. */
      deliver: function () {
        var plugin = pluginOrNull();
        if (!plugin) return { delivered: false, reason: "no-native-bridge" };
        var bubble = readBubble() || {};
        var engine = typeof readEngineVersion === "function" ? readEngineVersion() : readEngineVersion;
        /* No engine version, no snapshot. The wrist decides whether it may
           compute locally by comparing versions, and a bag delivered without
           one would leave it unable to answer that at all. */
        if (!engine) return { delivered: false, reason: "no-engine-version" };
        var snapshot = snapshotFrom(readBag(), bubble.saved, bubble.handedness, engine);
        /* No playable bag at all is not a failure to report to the wrist - it
           is a player who has not set one up, and the engine's ghost bag covers
           the phone. Sending an empty bag would let the wrist compute against
           nothing. */
        if (!snapshot) return { delivered: false, reason: "no-playable-bag" };
        /* Two different questions, in order of authority.

           An answer FROM the wrist settles it outright - including an empty
           fingerprint, which is the wrist saying it holds nothing (a fresh
           install, a cleared cache) and is emphatically not the same as never
           having answered. Collapsing the two is how a wrist that has lost its
           bag sits there un-resupplied because the phone still believes it sent
           one. Same trap as the aim offset elsewhere in this payload: absent
           and empty are distinct facts and both are real.

           Only when the wrist has said nothing at all does the local note
           stand in, and its whole job is to stop every Scene re-publishing
           while the first report is still in flight. */
        if (wristHas !== null) {
          if (snapshot.fingerprint === wristHas) {
            sent = snapshot.fingerprint;
            return { delivered: false, reason: "wrist-has-it", fingerprint: snapshot.fingerprint };
          }
        } else if (snapshot.fingerprint === sent) {
          return { delivered: false, reason: "already-sent", fingerprint: snapshot.fingerprint };
        }
        try {
          plugin.publishWatchPlayer({ player: snapshot });
        } catch (error) {
          log("watch player publish failed", error);
          return { delivered: false, reason: "publish-failed" };
        }
        sent = snapshot.fingerprint;
        return { delivered: true, fingerprint: snapshot.fingerprint, clubs: snapshot.bag.clubs.length, ghost: snapshot.bag.isGhost };
      },

      /* The wrist's own report of what it holds, relayed by native. Losing it
         costs one re-send, never correctness - which is why a missing or
         malformed report simply clears the record rather than being trusted. */
      noteInventory: function (report) {
        /* An empty string is kept as an empty string: it is the wrist saying
           "I hold nothing", which must provoke a send. null means "the wrist
           has not told us", which must not. A malformed report is the latter -
           losing a report costs one re-send, never correctness. */
        wristHas = report && typeof report.fingerprint === "string" ? report.fingerprint : null;
        /* The engine the wrist implements, reported alongside. Nothing on the
           phone changes behaviour on it - the WRIST is the end that decides
           whether it may compute, and it defers on its own. This is here so a
           mismatch is visible from the phone's side too, rather than only
           inferable from a Watch that mysteriously never computes. */
        var engine = report && typeof report.engineVersion === "string" ? report.engineVersion : null;
        wristEngine = engine || null;
        return wristHas;
      },

      /* Whether the wrist runs the same Bubble engine this phone does. null
         while the wrist has not reported one. */
      engineAgreement: function () {
        var mine = typeof readEngineVersion === "function" ? readEngineVersion() : readEngineVersion;
        if (!mine || !wristEngine) return { agreed: null, phone: mine || null, watch: wristEngine };
        return { agreed: mine === wristEngine, phone: mine, watch: wristEngine };
      },

      /* A bag edit or a My Bubble save mid-round must reach the wrist without
         waiting for something else to change. Callers clear the local note and
         the next Scene re-publishes. */
      invalidate: function () { sent = null; },

      state: function () { return { sent: sent, wristHas: wristHas, wristEngine: wristEngine }; }
    };
  }

  /* The app-wide instance, bound late so it picks up the Capacitor plugin
     whenever it registers rather than only if it happened to be ready at load.
     Same shape watch-map-delivery.js uses, and for the same reason. */
  var shared = null;
  function ensureShared() {
    if (shared) return shared;
    var capacitor = typeof window !== "undefined" ? window.Capacitor : null;
    if (!(capacitor && capacitor.Plugins && capacitor.Plugins.NativeRoundBridge)) return null;
    shared = createDelivery({});
    return shared;
  }

  return {
    createDelivery: createDelivery,
    SCHEMA_VERSION: SCHEMA_VERSION,
    engineVersion: engineVersion,
    deliver: function () {
      var instance = ensureShared();
      return instance ? instance.deliver() : { delivered: false, reason: "no-native-bridge" };
    },
    noteInventory: function (report) {
      var instance = ensureShared();
      return instance ? instance.noteInventory(report) : null;
    },
    invalidate: function () {
      var instance = ensureShared();
      if (instance) instance.invalidate();
    },
    __test: { club: club, bagFrom: bagFrom, bubbleFrom: bubbleFrom, fingerprint: fingerprint, snapshotFrom: snapshotFrom }
  };
});
