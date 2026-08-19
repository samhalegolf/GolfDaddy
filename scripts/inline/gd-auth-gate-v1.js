/* Extracted verbatim from an inline <script> block in index.html (split-03).
 *
 * Rewritten August 2026, after App Store review rejected build 740 under
 * guideline 5.1.1(v): "the app requires users to register or log in to access
 * features that are not account based".
 *
 * It used to be a wall. With no account it force-closed every surface, pinned
 * the sign-in panel open, wrapped gdCloseProfileV67 so the panel could not be
 * dismissed, and re-asserted all of that from a capture-phase listener on every
 * click anywhere in the app.
 *
 * It is now a gate on four routes. The test for what belongs here: does the
 * route read or write something that belongs to a person? Stats, practice data,
 * player settings and the admin panel do. Home, the course library, the bag and
 * the GPS surface do not - none of them read GolfDaddyAccounts, and nothing
 * under app/ references ClarityPermissions at all, so a signed-out player gets
 * the rangefinder, which is what Apple asked for. Whether that player may also
 * keep score is a separate question answered by clarity-permissions.js and
 * app/js/access.js; a paywall is not a login wall.
 *
 * The default is deliberately "open": a route that does not call
 * gdAuthGateAllows() is reachable. A new screen has to opt IN to needing an
 * account, so this cannot quietly grow back into a wall.
 *
 * Two sibling files were part of the same wall and changed with it -
 * gd-auth-reset-route-bootstrap.js (the pre-paint hide) and gd-route-audit.js
 * (browser back/restore). Please read this comment before re-adding an account
 * check to either.
 */
