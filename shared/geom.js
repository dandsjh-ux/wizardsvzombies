// Collision helpers and the navigation grid shared by server (zombie flow field) and client (click-to-move A*).

import { WORLD_HALF } from './layout.js';

// Push a circle (px,pz,r) out of a shape. Returns [x, z] (unchanged when not overlapping).
export function pushOut(px, pz, r, s) {
  if (s.type === 'circle') {
    const dx = px - s.x, dz = pz - s.z;
    const rr = r + s.r;
    const d2 = dx * dx + dz * dz;
    if (d2 >= rr * rr) return null;
    const d = Math.sqrt(d2) || 0.0001;
    return [s.x + (dx / d) * rr, s.z + (dz / d) * rr];
  }
  // oriented box: rotation r maps local (x,z) -> world (x cos + z sin, -x sin + z cos)
  const c = Math.cos(s.rot), sn = Math.sin(s.rot);
  const dx = px - s.x, dz = pz - s.z;
  const lx = dx * c - dz * sn;
  const lz = dx * sn + dz * c;
  const qx = Math.max(-s.hx, Math.min(s.hx, lx));
  const qz = Math.max(-s.hz, Math.min(s.hz, lz));
  let ox = lx - qx, oz = lz - qz;
  const d2 = ox * ox + oz * oz;
  if (d2 >= r * r) return null;
  let nlx, nlz;
  if (d2 > 1e-8) {
    const d = Math.sqrt(d2);
    nlx = qx + (ox / d) * r;
    nlz = qz + (oz / d) * r;
  } else {
    // centre inside the box: exit through the nearest face
    const ex = s.hx - Math.abs(lx), ez = s.hz - Math.abs(lz);
    if (ex < ez) { nlx = Math.sign(lx || 1) * (s.hx + r); nlz = lz; }
    else { nlx = lx; nlz = Math.sign(lz || 1) * (s.hz + r); }
  }
  return [s.x + nlx * c + nlz * sn, s.z - nlx * sn + nlz * c];
}

export function shapeContains(s, px, pz, pad = 0) {
  if (s.type === 'circle') return (px - s.x) ** 2 + (pz - s.z) ** 2 < (s.r + pad) ** 2;
  const c = Math.cos(s.rot), sn = Math.sin(s.rot);
  const dx = px - s.x, dz = pz - s.z;
  const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
  return Math.abs(lx) < s.hx + pad && Math.abs(lz) < s.hz + pad;
}

export function shapeRadius(s) { return s.type === 'circle' ? s.r : Math.hypot(s.hx, s.hz); }

// Bucketed static shapes for fast queries.
export class ShapeIndex {
  constructor(cell = 8) { this.cell = cell; this.map = new Map(); }
  key(ix, iz) { return ix * 4096 + iz; }
  add(s) {
    const rad = shapeRadius(s);
    const c = this.cell;
    for (let ix = Math.floor((s.x - rad) / c); ix <= Math.floor((s.x + rad) / c); ix++)
      for (let iz = Math.floor((s.z - rad) / c); iz <= Math.floor((s.z + rad) / c); iz++) {
        const k = this.key(ix, iz);
        let arr = this.map.get(k);
        if (!arr) this.map.set(k, (arr = []));
        arr.push(s);
      }
  }
  remove(s) { for (const arr of this.map.values()) { const i = arr.indexOf(s); if (i >= 0) arr.splice(i, 1); } }
  query(x, z, r, out = []) {
    const c = this.cell;
    out.length = 0;
    const seen = new Set();
    for (let ix = Math.floor((x - r) / c); ix <= Math.floor((x + r) / c); ix++)
      for (let iz = Math.floor((z - r) / c); iz <= Math.floor((z + r) / c); iz++) {
        const arr = this.map.get(this.key(ix, iz));
        if (arr) for (const s of arr) if (!seen.has(s)) { seen.add(s); out.push(s); }
      }
    return out;
  }
}

const tmpList = [];
// Resolve a moving circle against an index of shapes; `skip(shape)` can exclude shapes (e.g. open gates).
export function resolveCollisions(index, x, z, r, skip) {
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const s of index.query(x, z, r + 1, tmpList)) {
      if (skip && skip(s)) continue;
      const p = pushOut(x, z, r, s);
      if (p) { x = p[0]; z = p[1]; moved = true; }
    }
    if (!moved) break;
  }
  return [x, z];
}

// ---------------------------------------------------------------------------
// Navigation grid: 1m cells covering the whole world.
export const GRID_N = WORLD_HALF * 2 + 4; // 128
export const GRID_MIN = -(GRID_N / 2);
export const cellOf = (v) => Math.max(0, Math.min(GRID_N - 1, Math.floor(v - GRID_MIN)));
export const cellCenter = (i) => GRID_MIN + i + 0.5;

