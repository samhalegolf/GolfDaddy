exports.handler = async function(event){
  if(event.httpMethod !== "POST"){
    return json(405, {error: "Method not allowed"});
  }

  var payload;
  try{
    payload = JSON.parse(event.body || "{}");
  }catch(error){
    return json(400, {error: "Invalid JSON"});
  }

  var happened = text(payload.happened, 1200);
  if(!happened){
    return json(400, {error: "Missing support note"});
  }

  var ticket = {
    happened: happened,
    expected: text(payload.expected, 1200),
    contact: text(payload.contact, 240),
    context: sanitizeContext(payload.context || {}),
    status: "new",
    source: "clarity-caddie-beta-report",
    created_at: new Date().toISOString()
  };

  var storage = await storeTicket(ticket);
  var emailResult = await sendDebugEmail(ticket, storage.ticketId);

  if(!storage.stored && !emailResult.sent){
    return json(emailResult.provider === "not_configured" && storage.provider === "not_configured" ? 503 : 502, {
      error: "Debug report could not be sent",
      storage: storage.publicStatus,
      email: emailResult.publicStatus,
      setup: "Set RESEND_API_KEY plus CLARITY_EMAIL_FROM and CLARITY_DEBUG_REPORT_TO, or configure Supabase support storage."
    });
  }

  return json(200, {
    ticketId: storage.ticketId || null,
    stored: !!storage.stored,
    emailed: !!emailResult.sent,
    emailQueued: emailResult.provider === "not_configured" && !!storage.stored,
    provider: emailResult.sent ? "resend" : (storage.stored ? "support-storage" : "none")
  });
};

async function storeTicket(ticket){
  var supabaseUrl = env("SUPABASE_URL");
  var supabaseKey = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_ANON_KEY");

  if(!supabaseUrl || !supabaseKey){
    return {stored:false, ticketId:null, provider:"not_configured", publicStatus:"storage_not_configured"};
  }

  try{
    var response = await fetch(supabaseUrl.replace(/\/$/, "") + "/rest/v1/support_tickets", {
      method: "POST",
      headers: {
        "apikey": supabaseKey,
        "Authorization": "Bearer " + supabaseKey,
        "Content-Type": "application/json",
        "Prefer": "return=representation"
      },
      body: JSON.stringify(ticket)
    });

    var body = await response.json().catch(function(){return null;});
    if(!response.ok){
      return {stored:false, ticketId:null, provider:"supabase", publicStatus:"storage_rejected", details: body};
    }

    var created = Array.isArray(body) ? body[0] : body;
    return {stored:true, ticketId: created && created.id || null, provider:"supabase", publicStatus:"stored"};
  }catch(error){
    return {stored:false, ticketId:null, provider:"supabase", publicStatus:"storage_error", details: text(error && error.message || error, 400)};
  }
}

async function sendDebugEmail(ticket, ticketId){
  var resendKey = env("RESEND_API_KEY");
  if(!resendKey){
    return {sent:false, provider:"not_configured", publicStatus:"email_not_configured"};
  }

  var to = email(env("CLARITY_DEBUG_REPORT_TO") || env("CLARITY_SUPPORT_EMAIL") || env("CLARITY_OWNER_EMAIL") || env("SUPPORT_EMAIL") || "samhalegolf@gmail.com");
  if(!to){
    return {sent:false, provider:"not_configured", publicStatus:"email_recipient_missing"};
  }

  var from = env("CLARITY_EMAIL_FROM") || "Clarity Golf Systems <notifications@claritygolf.systems>";
  var rendered = renderDebugEmail(ticket, ticketId);

  try{
    var response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + resendKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: from,
        to: [to],
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text
      })
    });

    var body = await response.json().catch(function(){return null;});
    if(!response.ok){
      return {sent:false, provider:"resend", publicStatus:"email_rejected", details: body};
    }

    return {sent:true, provider:"resend", publicStatus:"sent", id: body && body.id || null};
  }catch(error){
    return {sent:false, provider:"resend", publicStatus:"email_error", details: text(error && error.message || error, 400)};
  }
}

