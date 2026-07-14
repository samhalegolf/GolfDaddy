"use strict";

const MAX_RESPONSE_CHARS = 650000;

exports.handler = async function scorecardFetch(event) {
  if (event.httpMethod === "OPTIONS") {
    return json(204, null);
  }
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (error) {
    return json(400, { error: "Invalid JSON" });
  }

  const target = safeScorecardUrl(payload && payload.url);
  if (!target) return json(400, { error: "Unsupported scorecard source" });

  try {
    const res = await fetch(target.href, {
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 ClarityCaddieScorecardResolver/1.0"
      }
    });
    const html = await res.text();
    if (!res.ok) {
      return json(res.status, { error: "Scorecard source returned " + res.status, url: target.href });
    }
    return json(200, { url: target.href, html: html.slice(0, MAX_RESPONSE_CHARS) });
  } catch (error) {
    return json(502, { error: "Scorecard source fetch failed", message: error && error.message || String(error), url: target.href });
  }
};

function safeScorecardUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:") return null;
    if (url.href.length > 500) return null;
    const host = url.hostname.toLowerCase();
    if (host === "golfify.io" || host === "www.golfify.io") return url;
    if (/golf\.co\.nz$/.test(host)) return url;
    return null;
  } catch (error) {
    return null;
  }
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: body == null ? "" : JSON.stringify(body)
  };
}