export class NavGrid {
  constructor() {
    this.n = GRID_N;
    this.blocked = new Uint8Array(GRID_N * GRID_N); // static obstacles
    this.fence = new Int16Array(GRID_N * GRID_N).fill(-1); // fence segment id per cell
    this.dyn = new Int32Array(GRID_N * GRID_N).fill(-1); // construct (wall) id per cell
  }
  idx(ix, iz) { return iz * this.n + ix; }
  markShapes(shapes, pad) {
    for (const s of shapes) {
      const rad = shapeRadius(s) + pad;
      for (let ix = cellOf(s.x - rad); ix <= cellOf(s.x + rad); ix++)
        for (let iz = cellOf(s.z - rad); iz <= cellOf(s.z + rad); iz++)
          if (shapeContains(s, cellCenter(ix), cellCenter(iz), pad)) this.blocked[this.idx(ix, iz)] = 1;
    }
  }
  markFence(segs) {
    for (const sg of segs) {
      const along = sg.axis === 'x';
      // a 2m section covers two cells along its length (t) and the cell rows either side of its line (k)
      for (let k = -1; k <= 0; k++) {
        for (let t = -1; t <= 0; t++) {
          const ix = cellOf(sg.x + (along ? t : k) + 0.5);
          const iz = cellOf(sg.z + (along ? k : t) + 0.5);
          const i = this.idx(ix, iz);
          this.fence[i] = sg.id;
          this.blocked[i] = 0;
        }
      }
    }
  }
}

// Binary min-heap on (index, priority) for Dijkstra / A*.
class Heap {
  constructor(cap) { this.i = new Int32Array(cap); this.p = new Float32Array(cap); this.n = 0; }
  push(idx, pr) {
    let k = this.n++;
    if (k >= this.i.length) { const ni = new Int32Array(this.i.length * 2); ni.set(this.i); this.i = ni; const np = new Float32Array(this.p.length * 2); np.set(this.p); this.p = np; }
    while (k > 0) {
      const par = (k - 1) >> 1;
      if (this.p[par] <= pr) break;
      this.i[k] = this.i[par]; this.p[k] = this.p[par]; k = par;
    }
    this.i[k] = idx; this.p[k] = pr;
  }
  pop() {
    const top = this.i[0];
    const n = --this.n;
    if (n > 0) {
      const li = this.i[n], lp = this.p[n];
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= n) break;
        if (c + 1 < n && this.p[c + 1] < this.p[c]) c++;
        if (this.p[c] >= lp) break;
        this.i[k] = this.i[c]; this.p[k] = this.p[c]; k = c;
      }
      this.i[k] = li; this.p[k] = lp;
    }
    return top;
  }
}

const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142]];

const NDX = Int8Array.from(DIRS.map((d) => d[0]));
const NDZ = Int8Array.from(DIRS.map((d) => d[1]));
const NW = Float32Array.from(DIRS.map((d) => d[2]));

// Dijkstra flow field from goal cells. extra[i] is the additional cost to ENTER cell i (Infinity = impassable).
// Returns Float32Array dist (Infinity where unreachable).
export function computeFlow(grid, goals, extra) {
  const N = grid.n, total = N * N;
  const blocked = grid.blocked;
  const dist = new Float32Array(total).fill(Infinity);
  const heap = new Heap(8192);
  const done = new Uint8Array(total);
  for (const g of goals) { dist[g] = 0; heap.push(g, 0); }
  while (heap.n) {
    const cur = heap.pop();
    if (done[cur]) continue;
    done[cur] = 1;
    // zombies walk from a neighbour INTO cur, so they pay cur's entry cost
    const ex = extra[cur];
    if (ex === Infinity) continue;
    const d0 = dist[cur];
    const cx = cur % N, cz = (cur / N) | 0;
    for (let k = 0; k < 8; k++) {
      const dx = NDX[k], dz = NDZ[k];
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
      const ni = nz * N + nx;
      if (blocked[ni] || done[ni]) continue;
      if (dx && dz && (blocked[cz * N + nx] || blocked[nz * N + cx])) continue; // no corner cutting
      const nd = d0 + NW[k] * (1 + ex);
      if (nd < dist[ni]) { dist[ni] = nd; heap.push(ni, nd); }
    }
  }
  return dist;
}

// For every cell, the neighbouring cell with the lowest flow distance (-1 at goals / unreachable).
export function flowNext(grid, dist) {
  const N = grid.n, blocked = grid.blocked;
  const next = new Int32Array(N * N).fill(-1);
  for (let iz = 0; iz < N; iz++)
    for (let ix = 0; ix < N; ix++) {
      const i = iz * N + ix;
      let bd = dist[i];
      if (bd === Infinity || bd === 0) continue;
      let best = -1;
      for (let k = 0; k < 8; k++) {
        const dx = NDX[k], dz = NDZ[k];
        const nx = ix + dx, nz = iz + dz;
        if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
        const ni = nz * N + nx;
        if (blocked[ni]) continue;
        if (dx && dz && (blocked[iz * N + nx] || blocked[nz * N + ix])) continue;
        if (dist[ni] < bd) { bd = dist[ni]; best = ni; }
      }
      next[i] = best;
    }
  return next;
}

