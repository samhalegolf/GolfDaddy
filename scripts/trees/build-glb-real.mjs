/* Writes one textured .glb per realistic tree from nz-trees-real.js.
 *   node scripts/trees/build-glb-real.mjs <output folder>
 * No dependencies. Each file: one node, one mesh, two primitives -
 *   bark:   opaque, tiling bark texture (REPEAT)
 *   leaves: alphaMode MASK (cutoff 0.45), leaf/needle atlas, single-sided because every
 *           card is already written front and back with crown-outward normals
 * COLOR_0 (normalised unsigned bytes) carries ambient occlusion and multiplies the texture.
 * The mesh's `extras` carry species, height and crown radius:
 *   scale = markerRadius / extras.crownRadiusM
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePNG } from "./png.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const lib = {};
new Function("self", readFileSync(join(here, "nz-trees-real.js"), "utf8"))(lib);
const T = lib.NZTreesReal;

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: node scripts/trees/build-glb-real.mjs <output folder>");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const pad4 = (buf, fill = 0) => {
  const extra = (4 - (buf.length % 4)) % 4;
  return extra ? Buffer.concat([buf, Buffer.alloc(extra, fill)]) : buf;
};
const asBuf = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

function glb(tree) {
  const chunks = [], bufferViews = [], accessors = [];
  let offset = 0;
  function view(buf, target) {
    const padded = pad4(buf);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, ...(target ? { target } : {}) });
    chunks.push(padded);
    offset += padded.length;
    return bufferViews.length - 1;
  }
  function accessor(def) { accessors.push(def); return accessors.length - 1; }

  function primitive(g, material) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < g.positions.length; i += 3) for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], g.positions[i + a]); max[a] = Math.max(max[a], g.positions[i + a]);
    }
    const n = g.vertexCount;
    const colors = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) colors[i * 4 + c] = Math.round(Math.min(1, Math.max(0, g.colors[i * 3 + c])) * 255);
      colors[i * 4 + 3] = 255;
    }
    const attributes = {
      POSITION: accessor({ bufferView: view(asBuf(g.positions), 34962), componentType: 5126, count: n, type: "VEC3", min, max }),
      NORMAL: accessor({ bufferView: view(asBuf(g.normals), 34962), componentType: 5126, count: n, type: "VEC3" }),
      TEXCOORD_0: accessor({ bufferView: view(asBuf(g.uvs), 34962), componentType: 5126, count: n, type: "VEC2" }),
      COLOR_0: accessor({ bufferView: view(Buffer.from(colors.buffer), 34962), componentType: 5121, normalized: true, count: n, type: "VEC4" })
    };
    const wide = g.indices instanceof Uint32Array;
    const indices = accessor({ bufferView: view(asBuf(g.indices), 34963), componentType: wide ? 5125 : 5123, count: g.indices.length, type: "SCALAR" });
    return { attributes, indices, material, mode: 4 };
  }

  const prims = [primitive(tree.bark, 0), primitive(tree.leaves, 1)];
  const barkImg = view(encodePNG(tree.textures.bark, { opaque: true }));
  const leafImg = view(encodePNG(tree.textures.leaves));

  const json = {
    asset: { version: "2.0", generator: "Clarity Caddy NZ trees, realistic (nz-trees-real.js)" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: tree.id, mesh: 0 }],
    meshes: [{ name: tree.id, primitives: prims, extras: { ...tree.meta, units: "metres", up: "Y", origin: "base of main trunk" } }],
    materials: [
      { name: tree.id + "-bark", pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.95 } },
      { name: tree.id + "-leaves", pbrMetallicRoughness: { baseColorTexture: { index: 1 }, metallicFactor: 0, roughnessFactor: 0.8 }, alphaMode: "MASK", alphaCutoff: 0.45 }
    ],
    samplers: [
      { magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 },
      { magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }
    ],
    images: [
      { name: tree.id + "-bark", bufferView: barkImg, mimeType: "image/png" },
      { name: tree.id + "-leaves", bufferView: leafImg, mimeType: "image/png" }
    ],
    textures: [{ sampler: 0, source: 0 }, { sampler: 1, source: 1 }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }]
  };
  const bin = Buffer.concat(chunks);
  const jsonChunk = pad4(Buffer.from(JSON.stringify(json), "utf8"), 0x20);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + bin.length, 8);
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  return Buffer.concat([header, ch(jsonChunk.length, 0x4e4f534a), jsonChunk, ch(bin.length, 0x004e4942), bin]);
}

const builds = T.SPECIES.map((s) => T.build(s.id));
builds.push(T.build("pohutukawa", { flowering: true }));

const index = builds.map((tree) => {
  const file = tree.id + (tree.meta.variant ? "-" + tree.meta.variant : "") + ".glb";
  const data = glb(tree);
  writeFileSync(join(outDir, file), data);
  return { file, name: tree.name, variant: tree.meta.variant, heightM: tree.meta.heightM, crownRadiusM: tree.meta.crownRadiusM, triangles: tree.meta.triangles, kb: Math.round(data.length / 1024), billboardType: tree.meta.billboardType };
});
writeFileSync(join(outDir, "index.json"), JSON.stringify(index, null, 2) + "\n");
console.table(index);
