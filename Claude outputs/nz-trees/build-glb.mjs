/* Writes one .glb per tree from nz-trees.js.
 *   node build-glb.mjs [outDir]      (default: ./glb)
 * No dependencies. Each file: one node, one mesh, one double-sided vertex-colour material,
 * POSITION / NORMAL / COLOR_0 as a plain triangle list. The mesh's `extras` carry the
 * species, height and crown radius, so a renderer can scale a model to a tree marker's
 * crown radius with  scale = markerRadius / extras.crownRadiusM.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const lib = {};
new Function("self", readFileSync(join(here, "nz-trees.js"), "utf8"))(lib);
const NZTrees = lib.NZTrees;

const outDir = process.argv[2] || join(here, "glb");
mkdirSync(outDir, { recursive: true });

function pad4(buf, fill) {
  const extra = (4 - (buf.length % 4)) % 4;
  return extra ? Buffer.concat([buf, Buffer.alloc(extra, fill)]) : buf;
}

function glb(tree) {
  const parts = [tree.positions, tree.normals, tree.colors].map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  const bin = Buffer.concat(parts);
  const count = tree.positions.length / 3;
  let offset = 0;
  const bufferViews = parts.map((p) => {
    const view = { buffer: 0, byteOffset: offset, byteLength: p.length, target: 34962 };
    offset += p.length;
    return view;
  });
  /* Exact float32 bounds for the accessor (the rounded ones in extras are for people). */
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tree.positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], tree.positions[i + a]);
      max[a] = Math.max(max[a], tree.positions[i + a]);
    }
  }
  const json = {
    asset: { version: "2.0", generator: "Clarity Caddy NZ trees (nz-trees.js)" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: tree.id, mesh: 0 }],
    meshes: [{
      name: tree.id,
      primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, material: 0, mode: 4 }],
      extras: { ...tree.meta, triangles: tree.triangles, units: "metres", up: "Y", origin: "base of main trunk" }
    }],
    materials: [{
      name: tree.id + "-vertex-colour",
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.9 },
      doubleSided: true
    }],
    accessors: [
      { bufferView: 0, componentType: 5126, count, type: "VEC3", min, max },
      { bufferView: 1, componentType: 5126, count, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count, type: "VEC3" }
    ],
    bufferViews,
    buffers: [{ byteLength: bin.length }]
  };
  const jsonChunk = pad4(Buffer.from(JSON.stringify(json), "utf8"), 0x20);
  const binChunk = pad4(bin, 0);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  return Buffer.concat([header, ch(jsonChunk.length, 0x4e4f534a), jsonChunk, ch(binChunk.length, 0x004e4942), binChunk]);
}

const builds = NZTrees.SPECIES.map((s) => NZTrees.build(s.id));
builds.push(NZTrees.build("pohutukawa", { flowering: true }));

const index = builds.map((tree) => {
  const file = tree.id + (tree.meta.variant ? "-" + tree.meta.variant : "") + ".glb";
  const data = glb(tree);
  writeFileSync(join(outDir, file), data);
  return { file, name: tree.name, variant: tree.meta.variant, heightM: tree.meta.heightM, crownRadiusM: tree.meta.crownRadiusM, triangles: tree.triangles, kb: +(data.length / 1024).toFixed(1), billboardType: tree.meta.billboardType };
});
writeFileSync(join(outDir, "index.json"), JSON.stringify(index, null, 2) + "\n");
console.table(index);
