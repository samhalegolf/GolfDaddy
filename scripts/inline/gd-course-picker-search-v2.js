/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  "use strict";
	  const RECENTS_KEY="gd_recent_course_picks_v1";
	  const COURSE_MAPS_API="/api/course-maps";
	  const NEARBY_M=5200;
	  const REMOTE_LIMIT=12;
  const KNOWN=[
    {name:"Akarana Golf Club",courseId:"akarana-golf-club",lat:-36.9174953,lng:174.7400425,source:"known-course",aliases:["akarana golf course","akarana gc"]},
    {name:"Maungakiekie Golf Club",courseId:"maungakiekie-golf-club",lat:-36.9229754,lng:174.7254871,source:"known-course",aliases:["maungakeikei golf club","maungakiekie golf course","maunga gc"]}
	  ];
	  let searchRun=0;
	  let databaseCourseCache=[];
	  let databaseCourseLoadAt=0;
	  let databaseCoursePromise=null;
  const state={
    initialized:false,
    listenersBound:false,
    destroyed:false,
    open:false,
    source:"",
    activeKey:"",
    activeToken:"",
    activePromise:null,
    activeSelection:null,
    lastResult:null,
    lastSearchQuery:"",
    lastNearby:null,
    lastResumePanel:null
  };

  function byId(id){return document.getElementById(id)}
  function safe(fn,fallback){try{return fn()}catch(e){return fallback}}
  function bridge(){return window.GDCoursePickerCoreBridge||{}}
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
  /* Where a course is, in words. "Riverside" is four different clubs in four
     different countries, so a name on its own is not an identification - the
     region and country under it are what let a player pick the right one.

     Region, not town. Nominatim's settlement fields answer "which body
     administers this point", not "what do people call here": reverse geocoding
     the real course database returned Kaipatiki for Takapuna and Puketapapa for
     Akarana, correct local-board names no golfer uses. The state/region field
     gave Auckland, Otago, Waikato, California, Scotland - recognisable, and
     present on every course tried. Matches the key order in
     functions/lib/gd-course-place.mjs, which does the same job server-side. */
  const PLACE_REGION_KEYS=["state","region","state_district","county","city","town","municipality","village"];
  function placeFromAddress(address){
    if(!address||typeof address!=="object")return null;
    const country=String(address.country||"").trim().slice(0,80);
    const countryCode=String(address.country_code||"").trim().slice(0,8).toUpperCase();
    if(!country&&!countryCode)return null;
    let region="";
    for(const key of PLACE_REGION_KEYS){
      region=String(address[key]||"").trim().slice(0,120);
      if(region)break;
    }
    return {region,country,countryCode};
  }
  /* "Auckland, New Zealand", or just the country when the region is unknown, or
     "" when nothing is known - callers render "" as no subtitle rather than a
     stray separator. Falls back to the country code so a course geocoded
     before country names were stored still says something. */
  function placeLabel(course){
    if(!course||typeof course!=="object")return "";
    const region=String(course.region||"").trim();
    const country=String(course.country||"").trim()||String(course.countryCode||"").trim().toUpperCase();
    return [region,country].filter(Boolean).join(", ");
  }
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
    safe(()=>{if(window.GDCourseLocation&&typeof window.GDCourseLocation.propose==="function")window.GDCourseLocation.propose(state.activeSelection||{},Object.assign({source:"course-picker"},point),{source:"course-picker-gps-proposal",realGpsOnly:true,confidence:.45});});
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
      region:String(src.region||"").trim(),
      country:String(src.country||"").trim(),
      countryCode:String(src.countryCode||src.country_code||"").trim().toUpperCase(),
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
      const raw=item&&typeof item==="object"?item:{};
      const course=basePayload({
        name:raw.name,
        courseName:raw.courseName,
        courseId:raw.courseId,
        canonicalKey:raw.canonicalKey,
        lat:raw.lat,
        lng:raw.lng,
        courseLat:raw.courseLat,
        courseLng:raw.courseLng,
        finderLat:raw.finderLat,
        finderLng:raw.finderLng,
        /* Absent on rows written before the subtitle existed. Those show no
           subtitle until the course is picked again, which is honest - we do
           not know where they are and will not guess. */
        region:raw.region,
        country:raw.country,
        countryCode:raw.countryCode,
        source:"recent-course"
      });
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
      region:course.region||"",
      country:course.country||"",
      countryCode:course.countryCode||"",
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
	  function databaseCoursePayload(raw){
	    const course=basePayload({
	      name:raw?.courseName||raw?.name,
	      courseName:raw?.courseName||raw?.name,
	      courseId:raw?.courseId||raw?.id,
	      canonicalKey:raw?.courseId||raw?.canonicalKey,
	      lat:raw?.courseLat??raw?.lat??raw?.finderLat,
	      lng:raw?.courseLng??raw?.lng??raw?.finderLng,
	      courseLat:raw?.courseLat??raw?.lat,
	      courseLng:raw?.courseLng??raw?.lng,
	      finderLat:raw?.finderLat??raw?.courseFinderLat,
	      finderLng:raw?.finderLng??raw?.courseFinderLng,
	      region:raw?.region,
	      country:raw?.country,
	      countryCode:raw?.countryCode??raw?.country_code,
	      source:"database-course"
	    });
	    course.hasDatabaseMap=true;
	    course.databaseCourseId=raw?.id||course.courseId;
	    return course.name&&!/^manual gps$/i.test(course.name)?course:null;
	  }
	  function databaseCoursesFromMaps(maps){
	    return Object.values(maps?.courses||{}).map(databaseCoursePayload).filter(Boolean);
	  }
	  function loadDatabaseCourses(opts={}){
	    if(typeof fetch!=="function")return Promise.resolve(databaseCourseCache.slice());
	    const now=Date.now();
	    if(!opts.force&&databaseCourseCache.length&&now-databaseCourseLoadAt<120000)return Promise.resolve(databaseCourseCache.slice());
	    if(databaseCoursePromise)return databaseCoursePromise;
	    databaseCoursePromise=fetch(COURSE_MAPS_API,{headers:{Accept:"application/json"},cache:"no-store"})
	      .then(res=>res.ok?res.json():null)
	      .then(data=>{
	        databaseCourseCache=databaseCoursesFromMaps(data);
	        databaseCourseLoadAt=Date.now();
	        window.__gdCoursePickerDatabaseCourses=databaseCourseCache.slice();
	        return databaseCourseCache.slice();
	      })
	      .catch(()=>databaseCourseCache.slice())
	      .finally(()=>{databaseCoursePromise=null;});
	    return databaseCoursePromise;
	  }
	  function allLocalCourses(){
	    const api=window.GolfDaddyCourseLibrary;
	    const libraryKnown=typeof api?.knownCourseCandidates==="function"?safe(()=>api.knownCourseCandidates(),[]): [];
	    return KNOWN.concat(libraryKnown||[],databaseCourseCache||[]).map(basePayload);
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
	        existing.hasDatabaseMap=!!(existing.hasDatabaseMap||course.hasDatabaseMap);
	        if(course.databaseCourseId)existing.databaseCourseId=course.databaseCourseId;
	        if(course.hasSavedData){
	          existing.courseId=course.courseId||existing.courseId;
	          existing.savedCourseId=course.courseId||existing.savedCourseId;
	        }
	        if(course.hasDatabaseMap){
	          existing.courseId=course.courseId||existing.courseId;
	          existing.source="database-course";
	        }
        /* First place wins. The same course arriving from search, the database
           and recents should not flicker between two spellings of the same
           town, and a duplicate that knows nothing must not blank out one that
           does. */
        if(!existing.country&&!existing.countryCode&&(course.country||course.countryCode)){
          existing.region=course.region;
          existing.country=course.country;
          existing.countryCode=course.countryCode;
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
        /* addressdetails=1 was already on the request but the address was being
           thrown away - this is the only place in the app that gets a course's
           region and country for free, so it is where they enter the system. */
        const place=placeFromAddress(item.address)||{};
        return basePayload({name:label,lat,lng,region:place.region,country:place.country,countryCode:place.countryCode,source:"remote-search"});
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
	      if(course.source==="database-course"||course.hasDatabaseMap)score-=12;
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
	    /* Region and country lead the line. It is the part that identifies the
	       course rather than describing our relationship to it, and it is what a
	       player scans for when two results share a name. */
	    const place=placeLabel(course);
	    if(place)parts.push(place);
	    if(Number.isFinite(course.distanceM))parts.push(course.distanceM<1000?`${Math.round(course.distanceM)}m away`:`${(course.distanceM/1000).toFixed(1)}km away`);
	    if(course.source==="recent-course")parts.push("Recent");
	    /* No label for a course we already hold a map for. Where the map came
	       from is our concern, not the player's - they only need to recognise
	       the course. The branch stays so these courses do not fall through and
	       get relabelled "search result" or "course result"; ranking still
	       favours them above, which is behaviour rather than a badge. */
	    else if(course.source==="database-course"||course.hasDatabaseMap){/* no badge */}
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
    state.lastNearby=selected;
    return selected;
  }
  function selectCourse(raw){
    return selectCourseForPlay(raw,{source:"picker-select"});
  }
  function normalizeCourse(raw){
    const normalizer=bridge().normalizeCourse;
    const course=typeof normalizer==="function"?normalizer(raw):basePayload(raw);
    return basePayload(course);
  }
  function isManualCourse(course){
    const owned=bridge().isManual;
    return typeof owned==="function"?!!owned(course):/^manual gps$/i.test(String(course?.name||course?.courseName||"").trim());
  }
  function courseHasPoint(course){
    const owned=bridge().hasPoint;
    return typeof owned==="function"?!!owned(course):finitePoint(course);
  }
  function applyStoredPin(course){
    const apply=bridge().applyStoredPin;
    const applied=typeof apply==="function"?normalizeCourse(apply(course)):course;
    const owner=window.GDCourseLocation;
    return owner&&typeof owner.attachToCourse==="function"?normalizeCourse(owner.attachToCourse(applied,{requireConfirmed:false})):applied;
  }
  function selectionKey(course,opts={}){
    const point=opts.fromPinnedSeed?finitePoint(course)&&course:null;
    const seed=point?`:pin:${Number(point.lat).toFixed(5)},${Number(point.lng).toFixed(5)}`:"";
    return `${String(course?.courseId||course?.id||course?.canonicalKey||course?.name||course?.courseName||"course").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")||"course"}:h1${seed}`;
  }
  function mappingController(){
    const controller=window.runCourseMappingAttempt||window.gdRunCourseMappingAttempt;
    return typeof controller==="function"?controller:null;
  }
  function mappingRequest(course,opts={}){
    const now=Date.now();
    const selectedAt=new Date(now).toISOString();
    const pinSeed=!!opts.fromPinnedSeed;
    const owner=window.GDCourseLocation;
    const location=owner&&typeof owner.resolve==="function"?owner.resolve(course,{requireConfirmed:pinSeed||course?.courseLocationConfirmed===true}):null;
    const resolvedCourse=owner&&typeof owner.attachToCourse==="function"?owner.attachToCourse(course,{requireConfirmed:pinSeed||course?.courseLocationConfirmed===true}):course;
    const pinnedCentre=location&&location.centre?{lat:Number(location.centre.lat),lng:Number(location.centre.lng)}:(pinSeed&&finitePoint(resolvedCourse)?{lat:Number(resolvedCourse.lat),lng:Number(resolvedCourse.lng)}:null);
    const library=window.GolfDaddyCourseLibrary||window.ClarityCaddieCourseLibrary||{};
    const snapshotOpts={selectedAt,source:pinSeed?"course-picker-pin-auto-map":"course-picker-auto-map"};
    if(pinnedCentre)snapshotOpts.courseCentre=pinnedCentre;
    const mappingCourse=typeof library.mappingCourseSnapshot==="function"?library.mappingCourseSnapshot(resolvedCourse,snapshotOpts):resolvedCourse;
    return {
      course:mappingCourse,
      courseCentre:pinnedCentre||undefined,
      hole:1,
      wholeCourse:true,
      showLoading:true,
      fresh:true,
      allowLocalSavedMap:course?.gdDatabaseMapAvailable===true,
      acceptPartialGeneratedMap:pinSeed,
      selectedAt,
      reason:pinSeed?"course-picker-pin":"course-picker"
    };
  }
  function setMappingStatus(result){
    try{
      document.body.dataset.gdCourseAutoMapStatus=result&&result.stale?"stale":result&&(result.playable||result.fallback)?"done":"empty";
      document.body.dataset.gdCourseAutoMappedHoles=String(result?.holes||result?.persisted?.holes||0);
      document.body.dataset.gdCourseAutoMapSaved=String(result?.saved||result?.persisted?.saved||0);
      document.body.dataset.gdCourseNeedsPin=result&&result.fallback?"active":result&&result.playable?"no":"pending";
    }catch(e){}
  }
  function closePickerSurface(reason){
    if(window.GDShell&&typeof window.GDShell.closeCoursePicker==="function"){
      if(reason==="course-picker-mapping")window.GDShell.openCoursePicker({source:reason,replace:true});
      else window.GDShell.closeCoursePicker({reason:reason||"course-picker-owner",to:"gps"});
    }
    safe(()=>{document.body.dataset.gdCoursePickerClosedBy=String(reason||"course-picker-owner");});
    safe(()=>{window.__gdCoursePickerPinPromptActive=false;});
    state.open=false;
  }
  function prepareMappingSurface(course,opts={}){
    const b=bridge();
    if(typeof b.hidePin==="function")b.hidePin();
    closePickerSurface("course-picker-mapping");
    if(typeof b.prepareMappingSurface==="function")b.prepareMappingSurface(course,opts);
    else{
      if(typeof b.resetPresentationReadiness==="function")b.resetPresentationReadiness(course,{forceScanner:!!opts.fromPinnedSeed});
      if(typeof b.storeSelection==="function")b.storeSelection(course);
    }
  }
  /* The paid-access gate for GPS rounds.
   *
   * gd-gps-play-runtime-owner-v1.js was the only place in the codebase that
   * enforced gps_round_start, and it was deleted with the old play system, so
   * from that commit until now anyone could open a round for free. This is that
   * same check restored, not a new policy: same permission key, same resolver,
   * same message. It sits here rather than inside /app/ because this is where
   * entry is decided and where clarity-permissions.js is already loaded - the
   * play surface stays free of billing code.
   *
   * Fails CLOSED, matching the original: the resolver is the source of truth and
   * a check that could not complete is not evidence of access. The two failure
   * messages are kept distinct because they need different answers from the
   * player - "buy access" versus "try again".
   */
  var GPS_ROUND_START_PERMISSION_KEY="gps_round_start";
  function gpsStartPermission(){
    if(!(window.ClarityPermissions&&typeof window.ClarityPermissions.canUse==="function")){
      return Promise.resolve({allowed:false,reasons:["PERMISSIONS_HELPER_MISSING"]});
    }
    return window.ClarityPermissions.canUse(GPS_ROUND_START_PERMISSION_KEY,{route:"gps_round_start",resourceId:"gps-entry"});
  }
  function enterGpsPlay(course,result,opts={}){
    if(!(result&&result.playable))return false;
    state.lastResult=result;
    /* Resuming a round already in progress bypasses the gate, exactly as the old
       owner's shouldBypassGpsRoundStartPermission did - a player whose access
       lapsed mid-round is not locked out of the holes they are standing on. */
    if(opts.fromResume||opts.fromBack||opts.preserveState){
      navigateToAppPlay(course);
      return true;
    }
    gpsStartPermission().then(function(check){
      if(check&&check.allowed){navigateToAppPlay(course);return;}
      if(typeof toast==="function")toast("Start gate: active paid access is required for GPS rounds");
    }).catch(function(){
      if(typeof toast==="function")toast("Start gate check failed. Try again.");
    });
    return true;
  }
  /* index.html is named explicitly rather than relying on directory-index
     resolution, because the native shells do not do it. Both Capacitor local
     servers treat a path with no file extension as an SPA route and serve the
     BUNDLE ROOT index.html instead - iOS in Router.swift ("if there's no path
     extension it also means the path is empty or a SPA route"), Android in
     WebViewLocalServer's html5mode branch, which is on by default. So "/app/"
     re-entered the old shell on a phone while working perfectly in every
     browser and in CI, which is why nothing caught it. */
  function navigateToAppPlay(course){
    const parts=[];
    if(course.courseId)parts.push("courseId="+encodeURIComponent(course.courseId));
    if(course.courseName)parts.push("courseName="+encodeURIComponent(course.courseName));
    if(Number.isFinite(course.courseLat))parts.push("courseLat="+encodeURIComponent(course.courseLat));
    if(Number.isFinite(course.courseLng))parts.push("courseLng="+encodeURIComponent(course.courseLng));
    window.location.href="/app/index.html?"+parts.join("&");
  }
  function localSavedPlayable(course){
    const has=bridge().hasMappedPlayData;
    return typeof has==="function"&&!!has(course,1);
  }
  function invokeMappingOnce(course,opts={}){
    const key=selectionKey(course,opts);
    if(state.activePromise&&state.activeKey===key)return state.activePromise;
    const controller=mappingController();
    const token=`${Date.now()}-${Math.random()}`;
    state.activeKey=key;
    state.activeToken=token;
    state.activeSelection=course;
    try{
      window.__gdCoursePickerOwnsOpenResolverUntil=Date.now()+45000;
      document.body.dataset.gdCourseAutoMapStatus=opts.fromPinnedSeed?"checking_pin_seed":"running";
      document.body.dataset.gdCourseScannerSeed=opts.fromPinnedSeed?"pin":"course";
      document.body.dataset.gdCoursePickerOwner="GDCoursePicker";
    }catch(e){}
    prepareMappingSurface(course,opts);
    if(typeof controller!=="function"){
      try{document.body.dataset.gdCourseAutoMapStatus="controller_unavailable";document.body.dataset.gdCourseNeedsPin="pending";}catch(e){}
      return false;
    }
    const request=mappingRequest(course,opts);
    const promise=Promise.resolve(controller(request))
      .then(result=>{
        if(state.activeToken!==token)return Object.assign({},result,{stale:true});
        state.lastResult=result||null;
        setMappingStatus(result);
        if(result&&result.playable)enterGpsPlay(course,result,opts);
        return result;
      })
      .catch(error=>{
        if(state.activeToken===token){
          try{document.body.dataset.gdCourseAutoMapStatus="error";document.body.dataset.gdCourseNeedsPin="pending";}catch(e){}
        }
        throw error;
      })
      .finally(()=>{if(state.activeToken===token)state.activePromise=null;});
    state.activePromise=promise;
    return promise;
  }
  function selectCourseForPlay(raw,opts={}){
    let course=normalizeCourse(raw);
    course.courseId=course.savedCourseId||course.courseId||course.canonicalKey;
    course=applyStoredPin(course);
    if(window.GDCourseLocation&&typeof window.GDCourseLocation.attachToCourse==="function")course=normalizeCourse(window.GDCourseLocation.attachToCourse(course,{requireConfirmed:false}));
    rememberRecentCourse(course);
    state.activeSelection=course;
    safe(()=>{window.__gdLiveCoursePickerSelection=course;window.__gdLiveCoursePickerSelectionAt=Date.now();});
    if(!course.gdDatabaseMapChecked&&!isManualCourse(course)){
      const token=`${Date.now()}-${Math.random()}`;
      state.activeToken=token;
      safe(()=>{
        document.body.dataset.gdCourseNeedsPin="checking_database_map";
        document.body.dataset.gdCourseNeedsPinCourse=course.courseId||course.canonicalKey||course.name||"";
        document.body.dataset.gdCoursePinDecision="checking-database-map";
      });
      const checker=bridge().databaseMapAvailable;
      Promise.resolve(typeof checker==="function"?checker(course):{available:false,attempted:false,reason:"database-map-check-unavailable"})
        .then(result=>{
          if(state.activeToken!==token)return false;
          const hasDatabaseMap=!!(result&&result.available);
          safe(()=>{document.body.dataset.gdCourseDatabaseMapAvailable=hasDatabaseMap?"yes":"no";document.body.dataset.gdCourseDatabaseMapSource=result&&result.source||result&&result.reason||"";});
          return selectCourseForPlay(Object.assign({},course,{gdDatabaseMapChecked:true,gdDatabaseMapAvailable:hasDatabaseMap,gdDatabaseMapSource:result&&result.source||""}),Object.assign({},opts,{source:"database-map-checked"}));
        })
        .catch(error=>{
          if(state.activeToken!==token)return false;
          safe(()=>{document.body.dataset.gdCourseDatabaseMapAvailable="error";document.body.dataset.gdCourseDatabaseMapSource=error&&error.message||"database-map-check-error";});
          return selectCourseForPlay(Object.assign({},course,{gdDatabaseMapChecked:true,gdDatabaseMapAvailable:false}),Object.assign({},opts,{source:"database-map-error"}));
        });
      return false;
    }
    const usePinSeed=!course.gdDatabaseMapAvailable&&course.courseLocationConfirmed===true&&courseHasPoint(course);
    safe(()=>{
      window.__gdCoursePickerChangingAt=0;
      window.__gdCoursePickerFirstHoleOpenToken=null;
      window.gdCourseChangeMode="";
      if(!isManualCourse(course))window.__gdCoursePickerOwnsOpenResolverUntil=Date.now()+45000;
      localStorage.removeItem("gd_active_course_v1");
    });
    const needsPin=bridge().needsCoursePin;
    if(typeof needsPin==="function"&&needsPin(course)){
      const showPin=bridge().showPin;
      return typeof showPin==="function"?showPin(course):false;
    }
    if(isManualCourse(course)){
      if(typeof bridge().hidePin==="function")bridge().hidePin();
      closePickerSurface("manual-gps-selected");
      const manualOpen=bridge().openManualCourse;
      return typeof manualOpen==="function"?manualOpen(course):false;
    }
    if(course.gdDatabaseMapAvailable===true&&localSavedPlayable(course)){
      if(typeof bridge().hidePin==="function")bridge().hidePin();
      closePickerSurface("saved-playable-course");
      setMappingStatus({playable:true,holes:0,saved:0});
      return enterGpsPlay(course,{playable:true,course,source:"saved-playable-course"},opts);
    }
    return invokeMappingOnce(course,Object.assign({},opts,{fromPinnedSeed:usePinSeed}));
  }
  function renderCoursesOwner(courses){
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
  }
  function searchOwner(query){
    const q=byId("searchInput")?.value.trim()||"";
    const requested=query==null?q:String(query||"").trim();
    if(query!=null){
      const input=byId("searchInput");
      if(input)input.value=requested;
    }
    const count=byId("countLine");
    const list=byId("courseList");
    const run=++searchRun;
    if(list)list.innerHTML="";
    renderNearby();
    state.lastSearchQuery=requested;
	    if(!requested){
	      renderCoursesOwner(readRecentCourses());
	      loadDatabaseCourses().then(()=>{renderNearby();if(run===searchRun)renderCoursesOwner(readRecentCourses());});
	      return false;
	    }
	    if(count)count.textContent="Searching";
	    const immediate=rank(localMatches(requested),requested);
	    if(immediate.length)renderCoursesOwner(immediate);
	    Promise.all([loadDatabaseCourses(),remoteMatches(requested)]).then(([,remote])=>{
	      if(run!==searchRun)return;
	      const results=rank(localMatches(requested).concat(remote),requested).slice(0,12);
	      renderCoursesOwner(results);
	      if(count)count.textContent=results.length?`${results.length} found`:"No course found";
	    });
    return false;
  }
  const oldRefreshAssumedOption=window.gdRefreshCourseAssumedOption;
  function refreshAssumedOptionOwner(course){
    if(course&&course.assumedCandidate&&course.name&&!/^assumed/i.test(course.name))return renderNearby();
    if(typeof oldRefreshAssumedOption==="function")oldRefreshAssumedOption(course);
    return renderNearby();
  }
  function confirmAssumedCourseOwner(event){
    if(event){event.preventDefault?.();event.stopPropagation?.();event.stopImmediatePropagation?.();}
    const option=byId("gdCourseAssumedOption");
    const block=event?.target?.closest?.(".courseAssumedBlock");
    return selectCourseForPlay(block?.__gdCoursePayload||option?.__gdCoursePayload||renderNearby(),{source:"assumed-course"});
  }
  function openOwner(opts={}){
    const event=opts&&opts.preventDefault?opts:opts.event;
    if(event){event.preventDefault?.();event.stopPropagation?.();event.stopImmediatePropagation?.();}
    state.open=true;
    state.source=opts.source||"change-course";
    window.gdCourseChangeMode=opts.mode||"change-course";
    window.__gdCoursePickerReturnTarget=opts.returnTarget||"gps";
    safe(()=>{window.__gdCoursePickerChangingAt=Date.now();window.__gdCoursePickerFirstHoleOpenToken=null;window.__gdStableMappedHoleOneLast=null;});
    safe(()=>{if(window.__gdPreLockHoleFrameTimer)clearTimeout(window.__gdPreLockHoleFrameTimer);});
    safe(()=>{if(typeof gdClearMappedStartPromptChrome==="function")gdClearMappedStartPromptChrome();});
    safe(()=>{
      if(window.GDShell&&typeof window.GDShell.openCoursePicker==="function"){
        window.GDShell.openCoursePicker({source:state.source,returnTarget:window.__gdCoursePickerReturnTarget,replace:!!opts.replace});
      }
      document.body.classList.remove("gdToolRailOpen","gdCourseOpening","gdCoursePinPromptActive");
      [
        "gdCourseNeedsPin",
        "gdCourseNeedsPinCourse",
        "gdCoursePinDecision",
        "gdCourseDatabaseMapAvailable",
        "gdCourseDatabaseMapSource",
        "gdCourseAutoMapStatus",
        "gdCourseAutoMappedHoles",
        "gdCourseAutoMapSaved",
        "gdCourseScannerSeed"
      ].forEach(key=>delete document.body.dataset[key]);
      window.__gdCoursePickerPinPromptActive=false;
    });
    const input=byId("searchInput");
    if(input)input.value="";
	    centerPickerMapOnGps();
	    requestPickerGps();
	    renderCoursesOwner(readRecentCourses());
	    loadDatabaseCourses().then(()=>{renderNearby();if(!(input&&input.value.trim()))renderCoursesOwner(readRecentCourses());});
    setTimeout(()=>input?.focus(),80);
    resumeRound({renderOnly:true,source:state.source});
    return false;
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
      if(!isManualCourse(active)){
        if(typeof gdScheduleCoursePickerFirstHoleOpen==="function")gdScheduleCoursePickerFirstHoleOpen(active);
        else scheduleActiveCourseToHoleOne(active,opts||{});
      }
    }
    else renderNearby();
    return res;
  };
  function resumeRound(opts={}){
    if(opts&&opts.event){opts.event.preventDefault?.();opts.event.stopPropagation?.();opts.event.stopImmediatePropagation?.();}
    const panel=typeof window.gdEnsureResumeRoundPicker==="function"?window.gdEnsureResumeRoundPicker():null;
    state.lastResumePanel=panel||null;
    if(opts.renderOnly)return panel;
    if(typeof window.gdResumeRoundFromPicker==="function")return window.gdResumeRoundFromPicker(opts.event||opts);
    return false;
  }
  function closeOwner(opts={}){
    const event=opts&&opts.preventDefault?opts:opts.event;
    if(event){event.preventDefault?.();event.stopPropagation?.();event.stopImmediatePropagation?.();}
    if(opts.cancelPending!==false){
      state.activeToken=`cancelled-${Date.now()}-${Math.random()}`;
      state.activePromise=null;
    }
    if(typeof bridge().hidePin==="function")bridge().hidePin();
    closePickerSurface(opts.reason||"course-picker-close");
    return false;
  }
  function bindListeners(){
    if(state.listenersBound)return true;
    state.listenersBound=true;
    const screen=byId("courseScreen");
    if(screen&&!screen.__gdCoursePickerOwnerBound){
      screen.__gdCoursePickerOwnerBound=true;
      screen.addEventListener("click",event=>{
        const target=event.target&&event.target.closest&&event.target.closest("#gdCourseAssumedOption .courseAssumedBlock,#courseScreen .course");
        if(!target)return;
        event.preventDefault();
        event.stopPropagation();
        if(event.stopImmediatePropagation)event.stopImmediatePropagation();
        return selectCourseForPlay(target.__gdCoursePayload||target,{source:"picker-list-click"});
      },false);
      screen.addEventListener("keydown",event=>{
        if((event.key!=="Enter"&&event.key!==" ")||!event.target?.closest?.("#gdCourseAssumedOption .courseAssumedBlock,#courseScreen .course"))return;
        event.preventDefault();
        return selectCourseForPlay(event.target.closest("#gdCourseAssumedOption .courseAssumedBlock,#courseScreen .course").__gdCoursePayload,{source:"picker-list-key"});
      },false);
    }
    const input=byId("searchInput");
    if(input&&!input.__gdCoursePickerSearchBound){
      input.__gdCoursePickerSearchBound=true;
      input.addEventListener("keydown",event=>{if(event.key==="Enter")searchOwner();});
    }
    return true;
  }
  function init(){
    if(state.destroyed)return false;
    bindListeners();
    state.initialized=true;
    renderNearby();
    renderCoursesOwner(readRecentCourses());
    loadDatabaseCourses().then(()=>{renderNearby();renderCoursesOwner(readRecentCourses());});
    return true;
  }
  function destroy(){
    closeOwner({reason:"destroy"});
    state.destroyed=true;
    return true;
  }
  function getState(){
    return Object.assign({},state,{
      activeSelection:state.activeSelection?Object.assign({},state.activeSelection):null,
      activePromise:!!state.activePromise
    });
  }
  function selectionFromElement(element){
    const payloadFromCore=bridge().payloadFromSelectionElement;
    if(typeof payloadFromCore==="function")return payloadFromCore(element);
    const target=element?.closest?.("#gdCourseAssumedOption .courseAssumedBlock,#courseScreen .course");
    return target?.__gdCoursePayload||renderNearby();
  }
  const api={
    init,
    open:openOwner,
    close:closeOwner,
    search:searchOwner,
    renderCourses:renderCoursesOwner,
    refreshNearby:renderNearby,
    refreshAssumed:refreshAssumedOptionOwner,
    requestLocation:requestPickerGps,
    rememberLocation:rememberPickerGps,
    centerMapOnLocation:centerPickerMapOnGps,
    selectCourse:selectCourseForPlay,
    selectFromElement:function(element,opts={}){return selectCourseForPlay(selectionFromElement(element),Object.assign({source:"selection-element"},opts||{}));},
    resumeRound,
    getState,
    destroy
  };
  window.GDCoursePicker=api;
  window.renderCourses=function(courses){return api.renderCourses(courses);};
  window.manualSearch=function(query){return api.search(query);};
  window.gdRefreshCourseAssumedOption=function(course){return api.refreshAssumed(course);};
  window.gdRefreshCourseAssumedNearby=function(){return api.refreshNearby();};
  window.gdConfirmAssumedCourse=function(event){
    if(event){event.preventDefault?.();event.stopPropagation?.();event.stopImmediatePropagation?.();}
    return api.selectFromElement(event?.target,{source:"assumed-course"});
  };
  window.gdOpenChangeCourse=function(event){return api.open({event,source:"change-course",returnTarget:"gps"});};
  window.gdOpenCoursePickerCourse=function(course){return api.selectCourse(course,{source:"legacy-global"});};
  window.gdOpenCoursePickerSelectionFromElement=function(element){return api.selectFromElement(element);};
  window.gdCoursePickerRequestGps=function(){return api.requestLocation();};
  window.gdCoursePickerRememberGps=function(pos){return api.rememberLocation(pos);};
  window.gdCoursePickerCenterMapOnGps=function(point){return api.centerMapOnLocation(point);};
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});
  else init();
})();
