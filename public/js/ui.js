// DOM user interface: join screen, HUD, panels (shops, build, quiz, help), minimap, world-anchored labels,
// damage numbers and attack-direction indicators.

import * as THREE from 'three';
import {
  CLASSES, SPELLS, CLASS_SPELLS, CONSTRUCTS, CLASS_CONSTRUCTS, ITEMS, CONSUMABLE_ORDER, NPCS, ZOMBIES, ZOMBIE_TYPES,
  spellUpgradeCost, rankVal, MAX_CONSTRUCTS_PER_PLAYER, TOTAL_WAVES, SPAWN_DIRS, directionName, quizStreakMult, WELL_COOLDOWN,
  MAX_PLAYERS,
} from '/shared/data.js';
import { VILLAGE_HALF, HEART } from '/shared/layout.js';
import { sfx, toggleMute, isMuted } from './audio.js';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
const fmt = (n) => (Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1));
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BUFF_ICONS = { empower: ['💪', 'Empowered: more damage'], haste: ['💨', 'Haste: faster movement & spells'], ascend: ['👑', 'Ascendance'], shield: ['🛡', 'Divine Shield'], blades: ['🗡', 'Spectral Blades'], chill: ['🥶', 'Chilled: slowed'] };

export class UI {
  constructor(game) {
    this.g = game;
    this.v3 = new THREE.Vector3();
    this.plates = new Map();
    this.zbars = new Map();
    this.dmgPool = [];
    this.dmgs = [];
    this.edgePool = [];
    this.warnPool = [];
    this.cdTotals = {};
    this.lastHud = 0;
    this.panelKind = null;
    this.chatLines = [];
    this.selectedClass = null;
    this.worldUi = $('#world-ui');
    this.indicators = $('#indicators');
    this.fitScale();
    window.addEventListener('resize', () => this.fitScale());
    this.initJoin();
    this.initHud();
    this.minimap = $('#minimap');
    this.mctx = this.minimap.getContext('2d');
    this.buildStaticMap();
  }

  fitScale() {
    const w = window.innerWidth, h = window.innerHeight;
    const fs = Math.max(10.5, Math.min(17, Math.min(w * 0.75, h) / 50));
    document.documentElement.style.fontSize = fs + 'px';
  }

  // ------------------------------------------------------------------ loading & join
  setLoading(p) { $('#screen-loading .progress div').style.width = Math.round(p * 100) + '%'; }
  hideLoading() { $('#screen-loading').classList.add('hidden'); }

  initJoin() {
    const cards = $('#class-cards');
    for (const [id, c] of Object.entries(CLASSES)) {
      const spells = c.start.map((s) => `${SPELLS[s].icon} ${SPELLS[s].name}`).join(', ');
      const cons = CLASS_CONSTRUCTS[id].map((k) => `${CONSTRUCTS[k].icon} ${CONSTRUCTS[k].name}`).join(', ');
      const card = el('div', 'ccard', `
        <div class="top"><div class="big">${c.icon}</div><div><h2>${c.name}</h2><div class="sub">${c.title}</div></div></div>
        <p>${c.desc}</p>
        <div class="stats"><span class="h">❤ ${c.hp} HP</span><span class="m">💧 ${c.mana} Mana</span><span>👟 ${c.speed}</span></div>
        <div class="list"><b>Starts with:</b> ${spells}<br><b>Spellbooks:</b> ${CLASS_SPELLS[id].length} spells to unlock<br><b>Constructs:</b> ${cons}</div>`);
      card.style.setProperty('--cc', c.color);
      card.onclick = () => {
        this.selectedClass = id;
        for (const x of cards.children) x.classList.toggle('sel', x === card);
        this.updateJoinButton();
        sfx('click');
      };
      cards.appendChild(card);
    }
    const name = $('#join-name');
    try { name.value = localStorage.getItem('wvz-name') || ''; } catch { /* ignore */ }
    name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') $('#join-btn').click(); });
    $('#join-btn').onclick = () => {
      if (!this.selectedClass) return;
      const nm = name.value.trim().slice(0, 16);
      try { localStorage.setItem('wvz-name', nm); } catch { /* ignore */ }
      this.g.join(nm, this.selectedClass);
    };
  }

  updateJoinButton() {
    const b = $('#join-btn');
    const full = this.joinInfo && this.joinInfo.slots <= 0;
    b.disabled = !this.selectedClass || full || !this.g.net.open;
    b.textContent = full ? 'Village is full — waiting for a free spot…' : !this.selectedClass ? 'Choose a class' : this.joinInfo && this.joinInfo.phase !== 'lobby' ? `Join the battle as ${CLASSES[this.selectedClass].name}` : `Start the defence as ${CLASSES[this.selectedClass].name}`;
  }

  showJoin(info) {
    this.joinInfo = info;
    $('#screen-join').classList.remove('hidden');
    $('#hud').classList.add('hidden');
    this.closePanel();
    const st = $('#join-status');
    const n = info.roster.length;
    const names = info.roster.map((r) => `${esc(r.name)} (${CLASSES[r.cls].name}${r.on ? '' : ', away'})`).join(', ');
    if (info.phase === 'lobby' || n === 0) st.textContent = 'No battle in progress — you will begin the defence!';
    else if (info.phase === 'over') st.textContent = 'The last battle is ending — a new one begins shortly…';
    else st.innerHTML = `Battle in progress: <b>Wave ${Math.max(1, info.wave)}</b> · ${n}/${MAX_PLAYERS} wizards${names ? ' — ' + names : ''}`;
    st.classList.toggle('full', info.slots <= 0);
    this.updateJoinButton();
  }

  hideJoin() {
    $('#screen-join').classList.add('hidden');
    $('#hud').classList.remove('hidden');
  }

