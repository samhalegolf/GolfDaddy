"use strict";

/* Server-side fetcher for club scorecard pages. The browser cannot fetch these
   directly - club sites send no Access-Control-Allow-Origin - so every scorecard
   read goes through here.

   This used to allow two hosts by name, which meant every other course failed with
   "Unsupported scorecard source". It now accepts any public https host and relies
   on the shared SSRF guards instead, plus redirects re-validated at every hop and a
   hard cap on how much of the response is buffered. */

const { safeRemoteUrl, resolvesToPublicAddress } = require("./lib/safe-remote-url");

const MAX_RESPONSE_CHARS = 650000;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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

  const target = safeRemoteUrl(payload && payload.url);
  if (!target) return json(400, { error: "Unsupported scorecard source" });

  let hop;
  try {
    hop = await fetchFollowingSafeRedirects(target);
  } catch (error) {
    return json(502, {
      error: "Scorecard source fetch failed",
      message: (error && error.message) || String(error),
      url: target.href
    });
  }

  if (hop.error) return json(400, { error: hop.error, url: hop.url.href });

  const res = hop.res;
  if (!res.ok) {
    return json(res.status, { error: "Scorecard source returned " + res.status, url: hop.url.href });
  }
  if (!isTextualResponse(res)) {
    return json(415, { error: "Scorecard source did not return a document", url: hop.url.href });
  }

  try {
    const html = await readTextCapped(res, MAX_RESPONSE_CHARS);
    return json(200, { url: hop.url.href, html });
  } catch (error) {
    return json(502, {
      error: "Scorecard source read failed",
      message: (error && error.message) || String(error),
      url: hop.url.href
    });
  }
};

/* Follows redirects by hand so every hop is re-checked. Letting fetch follow them
   would let a public hostname bounce us into private space on the second request,
   after the first one passed every check. */
async function fetchFollowingSafeRedirects(startUrl) {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!(await resolvesToPublicAddress(url))) {
      return { error: "Scorecard source resolves to a non-public address", url };
    }
    const res = await fetch(url.href, {
      redirect: "manual",
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 ClarityCaddieScorecardResolver/1.0"
      }
    });
    if (!REDIRECT_STATUSES.has(res.status)) return { res, url };

    const location = res.headers.get("location");
    let next = null;
    try {
      next = location ? new URL(location, url) : null;
    } catch (error) {
      next = null;
    }
    if (!next || !safeRemoteUrl(next.href)) {
      return { error: "Scorecard source redirected to an unsupported URL", url };
    }
    url = next;
  }
  return { error: "Scorecard source redirected too many times", url: startUrl };
}

function isTextualResponse(res) {
  const type = (res.headers.get("content-type") || "").toLowerCase();
  if (!type) return true;
  return type.includes("html") || type.includes("xml") || type.startsWith("text/");
}

/* Streams and stops at the cap rather than buffering the whole body first - a
   hostile or merely enormous page should not be pulled into memory just to be
   sliced down afterwards. */
async function readTextCapped(res, maxChars) {
  const maxBytes = maxChars * 4;
  const reader = res.body && typeof res.body.getReader === "function" ? res.body.getReader() : null;
  if (!reader) return String(await res.text()).slice(0, maxChars);

  const chunks = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    total += value.length;
  }
  try {
    await reader.cancel();
  } catch (error) {
    /* Already drained. */
  }
  return Buffer.concat(chunks).toString("utf8").slice(0, maxChars);
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
