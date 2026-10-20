/* The public course page's images, made from the snapshot runner's frames.
 *
 * The runner shoots three 1170x2532 PNGs per course (2-3.5 MB each). A web page cannot carry
 * those, and a link shared to social wants a landscape card, so from each course's frames this
 * makes:
 *
 *   web/01-pre-lock.jpg, web/02-head-to-tee.jpg, web/03-approach.jpg      585 px wide
 *   og.png                                                                 1200x630
 *
 * and uploads them to the public `course-pages` bucket under <courseId>/. The page function
 * (functions/course-page.mjs) lists that folder and uses what is there.
 *
 * Resizing and the card are done in the runner's own Chromium (a page with the frames in it,
 * screenshotted at the target size) rather than with sharp, which the runner does not need
 * for anything else and which only loads on the platform it was installed for. */

import fs from "node:fs/promises";
import path from "node:path";

export const BUCKET = "course-pages";
export const FRAMES = ["01-pre-lock", "02-head-to-tee", "03-approach"];
export const WEB_WIDTH = 585;
export const OG = { width: 1200, height: 630 };

export function storageConfig(env = process.env) {
  const base = String(env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!base || !key) return null;
  return { base, key };
}

/* The card: course name and the pitch on the left, two phone frames on the right, on black -
   the same look as the page itself. Inline data URLs so the page needs no server. */
export function ogCardHtml({ name, place, frames }) {
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const phones = frames.slice(0, 2).map((src, i) => '<img src="' + src + '" style="height:' + (i ? 520 : 560) + 'px;width:auto;border-radius:26px;box-shadow:0 30px 60px rgba(0,0,0,.6);display:block;' + (i ? "margin-top:70px;margin-left:-60px" : "") + '">').join("");
  return '<!doctype html><html><head><meta charset="utf-8"><style>'
    + "html,body{margin:0;background:#000}"
    + "body{width:" + OG.width + "px;height:" + OG.height + "px;overflow:hidden;position:relative;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif}"
    + ".text{position:absolute;left:64px;top:0;bottom:0;width:560px;display:flex;flex-direction:column;justify-content:center}"
    + ".eyebrow{color:#20d96b;text-transform:uppercase;letter-spacing:.16em;font-weight:900;font-size:18px;margin:0 0 18px}"
    + "h1{margin:0;font-size:58px;line-height:1.02;letter-spacing:-.03em;font-weight:800}"
    + "p{margin:22px 0 0;color:rgba(255,255,255,.72);font-size:24px;line-height:1.4}"
    + ".brand{margin-top:34px;font-size:18px;font-weight:950;letter-spacing:.1em;text-transform:uppercase;color:#fff}"
    + ".phones{position:absolute;right:40px;top:40px;display:flex;align-items:flex-start}"
    + "</style></head><body>"
    + '<div class="text"><p class="eyebrow">' + esc(place || "Mapped course") + "</p><h1>" + esc(name) + "</h1><p>Every hole on your Garmin, Apple Watch and phone.</p><div class=\"brand\">Clarity Caddy</div></div>"
    + '<div class="phones">' + phones + "</div></body></html>";
}

async function dataUrl(file) {
  return "data:image/png;base64," + (await fs.readFile(file)).toString("base64");
}

/* From a course's frame folder, the web-size frames and the card, as {path, buffer, type}. */
export async function deriveAssets(browser, { dir, name, place }) {
  const out = [];
  const page = await browser.newPage({ viewport: { width: OG.width, height: OG.height }, deviceScaleFactor: 1 });
  try {
    const frameUrls = [];
    for (const frame of FRAMES) {
      const file = path.join(dir, frame + ".png");
      try { await fs.access(file); } catch (error) { continue; }
      const src = await dataUrl(file);
      frameUrls.push(src);
      /* The frame at web width: a page holding just the image, clipped to it. */
      await page.setContent('<!doctype html><html><body style="margin:0;background:#000"><img id="f" src="' + src + '" style="display:block;width:' + WEB_WIDTH + 'px;height:auto"></body></html>');
      const img = page.locator("#f");
      await img.waitFor();
      const buffer = await img.screenshot({ type: "jpeg", quality: 86 });
      out.push({ path: "web/" + frame + ".jpg", buffer, type: "image/jpeg" });
    }
    if (frameUrls.length) {
      /* The card leads with the tee shot and the approach - the two frames with a bubble on
         them - falling back to whatever exists. */
      const ordered = [frameUrls[1], frameUrls[2], frameUrls[0]].filter(Boolean);
      await page.setContent(ogCardHtml({ name, place, frames: ordered }));
      await page.waitForFunction(() => Array.from(document.images).every((i) => i.complete));
      const buffer = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: OG.width, height: OG.height } });
      out.push({ path: "og.png", buffer, type: "image/png" });
    }
  } finally {
    await page.close();
  }
  return out;
}

export async function uploadAssets(courseId, assets, config, fetchImpl = fetch) {
  const uploaded = [];
  for (const asset of assets) {
    const target = courseId + "/" + asset.path;
    const response = await fetchImpl(config.base + "/storage/v1/object/" + BUCKET + "/" + target, {
      method: "POST",
      headers: { apikey: config.key, Authorization: "Bearer " + config.key, "Content-Type": asset.type, "x-upsert": "true" },
      body: asset.buffer
    });
    if (!response.ok) throw new Error("Upload " + response.status + " for " + target + ": " + (await response.text()).slice(0, 200));
    uploaded.push(target);
  }
  return uploaded;
}

/* One course: derive, upload, say what landed. */
export async function publishCourseAssets(browser, { courseId, dir, name, place }, config) {
  const assets = await deriveAssets(browser, { dir, name, place });
  if (!assets.length) return [];
  return uploadAssets(courseId, assets, config);
}
