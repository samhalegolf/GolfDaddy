/* Has this player actually set their bag? Read from the clubs themselves, never from flags.
 *
 * The profile flags (bagSeededDefault, ghostBagOnly, bagSlotsTouched) were the old answer and
 * could not be trusted: ghostBagOnly is set when the bag sheet clears an untouched stock set
 * and nothing ever clears it again, so a player who then typed in their own clubs still read
 * as "generated"; and profiles synced without their flags read the stock set as the player's
 * own. The numbers do not lie. A bag is one of:
 *
 *   none           no clubs
 *   stock          exactly the shipped stand-in distances (the ghost bag) - not set
 *   quick-default  the 7-iron quick set with the 7-iron left at its default 155 m - not set
 *   quick          the 7-iron quick set from the player's own 7-iron carry - set
 *   custom         anything else: distances the player typed or edited - set
 *
 * "Quick" is recognised from both the current generator (gd-bag-generator-core.js) and the
 * flat-offset formula it replaced (gd-app-core.js's gdGenerateQuickBag fallback), because
 * bags made with either are still stored. A quick set with one club edited is custom.
 *
 * Pure. Node-requirable for functions/caddy-admin-users.js and dev/bag-status.test.js. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    require("./gd-bag-generator-core.js");
    module.exports = factory(globalThis.GDBagGenerator);
  } else {
    root.GDBagStatus = factory(root.GDBagGenerator);
  }
})(typeof window !== "undefined" ? window : globalThis, function (generator) {
  "use strict";

  /* The 7-iron the quick set starts from until the player changes it (clarity-support.js). */
  var DEFAULT_SEVEN_IRON = 155;
  /* The flat offsets from the 7-iron that the quick set used before the speed/loft ladder. */
  var LEGACY_OFFSETS = { driver: 90, "3w": 55, "4h": 35, "5i": 20, "6i": 10, "7i": 0, "8i": -10, "9i": -22, pw: -40, gw: -55, sw: -72, lw: -88 };

  function key(label) { return String(label || "").toLowerCase().replace(/\s+/g, ""); }

  function rowsOf(bag) {
    return (Array.isArray(bag) ? bag : []).map(function (c) {
      var club = String(c && (c.club || c.name) || "").trim();
      var carry = Math.round(Number(c && (c.baseCarry != null ? c.baseCarry : c.carry)) || 0);
      return club && carry > 0 ? { key: key(club), carry: carry } : null;
    }).filter(Boolean);
  }

  /* Every club in the bag has exactly the carry this set gives it. */
  function matches(rows, carryFor) {
    return rows.every(function (row) { return carryFor(row.key) === row.carry; });
  }

  function stockCarry(k) {
    var d = generator && generator.descriptor ? generator.descriptor(k) : null;
    return d && d.reference ? d.reference : null;
  }

  function generatedCarry(seven) {
    var table = Object.create(null);
    (generator && generator.generate ? generator.generate(seven) : []).forEach(function (r) { table[key(r.club)] = Math.round(r.baseCarry); });
    return function (k) { return k in table ? table[k] : null; };
  }

  function legacyCarry(seven) {
    return function (k) { return k in LEGACY_OFFSETS ? seven + LEGACY_OFFSETS[k] : null; };
  }

  function bagStatus(bag) {
    var rows = rowsOf(bag);
    if (!rows.length) return { status: "none", set: false, clubs: 0, sevenIron: null };
    var sevenRow = rows.filter(function (r) { return r.key === "7i"; })[0];
    var seven = sevenRow ? sevenRow.carry : null;
    var out = function (status) {
      return { status: status, set: status === "quick" || status === "custom", clubs: rows.length, sevenIron: seven };
    };
    if (matches(rows, stockCarry)) return out("stock");
    if (seven && (matches(rows, generatedCarry(seven)) || matches(rows, legacyCarry(seven)))) {
      return out(seven === DEFAULT_SEVEN_IRON ? "quick-default" : "quick");
    }
    return out("custom");
  }

  bagStatus.DEFAULT_SEVEN_IRON = DEFAULT_SEVEN_IRON;
  return { bagStatus: bagStatus };
});
