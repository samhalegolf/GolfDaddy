/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  "use strict";
  const RECENTS_KEY="gd_recent_course_picks_v1";
  const NEARBY_M=5200;
  const REMOTE_LIMIT=12;
  const KNOWN=[
    {name:"Akarana Golf Club",courseId:"akarana-golf-club",lat:-36.9174953,lng:174.7400425,source:"known-course",aliases:["akarana golf course","akarana gc"]},
    {name:"Maungakiekie Golf Club",courseId:"maungakiekie-golf-club",lat:-36.9229754,lng:174.7254871,source:"known-course",aliases:["maungakeikei golf club","maungakiekie golf course","maunga gc"]}
  ];
  let searchRun=0;

  function byId(id){return document.getElementById(id)}
  function safe(fn,fallback){try{return fn()}catch(e){return fallback}}
  function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]))}
  function slug(s){return String(s||"course").toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")||"course"}
  function cleanName(s){
    return String(s||"").toLowerCase()
      .replace(/\b(golf club|golf course|country club|links|club|course|gc|cub)\b/g," ")
      .replace(/[^a-z0-9]+/g," ")
      .replace(/\s+/g," ")
      .trim();
  }
  function keyForName(name){return slug(cleanName(name)||name)}
  function distance(a,b){
    const lat1=Number(a?.lat),lng1=Number(a?.lng),lat2=Number(b?.lat),lng2=Number(b?.lng);
    if(![lat1,lng1,lat2,lng2].every(Number.isFinite))return Infinity;
    const R=6371000,toRad=x=>x*Math.PI/180;
    const dLat=toRad(lat2-lat1),dLng=toRad(lng2-lng1);
    const s=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
    return 2*R*Math.atan2(Math.sqrt(s),Math.sqrt(1-s));
  }
  function finitePoint(point){
    if(!point)return false;
    const rawLat=point.lat;
    const rawLng=point.lng??point.lon;
    if(rawLat==null||rawLat===""||rawLng==null||rawLng==="")return false;
    return Number.isFinite(Number(rawLat))&&Number.isFinite(Number(rawLng));
  }
  function neutralPoint(point){
    return finitePoint(point)&&Math.abs(Number(point.lat))<0.000001&&Math.abs(Number(point.lng))<0.000001;
  }
  function recentGpsPoint(){
    return safe(()=>{
      const state=window.gdGpsState||{};
      const fix=state.lastFix;
      if(!fix)return null;
      const at=Number(state.lastFixAt||0);
      const recent=Number.isFinite(at)&&at>0&&Date.now()-at<10*60*1000;
      if(!recent)return null;
      if(state.permissionKnown===true&&state.permissionGranted!==true)return null;
      if(fix.simulated===true)return null;
      const source=String(fix.source||"").toLowerCase();
      if(/manual|tap|click|map|green-focus|pin/.test(source))return null;
      const point={lat:Number(fix.lat),lng:Number(fix.lng)};
      return recent&&finitePoint(point)?point:null;
    },null);
  }
  function pickerVisible(){
    const screen=byId("courseScreen");
    if(!screen||screen.classList.contains("hidden"))return false;
    const cs=getComputedStyle(screen);
    return cs.display!=="none"&&cs.visibility!=="hidden";
  }
  function centerPickerMapOnGps(point=recentGpsPoint()){
    if(!finitePoint(point))return false;
    if(!pickerVisible()&&!document.body.classList.contains("gdCoursePickerOpen"))return false;
    return safe(()=>{
      if(typeof map==="undefined"||!map||typeof map.setView!=="function")return false;
      const currentZoom=typeof map.getZoom==="function"?Number(map.getZoom()):NaN;
      const zoom=Number.isFinite(currentZoom)&&currentZoom>=15?currentZoom:16;
      map.setView([Number(point.lat),Number(point.lng)],zoom,{animate:false});
      if(typeof map.invalidateSize==="function"){
        setTimeout(()=>map.invalidateSize(),40);
        setTimeout(()=>map.invalidateSize(),220);
      }
      return true;
    },false);
  }
  function rememberPickerGps(pos){
    const coords=pos&&pos.coords;
    const point={lat:Number(coords&&coords.latitude),lng:Number(coords&&coords.longitude)};
    if(!finitePoint(point))return null;
    window.gdGpsState=window.gdGpsState||{};
    window.gdGpsState.permissionKnown=true;
    window.gdGpsState.permissionGranted=true;
    window.gdGpsState.lastError=null;
    window.gdGpsState.lastFix={lat:point.lat,lng:point.lng,accuracy:Number.isFinite(Number(coords.accuracy))?Number(coords.accuracy):null,source:"course-picker",simulated:false};
    window.gdGpsState.lastFixAt=Date.now();
    centerPickerMapOnGps(point);
    return point;
  }
  function requestPickerGps(){
    if(window.__gdCoursePickerGpsRequestActive||!navigator.geolocation)return false;
    window.__gdCoursePickerGpsRequestActive=true;
    navigator.geolocation.getCurrentPosition(pos=>{
      window.__gdCoursePickerGpsRequestActive=false;
      if(rememberPickerGps(pos))renderNearby();
    },err=>{
      window.__gdCoursePickerGpsRequestActive=false;
      window.gdGpsState=window.gdGpsState||{};
      window.gdGpsState.lastError=err||null;
    },{enableHighAccuracy:true,maximumAge:60000,timeout:9000});
    return true;
  }
  window.gdCoursePickerRequestGps=requestPickerGps;
  window.gdCoursePickerRememberGps=rememberPickerGps;
  window.gdCoursePickerCenterMapOnGps=centerPickerMapOnGps;
  function currentPoint(){
    return safe(()=>{
      if(typeof start!=="undefined"&&start){
        const point={lat:Number(start.lat),lng:Number(start.lng)};
        if(finitePoint(point))return point;
      }
      const gps=recentGpsPoint();
      if(gps)return gps;
      if(typeof map!=="undefined"&&map&&map.getCenter){
        const c=map.getCenter();
        const center={lat:Number(c.lat),lng:Number(c.lng)};
        if(finitePoint(center)&&!neutralPoint(center))return center;
      }
    },null)||null;
  }
  function basePayload(raw){
    const src=raw&&typeof raw==="object"?raw:{};
    const name=String(src.name||src.courseName||"Course").trim()||"Course";
    const rawLat=src.lat??src.courseLat??src.latitude;
    const rawLng=src.lng??src.courseLng??src.longitude??src.lon;
    const rawFinderLat=src.finderLat??src.courseFinderLat;
    const rawFinderLng=src.finderLng??src.courseFinderLng;
    const lat=rawLat===""||rawLat==null?NaN:Number(rawLat);
    const lng=rawLng===""||rawLng==null?NaN:Number(rawLng);
    const finderLat=rawFinderLat===""||rawFinderLat==null?NaN:Number(rawFinderLat);
    const finderLng=rawFinderLng===""||rawFinderLng==null?NaN:Number(rawFinderLng);
    const canonicalKey=src.canonicalKey||keyForName(name);
    return Object.assign({},src,{
      name,
      courseName:name,
      courseId:src.courseId||src.id||canonicalKey,
      canonicalKey,
      courseLat:Number.isFinite(lat)?lat:null,
      courseLng:Number.isFinite(lng)?lng:null,
      finderLat:Number.isFinite(finderLat)?finderLat:null,
      finderLng:Number.isFinite(finderLng)?finderLng:null,
      lat:Number.isFinite(lat)?lat:(Number.isFinite(finderLat)?finderLat:null),
      lng:Number.isFinite(lng)?lng:(Number.isFinite(finderLng)?finderLng:null)
    });
  }
  function readRecentCourses(){
    const rows=safe(()=>JSON.parse(localStorage.getItem(RECENTS_KEY)||"[]"),[])||[];
    return (Array.isArray(rows)?rows:[]).map(item=>{
      const course=basePayload(Object.assign({},item,{source:"recent-course"}));
      course.hasSavedData=false;
      course.hasFinderCoordinate=false;
      return course.name&&!/^manual gps$/i.test(course.name)?course:null;
    }).filter(Boolean);
  }
  function rememberRecentCourse(raw){
    const course=basePayload(raw);
    if(!course.name||/^manual gps$/i.test(course.name))return;
    const row={
      name:course.name,
      courseName:course.name,
      courseId:course.courseId||course.canonicalKey,
      canonicalKey:course.canonicalKey||keyForName(course.name),
      lat:Number.isFinite(Number(course.lat))?Number(course.lat):null,
      lng:Number.isFinite(Number(course.lng))?Number(course.lng):null,
      pickedAt:new Date().toISOString(),
      source:"recent-course"
    };
    const key=String(row.canonicalKey||keyForName(row.name)).toLowerCase();
    const next=[row].concat(readRecentCourses().filter(item=>String(item.canonicalKey||keyForName(item.name)).toLowerCase()!==key)).slice(0,8);
    safe(()=>localStorage.setItem(RECENTS_KEY,JSON.stringify(next)));
  }
  function savedCourses(){
    return readRecentCourses();
  }
  function allLocalCourses(){
    const api=window.GolfDaddyCourseLibrary;
    const libraryKnown=typeof api?.knownCourseCandidates==="function"?safe(()=>api.knownCourseCandidates(),[]): [];
    return KNOWN.concat(libraryKnown||[]).map(basePayload);
  }
  function mergeDedupe(courses,center=currentPoint()){
    const mapByKey=new Map();
    courses.map(basePayload).forEach(course=>{
      if(!course.name||/^manual gps$/i.test(course.name))return;
      const key=course.canonicalKey||keyForName(course.name);
      const existing=mapByKey.get(key);
      course.distanceM=Number.isFinite(Number(course.distanceM))?Number(course.distanceM):distance(center,course);
      if(existing){
        existing.aliases=[...(existing.aliases||[]),...(course.aliases||[]),course.name].filter(Boolean);
        existing.hasSavedData=!!(existing.hasSavedData||course.hasSavedData);
        existing.hasFinderCoordinate=!!(existing.hasFinderCoordinate||course.hasFinderCoordinate);
        if(course.hasSavedData){
          existing.courseId=course.courseId||existing.courseId;
          existing.savedCourseId=course.courseId||existing.savedCourseId;
        }
        if(Number.isFinite(Number(course.finderLat))&&Number.isFinite(Number(course.finderLng))){
          existing.finderLat=course.finderLat;
          existing.finderLng=course.finderLng;
        }
        if(!Number.isFinite(existing.distanceM)||course.distanceM<existing.distanceM){
          existing.lat=course.lat;
          existing.lng=course.lng;
          existing.distanceM=course.distanceM;
        }
        if(existing.source==="remote-search"&&course.source!=="remote-search")existing.source=course.source;
      }else{
        course.canonicalKey=key;
        mapByKey.set(key,course);
      }
    });
    return [...mapByKey.values()];
  }
  function localMatches(query,opts={}){
    const center=currentPoint();
    const q=cleanName(query);
    if(opts.nearbyOnly&&!center)return [];
    return mergeDedupe(allLocalCourses(),center).filter(course=>{
      if(opts.nearbyOnly)return Number.isFinite(course.distanceM)&&course.distanceM<=NEARBY_M;
      if(!q&&!center)return false;
      if(!q)return Number.isFinite(course.distanceM)&&course.distanceM<=NEARBY_M;
      const hay=[course.name,course.courseName,course.courseId,...(course.aliases||[])].map(cleanName).join(" ");
      return hay.includes(q)||q.includes(course.canonicalKey)||course.canonicalKey.includes(q);
    });
  }
  async function remoteMatches(query){
    const q=String(query||"").trim();
    if(q.length<3)return [];
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),4200);
    try{
      const url=`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=${REMOTE_LIMIT}&addressdetails=1&q=${encodeURIComponent(q+" golf course")}`;
      const res=await fetch(url,{signal:controller.signal,headers:{Accept:"application/json"}});
      if(!res.ok)return [];
      const data=await res.json();
      return (Array.isArray(data)?data:[]).map(item=>{
        const first=String(item.name||item.display_name||"").split(",")[0].trim();
        const label=first||q;
        const lat=Number(item.lat),lng=Number(item.lon);
        if(!label||!Number.isFinite(lat)||!Number.isFinite(lng))return null;
        const text=`${label} ${item.display_name||""} ${item.type||""} ${item.class||""}`;
        if(!/golf|course|club|links/i.test(text))return null;
        return basePayload({name:label,lat,lng,source:"remote-search"});
      }).filter(Boolean);
    }catch(e){return []}
    finally{clearTimeout(timer)}
  }
  function rank(courses,query){
    const gps=recentGpsPoint();
    const center=gps||currentPoint();
    const q=cleanName(query);
    return mergeDedupe(courses,center).map(course=>{
      const nameClean=cleanName(course.name);
      let score=100;
      if(q&&nameClean===q)score-=55;
      else if(q&&nameClean.startsWith(q))score-=38;
      else if(q&&nameClean.includes(q))score-=24;
      if(Number.isFinite(course.distanceM))score-=Math.max(0,34-(course.distanceM/130));
      if(course.source==="recent-course")score-=14;
      if(course.source==="known-course"||course.source==="built-in-course")score-=7;
      course.__rank=score;
      return course;
    }).sort((a,b)=>{
      if(gps&&Number.isFinite(a.distanceM)&&Number.isFinite(b.distanceM)){
        const distanceDelta=a.distanceM-b.distanceM;
        if(Math.abs(distanceDelta)>25)return distanceDelta;
      }
      return a.__rank-b.__rank||String(a.name).localeCompare(String(b.name));
    });
  }
  function metaText(course){
    const parts=[];
    if(Number.isFinite(course.distanceM))parts.push(course.distanceM<1000?`${Math.round(course.distanceM)}m away`:`${(course.distanceM/1000).toFixed(1)}km away`);
    if(course.source==="recent-course")parts.push("Recent");
    else if(course.source==="remote-search")parts.push("search result");
    else parts.push("course result");
    return parts.join(" · ");
  }
  function setPayloadOn(element,course){
    if(!element)return;
    element.__gdCoursePayload=course;
    element.dataset.gdCourseName=course.name;
    if(typeof gdCoursePickerSetDatasetPoint==="function")gdCoursePickerSetDatasetPoint(element,course);
    else{
      element.dataset.gdCourseLat=Number.isFinite(Number(course.lat))?String(course.lat):"";
      element.dataset.gdCourseLng=Number.isFinite(Number(course.lng))?String(course.lng):"";
    }
    element.dataset.gdCourseId=course.courseId||"";
  }
  function renderNearby(){
    const option=byId("gdCourseAssumedOption");
    if(!option)return null;
    const center=currentPoint();
    const nearby=rank(localMatches("",{nearbyOnly:true}),"").slice(0,3);
    const courses=nearby.length?nearby:[basePayload({name:"Manual GPS",lat:center?.lat??null,lng:center?.lng??null,source:"manual-gps"})];
    const selected=courses[0];
    setPayloadOn(option,selected);
    option.innerHTML=courses.map((course,idx)=>{
      const detail=metaText(course).replace(/\s*·\s*course result$/,"").replace(/^course result$/,"");
      return `<div class="courseAssumedBlock" role="button" tabindex="0" data-course-key="${esc(course.canonicalKey||course.name)}" data-course-index="${idx}">
        <div class="courseAssumedMain">
          <div class="courseAssumedLabel">${course.name==="Manual GPS"?"Manual mode":"Nearby course"}</div>
          <div class="courseAssumedName"${idx===0?' id="gdCourseAssumedName"':""}>${esc(course.name)}</div>
          <div class="courseAssumedMeta">${esc(course.name==="Manual GPS"?(center?"No saved nearby course. Search to choose one.":"Search or use GPS to choose a course."):detail)}</div>
        </div>
        <button type="button"${idx===0?' id="gdCourseAssumedPlayBtn"':""}>${course.name==="Manual GPS"?"Manual":"Play"}</button>
      </div>`;
    }).join("");
    option.querySelectorAll(".courseAssumedBlock").forEach(block=>{
      const idx=Number(block.dataset.courseIndex);
      const course=courses[idx]||selected;
      setPayloadOn(block,course);
    });
    return selected;
  }
  function selectCourse(raw){
    const course=basePayload(raw);
    course.courseId=course.savedCourseId||course.courseId||course.canonicalKey;
    rememberRecentCourse(course);
    if(typeof window.gdOpenCoursePickerCourse==="function")return window.gdOpenCoursePickerCourse(course);
    if(typeof window.openCourse==="function"&&window.openCourse!==selectCourse)return window.openCourse(course);
    safe(()=>{localStorage.setItem("gd_active_course_v1",JSON.stringify(course));sessionStorage.setItem("gd_assumed_course_name",course.name);});
    byId("courseScreen")?.classList.add("hidden");
    return false;
  }
  window.renderCourses=function(courses){
    const list=byId("courseList");
    if(!list)return;
    renderNearby();
    courses=Array.isArray(courses)?courses:[];
    if(courses.length===1&&courses[0]?.assumedCandidate)courses=[];
    list.innerHTML="";
    courses.forEach(raw=>{
      const c=basePayload(raw);
      const row=document.createElement("div");
      row.className="course";
      setPayloadOn(row,c);
      row.innerHTML=`<div><div class="name">${esc(c.name)}</div><div class="meta">${esc(metaText(c))}</div></div><button class="play" type="button">Play</button>`;
      list.appendChild(row);
    });
    const count=byId("countLine");
    if(count){
      const recentOnly=courses.length&&courses.every(course=>course&&course.source==="recent-course");
      count.textContent=courses.length?(recentOnly?`${courses.length} recent`:`${courses.length} found`):"Search";
    }
  };
  window.manualSearch=function(){
    const q=byId("searchInput")?.value.trim()||"";
    const count=byId("countLine");
    const list=byId("courseList");
    const run=++searchRun;
    if(list)list.innerHTML="";
    renderNearby();
    if(!q){
      window.renderCourses(readRecentCourses());
      return false;
    }
    if(count)count.textContent="Searching";
    const immediate=rank(localMatches(q),q);
    if(immediate.length)window.renderCourses(immediate);
    remoteMatches(q).then(remote=>{
      if(run!==searchRun)return;
      const results=rank(immediate.concat(remote),q).slice(0,12);
      window.renderCourses(results);
      if(count)count.textContent=results.length?`${results.length} found`:"No course found";
    });
    return false;
  };
  const oldRefresh=window.gdRefreshCourseAssumedOption;
  window.gdRefreshCourseAssumedOption=function(course){
    if(course&&course.assumedCandidate&&course.name&&!/^assumed/i.test(course.name))return renderNearby();
    if(typeof oldRefresh==="function")oldRefresh(course);
    return renderNearby();
  };
  window.gdConfirmAssumedCourse=function(event){
    if(event){event.preventDefault?.();event.stopPropagation?.();event.stopImmediatePropagation?.();}
    if(typeof window.gdOpenCoursePickerSelectionFromElement==="function"){
      return window.gdOpenCoursePickerSelectionFromElement(event?.target);
    }
    const option=byId("gdCourseAssumedOption");
    const block=event?.target?.closest?.(".courseAssumedBlock");
    return selectCourse(block?.__gdCoursePayload||option?.__gdCoursePayload||renderNearby());
  };
  window.gdOpenChangeCourse=function(event){
    if(event){event.preventDefault?.();event.stopPropagation?.();event.stopImmediatePropagation?.();}
    window.gdCourseChangeMode="change-course";
    window.__gdCoursePickerReturnTarget="gps";
    safe(()=>{window.__gdCoursePickerChangingAt=Date.now();window.__gdCoursePickerFirstHoleOpenToken=null;window.__gdStableMappedHoleOneLast=null;});
    safe(()=>{if(window.__gdPreLockHoleFrameTimer)clearTimeout(window.__gdPreLockHoleFrameTimer);});
    safe(()=>{if(typeof gdClearMappedStartPromptChrome==="function")gdClearMappedStartPromptChrome();});
    const input=byId("searchInput");
    if(input)input.value="";
    centerPickerMapOnGps();
    requestPickerGps();
    window.renderCourses(readRecentCourses());
    const screen=byId("courseScreen");
    if(screen){
      screen.classList.remove("hidden");
      screen.style.display="flex";
      screen.style.pointerEvents="auto";
    }
    setTimeout(()=>input?.focus(),80);
    return false;
  };
  const oldOpenCoursePickerCourse=window.gdOpenCoursePickerCourse;
  if(typeof oldOpenCoursePickerCourse==="function"&&!oldOpenCoursePickerCourse.__gdRecentCourseWrapped){
    const wrapped=function(course){
      rememberRecentCourse(course);
      return oldOpenCoursePickerCourse.apply(this,arguments);
    };
    wrapped.__gdRecentCourseWrapped=true;
    window.gdOpenCoursePickerCourse=wrapped;
  }
  let activeCourseHoleOneTimer=null;
  function shouldOpenActiveCourseToHoleOne(active,opts){
    const name=String(active?.name||active?.courseName||"").trim();
    if(!name||/^manual gps$/i.test(name))return false;
    if(opts&&(opts.fromBack||opts.preserve||opts.preserveState||opts.fromCoursePicker||opts.keepGps))return false;
    if(safe(()=>typeof gdShouldSkipMappedHoleOneReset==="function"&&gdShouldSkipMappedHoleOneReset(),false))return false;
    if(safe(()=>!!(start||target||lockedFrame),false))return false;
    if(!activeCourseHasMappedPlayData(active,1))return false;
    return true;
  }
  function activeCourseHasMappedPlayData(active,hole){
    const h=Number(hole)||1;
    return safe(()=>typeof window.gdCourseHasMappedGreenFairway==="function"&&window.gdCourseHasMappedGreenFairway(active,h),false);
  }
  function clearUnmappedActiveCourseForPlay(active){
    const name=String(active?.name||active?.courseName||"").trim();
    if(!name||/^manual gps$/i.test(name))return;
    safe(()=>localStorage.removeItem("gd_active_course_v1"));
    safe(()=>sessionStorage.removeItem("gd_assumed_course_name"));
    safe(()=>{window.gdActiveCourse=null;window.currentCourse=null;});
    safe(()=>{currentCourse=null;});
    safe(()=>{
      const line=document.getElementById("courseLine");
      if(line){line.textContent="";line.style.display="none";}
    });
  }
  function scheduleActiveCourseToHoleOne(active,opts){
    if(!shouldOpenActiveCourseToHoleOne(active,opts))return;
    clearTimeout(activeCourseHoleOneTimer);
    activeCourseHoleOneTimer=setTimeout(()=>{
      const stored=safe(()=>JSON.parse(localStorage.getItem("gd_active_course_v1")||"null"),null);
      const course=basePayload(active||stored);
      if(safe(()=>typeof gdShouldSkipMappedHoleOneReset==="function"&&gdShouldSkipMappedHoleOneReset(),false))return;
      if(!shouldOpenActiveCourseToHoleOne(course,{}))return;
      if(typeof window.openCourse==="function")window.openCourse(course);
      else if(typeof window.gdOpenCourseToFirstHole==="function")window.gdOpenCourseToFirstHole(course);
    },180);
  }
  const previousEnterGps=window.enterGpsModule;
  window.enterGpsModule=function(opts){
    const res=typeof previousEnterGps==="function"?previousEnterGps.call(window,opts||{}):false;
    const forcePicker=!!(opts&&opts.forceCoursePicker)||window.gdCourseChangeMode==="change-course";
    if(!(opts&&opts.fromCoursePicker)){
      renderNearby();
      return res;
    }
    const active=(opts&&opts.selectedCourse)||window.__gdLiveCoursePickerSelection||safe(()=>JSON.parse(localStorage.getItem("gd_active_course_v1")||"null"),null);
    if(active&&active.name&&!forcePicker){
      byId("courseScreen")?.classList.add("hidden");
      if(!gdCoursePayloadIsManual(active)){
        if(typeof gdScheduleCoursePickerFirstHoleOpen==="function")gdScheduleCoursePickerFirstHoleOpen(active);
        else scheduleActiveCourseToHoleOne(active,opts||{});
      }
    }
    else renderNearby();
    return res;
  };
  window.gdRefreshCourseAssumedNearby=renderNearby;
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",()=>{renderNearby();window.renderCourses(readRecentCourses());});
  else{renderNearby();window.renderCourses(readRecentCourses());}
})();
