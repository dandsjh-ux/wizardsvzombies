// Construct footprint + placement rules, shared so the client's build ghost matches the server's verdict.

import { CONSTRUCTS } from './data.js';
import { PLAYER_BOUND, HEART } from './layout.js';
import { shapeDist } from './geom.js';

export function wallPoint(x, z, rot, along) { return [x + Math.cos(rot) * along, z - Math.sin(rot) * along]; }

// Collision shape of a placed construct (traps have none).
export function constructShape(kind, x, z, rot, id) {
  const d = CONSTRUCTS[kind];
  if (d.trap) return null;
  if (d.wall) return { type: 'box', x, z, hx: d.halfLen, hz: 0.45, rot, con: id };
  return { type: 'circle', x, z, r: d.radius * 0.75, con: id };
}

// Sample points covering a construct's footprint, with the clearance each needs.
export function footprintSamples(kind, x, z, rot) {
  const d = CONSTRUCTS[kind];
  if (!d.wall) return [[x, z, d.trap ? 0.9 : d.radius]];
  const pts = [];
  for (let k = -2; k <= 2; k++) pts.push([...wallPoint(x, z, rot, (d.halfLen * k) / 2), 0.45]);
  return pts;
}

// world: { staticIndex, fenceShapes, npcs: [{x,z}], constructs: iterable of {kind,x,z,shape} }
// Returns null when valid, else a human-readable reason.
export function placementError(world, kind, x, z, rot) {
  if (Math.abs(x) > PLAYER_BOUND - 1 || Math.abs(z) > PLAYER_BOUND - 1) return 'Too far out';
  if (Math.hypot(x - HEART.x, z - HEART.z) < 3.5) return 'Too close to the Well';
  const tmp = [];
  for (const [px, pz, clr] of footprintSamples(kind, x, z, rot)) {
    for (const o of world.staticIndex.query(px, pz, clr + 1, tmp)) if (shapeDist(o, px, pz) < clr) return 'Blocked by a building';
    for (const f of world.fenceShapes) if (Math.abs(f.x - px) < 3 && Math.abs(f.z - pz) < 3 && shapeDist(f, px, pz) < clr + 0.35) return 'Too close to the palisade';
    for (const n of world.npcs) if ((n.x - px) ** 2 + (n.z - pz) ** 2 < 4) return 'Too close to a villager';
    for (const c of world.constructs) {
      const cd = CONSTRUCTS[c.kind];
      if (cd.wall ? shapeDist(c.shape, px, pz) < clr + 0.2 : (c.x - px) ** 2 + (c.z - pz) ** 2 < (clr + cd.radius) ** 2) return 'Too close to another construct';
    }
  }
  return null;
}
