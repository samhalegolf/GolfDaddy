/* Bag editor: club list + carry distances + firmness. This is the fresh app's
   own bag store — not the legacy per-account profile bag — so the shot/bubble
   engine's ghost-bag fallback (bubble-engine.js's PLACEHOLDER_PLAYER_PROFILE)
   only applies until the player has actually set clubs here. Persists locally;
   feeds the engine through GDBubbleEngine.setBag on every change (see the
   gdShotActiveProfile rebind in dev/generate-bubble-engine-client.js). */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});
  var STORE_KEY = "clarity:bag:v1";
  var FIRMNESS_KEY = "gd_bag_total_firmness_v1";   // same key bubble-engine.js already reads

  function load() {
    try {
      var raw = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      var clubs = raw && Array.isArray(raw.clubs) ? raw.clubs : [];
      return clubs.filter(function (c) {
        return c && String(c.club || "").trim() && Number(c.baseCarry) > 0;
      }).map(function (c) {
        return { club: String(c.club).trim(), baseCarry: Math.round(Number(c.baseCarry)) };
      });
    } catch (e) { return []; }
  }

  function save(clubs) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ clubs: clubs })); } catch (e) {}
  }

  function firmness() {
    try {
      var stored = localStorage.getItem(FIRMNESS_KEY);
      return stored === "soft" || stored === "hard" ? stored : "medium";
    } catch (e) { return "medium"; }
  }

  function setFirmness(preset) {
    try { localStorage.setItem(FIRMNESS_KEY, preset); } catch (e) {}
    render();
  }

  var clubs = load();

  function sync() {
    save(clubs);
    if (window.GDBubbleEngine) window.GDBubbleEngine.setBag(clubs);
  }

  function render() {
    var list = document.getElementById("bagList");
    if (!list) return;
    list.textContent = "";
    clubs.forEach(function (row, i) {
      var el = document.createElement("div");
      el.className = "bagRow";
      var clubInput = document.createElement("input");
      clubInput.type = "text";
      clubInput.value = row.club;
      clubInput.setAttribute("aria-label", "Club name");
      clubInput.addEventListener("change", function () {
        var v = clubInput.value.trim();
        if (v) { clubs[i].club = v; sync(); } else { clubInput.value = clubs[i].club; }
      });
      var carryInput = document.createElement("input");
      carryInput.type = "number";
      carryInput.inputMode = "numeric";
      carryInput.min = "1";
      carryInput.step = "1";
      carryInput.value = String(row.baseCarry);
      carryInput.setAttribute("aria-label", "Carry metres");
      carryInput.addEventListener("change", function () {
        var v = Math.round(Number(carryInput.value));
        if (v > 0) { clubs[i].baseCarry = v; sync(); } else { carryInput.value = String(clubs[i].baseCarry); }
      });
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
      el.appendChild(clubInput);
      el.appendChild(carryInput);
      el.appendChild(remove);
      list.appendChild(el);
    });
    var preset = firmness();
    document.querySelectorAll("#bagFirmness [data-firmness]").forEach(function (btn) {
      btn.setAttribute("aria-pressed", btn.dataset.firmness === preset ? "true" : "false");
    });
  }

  function addClub(club, carry) {
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
      var panel = document.getElementById("bagPanel");
      if (panel) panel.classList.remove("hiddenState");
      render();
    },
    close: function () {
      var panel = document.getElementById("bagPanel");
      if (panel) panel.classList.add("hiddenState");
    },
    rows: function () { return clubs.slice(); }
  };

  document.addEventListener("DOMContentLoaded", function () {
    if (window.GDBubbleEngine) window.GDBubbleEngine.setBag(clubs);

    var close = document.getElementById("bagClose");
    if (close) close.addEventListener("click", function () { app.bag.close(); });

    var addBtn = document.getElementById("bagAddBtn");
    if (addBtn) addBtn.addEventListener("click", function () {
      var clubInput = document.getElementById("bagAddClub");
      var carryInput = document.getElementById("bagAddCarry");
      if (addClub(clubInput.value, carryInput.value)) {
        clubInput.value = "";
        carryInput.value = "";
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

    render();
  });
})();
