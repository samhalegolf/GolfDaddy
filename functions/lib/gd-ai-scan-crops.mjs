/* Cuts the close-up crops the verify pass looks at (gd-ai-scan-verify-core.mjs says where)
 * out of the scan picture with sharp: extract the window, scale it up, lay the grid and the
 * pin crosshair over it, hand back PNG base64 for the model. sharp is loaded on demand, the
 * way the mapper worker loads it, so the scan core and its tests never need it. */
import { cropOverlaySvg } from "./gd-ai-scan-verify-core.mjs";

export async function renderCrops(image, windows) {
  const sharp = (await import("sharp")).default;
  const source = Buffer.from(String(image.data || ""), "base64");
  const out = [];
  for (const w of windows) {
    const data = await sharp(source)
      .extract({ left: w.left, top: w.top, width: w.side, height: w.side })
      .resize(w.outPx, w.outPx, { kernel: "lanczos3" })
      .composite([{ input: Buffer.from(cropOverlaySvg(w)), top: 0, left: 0 }])
      .png()
      .toBuffer();
    out.push({ crop: w.crop, mediaType: "image/png", data: data.toString("base64") });
  }
  return out;
}
