(function(){
  "use strict";

  var STORE_KEY = "gd_email_notification_events_v1";
  var PREF_KEY = "notificationPreferences";
  var BASE_URL = "/api/email-notification";
  var lastEventKey = "";
  var lastEventAt = 0;

  function safe(fn, fallback){
    try{return fn();}catch(e){return fallback;}
  }
  function escapeHTML(value){
    return String(value == null ? "" : value).replace(/[&<>"']/g,function(ch){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch];
    });
  }
  function nowISO(){return new Date().toISOString();}
  function role(account){return String(account && account.role || "player").toLowerCase();}
  function isStaff(account){var r=role(account);return r==="coach"||r==="admin";}
  function firstName(value){
    var name = String(value || "there").trim().split(/\s+/)[0] || "there";
    return name.replace(/[^\w'-]/g,"") || "there";
  }
  function accountsApi(){return window.GolfDaddyAccounts || window.ClarityCaddieAccounts || null;}
  function profilesApi(){return window.GolfDaddyProfiles || window.ClarityCaddieProfiles || null;}
  function currentAccount(){
    var api = accountsApi();
    return safe(function(){return api && typeof api.current === "function" ? api.current() : null;}, null);
  }
  function accountById(id){
    var api = accountsApi();
    var state = safe(function(){return api && typeof api.state === "function" ? api.state() : null;}, null);
    var list = state && Array.isArray(state.accounts) ? state.accounts : [];
    return list.find(function(account){return account && account.accountId === id;}) || null;
  }
  function accountByEmail(value){
    var api = accountsApi();
    var email = String(value || "").trim().toLowerCase();
    if(!email)return null;
    var state = safe(function(){return api && typeof api.state === "function" ? api.state() : null;}, null);
    var list = state && Array.isArray(state.accounts) ? state.accounts : [];
    return list.find(function(account){return String(account && account.email || "").trim().toLowerCase() === email;}) || null;
  }
  function accountForProfile(profileId){
    var api = accountsApi();
    return safe(function(){return api && typeof api.accountForProfile === "function" ? api.accountForProfile(profileId) : null;}, null);
  }
  function activeProfile(){
    return safe(function(){
      if(typeof window.activePlayerProfile === "function")return window.activePlayerProfile();
      var api = profilesApi();
      return api && typeof api.active === "function" ? api.active() : null;
    }, null);
  }
  function linkedCoaches(account){
    var ids = Array.isArray(account && account.linkedCoachIds) ? account.linkedCoachIds : [];
    return ids.map(accountById).filter(Boolean);
  }
  function linkedPlayers(account){
    var api = accountsApi();
    return safe(function(){return api && typeof api.linkedPlayers === "function" ? api.linkedPlayers(account) : [];}, []);
  }
  function saveAccounts(){
    var api = accountsApi();
    safe(function(){if(api && typeof api.save === "function")api.save();});
  }
  function readEvents(){
    return safe(function(){
      var parsed = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    }, []);
  }
  function writeEvents(events){
    safe(function(){localStorage.setItem(STORE_KEY, JSON.stringify((events || []).slice(0, 80)));});
  }
  function defaultPrefs(account){
    return {
      emailEnabled:false,
      coachUpdates:true,
      playerUpdates:true,
      accountUpdates:true,
      email:account && account.email || ""
    };
  }
  function getPreferences(account){
    var prefs = Object.assign(defaultPrefs(account), account && account[PREF_KEY] || {});
    prefs.emailEnabled = !!prefs.emailEnabled;
    prefs.coachUpdates = prefs.coachUpdates !== false;
    prefs.playerUpdates = prefs.playerUpdates !== false;
    prefs.accountUpdates = prefs.accountUpdates !== false;
    prefs.email = String(prefs.email || account && account.email || "").trim();
    return prefs;
  }
  function setPreferences(next, account){
    account = account || currentAccount();
    if(!account)return null;
    account[PREF_KEY] = Object.assign(getPreferences(account), next || {}, {email:account.email || ""});
    account.updatedAt = nowISO();
    saveAccounts();
    renderSettings();
    return account[PREF_KEY];
  }
  function prefsAllow(recipient, event){
    var prefs = getPreferences(recipient);
    if(!prefs.emailEnabled)return false;
    if(event && event.test)return true;
    if(event && event.direction === "coach_to_player")return prefs.coachUpdates !== false;
    if(event && event.direction === "player_to_coach")return prefs.playerUpdates !== false;
    return prefs.accountUpdates !== false;
  }
  function statusText(account){
    var prefs = getPreferences(account);
    if(!prefs.emailEnabled)return "Off";
    var bits = [];
    if(prefs.coachUpdates)bits.push("coach updates");
    if(prefs.playerUpdates)bits.push("player updates");
    return bits.length ? "On - " + bits.join(", ") : "On";
  }
  function renderToggle(id, on){
    var btn = document.getElementById(id);
    if(!btn)return;
    btn.textContent = on ? "On" : "Off";
    btn.classList.toggle("active", !!on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
  function renderSettings(){
    var account = currentAccount();
    var prefs = getPreferences(account);
    var line = document.getElementById("gdPlayerSettingsNotificationsLine");
    var sub = document.getElementById("gdEmailNotificationsSub");
    if(line)line.textContent = account ? statusText(account) : "Sign in to manage email updates.";
    if(sub)sub.textContent = prefs.emailEnabled ? "On for " + (prefs.email || account && account.email || "this account") : "Off";
    renderToggle("gdEmailNotificationsToggle", prefs.emailEnabled);
    renderToggle("gdEmailCoachUpdatesToggle", prefs.coachUpdates);
    renderToggle("gdEmailPlayerUpdatesToggle", prefs.playerUpdates);
  }
  function setStatus(message){
    var el = document.getElementById("gdEmailNotificationsStatus");
    if(el)el.textContent = message || "";
  }
  function toggleEmailNotifications(){
    var account = currentAccount();
    if(!account)return false;
    var prefs = getPreferences(account);
    setPreferences({emailEnabled:!prefs.emailEnabled}, account);
    setStatus(!prefs.emailEnabled ? "Email update notifications are on." : "Email update notifications are off.");
    return false;
  }
  function toggleKind(kind){
    var account = currentAccount();
    if(!account)return false;
    var prefs = getPreferences(account);
    if(kind !== "coachUpdates" && kind !== "playerUpdates")return false;
    var next = {};
    next[kind] = !prefs[kind];
    setPreferences(next, account);
    setStatus("Notification preference saved.");
    return false;
  }
  function logoUrl(){
    return new URL("assets/brand/cg-logo-white-g.png?v=clarity-20260531", location.origin + location.pathname).toString();
  }
  function appUrl(){
    return new URL(location.pathname || "/", location.origin).toString();
  }
  function passwordResetUrl(emailValue){
    var url = new URL(location.pathname || "/", location.origin);
    url.searchParams.set("clarityResetPassword", "1");
    url.searchParams.set("email", String(emailValue || "").trim());
    return url.toString();
  }
  function template(payload){
    var recipientName = firstName(payload.recipientName);
    var actorName = payload.actorName || "Clarity";
    var title = payload.title || "Your Clarity account was updated";
    var detail = payload.detail || "";
    var ctaUrl = payload.ctaUrl || location.origin + "/";
    var ctaLabel = payload.ctaLabel || "Open Clarity";
    var footer = isServiceEmail(payload)
      ? "You are receiving this because it relates to your Clarity account access."
      : "You can change email notifications in Settings &gt; Notifications.";
    var html = [
      "<!doctype html><html><body style=\"margin:0;background:#07100b;color:#f7faf7;font-family:Arial,sans-serif\">",
      "<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" style=\"background:#07100b;padding:28px 14px\"><tr><td align=\"center\">",
      "<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" style=\"max-width:560px;background:#101b15;border:1px solid rgba(255,255,255,.12);border-radius:20px;overflow:hidden\">",
      "<tr><td style=\"padding:24px 24px 16px;background:#07100b\"><img src=\""+escapeHTML(payload.logoUrl || logoUrl())+"\" width=\"44\" height=\"44\" alt=\"Clarity Golf\" style=\"vertical-align:middle;margin-right:12px\"><span style=\"font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#b9c4bd;font-weight:700\">Clarity Golf Systems</span></td></tr>",
      "<tr><td style=\"padding:24px\"><p style=\"margin:0 0 10px;color:#42b66a;font-weight:700\">Hi "+escapeHTML(recipientName)+",</p>",
      "<h1 style=\"margin:0 0 12px;color:#fff;font-size:28px;line-height:1.05\">"+escapeHTML(title)+"</h1>",
      "<p style=\"margin:0 0 18px;color:#c8d1cc;font-size:16px;line-height:1.45\">"+escapeHTML(detail)+"</p>",
      "<p style=\"margin:0 0 22px;color:#8fa199;font-size:13px;line-height:1.4\">Update from "+escapeHTML(actorName)+".</p>",
      "<a href=\""+escapeHTML(ctaUrl)+"\" style=\"display:inline-block;background:#ff9f2f;color:#06110b;text-decoration:none;font-weight:800;border-radius:999px;padding:12px 18px\">"+escapeHTML(ctaLabel)+"</a>",
      "</td></tr>",
      "<tr><td style=\"padding:16px 24px 24px;color:#708178;font-size:12px;line-height:1.45\">"+footer+"</td></tr>",
      "</table></td></tr></table></body></html>"
    ].join("");
    var text = "Hi " + recipientName + ",\\n\\n" + title + "\\n\\n" + detail + "\\n\\nUpdate from " + actorName + ".\\n\\n" + ctaUrl;
    return {html:html,text:text};
  }
  function eventTitle(kind, actor, target){
    var actorName = actor && actor.name || "A connected account";
    var targetName = target && target.name || "your account";
    if(kind === "bag")return actorName + " updated " + targetName + " bag";
    if(kind === "shot")return actorName + " updated " + targetName + " shot data";
    if(kind === "account")return actorName + " updated account details";
    return actorName + " updated " + targetName + " profile";
  }
  function eventDetail(kind, direction, actor, target){
    var actorName = actor && actor.name || "A connected account";
    var targetName = target && target.name || "this account";
    if(direction === "coach_to_player")return actorName + " updated " + targetName + ". Open the app to review the latest profile data.";
    if(direction === "player_to_coach")return targetName + " has new activity ready for coach review.";
    if(kind === "account")return "Account settings were saved in Clarity Caddie.";
    return "Profile activity was saved in Clarity Caddie.";
  }
  function recipientsFor(actor, targetOwner){
    if(!actor)return [];
    if(targetOwner && targetOwner.accountId && targetOwner.accountId !== actor.accountId){
      return [{account:targetOwner,direction:"coach_to_player"}];
    }
    if(role(actor) === "player")return linkedCoaches(actor).map(function(account){return {account:account,direction:"player_to_coach"};});
    if(isStaff(actor))return linkedPlayers(actor).map(function(account){return {account:account,direction:"coach_to_player"};});
    return [];
  }
  function queue(event){
    var events = readEvents();
    events.unshift(event);
    writeEvents(events);
  }
  async function sendToRecipient(event, recipient, force){
    var prefs = getPreferences(recipient);
    var allowed = force || prefsAllow(recipient, event);
    var recipientEmail = prefs.email || recipient.email || "";
    var payload = Object.assign({}, event, {
      to:recipientEmail,
      recipientName:recipient.name || recipient.email || "there",
      logoUrl:logoUrl(),
      html:template(Object.assign({}, event, {recipientName:recipient.name || recipient.email || "there"})).html,
      text:template(Object.assign({}, event, {recipientName:recipient.name || recipient.email || "there"})).text
    });
    var queued = Object.assign({}, event, {
      recipientAccountId:recipient.accountId,
      recipientEmail:recipientEmail,
      delivery:allowed ? "pending" : "muted"
    });
    queue(queued);
    if(!allowed || !recipientEmail)return {queued:true, muted:!allowed};
    try{
      var response = await fetch(BASE_URL, {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify(payload)
      });
      var body = await response.json().catch(function(){return {};});
      return Object.assign({ok:response.ok,status:response.status,queued:response.ok ? body.queued : false}, body);
    }catch(error){
      return {queued:false, error:"Email endpoint unavailable"};
    }
  }
  function serviceEvent(recipient, options){
    var actor = currentAccount();
    return {
      id:"email_evt_" + Date.now().toString(36) + Math.random().toString(36).slice(2,7),
      kind:"service",
      eventType:options && options.eventType || "account_activity",
      actorAccountId:actor && actor.accountId || "",
      actorName:options && options.actorName || "Clarity Golf Systems",
      targetAccountId:recipient && recipient.accountId || "",
      targetName:recipient && recipient.name || "",
      direction:"service",
      title:options && options.title || "Your Clarity account is ready",
      detail:options && options.detail || "Your account has been updated in Clarity Caddie.",
      ctaLabel:options && options.ctaLabel || "Open Clarity",
      ctaUrl:options && options.ctaUrl || appUrl(),
      createdAt:nowISO()
    };
  }
  function isServiceEmail(event){
    return ["account_created","password_recovery"].indexOf(event && event.eventType) !== -1;
  }
  function sendServiceEmail(recipient, options){
    if(!recipient)return Promise.resolve({queued:false});
    return sendToRecipient(serviceEvent(recipient, options), recipient, true);
  }
  function sendPasswordRecovery(emailValue){
    var account = accountByEmail(emailValue);
    if(!account)return Promise.resolve({queued:false});
    return sendServiceEmail(account, {
      eventType:"password_recovery",
      title:"Reset your Clarity password",
      detail:"A password reset was requested for this Clarity account. Use the button below to set a new password.",
      ctaLabel:"Set New Password",
      ctaUrl:passwordResetUrl(account.email)
    });
  }
  function recordActivity(options){
    var actor = options && options.actor || currentAccount();
    var profile = options && options.profile || activeProfile();
    var targetOwner = options && options.targetOwner || accountForProfile(profile && profile.id);
    var target = targetOwner || profile || {};
    var kind = options && options.kind || "profile";
    var recipients = options && options.recipients || recipientsFor(actor, targetOwner);
    var event = {
      id:"email_evt_" + Date.now().toString(36) + Math.random().toString(36).slice(2,7),
      kind:kind,
      eventType:options && options.eventType || "account_activity",
      actorAccountId:actor && actor.accountId || "",
      actorName:actor && actor.name || "",
      targetAccountId:targetOwner && targetOwner.accountId || "",
      targetName:target.name || profile && profile.name || "",
      direction:"",
      title:options && options.title || eventTitle(kind, actor, target),
      detail:options && options.detail || "",
      ctaLabel:"Open Clarity",
      ctaUrl:location.origin + location.pathname,
      createdAt:nowISO(),
      test:!!(options && options.test)
    };
    if(!event.detail)event.detail = eventDetail(kind, "", actor, target);
    var duplicateKey = [event.kind,event.actorAccountId,event.targetAccountId,event.title].join("|");
    if(duplicateKey === lastEventKey && Date.now() - lastEventAt < 2500)return Promise.resolve([]);
    lastEventKey = duplicateKey;
    lastEventAt = Date.now();
    return Promise.all(recipients.map(function(item){
      var recipient = item.account || item;
      var direction = item.direction || "";
      var eventForRecipient = Object.assign({}, event, {
        direction:direction,
        detail:options && options.detail || eventDetail(kind, direction, actor, target)
      });
      return sendToRecipient(eventForRecipient, recipient, options && options.force);
    }));
  }
  function sendTest(){
    var account = currentAccount();
    if(!account)return false;
    setStatus("Preparing test email...");
    recordActivity({
      kind:"profile",
      test:true,
      force:true,
      recipients:[{account:account,direction:"account"}],
      title:"Test email notification",
      detail:"This is the base Clarity email template with automatic account naming."
    }).then(function(results){
      var result = results && results[0] || {};
      setStatus(result.sent ? "Test email sent." : (result.error || result.status >= 400 ? "Test email could not be sent." : "Test email queued."));
    });
    return false;
  }
  function wrap(name, kind, title){
    var original = window[name];
    if(typeof original !== "function" || original.__clarityEmailWrapped)return;
    var wrapped = function(){
      var result = original.apply(this, arguments);
      setTimeout(function(){
        recordActivity({kind:kind,title:title}).catch(function(){});
      }, 0);
      return result;
    };
    wrapped.__clarityEmailWrapped = true;
    window[name] = wrapped;
  }
  function wrapAccounts(){
    var api = accountsApi();
    if(!api || api.__clarityEmailWrapped)return;
    ["update","addPlayer","addCoach","connectCoachByCode","signup"].forEach(function(name){
      var original = api[name];
      if(typeof original !== "function")return;
      api[name] = function(){
        var actor = currentAccount();
        var result = original.apply(api, arguments);
        setTimeout(function(){
          if(name === "signup"){
            sendServiceEmail(result, {
              eventType:"account_created",
              title:"Your Clarity account is ready",
              detail:"Your player account has been created. You can now add your bag, enter shot data, and connect to a coach from Settings.",
              ctaLabel:"Open Clarity"
            }).catch(function(){});
            return;
          }
          if(name === "addPlayer" || name === "addCoach"){
            sendServiceEmail(result, {
              eventType:"account_created",
              title:"Your Clarity account is ready",
              detail:"Your account has been created by " + ((actor && actor.name) || "your coach") + ". Sign in with the temporary password, then open Settings to set your own password.",
              ctaLabel:"Open Settings"
            }).catch(function(){});
            recordActivity({
              kind:"profile",
              actor:actor,
              targetOwner:result,
              title:name === "addPlayer" ? "A player account was created" : "A coach account was created",
              detail:"A new account was created in Clarity Caddie."
            }).catch(function(){});
            return;
          }
          var kind = name === "update" ? "account" : "profile";
          recordActivity({kind:kind}).catch(function(){});
        }, 0);
        return result;
      };
    });
    api.__clarityEmailWrapped = true;
  }
  function wrapAuthHelpers(){
    var forgot = window.gd67ForgotPassword;
    if(typeof forgot === "function" && !forgot.__clarityEmailWrapped){
      var wrappedForgot = function(){
        var emailValue = document.getElementById("gd67AuthEmail") && document.getElementById("gd67AuthEmail").value || "";
        var result = forgot.apply(this, arguments);
        sendPasswordRecovery(emailValue).then(function(sendResult){
          var help = document.getElementById("gd67ForgotPasswordHelp");
          if(help && sendResult){
            if(sendResult.sent){
              help.textContent = "Password reset email sent.";
            }else if(sendResult.error || sendResult.status >= 400){
              help.textContent = "Password reset email could not be sent. Check the account uses a real email address.";
            }else if(sendResult.queued !== false){
              help.textContent = "Password reset email queued.";
            }else{
              help.textContent = "No Clarity account found for that email.";
            }
          }
        }).catch(function(){});
        return result;
      };
      wrappedForgot.__clarityEmailWrapped = true;
      window.gd67ForgotPassword = wrappedForgot;
    }
  }
  function installHooks(){
    wrap("gdSavePlayerSettings","profile");
    wrap("gdBagSave","bag");
    wrap("gdBagTryAddClub","bag");
    wrap("gdBagGenerateQuick","bag");
    wrap("gdBagSetFirmness","bag");
    wrap("gdBubbleOffsetSave","shot");
    wrapAccounts();
    wrapAuthHelpers();
    renderSettings();
  }

  window.ClarityEmail = {
    defaultPrefs:defaultPrefs,
    getPreferences:getPreferences,
    setPreferences:setPreferences,
    sendServiceEmail:sendServiceEmail,
    sendPasswordRecovery:sendPasswordRecovery,
    renderSettings:renderSettings,
    recordActivity:recordActivity,
    readEvents:readEvents,
    template:template,
    sendTest:sendTest
  };
  window.gdToggleEmailNotifications = toggleEmailNotifications;
  window.gdToggleEmailNotificationKind = toggleKind;
  window.gdSendTestEmailNotification = sendTest;

  if(document.readyState === "loading")document.addEventListener("DOMContentLoaded", installHooks);
  else installHooks();
})();
