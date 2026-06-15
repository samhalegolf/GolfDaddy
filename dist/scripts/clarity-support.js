(function(){
  var MAX_ERRORS = 12;
  var errors = [];
  var lastAction = null;

  function nowIso(){
    try{return new Date().toISOString();}catch(e){return "";}
  }

  function safe(fn, fallback){
    try{return fn();}catch(e){return fallback;}
  }

  function truncate(value, limit){
    var text = String(value || "");
    return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
  }

  function pushError(source, message, extra){
    errors.push({
      time: nowIso(),
      source: source,
      message: truncate(message, 600),
      extra: extra ? truncate(extra, 600) : ""
    });
    if(errors.length > MAX_ERRORS) errors = errors.slice(errors.length - MAX_ERRORS);
  }

  function hookErrors(){
    var oldError = console.error;
    console.error = function(){
      pushError("console.error", Array.prototype.map.call(arguments, function(item){
        return typeof item === "string" ? item : safe(function(){return JSON.stringify(item);}, String(item));
      }).join(" "), "");
      return oldError.apply(console, arguments);
    };
    window.addEventListener("error", function(event){
      pushError("window.error", event.message || "Script error", event.filename ? event.filename + ":" + event.lineno : "");
    });
    window.addEventListener("unhandledrejection", function(event){
      pushError("unhandledrejection", event.reason && (event.reason.message || event.reason) || "Unhandled promise rejection", "");
    });
  }

  function storageSummary(storage){
    var rows = [];
    if(!storage) return rows;
    for(var i = 0; i < storage.length; i++){
      var key = storage.key(i);
      if(!key || !/^gd_|^clarity/i.test(key)) continue;
      var raw = storage.getItem(key) || "";
      var parsedType = "string";
      safe(function(){
        var parsed = JSON.parse(raw);
        parsedType = Array.isArray(parsed) ? "array" : typeof parsed;
      }, null);
      rows.push({
        key: key,
        bytes: raw.length,
        type: parsedType
      });
    }
    return rows.sort(function(a, b){return a.key.localeCompare(b.key);});
  }

  function activeCourseLabel(){
    return safe(function(){
      var visible = document.querySelector(".badgeCourse,.courseAssumedName,.gdCourseCurrent strong");
      if(visible && visible.textContent.trim()) return visible.textContent.trim();
      var active = JSON.parse(localStorage.getItem("gd_active_course_v1") || "null");
      return active && (active.name || active.courseName) || "";
    }, "");
  }

  function currentRoute(){
    return safe(function(){
      var body = document.body;
      if(body.classList.contains("shell-home")) return "home";
      if(body.classList.contains("shell-gps")) return "gps";
      var open = document.querySelector(".modulePanel.open,.panel.open");
      return open ? open.id : location.pathname + location.hash;
    }, location.pathname + location.hash);
  }

  function buildContext(){
    return {
      build: window.ClarityBuild || {},
      route: currentRoute(),
      url: location.href,
      pageTitle: document.title || "",
      timestamp: nowIso(),
      userAgent: navigator.userAgent,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1
      },
      activeCourseLabel: activeCourseLabel(),
      lastAction: lastAction,
      localStorageSummary: safe(function(){return storageSummary(window.localStorage);}, []),
      sessionStorageSummary: safe(function(){return storageSummary(window.sessionStorage);}, []),
      recentErrors: errors.slice()
    };
  }

  function describeTarget(target){
    if(!target) return "";
    var label = target.getAttribute("aria-label") || target.title || target.textContent || target.id || target.className || target.tagName;
    return truncate(String(label).replace(/\s+/g, " ").trim(), 160);
  }

  function hookActions(){
    document.addEventListener("click", function(event){
      var target = event.target && event.target.closest ? event.target.closest("button,a,input,select,textarea,[onclick]") : event.target;
      lastAction = {
        time: nowIso(),
        type: "click",
        target: describeTarget(target)
      };
    }, true);
  }

  function render(){
    if(document.getElementById("claritySupportButton")) return;
    var button = document.createElement("button");
    button.id = "claritySupportButton";
    button.className = "claritySupportButton";
    button.type = "button";
    button.title = "Support";
    button.setAttribute("aria-label", "Support");
    button.textContent = "?";

    var flag = document.createElement("button");
    flag.id = "clarityBetaFlag";
    flag.className = "clarityBetaFlag";
    flag.type = "button";
    flag.title = "Beta build · send debug report";
    flag.setAttribute("aria-label", "Beta build, send debug report");
    flag.innerHTML = '<span>β</span><small>report</small>';

    var overlay = document.createElement("div");
    overlay.id = "claritySupportOverlay";
    overlay.className = "claritySupportOverlay";
    overlay.innerHTML = [
      '<div class="claritySupportSheet" role="dialog" aria-modal="true" aria-labelledby="claritySupportTitle">',
      '<div class="claritySupportHead"><div><strong id="claritySupportTitle">Beta report</strong><span>Email a short note with safe debug context so the issue can be reproduced later.</span></div><button class="claritySupportClose" type="button" aria-label="Close beta report">×</button></div>',
      '<form class="claritySupportForm" id="claritySupportForm">',
      '<label>What happened<textarea id="claritySupportHappened" required maxlength="1200"></textarea></label>',
      '<label>What you expected<textarea id="claritySupportExpected" maxlength="1200"></textarea></label>',
      '<label>Your contact optional<input id="claritySupportContact" maxlength="240" autocomplete="email"></label>',
      '<div class="claritySupportMeta" id="claritySupportMeta"></div>',
      '<div class="claritySupportActions"><button type="button" class="claritySupportCloseAction">Cancel</button><button type="submit" class="primary">Email report</button></div>',
      '<div class="claritySupportStatus" id="claritySupportStatus" role="status"></div>',
      '</form>',
      '</div>'
    ].join("");

    document.body.append(button, flag, overlay);
    button.addEventListener("click", open);
    flag.addEventListener("click", open);
    overlay.querySelector(".claritySupportClose").addEventListener("click", close);
    overlay.querySelector(".claritySupportCloseAction").addEventListener("click", close);
    overlay.addEventListener("click", function(event){if(event.target === overlay) close();});
    overlay.querySelector("form").addEventListener("submit", submit);
  }

  function open(){
    var overlay = document.getElementById("claritySupportOverlay");
    var meta = document.getElementById("claritySupportMeta");
    var context = buildContext();
    meta.textContent = "Build " + (context.build.buildId || "unknown") + " · " + (context.build.channel || "beta") + " · " + (context.route || "unknown route") + " · " + (context.activeCourseLabel || "no active course");
    overlay.classList.add("open");
    safe(function(){document.getElementById("claritySupportHappened").focus();}, null);
  }

  function close(){
    var overlay = document.getElementById("claritySupportOverlay");
    if(overlay) overlay.classList.remove("open");
  }

  async function submit(event){
    event.preventDefault();
    var status = document.getElementById("claritySupportStatus");
    var payload = {
      happened: document.getElementById("claritySupportHappened").value.trim(),
      expected: document.getElementById("claritySupportExpected").value.trim(),
      contact: document.getElementById("claritySupportContact").value.trim(),
      context: buildContext()
    };
    if(!payload.happened){
      status.className = "claritySupportStatus warn";
      status.textContent = "Add what happened first.";
      return;
    }
    status.className = "claritySupportStatus";
    status.textContent = "Sending…";
    try{
      var res = await fetch("/api/support-ticket", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload)
      });
      var data = await res.json().catch(function(){return {};});
      if(!res.ok) throw new Error(data.error || "Support endpoint unavailable");
      status.className = "claritySupportStatus good";
      var ticket = data.ticketId ? "Ticket " + data.ticketId : "Report received";
      var email = data.emailed ? " · emailed" : (data.emailQueued ? " · email queued" : "");
      status.textContent = ticket + email;
      setTimeout(close, 1100);
    }catch(error){
      status.className = "claritySupportStatus warn";
      status.textContent = "Could not send yet. Your note stayed on this screen.";
      pushError("support-submit", error.message || error, "");
    }
  }

  hookErrors();
  hookActions();
  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", render);
  else render();
  window.ClaritySupport = {
    buildContext: buildContext,
    open: open,
    report: open,
    pushError: pushError
  };
})();


