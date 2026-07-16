/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  "use strict";
  if(window.__gdGpsLocationSetLockV1)return;
  window.__gdGpsLocationSetLockV1=true;
  var consumeUntil=0;
  var armedUntil=0;
  var armed=false;
  var locked=false;
  var lastGesture=null;
  function safe(fn,fb){try{return fn()}catch(e){return fb}}
  function gpsPlayActive(){
    return safe(function(){
      return !!(document.body&&(
        document.body.classList.contains("shell-gps")||
        document.body.classList.contains("gdGpsActive")||
        document.body.classList.contains("gps-active")||
        document.body.dataset.clarityRoute==="gps"
      ));
    },false);
  }
  function explicitMappingMode(){
    return safe(function(){
      return !!(window.gdFullMappingMode||
        window.__gdMapperObjectCaptureActive||
        document.body.classList.contains("gdFullMappingMode")||
        document.body.dataset.gdToolScreen==="mapping"||
        document.body.classList.contains("gdCourseOpening"));
    },false);
  }
  function locationClassActive(){
    return safe(function(){return document.body.classList.contains("gdManualStartPlacementActive");},false);
  }
  function consume(reason,ms){
    consumeUntil=Math.max(consumeUntil,Date.now()+Math.max(350,Number(ms)||900));
    safe(function(){
      document.body.dataset.gdLocationClickConsumed=String(reason||"gesture");
      document.body.dataset.gdLocationClickConsumedAt=String(Date.now());
    });
    safe(function(){if(typeof gdSuppressMapPlacementClick==="function")gdSuppressMapPlacementClick(Math.max(350,Number(ms)||900));});
    safe(function(){gdMapPlacementSuppressClickUntil=Math.max(gdMapPlacementSuppressClickUntil||0,Date.now()+Math.max(350,Number(ms)||900));});
    return false;
  }
  function consumeButtonClick(reason,ms){
    consumeUntil=Math.max(consumeUntil,Date.now()+Math.max(120,Number(ms)||260));
    safe(function(){
      document.body.dataset.gdLocationClickConsumed=String(reason||"button");
      document.body.dataset.gdLocationClickConsumedAt=String(Date.now());
    });
    return false;
  }
  function arm(reason){
    armed=true;
    locked=false;
    armedUntil=Date.now()+15000;
    consumeButtonClick(reason||"arm-location",260);
    safe(function(){
      document.body.dataset.gdLocationSetMode="armed";
      document.body.dataset.gdLocationSetReason=String(reason||"manual");
      document.body.dataset.gdLocationSetArmedAt=String(Date.now());
    });
    lockMapInteractions(true,reason||"arm-location");
    return true;
  }
  function disarm(reason){
    armed=false;
    armedUntil=0;
    locked=true;
    safe(function(){
      document.body.dataset.gdLocationSetMode="locked";
      document.body.dataset.gdLocationSetLockedAt=String(Date.now());
      document.body.dataset.gdLocationSetLockedReason=String(reason||"location-set");
    });
    consume(reason||"location-set",850);
    lockMapInteractions(true,reason||"location-set");
    return true;
  }
  function clear(reason){
    armed=false;
    armedUntil=0;
    locked=false;
    safe(function(){
      document.body.dataset.gdLocationSetMode="";
      document.body.dataset.gdLocationSetClearReason=String(reason||"clear");
    });
    lockMapInteractions(false,reason||"clear");
    return true;
  }
  function eventMoved(event){
    if(!lastGesture||!event)return false;
    if(lastGesture.id!==event.pointerId)return false;
    return Math.hypot(Number(event.clientX||0)-lastGesture.x,Number(event.clientY||0)-lastGesture.y)>Math.max(5,lastGesture.pointerType==="mouse"?4:8);
  }
  function eventLooksLikePlayOverlay(event){
    var target=event&&event.target;
    if(!target||!target.closest)return false;
    return !!target.closest("#gdCapturedBubbleDragHit,.gdBubbleDragHit,.gdBubbleDragHitIcon,.targetDot,.startDot,.gdCapturedShotBubble,.gdCapturedShotCore,.gdCapturedShotSvg,.gdCapturedAimLine,.gdAimRecognitionFleck,.gdMiddleGuideLabel,.remainingGreenLabel,.leaflet-marker-icon,.leaflet-interactive");
  }
  function maySet(event,context){
    if(!gpsPlayActive())return true;
    if(explicitMappingMode())return true;
    if(Date.now()<consumeUntil)return false;
    if(safe(function(){return document.body.classList.contains("gdCapturedBubbleDragging")||!!targetDragging;},false))return false;
    if(eventLooksLikePlayOverlay(event))return false;
    if(event&&event.target&&event.target.closest&&event.target.closest("#shotTile,.rightRail,#gdToolRailTab,#hint,.panel,.modulePanel"))return false;
    if(eventMoved(event))return false;
    if(!locationClassActive())return false;
    if(!armed||Date.now()>armedUntil)return false;
    return !locked;
  }
  function setHandlerState(name,enabled){
    var m=safe(function(){return map;},null)||window.map;
    var h=m&&m[name];
    if(!h)return;
    try{enabled?h.enable():h.disable();}catch(e){}
  }
  function lockMapInteractions(on,reason){
    if(!gpsPlayActive()||explicitMappingMode())on=false;
    ["dragging","touchZoom","doubleClickZoom","scrollWheelZoom","boxZoom","keyboard"].forEach(function(name){setHandlerState(name,!on);});
    safe(function(){var m=map||window.map;if(m&&m.tap)on?m.tap.disable():m.tap.enable();});
    safe(function(){
      document.body.dataset.gdManualMapDragLocked=on?"1":"0";
      document.body.dataset.gdManualMapDragLockReason=String(reason||"gps-play");
    });
    return true;
  }
  function wrapGestureEnable(name){
    var m=safe(function(){return map;},null)||window.map;
    var h=m&&m[name];
    if(!h||typeof h.enable!=="function"||h.enable.__gdLocationSetLockWrapped)return false;
    var old=h.enable;
    h.enable=function(){
      if(gpsPlayActive()&&!explicitMappingMode())return false;
      return old.apply(this,arguments);
    };
    h.enable.__gdLocationSetLockWrapped=true;
    return true;
  }
  function install(){
    ["dragging","touchZoom","doubleClickZoom","scrollWheelZoom","boxZoom","keyboard"].forEach(wrapGestureEnable);
    lockMapInteractions(gpsPlayActive()&&!explicitMappingMode(),"install");
  }
  function consumeOverlayGesture(event,phase){
    if(!gpsPlayActive())return;
    if(eventLooksLikePlayOverlay(event)){
      consume("overlay-"+phase,1400);
      return;
    }
    if(safe(function(){return document.body.classList.contains("gdCapturedBubbleDragging")||!!targetDragging;},false))consume("bubble-drag-"+phase,1400);
    else if(phase==="pointerup"&&eventMoved(event))consume("pointerup-moved",1100);
  }
  window.addEventListener("pointerdown",function(event){
    consumeOverlayGesture(event,"pointerdown");
  },true);
  window.addEventListener("pointermove",function(event){
    consumeOverlayGesture(event,"pointermove");
  },true);
  window.addEventListener("pointerup",function(event){
    consumeOverlayGesture(event,"pointerup");
  },true);
  window.addEventListener("click",function(event){
    consumeOverlayGesture(event,"click");
  },true);
  document.addEventListener("pointerdown",function(event){
    lastGesture={id:event.pointerId,x:Number(event.clientX||0),y:Number(event.clientY||0),pointerType:event.pointerType||"",at:Date.now()};
    if(eventLooksLikePlayOverlay(event)){
      consume("bubble-pointerdown",1200);
    }
  },true);
  document.addEventListener("pointermove",function(event){
    if(!lastGesture||lastGesture.id!==event.pointerId)return;
    if(eventMoved(event))consume("pointer-move",700);
  },true);
  document.addEventListener("pointerup",function(event){
    if(eventLooksLikePlayOverlay(event))consume("bubble-pointerup",1200);
  },true);
  window.gdConsumeNextMapClick=consume;
  window.gdMapClickConsumed=function(){return Date.now()<consumeUntil;};
  window.gdLocationSetArmed=function(){return gpsPlayActive()&&locationClassActive()&&armed&&Date.now()<=armedUntil&&!locked;};
  window.gdLocationEventIsPlayOverlay=eventLooksLikePlayOverlay;
  window.gdArmLocationSet=arm;
  window.gdDisarmLocationSet=disarm;
  window.gdClearLocationSetLock=clear;
  window.gdMaySetLocationFromMapEvent=maySet;
  window.gdSetGpsPlayManualMapDragLocked=lockMapInteractions;
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",install);
  else install();
  [120,500,1400,2600].forEach(function(delay){setTimeout(install,delay);});
  setInterval(function(){lockMapInteractions(gpsPlayActive()&&!explicitMappingMode(),"tick");},700);
})();
