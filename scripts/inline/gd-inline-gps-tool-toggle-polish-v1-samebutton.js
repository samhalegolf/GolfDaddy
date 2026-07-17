/* Extracted verbatim from an inline <script> block in index.html (split-03). */
/* --- GPS tool toggle polish v1: same-button close, wand accepted-live, rotated flag drop --- */
(function(){
  'use strict';
  function safe(fn){try{return fn()}catch(e){console.warn('[GD tool toggle polish]',e);}}
  function isPanelOpen(id){const el=document.getElementById(id);return !!(el&&el.classList.contains('open'))}
  function hideWandPanel(){
    safe(()=>{greenActive=false;});
    safe(()=>{const panel=document.getElementById('gdWandPanel'); if(panel) panel.classList.add('hidden');});
    safe(()=>{if(typeof clearWandHandles==='function') clearWandHandles();});
    safe(()=>{const cs=document.getElementById('courseScreen'); if(cs) cs.classList.add('hidden');});
  }
  function syncWandLiveChrome(){
    const panel=document.getElementById('gdWandPanel');
    const open=!!(panel&&!panel.classList.contains('hidden'));
    const live=!!window.gdWandAcceptedLive;
    const active=open||live;
    const btn=document.getElementById('greenToolBtn');
    if(btn){
      btn.classList.toggle('gdWandActive',active);
      btn.classList.toggle('gdWandLive',live);
      btn.setAttribute('aria-label',live?'Green wand live':'Green Wand');
      btn.title=live?'Green wand live':'Green Wand';
    }
    document.body.classList.toggle('gdWandActive',active);
    document.body.classList.toggle('gdWandLayerActive',open);
    document.body.classList.toggle('gdWandLive',live);
  }
  function clearWandLive(){
    window.gdWandAcceptedLive=false;
    syncWandLiveChrome();
  }
  function gdGpsSurfaceAlreadyOpen(){
    return !!(document.body.classList.contains('shell-gps')||document.body.classList.contains('gdGpsActive')||document.body.classList.contains('gps-active')||document.getElementById('app')&&!document.getElementById('app').classList.contains('hidden'));
  }
	  function returnGpsMap(){
    safe(()=>sessionStorage.removeItem('gd_return_from_bag_to_gps'));
    safe(()=>sessionStorage.removeItem('gd_return_from_scorecard'));
    safe(()=>document.querySelectorAll('.panel.open,.modulePanel.open').forEach(p=>p.classList.remove('open')));
    if(gdGpsSurfaceAlreadyOpen()){
      safe(()=>document.getElementById('courseScreen')?.classList.add('hidden'));
      safe(()=>document.body.classList.remove('shell-home','shell-module'));
      safe(()=>document.body.classList.add('shell-gps','gdGpsActive','gps-active'));
      safe(()=>{if(typeof showShellChrome==='function')showShellChrome(true);});
      safe(()=>{if(typeof setDockActive==='function')setDockActive('gps');});
      safe(()=>{if(typeof map!=='undefined'&&map&&map.invalidateSize)setTimeout(()=>map.invalidateSize(),40);});
      safe(()=>{if(typeof window.gdSyncPlayFlowRail==='function')window.gdSyncPlayFlowRail();});
      safe(()=>{if(typeof window.gdHydrateGpsBadge==='function')window.gdHydrateGpsBadge(true);});
      safe(()=>{if(typeof window.gdApplyGpsMapVisibilityOwner==='function')window.gdApplyGpsMapVisibilityOwner('return-from-tool-panel');});
      return false;
    }
    safe(()=>{if(typeof enterGpsModule==='function') enterGpsModule({fromBack:true,preserve:true});});
    safe(()=>{if(typeof gdV62Refresh==='function') setTimeout(gdV62Refresh,80);});
  }
  window.gdSyncWandLiveChrome=syncWandLiveChrome;
  window.gdClearWandLive=clearWandLive;
  window.gdToggleBagTool=function(ev){
    if(ev){ev.preventDefault();ev.stopPropagation();}
    if(isPanelOpen('bagPanel')){returnGpsMap();return false;}
    safe(()=>sessionStorage.setItem('gd_return_from_bag_to_gps','1'));
    safe(()=>{if(typeof openBag==='function') openBag({fromGps:true});});
    return false;
  };
  window.gdToggleScorecardTool=function(ev){
    if(ev){ev.preventDefault();ev.stopPropagation();}
    if(isPanelOpen('scorePanel')){returnGpsMap();return false;}
    safe(()=>sessionStorage.setItem('gd_return_from_scorecard','gps'));
    safe(()=>{if(typeof openScorecard==='function') openScorecard();});
    return false;
  };
  window.gdToggleWandTool=function(ev){
    if(ev){ev.preventDefault();ev.stopPropagation();}
    safe(()=>{if(typeof toggleGreenWand==='function') toggleGreenWand(ev); else if(typeof openGpsWand==='function') openGpsWand(ev);});
    setTimeout(syncWandLiveChrome,40);
    return false;
  };
  window.gdOpenGpsToolSettings=function(ev){
    if(ev){ev.preventDefault();ev.stopPropagation();if(ev.stopImmediatePropagation)ev.stopImmediatePropagation();}
    safe(()=>sessionStorage.setItem('gd_return_from_settings_to_gps','1'));
    safe(()=>{window.__gdBackTarget='gps';});
    safe(()=>{if(typeof openSettings==='function')openSettings({fromGps:true});});
    return false;
  };
  function wrapAccept(){
    const old=window.acceptGreenWand;
    if(typeof old!=='function'||old.__gdAcceptLiveWrapped)return;
    const wrapped=function(){
      const hasOutline=!!(typeof greenPolygon!=='undefined'&&greenPolygon&&greenPolygon.length);
      const res=old.apply(this,arguments);
      if(hasOutline){
        window.gdWandAcceptedLive=true;
        hideWandPanel();
        safe(()=>{if(typeof updateWandStatus==='function'&&lastWandResult) updateWandStatus(`Accepted · ${lastWandResult.modeUsed} · ${lastWandResult.sensitivity}%`);});
        safe(()=>{if(typeof toast==='function') toast('Green accepted · wand live');});
        syncWandLiveChrome();
      }
      return res;
    };
    wrapped.__gdAcceptLiveWrapped=true;
    window.acceptGreenWand=wrapped;
  }
  function wrapReject(){
    const old=window.rejectGreenWand;
    if(typeof old!=='function'||old.__gdRejectLiveWrapped)return;
    const wrapped=function(){
      clearWandLive();
      return old.apply(this,arguments);
    };
    wrapped.__gdRejectLiveWrapped=true;
    window.rejectGreenWand=wrapped;
  }
  function wrapClearLive(name,when){
    const old=window[name];
    if(typeof old!=='function'||old.__gdClearWandLiveWrapped)return;
    const wrapped=function(){
      if(!when||when(arguments)) clearWandLive();
      return old.apply(this,arguments);
    };
    wrapped.__gdClearWandLiveWrapped=true;
    window[name]=wrapped;
  }
  function installToolButtons(){
    const wand=document.getElementById('greenToolBtn');
    if(wand) wand.onclick=window.gdToggleWandTool;
    const bag=document.getElementById('bagRailBtn');
    if(bag) bag.onclick=window.gdToggleBagTool;
    const score=document.getElementById('scorecardRailBtn');
    if(score) score.onclick=window.gdToggleScorecardTool;
    const settings=document.getElementById('gdGpsSettingsRailBtn');
    if(settings) settings.onclick=window.gdOpenGpsToolSettings;
    const flag=document.getElementById('flagTool');
    if(flag) flag.onclick=function(ev){if(ev){ev.preventDefault();ev.stopPropagation();}return false;};
    syncWandLiveChrome();
  }
  function install(){
    wrapAccept();
    wrapReject();
    wrapClearLive('setGreenTarget');
    wrapClearLive('resetPlay');
    wrapClearLive('clearAllLayers');
    wrapClearLive('setGpsPlayMode',args=>args&&args[0]==='twoTap');
    installToolButtons();
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',install);
  else install();
  document.addEventListener('click',()=>setTimeout(installToolButtons,160),true);
  setTimeout(install,350);
  setTimeout(install,1200);
})();
