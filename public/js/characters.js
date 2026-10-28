// Skinned characters from the kit with procedural (code-driven) animation: walking, casting, zombie shambles, deaths.
// The rig's bones all have identity rest rotations in a T-pose facing +Z, which makes posing straightforward.

import * as THREE from 'three';
import { makeCharacterModel } from './assets.js';

const BONES = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftArm', 'LeftForeArm', 'RightArm', 'RightForeArm', 'LeftUpLeg', 'LeftLeg', 'RightUpLeg', 'RightLeg', 'LeftFoot', 'RightFoot'];

const hatMats = {};
function hatMaterial(color) {
  if (!hatMats[color]) hatMats[color] = new THREE.MeshLambertMaterial({ color });
  return hatMats[color];
}
const staffMat = new THREE.MeshLambertMaterial({ color: 0x5a3a1e });
const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff2a10 });
const eyeMatBlue = new THREE.MeshBasicMaterial({ color: 0x80f0ff });
const eyeGeo = new THREE.SphereGeometry(0.022, 6, 4);
const hatGeo = new THREE.ConeGeometry(0.2, 0.5, 10, 1, true);
const hatTipGeo = new THREE.ConeGeometry(0.11, 0.24, 8);
const brimGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.025, 16);
const staffGeo = new THREE.CylinderGeometry(0.025, 0.032, 1.55, 6);
const orbGeo = new THREE.IcosahedronGeometry(0.075, 1);
const bookGeo = new THREE.BoxGeometry(0.22, 0.05, 0.3);
const crownGeo = new THREE.CylinderGeometry(0.17, 0.15, 0.12, 8, 1, true);

export const WIZARD_COLORS = {
  striker: { hat: 0x7a1a10, band: 0xf2c14e, orb: 0xff6a20 },
  healer: { hat: 0xf0ecdc, band: 0x48b06a, orb: 0x9dffb0 },
  augmenter: { hat: 0x3a1a64, band: 0x7ef0e0, orb: 0xc07cff },
};

export class Character {
  // kind: 'wizard' | 'zombie' | 'npc'; look: key in LOOKS; opts: { cls, ztype, scale, boss }
  constructor(kind, look, opts = {}) {
    this.kind = kind;
    this.opts = opts;
    this.root = new THREE.Group();
    this.body = makeCharacterModel(look);
    this.root.add(this.body);
    this.bones = {};
    for (const n of BONES) this.bones[n] = this.body.getObjectByName(n);
    this.seed = Math.random() * 100;
    this.phase = Math.random() * 6;
    this.walk = 0;
    this.speed = 0;
    this.castT = 9;
    this.atkT = 9;
    this.hitT = 9;
    this.deadT = -1;
    this.tint = new THREE.Color(0, 0, 0);
    this.scale = opts.scale || 1;
    this.root.scale.setScalar(this.scale);
    // per-character materials so we can flash/tint them
    this.mats = [];
    this.body.traverse((o) => {
      if (o.isMesh) {
        o.material = o.material.clone();
        this.mats.push(o.material);
      }
    });
    const pouch = this.body.getObjectByName('coin-pouch');
    if (pouch && kind !== 'npc') pouch.visible = false;

    if (kind === 'wizard') this.addWizardGear(opts.cls);
    if (kind === 'zombie') this.addZombieGear(opts);
    if (look === 'librarian') this.addBook();
    if (look === 'arcanist') this.addWizardGear('augmenter', 0x1f3c78, 0xf4d35e, 0x7ab8ff);
    if (opts.ghost) {
      for (const m of this.mats) { m.transparent = true; m.opacity = 0.55; m.emissive = new THREE.Color(0x2a5a9a); m.depthWrite = false; }
    }
    this.baseEmissive = this.mats.map((m) => m.emissive.clone());
  }

