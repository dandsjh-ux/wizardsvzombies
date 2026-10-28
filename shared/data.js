// Game definitions shared by the server (authoritative rules) and the client (UI, tooltips, smart targeting).

export const TICK_RATE = 20;
export const SNAPSHOT_EVERY = 2; // ticks per snapshot (10 Hz)
export const MAX_PLAYERS = 3;
export const TOTAL_WAVES = 30;
export const FIRST_PREP_TIME = 40; // seconds before wave 1
export const WAVE_BREAK_TIME = 30; // buffer after a wave is cleared
export const WELL_COOLDOWN = 90;
export const WELL_RANGE = 3.6;
export const NPC_RANGE = 4.2;
export const BUILD_RANGE = 10;
export const MAX_CONSTRUCTS_PER_PLAYER = 6;
export const MAX_LEVEL = 30;
export const RECONNECT_GRACE_MS = 5 * 60 * 1000;
export const EMPTY_RESET_MS = 10 * 60 * 1000;

export const FENCE_HP = 400;
export const GATE_HP = 700;
export const HEART_HP = 2000;
export const HEART_DMG_MULT = 0.5; // zombies are clumsy against the enchanted Well
export const FENCE_INTACT_RATIO = 0.25; // a broken segment blocks again once repaired to this fraction

export const START_GOLD = 120;
export const START_WOOD = 4;
export const START_STONE = 3;

export const CLASSES = {
  striker: {
    name: 'Striker', title: 'Offensive Mage', color: '#ff7a3d', icon: '🔥',
    hp: 95, mana: 110, hpPerLvl: 11, manaPerLvl: 9, hpRegen: 0.6, manaRegen: 4.0, speed: 5.6,
    desc: 'Glass cannon of fire, frost and lightning. Melts hordes and bosses alike.',
    start: ['firebolt'],
  },
  healer: {
    name: 'Healer', title: 'Defensive Mage', color: '#5fe08a', icon: '✚',
    hp: 115, mana: 125, hpPerLvl: 13, manaPerLvl: 10, hpRegen: 1.0, manaRegen: 4.6, speed: 5.4,
    desc: 'Keeps wizards alive and the palisade standing. Mends fences with a word.',
    start: ['healing_light', 'mend'],
  },
  augmenter: {
    name: 'Augmenter', title: 'Buffing Mage', color: '#b47cff', icon: '✦',
    hp: 105, mana: 115, hpPerLvl: 12, manaPerLvl: 9, hpRegen: 0.8, manaRegen: 4.3, speed: 5.6,
    desc: 'Empowers allies, hexes the dead and still hits hard with arcane magic.',
    start: ['arcane_spark', 'empower'],
  },
};

export const BASIC_ATTACK = { name: 'Wand Bolt', range: 11, cd: 0.75, speed: 20, dmg: (lvl) => 8 + 0.8 * (lvl - 1) };

// Spell power from levels: +4% per level above 1.
export const spellPower = (lvl) => 1 + 0.04 * (lvl - 1);

