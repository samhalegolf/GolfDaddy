(function(){
  "use strict";

  var FORCE_KEY="gd_green_focus_force_next_hole_v1";
  var FLAG_TTL=10000;
  var ENFORCE_DELAYS=[0,50,120,220,420,750,1100,1700,2600,4200,6500,9000];
  var WRAPPED_KEY="__gdGreenFocusShotEndGuardWrapped";
  var lastNativeShotEndAt=0;

  function safe(fn,fallback){try{return fn()}catch(e){console.warn("[Clarity shot-end guard]",e);return fallback}}
  function now(){return Date.now()}
  function validHole(value){var h=Number(value);return Number.isFinite(h)&&h>=1&&h<=36?Math.round(h):null}
  function holeCount(){return safe(function(){return Array.isArray(scorecard&&scorecard.holes)&&scorecard.holes.length?scorecard.holes.length:18},18)||18}
  function textOf(node){return String((node&&node.textContent)||"").replace(/\s+/g," ").trim()}
  function isGps(){return document.body.classList.contains("shell-gps")||document.body.classList.contains("gdGpsActive")||document.body.classList.contains("gps-active")}
  function isLocked(){return safe(function(){return !!lockedFrame&&!!start&&!!target},false)}

  function activeHole(){
    return validHole(safe(function(){return currentPlayingHole},null))
      || validHole(safe(function(){return sessionStorage.getItem("gd_active_playing_hole")},null))
      || validHole(safe(function(){return sessionStorage.getItem("gd_mapper_active_hole")},null))
      || validHole(safe(function(){return selectedHole},null))
      || validHole(safe(function(){var el=document.querySelector("#gdHoleStepper strong,#gdHoleStepper .holeNum,.gd-hole-stepper strong");return el&&textOf(el).replace(/[^0-9]/g,"")},null))
      || 1;
  }
  function nextHole(){return Math.min(holeCount(),activeHole()+1)}
  function parForHole(h){
    return safe(function(){
      var row=scorecard&&scorecard.holes&&scorecard.holes[h-1];
      var view=typeof gdScorecardHoleView==="function"?gdScorecardHoleView(row):row;
      var par=typeof gdScorecardKnownNumber==="function"?gdScorecardKnownNumber(view&&view.par):Number(view&&view.par);
      return Number.isFinite(par)?par:null;
    },null);
  }

  function readForce(){
    return safe(function(){
      var raw=JSON.parse(sessionStorage.getItem(FORCE_KEY)||"null");
      if(!raw||!validHole(raw.hole)||now()-Number(raw.at||0)>FLAG_TTL){sessionStorage.removeItem(FORCE_KEY);return null}
      return raw;
    },null);
  }
  function setForce(h){sessionStorage.setItem(FORCE_KEY,JSON.stringify({hole:validHole(h)||nextHole(),at:now()}))}
  function clearForceSoon(){setTimeout(function(){sessionStorage.removeItem(FORCE_KEY)},FLAG_TTL+750)}
  function forcedHole(){var force=readForce();return force&&validHole(force.hole)}

  function globalValue(name){return safe(function(){return window[name]||eval(name)},null)}
  function assignGlobal(name,value){safe(function(){window[name]=value});safe(function(){eval(name+"=value")})}

  function wrapFunction(name,replacement){
    var old=globalValue(name);
    if(typeof old!=="function"||old[WRAPPED_KEY])return;
    var wrapped=replacement(old);
    wrapped[WRAPPED_KEY]=true;
    wrapped.__gdOriginal=old;
    assignGlobal(name,wrapped);
  }

  function installHoleOneGuards(){
    wrapFunction("gdShouldSkipMappedHoleOneReset",function(old){
      return function(){
        if(readForce())return true;
        return old.apply(this,arguments);
      };
    });
    [
      "rescueForceHoleOne",
      "forceStableMappedHoleOne",
      "scheduleStableMappedHoleOne",
      "rescueScheduleHoleOne",
      "gdOpenCourseToFirstHole",
      "gdScheduleCoursePickerFirstHoleOpen"
    ].forEach(function(name){
      wrapFunction(name,function(old){
        return function(){
          if(readForce())return false;
          return old.apply(this,arguments);
        };
      });
    });
  }

  function installNativeNextGuards(){
    wrapFunction("gdPlayNextHole",function(old){
      return function(){
        if(isGps()&&isLocked())return shotEnd();
        return old.apply(this,arguments);
      };
    });
    wrapFunction("gdQueueScoreThenNext",function(old){
      return function(){
        if(isGps()&&isLocked())return shotEnd();
        return old.apply(this,arguments);
      };
    });
  }

  function removeLayer(layer){safe(function(){if(layer&&typeof map!=="undefined"&&map&&map.removeLayer)map.removeLayer(layer)})}
  function clearShotState(){
    safe(function(){window.gdPendingManualShotVerification=false});
    safe(function(){if(typeof window.gdCancelMappedAsyncWork==="function")window.gdCancelMappedAsyncWork("green-focus-shot-end")});
    safe(function(){if(typeof clearReplaceGreenMode==="function")clearReplaceGreenMode()});
    safe(function(){if(typeof unlockFrameForReset==="function")unlockFrameForReset();else if(typeof setBubbleOnlyLock==="function")setBubbleOnlyLock(false)});
    safe(function(){if(typeof clearShot==="function")clearShot()});
    safe(function(){if(typeof clearAllLayers==="function")clearAllLayers()});
    [
      "startMarker","targetMarker","greenMarker","pinMarker","pinDirectionLine","greenOutline","greenSoft",
      "greenLabel","frontLabel","backLabel","remainingGreenLine","remainingGreenLabel","middleGuideLine",
      "middleGuideLabel","pinLine","pinLabel","bubbleOuter","bubbleMain","bubbleCore","bubbleMiss",
      "bubbleShadow","bubbleShade","bubbleCarryLine"
    ].forEach(function(name){removeLayer(globalValue(name))});
    safe(function(){
      startMarker=targetMarker=greenMarker=pinMarker=pinDirectionLine=greenOutline=greenSoft=greenLabel=frontLabel=backLabel=null;
      remainingGreenLine=remainingGreenLabel=middleGuideLine=middleGuideLabel=pinLine=pinLabel=null;
      bubbleOuter=bubbleMain=bubbleCore=bubbleMiss=bubbleShadow=bubbleShade=bubbleCarryLine=null;
      start=target=greenCentre=pin=null;
      greenPolygon=null;
      gdWindLandingTarget=null;
      lockedFrame=false;
      targetWasMoved=false;
      currentShotLogged=false;
      gdCurrentPlannedShotId=null;
      targetDragging=false;
      placingPin=false;
      mode="start";
      undoStack=[];
    });
    safe(function(){document.body.classList.remove("gd-replacing-green-centre","gd-frame-hard-locked","gdFullMappingMode")});
    safe(function(){var appEl=(typeof app!=="undefined"&&app)||document.getElementById("app");if(appEl)appEl.classList.remove("framed","gdPreLockFrame")});
    safe(function(){var tile=document.getElementById("shotTile");if(tile)tile.classList.remove("visible")});
    safe(function(){var oldBtn=document.getElementById("gdGreenFocusShotEndBtn");if(oldBtn)oldBtn.remove()});
    safe(function(){var oldCss=document.getElementById("gdGreenFocusShotEndGuardCss");if(oldCss)oldCss.remove()});
    safe(function(){if(typeof setMapGestures==="function")setMapGestures(true)});
    safe(function(){if(typeof gdSyncNewShotButtonState==="function")gdSyncNewShotButtonState()});
  }

  function rememberHole(h){
    h=validHole(h)||1;
    safe(function(){if(typeof window.gdRememberPlayingHole==="function")window.gdRememberPlayingHole(h)});
    safe(function(){currentPlayingHole=h});
    safe(function(){selectedHole=h});
    safe(function(){window.gdMapperActiveHole=h});
    safe(function(){sessionStorage.setItem("gd_active_playing_hole",String(h));sessionStorage.setItem("gd_mapper_active_hole",String(h))});
    return h;
  }

  function showFreshPreLock(h){
    h=rememberHole(h);
    var par=parForHole(h);
    safe(function(){if(typeof setHole==="function")setHole(par!==null?{hole:h,par:par}:{hole:h})});
    safe(function(){if(typeof setState==="function")setState("Hole "+h)});
    safe(function(){document.querySelectorAll(".panel.open,.modulePanel.open").forEach(function(p){p.classList.remove("open")})});
    safe(function(){var cs=document.getElementById("courseScreen");if(cs)cs.classList.add("hidden")});
    safe(function(){document.body.classList.add("shell-gps","gdGpsActive","gps-active");document.body.classList.remove("shell-home","shell-module")});
    safe(function(){if(typeof gdFocusScorecardHoleOnGps==="function")gdFocusScorecardHoleOnGps(h,par)});
    safe(function(){
      var hint=document.getElementById("hint");
      if(hint){
        hint.classList.add("visible");
        if(typeof gdRenderMappedStartHint==="function")gdRenderMappedStartHint(hint);
        else hint.textContent="Set start point";
      }
    });
    safe(function(){if(typeof gdQueueMappedPreLockHoleFrame==="function")gdQueueMappedPreLockHoleFrame()});
    safe(function(){if(typeof gdV62Refresh==="function")gdV62Refresh()});
    safe(function(){if(typeof gdSyncPlayFlowRail==="function")gdSyncPlayFlowRail()});
  }

  function enforceForcedHole(){
    var h=forcedHole();
    if(!h)return false;
    installHoleOneGuards();
    clearShotState();
    showFreshPreLock(h);
    return true;
  }
  function scheduleEnforce(){ENFORCE_DELAYS.forEach(function(delay){setTimeout(enforceForcedHole,delay)})}

  function resultPoint(){
    return safe(function(){
      if(window.gdGpsState&&window.gdGpsState.lastFix)return L.latLng(window.gdGpsState.lastFix.lat,window.gdGpsState.lastFix.lng);
      if(typeof pin!=="undefined"&&pin)return L.latLng(pin.lat,pin.lng);
      if(typeof greenCentre!=="undefined"&&greenCentre)return L.latLng(greenCentre.lat,greenCentre.lng);
      if(typeof target!=="undefined"&&target)return L.latLng(target.lat,target.lng);
      return null;
    },null);
  }

  function shotEnd(){
    var t=now();
    if(t-lastNativeShotEndAt<700)return false;
    lastNativeShotEndAt=t;
    var h=nextHole();
    var point=resultPoint();
    setForce(h);
    installHoleOneGuards();
    safe(function(){if(typeof gdCaptureCurrentPlannedShot==="function")gdCaptureCurrentPlannedShot("green-focus-shot-end")});
    safe(function(){
      if(point&&typeof gdLogBallPositionForTracking==="function"){
        var accuracy=window.gdGpsState&&window.gdGpsState.lastFix?window.gdGpsState.lastFix.accuracy:null;
        gdLogBallPositionForTracking(point,"green_focus_shot_end",accuracy);
      }
    });
    safe(function(){if(typeof toast==="function")toast("Shot logged · H"+h)});
    clearShotState();
    showFreshPreLock(h);
    scheduleEnforce();
    clearForceSoon();
    return false;
  }

  function nativeAdvanceCandidate(node){
    var next=nextHole();
    var el=node&&node.nodeType===1?node:node&&node.parentElement;
    for(var depth=0;el&&depth<8;depth++,el=el.parentElement){
      if(el===document.body||el===document.documentElement)break;
      if(el.id==="gdNextHolePopout"||el.id==="scorecardRailBtn")return el;
      var label=(textOf(el)+" "+String(el.getAttribute&&el.getAttribute("aria-label")||"")).toLowerCase();
      if(label.length>180)continue;
      if(label.indexOf("shot end")!==-1||label.indexOf("end shot")!==-1)return el;
      if(label.indexOf("next")!==-1&&label.indexOf("h"+next)!==-1)return el;
      if(label.indexOf("next hole")!==-1)return el;
    }
    return null;
  }

  function blockNativeEvent(event){
    event.preventDefault();
    event.stopPropagation();
    if(event.stopImmediatePropagation)event.stopImmediatePropagation();
  }

  function interceptNativeAdvance(event){
    if(!isGps()||!isLocked())return;
    var candidate=nativeAdvanceCandidate(event.target);
    if(!candidate)return;
    blockNativeEvent(event);
    if(event.type==="pointerdown"||event.type==="mousedown"||event.type==="touchstart"||event.type==="click"||event.type==="keydown")shotEnd();
  }

  function installEventCapture(){
    if(window.__gdGreenFocusShotEndCaptureInstalled)return;
    window.__gdGreenFocusShotEndCaptureInstalled=true;
    ["pointerdown","pointerup","click","mousedown","mouseup","touchstart","touchend"].forEach(function(type){
      document.addEventListener(type,interceptNativeAdvance,true);
    });
    document.addEventListener("keydown",function(event){
      if((event.key==="Enter"||event.key===" ")&&nativeAdvanceCandidate(event.target))interceptNativeAdvance(event);
    },true);
  }

  function install(){
    installHoleOneGuards();
    installNativeNextGuards();
    installEventCapture();
    window.gdEndGreenFocusShot=shotEnd;
    safe(function(){var oldBtn=document.getElementById("gdGreenFocusShotEndBtn");if(oldBtn)oldBtn.remove()});
    safe(function(){var oldCss=document.getElementById("gdGreenFocusShotEndGuardCss");if(oldCss)oldCss.remove()});
    enforceForcedHole();
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",install);else install();
  setTimeout(install,120);
  setTimeout(install,600);
  setTimeout(install,1500);
  setInterval(function(){installHoleOneGuards();installNativeNextGuards();},700);
})();
