// The village map: building placements, decorations, palisade fence segments, NPC spots.
// Deterministic (seeded) so the server and every client agree on colliders.

export const VILLAGE_HALF = 31; // fence line sits at x/z = ±31
export const WORLD_HALF = 62;
export const PLAYER_BOUND = 58;
export const SPAWN_DIST = 54;
export const HEART = { x: 0, z: 0, r: 1.2 };
export const PLAYER_SPAWN = { x: 0, z: 4.5 };

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PI = Math.PI;

// Local-space footprints of kit assets (templates face +Z). box: [cx, cz, hx, hz], circle: [cx, cz, r]
export const FOOTPRINTS = {
  blacksmith: { box: [0, -0.09, 2.5, 2.0] },
  'cottage-small': { box: [0, 0, 3.0, 1.95] },
  tavern: { box: [0, 0, 6.4, 4.15] },
  watchtower: { box: [0, 0, 1.8, 1.8] },
  'house-two-story': { box: [0, 0, 2.85, 3.8] },
  chapel: { box: [0, 0, 2.2, 3.2] },
  windmill: { circle: [0, 0, 2.3] },
  well: { circle: [0, 0, 1.15] },
  'market-stall': { box: [0, 0, 0.98, 0.57] },
  cart: { box: [0, 0.34, 0.78, 1.25] },
  'water-trough': { box: [0, 0, 1.17, 0.53] },
  crate: { box: [0, 0, 0.45, 0.33] },
  barrel: { circle: [0, 0, 0.44] },
  'quench-barrel': { circle: [0, 0, 0.54] },
  haystack: { circle: [0, 0, 1.0] },
  sack: { circle: [0, 0, 0.28] },
  anvil: { circle: [0, 0, 0.4] },
  wheelbarrow: { box: [0, -0.17, 0.35, 0.84] },
  'tree-oak': { circle: [0, 0, 0.5] },
  'tree-stump': { circle: [0, 0, 0.55] },
  'flower-planter': { box: [0, 0, 0.41, 0.16] },
  'lamp-post': { circle: [0, 0, 0.16] },
  signpost: { circle: [0, 0, 0.18] },
  'terrain-water': { circle: [0, 0, 2.9] },
};

function rotLocal(x, z, r, lx, lz) {
  const c = Math.cos(r), s = Math.sin(r);
  return [x + lx * c + lz * s, z - lx * s + lz * c];
}

