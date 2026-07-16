/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  const CAL_KEY="gd_green_wand_robust_calibration_v2_known_good";
  let liveCalibrationDirty=false;

  function courseKey(){
    try{
      const c=window.currentCourse || currentCourse;
      return (c && c.name) ? String(c.name) : "Manual GPS";
    }catch(e){return "Manual GPS";}
  }
  function readAll(){try{return JSON.parse(localStorage.getItem(CAL_KEY)||"{}") || {};}catch(e){return {};}}
  function writeAll(v){try{localStorage.setItem(CAL_KEY, JSON.stringify(v||{}));}catch(e){}}

  window.gdReadGreenWandCalibration=function(){ return readAll()[courseKey()] || null; };
  window.gdHasGreenWandCalibration=function(){
    const c=window.gdReadGreenWandCalibration();
    return !!(c && Number.isFinite(Number(c.sensitivity)) && Number.isFinite(Number(c.sizeM)) && Number.isFinite(Number(c.curve)));
  };

  window.gdMarkGreenWandCalibrationDirty=function(){
    liveCalibrationDirty=true;
    const save=document.getElementById("gdCalibrationSaveBtn");
    const scan=document.getElementById("gdWandScanBtn");
    const hint=document.getElementById("gdWandUserHint");
    if(save) save.textContent="Save Live Calibration";
    if(scan) scan.textContent="Live Scan";
    if(hint) hint.textContent="Live previewing. Save to keep these settings.";
  };

  window.gdApplyGreenWandCalibration=function(options){
    if(liveCalibrationDirty && !(options && options.force)){
      gdSyncWandControlUi();
      return false;
    }
    const c=window.gdReadGreenWandCalibration();
    if(!c) return false;
    wandMode="robustTonal";
    greenTolerance=Number(c.sensitivity)/100;
    sessionGreenTolerance=greenTolerance;
    wandBaseBubbleMetersOverride=Number(c.sizeM);
    wandClusterPullOverride=Number(c.curve);
    gdSyncWandControlUi();
    return true;
  };

  window.gdSyncWandControlUi=function(){
    const sensitivity=Math.round((greenTolerance||0.71)*100);
    const sizeM=Number(wandBaseBubbleMetersOverride ?? 24.5);
    const curve=Math.round(Number(wandClusterPullOverride ?? 60));

    const sens=document.getElementById("gdWandSensitivity"), sensOut=document.getElementById("gdWandSensitivityOut");
    if(sens) sens.value=sensitivity;
    if(sensOut) sensOut.textContent=String(sensitivity);

    const size=document.getElementById("gdWandBaseBubble"), sizeOut=document.getElementById("gdWandBaseBubbleOut");
    if(size) size.value=sizeM;
    if(sizeOut) sizeOut.textContent=sizeM.toFixed(sizeM%1?1:0)+"m";

    const curveEl=document.getElementById("gdWandClusterPull"), curveOut=document.getElementById("gdWandClusterPullOut");
    if(curveEl) curveEl.value=curve;
    if(curveOut) curveOut.textContent=curve+"%";
  };

  window.saveGreenWandCalibration=function(){
    const all=readAll();
    const sensitivity=Math.round((greenTolerance || 0.71)*100);
    const sizeM=Number(wandBaseBubbleMetersOverride ?? 24.5);
    const curve=Math.round(Number(wandClusterPullOverride ?? 60));
    all[courseKey()]={course:courseKey(),sensitivity,sizeM:Number(sizeM.toFixed(1)),curve,mode:"robustTonal",savedAt:new Date().toISOString()};
    writeAll(all);
    liveCalibrationDirty=false;
    gdSyncWandControlUi();
    gdUpdateWandCalibrationUi();
    updateWandStatus(`Calibration saved · Robust · size ${Number(sizeM).toFixed(1)}m · curve ${curve}%`);
    if(typeof toast==="function") toast("Green Wand calibration saved");
  };

  window.gdUpdateWandCalibrationUi=function(){
    const calibrated=gdHasGreenWandCalibration();
    const title=document.getElementById("gdWandTitleText");
    const details=document.getElementById("gdCalibrationDetails");
    const scan=document.getElementById("gdWandScanBtn");
    const hint=document.getElementById("gdWandUserHint");
    const save=document.getElementById("gdCalibrationSaveBtn");

    if(calibrated){
      if(liveCalibrationDirty) gdSyncWandControlUi();
      else gdApplyGreenWandCalibration({force:true});
      if(title) title.textContent="Green Wand";
      if(details && !details.__gdUserOpened && !details.__gdCompactUserOpened) details.open=false;
      if(scan) scan.textContent=liveCalibrationDirty?"Live Scan":"Scan Outline";
      if(save) save.textContent=liveCalibrationDirty?"Save Live Calibration":"Update Calibration";
      if(hint) hint.textContent=liveCalibrationDirty?"Live previewing. Save to keep these settings.":"Using saved Robust calibration.";
    }else{
      // First calibration opens with known-good values.
      wandMode="robustTonal";
      if(!liveCalibrationDirty){
        if(wandBaseBubbleMetersOverride==null) wandBaseBubbleMetersOverride=24.5;
        if(wandClusterPullOverride==null) wandClusterPullOverride=60;
        if(!greenTolerance || Math.round(greenTolerance*100)<58 || Math.round(greenTolerance*100)>79) greenTolerance=0.71;
      }
      gdSyncWandControlUi();

      if(title) title.textContent="Green Wand Calibration";
      if(details) details.open=true;
      if(scan) scan.textContent=liveCalibrationDirty?"Live Scan":"Calibrate / Scan";
      if(save) save.textContent=liveCalibrationDirty?"Save Live Calibration":"Save Calibration";
      if(hint) hint.textContent=liveCalibrationDirty?"Live previewing. Save to keep these settings.":"First green at this location: starts from known-good Robust settings. Tune only if needed.";
    }
  };

  function removeLayerSafe(l){try{if(l && map) map.removeLayer(l);}catch(e){}}
  window.rejectGreenWand=function(){
    try{
      if(typeof clearWandHandles==="function") clearWandHandles();
      if(typeof clearWandDebugLayers==="function") clearWandDebugLayers();
      [greenOutline,greenSoft,greenLabel,frontLabel,backLabel].forEach(removeLayerSafe);
      greenOutline=greenSoft=greenLabel=frontLabel=backLabel=null;
      greenPolygon=[];
      lastWandResult=null;
      updateWandStatus("Green outline rejected · ready to scan again");
      if(typeof toast==="function") toast("Green outline rejected");
      if(typeof renderShot==="function") renderShot();
    }catch(e){console.warn("Reject Wand failed",e);}
  };

  window.attachGreenOutlineLongPress=function(){
    try{
      if(!greenOutline || greenOutline.__gdLongPressAttached) return;
      greenOutline.__gdLongPressAttached=true;
      let timer=null;
      const arm=()=>{
        clearTimeout(timer);
        timer=setTimeout(()=>{
          try{
            if(typeof makeEditableGreen==="function") makeEditableGreen();
            updateWandStatus("Adjust mode · drag the side handles");
            if(typeof toast==="function") toast("Adjust green outline");
          }catch(e){}
        },850);
      };
      const disarm=()=>{clearTimeout(timer);timer=null;};
      greenOutline.on("mousedown",arm);
      greenOutline.on("touchstart",arm);
      greenOutline.on("mouseup",disarm);
      greenOutline.on("mouseout",disarm);
      greenOutline.on("touchend",disarm);
      greenOutline.on("drag",disarm);
    }catch(e){}
  };

  function install(){
    const details=document.getElementById("gdCalibrationDetails");
    if(details && !details.__gdTrackOpen){
      details.__gdTrackOpen=true;
      details.addEventListener("toggle",()=>{details.__gdUserOpened=true;details.__gdCompactUserOpened=true;});
      details.querySelector("summary")?.addEventListener("click",()=>{details.__gdUserOpened=true;details.__gdCompactUserOpened=true;},true);
    }
    wandMode="robustTonal";
    if(gdHasGreenWandCalibration() && !liveCalibrationDirty) gdApplyGreenWandCalibration();
    gdUpdateWandCalibrationUi();
  }

  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",install);
  else install();
  setTimeout(install,300);
  setTimeout(install,1200);

  function wrap(name,before,after){
    const fn=window[name];
    if(typeof fn!=="function" || fn.__gdKnownGoodRobustWrapped) return;
    const wrapped=function(){
      try{before && before();}catch(e){}
      const result=fn.apply(this,arguments);
      Promise.resolve(result).finally(()=>{try{after && after();}catch(e){}});
      return result;
    };
    wrapped.__gdKnownGoodRobustWrapped=true;
    window[name]=wrapped;
  }

  setTimeout(()=>{
    wrap("openGpsWand",()=>{wandMode="robustTonal";},gdUpdateWandCalibrationUi);
    wrap("runGreenWandScan",()=>{wandMode="robustTonal"; if(gdHasGreenWandCalibration() && !liveCalibrationDirty) gdApplyGreenWandCalibration(); else gdUpdateWandCalibrationUi();},gdUpdateWandCalibrationUi);
  },100);
})();
