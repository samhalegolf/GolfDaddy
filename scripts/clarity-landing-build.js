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

function escapeAttr(value) {
  var text = String(value || "#").trim();
  if (!text || /^(javascript|data):/i.test(text)) return "#";
  return escapeHtml(text);
}

function renderButton(cta, variant) {
  if (!cta || !cta.label || !cta.href) return "";
  return `<a class="landingButton ${variant || ""}" href="${escapeAttr(cta.href)}">${escapeHtml(cta.label)}</a>`;
}

function loadLandingContent(root) {
  const source = fs.readFileSync(path.join(root, "src", "content", "landingContent.ts"), "utf8");
  const body = source
    .replace(/export\s+const\s+landingContent\s*=\s*/, "return ")
    .replace(/\s*;\s*$/, ";");
  return Function(body)();
}

function renderCards(items, productCards) {
  return (items || []).map(function (item) {
    const link = productCards && item.cta
      ? `<a class="landingCardLink" href="${escapeAttr(item.cta.href)}">${escapeHtml(item.cta.label)}</a>`
      : "";
    return `<article class="landingCard${productCards ? " productCard" : ""}"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.body)}</p>${link}</article>`;
  }).join("");
}

function renderLandingPage(content) {
  const hero = content.hero || {};
  const features = content.features || { items: [] };
  const products = content.products || { items: [] };
  const cta = content.cta || {};

  return `<!DOCTYPE html>
<html lang="en-NZ">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(hero.eyebrow || "Clarity Golf")}</title>
  <meta name="description" content="${escapeAttr(hero.body || "Clarity Golf")}" />
  <link href="assets/brand/clarity-app-icon.png?v=clarity-20260531" rel="icon" type="image/png" />
  <style>
    *,*::before,*::after{box-sizing:border-box}html{background:#050806;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{margin:0;min-height:100vh;background:radial-gradient(circle at 76% 0%,rgba(31,211,109,.18),transparent 34%),radial-gradient(circle at 18% 22%,rgba(255,122,26,.16),transparent 30%),linear-gradient(180deg,#07100b 0%,#030604 100%);color:#fff}.landingPage{width:min(1160px,100%);margin:0 auto;padding:22px 18px 40px}.landingNav{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:0 0 54px}.landingBrand{display:flex;align-items:center;gap:10px;font-weight:950;letter-spacing:-.04em;text-transform:uppercase;color:#fff;text-decoration:none}.landingBrandMark{width:34px;height:34px;border-radius:13px;background:linear-gradient(135deg,#ff7a1a,#1fd36d);box-shadow:0 10px 26px rgba(0,0,0,.35)}.landingNavLinks{display:flex;align-items:center;gap:10px}.landingNavLinks a{color:rgba(255,255,255,.72);font-size:13px;font-weight:850;text-decoration:none}.landingHero{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(280px,.9fr);gap:34px;align-items:center;min-height:58vh}.landingEyebrow{margin:0 0 12px;color:#b7ff3b;font-size:12px;font-weight:950;letter-spacing:.16em;text-transform:uppercase}.landingHero h1,.landingSection h2,.landingCta h2{margin:0;color:#fff;letter-spacing:-.07em;line-height:.92}.landingHero h1{max-width:820px;font-size:clamp(52px,10vw,118px)}.landingHeroBody{max-width:640px;margin:22px 0 0;color:rgba(255,255,255,.72);font-size:clamp(18px,2.4vw,24px);line-height:1.34}.landingActions{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px}.landingButton{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 18px;border-radius:999px;border:1px solid rgba(255,255,255,.14);color:#fff;font-weight:950;text-decoration:none;box-shadow:0 14px 34px rgba(0,0,0,.28)}.landingButton.primary{background:#ff7a1a;border-color:#ff7a1a;color:#140700}.landingButton.secondary{background:rgba(255,255,255,.07);backdrop-filter:blur(12px)}.landingHeroVisual{min-height:360px;border-radius:36px;border:1px solid rgba(255,255,255,.12);background:linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,.025));box-shadow:0 24px 70px rgba(0,0,0,.36),inset 0 1px 0 rgba(255,255,255,.12);position:relative;overflow:hidden}.landingGreen{position:absolute;left:50%;top:52%;width:230px;height:340px;border-radius:54% 46% 58% 42%/46% 58% 42% 54%;transform:translate(-50%,-50%) rotate(22deg);background:linear-gradient(135deg,#1fd36d,#0b6b38);box-shadow:0 24px 80px rgba(31,211,109,.2)}.landingBubble{position:absolute;left:50%;top:52%;width:190px;height:108px;border-radius:50%;transform:translate(-50%,-50%) rotate(-18deg);border:2px solid rgba(255,255,255,.9);background:radial-gradient(ellipse at center,rgba(255,255,255,.22),rgba(255,255,255,.06));box-shadow:0 0 34px rgba(255,255,255,.18)}.landingPin{position:absolute;left:52%;top:27%;width:4px;height:128px;background:#fff;border-radius:999px}.landingPin:after{content:"";position:absolute;left:4px;top:0;border-top:18px solid #f0182f;border-bottom:18px solid transparent;border-left:42px solid #f0182f}.landingShotLine{position:absolute;left:14%;bottom:18%;width:58%;border-top:3px dotted rgba(255,255,255,.86);transform:rotate(-13deg);transform-origin:left center}.landingSection{padding:86px 0 0}.landingSectionHeader{max-width:760px}.landingSection h2,.landingCta h2{font-size:clamp(38px,6vw,72px)}.landingSectionHeader p:not(.landingEyebrow),.landingCta p{color:rgba(255,255,255,.68);font-size:18px;line-height:1.48}.landingGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:28px}.landingCard{min-height:210px;padding:24px;border-radius:28px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.055);box-shadow:0 16px 40px rgba(0,0,0,.22)}.landingCard h3{margin:0 0 10px;font-size:24px;letter-spacing:-.04em}.landingCard p{margin:0;color:rgba(255,255,255,.66);line-height:1.45}.productCard{display:flex;flex-direction:column}.landingCardLink{margin-top:auto;padding-top:18px;color:#b7ff3b;font-weight:950;text-decoration:none}.landingCta{margin-top:86px;padding:34px;border-radius:34px;background:linear-gradient(135deg,rgba(255,122,26,.22),rgba(31,211,109,.14));border:1px solid rgba(255,255,255,.12);box-shadow:0 20px 70px rgba(0,0,0,.3)}.landingFooter{padding:26px 0 0;color:rgba(255,255,255,.42);font-size:12px}@media (max-width:840px){.landingHero{grid-template-columns:1fr;min-height:auto}.landingHeroVisual{min-height:300px}.landingGrid{grid-template-columns:1fr}.landingNav{margin-bottom:34px}.landingPage{padding:18px 14px 30px}.landingSection{padding-top:64px}.landingCta{margin-top:64px}}
  </style>
</head>
<body>
  <main class="landingPage">
    <nav class="landingNav" aria-label="Primary"><a class="landingBrand" href="/"><span class="landingBrandMark" aria-hidden="true"></span><span>Clarity Golf</span></a><div class="landingNavLinks"><a href="/app">App</a><a href="/login">Log in</a><a href="/signup">Sign up</a></div></nav>
    <section class="landingHero"><div><p class="landingEyebrow">${escapeHtml(hero.eyebrow)}</p><h1>${escapeHtml(hero.heading)}</h1><p class="landingHeroBody">${escapeHtml(hero.body)}</p><div class="landingActions">${renderButton(hero.primaryCta,"primary")}${renderButton(hero.secondaryCta,"secondary")}</div></div><div class="landingHeroVisual" aria-hidden="true"><div class="landingGreen"></div><div class="landingBubble"></div><div class="landingPin"></div><div class="landingShotLine"></div></div></section>
    <section class="landingSection"><div class="landingSectionHeader"><p class="landingEyebrow">${escapeHtml(features.eyebrow)}</p><h2>${escapeHtml(features.heading)}</h2><p>${escapeHtml(features.body)}</p></div><div class="landingGrid">${renderCards(features.items,false)}</div></section>
    <section class="landingSection"><div class="landingSectionHeader"><p class="landingEyebrow">${escapeHtml(products.eyebrow)}</p><h2>${escapeHtml(products.heading)}</h2><p>${escapeHtml(products.body)}</p></div><div class="landingGrid">${renderCards(products.items,true)}</div></section>
    <section class="landingCta"><h2>${escapeHtml(cta.heading)}</h2><p>${escapeHtml(cta.body)}</p><div class="landingActions">${renderButton(cta.primaryCta,"primary")}${renderButton(cta.secondaryCta,"secondary")}</div></section>
    <footer class="landingFooter">Clarity Golf Systems · Clarity Caddie</footer>
  </main>
</body>
</html>`;
}

module.exports = {
  loadLandingContent,
  renderLandingPage
};
