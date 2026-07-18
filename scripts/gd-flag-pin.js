/* ============================================================================
 * FLAG / PIN PLACEMENT OWNER — carved verbatim out of gd-app-core.js
 * (Phase B template carve, 2026-07-19).
 *
 * Loads immediately after gd-app-core.js. Top-level let/function declarations
 * land in the shared global lexical scope, so core functions that read
 * `placingPin` / call `finishPinPlacement` etc. keep working unchanged.
 * #flagTool is created dynamically by the rail owner (gd-brand-icon-render.js),
 * which calls window.gdBindFlagPointerHandlers() after creating it.
 * ============================================================================ */
function gdFlagEl(){return document.getElementById("flagTool")}
const ghost=document.getElementById("ghost"),dropPulse=document.getElementById("dropPulse");let draggingFlag=false,placingPin=false,flagPointerStart=null,suppressFlagClickUntil=0;
function cancelPinPlacement(message="Pin cancelled"){
  placingPin=false;
  draggingFlag=false;
  flagPointerStart=null;
  gdFlagEl()?.classList.remove("softActive","grabbing");
  if(ghost)ghost.style.display="none";
  hideHint();
  setState(mode==="aim"?"Aim":(gpsOk?"GPS ready":"Manual GPS"));
  toast(message);
}
function startPinPlacement(ev){
  if(ev){ev.preventDefault();ev.stopPropagation();}
  if(Date.now()<suppressFlagClickUntil)return;
  if(placingPin){cancelPinPlacement();return;}
  placingPin=true;
  draggingFlag=false;
  gdFlagEl()?.classList.add("softActive");
  gdFlagEl()?.classList.remove("grabbing");
  if(ghost)ghost.style.display="none";
  setState("Place pin");
  showHint("Tap map to place the pin");
  toast("Tap map to place pin");
}
function finishPinPlacement(ll){
  placingPin=false;
  gdFlagEl()?.classList.remove("softActive","grabbing");
  if(ghost)ghost.style.display="none";
  hideHint();
  placePin(ll);
  toast("Pin placed");
}
window.startPinPlacement=startPinPlacement;
function gdBindFlagPointerHandlers(){
  const flagEl=gdFlagEl();
  if(!flagEl||flagEl.__gdFlagPointerBound)return;
  flagEl.__gdFlagPointerBound=true;
  flagEl.addEventListener("pointerdown",e=>{if(e.button&&e.button!==0)return;e.preventDefault();e.stopPropagation();flagPointerStart={x:e.clientX,y:e.clientY,id:e.pointerId};draggingFlag=false;try{flagEl.setPointerCapture(e.pointerId)}catch(_e){}});
  flagEl.addEventListener("pointermove",e=>{if(!flagPointerStart)return;const moved=Math.hypot(e.clientX-flagPointerStart.x,e.clientY-flagPointerStart.y);if(!draggingFlag&&moved>8){draggingFlag=true;placingPin=false;flagEl.classList.add("grabbing");flagEl.classList.remove("softActive");if(ghost)ghost.style.display="block";}if(draggingFlag)moveGhost(e.clientX,e.clientY)});
  flagEl.addEventListener("pointerup",e=>{if(!flagPointerStart)return;e.preventDefault();e.stopPropagation();const wasDragging=draggingFlag;flagPointerStart=null;draggingFlag=false;flagEl.classList.remove("grabbing");if(ghost)ghost.style.display="none";if(wasDragging){suppressFlagClickUntil=Date.now()+450;showDrop(e.clientX,e.clientY);const p=typeof gdClientToMapContainerPoint==="function"?gdClientToMapContainerPoint(e.clientX,e.clientY):null;const ll=p?map.containerPointToLatLng(p):map.containerPointToLatLng([e.clientX-document.getElementById("map").getBoundingClientRect().left,e.clientY-document.getElementById("map").getBoundingClientRect().top]);finishPinPlacement(ll);return;}startPinPlacement(e)});
  flagEl.addEventListener("pointercancel",()=>{flagPointerStart=null;draggingFlag=false;flagEl.classList.remove("grabbing");if(ghost)ghost.style.display="none"});
}
window.gdBindFlagPointerHandlers=gdBindFlagPointerHandlers;
gdBindFlagPointerHandlers();
function moveGhost(x,y){ghost.style.left=x+"px";ghost.style.top=y+"px"}function showDrop(x,y){dropPulse.classList.remove("show");dropPulse.style.left=x+"px";dropPulse.style.top=y+"px";void dropPulse.offsetWidth;dropPulse.classList.add("show")}
