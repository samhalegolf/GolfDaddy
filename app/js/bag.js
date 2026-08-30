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
 *
 * ONE LIST, TOO. The clubs were already shared; the way they were shown was
 * not. This surface drew its own column of rows in its own order while the
 * shell's Bag panel drew a two-column, longest-first grid, so the same bag
 * looked like two different bags depending on which door the player came
 * through. Both now render through GDBagCore (scripts/gd-bag-core.js), which
 * owns the order, the markup and the edit semantics; this file keeps only the
 * things that are genuinely local - the profile store, membership, handedness
 * and firmness.
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

  function core() { return window.GDBagCore; }

  /* Longest club first, always - the shell's panel reads this same stored bag
     back and must not have to re-order it. GDBagCore owns the rule. */
  function normalise(rows) {
    var list = (Array.isArray(rows) ? rows : []).map(function (c) {
      var club = String(c && (c.club || c.name) || "").trim();
      var carry = Math.round(Number(c && (c.baseCarry != null ? c.baseCarry : c.carry)) || 0);
      return club && carry > 0 ? { club: club, baseCarry: carry } : null;
    }).filter(Boolean);
    return safe(function () { return core().sortRows(list); }, list);
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

  /* Roll-out, from the same calculator the shell uses. It used to be derived
     here from the ghost bag's own carry:total ratio, which is close but not the
     same number - so a club edited on the course and the identical club edited
     in the shell stored different totals for the same carry. The ghost ratio
     stays as the fallback for a page where the core has not loaded. */
  function totalFor(row) {
    var club = row && row.club;
    var carry = Math.round(Number(row && row.baseCarry) || 0);
    var fromCore = safe(function () { return Math.round(core().totalForCarry(club, carry, firmness())) || 0; }, 0);
    if (fromCore >= carry && fromCore > 0) return fromCore;
    var engine = window.GDBubbleEngine;
    var defaults = engine && engine.defaultBagRows ? engine.defaultBagRows() : [];
    var match = defaults.filter(function (r) { return r.club === club; })[0];
    var ratio = match && match.baseCarry > 0 ? match.totalM / match.baseCarry : 1;
    return Math.max(carry, Math.round(carry * ratio));
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
    /* Re-persist, don't just redraw: the totals are stored alongside the
       carries, and the shell reads those stored numbers. Redrawing alone left
       this surface showing one total and the shell showing the old one. */
    if (clubs.length) sync();
    render();
  }

  function refuse() {
    if (app.access && app.access.prompt) app.access.prompt("set your own club distances");
    return false;
  }

  var clubs = load();
  /* Which club's editor is open, tracked by NAME: every write re-sorts the bag
     by distance, so a position in the list does not survive an edit. */
  var editing = null;
  var editingAnchorRows = null;

  function sync() {
    save(clubs);
    if (window.GDBubbleEngine) window.GDBubbleEngine.setBag(clubs);
  }

  /* One write path for the in-place edits, so a refusal from the core (an empty
     name, a duplicate club) says why instead of silently doing nothing. */
  function apply(result) {
    if (!result) return;
    if (result.error) { render(); note(result.error); return; }
    editing = result.club || editing;
    clubs = result.rows;
    sync();
    render();
  }

  /* No toast on this surface - the notice line above the list is where the bag
     panel already explains itself. */
  function note(message) {
    var el = document.getElementById("bagNotice");
    if (!el) return;
    el.classList.remove("hiddenState");
    el.textContent = message;
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

    /* One renderer, shared with the shell's Bag panel: two columns filled left
       column first, longest club top-left, shortest at the end of the right
       column, and a tap opens that club's name and carry in place. */
    safe(function () {
      core().renderList(list, {
        rows: rows,
        editing: editing,
        anchorEditing: !!editingAnchorRows,
        anchorRows: editingAnchorRows,
        artBase: "../",
        onEdit: function (club) {
          if (!editable) return refuse();
          /* The ghost rows are the shipped defaults shown because there is
             nothing else to show; opening one would edit a bag the player
             never set. The notice above the list says so, and Add a club is
             the way out of it. */
          if (showingGhost) return;
          editing = club || null;
          editingAnchorRows = editing ? clubs.slice() : null;
          render();
        },
        onRename: function (club, label) { apply(core().renameRow(clubs, club, label)); },
        onCarry: function (club, metres) { apply(core().setCarry(clubs, club, metres)); },
        onRemove: function (club) {
          var result = core().removeRow(clubs, club);
          editing = null;
          editingAnchorRows = null;
          clubs = result.rows;
          sync();
          render();
        }
      });
    }, null);

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

  /* Name first, then distance - and through the core's add, so a blank name or
     a club already in the bag is refused the same way it is in the shell. */
  function addClub(club, carry) {
    if (!canEdit()) return refuse();
    var result = safe(function () { return core().addRow(clubs, club, carry); }, null);
    if (!result) return false;
    if (result.error) { render(); note(result.error); return false; }
    clubs = result.rows;
    editing = result.club;
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
    var generated = safe(function () { return window.GDBagGenerator.generate(base); }, null);
    if (!(base > 0) || !generated || !generated.length) return;
    clubs = normalise(generated);
    editing = null;
    editingAnchorRows = null;
    sync();
    render();
  }

  function generateRest() {
    if (!canEdit()) return refuse();
    var input = document.getElementById("bagQuick7i");
    var result = safe(function () { return window.GDBagGenerator.generateRest(clubs, input && input.value); }, null);
    if (!result || result.error) { note((result && result.error) || "Enter your 7-iron carry first"); return; }
    var message = "Generate the rest of your bag?\n\nWe'll use your 7-iron carry to estimate " + result.added + " missing club" + (result.added === 1 ? "" : "s") + ". Your " + result.retained + " existing club" + (result.retained === 1 ? " stays" : "s stay") + " unchanged. You can edit every distance afterwards.";
    if (!window.confirm(message)) return;
    clubs = normalise(result.rows);
    editing = null;
    editingAnchorRows = null;
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
    var restBtn = document.getElementById("bagRestBtn");
    if (restBtn) restBtn.addEventListener("click", generateRest);

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
