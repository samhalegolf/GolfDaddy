/* Clarity Caddy course-play pipeline debug + Course Play Monitor.
   STUDIO ONLY - index.html loads this with data-gd-surface="studio".
   See docs/APP_STUDIO_SPLIT.md.

   Moved verbatim (app/studio split phase 4) from gd-app-core.js lines 312-493
   and its exports/listeners from 639-648. Every one of these is a RENDERER; the
   debug events themselves are emitted from the play pipeline behind
   `typeof gdCoursePlayDebugEvent==="function"` guards and stay on the phone, so
   nothing stops being recorded - it just stops being drawn where only an admin
   could ever have seen it (gdCoursePlayMonitorAdminAllowed).

   The tail of this file is what used to run inside core's top-level pass: the
   monitor's first render, two window listeners and a 2200ms refresh interval.
   The app build no longer installs any of them. */
function gdCoursePlayMonitorAdminAllowed(){
  try{
    const permission=typeof gdGetAccountPermission==="function"?gdGetAccountPermission():String(document.body?.dataset?.gdPermission||"");
    if(String(permission||"").toLowerCase()==="admin")return true;
    const account=window.GolfDaddyAccounts&&typeof window.GolfDaddyAccounts.current==="function"?window.GolfDaddyAccounts.current():null;
    if(String(account?.role||"").toLowerCase()==="admin")return true;
    return String(document.body?.dataset?.gdPermission||"").toLowerCase()==="admin";
  }catch(e){return false;}
}
function gdCoursePlayDebugEnabled(){
  if(!gdCoursePlayMonitorAdminAllowed())return false;
  try{
    if(/[?&](gd_course_play_debug|debug-course-play)(=1|=true|=[^&]+|&|$)/i.test(location.search))return true;
    return localStorage.getItem("gd_course_play_debug_enabled")==="1";
  }catch(e){return false;}
}
function gdSetCoursePlayDebug(enabled){
  try{localStorage.setItem("gd_course_play_debug_enabled",enabled?"1":"0");}catch(e){}
  try{document.body.classList.toggle("gdCoursePlayDebugOn",!!enabled);}catch(e){}
  gdRenderCoursePlayPipelineDebug();
  gdRenderCoursePlayMonitor();
}
function gdCoursePlayDebugFlag(value){
  return `<span class="gdCoursePlayDebugFlag ${value?'ok':'bad'}">${value?'Yes':'No'}</span>`;
}
function gdCoursePlayDebugTime(value){
  if(!value)return "";
  const n=Number(value);
  const date=Number.isFinite(n)&&String(value).length<14?new Date(n):new Date(value);
  if(Number.isNaN(date.getTime()))return String(value);
  return date.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit"});
}
function gdCoursePlayDebugMetric(label,value){
  return `<div class="gdCoursePlayDebugMetric"><span>${gdEscapeHTML(label)}</span><strong>${gdEscapeHTML(value ?? "")}</strong></div>`;
}
function gdCoursePlayMonitorMetric(label,value){
  return `<div class="gdCpmMetric"><span>${gdEscapeHTML(label)}</span><strong>${gdEscapeHTML(value ?? "")}</strong></div>`;
}
function gdCoursePlayMonitorEventText(event){
  const type=String(event?.type||"event");
  const hole=event?.holeNumber?`Hole ${event.holeNumber} `:"";
  const labels={
    "automapper-started":"AutoMapper started",
    "automapper-ingest-started":"AutoMapper saving geometry",
    "automapper-completed":"AutoMapper complete",
    "course-opened":"Course opened",
    "course-library-ingested-hole":`${hole}geometry saved`,
    "pipeline-record-saved":`${hole}play data ready`,
    "pipeline-course-ingested":"Course saved",
    "frame-index-saved":`${hole}frame saved`,
    "captured-manifest-registered":`${hole}manifest registered`,
    "gps-play-requested-hole":`${hole}requested`,
    "gps-play-loaded-existing-frame":`${hole}loaded saved frame`,
    "gps-play-loaded-from-existing-frame":`${hole}loaded captured frame`,
    "gps-play-generated-new-frame":`${hole}frame generated`,
    "gps-play-rendered-frame":`${hole}rendered frame`,
    "gps-play-showed-loading":`${hole}loading frame`,
    "gps-play-fell-to-unavailable":`${hole}frame unavailable`,
    "gps-play-data-ready-no-manifest":`${hole}ready, manifest missing`,
    "debug-log-cleared":"Debug log cleared"
  };
  return labels[type]||[type.replace(/-/g," "),event?.courseName||"",event?.status||event?.reason||""].filter(Boolean).join(" · ");
}
function gdCoursePlayMonitorCollapsed(){
  try{return localStorage.getItem("gd_course_play_monitor_collapsed")==="1";}catch(e){return false;}
}
function gdToggleCoursePlayMonitorCollapsed(){
  const next=!gdCoursePlayMonitorCollapsed();
  try{localStorage.setItem("gd_course_play_monitor_collapsed",next?"1":"0");}catch(e){}
  gdRenderCoursePlayMonitor();
  return false;
}
function gdCoursePlayMonitorHeader(courseName,badge,collapsed){
  return `<div class="gdCpmHead"><div><strong>Course Play Monitor</strong><span>${gdEscapeHTML(courseName||"Waiting for pipeline")}</span></div><div class="gdCpmActions"><div class="gdCpmBadge">${gdEscapeHTML(badge||"debug")}</div><button class="gdCpmToggle" type="button" onclick="return gdToggleCoursePlayMonitorCollapsed()" aria-label="${collapsed?"Expand":"Collapse"} Course Play Monitor" title="${collapsed?"Expand":"Collapse"}">${collapsed?"+":"-"}</button></div></div>`;
}
function gdEnsureCoursePlayMonitor(){
  let el=document.getElementById("gdCoursePlayMonitor");
  if(!el&&document.body){
    el=document.createElement("div");
    el.id="gdCoursePlayMonitor";
    el.setAttribute("aria-live","polite");
    el.setAttribute("role","status");
    document.body.appendChild(el);
  }
  return el;
}
function gdRenderCoursePlayMonitor(){
  try{document.body.classList.toggle("gdCoursePlayDebugOn",gdCoursePlayDebugEnabled());}catch(e){}
  const enabled=gdCoursePlayDebugEnabled();
  const el=enabled?gdEnsureCoursePlayMonitor():document.getElementById("gdCoursePlayMonitor");
  if(!el)return;
  if(!enabled){el.innerHTML="";el.classList.remove("gdCpmCollapsed");return;}
  const collapsed=gdCoursePlayMonitorCollapsed();
  el.classList.toggle("gdCpmCollapsed",collapsed);
  const api=window.GDCoursePlayPipeline;
  if(!api||typeof api.buildDebugSnapshot!=="function"){
    el.innerHTML=gdCoursePlayMonitorHeader("Waiting for pipeline","Debug",collapsed);
    return;
  }
  const snap=api.buildDebugSnapshot();
  const events=(Array.isArray(snap.timeline)?snap.timeline:[]).slice(-8).reverse();
  const last=events[0];
  const courseName=String(snap.activeCourseName||snap.activeCourseKey||"Course").replace(/\s+Golf\s+Club$/i,"");
  if(collapsed){
    el.innerHTML=gdCoursePlayMonitorHeader(courseName,`H${snap.activeHole||""} · ${snap.holesWithPlayDataReady||0}/${snap.holesScanned||0}`,collapsed);
    return;
  }
  el.innerHTML=[
    gdCoursePlayMonitorHeader(courseName,snap.automapperStatus||"debug",collapsed),
    `<div class="gdCpmGrid">${[
      gdCoursePlayMonitorMetric("Active hole","H"+(snap.activeHole||"")),
      gdCoursePlayMonitorMetric("AutoMapper",snap.automapperStatus||"unknown"),
      gdCoursePlayMonitorMetric("Holes scanned",snap.holesScanned||0),
      gdCoursePlayMonitorMetric("Holes saved",snap.holesSaved||0),
      gdCoursePlayMonitorMetric("Play data ready",snap.holesWithPlayDataReady||0),
      gdCoursePlayMonitorMetric("Frames ready",snap.holesWithFrameIndexEntries||0),
      gdCoursePlayMonitorMetric("Manifest present",snap.holesWithCapturedManifestsPresent||0),
      gdCoursePlayMonitorMetric("Sync queue",snap.syncQueueItemCount||0)
    ].join("")}</div>`,
    `<div class="gdCpmLast">Last event: ${gdEscapeHTML(last?gdCoursePlayMonitorEventText(last):"Waiting")}</div>`,
    `<div class="gdCpmEvents">${events.map(event=>`<div class="gdCpmEvent">${gdEscapeHTML(gdCoursePlayDebugTime(event.at))} ${gdEscapeHTML(gdCoursePlayMonitorEventText(event))}</div>`).join("")||'<div class="gdCpmEvent">No events yet</div>'}</div>`
  ].join("");
}
function gdRenderCoursePlayPipelineDebug(){
  const summary=document.getElementById("gdCoursePlayDebugSummary");
  const tableHost=document.getElementById("gdCoursePlayDebugTable");
  const timelineHost=document.getElementById("gdCoursePlayDebugTimeline");
  if(!summary||!tableHost||!timelineHost)return;
  try{document.body.classList.toggle("gdCoursePlayDebugOn",gdCoursePlayDebugEnabled());}catch(e){}
  const api=window.GDCoursePlayPipeline;
  if(!api||typeof api.buildDebugSnapshot!=="function"){
    summary.innerHTML='<div class="gdCoursePlayDebugEmpty">Course Play Pipeline debug data is not loaded yet.</div>';
    tableHost.innerHTML="";
    timelineHost.innerHTML="";
    return;
  }
  const snap=api.buildDebugSnapshot();
  /* Say so when nothing is open rather than rendering a row of zeros against a
     blank course. This panel is scoped to the current browser, so a studio tab
     on a laptop will read empty while a scan runs on a phone - that is correct,
     and it needs to look correct instead of looking like a scan that failed. */
  if(!snap.hasActiveCourse){
    summary.innerHTML='<div class="gdCoursePlayDebugEmpty">No course is open in this browser. This panel shows local scan state only - a scan running on another device will not appear here.</div>';
    tableHost.innerHTML="";
    timelineHost.innerHTML="";
    return;
  }
  summary.innerHTML=[
    gdCoursePlayDebugMetric("Course",snap.activeCourseName||snap.activeCourseKey||""),
    gdCoursePlayDebugMetric("Course key",snap.activeCourseKey||""),
    gdCoursePlayDebugMetric("Active hole","H"+(snap.activeHole||"")),
    gdCoursePlayDebugMetric("Pipeline status",snap.pipelineCourseStatus||"unknown"),
    gdCoursePlayDebugMetric("Holes known",snap.totalHolesKnown||0),
    gdCoursePlayDebugMetric("Play data ready",snap.holesWithPlayDataReady||0),
    gdCoursePlayDebugMetric("Frame index",snap.holesWithFrameIndexEntries||0),
    gdCoursePlayDebugMetric("Manifest present",snap.holesWithCapturedManifestsPresent||0),
    gdCoursePlayDebugMetric("Sync queue",snap.syncQueueItemCount||0)
  ].join("");
  const rows=Array.isArray(snap.rows)?snap.rows:[];
  if(rows.length){
    tableHost.innerHTML=`<div class="gdCoursePlayDebugScroll"><table class="gdCoursePlayDebugTable"><thead><tr><th>Hole</th><th>State</th><th>Tee</th><th>Green</th><th>Route</th><th>Anchors</th><th>Frame index</th><th>Manifest key</th><th>Manifest</th><th>Last gen/render</th><th>Source</th><th>Sync</th><th>Updated</th><th>Reason</th></tr></thead><tbody>${rows.map(row=>`
      <tr>
        <td>H${gdEscapeHTML(row.holeNumber)}</td>
        <td>${gdEscapeHTML(row.pipelineState||"")}</td>
        <td>${gdCoursePlayDebugFlag(row.hasTee)}</td>
        <td>${gdCoursePlayDebugFlag(row.hasGreen)}</td>
        <td>${gdCoursePlayDebugFlag(row.hasRoute)}</td>
        <td>${gdCoursePlayDebugFlag(row.hasFrameAnchors)}</td>
        <td>${gdCoursePlayDebugFlag(row.hasFrameIndexEntry)}<br>${gdEscapeHTML(row.frameIndexKey||"")}</td>
        <td>${gdEscapeHTML(row.capturedManifestKey||"")}</td>
        <td>${gdCoursePlayDebugFlag(row.capturedManifestPresent)}</td>
        <td>${gdEscapeHTML(gdCoursePlayDebugTime(row.lastGeneratedAt))}<br>${gdEscapeHTML(row.lastRenderedAt?gdCoursePlayDebugTime(row.lastRenderedAt):"")}</td>
        <td>${gdEscapeHTML(row.source||"")}</td>
        <td>${gdEscapeHTML(row.syncStatus||"")}</td>
        <td>${gdEscapeHTML(gdCoursePlayDebugTime(row.updatedAt))}</td>
        <td>${gdEscapeHTML(row.lastError||"")}</td>
      </tr>`).join("")}</tbody></table></div>`;
  }else{
    tableHost.innerHTML='<div class="gdCoursePlayDebugEmpty">No known course-play holes yet.</div>';
  }
  const events=(Array.isArray(snap.timeline)?snap.timeline:[]).slice().reverse();
  timelineHost.innerHTML=events.length?events.map(event=>{
    const bits=[event.type,event.courseName||event.courseId,event.holeNumber?("H"+event.holeNumber):"",event.status||event.frameStatus||"",event.reason||event.source||""].filter(Boolean);
    return `<div class="gdCoursePlayDebugEvent"><strong>${gdEscapeHTML(gdCoursePlayDebugTime(event.at))}</strong> ${gdEscapeHTML(bits.join(" · "))}</div>`;
  }).join(""):'<div class="gdCoursePlayDebugEmpty">No runtime events yet.</div>';
}
function gdClearCoursePlayPipelineDebug(){
  try{window.GDCoursePlayPipeline?.clearDebugTimeline?.();}catch(e){}
  try{window.__gdClearCoursePlayDebugLog?.();}catch(e){}
  gdRenderCoursePlayPipelineDebug();
  gdRenderCoursePlayMonitor();
}

