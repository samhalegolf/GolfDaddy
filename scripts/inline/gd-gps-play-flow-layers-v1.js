/* ============================================================================
 * GPS PLAY FLOW LAYERS — consolidated from 5 patch files (Phase A, 2026-07-19).
 * Sections in original load order, each an unchanged self-contained IIFE.
 * Folds into the GPS play owner during Phase B.
 * ============================================================================ */

/* ==== section: gd-gps-request-button-fix-v1.js ==== */
/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  function safe(fn){try{return fn()}catch(e){console.warn("[GolfDaddy] GPS request button",e)}}
  function requestGps(event){
    if(event){
      event.preventDefault?.();
      event.stopPropagation?.();
      event.stopImmediatePropagation?.();
    }
    if(typeof window.gdGpsLocateNow==="function")return window.gdGpsLocateNow();
    if(typeof window.refreshGPS==="function")return window.refreshGPS();
    if(typeof window.initGPS==="function")return window.initGPS();
    if(navigator.geolocation){
      safe(()=>navigator.geolocation.getCurrentPosition(()=>{},()=>{},{
        enableHighAccuracy:true,
        maximumAge:0,
        timeout:15000
      }));
    }
    return false;
  }
	  function ensureGpsRailButton(){
	    const rail=document.querySelector(".rightRail");
	    if(!rail)return;
	    let btn=document.getElementById("gpsRailBtn");
	    if(!btn)return;
    btn.type="button";
    btn.classList.add("railBtn","gdGpsRecenterBtn");
    btn.setAttribute("aria-label","GPS locate");
    btn.title="GPS locate";
    if(!btn.querySelector("img")&&!btn.querySelector(".gdGpsRailText")){
      btn.innerHTML='<span class="gdGpsRailText">GPS</span>';
    }
    btn.onclick=requestGps;
  }
  function wireHint(){
    document.querySelectorAll("#hint,.hint").forEach(el=>{
      if(!/Tap GPS and allow location/i.test(el.textContent||""))return;
      el.classList.add("gdGpsRequestHint");
      el.setAttribute("role","button");
      el.setAttribute("tabindex","0");
      el.setAttribute("aria-label","Request GPS location");
      if(!el.__gdGpsRequestHint){
        el.__gdGpsRequestHint=true;
        el.addEventListener("click",requestGps,true);
        el.addEventListener("keydown",event=>{
          if(event.key==="Enter"||event.key===" ")requestGps(event);
        },true);
      }
    });
  }
  function refresh(){ensureGpsRailButton();wireHint();}
  window.gdRequestGpsNow=requestGps;
  refresh();
  document.addEventListener("DOMContentLoaded",()=>setTimeout(refresh,80));
  document.addEventListener("click",event=>{
    const target=event.target&&event.target.closest&&event.target.closest("#hint.gdGpsRequestHint,.hint.gdGpsRequestHint,#gpsRailBtn");
    if(target)requestGps(event);
  },true);
  setInterval(refresh,900);
})();

/* ==== section: gd-gps-new-shot-final-wire-v1.js ==== */
/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  "use strict";
  function wire(){
    try{
      const btn=document.getElementById("gdV62LogShotBtn");
      if(btn&&!btn.__gdLogShotFinalWire){
        btn.__gdLogShotFinalWire=true;
        btn.onclick=function(ev){ev.preventDefault();ev.stopPropagation();if(typeof window.gdGpsNewShot==="function")window.gdGpsNewShot();};
      }
      if(typeof window.gdSyncNewShotButtonState==="function")window.gdSyncNewShotButtonState();
    }catch(e){console.warn("[GolfDaddy] new shot wire skipped",e);}
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",wire);
  else wire();
  setTimeout(wire,250);
  setTimeout(wire,1000);
})();

