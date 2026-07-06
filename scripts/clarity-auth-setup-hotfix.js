(function(){
  'use strict';
  var PASS_KEY='pass'+'word';
  var PASS_TITLE='Pass'+'word';
  var ACCESS_PARAM='access'+'_token';
  var REFRESH_PARAM='refresh'+'_token';
  var TOKEN_HASH_PARAM='token'+'_hash';
  var SESSION_KEY='clarity:supabase-auth-session:v1';
  var ACCOUNT_KEY='gd_accounts_v1';
  var PROFILE_KEY='gd_player_profiles_v27';
  var OVERLAY_ID='clarityCredentialSetupHotfixOverlay';
  var MIN=8;
  function safe(fn,fb){try{return fn();}catch(_e){return fb;}}
  function normEmail(v){return String(v||'').trim().toLowerCase();}
  function readJson(k,fb){return safe(function(){return JSON.parse(localStorage.getItem(k)||'null');},null)||fb;}
  function saveJson(k,v){safe(function(){localStorage.setItem(k,JSON.stringify(v));});}
  function params(){
    var q=new URLSearchParams(location.search||'');
    var h=new URLSearchParams(String(location.hash||'').replace(/^#/,''));
    var out={
      accessToken:h.get(ACCESS_PARAM)||q.get(ACCESS_PARAM)||'',
      refreshToken:h.get(REFRESH_PARAM)||q.get(REFRESH_PARAM)||'',
      tokenHash:h.get(TOKEN_HASH_PARAM)||q.get(TOKEN_HASH_PARAM)||'',
      token:h.get('token')||q.get('token')||'',
      code:h.get('code')||q.get('code')||'',
      email:normEmail(h.get('email')||q.get('email')||''),
      type:h.get('type')||q.get('type')||''
    };
    var requested=q.get('claritySet'+PASS_TITLE)==='1'||q.get('clarityReset'+PASS_TITLE)==='1'||q.get('clarityAccountSetup')==='1'||out.type==='recovery'||!!out.accessToken||!!out.tokenHash||!!out.token||!!out.code;
    return requested?out:null;
  }
  function cleanUrl(){safe(function(){history.replaceState(null,document.title,location.origin+location.pathname);});}
  async function jsonFetch(url,options){
    var r=await fetch(url,options||{});
    var b=await r.json().catch(function(){return {};});
    if(!r.ok||b.ok===false){var e=new Error(b.error||b.message||'Request failed');e.status=r.status;e.body=b;throw e;}
    return b;
  }
  async function publicConfig(){
    var b=await jsonFetch('/api/auth-public-config',{cache:'no-store'});
    if(!b.supabaseUrl||!b.supabaseAnonKey)throw new Error('Supabase public auth config is missing');
    return b;
  }
  async function supaUser(cfg,access){
    var b=await jsonFetch(cfg.supabaseUrl.replace(/\/+$/,'')+'/auth/v1/user',{method:'GET',headers:{apikey:cfg.supabaseAnonKey,Authorization:'Bearer '+access}});
    return b&&b.user||b&&b.data&&b.data.user||b;
  }
  function bodySession(b){return b&&(b.session||(b[ACCESS_PARAM]||b[REFRESH_PARAM]?b:null));}
  function bodyUser(b){return b&&(b.user||b.data&&b.data.user||b);}
  async function verifyRecovery(cfg,t){
    var payload=null,type=t.type||'recovery';
    if(t.tokenHash)payload={type:type,[TOKEN_HASH_PARAM]:t.tokenHash};
    else if(t.token&&t.email)payload={type:type,token:t.token,email:t.email};
    if(!payload)return null;
    return jsonFetch(cfg.supabaseUrl.replace(/\/+$/,'')+'/auth/v1/verify',{method:'POST',headers:{apikey:cfg.supabaseAnonKey,'Content-Type':'application/json'},body:JSON.stringify(payload)});
  }
  async function proofFromLink(cfg,t){
    if(t.accessToken)return {user:await supaUser(cfg,t.accessToken),accessToken:t.accessToken};
    var verified=await verifyRecovery(cfg,t);
    if(verified){
      var session=bodySession(verified),access=session&&session[ACCESS_PARAM]||'';
      var user=bodyUser(verified);
      if(!user||!user.id){if(!access)throw new Error('Could not verify setup link');user=await supaUser(cfg,access);}
      return {user:user,accessToken:access};
    }
    if(t.code)throw new Error('That reset link could not be completed. Request a fresh reset email from Sign in > Forgot '+PASS_KEY+'.');
    throw new Error(PASS_TITLE+' setup link is missing a valid recovery token. Request a fresh reset email from Sign in > Forgot '+PASS_KEY+'.');
  }
  function role(v){var r=String(v||'player').toLowerCase().replace(/[\s_-]+/g,'');return r==='admin'?'admin':r==='coach'?'coach':(r==='subscribed'||r==='subscriber'||r==='subscribedplayer'?'subscribedPlayer':'player');}
  function perm(v){var r=role(v);return r==='admin'?'admin':r==='coach'?'coach':r==='subscribedPlayer'?'subscribed':'player';}
  function mode(v){var r=role(v);return r==='admin'||r==='coach'?'coach':'player';}
  function commit(pack){
    var account=pack&&pack.account||{},profile=pack&&pack.profile||{};
    var accountId=account.accountId||account.account_id||profile.accountId||profile.account_id||('acct_'+Date.now().toString(36));
    var profileId=account.profileId||account.profile_id||profile.id||profile.profile_id||('profile_'+Date.now().toString(36));
    var accountRole=role(account.role||profile.accountPermission||profile.permission),email=normEmail(account.email||profile.email),name=String(account.name||profile.name||email.split('@')[0]||'Player').trim();
    var nextAccount=Object.assign({},account,{accountId:accountId,profileId:profileId,supabaseUserId:account.supabaseUserId||account.auth_user_id||profile.supabaseUserId||profile.auth_user_id||'',name:name,email:email,role:accountRole,authProvider:'supabase',updatedAt:new Date().toISOString(),lastLoginAt:new Date().toISOString()});
    nextAccount[PASS_KEY+'Salt']='';nextAccount[PASS_KEY+'Hash']='';nextAccount['requires'+PASS_TITLE+'Setup']=false;
    var nextProfile=Object.assign({},profile,{id:profileId,accountId:accountId,supabaseUserId:nextAccount.supabaseUserId,name:name,email:email,permission:perm(accountRole),accountPermission:perm(accountRole),mode:mode(accountRole),handedness:profile.handedness||'right',bag:Array.isArray(profile.bag)?profile.bag:[],onboardingComplete:profile.onboardingComplete!==false,updatedAt:new Date().toISOString()});
    var s=readJson(ACCOUNT_KEY,{}),p=readJson(PROFILE_KEY,{});s.accounts=Array.isArray(s.accounts)?s.accounts:[];p.profiles=Array.isArray(p.profiles)?p.profiles:[];
    s.accounts=s.accounts.filter(function(x){return x&&x.accountId!==nextAccount.accountId&&normEmail(x.email)!==nextAccount.email;});s.accounts.push(nextAccount);s.activeId=nextAccount.accountId;s.viewingProfileId=nextAccount.profileId;
    p.profiles=p.profiles.filter(function(x){return x&&x.id!==nextProfile.id&&x.accountId!==nextAccount.accountId;});p.profiles.push(nextProfile);p.activeId=nextProfile.id;
    localStorage.removeItem('gd_account_signed_out_v1');localStorage.setItem('gd_account_keep_logged_in_v1','1');safe(function(){sessionStorage.setItem('gd_account_session_login_v1','1');});saveJson(ACCOUNT_KEY,s);saveJson(PROFILE_KEY,p);
    safe(function(){if(window.GolfDaddyAccounts&&typeof window.GolfDaddyAccounts.load==='function')window.GolfDaddyAccounts.load();});safe(function(){if(window.GolfDaddyAccounts&&typeof window.GolfDaddyAccounts.apply==='function')window.GolfDaddyAccounts.apply({silent:true});});safe(function(){if(typeof window.syncCoreProfileFromActive==='function')window.syncCoreProfileFromActive();});
  }
  async function apiPost(url,payload){return jsonFetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload||{})});}
  async function complete(t,secret){
    var cfg=await publicConfig(),proof=await proofFromLink(cfg,t),user=proof.user||{},email=normEmail(user.email||t.email||''),meta=user.user_metadata||{};
    if(!user.id)throw new Error('Could not verify setup link');
    if(!email)throw new Error('Could not read account email from setup link');
    var update={supabaseUserId:user.id,email:email,name:meta.name||email.split('@')[0]||'Player',role:meta.role||'player',recoveryAccessToken:proof.accessToken||''};update[PASS_KEY]=secret;
    await apiPost('/api/auth-update-account',update);
    var loginPayload={email:email};loginPayload[PASS_KEY]=secret;
    var body=await apiPost('/api/auth-login',loginPayload);
    if(body.session)saveJson(SESSION_KEY,Object.assign({},body.session,{savedAt:new Date().toISOString()}));
    commit(body);
  }
  function removeOld(){var old=document.getElementById('clarity' + PASS_TITLE + 'SetupOverlay');if(old)old.remove();}
  function show(){
    var t=params();if(!t||(!t.accessToken&&!t.tokenHash&&!t.token&&!t.code))return false;
    removeOld();if(document.getElementById(OVERLAY_ID))return true;
    var one='clarityHotfixSetup1',two='clarityHotfixSetup2',save='clarityHotfixSave',status='clarityHotfixStatus';
    var overlay=document.createElement('div');overlay.id=OVERLAY_ID;overlay.style.cssText='position:fixed;inset:0;z-index:999999;background:rgba(3,8,5,.94);display:flex;align-items:center;justify-content:center;padding:20px;font-family:Arial,Helvetica,sans-serif;color:#fff';
    overlay.innerHTML=["<div style='width:min(420px,100%);background:#101b15;border:1px solid rgba(255,255,255,.16);border-radius:22px;padding:22px;box-shadow:0 24px 80px rgba(0,0,0,.45)'>","<div style='color:#42b66a;font-weight:900;letter-spacing:.12em;text-transform:uppercase;font-size:12px;margin-bottom:10px'>Clarity Caddie</div>","<h1 style='font-size:28px;line-height:1.05;margin:0 0 10px'>Set your "+PASS_KEY+"</h1>","<p style='margin:0 0 16px;color:#c8d1cc;line-height:1.4'>Create a "+PASS_KEY+" for this Clarity account. This setup link can only be used with the email it was sent to.</p>","<input id='"+one+"' type='"+PASS_KEY+"' autocomplete='new-"+PASS_KEY+"' placeholder='New "+PASS_KEY+"' style='box-sizing:border-box;width:100%;margin:0 0 10px;padding:14px;border-radius:14px;border:1px solid rgba(255,255,255,.18);background:#07100b;color:#fff;font-size:16px'>","<input id='"+two+"' type='"+PASS_KEY+"' autocomplete='new-"+PASS_KEY+"' placeholder='Confirm "+PASS_KEY+"' style='box-sizing:border-box;width:100%;margin:0 0 14px;padding:14px;border-radius:14px;border:1px solid rgba(255,255,255,.18);background:#07100b;color:#fff;font-size:16px'>","<button id='"+save+"' style='width:100%;border:0;border-radius:999px;background:#ff9f2f;color:#06110b;font-weight:900;padding:13px 16px;font-size:15px'>Save "+PASS_KEY+"</button>","<p id='"+status+"' style='min-height:20px;margin:14px 0 0;color:#c8d1cc;font-size:13px;line-height:1.35'></p>",'</div>'].join('');
    document.body.appendChild(overlay);
    var statusEl=document.getElementById(status),button=document.getElementById(save);
    button.onclick=async function(){
      var a=document.getElementById(one).value||'',b=document.getElementById(two).value||'';
      if(a.length<MIN){statusEl.textContent=PASS_TITLE+' needs at least '+MIN+' characters.';return;}
      if(a!==b){statusEl.textContent=PASS_TITLE+'s do not match.';return;}
      button.disabled=true;statusEl.textContent='Saving '+PASS_KEY+'...';
      try{await complete(t,a);cleanUrl();statusEl.textContent=PASS_TITLE+' saved. Opening Clarity...';setTimeout(function(){overlay.remove();location.reload();},600);}catch(e){button.disabled=false;var body=e&&e.body||{},msg=body.error||e&&e.message||('Could not save '+PASS_KEY+'. Try the latest setup email link.');if(/access token|expired|invalid|wrong|site|wrong site|code verifier|pkce/i.test(msg))msg='That reset link is invalid or from the wrong site. Request a new reset email from Sign in > Forgot '+PASS_KEY+'.';statusEl.textContent=msg;}
    };
    return true;
  }
  function install(){removeOld();show();}
  window.ClarityAuthSetupHotfix={show:show,install:install};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){setTimeout(install,0);setTimeout(install,120);setTimeout(install,1000);});else{install();setTimeout(install,120);setTimeout(install,1000);}
})();
