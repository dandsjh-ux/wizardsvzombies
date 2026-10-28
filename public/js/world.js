// Builds the 3D village from the kit, owns the isometric camera, colliders/nav grid for the local player,
// palisade visuals and construct meshes.

import * as THREE from 'three';
import { templates, cloneAsset, assetMeshes } from './assets.js';
import { buildLayout, buildFenceSegments, buildObstacles, HEART } from '/shared/layout.js';
import { ShapeIndex, NavGrid, resolveCollisions, findPath, cellOf } from '/shared/geom.js';
import { CONSTRUCTS, FENCE_HP, GATE_HP, HEART_HP } from '/shared/data.js';
import { constructShape } from '/shared/placement.js';

const BUILDING_HEIGHT = {
  blacksmith: 4, 'cottage-small': 5, tavern: 11, watchtower: 9.5, 'house-two-story': 8.4, chapel: 8.2, windmill: 9.6,
};
const INSTANCE_MIN = 3;

function grassTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#6f9a4a';
  g.fillRect(0, 0, 256, 256);
  const rnd = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
  for (let i = 0; i < 2600; i++) {
    const x = rnd() * 256, y = rnd() * 256, r = 1 + rnd() * 3.5;
    const l = rnd();
    g.fillStyle = l < 0.33 ? 'rgba(88,128,56,0.55)' : l < 0.66 ? 'rgba(126,164,82,0.5)' : 'rgba(102,140,62,0.5)';
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(60, 60);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function softCircleTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,0.55)');
  grd.addColorStop(0.75, 'rgba(255,255,255,0.35)');
  grd.addColorStop(0.93, 'rgba(255,255,255,0.9)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class World {
  constructor(quality) {
    this.quality = quality;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9cc2de);
    this.scene.fog = new THREE.Fog(0x9cc2de, 120, 190);
    this.layout = buildLayout();
    this.obstacles = buildObstacles(this.layout);
    this.staticIndex = new ShapeIndex(8);
    for (const o of this.obstacles) this.staticIndex.add(o);
    this.segDefs = buildFenceSegments();
    this.fenceShapes = this.segDefs.map((sg) => ({ type: 'box', x: sg.x, z: sg.z, hx: 1.0, hz: sg.gate ? 0.22 : 0.14, rot: sg.rot, seg: sg.id, gate: sg.gate }));
    this.dynIndex = new ShapeIndex(8);
    for (const s of this.fenceShapes) this.dynIndex.add(s);
    this.grid = new NavGrid();
    this.grid.markShapes(this.obstacles, 0.42);
    this.grid.markFence(this.segDefs);
    this.fence = this.segDefs.map((sg) => ({ ...sg, hp: sg.gate ? GATE_HP : FENCE_HP, maxHp: sg.gate ? GATE_HP : FENCE_HP, broken: false, hotUntil: 0, fort: false }));
    this.heart = { hp: HEART_HP, maxHp: HEART_HP, hotUntil: 0 };
    this.constructs = new Map();
    this.buildings = [];
    this.animated = [];
    this.softTex = softCircleTexture();

    this.setupLights();
    this.buildGround();
    this.buildProps();
    this.buildDecor();
    this.buildFence();
    this.buildWellGlow();
    this.setupCamera();
  }

  // ------------------------------------------------------------------ scene
  setupLights() {
    const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x4d5f34, 1.15);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffe6c4, 2.3);
    sun.position.set(-18, 40, -10);
    this.sunOffset = sun.position.clone();
    if (this.quality !== 'low') {
      sun.castShadow = true;
      const sz = this.quality === 'high' ? 2048 : 1024;
      sun.shadow.mapSize.set(sz, sz);
      const s = 34;
      Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 120 });
      sun.shadow.bias = -0.0006;
      sun.shadow.normalBias = 0.02;
    }
    this.scene.add(sun, sun.target);
    this.sun = sun;
    this.hemi = hemi;
  }

  buildGround() {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(420, 420), new THREE.MeshLambertMaterial({ map: grassTexture() }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.ground = ground;
    // worn earth inside the palisade
    const dirt = new THREE.Mesh(new THREE.PlaneGeometry(61, 61), new THREE.MeshLambertMaterial({ color: 0x8a9a5a, transparent: true, opacity: 0.22, depthWrite: false }));
    dirt.rotation.x = -Math.PI / 2;
    dirt.position.y = 0.005;
    dirt.receiveShadow = true;
    this.scene.add(dirt);
  }

  addInstanced(name, list, { cast = true, receive = true } = {}) {
    if (!list.length || !templates[name]) return [];
    const parts = assetMeshes(name);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const out = [];
    for (const part of parts) {
      const im = new THREE.InstancedMesh(part.geometry, part.material, list.length);
      list.forEach((it, i) => {
        p.set(it.x, it.y || 0, it.z);
        q.setFromAxisAngle(up, it.r || 0);
        sc.setScalar(it.s || 1);
        m.compose(p, q, sc).multiply(part.matrix);
        im.setMatrixAt(i, m);
      });
      im.castShadow = cast && this.quality !== 'low';
      im.receiveShadow = receive;
      im.computeBoundingSphere();
      this.scene.add(im);
      out.push({ im, part });
    }
    return out;
  }

  buildProps() {
    const groups = new Map();
    for (const pr of this.layout.props) {
      if (!groups.has(pr.a)) groups.set(pr.a, []);
      groups.get(pr.a).push(pr);
    }
    for (const [name, list] of groups) {
      const isBuilding = BUILDING_HEIGHT[name] !== undefined;
      if (!isBuilding && list.length >= INSTANCE_MIN) {
        this.addInstanced(name, list, { cast: name !== 'flower-planter' });
        continue;
      }
      for (const pr of list) {
        const o = cloneAsset(name);
        o.position.set(pr.x, 0, pr.z);
        o.rotation.y = pr.r;
        o.scale.setScalar(pr.s || 1);
        this.scene.add(o);
        if (name === 'windmill') { const sails = o.getObjectByName('sails'); if (sails) this.animated.push({ obj: sails, spin: 0.5 }); }
        if (isBuilding) {
          const mats = [];
          o.traverse((c) => { if (c.isMesh) { c.material = c.material.clone(); mats.push(c.material); } });
          const shape = this.obstacles.find((ob) => ob.a === name && Math.hypot(ob.x - pr.x, ob.z - pr.z) < 2);
          this.buildings.push({ obj: o, mats, shape, height: BUILDING_HEIGHT[name], fade: 1 });
        }
      }
    }
  }

  buildDecor() {
    const d = this.layout.decor;
    const lite = this.quality === 'low';
    const thin = (arr, k) => (lite ? arr.filter((_, i) => i % k === 0) : arr);
    const toList = (arr) => arr.map(([x, z, r, s]) => ({ x, z, r, s }));
    this.addInstanced('grass-terrain-blob', toList(d['grass-terrain-blob']), { cast: false });
    this.addInstanced('grass-tuft', toList(thin(d['grass-tuft'], 2)), { cast: false, receive: true });
    this.addInstanced('small-rock', toList(d['small-rock']), { cast: !lite });
    for (const name of ['path-stone-a', 'path-stone-b']) {
      const list = d[name].map(([x, z, r, s]) => ({ x, z, r, s: s * 0.78 }));
      for (const { im } of this.addInstanced(name, list, { cast: false })) {
        // tone the pale kit stones down so roads read as roads, not snow
        const col = new Float32Array(list.length * 3);
        for (let i = 0; i < list.length; i++) { const v = 0.62 + ((i * 7919) % 100) / 900; col.set([v, v * 0.96, v * 0.88], i * 3); }
        im.instanceColor = new THREE.InstancedBufferAttribute(col, 3);
      }
    }
  }

  buildFence() {
    const plain = this.segDefs.filter((s) => !s.gate);
    this.fenceIdx = new Map(); // seg id -> instance index
    plain.forEach((s, i) => this.fenceIdx.set(s.id, i));
    this.fenceMeshes = this.addInstanced('fence-wood', plain.map((s) => ({ x: s.x, z: s.z, r: s.rot })));
    for (const { im } of this.fenceMeshes) {
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(plain.length * 3).fill(1), 3);
    }
    this.gates = new Map();
    const wardMat = new THREE.MeshBasicMaterial({ color: 0x7ff0ff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    for (const s of this.segDefs.filter((sg) => sg.gate)) {
      const g = cloneAsset('gate-wood');
      g.position.set(s.x, 0, s.z);
      g.rotation.y = s.rot;
      g.traverse((c) => { if (c.isMesh) { c.material = c.material.clone(); } });
      const ward = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 1.7), wardMat);
      ward.position.y = 0.85;
      g.add(ward);
      this.scene.add(g);
      this.gates.set(s.id, { obj: g, leaf: g.getObjectByName('gate'), ward });
    }
    this.fenceColorDirty = true;
  }

  buildWellGlow() {
    const mat = new THREE.MeshBasicMaterial({ map: this.softTex, color: 0x6ff8ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(3.4, 48), mat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.03;
    this.scene.add(disc);
    this.wellGlow = disc;
    const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.32, 0), new THREE.MeshBasicMaterial({ color: 0x8ffcff }));
    crystal.position.set(0, 3.25, 0);
    this.scene.add(crystal);
    this.wellCrystal = crystal;
  }

  // ------------------------------------------------------------------ camera
  setupCamera() {
    this.viewSize = 30;
    this.camYaw = Math.PI / 4;
    this.camYawTarget = this.camYaw;
    this.pitch = THREE.MathUtils.degToRad(50);
    this.camDist = 90;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 260);
    this.camTarget = new THREE.Vector3();
    this.shake = 0;
  }

  resize(w, h) {
    this.aspect = w / h;
    this.viewH = h;
    this.updateFrustum();
  }

  updateFrustum() {
    const v = this.viewSize / 2;
    this.camera.left = -v * this.aspect;
    this.camera.right = v * this.aspect;
    this.camera.top = v;
    this.camera.bottom = -v;
    this.camera.updateProjectionMatrix();
  }

  zoom(delta) {
    this.viewSize = THREE.MathUtils.clamp(this.viewSize * delta, 12, 46);
    this.updateFrustum();
  }

  rotateCamera(dir) { this.camYawTarget += (dir * Math.PI) / 2; }

  updateCamera(target, dt) {
    this.camYaw += (this.camYawTarget - this.camYaw) * Math.min(1, dt * 6);
    this.camTarget.lerp(target, Math.min(1, dt * 10));
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const off = new THREE.Vector3(Math.sin(this.camYaw) * cp, sp, Math.cos(this.camYaw) * cp).multiplyScalar(this.camDist);
    this.camera.position.copy(this.camTarget).add(off);
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 2.5);
      const a = this.shake * 0.5;
      this.camera.position.x += (Math.random() - 0.5) * a;
      this.camera.position.z += (Math.random() - 0.5) * a;
    }
    this.camera.lookAt(this.camTarget);
    this.sun.position.copy(this.camTarget).add(this.sunOffset);
    this.sun.target.position.copy(this.camTarget);
  }

  // Unit vectors on the ground for screen-right and screen-up (WASD movement).
  screenAxes() {
    const y = this.camYaw;
    return { right: [Math.cos(y), -Math.sin(y)], up: [-Math.sin(y), -Math.cos(y)] };
  }

  // Fade buildings that hide the local wizard.
  updateOcclusion(px, pz, dt) {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const dx = Math.sin(this.camYaw) * cp, dz = Math.cos(this.camYaw) * cp, dy = sp;
    for (const b of this.buildings) {
      let hide = false;
      if (b.shape && Math.hypot(b.shape.x - px, b.shape.z - pz) < 26) {
        for (let t = 0.5; t < 24; t += 0.5) {
          const x = px + dx * t, y = 0.9 + dy * t, z = pz + dz * t;
          if (y > b.height) break;
          if (this.inShape(b.shape, x, z)) { hide = true; break; }
        }
      }
      const target = hide ? 0.28 : 1;
      if (Math.abs(b.fade - target) < 0.01) continue;
      b.fade += (target - b.fade) * Math.min(1, dt * 8);
      for (const m of b.mats) {
        m.transparent = b.fade < 0.99;
        m.opacity = b.fade;
        m.depthWrite = b.fade > 0.6;
      }
    }
  }

  inShape(s, x, z) {
    if (s.type === 'circle') return (x - s.x) ** 2 + (z - s.z) ** 2 < s.r * s.r;
    const c = Math.cos(s.rot), sn = Math.sin(s.rot);
    const lx = (x - s.x) * c - (z - s.z) * sn, lz = (x - s.x) * sn + (z - s.z) * c;
    return Math.abs(lx) < s.hx && Math.abs(lz) < s.hz;
  }

  // ------------------------------------------------------------------ fences
  setFence(id, hp, maxHp, broken, hot, fort, now) {
    const f = this.fence[id];
    if (!f) return;
    const wasBroken = f.broken;
    f.hp = hp; f.maxHp = maxHp; f.broken = !!broken; f.fort = !!fort;
    if (hot) f.hotUntil = now + 1.3;
    if (wasBroken !== f.broken) this.navChanged = true;
    this.fenceColorDirty = true;
  }

  markHot(id, now) { const f = this.fence[id]; if (f) { f.hotUntil = now + 1.3; this.fenceColorDirty = true; } }

  updateFenceVisuals(now) {
    const anyHot = this.fence.some((f) => f.hotUntil > now);
    if (!this.fenceColorDirty && !anyHot) return;
    this.fenceColorDirty = anyHot;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const pulse = 0.5 + 0.5 * Math.sin(now * 14);
    for (const f of this.fence) {
      const ratio = f.hp / f.maxHp;
      let r = 1, g = 1, b = 1;
      if (f.broken) { r = 0.35; g = 0.3; b = 0.28; }
      else if (ratio < 1) { r = 1; g = 0.55 + 0.45 * ratio; b = 0.45 + 0.55 * ratio; }
      if (f.fort) { r *= 1.15; g *= 1.05; b *= 0.6; }
      if (f.hotUntil > now && !f.broken) { r = r + pulse * 0.9; g *= 1 - pulse * 0.6; b *= 1 - pulse * 0.6; }
      if (f.gate) {
        const gt = this.gates.get(f.id);
        if (gt.leaf) gt.leaf.visible = !f.broken;
        gt.ward.visible = !f.broken;
        gt.ward.material.color.setRGB(f.hotUntil > now ? 1 : 0.5, f.hotUntil > now ? 0.4 : 0.94, f.hotUntil > now ? 0.4 : 1);
        gt.obj.traverse((c) => { if (c.isMesh && c !== gt.ward) c.material.color.setRGB(r, g, b); });
        continue;
      }
      const i = this.fenceIdx.get(f.id);
      for (const { im, part } of this.fenceMeshes) {
        im.instanceColor.setXYZ(i, r, g, b);
        p.set(f.x, 0, f.z);
        q.setFromAxisAngle(up, f.rot + (f.broken ? 0.25 * Math.sin(f.id * 7.1) : 0));
        sc.set(1, f.broken ? 0.32 : 1, 1);
        m.compose(p, q, sc).multiply(part.matrix);
        im.setMatrixAt(i, m);
        im.instanceColor.needsUpdate = true;
        im.instanceMatrix.needsUpdate = true;
      }
    }
  }

  // ------------------------------------------------------------------ constructs
  addConstruct(info) {
    if (this.constructs.has(info.id)) return;
    const mesh = makeConstructMesh(info.kind, this.softTex);
    mesh.position.set(info.x, 0, info.z);
    mesh.rotation.y = info.rot || 0;
    mesh.scale.setScalar(0.01);
    this.scene.add(mesh);
    const shape = constructShape(info.kind, info.x, info.z, info.rot || 0, info.id);
    if (shape) this.dynIndex.add(shape);
    this.constructs.set(info.id, { ...info, mesh, shape, born: performance.now() / 1000, hotUntil: 0 });
    this.navChanged = true;
  }

  removeConstruct(id) {
    const c = this.constructs.get(id);
    if (!c) return null;
    this.scene.remove(c.mesh);
    if (c.shape) this.dynIndex.remove(c.shape);
    this.constructs.delete(id);
    this.navChanged = true;
    return c;
  }

  updateConstructs(now) {
    for (const c of this.constructs.values()) {
      const age = now - c.born;
      const s = Math.min(1, age / 0.6);
      c.mesh.scale.setScalar(s < 1 ? s * (1.1 - 0.1 * s) : 1);
      const spin = c.mesh.userData.spin;
      if (spin) spin.rotation.y = now * 1.6;
      const bob = c.mesh.userData.bob;
      if (bob) bob.position.y = bob.userData.y0 + Math.sin(now * 2.2 + c.id) * 0.12;
    }
  }

  // ------------------------------------------------------------------ local movement helpers
  // Player passes gates and broken sections; other fence sections and constructs block.
  collide(x, z, r) {
    [x, z] = resolveCollisions(this.staticIndex, x, z, r);
    [x, z] = resolveCollisions(this.dynIndex, x, z, r, (s) => (s.seg !== undefined ? s.gate || this.fence[s.seg].broken : false));
    return [x, z];
  }

  // Wizards may only change sides of the palisade through a gate or a broken section.
  crossingOpen(ax, az, bx, bz) {
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    let seg = null, bd = Infinity;
    for (const f of this.fence) {
      if (Math.abs(f.x - mx) > 3 || Math.abs(f.z - mz) > 3) continue;
      const ex = f.axis === 'x' ? [f.x - 1, f.z, f.x + 1, f.z] : [f.x, f.z - 1, f.x, f.z + 1];
      const vx = ex[2] - ex[0], vz = ex[3] - ex[1];
      const t = Math.max(0, Math.min(1, ((mx - ex[0]) * vx + (mz - ex[1]) * vz) / (vx * vx + vz * vz)));
      const d = Math.hypot(mx - (ex[0] + vx * t), mz - (ex[1] + vz * t));
      if (d < bd) { bd = d; seg = f; }
    }
    return !seg || seg.broken || seg.gate;
  }

  playerPassable(i) {
    const g = this.grid;
    if (g.blocked[i]) return false;
    const f = g.fence[i];
    if (f >= 0) { const s = this.fence[f]; if (!s.gate && !s.broken) return false; }
    return true;
  }

  path(sx, sz, tx, tz) {
    if (this.navChanged || !this.dynFree) this.rebuildDyn();
    return findPath(this.grid, sx, sz, tx, tz, (i) => this.playerPassable(i) && this.dynFree[i] !== 1, 12000);
  }

  rebuildDyn() {
    this.navChanged = false;
    this.dynFree = new Uint8Array(this.grid.n * this.grid.n);
    for (const c of this.constructs.values()) {
      if (!c.shape) continue;
      for (let ix = cellOf(c.x - 3); ix <= cellOf(c.x + 3); ix++)
        for (let iz = cellOf(c.z - 3); iz <= cellOf(c.z + 3); iz++) {
          const cx = ix - this.grid.n / 2 + 0.5, cz = iz - this.grid.n / 2 + 0.5;
          if (c.shape.type === 'circle' ? Math.hypot(cx - c.x, cz - c.z) < c.shape.r + 0.4 : this.inShapePad(c.shape, cx, cz, 0.4)) this.dynFree[this.grid.idx(ix, iz)] = 1;
        }
    }
  }

  inShapePad(s, x, z, pad) {
    const c = Math.cos(s.rot), sn = Math.sin(s.rot);
    const lx = (x - s.x) * c - (z - s.z) * sn, lz = (x - s.x) * sn + (z - s.z) * c;
    return Math.abs(lx) < s.hx + pad && Math.abs(lz) < s.hz + pad;
  }

  // Darken the sky with a red cast while a boss walks the field.
  setMood(boss, dt) {
    if (!this.mood) {
      this.mood = { k: 0, sky: new THREE.Color(0x9cc2de), skyBoss: new THREE.Color(0x5a3a48), hemi: new THREE.Color(0xcfe3ff), hemiBoss: new THREE.Color(0xd08a7a), sun: new THREE.Color(0xffe6c4), sunBoss: new THREE.Color(0xff9a6a) };
    }
    const m = this.mood;
    const target = boss ? 1 : 0;
    if (Math.abs(m.k - target) < 0.001) return;
    m.k += (target - m.k) * Math.min(1, dt * 0.8);
    this.scene.background.copy(m.sky).lerp(m.skyBoss, m.k);
    this.scene.fog.color.copy(this.scene.background);
    this.hemi.color.copy(m.hemi).lerp(m.hemiBoss, m.k);
    this.sun.color.copy(m.sun).lerp(m.sunBoss, m.k);
    this.hemi.intensity = 1.15 - 0.3 * m.k;
  }

  update(dt, now) {
    for (const a of this.animated) a.obj.rotation.z += a.spin * dt;
    this.updateFenceVisuals(now);
    this.updateConstructs(now);
    const hot = this.heart.hotUntil > now;
    this.wellGlow.material.color.setHex(hot ? 0xff5a5a : 0x6ff8ff);
    this.wellGlow.material.opacity = 0.35 + 0.15 * Math.sin(now * (hot ? 10 : 2));
    this.wellCrystal.rotation.y = now * 1.2;
    this.wellCrystal.position.y = 3.25 + Math.sin(now * 1.8) * 0.1;
    const hr = this.heart.hp / this.heart.maxHp;
    this.wellCrystal.scale.setScalar(0.5 + 0.5 * hr);
  }
}

