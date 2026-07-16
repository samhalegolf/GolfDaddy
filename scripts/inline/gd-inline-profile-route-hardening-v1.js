/* Extracted verbatim from an inline <script> block in index.html (split-03). */
/* --- Profile route hardening v1 ---
   Keeps the V67 profile overlay from leaving Home/GPS live underneath it. */
	(function(){
	  'use strict';
	  function safe(fn){try{return fn()}catch(e){console.warn('[GD profile route]',e);}}
	  function authSurfaceOpen(){
	    if(document.body.classList.contains('gdAuthLocked'))return true;
	    const profile=document.getElementById('gdProfileV67');
	    const account=safe(()=>window.GolfDaddyAccounts&&window.GolfDaddyAccounts.current&&window.GolfDaddyAccounts.current(),null);
	    return !!(profile&&!profile.classList.contains('hidden')&&!account&&/Sign in|Set password|Create account/i.test(profile.textContent||''));
	  }
	  function keepHomeBehindAuth(){
	    safe(()=>document.querySelectorAll('.modulePanel.open,.panel.open').forEach(el=>el.classList.remove('open')));
	    safe(()=>{
	      const home=document.getElementById('shellHome');
	      if(home){
	        home.classList.add('hidden');
	        home.style.display='';
	        home.style.visibility='';
	        home.style.pointerEvents='';
	        home.style.opacity='';
	      }
	    });
	    safe(()=>document.getElementById('courseScreen')?.classList.add('hidden'));
	    safe(()=>document.getElementById('shellTop')?.classList.remove('visible'));
	    safe(()=>document.getElementById('shellDock')?.classList.remove('visible'));
	    safe(()=>document.body.classList.remove('gdBubbleStudioOpen','shell-home','shell-gps','gps-active','gdGpsActive','gps-open','manual-gps-active','shell-module'));
	    safe(()=>document.body.classList.add('gdAuthLocked','gdProfileOpen'));
	    const profile=document.getElementById('gdProfileV67');
	    if(profile) profile.classList.remove('hidden');
	    return false;
	  }
	  function forceProfileSurface(){
	    if(authSurfaceOpen())return keepHomeBehindAuth();
	    safe(()=>document.querySelectorAll('.modulePanel.open,.panel.open').forEach(el=>el.classList.remove('open')));
    safe(()=>document.getElementById('shellHome')?.classList.add('hidden'));
    safe(()=>document.getElementById('courseScreen')?.classList.add('hidden'));
    safe(()=>document.getElementById('shellTop')?.classList.remove('visible'));
    safe(()=>document.getElementById('shellDock')?.classList.remove('visible'));
    safe(()=>document.body.classList.remove('gdBubbleStudioOpen','shell-gps','gps-active','gdGpsActive','gps-open','manual-gps-active'));
    safe(()=>document.body.classList.add('gdProfileOpen','shell-module'));
    safe(()=>document.body.classList.remove('shell-home'));
    const profile=document.getElementById('gdProfileV67');
    if(profile) profile.classList.remove('hidden');
    safe(()=>{
      lastShellModule='profilePanel';
      if(typeof updateShellRouteLabel==='function') updateShellRouteLabel();
    });
  }
  function forceProfileHome(){
    safe(()=>document.getElementById('gdProfileV67')?.classList.add('hidden'));
    safe(()=>document.body.classList.remove('gdProfileOpen','shell-module','shell-gps','gps-active','gdGpsActive'));
    safe(()=>document.body.classList.add('shell-home'));
    const home=document.getElementById('shellHome');
    if(home){
      home.classList.remove('hidden');
      home.style.display='';
      home.style.visibility='';
      home.style.pointerEvents='';
      home.style.opacity='';
    }
    safe(()=>document.getElementById('shellTop')?.classList.remove('visible'));
    safe(()=>document.getElementById('shellDock')?.classList.remove('visible'));
    safe(()=>document.querySelectorAll('.modulePanel.open,.panel.open').forEach(el=>el.classList.remove('open')));
    safe(()=>document.getElementById('courseScreen')?.classList.add('hidden'));
    safe(()=>{if(typeof setDockActive==='function')setDockActive('')});
    safe(()=>{
      if(typeof replaceShellRoute==='function') replaceShellRoute('home');
      else {
        shellRouteStack=['home'];
        lastShellModule='home';
        if(typeof updateShellRouteLabel==='function') updateShellRouteLabel();
      }
    });
    safe(()=>{if(typeof gdV62Refresh==='function')setTimeout(gdV62Refresh,40)});
    return false;
  }
  function wrapProfileOpen(){
    const oldOpen=window.openProfilePanel;
    if(typeof oldOpen==='function'&&!oldOpen.__gdProfileRouteHardening){
      const wrapped=function(){
        const res=oldOpen.apply(this,arguments);
        forceProfileSurface();
        return res;
      };
      wrapped.__gdProfileRouteHardening=true;
      window.openProfilePanel=wrapped;
      safe(()=>{openProfilePanel=wrapped});
    }
    const oldV67Open=window.gdOpenProfileV67;
    if(typeof oldV67Open==='function'&&!oldV67Open.__gdProfileRouteHardening){
      const wrapped=function(){
        const res=oldV67Open.apply(this,arguments);
        forceProfileSurface();
        return res;
      };
      wrapped.__gdProfileRouteHardening=true;
      window.gdOpenProfileV67=wrapped;
    }
  }
  function wrapProfileClose(){
    const oldClose=window.gdCloseProfileV67;
    if(typeof oldClose==='function'&&!oldClose.__gdProfileRouteHardening){
      const wrapped=function(){
        safe(()=>oldClose.apply(this,arguments));
        return forceProfileHome();
      };
      wrapped.__gdProfileRouteHardening=true;
      window.gdCloseProfileV67=wrapped;
    }
  }
  document.addEventListener('click',function(ev){
    const openTarget=ev.target&&ev.target.closest&&ev.target.closest('.gdProfileTile,[onclick*="openProfilePanel"]');
    if(openTarget){
      setTimeout(()=>{wrapProfileOpen();wrapProfileClose();forceProfileSurface();},0);
      return;
    }
    const closeTarget=ev.target&&ev.target.closest&&ev.target.closest('#gdProfileV67 .pillBtn');
    if(closeTarget && /back|home/i.test(closeTarget.textContent||closeTarget.getAttribute('aria-label')||'')){
      if(/back/i.test(closeTarget.textContent||closeTarget.getAttribute('aria-label')||'')&&document.querySelector('#gdProfileV67 .coachChangePlayer'))return;
      setTimeout(forceProfileHome,0);
    }
  },true);
  wrapProfileOpen();
  wrapProfileClose();
  setTimeout(()=>{wrapProfileOpen();wrapProfileClose();},250);
  setTimeout(()=>{wrapProfileOpen();wrapProfileClose();},1000);
})();