function env(name){
  return process.env[name] || "";
}

function text(value, limit){
  var input = String(value || "").trim();
  return input.length > limit ? input.slice(0, limit) : input;
}

function email(value){
  var input = text(value, 240).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) ? input : "";
}

function sanitizeArray(value, limit, mapFn){
  if(!Array.isArray(value)) return [];
  return value.slice(0, limit).map(mapFn).filter(Boolean);
}

function sanitizeContext(context){
  return {
    build: sanitizeBuild(context.build || {}),
    route: text(context.route, 200),
    url: text(context.url, 500),
    pageTitle: text(context.pageTitle, 240),
    timestamp: text(context.timestamp, 80),
    userAgent: text(context.userAgent, 500),
    viewport: context.viewport && typeof context.viewport === "object" ? {
      width: Number(context.viewport.width) || null,
      height: Number(context.viewport.height) || null,
      devicePixelRatio: Number(context.viewport.devicePixelRatio) || null
    } : {},
    activeCourseLabel: text(context.activeCourseLabel, 240),
    lastAction: sanitizeLastAction(context.lastAction),
    localStorageSummary: sanitizeArray(context.localStorageSummary, 80, sanitizeStorageRow),
    sessionStorageSummary: sanitizeArray(context.sessionStorageSummary, 80, sanitizeStorageRow),
    recentErrors: sanitizeArray(context.recentErrors, 12, sanitizeErrorRow)
  };
}

function sanitizeBuild(build){
  return {
    appName: text(build.appName, 80),
    packageName: text(build.packageName, 80),
    version: text(build.version, 80),
    buildId: text(build.buildId, 120),
    deployedAt: text(build.deployedAt, 80),
    channel: text(build.channel, 40),
    betaLabel: text(build.betaLabel, 40),
    cacheBust: text(build.cacheBust, 120)
  };
}

function sanitizeLastAction(action){
  if(!action || typeof action !== "object") return null;
  return {
    time: text(action.time, 80),
    type: text(action.type, 40),
    target: text(action.target, 180)
  };
}

function sanitizeStorageRow(row){
  if(!row || typeof row !== "object") return null;
  return {
    key: text(row.key, 180),
    bytes: Math.max(0, Math.min(Number(row.bytes) || 0, 10000000)),
    type: text(row.type, 40)
  };
}

function sanitizeErrorRow(row){
  if(!row || typeof row !== "object") return null;
  return {
    time: text(row.time, 80),
    source: text(row.source, 120),
    message: text(row.message, 600),
    extra: text(row.extra, 600)
  };
}

