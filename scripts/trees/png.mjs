/* Minimal PNG encoder (RGBA, 8-bit) on Node's zlib - no dependencies. */
import { deflateSync } from "node:zlib";

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/* opaque: drop the alpha channel (RGB) - smaller files for bark. */
export function encodePNG({ width, height, data }, { opaque = false } = {}) {
  const bpp = opaque ? 3 : 4, row = width * bpp + 1, raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    raw[y * row] = 1; // Sub filter: compresses noisy textures better than none
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < bpp; c++) {
        const v = data[(y * width + x) * 4 + c], left = x ? data[(y * width + x - 1) * 4 + c] : 0;
        raw[y * row + 1 + x * bpp + c] = (v - left) & 255;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = opaque ? 2 : 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}