window.gdRenderCoursePlayPipelineDebug=gdRenderCoursePlayPipelineDebug;
window.gdSetCoursePlayDebug=gdSetCoursePlayDebug;
window.gdClearCoursePlayPipelineDebug=gdClearCoursePlayPipelineDebug;
window.gdRenderCoursePlayMonitor=gdRenderCoursePlayMonitor;
window.gdToggleCoursePlayMonitorCollapsed=gdToggleCoursePlayMonitorCollapsed;
try{document.body.classList.toggle("gdCoursePlayDebugOn",gdCoursePlayDebugEnabled());}catch(e){}
gdRenderCoursePlayMonitor();
window.addEventListener("gd-course-play-debug-event",()=>{if(document.getElementById("developerPanel")?.classList.contains("open")){gdRenderAdminCourseDatabase();gdRenderCoursePlayPipelineDebug();try{window.GDCourseMappingDebug?.renderAdminPanel?.();}catch(e){}}gdRenderCoursePlayMonitor();});
window.addEventListener("gd-course-mapping-debug-updated",()=>{if(document.getElementById("developerPanel")?.classList.contains("open"))try{window.GDCourseMappingDebug?.renderAdminPanel?.();}catch(e){}});
setInterval(()=>{if(document.getElementById("developerPanel")?.classList.contains("open")){gdRenderAdminCourseDatabase();gdRenderCoursePlayPipelineDebug();try{window.GDCourseMappingDebug?.renderAdminPanel?.();}catch(e){}}gdRenderCoursePlayMonitor();},2200);
