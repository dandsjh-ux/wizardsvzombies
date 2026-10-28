// HTTP + WebSocket entry point. One shared Game instance: the first wizard to join starts it,
// everyone else joins the battle already in progress.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import { WebSocketServer } from 'ws';
import { Game } from './game.js';
import { TICK_RATE } from '../shared/data.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.disable('x-powered-by');
// gzip the kit GLB too (vertex data shrinks a lot); it isn't in compression's default type list
app.use(compression({ filter: (req, res) => req.path.endsWith('.glb') || compression.filter(req, res) }));
app.get('/healthz', (_req, res) => res.type('text').send('ok'));
app.use('/vendor/three/build', express.static(path.join(root, 'node_modules/three/build'), { maxAge: '7d' }));
app.use('/vendor/three/examples/jsm', express.static(path.join(root, 'node_modules/three/examples/jsm'), { maxAge: '7d' }));
app.use('/shared', express.static(path.join(root, 'shared')));
app.use('/assets', express.static(path.join(root, 'public/assets'), { maxAge: '1d' }));
app.use(express.static(path.join(root, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: { threshold: 1024 }, maxPayload: 16 * 1024 });
const game = new Game();

wss.on('connection', (ws) => {
  const client = {
    ws,
    alive: true,
    sendRaw(s) { if (ws.readyState === 1) ws.send(s); },
    send(obj) { this.sendRaw(JSON.stringify(obj)); },
    close() { try { ws.close(4000, 'replaced'); } catch { /* already closed */ } },
  };
  game.onConnect(client);
  ws.on('pong', () => { client.alive = true; });
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    try { game.onMessage(client, msg); } catch (err) { console.error('message error', err); }
  });
  ws.on('close', () => game.onDisconnect(client));
  ws.on('error', () => {});
});

// Drop dead sockets (e.g. a tablet that went to sleep) so their wizard can reconnect cleanly.
setInterval(() => {
  for (const ws of wss.clients) {
    const c = [...game.clients].find((cl) => cl.ws === ws);
    if (c && !c.alive) { ws.terminate(); continue; }
    if (c) c.alive = false;
    ws.ping();
  }
}, 15000);

// Fixed-step simulation loop with drift correction.
const step = 1000 / TICK_RATE;
let next = performance.now();
let slowTicks = 0;
function loop() {
  const now = performance.now();
  let n = 0;
  while (now >= next && n < 5) {
    const t0 = performance.now();
    try { game.tick(); } catch (err) { console.error('tick error', err); }
    if (performance.now() - t0 > step) slowTicks++;
    next += step;
    n++;
  }
  if (now - next > 1000) next = now; // fell far behind (e.g. process paused): skip ahead
  setTimeout(loop, Math.max(0, next - performance.now()));
}
loop();
setInterval(() => { if (slowTicks) { console.warn(`slow ticks in last minute: ${slowTicks}`); slowTicks = 0; } }, 60000);

server.listen(PORT, () => console.log(`Wizards vs Zombies listening on http://localhost:${PORT}`));
