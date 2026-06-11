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
      userAgent: navigator.userAgent,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1
      },
      activeCourseLabel: activeCourseLabel(),
      lastAction: lastAction,
      localStorageSummary: storageSummary(window.localStorage),
      sessionStorageSummary: storageSummary(window.sessionStorage),
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

    var overlay = document.createElement("div");
    overlay.id = "claritySupportOverlay";
    overlay.className = "claritySupportOverlay";
    overlay.innerHTML = [
      '<div class="claritySupportSheet" role="dialog" aria-modal="true" aria-labelledby="claritySupportTitle">',
      '<div class="claritySupportHead"><div><strong id="claritySupportTitle">Support</strong><span>Send a short note with app context so the issue can be reproduced later.</span></div><button class="claritySupportClose" type="button" aria-label="Close support">×</button></div>',
      '<form class="claritySupportForm" id="claritySupportForm">',
      '<label>What happened<textarea id="claritySupportHappened" required maxlength="1200"></textarea></label>',
      '<label>What you expected<textarea id="claritySupportExpected" maxlength="1200"></textarea></label>',
      '<label>Contact optional<input id="claritySupportContact" maxlength="240" autocomplete="email"></label>',
      '<div class="claritySupportMeta" id="claritySupportMeta"></div>',
      '<div class="claritySupportActions"><button type="button" class="claritySupportCloseAction">Cancel</button><button type="submit" class="primary">Send ticket</button></div>',
      '<div class="claritySupportStatus" id="claritySupportStatus" role="status"></div>',
      '</form>',
      '</div>'
    ].join("");

    document.body.append(button, overlay);
    button.addEventListener("click", open);
    overlay.querySelector(".claritySupportClose").addEventListener("click", close);
    overlay.querySelector(".claritySupportCloseAction").addEventListener("click", close);
    overlay.addEventListener("click", function(event){if(event.target === overlay) close();});
    overlay.querySelector("form").addEventListener("submit", submit);
  }

  function open(){
    var overlay = document.getElementById("claritySupportOverlay");
    var meta = document.getElementById("claritySupportMeta");
    var context = buildContext();
    meta.textContent = "Build " + (context.build.buildId || "unknown") + " · " + (context.route || "unknown route") + " · " + (context.activeCourseLabel || "no active course");
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
      status.textContent = "Ticket sent: " + (data.ticketId || "received");
      setTimeout(close, 900);
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
    open: open
  };
})();

