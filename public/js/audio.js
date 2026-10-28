// Tiny procedural sound effects with WebAudio (no audio files to download).

let ctx = null;
let master = null;
let noiseBuf = null;
let muted = false;
const last = {};

try { muted = localStorage.getItem('wvz-muted') === '1'; } catch { /* ignore */ }

export function unlockAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 0.5;
  master.connect(ctx.destination);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}

export function toggleMute() {
  muted = !muted;
  try { localStorage.setItem('wvz-muted', muted ? '1' : '0'); } catch { /* ignore */ }
  if (master) master.gain.value = muted ? 0 : 0.5;
  return muted;
}
export const isMuted = () => muted;

function env(g, t, a, peak, dur) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
}

function tone(freq, dur, type = 'sine', vol = 0.3, slide = 0, delay = 0) {
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
  env(g, t, 0.01, vol, dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.05);
}

function noise(dur, vol = 0.3, filter = 'lowpass', f0 = 2000, f1 = 300, delay = 0, q = 1) {
  const t = ctx.currentTime + delay;
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = filter;
  f.Q.value = q;
  f.frequency.setValueAtTime(f0, t);
  f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
  const g = ctx.createGain();
  env(g, t, 0.005, vol, dur);
  s.connect(f).connect(g).connect(master);
  s.start(t, Math.random() * 0.5);
  s.stop(t + dur + 0.05);
}

const SOUNDS = {
  fire: () => { noise(0.35, 0.25, 'bandpass', 900, 300, 0, 1.5); tone(180, 0.25, 'sawtooth', 0.05, 0.5); },
  frost: () => { tone(1400, 0.25, 'triangle', 0.08, 0.6); noise(0.2, 0.12, 'highpass', 4000, 2000); },
  arcane: () => { tone(660, 0.18, 'triangle', 0.1, 1.6); tone(990, 0.12, 'sine', 0.06, 1.3, 0.04); },
  holy: () => { tone(880, 0.3, 'sine', 0.1, 1.0); tone(1320, 0.3, 'sine', 0.06, 1.0, 0.05); },
  wand: () => { tone(520, 0.08, 'square', 0.04, 1.8); },
  zap: () => { noise(0.25, 0.25, 'highpass', 6000, 1500, 0, 0.7); tone(90, 0.2, 'sawtooth', 0.08, 2); },
  boom: () => { noise(0.8, 0.5, 'lowpass', 1200, 60); tone(70, 0.6, 'sine', 0.35, 0.4); },
  heal: () => { [523, 659, 784].forEach((f, i) => tone(f, 0.35, 'sine', 0.09, 1, i * 0.07)); },
  buff: () => { [392, 523, 659, 784].forEach((f, i) => tone(f, 0.25, 'triangle', 0.07, 1, i * 0.05)); },
  mend: () => { noise(0.08, 0.25, 'bandpass', 1500, 1200, 0, 3); noise(0.08, 0.2, 'bandpass', 1300, 1100, 0.12, 3); tone(700, 0.2, 'sine', 0.05, 1.2, 0.1); },
  hit: () => { noise(0.08, 0.18, 'bandpass', 1800, 600, 0, 1); },
  hurt: () => { tone(160, 0.2, 'square', 0.12, 0.6); noise(0.12, 0.2, 'lowpass', 900, 200); },
  zdie: () => { tone(140, 0.45, 'sawtooth', 0.08, 0.4); noise(0.3, 0.12, 'lowpass', 600, 100); },
  groan: () => { const f = 80 + Math.random() * 40; tone(f, 0.9, 'sawtooth', 0.05, 0.7); tone(f * 1.5, 0.9, 'triangle', 0.03, 0.6); },
  coin: () => { tone(1320, 0.08, 'square', 0.05); tone(1760, 0.15, 'square', 0.05, 1, 0.07); },
  level: () => { [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.4, 'triangle', 0.1, 1, i * 0.09)); },
  horn: () => { tone(110, 1.4, 'sawtooth', 0.12, 1.02); tone(165, 1.4, 'sawtooth', 0.07, 1.01, 0.1); },
  bosshorn: () => { tone(70, 2.2, 'sawtooth', 0.16, 0.9); tone(105, 2.2, 'sawtooth', 0.1, 0.92, 0.15); noise(1.5, 0.12, 'lowpass', 300, 80); },
  fbreak: () => { noise(0.6, 0.45, 'lowpass', 2500, 120); tone(90, 0.4, 'square', 0.1, 0.5); },
  error: () => { tone(200, 0.15, 'square', 0.06, 0.8); },
  right: () => { tone(784, 0.15, 'sine', 0.12); tone(1175, 0.3, 'sine', 0.12, 1, 0.1); },
  wrong: () => { tone(220, 0.3, 'sawtooth', 0.07, 0.7); },
  build: () => { noise(0.1, 0.3, 'bandpass', 700, 500, 0, 2); noise(0.1, 0.3, 'bandpass', 600, 400, 0.15, 2); tone(440, 0.4, 'triangle', 0.08, 1.5, 0.25); },
  well: () => { [392, 494, 587, 784, 988].forEach((f, i) => tone(f, 0.6, 'sine', 0.08, 1, i * 0.06)); noise(0.8, 0.08, 'bandpass', 3000, 1500, 0, 2); },
  click: () => { tone(900, 0.04, 'square', 0.03); },
  clear: () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.5, 'triangle', 0.1, 1, i * 0.12)); },
  die: () => { [392, 330, 262, 196].forEach((f, i) => tone(f, 0.5, 'triangle', 0.1, 1, i * 0.15)); },
};

export function sfx(name, minGap = 0.05) {
  if (!ctx || muted || !SOUNDS[name]) return;
  const now = ctx.currentTime;
  if (last[name] && now - last[name] < minGap) return;
  last[name] = now;
  try { SOUNDS[name](); } catch { /* ignore audio glitches */ }
}
