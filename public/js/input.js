// Mouse, touch and keyboard input. Translates raw events into game intents:
// tap/click (move, attack, talk), hold-to-walk, right-click casting, hotkeys, wheel/pinch zoom.

export class Input {
  constructor(canvas, handlers) {
    this.c = canvas;
    this.h = handlers;
    this.keys = new Set();
    this.pointers = new Map();
    this.hover = null; // last mouse position over the canvas
    this.hold = null; // {x, y} screen point while a primary pointer is held down for walking
    this.mouseSeen = false;
    this.pinch = null;
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    window.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', (e) => this.up(e));
    window.addEventListener('pointercancel', (e) => this.up(e, true));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); this.h.zoom(e.deltaY > 0 ? 1.1 : 0.9); }, { passive: false });
    window.addEventListener('keydown', (e) => this.keydown(e));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.hold = null; this.pointers.clear(); });
    canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') this.hover = null; });
  }

  down(e) {
    this.h.unlock();
    if (e.pointerType === 'mouse') this.mouseSeen = true;
    this.c.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now(), type: e.pointerType, button: e.button, moved: false });
    if (this.pointers.size === 2) {
      // second finger: start a pinch, cancel any walking
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
      this.hold = null;
      for (const p of this.pointers.values()) p.moved = true;
      return;
    }
    if (e.pointerType === 'mouse' && e.button === 2) { this.h.rightClick(e.clientX, e.clientY); return; }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.holdTimer = setTimeout(() => {
      const p = this.pointers.get(e.pointerId);
      if (p && this.pointers.size === 1 && !this.h.placing()) this.hold = { x: p.x, y: p.y };
    }, e.pointerType === 'mouse' ? 220 : 260);
  }

  move(e) {
    if (e.pointerType === 'mouse') {
      this.mouseSeen = true;
      this.hover = e.target === this.c ? { x: e.clientX, y: e.clientY } : null;
    }
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    if (Math.hypot(p.x - p.sx, p.y - p.sy) > 12) p.moved = true;
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d > 10 && this.pinch.d > 10) this.h.zoom(this.pinch.d / d);
      this.pinch.d = d;
      return;
    }
    if (p.moved && this.pointers.size === 1 && !this.h.placing()) {
      if (p.type !== 'mouse' || p.button === 0) this.hold = { x: p.x, y: p.y };
    }
    if (this.hold && this.pointers.size === 1) { this.hold.x = p.x; this.hold.y = p.y; }
  }

  up(e, cancel) {
    const p = this.pointers.get(e.pointerId);
    clearTimeout(this.holdTimer);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    const wasHold = !!this.hold;
    if (this.pointers.size === 0) this.hold = null;
    if (cancel || p.moved || wasHold) { if (wasHold) this.h.holdEnd(); return; }
    if (p.type === 'mouse' && p.button !== 0) return;
    if (performance.now() - p.t < 600) this.h.tap(p.x, p.y, p.type);
  }

  keydown(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    this.h.unlock();
    this.keys.add(e.code);
    if (e.repeat) return;
    if (this.h.key(e.code, e.key, e)) e.preventDefault();
  }

  // WASD / arrow keys as a screen-relative direction, or null.
  keyDir() {
    let x = 0, y = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (!x && !y) return null;
    const l = Math.hypot(x, y);
    return [x / l, y / l];
  }
}
