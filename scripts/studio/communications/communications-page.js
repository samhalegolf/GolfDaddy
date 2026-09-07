/* Clarity Studio — Communications page. Studio-only.
 *
 * Answers two questions that previously had no screen at all: what does Clarity email people,
 * and why does each one go out. Both answers come from scripts/gd-email-templates-core.js —
 * the same module the Netlify functions render from — so this page cannot drift into
 * describing an email that is no longer sent, or missing one that is. A preview here is the
 * real template with sample data, not a mock-up of it.
 *
 * Welcome Emails is the one section that also EDITS. Two templates, Basic Sign Up and Comped
 * Sign Up, chosen by the signup flow from what actually happened to the player's entitlement.
 * They live here rather than behind a button in Admin → Users because "what do we say to a new
 * player" is a communications decision, not a row-level user operation — and because there is
 * now more than one of them.
 *
 * What it still does NOT do: build email HTML. Every field below is content. The shell, the
 * escaping, the branding and the final markup stay in the template core, and Preview and Send
 * Test both go through the production renderer and the production delivery path — a friendlier
 * second approximation of the email is how a preview starts lying. The delivery panel is
 * read-only booleans from payment-admin's settings action — never secret values. */
(function () {
  "use strict";

  var PREVIEW_HEIGHT = 520;
  var FIELDS = [
    { key: "subject", label: "Subject", maxlength: 140 },
    { key: "headline", label: "Headline", maxlength: 180 },
    { key: "body", label: "Message", maxlength: 4000, textarea: true },
    { key: "ctaLabel", label: "Button text", maxlength: 80 },
    { key: "ctaUrl", label: "Button destination", maxlength: 900, placeholder: "Leave empty to use Clarity" }
  ];

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function core() {
    return window.GDEmailTemplatesCore || null;
  }

  async function welcomeApi(body) {
    var auth = window.ClaritySupabaseAuth;
    var token = auth && typeof auth.freshAccessToken === "function" ? await auth.freshAccessToken() : "";
    if (!token) throw new Error("Sign in again to manage welcome emails.");
    var response = await fetch("/api/caddy-admin-welcome-email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify(body)
    });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(data.error || "Welcome Email request failed");
    return data;
  }

  var GROUP_NOTES = {
    "Welcome Emails": "Three independent templates. Which one a new account gets is never a setting — "
      + "it is decided by what actually happened: whether a coach created the account for them, and "
      + "whether comped access was really issued.",
    "Account Updates": "Sent while someone is already a player, rather than when they arrive."
  };

  function categoryBadge(entry) {
    if (entry.category === "optional") return '<span class="gdStudioEmailBadge">Player can opt out</span>';
    var isService = entry.category === "service";
    return '<span class="gdStudioEmailBadge' + (isService ? " isService" : "") + '">'
      + (isService ? "Always sends" : "Opt-in") + "</span>";
  }

  function factsHTML(entry) {
    return '<dl class="gdStudioEmailFacts">'
      + "<dt>Goes to</dt><dd>" + esc(entry.recipient) + "</dd>"
      + "<dt>Sent when</dt><dd>" + esc(entry.trigger) + "</dd>"
      + "<dt>Suppression</dt><dd>" + esc(entry.gating) + "</dd>"
      + "<dt>Button</dt><dd>" + esc(entry.cta) + "</dd>"
      + "<dt>Sent by</dt><dd><code>" + esc(entry.sender) + "</code></dd>"
      + "</dl>";
  }

  function entryHTML(entry, index) {
    return '<article class="gdStudioEmailCard" data-gd-email-id="' + esc(entry.id) + '">'
      + '<header class="gdStudioEmailHead">'
      + '<div><h3>' + esc(entry.label) + "</h3>"
      + '<code>' + esc(entry.eventType) + "</code></div>"
      + categoryBadge(entry)
      + "</header>"
      + factsHTML(entry)
      + (entry.previewNote ? '<p class="gdStudioNeedsVerification">' + esc(entry.previewNote) + "</p>" : "")
      + '<div class="gdStudioEmailActions">'
      + '<button type="button" class="gdStudioDiagramBtn" data-gd-email-preview="' + esc(entry.id) + '">Preview this email</button>'
      + '<button type="button" class="gdStudioDiagramBtn" data-gd-email-source="' + esc(entry.id) + '">Show subject &amp; plain text</button>'
      + "</div>"
      + '<div class="gdStudioEmailPreview" id="gdStudioEmailPreview-' + index + '" hidden></div>'
      + "</article>";
  }

  function variablesHTML(api) {
    var list = (api.TEMPLATE_VARIABLES || []).map(function (v) {
      return "<code data-gd-email-var=\"" + esc(v.key) + "\">{{" + esc(v.key) + "}}</code> " + esc(v.note);
    }).join(" · ");
    return '<p class="gdStudioEmailVars">Click a variable to copy it. ' + list
      + ". An unknown or empty variable disappears rather than printing, and a line that has "
      + "nothing left to say is dropped with it.</p>";
  }

  function fieldHTML(field, value) {
    var attrs = 'data-gd-field="' + esc(field.key) + '" maxlength="' + field.maxlength + '"'
      + (field.placeholder ? ' placeholder="' + esc(field.placeholder) + '"' : "");
    var control = field.textarea
      ? "<textarea " + attrs + ">" + esc(value) + "</textarea>"
      : '<input type="text" ' + attrs + ' value="' + esc(value) + '">';
    return "<label>" + esc(field.label) + control + "</label>";
  }

  function editorHTML(entry, loaded, api) {
    var template = (loaded && loaded.template) || api.defaultSignupTemplate(entry.templateKey);
    /* Say which of "never edited", "could not be read" and "last saved on X" the admin is
       looking at. They need different responses, and a card that claims a save date it does
       not have is the one that gets overwritten by accident. */
    var origin = !loaded || loaded.error
      ? '<span class="gdStudioNeedsVerification">Stored copy could not be read'
        + (loaded && loaded.error ? " (" + esc(loaded.error) + ")" : "")
        + " — the built-in default is shown below, and that is what a send would use right now.</span>"
      : loaded.isDefault
        ? "Never edited — showing the built-in default, which is what is being sent."
        : loaded.updatedAt
          ? "Last saved " + esc(new Date(loaded.updatedAt).toLocaleString()) + "."
          : "Saved, but with no recorded date.";
    return '<article class="gdStudioEmailCard isEditable" data-gd-template="' + esc(entry.templateKey) + '">'
      + '<header class="gdStudioEmailHead">'
      + "<div><h3>" + esc(entry.label) + "</h3><code>" + esc(entry.templateKey) + "</code></div>"
      + categoryBadge(entry)
      + "</header>"
      + factsHTML(entry)
      + '<p class="gdStudioMuted">' + origin + "</p>"
      + '<div class="gdStudioEmailEditor">'
      + FIELDS.map(function (f) { return fieldHTML(f, template[f.key] || ""); }).join("")
      + variablesHTML(api)
      + "</div>"
      + '<div class="gdStudioEmailActions">'
      + '<button type="button" class="gdStudioDiagramBtn" data-gd-action="preview">Preview Email</button>'
      + '<button type="button" class="gdStudioDiagramBtn" data-gd-action="test">Send Test</button>'
      + '<button type="button" class="gdStudioDiagramBtn" data-gd-action="save">Save</button>'
      + '<button type="button" class="gdStudioDiagramBtn" data-gd-action="revert">Reset to default</button>'
      + "</div>"
      + '<p class="gdStudioEmailStatusLine" data-gd-status></p>'
      + '<div class="gdStudioEmailPreview" data-gd-preview hidden></div>'
      + "</article>";
  }

  function deliveryHTML(state) {
    if (state.loading) return '<p class="gdStudioMuted">Reading delivery settings…</p>';
    if (state.error) {
      return '<p class="gdStudioNeedsVerification">Delivery settings could not be read: ' + esc(state.error)
        + " The catalogue below is still accurate — this panel only reports whether the server can send.</p>";
    }
    var d = state.delivery;
    if (!d) return '<p class="gdStudioMuted">Delivery settings were not reported by this build.</p>';
    function row(label, ok, detail) {
      return '<div class="gdStudioEmailStatusRow"><span class="gdStudioEmailDot' + (ok ? " isOn" : "") + '"></span>'
        + "<strong>" + esc(label) + "</strong><span>" + esc(detail) + "</span></div>";
    }
    return '<div class="gdStudioEmailStatus">'
      + row("Email provider", !!d.providerConfigured, d.providerConfigured
        ? "RESEND_API_KEY is set — service emails can send."
        : "RESEND_API_KEY is not set. Nothing below sends; senders return not_configured rather than failing.")
      + row("From address", !!d.fromAddress, d.fromAddress || "CLARITY_EMAIL_FROM unset — the built-in default is used.")
      + row("Site URL in links", !!d.siteUrl, d.siteUrl || "CLARITY_SITE_URL unset — links fall back to caddy.claritygolf.app.")
      + row("Opt-in activity emails", !!d.activityEmailsEnabled, d.activityEmailsEnabled
        ? "EMAIL_NOTIFICATIONS_ENABLED=1 — connected-account activity can send, still subject to each recipient's preference."
        : "EMAIL_NOTIFICATIONS_ENABLED is off. Activity emails are prepared and returned as a preview, never delivered. Service emails are unaffected.")
      + "</div>";
  }

  function render(containerEl, record) {
    var api = core();
    if (!api) {
      containerEl.innerHTML = '<div class="gdStudioPlaceholder">'
        + '<div class="gdStudioPlaceholderBadge">Template core not loaded</div>'
        + "<p>scripts/gd-email-templates-core.js did not load on this surface, so the email catalogue "
        + "cannot be shown. Everything on this page is read from that file.</p></div>";
      return;
    }

    var entries = api.catalogue();
    var editable = entries.filter(function (e) { return e.editable; });
    var rest = entries.filter(function (e) { return !e.editable; });
    /* Grouped by what fires them, in catalogue order - the order is the order they were
       thought about, and a template that has no group would otherwise vanish from the page. */
    var groups = [];
    editable.forEach(function (entry) {
      var name = entry.group || "Templates";
      var group = null;
      for (var i = 0; i < groups.length; i++) if (groups[i].name === name) { group = groups[i]; break; }
      if (!group) { group = { name: name, entries: [] }; groups.push(group); }
      group.entries.push(entry);
    });
    var deliveryState = { loading: true, error: "", delivery: null };
    var welcomeState = { loading: true, error: "", byKey: {} };
    var destroyed = false;

    function groupHTML(group) {
      return '<section><h3 class="gdStudioJobHistoryHeading">' + esc(group.name) + "</h3>"
        + '<p class="gdStudioMuted">' + esc(GROUP_NOTES[group.name] || "") + "</p>"
        + '<div data-gd-group="' + esc(group.name) + '">'
        + (welcomeState.loading
          ? '<p class="gdStudioMuted">Reading the stored templates…</p>'
          : group.entries.map(function (entry) {
              return editorHTML(entry, welcomeState.byKey[entry.templateKey], api);
            }).join(""))
        + "</div></section>";
    }

    function paint() {
      containerEl.innerHTML =
        '<div class="gdStudioEmailPage">'
        + '<p class="gdStudioLede">' + esc((record && record.function) || "") + "</p>"
        + '<section><h3 class="gdStudioJobHistoryHeading">Delivery</h3>'
        + '<div id="gdStudioEmailDelivery">' + deliveryHTML(deliveryState) + "</div></section>"
        + '<div id="gdStudioWelcomeEmails">'
        + (welcomeState.error ? '<p class="gdStudioNeedsVerification">Saved templates could not be read: ' + esc(welcomeState.error)
            + " The built-in defaults are shown below — that is also what a send would use right now, so nothing is broken, "
            + "but do not save over a template you cannot see.</p>" : "")
        + groups.map(groupHTML).join("")
        + "</div>"
        + '<section><h3 class="gdStudioJobHistoryHeading">Every other email Clarity sends (' + rest.length + ")</h3>"
        + '<p class="gdStudioMuted">Read from scripts/gd-email-templates-core.js, which is also what the '
        + "Netlify functions render from — so a preview here is the real message, and a sender missing from "
        + "this list is a sender nobody can audit. These are written in code rather than edited here.</p>"
        + rest.map(entryHTML).join("")
        + "</section></div>";
    }

    function repaintDelivery() {
      var host = containerEl.querySelector("#gdStudioEmailDelivery");
      if (host) host.innerHTML = deliveryHTML(deliveryState);
    }
    function repaintWelcome() {
      var host = containerEl.querySelector("#gdStudioWelcomeEmails");
      if (!host) return;
      host.innerHTML = (welcomeState.error
        ? '<p class="gdStudioNeedsVerification">Saved templates could not be read: ' + esc(welcomeState.error)
          + " The built-in defaults are shown below — that is also what a send would use right now, so nothing is broken, "
          + "but do not save over a template you cannot see.</p>"
        : "") + groups.map(groupHTML).join("");
    }

    /* Delivery config comes from payment-admin's settings action, which is already the
       admin-gated read this surface has. Booleans and a from-address only; no secret ever
       crosses this boundary. */
    function loadDelivery() {
      var payments = window.ClarityPayments;
      if (!payments || typeof payments.adminSettings !== "function") {
        deliveryState = { loading: false, error: "", delivery: null };
        repaintDelivery();
        return;
      }
      Promise.resolve(payments.adminSettings()).then(function (body) {
        if (destroyed) return;
        deliveryState = { loading: false, error: "", delivery: (body && body.emailDelivery) || null };
        repaintDelivery();
      }).catch(function (error) {
        if (destroyed) return;
        deliveryState = { loading: false, error: (error && error.message) || "request failed.", delivery: null };
        repaintDelivery();
      });
    }

    function loadWelcome() {
      welcomeApi({ action: "list_templates" }).then(function (data) {
        if (destroyed) return;
        var byKey = {};
        (data.templates || []).forEach(function (t) { byKey[t.templateKey] = t; });
        welcomeState = { loading: false, error: "", byKey: byKey };
        repaintWelcome();
      }).catch(function (error) {
        if (destroyed) return;
        welcomeState = { loading: false, error: (error && error.message) || "request failed.", byKey: {} };
        repaintWelcome();
      });
    }

    /* The preview is rendered into a sandboxed srcdoc iframe, not into the page. Email HTML is
       a full document with its own <body> background and font stack; dropping it inline would
       both break out of the Studio layout and let it restyle the page around it. */
    function frameInto(host, html) {
      var frame = document.createElement("iframe");
      frame.className = "gdStudioEmailFrame";
      frame.setAttribute("sandbox", "");
      frame.setAttribute("title", "Email preview");
      frame.style.height = PREVIEW_HEIGHT + "px";
      frame.srcdoc = html;
      host.innerHTML = "";
      host.appendChild(frame);
      host.hidden = false;
    }

    function togglePreview(id, mode) {
      var index = -1;
      for (var i = 0; i < rest.length; i++) if (rest[i].id === id) { index = i; break; }
      if (index < 0) return;
      var host = containerEl.querySelector("#gdStudioEmailPreview-" + index);
      if (!host) return;
      if (!host.hidden && host.getAttribute("data-gd-mode") === mode) { host.hidden = true; host.innerHTML = ""; return; }
      var built = api.build(rest[index].eventType, Object.assign({ to: "player@example.com" }, rest[index].sample || {}));
      host.setAttribute("data-gd-mode", mode);
      if (mode === "source") {
        host.innerHTML = '<div class="gdStudioEmailSource">'
          + "<p><strong>Subject</strong><br><code>" + esc(built.subject) + "</code></p>"
          + "<p><strong>Plain-text part</strong></p><pre>" + esc(built.text) + "</pre></div>";
        host.hidden = false;
      } else {
        frameInto(host, built.html);
      }
    }

    /* ---- the editable half ---- */

    function cardFor(node) { return node.closest("[data-gd-template]"); }
    function draftFrom(card) {
      var out = {};
      FIELDS.forEach(function (f) {
        var el = card.querySelector('[data-gd-field="' + f.key + '"]');
        out[f.key] = el ? el.value : "";
      });
      return out;
    }
    function say(card, message, kind) {
      var line = card.querySelector("[data-gd-status]");
      if (!line) return;
      line.textContent = message;
      line.className = "gdStudioEmailStatusLine" + (kind ? " is" + kind : "");
    }

    function runAction(card, action) {
      var key = card.getAttribute("data-gd-template");
      var template = draftFrom(card);
      if (action === "revert") {
        var fallback = api.defaultSignupTemplate(key);
        FIELDS.forEach(function (f) {
          var el = card.querySelector('[data-gd-field="' + f.key + '"]');
          if (el) el.value = fallback[f.key] || "";
        });
        say(card, "Built-in default loaded into the form. Nothing is saved until you press Save.", "");
        return;
      }
      if (action === "preview") {
        say(card, "Rendering…", "");
        welcomeApi({ action: "preview", templateKey: key, template: template }).then(function (data) {
          if (destroyed) return;
          frameInto(card.querySelector("[data-gd-preview]"), (data.preview && data.preview.html) || "");
          say(card, "Preview built by the production renderer — subject: " + ((data.preview && data.preview.subject) || ""), "Ok");
        }).catch(function (error) { say(card, error.message, "Error"); });
        return;
      }
      if (action === "test") {
        say(card, "Sending test…", "");
        welcomeApi({ action: "send_test", templateKey: key, template: template }).then(function (data) {
          if (destroyed) return;
          say(card, "Test sent to " + ((data.result && data.result.recipientEmail) || "your admin email")
            + ". Only the subject is marked as a test; the saved template is untouched.", "Ok");
        }).catch(function (error) { say(card, error.message, "Error"); });
        return;
      }
      if (action === "save") {
        say(card, "Saving…", "");
        welcomeApi({ action: "save_template", templateKey: key, template: template }).then(function (data) {
          if (destroyed) return;
          welcomeState.byKey[key] = { templateKey: key, template: data.template, updatedAt: new Date().toISOString(), isDefault: false, error: "" };
          say(card, "Saved. This is what the next matching signup will send.", "Ok");
        }).catch(function (error) { say(card, error.message, "Error"); });
      }
    }

    function onClick(event) {
      var variable = event.target.closest("[data-gd-email-var]");
      if (variable) {
        try { navigator.clipboard.writeText("{{" + variable.getAttribute("data-gd-email-var") + "}}"); } catch (_e) {}
        return;
      }
      var action = event.target.closest("[data-gd-action]");
      if (action) {
        var card = cardFor(action);
        if (card) runAction(card, action.getAttribute("data-gd-action"));
        return;
      }
      var preview = event.target.closest("[data-gd-email-preview]");
      if (preview) { togglePreview(preview.getAttribute("data-gd-email-preview"), "html"); return; }
      var source = event.target.closest("[data-gd-email-source]");
      if (source) togglePreview(source.getAttribute("data-gd-email-source"), "source");
    }

    paint();
    containerEl.addEventListener("click", onClick);
    loadDelivery();
    loadWelcome();

    return function () {
      destroyed = true;
      containerEl.removeEventListener("click", onClick);
    };
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["communications"] = render;
})();
