/* The bag, once.
 *
 * There are three ways into the bag - the home tile, the in-play rail icon,
 * and the bag tool on the player's profile - and two shells that draw it: the
 * legacy shell at /index.html and the play surface at /app/index.html. All of
 * them already read and write the SAME clubs (`gd_player_profiles_v27`), but
 * until this file each shell owned its own list markup, its own sort, and its
 * own idea of what a total distance was. Same data, two answers - the player
 * saw their bag reordered and their totals shift depending on which door they
 * came through.
 *
 * This module is the one answer. It owns:
 *
 *   - the shape of a club row (normalise / totalForCarry),
 *   - the ORDER clubs appear in (sortRows / columnOrder),
 *   - the list UI itself (renderList), markup and handlers both,
 *   - the edit semantics every caller has to agree on (rename / setCarry /
 *     addRow / removeRow).
 *
 * It owns no storage. Each shell still persists through its own profile
 * plumbing and hands the rows back in; this file never touches localStorage
 * except to read the roll-out preset, which is a display setting rather than
 * part of the bag.
 *
 * ORDER, precisely, because it is the thing that used to differ: longest club
 * first, and the two-column grid fills the LEFT column top-to-bottom before it
 * starts the right one. So the top-left cell is always the longest club in the
 * bag and the last cell of the right column is always the shortest. The grid
 * itself flows row-major, so `columnOrder` re-emits the sorted rows
 * interleaved (left[0], right[0], left[1], right[1] ...) - the DOM order that
 * a row-major grid paints as two top-to-bottom columns.
 */
