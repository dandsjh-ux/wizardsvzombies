// Client entry: loads the kit, builds the world, talks to the server and runs the render loop.

import * as THREE from 'three';
import { loadKit } from './assets.js';
import { World, makeConstructMesh } from './world.js';
import { Character } from './characters.js';
import { FX } from './fx.js';
import { UI } from './ui.js';
import { Net } from './net.js';
import { Input } from './input.js';
import { unlockAudio, sfx } from './audio.js';
import {
  CLASSES, SPELLS, CLASS_SPELLS, ZOMBIES, ZOMBIE_TYPES, BASIC_ATTACK, ITEMS, CONSTRUCTS, NPC_RANGE, WELL_RANGE,
  BUILD_RANGE, rankVal, NPCS, MAX_CONSTRUCTS_PER_PLAYER,
} from '/shared/data.js';
import { HEART, PLAYER_BOUND, PLAYER_SPAWN, insideVillage } from '/shared/layout.js';
import { placementError } from '/shared/placement.js';

const INTERP = 0.13;
const PLAYER_R = 0.4;
const ZLOOK = {
  walker: (id) => (id % 2 ? 'zombie' : 'zombie2'), runner: () => 'zombie2', brute: () => 'brute', spitter: () => 'spitter',
  bloater: () => 'bloater', wraith: () => 'wraith', gravecrusher: () => 'gravecrusher', plague_mother: () => 'plague_mother', lich_king: () => 'lich_king',
};
const SPELL_SOUND = {
  firebolt: 'fire', meteor: 'fire', flame_nova: 'fire', dragons_breath: 'fire', frost_shard: 'frost', blizzard: 'frost', chain_lightning: 'zap',
  arcane_barrage: 'arcane', arcane_spark: 'arcane', hex: 'arcane', gravity_well: 'arcane', spectral_blades: 'arcane', holy_smite: 'holy',
  healing_light: 'heal', sanctuary: 'heal', purifying_nova: 'holy', divine_shield: 'buff', mend: 'mend', fortify: 'mend', divine_intervention: 'level',
  empower: 'buff', haste: 'buff', mana_surge: 'buff', ascendance: 'level', wand: 'wand', build: 'build',
};
const BOSS_AURA = { gravecrusher: 0xff9a30, plague_mother: 0x9cff40, lich_king: 0x8a5aff };
const BUFF_COLORS = { empower: 0xff9d3d, haste: 0x7dffe9, ascend: 0xffd36b, shield: 0xffe9a0, blades: 0xd0a0ff, mana: 0x5aa8ff };
const lerpAngle = (a, b, t) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return a + d * t; };
const d2 = (ax, az, bx, bz) => (ax - bx) ** 2 + (az - bz) ** 2;

class Game {
  constructor() {
    this.players = new Map();
    this.zombies = new Map();
    this.roster = new Map();
    this.me = null;
    this.myId = null;
    this.phase = 'lobby';
    this.wave = 0;
    this.timeLeft = 0;
    this.zl = 0;
    this.nextDirs = [];
    this.heart = { hp: 2000, maxHp: 2000, hit: 0 };
    this.boss = null;
    this.serverOffset = null;
    this.localPos = { x: PLAYER_SPAWN.x, z: PLAYER_SPAWN.z };
    this.localFacing = Math.PI;
    this.tpSeq = 0;
    this.path = null;
    this.attackTarget = null;
    this.allyTarget = null;
    this.auto = true;
    this.selectedSlot = 0;
    this.placing = null;
    this.pending = null;
    this.lastSend = 0;
    this.localBasicReady = 0;
    this.castFaceUntil = 0;
    this.waveStartLocal = 0;
    this.fpsAcc = [];
  }

  async start() {
    const params = new URLSearchParams(location.search);
    const coarse = matchMedia('(pointer: coarse)').matches;
    this.quality = params.get('q') || (coarse ? 'medium' : 'high');
    await loadKit((p) => { document.querySelector('#screen-loading .progress div').style.width = Math.round(p * 90) + '%'; });

    const renderer = new THREE.WebGLRenderer({ antialias: this.quality !== 'low', powerPreference: 'high-performance' });
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, this.quality === 'high' ? 2 : 1.5);
    renderer.setPixelRatio(this.pixelRatio);
    renderer.shadowMap.enabled = this.quality !== 'low';
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    document.getElementById('game').appendChild(renderer.domElement);
    this.renderer = renderer;

    this.world = new World(this.quality);
    this.fx = new FX(this.world.scene, this.world.softTex);
    this.ui = new UI(this);
    this.makeNpcs();
    this.makeMarkers();
    this.resize();
    window.addEventListener('resize', () => this.resize());

