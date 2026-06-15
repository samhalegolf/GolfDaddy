(function(){
  "use strict";
  var FORCE_KEY="gd_green_focus_force_next_hole_v1";
  var FLAG_TTL=9000;

  function safe(fn,fallback){try{return fn()}catch(e){console.warn("[Clarity shot-end guard]",e);return fallback}}
  function now(){return Date.now()}
  function validHole(value){var h=Number(value);return Number.isFinite(h)&&h>=1&&h<=36?Math.round(h):null}
  function holeCount(){return safe(function(){return Array.isArray(scorecard&&scorecard.holes)&&scorecard.holes.length?scorecard.holes.length:18},18)||18}
  function activeHole(){
    return validHole(safe(function(){return currentPlayingHole},null))
      || validHole(safe(function(){return sessionStorage.getItem("gd_active_playing_hole")},null))
      || validHole(safe(function(){return selectedHole},null))
      || validHole(safe(function(){return (document.querySelector("#gdHoleStepper strong")||{}).textContent&&String(document.querySelector("#gdHoleStepper strong").textContent).replace(/[^0-9]/g,"")},null))
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
  function clearForceSoon(){setTimeout(function(){sessionStorage.removeItem(FORCE_KEY)},FLAG_TTL+350)}

  function installHoleOneGuard(){
    var old=window.gdShouldSkipMappedHoleOneReset||safe(function(){return gdShouldSkipMappedHoleOneReset},null);
    if(typeof old==="function"&&old.__gdGreenFocusGuardWrapped)return;
    var wrapped=function(){
      if(readForce())return true;
      return typeof old==="function"?old.apply(this,arguments):false;
    };
    wrapped.__gdGreenFocusGuardWrapped=true;
    window.gdShouldSkipMappedHoleOneReset=wrapped;
    safe(function(){gdShouldSkipMappedHoleOneReset=wrapped});
  }

  function removeLayer(layer){safe(function(){if(layer&&typeof map!=="undefined"&&map&&map.removeLayer)map.removeLayer(layer)})}
  function clearShotState(){
    safe(function(){window.gdPendingManualShotVerification=false});
    safe(function(){if(typeof window.gdCancelMappedAsyncWork==="function")window.gdCancelMappedAsyncWork("green-focus-shot-end")});
    safe(function(){if(typeof clearReplaceGreenMode==="function")clearReplaceGreenMode()});
    safe(function(){if(typeof unlockFrameForReset==="function")unlockFrameForReset();else if(typeof setBubbleOnlyLock==="function")setBubbleOnlyLock(false)});
    safe(function(){if(typeof clearShot==="function")clearShot()});
    [
      "startMarker","targetMarker","greenMarker","pinMarker","pinDirectionLine","greenOutline","greenSoft",
      "greenLabel","frontLabel","backLabel","remainingGreenLine","remainingGreenLabel","middleGuideLine",
      "middleGuideLabel","pinLine","pinLabel","bubbleOuter","bubbleMain","bubbleCore","bubbleMiss",
      "bubbleShadow","bubbleShade","bubbleCarryLine"
    ].forEach(function(name){removeLayer(safe(function(){return window[name]||eval(name)},null))});
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
      mode="start";
      undoStack=[];
    });
    safe(function(){document.body.classList.remove("gd-replacing-green-centre","gd-frame-hard-locked","gdFullMappingMode")});
    safe(function(){var appEl=(typeof app!=="undefined"&&app)||document.getElementById("app");if(appEl)appEl.classList.remove("framed","gdPreLockFrame")});
    safe(function(){var tile=document.getElementById("shotTile");if(tile)tile.classList.remove("visible")});
    safe(function(){if(typeof setMapGestures==="function")setMapGestures(true)});
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
    var force=readForce();
    if(!force)return false;
    clearShotState();
    showFreshPreLock(force.hole);
    return true;
  }
  function scheduleEnforce(){[0,60,180,420,900,1600,2600,4200,6500].forEach(function(delay){setTimeout(enforceForcedHole,delay)})}

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
    var h=nextHole();
    var point=resultPoint();
    setForce(h);
    safe(function(){if(typeof gdCaptureCurrentPlannedShot==="function")gdCaptureCurrentPlannedShot("green-focus-shot-end")});
    safe(function(){
      if(point&&typeof gdLogBallPositionForTracking==="function"){
        var accuracy=window.gdGpsState&&window.gdGpsState.lastFix?window.gdGpsState.lastFix.accuracy:null;
        gdLogBallPositionForTracking(point,"green_focus_shot_end",accuracy);
      }
    });
    safe(function(){if(typeof toast==="function")toast("Shot logged · H"+h)});
    scheduleEnforce();
    clearForceSoon();
    return false;
  }

  function ensureButton(){
    var btn=document.getElementById("gdGreenFocusShotEndBtn");
    if(!btn){
      btn=document.createElement("button");
      btn.id="gdGreenFocusShotEndBtn";
      btn.type="button";
      btn.textContent="Shot End";
      btn.setAttribute("aria-label","End shot and move to next hole");
      document.body.appendChild(btn);
    }
    btn.onclick=function(event){
      if(event){event.preventDefault();event.stopPropagation();if(event.stopImmediatePropagation)event.stopImmediatePropagation()}
      return shotEnd();
    };
    return btn;
  }
  function installStyles(){
    if(document.getElementById("gdGreenFocusShotEndGuardCss"))return;
    var style=document.createElement("style");
    style.id="gdGreenFocusShotEndGuardCss";
    style.textContent="#gdGreenFocusShotEndBtn{position:fixed;right:14px;bottom:calc(150px + env(safe-area-inset-bottom));z-index:2600;display:none;min-width:92px;min-height:44px;border:1px solid rgba(55,242,141,.34);border-radius:999px;background:linear-gradient(180deg,rgba(55,242,141,.96),rgba(24,176,96,.96));color:#06110b;font:950 12px/1 Inter,system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;box-shadow:0 16px 36px rgba(0,0,0,.34),inset 0 1px 0 rgba(255,255,255,.20);cursor:pointer}#gdGreenFocusShotEndBtn.visible{display:block;visibility:visible;pointer-events:auto}body:not(.shell-gps) #gdGreenFocusShotEndBtn,body.shell-home #gdGreenFocusShotEndBtn,body.shell-module #gdGreenFocusShotEndBtn{display:none!important}";
    document.head.appendChild(style);
  }
  function syncButton(){
    var btn=ensureButton();
    var gps=document.body.classList.contains("shell-gps")||document.body.classList.contains("gdGpsActive")||document.body.classList.contains("gps-active");
    var locked=safe(function(){return !!lockedFrame&&!!start&&!!target},false);
    btn.classList.toggle("visible",gps&&locked);
  }
  function install(){
    installHoleOneGuard();
    installStyles();
    window.gdEndGreenFocusShot=shotEnd;
    ensureButton();
    syncButton();
    enforceForcedHole();
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",install);else install();
  setTimeout(install,120);
  setTimeout(install,600);
  setInterval(function(){installHoleOneGuard();syncButton();},700);
})();
