/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  "use strict";
  if(window.__gdGpsScorecardOwnerV1)return;
  window.__gdGpsScorecardOwnerV1=true;
  var STORE_KEY="gd_gps_scorecard_owner_v1";
  var selected=1;
  function safe(fn,fb){try{return fn()}catch(e){return fb}}
  function clean(value){return String(value||"").trim().replace(/\s+/g," ")}
  function courseName(){
    var names=[
      safe(function(){return document.body.dataset.gdActiveCourseName},""),
      safe(function(){return document.querySelector("#gdV62GpsBadge .courseTop").textContent},""),
      safe(function(){return document.getElementById("courseLine").textContent},""),
      safe(function(){return window.gdActiveCourseDisplayName},""),
      safe(function(){return sessionStorage.getItem("gd_assumed_course_name")},"")
    ].map(clean).filter(Boolean);
    return names.find(function(name){return name!=="Manual GPS"&&!/assumed course/i.test(name)})||"";
  }
  function key(name){return clean(name).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")||"manual-gps"}
  function holeNumber(value){
    var n=Number(value);
    return Number.isFinite(n)?Math.max(1,Math.min(18,Math.round(n))):1;
  }
  function activeHole(){
    return holeNumber(
      safe(function(){return sessionStorage.getItem("gd_active_playing_hole")},0)||
      safe(function(){return sessionStorage.getItem("gd_mapper_active_hole")},0)||
      selected||1
    );
  }
  function readAll(){return safe(function(){return JSON.parse(localStorage.getItem(STORE_KEY)||"{}")||{}},{})}
  function writeAll(all){safe(function(){localStorage.setItem(STORE_KEY,JSON.stringify(all||{}))})}
  function defaultHoles(){
    return Array.from({length:18},function(_,i){return{hole:i+1,par:null,score:null,putts:null}});
  }
  function stateFor(name){
    var all=readAll();
    var id=key(name);
    var state=all[id];
    if(!state||!Array.isArray(state.holes)||state.holes.length!==18){
      state={courseName:name||"Confirmed course",holes:defaultHoles(),updatedAt:Date.now()};
      all[id]=state;
      writeAll(all);
    }
    state.courseName=name||state.courseName||"Confirmed course";
    return state;
  }
  function saveState(name,state){
    var all=readAll();
    state.updatedAt=Date.now();
    all[key(name)]=state;
    writeAll(all);
  }
  function scoreText(value){return value===null||value===undefined?"-":String(value)}
  function render(){
    var panel=document.getElementById("scorePanel");
    if(!panel)return false;
    var name=courseName();
    if(!name){
      panel.classList.add("gdScoreEmptyMode");
      setText("scoreCourse","Course scorecard");
      setText("gdScoreCourseName","No course selected");
      setText("gdScoreCourseLabel","Confirmed course");
      setText("gdScoreCourseMeta","Confirm a course to load a scorecard.");
      setText("gdScoreEmpty","Confirm a course first, then the scorecard can load.");
      return false;
    }
    var state=stateFor(name);
    selected=holeNumber(selected||activeHole());
    panel.classList.remove("gdScoreEmptyMode");
    panel.classList.add("gdScoreShell");
    setText("scoreCourse",name);
    setText("gdScoreCourseName",name);
    setText("gdScoreCourseLabel","Score entry");
    setText("gdScoreCourseMeta","Using 18 score slots for this active GPS course.");
    setText("gdScoreEmpty","No scorecard data is available for this course yet.");
    setText("gdScoreHolePickerCurrent","H"+selected);
    var strip=document.getElementById("holeStrip");
    if(strip){
      strip.innerHTML="";
      state.holes.forEach(function(row){
        var b=document.createElement("button");
        b.type="button";
        b.className="holePill"+(row.hole===selected?" active":"")+(row.score!=null?" scored":"")+(row.hole===activeHole()?" playing":"");
        b.textContent=String(row.hole);
        b.setAttribute("aria-label","Play hole "+row.hole);
        b.onclick=function(event){
          if(event){event.preventDefault();event.stopPropagation();}
          selected=row.hole;
          playSelectedHole();
          return false;
        };
        strip.appendChild(b);
      });
    }
    var current=state.holes[selected-1]||state.holes[0];
    setText("scoreTitle","Hole "+(current&&current.hole||selected));
    setText("scoreMeta","Score entry");
    setText("holeScore",scoreText(current&&current.score));
    return true;
  }
  function setText(id,value){var el=document.getElementById(id);if(el)el.textContent=value}
  function open(){
    var panel=document.getElementById("scorePanel");
    if(!panel)return false;
    safe(function(){document.body.classList.remove("gdToolRailOpen")});
    safe(function(){document.querySelectorAll(".panel.open,.modulePanel.open").forEach(function(el){if(el.id!=="scorePanel")el.classList.remove("open")})});
    selected=activeHole();
    panel.classList.add("open");
    safe(function(){sessionStorage.setItem("gd_return_from_scorecard","gps")});
    render();
    return false;
  }
  function close(){
    safe(function(){document.getElementById("scorePanel")?.classList.remove("open")});
    safe(function(){document.body.classList.remove("shell-home","shell-module")});
    safe(function(){document.body.classList.add("shell-gps","gdGpsActive","gps-active")});
    safe(function(){document.getElementById("courseScreen")?.classList.add("hidden")});
    restoreCapturedLockFrame("scorecard-close");
    safe(function(){if(typeof window.gdSyncPlayFlowRail==="function")window.gdSyncPlayFlowRail()});
    safe(function(){if(typeof window.gdV62Refresh==="function")window.gdV62Refresh()});
    return false;
  }
  function restoreCapturedLockFrame(reason){
    if(!document.body)return;
    var locked=document.body.classList.contains("gd-frame-hard-locked")||
      document.body.classList.contains("gdLockStateFrameActive")||
      document.body.classList.contains("gdHeadToTeeFrameActive");
    if(!locked)return;
    function repaintCapturedShot(){
      safe(function(){
        if(typeof window.gdRepaintCapturedHoleFrameShotOverlay==="function")window.gdRepaintCapturedHoleFrameShotOverlay(reason||"scorecard-return");
      });
      safe(function(){
        if(typeof window.gdPaintCapturedShotOverlayOwner==="function")window.gdPaintCapturedShotOverlayOwner(reason||"scorecard-return");
      });
      safe(function(){if(typeof window.renderShot==="function")window.renderShot();});
      safe(function(){if(typeof renderShot==="function")renderShot();});
      safe(function(){
        if(typeof window.gdPaintCapturedShotOverlayOwner==="function")window.gdPaintCapturedShotOverlayOwner((reason||"scorecard-return")+"-after-render");
      });
    }
    document.body.classList.add("gdCapturedHoleFrameCameraOn","gdHoleImageCameraOn");
    repaintCapturedShot();
    [0,160,520].forEach(function(delay){
      setTimeout(function(){
        repaintCapturedShot();
        safe(function(){
          if(typeof window.gdFitLockStateFrameV19==="function"){
            window.gdFitLockStateFrameV19({force:true,objectName:"scorecardReturnLockFrame",reason:reason||"scorecard-return"});
          }else if(typeof window.gdHeadToTeeShotFrame==="function"){
            window.gdHeadToTeeShotFrame();
          }
        });
        repaintCapturedShot();
      },delay);
    });
  }
  function adjustScore(delta){
    var name=courseName();
    if(!name)return false;
    var state=stateFor(name);
    var row=state.holes[selected-1]||state.holes[0];
    row.score=Math.max(0,Number(row.score==null?row.par||0:row.score)+Number(delta||0));
    saveState(name,state);
    render();
    return false;
  }
  function saveScore(){
    var name=courseName();
    if(name)saveState(name,stateFor(name));
    close();
    safe(function(){if(typeof toast==="function")toast("Score saved")});
    return false;
  }
  function playSelected(){
    selected=holeNumber(selected);
    safe(function(){sessionStorage.setItem("gd_active_playing_hole",String(selected));sessionStorage.setItem("gd_mapper_active_hole",String(selected))});
    safe(function(){window.gdRememberPlayingHole&&window.gdRememberPlayingHole(selected)});
    setHoleLine({hole:selected});
    render();
    return false;
  }
  function setHoleLine(h){
    var n=holeNumber(h&&typeof h==="object"?h.hole:h);
    var el=document.getElementById("holeLine");
    if(el){el.style.display="inline";el.textContent="Hole "+n;}
    safe(function(){if(typeof window.gdSyncPlayFlowRail==="function")window.gdSyncPlayFlowRail()});
    safe(function(){if(typeof window.gdV62Refresh==="function")window.gdV62Refresh()});
    return false;
  }
  function bind(){
    var panel=document.getElementById("scorePanel");
    if(panel&&!panel.__gdScoreOwnerBack){
      panel.__gdScoreOwnerBack=true;
      panel.addEventListener("click",function(event){
        if(event.target&&event.target.closest&&event.target.closest(".backBtn")){
          event.preventDefault();
          event.stopPropagation();
          if(event.stopImmediatePropagation)event.stopImmediatePropagation();
          return close();
        }
      },true);
    }
  }
  window.gdScorecardConfirmedCourse=function(){var name=courseName();return name?{name:name,courseName:name,source:"gps-scorecard-owner"}:null};
  window.openScorecard=open;
  window.renderScorecard=render;
  window.adjustHoleScore=adjustScore;
  window.adjustHolePutts=function(){return false};
  window.saveHoleScore=saveScore;
  window.playSelectedHole=playSelected;
  window.setHole=setHoleLine;
  window.gdGpsScorecardReturnToGps=close;
  window.gdGpsScorecardOwnerRender=render;
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",bind);
  else bind();
  [120,600,1600].forEach(function(delay){setTimeout(bind,delay)});
})();
