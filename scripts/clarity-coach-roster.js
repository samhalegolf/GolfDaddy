/* Pull a coach's players down from the server.
 *
 * The coach/player relationship was device-local. linked_player_ids arrived on
 * the coach's account at login, but nothing ever fetched the players' account
 * rows or their profiles - so the Players list only ever showed players created
 * on that same device, and tapping one whose profile row was missing landed on
 * the coach's own profile instead. clarity-profile-hydrate.js is the same
 * missing-downward-half fix for your own profiles; this is the coach's roster.
 *
 * WHAT IT WRITES, AND WHAT IT REFUSES TO WRITE
 *
 * Identity and links are the server's to state, so account rows are created and
 * refreshed from the response: name, email, linked_coach_ids, and the coach's
 * own linkedPlayerIds.
 *
 * Profiles are only ever ADDED, never overwritten. Same reasoning as
 * clarity-profile-hydrate: there is no server-side delete for profiles, and a
 * coach may have edited a player's bag offline. Overwriting would resurrect
 * removed players and lose local edits; filling gaps cannot do either.
 *
 * It never touches activeId or viewingProfileId. Deciding who you are looking
 * at is the profile shell's job, not a background fetch's.
 */
(function () {
  "use strict";

  var ENDPOINT = "/api/coach-roster";
  var ACCOUNT_KEY = "gd_accounts_v1";
  var PROFILE_KEY = "gd_player_profiles_v27";
  var MIN_INTERVAL_MS = 30000;
  var lastRunAt = 0;
  var inFlight = null;

  function safe(fn) { try { return fn(); } catch (_e) { return undefined; } }
  function readJson(key) { return safe(function () { return JSON.parse(localStorage.getItem(key) || "{}"); }) || {}; }
  function writeJson(key, value) {
    return safe(function () {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    }) || false;
  }
  function unique(list) {
    var seen = Object.create(null);
    return (list || []).filter(function (id) {
      if (!id || seen[id]) return false;
      seen[id] = true;
      return true;
    });
  }

  function currentAccount() {
    return safe(function () {
      var api = window.GolfDaddyAccounts;
      return api && typeof api.current === "function" ? api.current() : null;
    }) || null;
  }

  function isCoach(account) {
    var role = String(account && account.role || "player").toLowerCase();
    return role === "coach" || role === "admin";
  }

  async function accessToken() {
    var auth = window.ClaritySupabaseAuth;
    if (!auth || typeof auth.freshAccessToken !== "function") return "";
    try { return (await auth.freshAccessToken()) || ""; } catch (_e) { return ""; }
  }

  /* Server row -> the shape gd-app-core stores. Shared contract with
     clarity-profile-hydrate, so reuse its converter when it is loaded. */
  function toLocalProfile(row, accountId) {
    if (window.ClarityProfileHydrate && typeof window.ClarityProfileHydrate.toLocalProfile === "function") {
      return window.ClarityProfileHydrate.toLocalProfile(row, accountId);
    }
    if (!row) return null;
    var base = {};
    if (row.profile_json && typeof row.profile_json === "object" && !Array.isArray(row.profile_json)) {
      base = JSON.parse(JSON.stringify(row.profile_json));
    }
    base.id = row.profile_id || base.id;
    if (!base.id) return null;
    base.accountId = base.accountId || accountId || "";
    base.name = base.name || row.name || "Player";
    base.handedness = base.handedness || row.handedness || "right";
    if (base.handicap == null || base.handicap === "") base.handicap = row.handicap || "";
    base.permission = base.permission || row.permission || "player";
    if (!Array.isArray(base.bag) && Array.isArray(row.bag_json)) base.bag = row.bag_json;
    return base;
  }

  function merge(coachAccountId, players) {
    var accountStore = readJson(ACCOUNT_KEY);
    var profileStore = readJson(PROFILE_KEY);
    accountStore.accounts = Array.isArray(accountStore.accounts) ? accountStore.accounts : [];
    profileStore.profiles = Array.isArray(profileStore.profiles) ? profileStore.profiles : [];

    var addedAccounts = 0;
    var addedProfiles = 0;
    var playerIds = [];

    players.forEach(function (entry) {
      var incoming = entry && entry.account;
      var accountId = incoming && incoming.accountId;
      if (!accountId || accountId === coachAccountId) return;
      playerIds.push(accountId);

      var existing = accountStore.accounts.find(function (row) { return row && row.accountId === accountId; });
      if (existing) {
        existing.name = incoming.name || existing.name;
        existing.email = incoming.email || existing.email;
        existing.profileId = incoming.profileId || existing.profileId;
        existing.linkedCoachIds = unique([].concat(existing.linkedCoachIds || [], incoming.linkedCoachIds || [], [coachAccountId]));
        existing.requiresPasswordSetup = !!incoming.requiresPasswordSetup;
      } else {
        accountStore.accounts.push({
          accountId: accountId,
          profileId: incoming.profileId || "",
          name: incoming.name || "Player",
          email: incoming.email || "",
          role: "player",
          authProvider: "supabase",
          passwordSalt: "",
          passwordHash: "",
          linkedCoachIds: unique([].concat(incoming.linkedCoachIds || [], [coachAccountId])),
          linkedPlayerIds: [],
          createdByCoachId: incoming.createdByCoachId || null,
          requiresPasswordSetup: !!incoming.requiresPasswordSetup,
          createdAt: incoming.createdAt || new Date().toISOString(),
          updatedAt: incoming.updatedAt || new Date().toISOString()
        });
        addedAccounts += 1;
      }

      var profile = toLocalProfile(entry.profile, accountId);
      if (!profile || !profile.id) return;
      var held = profileStore.profiles.some(function (row) { return row && row.id === profile.id; });
      if (held) return;
      profileStore.profiles.push(profile);
      addedProfiles += 1;
    });

    var coach = accountStore.accounts.find(function (row) { return row && row.accountId === coachAccountId; });
    if (coach) {
      /* The coach's own id used to sit in this list, which is what put the coach
         in their own player roster. The server drops it; keep it dropped. */
      coach.linkedPlayerIds = unique([].concat(coach.linkedPlayerIds || [], playerIds))
        .filter(function (id) { return id !== coachAccountId; });
    }

    if (!addedAccounts && !addedProfiles && !coach) return { addedAccounts: 0, addedProfiles: 0 };

    writeJson(ACCOUNT_KEY, accountStore);
    if (addedProfiles) writeJson(PROFILE_KEY, profileStore);
    return { addedAccounts: addedAccounts, addedProfiles: addedProfiles, playerCount: playerIds.length };
  }

  async function refresh(reason, opts) {
    opts = opts || {};
    if (inFlight) return inFlight;
    if (!opts.force && Date.now() - lastRunAt < MIN_INTERVAL_MS) return null;

    var account = currentAccount();
    if (!isCoach(account)) return null;

    inFlight = (async function () {
      var token = await accessToken();
      if (!token) return null;

      var body = null;
      try {
        var response = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessToken: token })
        });
        body = await response.json().catch(function () { return null; });
        if (!response.ok || !body || !body.ok) return null;
      } catch (_error) {
        return null;
      }

      lastRunAt = Date.now();
      var players = Array.isArray(body.players) ? body.players : [];
      var result = merge(body.coachAccountId || (account && account.accountId) || "", players);
      if (!result) return null;

      safe(function () { if (window.GolfDaddyAccounts && typeof window.GolfDaddyAccounts.load === "function") window.GolfDaddyAccounts.load(); });
      safe(function () { if (typeof window.loadPlayerProfiles === "function") window.loadPlayerProfiles(); });
      safe(function () {
        window.dispatchEvent(new CustomEvent("clarity:coach-roster-refreshed", {
          detail: { reason: reason || "", players: players.length, added: result.addedAccounts, profiles: result.addedProfiles }
        }));
      });
      return result;
    })().finally(function () { inFlight = null; });

    return inFlight;
  }

  function schedule(reason) {
    /* freshAccessToken is useless before the auth session has loaded. */
    setTimeout(function () { refresh(reason).catch(function () {}); }, 900);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { schedule("boot"); });
  } else {
    schedule("boot");
  }
  window.addEventListener("clarity:session-changed", function () { schedule("session-changed"); });

  window.ClarityCoachRoster = {
    refresh: refresh,
    merge: merge,
    toLocalProfile: toLocalProfile
  };
})();