/* --- Clarity Caddie bag hotfix: legacy-safe bag editor + ghost-bag setup support --- */
(function(){
  var win = window;
  function safe(fn, fallback){ try { return fn(); } catch(e) { return fallback; } }
  function esc(value){
    try { return typeof win.gdEscapeHTML === "function" ? win.gdEscapeHTML(value) : String(value == null ? "" : value); }
    catch(e){ return String(value == null ? "" : value); }
  }
  function toast(message){ safe(function(){ if(typeof win.toast === "function") win.toast(message); else console.log(message); }, null); }
  function num(value){ var n = Number(value); return Number.isFinite(n) ? n : 0; }
  function clubName(row){
    if(!row) return "";
    return String(row.club || row.name || row.clubName || row.club_name || row.clubLabel || row.label || row.title || row.id || "").trim();
  }
  function carryValue(row){
    if(!row) return 0;
    var raw = row.baseCarry ?? row.carry ?? row.carryM ?? row.carryMeters ?? row.carryMetres ?? row.carryDistanceM ?? row.carryDistance ?? row.distance ?? row.distanceM ?? row.meters ?? row.metres ?? row.actualDistanceM ?? row.expectedDistanceM ?? row.expectedM ?? row.avgCarryM ?? row.stockCarryM ?? row.stockM ?? row.totalM ?? row.total ?? row.totalDistance ?? row.totalDistanceM ?? row.baseTotal;
    return num(raw);
  }
  function totalValue(row){
    if(!row) return 0;
    return num(row.totalM ?? row.total ?? row.totalMeters ?? row.totalMetres ?? row.totalDistance ?? row.totalDistanceM ?? row.baseTotal);
  }
  function totalFor(club, carry){
    return safe(function(){ return Math.max(carry, Math.round(win.gdBagTotalForCarry(club, carry) || carry)); }, Math.max(carry, Math.round(carry * 1.08)));
  }
  function normalise(row, forcedClub){
    if(!row || row.ghost) return null;
    var source = (typeof row === "object") ? row : { baseCarry: row };
    var club = String(forcedClub || clubName(source) || "").trim();
    var carry = Math.round(carryValue(source) || 0);
    if(!club || carry <= 0) return null;
    var saved = Math.round(totalValue(source) || 0);
    return { club: club, baseCarry: carry, totalM: Math.max(carry, saved > 0 ? saved : totalFor(club, carry)) };
  }
  function collectRows(container){
    var rows = [];
    function add(row, forcedClub){ var n = normalise(row, forcedClub); if(n) rows.push(n); }
    function addSource(source){
      if(Array.isArray(source)){ source.forEach(function(item){ add(item); }); return; }
      if(source && typeof source === "object"){
        Object.keys(source).forEach(function(key){
          var value = source[key];
          if(value && typeof value === "object") add(Object.assign({}, value, { club: value.club || value.name || key }));
          else add({ club: key, baseCarry: value });
        });
      }
    }
    if(container && !container.placeholderProfile){
      [container.bag, container.bagRows, container.clubs, container.clubBag, container.clubDistances, container.distances, container.yardages, container.bagCells, container.clubCells].forEach(addSource);
    }
    var byClub = new Map();
    rows.forEach(function(row){
      var key = row.club.toLowerCase();
      var existing = byClub.get(key);
      if(!existing || row.baseCarry > existing.baseCarry) byClub.set(key, row);
    });
    return Array.from(byClub.values()).sort(function(a,b){ return (b.totalM || b.baseCarry) - (a.totalM || a.baseCarry); });
  }
  function profile(){
    return safe(function(){ return typeof win.ensureProfile === "function" ? win.ensureProfile() : (typeof win.activePlayerProfile === "function" ? win.activePlayerProfile() : null); }, null);
  }
  function storedProfileRows(){
    return safe(function(){
      var raw = JSON.parse(localStorage.getItem("gd_player_profiles_v27") || "{}");
      var profiles = Array.isArray(raw.profiles) ? raw.profiles : [];
      var active = raw.activeId ? profiles.find(function(p){ return p && p.id === raw.activeId; }) : null;
      var candidates = [];
      if(active) candidates.push(active);
      profiles.forEach(function(p){ if(p && candidates.indexOf(p) < 0) candidates.push(p); });
      for(var i=0;i<candidates.length;i++){
        var rows = collectRows(candidates[i]);
        if(rows.length) return rows;
      }
      return [];
    }, []);
  }
  function currentRows(){
    var p = profile();
    var rows = collectRows(p);
    if(rows.length) return rows;
    rows = readBagPanelSafe();
    if(rows.length) return rows;
    return storedProfileRows();
  }
  function sortRows(rows){
    var clean = (Array.isArray(rows) ? rows : []).map(function(row){ return normalise(row); }).filter(Boolean);
    return clean.sort(function(a,b){ return (b.totalM || b.baseCarry) - (a.totalM || a.baseCarry); });
  }
  function quickBag(seven){
    return safe(function(){ return win.gdGenerateQuickBag(seven); }, null) || (function(){
      var a = num(seven) || 145;
      return [["Driver",a+75],["3W",a+50],["4H",a+30],["5i",a+18],["6i",a+9],["7i",a],["8i",a-10],["9i",a-22],["PW",a-38],["GW",a-52],["SW",a-68],["LW",a-82]].map(function(pair){
        var carry = Math.max(35, Math.round(pair[1]));
        return { club: pair[0], baseCarry: carry, totalM: totalFor(pair[0], carry) };
      });
    })();
  }
  function readBagPanelSafe(){
    var rows = [];
    document.querySelectorAll('#gdBagEditor [id^="gdBagClub_"]').forEach(function(el){
      var i = el.id.split('_')[1];
      rows.push(normalise({
        club: el.value,
        baseCarry: document.getElementById('gdBagCarry_' + i)?.value,
        totalM: document.getElementById('gdBagTotal_' + i)?.value
      }));
    });
    return rows.filter(Boolean);
  }
  function persistRows(rows, opts){
    opts = opts || {};
    var p = profile();
    if(!p) return [];
    var clean = sortRows(rows);
    p.bag = clean;
    p.bagSlotsTouched = true;
    p.bagSeededDefault = false;
    p.onboardingComplete = true;
    p.updatedAt = new Date().toISOString();
    safe(function(){ win.savePlayerProfiles(); }, null);
    safe(function(){ win.syncCoreProfileFromActive(); }, null);
    if(opts.render !== false){
      safe(function(){ win.renderBagPanel(); }, null);
      safe(function(){ win.renderProfilePanel(); }, null);
      safe(function(){ if(typeof win.renderShot === "function") win.renderShot(); }, null);
    }
    if(!opts.silent) toast('Bag saved');
    return clean;
  }
  function totalLabel(){ return safe(function(){ return win.gdBagTotalLabel(); }, 'Total'); }
  function renderBagPanelHotfix(){
    var p = profile();
    var bag = collectRows(p);
    if(!bag.length) bag = storedProfileRows();
    if(bag.length && p){ p.bag = bag; p.bagSeededDefault = false; }
    var box = document.getElementById('gdBagEditor');
    var sub = document.getElementById('gdBagPanelSub');
    var title = document.getElementById('gdBagStatusTitle');
    var text = document.getElementById('gdBagStatusText');
    var quick = document.getElementById('gdBagQuick7i');
    var label = totalLabel();
    safe(function(){ if(typeof win.gdBagSyncFirmnessButtons === 'function') win.gdBagSyncFirmnessButtons(); }, null);
    if(quick) quick.value = (bag.find(function(c){ return c.club === '7i'; }) || {}).baseCarry || '';
    if(sub) sub.textContent = '';
    if(title) title.textContent = bag.length ? (bag.length + ' bag cells') : 'Build your bag';
    if(text) text.textContent = bag.length ? (label + ' generated.') : 'Use Quick set, Add club, or New cell.';
    if(box){
      box.innerHTML = bag.length ? bag.map(function(c,i){
        return '<div class="gdBagEditRow" id="gdBagRow_'+i+'"><label class="gdBagField gdBagClubField"><span>Club</span><input id="gdBagClub_'+i+'" aria-label="Club name" value="'+esc(c.club)+'" readonly oninput="gdBagRefreshQuickTab()"></label><label class="gdBagField"><span>Carry</span><input id="gdBagCarry_'+i+'" aria-label="Carry metres" inputmode="numeric" type="number" min="1" step="1" value="'+(Number(c.baseCarry)||0)+'" readonly oninput="gdBagRefreshQuickTab()"></label><label class="gdBagField"><span>'+esc(label)+'</span><input id="gdBagTotal_'+i+'" aria-label="'+esc(label)+' metres" inputmode="numeric" type="number" min="1" step="1" value="'+(Number(c.totalM)||Number(c.baseCarry)||0)+'" readonly oninput="gdBagRefreshQuickTab()"></label><div class="gdBagRowActions"><button class="gdBagRowEdit" id="gdBagEdit_'+i+'" type="button" aria-label="Edit club" onclick="gdBagToggleRowEdit('+i+')">Edit</button><button class="gdBagRowDelete" id="gdBagDelete_'+i+'" type="button" aria-label="Delete club" onclick="gdBagDeleteClub('+i+')">×</button></div></div>';
      }).join('') : '<div class="lockNotice">No clubs yet. Quick set and Add club are available below.</div>';
    }
    showQuickGenerator();
  }
  function showQuickGenerator(){
    var wrap = document.getElementById('gdBagQuickWrap');
    var tab = document.getElementById('gdBagQuickTab');
    if(wrap) wrap.hidden = false;
    if(tab && !tab.hasAttribute('aria-expanded')) tab.setAttribute('aria-expanded', 'false');
  }

  win.gdNormaliseBagRow = normalise;
  win.gdBagSortRows = sortRows;
  win.gdUsableBagRowsForProfile = collectRows;
  win.gdCurrentUsableBagRows = currentRows;
  win.gdHasUsableBag = function(){ return currentRows().length > 0; };
  win.gdEnsureDefaultBagCells = function(p){
    p = p || profile();
    var rows = collectRows(p);
    if(!rows.length) rows = storedProfileRows();
    if(rows.length && p){ p.bag = rows; p.bagSeededDefault = false; return rows; }
    return [];
  };
  win.gdBagSourceRows = function(){ return win.gdEnsureDefaultBagCells(profile()); };
  win.readBagPanel = readBagPanelSafe;
  win.gdBagPersistRows = persistRows;
  win.gdBagRefreshQuickTab = showQuickGenerator;
  win.renderBagPanel = renderBagPanelHotfix;
  win.gdBagToggleQuick = function(){
    var panel = document.getElementById('gdBagQuickPanel');
    var tab = document.getElementById('gdBagQuickTab');
    if(!panel) return;
    panel.hidden = !panel.hidden;
    if(tab) tab.setAttribute('aria-expanded', String(!panel.hidden));
  };
  win.gdBagGenerateQuick = function(){
    var raw = document.getElementById('gdBagQuick7i')?.value;
    var quick = num(raw) || 145;
    persistRows(quickBag(quick), { silent:true });
    toast('Quick bag generated');
  };
  win.gdBagTryAddClub = function(){
    var clubEl = document.getElementById('gdBagAddClub');
    var carryEl = document.getElementById('gdBagAddCarry');
    var club = String(clubEl?.value || '').trim();
    var carry = Math.round(num(carryEl?.value));
    if(!club || carry <= 0){ toast('Enter club and carry'); return; }
    var rows = readBagPanelSafe().filter(function(row){ return row.club.toLowerCase() !== club.toLowerCase(); });
    persistRows(rows.concat([{ club: club, baseCarry: carry, totalM: totalFor(club, carry) }]), { silent:true });
    if(clubEl) clubEl.value = '';
    if(carryEl) carryEl.value = '';
    toast('Club added');
  };
  win.gdBagAddSlot = function(){
    var rows = readBagPanelSafe();
    var used = new Set(rows.map(function(row){ return row.club.toLowerCase(); }));
    var defaults = quickBag(rows.find(function(r){ return r.club === '7i'; })?.baseCarry || 145);
    var next = defaults.find(function(row){ return !used.has(row.club.toLowerCase()); }) || { club: 'Club ' + (rows.length + 1), baseCarry: 100, totalM: totalFor('Club', 100) };
    persistRows(rows.concat([next]), { silent:true });
    setTimeout(function(){ safe(function(){ if(typeof win.gdBagToggleRowEdit === 'function') win.gdBagToggleRowEdit(readBagPanelSafe().findIndex(function(row){ return row.club === next.club; })); }, null); }, 40);
    toast('Cell added');
  };

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showQuickGenerator);
  else showQuickGenerator();
  win.ClarityBagHotfix = { version: 'bag-hotfix-20260610-restore-editor', rows: currentRows };
})();
