/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  const ICONS = window.GDIconAssets.icons;
  const MODE_KEY = 'gd_beta_gps_mode';
  let returnScorecardToGps = false;
  let lastGpsActive = false;

  function $(sel){return document.querySelector(sel)}
  function safeToast(msg){try{ if(typeof toast==='function') toast(msg); else console.log(msg); }catch(e){console.log(msg)}}
  function img(key,cls=''){const src=ICONS[key]||'';return src?'<img class="'+cls+'" src="'+src+'" alt="'+key+'">':''}

  function gpsActive(){
    const home=document.getElementById('shellHome');
    if(document.body.classList.contains('shell-home') && home && !home.classList.contains('hidden')) return false;
    if(document.body.classList.contains('shell-module') && !document.body.classList.contains('shell-gps')) return false;
    if(document.querySelector('#bagPanel.open,#developerPanel.open,#settingsPanel.open,#profilePanel.open,#statsPanel.open,#dataHubPanel.open,#practiceDataPanel.open,#gdProfileV67:not(.hidden)')) return false;
    const mapEl=document.getElementById('map');
    if(!mapEl || mapEl.offsetParent===null) return false;
    const course=document.getElementById('courseScreen');
    return !course || course.classList.contains('hidden');
  }
	  function setGpsActive(){
	    const active=gpsActive();
	    if(active) lastGpsActive=true;
	    return active;
	  }
  function usablePersonName(value){
    const name=String(value||'').trim();
    if(!name)return '';
    return /^(demo player|player 1|placeholder player)$/i.test(name)?'':name;
  }
  function storedProfileById(profileId){
    try{
      const raw=JSON.parse(localStorage.getItem('gd_player_profiles_v27')||'{}');
      const profiles=Array.isArray(raw.profiles)?raw.profiles:[];
      if(profileId)return profiles.find(profile=>profile&&profile.id===profileId)||null;
      return profiles.find(profile=>profile&&profile.id===raw.activeId)||profiles[0]||null;
    }catch(e){return null}
  }
  function profileById(profileId){
    if(!profileId)return null;
    try{if(typeof gdProfileById==='function')return gdProfileById(profileId)||storedProfileById(profileId)}catch(e){}
    return storedProfileById(profileId);
  }
  function accountApi(){return window.GolfDaddyAccounts||window.ClarityCaddieAccounts||null}
  function accountState(){
    const api=accountApi();
    try{return api&&typeof api.state==='function'?api.state():null}catch(e){return null}
  }
  function currentAccount(){
    const api=accountApi();
    try{return api&&typeof api.current==='function'?api.current():null}catch(e){return null}
  }
  function accountForProfileId(profileId){
    const api=accountApi();
    try{return api&&typeof api.accountForProfile==='function'?api.accountForProfile(profileId):null}catch(e){return null}
  }
  function getProfile(){
    const account=currentAccount();
    const state=accountState()||{};
    if(account){
      const ownProfileId=account.profileId||'';
      const viewedProfileId=state.viewingProfileId||document.body?.dataset?.clarityViewedProfileId||ownProfileId;
      const profileId=viewedProfileId||ownProfileId;
      const profile=profileById(profileId)||profileById(ownProfileId);
      const owner=accountForProfileId(profileId);
      const viewingOther=!!(profileId&&ownProfileId&&profileId!==ownProfileId);
      const name=viewingOther
        ? (usablePersonName(owner&&owner.name)||usablePersonName(profile&&profile.name))
        : (usablePersonName(account.name)||usablePersonName(profile&&profile.name)||usablePersonName(owner&&owner.name));
      return Object.assign({},profile||{}, { name:name||usablePersonName(account.name)||'Player' });
    }
    try{
      const p=typeof activePlayerProfile==='function'?activePlayerProfile():null;
      const stored=storedProfileById(p&&p.id);
      return p||stored||null;
    }catch(e){return storedProfileById(null)}
  }
  function profileName(){const p=getProfile();return usablePersonName(p&&p.name)||'Player'}
  function mode(){return localStorage.getItem(MODE_KEY)==='live'?'live':'twoTap'}
  function currentHoleBadgeLabel(){
    try{
      if(window.gdFullMappingMode){
        const mapped=Number(window.gdMapperActiveHole||sessionStorage.getItem('gd_mapper_active_hole')||0);
        if(Number.isFinite(mapped)&&mapped>0)return 'Mapping H'+mapped;
      }
      if(typeof currentPlayingHole!=='undefined' && currentPlayingHole){
        const holeNumber=Number(currentPlayingHole);
        const holeData=(typeof scorecard!=='undefined' && scorecard && Array.isArray(scorecard.holes))?scorecard.holes[holeNumber-1]:null;
        return 'Hole '+holeNumber+(holeData&&holeData.par?' · Par '+holeData.par:'');
      }
    }catch(e){}
    try{
      const line=document.getElementById('holeLine');
      if(line && line.style.display!=='none' && line.textContent.trim()) return line.textContent.trim();
    }catch(e){}
    return '';
  }
  function setGpsLabel(ok,label){try{ if(typeof setGps==='function') setGps(!!ok,label); }catch(e){}}
  function setStateLabel(label){try{ if(typeof setState==='function') setState(label); }catch(e){}}
  function hint(label){try{ if(typeof showHint==='function') showHint(label); }catch(e){}}
  function hideHintSafe(){try{ if(typeof hideHint==='function') hideHint(); }catch(e){}}
  function wireGpsBadgeTuck(el){
    if(!el||el.__gdTuckWired)return;
    el.__gdTuckWired=true;
    let gesture=null;
    el.addEventListener('pointerdown',event=>{
      if(event.button&&event.button!==0)return;
      gesture={x:event.clientX,y:event.clientY,t:Date.now()};
    },{passive:true});
    el.addEventListener('pointerup',event=>{
      if(!gesture)return;
      const dx=event.clientX-gesture.x;
      const dy=event.clientY-gesture.y;
      const quick=Date.now()-gesture.t<600;
      gesture=null;
      if(Math.abs(dx)<8&&Math.abs(dy)<8&&el.classList.contains('gdTucked')){
        el.classList.remove('gdTucked');
        el.__gdSuppressNextClick=true;
        return;
      }
      if(!quick||Math.abs(dx)<42||Math.abs(dx)<Math.abs(dy)*1.35)return;
      if(dx<0&&!el.classList.contains('gdTucked')){
        el.classList.add('gdTucked');
        el.__gdSuppressNextClick=true;
      }else if(dx>0&&el.classList.contains('gdTucked')){
        el.classList.remove('gdTucked');
        el.__gdSuppressNextClick=true;
      }
    },{passive:true});
    el.addEventListener('click',event=>{
      if(!el.__gdSuppressNextClick)return;
      el.__gdSuppressNextClick=false;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    },true);
  }

  function ensureGpsBadge(){
    let el=document.getElementById('gdV62GpsBadge');
    if(!el){el=document.createElement('div');el.id='gdV62GpsBadge';document.body.appendChild(el)}
    const m=mode();
    const sub=m==='live'?'Live':'';
    const stat=m==='live'?'Location mode':'Set position';
    const label=m==='live'?'Live':'Manual';
    const hole=currentHoleBadgeLabel();
    el.classList.toggle('hasHole',!!hole);
    el.replaceChildren();

	    const main=document.createElement('div');
	    main.className='main';
	    const courseTop=document.createElement('div');
	    courseTop.className='courseTop';
    try{
      const active=window.gdActiveCourse;
      const activeName=(document.body?.dataset?.gdActiveCourseName||'').trim();
      if(activeName){
        courseTop.textContent=activeName==='Manual GPS'?'':activeName;
      }else if(active&&active.name){
        courseTop.textContent=active.name==='Manual GPS'?'':active.name;
      }else{
        courseTop.textContent=window.GolfDaddyCourseLibrary&&typeof window.GolfDaddyCourseLibrary.currentCourseStorageLabel==='function'
          ? window.GolfDaddyCourseLibrary.currentCourseStorageLabel()
          : (window.gdAssumedCourseName||sessionStorage.getItem('gd_assumed_course_name')||'');
      }
    }catch(e){courseTop.textContent=''}
    const name=document.createElement('div');
    name.className='name';
    name.textContent='GPS';
    const subEl=document.createElement('div');
    subEl.className='sub';
    subEl.textContent=sub;
    if(courseTop.textContent){
      courseTop.setAttribute('role','button');
      courseTop.setAttribute('tabindex','0');
      courseTop.setAttribute('title','Change course');
      courseTop.onclick=function(event){return typeof gdOpenChangeCourse==='function'?gdOpenChangeCourse(event):false;};
      courseTop.onkeydown=function(event){if(event.key==='Enter'||event.key===' '){return typeof gdOpenChangeCourse==='function'?gdOpenChangeCourse(event):false;}};
      main.append(courseTop);
    }
    main.append(name);
    if(subEl.textContent)main.append(subEl);

    const offset=document.createElement('div');
    offset.className='offset';
    offset.dataset.scoreTone=typeof gdScoreTone==='function'?gdScoreTone():'even';
    offset.setAttribute('role','button');
    offset.setAttribute('aria-label','Tap top half for score up, bottom half for score down');
    offset.setAttribute('aria-valuetext',typeof gdScoreDisplayValue==='function'?gdScoreDisplayValue():'E');
    offset.onclick=function(event){
      if(typeof adjustScore!=='function')return;
      const rect=offset.getBoundingClientRect();
      adjustScore(event.clientY<rect.top+(rect.height/2)?1:-1);
    };
    offset.onkeydown=function(event){
      if(typeof adjustScore!=='function')return;
      if(event.key==='ArrowUp'){adjustScore(1);event.preventDefault();}
      if(event.key==='ArrowDown'){adjustScore(-1);event.preventDefault();}
    };
    offset.tabIndex=0;
    const upMark=document.createElement('span');
    upMark.className='swipeMark top';
    upMark.textContent='+';
    const mid=document.createElement('span');
    mid.className='mid';
    mid.textContent=typeof gdScoreDisplayValue==='function'?gdScoreDisplayValue():'E';
    const downMark=document.createElement('span');
    downMark.className='swipeMark bottom';
    downMark.textContent='-';
    offset.append(upMark,mid,downMark);

    const status=document.createElement('div');
    status.className='status';
    const statusText=document.createElement('span');
    statusText.className='statusText';
    statusText.textContent=hole||stat;
    const modeText=document.createElement('span');
    modeText.className='modeText';
    const dot=document.createElement('i');
    dot.className='dot';
    const bold=document.createElement('b');
    bold.textContent=label;
    modeText.append(dot,bold);
    status.append(statusText,modeText);
    el.append(main,offset,status);
    wireGpsBadgeTuck(el);
  }

	  function ensureModeSwitch(){
	    let sw=document.getElementById('gdV62ModeSwitch');
	    if(!gpsActive()){
	      if(sw&&!document.querySelector('.rightRail')&&sw.parentElement===document.body)sw.remove();
	      return;
	    }
	    const rail=document.querySelector('.rightRail') || (typeof window.gdEnsureAppRightRail==='function' ? window.gdEnsureAppRightRail() : null);
	    if(!rail)return;
	    if(!sw){sw=document.createElement('div');sw.id='gdV62ModeSwitch';}
	    if(rail&&sw.parentElement!==rail)rail.appendChild(sw);
	    ['top','right','bottom','left','transform'].forEach(prop=>{sw.style[prop]='';});
    delete sw.dataset.gdStableTop;
    const liveMode=mode()==='live';
    const nextMode=liveMode?'twoTap':'live';
    sw.dataset.mode=liveMode?'live':'twoTap';
    let btn=sw.querySelector('button.gdModeToggle');
    if(!btn){
      btn=document.createElement('button');
      btn.className='gdModeToggle';
      btn.type='button';
      btn.innerHTML='<span class="gdModeTrack"><span class="gdModeKnob"><span class="gdModeText"></span></span></span>';
      sw.replaceChildren(btn);
    }
    btn.classList.toggle('live',liveMode);
    btn.classList.toggle('twoTap',!liveMode);
    btn.setAttribute('aria-label',liveMode?'Switch to Manual':'Switch to Live');
    btn.title=liveMode?'Switch to Manual':'Switch to Live';
    const text=btn.querySelector('.gdModeText');
    if(text)text.innerHTML=liveMode?'Live':'Manual';
    btn.onclick=(ev)=>{
      ev.preventDefault();
      ev.stopPropagation();
      if(sw.dataset.switching==='1')return;
      sw.dataset.switching='1';
      try{
        localStorage.setItem(MODE_KEY,nextMode);
        localStorage.setItem('gd_gps_play_mode',nextMode);
        gdSafeLocalSet('gdGpsPlayMode',nextMode);
      }catch(e){}
      if(typeof window.setGpsPlayMode==='function') window.setGpsPlayMode(nextMode);
      else nextMode==='live'?enterLiveGps():enterTwoTap();
      setTimeout(()=>{sw.dataset.switching='0';try{ if(typeof gdV62Refresh==='function') gdV62Refresh(); }catch(e){}},220);
    };
  }

  function ensureUndo(){
    let dock=document.getElementById('gdV62UndoDock');
    if(!dock){dock=document.createElement('div');dock.id='gdV62UndoDock';dock.innerHTML='<button id="gdV62NewShotBtn" type="button">Unlock</button><button id="gdV62LogShotBtn" type="button">Shot End</button>';document.body.appendChild(dock)}
    if(!dock.querySelector('#gdV62NewShotBtn')){
      const next=document.createElement('button');
      next.id='gdV62NewShotBtn';
      next.type='button';
      next.textContent='Unlock';
      dock.prepend(next);
    }
    if(!dock.querySelector('#gdV62LogShotBtn')){
      const log=document.createElement('button');
      log.id='gdV62LogShotBtn';
      log.type='button';
      log.textContent='Shot End';
      dock.appendChild(log);
    }
    dock.querySelectorAll('#gdV62UndoBtn').forEach(btn=>btn.remove());
    const nextBtn=dock.querySelector('#gdV62NewShotBtn');
    nextBtn.onclick=(ev)=>{
      ev.preventDefault();
      ev.stopPropagation();
      if(typeof window.softUnlockFrame==='function')window.softUnlockFrame();
      else if(typeof unlockFrameForReset==='function')unlockFrameForReset();
      else if(typeof clearOrUndo==='function')clearOrUndo();
    };
    const logBtn=dock.querySelector('#gdV62LogShotBtn');
    logBtn.onclick=(ev)=>{
      ev.preventDefault();
      ev.stopPropagation();
      if(document.body.classList.contains('gdGreenArrivalMode')){
        if(typeof window.gdGpsNewShot==='function')window.gdGpsNewShot('shot_end_green_focus');
        return;
      }
      if(window.gdPendingManualShotVerification){toast("Tap where the shot finished");return;}
      if(!(gdPendingCourseShot()||target)){toast("Lock in a shot first");return;}
      if(typeof window.gdGpsNewShot==='function')window.gdGpsNewShot();
    };
    if(typeof window.gdSyncNewShotButtonState==='function')window.gdSyncNewShotButtonState();
  }

  function getLL(o){if(!o)return null;if(typeof o.lat==='number'&&typeof o.lng==='number')return o;if(typeof o.getLatLng==='function')return o.getLatLng();return null}
  function curStart(){try{if(typeof start!=='undefined')return getLL(start)}catch(e){}return getLL(window.start)}
  function curTarget(){try{if(typeof target!=='undefined')return getLL(target)}catch(e){}return getLL(window.target||window.pin)}
  function dist(a,b){if(!a||!b)return null;try{return L.latLng(a.lat,a.lng).distanceTo(L.latLng(b.lat,b.lng))}catch(e){};const R=6371000,rad=x=>x*Math.PI/180,dLat=rad(b.lat-a.lat),dLon=rad(b.lng-a.lng),lat1=rad(a.lat),lat2=rad(b.lat);const x=Math.sin(dLat/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;return 2*R*Math.atan2(Math.sqrt(x),Math.sqrt(1-x))}
  function ensureDistance(){
    let el=document.getElementById('gdV62Distance');
    if(el) el.remove();
  }

  function clearStartOnly(){try{if(typeof start!=='undefined')start=null}catch(e){};try{mode='start'}catch(e){};document.querySelectorAll('.startDot,.startMarker,.ballMarker,.originDot').forEach(x=>x.remove());try{if(typeof renderShot==='function')renderShot()}catch(e){}}
  function clearTargetOnly(){try{if(typeof target!=='undefined')target=null}catch(e){};try{mode='green'}catch(e){};document.querySelectorAll('.targetDot,.greenDot,.pinDot,.flagMarker').forEach(x=>x.remove());try{if(typeof renderShot==='function')renderShot()}catch(e){}}

  function enterTwoTap(){
    gdSafeLocalSet(MODE_KEY,'twoTap');
    try{if(typeof gpsWatch!=='undefined'&&gpsWatch&&navigator.geolocation){navigator.geolocation.clearWatch(gpsWatch);gpsWatch=null}}catch(e){}
    setGpsLabel(false,'Manual');
    clearStartOnly();
    const mapped=!!(window.gdMappedCourseAssistActive&&window.gdMappedCourseAssistActive());
    setStateLabel(mapped?'Mapped: set position':'Manual: set start');
    hint(mapped?'Tap where you are standing':'Tap twice: ball then green');
    refresh();
  }
  function enterLiveGps(){
    gdSafeLocalSet(MODE_KEY,'live');
    setGpsLabel(true,'GPS…');setStateLabel('Requesting GPS');hint('Allow location permission');
    window.GDGpsLocationLifecycle?.locate?.();
    refresh();
  }
  function clearOrUndo(){
    if(mode()==='live'){if(curTarget()){clearTargetOnly();if(window.gdMappedCourseAssistActive&&window.gdMappedCourseAssistActive()){setStateLabel('Mapped data needed');if(typeof window.gdShowMappedDropout==='function')window.gdShowMappedDropout()}else{setStateLabel('Live: set green');hint('Tap green centre')}refresh();return}}
    else{const mapped=!!(window.gdMappedCourseAssistActive&&window.gdMappedCourseAssistActive());if(curTarget()){clearTargetOnly();setStateLabel(mapped?'Mapped: set position':'Manual: set green');hint(mapped?'Tap where you are standing':'Tap twice: ball then green');refresh();return} if(curStart()){clearStartOnly();setStateLabel(mapped?'Mapped: set position':'Manual: set start');hint(mapped?'Tap where you are standing':'Tap twice: ball then green');refresh();return}}
    try{if(typeof undo==='function')undo();else if(typeof undoLast==='function')undoLast();}catch(e){safeToast('Nothing to undo')}
    refresh();
  }

  function ensureHome(){
    const home=document.getElementById('shellHome')||document.querySelector('.shellHome,.homeScreen,#homeScreen');
    if(!home) return;
    let wrap=document.getElementById('gdV62Home');
    if(!wrap){wrap=document.createElement('div');wrap.id='gdV62Home';home.prepend(wrap)}
    if(wrap.dataset.gdHomeBuilt==='1') return;
    wrap.dataset.gdHomeBuilt='1';
    wrap.innerHTML=`<div class="gdHomeHeader"><button class="gdHomeBrand" onclick="try{showShellHome()}catch(e){}" aria-label="Clarity Golf home"><span class="gdHomeBrandInner"><span class="gdClarityMark" aria-hidden="true"><img src="assets/brand/cg-logo-white-g.png?v=clarity-20260531" alt=""></span><span class="gdHomeBrandText">CLARITY GOLF</span></span></button><div class="gdHomeTagline"><span class="gdTaglineGreen">Turn</span> <span class="gdTaglineOrange">Practice</span> <span class="gdTaglineGreen">Patterns In</span><span class="gdTaglineOrange">to</span> <span class="gdTaglineGreen">on Course</span> <span class="gdTaglineOrange">Results</span></div><button class="gdHomeAdminSettings" onclick="try{if(window.gdOpenAdminSettings)return window.gdOpenAdminSettings({fromHome:true});openDeveloperPanel({fromHome:true});}catch(e){}" aria-label="Admin Settings">Admin</button><button class="gdHomePlayerSettings" onclick="gdOpenPlayerSettingsPanel({fromHome:true})" aria-label="Settings">Settings</button></div>
      <section class="gdHomeTiles" aria-label="Clarity Golf home navigation">
        <button class="gdHomeTile gdPlayTile" onclick="try{return window.GDCoursePicker&&typeof window.GDCoursePicker.open==='function'?window.GDCoursePicker.open({source:'home-play',returnTarget:'home'}):(typeof gdOpenChangeCourse==='function'?gdOpenChangeCourse(event):false)}catch(e){return false}" aria-label="Clarity Caddy Play"><span class="gdHomeTileLabel"><span class="gdHomeTileKicker">CLARITY CADDY</span><span class="gdHomeTileAction">PLAY</span></span><img class="gdHomeTileArt" src="assets/home/play.png?v=clarity-20260531" alt=""></button>
        <button class="gdHomeTile gdBubbleTile" onclick="try{gdOpenDataHub()}catch(e){}" aria-label="Clarity Shot System Enter"><span class="gdHomeTileLabel"><span class="gdHomeTileKicker">CLARITY SHOT SYSTEM</span><span class="gdHomeTileAction">ENTER</span></span><img class="gdHomeTileArt" src="assets/home/shot-system.svg?v=clarity-shot-system-line-20260601" alt=""></button>
        <button class="gdHomeTile gdBagTile" onclick="try{openBag()}catch(e){}" aria-label="Bag"><span class="gdHomeTileLabel">BAG</span><img class="gdHomeTileArt" src="assets/home/bag.png" alt=""></button>
        <button class="gdHomeTile gdProfileTile" onclick="try{openProfilePanel()}catch(e){}" aria-label="Player Profile"><span class="gdHomeTileLabel">PLAYER<br>PROFILE</span><img class="gdHomeTileArt" src="assets/home/profile.png" alt=""></button>
      </section>`;
  }

  function lockProfile(){
    const panel=document.getElementById('profilePanel'); if(!panel) return;
    const editing=panel.dataset.gdEditing==='1';
    panel.classList.toggle('gdLocked',!editing);
    panel.querySelectorAll('input,select').forEach(el=>el.disabled=!editing);
    const sheet=panel.querySelector('.moduleSheet')||panel;
    if(!panel.querySelector('.gdProfileLockNotice')){const n=document.createElement('div');n.className='gdProfileLockNotice';n.textContent='Profile is locked after setup. Use Edit Profile to make changes.';sheet.appendChild(n)}
    let b=panel.querySelector('.gdProfileEditBtn'); if(!b){b=document.createElement('button');b.className='gdProfileEditBtn';sheet.appendChild(b)}
    b.textContent=editing?'Save Profile':'Edit Profile';
    b.onclick=()=>{panel.dataset.gdEditing=editing?'0':'1';try{if(editing&&typeof savePlayerProfiles==='function')savePlayerProfiles()}catch(e){};setTimeout(()=>{lockProfile();ensureHome()},50)};
  }

  function scorecardOpen(){
    return Array.from(document.querySelectorAll('[id*="score" i],[class*="score" i]')).some(el=>{const r=el.getBoundingClientRect?el.getBoundingClientRect():null;return r&&r.width>40&&r.height>40&&el.offsetParent!==null&&!el.classList.contains('hidden')});
  }
  function returnToGps(){returnScorecardToGps=false;sessionStorage.removeItem('gd_return_from_scorecard');try{if(typeof enterGpsModule==='function')enterGpsModule({fromBack:true,preserve:true})}catch(e){}setTimeout(refresh,100)}
  function wireScorecardBack(){
    document.querySelectorAll('button,[role="button"],a').forEach(btn=>{
      if(btn.dataset.v62Back) return;
      const label=((btn.textContent||'')+' '+(btn.getAttribute('aria-label')||'')+' '+(btn.title||'')).toLowerCase();
      if(label.includes('back')||label.trim()==='←'||label.trim()==='‹'){btn.dataset.v62Back='1';btn.addEventListener('click',ev=>{if((returnScorecardToGps||sessionStorage.getItem('gd_return_from_scorecard')==='gps')&&scorecardOpen()){ev.preventDefault();ev.stopPropagation();ev.stopImmediatePropagation();returnToGps()}},true)}
    });
  }

  function refresh(){
    setGpsActive();
    ensureGpsBadge();
    ensureModeSwitch();
    ensureUndo();
    ensureDistance();
    ensureHome();
    lockProfile();
    wireScorecardBack();
  }

  window.setGpsPlayMode=function(next){next==='live'?enterLiveGps():enterTwoTap()};
  window.gdV62Refresh=refresh;

  ['enterGpsModule','setStart','setGreenTarget','renderShot','lockFrame','openShellModule','showShellHome','openProfilePanel'].forEach(name=>{
    const old=window[name];
    if(typeof old==='function'&&!old.__v62Wrapped){const w=function(...args){const res=old.apply(this,args);setTimeout(refresh,60);setTimeout(refresh,200);return res};w.__v62Wrapped=true;window[name]=w}
  });

  document.addEventListener('DOMContentLoaded',()=>{setTimeout(refresh,80);setTimeout(refresh,400);setTimeout(refresh,1000)});
  document.addEventListener('click',()=>setTimeout(refresh,80));
  window.addEventListener('clarity:session-changed',()=>setTimeout(refresh,40));
  window.addEventListener('resize',()=>setTimeout(refresh,80));
})();
