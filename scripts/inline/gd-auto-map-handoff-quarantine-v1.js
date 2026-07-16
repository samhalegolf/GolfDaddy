/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  "use strict";
  if(window.__gdAutoMapHandoffQuarantineV1)return;
  window.__gdAutoMapHandoffQuarantineV1=true;
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
  function explicitMappingContext(context){
    context=context||{};
    var source=String(context.source||context.reason||"");
    return !!safe(function(){
      return window.gdFullMappingMode||
        window.__gdMapperObjectCaptureActive||
        document.body.classList.contains("gdFullMappingMode")||
        document.body.dataset.gdToolScreen==="mapping"||
        /remap|mapping|mapper-tool|manual-map|capture/i.test(source);
    },false);
  }
  function gdGpsPlayFrameAlreadyConsumed(){
    return gpsPlayActive()&&safe(function(){
      return document.body.classList.contains("gdCapturedHoleFrameCameraOn")||
        document.body.classList.contains("gdHoleImageCameraOn")||
        document.body.classList.contains("gdHoleFrameLoading")||
        document.body.classList.contains("gdCapturedFrameUnavailable")||
        !!window.__gdV19LastCapturedFit||
        !!window.__gdHoleFrameLoading||
        !!window.__gdCapturedFrameUnavailable;
    },false);
  }
  function gdInteractiveGreenFallbackActive(){
    return safe(function(){
      return !!(window.__gdCoursePlayInteractiveFallbackActive||
        window.__gdInteractiveGreenFallback||
        document.body.classList.contains("gdGpsInteractiveGreenFallbackActive"));
    },false);
  }
  function gdAutoMapMayOwnCamera(context){
    if(gdInteractiveGreenFallbackActive())return false;
    if(explicitMappingContext(context))return true;
    return !gdGpsPlayFrameAlreadyConsumed();
  }
  function mapperStack(){
    var stack=String(safe(function(){return (new Error()).stack;},"")||"");
    return /gd-course-library-pin-lock|frameMappedHoleForPlay|scheduleOsmAutoMapForPlay|autoMapOsmCourse|focusMappedHoleOrSavedGreen|openCourseToFirstHole|settleMappedHoleZoom|orientCameraToMappedHole/i.test(stack);
  }
  function markBlocked(source){
    safe(function(){
      document.body.dataset.gdAutoMapCameraQuarantined=String(source||"auto-map");
      document.body.dataset.gdAutoMapCameraQuarantinedAt=String(Date.now());
    });
    return false;
  }
  function shouldBlockCamera(source){
    return mapperStack()&&!gdAutoMapMayOwnCamera({source:source||"auto-map-camera"});
  }
  function dataOnlyOptions(opts,source){
    var next=Object.assign({},opts||{});
    next.frame=false;
    next.__gdAutoMapCameraQuarantined=true;
    next.source=next.source||source||"auto-map-data-only";
    return next;
  }
  function wrapCameraMethod(name){
    var m=safe(function(){return map;},null)||window.map;
    if(!m||typeof m[name]!=="function"||m[name].__gdAutoMapHandoffWrapped)return false;
    var old=m[name];
    m[name]=function(){
      if(shouldBlockCamera(name))return markBlocked(name);
      return old.apply(this,arguments);
    };
    m[name].__gdAutoMapHandoffWrapped=true;
    return true;
  }
  function wrapNamedFunction(name,wrap){
    var old=window[name];
    if(typeof old!=="function"||old.__gdAutoMapHandoffWrapped)return false;
    var next=wrap(old);
    next.__gdAutoMapHandoffWrapped=true;
    window[name]=next;
    safe(function(){eval(name+"=window[name]");});
    return true;
  }
  function install(){
    wrapCameraMethod("fitBounds");
    wrapCameraMethod("setView");
    wrapCameraMethod("panTo");
    wrapCameraMethod("setZoom");
    wrapNamedFunction("gdFocusMappedHoleOrSavedGreen",function(old){
      return function(hole,opts){
        if(!gdAutoMapMayOwnCamera({source:"focusMappedHoleOrSavedGreen",opts:opts}))return markBlocked("focusMappedHoleOrSavedGreen");
        return old.apply(this,arguments);
      };
    });
	    wrapNamedFunction("gdScheduleOsmAutoMapForPlay",function(old){
	      return function(course,opts){
	        if(gdInteractiveGreenFallbackActive())return markBlocked("scheduleOsmAutoMapForPlay-manual-fallback-terminal");
	        if(!gdAutoMapMayOwnCamera({source:"scheduleOsmAutoMapForPlay",opts:opts})){
	          if(window.gdResolveCoursePlayHole&&(opts&&((opts.hole&&Number(opts.hole)>0)||opts.promptStart||opts.resolvePlay))){
	            return window.gdResolveCoursePlayHole(course,{
	              hole:Number(opts.hole)||1,
	              wholeCourse:!opts.hole,
	              showLoading:!!opts.showLoading,
	              fresh:!!opts.fresh,
	              reason:"schedule-quarantine"
	            });
	          }
	          return old.call(this,course,dataOnlyOptions(opts,"scheduleOsmAutoMapForPlay"));
	        }
	        return old.apply(this,arguments);
	      };
	    });
    wrapNamedFunction("gdAutoMapOsmCourse",function(old){
      return function(opts){
        if(!gdAutoMapMayOwnCamera({source:"autoMapOsmCourse",opts:opts})){
          return old.call(this,dataOnlyOptions(opts,"autoMapOsmCourse"));
        }
        return old.apply(this,arguments);
      };
    });
	    wrapNamedFunction("gdOpenCourseToFirstHole",function(old){
	      return function(course){
	        if(gdInteractiveGreenFallbackActive())return markBlocked("openCourseToFirstHole-manual-fallback-terminal");
	        if(!gdAutoMapMayOwnCamera({source:"openCourseToFirstHole"})){
	          if(window.gdResolveCoursePlayHole)return window.gdResolveCoursePlayHole(course,{hole:1,wholeCourse:true,showLoading:true,fresh:true,reason:"open-course-quarantine"});
	          return markBlocked("openCourseToFirstHole");
	        }
	        return old.apply(this,arguments);
	      };
	    });
    wrapNamedFunction("gdOrientGpsCameraToBearing",function(old){
      return function(bearingRad,source,opts){
        var label=String(source||"");
        if((mapperStack()||/mapped-hole|auto-map|open-course/i.test(label))&&!gdAutoMapMayOwnCamera({source:"orient:"+label,opts:opts})){
          return markBlocked("gdOrientGpsCameraToBearing");
        }
        return old.apply(this,arguments);
      };
    });
    window.gdGpsPlayFrameAlreadyConsumed=gdGpsPlayFrameAlreadyConsumed;
    window.gdAutoMapMayOwnCamera=gdAutoMapMayOwnCamera;
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",install);
  else install();
  [120,420,1100,2200].forEach(function(delay){setTimeout(install,delay);});
})();
