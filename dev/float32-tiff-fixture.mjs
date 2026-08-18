/* Test fixture: a minimal single-strip uncompressed little-endian float32 TIFF - the same
   sampleFormat 3 shape 3DEP's exportImage was confirmed to return ("32-bit sampleFormat 3,
   sensible metres", gd-imagery-sources.mjs). Built by hand so the tests that exercise the
   float32 elevation path (dev/terrain-relief.test.js, dev/relief-preview.test.js) need no
   binary fixture on disk and no tiff-writing dependency. sharp/libvips reads it back
   byte-exact - asserted in terrain-relief check 8. */
export function float32Tiff(heights, width, height) {
  const pixelBytes = width * height * 4;
  const ifdEntries = 10;
  const ifdOffset = 8;
  const dataOffset = ifdOffset + 2 + ifdEntries * 12 + 4;
  const buf = Buffer.alloc(dataOffset + pixelBytes);
  buf.write("II", 0, "ascii"); buf.writeUInt16LE(42, 2); buf.writeUInt32LE(ifdOffset, 4);
  let p = ifdOffset;
  buf.writeUInt16LE(ifdEntries, p); p += 2;
  const entry = (tag, type, count, value) => {
    buf.writeUInt16LE(tag, p); buf.writeUInt16LE(type, p + 2);
    buf.writeUInt32LE(count, p + 4); buf.writeUInt32LE(value, p + 8); p += 12;
  };
  entry(256, 3, 1, width);      // ImageWidth
  entry(257, 3, 1, height);     // ImageLength
  entry(258, 3, 1, 32);         // BitsPerSample
  entry(259, 3, 1, 1);          // Compression: none
  entry(262, 3, 1, 1);          // Photometric: BlackIsZero
  entry(273, 4, 1, dataOffset); // StripOffsets
  entry(277, 3, 1, 1);          // SamplesPerPixel
  entry(278, 3, 1, height);     // RowsPerStrip
  entry(279, 4, 1, pixelBytes); // StripByteCounts
  entry(339, 3, 1, 3);          // SampleFormat: IEEE float
  buf.writeUInt32LE(0, p);      // next IFD: none
  for (let i = 0; i < heights.length; i++) buf.writeFloatLE(heights[i], dataOffset + i * 4);
  return buf;
}
