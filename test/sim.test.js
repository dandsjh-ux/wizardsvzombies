import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/game.js';
import { MAX_PLAYERS } from '../shared/data.js';

function client() {
  return {
    inbox: [],
    sendRaw(s) { this.inbox.push(JSON.parse(s)); },
    send(o) { this.inbox.push(o); },
    close() { this.closed = true; },
    last(t) { return [...this.inbox].reverse().find((m) => m.t === t); },
  };
}

function connect(g, token) {
  const c = client();
  g.onConnect(c);
  g.onMessage(c, { t: 'hello', token });
  return c;
}

test('first wizard starts the single shared game; others join it; a 4th is turned away', () => {
  const g = new Game();
  assert.equal(g.phase, 'lobby');
  const a = connect(g, 'tokenAAAAAAAA');
  g.onMessage(a, { t: 'join', name: 'Ann', cls: 'striker' });
  assert.equal(g.phase, 'prep');
  const b = connect(g, 'tokenBBBBBBBB');
  assert.equal(b.last('welcome').you, null);
  assert.equal(b.last('welcome').phase, 'prep');
  g.onMessage(b, { t: 'join', name: 'Bob', cls: 'healer' });
  const c = connect(g, 'tokenCCCCCCCC');
  g.onMessage(c, { t: 'join', name: 'Cat', cls: 'augmenter' });
  assert.equal(g.players.size, MAX_PLAYERS);
  const d = connect(g, 'tokenDDDDDDDD');
  g.onMessage(d, { t: 'join', name: 'Dan', cls: 'striker' });
  assert.ok(d.last('full'));
  assert.equal(g.players.size, MAX_PLAYERS);
});

test('a disconnected wizard reconnects to the same character with the same token', () => {
  const g = new Game();
  const a = connect(g, 'tokenRECONNECT1');
  g.onMessage(a, { t: 'join', name: 'Ann', cls: 'healer' });
  const id = a.last('welcome').you;
  const p = g.players.get(id);
  p.gold = 777;
  p.level = 5;
  g.onDisconnect(a);
  assert.equal(p.connected, false);
  for (let i = 0; i < 40; i++) g.tick(); // world is paused while nobody is connected
  const a2 = connect(g, 'tokenRECONNECT1');
  const w = a2.last('welcome');
  assert.equal(w.you, id);
  assert.ok(w.tp);
  assert.equal(g.players.get(id).gold, 777);
  assert.equal(g.players.get(id).connected, true);
});

test('zombies attack the palisade, and clearing a wave starts the 30s break', () => {
  const g = new Game();
  const a = connect(g, 'tokenSIMSIMSIM');
  g.onMessage(a, { t: 'join', name: 'Ann', cls: 'striker' });
  g.onMessage(a, { t: 'ready' });
  let sawHit = false;
  for (let i = 0; i < 20 * 120 && g.phase !== 'break'; i++) {
    g.tick();
    if (g.fence.some((f) => f.hp < f.maxHp)) sawHit = true;
    // a "sky wizard" smites any zombie that reaches the palisade
    if (sawHit) for (const z of [...g.zombies.values()]) g.damageZombie(z, 9999, g.players.values().next().value, 'test');
  }
  assert.ok(sawHit, 'zombies reached and damaged the fence');
  assert.equal(g.phase, 'break');
  assert.equal(g.wave, 1);
  assert.ok(Math.abs(g.timer - 30) < 0.5);
  const p = [...g.players.values()][0];
  assert.ok(p.xp > 0 || p.level > 1);
});

test('casting, shopping, building and the quiz work through the message API', () => {
  const g = new Game();
  const a = connect(g, 'tokenSHOPSHOP1');
  g.onMessage(a, { t: 'join', name: 'Ann', cls: 'healer' });
  const p = [...g.players.values()][0];
  p.gold = 1000;
  // trader
  const tr = g.npcs.trader;
  g.onMessage(a, { t: 'mv', x: tr.x - 2, z: tr.z, q: p.tpSeq });
  p.x = tr.x - 2; p.z = tr.z;
  g.onMessage(a, { t: 'buy', item: 'wood', qty: 5 });
  g.onMessage(a, { t: 'buy', item: 'stone', qty: 5 });
  assert.equal(p.wood, 9);
  assert.equal(p.stone, 8);
  // build a shrine next to the trader stall area
  g.onMessage(a, { t: 'build', kind: 'healing_shrine', x: tr.x - 6, z: tr.z + 4, rot: 0 });
  assert.equal(g.constructs.size, 1, 'shrine placed');
  // mend a damaged fence section from range
  const f = g.fence[3];
  f.hp = 100;
  p.x = f.x; p.z = f.z + 5;
  g.time += 5;
  g.onMessage(a, { t: 'cast', s: 'mend', x: f.x, z: f.z });
  assert.ok(f.hp > 100, 'fence repaired');
  // quiz
  const lib = g.npcs.librarian;
  p.x = lib.x; p.z = lib.z + 1;
  g.onMessage(a, { t: 'quizStart' });
  const q = a.last('quizQ');
  assert.ok(q && q.choices.length === 4);
  g.time += 2;
  g.onMessage(a, { t: 'quizAnswer', id: q.id, choice: 0 });
  const r = a.last('quizR');
  assert.ok(r && typeof r.correct === 'boolean');
});
