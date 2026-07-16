/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  "use strict";
  function sync(){
    var panel=document.getElementById("gdWandPanel");
    var open=!!(panel&&!panel.classList.contains("hidden"));
    document.body.classList.toggle("gdWandLayerActive",open);
  }
  function install(){
    var panel=document.getElementById("gdWandPanel");
    if(panel&&!panel.__gdLayerObserver){
      panel.__gdLayerObserver=new MutationObserver(sync);
      panel.__gdLayerObserver.observe(panel,{attributes:true,attributeFilter:["class"]});
    }
    sync();
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",install);
  else install();
  setTimeout(install,400);
  setTimeout(sync,1200);
})();
