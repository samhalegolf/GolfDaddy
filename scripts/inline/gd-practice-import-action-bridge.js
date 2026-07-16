/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  if(window.__gdPracticeImportActionBridgeBound)return;
  window.__gdPracticeImportActionBridgeBound=true;
  function stopEvent(event){
    if(!event)return;
    if(event.preventDefault)event.preventDefault();
    if(event.stopPropagation)event.stopPropagation();
    if(event.stopImmediatePropagation)event.stopImmediatePropagation();
  }
  function releaseSurfaces(){
    try{localStorage.removeItem("gd_practice_import_job_v1");}catch(e){}
    try{window.gdPracticeImportJob=null;}catch(e){}
    try{
      document.body.classList.remove("gdPracticeScanRunning","gdPracticePhotoProcessing");
      var panel=document.getElementById("practiceDataPanel");
      if(panel)panel.classList.remove("gdPracticeScanRunning","gdPracticePhotoProcessing");
      document.querySelectorAll(".gdPracticeLibraryProcessing").forEach(function(node){node.remove();});
      document.querySelectorAll(".gdPracticeLibraryTabs .gdNativeProcessingStack").forEach(function(node){node.remove();});
    }catch(e){}
  }
  function reviewImport(){
    try{
      var panel=document.getElementById("practiceDataPanel");
      if(panel)panel.classList.add("gdPracticeAdminExpanded");
      document.querySelectorAll(".gdShotDataLibraryShell-practice").forEach(function(shell){shell.classList.add("open");});
      document.querySelectorAll(".gdPracticeLibraryTabs").forEach(function(toggle){toggle.setAttribute("aria-expanded","true");});
      var card=document.querySelector(".gdPracticeImportJob");
      if(card&&card.scrollIntoView)card.scrollIntoView({block:"center"});
    }catch(e){}
    return false;
  }
  function clearImport(){
    releaseSurfaces();
    try{document.querySelectorAll(".gdPracticeImportJob").forEach(function(node){node.remove();});}catch(e){}
    try{if(typeof window.renderPracticeData==="function")window.renderPracticeData(true);}catch(e){}
    return false;
  }
  function bridge(action,event){
    stopEvent(event);
    var resolved=String(action||"");
    if(resolved==="review")return reviewImport();
    if(resolved==="discard"||resolved==="clear"||resolved==="cancel")return clearImport();
    return false;
  }
  window.gdPracticeHandleImportJobAction=bridge;
  if(typeof window.gdPracticeHardStopScan!=="function"){
    window.gdPracticeHardStopScan=function(reason){
      releaseSurfaces();
      try{document.querySelectorAll(".gdPracticeImportJob").forEach(function(node){node.remove();});}catch(e){}
      return false;
    };
  }
  document.addEventListener("click",function(event){
    var target=event.target&&event.target.closest&&event.target.closest("[data-gd-practice-import-action]");
    if(!target)return;
    return bridge(target.getAttribute("data-gd-practice-import-action"),event);
  },true);
})();
