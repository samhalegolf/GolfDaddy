/* Session presentation for the shell. Auth itself lives in the reused
   scripts/clarity-supabase-auth.js — this file only reads its session, renders
   the signed-in/out state, and clears the session keys on sign out. It never
   touches passwords; those go straight from the form to ClaritySupabaseAuth. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});
  var SESSION_KEY = "clarity:supabase-auth-session:v1";
  var ACCOUNT_KEY = "gd_accounts_v1";

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