// target: enemy | point | ally | self | repair
// Values given as [rank1, rank2, rank3].
export const SPELLS = {
  // ---------------- Striker ----------------
  firebolt: {
    cls: 'striker', name: 'Firebolt', icon: '🔥', kind: 'bolt', target: 'enemy', color: 0xff6a20,
    mana: [6, 6, 7], cd: [0.9, 0.8, 0.7], range: 15, speed: 22, dmg: [24, 34, 46],
    price: 0, upgrade: [80, 200], level: 1,
    desc: 'Hurl a bolt of fire at a zombie.',
  },
  frost_shard: {
    cls: 'striker', name: 'Frost Shard', icon: '❄', kind: 'bolt', target: 'enemy', color: 0x8fdcff,
    mana: [10, 10, 11], cd: [2.4, 2.1, 1.8], range: 15, speed: 24, dmg: [20, 28, 38], pierce: [2, 3, 4],
    slow: { pct: 0.4, dur: 3 }, price: 60, level: 2,
    desc: 'A piercing shard of ice that slows everything it passes through.',
  },
  chain_lightning: {
    cls: 'striker', name: 'Chain Lightning', icon: '⚡', kind: 'chain', target: 'enemy', color: 0x9ad0ff,
    mana: [18, 18, 20], cd: [5, 4.5, 4], range: 13, dmg: [30, 42, 56], jumps: [3, 4, 5], jumpRange: 6,
    price: 120, level: 4,
    desc: 'Lightning arcs from zombie to zombie.',
  },
  flame_nova: {
    cls: 'striker', name: 'Flame Nova', icon: '💥', kind: 'nova', target: 'self', color: 0xff8a30,
    mana: [22, 22, 24], cd: [8, 7, 6], radius: 5, dmg: [40, 56, 75], knock: 3,
    price: 180, level: 6,
    desc: 'Explode in a ring of fire, damaging and knocking back nearby zombies.',
  },
  meteor: {
    cls: 'striker', name: 'Meteor', icon: '☄', kind: 'meteor', target: 'point', color: 0xff5010,
    mana: [35, 35, 38], cd: [12, 11, 10], range: 16, radius: 4, delay: 1.1, dmg: [90, 130, 180],
    burn: { dps: [10, 15, 20], dur: 3 }, price: 260, level: 9,
    desc: 'Call down a blazing meteor that leaves the ground burning.',
  },
  arcane_barrage: {
    cls: 'striker', name: 'Arcane Barrage', icon: '✴', kind: 'missiles', target: 'enemy', color: 0xff60d0,
    mana: [26, 26, 28], cd: [7, 6.5, 6], range: 15, speed: 16, count: [5, 6, 7], dmg: [14, 19, 25],
    price: 340, level: 12,
    desc: 'Unleash homing missiles that seek out zombies around the target.',
  },
  blizzard: {
    cls: 'striker', name: 'Blizzard', icon: '🌨', kind: 'zone', target: 'point', color: 0xbfe8ff,
    mana: [40, 40, 44], cd: [16, 15, 14], range: 16, radius: 5, dur: [6, 6.5, 7], tick: 0.5,
    dmg: [12, 17, 23], slow: { pct: 0.5, dur: 0.8 }, price: 450, level: 15,
    desc: 'A freezing storm that shreds and slows zombies inside it.',
  },
  dragons_breath: {
    cls: 'striker', name: "Dragon's Breath", icon: '🐉', kind: 'cone', target: 'point', color: 0xff4000,
    mana: [60, 60, 65], cd: [30, 27, 24], range: 10, angle: 75, dmg: [180, 260, 360],
    burn: { dps: [20, 30, 40], dur: 4 }, price: 600, level: 18,
    desc: 'Ultimate: breathe a torrent of dragonfire in a wide cone.',
  },

  // ---------------- Healer ----------------
  healing_light: {
    cls: 'healer', name: 'Healing Light', icon: '✚', kind: 'heal', target: 'ally', color: 0x9dffb0,
    mana: [10, 10, 11], cd: [1.2, 1.1, 1.0], range: 14, heal: [35, 50, 70],
    price: 0, upgrade: [80, 200], level: 1,
    desc: 'Heal a wizard (or yourself).',
  },
  mend: {
    cls: 'healer', name: 'Mend', icon: '🔨', kind: 'mend', target: 'repair', color: 0xffe08a,
    mana: [12, 12, 13], cd: [1.5, 1.35, 1.2], range: 12, radius: 3, repair: [60, 90, 130],
    price: 0, upgrade: [80, 200], level: 1,
    desc: 'Magically repair fences, gates, constructs and the Well near the target.',
  },
  holy_smite: {
    cls: 'healer', name: 'Holy Smite', icon: '☀', kind: 'bolt', target: 'enemy', color: 0xfff2a0,
    mana: [8, 8, 9], cd: [1.2, 1.1, 1.0], range: 14, speed: 22, dmg: [26, 36, 50], undeadBonus: 0.25,
    price: 50, level: 2,
    desc: 'A bolt of radiant light. Extra effective against the undead.',
  },
  sanctuary: {
    cls: 'healer', name: 'Sanctuary', icon: '⛨', kind: 'zone', target: 'point', color: 0x9dffb0,
    mana: [30, 30, 33], cd: [14, 13, 12], range: 14, radius: 5, dur: [8, 9, 10], tick: 0.5,
    heal: [4, 6, 8], dmg: [3, 4.5, 6], price: 140, level: 4,
    desc: 'Consecrate the ground: heals wizards and burns zombies standing in it.',
  },
  divine_shield: {
    cls: 'healer', name: 'Divine Shield', icon: '🛡', kind: 'shield', target: 'ally', color: 0xffe9a0,
    mana: [20, 20, 22], cd: [10, 9, 8], range: 14, absorb: [60, 90, 130], dur: 10,
    price: 180, level: 6,
    desc: 'Wrap a wizard in a barrier that absorbs damage.',
  },
  fortify: {
    cls: 'healer', name: 'Fortify', icon: '🏰', kind: 'fortify', target: 'repair', color: 0xffd060,
    mana: [35, 35, 38], cd: [18, 16, 14], range: 14, radius: 6, repair: [120, 180, 250], fortDur: 15,
    price: 260, level: 9,
    desc: 'Repair all structures in an area and make them take half damage for 15s.',
  },
  purifying_nova: {
    cls: 'healer', name: 'Purifying Nova', icon: '✺', kind: 'nova', target: 'self', color: 0xfff6c0,
    mana: [30, 30, 33], cd: [10, 9, 8], radius: 6, dmg: [50, 70, 95], heal: [40, 60, 80], knock: 1.5,
    price: 340, level: 12,
    desc: 'A burst of holy light: damages zombies and heals wizards around you.',
  },
  divine_intervention: {
    cls: 'healer', name: 'Divine Intervention', icon: '👼', kind: 'intervention', target: 'self', color: 0xffffff,
    mana: [80, 80, 85], cd: [90, 80, 70], repairPct: [0.25, 0.35, 0.5],
    price: 600, level: 16,
    desc: 'Ultimate: fully heal and revive every wizard and restore all fences and the Well.',
  },

  // ---------------- Augmenter ----------------
  arcane_spark: {
    cls: 'augmenter', name: 'Arcane Spark', icon: '✦', kind: 'bolt', target: 'enemy', color: 0xc07cff,
    mana: [5, 5, 6], cd: [0.8, 0.72, 0.65], range: 15, speed: 24, dmg: [18, 26, 36],
    price: 0, upgrade: [80, 200], level: 1,
    desc: 'A quick bolt of arcane energy.',
  },
  empower: {
    cls: 'augmenter', name: 'Empower', icon: '💪', kind: 'aura', target: 'self', color: 0xff9d3d,
    mana: [18, 18, 20], cd: [14, 13, 12], radius: 9, buff: 'empower', value: [0.25, 0.35, 0.45], dur: [12, 13, 14],
    price: 0, upgrade: [80, 200], level: 1,
    desc: 'You and nearby wizards (and their constructs) deal more damage.',
  },
  haste: {
    cls: 'augmenter', name: 'Haste', icon: '💨', kind: 'aura', target: 'self', color: 0x7dffe9,
    mana: [20, 20, 22], cd: [16, 15, 14], radius: 9, buff: 'haste', value: [0.35, 0.45, 0.55], dur: [8, 9, 10],
    price: 80, level: 2,
    desc: 'Nearby wizards move faster and their spells recharge quicker.',
  },
  hex: {
    cls: 'augmenter', name: 'Hex of Weakness', icon: '☠', kind: 'hex', target: 'point', color: 0x9b4dff,
    mana: [18, 18, 20], cd: [9, 8.5, 8], range: 15, radius: 4.5, amp: [0.25, 0.35, 0.45], slow: 0.3, dur: 8,
    price: 130, level: 4,
    desc: 'Curse zombies in an area: they take more damage and move slower.',
  },
  mana_surge: {
    cls: 'augmenter', name: 'Mana Surge', icon: '💧', kind: 'manasurge', target: 'self', color: 0x5aa8ff,
    mana: [0, 0, 0], cd: [22, 20, 18], radius: 12, restore: [30, 45, 60],
    price: 180, level: 6,
    desc: 'Restore mana to yourself and every wizard nearby.',
  },
  gravity_well: {
    cls: 'augmenter', name: 'Gravity Well', icon: '🌀', kind: 'zone', target: 'point', color: 0x7a4dff,
    mana: [32, 32, 35], cd: [15, 14, 13], range: 15, radius: 5, dur: [2.5, 3, 3.5], tick: 0.25,
    dmg: [5, 7.5, 10], pull: 7, price: 260, level: 9,
    desc: 'Rip open a singularity that drags zombies together and holds them.',
  },
  spectral_blades: {
    cls: 'augmenter', name: 'Spectral Blades', icon: '🗡', kind: 'blades', target: 'self', color: 0xd0a0ff,
    mana: [28, 28, 30], cd: [14, 13, 12], radius: 3.2, dur: 8, tick: 0.4, dmg: [15, 21, 28],
    price: 340, level: 12,
    desc: 'Summon blades that orbit you and slice nearby zombies.',
  },
  ascendance: {
    cls: 'augmenter', name: 'Ascendance', icon: '👑', kind: 'ascend', target: 'self', color: 0xffd36b,
    mana: [70, 70, 75], cd: [60, 55, 50], radius: 15, value: [0.4, 0.5, 0.6], dur: [12, 14, 16], pulse: [120, 170, 230], pulseRadius: 7,
    price: 600, level: 16,
    desc: 'Ultimate: nearby wizards gain huge damage, mana regen and faster spells. Detonates arcane power around you.',
  },
};

