/* --- Local app permissions owner --- */
const GD_PERMISSION_STORE_KEY='gd_account_permission_v1';
const GD_COACH_PROFILE_VISIBILITY_KEY='gd_coach_profile_visibility_v1';
const GD_PERMISSIONS={
  admin:{label:'Admin',publicLabel:'Coach',desc:'Coach-facing app plus Admin Settings and Developer Settings.'},
  coach:{label:'Coach',publicLabel:'Coach',desc:'Coach tools without developer tuning.'},
  player:{label:'Player',publicLabel:'Player',desc:'Core GPS, bag, profile and Shot Data.'},
  subscribedPlayer:{label:'Subscribed Player',publicLabel:'Subscribed Player',desc:'Player flow plus subscribed features and saved data.'}
};
const GD_COACH_PROFILE_VISIBILITY_FIELDS=[
  {key:'bag',label:'Bag',desc:'Club list and carry distances.'},
  {key:'shot',label:'Shot Data',desc:'Course and shot pattern data.'},
  {key:'courses',label:'Course Mapping',desc:'Saved mapped courses, greens, tees, bunkers and fairways.'},
  {key:'play',label:'Play / GPS',desc:'Open GPS as that player.'}
];
const GD_COACH_PROFILE_VISIBILITY_DEFAULTS={bag:true,shot:true,courses:false,play:false};
function gdNormalizePermission(v){
  const raw=String(v||'player').trim();
  const key=raw.toLowerCase().replace(/[\s_-]+/g,'');
  if(key==='subscribed'||key==='subscriber'||key==='subscribedplayer'||key==='advanced')return 'subscribedPlayer';
  if(key==='admin')return 'admin';
  if(key==='coach')return 'coach';
  if(key==='player')return 'player';
  return 'player';
}
function gdPermissionLabel(v){return GD_PERMISSIONS[gdNormalizePermission(v)].label}
function gdPermissionPublicLabel(v){return GD_PERMISSIONS[gdNormalizePermission(v)].publicLabel}
function gdPermissionToMode(v){const p=gdNormalizePermission(v);return p==='admin'||p==='coach'?'coach':'player'}
function gdModeLabel(v){return gdPermissionPublicLabel(gdNormalizePermission(v))}
function gdGetCoachProfileVisibility(){
  let saved={};
  try{saved=JSON.parse(localStorage.getItem(GD_COACH_PROFILE_VISIBILITY_KEY)||'{}')||{};}catch(e){saved={};}
  return {...GD_COACH_PROFILE_VISIBILITY_DEFAULTS,...saved};
}
function gdCoachCanSeeProfileFeature(key){
  return !!gdGetCoachProfileVisibility()[key];
}
function gdSetCoachProfileVisibility(key,value){
  const next=gdGetCoachProfileVisibility();
  next[key]=!!value;
  localStorage.setItem(GD_COACH_PROFILE_VISIBILITY_KEY,JSON.stringify(next));
  gdRenderPermissionsAdmin();
  try{if(typeof renderProfilePanel==="function")renderProfilePanel();}catch(e){}
  try{if(typeof toast==="function")toast("Coach profile visibility updated");}catch(e){}
  return next;
}
window.gdGetCoachProfileVisibility=gdGetCoachProfileVisibility;
window.gdCoachCanSeeProfileFeature=gdCoachCanSeeProfileFeature;
window.gdSetCoachProfileVisibility=gdSetCoachProfileVisibility;
function gdGetAccountPermission(){
  let hasAccountApi=false;
  const paidActive=()=>{
    try{return !!(window.ClarityPayments&&typeof window.ClarityPayments.hasActiveAccess==="function"&&window.ClarityPayments.hasActiveAccess());}catch(e){return false;}
  };
  try{
    hasAccountApi=!!(window.GolfDaddyAccounts&&typeof window.GolfDaddyAccounts.current==="function");
    const account=hasAccountApi?window.GolfDaddyAccounts.current():null;
    if(account){
      const permission=gdNormalizePermission(account.role||account.permission||"player");
      return permission==="player"&&paidActive()?"subscribedPlayer":permission;
    }
  }catch(e){}
  if(hasAccountApi)return paidActive()?"subscribedPlayer":"player";
  let p=null;
  try{p=typeof activePlayerProfile==='function'?activePlayerProfile():null;}catch(e){}
  const permission=gdNormalizePermission(localStorage.getItem(GD_PERMISSION_STORE_KEY)||p?.permission||p?.accountPermission||p?.mode||'player');
  return permission==="player"&&paidActive()?"subscribedPlayer":permission;
}
function gdApplyAccountPermission(value,opts={}){
  const permission=gdNormalizePermission(value);
  localStorage.setItem(GD_PERMISSION_STORE_KEY,permission);
  let p=null;
  try{p=typeof activePlayerProfile==='function'?activePlayerProfile():null;}catch(e){}
  if(p){
    p.permission=permission;
    p.accountPermission=permission;
    p.mode=gdPermissionToMode(permission);
    p.updatedAt=new Date().toISOString();
    try{savePlayerProfiles&&savePlayerProfiles();}catch(e){}
    try{syncCoreProfileFromActive&&syncCoreProfileFromActive();}catch(e){}
  }
  gdRenderPermissionsAdmin();
  gdRefreshPermissionChrome();
  try{if(document.getElementById("practiceDataPanel")?.classList.contains("open")&&typeof renderPracticeData==="function")renderPracticeData();}catch(e){}
  try{if(document.getElementById("statsPanel")?.classList.contains("open")&&typeof renderStats==="function")renderStats();}catch(e){}
  if(!opts.silent)try{toast(`Permission set to ${gdPermissionLabel(permission)}`);}catch(e){}
  return permission;
}
function gdRefreshPermissionChrome(){
  const permission=gdGetAccountPermission();
  document.body.dataset.gdPermission=permission;
  const adminBtn=document.getElementById('dockAdmin');
  if(adminBtn)adminBtn.textContent='Admin';
  try{gdRefreshAccountQuickSignOut();}catch(e){}
}
function gdEnsureAccountQuickSignOut(){
  if(!document.body)return null;
  let btn=document.getElementById('gdQuickSignOut');
  if(btn)btn.remove();
  return null;
}
function gdRefreshAccountQuickSignOut(){
  const btn=gdEnsureAccountQuickSignOut();
  if(!btn)return;
  let account=null;
  try{account=window.GolfDaddyAccounts&&typeof window.GolfDaddyAccounts.current==="function"?window.GolfDaddyAccounts.current():gdCurrentAccount();}catch(e){account=null;}
  btn.classList.toggle('visible',!!account);
  btn.title=account?`Signed in as ${account.name||account.email||'account'}`:'';
}
function gdQuickSignOut(){
  try{
    if(window.GolfDaddyAccounts&&typeof window.GolfDaddyAccounts.logout==="function")window.GolfDaddyAccounts.logout();
    else gdAccountLogout();
  }catch(e){try{toast(e.message||'Could not sign out')}catch(_e){}}
  try{showShellHome();}catch(e){}
  try{gdRefreshAccountQuickSignOut();}catch(e){}
  setTimeout(()=>{try{if(window.gdOpenProfileV67)window.gdOpenProfileV67();else if(window.openProfilePanel)window.openProfilePanel();}catch(e){}},30);
}
function gdRenderPermissionsAdmin(){
  const root=document.getElementById('gdPermissionCard');
  if(!root)return;
  const current=gdGetAccountPermission();
  const order=['admin','coach','player','subscribedPlayer'];
  const visibility=gdGetCoachProfileVisibility();
  const visibilityRows=GD_COACH_PROFILE_VISIBILITY_FIELDS.map(item=>{
    return `<label class="gdCoachVisibilityOption"><input type="checkbox" data-gd-coach-visible="${gdEscapeHTML(item.key)}" ${visibility[item.key]?'checked':''}><div>${gdEscapeHTML(item.label)}<span>${gdEscapeHTML(item.desc)}</span></div></label>`;
  }).join('');
  root.innerHTML=`<h3>Account Permissions</h3><p>Admin and Coach share the same app feel. Admin only gets this settings surface and the tucked-away Developer Settings.</p><div class="gdPermissionGrid">${order.map(key=>{
    const item=GD_PERMISSIONS[key];
    return `<button type="button" class="gdPermissionOption ${key===current?'active':''}" data-gd-permission="${key}"><strong>${gdEscapeHTML(item.label)}</strong><span>${gdEscapeHTML(item.desc)}</span></button>`;
  }).join('')}</div><div class="gdCoachVisibility"><h4>Coach can see on another profile</h4><p>Admin controls which player-profile cards appear when a coach opens someone else.</p><div class="gdCoachVisibilityGrid">${visibilityRows}</div></div><div class="gdPermissionSummary">Current app face: ${gdEscapeHTML(gdPermissionPublicLabel(current))}. Stored permission: ${gdEscapeHTML(gdPermissionLabel(current))}.</div>`;
  root.querySelectorAll('[data-gd-permission]').forEach(btn=>{btn.onclick=()=>gdApplyAccountPermission(btn.dataset.gdPermission);});
  root.querySelectorAll('[data-gd-coach-visible]').forEach(input=>{input.onchange=()=>gdSetCoachProfileVisibility(input.dataset.gdCoachVisible,input.checked);});
}
document.addEventListener('DOMContentLoaded',()=>setTimeout(()=>{try{gdRefreshAccountQuickSignOut();}catch(e){}},80));
window.GolfDaddyPermissions={all:GD_PERMISSIONS,get:gdGetAccountPermission,set:gdApplyAccountPermission,label:gdPermissionLabel,publicLabel:gdPermissionPublicLabel,render:gdRenderPermissionsAdmin};
window.ClarityCaddiePermissions=window.GolfDaddyPermissions;
