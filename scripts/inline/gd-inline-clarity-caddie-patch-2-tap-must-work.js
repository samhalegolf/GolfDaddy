/* Extracted verbatim from an inline <script> block in index.html (split-03). */
/* --- Clarity Caddy patch: 2-Tap must work with no location permission v1 --- */
(function(){
  'use strict';
  function safe(fn){ try{return fn()}catch(e){ console.warn('[GD 2tap no-location fix]', e); } }
  function say(msg){ safe(function(){ if(typeof toast==='function') toast(msg); }); }
  function state(msg){ safe(function(){ if(typeof setState==='function') setState(msg); }); safe(function(){ if(typeof setStateLabel==='function') setStateLabel(msg); }); }
  function hintMsg(msg){ safe(function(){ if(typeof showHint==='function') showHint(msg); else if(typeof hint==='function') hint(msg); }); }
  function hideCoursePicker(){ safe(function(){ var cs=document.getElementById('courseScreen'); if(cs) cs.classList.add('hidden'); }); }
  function showGpsSurface(){
    hideCoursePicker();
    safe(function(){ document.body.classList.add('shell-gps','gps-active','gdModeTwoTap'); document.body.classList.remove('gdModeLive'); });
    safe(function(){ if(typeof setShellLayer==='function') setShellLayer('gps'); });
    safe(function(){ if(typeof setDockActive==='function') setDockActive('gps'); });
    safe(function(){ var h=document.getElementById('shellHome'); if(h) h.classList.add('hidden'); });
    safe(function(){ if(typeof showShellChrome==='function') showShellChrome(true); });
    safe(function(){ if(typeof map!=='undefined'&&map&&map.invalidateSize) setTimeout(function(){map.invalidateSize();},80); });
  }
  function enableMapGestures(){
    safe(function(){ if(typeof map!=='undefined'&&map){ ['dragging','touchZoom','doubleClickZoom','scrollWheelZoom','boxZoom','keyboard'].forEach(function(k){ try{ map[k]&&map[k].enable&&map[k].enable(); }catch(e){} }); }});
  }
  function stopGpsWatch(){ safe(function(){ if(typeof gpsWatch!=='undefined' && gpsWatch && navigator.geolocation){ navigator.geolocation.clearWatch(gpsWatch); gpsWatch=null; } }); }
  function fullUnlockForManual(){
    safe(function(){ if(typeof clearReplaceGreenMode==='function') clearReplaceGreenMode(); });
    safe(function(){ if(typeof unlockFrameForReset==='function') unlockFrameForReset(); else if(typeof setBubbleOnlyLock==='function') setBubbleOnlyLock(false); });
    safe(function(){ lockedFrame=false; });
    safe(function(){ var a=(typeof app!=='undefined'&&app)||document.getElementById('app'); if(a) a.classList.remove('framed'); });
    enableMapGestures();
  }
  function removeLayerByName(name){ safe(function(){ if(typeof map!=='undefined'&&map&&typeof window[name]!=='undefined'&&window[name]){ map.removeLayer(window[name]); window[name]=null; } }); }
  function clearManualShotState(){
    safe(function(){ if(typeof clearShot==='function') clearShot(); });
    ['targetMarker','greenMarker','pinMarker','pinDirectionLine','aimLine','bubbleOuter','bubbleMain','bubbleCore','bubbleShadow','bubbleShade','heatLayer'].forEach(removeLayerByName);
    safe(function(){ target=null; greenCentre=null; pin=null; });
    safe(function(){ mode='start'; });
    safe(function(){ undoStack=[]; });
    safe(function(){ var tile=document.getElementById('shotTile'); if(tile) tile.classList.remove('visible'); });
  }
  function refreshModeButtons(){
    safe(function(){ var two=document.getElementById('gpsTwoTapBtn'), live=document.getElementById('gpsLiveModeBtn'); if(two) two.classList.add('active'); if(live) live.classList.remove('active'); });
    safe(function(){ localStorage.setItem('gd_gps_play_mode','twoTap'); localStorage.setItem('gdGpsPlayMode','twoTap'); });
  }
  function enterTwoTapNoLocation(){
    stopGpsWatch();
    fullUnlockForManual();
    showGpsSurface();
    refreshModeButtons();
    clearManualShotState();
    safe(function(){ if(typeof setGps==='function') setGps(false,'Manual'); });
    safe(function(){ if(typeof setGpsLabel==='function') setGpsLabel(false,'Manual'); });
    var mapped=!!(window.gdMappedCourseAssistActive&&window.gdMappedCourseAssistActive());
    state(mapped?'Mapped: set position':'Manual: set start');
    hintMsg(mapped?'Tap where you are standing':'Tap twice: ball then green');
    return true;
  }

  var previousSetGpsPlayMode = window.setGpsPlayMode;
  window.setGpsPlayMode = function(next){
    if(next==='twoTap') return enterTwoTapNoLocation();
    if(typeof previousSetGpsPlayMode==='function') return previousSetGpsPlayMode.apply(this, arguments);
  };

  function patchTwoTapButton(){
    var btn=document.getElementById('gpsTwoTapBtn');
    if(btn){
      btn.onclick=function(ev){ if(ev){ev.preventDefault();ev.stopPropagation();} enterTwoTapNoLocation(); };
    }
  }
  patchTwoTapButton();
  document.addEventListener('DOMContentLoaded', function(){ setTimeout(patchTwoTapButton,60); setTimeout(patchTwoTapButton,400); setTimeout(patchTwoTapButton,1400); });

  window.gdEnterTwoTapNoLocation = enterTwoTapNoLocation;
})();