export const CLASS_SPELLS = {};
for (const [id, s] of Object.entries(SPELLS)) (CLASS_SPELLS[s.cls] ||= []).push(id);

export function spellUnlockCost(id) { return SPELLS[id].price; }
export function spellUpgradeCost(id, currentRank) {
  const s = SPELLS[id];
  if (currentRank >= 3) return null;
  if (s.upgrade) return s.upgrade[currentRank - 1];
  return Math.max(currentRank === 1 ? 60 : 120, Math.round(s.price * (currentRank === 1 ? 0.75 : 1.5)));
}
export const rankVal = (v, rank) => (Array.isArray(v) ? v[Math.min(v.length, rank) - 1] : v);

// Constructs: each class can craft three. Costs wood + stone (bought from the Trader) and are enchanted with mana.
export const CONSTRUCTS = {
  flame_turret: {
    cls: 'striker', name: 'Flame Turret', icon: '🗼', wood: 4, stone: 3, mana: 40, hp: 220, radius: 0.8,
    range: 11, rate: 1.1, dmg: 16, desc: 'Shoots firebolts at zombies in range.',
  },
  ember_trap: {
    cls: 'striker', name: 'Ember Trap', icon: '♨', wood: 3, stone: 1, mana: 25, hp: 160, radius: 1.6, trap: true,
    rate: 0.5, dmg: 18, slow: 0.35, uses: 70, desc: 'Burns and slows zombies that walk over it. Wears out with use.',
  },
  storm_spire: {
    cls: 'striker', name: 'Storm Spire', icon: '⚡', wood: 3, stone: 6, mana: 70, hp: 260, radius: 0.8,
    range: 12, rate: 2.6, dmg: 30, jumps: 3, desc: 'Calls chain lightning on groups of zombies.',
  },
  barricade: {
    cls: 'healer', name: 'Stone Barricade', icon: '🧱', wood: 3, stone: 5, mana: 30, hp: 650, radius: 0.6, wall: true,
    halfLen: 1.6, desc: 'A sturdy wall zombies must smash through. Rotate before placing.',
  },
  healing_shrine: {
    cls: 'healer', name: 'Healing Shrine', icon: '⛲', wood: 4, stone: 4, mana: 50, hp: 250, radius: 0.8,
    range: 6, heal: 6, desc: 'Heals wizards standing near it.',
  },
  mending_totem: {
    cls: 'healer', name: 'Mending Totem', icon: '🪵', wood: 5, stone: 3, mana: 50, hp: 230, radius: 0.7,
    range: 8, repair: 12, desc: 'Slowly repairs nearby fences, gates and constructs.',
  },
  frost_obelisk: {
    cls: 'augmenter', name: 'Frost Obelisk', icon: '🧊', wood: 2, stone: 5, mana: 45, hp: 260, radius: 0.8,
    range: 7, slow: 0.4, dmg: 4, desc: 'Chills zombies nearby, slowing them down.',
  },
  mana_font: {
    cls: 'augmenter', name: 'Mana Font', icon: '🔮', wood: 3, stone: 3, mana: 35, hp: 210, radius: 0.8,
    range: 6, regen: 8, desc: 'Wizards nearby regenerate mana much faster.',
  },
  arcane_amplifier: {
    cls: 'augmenter', name: 'Arcane Amplifier', icon: '🚩', wood: 5, stone: 2, mana: 50, hp: 230, radius: 0.7,
    range: 9, amp: 0.2, rateAmp: 0.3, desc: 'Wizards and constructs nearby deal 20% more damage; turrets fire 30% faster.',
  },
};
export const CLASS_CONSTRUCTS = {};
for (const [id, c] of Object.entries(CONSTRUCTS)) (CLASS_CONSTRUCTS[c.cls] ||= []).push(id);

