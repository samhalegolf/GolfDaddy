/* Admin → canonical Users.
 *
 * Every row carries its canonical Player ID, because that id is what a merge
 * asks for and there was nowhere else to read it from. The same list also backs
 * the roster rows in the profile shell: those rows only know a local profile /
 * account id, so canonicalIdFor() maps one to the other from this response. */
(function () {
  "use strict";
  var rootId = "clarityCanonicalUsers";
  var indexPromise = null;

  function esc(v) { return String(v == null ? "" : v).replace(/[&<>\"']/g, function (c) { return ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[c]; }); }
  async function token() { return window.ClaritySupabaseAuth && await window.ClaritySupabaseAuth.freshAccessToken(); }
  async function api(body) {
    var t = await token(); if (!t) throw new Error("Sign in again to manage users");
    var r = await fetch("/api/caddy-admin-users", { method:"POST", headers:{"Content-Type":"application/json",Authorization:"Bearer " + t}, body:JSON.stringify(body) });
    var data = await r.json().catch(function(){ return {}; }); if (!r.ok) throw new Error(data.error || "Users request failed"); return data;
  }
  function close() { var n=document.getElementById(rootId); if(n)n.remove(); }

  function idLine(label, value) {
    if (!value) return "";
    return '<br><small style="opacity:.75">' + esc(label) + ': <code style="font-family:ui-monospace,monospace;user-select:all">' + esc(value) + '</code> <button class="saveBtn" type="button" onclick="ClarityAdminUsers.copyId(\'' + esc(value) + '\')">Copy</button></small>';
  }

  function row(r) {
    return '<article style="padding:12px 0;border-bottom:1px solid #334"><strong>' + esc(r.name) + '</strong> · ' + esc(r.email || 'No email') +
      '<br><small>Login: ' + esc(r.login) + ' · Player: ' + esc(r.player) + ' · Coach: ' + esc(r.coach) + ' · Access: ' + esc(r.access || 'None') + ' · Bag: ' + r.bagCount + ' · Bubble: ' + esc(r.bubble) + ' · ' + esc(r.status) + '</small>' +
      idLine('Player ID', r.playerId) +
      idLine('Merged into', r.mergedIntoPlayerId) +
      '<br>' + (r.playerId
        ? '<button class="saveBtn" type="button" onclick="ClarityAdminUsers.assign(\'' + esc(r.playerId) + '\')">Assign Sam Hale</button> <button class="saveBtn" type="button" onclick="ClarityAdminUsers.merge(\'' + esc(r.playerId) + '\')">Merge this into another</button>'
        : '') + '</article>';
  }

  function render(rows) {
    var n = document.getElementById(rootId); if (!n) return;
    n.innerHTML = '<section class="accountPanel" style="position:fixed;inset:5vh 5vw;z-index:9999;overflow:auto;background:#101815;padding:20px;border:1px solid #49604d;border-radius:16px;color:white">' +
      '<button class="saveBtn" style="float:right" type="button" onclick="ClarityAdminUsers.close()">Close</button>' +
      '<h2>Users</h2><p>Canonical Caddy players, including no-login and repair cases.</p>' +
      '<button class="saveBtn" type="button" onclick="ClarityAdminUsers.createPlayer()">Create no-login player</button>' +
      '<div style="margin-top:16px">' + rows.map(row).join('') + '</div></section>';
  }

  async function list() {
    var d = await api({ action:"list" });
    return d.users || [];
  }

  async function refresh() { indexPromise = null; render(await list()); }

  /* Cached profile/account → canonical Player ID map. One admin list call
     serves every roster row that gets expanded. */
  function canonicalIndex() {
    if (!indexPromise) {
      indexPromise = list().then(function (users) {
        var map = Object.create(null);
        users.forEach(function (u) {
          if (!u.playerId) return;
          if (u.profileId) map['profile:' + u.profileId] = u.playerId;
          if (u.accountId) map['account:' + u.accountId] = u.playerId;
        });
        return map;
      }).catch(function (e) { indexPromise = null; throw e; });
    }
    return indexPromise;
  }

  async function canonicalIdFor(profileId, accountId) {
    var map = await canonicalIndex();
    return (profileId && map['profile:' + profileId]) || (accountId && map['account:' + accountId]) || "";
  }

  /* One merge, described from whichever end the caller started at. The server
     always takes source (retired) and target (survives). */
  async function runMerge(source, target) {
    if (!source || !target) return false;
    if (source === target) { alert("Source and surviving player are the same."); return false; }
    await api({ action:"merge_preview", sourcePlayerId:source, targetPlayerId:target });
    if (!confirm("Merge\n" + source + "\ninto\n" + target + "\n\nThe first player is retired and redirected to the second. Kept as an audit event.")) return false;
    await api({ action:"merge_execute", sourcePlayerId:source, targetPlayerId:target, decisions:{ previewed:true } });
    indexPromise = null;
    return true;
  }

  window.ClarityAdminUsers = {
    open: function () { var n=document.createElement('div'); n.id=rootId; document.body.appendChild(n); refresh().catch(function(e){ n.textContent=e.message; }); },
    close: close,
    refresh: refresh,
    list: list,
    canonicalIdFor: canonicalIdFor,
    copyId: function (id) { try { navigator.clipboard.writeText(id); } catch(e) {} },
    createPlayer: async function () {
      var name = prompt("Player name"); if (!name) return;
      var email = prompt("Email (optional until claimed)") || "";
      await api({ action:"create_player", name:name, email:email, assignSam:true });
      refresh();
    },
    assign: async function (id) { await api({ action:"assign_coach", playerId:id }); refresh(); },
    /* This row is the duplicate. Paste the id of the one that survives. */
    merge: async function (source) {
      var target = prompt("Retiring this player:\n" + source + "\n\nPaste the Player ID of the player that SURVIVES:");
      if (await runMerge(source, String(target || "").trim())) refresh();
    },
    /* This row is the keeper. Paste the id of the duplicate to retire. */
    mergeInto: async function (target) {
      var source = prompt("Keeping this player:\n" + target + "\n\nPaste the Player ID of the DUPLICATE to retire into it:");
      return runMerge(String(source || "").trim(), target);
    }
  };
}());
