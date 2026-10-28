// Authoritative simulation for the single shared village defence.

import {
  TICK_RATE, SNAPSHOT_EVERY, MAX_PLAYERS, TOTAL_WAVES, FIRST_PREP_TIME, WAVE_BREAK_TIME, WELL_COOLDOWN, WELL_RANGE,
  NPC_RANGE, BUILD_RANGE, MAX_CONSTRUCTS_PER_PLAYER, MAX_LEVEL, RECONNECT_GRACE_MS, EMPTY_RESET_MS, FENCE_HP, GATE_HP,
  HEART_HP, FENCE_INTACT_RATIO, START_GOLD, START_WOOD, START_STONE, CLASSES, BASIC_ATTACK, spellPower, SPELLS,
  spellUpgradeCost, rankVal, CONSTRUCTS, ITEMS, ZOMBIES, ZOMBIE_TYPES, waveHpMult, waveDmgMult, waveSpeedMult,
  partyRewardScale, waveSpec, SPAWN_DIRS, directionName, xpToNext, waveXpMult, waveClearGold, waveClearXp,
  quizBaseXp, quizStreakMult, tierOf, NPCS, HEART_DMG_MULT,
} from '../shared/data.js';
import {
  buildLayout, buildFenceSegments, buildObstacles, insideVillage, HEART, PLAYER_SPAWN, PLAYER_BOUND, SPAWN_DIST, WORLD_HALF,
} from '../shared/layout.js';
import {
  ShapeIndex, resolveCollisions, NavGrid, computeFlow, flowNext, cellOf, cellCenter, GRID_N, shapeDist, shapeClosest, segDist, shapeContains,
} from '../shared/geom.js';
import { placementError, constructShape } from '../shared/placement.js';
import { QUIZ_BANK } from './quiz-bank.js';