// Trader stock. Consumables have hotkeys in the HUD.
export const ITEMS = {
  health_potion: { name: 'Health Potion', icon: '❤', price: 25, max: 10, key: 'Q', desc: 'Restore 50% of your health.' },
  mana_potion: { name: 'Mana Potion', icon: '💙', price: 20, max: 10, key: 'E', desc: 'Restore 50% of your mana.' },
  repair_kit: { name: "Carpenter's Kit", icon: '🧰', price: 30, max: 10, key: 'R', desc: 'Repairs the 3 most damaged fence sections near you by 250 HP (rebuilds broken ones).' },
  fire_bomb: { name: 'Fire Bomb', icon: '💣', price: 35, max: 5, key: 'T', desc: 'Throw at the target: big fire explosion. Damage grows with the wave.' },
  iron_bands: { name: 'Iron Reinforcement', icon: '⛓', price: 90, max: 3, key: 'G', desc: 'Permanently +50% max HP for fence sections within 5m of you, fully repairing them.' },
  phoenix_charm: { name: 'Phoenix Charm', icon: '🪶', price: 120, max: 1, passive: true, desc: 'When you would die, revive instantly with 50% health. Consumed on use.' },
  wood: { name: 'Timber', icon: '🪵', price: 8, max: 99, material: true, desc: 'Building material for constructs.' },
  stone: { name: 'Stone Block', icon: '🪨', price: 12, max: 99, material: true, desc: 'Building material for constructs.' },
};
export const CONSUMABLE_ORDER = ['health_potion', 'mana_potion', 'repair_kit', 'fire_bomb', 'iron_bands'];