  // ------------------------------------------------------------------ HUD setup
  initHud() {
    $('#map-buttons').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const a = b.dataset.act;
      if (a === 'rotl') this.g.world.rotateCamera(-1);
      if (a === 'rotr') this.g.world.rotateCamera(1);
      if (a === 'zin') this.g.world.zoom(0.85);
      if (a === 'zout') this.g.world.zoom(1.18);
      if (a === 'sound') this.toggleSound();
      if (a === 'help') this.openPanel('help');
    });
    $('#btn-sound').textContent = isMuted() ? '🔇' : '🔊';
    $('#btn-ready').onclick = () => { this.g.net.send({ t: 'ready' }); sfx('click'); };
    $('#act-build').onclick = () => this.togglePanel('build');
    $('#act-auto').onclick = () => this.g.toggleAuto();
    $('#act-interact').onclick = () => this.g.interact();
    $('#panel .panel-close').onclick = () => this.closePanel();
    $('#place-rot').onclick = () => this.g.placeRotate();
    $('#place-ok').onclick = () => this.g.placeConfirm();
    $('#place-cancel').onclick = () => this.g.placeCancel();
    $('#chat-btn').onclick = () => this.toggleChat();
    const ci = $('#chat-input');
    ci.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { const t = ci.value.trim(); if (t) this.g.net.send({ t: 'chat', text: t }); ci.value = ''; this.toggleChat(false); }
      if (e.key === 'Escape') this.toggleChat(false);
    });
    this.tooltip = $('#tooltip');
  }

  toggleSound() { const m = toggleMute(); $('#btn-sound').textContent = m ? '🔇' : '🔊'; }

  toggleChat(force) {
    const c = $('#chat');
    const open = force ?? !c.classList.contains('open');
    c.classList.toggle('open', open);
    if (open) setTimeout(() => $('#chat-input').focus(), 0);
    else $('#chat-input').blur();
  }

  buildBars() {
    const cls = this.g.cls;
    const sb = $('#skillbar');
    sb.innerHTML = '';
    this.slots = CLASS_SPELLS[cls].map((id, i) => {
      const sp = SPELLS[id];
      const b = el('button', 'slot', `${sp.icon}<span class="key">${i + 1}</span><span class="rank"></span><span class="cost"></span><div class="cd"></div><div class="cdt"></div>`);
      b.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
      b.addEventListener('click', (e) => { e.stopPropagation(); this.g.castSlot(i, null, true); });
      this.attachTip(b, () => this.spellTip(id));
      sb.appendChild(b);
      return { id, b, cd: b.querySelector('.cd'), cdt: b.querySelector('.cdt'), cost: b.querySelector('.cost'), rank: b.querySelector('.rank') };
    });
    const ib = $('#itembar');
    ib.innerHTML = '';
    this.itemSlots = CONSUMABLE_ORDER.map((id) => {
      const it = ITEMS[id];
      const b = el('button', 'slot small', `${it.icon}<span class="key">${it.key}</span><span class="cnt"></span>`);
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => { e.stopPropagation(); this.g.useItem(id, true); });
      this.attachTip(b, () => `<b>${it.icon} ${it.name}</b> <small>[${it.key}]</small><br>${it.desc}<div class="st">Buy from Gareth the Trader — ${it.price} gold</div>`);
      ib.appendChild(b);
      return { id, b, cnt: b.querySelector('.cnt') };
    });
    const C = CLASSES[cls];
    $('#me-icon').textContent = C.icon;
    $('#me-portrait').style.borderColor = C.color;
    $('#me-name').textContent = this.g.name;
    $('#me-class').textContent = C.name;
  }

  attachTip(target, html) {
    target.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'mouse') return;
      this.tooltip.innerHTML = html();
      this.tooltip.classList.remove('hidden');
      const r = target.getBoundingClientRect();
      const tr = this.tooltip.getBoundingClientRect();
      this.tooltip.style.left = Math.max(6, Math.min(window.innerWidth - tr.width - 6, r.left + r.width / 2 - tr.width / 2)) + 'px';
      this.tooltip.style.top = Math.max(6, r.top - tr.height - 8) + 'px';
    });
    target.addEventListener('pointerleave', () => this.tooltip.classList.add('hidden'));
  }

  spellStats(id, rank) {
    const s = SPELLS[id];
    const R = (v) => rankVal(v, rank);
    const parts = [];
    if (s.dmg) parts.push(`${s.kind === 'zone' ? 'Dmg/tick' : s.kind === 'missiles' ? 'Dmg each' : 'Damage'} ${fmt(R(s.dmg))}`);
    if (s.heal) parts.push(`${s.kind === 'zone' ? 'Heal/tick' : 'Heal'} ${fmt(R(s.heal))}`);
    if (s.repair) parts.push(`Repair ${fmt(R(s.repair))}`);
    if (s.absorb) parts.push(`Absorb ${fmt(R(s.absorb))}`);
    if (s.count) parts.push(`${R(s.count)} missiles`);
    if (s.jumps) parts.push(`${R(s.jumps)} jumps`);
    if (s.pierce) parts.push(`pierces ${R(s.pierce)}`);
    if (s.value) parts.push(`+${Math.round(R(s.value) * 100)}%`);
    if (s.amp) parts.push(`+${Math.round(R(s.amp) * 100)}% dmg taken`);
    if (s.restore) parts.push(`+${R(s.restore)} mana`);
    if (s.pulse) parts.push(`Blast ${R(s.pulse)}`);
    if (s.repairPct) parts.push(`Restore ${Math.round(R(s.repairPct) * 100)}% fences`);
    if (s.dur && typeof R(s.dur) === 'number') parts.push(`${fmt(R(s.dur))}s`);
    parts.push(`CD ${fmt(R(s.cd))}s`);
    parts.push(`${R(s.mana)} mana`);
    return parts.join(' · ');
  }

  spellTip(id) {
    const s = SPELLS[id];
    const rank = this.g.me?.sp?.[id] || 0;
    const head = `<b>${s.icon} ${s.name}</b> ${rank ? '★'.repeat(rank) + '☆'.repeat(3 - rank) : '<small>(locked)</small>'}`;
    const body = `<br>${s.desc}<div class="st">${this.spellStats(id, Math.max(1, rank))}</div>`;
    const foot = rank ? '' : `<div class="st">Learn from Mystra the Arcanist — level ${s.level}, ${s.price} gold</div>`;
    return head + body + foot;
  }

  // ------------------------------------------------------------------ announcements, toasts, chat
  announce(text, kind = 'info') {
    const box = $('#announce');
    const a = el('div', 'ann ' + kind, esc(text));
    box.appendChild(a);
    while (box.children.length > 4) box.firstChild.remove();
    const life = kind === 'wave' || kind === 'boss' ? 5500 : 4200;
    setTimeout(() => a.classList.add('out'), life);
    setTimeout(() => a.remove(), life + 600);
  }

  toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  chat(from, cls, text) {
    const log = $('#chat-log');
    const d = el('div', '', `<b style="color:${CLASSES[cls]?.color || '#fff'}">${esc(from)}:</b> ${esc(text)}`);
    log.appendChild(d);
    while (log.children.length > 7) log.firstChild.remove();
    setTimeout(() => d.classList.add('old'), 15000);
  }

  // ------------------------------------------------------------------ per-frame HUD
  updateHud(now) {
    const g = this.g;
    const me = g.me;
    const P = g.players.get(g.myId);
    if (!me || !P || !this.slots) return;
    const sNow = g.serverNow();
    // cooldown sweeps every frame
    for (const s of this.slots) {
      const rank = me.sp[s.id] || 0;
      const ready = me.cd[s.id] || 0;
      const rem = ready - sNow;
      if (rem > 0) {
        if (!this.cdTotals[s.id] || this.cdTotals[s.id].ready !== ready) this.cdTotals[s.id] = { ready, total: Math.max(rem, 0.1) };
        const p = Math.min(100, (rem / this.cdTotals[s.id].total) * 100);
        s.cd.style.setProperty('--p', p + '%');
        s.cdt.textContent = rem > 1 ? Math.ceil(rem) : rem.toFixed(1);
      } else if (s.cdt.textContent) { s.cd.style.setProperty('--p', '0%'); s.cdt.textContent = ''; }
      const locked = !rank;
      s.b.classList.toggle('locked', locked);
      const cost = rankVal(SPELLS[s.id].mana, Math.max(1, rank));
      s.b.classList.toggle('nomana', !locked && P.mana < cost);
      s.b.classList.toggle('sel', g.selectedSlot === this.slots.indexOf(s));
      s.cost.textContent = locked ? '' : cost || '';
      s.rank.textContent = rank ? '★'.repeat(rank) : '';
    }
    if (now - this.lastHud < 0.1) return;
    this.lastHud = now;

    const setBar = (sel, v, max, text) => {
      const b = typeof sel === 'string' ? $(sel) : sel;
      b.querySelector('.fill').style.width = Math.max(0, Math.min(100, (v / max) * 100)) + '%';
      const sp = b.querySelector('span');
      if (sp && text !== undefined) sp.textContent = text;
    };
    setBar('#me-hp', P.hp, P.maxHp, `${Math.ceil(P.hp)} / ${P.maxHp}`);
    $('#me-hp .shield').style.width = Math.min(100, ((me.sh || 0) / P.maxHp) * 100) + '%';
    setBar('#me-mana', P.mana, P.maxMana, `${Math.floor(P.mana)} / ${P.maxMana}`);
    setBar('#me-xp', me.xp, me.xn, me.lv >= 30 ? 'MAX LEVEL' : `Level ${me.lv} — ${me.xp} / ${me.xn} XP`);
    $('#me-level').textContent = me.lv;
    $('#res-gold').textContent = me.g;
    $('#res-wood').textContent = me.wd;
    $('#res-stone').textContent = me.st;

    for (const it of this.itemSlots) {
      const n = me.inv[it.id] || 0;
      it.cnt.textContent = n;
      it.b.classList.toggle('empty', n <= 0);
    }

    // buffs
    const bf = $('#buffs');
    const keys = Object.keys(me.bf || {}).filter((k) => BUFF_ICONS[k] && me.bf[k] > sNow);
    if (me.inv.phoenix_charm > 0) keys.push('phoenix');
    const sig = keys.map((k) => k + (k === 'phoenix' ? '' : Math.ceil(me.bf[k] - sNow))).join(',');
    if (sig !== this.buffSig) {
      this.buffSig = sig;
      bf.innerHTML = keys.map((k) => k === 'phoenix' ? '<div class="buff" title="Phoenix Charm">🪶</div>' : `<div class="buff" title="${BUFF_ICONS[k][1]}">${BUFF_ICONS[k][0]}<i>${Math.ceil(me.bf[k] - sNow)}</i></div>`).join('');
    }

    // party
    const others = [...g.players.values()].filter((p) => p.id !== g.myId);
    const party = $('#party');
    const psig = others.map((p) => p.id).join(',');
    if (psig !== this.partySig) {
      this.partySig = psig;
      party.innerHTML = '';
      for (const p of others) {
        const C = CLASSES[p.cls];
        const d = el('div', 'pm frame', `<div class="ic" style="border-color:${C.color}">${C.icon}</div><div class="nm"></div><div class="bar hp"><div class="fill"></div></div><div class="bar mana"><div class="fill"></div></div>`);
        d.dataset.id = p.id;
        d.onclick = () => this.g.selectAlly(p.id);
        party.appendChild(d);
      }
    }
    for (const d of party.children) {
      const p = g.players.get(Number(d.dataset.id));
      if (!p) continue;
      d.querySelector('.nm').textContent = `${p.name} · Lv ${p.level}${p.on ? (p.dead ? ' · fallen' : '') : ' · away'}`;
      d.querySelector('.hp .fill').style.width = (p.hp / p.maxHp) * 100 + '%';
      d.querySelector('.mana .fill').style.width = (p.mana / p.maxMana) * 100 + '%';
      d.classList.toggle('off', !p.on);
      d.classList.toggle('dead', p.dead);
      d.style.outline = g.allyTarget === p.id ? '2px solid #9dffb0' : '';
    }

    // wave panel
    const ph = g.phase;
    $('#wave-title').textContent = ph === 'over' ? (g.victory ? 'Victory!' : 'The village has fallen') : `Wave ${Math.max(g.wave, ph === 'prep' ? 1 : g.wave)} / ${TOTAL_WAVES}`;
    let sub = '';
    const dirs = (g.nextDirs || []).map((d) => SPAWN_DIRS[d]?.name).filter(Boolean).join(', ');
    if (ph === 'prep') sub = `Prepare! First wave in <b>${mmss(g.timeLeft)}</b> · from the <span class="dirs">${dirs}</span>`;
    else if (ph === 'break') sub = `Next wave in <b>${mmss(g.timeLeft)}</b> · from the <span class="dirs">${dirs}</span>`;
    else if (ph === 'wave') sub = `Zombies remaining: <b>${g.zl}</b> · attacking from the <span class="dirs">${dirs}</span>`;
    else if (ph === 'over') sub = `A new battle begins in ${mmss(g.timeLeft)}`;
    if (sub !== this.subSig) { this.subSig = sub; $('#wave-sub').innerHTML = sub; }
    setBar('#heart-bar', g.heart.hp, g.heart.maxHp, `Well of Renewal ${Math.ceil(g.heart.hp)} / ${g.heart.maxHp}`);
    $('#heart-bar').classList.toggle('hit', !!g.heart.hit);
    const boss = g.boss;
    $('#boss-bar').classList.toggle('hidden', !boss);
    if (boss) setBar('#boss-bar', boss[2], boss[3], `${ZOMBIES[ZOMBIE_TYPES[boss[1]]].name} — ${boss[2]} / ${boss[3]}`);
    const rb = $('#btn-ready');
    rb.classList.toggle('hidden', !(ph === 'prep' || ph === 'break') || P.dead);
    rb.classList.toggle('on', !!me.rd);
    rb.textContent = me.rd ? 'Ready! (waiting for others)' : 'Ready ✔ — skip the wait';

    // interact button
    const it = g.nearInteract;
    const ib = $('#act-interact');
    ib.classList.toggle('hidden', !it);
    if (it) {
      const lab = { arcanist: ['📜', 'Spells'], trader: ['💰', 'Trade'], librarian: ['📚', 'Word Quiz'], well: ['⛲', 'Well'] }[it];
      let lb = lab[1];
      if (it === 'well') { const r = me.wl - sNow; lb = r > 0 ? `Well ${Math.ceil(r)}s` : 'Use Well'; }
      ib.querySelector('.ic').textContent = lab[0];
      ib.querySelector('.lb').textContent = lb;
    }
    $('#act-auto').classList.toggle('on', g.auto);

    // death overlay
    const dead = P.dead;
    $('#death').classList.toggle('hidden', !dead);
    if (dead) $('#death .s').textContent = `Respawning at the Well in ${Math.max(0, Math.ceil(me.rs - sNow))}s…`;

    if (this.panelKind && this.panelRefresh) this.panelRefresh();
    if (this.panelKind && this.panelNpc && !g.isNear(this.panelNpc)) this.closePanel();
  }

  // ------------------------------------------------------------------ panels
  togglePanel(kind) { if (this.panelKind === kind) this.closePanel(); else this.openPanel(kind); }

  openPanel(kind, data) {
    const g = this.g;
    const p = $('#panel');
    p.classList.remove('hidden');
    this.panelKind = kind;
    this.panelRefresh = null;
    this.panelNpc = null;
    const head = (icon, title, sub) => {
      p.querySelector('.panel-icon').textContent = icon;
      p.querySelector('.panel-title').textContent = title;
      p.querySelector('.panel-sub').textContent = sub;
    };
    const body = p.querySelector('.panel-body');
    body.innerHTML = '';
    body.scrollTop = 0;
    if (kind === 'arcanist') {
      head('📜', NPCS.arcanist.name, 'Spellbooks & tomes of mastery');
      this.panelNpc = 'arcanist';
      this.renderSpellShop(body);
    } else if (kind === 'trader') {
      head('💰', NPCS.trader.name, 'Potions, repairs and building materials');
      this.panelNpc = 'trader';
      this.renderTrader(body);
    } else if (kind === 'build') {
      head('🛠', 'Arcane Constructs', 'Built from timber & stone, enchanted with mana');
      this.renderBuild(body);
    } else if (kind === 'quiz') {
      head('📚', NPCS.librarian.name, 'Word Magic — nouns, adjectives & verbs');
      this.panelNpc = 'librarian';
      this.renderQuizIntro(body);
    } else if (kind === 'help') {
      head('❔', 'How to play', 'Defend the Well of Renewal for 30 waves');
      this.renderHelp(body);
    } else if (kind === 'over') {
      head(data.victory ? '🏆' : '💀', data.victory ? 'Victory!' : 'Defeat', `Reached wave ${data.wave}`);
      this.renderOver(body, data);
    }
  }

  closePanel() {
    if (this.panelKind === 'quiz') this.g.net.send({ t: 'quizStop' });
    this.panelKind = null;
    this.panelRefresh = null;
    this.panelNpc = null;
    $('#panel').classList.add('hidden');
  }

  renderSpellShop(body) {
    const g = this.g;
    body.appendChild(el('p', 'panel-note', `Spellbooks unlock new spells; tomes raise a spell's rank (★★★). Higher ranks need higher levels. You have <b id="shop-gold"></b> gold.`));
    const rows = CLASS_SPELLS[g.cls].map((id) => {
      const s = SPELLS[id];
      const r = el('div', 'row-item', `<div class="ic">${s.icon}</div><div><div class="nm"></div><div class="ds">${s.desc}</div><div class="st"></div></div><div class="btns"><button></button></div>`);
      const btn = r.querySelector('button');
      btn.onclick = () => { g.net.send({ t: 'spell', id }); sfx('click'); };
      body.appendChild(r);
      return { id, r, btn };
    });
    this.panelRefresh = () => {
      const me = g.me;
      body.querySelector('#shop-gold').textContent = me.g;
      for (const { id, r, btn } of rows) {
        const s = SPELLS[id];
        const rank = me.sp[id] || 0;
        r.querySelector('.nm').innerHTML = `${s.name} <small>${rank ? '★'.repeat(rank) + '☆'.repeat(3 - rank) : ''}</small>`;
        const next = Math.min(3, rank + 1);
        r.querySelector('.st').textContent = rank >= 3 ? this.spellStats(id, 3) : `${rank ? 'Next rank: ' : ''}${this.spellStats(id, next)}`;
        r.classList.toggle('owned', rank > 0);
        if (rank >= 3) { btn.textContent = 'Mastered'; btn.disabled = true; btn.className = ''; continue; }
        const cost = rank === 0 ? s.price : spellUpgradeCost(id, rank);
        const req = rank === 0 ? s.level : s.level + rank * 3;
        const lvlOk = me.lv >= req;
        btn.disabled = !lvlOk || me.g < cost;
        btn.className = btn.disabled ? '' : 'primary';
        btn.textContent = !lvlOk ? `Needs Lv ${req}` : `${rank === 0 ? 'Learn' : 'Upgrade'} · ${cost}🪙`;
      }
    };
    this.panelRefresh();
  }

  renderTrader(body) {
    const g = this.g;
    body.appendChild(el('p', 'panel-note', `Timber and stone are used to build constructs (🛠 Build). You have <b id="shop-gold"></b> gold.`));
    const order = ['health_potion', 'mana_potion', 'repair_kit', 'fire_bomb', 'iron_bands', 'phoenix_charm', 'wood', 'stone'];
    const rows = order.map((id) => {
      const it = ITEMS[id];
      const r = el('div', 'row-item', `<div class="ic">${it.icon}</div><div><div class="nm">${it.name} <small></small></div><div class="ds">${it.desc}</div></div><div class="btns"><button class="b1"></button>${it.max > 1 ? '<button class="b5"></button>' : ''}</div>`);
      r.querySelector('.b1').onclick = () => { g.net.send({ t: 'buy', item: id, qty: 1 }); sfx('coin'); };
      const b5 = r.querySelector('.b5');
      if (b5) b5.onclick = () => { g.net.send({ t: 'buy', item: id, qty: 5 }); sfx('coin'); };
      body.appendChild(r);
      return { id, r, b1: r.querySelector('.b1'), b5 };
    });
    this.panelRefresh = () => {
      const me = g.me;
      body.querySelector('#shop-gold').textContent = me.g;
      for (const { id, r, b1, b5 } of rows) {
        const it = ITEMS[id];
        const have = id === 'wood' ? me.wd : id === 'stone' ? me.st : me.inv[id] || 0;
        r.querySelector('.nm small').textContent = `owned ${have}/${it.max}`;
        b1.textContent = `Buy · ${it.price}🪙`;
        b1.disabled = me.g < it.price || have >= it.max;
        b1.className = b1.disabled ? 'b1' : 'b1 primary';
        if (b5) {
          const n = Math.min(5, it.max - have);
          b5.textContent = `×${Math.max(1, n)} · ${it.price * Math.max(1, n)}🪙`;
          b5.disabled = n <= 1 || me.g < it.price * n;
        }
      }
    };
    this.panelRefresh();
  }

  renderBuild(body) {
    const g = this.g;
    body.appendChild(el('p', 'panel-note', `Each construct costs timber 🪵 and stone 🪨 (buy them from Gareth the Trader) and is enchanted with your mana. You can maintain <b>${MAX_CONSTRUCTS_PER_PLAYER}</b> at a time — zombies will attack them! <span id="build-count"></span>`));
    const rows = CLASS_CONSTRUCTS[g.cls].map((id) => {
      const c = CONSTRUCTS[id];
      const r = el('div', 'row-item', `<div class="ic">${c.icon}</div><div><div class="nm">${c.name}</div><div class="ds">${c.desc}</div><div class="st">🪵 ${c.wood} · 🪨 ${c.stone} · 💧 ${c.mana} mana · ${c.hp} HP</div></div><div class="btns"><button></button></div>`);
      const btn = r.querySelector('button');
      btn.onclick = () => { this.closePanel(); g.beginPlacement(id); };
      body.appendChild(r);
      return { id, btn };
    });
    this.panelRefresh = () => {
      const me = g.me;
      const P = g.players.get(g.myId);
      body.querySelector('#build-count').textContent = `(${me.cn}/${MAX_CONSTRUCTS_PER_PLAYER} built)`;
      for (const { id, btn } of rows) {
        const c = CONSTRUCTS[id];
        const lack = me.wd < c.wood ? 'Need timber' : me.st < c.stone ? 'Need stone' : P && P.mana < c.mana ? 'Need mana' : me.cn >= MAX_CONSTRUCTS_PER_PLAYER ? 'Limit reached' : '';
        btn.textContent = lack || 'Build';
        btn.disabled = !!lack;
        btn.className = lack ? '' : 'primary';
      }
    };
    this.panelRefresh();
  }

  renderQuizIntro(body) {
    const me = this.g.me;
    body.innerHTML = `
      <p class="panel-note">"Ah, a young wizard! True magic is made of <b>words</b>. Answer my questions about <b>nouns</b>, <b>adjectives</b> and <b>verbs</b> and I shall share my wisdom (XP). Answer correctly in a row to build a <b>streak</b> — streaks multiply your reward!"</p>
      <div class="mult-ladder">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((s) => `<span>${s} in a row: ×${quizStreakMult(s)}</span>`).join('')}</div>
      <p class="panel-note">Best streak so far: <b>${me.qb || 0}</b>. Stay near the Library while you answer.</p>
      <div style="text-align:center"><button class="btn primary big" id="quiz-go">Begin the lesson</button></div>`;
    body.querySelector('#quiz-go').onclick = () => { this.g.net.send({ t: 'quizStart' }); sfx('click'); };
  }

  showQuizQuestion(q) {
    if (this.panelKind !== 'quiz') this.openPanel('quiz');
    const body = $('#panel .panel-body');
    const fires = '🔥'.repeat(Math.min(5, q.streak));
    body.innerHTML = `
      <div class="quiz-top">
        <span class="qtype ${q.type}">${q.type}</span>
        <span class="streak">${q.streak ? `<span class="fire">${fires}</span> Streak ${q.streak}` : 'No streak yet'}</span>
        <span class="qreward">Next correct: +${q.xp} XP (×${q.mult})</span>
      </div>
      <div class="panel-note">Question ${q.num} · best streak ${q.best}</div>
      <div class="qtext">${esc(q.q)}</div>
      <div class="qchoices">${q.choices.map((c, i) => `<button data-i="${i}">${esc(c)}</button>`).join('')}</div>
      <div class="qfeedback hidden"></div>`;
    this.quizLocked = false;
    for (const b of body.querySelectorAll('.qchoices button')) {
      b.onclick = () => {
        if (this.quizLocked) return;
        this.quizLocked = true;
        b.style.borderColor = '#fff';
        this.g.net.send({ t: 'quizAnswer', id: q.id, choice: Number(b.dataset.i) });
      };
    }
    this.quizShownAt = performance.now();
  }

  showQuizResult(r) {
    if (this.panelKind !== 'quiz') return;
    const body = $('#panel .panel-body');
    const btns = body.querySelectorAll('.qchoices button');
    btns.forEach((b, i) => {
      if (i === r.answer) b.classList.add('right');
      else if (i === r.chosen) b.classList.add('wrong');
      b.disabled = true;
    });
    const fb = body.querySelector('.qfeedback');
    fb.classList.remove('hidden');
    fb.classList.add(r.correct ? 'ok' : 'no');
    fb.innerHTML = r.correct
      ? `<b>✔ Correct!</b> +${r.xp} XP${r.streak > 1 ? ` — streak ${r.streak}! 🔥` : ''}<br>${esc(r.explain)}`
      : `<b>✖ Not quite.</b> The answer is <b>${esc(btns[r.answer]?.textContent || '')}</b>. Your streak resets.<br>${esc(r.explain)}`;
    sfx(r.correct ? 'right' : 'wrong');
    if (r.correct && r.streak >= 3) this.g.fx.levelUp?.call(this.g.fx, this.g.localPos.x, this.g.localPos.z);
  }

  renderHelp(body) {
    body.innerHTML = `<div class="help">
      <h3>Goal</h3>
      <p>Zombies attack the village palisade in 30 waves. If they break through and destroy the <b>Well of Renewal</b> in the village centre, the village falls. Every 10th wave brings a <b>boss</b>. Clear a wave to earn a 30 second break to heal and fortify.</p>
      <h3>Controls</h3>
      <div class="help-grid">
        <kbd>Click / Tap</kbd><span>Move, or attack a zombie. Click villagers to talk, the Well to drink.</span>
        <kbd>Hold &amp; drag</kbd><span>Keep walking toward the pointer</span>
        <kbd>WASD / Arrows</kbd><span>Walk (keyboard)</span>
        <kbd>1 – 8</kbd><span>Cast spells at the mouse cursor (tap a spell on touch: it auto-targets)</span>
        <kbd>Right-click</kbd><span>Cast your last-used spell at the cursor</span>
        <kbd>Q E R T G</kbd><span>Health potion, mana potion, repair kit, fire bomb, iron reinforcement</span>
        <kbd>F</kbd><span>Talk / use the Well when nearby</span>
        <kbd>B</kbd><span>Build constructs</span>
        <kbd>V</kbd><span>Toggle auto-attack (wand bolts at nearby zombies)</span>
        <kbd>[ ]</kbd><span>Rotate camera · mouse wheel or pinch to zoom</span>
        <kbd>Enter</kbd><span>Chat</span><kbd>M</kbd><span>Mute</span>
      </div>
      <h3>Tips</h3>
      <ul>
        <li><b>Red arrows</b> at the screen edge and flashing fences on the minimap show where zombies are attacking. Orange arrows show where the next wave comes from.</li>
        <li>The <b>Well of Renewal</b> fully restores you when you walk up to it — once every ${WELL_COOLDOWN} seconds.</li>
        <li>Visit <b>Mystra</b> (north-east of the plaza) for spellbooks, <b>Gareth</b> (south-east) for potions, repair kits, timber and stone.</li>
        <li><b>Professor Quill</b> at the Library (north-west) gives big XP for English word-magic answers — build a streak!</li>
        <li>Healers mend fences with <b>Mend</b>; any wizard can use a Carpenter's Kit. Broken sections let zombies pour in.</li>
        <li>Wizards can walk through the glowing magic gates; zombies cannot.</li>
      </ul></div>`;
  }

  renderOver(body, d) {
    body.innerHTML = `<div class="over-title ${d.victory ? 'win' : 'lose'}">${d.victory ? 'The village is saved!' : 'The Well has fallen…'}</div>
      <table class="stats"><tr><th>Wizard</th><th>Lv</th><th>Kills</th><th>Damage</th><th>Healed</th><th>Repaired</th><th>Quiz ✔</th><th>Falls</th></tr>
      ${d.stats.map((s) => `<tr><td style="color:${CLASSES[s.cls].color}">${esc(s.name)}</td><td>${s.level}</td><td>${s.kills}</td><td>${Math.round(s.dmg)}</td><td>${Math.round(s.heal)}</td><td>${Math.round(s.repair)}</td><td>${s.quiz}</td><td>${s.deaths}</td></tr>`).join('')}
      </table><p class="panel-note" style="text-align:center;margin-top:0.8rem">A new battle begins shortly — you will be able to choose your class again.</p>`;
  }

  // ------------------------------------------------------------------ minimap
  buildStaticMap() {
    const S = 264, k = S / 132;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const x = c.getContext('2d');
    x.fillStyle = '#34502a';
    x.fillRect(0, 0, S, S);
    const tx = (v) => (v + 66) * k;
    x.fillStyle = '#4c6a36';
    x.fillRect(tx(-VILLAGE_HALF), tx(-VILLAGE_HALF), VILLAGE_HALF * 2 * k, VILLAGE_HALF * 2 * k);
    x.fillStyle = '#8a7a5a';
    x.fillRect(tx(-1.5), tx(-31), 3 * k, 62 * k);
    x.fillRect(tx(-31), tx(-1.5), 62 * k, 3 * k);
    x.beginPath(); x.arc(tx(0), tx(0), 7 * k, 0, Math.PI * 2); x.fill();
    for (const o of this.g.world.obstacles) {
      if (o.a === 'npc') continue;
      x.save();
      x.translate(tx(o.x), tx(o.z));
      if (o.type === 'box') {
        x.rotate(-o.rot);
        x.fillStyle = o.hx * o.hz > 3 ? '#a8754a' : '#6a5a40';
        x.fillRect(-o.hx * k, -o.hz * k, o.hx * 2 * k, o.hz * 2 * k);
      } else {
        x.fillStyle = o.a === 'tree-oak' ? '#24401c' : o.a === 'well' ? '#7ff0ff' : '#6a5a40';
        x.beginPath(); x.arc(0, 0, Math.max(1.2, o.r * k), 0, Math.PI * 2); x.fill();
      }
      x.restore();
    }
    this.staticMap = c;
  }

  drawMinimap(now) {
    const g = this.g;
    const cv = this.minimap;
    const ctx = this.mctx;
    const W = cv.width;
    const R = 62; // world units from centre to edge
    const k = W / 2 / R;
    ctx.save();
    ctx.clearRect(0, 0, W, W);
    ctx.beginPath(); ctx.arc(W / 2, W / 2, W / 2, 0, Math.PI * 2); ctx.clip();
    ctx.translate(W / 2, W / 2);
    ctx.rotate(g.world.camYaw);
    ctx.scale(k, k);
    ctx.drawImage(this.staticMap, -66, -66, 132, 132);
    // fences
    ctx.lineWidth = 1.6;
    for (const f of g.world.fence) {
      const hot = f.hotUntil > now;
      const r = f.hp / f.maxHp;
      ctx.strokeStyle = f.broken ? (hot || Math.sin(now * 8) > 0 ? '#ff2020' : '#400') : hot ? (Math.sin(now * 16) > 0 ? '#ff3030' : '#ffd0a0') : f.gate ? '#7ff0ff' : `rgb(${Math.round(255 - 140 * r)},${Math.round(90 + 140 * r)},60)`;
      ctx.beginPath();
      if (f.axis === 'x') { ctx.moveTo(f.x - 1, f.z); ctx.lineTo(f.x + 1, f.z); } else { ctx.moveTo(f.x, f.z - 1); ctx.lineTo(f.x, f.z + 1); }
      ctx.stroke();
    }
    // incoming directions
    if (g.phase === 'prep' || g.phase === 'break' || (g.phase === 'wave' && g.waveAge < 15)) {
      ctx.fillStyle = 'rgba(255,160,40,0.85)';
      for (const d of g.nextDirs || []) {
        const sd = SPAWN_DIRS[d];
        if (!sd) continue;
        const len = Math.hypot(sd.x, sd.z);
        const ux = sd.x / len, uz = sd.z / len;
        const bx = ux * 52, bz = uz * 52;
        ctx.beginPath();
        ctx.moveTo(ux * 40, uz * 40);
        ctx.lineTo(bx - uz * 5, bz + ux * 5);
        ctx.lineTo(bx + uz * 5, bz - ux * 5);
        ctx.fill();
      }
    }
    // constructs
    for (const c of g.world.constructs.values()) {
      ctx.fillStyle = c.owner === g.myId ? '#ffe08a' : '#c8b07a';
      ctx.fillRect(c.x - 0.9, c.z - 0.9, 1.8, 1.8);
    }
    // heart
    ctx.fillStyle = g.heart.hit && Math.sin(now * 12) > 0 ? '#ff4040' : '#7ff0ff';
    ctx.beginPath(); ctx.arc(HEART.x, HEART.z, 2.2, 0, Math.PI * 2); ctx.fill();
    // NPCs
    ctx.fillStyle = '#ffd36b';
    for (const n of Object.values(g.world.layout.npcs)) { ctx.beginPath(); ctx.arc(n.x, n.z, 1.3, 0, Math.PI * 2); ctx.fill(); }
    // zombies
    for (const z of g.zombies.values()) {
      if (z.dying) continue;
      const boss = ZOMBIES[z.type].boss;
      ctx.fillStyle = boss ? '#ff00ff' : z.flags & 16 ? '#ffb030' : '#ff3a2a';
      const s = boss ? 2.6 : 1.1;
      ctx.fillRect(z.x - s / 2, z.z - s / 2, s, s);
    }
    // players
    for (const p of g.players.values()) {
      if (!p.on) continue;
      ctx.save();
      ctx.translate(p.x, p.z);
      ctx.rotate(-p.f);
      ctx.fillStyle = p.dead ? '#888' : CLASSES[p.cls].color;
      ctx.strokeStyle = p.id === g.myId ? '#fff' : '#000';
      ctx.lineWidth = 0.6;
      ctx.beginPath(); ctx.moveTo(0, 2.6); ctx.lineTo(1.8, -1.6); ctx.lineTo(-1.8, -1.6); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(233,196,106,0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(W / 2, W / 2, W / 2 - 1, 0, Math.PI * 2); ctx.stroke();
    // north marker: world -Z after the map rotation
    const y = g.world.camYaw;
    ctx.fillStyle = '#e9c46a';
    ctx.font = 'bold 15px Nunito, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', W / 2 + (W / 2 - 12) * Math.sin(y), W / 2 - (W / 2 - 12) * Math.cos(y));
  }

  // ------------------------------------------------------------------ world-anchored UI
  project(x, y, z) {
    this.v3.set(x, y, z).project(this.g.world.camera);
    return [(this.v3.x * 0.5 + 0.5) * window.innerWidth, (-this.v3.y * 0.5 + 0.5) * window.innerHeight];
  }

  plate(key, cls, html) {
    let p = this.plates.get(key);
    if (!p) {
      p = el('div', 'plate ' + cls, html);
      this.worldUi.appendChild(p);
      this.plates.set(key, p);
    }
    p.dataset.seen = '1';
    return p;
  }

  updateWorldUi(now, dt) {
    const g = this.g;
    for (const p of this.plates.values()) p.dataset.seen = '';
    // NPC labels
    for (const [key, n] of Object.entries(g.world.layout.npcs)) {
      const d = NPCS[key];
      const p = this.plate('npc-' + key, 'npc', `${key === 'librarian' ? '<span class="bang">❗</span><br>' : ''}<div class="nm">${d.name}</div><div class="role">${d.role}</div>`);
      const [sx, sy] = this.project(n.x, 2.5, n.z);
      p.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -100%)`;
    }
    // players
    for (const pl of g.players.values()) {
      if (!pl.on || !pl.char) continue;
      const mine = pl.id === g.myId;
      const p = this.plate('p-' + pl.id, 'player', `${mine ? '' : `<div class="nm" style="color:${CLASSES[pl.cls].color}">${esc(pl.name)} <small>${pl.level}</small></div>`}<div class="bar hp"><div class="fill"></div></div><div class="bar mana"><div class="fill"></div></div>`);
      const pos = mine ? g.localPos : pl;
      const [sx, sy] = this.project(pos.x, 2.6, pos.z);
      p.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -100%)`;
      p.style.opacity = pl.dead ? 0.35 : 1;
      p.children[mine ? 0 : 1].firstChild.style.width = (pl.hp / pl.maxHp) * 100 + '%';
      p.children[mine ? 1 : 2].firstChild.style.width = (pl.mana / pl.maxMana) * 100 + '%';
      const nm = !mine && p.querySelector('.nm small');
      if (nm && nm.textContent !== String(pl.level)) nm.textContent = pl.level;
    }
    for (const [k, p] of this.plates) if (!p.dataset.seen) { p.remove(); this.plates.delete(k); }

    // zombie health bars (only when hurt)
    const seen = new Set();
    for (const z of g.zombies.values()) {
      if (z.dying || ZOMBIES[z.type].boss) continue;
      if (z.hpPct >= 100 && !(z.flags & 16)) continue;
      seen.add(z.id);
      let b = this.zbars.get(z.id);
      if (!b) { b = el('div', 'zbar' + (z.flags & 16 ? ' elite' : ''), '<div></div>'); this.worldUi.appendChild(b); this.zbars.set(z.id, b); }
      const h = 2.2 * (ZOMBIES[z.type].scale || 1) * (z.flags & 16 ? 1.2 : 1);
      const [sx, sy] = this.project(z.x, h, z.z);
      b.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, 0)`;
      b.firstChild.style.width = z.hpPct + '%';
    }
    // constructs show a health bar once damaged
    for (const c of g.world.constructs.values()) {
      if (c.hp >= c.maxHp) continue;
      const key = 'c' + c.id;
      seen.add(key);
      let b = this.zbars.get(key);
      if (!b) { b = el('div', 'zbar con', '<div></div>'); this.worldUi.appendChild(b); this.zbars.set(key, b); }
      const [sx, sy] = this.project(c.x, 2.6, c.z);
      b.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, 0)`;
      b.firstChild.style.width = Math.max(0, (c.hp / c.maxHp) * 100) + '%';
      b.classList.toggle('hot', c.hotUntil > now);
    }
    for (const [id, b] of this.zbars) if (!seen.has(id)) { b.remove(); this.zbars.delete(id); }

    // floating numbers
    for (let i = this.dmgs.length - 1; i >= 0; i--) {
      const d = this.dmgs[i];
      d.t += dt;
      if (d.t > d.life) { d.el.style.display = 'none'; this.dmgPool.push(d.el); this.dmgs.splice(i, 1); continue; }
      const [sx, sy] = this.project(d.x, d.y, d.z);
      const k = d.t / d.life;
      d.el.style.transform = `translate(${sx + d.dx * k * 30}px, ${sy - 40 * k - 10}px) translate(-50%, -50%) scale(${k < 0.15 ? 0.6 + k * 3 : 1})`;
      d.el.style.opacity = k > 0.6 ? 1 - (k - 0.6) / 0.4 : 1;
    }
    this.updateIndicators(now);
  }

  number(x, z, amt, kind) {
    if (this.dmgs.length > 70) return;
    const e = this.dmgPool.pop() || el('div', 'dmg');
    if (!e.parentNode) this.worldUi.appendChild(e);
    e.style.display = '';
    e.className = 'dmg k' + kind + (amt >= 100 ? ' big' : '');
    e.textContent = kind === 2 || kind === 3 ? '+' + amt : kind === 4 ? 'absorbed' : String(amt);
    this.dmgs.push({ el: e, x, y: kind === 1 || kind === 2 ? 2.4 : 1.8, z, t: 0, life: kind === 0 ? 0.8 : 1.1, dx: (Math.random() - 0.5) });
  }

  // Edge-of-screen arrows toward fence sections under attack, the Well, and incoming waves.
  updateIndicators(now) {
    const g = this.g;
    const W = window.innerWidth, H = window.innerHeight;
    const targets = [];
    // cluster hot fence sections
    const hot = g.world.fence.filter((f) => f.hotUntil > now || (f.broken && g.phase === 'wave' && this.zombiesNear(f.x, f.z, 4)));
    const clusters = [];
    for (const f of hot) {
      let c = clusters.find((c) => Math.hypot(c.x / c.n - f.x, c.z / c.n - f.z) < 9);
      if (!c) { c = { x: 0, z: 0, n: 0, gate: false, broken: false }; clusters.push(c); }
      c.x += f.x; c.z += f.z; c.n++; c.gate ||= f.gate; c.broken ||= f.broken;
    }
    for (const c of clusters) {
      const x = c.x / c.n, z = c.z / c.n;
      targets.push({ x, z, cls: '', label: `${c.broken ? 'BREACH' : c.gate ? 'Gate' : 'Wall'} · ${directionName(x, z)}` });
    }
    if (g.heart.hit) targets.push({ x: HEART.x, z: HEART.z, cls: 'heart', label: 'The Well!' });
    if (g.phase === 'prep' || g.phase === 'break' || (g.phase === 'wave' && g.waveAge < 12)) {
      for (const d of g.nextDirs || []) {
        const sd = SPAWN_DIRS[d];
        if (!sd) continue;
        const len = Math.hypot(sd.x, sd.z);
        targets.push({ x: (sd.x / len) * 44, z: (sd.z / len) * 44, cls: 'incoming', label: `${g.phase === 'wave' ? 'Incoming' : 'Next'}: ${sd.name}`, edgeOnly: true });
      }
    }
    let ei = 0, wi = 0;
    const placed = [];
    // keep arrows clear of the HUD: wave panel on top, skill bar and buttons at the bottom
    const fs = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const mL = 3.5 * fs, mR = 4 * fs, mT = 9.5 * fs, mB = 10.5 * fs;
    for (const t of targets) {
      const [sx, sy] = this.project(t.x, 1.5, t.z);
      const on = sx > mL && sx < W - mR && sy > mT && sy < H - mB;
      if (on) {
        if (t.edgeOnly) continue;
        const w = this.warnPool[wi] || (this.warnPool[wi] = this.indicators.appendChild(el('div', 'warn', '⚠')));
        w.style.display = '';
        w.style.transform = `translate(${sx}px, ${sy - 50}px) translate(-50%, -50%)`;
        wi++;
        continue;
      }
      const cx = (mL + W - mR) / 2, cy = (mT + H - mB) / 2;
      const dx = sx - cx, dy = sy - cy;
      const s = Math.min((W - mR - mL) / 2 / Math.abs(dx || 1e-6), (H - mB - mT) / 2 / Math.abs(dy || 1e-6));
      let ex = cx + dx * s, ey = cy + dy * s;
      // nudge along the edge so labels don't stack; the direction is fixed up front and the
      // number of nudges bounded, so two neighbours can never bounce a label back and forth
      const horizontal = Math.abs(ey - mT) < 2 || Math.abs(ey - (H - mB)) < 2;
      const step = horizontal ? (ex < W / 2 ? 125 : -125) : (ey < H / 2 ? 28 : -28);
      for (let tries = 0; tries < 6 && placed.some(([px, py]) => Math.abs(px - ex) < 120 && Math.abs(py - ey) < 26); tries++) {
        if (horizontal) ex += step; else ey += step;
      }
      placed.push([ex, ey]);
      const ang = Math.atan2(dy, dx);
      const e = this.edgePool[ei] || (this.edgePool[ei] = this.indicators.appendChild(el('div', 'edge', '<div class="arw"></div><div class="lbl"></div>')));
      e.style.display = '';
      e.className = 'edge ' + t.cls;
      e.querySelector('.arw').style.transform = `rotate(${ang}rad)`;
      const lbl = e.querySelector('.lbl');
      if (lbl.textContent !== t.label) lbl.textContent = t.label;
      e.style.transform = `translate(${ex}px, ${ey}px) translate(${dx > 0 ? '-100%' : '0'}, -50%)`;
      e.style.flexDirection = dx > 0 ? 'row-reverse' : 'row';
      ei++;
    }
    for (let i = ei; i < this.edgePool.length; i++) this.edgePool[i].style.display = 'none';
    for (let i = wi; i < this.warnPool.length; i++) this.warnPool[i].style.display = 'none';
  }

  zombiesNear(x, z, r) {
    for (const zb of this.g.zombies.values()) if (!zb.dying && Math.abs(zb.x - x) < r && Math.abs(zb.z - z) < r) return true;
    return false;
  }

  setPlacementInfo(name, hint, bad) {
    $('#place-bar').classList.remove('hidden');
    $('#place-name').textContent = name;
    const h = $('#place-hint');
    h.textContent = hint;
    h.classList.toggle('bad', !!bad);
  }
  hidePlacement() { $('#place-bar').classList.add('hidden'); }
  setConn(state) { $('#conn').classList.toggle('hidden', state); }
}
