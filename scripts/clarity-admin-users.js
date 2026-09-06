(function () {
  "use strict";
  var rootId = "clarityCanonicalUsers";
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>\"']/g, function (c) { return ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[c]; }); }
  async function token() { return window.ClaritySupabaseAuth && await window.ClaritySupabaseAuth.freshAccessToken(); }
  async function api(body) {
    var t = await token(); if (!t) throw new Error("Sign in again to manage users");
    var r = await fetch("/api/caddy-admin-users", { method:"POST", headers:{"Content-Type":"application/json",Authorization:"Bearer " + t}, body:JSON.stringify(body) });
    var data = await r.json().catch(function(){ return {}; }); if (!r.ok) throw new Error(data.error || "Users request failed"); return data;
  }
  function close() { var n=document.getElementById(rootId); if(n)n.remove(); }
  function render(rows) {
    var n=document.getElementById(rootId); if(!n)return;
    n.innerHTML='<section class="accountPanel" style="position:fixed;inset:5vh 5vw;z-index:9999;overflow:auto;background:#101815;padding:20px;border:1px solid #49604d;border-radius:16px;color:white"><button class="saveBtn" style="float:right" type="button" onclick="ClarityAdminUsers.close()">Close</button><h2>Users</h2><p>Canonical Caddy players, including no-login and repair cases.</p><button class="saveBtn" type="button" onclick="ClarityAdminUsers.createPlayer()">Create no-login player</button><div style="margin-top:16px">'+rows.map(function(r){return '<article style="padding:12px 0;border-bottom:1px solid #334"><strong>'+esc(r.name)+'</strong> · '+esc(r.email||'No email')+'<br><small>Login: '+esc(r.login)+' · Player: '+esc(r.player)+' · Coach: '+esc(r.coach)+' · Access: '+esc(r.access||'None')+' · Bag: '+r.bagCount+' · Bubble: '+esc(r.bubble)+' · '+esc(r.status)+'</small><br>'+(r.playerId?'<button class="saveBtn" type="button" onclick="ClarityAdminUsers.assign(\''+esc(r.playerId)+'\')">Assign Sam Hale</button> <button class="saveBtn" type="button" onclick="ClarityAdminUsers.merge(\''+esc(r.playerId)+'\')">Merge</button>':'')+'</article>';}).join('')+'</div></section>';
  }
  async function refresh() { var d=await api({action:"list"}); render(d.users||[]); }
  window.ClarityAdminUsers={open:function(){var n=document.createElement('div');n.id=rootId;document.body.appendChild(n);refresh().catch(function(e){n.textContent=e.message;});},close:close,refresh:refresh,createPlayer:async function(){var name=prompt("Player name");if(!name)return;var email=prompt("Email (optional until claimed)")||"";await api({action:"create_player",name:name,email:email,assignSam:true});refresh();},assign:async function(id){await api({action:"assign_coach",playerId:id});refresh();},merge:async function(source){var target=prompt("Surviving canonical Player ID");if(!target)return;var preview=await api({action:"merge_preview",sourcePlayerId:source,targetPlayerId:target});if(!confirm("Review complete. Merge source into target? This keeps a redirect and audit event."))return;await api({action:"merge_execute",sourcePlayerId:source,targetPlayerId:target,decisions:{previewed:true}});refresh();}};
}());