// ---------------------------------------------------------------------------- construct meshes
const M = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, ...extra });
const G = (color) => new THREE.MeshBasicMaterial({ color });
const stoneMat = M(0x8d8a84), darkStone = M(0x5f5c58), woodMat = M(0x7a5230), darkWood = M(0x4e3420);

function mesh(geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function makeConstructMesh(kind, softTex) {
  const g = new THREE.Group();
  const glow = (color, r) => {
    const d = new THREE.Mesh(new THREE.CircleGeometry(r, 32), new THREE.MeshBasicMaterial({ map: softTex, color, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }));
    d.rotation.x = -Math.PI / 2;
    d.position.y = 0.04;
    return d;
  };
  const orb = (color, y, r = 0.22) => {
    const o = mesh(new THREE.IcosahedronGeometry(r, 1), G(color), 0, y, 0);
    o.castShadow = false;
    o.userData.y0 = y;
    g.userData.bob = o;
    return o;
  };
  switch (kind) {
    case 'flame_turret':
      g.add(mesh(new THREE.CylinderGeometry(0.55, 0.7, 0.5, 8), stoneMat, 0, 0.25));
      g.add(mesh(new THREE.CylinderGeometry(0.35, 0.45, 1.1, 8), darkStone, 0, 1.0));
      {
        const band = mesh(new THREE.TorusGeometry(0.42, 0.08, 6, 12), woodMat, 0, 1.55);
        band.rotation.x = Math.PI / 2;
        g.add(band);
      }
      g.add(orb(0xff7a20, 2.0, 0.26), glow(0xff7a20, 1.4));
      break;
    case 'ember_trap': {
      g.add(mesh(new THREE.CylinderGeometry(1.2, 1.3, 0.12, 14), darkStone, 0, 0.06));
      const rune = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.95, 6), new THREE.MeshBasicMaterial({ color: 0xff5a10, side: THREE.DoubleSide }));
      rune.rotation.x = -Math.PI / 2;
      rune.position.y = 0.13;
      g.add(rune);
      g.userData.spin = rune;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        g.add(mesh(new THREE.ConeGeometry(0.09, 0.4, 5), M(0x3a2a20), Math.cos(a) * 0.45, 0.3, Math.sin(a) * 0.45));
      }
      g.add(glow(0xff4a00, 1.7));
      break;
    }
    case 'storm_spire':
      g.add(mesh(new THREE.CylinderGeometry(0.6, 0.75, 0.4, 6), stoneMat, 0, 0.2));
      g.add(mesh(new THREE.CylinderGeometry(0.18, 0.4, 2.4, 6), darkStone, 0, 1.6));
      g.add(mesh(new THREE.BoxGeometry(0.9, 0.12, 0.12), woodMat, 0, 2.3));
      g.add(orb(0x9ad0ff, 3.15, 0.3), glow(0x6ab0ff, 1.5));
      break;
    case 'barricade':
      for (let i = -1; i <= 1; i++) {
        g.add(mesh(new THREE.BoxGeometry(1.0, 0.7, 0.8), stoneMat, i * 1.05, 0.35, 0));
        g.add(mesh(new THREE.BoxGeometry(0.95, 0.55, 0.7), i === 0 ? darkStone : stoneMat, i * 1.05 + 0.1, 0.98, 0.02));
      }
      g.add(mesh(new THREE.BoxGeometry(3.3, 0.14, 0.18), darkWood, 0, 1.15, 0.42));
      g.add(mesh(new THREE.BoxGeometry(3.3, 0.14, 0.18), darkWood, 0, 0.5, 0.42));
      break;
    case 'healing_shrine':
      g.add(mesh(new THREE.CylinderGeometry(0.7, 0.85, 0.35, 8), stoneMat, 0, 0.18));
      g.add(mesh(new THREE.CylinderGeometry(0.25, 0.35, 1.1, 8), M(0xd8d2c0), 0, 0.9));
      g.add(mesh(new THREE.CylinderGeometry(0.5, 0.3, 0.2, 8), M(0xd8d2c0), 0, 1.5));
      g.add(orb(0x8affb0, 2.0, 0.24), glow(0x6aff9a, 2.4));
      break;
    case 'mending_totem':
      g.add(mesh(new THREE.CylinderGeometry(0.5, 0.6, 0.3, 8), stoneMat, 0, 0.15));
      for (let i = 0; i < 3; i++) g.add(mesh(new THREE.CylinderGeometry(0.3 - i * 0.03, 0.32 - i * 0.03, 0.6, 8), i % 2 ? darkWood : woodMat, 0, 0.6 + i * 0.6));
      g.add(mesh(new THREE.BoxGeometry(0.9, 0.12, 0.2), woodMat, 0, 1.75));
      g.add(orb(0xffd060, 2.35, 0.2), glow(0xffc040, 2.0));
      break;
    case 'frost_obelisk': {
      g.add(mesh(new THREE.CylinderGeometry(0.6, 0.7, 0.3, 6), stoneMat, 0, 0.15));
      const ice = M(0x9fe4ff, { emissive: 0x1a4a6a });
      const c1 = mesh(new THREE.OctahedronGeometry(0.45, 0), ice, 0, 1.3, 0); c1.scale.set(0.7, 2.4, 0.7); g.add(c1);
      const c2 = mesh(new THREE.OctahedronGeometry(0.3, 0), ice, 0.35, 0.65, 0.1); c2.scale.set(0.6, 1.8, 0.6); c2.rotation.z = -0.4; g.add(c2);
      const c3 = mesh(new THREE.OctahedronGeometry(0.28, 0), ice, -0.3, 0.6, -0.15); c3.scale.set(0.6, 1.7, 0.6); c3.rotation.z = 0.45; g.add(c3);
      g.add(glow(0x8fe0ff, 3.2));
      break;
    }
    case 'mana_font':
      g.add(mesh(new THREE.CylinderGeometry(0.75, 0.55, 0.7, 10), stoneMat, 0, 0.35));
      g.add(mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.06, 16), G(0x4a9aff), 0, 0.68));
      g.add(orb(0x6ab8ff, 1.4, 0.18), glow(0x4a8aff, 2.2));
      break;
    case 'arcane_amplifier': {
      g.add(mesh(new THREE.CylinderGeometry(0.45, 0.55, 0.3, 8), stoneMat, 0, 0.15));
      g.add(mesh(new THREE.CylinderGeometry(0.06, 0.07, 2.8, 6), darkWood, 0, 1.5));
      const banner = mesh(new THREE.PlaneGeometry(0.8, 1.2), M(0x7a3ad0, { side: THREE.DoubleSide }), 0.42, 2.2, 0);
      g.add(banner);
      g.add(mesh(new THREE.BoxGeometry(0.95, 0.06, 0.06), darkWood, 0.4, 2.8, 0));
      g.add(orb(0xd08aff, 3.05, 0.16), glow(0xb070ff, 2.6));
      break;
    }
    default:
      g.add(mesh(new THREE.BoxGeometry(1, 1, 1), stoneMat, 0, 0.5));
  }
  return g;
}

export function constructRange(kind) {
  const d = CONSTRUCTS[kind];
  return d.range || d.radius || 1;
}