export function buildLayout() {
  const rand = mulberry32(1337);
  const props = []; // { a, x, z, r, s, solid }
  const add = (a, x, z, r = 0, s = 1, solid = true) => { props.push({ a, x, z, r, s, solid }); return props[props.length - 1]; };

  // --- Plaza & Well of Renewal ---
  add('well', 0, 0, 0.3);
  add('signpost', 3.4, 2.4, -0.9);
  for (const [x, z] of [[5, 5], [-5, 5], [5, -5], [-5, -5]]) add('lamp-post', x, z, Math.atan2(-x, -z));
  add('flower-planter', 2.6, -4.2, 0.4);
  add('flower-planter', -3.8, 3.4, -0.9);
  add('flower-planter', -2.7, -4.1, -0.5);

  // --- Market: Arcane vendor (north-east of plaza) & Trader (south-east) ---
  const arcStall = add('market-stall', 7.6, -6.6, -PI / 2);
  const trdStall = add('market-stall', 7.6, 6.6, -PI / 2);
  add('crate', 9.6, -8.4, 0.3); add('barrel', 9.8, -4.6); add('sack', 8.8, -8.6, 0.6);
  add('crate', 9.7, 8.5, -0.2); add('crate', 10.1, 8.0, 0.9, 0.9); add('barrel', 9.7, 4.6); add('barrel', 10.5, 5.1);
  add('sack', 8.6, 8.8, 0.4); add('water-trough', 6.2, 10.6, 0.1);

  // --- Blacksmith & east houses ---
  add('blacksmith', 14.5, 11.2, -PI / 2);
  add('anvil', 11.4, 13.4, 0.4); add('quench-barrel', 11.3, 9.0); add('wheelbarrow', 12.0, 15.6, 2.6);
  add('house-two-story', 22.5, 6.2, -PI / 2);
  add('cottage-small', 19.5, 21.0, -3 * PI / 4);
  add('cottage-small', 6.5, 22.5, PI);
  add('cart', 13.0, 20.5, 0.9); add('haystack', 15.2, 24.3);
  add('flower-planter', 4.8, 20.1, PI); add('flower-planter', 8.2, 20.1, PI);

  // --- North: chapel, windmill, farm ---
  add('chapel', 10.2, -20.0, 0);
  add('windmill', 22.0, -15.5, -PI / 2);
  add('haystack', 24.4, -10.4); add('haystack', 18.6, -10.8, 0.5);
  add('cottage-small', 18.4, -25.4, 0);
  add('sack', 20.6, -12.0, 0.2); add('sack', 21.2, -11.4, 1.2); add('crate', 17.2, -12.4, 0.4);
  add('house-two-story', -6.2, -23.2, 0);
  add('tree-stump', 3.8, -15.0, 1.3);

  // --- Library (north-west) where Professor Quill runs the word quiz ---
  const lib = add('house-two-story', -13.2, -13.2, PI / 4);
  const [lx, lz] = rotLocal(lib.x, lib.z, lib.r, 2.4, 5.0);
  add('crate', ...rotLocal(lib.x, lib.z, lib.r, -2.2, 4.6), PI / 4 + 0.2);
  add('crate', ...rotLocal(lib.x, lib.z, lib.r, -2.0, 5.5), PI / 4 - 0.4, 0.85);
  add('lamp-post', ...rotLocal(lib.x, lib.z, lib.r, 3.6, 4.1), PI / 4);
  add('cottage-small', -21.5, -6.0, PI / 2);
  add('flower-planter', -18.9, -8.4, PI / 2);

  // --- South-west: tavern & pond ---
  add('tavern', -16.0, 15.0, 3 * PI / 4);
  add('barrel', -8.0, 11.0); add('barrel', -7.4, 11.9); add('crate', -6.9, 10.8, 0.5);
  add('terrain-water', -6.8, 25.6, 0.2, 0.75);
  add('cottage-small', -22.5, 25.0, 3 * PI / 4);
  add('flower-planter', -9.6, 6.5, 2.3);

  // --- Watchtowers on the corners of the palisade ---
  for (const [x, z] of [[27.2, 27.2], [-27.2, 27.2], [27.2, -27.2], [-27.2, -27.2]]) add('watchtower', x, z, Math.atan2(-x, -z));

  // --- Lamps along the four roads ---
  for (const d of [12, 22]) {
    add('lamp-post', 3.2, -d, -PI / 2); add('lamp-post', -3.2, d, PI / 2);
    add('lamp-post', d, 3.2, PI); add('lamp-post', -d, -3.2, 0);
  }

  // --- Trees inside the village ---
  for (const [x, z] of [[16, -6.5], [-9, -4.8], [-24.5, -18], [24.5, 15.5], [-4.5, 15.5], [4.8, -27], [-26, 12.5], [14.5, -28]]) add('tree-oak', x, z, rand() * PI * 2, 0.85 + rand() * 0.3);
  for (const [x, z] of [[-10.5, 4.2], [11.8, -3.6], [-3.6, 9.8], [3.8, -10.4], [-17.8, -1.4], [17.6, 2.8], [-25, -26], [25.8, -21]]) add('bush', x, z, rand() * PI * 2, 1.0 + rand() * 0.4, false);

  // --- Forest & rocks outside the palisade ---
  const outside = [];
  let tries = 0;
  while (outside.length < 70 && tries++ < 4000) {
    const x = (rand() * 2 - 1) * 60, z = (rand() * 2 - 1) * 60;
    const m = Math.max(Math.abs(x), Math.abs(z));
    if (m < 37 || m > 60) continue;
    // keep the eight approach lanes (and the spawn points) clear
    const ang = Math.atan2(x, -z);
    const lane = Math.abs(((ang / (PI / 4)) % 1 + 1) % 1 - 0.5);
    if (lane > 0.36) continue;
    if (outside.some((t) => (t.x - x) ** 2 + (t.z - z) ** 2 < 20)) continue;
    outside.push({ x, z });
  }
  for (const t of outside) add('tree-oak', t.x, t.z, rand() * PI * 2, 0.9 + rand() * 0.5);
  for (let i = 0; i < 26; i++) {
    const a = rand() * PI * 2, d = 35 + rand() * 24;
    add('bush', Math.cos(a) * d, Math.sin(a) * d, rand() * PI * 2, 1 + rand() * 0.6, false);
  }

  // --- Non-colliding ground decoration (instanced on the client) ---
  const decor = { 'grass-tuft': [], 'small-rock': [], 'path-stone-a': [], 'path-stone-b': [], 'grass-terrain-blob': [] };
  const onRoad = (x, z) => (Math.abs(x) < 2.6 && Math.abs(z) > 5 && Math.abs(z) < 33) || (Math.abs(z) < 2.6 && Math.abs(x) > 5 && Math.abs(x) < 33) || Math.hypot(x, z) < 7.2;
  // roads from the plaza to each gate
  for (let d = 6.2; d < 33; d += 0.95) {
    for (const off of [-1.15, 0, 1.15]) {
      const j = () => (rand() - 0.5) * 0.35;
      const pick = () => (rand() < 0.5 ? 'path-stone-a' : 'path-stone-b');
      decor[pick()].push([off + j(), -d + j(), rand() * PI, 0.9 + rand() * 0.4]);
      decor[pick()].push([off + j(), d + j(), rand() * PI, 0.9 + rand() * 0.4]);
      decor[pick()].push([d + j(), off + j(), rand() * PI, 0.9 + rand() * 0.4]);
      decor[pick()].push([-d + j(), off + j(), rand() * PI, 0.9 + rand() * 0.4]);
    }
  }
  // plaza ring
  for (let rr = 2.0; rr < 7.2; rr += 1.0) {
    const n = Math.round((PI * 2 * rr) / 0.95);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * PI * 2 + rand() * 0.1;
      decor[rand() < 0.5 ? 'path-stone-a' : 'path-stone-b'].push([Math.cos(a) * rr, Math.sin(a) * rr, rand() * PI, 0.9 + rand() * 0.4]);
    }
  }
  for (let i = 0; i < 520; i++) {
    const x = (rand() * 2 - 1) * 61, z = (rand() * 2 - 1) * 61;
    if (onRoad(x, z)) continue;
    decor['grass-tuft'].push([x, z, rand() * PI * 2, 0.8 + rand() * 0.8]);
  }
  for (let i = 0; i < 90; i++) {
    const x = (rand() * 2 - 1) * 61, z = (rand() * 2 - 1) * 61;
    if (onRoad(x, z)) continue;
    decor['small-rock'].push([x, z, rand() * PI * 2, 0.6 + rand() * 1.2]);
  }
  for (let i = 0; i < 70; i++) {
    const x = (rand() * 2 - 1) * 60, z = (rand() * 2 - 1) * 60;
    if (onRoad(x, z)) continue;
    decor['grass-terrain-blob'].push([x, z, rand() * PI * 2, 0.9 + rand() * 0.8]);
  }

  // --- NPC positions (in front of their stalls / building) ---
  const npcs = {
    arcanist: { x: arcStall.x + 1.25, z: arcStall.z, r: -PI / 2 },
    trader: { x: trdStall.x + 1.25, z: trdStall.z, r: -PI / 2 },
    librarian: { x: lx, z: lz, r: PI / 4 },
  };
  return { props, decor, npcs };
}