(function () {
  "use strict";
  var win = window;
  if (win.GDBagCore && win.GDBagCore.__owner === "GDBagCore") return;

  var COLUMNS = 2;
  /* VERBATIM from gd-app-core.js's GD_CLUB_GROUPS (and app/js/bubble-engine.js's
     identical copy). Roll-out is derived from this grouping, so a wider pattern
     here would make the same club run on differently in the two shells - which
     is the class of bug this file exists to end. Widen it in all three or not
     at all. */
  var CLUB_GROUPS = { driver: /driver/i, woodHybrid: /3w|wood|hybrid|4h/i, wedge: /pw|gw|sw|lw|wedge/i };
  /* The shells' shipped roll-out percentages. woodHybrid is NOT the .095 that
     sits in their fallback table - gdRolloutBasePct never reads it, it scales
     the iron figure by 1.35 - so this is the number a wood actually runs on. */
  var ROLLOUT_PCT = { driver: 0.11, iron: 0.075, wedge: 0.047 };
  ROLLOUT_PCT.woodHybrid = ROLLOUT_PCT.iron * 1.35;
  var FIRMNESS = { soft: { label: "Soft", multiplier: 0.45 }, medium: { label: "Normal", multiplier: 1 }, hard: { label: "Firm", multiplier: 1.65 } };
  var FIRMNESS_KEY = "gd_bag_total_firmness_v1";
  var ART_ASPECT = { driver: "710 / 302", wood: "681 / 208", hybrid: "666 / 146", blade: "674 / 222" };

  function safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }
  function num(value) { var n = Number(value); return Number.isFinite(n) ? n : 0; }

  function clubName(row) {
    if (!row) return "";
    return String(row.club || row.name || row.clubName || row.club_name || row.clubLabel || row.label || "").trim();
  }
  function carryValue(row) {
    if (!row) return 0;
    var raw = row.baseCarry != null ? row.baseCarry
      : row.carry != null ? row.carry
      : row.carryM != null ? row.carryM
      : row.distance != null ? row.distance
      : row.meters != null ? row.meters
      : row.metres != null ? row.metres
      : row.totalM;
    return num(raw);
  }
  function savedTotal(row) {
    if (!row) return 0;
    var raw = row.totalM != null ? row.totalM : row.total != null ? row.total : row.totalDistance != null ? row.totalDistance : row.baseTotal;
    return num(raw);
  }

  function group(club) {
    var name = String(club || "");
    if (CLUB_GROUPS.driver.test(name)) return "driver";
    if (CLUB_GROUPS.woodHybrid.test(name)) return "woodHybrid";
    if (CLUB_GROUPS.wedge.test(name)) return "wedge";
    return "iron";
  }

  function firmness() {
    var stored = safe(function () { return localStorage.getItem(FIRMNESS_KEY); }, null);
    return FIRMNESS[stored] ? stored : "medium";
  }
  function firmnessLabel(preset) { return (FIRMNESS[preset || firmness()] || FIRMNESS.medium).label; }

  /* The legacy shell tunes roll-out through its developer settings, so defer to
     its calculator when it is loaded. The formula below is the same one, with
     the shipped percentages - it is what the play surface, which has no
     developer settings, has always used. */
  function totalForCarry(club, carry, preset) {
    var c = Math.max(0, Math.round(num(carry)));
    if (!c) return 0;
    var host = safe(function () {
      return typeof win.gdBagTotalForCarry === "function" ? Math.round(win.gdBagTotalForCarry(club, c, preset)) : 0;
    }, 0);
    if (host >= c) return host;
    var pct = Math.max(0, (ROLLOUT_PCT[group(club)] || ROLLOUT_PCT.iron) * ((FIRMNESS[preset || firmness()] || FIRMNESS.medium).multiplier));
    return Math.max(c, Math.round(c * (1 + pct)));
  }

  function normalise(row, forcedClub) {
    if (!row || row.ghost) return null;
    var source = (row && typeof row === "object") ? row : { baseCarry: row };
    var club = String(forcedClub || clubName(source)).trim();
    var carry = Math.round(carryValue(source));
    if (!club || !(carry > 0)) return null;
    var saved = Math.round(savedTotal(source));
    return { club: club, baseCarry: carry, totalM: Math.max(carry, saved > 0 ? saved : totalForCarry(club, carry)) };
  }

  function rowTotal(row) { return num(row && (row.totalM || row.baseCarry)); }

  /* Longest first. Carry breaks a total tie so two clubs that run out to the
     same number still land in the order the player hits them. */
  function sortRows(rows) {
    return (Array.isArray(rows) ? rows : [])
      .map(function (row) { return normalise(row); })
      .filter(Boolean)
      .sort(function (a, b) { return (rowTotal(b) - rowTotal(a)) || (b.baseCarry - a.baseCarry); });
  }

  /* Sorted rows -> the DOM order a row-major grid needs to paint them as
     column-first columns. The left column takes the ceiling half, so an odd
     bag puts the extra club on the left and the shortest club still ends the
     right-hand column. */
  function columnOrder(rows, columns) {
    var list = Array.isArray(rows) ? rows : [];
    var cols = Math.max(1, Math.round(num(columns)) || COLUMNS);
    var lines = Math.ceil(list.length / cols);
    var out = [];
    for (var line = 0; line < lines; line++) {
      for (var col = 0; col < cols; col++) {
        var index = col * lines + line;
        if (index < list.length) out.push({ row: list[index], index: index, column: col, line: line });
      }
    }
    return out;
  }

  /* ---- edit semantics, shared so a rename means the same thing in both shells ---- */

  function sameLabel(a, b) { return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase(); }

  function addRow(rows, club, carry) {
    var list = sortRows(rows);
    var label = String(club || "").trim();
    var metres = Math.round(num(carry));
    if (!label) return { rows: list, error: "Give the club a name first" };
    if (!(metres > 0)) return { rows: list, error: "Give the club a distance" };
    if (list.some(function (r) { return sameLabel(r.club, label); })) return { rows: list, error: label + " is already in the bag" };
    return { rows: sortRows(list.concat([{ club: label, baseCarry: metres, totalM: totalForCarry(label, metres) }])), club: label };
  }

  function renameRow(rows, club, label) {
    var list = sortRows(rows);
    var next = String(label || "").trim();
    var current = list.filter(function (r) { return sameLabel(r.club, club); })[0];
    if (!current) return { rows: list, error: "" };
    if (!next) return { rows: list, error: "A club needs a name" };
    if (sameLabel(next, current.club)) return { rows: list, club: current.club };
    if (list.some(function (r) { return sameLabel(r.club, next); })) return { rows: list, error: next + " is already in the bag" };
    return {
      rows: sortRows(list.map(function (r) {
        /* Re-derive the total from the new label: roll-out is a property of the
           club, so a 4i renamed to 4H runs on further on the same carry. */
        return sameLabel(r.club, club) ? { club: next, baseCarry: r.baseCarry, totalM: totalForCarry(next, r.baseCarry) } : r;
      })),
      club: next
    };
  }

  function setCarry(rows, club, carry) {
    var list = sortRows(rows);
    var current = list.filter(function (r) { return sameLabel(r.club, club); })[0];
    if (!current) return { rows: list, error: "" };
    var metres = Math.max(20, Math.min(400, Math.round(num(carry) || current.baseCarry)));
    return {
      rows: sortRows(list.map(function (r) {
        return sameLabel(r.club, club) ? { club: r.club, baseCarry: metres, totalM: totalForCarry(r.club, metres) } : r;
      })),
      club: current.club
    };
  }

  function removeRow(rows, club) {
    var list = sortRows(rows);
    return {
      rows: list.filter(function (r) { return !sameLabel(r.club, club); }),
      club: (list.filter(function (r) { return sameLabel(r.club, club); })[0] || {}).club || ""
    };
  }

  /* ---- the list itself ---- */

  /* Which picture to draw. Cosmetic, so it may be broader than the roll-out
     grouping above without the two shells disagreeing about a distance. */
  function art(club) {
    var name = String(club || "");
    if (/driver/i.test(name)) return "driver";
    if (/\d\s*w\b|wood/i.test(name)) return "wood";
    if (/\d\s*h\b|hybrid|rescue/i.test(name)) return "hybrid";
    return "blade";
  }

  function elem(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function editorFor(row, opts) {
    var wrap = elem("div", "gdBagRowEdit");

    /* The label first, because it is the thing that had no editor at all: a
       club generated by the bag builder arrived named and there was no way to
       say it was actually a 5-wood. Same order as adding one - name, then
       number. */
    var nameField = elem("label", "gdBagRowName");
    nameField.appendChild(elem("span", null, "Club"));
    var nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = row.club;
    nameInput.autocomplete = "off";
    nameInput.setAttribute("aria-label", "Club name");
    nameInput.addEventListener("change", function () { opts.onRename(row.club, nameInput.value); });
    nameInput.addEventListener("keydown", function (event) { if (event.key === "Enter") nameInput.blur(); });
    nameField.appendChild(nameInput);
    wrap.appendChild(nameField);

    var step = elem("div", "gdBagRowStep");
    var less = elem("button", null, "−");
    less.type = "button";
    less.setAttribute("aria-label", "Less carry");
    less.addEventListener("click", function () { opts.onCarry(row.club, row.baseCarry - 1); });
    var carryField = elem("label");
    carryField.appendChild(elem("span", null, "Carry"));
    var carryInput = document.createElement("input");
    carryInput.inputMode = "numeric";
    carryInput.value = String(row.baseCarry);
    carryInput.setAttribute("aria-label", "Carry metres");
    carryInput.addEventListener("change", function () { opts.onCarry(row.club, carryInput.value); });
    carryField.appendChild(carryInput);
    var more = elem("button", null, "+");
    more.type = "button";
    more.setAttribute("aria-label", "More carry");
    more.addEventListener("click", function () { opts.onCarry(row.club, row.baseCarry + 1); });
    step.appendChild(less);
    step.appendChild(carryField);
    step.appendChild(more);
    wrap.appendChild(step);

    var foot = elem("div", "gdBagRowFoot");
    foot.appendChild(elem("span", "gdBagRowNote", "Runs on to " + row.totalM + " m"));
    var actions = elem("div", "gdBagRowActions");
    var remove = elem("button", "gdBagRowRemove", "Remove");
    remove.type = "button";
    remove.addEventListener("click", function () { opts.onRemove(row.club); });
    var done = elem("button", "gdBagRowDone", "Done");
    done.type = "button";
    done.addEventListener("click", function () { opts.onEdit(null); });
    actions.appendChild(remove);
    actions.appendChild(done);
    foot.appendChild(actions);
    wrap.appendChild(foot);
    return wrap;
  }

  /* renderList(container, opts)
   *   rows      - club rows in any order; sorted and laid out here
   *   editing   - club name of the open row, or null
   *   editable  - false renders the same list with no editors (the ghost bag)
   *   artBase   - path prefix for assets/clubs/ (the play surface is a level down)
   *   onEdit(clubOrNull) / onRename(club, label) / onCarry(club, metres) / onRemove(club)
   * Returns the sorted rows so a caller can keep its own copy in step. */
  function renderList(container, opts) {
    opts = opts || {};
    var rows = sortRows(opts.rows);
    if (!container) return rows;
    var editable = opts.editable !== false;
    var noop = function () {};
    var handlers = {
      onEdit: opts.onEdit || noop,
      onRename: opts.onRename || noop,
      onCarry: opts.onCarry || noop,
      onRemove: opts.onRemove || noop
    };
    var base = opts.artBase == null ? "" : String(opts.artBase);

    /* A carry step persists immediately so every other surface sees the new
       value, but its editor must not move under the player's finger.  Keep the
       open club at the slot it occupied when editing began; the next render
       after Done uses the normal sorted order again. */
    var displayRows = rows;
    if (opts.anchorEditing && opts.editing && Array.isArray(opts.anchorRows)) {
      var anchor = sortRows(opts.anchorRows);
      var oldIndex = anchor.findIndex(function (row) { return sameLabel(row.club, opts.editing); });
      var currentIndex = rows.findIndex(function (row) { return sameLabel(row.club, opts.editing); });
      if (oldIndex >= 0 && currentIndex >= 0) {
        displayRows = rows.slice();
        var moving = displayRows.splice(currentIndex, 1)[0];
        displayRows.splice(Math.min(oldIndex, displayRows.length), 0, moving);
      }
    }
    container.textContent = "";
    container.classList.add("gdBagEditor");
    columnOrder(displayRows, opts.columns).forEach(function (cell) {
      var row = cell.row;
      var editing = editable && opts.editing && sameLabel(opts.editing, row.club);
      var node = elem("div", "gdBagRow" + (editing ? " editing" : ""));
      node.id = "gdBagRow_" + cell.index;
      node.dataset.club = row.club;
      node.dataset.carry = String(row.baseCarry);
      node.dataset.total = String(row.totalM);
      node.dataset.bagColumn = String(cell.column);

      var artWrap = elem("div", "gdBagRowArt");
      artWrap.setAttribute("aria-hidden", "true");
      var kind = art(row.club);
      var glyph = elem("i");
      glyph.style.aspectRatio = ART_ASPECT[kind];
      glyph.style.backgroundImage = "url(" + base + "assets/clubs/" + kind + "-h.png)";
      artWrap.appendChild(glyph);
      node.appendChild(artWrap);

      var main = elem("div", "gdBagRowMain");
      main.appendChild(elem("span", "gdBagRowClub", row.club === "Driver" ? "DR" : row.club));
      main.appendChild(elem("span", "gdBagRowTotal", row.totalM));
      main.appendChild(elem("span", "gdBagRowCarry", row.baseCarry));
      if (editable) {
        main.setAttribute("role", "button");
        main.tabIndex = 0;
        main.setAttribute("aria-expanded", editing ? "true" : "false");
        main.addEventListener("click", function () { handlers.onEdit(editing ? null : row.club); });
        main.addEventListener("keydown", function (event) {
          if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
          event.preventDefault();
          handlers.onEdit(editing ? null : row.club);
        });
      }
      node.appendChild(main);

      if (editing) node.appendChild(editorFor(row, handlers));
      container.appendChild(node);
    });
    return rows;
  }

  /* The rendered list is a readable source of truth - the legacy shell reads it
     back in several places rather than holding its own copy. */
  function readList(container) {
    var rows = [];
    if (!container) return rows;
    container.querySelectorAll(".gdBagRow[data-club]").forEach(function (node) {
      var row = normalise({ club: node.dataset.club, baseCarry: node.dataset.carry, totalM: node.dataset.total });
      if (row) rows.push(row);
    });
    return rows;
  }

  win.GDBagCore = {
    __owner: "GDBagCore",
    version: "bag-core-20260829",
    COLUMNS: COLUMNS,
    /* Which silhouette a club gets, and its aspect ratio. Exported because the
       GPS shot card draws the same artwork in its club band and must classify
       a club the same way the bag sheet does — one rule, not two copies. */
    clubArt: art,
    ART_ASPECT: ART_ASPECT,
    FIRMNESS: FIRMNESS,
    FIRMNESS_KEY: FIRMNESS_KEY,
    normalise: normalise,
    sortRows: sortRows,
    columnOrder: columnOrder,
    totalForCarry: totalForCarry,
    firmness: firmness,
    firmnessLabel: firmnessLabel,
    addRow: addRow,
    renameRow: renameRow,
    setCarry: setCarry,
    removeRow: removeRow,
    renderList: renderList,
    readList: readList
  };
})();
