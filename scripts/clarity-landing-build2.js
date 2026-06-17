const fs = require("fs");
const path = require("path");

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function loadLandingContent(root) {
  const source = fs.readFileSync(path.join(root, "src/content/landingContent.ts"), "utf8");
  const body = source.replace(/export\s+const\s+landingContent\s*=\s*/, "return ").replace(/\s*;\s*$/, ";");
  return Function(body)();
}

function button(cta, klass) {
  if (!cta) return "";
  return `<a class="btn ${klass}" href="${escapeHtml(cta.href)}">${escapeHtml(cta.label)}</a>`;
}

function cards(items) {
  return (items || []).map((item) => `<article class="card"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.body)}</p>${item.cta ? `<a href="${escapeHtml(item.cta.href)}">${escapeHtml(item.cta.label)}</a>` : ""}</article>`).join("");
}

function renderLandingPage(content) {
  const hero = content.hero || {};
  const features = content.features || {};
  const products = content.products || {};
  const cta = content.cta || {};
  return `<!doctype html><html lang="en-NZ"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Clarity Golf</title><meta name="description" content="${escapeHtml(hero.body)}"><link href="assets/brand/clarity-app-icon.png?v=clarity-20260531" rel="icon"><style>*{box-sizing:border-box}body{margin:0;background:#050806;color:white;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}.page{width:min(1120px,100%);margin:auto;padding:22px 18px 40px;background:radial-gradient(circle at 80% 0,rgba(31,211,109,.18),transparent 32%),radial-gradient(circle at 16% 20%,rgba(255,122,26,.16),transparent 30%)}nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:56px}nav a{color:white;text-decoration:none;font-weight:850}.navlinks{display:flex;gap:14px}.hero{display:grid;grid-template-columns:1.1fr .9fr;gap:34px;align-items:center;min-height:58vh}.eyebrow{color:#b7ff3b;text-transform:uppercase;font-size:12px;font-weight:950;letter-spacing:.16em}h1,h2{letter-spacing:-.07em;line-height:.94;margin:0}h1{font-size:clamp(52px,10vw,112px)}h2{font-size:clamp(38px,6vw,72px)}p{color:rgba(255,255,255,.7);line-height:1.46}.hero p.body{font-size:clamp(18px,2.4vw,24px)}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:28px}.btn{display:inline-flex;min-height:48px;align-items:center;padding:0 18px;border-radius:999px;border:1px solid rgba(255,255,255,.14);text-decoration:none;color:white;font-weight:950}.primary{background:#ff7a1a;border-color:#ff7a1a;color:#140700}.secondary{background:rgba(255,255,255,.07)}.visual{min-height:350px;border-radius:34px;border:1px solid rgba(255,255,255,.12);background:linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,.025));position:relative;overflow:hidden}.green{position:absolute;left:50%;top:52%;width:220px;height:330px;border-radius:54% 46% 58% 42%;transform:translate(-50%,-50%) rotate(22deg);background:linear-gradient(135deg,#1fd36d,#0b6b38)}.bubble{position:absolute;left:50%;top:52%;width:190px;height:108px;border-radius:50%;transform:translate(-50%,-50%) rotate(-18deg);border:2px solid rgba(255,255,255,.9);background:rgba(255,255,255,.1)}.pin{position:absolute;left:52%;top:27%;width:4px;height:120px;background:white}.pin:after{content:"";position:absolute;left:4px;top:0;border-top:18px solid #f0182f;border-bottom:18px solid transparent;border-left:42px solid #f0182f}.line{position:absolute;left:14%;bottom:18%;width:58%;border-top:3px dotted rgba(255,255,255,.86);transform:rotate(-13deg)}section{padding-top:86px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:28px}.card{padding:24px;border-radius:28px;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.1);min-height:205px}.card h3{font-size:24px;margin:0 0 10px}.card a{color:#b7ff3b;font-weight:950}.cta{margin-top:86px;padding:34px;border-radius:34px;background:linear-gradient(135deg,rgba(255,122,26,.22),rgba(31,211,109,.14));border:1px solid rgba(255,255,255,.12)}footer{padding-top:26px;color:rgba(255,255,255,.42)}@media(max-width:840px){.hero,.grid{grid-template-columns:1fr}.hero{min-height:auto}.visual{min-height:300px}section{padding-top:64px}}</style></head><body><main class="page"><nav><a href="/">Clarity Golf</a><div class="navlinks"><a href="/app">App</a><a href="/login">Log in</a><a href="/signup">Sign up</a></div></nav><div class="hero"><div><p class="eyebrow">${escapeHtml(hero.eyebrow)}</p><h1>${escapeHtml(hero.heading)}</h1><p class="body">${escapeHtml(hero.body)}</p><div class="actions">${button(hero.primaryCta,"primary")}${button(hero.secondaryCta,"secondary")}</div></div><div class="visual"><div class="green"></div><div class="bubble"></div><div class="pin"></div><div class="line"></div></div></div><section><p class="eyebrow">${escapeHtml(features.eyebrow)}</p><h2>${escapeHtml(features.heading)}</h2><p>${escapeHtml(features.body)}</p><div class="grid">${cards(features.items)}</div></section><section><p class="eyebrow">${escapeHtml(products.eyebrow)}</p><h2>${escapeHtml(products.heading)}</h2><p>${escapeHtml(products.body)}</p><div class="grid">${cards(products.items)}</div></section><section class="cta"><h2>${escapeHtml(cta.heading)}</h2><p>${escapeHtml(cta.body)}</p><div class="actions">${button(cta.primaryCta,"primary")}${button(cta.secondaryCta,"secondary")}</div></section><footer>Clarity Golf Systems · Clarity Caddie</footer></main></body></html>`;
}

module.exports = { loadLandingContent, renderLandingPage };
