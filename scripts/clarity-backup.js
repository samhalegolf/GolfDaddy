(function(){
  var BACKUP_FORMAT = "clarity-caddie-browser-backup";
  var BACKUP_VERSION = 1;
  var KEY_PATTERN = /^(gd_|clarity|Clarity|GolfDaddy)/;
  var DANGEROUS_KEYS = /token|secret|password/i;
  var statusTimer = null;

  function safe(fn, fallback){
    try{return fn();}catch(e){return fallback;}
  }

  function nowIso(){
    return safe(function(){return new Date().toISOString();}, "");
  }

  function slug(value){
    return String(value || "clarity-caddie").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "clarity-caddie";
  }

  function isClarityKey(key){
    return KEY_PATTERN.test(String(key || ""));
  }

  function readStorage(storage){
    var out = {};
    if(!storage) return out;
    for(var i = 0; i < storage.length; i++){
      var key = storage.key(i);
      if(!isClarityKey(key)) continue;
      out[key] = storage.getItem(key);
    }
    return out;
  }

  function byteLength(text){
    return new Blob([String(text || "")]).size;
  }

  function storageStats(){
    var local = readStorage(window.localStorage);
    var session = readStorage(window.sessionStorage);
    var account = safe(function(){return JSON.parse(local.gd_accounts_v1 || "{}");}, {});
    var profiles = safe(function(){return JSON.parse(local.gd_player_profiles_v27 || "{}");}, {});
    return {
      localKeys: Object.keys(local).length,
      sessionKeys: Object.keys(session).length,
      bytes: byteLength(JSON.stringify({localStorage: local, sessionStorage: session})),
      accounts: Array.isArray(account.accounts) ? account.accounts.length : 0,
      profiles: Array.isArray(profiles.profiles) ? profiles.profiles.length : 0
    };
  }

  function buildBackup(){
    var activeCourse = safe(function(){return JSON.parse(localStorage.getItem("gd_active_course_v1") || "null");}, null);
    return {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: nowIso(),
      app: window.ClarityBuild || {},
      browser: {
        userAgent: navigator.userAgent,
        origin: location.origin
      },
      activeCourseLabel: activeCourse && (activeCourse.name || activeCourse.courseName) || "",
      warnings: [
        "This backup contains local Clarity browser data.",
        "It may include local account password hashes used by the prototype account layer.",
        "Do not share it publicly."
      ],
      localStorage: readStorage(window.localStorage),
      sessionStorage: readStorage(window.sessionStorage)
    };
  }

  function downloadBackup(){
    var backup = buildBackup();
    var text = JSON.stringify(backup, null, 2);
    var url = URL.createObjectURL(new Blob([text], {type: "application/json"}));
    var a = document.createElement("a");
    var date = nowIso().slice(0, 10) || "backup";
    a.href = url;
    a.download = slug(backup.app.appName || "clarity-caddie") + "-backup-" + date + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function(){URL.revokeObjectURL(url);}, 1000);
    setStatus("Backup exported: " + Object.keys(backup.localStorage).length + " local keys.", "good");
  }

  function validateBackup(data){
    if(!data || data.format !== BACKUP_FORMAT) throw new Error("This is not a Clarity backup file.");
    if(!data.localStorage || typeof data.localStorage !== "object") throw new Error("Backup has no localStorage data.");
    return data;
  }

  function clearClarityStorage(storage){
    if(!storage) return;
    var keys = [];
    for(var i = 0; i < storage.length; i++){
      var key = storage.key(i);
      if(isClarityKey(key)) keys.push(key);
    }
    keys.forEach(function(key){storage.removeItem(key);});
  }

  function writeStorage(storage, values){
    Object.keys(values || {}).forEach(function(key){
      if(!isClarityKey(key) || DANGEROUS_KEYS.test(key)) return;
      storage.setItem(key, String(values[key]));
    });
  }

  function importBackup(data, opts){
    validateBackup(data);
    opts = opts || {};
    if(opts.replace){
      clearClarityStorage(window.localStorage);
      clearClarityStorage(window.sessionStorage);
    }
    writeStorage(window.localStorage, data.localStorage);
    writeStorage(window.sessionStorage, data.sessionStorage);
    setStatus("Backup imported. Reloading app...", "good");
    setTimeout(function(){
      location.href = location.pathname + "?v=backup-restore-" + Date.now();
    }, 800);
  }

  function handleImportFile(file){
    if(!file) return;
    var reader = new FileReader();
    reader.onload = function(){
      try{
        var data = validateBackup(JSON.parse(String(reader.result || "{}")));
        var replace = !!document.getElementById("clarityBackupReplace")?.checked;
        var keys = Object.keys(data.localStorage || {}).length + Object.keys(data.sessionStorage || {}).length;
        var ok = window.confirm("Import " + keys + " Clarity keys from " + (data.exportedAt || "backup") + "?");
        if(!ok) return setStatus("Import cancelled.", "warn");
        importBackup(data, {replace: replace});
      }catch(error){
        setStatus(error && error.message ? error.message : "Import failed.", "bad");
      }
    };
    reader.onerror = function(){setStatus("Could not read backup file.", "bad");};
    reader.readAsText(file);
  }

  function setStatus(message, tone){
    var el = document.getElementById("clarityBackupStatus");
    var overlayEl = document.getElementById("clarityBackupOverlayStatus");
    [el, overlayEl].forEach(function(item){
      if(!item) return;
      item.className = "clarityBackupStatus " + (tone || "");
      item.textContent = message || "";
    });
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function(){
      [el, overlayEl].forEach(function(item){
        if(!item) return;
        if(item.textContent === message) item.textContent = summaryText();
        item.className = "clarityBackupStatus";
      });
    }, 5000);
  }

  function summaryText(){
    var stats = storageStats();
    return stats.accounts + " local accounts, " + stats.profiles + " profiles, " + stats.localKeys + " local keys.";
  }

  function renderCard(){
    var host = document.getElementById("developerPanel");
    var permissionCard = document.getElementById("gdPermissionCard");
    if(!host || !permissionCard || document.getElementById("clarityBackupCard")) return;
    var stats = storageStats();
    var card = document.createElement("div");
    card.id = "clarityBackupCard";
    card.className = "clarityBackupCard";
    card.innerHTML = [
      "<h3>Data Safety</h3>",
      "<p>Export or restore this browser's Clarity data before cloud sync changes. Backups include local profiles, linked coach/player accounts, course mapping, shot data, practice data, and app settings.</p>",
      '<div class="clarityBackupStats">',
      '<div class="clarityBackupStat"><strong id="clarityBackupAccounts">' + stats.accounts + '</strong><span>Accounts</span></div>',
      '<div class="clarityBackupStat"><strong id="clarityBackupProfiles">' + stats.profiles + '</strong><span>Profiles</span></div>',
      '<div class="clarityBackupStat"><strong id="clarityBackupKeys">' + stats.localKeys + '</strong><span>Local keys</span></div>',
      "</div>",
      '<label class="clarityBackupOption"><input id="clarityBackupReplace" type="checkbox" checked><span>Replace existing Clarity browser keys before import. Leave checked for a full restore.</span></label>',
      '<div class="clarityBackupActions">',
      '<button type="button" class="primary" id="clarityBackupExportBtn">Export Backup</button>',
      '<label class="clarityBackupFileLabel">Import Backup<input id="clarityBackupImportInput" type="file" accept="application/json,.json"></label>',
      "</div>",
      '<div class="clarityBackupStatus" id="clarityBackupStatus">' + summaryText() + "</div>"
    ].join("");
    permissionCard.insertAdjacentElement("afterend", card);
    card.querySelector("#clarityBackupExportBtn").addEventListener("click", downloadBackup);
    card.querySelector("#clarityBackupImportInput").addEventListener("change", function(event){
      handleImportFile(event.target.files && event.target.files[0]);
      event.target.value = "";
    });
  }

  function renderOverlay(){
    if(document.getElementById("clarityBackupOverlay")) return;
    var overlay = document.createElement("div");
    overlay.id = "clarityBackupOverlay";
    overlay.className = "clarityBackupOverlay";
    overlay.innerHTML = [
      '<div class="clarityBackupSheet" role="dialog" aria-modal="true" aria-labelledby="clarityBackupOverlayTitle">',
      '<div class="clarityBackupHead"><strong id="clarityBackupOverlayTitle">Data Safety</strong><button class="clarityBackupClose" type="button" aria-label="Close backup">x</button></div>',
      '<div class="clarityBackupCard" id="clarityBackupOverlayCard"></div>',
      '</div>'
    ].join("");
    document.body.append(overlay);
    overlay.querySelector(".clarityBackupClose").addEventListener("click", closeOverlay);
    overlay.addEventListener("click", function(event){if(event.target === overlay) closeOverlay();});
  }

  function overlayMarkup(){
    var stats = storageStats();
    return [
      "<h3>Browser Backup</h3>",
      "<p>Export or restore this browser's Clarity data before cloud sync changes. Backups include local profiles, linked coach/player accounts, course mapping, shot data, practice data, and app settings.</p>",
      '<div class="clarityBackupStats">',
      '<div class="clarityBackupStat"><strong>' + stats.accounts + '</strong><span>Accounts</span></div>',
      '<div class="clarityBackupStat"><strong>' + stats.profiles + '</strong><span>Profiles</span></div>',
      '<div class="clarityBackupStat"><strong>' + stats.localKeys + '</strong><span>Local keys</span></div>',
      "</div>",
      '<label class="clarityBackupOption"><input id="clarityBackupReplaceOverlay" type="checkbox" checked><span>Replace existing Clarity browser keys before import. Leave checked for a full restore.</span></label>',
      '<div class="clarityBackupActions">',
      '<button type="button" class="primary" id="clarityBackupExportOverlayBtn">Export Backup</button>',
      '<label class="clarityBackupFileLabel">Import Backup<input id="clarityBackupImportOverlayInput" type="file" accept="application/json,.json"></label>',
      "</div>",
      '<div class="clarityBackupStatus" id="clarityBackupOverlayStatus">' + summaryText() + "</div>"
    ].join("");
  }

  function openOverlay(){
    var overlay = document.getElementById("clarityBackupOverlay");
    var card = document.getElementById("clarityBackupOverlayCard");
    if(!overlay || !card) return;
    card.innerHTML = overlayMarkup();
    card.querySelector("#clarityBackupExportOverlayBtn").addEventListener("click", downloadBackup);
    card.querySelector("#clarityBackupImportOverlayInput").addEventListener("change", function(event){
      var oldReplace = document.getElementById("clarityBackupReplace");
      var overlayReplace = document.getElementById("clarityBackupReplaceOverlay");
      if(oldReplace && overlayReplace) oldReplace.checked = overlayReplace.checked;
      handleImportFile(event.target.files && event.target.files[0]);
      event.target.value = "";
    });
    overlay.classList.add("open");
  }

  function closeOverlay(){
    var overlay = document.getElementById("clarityBackupOverlay");
    if(overlay) overlay.classList.remove("open");
  }

  function refreshCard(){
    var stats = storageStats();
    var a = document.getElementById("clarityBackupAccounts");
    var p = document.getElementById("clarityBackupProfiles");
    var k = document.getElementById("clarityBackupKeys");
    if(a) a.textContent = stats.accounts;
    if(p) p.textContent = stats.profiles;
    if(k) k.textContent = stats.localKeys;
    var status = document.getElementById("clarityBackupStatus");
    if(status && !status.textContent) status.textContent = summaryText();
  }

  function boot(){
    renderOverlay();
    renderCard();
    refreshCard();
  }

  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
  setInterval(boot, 1000);
  window.ClarityBackup = {
    buildBackup: buildBackup,
    export: downloadBackup,
    importData: importBackup,
    stats: storageStats,
    open: openOverlay,
    close: closeOverlay
  };
})();