// Zombies ---------------------------------------------------------------
export const ZOMBIES = {
  walker: { name: 'Walker', hp: 45, dmg: 8, fenceDmg: 10, atkRate: 1.2, range: 1.4, speed: 1.7, xp: 10, gold: 3, radius: 0.45, scale: 1.0 },
  runner: { name: 'Runner', hp: 28, dmg: 6, fenceDmg: 6, atkRate: 0.9, range: 1.3, speed: 3.6, xp: 12, gold: 4, radius: 0.4, scale: 0.92 },
  brute: { name: 'Brute', hp: 180, dmg: 18, fenceDmg: 30, atkRate: 1.6, range: 1.8, speed: 1.3, xp: 30, gold: 10, radius: 0.7, scale: 1.45 },
  spitter: { name: 'Spitter', hp: 55, dmg: 10, fenceDmg: 12, atkRate: 2.2, range: 8, ranged: true, speed: 1.6, xp: 18, gold: 6, radius: 0.45, scale: 1.0 },
  bloater: { name: 'Bloater', hp: 120, dmg: 45, fenceDmg: 150, atkRate: 1.0, range: 1.6, speed: 1.4, xp: 22, gold: 7, radius: 0.75, scale: 1.3, explode: 3.5 },
  wraith: { name: 'Wraith', hp: 40, dmg: 12, fenceDmg: 0, atkRate: 1.1, range: 1.4, speed: 2.6, xp: 20, gold: 6, radius: 0.4, scale: 1.0, ghost: true },
  gravecrusher: { name: 'Gravecrusher', boss: true, hp: 2400, dmg: 35, fenceDmg: 120, atkRate: 1.8, range: 2.6, speed: 1.25, xp: 400, gold: 150, radius: 1.3, scale: 2.6, slam: { every: 6, radius: 4.5, dmg: 40 } },
  plague_mother: { name: 'Plague Mother', boss: true, hp: 6000, dmg: 30, fenceDmg: 100, atkRate: 1.6, range: 2.6, speed: 1.35, xp: 900, gold: 300, radius: 1.3, scale: 2.8, spit: { every: 3, range: 11, dmg: 22 }, summon: { every: 12, type: 'runner', count: 4 } },
  lich_king: { name: 'The Lich King', boss: true, hp: 14000, dmg: 40, fenceDmg: 140, atkRate: 1.5, range: 2.8, speed: 1.6, xp: 2000, gold: 600, radius: 1.3, scale: 3.0, bolt: { every: 2.2, range: 13, dmg: 30 }, nova: { every: 10, radius: 6, dmg: 45 }, summon: { every: 15, type: 'wraith', count: 3 } },
};
export const ZOMBIE_TYPES = Object.keys(ZOMBIES);
export const BOSS_BY_WAVE = { 10: 'gravecrusher', 20: 'plague_mother', 30: 'lich_king' };

