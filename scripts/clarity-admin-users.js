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
  async function welcomeApi(body) {
    var t = await token(); if (!t) throw new Error("Sign in again to manage welcome email");
    var r = await fetch("/api/caddy-admin-welcome-email", { method:"POST", headers:{"Content-Type":"application/json",Authorization:"Bearer " + t}, body:JSON.stringify(body) });
    var data = await r.json().catch(function(){ return {}; }); if (!r.ok) throw new Error(data.error || "Welcome Email request failed"); return data;
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
      (r.welcomeEmail ? '<br><small>Welcome Email: ' + esc(r.welcomeEmail.status === "sent" ? "Sent " + new Date(r.welcomeEmail.sentAt).toLocaleString() + " to " + r.welcomeEmail.recipientEmail : "Last attempt failed") + '</small>' : '') +
      '<br>' + (r.playerId
        ? (r.email ? '<button class="saveBtn" type="button" onclick="ClarityAdminUsers.welcome(\'' + esc(r.playerId) + '\')">' + (r.welcomeEmail && r.welcomeEmail.status === "sent" ? "Resend Welcome" : "Send Welcome") + '</button> ' : '<small>Welcome email — no email address</small> ') + '<button class="saveBtn" type="button" onclick="ClarityAdminUsers.assign(\'' + esc(r.playerId) + '\')">Assign Sam Hale</button> <button class="saveBtn" type="button" onclick="ClarityAdminUsers.merge(\'' + esc(r.playerId) + '\')">Merge this into another</button>'
        : '') + '</article>';
  }

  function render(rows) {
    var n = document.getElementById(rootId); if (!n) return;
    n.innerHTML = '<section class="accountPanel" style="position:fixed;inset:5vh 5vw;z-index:9999;overflow:auto;background:#101815;padding:20px;border:1px solid #49604d;border-radius:16px;color:white">' +
      '<button class="saveBtn" style="float:right" type="button" onclick="ClarityAdminUsers.close()">Close</button>' +
      '<h2>Users</h2><p>Canonical Caddy players, including no-login and repair cases.</p>' +
      '<button class="saveBtn" type="button" onclick="ClarityAdminUsers.createPlayer()">Create no-login player</button> <button class="saveBtn" type="button" onclick="ClarityAdminUsers.editWelcomeTemplate()">Welcome Email Template</button>' +
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
    },
    welcome: async function (playerId) {
      var d = await welcomeApi({ action:"player_preview", playerId:playerId });
      var p = d.player || {}, preview = d.preview || {};
      var overlay = document.createElement("div"); overlay.id = "clarityWelcomeConfirm";
      overlay.innerHTML = '<section class="accountPanel" style="position:fixed;inset:5vh 5vw;z-index:10000;overflow:auto;background:#101815;padding:20px;border:1px solid #49604d;border-radius:16px;color:white"><button class="saveBtn" style="float:right" type="button">Cancel</button><h2>Send Welcome Email</h2><p>To: <strong>' + esc(p.name) + '</strong><br>' + esc(p.email) + '</p><p>Subject: <strong>' + esc(preview.subject) + '</strong></p><p><small>' + (p.accountState === "needs_setup" ? "A secure set-password link is created only after you send." : "This player has an account, so the button opens Clarity.") + '</small></p><iframe sandbox="" style="width:100%;height:420px;border:1px solid #49604d;background:#07100b" srcdoc="' + esc(preview.html) + '"></iframe><p><button class="saveBtn" type="button" data-send="1">Send Welcome</button></p></section>';
      document.body.appendChild(overlay); overlay.querySelector("button:not([data-send])").onclick=function(){ overlay.remove(); };
      overlay.querySelector("[data-send]").onclick=async function(){ var btn=this; btn.disabled=true; btn.textContent="Sending…"; try { await welcomeApi({ action:"send_player", playerId:playerId }); overlay.remove(); await refresh(); alert("Welcome Email sent."); } catch(e) { btn.disabled=false; btn.textContent="Send Welcome"; alert(e.message); } };
    },
    editWelcomeTemplate: async function () {
      var d = await welcomeApi({ action:"get_template" }), t = d.template || {};
      var overlay = document.createElement("div"); overlay.id = "clarityWelcomeTemplate";
      overlay.innerHTML = '<section class="accountPanel" style="position:fixed;inset:4vh 5vw;z-index:10000;overflow:auto;background:#101815;padding:20px;border:1px solid #49604d;border-radius:16px;color:white"><button class="saveBtn" style="float:right" type="button" data-close="1">Close</button><h2>Welcome Email Template</h2><p><small>Content only — Clarity owns the email layout. Variables: {{firstName}}, {{fullName}}, {{email}}, {{coachName}}, {{appUrl}}, {{appStoreUrl}}</small></p><label>Subject<br><input data-field="subject" maxlength="140" style="width:100%"></label><br><label>Headline<br><input data-field="headline" maxlength="180" style="width:100%"></label><br><label>Message<br><textarea data-field="body" maxlength="4000" rows="10" style="width:100%"></textarea></label><br><label>Button text<br><input data-field="ctaLabel" maxlength="80" style="width:100%"></label><br><label>Button destination<br><input value="Determined automatically from the player&rsquo;s account state" readonly style="width:100%"></label><p><button class="saveBtn" type="button" data-preview="1">Preview Email</button> <button class="saveBtn" type="button" data-test="1">Send Test to Me</button> <button class="saveBtn" type="button" data-save="1">Save Template</button></p><p data-status="1"></p><iframe sandbox="" style="display:none;width:100%;height:420px;border:1px solid #49604d;background:#07100b" data-frame="1"></iframe></section>';
      document.body.appendChild(overlay); ["subject","headline","body","ctaLabel"].forEach(function(k){ overlay.querySelector('[data-field="'+k+'"]').value=t[k] || ""; });
      function draft(){ var out={}; ["subject","headline","body","ctaLabel"].forEach(function(k){ out[k]=overlay.querySelector('[data-field="'+k+'"]').value; }); return out; }
      function status(s){ overlay.querySelector("[data-status]").textContent=s; }
      overlay.querySelector("[data-close]").onclick=function(){overlay.remove();};
      overlay.querySelector("[data-preview]").onclick=async function(){ try { var r=await welcomeApi({action:"preview",template:draft()}), f=overlay.querySelector("[data-frame]"); f.srcdoc=r.preview.html; f.style.display="block"; status("Preview uses the production renderer."); } catch(e){status(e.message);} };
      overlay.querySelector("[data-test]").onclick=async function(){ try { status("Sending test…"); await welcomeApi({action:"send_test",template:draft()}); status("Test sent to your admin email."); } catch(e){status(e.message);} };
      overlay.querySelector("[data-save]").onclick=async function(){ try { await welcomeApi({action:"save_template",template:draft()}); status("Template saved."); } catch(e){status(e.message);} };
    }
  };
}());
