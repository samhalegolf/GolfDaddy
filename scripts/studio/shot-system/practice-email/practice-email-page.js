/* Clarity Studio — Practice Email page. Studio-only, read-only.
 *
 * Unlike the Practice Data page next to it, this one is not a jump-in: there is
 * no app screen to jump into. The app shows a player their own address and
 * their own imports; nothing anywhere shows what has arrived across all
 * players, or how far a given email got before it stopped.
 *
 * Everything here is read through /api/practice-email-admin, which holds the
 * service key and checks the caller is an admin. The intake tables are RLS'd to
 * the service role, so this page could not query Supabase directly even with an
 * admin signed in.
 *
 * Read-only on purpose. Revoking a sender or deleting an import is a real
 * action against a real player's account and is not wired here. */
(function () {
  "use strict";

  function esc(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function when(iso) {
    if (!iso) return "—";
    var date = new Date(iso);
    if (isNaN(date.getTime())) return String(iso);
    return date.toLocaleString(undefined, {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit"
    });
  }

  /* The stage an intake reached, said in words rather than in the enum. The
     enum is still shown next to it - this is the reading, not a replacement. */
  function stageNote(intake) {
    if (intake.errors.length) return "errors";
    if (intake.status === "staged") return "parsed and staged";
    if (intake.status === "pending_photo") return "photo stored, waiting for the app to scan it";
    if (intake.status === "needs_review") return "landed, needs review";
    if (intake.status === "unsupported") return "nothing importable attached";
    return intake.status || "unknown";
  }

  function tone(intake, batch) {
    if (intake.errors.length) return "bad";
    if (batch && batch.invalidCount > 0) return "warn";
    if (batch && batch.status === "staged") return "ok";
    if (intake.status === "staged") return "ok";
    return "warn";
  }

  function flagCell(intake, batch) {
    var bits = [];
    if (!intake.senderVerified) bits.push("unapproved sender");
    if (batch) {
      if (batch.warnings.length) bits.push(batch.warnings.join(", "));
      if (batch.parseErrors.length) bits.push("parse: " + batch.parseErrors.join(", "));
      if (batch.photoCount) bits.push(batch.photoCount + " photo" + (batch.photoCount === 1 ? "" : "s"));
    }
    if (intake.errors.length) bits.push(intake.errors.join(", "));
    if (intake.unsupportedCount) bits.push(intake.unsupportedCount + " unsupported attachment(s)");
    return bits.length ? esc(bits.join(" · ")) : '<span class="gdStudioMuted">—</span>';
  }

  /* One row per attachment. An email that produced no attachment still gets a
     row, because an email that landed and did nothing is the single most
     useful thing on this page. */
  function intakeRows(intakes) {
    var rows = [];
    intakes.forEach(function (intake) {
      var batches = intake.batches.length ? intake.batches : [null];
      batches.forEach(function (batch, index) {
        var first = index === 0;
        rows.push(
          "<tr>"
          + "<td>" + (first ? esc(when(intake.createdAt)) : "") + "</td>"
          + "<td>" + (first ? esc(intake.from) : "") + "</td>"
          + "<td>" + (first ? esc(intake.to) : "") + "</td>"
          + "<td>" + (batch ? esc(batch.sourceName || batch.sourceType) : '<span class="gdStudioMuted">no attachment</span>') + "</td>"
          + '<td><span class="gdAdminCourseStatusDot ' + tone(intake, batch) + '"></span>'
          + esc(batch ? batch.status : intake.status) + "</td>"
          + "<td>" + (batch ? esc(batch.rowCount) : "—") + "</td>"
          + "<td>" + (batch ? esc(batch.validCount + " / " + batch.invalidCount) : "—") + "</td>"
          + "<td>" + (batch && batch.provider ? esc(batch.provider) : "—") + "</td>"
          + "<td>" + (batch && batch.unitSystem
            ? esc(batch.unitSystem) + '<span class="gdStudioMuted"> (' + esc(batch.unitSource || "?") + ")</span>"
            : '<span class="gdStudioMuted">undeclared</span>') + "</td>"
          + "<td>" + flagCell(intake, batch) + "</td>"
          + "</tr>"
        );
      });
      if (!intake.batches.length) {
        rows.push('<tr><td colspan="10" class="gdStudioJobError">'
          + esc(stageNote(intake)) + "</td></tr>");
      }
    });
    return rows.join("");
  }

  function intakeTable(intakes) {
    if (!intakes.length) return '<p class="gdStudioMuted">No practice email has arrived yet.</p>';
    return '<div class="gdStudioJobTableWrap"><table class="gdStudioJobTable"><thead><tr>'
      + "<th>When</th><th>From</th><th>To</th><th>Attachment</th><th>Stage</th>"
      + "<th>Rows</th><th>Valid / invalid</th><th>Provider</th><th>Units</th><th>Notes</th>"
      + "</tr></thead><tbody>" + intakeRows(intakes) + "</tbody></table></div>";
  }

  function addressTable(addresses) {
    if (!addresses.length) return '<p class="gdStudioMuted">No addresses have been issued yet.</p>';
    var rows = addresses.map(function (row) {
      var senders = row.senders.length
        ? row.senders.map(function (sender) {
          return esc(sender.email) + '<span class="gdStudioMuted"> (' + esc(sender.source) + ")</span>";
        }).join("<br>")
        : '<span class="gdStudioMuted">none</span>';
      return "<tr>"
        + "<td>" + esc(row.address) + "</td>"
        + "<td>" + esc(row.playerKey) + "</td>"
        + '<td><span class="gdAdminCourseStatusDot ' + (row.active ? "ok" : "bad") + '"></span>'
        + (row.active ? "active" : "inactive") + "</td>"
        + "<td>" + esc(when(row.createdAt)) + "</td>"
        + "<td>" + senders + "</td>"
        + "</tr>";
    }).join("");
    return '<div class="gdStudioJobTableWrap"><table class="gdStudioJobTable"><thead><tr>'
      + "<th>Address</th><th>Player key</th><th>State</th><th>Issued</th><th>Approved senders</th>"
      + "</tr></thead><tbody>" + rows + "</tbody></table></div>";
  }

  function render(containerEl) {
    var lede = document.createElement("div");
    lede.className = "gdStudioLede";
    lede.innerHTML = "<p>What has arrived at the practice inbox and how far it got. "
      + "One row per attachment; an email that produced nothing still gets a row. "
      + "Read-only — approving or revoking a sender is done from the player's own screen.</p>";

    var controls = document.createElement("p");
    controls.innerHTML = '<button type="button" class="gdStudioDiagramBtn" id="gdStudioPracticeEmailRefresh">Refresh</button>'
      + ' <span class="gdStudioMuted" id="gdStudioPracticeEmailStamp"></span>';

    var intakeHeading = document.createElement("h3");
    intakeHeading.className = "gdStudioJobHistoryHeading";
    intakeHeading.textContent = "Recent intakes";
    var intakeBody = document.createElement("div");

    var addressHeading = document.createElement("h3");
    addressHeading.className = "gdStudioJobHistoryHeading";
    addressHeading.textContent = "Issued addresses";
    var addressBody = document.createElement("div");

    containerEl.appendChild(lede);
    containerEl.appendChild(controls);
    containerEl.appendChild(intakeHeading);
    containerEl.appendChild(intakeBody);
    containerEl.appendChild(addressHeading);
    containerEl.appendChild(addressBody);

    var stamp = containerEl.querySelector("#gdStudioPracticeEmailStamp");
    var button = containerEl.querySelector("#gdStudioPracticeEmailRefresh");
    var cancelled = false;

    function token() {
      var auth = window.ClaritySupabaseAuth;
      if (auth && typeof auth.freshAccessToken === "function") return auth.freshAccessToken();
      return Promise.resolve("");
    }

    function load() {
      intakeBody.innerHTML = '<p class="gdStudioMuted">Loading…</p>';
      addressBody.innerHTML = "";
      if (button) button.disabled = true;
      return token().then(function (accessToken) {
        if (!accessToken) throw new Error("No signed-in Supabase session — sign in again");
        return fetch("/api/practice-email-admin?limit=50", {
          headers: { Accept: "application/json", Authorization: "Bearer " + accessToken }
        });
      }).then(function (response) {
        if (response.status === 403) throw new Error("This view is admin-only");
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      }).then(function (data) {
        if (cancelled) return;
        intakeBody.innerHTML = intakeTable(data.intakes || []);
        addressBody.innerHTML = addressTable(data.addresses || []);
        if (stamp) stamp.textContent = "read " + when(data.checkedAt);
      }).catch(function (error) {
        if (cancelled) return;
        intakeBody.innerHTML = '<p class="gdStudioNeedsVerification">Could not load practice email intake: '
          + esc(error && error.message || error) + "</p>";
        addressBody.innerHTML = "";
      }).then(function () {
        if (button && !cancelled) button.disabled = false;
      });
    }

    if (button) button.addEventListener("click", load);
    load();

    return function cleanup() { cancelled = true; };
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["practice-email"] = render;
})();
