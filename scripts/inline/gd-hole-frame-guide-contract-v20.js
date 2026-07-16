/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  if(window.__gdHoleFrameGuideContractV20)return;
  window.__gdHoleFrameGuideContractV20=true;
  window.__gdSingleGuideCaptureFrameOwnerV20=true;
  var VERSION="V20_HOLE_FRAME_GUIDE_CONTRACT";
  function safe(fn,fb){try{return fn();}catch(e){return fb;}}
  function frameRect(kind){
    var w=innerWidth||document.documentElement.clientWidth||390;
    var h=innerHeight||document.documentElement.clientHeight||760;
    var spec={
      zoom:{x:.152,y:.203,w:.687,h:.316},
      lock:{x:.247,y:.203,w:.497,h:.222},
      hole:{x:.308,y:.203,w:.375,h:.160},
      tee:{x:.308,y:.881,w:.375,h:.037}
    }[kind]||{x:.247,y:.203,w:.497,h:.222};
    return {left:w*spec.x,top:h*spec.y,right:w*(spec.x+spec.w),bottom:h*(spec.y+spec.h),width:w*spec.w,height:h*spec.h};
  }
  function ensureOverlay(){
    if(!document.body)return null;
    var overlay=document.getElementById("gdTargetFrameDebugOverlay");
    if(!overlay){
      overlay=document.createElement("div");
      overlay.id="gdTargetFrameDebugOverlay";
      overlay.setAttribute("aria-hidden","true");
      document.body.appendChild(overlay);
    }
    var labels={hole:"Green (Hole Frame)",lock:"Green (Lock in State )",zoom:"Green Zoom",tee:"Tee (Hole Frame)"};
    overlay.innerHTML=["zoom","lock","hole","tee"].map(function(k){
      var r=frameRect(k);
      return '<div class="gdTargetFrameBox" data-frame="'+k+'" style="left:'+Math.round(r.left)+'px;top:'+Math.round(r.top)+'px;width:'+Math.round(r.width)+'px;height:'+Math.round(r.height)+'px"><span>'+labels[k]+'</span></div>';
    }).join("");
    return overlay;
  }
  function install(){
    window.gdScreenTargetFrameRect=frameRect;
    window.gdScreenTargetFrameConfig=function(kind){var r=frameRect(kind||"lock"),w=innerWidth||390,h=innerHeight||760;return {left:Math.round(r.left),top:Math.round(r.top),right:Math.round(Math.max(0,w-r.right)),bottom:Math.round(Math.max(0,h-r.bottom))};};
    window.gdTargetFramePadding=function(kind){var r=frameRect(kind||"lock"),w=innerWidth||390,h=innerHeight||760;return {paddingTopLeft:[Math.round(r.left),Math.round(r.top)],paddingBottomRight:[Math.round(Math.max(0,w-r.right)),Math.round(Math.max(0,h-r.bottom))]};};
    window.gdEnsureTargetFrameDebugOverlay=ensureOverlay;
    window.gdSetTargetFrameDebug=function(enabled){window.gdTargetFrameDebug=!!enabled;ensureOverlay();if(document.body)document.body.classList.toggle("gdTargetFrameDebugOn",!!enabled);};
    ensureOverlay();
    if(document.body)document.body.classList.toggle("gdTargetFrameDebugOn",window.gdTargetFrameDebug===true);
    window.__gdHoleFrameGuideContractV20={version:VERSION,at:Date.now(),frames:{hole:frameRect("hole"),lock:frameRect("lock"),zoom:frameRect("zoom"),tee:frameRect("tee")}};
    safe(function(){if(document.body&&document.body.classList.contains("gdCapturedHoleFrameCameraOn")&&window.__gdV19LastCapturedFit&&typeof window.gdFitCapturedHoleFrameToBoxV19==="function"){var last=window.__gdV19LastCapturedFit;var b=window.gdGetActiveShotObjectBounds&&window.gdGetActiveShotObjectBounds();window.gdFitCapturedHoleFrameToBoxV19(b,last.frame||"hole",last.frame==="zoom"?.018:.025,{objectName:last.object||"guide-contract",reason:"guide-contract"});}});
    return true;
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",function(){setTimeout(install,120);});else setTimeout(install,60);
  [800,1800,3400,5600].forEach(function(ms){setTimeout(install,ms);});
  safe(function(){window.addEventListener("resize",function(){setTimeout(install,80);},true);});
})();
