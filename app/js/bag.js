/* Bag editor: club list + carry distances + firmness.
 *
 * ONE BAG. This used to keep its own store at `clarity:bag:v1`, separate from
 * the per-account profile bag the shell's Bag panel writes — so a player who
 * adopted practice distances in the Shot System saw no change to the bubble on
 * the course, and a bag built on the course never reached the cloud, the
 * backup, or their coach. Two stores, neither wrong, never meeting. The profile
 * bag won because it already had all of that; this file now reads and writes it
 * (`gd_player_profiles_v27`, same store and resolver as my-bubble.js).
 *
 * The engine still gets its bag through GDBubbleEngine.setBag, and still falls
 * back to its own ghost bag (bubble-engine.js's GD_DEFAULT_CLUB_CARRY_M) when
 * there isn't a real one. `placeholderProfile` and `bagSeededDefault` are what
 * tell those apart: a seeded default set is NOT a real bag, and passing it as
 * one would quietly retire the ghost.
 *
 * The ghost bag is free. Replacing it with your own clubs is the membership.
 * A player without one sees the ghost distances that are driving their bubble,
 * read-only, which is the thing they would be buying control of.
 */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});
  var PROFILE_KEY = "gd_player_profiles_v27";      // gd-app-core.js GD_PROFILE_STORE_KEY
  var FIRMNESS_KEY = "gd_bag_total_firmness_v1";   // same key bubble-engine.js already reads

  function safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }

  function store() {
    return safe(function () { return JSON.parse(localStorage.getItem(PROFILE_KEY) || "null") || {}; }, {});
  }

  /* Same resolver as my-bubble.js, deliberately: two different answers to
     "which profile is active" is how the two-bag split happened. */
  function activeProfile(raw) {
    raw = raw || store();
    var profiles = Array.isArray(raw.profiles) ? raw.profiles : [];
    if (!profiles.length) return null;
    return profiles.filter(function (p) { return p && p.id === raw.activeId; })[0] || profiles[0];
  }

  function normalise(rows) {
    return (Array.isArray(rows) ? rows : []).map(function (c) {
      var club = String(c && (c.club || c.name) || "").trim();
      var carry = Math.round(Number(c && (c.baseCarry != null ? c.baseCarry : c.carry)) || 0);
      return club && carry > 0 ? { club: club, baseCarry: carry } : null;
    }).filter(Boolean);
  }

  /* A REAL bag, or nothing. A seeded default set answers "nothing" on purpose,
     so the engine keeps using its ghost rather than treating stand-in numbers
     as the player's own. */
  function load() {
    var p = activeProfile();
    if (!p || p.placeholderProfile || p.bagSeededDefault) return [];
    return normalise(p.bag);
  }

  /* Mirrors gd-app-core's gdBagPersistRows, minus the shell-only rendering: the
     same three flags have to move together or the ghost/real distinction breaks
     the next time either side reads it. Refuses without a profile rather than
     inventing one - editing is a member action, and a member has an account. */
  function save(clubs) {
    var raw = store();
    var p = activeProfile(raw);
    if (!p) return false;
    p.bag = normalise(clubs).map(function (row) {
      return { club: row.club, baseCarry: row.baseCarry, totalM: totalFor(row) };
    });
    p.bagSlotsTouched = true;
    p.bagSeededDefault = false;
    p.placeholderProfile = false;
    p.updatedAt = new Date().toISOString();
    return safe(function () { localStorage.setItem(PROFILE_KEY, JSON.stringify(raw)); return true; }, false);
  }

  function totalFor(row) {
    var engine = window.GDBubbleEngine;
    var defaults = engine && engine.defaultBagRows ? engine.defaultBagRows() : [];
    var match = defaults.filter(function (r) { return r.club === row.club; })[0];
    var ratio = match && match.baseCarry > 0 ? match.totalM / match.baseCarry : 1;
    return Math.max(row.baseCarry, Math.round(row.baseCarry * ratio));
  }

  function ghostRows() {
    var engine = window.GDBubbleEngine;
    return normalise(engine && engine.defaultBagRows ? engine.defaultBagRows() : []);
  }

  function canEdit() {
    return !app.access || app.access.roundFeatures();
  }

  /* Handedness, from the same profile the bag comes from.
   *
   * It is a PLAYER value, not a round preference, which is why it lives here
   * beside the clubs and not in GPS Settings: both answer "who is swinging",
   * and both have to be the same answer in both shells. The old shell has had
   * a handedness select for a long time (#profileHandInput); /app/ could read
   * the result but never set it, so a left-hander playing only on the phone
   * got a right-hander's bubble with no way to say otherwise.
   *
   * Right unless the profile explicitly says left - the same rule
   * my-bubble.js, gdHandednessSign and every other reader uses. Anything that
   * is not the exact string "left" is right-handed, so a missing or malformed
   * value lands on the default rather than producing a third behaviour. */
  function handedness() {
    var p = activeProfile();
    return p && p.handedness === "left" ? "left" : "right";
  }

  /* Refuses without a profile rather than inventing one, exactly as save()
     does - see the note there. */
  function setHandedness(value) {
    if (!canEdit()) return refuse();
    var raw = store();
    var p = activeProfile(raw);
    if (!p) return false;
    p.handedness = value === "left" ? "left" : "right";
    p.updatedAt = new Date().toISOString();
    var ok = safe(function () { localStorage.setItem(PROFILE_KEY, JSON.stringify(raw)); return true; }, false);
    /* Every bubble on the surface re-derives from this immediately. Without the
       refresh the change would not show until the next profile read, which is
       whenever the app next happened to wake - and a setting that appears to do
       nothing gets pressed again. */
    if (ok && app.myBubble && app.myBubble.refresh) app.myBubble.refresh();
    return ok;
  }

  function renderHandedness() {
    var button = document.getElementById("bagHandToggle");
    if (!button) return;
    var left = handedness() === "left";
    button.textContent = left ? "Left handed" : "Right handed";
    button.setAttribute("aria-pressed", left ? "true" : "false");
  }

  function firmness() {
    var stored = safe(function () { return localStorage.getItem(FIRMNESS_KEY); }, null);
    return stored === "soft" || stored === "hard" ? stored : "medium";
  }

  function setFirmness(preset) {
    if (!canEdit()) return refuse();
    safe(function () { localStorage.setItem(FIRMNESS_KEY, preset); });
    render();
  }

  function refuse() {
    if (app.access && app.access.prompt) app.access.prompt("set your own club distances");
    return false;
  }

  var clubs = load();

  function sync() {
    save(clubs);
    if (window.GDBubbleEngine) window.GDBubbleEngine.setBag(clubs);
  }

  /* What the list shows is not always what the engine is using: with no real
     bag it shows the ghost rows, because "these are the numbers behind your
     bubble" is the honest answer and an empty list is not. */
  function render() {
    var list = document.getElementById("bagList");
    if (!list) return;
    var editable = canEdit();
    var showingGhost = !clubs.length;
    var rows = showingGhost ? ghostRows() : clubs;

    var notice = document.getElementById("bagNotice");
    if (notice) {
      notice.classList.toggle("hiddenState", editable && !showingGhost);
      notice.textContent = !editable
        ? "These are the standard distances driving your bubble. A Clarity membership lets you set your own."
        : showingGhost
          ? "Standard distances, until you set your own."
          : "";
    }

    list.textContent = "";
    rows.forEach(function (row, i) {
      var el = document.createElement("div");
      el.className = "bagRow";

      var clubInput = document.createElement("input");
      clubInput.type = "text";
      clubInput.value = row.club;
      clubInput.setAttribute("aria-label", "Club name");

      var carryInput = document.createElement("input");
      carryInput.type = "number";
      carryInput.inputMode = "numeric";
      carryInput.min = "1";
      carryInput.step = "1";
      carryInput.value = String(row.baseCarry);
      carryInput.setAttribute("aria-label", "Carry metres");

      /* One metre a tap, in both directions.
       *
       * step="1" only governs the platform's own spinner, and on a phone there
       * isn't one - the number field opens a keyboard, so nudging a club by a
       * metre meant selecting the value and retyping it. These are the actual
       * fine control, and they are the reason the field can be trusted to move
       * in ones: nothing about them is left to the platform. */
      var nudge = function (delta) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "bagRowNudge";
        button.textContent = delta < 0 ? "−" : "+";
        button.setAttribute("aria-label", (delta < 0 ? "Decrease " : "Increase ") + row.club + " by one metre");
        button.addEventListener("click", function () {
          if (!editable) return refuse();
          var next = Math.round(Number(carryInput.value)) + delta;
          if (!(next > 0)) return;
          carryInput.value = String(next);
          clubs[i].baseCarry = next;
          sync();
        });
        return button;
      };

      if (!editable) {
        /* readOnly rather than disabled: a disabled input cannot be tapped, and
           the tap is how the player finds out why it will not change. */
        [clubInput, carryInput].forEach(function (input) {
          input.readOnly = true;
          input.addEventListener("focus", function () { input.blur(); refuse(); });
          input.addEventListener("click", refuse);
        });
      } else {
        clubInput.addEventListener("change", function () {
          var v = clubInput.value.trim();
          if (v) { clubs[i].club = v; sync(); } else { clubInput.value = clubs[i].club; }
        });
        carryInput.addEventListener("change", function () {
          var v = Math.round(Number(carryInput.value));
          if (v > 0) { clubs[i].baseCarry = v; sync(); } else { carryInput.value = String(clubs[i].baseCarry); }
        });
      }

      el.appendChild(clubInput);
      /* Only on a real bag. The ghost rows are the shipped defaults being shown
         because there is nothing else to show - nudging one would write a bag
         the player never set. */
      if (editable && !showingGhost) el.appendChild(nudge(-1));
      el.appendChild(carryInput);
      if (editable && !showingGhost) el.appendChild(nudge(1));

      if (editable && !showingGhost) {
        var remove = document.createElement("button");
        remove.type = "button";
        remove.className = "bagRowRemove";
        remove.setAttribute("aria-label", "Remove " + row.club);
        remove.textContent = "×";
        remove.addEventListener("click", function () {
          clubs.splice(i, 1);
          sync();
          render();
        });
        el.appendChild(remove);
      }

      list.appendChild(el);
    });

    renderHandedness();
    var preset = firmness();
    document.querySelectorAll("#bagFirmness [data-firmness]").forEach(function (btn) {
      btn.setAttribute("aria-pressed", btn.dataset.firmness === preset ? "true" : "false");
    });
    ["bagAddRow", "bagQuickRow"].forEach(function (cls) {
      document.querySelectorAll("." + cls).forEach(function (el) {
        el.classList.toggle("hiddenState", !editable);
      });
    });
  }

  function addClub(club, carry) {
    if (!canEdit()) return refuse();
    var name = String(club || "").trim();
    var m = Math.round(Number(carry));
    if (!name || !(m > 0)) return false;
    clubs.push({ club: name, baseCarry: m });
    sync();
    render();
    return true;
  }

  /* The full club set scaled off one 7-iron carry — same ratios as the legacy
     quick-set generator (gdBagGenerateQuick), sourced from the engine's own
     shipped ghost-bag defaults (GDBubbleEngine.defaultBagRows, which wraps
     the verbatim GD_DEFAULT_CLUB_CARRY_M) rather than a hand-copied table. */
  function generateQuickSet(sevenIronCarry) {
    if (!canEdit()) return refuse();
    var base = Number(sevenIronCarry);
    var defaults = window.GDBubbleEngine ? window.GDBubbleEngine.defaultBagRows() : [];
    var ref = defaults.filter(function (r) { return r.club === "7i"; })[0];
    if (!(base > 0) || !defaults.length || !ref || !(ref.baseCarry > 0)) return;
    var scale = base / ref.baseCarry;
    clubs = defaults.map(function (row) {
      return { club: row.club, baseCarry: Math.round(row.baseCarry * scale) };
    });
    sync();
    render();
  }

  app.bag = {
    open: function () {
      /* Re-read on open: the shell's own Bag panel writes the same store, and
         a stale copy here is how the two bags used to disagree. */
      clubs = load();
      if (window.GDBubbleEngine) window.GDBubbleEngine.setBag(clubs);
      var panel = document.getElementById("bagPanel");
      if (panel) panel.classList.remove("hiddenState");
      render();
    },
    close: function () {
      var panel = document.getElementById("bagPanel");
      if (panel) panel.classList.add("hiddenState");
    },
    rows: function () { return clubs.slice(); },
    /* Exposed so anything asking "which way does this player swing" has one
       place to ask, rather than each caller re-reading the profile store and
       re-deriving the left/right rule. */
    handedness: handedness,
    setHandedness: setHandedness
  };

  document.addEventListener("DOMContentLoaded", function () {
    if (window.GDBubbleEngine) window.GDBubbleEngine.setBag(clubs);

    var close = document.getElementById("bagClose");
    if (close) close.addEventListener("click", function () { app.bag.close(); });

    /* Name first, then distance.
     *
     * The carry field and Add button stay out of the way until the club has a
     * name, so adding a club is one question at a time rather than two blanks
     * side by side. Naming it also moves the cursor to the distance, which is
     * the only thing left to answer. */
    var addClubInput = document.getElementById("bagAddClub");
    var addCarryInput = document.getElementById("bagAddCarry");
    var addBtn = document.getElementById("bagAddBtn");

    function showAddStepTwo(named) {
      if (addCarryInput) addCarryInput.classList.toggle("hiddenState", !named);
      if (addBtn) addBtn.classList.toggle("hiddenState", !named);
    }

    if (addClubInput) {
      /* input, not change: the second step should appear as the player types,
         not when they happen to leave the field. */
      addClubInput.addEventListener("input", function () {
        showAddStepTwo(!!addClubInput.value.trim());
      });
      addClubInput.addEventListener("keydown", function (event) {
        if (event.key !== "Enter" || !addClubInput.value.trim()) return;
        event.preventDefault();
        showAddStepTwo(true);
        if (addCarryInput) addCarryInput.focus();
      });
    }

    if (addBtn) addBtn.addEventListener("click", function () {
      if (addClub(addClubInput.value, addCarryInput.value)) {
        addClubInput.value = "";
        addCarryInput.value = "";
        /* Back to step one, ready for the next club. */
        showAddStepTwo(false);
        addClubInput.focus();
      }
    });

    var quickBtn = document.getElementById("bagQuickBtn");
    if (quickBtn) quickBtn.addEventListener("click", function () {
      var input = document.getElementById("bagQuick7i");
      generateQuickSet(input.value);
    });

    document.querySelectorAll("#bagFirmness [data-firmness]").forEach(function (btn) {
      btn.addEventListener("click", function () { setFirmness(btn.dataset.firmness); });
    });

    var handToggle = document.getElementById("bagHandToggle");
    if (handToggle) handToggle.addEventListener("click", function () {
      if (setHandedness(handedness() === "left" ? "right" : "left")) renderHandedness();
    });

    render();
  });
})();