(function(){
  'use strict';
  function safe(fn,fallback){try{return fn()}catch(e){console.warn('[GD auth gate]',e);return fallback}}
  function demoMode(){
    return safe(function(){return new URLSearchParams(window.location.search).get('demo')==='practice-bubble'},false);
  }
  function account(){
    return safe(function(){
      return window.GolfDaddyAccounts&&typeof window.GolfDaddyAccounts.current==='function'
        ? window.GolfDaddyAccounts.current()
        : null;
    },null);
  }
  function signedIn(){return !!account()||demoMode();}
  function passwordResetRoute(){
    return safe(function(){return !!(window.gdPasswordResetRouteActive&&window.gdPasswordResetRouteActive())},false)
      ||safe(function(){return document.documentElement.classList.contains('gdResetRouteBoot')},false);
  }

  /* The account-based routes, and what to say when one is reached without an
     account. Everything else is open. */
  var REASONS={
    shotData:'Your shot data is saved to your account.',
    courseData:'Your course data is saved to your account.',
    practiceData:'Your practice data is saved to your account.',
    admin:'Admin tools need an account.'
  };

  let demoPracticeRetriesScheduled=false;
  let demoPracticeOffsetApplied=false;

  function openAuth(message){
    safe(()=>window.GDShell?.showAuth?.({source:'auth-gate'}));
    document.body.classList.add('gdProfileOpen');
    const profile=document.getElementById('gdProfileV67');
    if(window.gdOpenProfileV67&&(!profile||profile.classList.contains('hidden')||!/Sign in/i.test(profile.textContent||''))){
      safe(()=>window.gdOpenProfileV67({authGate:true}));
    }else if(profile){
      profile.classList.remove('hidden');
    }
    if(message)safe(()=>{if(typeof window.toast==='function')window.toast(message+' Sign in to open it.')});
    return false;
  }

  /* gd-auth-reset-route-bootstrap.js sets html.gdAuthRouteBoot pre-paint, and
     gd-app-base.css uses it to hide the entire shell with display:none. Since
     that guess is made from localStorage before anything authoritative has run,
     the gate is the thing that has to clear it - when it did not, the app booted
     to a black screen (dev/auth-route-boot-release.test.js covers exactly this).
     The reset route is the one case where the shell SHOULD stay hidden: the
     player is there to set a password, not to play. */
  function applyGate(){
    if(passwordResetRoute())return false;
    safe(function(){document.documentElement.classList.remove('gdAuthRouteBoot')});
    return true;
  }

  /* The one question the rest of the app asks. True means "carry on"; false
     means the sign-in screen is now open and the caller should stop.
     A published function rather than wrappers around window.openStats and
     friends, because wrappers do not survive here: gd-route-audit.js re-exports
     its own navigation functions onto window on a timer (expose(), again at
     ~250ms and ~1200ms after boot) and separately intercepts the home tiles in
     a capture-phase click listener that calls its internals directly. A wrapper
     installed at boot is therefore both overwritten and bypassed. The route
     owner calls this instead, at the top of the routes that need an account. */
  window.gdAuthGateAllows=function(reasonKey){
    if(signedIn())return true;
    openAuth(REASONS[reasonKey]||null);
    return false;
  };

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

  function demoMetric(key,value){return {candidateMetric:key,value:value,confidence:0.98,rawLabel:key};}
  function demoShots(){
    const degrees=[2.42,2.5,2.56,2.62,2.68,2.52,2.6,2.7,2.46,2.58,2.66,2.54,2.64,2.48,2.72,2.5,2.58,2.62,2.52,2.68];
    const carries=[150,151,150,151,151,150,151,151,150,151,150,150,151,151,150,151,151,150,150,151];
    return degrees.map(function(deg,index){
      return {
        shotId:'demo-practice-shot-'+(index+1),
        candidateClub:'7 Iron',
        originClubLabel:'7 Iron',
        expectedDistanceM:151,
        timestamp:new Date(Date.now()-((degrees.length-index)*45000)).toISOString(),
        metrics:[
          demoMetric('carryDistance',carries[index]),
          demoMetric('offlineAngle',deg),
          demoMetric('faceAngle',deg-0.4),
          demoMetric('clubPath',0.3),
          demoMetric('faceToPath',deg-0.7)
        ]
      };
    });
  }
  function openRealPracticeDemoSurface(){
    let opened=false;
    safe(function(){
      document.documentElement.classList.remove('gdAuthRouteBoot');
      document.body.classList.remove('gdAuthLocked','gdProfileOpen','gdPasswordResetRoute');
      document.getElementById('gdProfileV67')?.classList.add('hidden');
      if(typeof window.gdOpenDataHub==='function'){
        window.gdOpenDataHub();
        opened=true;
      }
      if(typeof window.gdDataHubPracticeAction==='function'){
        window.gdDataHubPracticeAction();
        opened=true;
      }else if(typeof window.openPracticeData==='function'){
        window.openPracticeData();
        opened=true;
      }
      const practiceCard=document.getElementById('gdPracticeDataOpenBtn');
      if(practiceCard&&practiceCard.getAttribute('aria-expanded')!=='true'){
        practiceCard.click();
        opened=true;
      }
    });
    return opened;
  }
  function practiceDemoSurfaceVisible(){
    return safe(function(){
      const text=document.body?.innerText||'';
      const card=document.getElementById('gdPracticeDataOpenBtn');
      return document.body.classList.contains('gdShotDataOpen')
        && (card?.getAttribute('aria-expanded')==='true'||/Sam Hale - Practice Data|Generate Bubble|Adopt Bubble/.test(text));
    },false);
  }
  function applyPracticeDemoOffset(){
    if(demoPracticeOffsetApplied)return;
    safe(function(){
      if(typeof window.gdRenderPracticeData==='function')window.gdRenderPracticeData();
      if(typeof window.gdRenderBubbleOffsetHub==='function')window.gdRenderBubbleOffsetHub(true);
      const input=document.querySelector('#practiceDataPanel .gdBubbleFaceOffsetInput')||document.querySelector('.gdBubbleFaceOffsetInput');
      if(input){
        if(typeof window.gdBubbleOffsetEdit==='function')window.gdBubbleOffsetEdit();
        input.value='2.1';
        input.dispatchEvent(new Event('input',{bubbles:true}));
        if(typeof window.gdBubbleOffsetSave==='function')window.gdBubbleOffsetSave();
        demoPracticeOffsetApplied=true;
      }
    });
  }
  function schedulePracticeDemoSurfaceRetries(){
    if(demoPracticeRetriesScheduled)return;
    demoPracticeRetriesScheduled=true;
    [0,450,1000,1800,3000,5000,7500].forEach(function(delay){
      setTimeout(function(){
        if(!practiceDemoSurfaceVisible())openRealPracticeDemoSurface();
        if(practiceDemoSurfaceVisible())applyPracticeDemoOffset();
      },delay);
    });
  }
  function seedRealPracticeDemo(){
    if(!demoMode())return false;
    const api=window.GolfDaddyLaunchMonitorData;
    if(!api||typeof api.importCapture!=='function')return false;
    const key='gd_demo_practice_bubble_seed_v5';
    if(!sessionStorage.getItem(key)){
      safe(function(){
        api.clearStore();
        api.importCapture({
          sessionId:'demo-practice-session',
          captureId:'demo-practice-capture',
          importBatchId:'demo-practice-import',
          label:'Clarity Demo Practice Session',
          inputType:'generated-demo',
          rawTextBlocks:['Trackman demo session','7 Iron practice pattern'],
          sourceIdentity:{providerGuess:'trackman',label:'Trackman',confidence:1,evidence:['demo']},
          startedAt:new Date(Date.now()-20*60000).toISOString(),
          clubGroups:demoShots()
        });
        sessionStorage.setItem(key,'1');
      });
    }
    schedulePracticeDemoSurfaceRetries();
    return true;
  }

  function install(){
    wrapAccounts();
    applyGate();
    seedRealPracticeDemo();
  }
  window.gdApplyAuthGate=applyGate;
  window.gdSeedRealPracticeDemo=seedRealPracticeDemo;
  document.addEventListener('DOMContentLoaded',function(){setTimeout(install,0);setTimeout(install,500);setTimeout(seedRealPracticeDemo,1200);});
  setTimeout(install,0);
  setTimeout(install,800);
  setTimeout(seedRealPracticeDemo,1600);
})();
