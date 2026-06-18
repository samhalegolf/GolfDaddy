(function(){
  var build = {
    appName: "Clarity Caddie",
    packageName: "clarity-caddie-core",
    version: "0.1.0-beta.1",
    buildId: "2026-06-18-hole-frame-visual-zoom-001",
    deployedAt: "2026-06-18",
    channel: "beta",
    betaLabel: "Beta",
    cacheBust: "hole-frame-visual-zoom-001"
  };

  window.ClarityBuild = Object.assign({}, window.ClarityBuild || {}, build);
  window.GolfDaddy = window.GolfDaddy || {};
  window.GolfDaddy.clarityBuild = window.ClarityBuild;

  /* Runtime visual polish for Hole Frame navigation. */
  if(!window.__gdHoleFrameVisualZoomHotfixV1){
    window.__gdHoleFrameVisualZoomHotfixV1=true;

    function safe(fn,fallback){try{return fn();}catch(_){return fallback;}}

    function ensureBlackoutDefault(){
      safe(function(){
        var key="golf_daddy_dev_tuning_v1";
        var raw=localStorage.getItem(key);
        var settings=raw?JSON.parse(raw):{};
        settings.gps=settings.gps||{};
        if(settings.gps.preLockBlackoutFrame===undefined || settings.gps.preLockBlackoutFrame===null){
          settings.gps.preLockBlackoutFrame=1;
          localStorage.setItem(key,JSON.stringify(settings));
        }
      });
      safe(function(){
        if(typeof window.gdPreLockBlackoutFrameEnabled==="function" && !window.gdPreLockBlackoutFrameEnabled.__gdBlackoutDefaultPatched){
          var old=window.gdPreLockBlackoutFrameEnabled;
          window.gdPreLockBlackoutFrameEnabled=function(){
            try{
              var key="golf_daddy_dev_tuning_v1";
              var raw=localStorage.getItem(key);
              var settings=raw?JSON.parse(raw):{};
              if(settings && settings.gps && settings.gps.preLockBlackoutFrame!==undefined){
                return Number(settings.gps.preLockBlackoutFrame)>=1;
              }
            }catch(_){ }
            return true;
          };
          window.gdPreLockBlackoutFrameEnabled.__gdPrevious=old;
          window.gdPreLockBlackoutFrameEnabled.__gdBlackoutDefaultPatched=true;
        }
      });
      safe(function(){document.body&&document.body.classList.add("gdPreLockBlackoutFrame");});
    }

    function normaliseHoleRailLabel(){
      var rail=document.getElementById("gdHoleStepper");
      if(!rail) return;
      var label=rail.querySelector("strong");
      if(label){
        var txt=String(label.textContent||"").trim();
        var m=txt.match(/(\d+)/);
        if(m && txt!==m[1]) label.textContent=m[1];
        label.classList.add("gdHoleRailNumber");
      }
    }

    function zoomFallback(){
      var btn=document.getElementById("gdGpsSnapZoomBtn");
      if(!btn || btn.__gdZoomFallbackBound) return;
      btn.__gdZoomFallbackBound=true;
      btn.addEventListener("click",function(event){
        safe(function(){event.preventDefault();event.stopPropagation();});
        setTimeout(function(){
          safe(function(){
            if(window.gdFrameMappedPreLockPreset){
              var n=Number(window.__gdZoomFallbackPreset||0);
              window.__gdZoomFallbackPreset=(n+1)%3;
              window.gdFrameMappedPreLockPreset(window.__gdZoomFallbackPreset,{animate:false,immediate:true});
            }else if(window.gdFocusMappedPreLockHole){
              var h=Number(sessionStorage.getItem("gd_active_playing_hole")||sessionStorage.getItem("gd_mapper_active_hole")||1)||1;
              window.gdFocusMappedPreLockHole(h,{source:"zoom-fallback",reenterGps:false,refreshGps:false});
            }else if(window.map && map.zoomIn){
              map.zoomIn(1,{animate:true});
            }
          });
        },0);
      },false);
    }

    function tick(){
      ensureBlackoutDefault();
      normaliseHoleRailLabel();
      zoomFallback();
    }

    if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",tick);
    else tick();
    setInterval(tick,650);
    document.addEventListener("click",function(){setTimeout(tick,50);},true);
  }
})();
