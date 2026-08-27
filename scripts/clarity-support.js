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
    if(document.getElementById("claritySupportOverlay")) return;

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

    document.body.append(overlay);
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


/* --- Clarity Caddy bag hotfix: legacy-safe bag editor + ghost-bag setup support --- */
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
  function totalFor(club, carry, preset){
    return safe(function(){ return Math.max(carry, Math.round(win.gdBagTotalForCarry(club, carry, preset) || carry)); }, Math.max(carry, Math.round(carry * 1.08)));
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
      return active ? collectRows(active) : [];
    }, []);
  }
  function ghostBagRows(seven){
    return quickBag(seven || 145).map(function(row){ return Object.assign({}, row, { ghost:true, internalOnly:true }); });
  }
  function clearUntouchedDefaultBag(p){
    if(!p || p.placeholderProfile) return p;
    var touched = p.bagSlotsTouched === true || p.bagEdited === true || p.customBag === true;
    if(!touched && p.bagSeededDefault && collectRows(p).length){
      p.bag = [];
      p.bagRows = [];
      p.clubs = [];
      p.clubBag = [];
      p.bagSeededDefault = false;
      p.ghostBagOnly = true;
      p.updatedAt = new Date().toISOString();
      safe(function(){ win.savePlayerProfiles(); }, null);
    }
    return p;
  }
  function currentRows(){
    var p = clearUntouchedDefaultBag(profile());
    var rows = collectRows(p);
    if(rows.length) return rows;
    rows = readBagPanelSafe();
    if(rows.length) return rows;
    return storedProfileRows();
  }
  function bubbleRows(){
    var rows = currentRows();
    return rows.length ? rows : ghostBagRows();
  }
  function maxBagDistance(rows){
    return Math.max(0, ...(Array.isArray(rows) ? rows : []).map(function(row){ return Number(row.totalM || row.baseCarry || row.carry || row.distance || 0); }).filter(function(n){ return Number.isFinite(n) && n > 0; }));
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

  /* ---- one line per club (Claude Design "Golf bag UI simplification", turn 1b) ----
     The sheet used to be twelve four-field forms. It is now a two-column list of
     read-only 46px lines; tapping a line spans it full width and opens the carry
     stepper in place, so nothing is a live input until you ask for it. */
  var ROLL_LABEL = { soft:'Soft', medium:'Normal', hard:'Firm' };
  var ART_ASPECT = { driver:'710 / 302', wood:'681 / 208', hybrid:'666 / 146', blade:'674 / 222' };
  var ui = { editing:null, rollOpen:false, genOpen:false, genEntering:false, genLeaving:false, setupCarry:0, busy:false };
  var timers = [];

  function el(id){ return document.getElementById(id); }
  function clearTimers(){ timers.forEach(clearTimeout); timers = []; }
  function at(ms, fn){ timers.push(setTimeout(fn, ms)); }
  function reducedMotion(){ return safe(function(){ return win.matchMedia('(prefers-reduced-motion: reduce)').matches; }, false); }
  function firmnessKey(){ return safe(function(){ return GD_BAG_FIRMNESS_KEY; }, 'gd_bag_total_firmness_v1'); }
  function rollPreset(){ return safe(function(){ return win.gdBagFirmness(); }, 'medium'); }
  function art(club){
    if(/driver/i.test(club)) return 'driver';
    if(/\d\s*w|wood/i.test(club)) return 'wood';
    if(/\d\s*h|hybrid|rescue/i.test(club)) return 'hybrid';
    return 'blade';
  }

  /* The rendered rows are the panel's source of truth, the way the old inputs
     were - gd-app-core still calls readBagPanel() from several places. */
  function readBagPanelSafe(){
    var rows = [];
    document.querySelectorAll('#gdBagEditor .gdBagRow').forEach(function(node){
      var row = normalise({ club: node.dataset.club, baseCarry: node.dataset.carry, totalM: node.dataset.total });
      if(row) rows.push(row);
    });
    return rows;
  }
  function rowAt(index){ return readBagPanelSafe()[index] || null; }

  function editHTML(index, carry, total){
    return '<div class="gdBagRowEdit">'
      + '<div class="gdBagRowStep">'
      + '<button type="button" aria-label="Less carry" onclick="gdBagRowCarryStep(' + index + ',-1)">&minus;</button>'
      + '<label><span>Carry</span><input inputmode="numeric" aria-label="Carry metres" value="' + carry + '" onchange="gdBagRowCarrySet(' + index + ',this.value)"></label>'
      + '<button type="button" aria-label="More carry" onclick="gdBagRowCarryStep(' + index + ',1)">+</button>'
      + '</div>'
      + '<div class="gdBagRowFoot">'
      + '<span class="gdBagRowNote">Runs on to ' + total + ' m</span>'
      + '<div class="gdBagRowActions">'
      + '<button class="gdBagRowRemove" type="button" onclick="gdBagDeleteClub(' + index + ')">Remove</button>'
      + '<button class="gdBagRowDone" type="button" onclick="gdBagToggleRowEdit(' + index + ')">Done</button>'
      + '</div></div></div>';
  }
  function rowHTML(row, index){
    var kind = art(row.club);
    var carry = Math.round(Number(row.baseCarry) || 0);
    var total = Math.max(carry, Math.round(Number(row.totalM) || 0));
    var editing = ui.editing === row.club;
    return '<div class="gdBagRow' + (editing ? ' editing' : '') + '" id="gdBagRow_' + index + '"'
      + ' data-club="' + esc(row.club) + '" data-carry="' + carry + '" data-total="' + total + '">'
      + '<div class="gdBagRowArt" aria-hidden="true"><i style="aspect-ratio:' + ART_ASPECT[kind] + ';background-image:url(assets/clubs/' + kind + '-h.png)"></i></div>'
      + '<div class="gdBagRowMain" role="button" tabindex="0" aria-expanded="' + (editing ? 'true' : 'false') + '"'
      + ' onclick="gdBagToggleRowEdit(' + index + ')" onkeydown="gdBagRowKey(event,' + index + ')">'
      + '<span class="gdBagRowClub">' + esc(row.club === 'Driver' ? 'DR' : row.club) + '</span>'
      + '<span class="gdBagRowTotal">' + total + '</span>'
      + '<span class="gdBagRowCarry">' + carry + '</span>'
      + '</div>'
      + (editing ? editHTML(index, carry, total) : '')
      + '</div>';
  }

  function renderBagPanelHotfix(){
    var p = clearUntouchedDefaultBag(profile());
    var bag = collectRows(p);
    if(bag.length && p){ p.bag = bag; p.bagSeededDefault = false; }
    var hasBag = bag.length > 0;

    /* Track the open row by club name, not index: every write re-sorts the bag
       by total, so indexes move underneath us. */
    if(ui.editing && !bag.some(function(c){ return c.club === ui.editing; })) ui.editing = null;
    if(!ui.setupCarry){
      var seven = (bag.find(function(c){ return c.club === '7i'; }) || {}).baseCarry;
      ui.setupCarry = Math.max(60, Math.min(220, Math.round(num(seven) || 155)));
    }

    /* Mid-flight the generator and the club list are both on the stage: the
       clubs fly into the bag while the panel unfolds over the top of them. */
    var genVisible = !ui.genLeaving && (ui.genOpen || ui.genEntering || !hasBag);
    var listRows = hasBag && !ui.genOpen;
    var listChrome = listRows && !ui.genEntering;

    var sub = el('gdBagPanelSub');
    if(sub) sub.textContent = hasBag ? (bag.length + ' clubs · metres') : 'No clubs yet';
    var setup = el('gdBagSetupCarry');
    if(setup) setup.textContent = String(ui.setupCarry);

    var stage = el('gdBagStage');
    if(stage) stage.classList.toggle('hasBag', hasBag);
    var gen = el('gdBagGenPanel');
    if(gen) gen.classList.toggle('folded', !genVisible);
    var head = el('gdBagListHead');
    if(head) head.hidden = !listChrome;
    var add = el('gdBagAddTab');
    if(add) add.hidden = !listChrome;
    var chip = el('gdBagGenChip');
    if(chip){ chip.hidden = !hasBag; chip.classList.toggle('active', ui.genOpen || ui.genEntering); }

    var preset = rollPreset();
    var chipRoll = el('gdBagRollChip');
    if(chipRoll) chipRoll.textContent = 'Roll · ' + (ROLL_LABEL[preset] || 'Normal');
    var rollPanel = el('gdBagRollPanel');
    if(rollPanel) rollPanel.hidden = !ui.rollOpen;
    document.querySelectorAll('[data-gd-bag-firmness]').forEach(function(btn){
      btn.classList.toggle('active', btn.dataset.gdBagFirmness === preset);
    });

    var box = el('gdBagEditor');
    if(box) box.innerHTML = listRows ? bag.map(rowHTML).join('') : '';
  }

  /* ---- build / unbuild choreography ---- */
  function flyClubs(dir){
    if(reducedMotion()) return;
    var box = el('gdBagEditor');
    var artBox = document.querySelector('#bagPanel .gdBagArt');
    if(!box || !artBox) return;
    var nodes = Array.prototype.slice.call(box.querySelectorAll('.gdBagRow'));
    if(!nodes.length) return;
    var a = artBox.getBoundingClientRect();
    if(!a.width) return;
    /* Aim at the mouth of the bag, not the middle of the artwork - the same
       point the 390px prototype hand-tuned its offsets against. */
    var tx = a.left + a.width * 0.80;
    var ty = a.top + a.height * 0.82;
    var lines = Math.ceil(nodes.length / 2);
    nodes.forEach(function(node, i){
      var col = i % 2, line = Math.floor(i / 2);
      var r = node.getBoundingClientRect();
      var step = dir === 'in'
        ? ((col === 1 ? 0 : lines) + (lines - 1 - line)) * 0.085
        : ((col === 0 ? 0 : lines) + line) * 0.13;
      node.style.setProperty('--dx', Math.round(tx - (r.left + r.width / 2)) + 'px');
      node.style.setProperty('--dy', Math.round(ty - (r.top + r.height / 2)) + 'px');
      node.style.setProperty('--rot', ((col === 0 ? 74 : 68) + (line % 2 ? 8 : -6)) + 'deg');
      node.style.animation = dir === 'in'
        ? 'gbIn .38s cubic-bezier(.36,.05,.5,1) ' + step.toFixed(3) + 's both'
        : 'gbOut .5s cubic-bezier(.38,0,.55,.98) ' + step.toFixed(3) + 's both';
    });
  }
  function holdClubsInBag(){
    document.querySelectorAll('#gdBagEditor .gdBagRow').forEach(function(node){
      node.style.animation = 'gbIn .01s linear both';
    });
  }
  function clearClubAnim(){
    document.querySelectorAll('#gdBagEditor .gdBagRow').forEach(function(node){
      node.style.animation = '';
      node.style.removeProperty('--dx');
      node.style.removeProperty('--dy');
      node.style.removeProperty('--rot');
    });
  }
  function pulseBag(){
    var artBox = document.querySelector('#bagPanel .gdBagArt');
    if(!artBox || reducedMotion()) return;
    artBox.classList.remove('pulsing');
    void artBox.offsetWidth;
    artBox.classList.add('pulsing');
    /* Plain setTimeout, not at(): starting the next build must not strand the
       class by clearing the timer that takes it off again. */
    setTimeout(function(){ artBox.classList.remove('pulsing'); }, 900);
  }
  function popChip(){
    var chip = el('gdBagGenChip');
    if(!chip || reducedMotion()) return;
    chip.classList.remove('gdBagChipPop');
    void chip.offsetWidth;
    chip.classList.add('gdBagChipPop');
    setTimeout(function(){ chip.classList.remove('gdBagChipPop'); }, 560);
  }
  function resetUi(){
    clearTimers();
    ui.editing = null; ui.rollOpen = false;
    ui.genOpen = false; ui.genEntering = false; ui.genLeaving = false;
    ui.setupCarry = 0; ui.busy = false;
  }

  win.gdBagSetupStep = function(delta){
    ui.setupCarry = Math.max(60, Math.min(220, (ui.setupCarry || 155) + num(delta)));
    var out = el('gdBagSetupCarry');
    if(out) out.textContent = String(ui.setupCarry);
  };
  win.gdBagBuild = function(){
    if(ui.busy) return;
    ui.busy = true;
    clearTimers();
    var built = quickBag(ui.setupCarry);
    ui.editing = null; ui.rollOpen = false;
    ui.genLeaving = true; ui.genEntering = false;
    renderBagPanelHotfix();
    at(400, function(){
      ui.genLeaving = false; ui.genOpen = false;
      persistRows(built, { silent:true });
      flyClubs('out');
      pulseBag();
      popChip();
      toast('Bag built');
    });
    at(2600, function(){ ui.busy = false; clearClubAnim(); });
  };
  win.gdBagToggleGenerator = function(){
    if(ui.busy) return;
    if(ui.genOpen || ui.genEntering){ resetUi(); renderBagPanelHotfix(); return; }
    ui.busy = true;
    clearTimers();
    ui.editing = null; ui.rollOpen = false;
    ui.genEntering = true; ui.genLeaving = false;
    var seven = (collectRows(profile()).find(function(c){ return c.club === '7i'; }) || {}).baseCarry;
    if(num(seven)) ui.setupCarry = Math.max(60, Math.min(220, Math.round(num(seven))));
    renderBagPanelHotfix();
    flyClubs('in');
    at(1360, function(){ holdClubsInBag(); pulseBag(); });
    at(2000, function(){
      ui.genOpen = true; ui.genEntering = false; ui.busy = false;
      renderBagPanelHotfix();
    });
  };

  /* ---- row editing ---- */
  win.gdBagToggleRowEdit = function(index){
    var row = rowAt(index);
    if(!row) return;
    ui.editing = ui.editing === row.club ? null : row.club;
    renderBagPanelHotfix();
  };
  win.gdBagRowKey = function(event, index){
    if(!event || (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar')) return;
    event.preventDefault();
    win.gdBagToggleRowEdit(index);
  };
  function setRowCarry(index, value){
    var rows = readBagPanelSafe();
    var row = rows[index];
    if(!row) return;
    var carry = Math.max(20, Math.min(400, Math.round(num(value) || row.baseCarry)));
    ui.editing = row.club;
    persistRows(rows.map(function(r, i){
      return i === index ? { club: r.club, baseCarry: carry, totalM: totalFor(r.club, carry) } : r;
    }), { silent:true });
  }
  win.gdBagRowCarryStep = function(index, delta){
    var row = rowAt(index);
    if(row) setRowCarry(index, row.baseCarry + num(delta));
  };
  win.gdBagRowCarrySet = function(index, value){ setRowCarry(index, value); };
  win.gdBagDeleteClub = function(index){
    var rows = readBagPanelSafe();
    var removed = rows[index];
    if(!removed) return;
    ui.editing = null;
    persistRows(rows.filter(function(r, i){ return i !== index; }), { silent:true });
    toast(removed.club + ' removed');
  };
  win.gdBagAddSlot = function(){
    var rows = readBagPanelSafe();
    var used = new Set(rows.map(function(r){ return r.club.toLowerCase(); }));
    var seven = (rows.find(function(r){ return r.club === '7i'; }) || {}).baseCarry || ui.setupCarry || 155;
    var next = quickBag(seven).find(function(r){ return !used.has(r.club.toLowerCase()); })
      || { club: 'Club ' + (rows.length + 1), baseCarry: 100, totalM: totalFor('Club', 100) };
    ui.editing = next.club;
    persistRows(rows.concat([next]), { silent:true });
    toast(next.club + ' added');
  };

  /* ---- roll-out (the old soft / medium / hard "firmness") ---- */
  win.gdBagToggleRoll = function(){
    ui.rollOpen = !ui.rollOpen;
    renderBagPanelHotfix();
  };
  win.gdBagSetFirmness = function(mode){
    var preset = ROLL_LABEL[mode] ? mode : 'medium';
    safe(function(){ localStorage.setItem(firmnessKey(), preset); }, null);
    var rows = readBagPanelSafe();
    if(!rows.length) rows = currentRows();
    if(rows.length){
      persistRows(rows.map(function(r){
        return { club: r.club, baseCarry: r.baseCarry, totalM: totalFor(r.club, r.baseCarry, preset) };
      }), { silent:true });
    } else renderBagPanelHotfix();
    toast('Roll set to ' + ROLL_LABEL[preset].toLowerCase());
  };

  win.gdNormaliseBagRow = normalise;
  win.gdBagSortRows = sortRows;
  win.gdUsableBagRowsForProfile = collectRows;
  win.gdCurrentUsableBagRows = currentRows;
  win.gdHasUsableBag = function(){ return currentRows().length > 0; };
  win.gdGhostBagRows = ghostBagRows;
  win.gdBubbleSourceRows = bubbleRows;
  win.gdCurrentBagMaxDistanceM = function(){ return maxBagDistance(currentRows()); };
  win.gdCurrentBubbleMaxDistanceM = function(){ return maxBagDistance(bubbleRows()); };
  win.gdEnsureDefaultBagCells = function(p){
    p = clearUntouchedDefaultBag(p || profile());
    var rows = collectRows(p);
    if(rows.length && p){ p.bag = rows; p.bagSeededDefault = false; return rows; }
    return [];
  };
  win.gdBagSourceRows = function(){ return win.gdEnsureDefaultBagCells(profile()); };
  win.readBagPanel = readBagPanelSafe;
  win.gdBagPersistRows = persistRows;
  win.renderBagPanel = renderBagPanelHotfix;
  /* The quick-set tab and the club/carry add form are gone from the sheet.
     Keep the old entry points harmless for anything still holding a reference. */
  win.gdBagRefreshQuickTab = function(){};
  win.gdBagToggleQuick = function(){};
  win.gdBagGenerateQuick = function(){ win.gdBagToggleGenerator(); };
  win.gdBagTryAddClub = function(){ win.gdBagAddSlot(); };

  var coreOpenBag = win.openBag;
  win.openBag = function(){
    resetUi();
    if(typeof coreOpenBag === 'function') return coreOpenBag.apply(this, arguments);
    safe(function(){ win.openPanel('bagPanel'); }, null);
    renderBagPanelHotfix();
  };

  win.ClarityBagHotfix = { version: 'bag-sheet-20260827-one-line-per-club', rows: currentRows };
})();
