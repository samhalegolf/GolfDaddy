(function(){
  var build = {
    appName: "Clarity Caddie",
    packageName: "clarity-caddie-core",
    version: "0.1.0-beta.1",
    buildId: "2026-06-20-tool-rail-tab-hole-label-001",
    deployedAt: "2026-06-20",
    channel: "beta",
    betaLabel: "Beta",
    cacheBust: "tool-rail-tab-hole-label-001"
  };

  window.ClarityBuild = Object.assign({}, window.ClarityBuild || {}, build);
  window.GolfDaddy = window.GolfDaddy || {};
  window.GolfDaddy.clarityBuild = window.ClarityBuild;

  /* Runtime visual polish for Hole Frame navigation. */
  if(!window.__gdHoleFrameVisualZoomHotfixV1){
    window.__gdHoleFrameVisualZoomHotfixV1=true;

    function safe(fn,fallback){try{return fn();}catch(_){return fallback;}}

    function ensureBlackoutDefault(){
      safe(function(){document.body&&document.body.classList.remove("gdPreLockBlackoutFrame");});
    }

    function holeNumberFromText(text,fallback){
      var raw=String(text||"").trim();
      var match=raw.match(/H\s*(\d+)/i)||raw.match(/(\d+)/);
      var n=match?Number(match[1]):Number(fallback||1);
      if(!Number.isFinite(n)||n<1)n=1;
      return String(Math.max(1,Math.min(18,Math.round(n))));
    }

    function activeHoleNumber(){
      return safe(function(){
        var keys=["gd_active_playing_hole","gd_mapper_active_hole","gd_selected_hole","gd_current_hole"];
        for(var i=0;i<keys.length;i++){
          var n=Number(sessionStorage.getItem(keys[i])||localStorage.getItem(keys[i])||0);
          if(Number.isFinite(n)&&n>0)return String(Math.max(1,Math.min(18,Math.round(n))));
        }
        var visible=document.querySelector(".gdNextHolePopout .gdHoleNavNumber strong,#gdShotHoleChip,#gdHoleStepper strong");
        return holeNumberFromText(visible&&visible.textContent,1);
      },"1");
    }

    function writeNumber(el,fallback){
      if(!el)return;
      var n=holeNumberFromText(el.textContent, fallback || activeHoleNumber());
      var label="H"+n;
      if(String(el.textContent||"").trim()!==label)el.textContent=label;
      el.classList&&el.classList.add("gdHoleRailNumber");
      return n;
    }

    function normaliseHoleRailLabel(){
      var current=activeHoleNumber();
      writeNumber(document.querySelector("#gdHoleStepper strong"),current);
      writeNumber(document.querySelector(".gdNextHolePopout .gdHoleNavNumber strong"),current);

      var chip=document.getElementById("gdShotHoleChip");
      var chipNumber=writeNumber(chip,current)||current;
      if(chip){
        chip.title="Long press to pick hole";
        chip.setAttribute("aria-label","Current hole H"+chipNumber+". Long press to pick hole.");
      }

      var pickerHead=document.querySelector(".gdHoleSelectHead strong");
      if(pickerHead){
        var headNumber=holeNumberFromText(pickerHead.textContent,current);
        var headLabel="GPS H"+headNumber;
        if(String(pickerHead.textContent||"").trim()!==headLabel)pickerHead.textContent=headLabel;
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

    var tickQueued=false;
    function queueTick(){
      if(tickQueued)return;
      tickQueued=true;
      setTimeout(function(){tickQueued=false;tick();},0);
    }

    function observeHoleNav(){
      if(!document.body||window.__gdHoleNavNumberObserver)return;
      window.__gdHoleNavNumberObserver=true;
      safe(function(){
        var observer=new MutationObserver(function(mutations){
          for(var i=0;i<mutations.length;i++){
            var target=mutations[i].target;
            if(!target)continue;
            var node=target.nodeType===1?target:target.parentElement;
            if(node && node.closest && node.closest("#gdHoleStepper,.gdNextHolePopout,#gdShotHoleChip,.gdHoleSelectHead")){
              queueTick();
              return;
            }
          }
        });
        observer.observe(document.body,{childList:true,subtree:true,characterData:true});
      },null);
    }

    function tick(){
      ensureBlackoutDefault();
      normaliseHoleRailLabel();
      zoomFallback();
      observeHoleNav();
    }

    if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",tick);
    else tick();
    setInterval(tick,250);
    document.addEventListener("click",function(){setTimeout(tick,0);setTimeout(tick,50);},true);
  }
})();