function renderDebugEmail(ticket, ticketId){
  var context = ticket.context || {};
  var build = context.build || {};
  var subject = "Clarity Caddie beta report" + (context.route ? " · " + context.route : "") + (ticketId ? " · " + ticketId : "");
  var details = [
    ["Ticket", ticketId || "email-only"],
    ["Created", ticket.created_at],
    ["Contact", ticket.contact || "not provided"],
    ["Route", context.route || "unknown"],
    ["Course", context.activeCourseLabel || "not set"],
    ["Build", build.buildId || "unknown"],
    ["Version", build.version || "unknown"],
    ["Channel", build.channel || "beta"],
    ["URL", context.url || ""],
    ["Viewport", context.viewport ? [context.viewport.width, context.viewport.height, context.viewport.devicePixelRatio].filter(function(v){return v !== null && v !== undefined;}).join(" × ") : ""],
    ["Last action", context.lastAction ? [context.lastAction.type, context.lastAction.target, context.lastAction.time].filter(Boolean).join(" · ") : "none"]
  ];
  var storage = sectionRows("Local storage summary", context.localStorageSummary, storageLine);
  var session = sectionRows("Session storage summary", context.sessionStorageSummary, storageLine);
  var errors = sectionRows("Recent errors", context.recentErrors, errorLine);
  var textBody = [
    "Clarity Caddie beta report",
    "",
    "What happened:",
    ticket.happened,
    "",
    "Expected:",
    ticket.expected || "not provided",
    "",
    details.map(function(pair){return pair[0] + ": " + pair[1];}).join("\n"),
    "",
    storage.text,
    "",
    session.text,
    "",
    errors.text,
    "",
    "User agent:",
    context.userAgent || ""
  ].join("\n");
  var html = [
    "<!doctype html><html><body style=\"margin:0;background:#07100b;color:#f7faf7;font-family:Arial,Helvetica,sans-serif\">",
    "<div style=\"max-width:680px;margin:0 auto;padding:28px 16px\">",
    "<p style=\"margin:0 0 8px;color:#42b66a;font-weight:800;letter-spacing:.08em;text-transform:uppercase\">Clarity Caddie beta</p>",
    "<h1 style=\"margin:0 0 18px;font-size:28px;line-height:1.08\">Debug report</h1>",
    "<h2 style=\"margin:22px 0 8px;font-size:16px\">What happened</h2>",
    "<p style=\"white-space:pre-wrap;color:#dbe5df\">" + escapeHTML(ticket.happened) + "</p>",
    "<h2 style=\"margin:22px 0 8px;font-size:16px\">Expected</h2>",
    "<p style=\"white-space:pre-wrap;color:#dbe5df\">" + escapeHTML(ticket.expected || "not provided") + "</p>",
    "<h2 style=\"margin:22px 0 8px;font-size:16px\">Context</h2>",
    table(details),
    storage.html,
    session.html,
    errors.html,
    "<h2 style=\"margin:22px 0 8px;font-size:16px\">User agent</h2>",
    "<p style=\"word-break:break-word;color:#96a59d;font-size:12px\">" + escapeHTML(context.userAgent || "") + "</p>",
    "</div></body></html>"
  ].join("");
  return {subject: subject, text: textBody, html: html};
}

function table(rows){
  return "<table role=\"presentation\" cellspacing=\"0\" cellpadding=\"0\" style=\"width:100%;border-collapse:collapse;background:#101b15;border:1px solid #24342c;border-radius:14px;overflow:hidden\">" + rows.map(function(pair){
    return "<tr><th style=\"text-align:left;color:#8fa199;font-size:12px;padding:9px 10px;border-bottom:1px solid #24342c;width:34%\">" + escapeHTML(pair[0]) + "</th><td style=\"color:#f7faf7;font-size:12px;padding:9px 10px;border-bottom:1px solid #24342c;word-break:break-word\">" + escapeHTML(pair[1] || "") + "</td></tr>";
  }).join("") + "</table>";
}

function sectionRows(title, rows, formatter){
  rows = Array.isArray(rows) ? rows : [];
  var textValue = title + ":\n" + (rows.length ? rows.map(formatter).join("\n") : "none");
  var htmlValue = "<h2 style=\"margin:22px 0 8px;font-size:16px\">" + escapeHTML(title) + "</h2>" + (rows.length ? "<ul style=\"margin:0;padding-left:18px;color:#dbe5df;font-size:12px\">" + rows.map(function(row){return "<li>" + escapeHTML(formatter(row)) + "</li>";}).join("") + "</ul>" : "<p style=\"color:#96a59d;font-size:12px\">none</p>");
  return {text:textValue, html:htmlValue};
}

function storageLine(row){
  return (row.key || "unknown") + " · " + (row.type || "value") + " · " + (row.bytes || 0) + " bytes";
}

function errorLine(row){
  return [row.time, row.source, row.message, row.extra].filter(Boolean).join(" · ");
}

function escapeHTML(value){
  return String(value == null ? "" : value).replace(/[&<>\"']/g, function(ch){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#39;"}[ch];
  });
}

function json(statusCode, body){
  return {
    statusCode: statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}