export const tierOf = (w) => Math.min(2, Math.floor((w - 1) / 10));
export const waveHpMult = (w, P) => (1 + 0.075 * (w - 1)) * [1, 1.3, 1.7][tierOf(w)] * (1 + 0.1 * (P - 1));
export const waveDmgMult = (w) => (1 + 0.03 * (w - 1)) * [1, 1.15, 1.3][tierOf(w)];
export const waveSpeedMult = (w) => [1, 1.08, 1.16][tierOf(w)];
export const partyScale = (P) => 0.6 + 0.4 * Math.max(1, P);
// Normalises XP/gold so a solo wizard levels at the same pace as a full party.
export const partyRewardScale = (P) => 1.8 / partyScale(P);

export function waveSpec(w, P) {
  const scale = partyScale(P);
  const count = Math.round((4 + 1.5 * w) * scale);
  const weights = {
    runner: w >= 3 ? Math.min(0.32, 0.07 * (w - 2)) : 0,
    brute: w >= 6 ? Math.min(0.16, 0.03 * (w - 5)) : 0,
    spitter: w >= 11 ? Math.min(0.16, 0.03 * (w - 10)) : 0,
    bloater: w >= 14 ? Math.min(0.12, 0.025 * (w - 13)) : 0,
    wraith: w >= 21 ? Math.min(0.14, 0.03 * (w - 20)) : 0,
  };
  const used = Object.values(weights).reduce((a, b) => a + b, 0);
  weights.walker = Math.max(0.2, 1 - used);
  const mix = {};
  let assigned = 0;
  for (const [t, wt] of Object.entries(weights)) {
    const n = Math.floor(count * wt);
    if (n > 0) mix[t] = n;
    assigned += n;
  }
  mix.walker = (mix.walker || 0) + (count - assigned);
  const elites = w % 10 === 5 ? Math.max(1, Math.round(scale)) : 0;
  const dirs = w <= 3 ? 1 : w <= 9 ? 2 : w <= 19 ? 3 : 4;
  return {
    count, mix, elites, boss: BOSS_BY_WAVE[w] || null, dirs,
    spawnDuration: Math.min(42, 10 + count * 0.35),
  };
}

export const SPAWN_DIRS = [
  { name: 'North', x: 0, z: -1 }, { name: 'North-East', x: 0.72, z: -0.72 }, { name: 'East', x: 1, z: 0 },
  { name: 'South-East', x: 0.72, z: 0.72 }, { name: 'South', x: 0, z: 1 }, { name: 'South-West', x: -0.72, z: 0.72 },
  { name: 'West', x: -1, z: 0 }, { name: 'North-West', x: -0.72, z: -0.72 },
];

export function directionName(x, z) {
  const a = Math.atan2(x, -z); // 0 = north, clockwise
  const i = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
  return SPAWN_DIRS[i].name;
}

// XP & levels -------------------------------------------------------------
export const xpToNext = (lvl) => Math.round(60 * Math.pow(lvl, 1.5) + 40);
export const waveXpMult = (w) => 1 + 0.1 * (Math.max(1, w) - 1);
export const waveClearGold = (w) => 20 + 5 * w;
export const waveClearXp = (w) => 15 + 10 * w;

// Quiz XP: base grows with level, streaks multiply it (x1, x1.5, x2 ... up to x5).
export const quizBaseXp = (lvl) => 12 + 6 * lvl;
export const quizStreakMult = (streak) => Math.min(5, 1 + 0.5 * (Math.max(1, streak) - 1));

export const NPCS = {
  arcanist: { name: 'Mystra the Arcanist', role: 'Spell Vendor', model: 'merchant', look: 'arcanist' },
  trader: { name: 'Gareth the Trader', role: 'Shopkeeper', model: 'tradesman', look: 'trader' },
  librarian: { name: 'Professor Quill', role: 'Librarian — Word Magic Quiz', model: 'merchant', look: 'librarian' },
};
