#!/usr/bin/env node
// Builds public/assets/village-kit.glb from the full medieval village kit GLB.
//
// The source kit contains every asset sitting at the origin, with many
// byte-identical duplicates (175 terrain blobs, 212 path stones, 68 grass
// tufts...). The game only needs one template of each asset and instances
// them itself, so this keeps the first top-level node of every name and
// repacks the binary buffer. Result: ~13.8 MB -> a small fraction of that.
//
// Usage: node tools/extract-kit.mjs <source.glb> [out.glb]

import fs from 'node:fs';
import path from 'node:path';

const src = process.argv[2];
const out = process.argv[3] || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public', 'assets', 'village-kit.glb');
if (!src) {
  console.error('usage: node tools/extract-kit.mjs <source.glb> [out.glb]');
  process.exit(1);
}

const buf = fs.readFileSync(src);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB file');
let off = 12;
let json = null;
let bin = null;
while (off < buf.length) {
  const len = buf.readUInt32LE(off);
  const type = buf.readUInt32LE(off + 4);
  const data = buf.subarray(off + 8, off + 8 + len);
  if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
  else if (type === 0x004e4942) bin = data;
  off += 8 + len;
}

const nodes = json.nodes;
const root = nodes[json.scenes[json.scene || 0].nodes[0]];
const seen = new Set();
const keepTop = [];
for (const c of root.children) {
  const name = nodes[c].name;
  if (seen.has(name)) continue;
  seen.add(name);
  keepTop.push(c);
}

// Collect every node in kept subtrees (skins may reference joints anywhere in them).
const nodeMap = new Map();
const order = [];
function visit(i) {
  if (nodeMap.has(i)) return;
  nodeMap.set(i, order.length);
  order.push(i);
  for (const c of nodes[i].children || []) visit(c);
}
keepTop.forEach(visit);

const meshMap = new Map(), skinMap = new Map(), matMap = new Map(), accMap = new Map(), bvMap = new Map();
const outJson = {
  asset: { version: '2.0', generator: 'wizards-vs-zombies extract-kit' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [],
  meshes: [],
  materials: [],
  accessors: [],
  bufferViews: [],
  buffers: [],
  skins: [],
};
if (json.extensionsUsed) outJson.extensionsUsed = json.extensionsUsed;

const chunks = [];
let binLen = 0;
function mapBufferView(i) {
  if (bvMap.has(i)) return bvMap.get(i);
  const bv = json.bufferViews[i];
  const start = bv.byteOffset || 0;
  const data = bin.subarray(start, start + bv.byteLength);
  const pad = (4 - (binLen % 4)) % 4;
  if (pad) { chunks.push(Buffer.alloc(pad)); binLen += pad; }
  const nbv = { buffer: 0, byteOffset: binLen, byteLength: bv.byteLength };
  if (bv.byteStride) nbv.byteStride = bv.byteStride;
  if (bv.target) nbv.target = bv.target;
  chunks.push(data);
  binLen += bv.byteLength;
  const idx = outJson.bufferViews.push(nbv) - 1;
  bvMap.set(i, idx);
  return idx;
}
function mapAccessor(i) {
  if (accMap.has(i)) return accMap.get(i);
  const a = { ...json.accessors[i] };
  if (a.bufferView !== undefined) a.bufferView = mapBufferView(a.bufferView);
  const idx = outJson.accessors.push(a) - 1;
  accMap.set(i, idx);
  return idx;
}
function mapMaterial(i) {
  if (matMap.has(i)) return matMap.get(i);
  const idx = outJson.materials.push(json.materials[i]) - 1;
  matMap.set(i, idx);
  return idx;
}
function mapMesh(i) {
  if (meshMap.has(i)) return meshMap.get(i);
  const m = json.meshes[i];
  const nm = { ...m, primitives: m.primitives.map((p) => {
    const np = { ...p, attributes: {} };
    for (const [k, v] of Object.entries(p.attributes)) np.attributes[k] = mapAccessor(v);
    if (p.indices !== undefined) np.indices = mapAccessor(p.indices);
    if (p.material !== undefined) np.material = mapMaterial(p.material);
    if (p.targets) np.targets = p.targets.map((t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, mapAccessor(v)])));
    return np;
  }) };
  const idx = outJson.meshes.push(nm) - 1;
  meshMap.set(i, idx);
  return idx;
}
function mapSkin(i) {
  if (skinMap.has(i)) return skinMap.get(i);
  const s = json.skins[i];
  const ns = { ...s, joints: s.joints.map((j) => nodeMap.get(j) + 1) };
  if (s.inverseBindMatrices !== undefined) ns.inverseBindMatrices = mapAccessor(s.inverseBindMatrices);
  if (s.skeleton !== undefined) ns.skeleton = nodeMap.get(s.skeleton) + 1;
  const idx = outJson.skins.push(ns) - 1;
  skinMap.set(i, idx);
  return idx;
}

outJson.nodes.push({ name: 'village-kit', children: keepTop.map((c) => nodeMap.get(c) + 1) });
const topSet = new Set(keepTop);
for (const i of order) {
  const n = { ...nodes[i] };
  if (n.children) n.children = n.children.map((c) => nodeMap.get(c) + 1);
  // Templates sit at the origin facing +Z; the game positions every instance itself.
  if (topSet.has(i)) { delete n.matrix; delete n.translation; delete n.rotation; delete n.scale; }
  outJson.nodes.push(n);
}
for (let k = 0; k < order.length; k++) {
  const n = outJson.nodes[k + 1];
  if (n.mesh !== undefined) n.mesh = mapMesh(n.mesh);
  if (n.skin !== undefined) n.skin = mapSkin(n.skin);
}
if (!outJson.skins.length) delete outJson.skins;

const binBuf = Buffer.concat(chunks);
const binPadded = Buffer.concat([binBuf, Buffer.alloc((4 - (binBuf.length % 4)) % 4)]);
outJson.buffers.push({ byteLength: binPadded.length });
let jsonBuf = Buffer.from(JSON.stringify(outJson), 'utf8');
jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);

const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binPadded.length, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
const bh = Buffer.alloc(8); bh.writeUInt32LE(binPadded.length, 0); bh.writeUInt32LE(0x004e4942, 4);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([header, jh, jsonBuf, bh, binPadded]));
console.log(`kept ${keepTop.length} assets: ${keepTop.map((c) => nodes[c].name).join(', ')}`);
console.log(`wrote ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(2)} MB, was ${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
