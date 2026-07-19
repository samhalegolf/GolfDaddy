/* ============================================================================
 * GPS SCORECARD OWNER (Phase B, 2026-07-19).
 * Owns scorecard state, rendering, score entry, totals, and scorecard aliases.
 * ============================================================================ */
(function(){
  "use strict";
  if(window.__gdGpsScorecardOwnerV1)return;
  window.__gdGpsScorecardOwnerV1=true;

  const GD_SCORECARD_CACHE_KEY="gd_course_website_scorecards_v3";
  const GD_SCORECARD_SHELL_SOURCE="18-hole scoring shell";
  const GD_SCORECARD_DEFAULT_TEES=["Red","Yellow","White","Blue","Black"];
  const GD_SCORECARD_WEBSITE_SOURCES=[
    {match:/akarana/i,name:"Akarana Golf Club",baseUrl:"https://www.akaranagolf.co.nz",holeListPath:"/hole-by-hole",detailIdStart:2296381,seedHoles:[
      {hole:1,par:5,index:16,metres:401},{hole:2,par:4,index:18,metres:254},{hole:3,par:3,index:14,metres:156},{hole:4,par:4,index:12,metres:299},{hole:5,par:3,index:10,metres:144},{hole:6,par:4,index:2,metres:343},
      {hole:7,par:4,index:4,metres:376},{hole:8,par:3,index:8,metres:155},{hole:9,par:4,index:6,metres:371},{hole:10,par:5,index:11,metres:459},{hole:11,par:3,index:13,metres:136},{hole:12,par:5,index:3,metres:462},
      {hole:13,par:4,index:1,metres:355},{hole:14,par:4,index:5,metres:354},{hole:15,par:4,index:9,metres:327},{hole:16,par:3,index:17,metres:156},{hole:17,par:4,index:7,metres:353},{hole:18,par:4,index:15,metres:310}
    ]}
  ];
  var sessionTee = window.sessionTee || "White";
  var selectedHole = Number(window.selectedHole || 1) || 1;
  var gdScoreHolePickerOpen = true;
  var queuedNextHole = null;
  var scorecard = window.scorecard || {courseKey:"",courseName:"",source:"none",sourceUrl:"",loading:false,error:"",holes:[]};
  window.scorecard = scorecard;

  function safe(fn, fallback){try{return fn()}catch(e){return fallback}}
  function setGlobal(name,value){try{window[name]=value;}catch(e){} try{Function("value", name+"=value")(value);}catch(e){}}
  function getCurrentPlayingHole(){return Number(safe(function(){return currentPlayingHole}, window.currentPlayingHole)||window.currentPlayingHole||0)||null}
  function setCurrentPlayingHole(value){setGlobal("currentPlayingHole", value);}
  function call(name){
    var fn=window[name]||safe(function(){return Function("return typeof "+name+"==='function'&&"+name)()},null);
    if(typeof fn!=="function")return undefined;
    return fn.apply(window,Array.prototype.slice.call(arguments,1));
  }
  function emitScorecardEvent(name, detail){
    safe(function(){
      document.dispatchEvent(new CustomEvent(name,{detail:detail||{}}));
    });
  }
  function setText(id,value){var el=document.getElementById(id);if(el)el.textContent=value}
  function syncGlobals(){setGlobal("sessionTee", sessionTee);setGlobal("selectedHole", selectedHole);setGlobal("scorecard", scorecard);}
  function syncFromGlobals(){
    sessionTee=window.sessionTee||sessionTee;
    selectedHole=Number(window.selectedHole||selectedHole)||1;
  }

function gdScorecardNormalizeName(name){return String(name||"").trim().replace(/\s+/g," ")}
function gdScorecardCourseKey(course){const name=gdScorecardNormalizeName(course?.name||course?.clubName||"");return name?name.toLowerCase():""}
function gdScorecardCourseCandidate(value,source=""){
  const name=gdScorecardNormalizeName(value?.name||value?.courseName||value?.clubName||value);
  if(!name||name==="Manual GPS"||/assumed course/i.test(name))return null;
  if(value&&typeof value==="object")return Object.assign({},value,{name,courseName:name,scorecardSource:source||value.scorecardSource||value.source||""});
  return {name,courseName:name,scorecardSource:source};
}
function gdScorecardConfirmedCourse(){
  const candidates=[typeof currentCourse!=="undefined"?currentCourse:null,window.currentCourse,window.gdActiveCourse];
  try{if(typeof window.gdActiveCourseForMode==="function")candidates.push(window.gdActiveCourseForMode())}catch(e){}
  candidates.push(document.body?.dataset?.gdActiveCourseName,window.gdActiveCourseDisplayName,document.getElementById("courseLine")?.textContent,sessionStorage.getItem("gd_assumed_course_name"));
  try{candidates.push(JSON.parse(localStorage.getItem("gd_active_course_v1")||"null"))}catch(e){}
  for(const candidate of candidates){
    const course=gdScorecardCourseCandidate(candidate,"gps-active-course");
    if(course)return course;
  }
  return null;
}
function gdScorecardReadCache(){try{return JSON.parse(localStorage.getItem(GD_SCORECARD_CACHE_KEY)||"{}")||{}}catch(e){return {}}}
function gdScorecardWriteCache(cache){try{localStorage.setItem(GD_SCORECARD_CACHE_KEY,JSON.stringify(cache||{}))}catch(e){}}
function gdScorecardSourceForCourse(course){
  const name=gdScorecardNormalizeName(course?.name||course?.clubName||"");
  return GD_SCORECARD_WEBSITE_SOURCES.find(s=>s.match.test(name))||null;
}
function gdScorecardWebsiteCandidates(course){
  const list=[];
  const known=gdScorecardSourceForCourse(course);
  if(known)list.push(known);
  const raw=[course?.website,course?.url,course?.site,course?.homepage].filter(Boolean);
  raw.forEach(url=>list.push({name:gdScorecardNormalizeName(course?.name),baseUrl:String(url).replace(/\/+$/,"")}));
  const name=gdScorecardNormalizeName(course?.name||"").toLowerCase();
  if(name){
    const slug=name.replace(/\bgolf club\b|\bgolf course\b|\bthe\b/g,"").replace(/[^a-z0-9]+/g,"").trim();
    if(slug){
      list.push({name:gdScorecardNormalizeName(course?.name),baseUrl:`https://www.${slug}golf.co.nz`});
      list.push({name:gdScorecardNormalizeName(course?.name),baseUrl:`https://${slug}golf.co.nz`});
    }
  }
  gdScorecardGpsAppCandidates(course).forEach(source=>list.push(source));
  return list.filter((item,index,arr)=>item.baseUrl&&arr.findIndex(x=>x.baseUrl===item.baseUrl)===index);
}
function gdScorecardSlugVariants(course){
  const name=gdScorecardNormalizeName(course?.name||course?.courseName||course?.clubName||"").toLowerCase();
  if(!name)return [];
  const base=name.replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"");
  const variants=new Set([base]);
  if(/\bgolf-club\b/.test(base))variants.add(base.replace(/\bgolf-club\b/,"golf-course"));
  if(/\bgolf-course\b/.test(base))variants.add(base.replace(/\bgolf-course\b/,"golf-club"));
  variants.add(base.replace(/-golf-(club|course)$/,""));
  return [...variants].filter(Boolean);
}
function gdScorecardGpsAppCandidates(course){
  return gdScorecardSlugVariants(course).map(slug=>({
    name:gdScorecardNormalizeName(course?.name),
    provider:"Golfify",
    sourceKind:"gps-app",
    baseUrl:`https://www.golfify.io/courses/${slug}`
  }));
}
function gdScorecardCleanText(text){return String(text||"").replace(/&nbsp;/gi," ").replace(/\s+/g," ").trim()}
function gdScorecardText(el){return gdScorecardCleanText(el?.textContent||"")}
function gdScorecardMarkerKey(name){
  const key=gdScorecardCleanText(name).replace(/\s+C$/i,"");
  return key?key.charAt(0).toUpperCase()+key.slice(1).toLowerCase():"";
}
function gdScorecardShell(course,reason){
  const courseName=gdScorecardNormalizeName(course?.name||course?.clubName||"Confirmed course");
  return {
    courseKey:gdScorecardCourseKey(course),
    courseName,
    source:"shell",
    sourceUrl:"",
    error:reason||"",
    holes:Array.from({length:18},(_,i)=>({hole:i+1,par:null,index:null,metres:null,score:null,putts:null,tees:{}}))
  };
}
function gdScorecardEnsureHoleSlots(course){
  if(!Array.isArray(scorecard.holes))scorecard.holes=[];
  if(scorecard.holes.length>=18)return scorecard.holes;
  const shell=gdScorecardShell(course||gdScorecardConfirmedCourse()||{name:scorecard.courseName||"Confirmed course"},"Scorecard slots ready");
  const byHole=new Map((scorecard.holes||[]).map(h=>[Number(h.hole),h]));
  scorecard.holes=shell.holes.map(row=>Object.assign({},row,byHole.get(Number(row.hole))||{}));
  return scorecard.holes;
}
function gdScorecardHoleAt(hole,course){
  const h=Number(hole)||1;
  gdScorecardEnsureHoleSlots(course);
  return scorecard.holes[h-1]||null;
}
function gdScorecardMergeScores(nextHoles,previousHoles){
  const previous=new Map((previousHoles||[]).map(h=>[Number(h.hole),h]));
  return (nextHoles||[]).map(h=>{
    const old=previous.get(Number(h.hole));
    if(!old)return h;
    return Object.assign({},h,{
      score:old.score!=null?old.score:h.score,
      putts:old.putts!=null?old.putts:h.putts
    });
  });
}
function gdScorecardSeed(source,course,reason){
  if(!Array.isArray(source?.seedHoles)||source.seedHoles.length!==18)return null;
  const holes=source.seedHoles.map(h=>({hole:h.hole,par:h.par,index:h.index??null,metres:h.metres??null,score:null,putts:null,tees:{White:{par:h.par,index:h.index??null,metres:h.metres??null,gender:"M"}},sourceUrl:`${source.baseUrl}${source.holeListPath||""}`}));
  return {courseKey:gdScorecardCourseKey(course),courseName:gdScorecardNormalizeName(course?.name)||source.name,source:"seed",sourceUrl:source.baseUrl,holes,error:reason||""};
}
function gdScorecardDistanceCount(holes){
  return (holes||[]).filter(h=>{
    const tee=h?.tees?.[sessionTee]||h?.tees?.White||h?.tees?.Blue||null;
    return Number.isFinite(Number(h?.metres??h?.distanceM??tee?.metres??tee?.distanceM));
  }).length;
}
async function gdFetchScorecardText(url){
  try{
    const res=await fetch(url,{mode:"cors",credentials:"omit",cache:"no-store",headers:{"Accept":"text/html,application/xhtml+xml"}});
    if(!res.ok)throw new Error(`Website returned ${res.status}`);
    return await res.text();
  }catch(directError){
    const proxy=await fetch("/api/scorecard-fetch",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url})});
    let payload=null;
    try{payload=await proxy.json()}catch(e){}
    if(!proxy.ok||!payload?.html)throw new Error(payload?.error||directError?.message||"Scorecard source unavailable");
    return payload.html;
  }
}
function gdParseAkaranaHole(html,hole,sourceUrl){
  const doc=new DOMParser().parseFromString(html,"text/html");
  const rows=[...doc.querySelectorAll("tr[class*='course-marker']")];
  const tees={};
  rows.forEach(row=>{
    const cells=[...row.querySelectorAll("td")].map(gdScorecardText);
    if(cells.length<5)return;
    const marker=gdScorecardMarkerKey(cells[0]);
    if(!marker||/ C$/i.test(cells[0]))return;
    const gender=/women/i.test(row.className)?"W":"M";
    if(gender!=="M"&&tees[marker])return;
    const par=parseInt(cells[2],10), index=parseInt(cells[3],10), metres=parseInt(cells[4],10);
    if(!Number.isFinite(par))return;
    tees[marker]={par,index:Number.isFinite(index)?index:null,metres:Number.isFinite(metres)?metres:null,gender};
  });
  const preferred=tees[sessionTee]||tees.White||tees.Blue||Object.values(tees)[0]||null;
  if(!preferred)return null;
  return {hole,par:preferred.par,index:preferred.index,metres:preferred.metres,score:null,putts:null,tees,sourceUrl};
}
function gdParseSimpleParHoles(html,sourceUrl){
  const doc=new DOMParser().parseFromString(html,"text/html");
  const rawText=String(doc.body?.innerText||doc.body?.textContent||"");
  const text=gdScorecardCleanText(rawText);
  const lines=rawText.split(/\n+/).map(gdScorecardCleanText).filter(Boolean);
  const holes=new Map();
  function addHole(row){
    if(!row||!(row.hole>=1&&row.hole<=18)||!(row.par>=3&&row.par<=6))return;
    const existing=holes.get(row.hole)||{};
    const tees=Object.assign({},existing.tees||{},row.tees||{});
    const preferred=tees[sessionTee]||tees.White||tees.Blue||tees.Yellow||Object.values(tees)[0]||null;
    holes.set(row.hole,Object.assign({},existing,row,{
      index:row.index??existing.index??null,
      metres:row.metres??preferred?.metres??existing.metres??null,
      tees,
      score:null,
      putts:null,
      sourceUrl
    }));
  }
  function addNumericScorecardRow(hole,values){
    if(!(hole>=1&&hole<=18)||values.length<7)return;
    const tees={
      Black:{par:values[6],index:values[5],metres:values[0],gender:"M"},
      Blue:{par:values[6],index:values[5],metres:values[1],gender:"M"},
      White:{par:values[6],index:values[5],metres:values[2],gender:"M"},
      Yellow:{par:values[6],index:values[5],metres:values[3],gender:"M"},
      Red:{par:values[6],index:values[5],metres:values[4],gender:"M"}
    };
    const preferred=tees[sessionTee]||tees.White||tees.Blue||tees.Yellow||Object.values(tees)[0]||null;
    addHole({hole,par:values[6],index:values[5],metres:preferred?.metres??null,tees});
  }
  function addTourHoleText(hole,par,body){
    const tees={};
    String(body||"").replace(/\b([A-Za-z][A-Za-z ]{0,20})\s+(\d{2,4})\s*(m|metres?|meters?|yds?|yards?)\b/gi,(_,tee,value,unit)=>{
      const marker=gdScorecardMarkerKey(tee);
      if(!marker)return "";
      const raw=parseInt(value,10);
      if(!Number.isFinite(raw))return "";
      const metres=/^y/i.test(unit)?Math.round(raw*.9144):raw;
      tees[marker]={par,index:null,metres,gender:"M"};
      return "";
    });
    const stroke=String(body||"").match(/\bstroke\s*(\d{1,2})\b/i);
    const preferred=tees[sessionTee]||tees.White||tees.Blue||tees.Yellow||Object.values(tees)[0]||null;
    addHole({hole,par,index:stroke?parseInt(stroke[1],10):null,metres:preferred?.metres??null,tees});
  }
  doc.querySelectorAll("h1,h2,h3,h4").forEach(header=>{
    const title=gdScorecardText(header);
    const m=title.match(/\bhole\s*(\d{1,2})\b/i);
    if(!m)return;
    const hole=parseInt(m[1],10);
    const container=header.parentElement||header;
    let block=gdScorecardText(container);
    if(!/\bpar\s*\d\b/i.test(block)&&container.nextElementSibling)block+=" "+gdScorecardText(container.nextElementSibling);
    const parMatch=block.match(/\bpar\s*(\d)\b/i);
    if(!parMatch)return;
    addTourHoleText(hole,parseInt(parMatch[1],10),block);
  });
  lines.forEach(line=>{
    const m=line.match(/^(\d{1,2})\s+((?:\d{2,4}\s+){5,}\d{1,2}\s+\d)(?:\s|$)/);
    if(!m)return;
    const hole=parseInt(m[1],10);
    const values=(m[2].match(/\d+/g)||[]).map(value=>parseInt(value,10));
    addNumericScorecardRow(hole,values);
  });
  const fullScorecardIndex=text.toLowerCase().indexOf("full scorecard");
  if(fullScorecardIndex>=0){
    const scorecardText=text.slice(fullScorecardIndex);
    const rowPattern=/\b([1-9]|1[0-8])\s+((?:\d{2,4}\s+){5,}\d{1,2}\s+\d)(?=\s+(?:[1-9]|1[0-8]|out|in|total)\b)/gi;
    let rowMatch;
    while((rowMatch=rowPattern.exec(scorecardText))){
      addNumericScorecardRow(parseInt(rowMatch[1],10),(rowMatch[2].match(/\d+/g)||[]).map(value=>parseInt(value,10)));
    }
  }
  const tourPattern=/hole\s*(\d{1,2})\s*(?:[-–—][^-–—]*)?\s+par\s*(\d)\s*(?:[-–—]\s*)?([\s\S]*?)(?=hole\s*\d{1,2}\s*(?:[-–—]|\s+par)|$)/gi;
  let tourMatch;
  while((tourMatch=tourPattern.exec(text))){
    const hole=parseInt(tourMatch[1],10), par=parseInt(tourMatch[2],10), body=tourMatch[3]||"";
    addTourHoleText(hole,par,body);
  }
  const patterns=[
    /hole\s*(\d{1,2})\D{0,80}?par\s*(\d)/gi,
    /par\s*(\d)\D{0,80}?hole\s*(\d{1,2})/gi
  ];
  patterns.forEach((pattern,patternIndex)=>{
    let match;
    while((match=pattern.exec(text))){
      const hole=patternIndex===0?parseInt(match[1],10):parseInt(match[2],10);
      const par=patternIndex===0?parseInt(match[2],10):parseInt(match[1],10);
      if(hole>=1&&hole<=18&&par>=3&&par<=6&&!holes.has(hole))addHole({hole,par,index:null,metres:null,tees:{}});
    }
  });
  doc.querySelectorAll("table tr,.hole,.course-hole,[class*='hole']").forEach(row=>{
    const cells=[...row.querySelectorAll("th,td")].map(gdScorecardText).filter(Boolean);
    if(cells.length>=8&&/^\d{1,2}$/.test(cells[0])){
      const hole=parseInt(cells[0],10);
      const values=cells.slice(1).map(value=>parseInt(value,10)).filter(value=>Number.isFinite(value));
      addNumericScorecardRow(hole,values);
    }
    const rowText=gdScorecardCleanText(row.innerText||row.textContent||"");
    const m=rowText.match(/hole\s*(\d{1,2}).{0,80}?par\s*(\d)/i)||rowText.match(/\b(\d{1,2})\b.{0,80}?par\s*(\d)/i);
    if(!m)return;
    const hole=parseInt(m[1],10), par=parseInt(m[2],10);
    const tees={};
    rowText.replace(/\b(white|blue|yellow|red|black)\s+(\d{2,4})\s*(m|metres?|meters?|yds?|yards?)\b/gi,(_,tee,value,unit)=>{
      const marker=gdScorecardMarkerKey(tee);
      const raw=parseInt(value,10);
      if(marker&&Number.isFinite(raw))tees[marker]={par,index:null,metres:/^y/i.test(unit)?Math.round(raw*.9144):raw,gender:"M"};
      return "";
    });
    const direct=rowText.match(/\b(?:distance|length)\D{0,20}(\d{2,4})\s*(m|metres?|meters?|yds?|yards?)\b/i);
    const directMetres=direct?(/^y/i.test(direct[2])?Math.round(parseInt(direct[1],10)*.9144):parseInt(direct[1],10)):null;
    if(hole>=1&&hole<=18&&par>=3&&par<=6)addHole({hole,par,index:null,metres:Number.isFinite(directMetres)?directMetres:null,tees});
  });
  return Array.from({length:18},(_,i)=>holes.get(i+1)).filter(Boolean);
}
async function gdTryGenericWebsiteScorecard(source,course){
  const paths=[source.holeListPath||"", "/hole-by-hole", "/scorecard", "/course-scorecard", "/tour", "/course", "/golf/course"];
  for(const path of paths){
    const url=`${source.baseUrl}${path}`;
    try{
      const html=await gdFetchScorecardText(url);
      let holes=gdParseSimpleParHoles(html,url);
      if(holes.length===18)return {courseKey:gdScorecardCourseKey(course),courseName:gdScorecardNormalizeName(course?.name)||source.name,source:source.sourceKind||"website",provider:source.provider||source.name||"",sourceUrl:url,holes,error:""};
      const doc=new DOMParser().parseFromString(html,"text/html");
      const links=[...doc.querySelectorAll("a[href]")].map(a=>a.getAttribute("href")).filter(h=>/hole|score|course-hole-details/i.test(h||"")).slice(0,24);
      const linked=[];
      for(const href of links){
        const detailUrl=new URL(href,source.baseUrl).href;
        const detailHtml=await gdFetchScorecardText(detailUrl);
        linked.push(...gdParseSimpleParHoles(detailHtml,detailUrl));
      }
      const byHole=new Map(linked.map(h=>[h.hole,h]));
      holes=Array.from({length:18},(_,i)=>byHole.get(i+1)).filter(Boolean);
      if(holes.length===18)return {courseKey:gdScorecardCourseKey(course),courseName:gdScorecardNormalizeName(course?.name)||source.name,source:source.sourceKind||"website",provider:source.provider||source.name||"",sourceUrl:url,holes,error:""};
    }catch(e){}
  }
  throw new Error("No readable 18-hole par list found on course website");
}
async function gdLoadAkaranaScorecard(source,course){
  const holes=[];
  for(let i=0;i<18;i++){
    const url=`${source.baseUrl}/course-hole-details?HoleID=${source.detailIdStart+i}`;
    const html=await gdFetchScorecardText(url);
    const hole=gdParseAkaranaHole(html,i+1,url);
    if(hole)holes.push(hole);
  }
  if(holes.length!==18||holes.some(h=>!Number.isFinite(Number(h.par))))throw new Error("Course website did not provide 18 holes with par");
  return {courseKey:gdScorecardCourseKey(course),courseName:gdScorecardNormalizeName(course?.name)||source.name,source:source.sourceKind||"website",provider:source.provider||source.name||"",sourceUrl:source.baseUrl,holes,error:""};
}
async function gdLoadWebsiteScorecard(source,course){
  if(source.detailIdStart){
    try{return await gdLoadAkaranaScorecard(source,course)}catch(e){}
  }
  return await gdTryGenericWebsiteScorecard(source,course);
}
async function gdEnsureScorecardForCourse(course){
  const key=gdScorecardCourseKey(course);
  if(!key)return;
  if(scorecard.courseKey===key&&scorecard.holes.length)return;
  const cache=gdScorecardReadCache();
  if(cache[key]?.holes?.length){
    Object.assign(scorecard,cache[key],{loading:false});
    return;
  }
  const sources=gdScorecardWebsiteCandidates(course);
  const loadingShell=gdScorecardShell(course,"Loading course website scorecard");
  Object.assign(scorecard,{courseKey:key,courseName:gdScorecardNormalizeName(course?.name),source:"loading",sourceUrl:"",loading:true,error:"",holes:loadingShell.holes});
  renderScorecard();
  try{
    if(!sources.length)throw new Error("No course website scorecard source found");
    let loaded=null,lastError=null,seed=null,loadedSources=[];
    for(const source of sources){
      try{
        const candidate=await gdLoadWebsiteScorecard(source,course);
        loadedSources.push(candidate);
        if(!loaded)loaded=candidate;
      }catch(e){lastError=e;if(!seed)seed=gdScorecardSeed(source,course,e?.message)}
    }
    if(loadedSources.length){
      const sortedSources=loadedSources.slice().sort((a,b)=>gdScorecardDistanceCount(b.holes)-gdScorecardDistanceCount(a.holes)||((b.holes||[]).length-(a.holes||[]).length));
      const sourceRows=loadedSources.map(source=>({
        source:source.source||"",
        provider:source.provider||"",
        sourceUrl:source.sourceUrl||"",
        holes:source.holes||[]
      }));
      loaded=Object.assign({},sortedSources[0],{scorecardSources:sourceRows});
    }
    if(!loaded&&seed)loaded=seed;
    if(!loaded)throw lastError||new Error("No readable course scorecard found");
    loaded.holes=gdScorecardMergeScores(loaded.holes,scorecard.holes);
    Object.assign(scorecard,loaded,{loading:false});
    cache[key]=loaded;
    gdScorecardWriteCache(cache);
  }catch(e){
    const shell=gdScorecardShell(course,e?.message||"Course website scorecard was not available");
    shell.holes=gdScorecardMergeScores(shell.holes,scorecard.holes);
    Object.assign(scorecard,shell,{loading:false});
    cache[key]=shell;
    gdScorecardWriteCache(cache);
  }
  selectedHole=Math.max(1,Math.min(scorecard.holes.length||18,Number(selectedHole)||1));
  renderScorecard();
}
function gdScorecardHoleView(h){
  const tee=h?.tees?.[sessionTee]||h?.tees?.White||h?.tees?.Blue||null;
  return Object.assign({},h,tee||{});
}
function gdScorecardKnownNumber(value){
  if(value===null||value===undefined||String(value).trim()==="")return null;
  const n=Number(value);
  return Number.isFinite(n)?n:null;
}
function gdScorecardAvailableTees(){
  const tees=new Set();
  (scorecard.holes||[]).forEach(h=>Object.keys(h.tees||{}).forEach(t=>tees.add(t)));
  const found=[...tees].filter(Boolean);
  return found.length?found:GD_SCORECARD_DEFAULT_TEES;
}
function gdRenderScorecardTeeSelect(){
  const select=document.getElementById("teeSelect");
  if(!select)return;
  const tees=gdScorecardAvailableTees();
  if(!tees.includes(sessionTee))sessionTee=tees.includes("White")?"White":tees[0];
  select.innerHTML=tees.map(t=>`<option value="${t}">${t}</option>`).join("");
  select.value=sessionTee;
}
function gdToggleScoreHolePicker(event){
  if(event){event.preventDefault();event.stopPropagation();}
  gdScoreHolePickerOpen=!gdScoreHolePickerOpen;
  renderScorecard();
  return false;
}
function openScorecard(){
  syncFromGlobals();
  const course=gdScorecardConfirmedCourse();
  gdScoreHolePickerOpen=true;
  safe(function(){
    if(document.body.classList.contains("gdGpsActive")||document.body.classList.contains("shell-gps"))sessionStorage.setItem("gd_return_from_scorecard","gps");
  });
  if(!course){
    Object.assign(scorecard,{courseKey:"",courseName:"",source:"none",sourceUrl:"",loading:false,error:"",holes:[]});
    renderScorecard();
    call("openPanel","scorePanel");
    call("toast","Confirm a course before using the scorecard");
    return;
  }
  call("openPanel","scorePanel");
  gdEnsureScorecardForCourse(course);
  emitScorecardEvent("gd:scorecard-open",{hole:selectedHole,course:course});
}
function renderScorecard(){
  syncFromGlobals();
  const panel=document.getElementById("scorePanel");
  const course=gdScorecardConfirmedCourse();
  const courseName=scorecard.courseName||gdScorecardNormalizeName(course?.name)||"No course selected";
  const hasCourse=!!courseName&&courseName!=="No course selected";
  const hasHoles=Array.isArray(scorecard.holes)&&scorecard.holes.length>0;
  panel?.classList.toggle("gdScoreEmptyMode",!hasCourse||(!scorecard.loading&&!hasHoles));
  panel?.classList.toggle("gdScoreShell",scorecard.source==="shell");
  panel?.classList.toggle("gdScoreHolePickerClosed",!gdScoreHolePickerOpen);
  setText("scoreCourse",hasCourse?courseName:"Course scorecard");
  setText("gdScoreCourseName",courseName);
  setText("gdScoreCourseLabel",scorecard.source==="website"?"Course website scorecard":scorecard.source==="gps-app"?"GPS app scorecard":scorecard.source==="seed"?"Saved course website card":scorecard.source==="shell"?"Score entry":"Confirmed course");
  const teeSource=gdScorecardAvailableTees()===GD_SCORECARD_DEFAULT_TEES?"Default tees":"Course tees";
  setText("gdScoreCourseMeta",scorecard.loading?"Loading scorecard from course website...":scorecard.source==="website"||scorecard.source==="gps-app"?`Pulled from ${scorecard.sourceUrl} · ${teeSource}`:scorecard.source==="seed"?`From saved course website data · ${teeSource}`:scorecard.source==="shell"?"Course website card unavailable. Using 18 empty score slots with default tees.":"Confirm a course to load a scorecard.");
  const empty=document.getElementById("gdScoreEmpty");
  if(empty)empty.textContent=scorecard.loading?"Loading scorecard from course website...":hasCourse?"No scorecard data is available for this course yet.":"Confirm a course first, then the scorecard can load.";
  gdRenderScorecardTeeSelect();
  const pickerToggle=document.getElementById("gdScoreHolePickerToggle");
  const pickerCurrent=document.getElementById("gdScoreHolePickerCurrent");
  if(pickerToggle)pickerToggle.setAttribute("aria-expanded",gdScoreHolePickerOpen?"true":"false");
  if(pickerCurrent)pickerCurrent.textContent=`H${selectedHole||1}`;
  const strip=document.getElementById("holeStrip");
  if(strip){
    strip.innerHTML="";
    scorecard.holes.forEach(h=>{const b=document.createElement("button");b.className="holePill"+(h.hole===selectedHole?" active":"")+(h.score!=null?" scored":"")+(h.hole===getCurrentPlayingHole()?" playing":"");b.textContent=h.hole;b.setAttribute("aria-label",`Play hole ${h.hole}`);b.onclick=()=>{selectedHole=h.hole;gdScoreHolePickerOpen=false;playSelectedHole()};strip.appendChild(b)});
  }
  const h=hasCourse?gdScorecardHoleAt(selectedHole,course):scorecard.holes[selectedHole-1];
  if(!h){
    setText("scoreTitle","Hole 1");
    setText("scoreMeta","No scorecard loaded");
    setText("holeScore","-");
    return;
  }
  const hv=gdScorecardHoleView(h), parts=[];
  const par=gdScorecardKnownNumber(hv.par);
  if(par!==null)parts.push(`Par ${par}`);
  setText("scoreTitle",`Hole ${h.hole}`);
  setText("scoreMeta",parts.length?`${sessionTee} tee · ${parts.join(" · ")}`:`${sessionTee} tee · Hole number only`);
  setText("holeScore",h.score??"-");
  emitScorecardEvent("gd:scorecard-render",{hole:selectedHole,scorecard:scorecard});
}
function playSelectedHole(){syncFromGlobals();const h=gdScorecardHoleAt(selectedHole);if(!h){call("toast","Select a course before choosing a hole");return false}const hv=gdScorecardHoleView(h);const par=gdScorecardKnownNumber(hv.par);setCurrentPlayingHole(h.hole);try{sessionStorage.setItem("gd_active_playing_hole",String(h.hole));sessionStorage.setItem("gd_mapper_active_hole",String(h.hole));}catch(e){}try{window.gdRememberPlayingHole?.(h.hole)}catch(e){}setHole(par!==null?{hole:h.hole,par}:{hole:h.hole});call("setState",`Hole ${h.hole}`);renderScorecard();try{window.gdSyncPlayFlowRail?.()}catch(e){}emitScorecardEvent("gd:scorecard-play-selected",{hole:h.hole,par:par});return true}
function setHole(h){const el=document.getElementById("holeLine");const skipRefresh=!!window.__gdHoleFrameSwitching;if(!h){if(el)el.style.display="none";try{if(!skipRefresh&&typeof gdV62Refresh==="function")setTimeout(gdV62Refresh,20)}catch(e){};return}const par=gdScorecardKnownNumber(typeof h==="object"?h.par:null);if(el){el.style.display="inline";el.textContent=par!==null?`Hole ${h.hole} · Par ${par}`:`Hole ${h.hole}`;}try{if(!skipRefresh&&typeof gdV62Refresh==="function")setTimeout(gdV62Refresh,20)}catch(e){}}
function gdPersistCurrentScorecard(){const key=scorecard.courseKey;if(!key)return;const cache=gdScorecardReadCache();cache[key]=Object.assign({},scorecard,{loading:false});gdScorecardWriteCache(cache)}
function adjustHoleScore(d){syncFromGlobals();const h=gdScorecardHoleAt(selectedHole);if(!h){call("toast","No hole selected");return}const hv=gdScorecardHoleView(h);const par=gdScorecardKnownNumber(hv.par);if(h.score==null)h.score=par??0;h.score=Math.max(0,h.score+d);gdPersistCurrentScorecard();renderScorecard()}
function adjustHolePutts(d){syncFromGlobals();const h=gdScorecardHoleAt(selectedHole);if(!h){call("toast","No hole selected");return}if(h.putts==null)h.putts=2;h.putts=Math.max(0,h.putts+d);gdPersistCurrentScorecard();renderScorecard()}
function saveHoleScore(){syncFromGlobals();const h=gdScorecardHoleAt(selectedHole);if(!h){call("toast","Select a course before saving a hole");return}const hv=gdScorecardHoleView(h);const par=gdScorecardKnownNumber(hv.par);if(h.score==null)h.score=par??0;setGlobal("gdManualScoreOverride",false);setGlobal("gdScorecardHasDrivenScore",true);setGlobal("playerScore",calculateTotal());gdPersistCurrentScorecard();call("updateScore");renderScorecard();call("gdPanelBack","scorePanel");emitScorecardEvent("gd:scorecard-save",{hole:h.hole,par:par,nextHole:queuedNextHole,scorecard:scorecard});if(queuedNextHole){const next=queuedNextHole;queuedNextHole=null;setTimeout(function(){if(window.gdSetActiveHoleFrame)window.gdSetActiveHoleFrame(next,{source:"score-save-next"});},180)}}
Object.assign(window,{gdScorecardConfirmedCourse,gdEnsureScorecardForCourse,openScorecard,renderScorecard,saveHoleScore,playSelectedHole,setHole,adjustHoleScore,adjustHolePutts});


  function getState(){return {scorecard:scorecard,sessionTee:sessionTee,selectedHole:selectedHole,currentPlayingHole:getCurrentPlayingHole(),queuedNextHole:queuedNextHole,total:calculateTotal()};}
  function calculateTotal(){return (scorecard.holes||[]).reduce(function(sum,h){var xv=gdScorecardHoleView(h);var p=gdScorecardKnownNumber(xv.par);return sum+(h.score!=null&&p!==null?Number(h.score)-p:0);},0);}
  function setHoleScore(hole,value){var row=gdScorecardHoleAt(hole||selectedHole);if(!row)return false;row.score=Math.max(0,Number(value)||0);gdPersistCurrentScorecard();renderScorecard();return row;}
  function syncCurrentHole(hole,options){options=options||{};selectedHole=Math.max(1,Math.min((scorecard.holes&&scorecard.holes.length)||18,Number(hole||selectedHole)||1));syncGlobals();if(options.play)return playSelectedHole();renderScorecard();return selectedHole;}
  function reset(){scorecard.holes=gdScorecardEnsureHoleSlots().map(function(row){return Object.assign({},row,{score:null,putts:null});});queuedNextHole=null;gdPersistCurrentScorecard();renderScorecard();return getState();}
  function destroy(){queuedNextHole=null;return true;}
  function queueNextHole(hole){queuedNextHole=Number(hole)||null;renderScorecard();return queuedNextHole;}
  function bind(){
    if(document.__gdGpsScorecardOwnerBound)return true;
    document.__gdGpsScorecardOwnerBound=true;
    return true;
  }

  var GDGpsScorecard={init:function(){syncGlobals();bind();renderScorecard();return getState();},render:renderScorecard,getState:getState,setHoleScore:setHoleScore,syncCurrentHole:syncCurrentHole,reset:reset,destroy:destroy,open:openScorecard,close:function(){return safe(function(){return gdPanelBack("scorePanel")},false)},queueNextHole:queueNextHole,calculateTotal:calculateTotal,ensureForCourse:gdEnsureScorecardForCourse,holeView:gdScorecardHoleView,knownNumber:gdScorecardKnownNumber};
  window.GDGpsScorecard=GDGpsScorecard;
  Object.assign(window,{gdScorecardConfirmedCourse:gdScorecardConfirmedCourse,gdEnsureScorecardForCourse:gdEnsureScorecardForCourse,openScorecard:openScorecard,renderScorecard:renderScorecard,saveHoleScore:saveHoleScore,playSelectedHole:playSelectedHole,setHole:setHole,adjustHoleScore:adjustHoleScore,adjustHolePutts:adjustHolePutts,gdScorecardHoleView:gdScorecardHoleView,gdScorecardKnownNumber:gdScorecardKnownNumber,gdToggleScoreHolePicker:gdToggleScoreHolePicker});
  syncGlobals();
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",GDGpsScorecard.init,{once:true});
  else setTimeout(GDGpsScorecard.init,0);
})();
