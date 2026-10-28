// Visual effects: GPU point particles, projectiles, rings, lightning, zones, meteors, telegraphs.

import * as THREE from 'three';

const MAX_P = 4000;

const SPELL_COLORS = {
  wand: 0xffe0a0, turret: 0xff7a20, firebolt: 0xff6a20, frost_shard: 0x8fdcff, holy_smite: 0xfff2a0, arcane_spark: 0xc07cff,
  arcane_barrage: 0xff60d0, acid: 0x9cff40, plague: 0xa8e040, shadow: 0x6a40ff, bomb: 0xff8a20,
};

export class FX {
  constructor(scene, softTex) {
    this.scene = scene;
    this.softTex = softTex;
    this.n = 0;
    this.pos = new Float32Array(MAX_P * 3);
    this.vel = new Float32Array(MAX_P * 3);
    this.col = new Float32Array(MAX_P * 3);
    this.size = new Float32Array(MAX_P);
    this.alpha = new Float32Array(MAX_P);
    this.life = new Float32Array(MAX_P);
    this.maxLife = new Float32Array(MAX_P);
    this.grav = new Float32Array(MAX_P);
    this.drag = new Float32Array(MAX_P);
    this.size0 = new Float32Array(MAX_P);
    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('pcolor', this.aCol);
    geo.setAttribute('psize', this.aSize);
    geo.setAttribute('palpha', this.aAlpha);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.pmat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 30 } },
      vertexShader: `attribute vec3 pcolor; attribute float psize; attribute float palpha; uniform float uScale;
        varying vec3 vC; varying float vA;
        void main(){ vC = pcolor; vA = palpha; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mv; gl_PointSize = psize * uScale; }`,
      fragmentShader: `varying vec3 vC; varying float vA;
        void main(){ vec2 c = gl_PointCoord - 0.5; float d = length(c); if (d > 0.5) discard; float a = smoothstep(0.5, 0.05, d) * vA; gl_FragColor = vec4(vC * a, a); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, this.pmat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    scene.add(this.points);
    this.geo = geo;

    this.projs = new Map();
    this.items = []; // generic timed effects { update(dt) -> bool alive, obj }
    this.zones = new Map();
    this.tmpC = new THREE.Color();
    this.ringGeo = new THREE.RingGeometry(0.86, 1, 56);
    this.discGeo = new THREE.CircleGeometry(1, 48);
    this.projGeo = new THREE.SphereGeometry(1, 10, 8);
    for (const g of [this.ringGeo, this.discGeo, this.projGeo]) g.userData.shared = true;
  }

  setScale(pxPerUnit) { this.pmat.uniforms.uScale.value = pxPerUnit; }

  // ------------------------------------------------------------------ particles
  emit(x, y, z, count, o = {}) {
    const c = this.tmpC.set(o.color ?? 0xffffff);
    const c2 = o.color2 !== undefined ? new THREE.Color(o.color2) : null;
    for (let k = 0; k < count; k++) {
      if (this.n >= MAX_P) return;
      const i = this.n++;
      const sp = (o.speed ?? 3) * (0.4 + Math.random() * 0.8);
      let vx, vy, vz;
      if (o.dir) {
        const a = o.dir + (Math.random() - 0.5) * (o.spread ?? 0.6);
        vx = Math.sin(a) * sp; vz = Math.cos(a) * sp; vy = (o.up ?? 0.5) * (Math.random() * 0.8 + 0.2);
      } else {
        const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
        vx = Math.sin(ph) * Math.cos(th) * sp;
        vz = Math.sin(ph) * Math.sin(th) * sp;
        vy = Math.abs(Math.cos(ph)) * sp * (o.up ?? 1);
      }
      const r = o.radius ? Math.sqrt(Math.random()) * o.radius : 0;
      const ra = Math.random() * Math.PI * 2;
      this.pos[i * 3] = x + Math.cos(ra) * r + (o.jitter ? (Math.random() - 0.5) * o.jitter : 0);
      this.pos[i * 3 + 1] = y + (o.yJitter ? Math.random() * o.yJitter : 0);
      this.pos[i * 3 + 2] = z + Math.sin(ra) * r + (o.jitter ? (Math.random() - 0.5) * o.jitter : 0);
      this.vel[i * 3] = vx + (o.vx || 0);
      this.vel[i * 3 + 1] = vy + (o.vy || 0);
      this.vel[i * 3 + 2] = vz + (o.vz || 0);
      const mix = c2 ? Math.random() : 0;
      this.col[i * 3] = c.r + (c2 ? (c2.r - c.r) * mix : 0);
      this.col[i * 3 + 1] = c.g + (c2 ? (c2.g - c.g) * mix : 0);
      this.col[i * 3 + 2] = c.b + (c2 ? (c2.b - c.b) * mix : 0);
      const life = (o.life ?? 0.7) * (0.6 + Math.random() * 0.6);
      this.life[i] = life;
      this.maxLife[i] = life;
      this.size0[i] = (o.size ?? 0.35) * (0.6 + Math.random() * 0.8);
      this.size[i] = this.size0[i];
      this.alpha[i] = 1;
      this.grav[i] = o.gravity ?? 0;
      this.drag[i] = o.drag ?? 1.5;
    }
  }

  updateParticles(dt) {
    let i = 0;
    while (i < this.n) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        const j = --this.n;
        if (i !== j) {
          for (let k = 0; k < 3; k++) { this.pos[i * 3 + k] = this.pos[j * 3 + k]; this.vel[i * 3 + k] = this.vel[j * 3 + k]; this.col[i * 3 + k] = this.col[j * 3 + k]; }
          this.size[i] = this.size[j]; this.alpha[i] = this.alpha[j]; this.life[i] = this.life[j]; this.maxLife[i] = this.maxLife[j];
          this.grav[i] = this.grav[j]; this.drag[i] = this.drag[j]; this.size0[i] = this.size0[j];
        }
        continue;
      }
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= d; this.vel[i * 3 + 2] *= d;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d - this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const t = this.life[i] / this.maxLife[i];
      this.alpha[i] = Math.min(1, t * 2.2);
      this.size[i] = this.size0[i] * (0.4 + 0.6 * t);
      i++;
    }
    this.geo.setDrawRange(0, this.n);
    this.aPos.needsUpdate = this.aCol.needsUpdate = this.aSize.needsUpdate = this.aAlpha.needsUpdate = true;
  }

  // ------------------------------------------------------------------ primitives
  ring(x, z, radius, color, dur = 0.5, o = {}) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: o.opacity ?? 0.75, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const m = new THREE.Mesh(o.fill ? this.discGeo : this.ringGeo, o.fill ? Object.assign(mat, { map: this.softTex }) : mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, (o.y ?? 0.06), z);
    this.scene.add(m);
    let t = 0;
    const r0 = o.from ?? radius * 0.2;
    this.items.push({ obj: m, update: (dt) => {
      t += dt;
      const k = Math.min(1, t / dur);
      const e = 1 - (1 - k) * (1 - k);
      m.scale.setScalar(o.grow === false ? radius : r0 + (radius - r0) * e);
      mat.opacity = (o.opacity ?? 0.75) * (1 - k);
      return t < dur;
    } });
    return m;
  }

  flash(x, y, z, color, size = 2, dur = 0.25) {
    const mat = new THREE.SpriteMaterial({ map: this.softTex, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const s = new THREE.Sprite(mat);
    s.position.set(x, y, z);
    s.scale.setScalar(size);
    this.scene.add(s);
    let t = 0;
    this.items.push({ obj: s, update: (dt) => { t += dt; mat.opacity = 1 - t / dur; s.scale.setScalar(size * (1 + t / dur)); return t < dur; } });
  }

  // ------------------------------------------------------------------ projectiles
  // getTarget(tid) -> {x,y,z} | null. tid >= 0 zombie, <= -2 player (-2 - pid), -1 none (fly to tx,tz).
  // visualOnly projectiles (thrown bombs) get no hit event from the server and vanish on arrival.
  projectile(id, kind, ox, oz, tid, tx, tz, speed, curve, getTarget, visualOnly = false) {
    const color = SPELL_COLORS[kind] ?? 0xffffff;
    const big = kind === 'firebolt' || kind === 'turret' || kind === 'holy_smite' || kind === 'shadow' || kind === 'plague';
    const sz = kind === 'wand' ? 0.13 : big ? 0.24 : 0.18;
    const mat = new THREE.MeshBasicMaterial({ color });
    const m = new THREE.Mesh(this.projGeo, mat);
    m.scale.setScalar(sz);
    const lob = kind === 'acid' || kind === 'plague' || kind === 'bomb';
    m.position.set(ox, 1.2, oz);
    this.scene.add(m);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.softTex, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.scale.setScalar(sz * 7);
    m.add(glow);
    glow.scale.divideScalar(sz);
    const dir = Math.atan2(tx - ox, tz - oz) + (curve || 0);
    const p = {
      m, kind, color, speed, tid, tx, tz, x: ox, z: oz, y: 1.2, t: 0, getTarget, lob,
      vx: Math.sin(dir) * speed, vz: Math.cos(dir) * speed, curve: curve || 0,
      straight: tid === -1 && !lob, total: Math.hypot(tx - ox, tz - oz), ox, oz, visualOnly,
    };
    if (p.straight) { const d = Math.hypot(tx - ox, tz - oz) || 1; p.vx = ((tx - ox) / d) * speed; p.vz = ((tz - oz) / d) * speed; }
    this.projs.set(id, p);
  }

  projectileHit(id, x, z) {
    const p = this.projs.get(id);
    const color = p ? p.color : 0xffffff;
    if (p) { this.scene.remove(p.m); disposeObj(p.m); this.projs.delete(id); }
    const kind = p?.kind;
    if (kind === 'acid' || kind === 'plague') {
      this.emit(x, 0.3, z, 18, { color: 0x9cff40, color2: 0x4a8a10, speed: 3, life: 0.6, size: 0.4, gravity: 6 });
      this.ring(x, z, 1.4, 0x9cff40, 0.5);
    } else {
      this.emit(x, 1.1, z, kind === 'wand' ? 6 : 12, { color, speed: 3.5, life: 0.4, size: 0.3 });
    }
  }

  updateProjectiles(dt) {
    for (const [id, p] of this.projs) {
      p.t += dt;
      if (p.t > 4) { this.scene.remove(p.m); disposeObj(p.m); this.projs.delete(id); continue; }
      let tx = p.tx, tz = p.tz;
      if (p.tid !== -1) {
        const t = p.getTarget(p.tid);
        if (t) { tx = p.tx = t.x; tz = p.tz = t.z; }
      }
      if (p.straight) {
        p.x += p.vx * dt; p.z += p.vz * dt;
      } else if (p.lob) {
        const dx = p.tx - p.x, dz = p.tz - p.z, dl = Math.hypot(dx, dz);
        const step = p.speed * dt;
        if (dl > step) { p.x += (dx / dl) * step; p.z += (dz / dl) * step; }
        const prog = 1 - Math.min(1, Math.hypot(p.tx - p.x, p.tz - p.z) / Math.max(0.1, p.total));
        p.y = 1.2 + Math.sin(prog * Math.PI) * Math.min(4, p.total * 0.35) - prog * 0.9;
        if (p.visualOnly && dl <= step) { this.scene.remove(p.m); disposeObj(p.m); this.projs.delete(id); continue; }
      } else {
        // steer toward the target (curved for missiles)
        const dx = tx - p.x, dz = tz - p.z, dl = Math.hypot(dx, dz) || 1;
        const turn = p.curve ? 7 : 30;
        p.vx += ((dx / dl) * p.speed - p.vx) * Math.min(1, dt * turn);
        p.vz += ((dz / dl) * p.speed - p.vz) * Math.min(1, dt * turn);
        const vl = Math.hypot(p.vx, p.vz) || 1;
        const step = Math.min(dl, p.speed * dt);
        p.x += (p.vx / vl) * step; p.z += (p.vz / vl) * step;
      }
      p.m.position.set(p.x, p.y, p.z);
      // trail
      const trail = p.kind === 'wand' ? 1 : 2;
      this.emit(p.x, p.y, p.z, trail, { color: p.color, speed: 0.4, life: p.kind === 'wand' ? 0.2 : 0.35, size: p.kind === 'wand' ? 0.18 : 0.3 });
      if (p.kind === 'frost_shard') this.emit(p.x, p.y, p.z, 1, { color: 0xffffff, speed: 0.8, life: 0.4, size: 0.15 });
    }
  }

  // ------------------------------------------------------------------ spell effects
  lightning(pts, color = 0xa8d8ff) {
    const n = pts.length / 2;
    if (n < 2) return;
    const geo = new THREE.BufferGeometry();
    const segs = 6;
    const arr = new Float32Array((n - 1) * segs * 2 * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const line = new THREE.LineSegments(geo, mat);
    line.frustumCulled = false;
    this.scene.add(line);
    const jag = () => {
      let k = 0;
      for (let i = 0; i < n - 1; i++) {
        const x0 = pts[i * 2], z0 = pts[i * 2 + 1], x1 = pts[i * 2 + 2], z1 = pts[i * 2 + 3];
        let px = x0, py = 1.2, pz = z0;
        for (let s = 1; s <= segs; s++) {
          const t = s / segs;
          const j = s === segs ? 0 : 0.45;
          const nx = x0 + (x1 - x0) * t + (Math.random() - 0.5) * j, ny = 1.2 + (Math.random() - 0.5) * j, nz = z0 + (z1 - z0) * t + (Math.random() - 0.5) * j;
          arr.set([px, py, pz, nx, ny, nz], k);
          k += 6;
          px = nx; py = ny; pz = nz;
        }
        this.emit(x1, 1.2, z1, 6, { color, speed: 4, life: 0.3, size: 0.25 });
      }
      geo.attributes.position.needsUpdate = true;
    };
    jag();
    let t = 0;
    this.items.push({ obj: line, update: (dt) => { t += dt; if (Math.random() < 0.5) jag(); mat.opacity = 1 - t / 0.3; return t < 0.3; } });
  }

  nova(x, z, r, color, kind) {
    this.ring(x, z, r, color, 0.55, { from: 0.3 });
    this.ring(x, z, r * 0.85, color, 0.4, { fill: true, opacity: 0.22, from: 0.3 });
    const n = Math.min(80, Math.round(r * 12));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      this.emit(x + Math.sin(a) * 0.5, 0.4, z + Math.cos(a) * 0.5, 1, { color, dir: a, spread: 0.1, speed: r * 2.6, up: 0.6, life: 0.45, size: 0.45, drag: 3 });
    }
    if (kind === 'ascendance' || kind === 'divine') this.emit(x, 0.5, z, 60, { color: 0xffe08a, speed: 3, up: 3, life: 1.2, size: 0.4, radius: 1.5, drag: 0.5 });
  }

  boom(x, z, r, kind) {
    const pal = {
      meteor: [0xff6a10, 0xffd040], bomb: [0xff7a20, 0xffe060], acid: [0x9cff40, 0x4a8a10], slam: [0xc8a070, 0x6a5030],
      nova: [0x80e0ff, 0xffffff], debris: [0x9a8a70, 0x5a4a3a],
    }[kind] || [0xffaa40, 0xffffff];
    this.emit(x, 0.5, z, Math.min(120, 30 + r * 18), { color: pal[0], color2: pal[1], speed: r * 2.2, up: 1.4, life: 0.8, size: 0.6, gravity: 4, drag: 2 });
    this.ring(x, z, r, pal[0], 0.5);
    this.ring(x, z, r * 0.9, pal[1], 0.35, { fill: true, opacity: 0.5 });
    this.flash(x, 1, z, pal[1], r * 1.4, 0.3);
    if (kind === 'meteor' || kind === 'bomb' || kind === 'slam') this.emit(x, 0.3, z, 20, { color: 0x403830, speed: 2, up: 1.5, life: 1.4, size: 0.9, drag: 1.5 });
  }

  meteor(x, z, r, delay) {
    const tele = this.ring(x, z, r, 0xff5a10, delay, { fill: true, opacity: 0.35, from: r, grow: false });
    tele.renderOrder = 1;
    const m = new THREE.Mesh(this.projGeo, new THREE.MeshBasicMaterial({ color: 0xffa040 }));
    m.scale.setScalar(0.7);
    this.scene.add(m);
    let t = 0;
    const sx = x - 7, sz = z - 7, sy = 22;
    this.items.push({ obj: m, update: (dt) => {
      t += dt;
      const k = Math.min(1, t / delay);
      m.position.set(sx + (x - sx) * k, sy * (1 - k), sz + (z - sz) * k);
      this.emit(m.position.x, m.position.y, m.position.z, 4, { color: 0xff6a10, color2: 0xffd040, speed: 1, life: 0.5, size: 0.7 });
      return t < delay;
    } });
  }

  telegraph(x, z, r, delay) {
    const mat = new THREE.MeshBasicMaterial({ map: this.softTex, color: 0xff2020, transparent: true, opacity: 0.55, depthWrite: false });
    const m = new THREE.Mesh(this.discGeo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.07, z);
    this.scene.add(m);
    const edge = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0.9, depthWrite: false }));
    edge.rotation.x = -Math.PI / 2;
    edge.position.set(x, 0.08, z);
    edge.scale.setScalar(r);
    this.scene.add(edge);
    let t = 0;
    this.items.push({ obj: m, extra: edge, update: (dt) => {
      t += dt;
      m.scale.setScalar(r * Math.min(1, t / delay));
      return t < delay + 0.05;
    } });
  }

  cone(x, z, dir, range, angle) {
    const half = (angle / 2) * (Math.PI / 180);
    let t = 0;
    this.items.push({ obj: null, update: (dt) => {
      t += dt;
      for (let i = 0; i < 14; i++) {
        const a = dir + (Math.random() - 0.5) * half * 2;
        this.emit(x + Math.sin(dir) * 0.6, 1.1, z + Math.cos(dir) * 0.6, 1, { color: 0xff5010, color2: 0xffd040, dir: a, spread: 0.05, speed: range * 1.9, up: 0.3, life: 0.55, size: 0.9, drag: 1.2 });
      }
      return t < 0.45;
    } });
  }

  zone(id, kind, x, z, r, dur) {
    const color = { blizzard: 0x6fb8ff, sanctuary: 0xffd060, gravity_well: 0x7a4dff, burn: 0xff5010, poison: 0x8cd030 }[kind] || 0xffffff;
    const g = new THREE.Group();
    const disc = new THREE.Mesh(this.discGeo, new THREE.MeshBasicMaterial({ map: this.softTex, color, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
    disc.rotation.x = -Math.PI / 2;
    disc.scale.setScalar(r);
    disc.position.y = 0.05;
    g.add(disc);
    const ring = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.scale.setScalar(r);
    ring.position.y = 0.06;
    g.add(ring);
    g.position.set(x, 0, z);
    this.scene.add(g);
    let t = 0;
    const z0 = { g, kind };
    this.zones.set(id, z0);
    this.items.push({ obj: g, update: (dt) => {
      t += dt;
      const fade = Math.min(1, t / 0.2) * Math.min(1, (dur - t) / 0.4);
      disc.material.opacity = 0.28 * fade;
      ring.material.opacity = 0.5 * fade;
      ring.rotation.z += dt * (kind === 'gravity_well' ? 3 : 0.5);
      const rate = Math.ceil(r * r * 0.5 * 60 * dt);
      for (let i = 0; i < rate; i++) {
        const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r;
        const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
        if (kind === 'blizzard') this.emit(px, 4 + Math.random() * 2, pz, 1, { color: 0xffffff, color2: 0xbfe8ff, speed: 0.3, vy: -7, vx: 1.5, life: 0.7, size: 0.3, drag: 0 });
        else if (kind === 'sanctuary') this.emit(px, 0.2, pz, 1, { color: 0xffe9a0, color2: 0x9dffb0, speed: 0.2, vy: 2, life: 1, size: 0.3, drag: 0 });
        else if (kind === 'gravity_well') { const ex = x + Math.cos(a) * r, ez = z + Math.sin(a) * r; this.emit(ex, 0.6, ez, 1, { color: 0x9a6dff, speed: 0.1, vx: (x - ex) * 1.8, vz: (z - ez) * 1.8, life: 0.5, size: 0.35, drag: 0 }); }
        else if (kind === 'burn') this.emit(px, 0.2, pz, 1, { color: 0xff5010, color2: 0xffc040, speed: 0.3, vy: 2.2, life: 0.6, size: 0.4, drag: 0 });
        else if (kind === 'poison') this.emit(px, 0.2, pz, 1, { color: 0x8cd030, color2: 0x4a7010, speed: 0.2, vy: 1.2, life: 0.9, size: 0.6, drag: 0 });
      }
      if (t >= dur) this.zones.delete(id);
      return t < dur;
    } });
  }

  buffBurst(x, z, color) {
    this.emit(x, 0.3, z, 24, { color, speed: 1.2, vy: 2.5, life: 0.9, size: 0.35, radius: 0.8, drag: 0.5 });
    this.ring(x, z, 1.4, color, 0.5);
  }

  healBurst(x, z) {
    this.emit(x, 0.5, z, 26, { color: 0x9dffb0, color2: 0xffffff, speed: 1, vy: 3, life: 0.9, size: 0.35, radius: 0.7, drag: 0.6 });
  }

  levelUp(x, z) {
    this.ring(x, z, 2.5, 0xffd36b, 0.8);
    this.emit(x, 0.3, z, 70, { color: 0xffd36b, color2: 0xffffff, speed: 1.5, vy: 5, life: 1.3, size: 0.4, radius: 1, drag: 0.6 });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 12, 16, 1, true), new THREE.MeshBasicMaterial({ color: 0xffd36b, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    beam.position.set(x, 6, z);
    this.scene.add(beam);
    let t = 0;
    this.items.push({ obj: beam, update: (dt) => { t += dt; beam.material.opacity = 0.4 * (1 - t); beam.scale.x = beam.scale.z = 1 - t * 0.6; return t < 1; } });
  }

  update(dt) {
    this.updateProjectiles(dt);
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (!it.update(dt)) {
        if (it.obj) { this.scene.remove(it.obj); disposeObj(it.obj); }
        if (it.extra) { this.scene.remove(it.extra); disposeObj(it.extra); }
        this.items.splice(i, 1);
      }
    }
    this.updateParticles(dt);
  }
}

function disposeObj(o) {
  o.traverse?.((c) => {
    if (c.material && c.material.dispose) c.material.dispose();
    // sprites share one internal geometry; ours are flagged as shared too
    if (c.geometry && !c.isSprite && !c.geometry.userData.shared) c.geometry.dispose();
  });
}