/* ==== section: gd-final-tool-screen-isolation-v1.js ==== */
/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  "use strict";
  var MODE_KEY="gd_mapped_play_mode_v1";
  var COURSE_MODE_PREFIX="gd_mapped_play_mode_course_v1:";
  var flagDown=null;
  var lastFlagOpenAt=0;
  function safe(fn,fallback){try{return fn()}catch(e){return fallback}}
  function slug(value){
    return String(value||"manual-gps").toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")||"manual-gps";
  }
  function activeCourse(){
    return safe(function(){
      var visible=String(document.getElementById("courseLine")?.textContent||"").trim();
      if(visible&&visible!=="Manual GPS"&&!/^assumed/i.test(visible))return {name:visible,source:"visible-course-label"};
      var bodyName=String(document.body.dataset.gdActiveCourseName||"").trim();
      if(bodyName&&bodyName!=="Manual GPS"&&!/^assumed/i.test(bodyName))return {name:bodyName,source:"body-course-label"};
      var stored=JSON.parse(localStorage.getItem("gd_active_course_v1")||"null");
      if(stored&&(stored.name||stored.courseName))return stored;
      if(window.gdActiveCourse&&(window.gdActiveCourse.name||window.gdActiveCourse.courseName))return window.gdActiveCourse;
      if(window.currentCourse&&(window.currentCourse.name||window.currentCourse.courseName))return window.currentCourse;
      return {name:"Manual GPS"};
    },{name:"Manual GPS"});
  }
  function courseIdentity(course){
    course=course||activeCourse();
    return slug(course.courseId||course.id||course.name||course.courseName||"manual-gps");
  }
  function defaultMappedMode(course){
    course=course||activeCourse();
    var name=String(course.name||course.courseName||"");
    if(/^manual gps$/i.test(name))return "unmapped";
    return safe(function(){return window.gdCourseHasMappedGreenFairway&&window.gdCourseHasMappedGreenFairway(course)} ,false)?"mapped":"unmapped";
  }
  function setCourseMode(mode){
    var next=mode==="mapped"?"mapped":"unmapped";
    safe(function(){localStorage.setItem(COURSE_MODE_PREFIX+courseIdentity(activeCourse()),next)});
    syncToolScreen();
    updateCourseMappingSetting();
    safe(function(){if(typeof toast==="function")toast(next==="mapped"?"Mapped course assist on":"Plain two-tap mode")});
    return next;
  }
  function mappedMode(){
    return safe(function(){
      var course=activeCourse();
      var value=localStorage.getItem(COURSE_MODE_PREFIX+courseIdentity(course));
      if(value==="mapped")return true;
      if(value==="unmapped")return false;
      return defaultMappedMode(course)==="mapped";
    },false);
  }
  function canShowCourseMappingSetting(){
    var role=safe(function(){return typeof gdGetAccountPermission==="function"?gdGetAccountPermission():""},"")||
      safe(function(){return document.body&&document.body.dataset&&(document.body.dataset.gdPermission||document.body.dataset.clarityAccountRole||document.body.dataset.accountRole)},"")||
      safe(function(){return window.GolfDaddyAccounts&&typeof window.GolfDaddyAccounts.current==="function"&&(window.GolfDaddyAccounts.current()||{}).role},"")||
      "player";
    role=String(role||"player").toLowerCase();
    return role==="admin"||role==="coach";
  }
  function updateCourseMappingSetting(){
    var course=activeCourse();
    var mapped=mappedMode();
    var row=document.getElementById("gdMappedPlayModeRow");
    var canShow=canShowCourseMappingSetting();
    if(row)row.hidden=!canShow;
    if(!canShow)return;
    var btn=document.getElementById("gdMappedPlayModeToggle");
    var sub=document.getElementById("gdMappedPlayModeSub");
    if(btn){
      btn.textContent=mapped?"Mapped":"Unmapped";
      btn.classList.toggle("active",mapped);
      btn.setAttribute("aria-label",mapped?"Mapped course mode":"Unmapped course mode");
      btn.title=mapped?"Mapped course mode":"Unmapped course mode";
      if(!btn.__gdFinalCourseModeBound){
        btn.__gdFinalCourseModeBound=true;
        btn.addEventListener("click",function(event){
          event.preventDefault();
          event.stopPropagation();
          setCourseMode(mappedMode()?"unmapped":"mapped");
        },true);
      }
    }
    if(sub){
      var name=String(course.name||course.courseName||"Manual GPS");
      sub.textContent=mapped?"Use saved mapping for "+name:"Plain two-tap for "+name;
    }
  }
  function gpsActive(){
    return document.body.classList.contains("shell-gps")||
      document.body.classList.contains("gdGpsActive")||
      document.body.classList.contains("gps-active");
  }
	  function mappingActive(){
	    return !!window.gdFullMappingMode||document.body.classList.contains("gdFullMappingMode");
	  }
	  function toolScreen(){
	    if(!gpsActive())return document.body.classList.contains("shell-module")?"module":"home";
	    if(mappingActive())return "mapping";
	    return mappedMode()?"mapped":"unmapped";
	  }
  function resetLegacyFlagState(flag){
    safe(function(){placingPin=false});
    safe(function(){draggingFlag=false});
    safe(function(){flagPointerStart=null});
    safe(function(){document.getElementById("ghost").style.display="none"});
    safe(function(){flag.classList.remove("softActive","grabbing")});
    safe(function(){document.getElementById("gdPinToolFlyout")?.classList.add("hidden")});
  }
  function closeMappedWand(screen){
    if(screen!=="mapped")return;
    safe(function(){greenActive=false});
    safe(function(){document.getElementById("gdWandPanel")?.classList.add("hidden")});
    safe(function(){if(typeof clearWandHandles==="function")clearWandHandles()});
    safe(function(){if(typeof window.gdClearWandLive==="function")window.gdClearWandLive()});
  }
  function syncToolScreen(){
    var screen=toolScreen();
    var pickerOpen=safe(function(){
      var courseScreen=document.getElementById("courseScreen");
      if(!courseScreen||courseScreen.classList.contains("hidden"))return false;
      var cs=getComputedStyle(courseScreen);
      return cs.display!=="none"&&cs.visibility!=="hidden";
    },false);
    if(pickerOpen)screen="picker";
    document.body.dataset.gdToolScreen=screen;
    document.body.dataset.gdToolCourse=courseIdentity(activeCourse());
    document.body.classList.toggle("gdMappedCourseMode",screen==="mapped");
    updateCourseMappingSetting();
    closeMappedWand(screen);
    var flag=document.getElementById("flagTool");
    if(flag){
      flag.onclick=openFlagPlacement;
      flag.setAttribute("aria-label","Pin-Lock");
      flag.title="Pin-Lock";
    }
    var pinTool=document.getElementById("gdPinToolFlyout");
    if(pinTool)pinTool.classList.add("hidden");
    return screen;
  }
  function blockFlagEvent(event){
    var flag=event.target&&event.target.closest&&event.target.closest("#flagTool");
    if(!flag)return null;
    event.preventDefault();
    event.stopPropagation();
    if(event.stopImmediatePropagation)event.stopImmediatePropagation();
    return flag;
  }
  function openFlagPlacement(event){
    var flag=event&&event.target&&event.target.closest?event.target.closest("#flagTool"):document.getElementById("flagTool");
    if(event){
      event.preventDefault();
      event.stopPropagation();
      if(event.stopImmediatePropagation)event.stopImmediatePropagation();
    }
    syncToolScreen();
    resetLegacyFlagState(flag||document.getElementById("flagTool"));
    if(Date.now()-lastFlagOpenAt<180)return false;
    lastFlagOpenAt=Date.now();
    if(typeof gdHasPlacedPin==="function"&&gdHasPlacedPin()){
      gdClearPinAndOpenPinLock("Pin cleared");
      return false;
    }
    if(typeof window.gdOpenPinLockSheet==="function")window.gdOpenPinLockSheet();
    else if(typeof window.gdTogglePinToolFlyout==="function")window.gdTogglePinToolFlyout(event||null);
    return false;
  }
  document.addEventListener("pointerdown",function(event){
    var flag=blockFlagEvent(event);
    if(!flag)return;
    syncToolScreen();
    resetLegacyFlagState(flag);
    flagDown={x:event.clientX||0,y:event.clientY||0,time:Date.now()};
  },true);
  document.addEventListener("pointermove",function(event){
    if(!flagDown)return;
    var flag=event.target&&event.target.closest&&event.target.closest("#flagTool");
    if(!flag)return;
    blockFlagEvent(event);
    resetLegacyFlagState(flag);
  },true);
  document.addEventListener("pointerup",function(event){
    var flag=blockFlagEvent(event);
    if(!flag)return;
    var start=flagDown;
    flagDown=null;
    resetLegacyFlagState(flag);
    var moved=start?Math.hypot((event.clientX||0)-start.x,(event.clientY||0)-start.y):0;
    if(moved<=12)openFlagPlacement(event);
  },true);
  document.addEventListener("pointercancel",function(event){
    var flag=blockFlagEvent(event);
    if(!flag)return;
    flagDown=null;
    resetLegacyFlagState(flag);
  },true);
  document.addEventListener("click",function(event){
    var flag=blockFlagEvent(event);
    if(!flag)return;
    openFlagPlacement(event);
  },true);
	  window.gdOpenFlagPlacement=openFlagPlacement;
	  window.startPinPlacement=openFlagPlacement;
	  window.gdActiveCourseForMode=activeCourse;
	  window.gdCourseModeIdentity=courseIdentity;
	  window.gdSetCourseMappedMode=setCourseMode;
	  window.gdMappedMode=mappedMode;
	  window.gdSyncToolScreen=syncToolScreen;
	  safe(function(){startPinPlacement=openFlagPlacement});
  syncToolScreen();
  setTimeout(syncToolScreen,80);
  setTimeout(syncToolScreen,350);
  setTimeout(syncToolScreen,1200);
  setInterval(syncToolScreen,700);
})();

