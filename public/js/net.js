// WebSocket link to the shared game with automatic reconnection. The token in localStorage identifies
// our wizard, so a refresh or dropped connection drops us straight back into the battle.

const TOKEN_KEY = 'wvz-token';

function makeToken() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 24);
}

export class Net {
  constructor(onMessage, onStatus) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    try { this.token = localStorage.getItem(TOKEN_KEY); } catch { this.token = null; }
    if (!this.token || !/^[A-Za-z0-9_-]{8,64}$/.test(this.token)) {
      this.token = makeToken();
      try { localStorage.setItem(TOKEN_KEY, this.token); } catch { /* private mode */ }
    }
    this.attempt = 0;
    this.lastRx = 0;
    this.open = false;
    this.connect();
    setInterval(() => this.heartbeat(), 2500);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.heartbeat(true); });
    window.addEventListener('online', () => this.reconnectNow());
  }

  connect() {
    clearTimeout(this.retryTimer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.open = true;
      this.attempt = 0;
      this.lastRx = performance.now();
      this.send({ t: 'hello', token: this.token });
      this.onStatus('open');
    };
    ws.onmessage = (ev) => {
      if (ws !== this.ws) return;
      this.lastRx = performance.now();
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'welcome' && msg.token && msg.token !== this.token) {
        this.token = msg.token;
        try { localStorage.setItem(TOKEN_KEY, this.token); } catch { /* ignore */ }
      }
      if (msg.t === 'pong') { this.rtt = performance.now() - msg.c; return; }
      this.onMessage(msg);
    };
    ws.onclose = (ev) => {
      if (ws !== this.ws) return;
      this.open = false;
      if (ev.code === 4000) { this.onStatus('replaced'); return; }
      this.onStatus('closed');
      this.scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  scheduleReconnect() {
    clearTimeout(this.retryTimer);
    const delay = Math.min(5000, 400 * 2 ** this.attempt++) + Math.random() * 300;
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  reconnectNow() {
    if (this.open) return;
    this.attempt = 0;
    this.connect();
  }

  heartbeat(forceCheck) {
    if (!this.open) return;
    this.send({ t: 'ping', c: performance.now() });
    // no traffic at all for a while: the socket is dead even if the browser hasn't noticed (sleeping tablets)
    if (performance.now() - this.lastRx > (forceCheck ? 6000 : 9000)) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.open = false;
      this.onStatus('closed');
      this.attempt = 0;
      this.connect();
    }
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }
}
