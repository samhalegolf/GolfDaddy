/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  document.getElementById('gdWandDiagBtn')?.remove();
  document.getElementById('gdWandDiagPanel')?.remove();
  window.collectWandDiagnostics=function(){return ''};
  window.showWandDiagnostics=function(){};
  return;
  function ensureDiagUi(){
    if(!document.getElementById('gdWandDiagBtn')){
      const btn=document.createElement('button');
      btn.id='gdWandDiagBtn';
      btn.textContent='Wand Debug';
      btn.onclick=function(e){e.stopPropagation();showWandDiagnostics();};
      document.body.appendChild(btn);
    }
    if(!document.getElementById('gdWandDiagPanel')){
      const p=document.createElement('div');
      p.id='gdWandDiagPanel';
      p.innerHTML='<div class="diagTop"><span>Green Wand diagnostics</span><button onclick="document.getElementById(\'gdWandDiagPanel\').style.display=\'none\'">Close</button></div><div id="gdWandDiagText">No scan yet.</div>';
      document.body.appendChild(p);
    }
  }
  function cssTransformOf(sel){
    const el=document.querySelector(sel);
    if(!el)return 'missing';
    const cs=getComputedStyle(el);
    return cs.transform && cs.transform!=='none' ? cs.transform : 'none';
  }
  function rectOf(sel){
    const el=document.querySelector(sel);
    if(!el)return null;
    const r=el.getBoundingClientRect();
    return {x:+r.x.toFixed(1),y:+r.y.toFixed(1),w:+r.width.toFixed(1),h:+r.height.toFixed(1)};
  }
  function safeLatLngToPt(ll){
    try{return map.latLngToContainerPoint(ll)}catch(e){return null}
  }
  window.collectWandDiagnostics=function(){
    const lines=[];
    const now=new Date().toISOString();
    lines.push('time: '+now);
    lines.push('lockedFrame: '+(typeof lockedFrame!=='undefined'?!!lockedFrame:'unknown'));
    lines.push('greenActive: '+(typeof greenActive!=='undefined'?!!greenActive:'unknown'));
    lines.push('wandMode: '+(typeof wandMode!=='undefined'?wandMode:'unknown'));
    lines.push('greenTolerance/sensitivity: '+(typeof greenTolerance!=='undefined'?Math.round((greenTolerance||0)*100):'unknown'));
    lines.push('zoom: '+(map&&map.getZoom?map.getZoom():'unknown'));
    lines.push('map size: '+JSON.stringify(map&&map.getSize?map.getSize():null));
    lines.push('map rect: '+JSON.stringify(rectOf('#map')));
    lines.push('map css transform: '+cssTransformOf('#map'));
    lines.push('leaflet map-pane transform: '+cssTransformOf('.leaflet-map-pane'));
    lines.push('tile-pane transform: '+cssTransformOf('.leaflet-tile-pane'));
    lines.push('marker-pane transform: '+cssTransformOf('.leaflet-marker-pane'));
    lines.push('overlay-pane transform: '+cssTransformOf('.leaflet-overlay-pane'));
    lines.push('tile count loaded: '+document.querySelectorAll('.leaflet-tile-pane img.leaflet-tile-loaded').length);
    if(typeof wandScaleLock!=='undefined' && wandScaleLock){
      lines.push('scaleLock: '+JSON.stringify({mpp:+wandScaleLock.metersPerPixel.toFixed(4),zoom:wandScaleLock.zoom,centre:wandScaleLock.centre,viewport:wandScaleLock.viewport,reason:wandScaleLock.reason,ageMs:Date.now()-wandScaleLock.createdAt}));
    }else lines.push('scaleLock: none');
    if(typeof greenCentre!=='undefined' && greenCentre){
      const p=safeLatLngToPt(greenCentre);
      lines.push('greenCentre latlng: '+JSON.stringify({lat:+greenCentre.lat.toFixed(7),lng:+greenCentre.lng.toFixed(7)}));
      lines.push('greenCentre containerPoint: '+JSON.stringify(p?{x:+p.x.toFixed(1),y:+p.y.toFixed(1)}:null));
    }else lines.push('greenCentre: none');
    if(typeof target!=='undefined' && target){
      const p=safeLatLngToPt(target);
      lines.push('target containerPoint: '+JSON.stringify(p?{x:+p.x.toFixed(1),y:+p.y.toFixed(1)}:null));
    }
    if(typeof lastWandResult!=='undefined' && lastWandResult){
      lines.push('lastWandResult meta: '+JSON.stringify({source:lastWandResult.source,mode:lastWandResult.modeUsed,label:lastWandResult.label,confidence:lastWandResult.confidence,metersPerPixel:lastWandResult.metersPerPixel,baseRadiusMeters:lastWandResult.baseRadiusMeters,clusterPull:lastWandResult.clusterPull}));
      lines.push('last metrics: '+JSON.stringify(lastWandResult.metrics||{}));
      lines.push('debugCounts: '+JSON.stringify(lastWandResult.debugCounts||{}));
      if(lastWandResult.boundaryPoints && greenCentre){
        const pts=lastWandResult.boundaryPoints.map(p=>L.latLng(p.lat,p.lng));
        const cps=pts.map(safeLatLngToPt).filter(Boolean);
        if(cps.length){
          const cp=safeLatLngToPt(greenCentre);
          const cx=cps.reduce((s,p)=>s+p.x,0)/cps.length;
          const cy=cps.reduce((s,p)=>s+p.y,0)/cps.length;
          const dx=cx-(cp?cp.x:cx), dy=cy-(cp?cp.y:cy);
          const radii=cps.map(p=>Math.hypot(p.x-(cp?cp.x:cx),p.y-(cp?cp.y:cy)));
          const avg=radii.reduce((a,b)=>a+b,0)/radii.length;
          const q={right:[],left:[],up:[],down:[]};
          cps.forEach((p,i)=>{const rx=p.x-(cp?cp.x:cx), ry=p.y-(cp?cp.y:cy), rr=radii[i]; if(rx>0)q.right.push(rr); else q.left.push(rr); if(ry>0)q.down.push(rr); else q.up.push(rr);});
          const avgA=a=>a.length?+(a.reduce((x,y)=>x+y,0)/a.length).toFixed(1):null;
          lines.push('boundary centroid delta px: '+JSON.stringify({dx:+dx.toFixed(1),dy:+dy.toFixed(1),note:'positive dx = visual/right bias'}));
          lines.push('boundary radius px: '+JSON.stringify({avg:+avg.toFixed(1),min:+Math.min(...radii).toFixed(1),max:+Math.max(...radii).toFixed(1)}));
          lines.push('quadrant avg radius px: '+JSON.stringify({right:avgA(q.right),left:avgA(q.left),up:avgA(q.up),down:avgA(q.down),rightMinusLeft:q.right.length&&q.left.length?+(avgA(q.right)-avgA(q.left)).toFixed(1):null}));
        }
      }
    }else lines.push('lastWandResult: none');
    const likely=[];
    const transforms=['.leaflet-map-pane','.leaflet-tile-pane','.leaflet-marker-pane','.leaflet-overlay-pane'].map(cssTransformOf);
    if(transforms.some(t=>t && t!=='none' && !/^matrix\(1, 0, 0, 1,/.test(t))) likely.push('coordinate-frame mismatch likely: Leaflet panes are transformed/rotated, but Wand canvas/seed may be axis-aligned');
    if(typeof lastWandResult!=='undefined' && lastWandResult?.boundaryPoints && typeof greenCentre!=='undefined' && greenCentre){
      // centroid delta warning handled above visually by user screenshot
      likely.push('if dx is consistently positive across modes, the bias is upstream of mode logic, likely seed/canvas/map transform alignment');
    }
    lines.push('read: '+(likely.length?likely.join(' | '):'no obvious warning yet'));
    return lines.join('\n');
  };
  window.showWandDiagnostics=function(){
    ensureDiagUi();
    const p=document.getElementById('gdWandDiagPanel');
    const t=document.getElementById('gdWandDiagText');
    t.textContent=window.collectWandDiagnostics();
    p.style.display='block';
  };
  const oldUpdate=window.updateWandStatus;
  if(typeof oldUpdate==='function'){
    window.updateWandStatus=function(text){
      oldUpdate(text);
      ensureDiagUi();
    };
  }
  setTimeout(ensureDiagUi,500);
})();
