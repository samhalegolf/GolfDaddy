/* Web app gate.
 *
 * Clarity Caddy is tried through the App Store and Google Play only. The HTML
 * app (/, /studio, /app, /demo and any other page) is Sam's alone: a browser
 * without the access cookie is sent to welcome.html, whose only way in is the
 * store badges.
 *
 * The native apps never pass through here - Capacitor serves the bundle from
 * the device, and the AASA/assetlinks files claim every path on this host, so
 * an auth-email link on a phone with the app installed opens the app before
 * any request is made. A link opened anywhere else lands on the welcome page.
 *
 * Unlocking: open /studio (it shows the sign-in in place) or /web-access, enter CLARITY_WEB_ACCESS_KEY (falls back to
 * CLARITY_ADMIN_AUTH_TOKEN). That sets an HttpOnly cookie holding an HMAC of
 * the key, never the key itself, so rotating the key locks every browser out.
 * /web-access?lock=1 clears it. With no key configured the gate fails closed.
 *
 * Left public on purpose: the landing and legal pages the store listings link
 * to (Play fetches the privacy policy during review), /assets, /api, /scripts,
 * /styles and /.well-known. Only pages are gated, not the JS/CSS they load -
 * that code ships inside the IPA/APK anyway. */

const COOKIE = "cc_web_access";
const ACCESS_PATH = "/web-access";
const ONE_YEAR = 60 * 60 * 24 * 365;

const PUBLIC_PAGES = new Set([
  "/welcome", "/welcome.html",
  "/privacy", "/privacy.html",
  "/terms", "/terms.html",
  "/support", "/support.html",
  "/delete-account", "/delete-account.html"
]);

/* A file request (has an extension) that is not HTML passes; pages do not. */
const FILE_EXT = /\.[a-z0-9]+$/i;
const GATED_TREES = /^\/(studio|app|demo)(\/|$)/;

function accessKey() {
  return Netlify.env.get("CLARITY_WEB_ACCESS_KEY") || Netlify.env.get("CLARITY_ADMIN_AUTH_TOKEN") || "";
}

async function accessToken(key) {
  const enc = new TextEncoder();
  const hmacKey = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", hmacKey, enc.encode("clarity-web-access:v1"));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

function sameString(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return "";
}

/* Only same-site paths, so the form can never bounce anyone off-site. */
function safeNext(value) {
  const next = String(value || "");
  return next.startsWith("/") && !next.startsWith("//") && !next.startsWith(ACCESS_PATH) ? next : "/?login=1";
}

function isGated(pathname) {
  if (PUBLIC_PAGES.has(pathname)) return false;
  if (GATED_TREES.test(pathname)) return true;
  if (pathname.endsWith("/")) return true;
  if (/\.html?$/i.test(pathname)) return true;
  return !FILE_EXT.test(pathname);
}

function noStore(headers) {
  headers.set("Cache-Control", "no-store");
  return headers;
}

function accessPage(next, failed) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Clarity Studio</title><link rel="icon" href="/assets/brand/clarity-app-icon.png?v=7516d3a5">
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:radial-gradient(circle at 50% 0%,#12301d 0%,#07110b 60%);color:#fff;font:16px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
.card{width:min(360px,100%);padding:32px 28px;border-radius:22px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);box-shadow:0 24px 60px rgba(0,0,0,.45)}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:22px}.brand img{width:44px;height:44px;border-radius:11px}
h1{margin:0;font-size:22px;font-weight:800;letter-spacing:-.01em}.sub{margin:2px 0 0;color:rgba(255,255,255,.6);font-size:14px}
form{display:grid;gap:12px}label{font-size:13px;font-weight:700;color:rgba(255,255,255,.7)}
input,button{font:inherit;width:100%;padding:13px 14px;border-radius:12px}
input{border:1px solid rgba(255,255,255,.22);background:rgba(0,0,0,.25);color:#fff;outline:none}input:focus{border-color:#20d96b}
button{border:0;background:#20d96b;color:#04140a;font-weight:800;cursor:pointer;margin-top:4px}button:hover{filter:brightness(1.07)}
.err{margin:0;color:#ff8f8f;font-size:14px}
</style></head>
<body><main class="card"><div class="brand"><img src="/assets/brand/clarity-app-icon.png?v=7516d3a5" alt=""><div><h1>Clarity Studio</h1><p class="sub">Private - sign in to continue</p></div></div>
<form method="post" action="${ACCESS_PATH}"><input type="hidden" name="next" value="${next.replace(/[&<>"]/g, "")}">
<label for="key">Access key</label><input id="key" type="password" name="key" autocomplete="current-password" autofocus required>
${failed ? '<p class="err">That key is not right.</p>' : ""}<button type="submit">Sign in</button></form></main></body></html>`;
  return new Response(html, { status: failed ? 401 : 200, headers: noStore(new Headers({ "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex" })) });
}

function redirect(location, cookie) {
  const headers = noStore(new Headers({ Location: location }));
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

export default async (request, context) => {
  const url = new URL(request.url);
  const { pathname } = url;

  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return context.next();

  const key = accessKey();
  const expected = key ? await accessToken(key) : "";

  if (pathname === ACCESS_PATH) {
    if (url.searchParams.has("lock")) {
      return redirect("/welcome.html", `${COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`);
    }
    if (request.method === "POST") {
      const form = await request.formData().catch(() => null);
      const supplied = form ? String(form.get("key") || "") : "";
      const next = safeNext(form && form.get("next"));
      if (!key || !sameString(supplied, key)) return accessPage(next, true);
      return redirect(next, `${COOKIE}=${expected}; Path=/; Max-Age=${ONE_YEAR}; Secure; HttpOnly; SameSite=Lax`);
    }
    return accessPage(safeNext(url.searchParams.get("next")), false);
  }

  if (!isGated(pathname)) return context.next();
  if (expected && sameString(readCookie(request, COOKIE), expected)) return context.next();

  /* /studio is Sam's door: it asks for the key in place and comes back to the
     page he asked for. Everything else goes to the landing. */
  if (/^\/studio(\/|$)/.test(pathname)) return accessPage(safeNext(pathname + url.search), false);
  return redirect("/welcome.html");
};

export const config = {
  path: "/*",
  excludedPath: ["/api/*", "/.netlify/*", "/.well-known/*", "/assets/*", "/scripts/*", "/styles/*"]
};
