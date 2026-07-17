/* GPS Play camera tilt: automatic flat whole-hole view, then delayed lock-state tilt. */
(function(){
  if(window.__gdGpsPlayCameraTiltV1)return;
  window.__gdGpsPlayCameraTiltV1=true;

  var AUTO_LOCK_TILT_DEG=32;
  var LOCK_TILT_DELAY_MS=0;
  var FLAT_TILT_DEG=0;
  var STORAGE_KEY="gd_gps_play_camera_tilt_deg_v1";
  var currentDeg=null;
  var syncRaf=0;
  var lockTiltTimer=0;
  var observer=null;

  function safe(fn,fb){try{return fn();}catch(e){return fb;}}
  function gpsActive(){
    return !!(document.body&&(
      document.body.classList.contains("shell-gps")||
      document.body.classList.contains("gdGpsActive")||
      document.body.classList.contains("gps-active")||
      document.body.dataset.clarityRoute==="gps"
    ));
  }
  function pickerOpen(){
    var screen=safe(function(){return document.getElementById("courseScreen");},null);
    return !!(document.body&&(
      document.body.classList.contains("shell-home")||
      document.body.classList.contains("gdCoursePickerOpen")||
      document.body.classList.contains("gdCourseOpening")||
      (screen&&!screen.classList.contains("hidden"))
    ));
  }
  function capturedSurfaceReady(){
    return !!(document.body&&
      document.body.classList.contains("gdCapturedHoleFrameCameraOn")&&
      document.querySelector("#gdHoleImageCameraLayer .gdHoleImageTiles"));
  }
  function lockedViewReady(){
    if(!gpsActive()||pickerOpen()||!capturedSurfaceReady())return false;
    if(document.body.classList.contains("gdMappedStartPromptActive"))return false;
    if(document.body.classList.contains("gdManualStartPlacementActive"))return false;
    if(document.body.classList.contains("gdGreenArrivalMode"))return false;
    if(document.body.classList.contains("gdLockStateFrameActive"))return true;
    if(document.body.classList.contains("gd-frame-hard-locked"))return true;
    return safe(function(){return !!(lockedFrame&&start&&target);},false);
  }
  function scaleFor(deg){
    deg=Number(deg)||0;
    return (1+Math.max(0,deg)/150).toFixed(3);
  }
  function removeTiltControls(){
    ["gdGpsPlayCameraTiltBtn","gdGpsCameraTiltRow"].forEach(function(id){
      var el=document.getElementById(id);
      if(el&&el.parentNode)el.parentNode.removeChild(el);
    });
  }
  function syncControls(){
    removeTiltControls();
  }
  function clearLockTiltTimer(){
    if(lockTiltTimer){clearTimeout(lockTiltTimer);lockTiltTimer=0;}
  }
  function applyTilt(deg,reason){
    deg=Number(deg)||0;
    deg=deg>0?AUTO_LOCK_TILT_DEG:FLAT_TILT_DEG;
    currentDeg=deg;
    if(document.documentElement){
      document.documentElement.style.setProperty("--gd-gps-play-camera-tilt-deg",String(deg)+"deg");
      document.documentElement.style.setProperty("--gd-gps-play-camera-tilt-scale",scaleFor(deg));
    }
    if(document.body){
      document.body.classList.add("gdGpsPlayCameraTiltAutoReady");
      document.body.classList.toggle("gdGpsPlayCameraTiltOn",deg>0);
      document.body.classList.toggle("gdGpsPlayCameraTiltFlat",deg<=0);
      document.body.dataset.gdGpsPlayCameraTiltDeg=String(deg);
      document.body.dataset.gdGpsPlayCameraTiltReason=String(reason||"auto");
    }
    syncControls(deg);
    return deg;
  }
  function syncAutoTilt(reason){
    var shouldTilt=lockedViewReady();
    if(!shouldTilt){
      clearLockTiltTimer();
      if(currentDeg!==FLAT_TILT_DEG)applyTilt(FLAT_TILT_DEG,reason||"unlock-flat");
      else {
        if(document.body){
          document.body.classList.add("gdGpsPlayCameraTiltAutoReady","gdGpsPlayCameraTiltFlat");
          document.body.classList.remove("gdGpsPlayCameraTiltOn");
          document.body.dataset.gdGpsPlayCameraTiltDeg=String(FLAT_TILT_DEG);
        }
        syncControls();
      }
      return FLAT_TILT_DEG;
    }
    if(currentDeg===AUTO_LOCK_TILT_DEG)return currentDeg;
    if(lockTiltTimer)return currentDeg==null?FLAT_TILT_DEG:currentDeg;
    if(LOCK_TILT_DELAY_MS<=0){
      clearLockTiltTimer();
      return applyTilt(AUTO_LOCK_TILT_DEG,reason||"lock-same-time");
    }
    lockTiltTimer=setTimeout(function(){
      lockTiltTimer=0;
      if(lockedViewReady())applyTilt(AUTO_LOCK_TILT_DEG,"lock-settled");
      else applyTilt(FLAT_TILT_DEG,"lock-cancelled");
    },LOCK_TILT_DELAY_MS);
    if(currentDeg!==FLAT_TILT_DEG)applyTilt(FLAT_TILT_DEG,reason||"lock-prep-flat");
    syncControls();
    return FLAT_TILT_DEG;
  }
  function scheduleSync(reason){
    if(syncRaf)return;
    syncRaf=requestAnimationFrame(function(){
      syncRaf=0;
      syncAutoTilt(reason||"scheduled");
    });
  }
  function handleControl(event){
    if(event){
      event.preventDefault();
      event.stopPropagation();
      if(event.stopImmediatePropagation)event.stopImmediatePropagation();
    }
    scheduleSync("control-sync");
    return false;
  }
  function ensureObserver(){
    if(observer||!document.body||typeof MutationObserver!=="function")return;
    observer=new MutationObserver(function(){scheduleSync("body-state");});
    observer.observe(document.body,{attributes:true,attributeFilter:["class","data-clarity-route"]});
  }
  function init(){
    safe(function(){localStorage.removeItem(STORAGE_KEY);});
    removeTiltControls();
    ensureObserver();
    applyTilt(FLAT_TILT_DEG,"init-flat");
    scheduleSync("init");
  }

  window.gdCycleGpsPlayCameraTilt=handleControl;
  window.gdSyncGpsPlayCameraTilt=function(reason){return syncAutoTilt(reason||"manual-sync");};
  window.gdSetGpsPlayCameraTilt=function(deg){clearLockTiltTimer();return applyTilt(Number(deg)>0?AUTO_LOCK_TILT_DEG:FLAT_TILT_DEG,"manual-set");};
  window.gdGetGpsPlayCameraTilt=function(){return currentDeg==null?FLAT_TILT_DEG:currentDeg;};
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});
  else init();
  [160,420,900,1600,2600].forEach(function(delay){setTimeout(function(){removeTiltControls();ensureObserver();scheduleSync("settle-"+delay);},delay);});
  ["click","pointerup","transitionend"].forEach(function(type){window.addEventListener(type,function(){scheduleSync(type);},true);});
})();
