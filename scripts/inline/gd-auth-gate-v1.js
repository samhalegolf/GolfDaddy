/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  'use strict';
  function safe(fn,fallback){try{return fn()}catch(e){console.warn('[GD auth gate]',e);return fallback}}
  function account(){
    return safe(function(){
      return window.GolfDaddyAccounts&&typeof window.GolfDaddyAccounts.current==='function'
        ? window.GolfDaddyAccounts.current()
        : null;
    },null);
  }
  function locked(){return !account();}
	  function closeNonAuthSurfaces(){
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
		    safe(()=>document.getElementById('clarityBackupOverlay')?.classList.remove('open'));
		    safe(()=>document.getElementById('claritySupportOverlay')?.classList.remove('open'));
		    safe(()=>document.body.classList.remove('gps-open','manual-gps-active','gdStatsOpen','gdBubbleStudioOpen','gdShotDataOpen'));
		  }
	  function showLoginGate(){
	    if(window.gd67OpenPasswordResetRoute&&safe(()=>window.gd67OpenPasswordResetRoute(),false)){
		    closeNonAuthSurfaces();
		    safe(()=>window.GDShell?.showAuth?.({source:'auth-gate-reset'}));
		    document.body.classList.add('gdAuthLocked','gdProfileOpen','gdPasswordResetRoute');
	      return false;
	    }
		    closeNonAuthSurfaces();
		    safe(()=>window.GDShell?.showAuth?.({source:'auth-gate'}));
		    document.body.classList.add('gdAuthLocked','gdProfileOpen');
    const profile=document.getElementById('gdProfileV67');
    if(window.gdOpenProfileV67&&(!profile||profile.classList.contains('hidden')||!/Sign in/i.test(profile.textContent||''))){
	      safe(()=>window.gdOpenProfileV67({authGate:true}));
	      closeNonAuthSurfaces();
	      safe(()=>window.GDShell?.showAuth?.({source:'auth-gate-profile'}));
	      document.body.classList.add('gdAuthLocked','gdProfileOpen');
    }else if(profile){
      profile.classList.remove('hidden');
    }
    return false;
  }
  function releaseGate(){
    document.body.classList.remove('gdAuthLocked');
    /* gdAuthRouteBoot is a pre-paint guess made from localStorage before any
       script can verify it, and gd-app-base.css uses it to hide #shellHome,
       #courseScreen, #shellTop, #shellDock and every panel with !important.
       Four separate places are meant to clear it after sign-in; when none of
       them do, the shell renders as a blank screen no matter what the router
       says - route "home", no hidden class, and nothing visible.

       This gate is the authoritative check, so the guess must not outlive it:
       if an account exists, the boot class is stale by definition. Clearing it
       here means a missed removal self-heals on the next gate pass rather than
       stranding the user. gdResetRouteBoot is deliberately left alone - it has
       no CSS and belongs to the password-reset flow. */
    safe(function(){document.documentElement.classList.remove('gdAuthRouteBoot')});
    return true;
  }
  function applyGate(){
    return locked()?showLoginGate():releaseGate();
  }
  function guard(name){
    const old=window[name];
    if(typeof old!=='function'||old.__gdAuthGate)return;
    const wrapped=function(){
      if(locked())return showLoginGate();
      return old.apply(this,arguments);
    };
    wrapped.__gdAuthGate=true;
    window[name]=wrapped;
    safe(()=>{eval(name+'=wrapped')});
  }
  function wrapAccounts(){
    const api=window.GolfDaddyAccounts;
    if(!api||api.__gdAuthGate)return;
    ['login','logout','apply'].forEach(name=>{
      const old=api[name];
      if(typeof old!=='function')return;
      api[name]=function(){
        const result=old.apply(this,arguments);
        setTimeout(applyGate,0);
        return result;
      };
    });
    api.__gdAuthGate=true;
  }
  function install(){
    wrapAccounts();
    ['showShellHome','showModePicker','enterGpsModule','openShellModule','openBag','openStats','openCourseData','openPracticeData','openDeveloperPanel','gdOpenPlayerSettingsPanel'].forEach(guard);
    const oldClose=window.gdCloseProfileV67;
    if(typeof oldClose==='function'&&!oldClose.__gdAuthGate){
      const wrappedClose=function(){
        if(locked())return showLoginGate();
        return oldClose.apply(this,arguments);
      };
      wrappedClose.__gdAuthGate=true;
      window.gdCloseProfileV67=wrappedClose;
    }
    applyGate();
  }
  window.gdApplyAuthGate=applyGate;
  document.addEventListener('DOMContentLoaded',function(){setTimeout(install,0);setTimeout(install,500);});
	  document.addEventListener('click',function(ev){
	    if(ev.target&&ev.target.closest&&ev.target.closest('#gdProfileV67'))return;
	    setTimeout(applyGate,0);
	  },true);
  setTimeout(install,0);
  setTimeout(install,800);
})();
