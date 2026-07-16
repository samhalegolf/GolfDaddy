/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  "use strict";
  function wire(){
    try{
      const btn=document.getElementById("gdV62LogShotBtn");
      if(btn&&!btn.__gdLogShotFinalWire){
        btn.__gdLogShotFinalWire=true;
        btn.onclick=function(ev){ev.preventDefault();ev.stopPropagation();if(typeof window.gdGpsNewShot==="function")window.gdGpsNewShot();};
      }
      if(typeof window.gdSyncNewShotButtonState==="function")window.gdSyncNewShotButtonState();
    }catch(e){console.warn("[GolfDaddy] new shot wire skipped",e);}
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",wire);
  else wire();
  setTimeout(wire,250);
  setTimeout(wire,1000);
})();
