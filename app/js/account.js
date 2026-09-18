/* Session presentation for the shell. Auth itself lives in the reused
   scripts/clarity-supabase-auth.js — this file only reads its session, renders
   the signed-in/out state, and clears the session keys on sign out. It never
   touches passwords; those go straight from the form to ClaritySupabaseAuth. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});
  var SESSION_KEY = "clarity:supabase-auth-session:v1";
  var ACCOUNT_KEY = "gd_accounts_v1";
  /* Mirrors PUBLISHED_ADMIN_EMAILS in scripts/gd-course-library-pin-lock.js. The two
     shells share the account store but no code, so this is the one fact repeated;
     dev/course-version-stamp.test.js asserts the lists still agree. */
  var ADMIN_EMAILS = ["samhalegolf@gmail.com", "admin@clarity.local"];

  function auth() { return window.ClaritySupabaseAuth || null; }

  function activeAccount() {
    try {
      var state = JSON.parse(localStorage.getItem(ACCOUNT_KEY) || "null") || {};
      var accounts = Array.isArray(state.accounts) ? state.accounts : [];
      return accounts.find(function (a) { return a && a.accountId === state.activeId; }) || null;
    } catch (e) { return null; }
  }

  app.account = {
    signedIn: function () {
      var a = auth();
      return !!(a && typeof a.session === "function" && a.session());
    },
    label: function () {
      var account = activeAccount();
      return account ? (account.name || account.email || "Signed in") : "Signed in";
    },
    email: function () {
      var account = activeAccount();
      return String((account && account.email) || "").trim().toLowerCase();
    },
    /* Whether this device is signed in as the operator, for build-diagnostic overlays
       that must not appear for a player - today, the baked-asset version stamp in play.
       Deliberately a display gate and nothing more: it reveals a version number that is
       already in the package every device downloads, so it guards clutter, not secrets,
       and must never be used to decide what a round may DO. Anything that grants
       capability belongs behind the server's own admin check
       (functions/permission-resolver.js), which this cannot stand in for. */
    isAdmin: function () {
      var account = activeAccount();
      if (!account) return false;
      var role = String(account.role || "").trim().toLowerCase();
      return role === "admin" && ADMIN_EMAILS.indexOf(app.account.email()) !== -1;
    },
    login: async function (email, password) {
      var a = auth();
      if (!a) throw new Error("Auth is not available");
      return a.login(email, password, { keepLoggedIn: true });
    },
    signOut: function () {
      try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
      try { localStorage.setItem("gd_account_signed_out_v1", "1"); } catch (e) {}
      try {
        var state = JSON.parse(localStorage.getItem(ACCOUNT_KEY) || "null") || {};
        delete state.activeId;
        localStorage.setItem(ACCOUNT_KEY, JSON.stringify(state));
      } catch (e) {}
    }
  };
})();