    this.input = new Input(renderer.domElement, {
      unlock: () => unlockAudio(),
      tap: (x, y, type) => this.onTap(x, y, type),
      rightClick: (x, y) => this.onRightClick(x, y),
      holdEnd: () => {},
      placing: () => !!this.placing,
      zoom: (f) => this.world.zoom(f),
      key: (code, key, e) => this.onKey(code, key, e),
    });
    this.net = new Net((m) => this.onMessage(m), (s) => this.onNetStatus(s));
    this.ui.hideLoading();
    this.clock = performance.now();
    renderer.setAnimationLoop(() => this.frame());
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.world.resize(w, h);
  }

  serverNow() { return this.serverOffset === null ? 0 : performance.now() / 1000 + this.serverOffset; }

  // ------------------------------------------------------------------ setup helpers
  makeNpcs() {
    this.npcChars = {};
    for (const [key, n] of Object.entries(this.world.layout.npcs)) {
      const ch = new Character('npc', NPCS[key].look);
      ch.root.position.set(n.x, 0, n.z);
      ch.root.rotation.y = n.r;
      this.world.scene.add(ch.root);
      this.npcChars[key] = ch;
    }
  }

  makeMarkers() {
    const ring = (color) => {
      const m = new THREE.Mesh(new THREE.RingGeometry(0.75, 0.95, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false }));
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.05;
      m.visible = false;
      this.world.scene.add(m);
      return m;
    };
    this.targetRing = ring(0xff3a2a);
    this.allyRing = ring(0x9dffb0);
    this.buildRange = new THREE.Mesh(new THREE.RingGeometry(BUILD_RANGE - 0.08, BUILD_RANGE, 72), new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.35, depthWrite: false }));
    this.buildRange.rotation.x = -Math.PI / 2;
    this.buildRange.position.y = 0.05;
    this.buildRange.visible = false;
    this.world.scene.add(this.buildRange);
  }

  // ------------------------------------------------------------------ networking
  onNetStatus(s) {
    if (s === 'open') { this.ui.setConn(true); this.ui.updateJoinButton(); }
    else if (s === 'replaced') { this.ui.setConn(false); document.querySelector('#conn span').textContent = 'This wizard is now playing in another window. Reload to take over.'; }
    else if (s === 'closed') this.ui.setConn(false);
  }

  join(name, cls) {
    unlockAudio();
    this.net.send({ t: 'join', name, cls });
  }

  onMessage(m) {
    switch (m.t) {
      case 'welcome': return this.onWelcome(m);
      case 'roster': return this.onRoster(m.players, m.slots);
      case 's': return this.onSnap(m);
      case 'me': {
        const prevGold = this.me?.g;
        this.me = m;
        if (prevGold !== undefined && m.g > prevGold + 4) sfx('coin', 0.3);
        return;
      }
      case 'tp':
        this.localPos.x = m.x; this.localPos.z = m.z; this.tpSeq = m.q; this.path = null;
        return;
      case 'msg':
        this.ui.announce(m.text, m.kind);
        if (m.kind === 'bad' && /breached/.test(m.text)) sfx('fbreak', 1);
        return;
      case 'toast': this.ui.toast(m.text); sfx('error', 0.3); return;
      case 'chat': this.ui.chat(m.from, m.cls, m.text); return;
      case 'con+': this.world.addConstruct(m.c); if (m.c.owner === this.myId) sfx('build'); return;
      case 'con-': {
        const c = this.world.removeConstruct(m.id);
        if (c && c.owner === this.myId) this.ui.toast(`Your ${CONSTRUCTS[c.kind].name} was destroyed!`);
        return;
      }
      case 'over':
        this.victory = m.victory;
        this.ui.openPanel('over', m);
        sfx(m.victory ? 'level' : 'die');
        return;
      case 'reset':
        this.resetLocal();
        return;
      case 'full':
        this.ui.toast('The village already has 3 wizards. Waiting for a free spot…');
        this.ui.joinInfo = { ...(this.ui.joinInfo || {}), slots: 0 };
        this.ui.updateJoinButton();
        return;
      case 'error': this.ui.toast(m.text); return;
      case 'kicked': this.ui.toast(m.reason); return;
      case 'quizQ': this.ui.showQuizQuestion(m); return;
      case 'quizR': this.ui.showQuizResult(m); return;
      case 'bought': sfx('coin'); return;
      case 'learned':
        sfx('level');
        this.ui.toast(`${SPELLS[m.id].name} is now rank ${m.rank}!`);
        return;
      default:
    }
  }

  onWelcome(m) {
    this.serverOffset = m.tm - performance.now() / 1000;
    this.onRoster(m.roster, m.slots);
    for (const [id, hp, maxHp, broken] of m.fence) this.world.setFence(id, hp, maxHp, broken, 0, 0, 0);
    for (const id of [...this.world.constructs.keys()]) if (!m.cons.find((c) => c.id === id)) this.world.removeConstruct(id);
    for (const c of m.cons) this.world.addConstruct(c);
    this.heart.hp = m.heart[0]; this.heart.maxHp = m.heart[1];
    this.phase = m.phase;
    this.wave = m.wave;
    if (m.you) {
      const wasJoined = this.myId !== null;
      this.myId = m.you;
      const r = this.roster.get(m.you);
      this.cls = r.cls;
      this.name = r.name;
      if (m.tp) { this.localPos.x = m.tp.x; this.localPos.z = m.tp.z; this.tpSeq = m.tp.q; }
      this.path = null;
      this.ui.hideJoin();
      this.ui.buildBars();
      if (!wasJoined) {
        this.ui.announce(`Welcome, ${r.name}! Defend the Well of Renewal.`, 'good');
        try { if (!localStorage.getItem('wvz-helped')) { localStorage.setItem('wvz-helped', '1'); this.ui.openPanel('help'); } } catch { /* ignore */ }
      }
    } else {
      this.myId = null;
      this.ui.showJoin({ phase: m.phase, wave: m.wave, slots: m.slots, roster: m.roster });
    }
  }

  onRoster(list, slots) {
    this.roster = new Map(list.map((r) => [r.id, r]));
    for (const r of list) {
      const p = this.players.get(r.id);
      if (p) { p.name = r.name; p.on = r.on; p.level = r.lv; }
    }
    if (this.myId === null && this.ui.joinInfo) this.ui.showJoin({ ...this.ui.joinInfo, roster: list, slots });
    else if (this.myId === null) this.ui.joinInfo = { phase: this.phase, wave: this.wave, roster: list, slots };
  }

  resetLocal() {
    for (const p of this.players.values()) this.removePlayer(p);
    for (const z of this.zombies.values()) { this.world.scene.remove(z.char.root); z.char.dispose(); }
    this.zombies.clear();
    for (const id of [...this.world.constructs.keys()]) this.world.removeConstruct(id);
    this.myId = null;
    this.me = null;
    this.attackTarget = this.allyTarget = null;
    this.placeCancel();
    this.ui.closePanel();
  }

  ensurePlayer(id) {
    let p = this.players.get(id);
    if (p) return p;
    const r = this.roster.get(id) || { name: 'Wizard', cls: 'striker', on: true };
    const char = new Character('wizard', r.cls, { cls: r.cls });
    this.world.scene.add(char.root);
    p = { id, name: r.name, cls: r.cls, on: r.on, buf: [], char, x: 0, z: 0, f: 0, hp: 1, maxHp: 1, mana: 0, maxMana: 1, level: 1, dead: false, bits: 0, speed: 0, aura: this.makeAura() };
    char.root.add(p.aura.group);
    this.players.set(id, p);
    return p;
  }

  removePlayer(p) {
    this.world.scene.remove(p.char.root);
    p.char.dispose();
    this.players.delete(p.id);
  }

  makeAura() {
    const group = new THREE.Group();
    const mk = (color, r0, r1) => {
      const m = new THREE.Mesh(new THREE.RingGeometry(r0, r1, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.06;
      m.visible = false;
      group.add(m);
      return m;
    };
    const shield = new THREE.Mesh(new THREE.SphereGeometry(1.1, 18, 12), new THREE.MeshBasicMaterial({ color: 0xffe9a0, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false }));
    shield.position.y = 1;
    shield.visible = false;
    group.add(shield);
    const blades = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const b = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.7, 4), new THREE.MeshBasicMaterial({ color: 0xd8b0ff }));
      const a = (i / 3) * Math.PI * 2;
      b.position.set(Math.cos(a) * 1.6, 1, Math.sin(a) * 1.6);
      b.rotation.z = Math.PI / 2;
      b.rotation.y = -a;
      blades.add(b);
    }
    blades.visible = false;
    group.add(blades);
    return { group, empower: mk(0xff9d3d, 0.7, 0.85), haste: mk(0x7dffe9, 0.9, 1.0), ascend: mk(0xffd36b, 1.05, 1.25), shield, blades };
  }

  onSnap(s) {
    const lt = performance.now() / 1000;
    const off = s.tm - lt;
    if (this.serverOffset === null || Math.abs(off - this.serverOffset) > 0.6) this.serverOffset = off;
    else this.serverOffset += (off - this.serverOffset) * 0.05;
    if (s.ph === 'wave' && this.phase !== 'wave') this.waveStartLocal = lt;
    if (s.ph !== 'over' && this.phase === 'over' && this.ui.panelKind === 'over') this.ui.closePanel();
    this.phase = s.ph;
    this.wave = s.w;
    this.timeLeft = s.tl;
    this.zl = s.zl;
    this.nextDirs = s.nd || [];
    this.boss = s.b || null;
    if (s.h) { this.heart.hp = s.h[0]; this.heart.maxHp = s.h[1]; this.heart.hit = s.h[2]; this.world.heart.hp = s.h[0]; this.world.heart.maxHp = s.h[1]; this.world.heart.hotUntil = s.h[2] ? lt + 1 : 0; }

    const seenP = new Set();
    for (const [id, x, z, f, hp, maxHp, mana, maxMana, level, flags, bits] of s.p) {
      seenP.add(id);
      const p = this.ensurePlayer(id);
      p.buf.push([s.tm, x, z, f]);
      if (p.buf.length > 12) p.buf.shift();
      const dead = !!(flags & 1);
      if (dead && !p.dead) p.char.die();
      if (!dead && p.dead) p.char.revive();
      p.dead = dead;
      p.on = !(flags & 2);
      p.hp = hp; p.maxHp = maxHp; p.mana = mana; p.maxMana = maxMana; p.level = level; p.bits = bits;
      p.char.root.visible = p.on;
    }
    for (const p of [...this.players.values()]) if (!seenP.has(p.id)) this.removePlayer(p);

    const seenZ = new Set();
    for (const [id, ti, x, z, f, hpPct, state, flags] of s.z) {
      seenZ.add(id);
      let zb = this.zombies.get(id);
      if (!zb) {
        const type = ZOMBIE_TYPES[ti];
        const def = ZOMBIES[type];
        const elite = !!(flags & 16);
        const char = new Character('zombie', ZLOOK[type](id), { ztype: type, ghost: def.ghost, boss: def.boss, elite, scale: def.scale * (elite ? 1.2 : 1) });
        if (type === 'bloater') { char.body.scale.set(1.3, 1, 1.35); }
        char.root.position.set(x, 0, z);
        char.root.rotation.y = f;
        this.world.scene.add(char.root);
        zb = { id, type, char, buf: [], x, z, f, hpPct, flags, state, speed: 0, dying: false };
        this.zombies.set(id, zb);
        if (Math.random() < 0.15) sfx('groan', 1.5);
      }
      zb.buf.push([s.tm, x, z, f]);
      if (zb.buf.length > 12) zb.buf.shift();
      zb.hpPct = hpPct; zb.state = state; zb.flags = flags;
      const ch = zb.char;
      if (flags & 8) ch.setTint(0.35, 0.12, 0); else if (flags & 2) ch.setTint(0.18, 0, 0.3); else if (flags & 1) ch.setTint(0, 0.12, 0.3); else ch.setTint(0, 0, 0);
    }
    for (const zb of [...this.zombies.values()]) if (!seenZ.has(zb.id) && !zb.dying) this.dropZombie(zb, false);

    if (s.f) for (const [id, hp, maxHp, broken, hot, fort] of s.f) this.world.setFence(id, hp, maxHp, broken, hot, fort, lt);
    if (s.fa) for (const id of s.fa) this.world.markHot(id, lt);
    if (s.c) for (const [id, hp, maxHp, hot] of s.c) { const c = this.world.constructs.get(id); if (c) { c.hp = hp; c.maxHp = maxHp; if (hot) c.hotUntil = lt + 1; } }
    if (s.e) for (const e of s.e) this.onEvent(e, lt);
  }

  dropZombie(zb, animate) {
    if (animate) {
      zb.dying = true;
      zb.char.die();
      setTimeout(() => { this.world.scene.remove(zb.char.root); zb.char.dispose(); this.zombies.delete(zb.id); }, 2300);
    } else {
      this.world.scene.remove(zb.char.root);
      zb.char.dispose();
      this.zombies.delete(zb.id);
    }
    if (this.attackTarget === zb.id) this.attackTarget = null;
  }

  posOf(pid) {
    if (pid === this.myId) return this.localPos;
    return this.players.get(pid);
  }

  onEvent(e, lt) {
    const fx = this.fx;
    const near = (x, z, r = 30) => d2(x, z, this.localPos.x, this.localPos.z) < r * r;
    switch (e[0]) {
      case 'cast': {
        const [, pid, spell, x, z] = e;
        const p = this.players.get(pid);
        if (p && pid !== this.myId) { p.char.playCast(); p.castFace = Math.atan2(x - p.x, z - p.z); p.castFaceUntil = lt + 0.4; }
        if (spell === 'build') { fx.ring(x, z, 1.5, 0xffe08a, 0.7); fx.emit(x, 0.3, z, 30, { color: 0xffe08a, speed: 2, vy: 3, life: 0.8, size: 0.35, radius: 1 }); }
        const snd = SPELL_SOUND[spell];
        if (snd && near(x, z) && !['wand', 'build'].includes(spell)) sfx(snd, 0.08);
        if (spell === 'wand' && pid === this.myId) sfx('wand', 0.1);
        break;
      }
      case 'proj': {
        const [, id, kind, ox, oz, tid, tx, tz, speed, curve] = e;
        fx.projectile(id, kind, ox, oz, tid, tx, tz, speed, curve, (t) => {
          if (t <= -2) { const p = this.posOf(-2 - t); return p ? { x: p.x, z: p.z } : null; }
          const zb = this.zombies.get(t);
          return zb && !zb.dying ? zb : null;
        });
        if ((kind === 'acid' || kind === 'shadow' || kind === 'plague') && near(ox, oz, 20)) sfx('arcane', 0.2);
        break;
      }
      case 'ph': fx.projectileHit(e[1], e[2], e[3]); if (near(e[2], e[3], 18)) sfx('hit', 0.06); break;
      case 'd': {
        const [, x, z, amt, kind] = e;
        if (near(x, z, 40)) this.ui.number(x, z, amt, kind);
        if (kind === 0) { for (const zb of this.zombies.values()) if (!zb.dying && Math.abs(zb.x - x) < 0.6 && Math.abs(zb.z - z) < 0.6) { zb.char.playHit(); break; } }
        if (kind === 1 && d2(x, z, this.localPos.x, this.localPos.z) < 0.5) { this.hurtFlash = 1; sfx('hurt', 0.25); }
        break;
      }
      case 'zdie': {
        const zb = this.zombies.get(e[1]);
        if (zb && !zb.dying) this.dropZombie(zb, true);
        fx.emit(e[2], 0.8, e[3], 16, { color: 0x4a6a2a, color2: 0x8a2a1a, speed: 3, life: 0.6, size: 0.35, gravity: 8 });
        if (near(e[2], e[3], 25)) sfx('zdie', 0.12);
        break;
      }
      case 'za': { const zb = this.zombies.get(e[1]); if (zb) zb.char.playAttack(); break; }
      case 'chain': fx.lightning(e[1]); if (near(e[1][0], e[1][1])) sfx('zap', 0.1); break;
      case 'nova': {
        const [, x, z, r, spell] = e;
        fx.nova(x, z, r, SPELLS[spell]?.color ?? 0xffffff, spell === 'ascendance' ? 'ascendance' : '');
        break;
      }
      case 'meteor': fx.meteor(e[1], e[2], e[3], e[4]); break;
      case 'boom': {
        const [, x, z, r, kind] = e;
        fx.boom(x, z, r, kind);
        if (near(x, z, 26)) { this.world.shake = Math.min(1.2, this.world.shake + r * 0.15); sfx('boom', 0.1); }
        break;
      }
      case 'zone': fx.zone(e[1], e[2], e[3], e[4], e[5], e[6]); break;
      case 'cone': {
        const p = this.posOf(e[1]);
        if (p) fx.cone(p.x, p.z, e[2], e[3], e[4]);
        break;
      }
      case 'healfx': { const p = this.posOf(e[1]); if (p) fx.healBurst(p.x, p.z); break; }
      case 'mendfx': fx.ring(e[1], e[2], e[3], 0xffe08a, 0.6); fx.emit(e[1], 0.6, e[2], 20, { color: 0xffe08a, color2: 0xffffff, speed: 2, vy: 2, life: 0.7, size: 0.3, radius: e[3] * 0.8 }); break;
      case 'fortfx': fx.ring(e[1], e[2], e[3], 0xffc040, 0.8); fx.ring(e[1], e[2], e[3], 0xffc040, 0.8, { fill: true, opacity: 0.3 }); break;
      case 'buff': {
        const p = this.posOf(e[1]);
        if (p) fx.buffBurst(p.x, p.z, BUFF_COLORS[e[2]] ?? 0xffffff);
        if (e[1] === this.myId && e[2] !== 'mana') sfx('buff', 0.2);
        break;
      }
      case 'intervene':
        for (const p of this.players.values()) { const q = this.posOf(p.id); if (q) fx.levelUp(q.x, q.z); }
        sfx('level');
        break;
      case 'well': {
        fx.nova(HEART.x, HEART.z, 4, 0x7ff0ff);
        const p = this.posOf(e[1]);
        if (p) fx.healBurst(p.x, p.z);
        if (e[1] === this.myId) { sfx('well'); this.ui.toast('The Well of Renewal restores you!'); }
        break;
      }
      case 'lvl': {
        const p = this.posOf(e[1]);
        if (p) fx.levelUp(p.x, p.z);
        if (e[1] === this.myId) { sfx('level'); this.ui.announce(`Level up! You are now level ${e[2]}. Health and mana increased.`, 'good'); }
        break;
      }
      case 'pdie': if (e[1] === this.myId) { sfx('die'); this.path = null; } break;
      case 'revive': { const p = this.players.get(e[1]); if (p) p.char.revive(); break; }
      case 'phoenix': { const p = this.posOf(e[1]); if (p) { fx.levelUp(p.x, p.z); fx.emit(p.x, 1, p.z, 50, { color: 0xff7a20, color2: 0xffe060, speed: 4, life: 1, size: 0.5 }); } break; }
      case 'fbreak': { const f = this.world.fence[e[1]]; if (f) { fx.boom(f.x, f.z, 1.5, 'debris'); if (near(f.x, f.z, 20)) this.world.shake += 0.4; } break; }
      case 'tele': fx.telegraph(e[1], e[2], e[3], e[4]); break;
      case 'summon': fx.ring(e[1], e[2], 3, 0x9a4dff, 0.8); fx.emit(e[1], 0.4, e[2], 40, { color: 0x6a3aff, color2: 0x20ff80, speed: 3, life: 0.8, size: 0.5 }); break;
      case 'bomb': {
        const p = this.posOf(e[1]);
        if (p) fx.projectile(-1e9 - Math.random() * 1e6, 'acid', p.x, p.z, -1, e[2], e[3], 18, 0, () => null);
        break;
      }
      case 'wave': sfx(e[1] % 10 === 0 ? 'bosshorn' : 'horn', 1); break;
      case 'clear': sfx('clear'); break;
      default:
    }
  }

  // ------------------------------------------------------------------ interaction helpers
  isNear(key, extra = 1.5) {
    const p = this.localPos;
    if (key === 'well') return d2(p.x, p.z, HEART.x, HEART.z) < (WELL_RANGE + extra) ** 2;
    const n = this.world.layout.npcs[key];
    return n && d2(p.x, p.z, n.x, n.z) < (NPC_RANGE + extra) ** 2;
  }

  computeNearInteract() {
    for (const key of ['arcanist', 'trader', 'librarian']) if (this.isNear(key, 0)) return key;
    if (this.isNear('well', 0.6)) return 'well';
    return null;
  }

  interact(key = this.nearInteract) {
    if (!key) return;
    if (!this.isNear(key, 0.8)) { this.walkTo(key); return; }
    this.pending = null;
    this.path = null;
    if (key === 'well') { this.net.send({ t: 'well' }); return; }
    const panel = key === 'librarian' ? 'quiz' : key;
    this.ui.openPanel(panel);
    sfx('click');
  }

  walkTo(key) {
    const t = key === 'well' ? { x: HEART.x + 2.2, z: HEART.z + 2.2 } : this.world.layout.npcs[key];
    const n = key === 'well' ? null : this.world.layout.npcs[key];
    // stand in front of the villager
    const tx = n ? n.x + Math.sin(n.r) * 1.6 : t.x, tz = n ? n.z + Math.cos(n.r) * 1.6 : t.z;
    this.path = this.world.path(this.localPos.x, this.localPos.z, tx, tz);
    this.pending = key;
    this.attackTarget = null;
  }

  selectAlly(id) {
    this.allyTarget = this.allyTarget === id ? null : id;
    sfx('click');
  }

  toggleAuto() { this.auto = !this.auto; this.ui.toast(this.auto ? 'Auto-attack ON' : 'Auto-attack OFF'); }

  // ------------------------------------------------------------------ picking
  groundPoint(sx, sy) {
    const ndc = new THREE.Vector2((sx / window.innerWidth) * 2 - 1, -(sy / window.innerHeight) * 2 + 1);
    const rc = this.raycaster || (this.raycaster = new THREE.Raycaster());
    rc.setFromCamera(ndc, this.world.camera);
    const t = -rc.ray.origin.y / rc.ray.direction.y;
    return { x: rc.ray.origin.x + rc.ray.direction.x * t, z: rc.ray.origin.z + rc.ray.direction.z * t };
  }

  pick(sx, sy, touch) {
    const R = touch ? 46 : 32;
    let best = null, bd = R * R;
    const test = (kind, id, x, y, z, rad = R) => {
      const [px, py] = this.ui.project(x, y, z);
      const dd = (px - sx) ** 2 + (py - sy) ** 2;
      if (dd < Math.min(bd, rad * rad)) { bd = dd; best = { kind, id }; }
    };
    for (const zb of this.zombies.values()) if (!zb.dying) test('z', zb.id, zb.x, 1.0 * (ZOMBIES[zb.type].scale || 1), zb.z, R * (ZOMBIES[zb.type].boss ? 2.2 : 1));
    for (const [key, n] of Object.entries(this.world.layout.npcs)) test('npc', key, n.x, 1.0, n.z, R * 1.3);
    test('well', 'well', HEART.x, 1.2, HEART.z, R * 1.6);
    for (const p of this.players.values()) if (p.id !== this.myId && p.on) test('ally', p.id, p.x, 1.0, p.z);
    return best;
  }

  onTap(sx, sy, type) {
    if (this.myId === null) return;
    const touch = type !== 'mouse';
    const gp = this.groundPoint(sx, sy);
    if (this.placing) {
      this.placing.x = gp.x; this.placing.z = gp.z; this.placing.manual = true;
      if (!touch) this.placeConfirm();
      return;
    }
    const P = this.players.get(this.myId);
    if (!P || P.dead) return;
    const hit = this.pick(sx, sy, touch);
    if (hit?.kind === 'z') {
      this.attackTarget = hit.id;
      this.path = null;
      this.pending = null;
      return;
    }
    if (hit?.kind === 'npc' || hit?.kind === 'well') { this.interact(hit.id); return; }
    if (hit?.kind === 'ally') { this.selectAlly(hit.id); return; }
    this.attackTarget = null;
    this.pending = null;
    this.path = this.world.path(this.localPos.x, this.localPos.z, gp.x, gp.z);
    this.fx.ring(gp.x, gp.z, 0.7, 0xffffff, 0.4, { from: 0.2 });
  }

  onRightClick(sx, sy) {
    if (this.myId === null) return;
    if (this.placing) { this.placeCancel(); return; }
    this.castSlot(this.selectedSlot, this.groundPoint(sx, sy));
  }

  aimPoint() {
    const h = this.input.hover;
    return h ? this.groundPoint(h.x, h.y) : null;
  }

  onKey(code, key, e) {
    if (code === 'Enter') { if (this.myId !== null) this.ui.toggleChat(true); return true; }
    if (code === 'Escape') {
      if (this.placing) this.placeCancel();
      else if (this.ui.panelKind) this.ui.closePanel();
      return true;
    }
    if (this.myId === null) return false;
    if (/^Digit[1-8]$/.test(code)) { this.castSlot(Number(code[5]) - 1, this.aimPoint()); return true; }
    if (this.placing && code === 'KeyR') { this.placeRotate(); return true; }
    const itemKeys = { KeyQ: 'health_potion', KeyE: 'mana_potion', KeyR: 'repair_kit', KeyT: 'fire_bomb', KeyG: 'iron_bands' };
    if (itemKeys[code]) { this.useItem(itemKeys[code]); return true; }
    if (code === 'KeyB') { this.ui.togglePanel('build'); return true; }
    if (code === 'KeyF') { this.interact(); return true; }
    if (code === 'KeyV') { this.toggleAuto(); return true; }
    if (code === 'KeyM') { this.ui.toggleSound(); return true; }
    if (code === 'KeyH') { this.ui.togglePanel('help'); return true; }
    if (code === 'BracketLeft') { this.world.rotateCamera(-1); return true; }
    if (code === 'BracketRight') { this.world.rotateCamera(1); return true; }
    if (code === 'Space') { if (this.phase === 'prep' || this.phase === 'break') this.net.send({ t: 'ready' }); return true; }
    return false;
  }

  // ------------------------------------------------------------------ smart targeting
  liveZombies() { return [...this.zombies.values()].filter((z) => !z.dying); }

  nearestZombie(x, z, maxD) {
    let best = null, bd = maxD * maxD;
    for (const zb of this.zombies.values()) {
      if (zb.dying) continue;
      const dd = d2(zb.x, zb.z, x, z);
      if (dd < bd) { bd = dd; best = zb; }
    }
    return best;
  }

  bestCluster(range, radius) {
    const me = this.localPos;
    let best = null, bn = 0;
    const list = this.liveZombies().filter((z) => d2(z.x, z.z, me.x, me.z) < range * range);
    for (const a of list) {
      let n = ZOMBIES[a.type].boss ? 3 : 0;
      for (const b of list) if (d2(a.x, a.z, b.x, b.z) < radius * radius) n++;
      if (n > bn) { bn = n; best = a; }
    }
    return best;
  }

  lowestAlly(range) {
    const me = this.localPos;
    if (this.allyTarget) {
      const a = this.players.get(this.allyTarget);
      if (a && !a.dead && a.on && d2(a.x, a.z, me.x, me.z) < range * range) return a;
    }
    let best = this.players.get(this.myId), br = best ? best.hp / best.maxHp : 1;
    for (const p of this.players.values()) {
      if (p.dead || !p.on || p.id === this.myId) continue;
      if (d2(p.x, p.z, me.x, me.z) > range * range) continue;
      const r = p.hp / p.maxHp;
      if (r < br - 0.02) { br = r; best = p; }
    }
    return best;
  }

  damagedStructure(x, z, range) {
    let best = null, br = 0.999;
    const consider = (sx, sz, ratio) => {
      if (d2(sx, sz, x, z) > range * range) return;
      if (ratio < br) { br = ratio; best = { x: sx, z: sz }; }
    };
    for (const f of this.world.fence) consider(f.x, f.z, f.broken ? 0 : f.hp / f.maxHp);
    for (const c of this.world.constructs.values()) consider(c.x, c.z, c.hp / c.maxHp);
    consider(HEART.x, HEART.z, this.heart.hp / this.heart.maxHp + 0.05);
    return best;
  }

  castSlot(i, aim, fromButton) {
    const P = this.players.get(this.myId);
    if (!P || P.dead || !this.me || this.phase === 'over') return;
    const id = CLASS_SPELLS[this.cls][i];
    if (!id) return;
    const sp = SPELLS[id];
    const rank = this.me.sp[id];
    if (!rank) { this.ui.toast(`Learn ${sp.name} from Mystra the Arcanist (level ${sp.level}, ${sp.price} gold)`); sfx('error', 0.3); return; }
    const sNow = this.serverNow();
    if ((this.me.cd[id] || 0) > sNow + 0.05) { sfx('error', 0.3); return; }
    if (P.mana < rankVal(sp.mana, rank)) { this.ui.toast('Not enough mana!'); sfx('error', 0.3); return; }
    this.selectedSlot = i;
    const me = this.localPos;
    const range = sp.range || 0;
    const msg = { t: 'cast', s: id };
    if (sp.target === 'enemy') {
      let t = aim ? this.nearestZombie(aim.x, aim.z, 4) : null;
      if (t && d2(t.x, t.z, me.x, me.z) > (range + 2) ** 2) t = null;
      if (!t && this.attackTarget) { const a = this.zombies.get(this.attackTarget); if (a && !a.dying && d2(a.x, a.z, me.x, me.z) < (range + 1) ** 2) t = a; }
      if (!t) t = this.nearestZombie(me.x, me.z, range);
      if (!t) { this.ui.toast('No zombie in range'); sfx('error', 0.3); return; }
      msg.tid = t.id; msg.x = t.x; msg.z = t.z;
    } else if (sp.target === 'point') {
      let p = aim;
      if (!p) {
        const a = this.attackTarget && this.zombies.get(this.attackTarget);
        const t = a && !a.dying && d2(a.x, a.z, me.x, me.z) < range * range ? a : this.bestCluster(range, sp.radius || 4);
        p = t ? { x: t.x, z: t.z } : { x: me.x + Math.sin(this.localFacing) * 5, z: me.z + Math.cos(this.localFacing) * 5 };
      }
      msg.x = p.x; msg.z = p.z;
    } else if (sp.target === 'ally') {
      let t = null;
      if (aim) for (const p of this.players.values()) if (!p.dead && p.on && d2(p.x, p.z, aim.x, aim.z) < 6.25) t = p;
      if (!t) t = this.lowestAlly(range);
      msg.tid = t.id; const tp = this.posOf(t.id); msg.x = tp.x; msg.z = tp.z;
    } else if (sp.target === 'repair') {
      let p = aim && this.damagedStructure(aim.x, aim.z, 4);
      if (!p) p = this.damagedStructure(me.x, me.z, range + (sp.radius || 0) * 0.5);
      if (!p && aim) p = aim;
      if (!p) { this.ui.toast('Nothing damaged nearby to repair'); sfx('error', 0.3); return; }
      msg.x = p.x; msg.z = p.z;
    }
    this.net.send(msg);
    P.char.playCast();
    if (msg.x !== undefined && sp.target !== 'self') { this.localFacing = Math.atan2(msg.x - me.x, msg.z - me.z); this.castFaceUntil = performance.now() / 1000 + 0.35; }
    this.me.cd[id] = sNow + rankVal(sp.cd, rank);
    const slot = this.ui.slots?.[i]?.b;
    if (slot) { slot.classList.remove('flash'); void slot.offsetWidth; slot.classList.add('flash'); }
  }

  useItem(id) {
    if (!this.me) return;
    const P = this.players.get(this.myId);
    if (!P || P.dead) return;
    if (!(this.me.inv[id] > 0)) { this.ui.toast(`You have no ${ITEMS[id].name} — buy some from Gareth the Trader`); sfx('error', 0.3); return; }
    const msg = { t: 'use', item: id };
    if (id === 'fire_bomb') {
      const aim = this.aimPoint();
      let p = aim;
      if (!p) { const c = this.bestCluster(12, 3.5); if (c) p = { x: c.x, z: c.z }; }
      if (!p) { this.ui.toast('No target for the fire bomb'); return; }
      msg.x = p.x; msg.z = p.z;
      P.char.playCast();
    }
    this.net.send(msg);
    if (id === 'health_potion' || id === 'mana_potion') sfx('heal', 0.2);
  }

  // ------------------------------------------------------------------ construct placement
  beginPlacement(kind) {
    this.placeCancel();
    if (this.phase === 'over') return;
    const d = CONSTRUCTS[kind];
    const ghost = makeConstructMesh(kind, this.world.softTex);
    const mat = new THREE.MeshBasicMaterial({ color: 0x60ff80, transparent: true, opacity: 0.45, depthWrite: false });
    ghost.traverse((o) => { if (o.isMesh) { o.material = mat; o.castShadow = false; } });
    this.world.scene.add(ghost);
    const range = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 48), new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.6, depthWrite: false }));
    range.rotation.x = -Math.PI / 2;
    range.position.y = 0.07;
    range.scale.setScalar(d.range || d.radius || 1);
    ghost.add(range);
    const f = this.localFacing;
    this.placing = { kind, rot: 0, x: this.localPos.x + Math.sin(f) * 3, z: this.localPos.z + Math.cos(f) * 3, ghost, mat, manual: false };
    this.buildRange.visible = true;
    sfx('click');
  }

  placeRotate() { if (this.placing) this.placing.rot += Math.PI / 4; }

  placeCancel() {
    if (!this.placing) return;
    this.world.scene.remove(this.placing.ghost);
    this.placing = null;
    this.buildRange.visible = false;
    this.ui.hidePlacement();
  }

  placementCheck() {
    const pl = this.placing;
    const d = CONSTRUCTS[pl.kind];
    const P = this.players.get(this.myId);
    if (d2(pl.x, pl.z, this.localPos.x, this.localPos.z) > BUILD_RANGE * BUILD_RANGE) return 'Too far — move closer';
    if (this.me.wd < d.wood || this.me.st < d.stone) return `Needs ${d.wood} timber & ${d.stone} stone`;
    if (P && P.mana < d.mana) return `Needs ${d.mana} mana`;
    if (this.me.cn >= MAX_CONSTRUCTS_PER_PLAYER) return 'Construct limit reached';
    return placementError({ staticIndex: this.world.staticIndex, fenceShapes: this.world.fenceShapes, npcs: Object.values(this.world.layout.npcs), constructs: this.world.constructs.values() }, pl.kind, pl.x, pl.z, pl.rot);
  }

  placeConfirm() {
    const pl = this.placing;
    if (!pl) return;
    const err = this.placementCheck();
    if (err) { this.ui.toast(err); sfx('error', 0.3); return; }
    this.net.send({ t: 'build', kind: pl.kind, x: pl.x, z: pl.z, rot: pl.rot });
    this.placeCancel();
  }

  updatePlacement() {
    const pl = this.placing;
    if (!pl) return;
    if (this.input.hover && !pl.manual) { const g = this.groundPoint(this.input.hover.x, this.input.hover.y); pl.x = g.x; pl.z = g.z; }
    if (this.input.mouseSeen && this.input.hover) pl.manual = false;
    pl.ghost.position.set(pl.x, 0, pl.z);
    pl.ghost.rotation.y = pl.rot;
    const err = this.placementCheck();
    pl.mat.color.setHex(err ? 0xff4040 : 0x60ff80);
    const d = CONSTRUCTS[pl.kind];
    const touch = !this.input.mouseSeen;
    this.ui.setPlacementInfo(`${d.icon} ${d.name}`, err || (touch ? 'Tap the ground to move it, then press Place' : 'Click to place · R / ⟳ to rotate · Esc to cancel'), !!err);
    this.buildRange.position.set(this.localPos.x, 0.05, this.localPos.z);
  }

  // ------------------------------------------------------------------ local wizard
  updateLocal(dt, now) {
    const P = this.players.get(this.myId);
    if (!P) return;
    const ch = P.char;
    if (P.dead) { this.path = null; ch.speed = 0; this.sendMove(now, false); return; }
    const C = CLASSES[this.cls];
    let speed = C.speed;
    const bf = this.me?.bf || {};
    const sNow = this.serverNow();
    if (bf.haste > sNow) speed *= 1.4;
    if (bf.chill > sNow) speed *= 0.6;
    let dir = null;
    const kd = this.input.keyDir();
    if (kd) {
      const ax = this.world.screenAxes();
      dir = [ax.right[0] * kd[0] + ax.up[0] * kd[1], ax.right[1] * kd[0] + ax.up[1] * kd[1]];
      this.path = null; this.pending = null;
    } else if (this.input.hold && !this.placing) {
      const g = this.groundPoint(this.input.hold.x, this.input.hold.y);
      const dx = g.x - this.localPos.x, dz = g.z - this.localPos.z, dl = Math.hypot(dx, dz);
      if (dl > 0.4) dir = [dx / dl, dz / dl];
      this.path = null; this.pending = null; this.attackTarget = null;
    } else if (this.path && this.path.length) {
      const wp = this.path[0];
      const dx = wp[0] - this.localPos.x, dz = wp[1] - this.localPos.z, dl = Math.hypot(dx, dz);
      if (dl < 0.25) { this.path.shift(); if (!this.path.length) this.path = null; }
      else dir = [dx / dl, dz / dl];
    } else if (this.attackTarget) {
      const t = this.zombies.get(this.attackTarget);
      if (t && !t.dying) {
        const dl = Math.hypot(t.x - this.localPos.x, t.z - this.localPos.z);
        if (dl > BASIC_ATTACK.range - 1) {
          if (!this.chasePathAt || now > this.chasePathAt) {
            this.chasePathAt = now + 0.5;
            this.path = this.world.path(this.localPos.x, this.localPos.z, t.x, t.z);
            if (this.path && this.path.length > 1) this.path.pop();
          }
        }
      } else this.attackTarget = null;
    }
    if (this.pending && !this.path) {
      if (this.isNear(this.pending, 0.8)) this.interact(this.pending);
      else this.pending = null; // the walk ended somewhere else (blocked or redirected)
    }
    let moved = 0;
    if (dir) {
      const ox = this.localPos.x, oz = this.localPos.z;
      let nx = ox + dir[0] * speed * dt, nz = oz + dir[1] * speed * dt;
      [nx, nz] = this.world.collide(nx, nz, PLAYER_R);
      // shoulder past zombies
      for (const zb of this.zombies.values()) {
        if (zb.dying) continue;
        const r = PLAYER_R + 0.35 * (ZOMBIES[zb.type].scale || 1);
        const dx = nx - zb.x, dz = nz - zb.z, dd = Math.hypot(dx, dz);
        if (dd < r && dd > 0.01) { nx = zb.x + (dx / dd) * r; nz = zb.z + (dz / dd) * r; }
      }
      [nx, nz] = this.world.collide(nx, nz, PLAYER_R);
      nx = Math.max(-PLAYER_BOUND, Math.min(PLAYER_BOUND, nx));
      nz = Math.max(-PLAYER_BOUND, Math.min(PLAYER_BOUND, nz));
      if (insideVillage(nx, nz) !== insideVillage(ox, oz) && !this.world.crossingOpen(ox, oz, nx, nz)) { nx = ox; nz = oz; }
      moved = Math.hypot(nx - ox, nz - oz);
      this.localPos.x = nx; this.localPos.z = nz;
      if (now > this.castFaceUntil) this.localFacing = lerpAngle(this.localFacing, Math.atan2(dir[0], dir[1]), Math.min(1, dt * 14));
      if (this.path && moved < speed * dt * 0.15) { this.stuckT = (this.stuckT || 0) + dt; if (this.stuckT > 0.6) { this.path = null; this.stuckT = 0; } } else this.stuckT = 0;
    }
    ch.speed = moved / Math.max(dt, 1e-4);
    ch.root.position.set(this.localPos.x, 0, this.localPos.z);
    ch.root.rotation.y = lerpAngle(ch.root.rotation.y, this.localFacing, Math.min(1, dt * 16));
    P.x = this.localPos.x; P.z = this.localPos.z; P.f = this.localFacing;
    this.sendMove(now, moved > 0);
  }

  sendMove(now, moved) {
    if (now - this.lastSend < (moved ? 1 / 15 : 0.5)) return;
    this.lastSend = now;
    this.net.send({ t: 'mv', x: Math.round(this.localPos.x * 100) / 100, z: Math.round(this.localPos.z * 100) / 100, f: Math.round(this.localFacing * 100) / 100, q: this.tpSeq });
  }

  updateCombat(now) {
    const P = this.players.get(this.myId);
    if (!P || P.dead || !this.me) return;
    let t = this.attackTarget && this.zombies.get(this.attackTarget);
    if (t && t.dying) { this.attackTarget = null; t = null; }
    const me = this.localPos;
    const R = BASIC_ATTACK.range;
    if (!t && this.auto && !this.placing) t = this.nearestZombie(me.x, me.z, R - 0.5);
    if (!t || d2(t.x, t.z, me.x, me.z) > R * R) return;
    if (now < this.localBasicReady || this.me.bc > this.serverNow() + 0.02) return;
    this.localBasicReady = now + BASIC_ATTACK.cd * 0.95;
    this.net.send({ t: 'atk', tid: t.id });
    P.char.playCast();
    this.localFacing = Math.atan2(t.x - me.x, t.z - me.z);
    this.castFaceUntil = now + 0.3;
  }

  // ------------------------------------------------------------------ interpolation
  sample(e, rt) {
    const b = e.buf;
    if (!b.length) return;
    let i = b.length - 1;
    while (i > 0 && b[i - 1][0] > rt) i--;
    const s1 = b[i];
    const s0 = i > 0 ? b[i - 1] : s1;
    let x, z, f;
    if (rt >= s1[0] || s0 === s1) { x = s1[1]; z = s1[2]; f = s1[3]; }
    else if (rt <= s0[0]) { x = s0[1]; z = s0[2]; f = s0[3]; }
    else {
      const k = (rt - s0[0]) / (s1[0] - s0[0]);
      x = s0[1] + (s1[1] - s0[1]) * k; z = s0[2] + (s1[2] - s0[2]) * k; f = lerpAngle(s0[3], s1[3], k);
    }
    return [x, z, f];
  }

  updateEntities(dt, now) {
    const rt = this.serverNow() - INTERP;
    for (const p of this.players.values()) {
      const a = p.aura;
      const bits = p.bits;
      a.empower.visible = !!(bits & 1); a.haste.visible = !!(bits & 2); a.ascend.visible = !!(bits & 4); a.shield.visible = !!(bits & 8); a.blades.visible = !!(bits & 16);
      if (bits & 16) a.blades.rotation.y = now * 5;
      if (bits & 4) a.ascend.rotation.z = now;
      if (bits & 32) p.char.setTint(0, 0.1, 0.3); else p.char.setTint(0, 0, 0);
      if (p.id === this.myId) { p.char.update(dt, now); continue; }
      const s = this.sample(p, rt);
      if (!s) continue;
      const ox = p.x, oz = p.z;
      [p.x, p.z, p.f] = s;
      const sp = Math.hypot(p.x - ox, p.z - oz) / Math.max(dt, 1e-4);
      p.speed += (sp - p.speed) * Math.min(1, dt * 10);
      p.char.speed = p.speed;
      p.char.root.position.set(p.x, 0, p.z);
      p.char.root.rotation.y = p.castFaceUntil > now ? p.castFace : p.f;
      p.char.update(dt, now);
    }
    for (const zb of this.zombies.values()) {
      if (!zb.dying) {
        const s = this.sample(zb, rt);
        if (s) {
          const ox = zb.x, oz = zb.z;
          [zb.x, zb.z, zb.f] = s;
          const sp = Math.hypot(zb.x - ox, zb.z - oz) / Math.max(dt, 1e-4);
          zb.speed += (sp - zb.speed) * Math.min(1, dt * 8);
          zb.char.speed = zb.state === 1 ? 0 : zb.speed;
          zb.char.root.position.set(zb.x, 0, zb.z);
          zb.char.root.rotation.y = lerpAngle(zb.char.root.rotation.y, zb.f, Math.min(1, dt * 12));
        }
      }
      zb.char.update(dt, now);
      // bosses and elites trail a menacing aura
      if (!zb.dying && (zb.aura || (zb.aura = BOSS_AURA[zb.type] || (zb.flags & 16 ? 0xffb030 : 0)))) {
        const big = ZOMBIES[zb.type].boss;
        zb.auraT = (zb.auraT || 0) + dt;
        if (zb.auraT > (big ? 0.03 : 0.09)) {
          zb.auraT = 0;
          this.fx.emit(zb.x, 0.2, zb.z, 1, { color: zb.aura, speed: 0.4, vy: big ? 2.6 : 1.6, radius: big ? 1.6 : 0.7, life: 1, size: big ? 0.55 : 0.35, drag: 0 });
        }
      }
    }
    for (const ch of Object.values(this.npcChars)) ch.update(dt, now);
    // target rings
    const t = this.attackTarget && this.zombies.get(this.attackTarget);
    this.targetRing.visible = !!t;
    if (t) { this.targetRing.position.set(t.x, 0.05, t.z); this.targetRing.scale.setScalar((ZOMBIES[t.type].scale || 1) * (1 + 0.08 * Math.sin(now * 8))); }
    const a = this.allyTarget && this.players.get(this.allyTarget);
    this.allyRing.visible = !!a && !a.dead;
    if (a) this.allyRing.position.set(a.x, 0.05, a.z);
  }

  // ------------------------------------------------------------------ frame
  frame() {
    const t = performance.now();
    const rawDt = Math.min(0.25, (t - this.clock) / 1000);
    const dt = Math.min(0.05, rawDt);
    this.clock = t;
    const now = t / 1000;
    const joined = this.myId !== null && this.players.has(this.myId);
    if (joined) {
      // sub-step movement so slow devices still walk at full speed without tunnelling
      const steps = Math.max(1, Math.ceil(rawDt / 0.05));
      for (let i = 0; i < steps; i++) this.updateLocal(rawDt / steps, now);
      this.updateCombat(now);
      this.nearInteract = this.computeNearInteract();
      this.updatePlacement();
    }
    this.updateEntities(dt, now);
    this.world.update(dt, now);
    this.world.setMood(!!this.boss, dt);
    if (joined) {
      this.world.updateCamera(new THREE.Vector3(this.localPos.x, 0, this.localPos.z), dt);
      this.world.updateOcclusion(this.localPos.x, this.localPos.z, dt);
    } else {
      this.world.camYawTarget += dt * 0.05;
      this.world.updateCamera(new THREE.Vector3(0, 0, 0), dt);
    }
    this.fx.setScale((window.innerHeight / this.world.viewSize) * this.pixelRatio);
    this.fx.update(dt);
    if (joined) this.ui.updateHud(now);
    this.ui.updateWorldUi(now, dt);
    if (!this.lastMap || now - this.lastMap > 0.066) { this.lastMap = now; if (joined) this.ui.drawMinimap(now); }
    this.waveAge = now - this.waveStartLocal;
    if (this.hurtFlash > 0) {
      this.hurtFlash = Math.max(0, this.hurtFlash - dt * 3);
      document.getElementById('game').style.boxShadow = `inset 0 0 ${120 * this.hurtFlash}px rgba(255,0,0,${0.6 * this.hurtFlash})`;
    }
    this.renderer.render(this.world.scene, this.world.camera);
    this.adaptQuality(dt);
  }

  // Drop resolution on devices that can't keep up.
  adaptQuality(dt) {
    this.fpsAcc.push(dt);
    if (this.fpsAcc.length < 180) return;
    const avg = this.fpsAcc.reduce((a, b) => a + b, 0) / this.fpsAcc.length;
    this.fpsAcc.length = 0;
    if (avg > 1 / 28 && this.pixelRatio > 1) {
      this.pixelRatio = Math.max(1, this.pixelRatio - 0.25);
      this.renderer.setPixelRatio(this.pixelRatio);
      this.resize();
    }
  }
}

const game = new Game();
window.__game = game;
game.start().catch((err) => {
  console.error(err);
  document.querySelector('#screen-loading p').textContent = 'Failed to load: ' + err.message;
});
