(function () {
  "use strict";

  var activeSection = "menu";

  function safe(fn, fallback) {
    try {
      return fn();
    } catch (error) {
      return fallback;
    }
  }

  function account() {
    return safe(function () {
      return window.GolfDaddyAccounts && typeof window.GolfDaddyAccounts.current === "function"
        ? window.GolfDaddyAccounts.current()
        : window.gdCurrentAccount && window.gdCurrentAccount();
    }, null);
  }

  function profile(activeAccount) {
    activeAccount = activeAccount || account();
    if (!activeAccount) return null;
    return safe(function () {
      if (window.gdActiveAccountProfile) return window.gdActiveAccountProfile(activeAccount);
      if (window.gdProfileById) return window.gdProfileById(activeAccount.profileId);
      if (window.gdAccountEnsureProfile) return window.gdAccountEnsureProfile(activeAccount);
      return window.GolfDaddyProfiles && window.GolfDaddyProfiles.active ? window.GolfDaddyProfiles.active() : null;
    }, null);
  }

  function publicRole(activeAccount) {
    return safe(function () {
      if (window.gdAccountPublicRole) return window.gdAccountPublicRole(activeAccount && activeAccount.role);
      if (window.ClaritySession) return window.ClaritySession.normalizeRole(activeAccount && activeAccount.role);
      return activeAccount && activeAccount.role || "Player";
    }, activeAccount && activeAccount.role || "Player");
  }

  function isStaff(activeAccount) {
    return safe(function () {
      if (window.gdAccountIsStaff) return window.gdAccountIsStaff(activeAccount);
      var role = window.ClaritySession ? window.ClaritySession.normalizeRole(activeAccount && activeAccount.role) : activeAccount && activeAccount.role;
      return role === "admin" || role === "coach";
    }, false);
  }

  function render() {
    var activeAccount = account();
    var activeProfile = profile(activeAccount);
    var name = document.getElementById("gdPlayerSettingsName");
    var email = document.getElementById("gdPlayerSettingsEmail");
    var password = document.getElementById("gdPlayerSettingsPassword");
    var sub = document.getElementById("gdPlayerSettingsSub");
    var line = document.getElementById("gdPlayerSettingsProfileLine");
    var accountLine = document.getElementById("gdPlayerSettingsAccountLine");
    var coachLine = document.getElementById("gdPlayerSettingsCoachLine");
    var connectRow = document.getElementById("gdPlayerSettingsConnectRow");
    var photoImg = document.getElementById("gdPlayerSettingsPhotoPreviewImg");
    var photoPreview = document.querySelector(".gdPlayerSettingsPhotoPreview");
    var photo = activeProfile && (activeProfile.profilePhotoDataUrl || activeProfile.photoDataUrl) || "";

    if (name) name.value = activeAccount && activeAccount.name || activeProfile && activeProfile.name || "";
    if (email) email.value = activeAccount && activeAccount.email || activeProfile && activeProfile.email || "";
    if (password) password.value = "";
    if (sub) sub.textContent = activeAccount ? (activeAccount.name || "Account") + " · " + publicRole(activeAccount) : "Account and profile";
    if (line) line.textContent = activeAccount && activeAccount.requiresPasswordSetup ? "Set your own password before continuing." : activeAccount ? "Signed in as " + (activeAccount.email || activeAccount.name || "this account") : "Sign in to edit settings";
    if (accountLine) accountLine.textContent = activeAccount ? (activeAccount.email || activeAccount.name || "Signed in") + " · " + publicRole(activeAccount) : "Sign in to manage your account";
    if (connectRow) connectRow.hidden = !activeAccount || isStaff(activeAccount);
    if (coachLine) {
      var coachId = Array.isArray(activeAccount && activeAccount.linkedCoachIds) ? activeAccount.linkedCoachIds[0] : "";
      var coach = coachId && window.gdAccountById ? window.gdAccountById(coachId) : null;
      coachLine.textContent = coach ? "Connected to " + (coach.name || coach.email || "Coach") : "Enter the code from your coach.";
    }
    if (password) password.placeholder = activeAccount && activeAccount.requiresPasswordSetup ? "Choose your own password" : "New password";
    if (photoImg) photoImg.src = photo || "assets/home/profile.png";
    if (photoPreview) photoPreview.classList.toggle("hasPhoto", !!photo);

    showSection(activeSection || "menu");
    safe(function () { return window.ClarityEmail && window.ClarityEmail.renderSettings && window.ClarityEmail.renderSettings(); });
  }

  function showSection(section) {
    activeSection = section || "menu";
    var menu = document.getElementById("gdPlayerSettingsMenu");
    var pages = {
      profile: document.getElementById("gdPlayerSettingsProfileSection"),
      password: document.getElementById("gdPlayerSettingsPasswordSection"),
      connect: document.getElementById("gdPlayerSettingsConnectSection"),
      notifications: document.getElementById("gdPlayerSettingsNotificationsSection"),
      account: document.getElementById("gdPlayerSettingsAccountSection"),
      support: document.getElementById("gdPlayerSettingsSupportSection")
    };
    if (menu) menu.hidden = activeSection !== "menu";
    Object.keys(pages).forEach(function (key) {
      if (pages[key]) pages[key].hidden = activeSection !== key;
    });
  }

  function open(opts) {
    opts = opts || {};
    var activeAccount = account();
    if (!activeAccount) {
      safe(function () { if (window.gdOpenProfileV67) return window.gdOpenProfileV67(); });
      safe(function () { return window.toast && window.toast("Sign in first"); });
      return false;
    }

    var route = safe(function () { return window.ClarityRouter && window.ClarityRouter.get && window.ClarityRouter.get(); }, null);
    var returnToGps = !!opts.fromGps || document.body.classList.contains("shell-gps") || document.body.classList.contains("gdGpsActive") || document.body.classList.contains("gps-active") || route && route.name === "gps";
    var profilePanel = document.getElementById("gdProfileV67");
    var explicitProfile = !!opts.fromProfile || window.__gdSettingsReturnTarget === "profile" || route && route.name === "profile";
    var returnToProfile = explicitProfile || !!(profilePanel && !profilePanel.classList.contains("hidden") && document.body.classList.contains("gdProfileOpen"));
    var returnProfile = returnToProfile ? profile(activeAccount) : null;

    safe(function () { if (window.gdCloseProfileV67) window.gdCloseProfileV67(); });
    safe(function () { document.querySelectorAll(".modulePanel.open,.panel.open").forEach(function (panel) { panel.classList.remove("open"); }); });
    safe(function () { document.getElementById("shellHome") && document.getElementById("shellHome").classList.add("hidden"); });
    safe(function () { document.body.classList.remove("shell-home", "shell-gps", "gdGpsActive", "gps-active", "gps-open", "manual-gps-active", "gdProfileOpen"); });
    safe(function () { document.body.classList.add("shell-module"); });
    safe(function () { if (typeof window.hideGpsSurface === "function") window.hideGpsSurface(); });
    safe(function () { if (typeof window.showShellChrome === "function") window.showShellChrome(true); });
    safe(function () { if (typeof window.setShellLayer === "function") window.setShellLayer("module"); });
    safe(function () { if (typeof window.setDockActive === "function") window.setDockActive(""); });
    safe(function () { if (typeof window.setRouteLabel === "function") window.setRouteLabel("Settings"); });
    safe(function () {
      window.__gdBackTarget = returnToProfile ? "profile" : returnToGps ? "gps" : "home";
      if (returnToProfile && returnProfile) {
        window.__gdProfileReturnProfileId = returnProfile.id || activeAccount.profileId || "";
        window.__gdProfileReturnName = returnProfile.name || activeAccount.name || "Profile";
      }
      window.__gdSettingsReturnTarget = "";
    });

    activeSection = activeAccount.requiresPasswordSetup ? "password" : "menu";
    safe(function () {
      if (window.ClarityRouter) {
        window.ClarityRouter.navigate("playerSettings", {
          replace: !!opts.replace,
          source: "player-settings",
          params: { returnTo: window.__gdBackTarget || "home" }
        });
      }
    });
    safe(function () { if (window.openPanel) window.openPanel("playerSettingsPanel"); });
    render();
    refreshButton();
    return false;
  }

  function save() {
    var api = window.GolfDaddyAccounts;
    try {
      if (!api || typeof api.update !== "function") throw new Error("Account system not ready");
      var activeAccount = account();
      var passwordValue = document.getElementById("gdPlayerSettingsPassword") && document.getElementById("gdPlayerSettingsPassword").value || "";
      if (activeAccount && activeAccount.requiresPasswordSetup && !String(passwordValue).trim()) throw new Error("Choose your own password");
      api.update({
        name: document.getElementById("gdPlayerSettingsName") && document.getElementById("gdPlayerSettingsName").value,
        email: document.getElementById("gdPlayerSettingsEmail") && document.getElementById("gdPlayerSettingsEmail").value,
        password: passwordValue,
        role: activeAccount && activeAccount.role
      });
      render();
      safe(function () { if (typeof window.renderProfilePanel === "function") window.renderProfilePanel(); });
      safe(function () { if (typeof window.updateProfileHomeUI === "function") window.updateProfileHomeUI(); });
      safe(function () { if (window.ClaritySession) window.ClaritySession.sync("settings-save"); });
      safe(function () { return window.toast && window.toast("Settings saved"); });
    } catch (error) {
      safe(function () { return window.toast && window.toast(error && error.message ? error.message : "Could not save settings"); });
    }
  }

  function signOut() {
    safe(function () { document.getElementById("playerSettingsPanel").classList.remove("open"); });
    safe(function () { if (typeof window.gd67Logout === "function") window.gd67Logout(); });
    safe(function () { if (window.ClaritySession) window.ClaritySession.sync("settings-sign-out"); });
    refreshButton();
  }

  function connectCoach() {
    var api = window.GolfDaddyAccounts;
    try {
      if (!api || typeof api.connectCoachByCode !== "function") throw new Error("Coach connection is not ready");
      var coach = api.connectCoachByCode(document.getElementById("gdPlayerSettingsCoachCode") && document.getElementById("gdPlayerSettingsCoachCode").value);
      var code = document.getElementById("gdPlayerSettingsCoachCode");
      if (code) code.value = "";
      render();
      safe(function () { return window.toast && window.toast("Connected to " + (coach.name || "Coach")); });
    } catch (error) {
      safe(function () { return window.toast && window.toast(error && error.message ? error.message : "Could not connect coach"); });
    }
  }

  function openBackup() {
    try {
      if (window.ClarityBackup && typeof window.ClarityBackup.open === "function") {
        window.ClarityBackup.open();
        return false;
      }
      throw new Error("Backup is not ready yet");
    } catch (error) {
      safe(function () { return window.toast && window.toast(error && error.message ? error.message : "Could not open backup"); });
    }
    return false;
  }

  function openSupport() {
    try {
      if (window.ClaritySupport && typeof window.ClaritySupport.open === "function") {
        window.ClaritySupport.open();
        return false;
      }
      var btn = document.getElementById("claritySupportButton");
      if (btn) {
        btn.click();
        return false;
      }
      throw new Error("Support is not ready yet");
    } catch (error) {
      safe(function () { return window.toast && window.toast(error && error.message ? error.message : "Could not open support"); });
    }
    return false;
  }

  function uploadPhoto(event) {
    var file = event && event.target && event.target.files && event.target.files[0];
    if (!file) return;
    if (!file.type || !file.type.startsWith("image/")) {
      safe(function () { return window.toast && window.toast("Choose an image file"); });
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var max = 640;
        var scale = Math.min(1, max / Math.max(img.width || max, img.height || max));
        var canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round((img.width || max) * scale));
        canvas.height = Math.max(1, Math.round((img.height || max) * scale));
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        var activeAccount = account();
        var activeProfile = profile(activeAccount);
        if (activeProfile) {
          var photo = canvas.toDataURL("image/jpeg", 0.82);
          safe(function () {
            activeProfile = window.gdSaveProfilePhotoDataUrl ? window.gdSaveProfilePhotoDataUrl(photo, activeAccount) : null;
          });
          if (!activeProfile) {
            activeProfile = profile(activeAccount);
            activeProfile.profilePhotoDataUrl = photo;
            activeProfile.photoDataUrl = photo;
            activeProfile.updatedAt = new Date().toISOString();
            safe(function () { if (window.savePlayerProfiles) window.savePlayerProfiles(); });
            safe(function () { if (window.syncCoreProfileFromActive) window.syncCoreProfileFromActive(); });
          }
          render();
          safe(function () { if (typeof window.renderProfilePanel === "function") window.renderProfilePanel(); });
          safe(function () { return window.toast && window.toast("Profile photo saved"); });
        }
      };
      img.onerror = function () { safe(function () { return window.toast && window.toast("Could not read photo"); }); };
      img.src = String(reader.result || "");
    };
    reader.onerror = function () { safe(function () { return window.toast && window.toast("Could not open photo"); }); };
    reader.readAsDataURL(file);
  }

  function ensureButton() {
    var old = document.getElementById("gdPlayerSettingsBtn");
    if (old) old.remove();
    return document.querySelector(".gdHomePlayerSettings");
  }

  function refreshButton() {
    ensureButton();
    var activeAccount = account();
    var gps = document.body.classList.contains("shell-gps") || document.body.classList.contains("gdGpsActive") || document.body.classList.contains("gps-active");
    document.querySelectorAll(".gdHomePlayerSettings").forEach(function (btn) {
      btn.classList.toggle("visible", !!activeAccount && !gps);
      btn.title = activeAccount ? "Settings for " + (activeAccount.name || activeAccount.email || "account") : "";
    });
  }

  document.addEventListener("DOMContentLoaded", function () { setTimeout(refreshButton, 100); });
  document.addEventListener("click", function () { setTimeout(refreshButton, 80); }, true);
  window.addEventListener("clarity:session-changed", refreshButton);
  window.addEventListener("clarity:route-changed", refreshButton);

  window.gdOpenPlayerSettingsPanel = open;
  window.gdPlayerSettingsShowSection = showSection;
  window.gdRenderPlayerSettingsPanel = render;
  window.gdSavePlayerSettings = save;
  window.gdPlayerSettingsUploadPhoto = uploadPhoto;
  window.gdPlayerSettingsSignOut = signOut;
  window.gdConnectCoachFromSettings = connectCoach;
  window.gdOpenPlayerSettingsBackup = openBackup;
  window.gdOpenPlayerSettingsSupport = openSupport;
  window.gdRefreshPlayerSettingsButton = refreshButton;
})();