/* ==== section: gd-play-flow-next-hole-v1.js ==== */
/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  "use strict";
  var NEAR_GREEN_M=55;
  var CLEAR_GREEN_M=95;
  var LOST_CLEAR_MS=2600;
  var LONG_PRESS_MS=560;
  var SWIPE_STEP_PX=34;
  var pointerState=null;
  var chooserOpen=false;
  var lastRailActionAt=0;
	  var queuedNextHole=null;
	  var nextPromptLatch=null;
	  var nextPromptSuppressedHole=null;
	  var nextPromptLostAt=0;
	  var holeSwitchToken=0;

  function safe(fn,fallback){try{return fn()}catch(e){console.warn("[GolfDaddy play flow]",e);return fallback}}
  function validHole(value){
    var h=Number(value);
    return Number.isFinite(h)&&h>=1&&h<=36?Math.round(h):null;
  }
  function holeCount(){
    return safe(function(){
      return Array.isArray(scorecard&&scorecard.holes)&&scorecard.holes.length?scorecard.holes.length:18;
    },18)||18;
  }
  function activeHole(){
    return safe(function(){return validHole(currentPlayingHole)},null)
      || safe(function(){return validHole(sessionStorage.getItem("gd_active_playing_hole"))},null)
      || safe(function(){return validHole(selectedHole)},null)
      || 1;
  }
  function nextHole(fromHole){
    var count=holeCount();
    var h=validHole(fromHole)||activeHole();
    return Math.min(count,h+1);
  }
  function previousHole(fromHole){
    var h=validHole(fromHole)||activeHole();
    return Math.max(1,h-1);
  }
  function parForHole(h){
    return safe(function(){
      var row=scorecard&&scorecard.holes&&scorecard.holes[h-1];
      var view=typeof gdScorecardHoleView==="function"?gdScorecardHoleView(row):row;
      var par=typeof gdScorecardKnownNumber==="function"?gdScorecardKnownNumber(view&&view.par):Number(view&&view.par);
      return Number.isFinite(par)?par:null;
    },null);
  }
  function rememberHole(h){
    h=validHole(h)||1;
    if(nextPromptSuppressedHole&&nextPromptSuppressedHole!==h)nextPromptSuppressedHole=null;
    safe(function(){if(typeof window.gdRememberPlayingHole==="function")window.gdRememberPlayingHole(h);});
    safe(function(){currentPlayingHole=h;});
    safe(function(){selectedHole=h;});
    safe(function(){sessionStorage.setItem("gd_active_playing_hole",String(h));});
    safe(function(){sessionStorage.setItem("gd_mapper_active_hole",String(h));});
    return h;
  }
  function prepareFreshGpsHole(reason){
    safe(function(){
      if(typeof window.gdPrepareGpsFreshHoleScreen==="function")window.gdPrepareGpsFreshHoleScreen(reason||"hole-change");
    });
  }
  function returnGpsMap(){
    closeHoleChooser();
    safe(function(){sessionStorage.removeItem("gd_return_from_scorecard");});
    safe(function(){document.querySelectorAll(".panel.open,.modulePanel.open").forEach(function(p){p.classList.remove("open")});});
    var gpsOpen=safe(function(){return isGpsOpen&&isGpsOpen();},false)||document.body.classList.contains("shell-gps")||document.body.classList.contains("gdGpsActive")||document.body.classList.contains("gps-active");
    if(gpsOpen){
      safe(function(){document.getElementById("courseScreen")?.classList.add("hidden");});
      safe(function(){document.body.classList.remove("shell-home","shell-module");});
      safe(function(){document.body.classList.add("shell-gps","gdGpsActive","gps-active");});
      safe(function(){if(typeof showShellChrome==="function")showShellChrome(true);});
      safe(function(){if(typeof setDockActive==="function")setDockActive("gps");});
      safe(function(){if(typeof map!=="undefined"&&map&&map.invalidateSize)setTimeout(function(){map.invalidateSize();},40);});
      safe(function(){if(typeof window.gdSyncPlayFlowRail==="function")window.gdSyncPlayFlowRail();});
      safe(function(){if(typeof window.gdHydrateGpsBadge==="function")window.gdHydrateGpsBadge(true);});
      return false;
    }
    safe(function(){if(typeof enterGpsModule==="function")enterGpsModule({fromBack:true,preserve:true,replace:true});});
	    safe(function(){if(typeof gdV62Refresh==="function")setTimeout(gdV62Refresh,80);});
	  }
	  function mappedAssistOn(){
	    return safe(function(){
	      if(typeof window.gdMappedCourseAssistEnabled==="function")return !!window.gdMappedCourseAssistEnabled();
	      if(typeof gdMappedCourseAssistActive==="function")return !!gdMappedCourseAssistActive();
	      return document.body.classList.contains("gdMappedCourseMode");
	    },false);
	  }
		  function showHoleSwitchStartPrompt(h,reason){
		    if(!isGpsOpen()||coursePickerOpen()||!mappedAssistOn())return false;
		    if(validHole(h)!==activeHole())return false;
		    safe(function(){document.body.classList.add("gdMappedCourseMode","gdMappedStartPromptActive");});
		    safe(function(){document.body.classList.remove("gdManualStartPlacementActive","gdHeadToTeeFrameActive","gdLockStateFrameActive","gd-frame-hard-locked","gdGreenArrivalMode","gd-green-zoom-active");});
	    safe(function(){
	      var hint=document.getElementById("hint");
	      if(!hint)return;
	      hint.classList.add("visible","gdMappedStartPill");
	      if(typeof gdRenderMappedStartHint==="function")gdRenderMappedStartHint(hint);
	      else hint.innerHTML='<button class="gdMappedStartAction" type="button" data-gd-mapped-start-action="manual">Set Start Point</button><button class="gdMappedStartAction gdHeadToTee" type="button" data-gd-mapped-start-action="tee">Head To the Tee</button>';
	    });
	    safe(function(){
	      var appEl=document.getElementById("app");
	      if(appEl){appEl.classList.remove("framed");appEl.classList.add("gdPreLockFrame");}
		    });
		    safe(function(){if(typeof setState==="function")setState("Hole "+h)});
		    return true;
		  }
  function scorecardOpen(){
    var el=document.getElementById("scorePanel");
    return !!(el&&el.classList.contains("open"));
  }
  function openScorecardOnHole(h){
    h=rememberHole(h);
    safe(function(){sessionStorage.setItem("gd_return_from_scorecard","gps");});
    safe(function(){
      if(window.GDGpsScorecard&&typeof window.GDGpsScorecard.syncCurrentHole==="function")window.GDGpsScorecard.syncCurrentHole(h);
      if(window.GDGpsScorecard&&typeof window.GDGpsScorecard.open==="function")window.GDGpsScorecard.open({hole:h});
      else if(typeof openScorecard==="function")openScorecard();
    });
    [80,300,760].forEach(function(delay){
      setTimeout(function(){
        safe(function(){
          if(window.GDGpsScorecard&&typeof window.GDGpsScorecard.syncCurrentHole==="function")window.GDGpsScorecard.syncCurrentHole(h);
          else selectedHole=h;
        });
        safe(function(){
          if(window.GDGpsScorecard&&typeof window.GDGpsScorecard.render==="function")window.GDGpsScorecard.render();
          else if(typeof renderScorecard==="function")renderScorecard();
        });
        syncScoreSaveLabel();
      },delay);
    });
  }
  function gdRoundSessionRead(){
    return safe(function(){return JSON.parse(sessionStorage.getItem("gd_current_round_session")||"{}");},{} )||{};
  }
  function gdRoundSessionWrite(session){
    safe(function(){sessionStorage.setItem("gd_current_round_session",JSON.stringify(session||{}));});
  }
  function gdLatLngSnapshot(ll){
    return safe(function(){return ll?{lat:Number(ll.lat),lng:Number(ll.lng)}:null;},null);
  }
  function gdBuildHoleFrame(h,par,opts){
    opts=opts||{};
    var includeCurrentShot=opts.includeCurrentShot===true;
    return {
      ready:true,
      holeNumber:h,
      camera:safe(function(){return (typeof map!=="undefined"&&map)?{bounds:map.getBounds&&map.getBounds().toBBoxString?map.getBounds().toBBoxString():null,zoom:map.getZoom?map.getZoom():null,bearing:null}:{};},{}),
      startPoint:includeCurrentShot?safe(function(){return gdLatLngSnapshot(typeof start!=="undefined"?start:null);},null):null,
      targetPoint:includeCurrentShot?safe(function(){return gdLatLngSnapshot((typeof target!=="undefined"&&target)||(typeof greenCentre!=="undefined"&&greenCentre)||null);},null):null,
      green:{center:includeCurrentShot?safe(function(){return gdLatLngSnapshot(typeof greenCentre!=="undefined"?greenCentre:null);},null):null,shape:includeCurrentShot?safe(function(){return Array.isArray(window.gdAcceptedGreenShape)?window.gdAcceptedGreenShape:[];},[]):[]},
      aimLine:[],
      labels:{hole:h,par:par,mode:"preLock"}
    };
  }
  function gdEnsureHoleObject(h,par){
    var session=gdRoundSessionRead();
    session.holes=Array.isArray(session.holes)?session.holes:[];
    var existing=session.holes.find(function(x){return Number(x&&x.holeNumber)===Number(h);});
    if(!existing){
      existing={holeNumber:h,mapping:{mappedStatus:"saved"},holeFrame:gdBuildHoleFrame(h,par),playState:{phase:"preLock",locked:false,pin:null,selectedClub:null,shotBubble:null,lockState:{lockedAt:null,startPoint:null,targetPoint:null}}};
      session.holes.push(existing);
    }else{
      existing.holeNumber=h;
      existing.mapping=existing.mapping||{mappedStatus:"saved"};
      existing.holeFrame=existing.holeFrame&&existing.holeFrame.ready?existing.holeFrame:gdBuildHoleFrame(h,par);
      existing.playState=existing.playState||{phase:"preLock",locked:false,lockState:{}};
      if(!existing.playState.phase)existing.playState.phase=existing.playState.locked?"locked":"preLock";
    }
    session.activeHoleNumber=h;
    session.updatedAt=new Date().toISOString();
    gdRoundSessionWrite(session);
    return existing;
  }
	  function gdMarkActiveHoleLocked(){
	    var h=activeHole();
	    var par=parForHole(h);
	    var session=gdRoundSessionRead();
    var hole=gdEnsureHoleObject(h,par);
    hole.playState=hole.playState||{};
    hole.playState.phase="locked";
    hole.playState.locked=true;
    hole.playState.lockState=Object.assign({},hole.playState.lockState||{},{lockedAt:new Date().toISOString(),startPoint:safe(function(){return gdLatLngSnapshot(typeof start!=="undefined"?start:null);},null),targetPoint:safe(function(){return gdLatLngSnapshot((typeof target!=="undefined"&&target)||(typeof greenCentre!=="undefined"&&greenCentre)||null);},null)});
    session=gdRoundSessionRead();
    session.holes=Array.isArray(session.holes)?session.holes:[];
    var idx=session.holes.findIndex(function(x){return Number(x&&x.holeNumber)===Number(h);});
    if(idx>=0)session.holes[idx]=hole;
    session.activeHoleNumber=h;
	    gdRoundSessionWrite(session);
	    return hole;
	  }
	  function forceHolePreLock(hole,h,par,reason){
	    h=validHole(h)||activeHole();
	    if(!hole)return null;
	    hole.playState={phase:"preLock",locked:false,pin:null,selectedClub:null,shotBubble:null,lockState:{lockedAt:null,startPoint:null,targetPoint:null,reason:reason||"hole-switch"}};
	    hole.holeFrame=gdBuildHoleFrame(h,par);
	    var session=gdRoundSessionRead();
	    session.holes=Array.isArray(session.holes)?session.holes:[];
	    var idx=session.holes.findIndex(function(x){return Number(x&&x.holeNumber)===Number(h);});
	    if(idx>=0)session.holes[idx]=hole;
	    else session.holes.push(hole);
	    session.activeHoleNumber=h;
	    session.updatedAt=new Date().toISOString();
	    gdRoundSessionWrite(session);
	    return hole;
	  }
	  function clearManualStartFallback(reason){
	    safe(function(){
	      window.__gdManualStandingPlacementActiveUntil=0;
	      window.__gdManualStartHadShotToLog=false;
	      window.__gdManualStartLockToken=Number(window.__gdManualStartLockToken||0)+1;
	      delete window.__gdLastStandingPoint;
	    });
	    safe(function(){if(typeof window.gdClearLocationSetLock==="function")window.gdClearLocationSetLock(reason||"hole-switch")});
	    safe(function(){if(typeof window.gdDisarmLocationSet==="function")window.gdDisarmLocationSet(reason||"hole-switch")});
	    safe(function(){
	      if(!document.body||!document.body.dataset)return;
	      ["gdStandingPointLat","gdStandingPointLng","gdStandingPointSource","gdStandingPointAt","gdStandingPointComplete","gdGreenFocusManualDistance","gdGreenFocusBallLat","gdGreenFocusBallLng","gdGreenFocusBallSource","gdManualSurfaceEnd","gdLocationSetLockedReason","gdLocationSetLockedAt","gdLocationClickConsumed","gdLocationClickConsumedAt"].forEach(function(key){delete document.body.dataset[key]});
	    });
	    safe(function(){if(document.body)document.body.classList.remove("gdManualStartPlacementActive")});
	  }
	  function clearHoleSwitchShotState(h,reason){
	    reason=reason||"hole-switch";
	    safe(function(){
	      if(typeof window.gdClearManualStartRuntime==="function")window.gdClearManualStartRuntime(reason,{preserveMappedPrompt:false});
	      else clearManualStartFallback(reason);
	    });
	    safe(function(){if(typeof window.gdClearCapturedHoleFrameShotOverlay==="function")window.gdClearCapturedHoleFrameShotOverlay()});
	    safe(function(){if(typeof gdClearTargetArtifactsForFreshStart==="function")gdClearTargetArtifactsForFreshStart()});
	    safe(function(){if(typeof clearShot==="function")clearShot()});
	    safe(function(){if(typeof gdResetShotDistanceDisplay==="function")gdResetShotDistanceDisplay()});
	    safe(function(){start=target=greenCentre=pin=null;mode="start";lockedFrame=false;targetWasMoved=false;targetDragging=false;currentShotLogged=false;gdCurrentPlannedShotId=null;gdWindLandingTarget=null});
	    safe(function(){document.body.classList.remove("gdManualStartPlacementActive","gdHeadToTeeFrameActive","gdLockStateFrameActive","gd-frame-hard-locked","gdGreenArrivalMode","gd-green-zoom-active","gdBubbleLongPressZoomActive","gdCapturedBubbleDragging")});
	    safe(function(){var tile=document.getElementById("shotTile");if(tile)tile.classList.remove("visible")});
	    safe(function(){if(typeof setState==="function")setState("Hole "+h)});
	  }
	  function clearHoleSwitchSurface(h,reason){
	    clearHoleSwitchShotState(h,reason||"hole-switch");
	    safe(function(){if(typeof window.gdPrepareGpsFreshHoleScreen==="function")window.gdPrepareGpsFreshHoleScreen(reason||"hole-switch")});
	    safe(function(){
	      if(typeof window.gdClearHoleImageRuntime==="function")window.gdClearHoleImageRuntime(reason||"hole-switch");
	      else if(typeof window.gdResetHoleImageFresh==="function")window.gdResetHoleImageFresh();
	    });
	  }
	  function renderHoleFrame(hole,opts){
	    opts=opts||{};
	    if(!hole)return false;
	    if(typeof window.gdFocusMappedPreLockHole==="function"){
	      window.gdFocusMappedPreLockHole(hole.holeNumber,{source:opts.source||"hole-frame",par:hole.holeFrame&&hole.holeFrame.labels?hole.holeFrame.labels.par:null,preserveGpsSession:true,reenterGps:false,refreshGps:false,switchToken:opts.switchToken,surfaceAlreadyClear:!!opts.surfaceAlreadyClear});
	      return true;
	    }
    return false;
  }
  function renderLockedHole(hole,opts){
    opts=opts||{};
    safe(function(){if(typeof renderShot==="function")renderShot();});
    return renderHoleFrame(hole,Object.assign({},opts,{source:opts.source||"hole-frame-locked"}));
  }
  function renderActiveHole(hole,opts){
    opts=opts||{};
    if(!hole)return false;
    var phase=hole.playState&&hole.playState.phase?hole.playState.phase:"preLock";
    if(phase==="locked")return renderLockedHole(hole,opts);
    return renderHoleFrame(hole,opts);
  }
	  function setActiveHole(h,opts){
	    opts=opts||{};
		    h=rememberHole(h);
			    var switchToken=++holeSwitchToken;
			    window.__gdHoleFrameSwitchToken=switchToken;
			    window.__gdHoleFrameSwitchTarget=h;
			    safe(function(){document.body.dataset.gdHoleFrameSwitchToken=String(switchToken);document.body.dataset.gdHoleFrameSwitchTarget=String(h)});
		    clearHoleSwitchShotState(h,(opts.source||"hole-switch")+"-pre-session");
		    var par=parForHole(h);
		    var hole=gdEnsureHoleObject(h,par);
		    closeHoleChooser();
		    try{window.__gdHoleFrameSwitching=true;}catch(e){}
		    safe(function(){
		      if(typeof window.gdBeginGpsHoleSwitchTransition==="function")window.gdBeginGpsHoleSwitchTransition(h,opts.source||"hole-switch",switchToken);
		      else document.body.classList.add("gdGpsHoleTransitioning","gdGpsFramePreparing","gdGpsLiveMapSuppressed");
		    });
		    clearHoleSwitchSurface(h,opts.source||"hole-switch");
		    safe(function(){
		      if(typeof window.gdBeginGpsHoleSwitchTransition==="function")window.gdBeginGpsHoleSwitchTransition(h,(opts.source||"hole-switch")+"-surface-clear",switchToken);
		      else document.body.classList.add("gdGpsHoleTransitioning","gdGpsFramePreparing","gdGpsLiveMapSuppressed");
		    });
		    hole=forceHolePreLock(hole,h,par,opts.source||"hole-switch")||hole;
		    // Hole Frame navigation deliberately avoids the old broad normal-hole cleanup/re-entry path.
		    if(typeof window.gdFocusMappedPreLockHole!=="function")safe(function(){if(typeof setHole==="function")setHole(par!==null?{hole:h,par:par}:{hole:h});});
	    safe(function(){if(typeof setState==="function")setState("Hole "+h);});
	    safe(function(){if(typeof renderScorecard==="function")renderScorecard();});
		    safe(function(){if(typeof window.gdSyncPlayFlowRail==="function")window.gdSyncPlayFlowRail();});
		    safe(function(){if(typeof map!=="undefined"&&map&&map.invalidateSize)setTimeout(function(){map.invalidateSize();},40);});
		    setTimeout(function(){if(window.__gdHoleFrameSwitchToken===switchToken)try{window.__gdHoleFrameSwitching=false;}catch(e){}},180);
		    safe(function(){renderActiveHole(hole,{source:opts.source||"hole-rail",switchToken:switchToken,surfaceAlreadyClear:true});});
		    showHoleSwitchStartPrompt(h,opts.source||"hole-rail");
		    [120,360,860].forEach(function(delay){
		      setTimeout(function(){
		        if(window.__gdHoleFrameSwitchToken===switchToken&&activeHole()===h)showHoleSwitchStartPrompt(h,(opts.source||"hole-rail")+"-settle");
		      },delay);
		    });
	    safe(function(){if(typeof toast==="function")toast("Hole "+h+" selected");});
    setTimeout(syncRailButton,80);
    setTimeout(syncRailButton,520);
    return false;
  }
  window.gdSetActiveHoleFrame=setActiveHole;
  window.gdRenderActiveHoleFrame=renderActiveHole;
  window.gdMarkActiveHoleLocked=gdMarkActiveHoleLocked;
  function playHole(h,opts){
    opts=opts||{};
    nextPromptLatch=null;
    nextPromptLostAt=0;
    chooserOpen=false;
    return setActiveHole(h,Object.assign({},opts,{source:opts.source||"play-hole"}));
  }
  function holeStepper(){
    var el=document.getElementById("gdHoleStepper");
    if(!el){
      el=document.createElement("div");
      el.id="gdHoleStepper";
      el.className="gdHoleStepper hidden";
      el.innerHTML='<button type="button" data-gd-hole-step="1" title="Next hole" aria-label="Next hole">›</button><button type="button" data-gd-hole-picker="1" title="Choose hole" aria-label="Choose hole"><strong>H1</strong></button><button type="button" data-gd-hole-step="-1" title="Previous hole" aria-label="Previous hole">‹</button>';
      document.body.appendChild(el);
      el.addEventListener("click",function(event){
        var picker=event.target&&event.target.closest&&event.target.closest("button[data-gd-hole-picker]");
        if(picker){
          blockEvent(event);
          return toggleHoleChooser();
        }
        var btn=event.target&&event.target.closest&&event.target.closest("button[data-gd-hole-step]");
        if(!btn)return;
        blockEvent(event);
        var delta=Number(btn.dataset.gdHoleStep)||0;
        return stepHole(delta);
      },true);
    }
    return el;
  }
  function stepHole(delta){
    var current=activeHole();
    var count=holeCount();
    var next=Math.max(1,Math.min(count,current+Number(delta||0)));
    if(next===current)return false;
    closeHoleChooser();
    return playHole(next,{source:delta>0?"top-hole-next":"top-hole-prev"});
  }
  function syncHoleStepper(){
    var el=holeStepper();
    if(!el)return;
    var hide=!isGpsOpen()||coursePickerOpen()||!hasPlayingHole();
    el.classList.toggle("hidden",hide);
    if(hide)return;
    var current=activeHole();
    var count=holeCount();
    var label=el.querySelector("strong");
    var prev=el.querySelector('button[data-gd-hole-step="-1"]');
    var next=el.querySelector('button[data-gd-hole-step="1"]');
    if(label)label.textContent="H"+current;
    if(prev)prev.disabled=current<=1;
    if(next)next.disabled=current>=count;
  }
  function greenDistanceM(){
    return safe(function(){
      if(!start||!greenCentre||typeof map==="undefined"||!map)return null;
      var d=map.distance(start,greenCentre);
      return Number.isFinite(d)?d:null;
    },null);
  }
  function nearGreenNow(){
    var h=activeHole();
    if(safe(function(){return validHole(pendingScoreHole)===h},false))return true;
    var d=greenDistanceM();
    return Number.isFinite(d)&&d<=NEAR_GREEN_M;
  }
  function clearNextPrompt(suppressHole){
    var h=validHole(suppressHole);
    nextPromptLatch=null;
    nextPromptLostAt=0;
    if(h)nextPromptSuppressedHole=h;
  }
  function nextPromptTarget(){
    var current=activeHole();
    var next=nextHole(current);
    if(nextPromptSuppressedHole&&nextPromptSuppressedHole!==current)nextPromptSuppressedHole=null;
    if(next<=current){
      clearNextPrompt(null);
      return {ready:false,current:current,next:next};
    }
    var near=nearGreenNow();
    if(near){
      nextPromptSuppressedHole=null;
      nextPromptLostAt=0;
      nextPromptLatch={hole:current,next:next,at:Date.now()};
    }else if(nextPromptLatch&&nextPromptLatch.hole===current){
      var d=greenDistanceM();
      var clearlyLeft=!Number.isFinite(d)||d>=CLEAR_GREEN_M||safe(function(){return !target&&!greenCentre},false);
      if(clearlyLeft){
        if(!nextPromptLostAt)nextPromptLostAt=Date.now();
        if(Date.now()-nextPromptLostAt>=LOST_CLEAR_MS)clearNextPrompt(current);
      }else{
        nextPromptLostAt=0;
      }
    }
    var latched=nextPromptLatch&&nextPromptLatch.hole===current&&nextPromptLatch.next===next&&nextPromptSuppressedHole!==current;
    return {ready:!!latched,current:current,next:next};
  }
  function syncScoreSaveLabel(){
    var btn=document.querySelector(".gdScoreSave");
    if(!btn)return;
    var next=validHole(queuedNextHole);
    btn.classList.toggle("gdScoreSaveQueued",!!next);
    btn.textContent=next?"Save and H"+next:"Save score";
  }
  function queueScoreThenNext(){
    var current=activeHole();
    var next=nextHole(current);
    if(next>current)nextPromptLatch={hole:current,next:next,at:Date.now()};
    queuedNextHole=next>current?next:null;
    safe(function(){if(window.GDGpsScorecard&&typeof window.GDGpsScorecard.queueNextHole==="function")window.GDGpsScorecard.queueNextHole(queuedNextHole);});
    openScorecardOnHole(current);
    syncScoreSaveLabel();
    safe(function(){if(typeof toast==="function")toast(queuedNextHole?"Save score to play H"+queuedNextHole:"Scorecard ready");});
  }
  function railButton(){
    return document.getElementById("scorecardRailBtn");
  }
  function nextHolePopout(){
    var el=document.getElementById("gdNextHolePopout");
    if(!el){
      el=document.createElement("div");
      el.id="gdNextHolePopout";
      el.className="gdNextHolePopout hidden";
      el.setAttribute("role","group");
      el.setAttribute("aria-label","Hole navigation");
      el.innerHTML='<button class="gdHoleNavStep" type="button" data-gd-hole-delta="-1" title="Previous hole" aria-label="Previous hole">&#8249;</button><button class="gdHoleNavNumber" type="button" data-gd-hole-picker-trigger title="Long press to pick hole" aria-label="Current hole"><span>Hole</span><strong>H1</strong></button><button class="gdHoleNavStep" type="button" data-gd-hole-delta="1" title="Next hole" aria-label="Next hole">&#8250;</button>';
      document.body.appendChild(el);
    }
    return el;
  }
  function holeChooserTray(){
    var el=document.getElementById("gdHoleSelectTray");
    if(!el){
      el=document.createElement("div");
      el.id="gdHoleSelectTray";
      el.className="gdHoleSelectTray hidden";
      el.innerHTML='<div class="gdHoleSelectHead"><span>Hole selector</span><strong>GPS</strong></div><div class="gdHoleSelectStrip"></div>';
      document.body.appendChild(el);
    }
    return el;
  }
  function positionChooserTray(el,btn){
    if(!el)return;
    el.style.left="";
    el.style.top="";
    el.style.right="";
    el.style.width="";
  }
  function renderHoleChooserTray(choice){
    var el=holeChooserTray();
    var active=activeHole();
    var selected=validHole(choice)||active;
    var head=el.querySelector(".gdHoleSelectHead strong");
    var strip=el.querySelector(".gdHoleSelectStrip");
    if(head)head.textContent="GPS H"+active;
    if(!strip)return el;
    strip.innerHTML="";
    for(var h=1;h<=holeCount();h++){
      var btn=document.createElement("button");
      btn.type="button";
      btn.textContent=String(h);
      btn.className=(h===selected?"active ":"")+(h===active?"playing":"");
      btn.setAttribute("aria-label","Play hole "+h);
      btn.onclick=function(event){
        blockEvent(event);
        var next=validHole(this.textContent)||activeHole();
        chooserOpen=false;
        return playHole(next,{source:"hole-selector-tray"});
      };
      strip.appendChild(btn);
    }
    return el;
  }
	  function closeHoleChooser(){
	    chooserOpen=false;
	    var el=document.getElementById("gdHoleSelectTray");
	    if(el)el.classList.add("hidden");
	  }
  function positionPopout(el,btn){
    if(!el)return;
    el.style.left="";
    el.style.top="";
    el.style.right="";
    el.style.bottom="";
  }
  function syncShotHoleChip(){
    var chip=document.getElementById("gdShotHoleChip");
    if(!chip)return;
    var current=activeHole();
    chip.textContent="H"+current;
    chip.title="Long press to pick hole";
    chip.setAttribute("aria-label","Current hole H"+current+". Long press to pick hole.");
  }
	  function openHoleChooser(choice,source){
	    if(!isGpsOpen()||coursePickerOpen()||!hasPlayingHole())return false;
	    chooserOpen=true;
	    pointerState=null;
	    lastRailActionAt=Date.now();
    renderHoleChooserTray(validHole(choice)||activeHole());
    var tray=holeChooserTray();
    tray.classList.remove("hidden");
    positionChooserTray(tray,nextHolePopout());
	    syncRailButton();
	    return false;
	  }
	  function toggleHoleChooser(choice,source){
	    if(chooserOpen){
	      closeHoleChooser();
	      syncRailButton();
	      return false;
	    }
	    return openHoleChooser(validHole(choice)||activeHole(),source||"top-hole-stepper");
	  }
  function coursePickerOpen(){
    var screen=document.getElementById("courseScreen");
    if(!screen||screen.classList.contains("hidden"))return false;
    var cs=getComputedStyle(screen);
    return cs.display!=="none"&&cs.visibility!=="hidden";
  }
  function isGpsOpen(){
    return !!(
      document.body.classList.contains("shell-gps")||
      document.body.classList.contains("gdGpsActive")||
      document.body.classList.contains("gps-active")
    )&&!document.body.classList.contains("shell-home")&&!document.body.classList.contains("shell-module");
  }
  function hasPlayingHole(){
    return !!(
      safe(function(){return validHole(currentPlayingHole)},null)||
      safe(function(){return validHole(sessionStorage.getItem("gd_active_playing_hole"))},null)
    );
  }
  function syncRailButton(){
    var btn=railButton();
    var pop=nextHolePopout();
    var tray=holeChooserTray();
    if(!isGpsOpen()||coursePickerOpen()||!hasPlayingHole()){
      if(btn){
        btn.classList.remove("gdNextHoleReady","gdHoleChooser");
        btn.removeAttribute("data-gd-next-hole");
        btn.title="Scorecard";
        btn.setAttribute("aria-label","Scorecard");
      }
      if(pop)pop.classList.add("hidden");
      if(tray)tray.classList.add("hidden");
      syncHoleStepper();
      syncShotHoleChip();
      chooserOpen=false;
      pointerState=null;
      return;
    }
    var current=activeHole();
    var count=holeCount();
    var open=scorecardOpen();
    if(btn){
      btn.classList.remove("gdNextHoleReady","gdHoleChooser");
      btn.removeAttribute("data-gd-next-hole");
      btn.title="Scorecard";
      btn.setAttribute("aria-label","Scorecard");
    }
    if(pop){
      var show=!open;
      pop.classList.toggle("hidden",!show);
      pop.classList.toggle("chooser",chooserOpen);
      var prevBtn=pop.querySelector('[data-gd-hole-delta="-1"]');
      var nextBtn=pop.querySelector('[data-gd-hole-delta="1"]');
      var numBtn=pop.querySelector("[data-gd-hole-picker-trigger]");
      if(prevBtn)prevBtn.disabled=current<=1;
      if(nextBtn)nextBtn.disabled=current>=count;
      if(numBtn){
        var label=numBtn.querySelector("strong");
        if(label)label.textContent="H"+current;
        numBtn.title="Long press to pick hole";
        numBtn.setAttribute("aria-label","Current hole H"+current+". Long press to pick hole.");
      }
      pop.setAttribute("aria-label","Hole navigation. Hole "+current+" of "+count);
      if(show)positionPopout(pop,btn);
    }
    if(tray){
      var showTray=chooserOpen;
      tray.classList.toggle("hidden",!showTray);
      if(showTray){
        renderHoleChooserTray(current);
        positionChooserTray(tray,pop);
      }
    }
    syncHoleStepper();
    syncShotHoleChip();
  }
  function openNormalScorecard(){
    closeHoleChooser();
    safe(function(){sessionStorage.setItem("gd_return_from_scorecard","gps");});
    safe(function(){if(typeof openScorecard==="function")openScorecard();});
    setTimeout(syncScoreSaveLabel,100);
  }
  function blockEvent(event){
    event.preventDefault();
    event.stopPropagation();
    if(event.stopImmediatePropagation)event.stopImmediatePropagation();
  }
  function isScoreFlowEvent(event){
    return !!(event&&event.target&&event.target.closest&&event.target.closest("#gdNextHolePopout,#gdHoleSelectTray,#gdShotHoleChip"));
  }
  function finishQuickTap(source){
    if(scorecardOpen()){
      returnGpsMap();
      return false;
    }
    if(source&&source.closest&&source.closest("#scorecardRailBtn")&&!source.closest("#gdNextHolePopout")){
      closeHoleChooser();
      openNormalScorecard();
      return false;
    }
    var prompt=nextPromptTarget();
    var current=prompt.current;
    var next=prompt.next;
    if(next>current)return playHole(next,{source:"rail-quick-next"});
    openNormalScorecard();
    return false;
  }
  function finishChoice(choice){
    var h=validHole(choice)||nextHole(activeHole());
    return playHole(h,{source:"rail-swipe-choice"});
  }
  function bindHolePickerLongPress(el,source){
    if(!el||el.__gdHolePickerLongPress)return;
    el.__gdHolePickerLongPress=true;
    var timer=null;
    var opened=false;
    var startX=0;
    var startY=0;
    function clearTimer(){
      if(timer){clearTimeout(timer);timer=null;}
    }
    el.addEventListener("pointerdown",function(event){
      blockEvent(event);
      opened=false;
      startX=event.clientX||0;
      startY=event.clientY||0;
      clearTimer();
      timer=setTimeout(function(){
        timer=null;
        opened=true;
        el.dataset.gdPickerOpened="1";
        openHoleChooser(activeHole(),source);
      },LONG_PRESS_MS);
      safe(function(){el.setPointerCapture(event.pointerId);});
    },true);
    el.addEventListener("pointermove",function(event){
      if(!timer)return;
      var dx=Math.abs((event.clientX||0)-startX);
      var dy=Math.abs((event.clientY||0)-startY);
      if(dx>12||dy>12)clearTimer();
    },true);
    el.addEventListener("pointerup",function(event){
      blockEvent(event);
      clearTimer();
      safe(function(){el.releasePointerCapture(event.pointerId);});
      if(opened)setTimeout(function(){delete el.dataset.gdPickerOpened;},80);
      opened=false;
      return false;
    },true);
    el.addEventListener("pointercancel",function(event){
      blockEvent(event);
      clearTimer();
      opened=false;
    },true);
    el.addEventListener("click",function(event){
      blockEvent(event);
      if(el.dataset.gdPickerOpened)delete el.dataset.gdPickerOpened;
      return false;
    },true);
  }
  function bindHoleNavCard(){
    var el=nextHolePopout();
    if(!el||el.__gdHoleNavBound)return;
    el.__gdHoleNavBound=true;
    el.addEventListener("click",function(event){
      var step=event.target&&event.target.closest&&event.target.closest("[data-gd-hole-delta]");
      if(step){
        blockEvent(event);
        var delta=Number(step.dataset.gdHoleDelta)||0;
        return stepHole(delta);
      }
    },true);
    bindHolePickerLongPress(el.querySelector("[data-gd-hole-picker-trigger]"),"nav-card");
  }
  function bindGestureTarget(el){
    if(!el||el.__gdPlayFlowGestures)return;
    el.__gdPlayFlowGestures=true;
    el.onclick=function(ev){blockEvent(ev);if(Date.now()-lastRailActionAt>360)finishQuickTap(ev.target);return false;};
    el.addEventListener("pointerdown",function(event){
      blockEvent(event);
      var base=nextHole(activeHole());
      pointerState={x:event.clientX||0,y:event.clientY||0,choice:base,choosing:false,long:false,draggingChoice:false,timer:null};
      pointerState.timer=setTimeout(function(){
        if(!pointerState)return;
        pointerState.long=true;
        pointerState.choosing=true;
        chooserOpen=true;
        lastRailActionAt=Date.now();
        syncRailButton();
      },LONG_PRESS_MS);
      safe(function(){el.setPointerCapture(event.pointerId);});
    },true);
    el.addEventListener("pointermove",function(event){
      if(!pointerState)return;
      blockEvent(event);
      var dx=(event.clientX||0)-pointerState.x;
      var dy=(event.clientY||0)-pointerState.y;
      if(Math.abs(dy)>18&&Math.abs(dy)>Math.abs(dx)){
        if(pointerState.timer){clearTimeout(pointerState.timer);pointerState.timer=null;}
        pointerState.choosing=true;
        pointerState.draggingChoice=true;
        var step=Math.round(-dy/SWIPE_STEP_PX);
        pointerState.choice=Math.max(1,Math.min(holeCount(),nextHole(activeHole())+step));
        syncRailButton();
      }
    },true);
    el.addEventListener("pointerup",function(event){
      if(!pointerState)return;
      blockEvent(event);
      var state=pointerState;
      pointerState=null;
      if(state.timer)clearTimeout(state.timer);
      lastRailActionAt=Date.now();
      syncRailButton();
      if(state.choosing&&(!state.long||state.draggingChoice))return finishChoice(state.choice);
      if(state.long){
        chooserOpen=true;
        syncRailButton();
        return false;
      }
      return finishQuickTap(event.target);
    },true);
    el.addEventListener("pointercancel",function(event){
      if(!pointerState)return;
      blockEvent(event);
      if(pointerState.timer)clearTimeout(pointerState.timer);
      pointerState=null;
      syncRailButton();
    },true);
  }
  function installRailGestures(){
    bindHoleNavCard();
    bindHolePickerLongPress(document.getElementById("gdShotHoleChip"),"shot-card");
  }
  function installDocumentGuards(){
    if(document.__gdPlayFlowScoreGuards)return;
    document.__gdPlayFlowScoreGuards=true;
    document.addEventListener("click",function(event){
      if(!chooserOpen||!event||!event.target||!event.target.closest)return;
      if(event.target.closest("#gdHoleSelectTray,#gdNextHolePopout,#gdShotHoleChip"))return;
      closeHoleChooser();
      syncRailButton();
    },true);
  }
  function wrapPromptClearer(name){
    var old=window[name]||safe(function(){return eval(name)},null);
    if(typeof old!=="function"||old.__gdPlayFlowClearWrapped)return;
    var wrapped=function(){
      var h=activeHole();
      var res=old.apply(this,arguments);
      clearNextPrompt(h);
      setTimeout(syncRailButton,40);
      setTimeout(syncRailButton,400);
      return res;
    };
    wrapped.__gdPlayFlowClearWrapped=true;
    window[name]=wrapped;
    safe(function(){eval(name+"=wrapped");});
  }
  function install(){
    installRailGestures();
    installDocumentGuards();
    wrapPromptClearer("gdClearShotForNextStart");
    wrapPromptClearer("resetPlay");
    wrapPromptClearer("clearAllLayers");
    syncScoreSaveLabel();
    syncRailButton();
    syncHoleStepper();
  }
  window.gdPlayHoleFromScorecard=playHole;
  window.gdPlayNextHole=function(){return playHole(nextHole(activeHole()),{source:"api-next-hole"});};
  window.gdPlayPreviousHole=function(){return playHole(previousHole(activeHole()),{source:"api-previous-hole"});};
  window.gdQueueScoreThenNext=queueScoreThenNext;
  window.gdSyncPlayFlowRail=syncRailButton;
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",install);
  else install();
  setTimeout(install,120);
  setTimeout(install,600);
  setInterval(syncRailButton,1200);
  setInterval(syncHoleStepper,1200);
})();

/* ==== section: gd-gps-mapped-entry-guard-v1.js ==== */
/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  "use strict";
  window.gdGpsMappedEntryGuardIsolated=true;
  window.gdGpsMappedEntryGuardRemoved=true;
})();