const DT = 1 / TICK_RATE;
const PLAYER_R = 0.4;
const ZT_INDEX = Object.fromEntries(ZOMBIE_TYPES.map((t, i) => [t, i]));
const d2 = (ax, az, bx, bz) => (ax - bx) * (ax - bx) + (az - bz) * (az - bz);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r2 = (v) => Math.round(v * 100) / 100;
const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export class Game {
  constructor() {
    this.layout = buildLayout();
    this.obstacles = buildObstacles(this.layout);
    this.staticIndex = new ShapeIndex(8);
    for (const o of this.obstacles) this.staticIndex.add(o);
    this.segDefs = buildFenceSegments();
    this.fenceShapes = this.segDefs.map((sg) => ({ type: 'box', x: sg.x, z: sg.z, hx: 1.0, hz: sg.gate ? 0.22 : 0.14, rot: sg.rot, seg: sg.id, gate: sg.gate }));
    this.dynIndex = new ShapeIndex(8);
    for (const s of this.fenceShapes) this.dynIndex.add(s);
    this.grid = new NavGrid();
    this.grid.markShapes(this.obstacles, 0.45);
    this.grid.markFence(this.segDefs);
    this.goalCells = [];
    for (let ix = cellOf(-4); ix <= cellOf(4); ix++)
      for (let iz = cellOf(-4); iz <= cellOf(4); iz++) {
        const i = this.grid.idx(ix, iz);
        if (!this.grid.blocked[i] && Math.hypot(cellCenter(ix), cellCenter(iz)) < 2.9) this.goalCells.push(i);
      }
    this.npcs = this.layout.npcs;
    this.clients = new Set();
    this.players = new Map();
    this.tokens = new Map();
    this.nextId = 1;
    this.tickNo = 0;
    this.reset(true);
  }

  // ------------------------------------------------------------------ lifecycle
  reset(initial = false) {
    this.phase = 'lobby';
    this.wave = 0;
    this.timer = 0;
    this.time = 0;
    this.result = null;
    this.players.clear();
    this.tokens.clear();
    this.zombies = new Map();
    this.projectiles = [];
    this.zones = [];
    this.delayed = [];
    this.constructs = new Map();
    this.grid.dyn.fill(-1);
    for (const c of this.dynIndex.map.values()) for (let i = c.length - 1; i >= 0; i--) if (c[i].con) c.splice(i, 1);
    this.fenceTier = 0;
    this.fence = this.segDefs.map((sg) => {
      const maxHp = sg.gate ? GATE_HP : FENCE_HP;
      return { ...sg, hp: maxHp, maxHp, baseMax: maxHp, broken: false, lastHit: -99, fortUntil: 0, reinforced: false };
    });
    this.heart = { hp: HEART_HP, maxHp: HEART_HP, lastHit: -99 };
    this.spawnQueue = [];
    this.waveDirs = [];
    this.nextDirs = this.rollDirs(1);
    this.spawnTotal = 0;
    this.navDirty = true;
    this.flowDist = null;
    this.flowNext = null;
    this.playerFlows = new Map();
    this.events = [];
    this.fenceDirty = new Set(this.fence.map((f) => f.id));
    this.conDirty = new Set();
    this.heartDirty = true;
    this.breachMsgAt = 0;
    this.emptySince = null;
    this.stats = { kills: 0, started: Date.now() };
    this.zgrid = new Map();
    if (!initial) {
      for (const c of this.clients) {
        c.playerId = null;
        c.send({ t: 'reset' });
        this.sendWelcome(c, null);
      }
    }
  }

  connectedPlayers() { let n = 0; for (const p of this.players.values()) if (p.connected) n++; return n; }
  partySize() { return Math.max(1, this.players.size); }
  slotsUsed() { return this.players.size; }

  // ------------------------------------------------------------------ networking
  onConnect(client) {
    this.clients.add(client);
    client.msgCount = 0;
    client.msgWindow = Date.now();
  }

  onDisconnect(client) {
    this.clients.delete(client);
    const p = client.playerId && this.players.get(client.playerId);
    if (p && p.client === client) {
      p.connected = false;
      p.client = null;
      p.lastSeen = Date.now();
      p.quizCur = null;
      p.quizActive = false;
      this.announce(`${p.name} lost connection...`, 'info');
      this.broadcastRoster();
    }
  }

  onMessage(client, msg) {
    const now = Date.now();
    if (now - client.msgWindow > 1000) { client.msgWindow = now; client.msgCount = 0; }
    if (++client.msgCount > 80) return;
    if (!msg || typeof msg.t !== 'string') return;
    if (msg.t === 'hello') return this.handleHello(client, msg);
    if (msg.t === 'join') return this.handleJoin(client, msg);
    if (msg.t === 'ping') return client.send({ t: 'pong', c: msg.c, tm: this.time });
    const p = client.playerId && this.players.get(client.playerId);
    if (!p || p.client !== client) return;
    switch (msg.t) {
      case 'mv': return this.handleMove(p, msg);
      case 'atk': return this.handleBasicAttack(p, msg);
      case 'cast': return this.handleCast(p, msg);
      case 'use': return this.handleUse(p, msg);
      case 'buy': return this.handleBuy(p, msg);
      case 'spell': return this.handleBuySpell(p, msg);
      case 'build': return this.handleBuild(p, msg);
      case 'well': return this.tryWell(p, true);
      case 'ready': p.ready = !p.ready; return;
      case 'quizStart': return this.quizStart(p);
      case 'quizAnswer': return this.quizAnswer(p, msg);
      case 'quizStop': p.quizCur = null; p.quizActive = false; return;
      case 'chat': return this.handleChat(p, msg);
      case 'dev': return this.handleDev(p, msg);
      default:
    }
  }

  handleHello(client, msg) {
    let token = typeof msg.token === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(msg.token) ? msg.token : null;
    if (!token) token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    client.token = token;
    const pid = this.tokens.get(token);
    const p = pid && this.players.get(pid);
    if (p) {
      if (p.client && p.client !== client) {
        p.client.send({ t: 'kicked', reason: 'This wizard was opened in another window.' });
        p.client.playerId = null;
        p.client.close?.();
      }
      const wasAway = !p.connected;
      p.client = client;
      p.connected = true;
      client.playerId = p.id;
      p.tpSeq++;
      this.sendWelcome(client, p);
      if (wasAway) this.announce(`${p.name} is back!`, 'info');
      this.broadcastRoster();
    } else {
      this.sendWelcome(client, null);
    }
  }

  sendWelcome(client, p) {
    client.send({
      t: 'welcome',
      token: client.token,
      you: p ? p.id : null,
      phase: this.phase,
      wave: this.wave,
      slots: MAX_PLAYERS - this.slotsUsed(),
      roster: this.roster(),
      tp: p ? { x: p.x, z: p.z, q: p.tpSeq } : null,
      fence: this.fence.map((f) => [f.id, Math.round(f.hp), f.maxHp, f.broken ? 1 : 0]),
      cons: [...this.constructs.values()].map((c) => this.conInfo(c)),
      heart: [Math.round(this.heart.hp), this.heart.maxHp],
      tm: this.time,
    });
    if (p) this.sendMe(p, true);
  }

  handleJoin(client, msg) {
    if (client.playerId && this.players.has(client.playerId)) return;
    if (!client.token) return;
    const cls = typeof msg.cls === 'string' && Object.hasOwn(CLASSES, msg.cls) ? msg.cls : null;
    if (!cls) return;
    if (this.phase === 'over') return client.send({ t: 'error', text: 'The battle is ending — a new game starts shortly.' });
    if (this.slotsUsed() >= MAX_PLAYERS) return client.send({ t: 'full' });
    let name = typeof msg.name === 'string' ? msg.name.replace(/[^\p{L}\p{N} _'-]/gu, '').trim().slice(0, 16) : '';
    if (!name) name = CLASSES[cls].name;
    const p = this.createPlayer(client.token, name, cls);
    p.client = client;
    client.playerId = p.id;
    if (this.phase === 'lobby') {
      this.phase = 'prep';
      this.timer = FIRST_PREP_TIME;
      this.nextDirs = this.rollDirs(1);
      this.announce('The dead are rising! Prepare the village defences.', 'wave');
    }
    this.announce(`${name} the ${CLASSES[cls].name} joined the defence!`, 'info');
    this.sendWelcome(client, p);
    this.broadcastRoster();
  }

  createPlayer(token, name, cls) {
    const C = CLASSES[cls];
    let level = 1;
    if (this.players.size && this.wave > 1) {
      // late joiners catch up so they are useful straight away
      const avg = [...this.players.values()].reduce((a, q) => a + q.level, 0) / this.players.size;
      level = Math.max(1, Math.floor(avg * 0.8));
    }
    const p = {
      id: this.nextId++, token, name, cls, client: null, connected: true, lastSeen: Date.now(),
      x: PLAYER_SPAWN.x + (Math.random() - 0.5) * 3, z: PLAYER_SPAWN.z + Math.random() * 1.5, f: Math.PI, lastMv: this.time,
      level, xp: 0, maxHp: C.hp + C.hpPerLvl * (level - 1), maxMana: C.mana + C.manaPerLvl * (level - 1),
      gold: START_GOLD + (this.wave > 1 ? 35 * this.wave : 0), wood: START_WOOD, stone: START_STONE,
      inv: { health_potion: 2, mana_potion: 1, repair_kit: 1, fire_bomb: 0, iron_bands: 0, phoenix_charm: 0 },
      spells: Object.fromEntries(C.start.map((s) => [s, 1])),
      cds: {}, basicReady: 0, wellReady: 0, buffs: {}, dead: false, respawnAt: 0, ready: false,
      tpSeq: 1, ampUntil: 0, fontRegen: 0,
      quizOrder: shuffle([...QUIZ_BANK.keys()]), quizPos: 0, quizCycle: 0, quizStreak: 0, quizBest: 0, quizCur: null, quizCorrect: 0, quizAnswered: 0,
      stats: { kills: 0, dmg: 0, heal: 0, repair: 0, deaths: 0 },
      lastMe: '',
    };
    p.hp = p.maxHp;
    p.mana = p.maxMana;
    this.players.set(p.id, p);
    this.tokens.set(token, p.id);
    return p;
  }

  roster() {
    return [...this.players.values()].map((p) => ({ id: p.id, name: p.name, cls: p.cls, on: p.connected, lv: p.level }));
  }
  broadcastRoster() { this.broadcast({ t: 'roster', players: this.roster(), slots: MAX_PLAYERS - this.slotsUsed() }); }
  broadcast(obj) { const s = JSON.stringify(obj); for (const c of this.clients) c.sendRaw(s); }
  announce(text, kind = 'info') { this.broadcast({ t: 'msg', text, kind }); }
  ev(...e) { this.events.push(e); }

  // ------------------------------------------------------------------ main loop
  tick() {
    this.tickNo++;
    const now = Date.now();
    // drop players whose reconnect window expired
    for (const p of [...this.players.values()]) {
      if (!p.connected && now - p.lastSeen > RECONNECT_GRACE_MS) {
        this.players.delete(p.id);
        this.tokens.delete(p.token);
        this.announce(`${p.name} has left the village.`, 'info');
        this.broadcastRoster();
      }
    }
    const active = this.connectedPlayers();
    if (this.phase !== 'lobby' && active === 0) {
      // everyone is away: freeze the world; start over if nobody returns
      if (!this.emptySince) this.emptySince = now;
      if (now - this.emptySince > EMPTY_RESET_MS || this.players.size === 0) this.reset();
      return;
    }
    this.emptySince = null;
    if (this.phase === 'lobby') return;

    this.time += DT;
    this.updatePhase();
    if (this.navDirty && this.time - (this.flowAt || -9) > 0.3) this.rebuildFlow();
    this.updatePlayerFlows();
    this.rebuildZombieGrid();
    this.updatePlayers();
    this.updateZombies();
    this.updateProjectiles();
    this.updateZones();
    this.updateDelayed();
    this.updateConstructs();
    if (this.phase !== 'over' && this.heart.hp <= 0) this.endGame(false);
    if (this.tickNo % SNAPSHOT_EVERY === 0) this.sendSnapshots();
  }

  updatePhase() {
    if (this.phase === 'prep' || this.phase === 'break') {
      this.timer -= DT;
      const live = [...this.players.values()].filter((p) => p.connected);
      if (live.length && live.every((p) => p.ready) && this.timer > 3) this.timer = 3;
      if (this.timer <= 0) this.startWave();
    } else if (this.phase === 'wave') {
      while (this.spawnQueue.length && this.spawnQueue[0].at <= this.time) {
        const s = this.spawnQueue.shift();
        this.spawnZombie(s.type, s.x, s.z, { elite: s.elite });
        if (ZOMBIES[s.type].boss) this.announce(`☠ ${ZOMBIES[s.type].name} approaches from the ${s.dirName}! ☠`, 'boss');
      }
      if (!this.spawnQueue.length && this.zombies.size === 0) this.waveCleared();
    } else if (this.phase === 'over') {
      this.timer -= DT;
      if (this.timer <= 0) this.reset();
    }
  }

  rollDirs(n) {
    const idx = shuffle([0, 1, 2, 3, 4, 5, 6, 7]);
    // favour the four cardinal roads early on
    if (n <= 2) idx.sort((a, b) => (a % 2) - (b % 2) || Math.random() - 0.5);
    return idx.slice(0, n);
  }

  startWave() {
    this.wave++;
    this.phase = 'wave';
    for (const p of this.players.values()) p.ready = false;
    const P = this.partySize();
    const spec = waveSpec(this.wave, P);
    const dirs = this.nextDirs.length >= spec.dirs ? this.nextDirs.slice(0, spec.dirs) : this.rollDirs(spec.dirs);
    this.waveDirs = dirs;
    const T = tierOf(this.wave);
    if (T > this.fenceTier) {
      this.fenceTier = T;
      for (const f of this.fence) {
        const ratio = f.hp / f.maxHp;
        f.baseMax = Math.round((f.gate ? GATE_HP : FENCE_HP) * (1 + 0.3 * T));
        f.maxHp = Math.round(f.baseMax * (f.reinforced ? 1.5 : 1));
        f.hp = Math.round(ratio * f.maxHp);
        this.fenceDirty.add(f.id);
      }
      this.announce('The villagers reinforce the palisade: fences are 30% sturdier!', 'good');
    }
    const list = [];
    for (const [type, n] of Object.entries(spec.mix)) for (let i = 0; i < n; i++) list.push({ type, elite: false });
    for (let i = 0; i < spec.elites; i++) list.push({ type: 'brute', elite: true });
    shuffle(list);
    const dur = spec.spawnDuration;
    this.spawnQueue = [];
    list.forEach((s, i) => {
      const d = dirs[i % dirs.length];
      const at = this.time + 1.5 + (i / Math.max(1, list.length - 1)) * dur * (0.85 + Math.random() * 0.15);
      this.spawnQueue.push({ ...s, at, ...this.spawnPoint(d) });
    });
    if (spec.boss) this.spawnQueue.push({ type: spec.boss, elite: false, at: this.time + 4 + dur * 0.4, ...this.spawnPoint(dirs[0]) });
    this.spawnQueue.sort((a, b) => a.at - b.at);
    this.spawnTotal = this.spawnQueue.length;
    const names = dirs.map((d) => SPAWN_DIRS[d].name);
    const tierNote = this.wave === 11 || this.wave === 21 ? ' The horde grows stronger!' : '';
    this.announce(`Wave ${this.wave}${spec.boss ? ' — BOSS WAVE' : ''}: zombies approach from the ${joinNames(names)}!${tierNote}`, spec.boss ? 'boss' : 'wave');
    this.ev('wave', this.wave, dirs);
  }

  spawnPoint(d) {
    const dir = SPAWN_DIRS[d];
    const len = Math.hypot(dir.x, dir.z);
    const ux = dir.x / len, uz = dir.z / len;
    const side = (Math.random() - 0.5) * 16, depth = (Math.random() - 0.5) * 5;
    return { x: clamp(ux * (SPAWN_DIST + depth) - uz * side, -WORLD_HALF + 2, WORLD_HALF - 2), z: clamp(uz * (SPAWN_DIST + depth) + ux * side, -WORLD_HALF + 2, WORLD_HALF - 2), dirName: dir.name };
  }

  waveCleared() {
    const w = this.wave;
    for (const p of this.players.values()) {
      p.gold += waveClearGold(w);
      this.giveXp(p, waveClearXp(w));
    }
    // villagers patch the palisade between waves
    for (const f of this.fence) this.repairFence(f, f.maxHp * 0.25, null);
    this.heart.hp = Math.min(this.heart.maxHp, this.heart.hp + this.heart.maxHp * 0.15);
    this.heartDirty = true;
    if (w >= TOTAL_WAVES) return this.endGame(true);
    this.phase = 'break';
    this.timer = WAVE_BREAK_TIME;
    const nextSpec = waveSpec(w + 1, this.partySize());
    this.nextDirs = this.rollDirs(nextSpec.dirs);
    this.announce(`Wave ${w} cleared! +${waveClearGold(w)} gold. ${WAVE_BREAK_TIME} seconds to heal and fortify.`, 'good');
    this.ev('clear', w);
  }

  endGame(victory) {
    this.phase = 'over';
    this.timer = 30;
    this.result = victory ? 'victory' : 'defeat';
    this.zombies.clear();
    this.spawnQueue = [];
    this.projectiles = [];
    this.zones = [];
    const stats = [...this.players.values()].map((p) => ({ name: p.name, cls: p.cls, level: p.level, ...p.stats, quiz: p.quizCorrect }));
    this.broadcast({ t: 'over', victory, wave: this.wave, stats, restartIn: this.timer });
    this.announce(victory ? 'VICTORY! The village survived all 30 waves!' : `The Well of Renewal has fallen on wave ${this.wave}...`, victory ? 'good' : 'bad');
  }

  // ------------------------------------------------------------------ navigation
  // Extra cost for zombies to enter each nav cell: intact fence sections and walls must be smashed through,
  // so paths prefer weak or already-broken sections. Rebuilt whenever the palisade changes.
  buildCostField() {
    const g = this.grid;
    const cost = this.costField || (this.costField = new Float32Array(g.n * g.n));
    cost.fill(0);
    for (let i = 0; i < cost.length; i++) {
      const f = g.fence[i];
      if (f >= 0) {
        const s = this.fence[f];
        if (!s.broken) cost[i] = (s.gate ? 16 : 6) + 14 * (s.hp / s.maxHp);
        continue;
      }
      const c = g.dyn[i];
      if (c >= 0) {
        const con = this.constructs.get(c);
        if (con) cost[i] = 8 + 10 * (con.hp / con.maxHp);
      }
    }
    return cost;
  }

  rebuildFlow() {
    this.navDirty = false;
    this.flowAt = this.time;
    const cost = this.buildCostField();
    this.flowDist = computeFlow(this.grid, this.goalCells, cost);
    this.flowNext = flowNext(this.grid, this.flowDist);
    this.playerFlows.clear();
  }

  updatePlayerFlows() {
    // flow fields toward each wizard so chasing zombies route around buildings
    if (this.tickNo % 6 !== 0) return;
    const alive = [...this.players.values()].filter((p) => p.connected && !p.dead);
    if (!alive.length) return;
    const p = alive[(this.tickNo / 6) % alive.length | 0];
    const pi = this.grid.idx(cellOf(p.x), cellOf(p.z));
    const dist = computeFlow(this.grid, [pi], this.costField || this.buildCostField());
    this.playerFlows.set(p.id, { next: flowNext(this.grid, dist), at: this.time });
  }

  rebuildZombieGrid() {
    this.zgrid.clear();
    for (const zb of this.zombies.values()) {
      const k = Math.floor(zb.x / 4) * 1000 + Math.floor(zb.z / 4);
      let a = this.zgrid.get(k);
      if (!a) this.zgrid.set(k, (a = []));
      a.push(zb);
    }
  }

  zombiesNear(x, z, r) {
    const out = [];
    const minx = Math.floor((x - r) / 4), maxx = Math.floor((x + r) / 4);
    const minz = Math.floor((z - r) / 4), maxz = Math.floor((z + r) / 4);
    for (let gx = minx; gx <= maxx; gx++)
      for (let gz = minz; gz <= maxz; gz++) {
        const a = this.zgrid.get(gx * 1000 + gz);
        if (!a) continue;
        for (const zb of a) if (zb.hp > 0 && d2(zb.x, zb.z, x, z) <= (r + zb.radius) * (r + zb.radius)) out.push(zb);
      }
    return out;
  }

  nearestZombie(x, z, r, filter) {
    let best = null, bd = Infinity;
    for (const zb of this.zombiesNear(x, z, r)) {
      if (filter && !filter(zb)) continue;
      const dd = d2(zb.x, zb.z, x, z);
      if (dd < bd) { bd = dd; best = zb; }
    }
    return best;
  }

  // ------------------------------------------------------------------ players
  updatePlayers() {
    for (const p of this.players.values()) {
      const C = CLASSES[p.cls];
      if (p.dead) {
        if (this.time >= p.respawnAt) this.respawn(p);
        continue;
      }
      if (!p.connected) continue;
      for (const [k, b] of Object.entries(p.buffs)) if (b.until <= this.time) delete p.buffs[k];
      const ascend = p.buffs.ascend ? 2 : 1;
      p.mana = Math.min(p.maxMana, p.mana + (C.manaRegen + 0.12 * (p.level - 1)) * ascend * DT + p.fontRegen * DT);
      p.hp = Math.min(p.maxHp, p.hp + (C.hpRegen + 0.05 * (p.level - 1)) * DT);
      p.fontRegen = 0;
      if (p.buffs.blades && this.time >= p.buffs.blades.next) {
        const b = p.buffs.blades;
        b.next = this.time + SPELLS.spectral_blades.tick;
        for (const zb of this.zombiesNear(p.x, p.z, SPELLS.spectral_blades.radius)) this.damageZombie(zb, b.dmg * this.dmgMult(p), p, 'blade');
      }
      if (d2(p.x, p.z, HEART.x, HEART.z) < WELL_RANGE * WELL_RANGE) this.tryWell(p, false);
      if (p.quizActive && d2(p.x, p.z, this.npcs.librarian.x, this.npcs.librarian.z) > (NPC_RANGE + 3) ** 2) { p.quizCur = null; p.quizActive = false; }
    }
  }

  dmgMult(p) {
    let m = spellPower(p.level);
    if (p.buffs.empower) m *= 1 + p.buffs.empower.v;
    if (p.buffs.ascend) m *= 1 + p.buffs.ascend.v;
    if (p.ampUntil > this.time) m *= 1 + CONSTRUCTS.arcane_amplifier.amp;
    return m;
  }
  cdMult(p) {
    let m = 1;
    if (p.buffs.haste) m *= 1 - p.buffs.haste.v * 0.5;
    if (p.buffs.ascend) m *= 0.7;
    return m;
  }

  respawn(p) {
    p.dead = false;
    p.hp = p.maxHp;
    p.mana = p.maxMana;
    p.buffs = {};
    p.x = PLAYER_SPAWN.x + (Math.random() - 0.5) * 3;
    p.z = PLAYER_SPAWN.z + Math.random();
    p.tpSeq++;
    p.client?.send({ t: 'tp', x: p.x, z: p.z, q: p.tpSeq });
    this.ev('revive', p.id);
  }

  revive(p, hpFrac) {
    p.dead = false;
    p.hp = p.maxHp * hpFrac;
    this.ev('revive', p.id);
  }

  tryWell(p, manual) {
    if (p.dead) return;
    if (d2(p.x, p.z, HEART.x, HEART.z) > (WELL_RANGE + 0.6) ** 2) return;
    if (this.time < p.wellReady) {
      if (manual) p.client?.send({ t: 'toast', text: `The Well is recharging (${Math.ceil(p.wellReady - this.time)}s)` });
      return;
    }
    if (!manual && p.hp >= p.maxHp * 0.98 && p.mana >= p.maxMana * 0.98) return;
    p.hp = p.maxHp;
    p.mana = p.maxMana;
    for (const k of ['chill', 'poison']) delete p.buffs[k];
    p.wellReady = this.time + WELL_COOLDOWN;
    this.ev('well', p.id);
  }

  giveXp(p, amount) {
    if (p.level >= MAX_LEVEL || !(amount > 0)) return;
    p.xp += amount;
    const C = CLASSES[p.cls];
    let leveled = false;
    while (p.level < MAX_LEVEL && p.xp >= xpToNext(p.level)) {
      p.xp -= xpToNext(p.level);
      p.level++;
      p.maxHp += C.hpPerLvl;
      p.maxMana += C.manaPerLvl;
      leveled = true;
    }
    if (leveled) {
      if (!p.dead) { p.hp = p.maxHp; p.mana = p.maxMana; }
      this.ev('lvl', p.id, p.level);
      this.broadcastRoster();
    }
    if (p.level >= MAX_LEVEL) p.xp = 0;
  }

  hurtPlayer(p, amount, srcName) {
    if (p.dead || !p.connected || this.phase === 'over') return;
    let a = amount;
    const sh = p.buffs.shield;
    if (sh) {
      const absorbed = Math.min(sh.amt, a);
      sh.amt -= absorbed;
      a -= absorbed;
      if (sh.amt <= 0) delete p.buffs.shield;
    }
    if (a <= 0) { this.ev('d', r2(p.x), r2(p.z), 0, 4); return; }
    p.hp -= a;
    this.ev('d', r2(p.x), r2(p.z), Math.round(a), 1);
    if (p.hp <= 0) {
      if (p.inv.phoenix_charm > 0) {
        p.inv.phoenix_charm--;
        p.hp = p.maxHp * 0.5;
        this.ev('phoenix', p.id);
        return;
      }
      p.hp = 0;
      p.dead = true;
      p.buffs = {};
      p.quizCur = null;
      p.quizActive = false;
      p.stats.deaths++;
      p.respawnAt = this.time + Math.min(15, 6 + 0.3 * this.wave);
      this.ev('pdie', p.id);
      this.announce(`${p.name} has fallen${srcName ? ' to a ' + srcName : ''}! Respawning at the Well...`, 'bad');
    }
  }

  healPlayer(p, amount, src) {
    if (p.dead) return 0;
    const before = p.hp;
    p.hp = Math.min(p.maxHp, p.hp + amount);
    const done = p.hp - before;
    if (done > 0.5) {
      this.ev('d', r2(p.x), r2(p.z), Math.round(done), 2);
      if (src && src !== p) {
        src.stats.heal += done;
        this.giveXp(src, done / 10);
        src.gold += done / 40;
      } else if (src) src.stats.heal += done;
    }
    return done;
  }

  // ------------------------------------------------------------------ input handlers
  handleMove(p, msg) {
    if (p.dead) return;
    if (msg.q !== p.tpSeq) return; // stale until the client acknowledges a teleport
    let x = Number(msg.x), z = Number(msg.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    const elapsed = Math.max(0.05, this.time - p.lastMv);
    const C = CLASSES[p.cls];
    const maxStep = C.speed * 1.6 * (p.buffs.haste ? 1 + p.buffs.haste.v : 1) * elapsed + 0.6;
    const dx = x - p.x, dz = z - p.z, dl = Math.hypot(dx, dz);
    if (dl > maxStep) { x = p.x + (dx / dl) * maxStep; z = p.z + (dz / dl) * maxStep; }
    p.x = clamp(x, -PLAYER_BOUND, PLAYER_BOUND);
    p.z = clamp(z, -PLAYER_BOUND, PLAYER_BOUND);
    if (Number.isFinite(msg.f)) p.f = msg.f;
    p.lastMv = this.time;
  }

  face(p, x, z) { if (d2(p.x, p.z, x, z) > 0.01) p.f = Math.atan2(x - p.x, z - p.z); }

  toast(p, text) { p.client?.send({ t: 'toast', text }); }

  handleBasicAttack(p, msg) {
    if (p.dead || this.time < p.basicReady || this.phase === 'over') return;
    const zb = this.zombies.get(msg.tid);
    if (!zb || d2(zb.x, zb.z, p.x, p.z) > (BASIC_ATTACK.range + 2) ** 2) return;
    p.basicReady = this.time + BASIC_ATTACK.cd * this.cdMult(p);
    this.face(p, zb.x, zb.z);
    this.fireBolt(p, 'wand', zb, BASIC_ATTACK.dmg(p.level) * this.dmgMult(p) / spellPower(p.level), { speed: BASIC_ATTACK.speed });
    this.ev('cast', p.id, 'wand', r2(zb.x), r2(zb.z));
  }

  handleCast(p, msg) {
    if (p.dead || this.phase === 'over') return;
    const id = msg.s;
    if (typeof id !== 'string' || !Object.hasOwn(SPELLS, id) || !Object.hasOwn(p.spells, id)) return;
    const sp = SPELLS[id];
    const rank = p.spells[id];
    if ((p.cds[id] || 0) > this.time + 0.05) return;
    const mana = rankVal(sp.mana, rank);
    if (p.mana < mana) return this.toast(p, 'Not enough mana!');
    const range = sp.range || 0;
    let tx = Number(msg.x), tz = Number(msg.z);
    if (!Number.isFinite(tx) || !Number.isFinite(tz)) { tx = p.x; tz = p.z; }
    let target = null;
    if (sp.target === 'enemy') {
      target = this.zombies.get(msg.tid);
      if (!target || d2(target.x, target.z, p.x, p.z) > (range + 2.5) ** 2) {
        target = this.nearestZombie(tx, tz, 4, (zb) => d2(zb.x, zb.z, p.x, p.z) <= (range + 2) ** 2) || this.nearestZombie(p.x, p.z, range);
      }
      if (!target) return this.toast(p, 'No zombie in range');
      tx = target.x; tz = target.z;
    } else if (sp.target === 'ally') {
      target = this.players.get(msg.tid);
      if (!target || target.dead || !target.connected || d2(target.x, target.z, p.x, p.z) > (range + 2) ** 2) target = p;
      tx = target.x; tz = target.z;
    } else if (sp.target === 'self') {
      tx = p.x; tz = p.z;
    } else {
      const dx = tx - p.x, dz = tz - p.z, dl = Math.hypot(dx, dz);
      if (dl > range) { tx = p.x + (dx / dl) * range; tz = p.z + (dz / dl) * range; }
    }
    if (sp.target !== 'self') this.face(p, tx, tz);
    p.mana -= mana;
    p.cds[id] = this.time + rankVal(sp.cd, rank) * this.cdMult(p);
    this.ev('cast', p.id, id, r2(tx), r2(tz));
    this.executeSpell(p, id, sp, rank, target, tx, tz);
  }

  executeSpell(p, id, sp, rank, target, tx, tz) {
    const m = this.dmgMult(p);
    const R = (v) => rankVal(v, rank);
    switch (sp.kind) {
      case 'bolt':
        this.fireBolt(p, id, target, R(sp.dmg) * m, { speed: sp.speed, pierce: sp.pierce ? R(sp.pierce) : 0, slow: sp.slow, undead: sp.undeadBonus });
        break;
      case 'missiles': {
        const pool = this.zombiesNear(target.x, target.z, 7).sort((a, b) => d2(a.x, a.z, target.x, target.z) - d2(b.x, b.z, target.x, target.z));
        const n = R(sp.count);
        for (let i = 0; i < n; i++) {
          const t = pool.length ? pool[i % pool.length] : target;
          this.delayed.push({ at: this.time + i * 0.09, fn: () => { if (t.hp > 0) this.fireBolt(p, id, t, R(sp.dmg) * this.dmgMult(p), { speed: sp.speed, curve: (i % 2 ? 1 : -1) * (0.6 + Math.random()) }); } });
        }
        break;
      }
      case 'chain':
        this.chainLightning(p, target, R(sp.dmg) * m, R(sp.jumps), sp.jumpRange, p.x, p.z);
        break;
      case 'nova': {
        const rad = sp.radius;
        for (const zb of this.zombiesNear(p.x, p.z, rad)) {
          this.damageZombie(zb, R(sp.dmg) * m, p, id);
          if (sp.knock) this.knockback(zb, p.x, p.z, sp.knock);
        }
        if (sp.heal) for (const q of this.players.values()) if (!q.dead && q.connected && d2(q.x, q.z, p.x, p.z) <= rad * rad) this.healPlayer(q, R(sp.heal) * spellPower(p.level), p);
        this.ev('nova', r2(p.x), r2(p.z), rad, id);
        break;
      }
      case 'meteor':
        this.ev('meteor', r2(tx), r2(tz), sp.radius, sp.delay);
        this.delayed.push({ at: this.time + sp.delay, fn: () => {
          for (const zb of this.zombiesNear(tx, tz, sp.radius)) this.damageZombie(zb, R(sp.dmg) * this.dmgMult(p), p, id);
          this.addZone({ kind: 'burn', owner: p, x: tx, z: tz, r: sp.radius * 0.8, dur: sp.burn.dur, tick: 0.5, dmg: R(sp.burn.dps) * 0.5 * this.dmgMult(p) });
          this.ev('boom', r2(tx), r2(tz), sp.radius, 'meteor');
        } });
        break;
      case 'zone':
        this.addZone({ kind: id, owner: p, x: tx, z: tz, r: sp.radius, dur: R(sp.dur), tick: sp.tick, dmg: sp.dmg ? R(sp.dmg) * m : 0, heal: sp.heal ? R(sp.heal) * spellPower(p.level) : 0, slow: sp.slow, pull: sp.pull });
        break;
      case 'cone': {
        const dir = Math.atan2(tx - p.x, tz - p.z);
        const half = (sp.angle / 2) * (Math.PI / 180);
        for (const zb of this.zombiesNear(p.x, p.z, sp.range)) {
          const a = Math.atan2(zb.x - p.x, zb.z - p.z);
          let da = Math.abs(a - dir);
          if (da > Math.PI) da = Math.PI * 2 - da;
          if (da <= half + 0.15) {
            this.damageZombie(zb, R(sp.dmg) * m, p, id);
            this.burn(zb, R(sp.burn.dps) * m, sp.burn.dur, p);
          }
        }
        this.ev('cone', p.id, r2(dir), sp.range, sp.angle);
        break;
      }
      case 'heal':
        this.healPlayer(target, R(sp.heal) * spellPower(p.level) * (p.buffs.ascend ? 1 + p.buffs.ascend.v * 0.5 : 1), p);
        this.ev('healfx', target.id);
        break;
      case 'mend':
        this.repairArea(tx, tz, sp.radius, R(sp.repair) * spellPower(p.level), p, 0);
        this.ev('mendfx', r2(tx), r2(tz), sp.radius);
        break;
      case 'fortify':
        this.repairArea(tx, tz, sp.radius, R(sp.repair) * spellPower(p.level), p, sp.fortDur);
        this.ev('fortfx', r2(tx), r2(tz), sp.radius);
        break;
      case 'shield':
        target.buffs.shield = { until: this.time + sp.dur, amt: R(sp.absorb) * spellPower(p.level) };
        this.ev('buff', target.id, 'shield');
        break;
      case 'intervention': {
        for (const q of this.players.values()) {
          if (!q.connected) continue;
          if (q.dead) this.revive(q, 1);
          this.healPlayer(q, q.maxHp, p);
        }
        const pct = R(sp.repairPct);
        for (const f of this.fence) this.repairFence(f, f.maxHp * pct, p);
        this.heart.hp = Math.min(this.heart.maxHp, this.heart.hp + this.heart.maxHp * pct);
        this.heartDirty = true;
        this.ev('intervene', p.id);
        this.announce(`${p.name} calls down Divine Intervention!`, 'good');
        break;
      }
      case 'aura':
        for (const q of this.players.values()) {
          if (q.dead || !q.connected || d2(q.x, q.z, p.x, p.z) > sp.radius * sp.radius) continue;
          q.buffs[sp.buff] = { until: this.time + R(sp.dur), v: R(sp.value) };
          this.ev('buff', q.id, sp.buff);
        }
        this.ev('nova', r2(p.x), r2(p.z), sp.radius, id);
        break;
      case 'hex':
        for (const zb of this.zombiesNear(tx, tz, sp.radius)) {
          zb.hexUntil = this.time + sp.dur;
          zb.hexAmp = Math.max(zb.hexUntil > this.time ? zb.hexAmp : 0, R(sp.amp));
          zb.slowUntil = Math.max(zb.slowUntil, this.time + sp.dur);
          zb.slowPct = Math.max(zb.slowPct, sp.slow);
        }
        this.ev('nova', r2(tx), r2(tz), sp.radius, id);
        break;
      case 'manasurge':
        for (const q of this.players.values()) {
          if (q.dead || !q.connected || d2(q.x, q.z, p.x, p.z) > sp.radius * sp.radius) continue;
          q.mana = Math.min(q.maxMana, q.mana + R(sp.restore));
          this.ev('buff', q.id, 'mana');
        }
        this.ev('nova', r2(p.x), r2(p.z), sp.radius, id);
        break;
      case 'blades':
        p.buffs.blades = { until: this.time + sp.dur, dmg: R(sp.dmg), next: this.time };
        this.ev('buff', p.id, 'blades');
        break;
      case 'ascend':
        for (const q of this.players.values()) {
          if (q.dead || !q.connected || d2(q.x, q.z, p.x, p.z) > sp.radius * sp.radius) continue;
          q.buffs.ascend = { until: this.time + R(sp.dur), v: R(sp.value) };
          this.ev('buff', q.id, 'ascend');
        }
        for (const zb of this.zombiesNear(p.x, p.z, sp.pulseRadius)) this.damageZombie(zb, R(sp.pulse) * m, p, id);
        this.ev('nova', r2(p.x), r2(p.z), sp.pulseRadius, id);
        break;
      default:
    }
  }

  fireBolt(owner, kind, target, dmg, opts = {}) {
    const ox = owner.x, oz = owner.z;
    const pr = {
      id: this.nextId++, owner, kind, x: ox, z: oz, tid: target.id, tx: target.x, tz: target.z, speed: opts.speed || 20,
      dmg, pierce: opts.pierce || 0, slow: opts.slow, undead: opts.undead || 0, hit: new Set(), ttl: 2.2, enemy: false,
    };
    if (pr.pierce) {
      // piercing shards fly straight through the target and beyond
      const dx = target.x - ox, dz = target.z - oz, dl = Math.hypot(dx, dz) || 1;
      pr.dirx = dx / dl; pr.dirz = dz / dl;
      pr.tid = -1;
      pr.ttl = 16 / pr.speed;
    }
    this.projectiles.push(pr);
    this.ev('proj', pr.id, kind, r2(ox), r2(oz), pr.tid, r2(target.x), r2(target.z), pr.speed, opts.curve || 0);
    return pr;
  }

  chainLightning(src, first, dmg, jumps, jumpRange, ox, oz) {
    const pts = [r2(ox), r2(oz)];
    const hit = new Set();
    let cur = first, d = dmg;
    for (let j = 0; j <= jumps && cur; j++) {
      hit.add(cur.id);
      pts.push(r2(cur.x), r2(cur.z));
      this.damageZombie(cur, d, src, 'chain');
      d *= 0.85;
      const from = cur;
      cur = this.nearestZombie(from.x, from.z, jumpRange, (zb) => !hit.has(zb.id));
    }
    this.ev('chain', pts);
  }

  knockback(zb, fx, fz, dist) {
    if (ZOMBIES[zb.type].boss) dist *= 0.2;
    const dx = zb.x - fx, dz = zb.z - fz, dl = Math.hypot(dx, dz) || 1;
    let nx = zb.x + (dx / dl) * dist, nz = zb.z + (dz / dl) * dist;
    // never knock zombies through the palisade
    if (insideVillage(zb.x, zb.z) !== insideVillage(nx, nz)) return;
    [nx, nz] = resolveCollisions(this.staticIndex, nx, nz, Math.min(0.5, zb.radius));
    zb.x = clamp(nx, -WORLD_HALF, WORLD_HALF);
    zb.z = clamp(nz, -WORLD_HALF, WORLD_HALF);
  }

  burn(zb, dps, dur, owner) {
    if (zb.burnUntil < this.time || dps >= zb.burnDps) { zb.burnDps = dps; zb.burnOwner = owner; }
    zb.burnUntil = Math.max(zb.burnUntil, this.time + dur);
  }

  addZone(z) {
    z.id = this.nextId++;
    z.until = this.time + z.dur;
    z.next = this.time;
    this.zones.push(z);
    this.ev('zone', z.id, z.kind, r2(z.x), r2(z.z), z.r, z.dur);
  }

  repairArea(x, z, rad, amount, p, fortDur) {
    let any = false;
    for (const f of this.fence) {
      if (segDist(x, z, ...this.segEnds(f)) > rad) continue;
      any = true;
      this.repairFence(f, amount, p);
      if (fortDur) { f.fortUntil = this.time + fortDur; this.fenceDirty.add(f.id); }
    }
    for (const c of this.constructs.values()) {
      if (d2(c.x, c.z, x, z) > (rad + 0.8) ** 2) continue;
      any = true;
      this.repairConstruct(c, amount, p);
      if (fortDur) c.fortUntil = this.time + fortDur;
    }
    if (d2(x, z, HEART.x, HEART.z) < (rad + HEART.r) ** 2) {
      any = true;
      const before = this.heart.hp;
      this.heart.hp = Math.min(this.heart.maxHp, this.heart.hp + amount * 0.5);
      this.heartDirty = true;
      if (p) this.creditRepair(p, this.heart.hp - before);
    }
    return any;
  }

  // Is the palisade open where a mover crossed it between (ax,az) and (bx,bz)? Gates count for wizards only.
  crossingOpen(ax, az, bx, bz, wizard) {
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    let seg = null, bd = Infinity;
    for (const f of this.fence) {
      if (Math.abs(f.x - mx) > 3 || Math.abs(f.z - mz) > 3) continue;
      const d = segDist(mx, mz, ...this.segEnds(f));
      if (d < bd) { bd = d; seg = f; }
    }
    return !seg || seg.broken || (wizard && seg.gate);
  }

  segEnds(f) {
    return f.axis === 'x' ? [f.x - 1, f.z, f.x + 1, f.z] : [f.x, f.z - 1, f.x, f.z + 1];
  }

  creditRepair(p, done) {
    if (done <= 0.5) return;
    p.stats.repair += done;
    this.giveXp(p, done / 12);
    p.gold += done / 25;
  }

  repairFence(f, amount, p) {
    const before = f.hp;
    f.hp = Math.min(f.maxHp, f.hp + amount);
    if (f.hp === before) return;
    if (p) {
      this.creditRepair(p, f.hp - before);
      this.ev('d', f.x, f.z, Math.round(f.hp - before), 3);
    }
    if (f.broken && f.hp >= f.maxHp * FENCE_INTACT_RATIO) {
      f.broken = false;
      this.navDirty = true;
    }
    this.fenceDirty.add(f.id);
  }

  damageFence(f, amount, src) {
    if (f.broken) return;
    if (f.fortUntil > this.time) amount *= 0.5;
    f.hp -= amount;
    f.lastHit = this.time;
    this.fenceDirty.add(f.id);
    if (f.hp <= 0) {
      f.hp = 0;
      f.broken = true;
      this.navDirty = true;
      this.ev('fbreak', f.id);
      if (this.time > this.breachMsgAt) {
        this.breachMsgAt = this.time + 4;
        this.announce(`The ${f.gate ? 'gate' : 'palisade'} has been breached in the ${directionName(f.x, f.z)}!`, 'bad');
      }
    }
  }

  damageHeart(amount) {
    if (this.phase === 'over') return;
    this.heart.hp -= amount * HEART_DMG_MULT;
    this.heart.lastHit = this.time;
    this.heartDirty = true;
    if (this.time > (this.heartMsgAt || 0)) {
      this.heartMsgAt = this.time + 8;
      this.announce('The Well of Renewal is under attack!', 'bad');
    }
  }

  handleUse(p, msg) {
    if (p.dead || this.phase === 'over') return;
    const it = msg.item;
    if (typeof it !== 'string' || !Object.hasOwn(ITEMS, it) || ITEMS[it].material || ITEMS[it].passive) return;
    if (!(p.inv[it] > 0)) return this.toast(p, `You have no ${ITEMS[it].name}. Buy some from the Trader.`);
    if (this.time < (p.itemReady || 0)) return;
    let used = false;
    if (it === 'health_potion') {
      if (p.hp >= p.maxHp) return this.toast(p, 'Already at full health');
      this.healPlayer(p, p.maxHp * 0.5, p);
      used = true;
    } else if (it === 'mana_potion') {
      if (p.mana >= p.maxMana) return this.toast(p, 'Mana already full');
      p.mana = Math.min(p.maxMana, p.mana + p.maxMana * 0.5);
      this.ev('buff', p.id, 'mana');
      used = true;
    } else if (it === 'repair_kit') {
      const near = this.fence.filter((f) => segDist(p.x, p.z, ...this.segEnds(f)) < 6 && f.hp < f.maxHp).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp).slice(0, 3);
      if (!near.length) return this.toast(p, 'No damaged fence within 6m');
      for (const f of near) { this.repairFence(f, 250, p); this.ev('mendfx', f.x, f.z, 1.5); }
      used = true;
    } else if (it === 'fire_bomb') {
      let tx = Number(msg.x), tz = Number(msg.z);
      if (!Number.isFinite(tx) || !Number.isFinite(tz)) { const zb = this.nearestZombie(p.x, p.z, 12); if (!zb) return this.toast(p, 'No target'); tx = zb.x; tz = zb.z; }
      const dx = tx - p.x, dz = tz - p.z, dl = Math.hypot(dx, dz);
      if (dl > 12) { tx = p.x + (dx / dl) * 12; tz = p.z + (dz / dl) * 12; }
      const dmg = 60 + 8 * this.wave;
      this.face(p, tx, tz);
      this.ev('bomb', p.id, r2(tx), r2(tz));
      this.delayed.push({ at: this.time + 0.6, fn: () => {
        for (const zb of this.zombiesNear(tx, tz, 3.5)) this.damageZombie(zb, dmg, p, 'bomb');
        this.addZone({ kind: 'burn', owner: p, x: tx, z: tz, r: 2.8, dur: 2.5, tick: 0.5, dmg: dmg * 0.08 });
        this.ev('boom', r2(tx), r2(tz), 3.5, 'bomb');
      } });
      used = true;
    } else if (it === 'iron_bands') {
      const near = this.fence.filter((f) => !f.reinforced && segDist(p.x, p.z, ...this.segEnds(f)) < 5);
      if (!near.length) return this.toast(p, 'Stand next to un-reinforced fence sections (within 5m)');
      for (const f of near) {
        f.reinforced = true;
        f.maxHp = Math.round(f.baseMax * 1.5);
        f.hp = f.maxHp;
        if (f.broken) { f.broken = false; this.navDirty = true; }
        this.fenceDirty.add(f.id);
        this.ev('fortfx', f.x, f.z, 1.2);
      }
      this.toast(p, `Reinforced ${near.length} fence sections`);
      used = true;
    }
    if (used) { p.inv[it]--; p.itemReady = this.time + 0.4; }
  }

  nearNpc(p, key) {
    const n = this.npcs[key];
    return d2(p.x, p.z, n.x, n.z) <= (NPC_RANGE + 2.5) ** 2;
  }

  handleBuy(p, msg) {
    if (typeof msg.item !== 'string' || !Object.hasOwn(ITEMS, msg.item)) return;
    const it = ITEMS[msg.item];
    if (!this.nearNpc(p, 'trader')) return this.toast(p, 'Visit Gareth the Trader to buy items');
    const qty = clamp(Math.floor(Number(msg.qty) || 1), 1, 10);
    const have = msg.item === 'wood' ? p.wood : msg.item === 'stone' ? p.stone : p.inv[msg.item] || 0;
    const n = Math.min(qty, it.max - have, Math.floor(p.gold / it.price));
    if (have >= it.max) return this.toast(p, `You can carry at most ${it.max}`);
    if (n <= 0) return this.toast(p, 'Not enough gold');
    p.gold -= n * it.price;
    if (msg.item === 'wood') p.wood += n;
    else if (msg.item === 'stone') p.stone += n;
    else p.inv[msg.item] = have + n;
    p.client?.send({ t: 'bought', item: msg.item, n });
  }

  handleBuySpell(p, msg) {
    if (typeof msg.id !== 'string' || !Object.hasOwn(SPELLS, msg.id)) return;
    const sp = SPELLS[msg.id];
    if (sp.cls !== p.cls) return;
    if (!this.nearNpc(p, 'arcanist')) return this.toast(p, 'Visit Mystra the Arcanist to buy spellbooks');
    const rank = p.spells[msg.id] || 0;
    if (rank >= 3) return;
    if (rank === 0 && p.level < sp.level) return this.toast(p, `Requires level ${sp.level}`);
    const cost = rank === 0 ? sp.price : spellUpgradeCost(msg.id, rank);
    if (rank > 0 && p.level < sp.level + rank * 3) return this.toast(p, `Rank ${rank + 1} requires level ${sp.level + rank * 3}`);
    if (p.gold < cost) return this.toast(p, 'Not enough gold');
    p.gold -= cost;
    p.spells[msg.id] = rank + 1;
    p.client?.send({ t: 'learned', id: msg.id, rank: rank + 1 });
  }

  // Testing shortcuts, only when the server runs with DEV_COMMANDS=1.
  handleDev(p, msg) {
    if (process.env.DEV_COMMANDS !== '1') return;
    if (msg.cmd === 'wave') {
      for (const z of [...this.zombies.values()]) this.zombies.delete(z.id);
      this.spawnQueue = [];
      this.wave = Math.max(0, Math.min(TOTAL_WAVES, Number(msg.n) || 1) - 1);
      this.phase = 'break';
      this.timer = 2;
    } else if (msg.cmd === 'rich') {
      p.gold += 5000; p.wood += 30; p.stone += 30;
    } else if (msg.cmd === 'level') {
      const target = Math.min(MAX_LEVEL, Number(msg.n) || 10);
      while (p.level < target) this.giveXp(p, xpToNext(p.level) - p.xp + 0.5);
    } else if (msg.cmd === 'spells') {
      for (const id of Object.keys(SPELLS)) if (SPELLS[id].cls === p.cls) p.spells[id] = 3;
    } else if (msg.cmd === 'break') {
      const f = this.fence[Number(msg.n) || 0];
      if (f) this.damageFence(f, f.hp + 1, null);
    }
  }

  handleChat(p, msg) {
    if (typeof msg.text !== 'string') return;
    const text = msg.text.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 120);
    if (!text) return;
    if (this.time < (p.chatReady || 0)) return;
    p.chatReady = this.time + 0.6;
    this.broadcast({ t: 'chat', from: p.name, cls: p.cls, text });
  }

  // ------------------------------------------------------------------ constructs
  conInfo(c) { return { id: c.id, kind: c.kind, owner: c.owner, x: r2(c.x), z: r2(c.z), rot: r2(c.rot), hp: Math.round(c.hp), maxHp: c.maxHp }; }

  handleBuild(p, msg) {
    if (p.dead || this.phase === 'over') return;
    if (typeof msg.kind !== 'string' || !Object.hasOwn(CONSTRUCTS, msg.kind)) return;
    const d = CONSTRUCTS[msg.kind];
    if (d.cls !== p.cls) return;
    const x = Number(msg.x), z = Number(msg.z), rot = Number(msg.rot) || 0;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    if (d2(x, z, p.x, p.z) > (BUILD_RANGE + 1) ** 2) return this.toast(p, 'Too far away to build there');
    const mine = [...this.constructs.values()].filter((c) => c.owner === p.id).length;
    if (mine >= MAX_CONSTRUCTS_PER_PLAYER) return this.toast(p, `You can maintain at most ${MAX_CONSTRUCTS_PER_PLAYER} constructs`);
    if (p.wood < d.wood || p.stone < d.stone) return this.toast(p, `Needs ${d.wood} timber and ${d.stone} stone (buy from the Trader)`);
    if (p.mana < d.mana) return this.toast(p, `Needs ${d.mana} mana to enchant`);
    const bad = placementError({ staticIndex: this.staticIndex, fenceShapes: this.fenceShapes, npcs: Object.values(this.npcs), constructs: this.constructs.values() }, msg.kind, x, z, rot);
    if (bad) return this.toast(p, bad);
    p.wood -= d.wood;
    p.stone -= d.stone;
    p.mana -= d.mana;
    const c = { id: this.nextId++, kind: msg.kind, owner: p.id, x, z, rot, hp: d.hp, maxHp: d.hp, next: this.time + 1, uses: d.uses || 0, fortUntil: 0, born: this.time };
    this.constructs.set(c.id, c);
    c.shape = constructShape(c.kind, x, z, rot, c.id);
    if (c.shape) this.dynIndex.add(c.shape);
    if (d.wall) this.markWall(c, c.id);
    this.face(p, x, z);
    this.broadcast({ t: 'con+', c: this.conInfo(c) });
    this.ev('cast', p.id, 'build', r2(x), r2(z));
  }

  markWall(c, val) {
    const d = CONSTRUCTS[c.kind];
    const shape = { type: 'box', x: c.x, z: c.z, hx: d.halfLen, hz: 0.45, rot: c.rot };
    for (let ix = cellOf(c.x - 3); ix <= cellOf(c.x + 3); ix++)
      for (let iz = cellOf(c.z - 3); iz <= cellOf(c.z + 3); iz++) {
        const i = this.grid.idx(ix, iz);
        if (shapeContains(shape, cellCenter(ix), cellCenter(iz), 0.35)) {
          if (val >= 0) this.grid.dyn[i] = val;
          else if (this.grid.dyn[i] === c.id) this.grid.dyn[i] = -1;
        }
      }
    this.navDirty = true;
  }

  damageConstruct(c, amount) {
    if (c.fortUntil > this.time) amount *= 0.5;
    c.hp -= amount;
    c.lastHit = this.time;
    this.conDirty.add(c.id);
    if (c.hp <= 0) this.destroyConstruct(c);
  }

  repairConstruct(c, amount, p) {
    const before = c.hp;
    c.hp = Math.min(c.maxHp, c.hp + amount);
    if (c.hp > before) { this.conDirty.add(c.id); if (p) this.creditRepair(p, c.hp - before); }
  }

  destroyConstruct(c) {
    this.constructs.delete(c.id);
    if (c.shape) this.dynIndex.remove(c.shape);
    if (CONSTRUCTS[c.kind].wall) this.markWall(c, -1);
    this.broadcast({ t: 'con-', id: c.id });
    this.ev('boom', r2(c.x), r2(c.z), 1.5, 'debris');
  }

  updateConstructs() {
    for (const c of this.constructs.values()) {
      const d = CONSTRUCTS[c.kind];
      const owner = this.players.get(c.owner);
      const lvl = owner ? owner.level : 1;
      let amp = 1;
      let rateAmp = 1;
      for (const a of this.constructs.values()) {
        if (a.kind === 'arcane_amplifier' && a !== c && d2(a.x, a.z, c.x, c.z) < CONSTRUCTS.arcane_amplifier.range ** 2) { amp = 1 + CONSTRUCTS.arcane_amplifier.amp; rateAmp = 1 + CONSTRUCTS.arcane_amplifier.rateAmp; break; }
      }
      const power = spellPower(lvl) * amp * (owner?.buffs.empower ? 1 + owner.buffs.empower.v : 1);
      if (this.time < c.born + 0.8) continue; // enchanting
      switch (c.kind) {
        case 'flame_turret':
          if (this.time >= c.next) {
            const t = this.nearestZombie(c.x, c.z, d.range);
            if (t) {
              c.next = this.time + d.rate / rateAmp;
              this.fireBolt({ x: c.x, z: c.z, id: -c.id, owner: c.owner, construct: c }, 'turret', t, d.dmg * power, { speed: 20 });
            } else c.next = this.time + 0.25;
          }
          break;
        case 'storm_spire':
          if (this.time >= c.next) {
            const t = this.nearestZombie(c.x, c.z, d.range);
            if (t) {
              c.next = this.time + d.rate / rateAmp;
              this.chainLightning({ construct: c, owner: c.owner }, t, d.dmg * power, d.jumps, 6, c.x, c.z);
            } else c.next = this.time + 0.3;
          }
          break;
        case 'ember_trap':
          if (this.time >= c.next) {
            c.next = this.time + d.rate;
            for (const zb of this.zombiesNear(c.x, c.z, d.radius)) {
              if (ZOMBIES[zb.type].ghost) continue;
              this.damageZombie(zb, d.dmg * power, { construct: c, owner: c.owner }, 'trap');
              zb.slowUntil = Math.max(zb.slowUntil, this.time + 0.8);
              zb.slowPct = Math.max(zb.slowPct, d.slow);
              c.uses--;
              c.hp = (c.uses / d.uses) * c.maxHp;
              this.conDirty.add(c.id);
            }
            if (c.uses <= 0) this.destroyConstruct(c);
          }
          break;
        case 'healing_shrine':
          if (this.time >= c.next) {
            c.next = this.time + 0.5;
            for (const q of this.players.values()) if (!q.dead && q.connected && d2(q.x, q.z, c.x, c.z) < d.range * d.range) this.healPlayer(q, d.heal * 0.5 * spellPower(lvl), null);
          }
          break;
        case 'mending_totem':
          if (this.time >= c.next) {
            c.next = this.time + 0.5;
            const amt = d.repair * 0.5 * spellPower(lvl);
            const targets = [];
            for (const f of this.fence) if (f.hp < f.maxHp && segDist(c.x, c.z, ...this.segEnds(f)) < d.range) targets.push({ ratio: f.hp / f.maxHp, f });
            for (const o of this.constructs.values()) if (o !== c && o.hp < o.maxHp && !CONSTRUCTS[o.kind].trap && d2(o.x, o.z, c.x, c.z) < d.range * d.range) targets.push({ ratio: o.hp / o.maxHp, o });
            targets.sort((a, b) => a.ratio - b.ratio);
            for (const t of targets.slice(0, 3)) {
              if (t.f) this.repairFence(t.f, amt, null);
              else this.repairConstruct(t.o, amt, null);
            }
          }
          break;
        case 'frost_obelisk':
          for (const zb of this.zombiesNear(c.x, c.z, d.range)) {
            zb.chillUntil = this.time + 0.3;
            zb.chillPct = d.slow;
          }
          if (this.time >= c.next) {
            c.next = this.time + 0.5;
            for (const zb of this.zombiesNear(c.x, c.z, d.range)) this.damageZombie(zb, d.dmg * 0.5 * power, { construct: c, owner: c.owner }, 'frost', true);
          }
          break;
        case 'mana_font':
          for (const q of this.players.values()) if (!q.dead && d2(q.x, q.z, c.x, c.z) < d.range * d.range) q.fontRegen = Math.max(q.fontRegen, d.regen);
          break;
        case 'arcane_amplifier':
          for (const q of this.players.values()) if (!q.dead && d2(q.x, q.z, c.x, c.z) < d.range * d.range) q.ampUntil = this.time + 0.3;
          break;
        default:
      }
    }
  }

  // ------------------------------------------------------------------ zombies
  spawnZombie(type, x, z, opts = {}) {
    const def = ZOMBIES[type];
    const P = this.partySize();
    const w = Math.max(1, this.wave);
    let hp = def.boss ? def.hp * (0.6 + 0.4 * P) : def.hp * waveHpMult(w, P);
    if (opts.elite) hp *= 3.2;
    const dm = waveDmgMult(w) * (opts.elite ? 1.4 : 1);
    const zb = {
      id: this.nextId++, type, ti: ZT_INDEX[type], x, z, f: Math.atan2(-x, -z), hp, maxHp: hp,
      dmg: def.dmg * (def.boss ? 1 + 0.02 * (w - 1) : dm), fenceDmg: def.fenceDmg * (def.boss ? 1 : dm),
      speed: def.speed * waveSpeedMult(w) * (0.9 + Math.random() * 0.2), radius: def.radius * (opts.elite ? 1.2 : 1),
      elite: !!opts.elite, atkReady: this.time + 0.6, think: 0, tgt: null, state: 0,
      slowUntil: 0, slowPct: 0, chillUntil: 0, chillPct: 0, rootUntil: 0, hexUntil: 0, hexAmp: 0, burnUntil: 0, burnDps: 0, burnNext: 0, burnOwner: null,
      abil: { slam: this.time + 5, spit: this.time + 3, summon: this.time + 8, bolt: this.time + 2, nova: this.time + 7 },
      stuck: 0, lx: x, lz: z, summoned: !!opts.summoned, telegraph: null, enraged: false,
    };
    this.zombies.set(zb.id, zb);
    return zb;
  }

  damageZombie(zb, amount, src, kind, quiet) {
    if (zb.hp <= 0) return;
    let a = amount;
    if (zb.hexUntil > this.time) a *= 1 + zb.hexAmp;
    if (kind === 'holy_smite') a *= 1 + (SPELLS.holy_smite.undeadBonus || 0) * (ZOMBIES[zb.type].boss ? 2 : 1);
    zb.hp -= a;
    const player = src && (src.cls ? src : src.owner ? this.players.get(src.owner) : null);
    if (player) player.stats.dmg += a;
    if (!quiet) this.ev('d', r2(zb.x), r2(zb.z + 0.01), Math.round(a), 0);
    if (zb.hp <= 0) this.killZombie(zb, player);
  }

  killZombie(zb, killer) {
    zb.hp = 0;
    this.zombies.delete(zb.id);
    const def = ZOMBIES[zb.type];
    this.ev('zdie', zb.id, r2(zb.x), r2(zb.z));
    if (def.explode) this.explode(zb);
    if (zb.summoned && !killer) return;
    const P = this.partySize();
    const rs = partyRewardScale(P);
    const mult = zb.elite ? 3 : 1;
    const xp = def.xp * waveXpMult(this.wave) * rs * mult * (zb.summoned ? 0.5 : 1);
    const gold = def.gold * (1 + 0.04 * (this.wave - 1)) * (P === 1 ? 1.4 : P === 2 ? 1.15 : 1) * mult * (zb.summoned ? 0.5 : 1);
    this.stats.kills++;
    for (const p of this.players.values()) {
      if (!p.connected && p !== killer) continue;
      this.giveXp(p, xp);
      if (def.boss) p.gold += gold;
      else if (p === killer) p.gold += gold;
      else p.gold += gold * 0.4;
    }
    if (killer) killer.stats.kills++;
    if (def.boss) this.announce(`${def.name} has been destroyed! Everyone receives ${Math.round(gold)} gold.`, 'good');
  }

  explode(zb) {
    const def = ZOMBIES[zb.type];
    const r = def.explode;
    this.ev('boom', r2(zb.x), r2(zb.z), r, 'acid');
    for (const p of this.players.values()) if (!p.dead && d2(p.x, p.z, zb.x, zb.z) < r * r) this.hurtPlayer(p, zb.dmg, def.name);
    for (const f of this.fence) if (segDist(zb.x, zb.z, ...this.segEnds(f)) < r) this.damageFence(f, zb.fenceDmg, zb);
    for (const c of [...this.constructs.values()]) if (d2(c.x, c.z, zb.x, zb.z) < (r + 0.5) ** 2) this.damageConstruct(c, zb.fenceDmg * 0.6);
    if (d2(zb.x, zb.z, HEART.x, HEART.z) < (r + HEART.r) ** 2) this.damageHeart(zb.fenceDmg * 0.5);
  }

  zombieSpeed(zb) {
    let slow = 0;
    if (zb.slowUntil > this.time) slow = Math.max(slow, zb.slowPct);
    if (zb.chillUntil > this.time) slow = Math.max(slow, zb.chillPct);
    const def = ZOMBIES[zb.type];
    if (def.boss) slow *= 0.5;
    return zb.speed * (1 - slow) * (zb.enraged ? 1.25 : 1);
  }

  updateZombies() {
    const t = this.time;
    const alivePlayers = [...this.players.values()].filter((p) => !p.dead && p.connected);
    for (const zb of [...this.zombies.values()]) {
      if (zb.hp <= 0) continue;
      const def = ZOMBIES[zb.type];
      // burning
      if (zb.burnUntil > t && t >= zb.burnNext) {
        zb.burnNext = t + 0.5;
        this.damageZombie(zb, zb.burnDps * 0.5, zb.burnOwner, 'burn');
        if (zb.hp <= 0) continue;
      }
      if (def.boss) { this.bossAbilities(zb, alivePlayers); if (zb.hp <= 0) continue; }
      if (zb.telegraph) { zb.state = 1; continue; }

      // ---- choose a target
      if (t >= zb.think) {
        zb.think = t + 0.25 + Math.random() * 0.15;
        zb.tgt = this.pickTarget(zb, def, alivePlayers);
      }
      const rooted = zb.rootUntil > t;
      let speed = rooted ? 0 : this.zombieSpeed(zb);
      let mx = 0, mz = 0, attack = null;
      const tg = zb.tgt;
      if (tg && tg.kind === 'p') {
        const p = this.players.get(tg.id);
        if (!p || p.dead || !p.connected) { zb.tgt = null; zb.think = 0; continue; }
        const dist = Math.hypot(p.x - zb.x, p.z - zb.z);
        if (dist <= def.range + PLAYER_R) attack = { kind: 'p', obj: p, x: p.x, z: p.z };
        else [mx, mz] = this.steerTo(zb, p.x, p.z, this.playerFlows.get(p.id)?.next, def.ghost);
      } else if (tg && tg.kind === 'c') {
        const c = this.constructs.get(tg.id);
        if (!c) { zb.tgt = null; zb.think = 0; continue; }
        const dist = Math.hypot(c.x - zb.x, c.z - zb.z) - CONSTRUCTS[c.kind].radius;
        if (dist <= def.range + 0.2 || (c.shape && shapeDist(c.shape, zb.x, zb.z) <= def.range + 0.1)) attack = { kind: 'c', obj: c, x: c.x, z: c.z };
        else { mx = c.x - zb.x; mz = c.z - zb.z; }
      } else if (def.ghost) {
        const dist = Math.hypot(zb.x - HEART.x, zb.z - HEART.z) - HEART.r;
        if (dist <= def.range) attack = { kind: 'h', x: HEART.x, z: HEART.z };
        else { mx = HEART.x - zb.x; mz = HEART.z - zb.z; }
      } else {
        // follow the village flow field toward the Well, smashing anything in the way
        const res = this.followFlow(zb, def);
        if (res.attack) attack = res.attack;
        else { mx = res.mx; mz = res.mz; }
      }

      if (attack) {
        zb.state = 1;
        zb.f = Math.atan2(attack.x - zb.x, attack.z - zb.z);
        if (t >= zb.atkReady) {
          zb.atkReady = t + def.atkRate * (zb.enraged ? 0.75 : 1);
          this.zombieAttack(zb, def, attack);
        }
        speed = 0;
      } else {
        zb.state = 0;
      }
      if (speed > 0 && (mx || mz)) {
        const ml = Math.hypot(mx, mz);
        const step = Math.min(speed * DT, ml);
        zb.x += (mx / ml) * step;
        zb.z += (mz / ml) * step;
        const want = Math.atan2(mx, mz);
        let da = want - zb.f;
        while (da > Math.PI) da -= Math.PI * 2;
        while (da < -Math.PI) da += Math.PI * 2;
        zb.f += da * Math.min(1, DT * 8);
      }
      // separation
      for (const o of this.zombiesNear(zb.x, zb.z, zb.radius + 0.2)) {
        if (o === zb) continue;
        const dx = zb.x - o.x, dz = zb.z - o.z;
        const dd = Math.hypot(dx, dz) || 0.01;
        const need = (zb.radius + o.radius) * 0.85;
        if (dd < need) {
          const push = (need - dd) * 0.5;
          zb.x += (dx / dd) * push;
          zb.z += (dz / dd) * push;
        }
      }
      if (!def.ghost) {
        const cr = Math.min(0.5, zb.radius);
        [zb.x, zb.z] = resolveCollisions(this.staticIndex, zb.x, zb.z, cr);
        [zb.x, zb.z] = resolveCollisions(this.dynIndex, zb.x, zb.z, zb.radius * 0.9, (s) => (s.seg !== undefined ? this.fence[s.seg].broken : false));
        // crowding can shove a zombie past the middle of a fence section; only broken sections may be crossed
        if (insideVillage(zb.x, zb.z) !== insideVillage(zb.lx, zb.lz) && !this.crossingOpen(zb.lx, zb.lz, zb.x, zb.z, false)) { zb.x = zb.lx; zb.z = zb.lz; }
      }
      zb.x = clamp(zb.x, -WORLD_HALF + 0.5, WORLD_HALF - 0.5);
      zb.z = clamp(zb.z, -WORLD_HALF + 0.5, WORLD_HALF - 0.5);
      // unstick: if a zombie barely moved while trying to walk, nudge it sideways
      if (zb.state === 0 && speed > 0) {
        if (d2(zb.x, zb.z, zb.lx, zb.lz) < 0.0004) zb.stuck += DT; else zb.stuck = Math.max(0, zb.stuck - DT);
        if (zb.stuck > 1.2) {
          zb.stuck = 0;
          zb.x += (Math.random() - 0.5) * 0.8;
          zb.z += (Math.random() - 0.5) * 0.8;
          zb.tgt = null;
        }
      }
      zb.lx = zb.x; zb.lz = zb.z;
    }
  }

  pickTarget(zb, def, players) {
    const inside = insideVillage(zb.x, zb.z);
    const aggro = def.boss ? 12 : def.ranged ? def.range + 1 : 8;
    // keep hitting what we are already hitting
    let best = null, bd = aggro * aggro;
    for (const p of players) {
      if (!def.ghost && !def.ranged && insideVillage(p.x, p.z) !== inside) continue;
      const dd = d2(p.x, p.z, zb.x, zb.z);
      if (dd < bd) { bd = dd; best = p; }
    }
    if (best) return { kind: 'p', id: best.id };
    if (def.ghost) {
      let gb = null, gd = 22 * 22;
      for (const p of players) { const dd = d2(p.x, p.z, zb.x, zb.z); if (dd < gd) { gd = dd; gb = p; } }
      return gb ? { kind: 'p', id: gb.id } : null;
    }
    let cb = null, cd = 3.5 * 3.5;
    for (const c of this.constructs.values()) {
      if (CONSTRUCTS[c.kind].trap) continue;
      if (insideVillage(c.x, c.z) !== inside) continue;
      const dd = d2(c.x, c.z, zb.x, zb.z);
      if (dd < cd) { cd = dd; cb = c; }
    }
    if (cb) return { kind: 'c', id: cb.id };
    return null;
  }

  // Move toward (x,z): straight when close or no flow field, else via the flow field.
  steerTo(zb, x, z, next, ghost) {
    const dx = x - zb.x, dz = z - zb.z;
    if (ghost || !next || dx * dx + dz * dz < 9) return [dx, dz];
    const ci = this.grid.idx(cellOf(zb.x), cellOf(zb.z));
    let n1 = next[ci];
    if (n1 < 0) return [dx, dz];
    const f1 = this.grid.fence[n1];
    if (f1 >= 0 && !this.fence[f1].broken) return [dx, dz];
    const n2 = next[n1];
    const tgt = n2 >= 0 && !(this.grid.fence[n2] >= 0 && !this.fence[this.grid.fence[n2]].broken) ? n2 : n1;
    return [cellCenter(tgt % GRID_N) - zb.x, cellCenter((tgt / GRID_N) | 0) - zb.z];
  }

  followFlow(zb, def) {
    const g = this.grid;
    const hx = HEART.x - zb.x, hz = HEART.z - zb.z;
    const hd = Math.hypot(hx, hz) - HEART.r;
    if (hd <= def.range + 0.1) return { attack: { kind: 'h', x: HEART.x, z: HEART.z } };
    if (!this.flowNext) return { mx: hx, mz: hz };
    const ci = g.idx(cellOf(zb.x), cellOf(zb.z));
    let cur = ci;
    // look a few cells ahead for an intact obstacle (spitters attack from range)
    const look = def.ranged ? 6 : 1;
    for (let k = 0; k < look; k++) {
      const n = this.flowNext[cur];
      if (n < 0) break;
      const fs = g.fence[n];
      if (fs >= 0 && !this.fence[fs].broken) {
        const f = this.fence[fs];
        const shape = this.fenceShapes[fs];
        const dist = shapeDist(shape, zb.x, zb.z) - zb.radius;
        const [cx, cz] = shapeClosest(shape, zb.x, zb.z);
        if (dist <= def.range) return { attack: { kind: 'f', obj: f, x: cx, z: cz } };
        if (k === 0) return { mx: cx - zb.x, mz: cz - zb.z };
        break;
      }
      const cw = g.dyn[n];
      if (cw >= 0 && this.constructs.has(cw)) {
        const c = this.constructs.get(cw);
        const dist = shapeDist(c.shape, zb.x, zb.z) - zb.radius;
        if (dist <= def.range) return { attack: { kind: 'c', obj: c, x: c.x, z: c.z } };
        if (k === 0) { const [cx, cz] = shapeClosest(c.shape, zb.x, zb.z); return { mx: cx - zb.x, mz: cz - zb.z }; }
        break;
      }
      cur = n;
    }
    const n1 = this.flowNext[ci];
    if (n1 < 0) {
      if (this.flowDist && this.flowDist[ci] === 0) return { mx: hx, mz: hz };
      // in an unreachable/blocked cell: head for the nearest reachable neighbour
      let best = -1, bd = Infinity;
      const cx0 = ci % GRID_N, cz0 = (ci / GRID_N) | 0;
      for (const [dx, dz] of DIRS8) {
        const ni = (cz0 + dz) * GRID_N + cx0 + dx;
        if (ni >= 0 && ni < this.flowDist.length && this.flowDist[ni] < bd) { bd = this.flowDist[ni]; best = ni; }
      }
      if (best < 0) return { mx: hx, mz: hz };
      return { mx: cellCenter(best % GRID_N) - zb.x, mz: cellCenter((best / GRID_N) | 0) - zb.z };
    }
    const n2 = this.flowNext[n1];
    let tgt = n1;
    if (n2 >= 0 && !(g.fence[n2] >= 0 && !this.fence[g.fence[n2]].broken) && !(g.dyn[n2] >= 0)) tgt = n2;
    return { mx: cellCenter(tgt % GRID_N) - zb.x, mz: cellCenter((tgt / GRID_N) | 0) - zb.z };
  }

  zombieAttack(zb, def, a) {
    this.ev('za', zb.id);
    if (def.explode) { this.killZombie(zb, null); return; }
    if (def.ranged) {
      // lob acid at the target
      this.enemyShot(zb, a, 12, zb.dmg, def.fenceDmg ? zb.fenceDmg : 0, 'acid');
      return;
    }
    if (a.kind === 'p') this.hurtPlayer(a.obj, zb.dmg, def.name);
    else if (a.kind === 'f') this.damageFence(a.obj, zb.fenceDmg, zb);
    else if (a.kind === 'c') this.damageConstruct(a.obj, zb.fenceDmg);
    else if (a.kind === 'h') this.damageHeart(zb.fenceDmg);
  }

  enemyShot(zb, a, speed, dmg, structDmg, kind, homing = false) {
    const pr = {
      id: this.nextId++, enemy: true, kind, x: zb.x, z: zb.z, tx: a.x, tz: a.z, speed, dmg, structDmg, target: a,
      tid: homing && a.kind === 'p' ? a.obj.id : -1, ttl: 4, src: ZOMBIES[zb.type].name, aoe: kind === 'acid' ? 1.4 : 0.9,
    };
    this.projectiles.push(pr);
    this.ev('proj', pr.id, kind, r2(zb.x), r2(zb.z), homing ? -2 - a.obj.id : -1, r2(a.x), r2(a.z), speed, 0);
  }

  bossAbilities(zb, players) {
    const def = ZOMBIES[zb.type];
    const t = this.time;
    if (zb.telegraph && t >= zb.telegraph.at) {
      const tg = zb.telegraph;
      zb.telegraph = null;
      for (const p of players) if (d2(p.x, p.z, tg.x, tg.z) < tg.r * tg.r) {
        this.hurtPlayer(p, tg.dmg, def.name);
        if (tg.kind === 'nova') p.buffs.chill = { until: t + 3, v: 0.4 };
      }
      for (const f of this.fence) if (segDist(tg.x, tg.z, ...this.segEnds(f)) < tg.r) this.damageFence(f, zb.fenceDmg * 0.6, zb);
      for (const c of [...this.constructs.values()]) if (d2(c.x, c.z, tg.x, tg.z) < tg.r * tg.r) this.damageConstruct(c, zb.fenceDmg);
      this.ev('boom', r2(tg.x), r2(tg.z), tg.r, tg.kind);
    }
    if (!zb.enraged && zb.hp < zb.maxHp * 0.5) {
      zb.enraged = true;
      this.announce(`${def.name} is enraged!`, 'boss');
    }
    const near = (r) => players.filter((p) => d2(p.x, p.z, zb.x, zb.z) < r * r);
    if (def.slam && t >= zb.abil.slam) {
      const close = near(def.slam.radius + 0.5);
      const fenceClose = this.fence.some((f) => !f.broken && segDist(zb.x, zb.z, ...this.segEnds(f)) < def.slam.radius);
      if (close.length || fenceClose) {
        zb.abil.slam = t + def.slam.every * (zb.enraged ? 0.7 : 1);
        zb.telegraph = { at: t + 1.1, x: zb.x, z: zb.z, r: def.slam.radius, dmg: def.slam.dmg * waveDmgMult(this.wave), kind: 'slam' };
        this.ev('tele', r2(zb.x), r2(zb.z), def.slam.radius, 1.1);
      }
    }
    if (def.nova && t >= zb.abil.nova) {
      const close = near(def.nova.radius + 1);
      if (close.length) {
        zb.abil.nova = t + def.nova.every;
        zb.telegraph = { at: t + 1.3, x: zb.x, z: zb.z, r: def.nova.radius, dmg: def.nova.dmg * waveDmgMult(this.wave), kind: 'nova' };
        this.ev('tele', r2(zb.x), r2(zb.z), def.nova.radius, 1.3);
      }
    }
    if (def.spit && t >= zb.abil.spit) {
      const tgt = near(def.spit.range)[0];
      if (tgt) {
        zb.abil.spit = t + def.spit.every * (zb.enraged ? 0.7 : 1);
        this.enemyShot(zb, { kind: 'p', obj: tgt, x: tgt.x, z: tgt.z }, 11, def.spit.dmg * waveDmgMult(this.wave), 0, 'plague');
        this.delayed.push({ at: t + Math.hypot(tgt.x - zb.x, tgt.z - zb.z) / 11, fn: () => this.addZone({ kind: 'poison', x: tgt.x, z: tgt.z, r: 2.5, dur: 4, tick: 0.5, dmg: 6 * waveDmgMult(this.wave) }) });
      }
    }
    if (def.bolt && t >= zb.abil.bolt) {
      const tgt = near(def.bolt.range).sort(() => Math.random() - 0.5)[0];
      if (tgt) {
        zb.abil.bolt = t + def.bolt.every * (zb.enraged ? 0.7 : 1);
        this.enemyShot(zb, { kind: 'p', obj: tgt, x: tgt.x, z: tgt.z }, 13, def.bolt.dmg * waveDmgMult(this.wave), 0, 'shadow', true);
      }
    }
    if (def.summon && t >= zb.abil.summon) {
      zb.abil.summon = t + def.summon.every * (zb.enraged ? 0.75 : 1);
      if (this.zombies.size < 90) {
        for (let i = 0; i < def.summon.count + (zb.enraged ? 1 : 0); i++) {
          const a = Math.random() * Math.PI * 2;
          this.spawnZombie(def.summon.type, zb.x + Math.cos(a) * 2.5, zb.z + Math.sin(a) * 2.5, { summoned: true });
        }
        this.ev('summon', r2(zb.x), r2(zb.z));
      }
    }
  }

  // ------------------------------------------------------------------ projectiles, zones, timers
  updateProjectiles() {
    const keep = [];
    for (const pr of this.projectiles) {
      pr.ttl -= DT;
      if (pr.enemy) {
        if (pr.tid >= 0) {
          const p = this.players.get(pr.tid);
          if (p && !p.dead) { pr.tx = p.x; pr.tz = p.z; }
        }
        const dx = pr.tx - pr.x, dz = pr.tz - pr.z, dl = Math.hypot(dx, dz);
        const step = pr.speed * DT;
        if (dl <= step || pr.ttl <= 0) {
          pr.x = pr.tx; pr.z = pr.tz;
          this.enemyImpact(pr);
          continue;
        }
        pr.x += (dx / dl) * step; pr.z += (dz / dl) * step;
        keep.push(pr);
        continue;
      }
      // player / turret projectile
      const ox = pr.x, oz = pr.z;
      let done = false;
      if (pr.dirx !== undefined) {
        pr.x += pr.dirx * pr.speed * DT;
        pr.z += pr.dirz * pr.speed * DT;
      } else {
        const tz = this.zombies.get(pr.tid);
        if (tz) { pr.tx = tz.x; pr.tz = tz.z; }
        const dx = pr.tx - pr.x, dz = pr.tz - pr.z, dl = Math.hypot(dx, dz);
        const step = pr.speed * DT;
        if (dl <= step) { pr.x = pr.tx; pr.z = pr.tz; if (!tz) done = true; }
        else { pr.x += (dx / dl) * step; pr.z += (dz / dl) * step; }
      }
      for (const zb of this.zombiesNear((ox + pr.x) / 2, (oz + pr.z) / 2, Math.hypot(pr.x - ox, pr.z - oz) / 2 + 0.6)) {
        if (pr.hit.has(zb.id)) continue;
        if (segDist(zb.x, zb.z, ox, oz, pr.x, pr.z) > zb.radius + 0.35) continue;
        pr.hit.add(zb.id);
        const src = pr.owner.construct ? pr.owner : pr.owner;
        this.damageZombie(zb, pr.dmg, src, pr.kind);
        if (pr.slow) { zb.slowUntil = this.time + pr.slow.dur; zb.slowPct = Math.max(zb.slowUntil > this.time ? zb.slowPct : 0, pr.slow.pct); }
        if (pr.pierce > 0) { pr.pierce--; continue; }
        done = true;
        break;
      }
      if (done || pr.ttl <= 0) { this.ev('ph', pr.id, r2(pr.x), r2(pr.z)); continue; }
      keep.push(pr);
    }
    this.projectiles = keep;
  }

  enemyImpact(pr) {
    this.ev('ph', pr.id, r2(pr.x), r2(pr.z));
    for (const p of this.players.values()) if (!p.dead && d2(p.x, p.z, pr.x, pr.z) < pr.aoe * pr.aoe) this.hurtPlayer(p, pr.dmg, pr.src);
    const a = pr.target;
    if (pr.structDmg) {
      if (a.kind === 'f') this.damageFence(a.obj, pr.structDmg);
      else if (a.kind === 'c' && this.constructs.has(a.obj.id)) this.damageConstruct(a.obj, pr.structDmg);
      else if (a.kind === 'h') this.damageHeart(pr.structDmg);
    }
  }

  updateZones() {
    const keep = [];
    for (const z of this.zones) {
      if (this.time >= z.until) continue;
      keep.push(z);
      if (z.pull) {
        for (const zb of this.zombiesNear(z.x, z.z, z.r)) {
          if (ZOMBIES[zb.type].boss) continue;
          const dx = z.x - zb.x, dz = z.z - zb.z, dl = Math.hypot(dx, dz);
          if (dl > 0.4) {
            const step = Math.min(dl - 0.3, z.pull * DT);
            const nx = zb.x + (dx / dl) * step, nz = zb.z + (dz / dl) * step;
            if (insideVillage(nx, nz) === insideVillage(zb.x, zb.z)) { zb.x = nx; zb.z = nz; }
          }
          zb.rootUntil = this.time + 0.3;
        }
      }
      if (this.time < z.next) continue;
      z.next = this.time + z.tick;
      if (z.kind === 'poison') {
        for (const p of this.players.values()) if (!p.dead && d2(p.x, p.z, z.x, z.z) < z.r * z.r) this.hurtPlayer(p, z.dmg, 'Plague Mother');
        continue;
      }
      if (z.dmg) for (const zb of this.zombiesNear(z.x, z.z, z.r)) {
        this.damageZombie(zb, z.dmg, z.owner, z.kind, z.kind === 'gravity_well');
        if (z.slow) { zb.slowUntil = this.time + z.slow.dur; zb.slowPct = Math.max(zb.slowPct * (zb.slowUntil > this.time ? 1 : 0), z.slow.pct); }
      }
      if (z.heal) for (const p of this.players.values()) if (!p.dead && p.connected && d2(p.x, p.z, z.x, z.z) < z.r * z.r) this.healPlayer(p, z.heal, z.owner);
    }
    this.zones = keep;
  }

  updateDelayed() {
    if (!this.delayed.length) return;
    const now = this.time;
    const due = this.delayed.filter((d) => d.at <= now);
    if (!due.length) return;
    this.delayed = this.delayed.filter((d) => d.at > now);
    for (const d of due) d.fn();
  }

  // ------------------------------------------------------------------ quiz
  quizStart(p) {
    if (p.dead) return;
    if (!this.nearNpc(p, 'librarian')) return this.toast(p, 'Talk to Professor Quill at the Library');
    p.quizActive = true;
    if (!p.quizCur) this.quizNext(p);
    else this.resendQuiz(p);
  }

  quizNext(p) {
    if (p.quizPos >= p.quizOrder.length) {
      p.quizOrder = shuffle([...QUIZ_BANK.keys()]);
      p.quizPos = 0;
      p.quizCycle++;
    }
    const qi = p.quizOrder[p.quizPos++];
    const q = QUIZ_BANK[qi];
    const order = shuffle(q.choices.map((_, i) => i));
    // keep "noun/verb/adjective/adverb" style answer lists in their natural order
    const fixed = q.choices.includes('noun') && q.choices.includes('verb');
    const perm = fixed ? q.choices.map((_, i) => i) : order;
    p.quizCur = { qi, perm, at: this.time, id: this.nextId++ };
    this.resendQuiz(p);
  }

  resendQuiz(p) {
    const cur = p.quizCur;
    const q = QUIZ_BANK[cur.qi];
    const perm = cur.perm;
    p.client?.send({
      t: 'quizQ', id: p.quizCur.id, type: q.type, q: q.q, choices: perm.map((i) => q.choices[i]),
      streak: p.quizStreak, best: p.quizBest, num: p.quizAnswered + 1, mult: quizStreakMult(p.quizStreak + 1),
      xp: Math.round(quizBaseXp(p.level) * quizStreakMult(p.quizStreak + 1) * (p.quizCycle ? 0.5 : 1)), total: QUIZ_BANK.length,
    });
  }

  quizAnswer(p, msg) {
    const cur = p.quizCur;
    if (!cur || msg.id !== cur.id) return;
    if (this.time - cur.at < 1.0) return; // read the question first!
    const q = QUIZ_BANK[cur.qi];
    const choice = Number(msg.choice);
    if (!(choice >= 0 && choice < cur.perm.length)) return;
    p.quizCur = null;
    p.quizAnswered++;
    const correct = cur.perm[choice] === q.a;
    let xp = 0;
    if (correct) {
      p.quizStreak++;
      p.quizCorrect++;
      p.quizBest = Math.max(p.quizBest, p.quizStreak);
      xp = Math.round(quizBaseXp(p.level) * quizStreakMult(p.quizStreak) * (p.quizCycle ? 0.5 : 1));
      this.giveXp(p, xp);
      if (p.quizStreak > 0 && p.quizStreak % 5 === 0) this.announce(`${p.name} is on a ${p.quizStreak}-answer word magic streak!`, 'good');
    } else {
      p.quizStreak = 0;
    }
    p.client?.send({
      t: 'quizR', correct, answer: cur.perm.indexOf(q.a), chosen: choice, explain: q.explain, xp, streak: p.quizStreak,
      best: p.quizBest, mult: quizStreakMult(p.quizStreak + 1),
    });
    // queue the next question shortly after so the result can be read
    this.delayed.push({ at: this.time + (correct ? 1.8 : 4.5), fn: () => { if (p.quizActive && p.client && !p.quizCur && !p.dead && this.nearNpc(p, 'librarian')) this.quizNext(p); } });
  }

  // ------------------------------------------------------------------ snapshots
  sendSnapshots() {
    const players = [];
    for (const p of this.players.values()) {
      let bits = 0;
      if (p.buffs.empower) bits |= 1;
      if (p.buffs.haste) bits |= 2;
      if (p.buffs.ascend) bits |= 4;
      if (p.buffs.shield) bits |= 8;
      if (p.buffs.blades) bits |= 16;
      if (p.buffs.chill) bits |= 32;
      players.push([p.id, r2(p.x), r2(p.z), r2(p.f), Math.ceil(p.hp), p.maxHp, Math.floor(p.mana), p.maxMana, p.level, (p.dead ? 1 : 0) | (p.connected ? 0 : 2), bits]);
    }
    const zs = [];
    const t = this.time;
    for (const zb of this.zombies.values()) {
      let fl = 0;
      if (zb.slowUntil > t || zb.chillUntil > t) fl |= 1;
      if (zb.hexUntil > t) fl |= 2;
      if (zb.rootUntil > t) fl |= 4;
      if (zb.burnUntil > t) fl |= 8;
      if (zb.elite) fl |= 16;
      if (zb.enraged) fl |= 32;
      zs.push([zb.id, zb.ti, r2(zb.x), r2(zb.z), r2(zb.f), Math.max(1, Math.ceil((zb.hp / zb.maxHp) * 100)), zb.state, fl]);
    }
    const snap = {
      t: 's', tm: r2(this.time), ph: this.phase, w: this.wave, tl: Math.max(0, Math.ceil(this.timer)),
      zl: this.zombies.size + this.spawnQueue.length, p: players, z: zs,
      nd: this.phase === 'prep' || this.phase === 'break' ? this.nextDirs : this.waveDirs,
    };
    const boss = [...this.zombies.values()].find((zb) => ZOMBIES[zb.type].boss);
    if (boss) snap.b = [boss.id, boss.ti, Math.ceil(boss.hp), Math.ceil(boss.maxHp)];
    if (this.events.length) { snap.e = this.events; this.events = []; }
    if (this.fenceDirty.size) {
      snap.f = [...this.fenceDirty].map((id) => { const f = this.fence[id]; return [id, Math.round(f.hp), f.maxHp, f.broken ? 1 : 0, t - f.lastHit < 1.2 ? 1 : 0, f.fortUntil > t ? 1 : 0]; });
      this.fenceDirty.clear();
    }
    // re-send "under attack" flags for segments hit recently so indicators keep flashing
    const hot = this.fence.filter((f) => t - f.lastHit < 1.2).map((f) => f.id);
    if (hot.length) snap.fa = hot;
    if (this.conDirty.size) {
      snap.c = [...this.conDirty].filter((id) => this.constructs.has(id)).map((id) => { const c = this.constructs.get(id); return [id, Math.round(c.hp), c.maxHp, t - (c.lastHit || -9) < 1 ? 1 : 0]; });
      this.conDirty.clear();
    }
    snap.h = [Math.round(Math.max(0, this.heart.hp)), this.heart.maxHp, t - this.heart.lastHit < 1.5 ? 1 : 0];
    const s = JSON.stringify(snap);
    for (const c of this.clients) c.sendRaw(s);
    for (const p of this.players.values()) if (p.client) this.sendMe(p);
  }

  sendMe(p, force) {
    const cds = {};
    for (const [k, v] of Object.entries(p.cds)) if (v > this.time) cds[k] = r2(v);
    const bf = {};
    for (const [k, b] of Object.entries(p.buffs)) bf[k] = r2(b.until);
    const me = {
      t: 'me', g: Math.floor(p.gold), wd: p.wood, st: p.stone, xp: Math.floor(p.xp), xn: xpToNext(p.level), lv: p.level,
      inv: p.inv, sp: p.spells, cd: cds, bc: r2(p.basicReady), wl: r2(p.wellReady), bf, rd: p.ready ? 1 : 0,
      rs: p.dead ? r2(p.respawnAt) : 0, qs: p.quizStreak, qb: p.quizBest, tp: p.tpSeq,
      cn: [...this.constructs.values()].filter((c) => c.owner === p.id).length, sh: p.buffs.shield ? Math.round(p.buffs.shield.amt) : 0,
    };
    const s = JSON.stringify(me);
    if (!force && s === p.lastMe) return;
    p.lastMe = s;
    p.client.sendRaw(s);
  }
}

function joinNames(names) {
  if (names.length <= 1) return names[0] || '';
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}
