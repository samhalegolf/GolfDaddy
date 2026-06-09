(function(){
  "use strict";
  function safe(fn,fallback){try{return fn()}catch(e){return fallback}}
  function isAdmin(){
    return safe(function(){return typeof window.gdGetAccountPermission==="function"&&window.gdGetAccountPermission()==="admin"},false)
      || safe(function(){return document.body&&document.body.dataset&&document.body.dataset.gdPermission==="admin"},false);
  }
  function syncArcadeGate(){
    var allowed=isAdmin();
    if(document.body)document.body.classList.toggle("gdArcadeAdminAllowed",allowed);
    var btn=document.getElementById("gdArcadeRailBtn");
    if(btn){
      btn.setAttribute("aria-hidden",allowed?"false":"true");
      btn.tabIndex=allowed?0:-1;
      if(!allowed)btn.classList.remove("active");
      btn.title=allowed?"Arcade Mode":"Arcade Mode is admin-only for now";
    }
  }
  function installArcadeGuard(){
    if(window.__clarityArcadeAdminGuard)return;
    window.__clarityArcadeAdminGuard=true;
    var old=window.gdOpenArcadeEntry;
    window.gdOpenArcadeEntry=function(event){
      syncArcadeGate();
      if(!isAdmin()){
        if(event&&event.preventDefault)event.preventDefault();
        if(event&&event.stopPropagation)event.stopPropagation();
        safe(function(){if(typeof window.toast==="function")window.toast("Arcade is admin-only for now")});
        return false;
      }
      return typeof old==="function"?old.apply(this,arguments):false;
    };
  }
  function hideNextHolePopout(){
    var pop=document.getElementById("gdNextHolePopout");
    if(pop){
      pop.classList.add("hidden");
      pop.setAttribute("aria-hidden","true");
      pop.style.display="none";
    }
  }
  function recoverBagQuickControls(){
    var wrap=document.getElementById("gdBagQuickWrap");
    if(wrap){
      wrap.hidden=false;
      wrap.classList.add("gdBagQuickRecovered");
    }
    var tab=document.getElementById("gdBagQuickTab");
    if(tab&&!tab.__clarityQuickRecovered){
      tab.__clarityQuickRecovered=true;
      tab.addEventListener("click",function(){
        setTimeout(recoverBagQuickControls,0);
      },true);
    }
    var addTab=document.getElementById("gdBagAddTab");
    var addPanel=document.getElementById("gdBagAddPanel");
    if(addTab&&addPanel&&!addTab.__clarityAddRecovered){
      addTab.__clarityAddRecovered=true;
      addTab.addEventListener("click",function(){
        setTimeout(function(){
          if(addPanel.hidden===true){
            addPanel.hidden=false;
            addTab.setAttribute("aria-expanded","true");
          }
        },0);
      },true);
    }
  }
  function installBagQuickGuard(){
    if(window.__clarityBagQuickGuard)return;
    window.__clarityBagQuickGuard=true;
    var oldRefresh=window.gdBagRefreshQuickTab;
    if(typeof oldRefresh==="function"){
      window.gdBagRefreshQuickTab=function(){
        var res=oldRefresh.apply(this,arguments);
        recoverBagQuickControls();
        return res;
      };
    }
    var oldOpen=window.openBag;
    if(typeof oldOpen==="function"&&!oldOpen.__clarityBagQuickWrapped){
      var wrapped=function(){
        var res=oldOpen.apply(this,arguments);
        [0,80,260].forEach(function(ms){setTimeout(recoverBagQuickControls,ms)});
        return res;
      };
      wrapped.__clarityBagQuickWrapped=true;
      window.openBag=wrapped;
      safe(function(){openBag=wrapped});
    }
  }
  function syncAll(){
    syncArcadeGate();
    installArcadeGuard();
    installBagQuickGuard();
    hideNextHolePopout();
    recoverBagQuickControls();
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",syncAll);
  else syncAll();
  [80,300,900,1800].forEach(function(ms){setTimeout(syncAll,ms)});
  document.addEventListener("click",function(event){
    if(event&&event.target&&event.target.closest&&event.target.closest("#gdNextHolePopout")){
      event.preventDefault();
      event.stopPropagation();
      if(event.stopImmediatePropagation)event.stopImmediatePropagation();
      hideNextHolePopout();
      return false;
    }
    setTimeout(syncAll,0);
  },true);
  document.addEventListener("visibilitychange",syncAll);
})();
