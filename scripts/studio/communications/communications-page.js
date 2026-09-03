/* Clarity Studio — Communications page. Studio-only.
 *
 * Answers two questions that previously had no screen at all: what does Clarity email people,
 * and why does each one go out. Both answers come from scripts/gd-email-templates-core.js —
 * the same module the Netlify functions render from — so this page cannot drift into
 * describing an email that is no longer sent, or missing one that is. A preview here is the
 * real template with sample data, not a mock-up of it.
 *
 * What it deliberately does NOT do: send anything, or edit copy. Copy lives in the core file
 * under review; a Studio text box editing production email wording is a bigger decision than
 * "let me see what's being sent", which is what was asked for. The delivery panel is read-only
 * booleans from payment-admin's settings action — never secret values. */
(function () {
  "use strict";

  var PREVIEW_HEIGHT = 520;

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function core() {
    return window.GDEmailTemplatesCore || null;
  }

  function categoryBadge(entry) {
    var isService = entry.category === "service";
    return '<span class="gdStudioEmailBadge' + (isService ? " isService" : "") + '">'
      + (isService ? "Always sends" : "Opt-in") + "</span>";
  }

  function entryHTML(entry, index) {
    return '<article class="gdStudioEmailCard" data-gd-email-id="' + esc(entry.id) + '">'
      + '<header class="gdStudioEmailHead">'
      + '<div><h3>' + esc(entry.label) + "</h3>"
      + '<code>' + esc(entry.eventType) + "</code></div>"
      + categoryBadge(entry)
      + "</header>"
      + '<dl class="gdStudioEmailFacts">'
      + "<dt>Goes to</dt><dd>" + esc(entry.recipient) + "</dd>"
      + "<dt>Sent when</dt><dd>" + esc(entry.trigger) + "</dd>"
      + "<dt>Suppression</dt><dd>" + esc(entry.gating) + "</dd>"
      + "<dt>Button</dt><dd>" + esc(entry.cta) + "</dd>"
      + "<dt>Sent by</dt><dd><code>" + esc(entry.sender) + "</code></dd>"
      + "</dl>"
      + (entry.previewNote ? '<p class="gdStudioNeedsVerification">' + esc(entry.previewNote) + "</p>" : "")
      + '<div class="gdStudioEmailActions">'
      + '<button type="button" class="gdStudioDiagramBtn" data-gd-email-preview="' + esc(entry.id) + '">Preview this email</button>'
      + '<button type="button" class="gdStudioDiagramBtn" data-gd-email-source="' + esc(entry.id) + '">Show subject &amp; plain text</button>'
      + "</div>"
      + '<div class="gdStudioEmailPreview" id="gdStudioEmailPreview-' + index + '" hidden></div>'
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
    var deliveryState = { loading: true, error: "", delivery: null };
    var destroyed = false;

    function paint() {
      containerEl.innerHTML =
        '<div class="gdStudioEmailPage">'
        + '<p class="gdStudioLede">' + esc(record && record.function || "") + "</p>"
        + "<section><h3 class=\"gdStudioJobHistoryHeading\">Delivery</h3>"
        + '<div id="gdStudioEmailDelivery">' + deliveryHTML(deliveryState) + "</div></section>"
        + "<section><h3 class=\"gdStudioJobHistoryHeading\">Every email Clarity sends (" + entries.length + ")</h3>"
        + '<p class="gdStudioMuted">Read from scripts/gd-email-templates-core.js, which is also what the '
        + "Netlify functions render from — so a preview here is the real message, and a sender missing from "
        + "this list is a sender nobody can audit.</p>"
        + entries.map(entryHTML).join("")
        + "</section></div>";
    }

    function repaintDelivery() {
      var host = containerEl.querySelector("#gdStudioEmailDelivery");
      if (host) host.innerHTML = deliveryHTML(deliveryState);
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
        deliveryState = { loading: false, error: "", delivery: body && body.emailDelivery || null };
        repaintDelivery();
      }).catch(function (error) {
        if (destroyed) return;
        deliveryState = { loading: false, error: error && error.message ? error.message : "request failed.", delivery: null };
        repaintDelivery();
      });
    }

    /* The preview is rendered into a sandboxed srcdoc iframe, not into the page. Email HTML is
       a full document with its own <body> background and font stack; dropping it inline would
       both break out of the Studio layout and let it restyle the page around it. */
    function previewFor(entry) {
      var built = api.build(entry.eventType, Object.assign({ to: "player@example.com" }, entry.sample || {}));
      return { built: built, entry: entry };
    }

    function togglePreview(id, mode) {
      var index = -1;
      for (var i = 0; i < entries.length; i++) if (entries[i].id === id) { index = i; break; }
      if (index < 0) return;
      var host = containerEl.querySelector("#gdStudioEmailPreview-" + index);
      if (!host) return;
      if (!host.hidden && host.getAttribute("data-gd-mode") === mode) { host.hidden = true; host.innerHTML = ""; return; }
      var out = previewFor(entries[index]);
      host.setAttribute("data-gd-mode", mode);
      if (mode === "source") {
        host.innerHTML = '<div class="gdStudioEmailSource">'
          + "<p><strong>Subject</strong><br><code>" + esc(out.built.subject) + "</code></p>"
          + "<p><strong>Plain-text part</strong></p><pre>" + esc(out.built.text) + "</pre></div>";
      } else {
        var frame = document.createElement("iframe");
        frame.className = "gdStudioEmailFrame";
        frame.setAttribute("sandbox", "");
        frame.setAttribute("title", entries[index].label + " preview");
        frame.style.height = PREVIEW_HEIGHT + "px";
        frame.srcdoc = out.built.html;
        host.innerHTML = "";
        host.appendChild(frame);
      }
      host.hidden = false;
    }

    function onClick(event) {
      var preview = event.target.closest("[data-gd-email-preview]");
      if (preview) { togglePreview(preview.getAttribute("data-gd-email-preview"), "html"); return; }
      var source = event.target.closest("[data-gd-email-source]");
      if (source) togglePreview(source.getAttribute("data-gd-email-source"), "source");
    }

    paint();
    containerEl.addEventListener("click", onClick);
    loadDelivery();

    return function () {
      destroyed = true;
      containerEl.removeEventListener("click", onClick);
    };
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["communications"] = render;
})();
