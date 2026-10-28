// Loads the medieval village kit GLB and exposes per-asset templates plus recoloured character variants.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

export const templates = {};
const variantGeo = new Map();
const lambertCache = new Map();

// Swap the PBR materials for cheaper Lambert ones (big win on tablets; the kit is flat vertex-coloured).
function toLambert(m) {
  if (lambertCache.has(m)) return lambertCache.get(m);
  const emissive = m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b > 0.01);
  const lm = new THREE.MeshLambertMaterial({
    color: m.color.clone(),
    vertexColors: m.vertexColors,
    transparent: m.transparent,
    opacity: m.opacity,
    side: m.side,
    emissive: emissive ? m.emissive.clone().multiplyScalar(m.emissiveIntensity || 1) : 0x000000,
    depthWrite: m.depthWrite,
  });
  lm.name = m.name;
  lambertCache.set(m, lm);
  return lm;
}

export async function loadKit(onProgress) {
  const loader = new GLTFLoader();
  const gltf = await new Promise((resolve, reject) => {
    loader.load('/assets/village-kit.glb', resolve, (e) => onProgress?.(e.total ? e.loaded / e.total : 0.5), reject);
  });
  const root = gltf.scene.getObjectByName('village-kit') || gltf.scene.children[0];
  for (const child of [...root.children]) {
    let name = child.name;
    if (templates[name] || !name) continue;
    // GLTFLoader de-duplicates names ("anvil" -> "anvil_1"); undo it for top-level assets
    const base = name.replace(/_\d+$/, '');
    if (!templates[base]) name = base;
    child.traverse((o) => {
      if (o.isMesh) {
        o.material = Array.isArray(o.material) ? o.material.map(toLambert) : toLambert(o.material);
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    templates[name] = child;
  }
  // both character rigs use the same bone names, which the loader suffixes ("Head_1"); restore them
  for (const rig of ['merchant', 'tradesman']) {
    templates[rig]?.traverse((o) => { if (o !== templates[rig]) o.name = o.name.replace(/_\d+$/, ''); });
  }
  return templates;
}

// --- Character recolouring ---------------------------------------------------
// The merchant/tradesman rigs use flat vertex colours; we remap palette entries to build
// wizards, zombies and the librarian from the same skinned meshes.
const MERCHANT = {
  robe: [0.262, 0.144, 0.068],
  dark: [0.159, 0.076, 0.038],
  mantle: [0.479, 0.328, 0.168],
  hood: [0.275, 0.254, 0.216],
  skin: [0.624, 0.347, 0.175],
  brow: [0.392, 0.202, 0.091],
  trim: [0.807, 0.716, 0.527],
};
const TRADESMAN = {
  skin: [0.807, 0.584, 0.371],
  pants: [0.479, 0.328, 0.168],
  boots: [0.159, 0.076, 0.038],
  shirt: [0.807, 0.716, 0.527],
  hair: [0.045, 0.06, 0.08],
  vest: [0.262, 0.144, 0.068],
};

const srgb = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };

export const LOOKS = {
  // wizards (merchant rig)
  striker: { rig: 'merchant', map: { robe: srgb(0x8c2414), dark: srgb(0x3a0d08), mantle: srgb(0xd8572a), hood: srgb(0x5a1a10), trim: srgb(0xf2c14e) } },
  healer: { rig: 'merchant', map: { robe: srgb(0xe8e4d4), dark: srgb(0x6a6450), mantle: srgb(0x48b06a), hood: srgb(0xf4f0e0), trim: srgb(0xf2d06e) } },
  augmenter: { rig: 'merchant', map: { robe: srgb(0x4a2378), dark: srgb(0x1f0e33), mantle: srgb(0x8f55d6), hood: srgb(0x2c1450), trim: srgb(0x7ef0e0) } },
  arcanist: { rig: 'merchant', map: { robe: srgb(0x1f3c78), mantle: srgb(0x3a6fc4), hood: srgb(0x15264a), trim: srgb(0xf4d35e) } },
  librarian: { rig: 'merchant', map: { robe: srgb(0x2f5d3a), mantle: srgb(0x7a5a35), hood: srgb(0xc9c3b0), trim: srgb(0xe8d9a8) } },
  trader: { rig: 'tradesman', map: {} },
  // zombies
  zombie: { rig: 'merchant', map: { skin: srgb(0x7f9a68), robe: srgb(0x4b453c), dark: srgb(0x2a2722), mantle: srgb(0x6b5f4e), hood: srgb(0x55604a), brow: srgb(0x3b4430), trim: srgb(0x6f6656) } },
  zombie2: { rig: 'tradesman', map: { skin: srgb(0x8aa070), shirt: srgb(0x7d7564), pants: srgb(0x4a4438), vest: srgb(0x3d362e), boots: srgb(0x2a2520), hair: srgb(0x202018) } },
  brute: { rig: 'merchant', map: { skin: srgb(0x8e8a5a), robe: srgb(0x5a2f22), dark: srgb(0x2a1a14), mantle: srgb(0x7a4a32), hood: srgb(0x4f4a30), brow: srgb(0x3b3420), trim: srgb(0x8a6a4a) } },
  spitter: { rig: 'tradesman', map: { skin: srgb(0x9cc04a), shirt: srgb(0x5e7a2a), pants: srgb(0x3a4a20), vest: srgb(0x2f3a18), boots: srgb(0x1f2410), hair: srgb(0x2a3410) } },
  bloater: { rig: 'merchant', map: { skin: srgb(0x9a8ab0), robe: srgb(0x5d4a6e), dark: srgb(0x2e2238), mantle: srgb(0x7d6a8a), hood: srgb(0x6a5a78), brow: srgb(0x40304a), trim: srgb(0x8a7a98) } },
  wraith: { rig: 'merchant', map: { skin: srgb(0xa8d8ff), robe: srgb(0x3d6a9a), dark: srgb(0x1d3a5a), mantle: srgb(0x6aa0d8), hood: srgb(0x2a4a70), brow: srgb(0xc8f0ff), trim: srgb(0xc8f0ff) } },
  gravecrusher: { rig: 'merchant', map: { skin: srgb(0x6e7a4a), robe: srgb(0x3a2a20), dark: srgb(0x1a1410), mantle: srgb(0x5a4030), hood: srgb(0x30281c), brow: srgb(0x1a1a10), trim: srgb(0xa08040) } },
  plague_mother: { rig: 'merchant', map: { skin: srgb(0x8cb040), robe: srgb(0x3d5020), dark: srgb(0x1c2810), mantle: srgb(0x6a8a2a), hood: srgb(0x2a3a12), brow: srgb(0x1a2008), trim: srgb(0xd0e040) } },
  lich_king: { rig: 'merchant', map: { skin: srgb(0xc8d8e8), robe: srgb(0x1a1530), dark: srgb(0x0a0814), mantle: srgb(0x3a2a6a), hood: srgb(0x241a40), brow: srgb(0x60f0ff), trim: srgb(0x60f0ff) } },
};

function recolorGeometry(geo, palette, map) {
  const out = geo.clone();
  const col = out.getAttribute('color');
  if (!col) return out;
  const entries = Object.entries(palette).filter(([k]) => map[k]);
  for (let i = 0; i < col.count; i++) {
    const r = col.getX(i), g = col.getY(i), b = col.getZ(i);
    for (const [k, c] of entries) {
      if (Math.abs(r - c[0]) < 0.01 && Math.abs(g - c[1]) < 0.01 && Math.abs(b - c[2]) < 0.01) {
        const t = map[k];
        col.setXYZ(i, t[0], t[1], t[2]);
        break;
      }
    }
  }
  col.needsUpdate = true;
  return out;
}

// Returns a fresh skinned clone of a character rig with the given look applied.
export function makeCharacterModel(lookName) {
  const look = LOOKS[lookName] || LOOKS.zombie;
  const tpl = templates[look.rig];
  const model = SkeletonUtils.clone(tpl);
  const palette = look.rig === 'merchant' ? MERCHANT : TRADESMAN;
  model.traverse((o) => {
    if (o.isSkinnedMesh || o.isMesh) {
      const key = lookName + '|' + o.name;
      let geo = variantGeo.get(key);
      if (!geo) {
        geo = Object.keys(look.map).length ? recolorGeometry(o.geometry, palette, look.map) : o.geometry;
        variantGeo.set(key, geo);
      }
      o.geometry = geo;
      o.castShadow = true;
      o.receiveShadow = false;
      o.frustumCulled = false;
    }
  });
  return model;
}

// Static clone (shares geometry/material) of a kit asset.
export function cloneAsset(name) {
  const tpl = templates[name];
  if (!tpl) throw new Error('missing asset ' + name);
  return tpl.clone(true);
}

// All meshes in an asset with their transform relative to the asset root (for instancing).
export function assetMeshes(name) {
  const tpl = templates[name];
  tpl.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(tpl.matrixWorld).invert();
  const out = [];
  tpl.traverse((o) => {
    if (o.isMesh && !o.isSkinnedMesh) out.push({ geometry: o.geometry, material: o.material, matrix: new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld), name: o.name });
  });
  return out;
}
