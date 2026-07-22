/* Extracted verbatim from an inline <script> block in index.html (split-03). */
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
  function locked(){return !demoMode()&&!account();}
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
    safe(function(){document.documentElement.classList.remove('gdAuthRouteBoot')});
    return true;
  }
  function applyGate(){return locked()?showLoginGate():releaseGate();}
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
  function demoMetric(key,value){return {candidateMetric:key,value:value,confidence:0.98,rawLabel:key};}
  function demoShots(){
    const degrees=[3.6,4.1,4.4,4.7,5.0,5.2,4.8,4.5,5.4,4.2,4.9,5.1,3.9,4.6,5.3,4.3,4.8,5.0,4.4,5.2];
    const carries=[148,151,149,153,150,147,152,154,149,151,150,148,155,152,149,153,150,151,147,154];
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
  function seedRealPracticeDemo(){
    if(!demoMode())return false;
    const api=window.GolfDaddyLaunchMonitorData;
    if(!api||typeof api.importCapture!=='function')return false;
    const key='gd_demo_practice_bubble_seed_v3';
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
    safe(function(){
      document.documentElement.classList.remove('gdAuthRouteBoot');
      document.body.classList.remove('gdAuthLocked','gdProfileOpen');
      if(typeof window.gdOpenDataHub==='function')window.gdOpenDataHub();
      if(typeof window.gdDataHubPracticeAction==='function')window.gdDataHubPracticeAction();
      else if(typeof window.openPracticeData==='function')window.openPracticeData();
    });
    setTimeout(function(){
      safe(function(){
        if(typeof window.gdRenderPracticeData==='function')window.gdRenderPracticeData();
        if(typeof window.gdRenderBubbleOffsetHub==='function')window.gdRenderBubbleOffsetHub(true);
        const input=document.querySelector('#practiceDataPanel .gdBubbleFaceOffsetInput')||document.querySelector('.gdBubbleFaceOffsetInput');
        if(input){
          if(typeof window.gdBubbleOffsetEdit==='function')window.gdBubbleOffsetEdit();
          input.value='2.1';
          input.dispatchEvent(new Event('input',{bubbles:true}));
          if(typeof window.gdBubbleOffsetSave==='function')window.gdBubbleOffsetSave();
        }
      });
    },350);
    return true;
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
    seedRealPracticeDemo();
  }
  window.gdApplyAuthGate=applyGate;
  window.gdSeedRealPracticeDemo=seedRealPracticeDemo;
  document.addEventListener('DOMContentLoaded',function(){setTimeout(install,0);setTimeout(install,500);setTimeout(seedRealPracticeDemo,1200);});
  document.addEventListener('click',function(ev){
    if(ev.target&&ev.target.closest&&ev.target.closest('#gdProfileV67'))return;
    setTimeout(applyGate,0);
  },true);
  setTimeout(install,0);
  setTimeout(install,800);
  setTimeout(seedRealPracticeDemo,1600);
})();