  addWizardGear(cls, hatColor, bandColor, orbColor) {
    const col = WIZARD_COLORS[cls] || WIZARD_COLORS.striker;
    const head = this.bones.Head;
    const hat = new THREE.Group();
    const brim = new THREE.Mesh(brimGeo, hatMaterial(hatColor ?? col.hat));
    const cone = new THREE.Mesh(hatGeo, hatMaterial(hatColor ?? col.hat));
    cone.position.y = 0.26;
    const tip = new THREE.Mesh(hatTipGeo, hatMaterial(hatColor ?? col.hat));
    tip.position.set(0, 0.55, -0.06);
    tip.rotation.x = -0.5;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.205, 0.205, 0.05, 12, 1, true), hatMaterial(bandColor ?? col.band));
    band.position.y = 0.04;
    hat.add(brim, cone, tip, band);
    hat.position.set(0, 0.2, -0.01);
    hat.rotation.x = -0.12;
    for (const m of [brim, cone, tip, band]) m.castShadow = true;
    head.add(hat);
    this.hat = hat;
    const hand = this.body.getObjectByName('attach-righthand') || this.bones.RightArm;
    const staff = new THREE.Group();
    const pole = new THREE.Mesh(staffGeo, staffMat);
    pole.castShadow = true;
    const orb = new THREE.Mesh(orbGeo, new THREE.MeshBasicMaterial({ color: orbColor ?? col.orb }));
    orb.position.y = 0.82;
    staff.add(pole, orb);
    // The lowered right arm (rotation.z = 1.15) turns the hand's +X axis nearly upward; tilt the staff the
    // remaining 0.42 rad so it stands vertical, gripped a third of the way up.
    staff.rotation.z = -Math.PI / 2 + 0.42;
    staff.position.set(0.3, 0.13, 0.02);
    hand.add(staff);
    this.staff = staff;
    this.orb = orb;
  }

  addBook() {
    const book = new THREE.Mesh(bookGeo, new THREE.MeshLambertMaterial({ color: 0x7a1f1f }));
    book.position.set(0.0, -0.04, 0.12);
    (this.body.getObjectByName('LeftHand') || this.bones.LeftForeArm).add(book);
    const hand = this.body.getObjectByName('attach-righthand');
    if (hand) hand.visible = false;
  }

  addZombieGear(opts) {
    const head = this.bones.Head;
    const mat = opts.ghost || opts.ztype === 'lich_king' ? eyeMatBlue : eyeMat;
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(eyeGeo, mat);
      e.position.set(s * 0.045, 0.1, 0.105);
      head.add(e);
    }
    if (opts.boss || opts.elite) {
      const crown = new THREE.Mesh(crownGeo, new THREE.MeshBasicMaterial({ color: opts.ztype === 'lich_king' ? 0x60f0ff : opts.ztype === 'plague_mother' ? 0xc0f040 : 0xffb030, side: THREE.DoubleSide }));
      crown.position.set(0, 0.24, 0);
      head.add(crown);
    }
  }

  setTint(r, g, b) { this.tint.setRGB(r, g, b); }
  playCast() { this.castT = 0; }
  playAttack() { this.atkT = 0; }
  playHit() { this.hitT = 0; }
  die() { if (this.deadT < 0) this.deadT = 0; }
  revive() { this.deadT = -1; this.body.rotation.set(0, 0, 0); this.body.position.set(0, 0, 0); this.root.visible = true; }

  // speed: current ground speed (m/s) used to drive the walk cycle
  update(dt, time) {
    const B = this.bones;
    const sp = this.speed / this.scale;
    this.walk += ((sp > 0.15 ? 1 : 0) - this.walk) * Math.min(1, dt * 8);
    const stride = this.kind === 'zombie' ? 2.6 : 2.4;
    this.phase += dt * Math.max(sp, 0.001) * stride;
    this.castT += dt;
    this.atkT += dt;
    this.hitT += dt;
    const w = this.walk;
    const s = Math.sin(this.phase);
    const c = Math.cos(this.phase);

    // flash on hit, plus status tint (frozen / hexed / burning)
    const flash = this.hitT < 0.12 ? 1 - this.hitT / 0.12 : 0;
    for (let i = 0; i < this.mats.length; i++) {
      const m = this.mats[i];
      const b = this.baseEmissive[i];
      m.emissive.setRGB(b.r + this.tint.r + flash * 0.6, b.g + this.tint.g + flash * 0.6, b.b + this.tint.b + flash * 0.6);
    }

    if (this.deadT >= 0) {
      this.deadT += dt;
      const k = Math.min(1, this.deadT / 0.55);
      const e = k * k * (3 - 2 * k);
      this.body.rotation.x = -e * Math.PI * 0.48;
      this.body.position.y = this.deadT > 1.4 ? -(this.deadT - 1.4) * 0.8 : 0;
      B.LeftArm.rotation.set(0, 0, -0.6);
      B.RightArm.rotation.set(0, 0, 0.6);
      return;
    }

    if (this.kind === 'zombie') this.animZombie(dt, time, w, s, c);
    else this.animWizard(dt, time, w, s, c);
  }

  animWizard(dt, time, w, s, c) {
    const B = this.bones;
    const idle = Math.sin(time * 1.8 + this.seed);
    B.LeftUpLeg.rotation.x = -s * 0.6 * w;
    B.RightUpLeg.rotation.x = s * 0.6 * w;
    B.LeftLeg.rotation.x = Math.max(0, -c) * 0.8 * w;
    B.RightLeg.rotation.x = Math.max(0, c) * 0.8 * w;
    B.Spine1.rotation.x = 0.02 * idle + 0.08 * w;
    B.Spine.rotation.y = s * 0.08 * w;
    this.body.position.y = Math.abs(c) * 0.04 * w;
    // arms hang down (rotate about Z), swing about X while walking
    B.LeftArm.rotation.set(s * 0.45 * w, 0, -1.22 + 0.03 * idle);
    B.LeftForeArm.rotation.set(0, -0.25, 0);
    let rx = -s * 0.25 * w, ry = 0.35, rz = 1.15;
    if (this.kind === 'npc') { rx = 0; ry = 0.2; rz = 1.2 - 0.04 * idle; }
    if (this.castT < 0.55) {
      // thrust the staff forward and up
      const k = this.castT < 0.15 ? this.castT / 0.15 : 1 - (this.castT - 0.15) / 0.4;
      const e = Math.max(0, Math.min(1, k));
      rx = rx * (1 - e) - 0.2 * e;
      ry = ry * (1 - e) + 1.25 * e;
      rz = rz * (1 - e) - 0.35 * e;
      B.LeftArm.rotation.y = -0.6 * e;
      B.Spine2.rotation.y = -0.25 * e;
    } else B.Spine2.rotation.y = 0;
    B.RightArm.rotation.set(rx, ry, rz);
    B.RightForeArm.rotation.set(0, 0.45, 0);
    B.Head.rotation.set(0.03 * idle, 0, 0);
    if (this.orb) this.orb.scale.setScalar(1 + 0.15 * Math.sin(time * 6 + this.seed) + (this.castT < 0.4 ? 0.8 * (1 - this.castT / 0.4) : 0));
  }

  animZombie(dt, time, w, s, c) {
    const B = this.bones;
    const t = time + this.seed;
    const ghost = this.opts.ghost;
    const runner = this.opts.ztype === 'runner';
    const limp = this.opts.ztype === 'runner' ? 1 : 0.65;
    B.LeftUpLeg.rotation.x = -s * 0.5 * w * (ghost ? 0.3 : 1);
    B.RightUpLeg.rotation.x = s * 0.5 * w * limp * (ghost ? 0.3 : 1);
    B.LeftLeg.rotation.x = Math.max(0, -c) * 0.7 * w;
    B.RightLeg.rotation.x = Math.max(0, c) * 0.5 * w;
    B.Spine.rotation.x = runner ? 0.4 : 0.22;
    B.Spine1.rotation.z = Math.sin(t * 0.9) * 0.08;
    B.Head.rotation.set(0.15 + Math.sin(t * 1.3) * 0.05, Math.sin(t * 0.7) * 0.2, 0.25 * Math.sin(t * 0.5));
    this.body.position.y = ghost ? 0.25 + Math.sin(t * 2) * 0.08 : Math.abs(c) * 0.035 * w;
    this.body.rotation.z = Math.sin(this.phase) * 0.05 * w;
    // arms reach forward
    let lz = -0.3, rz = 0.3, ly = -1.3, ry = 1.3, lx = Math.sin(t * 1.7) * 0.1, rx = Math.sin(t * 1.5 + 1) * 0.1;
    if (this.atkT < 0.5) {
      const k = this.atkT / 0.5;
      const up = k < 0.4 ? k / 0.4 : 1 - (k - 0.4) / 0.6;
      lx -= up * 0.9; rx -= up * 0.9;
      B.Spine.rotation.x += up * 0.25 - (k > 0.4 ? 0.2 * (1 - k) : 0);
    }
    B.LeftArm.rotation.set(lx, ly, lz);
    B.RightArm.rotation.set(rx, ry, rz);
    B.LeftForeArm.rotation.set(0, -0.15, 0);
    B.RightForeArm.rotation.set(0, 0.15, 0);
  }

  dispose() {
    for (const m of this.mats) m.dispose();
  }
}