// A* path on the grid. passable(i) -> bool. Returns array of [x,z] world waypoints (smoothed) or null.
export function findPath(grid, sx, sz, tx, tz, passable, maxIter = 30000) {
  const N = grid.n;
  let si = grid.idx(cellOf(sx), cellOf(sz));
  let ti = grid.idx(cellOf(tx), cellOf(tz));
  if (!passable(ti)) {
    // pick the nearest passable cell around the target
    let best = -1, bd = Infinity;
    const tix = ti % N, tiz = (ti / N) | 0;
    for (let r = 1; r < 6 && best < 0; r++)
      for (let dx = -r; dx <= r; dx++)
        for (let dz = -r; dz <= r; dz++) {
          const x = tix + dx, z = tiz + dz;
          if (x < 0 || z < 0 || x >= N || z >= N) continue;
          const i = z * N + x;
          if (!passable(i)) continue;
          const d = dx * dx + dz * dz;
          if (d < bd) { bd = d; best = i; }
        }
    if (best < 0) return null;
    ti = best;
    tx = cellCenter(ti % N); tz = cellCenter((ti / N) | 0);
  }
  if (si === ti) return [[tx, tz]];
  const g = new Map();
  const came = new Map();
  const heap = new Heap(1024);
  const tix = ti % N, tiz = (ti / N) | 0;
  const h = (i) => { const dx = Math.abs((i % N) - tix), dz = Math.abs(((i / N) | 0) - tiz); return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz); };
  g.set(si, 0);
  heap.push(si, h(si));
  let iter = 0, found = false;
  const closed = new Set();
  while (heap.n && iter++ < maxIter) {
    const cur = heap.pop();
    if (cur === ti) { found = true; break; }
    if (closed.has(cur)) continue;
    closed.add(cur);
    const cx = cur % N, cz = (cur / N) | 0;
    const g0 = g.get(cur);
    for (const [dx, dz, w] of DIRS) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
      const ni = nz * N + nx;
      if (!passable(ni)) continue;
      if (dx && dz && (!passable(cz * N + nx) || !passable(nz * N + cx))) continue;
      const ng = g0 + w;
      if (ng < (g.get(ni) ?? Infinity)) { g.set(ni, ng); came.set(ni, cur); heap.push(ni, ng + h(ni)); }
    }
  }
  if (!found) return null;
  const cells = [];
  for (let c = ti; c !== undefined && c !== si; c = came.get(c)) cells.push(c);
  cells.reverse();
  // string-pull: keep a waypoint only when line of sight from the previous anchor breaks
  const pts = cells.map((c) => [cellCenter(c % N), cellCenter((c / N) | 0)]);
  pts[pts.length - 1] = [tx, tz];
  const out = [];
  let ax = sx, az = sz, i = 0;
  while (i < pts.length) {
    let j = i;
    while (j + 1 < pts.length && lineClear(grid, ax, az, pts[j + 1][0], pts[j + 1][1], passable)) j++;
    out.push(pts[j]);
    ax = pts[j][0]; az = pts[j][1];
    i = j + 1;
  }
  return out;
}

export function lineClear(grid, x0, z0, x1, z1, passable) {
  const d = Math.hypot(x1 - x0, z1 - z0);
  const steps = Math.ceil(d / 0.35);
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
    // sample a little to each side so paths keep clear of corners
    for (const [ox, oz] of [[0, 0], [0.3, 0.3], [-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3]]) {
      if (!passable(grid.idx(cellOf(x + ox), cellOf(z + oz)))) return false;
    }
  }
  return true;
}

// Distance from a point to the surface of a shape (0 when inside).
export function shapeDist(s, px, pz) {
  if (s.type === 'circle') return Math.max(0, Math.hypot(px - s.x, pz - s.z) - s.r);
  const c = Math.cos(s.rot), sn = Math.sin(s.rot);
  const dx = px - s.x, dz = pz - s.z;
  const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
  const qx = Math.max(-s.hx, Math.min(s.hx, lx)), qz = Math.max(-s.hz, Math.min(s.hz, lz));
  return Math.hypot(lx - qx, lz - qz);
}

// Closest point on a shape's surface/interior to (px,pz).
export function shapeClosest(s, px, pz) {
  if (s.type === 'circle') {
    const dx = px - s.x, dz = pz - s.z, d = Math.hypot(dx, dz) || 1;
    return d <= s.r ? [px, pz] : [s.x + (dx / d) * s.r, s.z + (dz / d) * s.r];
  }
  const c = Math.cos(s.rot), sn = Math.sin(s.rot);
  const dx = px - s.x, dz = pz - s.z;
  const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
  const qx = Math.max(-s.hx, Math.min(s.hx, lx)), qz = Math.max(-s.hz, Math.min(s.hz, lz));
  return [s.x + qx * c + qz * sn, s.z - qx * sn + qz * c];
}

// Distance from point to a line segment.
export function segDist(px, pz, ax, az, bx, bz) {
  const vx = bx - ax, vz = bz - az;
  const l2 = vx * vx + vz * vz;
  let t = l2 > 0 ? ((px - ax) * vx + (pz - az) * vz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + vx * t), pz - (az + vz * t));
}