// Palisade: a square of 2m fence sections with a magic gate in the middle of each side.
// Gates let wizards through but stop zombies.
export function buildFenceSegments() {
  const H = VILLAGE_HALF;
  const segs = [];
  const push = (x, z, axis, gate) => segs.push({ id: segs.length, x, z, axis, rot: axis === 'x' ? 0 : PI / 2, gate });
  // North (z=-H) west->east, then East (x=+H) north->south, South east->west, West south->north (a ring order).
  for (let i = 0; i < 31; i++) push(-30 + 2 * i, -H, 'x', i === 15);
  for (let i = 0; i < 31; i++) push(H, -30 + 2 * i, 'z', i === 15);
  for (let i = 0; i < 31; i++) push(30 - 2 * i, H, 'x', i === 15);
  for (let i = 0; i < 31; i++) push(-H, 30 - 2 * i, 'z', i === 15);
  return segs;
}

export function insideVillage(x, z, margin = 0) {
  return Math.abs(x) < VILLAGE_HALF - margin && Math.abs(z) < VILLAGE_HALF - margin;
}

// World-space collider shapes for every solid prop.
export function buildObstacles(layout) {
  const out = [];
  for (const p of layout.props) {
    if (!p.solid) continue;
    const f = FOOTPRINTS[p.a];
    if (!f) continue;
    const s = p.s || 1;
    if (f.box) {
      const [cx, cz] = rotLocal(p.x, p.z, p.r, f.box[0] * s, f.box[1] * s);
      out.push({ type: 'box', x: cx, z: cz, hx: f.box[2] * s, hz: f.box[3] * s, rot: p.r, a: p.a });
    } else if (f.circle) {
      const [cx, cz] = rotLocal(p.x, p.z, p.r, f.circle[0] * s, f.circle[1] * s);
      out.push({ type: 'circle', x: cx, z: cz, r: f.circle[2] * s, a: p.a });
    }
  }
  for (const n of Object.values(layout.npcs)) out.push({ type: 'circle', x: n.x, z: n.z, r: 0.45, a: 'npc' });
  return out;
}
