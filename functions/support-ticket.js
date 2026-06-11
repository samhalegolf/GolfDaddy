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
    source: "clarity-caddie-web",
    created_at: new Date().toISOString()
  };

  var supabaseUrl = process.env.SUPABASE_URL;
  var supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if(!supabaseUrl || !supabaseKey){
    return json(503, {
      error: "Support storage is not configured",
      setup: "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Netlify environment variables."
    });
  }

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
    return json(response.status, {error: "Could not create support ticket", details: body});
  }

  var created = Array.isArray(body) ? body[0] : body;
  return json(200, {ticketId: created && created.id || null});
};

function text(value, limit){
  var input = String(value || "").trim();
  return input.length > limit ? input.slice(0, limit) : input;
}

function sanitizeContext(context){
  return {
    build: context.build || {},
    route: text(context.route, 200),
    url: text(context.url, 500),
    userAgent: text(context.userAgent, 500),
    viewport: context.viewport || {},
    activeCourseLabel: text(context.activeCourseLabel, 240),
    lastAction: context.lastAction || null,
    localStorageSummary: Array.isArray(context.localStorageSummary) ? context.localStorageSummary : [],
    sessionStorageSummary: Array.isArray(context.sessionStorageSummary) ? context.sessionStorageSummary : [],
    recentErrors: Array.isArray(context.recentErrors) ? context.recentErrors.slice(-12) : []
  };
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

