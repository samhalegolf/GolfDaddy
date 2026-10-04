/* The half of the visual scorecard fallback that talks to the world: download the
 * candidate images safely and ask Claude to transcribe them.
 *
 * Injected into resolveScorecard as deps.visual, so the resolver and
 * gd-scorecard-visual-core stay testable without a network or a model. What comes
 * back from here is only a transcription; gd-scorecard-visual-core decides whether
 * to believe it.
 *
 * Its own clock. The resolver's HTML phase runs on a short budget because the
 * mapper's job is geometry; the visual phase starts after that budget is spent and
 * gets its own, started on first use. */

import Anthropic from "@anthropic-ai/sdk";
import safeRemote from "./safe-remote-url.js";
import webSearch from "./gd-web-search.js";
import { VISUAL_SCORECARD_SCHEMA, buildVisualPrompt } from "./gd-scorecard-visual-core.mjs";

const { safeRemoteUrl, resolvesToPublicAddress } = safeRemote;

/* Opus 5.5: telling an 8 from a 3 in a photographed card is the whole job, and this
   only runs when every HTML route has already failed, so it is rare. */
const DEFAULT_MODEL = "claude-opus-5-5";
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;
const MAX_IMAGE_SIDE = 8000;
const MIN_IMAGE_SIDE = 120;
const MAX_IMAGES_PER_CALL = 18;
export const SCORECARD_VISUAL_BUDGET_MS = 60000;

function visionModel() { return process.env.CLARITY_SCORECARD_VISION_MODEL || DEFAULT_MODEL; }

/* Media type and pixel size from the file's own header, not the server's word for
   it - a wrong media type or an oversized image fails the whole model call. */
export function sniffImage(bytes) {
  const b = bytes;
  if (!b || b.length < 24) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { mediaType: "image/png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { mediaType: "image/gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const chunk = b.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { mediaType: "image/webp", width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === "VP8 ") return { mediaType: "image/webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { mediaType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return { mediaType: "image/webp", width: null, height: null };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < b.length) {
      if (b[offset] !== 0xff) { offset += 1; continue; }
      const marker = b[offset + 1];
      const length = b.readUInt16BE(offset + 2);
      /* SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC). */
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { mediaType: "image/jpeg", height: b.readUInt16BE(offset + 5), width: b.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
    return { mediaType: "image/jpeg", width: null, height: null };
  }
  return null;
}

async function fetchImage(url, signal) {
  const target = safeRemoteUrl(url, { maxUrlChars: 1000 });
  if (!target) throw new Error("unsafe or unsupported url");
  if (!(await resolvesToPublicAddress(target))) throw new Error("url does not resolve to a public address");
  const response = await fetch(target.href, {
    signal, redirect: "follow",
    headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8", "User-Agent": "ClarityCaddie/1.0 (+https://caddy.claritygolf.app)" }
  });
  if (!response.ok) throw new Error("HTTP " + response.status);
  const declared = Number(response.headers.get("content-length")) || 0;
  if (declared > MAX_IMAGE_BYTES) throw new Error("image too large");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("image too large");
  const sniffed = sniffImage(bytes);
  if (!sniffed) throw new Error("not a supported image");
  const { width, height } = sniffed;
  if (width && height) {
    if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) throw new Error("image dimensions too large");
    if (width < MIN_IMAGE_SIDE || height < MIN_IMAGE_SIDE) throw new Error("image too small to hold a scorecard");
  }
  return { mediaType: sniffed.mediaType, data: bytes.toString("base64"), width, height };
}

async function transcribe(client, images, signal) {
  const content = [];
  images.forEach((image, index) => {
    content.push({ type: "text", text: "Image " + (index + 1) + ":" });
    content.push({ type: "image", source: { type: "base64", media_type: image.file.mediaType, data: image.file.data } });
  });
  content.push({ type: "text", text: buildVisualPrompt(images) });
  /* Streamed for the same reason the AI scan is: many images and a long answer must
     not hit an HTTP timeout. A safety decline falls back server-side rather than
     arriving as an empty 200. */
  const stream = client.beta.messages.stream({
    model: visionModel(),
    max_tokens: 32000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "high", format: { type: "json_schema", schema: VISUAL_SCORECARD_SCHEMA } },
    messages: [{ role: "user", content }]
  }, { signal });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") throw new Error("the model declined to read the images");
  if (message.stop_reason === "max_tokens") throw new Error("the transcription was cut off");
  const text = (message.content || []).filter(block => block.type === "text").map(block => block.text).join("");
  const parsed = JSON.parse(text);
  return { images: Array.isArray(parsed.images) ? parsed.images : [], model: message.model };
}

/* deps.visual for resolveScorecard, or null when there is no API key - the resolver
   then reports the visual fallback as unavailable instead of failing.
 *
 * fetchHtml(url, signal): the caller's own page fetcher, re-used for hole pages so
 * the same SSRF guards and size caps apply. */
export function makeScorecardVisualReader({ fetchHtml, budgetMs = SCORECARD_VISUAL_BUDGET_MS, cache = null } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  let controller = null, timer = null;
  const signal = () => {
    if (!controller && typeof AbortController !== "undefined") {
      controller = new AbortController();
      timer = setTimeout(() => controller.abort(), budgetMs);
    }
    return controller ? controller.signal : undefined;
  };
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const provider = webSearch.pickProvider();
  return {
    /* Straight to an image search, for cards no page we read was showing. Null
       when no search provider is configured. */
    searchImages: provider && provider.searchImages
      ? query => provider.searchImages(query, 20)
      : null,
    fetchHtml: url => fetchHtml(url, signal()),
    /* images: [{url, kind, hole, context}] -> [{image, raw|null, error?}] in the same order. */
    async readImages(images) {
      const list = (images || []).slice(0, MAX_IMAGES_PER_CALL);
      /* cache (url -> answer) lets one scan read an image once. A multi-course
         facility asks for cards round after round; reading the same picture again
         costs a model call and can come back with a digit read differently, which
         then looks like a second course. */
      if (cache && list.every(image => cache.has(image.url))) {
        return list.map(image => Object.assign({ image }, cache.get(image.url)));
      }
      /* An image search also hands back the search engine's own copy. It is
         smaller, but it is used when the site holding the original refuses us -
         the same sites that refuse a page fetch often refuse an image fetch. */
      const load = image => fetchImage(image.url, signal())
        .catch(error => image.thumbnailUrl ? fetchImage(image.thumbnailUrl, signal()) : Promise.reject(error));
      const loaded = await Promise.all(list.map(image => load(image)
        .then(file => ({ image, file }))
        .catch(error => ({ image, error: String(error && error.message || error).slice(0, 160) }))));
      const ready = loaded.filter(entry => entry.file);
      if (!ready.length) return loaded.map(entry => ({ image: entry.image, raw: null, error: entry.error || "not loaded" }));
      const answer = await transcribe(client, ready.map(entry => Object.assign({}, entry.image, { file: entry.file })), signal());
      return loaded.map(entry => {
        if (!entry.file) return { image: entry.image, raw: null, error: entry.error };
        const index = ready.indexOf(entry) + 1;
        const raw = answer.images.find(read => read && read.imageIndex === index) || null;
        const result = { raw, error: raw ? null : "no transcription returned", model: answer.model };
        if (cache && raw) cache.set(entry.image.url, result);
        return Object.assign({ image: entry.image }, result);
      });
    },
    done() { if (timer) clearTimeout(timer); }
  };
}
