'use strict';
/* WikiRace: a frontend-only party game.
   The host's tab holds the game state and sends it to every guest over WebRTC (PeerJS).
   Articles come from Wikipedia's API and are rendered in the page so link clicks can be counted.
   POOL (the list of possible start and target articles) is defined in pool.js. */

const PREFIX = 'wikirace-room-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const COUNTDOWN_MS = 6000;
const DNF_PENALTY = 10;
const MAX_PLAYERS = 12;
const API = 'https://en.wikipedia.org/w/api.php?format=json&formatversion=2&origin=*';
const COLORS = ['#ff5a8a', '#ffdd33', '#1fcf7a', '#ff8a3d', '#35c9ff', '#b98cff', '#ff6b5e', '#a6e22e', '#ffb3de', '#2ee6c5', '#ffffff', '#c9d4ff'];

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(area, k) { try { return window[area].getItem(k); } catch { return null; } },
  set(area, k, v) { try { window[area].setItem(k, v); } catch {} },
};
const rand = n => Math.floor(Math.random() * n);
const fmtClock = ms => { const t = Math.floor(Math.max(0, ms) / 100); return `${Math.floor(t / 600)}:${String(Math.floor(t / 10) % 60).padStart(2, '0')}.${t % 10}`; };
const fmtScore = x => x.toFixed(1);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const normTitle = t => { t = String(t).replace(/_/g, ' ').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };
const same = (a, b) => normTitle(a) === normTitle(b);
const colorOf = p => COLORS[(p.color | 0) % COLORS.length];
const cursor = color => `<svg class="cur" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 2.5v17l4.7-4.2 3 7 2.9-1.3-3-6.8 6.3-.2z" fill="${color}" stroke="#0d1233" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- identity ----------
const me = { pid: store.get('sessionStorage', 'wr-pid') || '', name: '' };
if (!me.pid) { me.pid = Math.random().toString(36).slice(2, 12) + Date.now().toString(36); store.set('sessionStorage', 'wr-pid', me.pid); }

let peer = null, isHost = false, state = null;

// ---------- sound, confetti, toast ----------
let actx = null, muted = store.get('localStorage', 'wr-muted') === '1';
function beep(freq, dur = 0.12, when = 0, vol = 0.07) {
  if (muted) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const t = actx.currentTime + when, o = actx.createOscillator(), g = actx.createGain();
    o.type = 'triangle'; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur + 0.02);
  } catch {}
}
const sfx = {
  tick: () => beep(440, 0.1),
  go: () => beep(880, 0.3),
  join: () => { beep(587, 0.08); beep(784, 0.1, 0.08); },
  other: () => beep(784, 0.14),
  arrive: () => [523, 659, 784, 1047].forEach((f, i) => beep(f, 0.18, i * 0.09)),
  win: () => [523, 659, 784, 1047, 1319].forEach((f, i) => beep(f, 0.24, i * 0.12)),
};
function paintMute() { $('mute').textContent = muted ? 'Sound off' : 'Sound on'; $('mute').setAttribute('aria-pressed', String(!muted)); }
$('mute').addEventListener('click', () => { muted = !muted; store.set('localStorage', 'wr-muted', muted ? '1' : '0'); paintMute(); if (!muted) sfx.other(); });
paintMute();

function confetti(n = 90) {
  if (reducedMotion()) return;
  const box = document.createElement('div');
  box.className = 'confetti';
  for (let i = 0; i < n; i++) {
    const p = document.createElement('i');
    p.style.cssText = `left:${Math.random() * 100}%;background:${COLORS[rand(COLORS.length)]};width:${8 + rand(9)}px;height:${10 + rand(12)}px;animation-duration:${1.8 + Math.random() * 1.8}s;animation-delay:${Math.random() * 0.5}s;--sway:${(Math.random() * 2 - 1) * 140}px;--rot:${(Math.random() * 2 - 1) * 900}deg`;
    box.append(p);
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 4800);
}

let toastTimer = 0;
function toast(text) { const t = $('toast'); t.textContent = text; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4000); }
function offline(text) { const o = $('offline'); o.hidden = !text; o.textContent = text || ''; }

// ---------- drifting wall of article links ----------
{
  let html = '';
  for (let r = 0; r < 11; r++) {
    let half = '';
    for (let i = 0; i < 18; i++) half += `<span>${esc(POOL[rand(POOL.length)])}</span>`;
    html += `<div class="wrow" style="animation-duration:${100 + rand(80)}s">${half}${half}</div>`;
  }
  $('wall').innerHTML = html;
}

// =====================================================================
// Host: holds the one true game state and sends it to everyone on change
// =====================================================================
const conns = new Map(); // pid -> connection
const used = new Set();
let roundStartAt = 0, limitTimer = 0, doneTimer = 0;

function newState(code) {
  return { code, phase: 'lobby', settings: { rounds: 3, limit: 180, factor: 0.1 }, round: 0, start: null, target: null, sinceStartMs: 0, players: [], history: [] };
}
function newPlayer(pid, name, host) {
  const taken = new Set(state.players.map(p => p.color));
  let color = 0; while (taken.has(color) && color < COLORS.length - 1) color++;
  return { pid, name, host, color, connected: true, clicks: 0, path: [], finished: false, timeMs: null };
}
function uniqueName(name) {
  let n = name, i = 2;
  while (state.players.some(p => p.name.toLowerCase() === n.toLowerCase())) n = `${name} ${i++}`;
  return n;
}
function cleanPath(path) { return Array.isArray(path) ? path.slice(0, 300).map(x => String(x).slice(0, 200)) : []; }

function hostCreate() {
  isHost = true;
  let code = ''; for (let i = 0; i < 4; i++) code += CODE_CHARS[rand(CODE_CHARS.length)];
  peer = new Peer(PREFIX + code);
  peer.on('open', () => {
    state = newState(code);
    state.players.push(newPlayer(me.pid, me.name, true));
    broadcast();
  });
  peer.on('connection', conn => {
    conn.on('data', msg => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'join') hostJoin(conn, msg);
      else if (conn.pid) hostHandle(conn.pid, msg);
    });
    conn.on('close', () => hostDrop(conn));
    conn.on('error', () => hostDrop(conn));
  });
  peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
  peer.on('error', err => {
    if (err.type === 'unavailable-id' && !state) { peer.destroy(); hostCreate(); return; }
    if (!state) homeError('Could not open a room. Check your internet connection and try again.');
    else if (err.type === 'network' || err.type === 'server-error') toast('Connection to the room service dropped. Players already here can keep playing.');
  });
}

function hostJoin(conn, msg) {
  const pid = String(msg.pid || '').slice(0, 40);
  if (!pid) return;
  let p = state.players.find(x => x.pid === pid);
  const reject = reason => { conn.send({ t: 'reject', reason }); setTimeout(() => conn.close(), 600); };
  if (!p) {
    if (state.phase !== 'lobby') return reject('That game has already started. Ask the host to add you next game.');
    if (state.players.length >= MAX_PLAYERS) return reject('That room is full.');
    p = newPlayer(pid, uniqueName(String(msg.name || '').trim().slice(0, 20) || 'Player'), false);
    state.players.push(p);
  } else {
    const old = conns.get(pid);
    if (old && old !== conn) { old.pid = null; old.close(); }
    p.connected = true;
  }
  conn.pid = pid;
  conns.set(pid, conn);
  broadcast();
}

function hostDrop(conn) {
  const pid = conn.pid;
  if (!pid || conns.get(pid) !== conn) return;
  conns.delete(pid);
  if (state.phase === 'lobby') state.players = state.players.filter(p => p.pid !== pid);
  else { const p = state.players.find(x => x.pid === pid); if (p) p.connected = false; }
  broadcast();
  if (state.phase === 'playing') hostCheckDone();
}

function hostHandle(pid, msg) {
  const p = state.players.find(x => x.pid === pid);
  if (!p || state.phase !== 'playing' || p.finished || msg.round !== state.round) return;
  if (msg.t === 'progress' || msg.t === 'finish') {
    p.clicks = Math.max(0, msg.clicks | 0);
    p.path = cleanPath(msg.path);
    if (msg.t === 'finish') {
      p.finished = true;
      p.timeMs = Math.max(0, Math.min(Number(msg.timeMs) || 0, state.settings.limit * 1000));
    }
    broadcast();
    if (p.finished) hostCheckDone();
  }
}

function broadcast() {
  if (state.phase === 'playing') state.sinceStartMs = Date.now() - roundStartAt;
  const msg = { t: 'state', state };
  for (const c of conns.values()) if (c.open) c.send(msg);
  onState(state);
}

function pickPair() {
  if (POOL.length - used.size < 2) used.clear();
  const pick = () => { let t; do { t = POOL[rand(POOL.length)]; } while (used.has(t)); used.add(t); return t; };
  return [pick(), pick()];
}

function hostStartRound() {
  const [a, b] = pickPair();
  state.round++;
  state.start = a; state.target = b; state.phase = 'playing';
  roundStartAt = Date.now() + COUNTDOWN_MS;
  for (const p of state.players) { p.clicks = 0; p.path = [a]; p.finished = false; p.timeMs = null; }
  clearTimeout(limitTimer); clearTimeout(doneTimer);
  limitTimer = setTimeout(hostEndRound, COUNTDOWN_MS + state.settings.limit * 1000 + 1500);
  broadcast();
}

function hostCheckDone() {
  const active = state.players.filter(p => p.connected);
  if (active.length && active.every(p => p.finished)) { clearTimeout(doneTimer); doneTimer = setTimeout(hostEndRound, 1800); }
}

function hostEndRound() {
  if (state.phase !== 'playing') return;
  clearTimeout(limitTimer); clearTimeout(doneTimer);
  const { factor, limit } = state.settings;
  const results = state.players.map(p => {
    const secs = p.finished ? p.timeMs / 1000 : limit;
    return { pid: p.pid, name: p.name, color: p.color, clicks: p.clicks, secs, finished: p.finished, path: p.path, score: p.clicks + factor * secs + (p.finished ? 0 : DNF_PENALTY) };
  });
  state.history.push({ start: state.start, target: state.target, results });
  state.phase = 'results';
  broadcast();
}

function hostNext() {
  if (state.round >= state.settings.rounds) { state.phase = 'final'; broadcast(); }
  else hostStartRound();
}

function hostPlayAgain() {
  state.history = []; state.round = 0; state.phase = 'lobby';
  state.players = state.players.filter(p => p.connected);
  broadcast();
}

// =====================================================================
// Guest: connects to the host's tab
// =====================================================================
let hostConn = null, joinCode = '', joined = false, rejected = false, reconnectTries = 0, reconnectTimer = 0;

function guestJoin() {
  isHost = false; joined = false; rejected = false; reconnectTries = 0;
  peer = new Peer();
  peer.on('open', connectToHost);
  peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
  peer.on('error', err => {
    if (err.type === 'peer-unavailable') {
      if (!joined) homeError('No room has that code. Check it with your host.');
      else scheduleReconnect();
    } else if (!joined) homeError('Could not connect. Check your internet connection and try again.');
  });
}

function connectToHost() {
  if (!peer || peer.destroyed) return;
  const conn = peer.connect(PREFIX + joinCode, { reliable: true, serialization: 'json' });
  hostConn = conn;
  const timer = setTimeout(() => {
    if (conn.open) return;
    conn.close();
    if (!joined) homeError('Could not reach that room. Some networks block direct connections between browsers; try a different network.');
    else scheduleReconnect();
  }, 15000);
  conn.on('open', () => { clearTimeout(timer); conn.send({ t: 'join', pid: me.pid, name: me.name }); });
  conn.on('data', msg => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'state') { joined = true; reconnectTries = 0; offline(''); onState(msg.state); }
    else if (msg.t === 'reject') { rejected = true; homeError(String(msg.reason || 'The host turned down the connection.')); }
  });
  conn.on('close', () => { clearTimeout(timer); if (joined && !rejected && hostConn === conn) scheduleReconnect(); });
}

function scheduleReconnect() {
  if (reconnectTimer || !joined) return;
  if (++reconnectTries > 20) { offline('Lost the room. The host may have closed their tab.'); return; }
  offline('Connection to the room dropped. Reconnecting.');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = 0;
    if (peer.disconnected && !peer.destroyed) peer.reconnect();
    connectToHost();
  }, 2000);
}

function send(msg) {
  msg.round = localRound;
  if (isHost) hostHandle(me.pid, msg);
  else if (hostConn && hostConn.open) hostConn.send(msg);
}

// =====================================================================
// Home
// =====================================================================
function homeError(text) {
  if (peer && !peer.destroyed) peer.destroy();
  peer = null; state = null; joined = false; isHost = false;
  clearInterval(tickId); tickId = 0;
  offline('');
  document.body.classList.remove('playing');
  $('homeErr').textContent = text;
  $('createBtn').disabled = $('joinBtn').disabled = false;
  show('home');
}

function enter(mode) {
  $('homeErr').textContent = '';
  if (typeof Peer === 'undefined') { $('homeErr').textContent = 'The connection library did not load. Check your internet connection and reload the page.'; return; }
  me.name = $('name').value.trim().slice(0, 20);
  if (!me.name) { $('homeErr').textContent = 'Type a name first.'; $('name').focus(); return; }
  store.set('localStorage', 'wr-name', me.name);
  if (mode === 'join') {
    joinCode = $('code').value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(joinCode)) { $('homeErr').textContent = 'Enter the four-letter room code from your host.'; $('code').focus(); return; }
  }
  $('createBtn').disabled = $('joinBtn').disabled = true;
  beep(660, 0.08);
  if (mode === 'join') guestJoin(); else hostCreate();
}
$('enter').addEventListener('submit', e => {
  e.preventDefault();
  // Pressing Enter in a field joins when a code is filled in, and creates a room otherwise.
  const typed = document.activeElement && document.activeElement.tagName === 'INPUT';
  const mode = typed ? ($('code').value.trim() ? 'join' : 'create') : (e.submitter && e.submitter.value === 'join' ? 'join' : 'create');
  enter(mode);
});

$('name').value = store.get('localStorage', 'wr-name') || '';
{
  const room = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  if (/^[A-Z]{4}$/.test(room)) $('code').value = room;
}
window.addEventListener('beforeunload', e => { if (isHost && state && state.players.length > 1) { e.preventDefault(); e.returnValue = ''; } });

// =====================================================================
// Rendering
// =====================================================================
const SCREENS = ['home', 'lobby', 'game', 'results', 'final'];
function show(id) { for (const s of SCREENS) $(s).hidden = s !== id; }

// What we had already seen in the previous state, so sounds and animations fire once per change.
let seen = { phase: null, round: 0, pids: new Set(), done: new Set() };

function onState(s) {
  state = s;
  const entered = seen.phase !== s.phase || seen.round !== s.round;
  if (s.phase === 'lobby') {
    localRound = 0;
    if (seen.phase === 'lobby' && s.players.some(p => !seen.pids.has(p.pid) && p.pid !== me.pid)) sfx.join();
  }
  if (s.phase === 'playing') {
    if (localRound !== s.round) beginRound(s);
    else for (const p of s.players) {
      if (p.finished && !seen.done.has(p.pid) && p.pid !== me.pid) { toast(`${p.name} made it in ${plural(p.clicks, 'click')}.`); sfx.other(); }
    }
  } else { clearInterval(tickId); tickId = 0; $('countdown').hidden = true; $('banner').hidden = true; }
  document.body.classList.toggle('playing', s.phase === 'playing');
  if (s.phase === 'lobby') renderLobby();
  else if (s.phase === 'playing') renderGame();
  else if (s.phase === 'results') renderResults(entered);
  else renderFinal(entered);
  show(s.phase === 'playing' ? 'game' : s.phase);
  if (entered && s.phase !== 'playing') { window.scrollTo(0, 0); $('toast').hidden = true; }
  if (entered && s.phase === 'final') { confetti(150); sfx.win(); }
  seen = { phase: s.phase, round: s.round, pids: new Set(s.players.map(p => p.pid)), done: new Set(s.players.filter(p => p.finished).map(p => p.pid)) };
}

const hostName = () => (state.players.find(p => p.host) || {}).name || 'the host';
function ruleText() {
  const { factor, limit } = state.settings;
  return `Score = clicks + ${factor} × seconds. Lowest score wins. Anyone who has not arrived after ${limit / 60} ${limit === 60 ? 'minute' : 'minutes'} is scored at the full time limit plus ${DNF_PENALTY} points.`;
}

// ---------- waiting room ----------
function renderLobby() {
  const s = state;
  $('lobbyCode').innerHTML = [...s.code].map(ch => `<span>${esc(ch)}</span>`).join('');
  $('peopleHead').textContent = s.players.length === 1 ? 'Just you so far' : `${s.players.length} players in the room`;
  // keyed update, so tags already on screen keep bobbing and only new ones pop in
  const ul = $('lobbyPeople'), have = new Map([...ul.children].map(el => [el.dataset.k, el]));
  s.players.forEach((p, i) => {
    let el = have.get(p.pid);
    if (el) have.delete(p.pid);
    else { el = document.createElement('li'); el.className = 'tag'; el.dataset.k = p.pid; el.style.setProperty('--d', (0.45 + (i % 5) * 0.37) + 's'); }
    const html = `${cursor(colorOf(p))}<span class="nm">${esc(p.name)}${p.host ? '<small>host</small>' : ''}${p.pid === me.pid ? '<small>you</small>' : ''}</span>`;
    if (el.dataset.h !== html) { el.dataset.h = html; el.innerHTML = html; el.style.setProperty('--c', colorOf(p)); }
    if (ul.children[i] !== el) ul.insertBefore(el, ul.children[i] || null);
  });
  for (const el of have.values()) el.remove();

  const sync = (el, v) => { el.disabled = !isHost; if (document.activeElement !== el || !isHost) el.value = v; };
  sync($('setRounds'), s.settings.rounds);
  sync($('setLimit'), s.settings.limit);
  sync($('setFactor'), s.settings.factor);
  $('lobbyRule').textContent = ruleText();
  $('startBtn').hidden = !isHost;
  $('lobbyWait').textContent = isHost
    ? (s.players.length === 1 ? 'You can start alone to try it out, or wait for friends to join.' : '')
    : `Waiting for ${hostName()} to start the race.`;
}
function settingsChanged() {
  if (!isHost || !state) return;
  const clamp = (v, lo, hi, d) => Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  state.settings.rounds = Math.round(clamp(parseFloat($('setRounds').value), 1, 10, state.settings.rounds));
  state.settings.limit = clamp(parseInt($('setLimit').value, 10), 60, 600, 180);
  state.settings.factor = Math.round(clamp(parseFloat($('setFactor').value), 0, 2, state.settings.factor) * 100) / 100;
  broadcast();
}
for (const id of ['setRounds', 'setLimit', 'setFactor']) $(id).addEventListener('change', settingsChanged);
$('startBtn').addEventListener('click', () => { if (isHost) hostStartRound(); });
$('copyBtn').addEventListener('click', async () => {
  const link = location.href.split(/[?#]/)[0] + '?room=' + state.code;
  try { await navigator.clipboard.writeText(link); toast('Invite link copied.'); }
  catch { toast('Copy this link: ' + link); }
});

// ---------- the race ----------
let localRound = 0, t0 = 0, my = null, busy = false, tickId = 0, lastCd = null;

function beginRound(s) {
  localRound = s.round;
  t0 = performance.now() - s.sinceStartMs;
  const mine = s.players.find(p => p.pid === me.pid) || {};
  my = {
    clicks: mine.clicks || 0,
    path: mine.path && mine.path.length ? mine.path.slice() : [s.start],
    finished: !!mine.finished, timeMs: mine.timeMs, timeUp: false,
  };
  busy = false; lastCd = null;
  $('banner').hidden = true;
  if (my.finished) arrivedBanner();
  $('cdRound').textContent = `Round ${s.round} of ${s.settings.rounds}`;
  $('cdStart').textContent = s.start;
  $('cdTarget').textContent = s.target;
  $('cdBlurb').textContent = '';
  $('gTarget').title = '';
  fetchBlurb(s.target).then(d => {
    if (localRound !== s.round || !d) return;
    $('cdBlurb').textContent = d.charAt(0).toUpperCase() + d.slice(1);
    $('gTarget').title = d;
  });
  clearArticle();
  const round = s.round;
  setLoading(true);
  fetchArticle(my.path[my.path.length - 1])
    .then(art => { if (localRound === round) showArticle(art); })
    .catch(() => toast('The starting article would not load. Check your connection.'))
    .finally(() => { if (localRound === round) setLoading(false); });
  if (!tickId) tickId = setInterval(tick, 100);
  tick();
}

function tick() {
  if (!state || state.phase !== 'playing' || !my) return;
  const el = performance.now() - t0, limitMs = state.settings.limit * 1000;
  $('countdown').hidden = el >= 0;
  if (el < 0) {
    const n = Math.ceil(-el / 1000);
    if (n !== lastCd) {
      lastCd = n;
      const c = $('cdNum');
      c.textContent = n;
      c.classList.remove('pop'); void c.offsetWidth; c.classList.add('pop');
      if (n <= 3) sfx.tick();
    }
  } else if (lastCd !== null) { lastCd = null; sfx.go(); }
  const shown = my.finished ? my.timeMs : Math.min(Math.max(el, 0), limitMs);
  $('timer').textContent = fmtClock(shown);
  $('limitFill').style.width = (100 * shown / limitMs) + '%';
  if (!my.finished && !my.timeUp && el >= limitMs) {
    my.timeUp = true;
    const b = $('banner'); b.textContent = 'Time is up. Adding up the scores.'; b.hidden = false;
  }
}

function renderGame() {
  const s = state;
  $('gRound').textContent = `Round ${s.round} of ${s.settings.rounds}`;
  $('gStart').textContent = s.start;
  $('gTarget').textContent = s.target;
  $('endBtn').hidden = !isHost;
  $('hudPlayers').innerHTML = s.players.map(p => {
    const mine = p.pid === me.pid && my;
    const clicks = mine ? my.clicks : p.clicks;
    const done = mine ? my.finished : p.finished;
    const time = mine ? my.timeMs : p.timeMs;
    const right = done ? `${clicks} in ${(time / 1000).toFixed(1)}s` : plural(clicks, 'click');
    return `<li class="${mine ? 'me ' : ''}${done ? 'done ' : ''}${p.connected ? '' : 'off'}"><span class="n">${cursor(colorOf(p))}<span>${esc(p.name)}${p.connected ? '' : ' (away)'}</span></span><span class="c">${right}</span></li>`;
  }).join('');
}
$('endBtn').addEventListener('click', () => { if (isHost) hostEndRound(); });

function arrivedBanner() {
  const b = $('banner');
  b.textContent = `You reached ${state.target} in ${plural(my.clicks, 'click')} and ${(my.timeMs / 1000).toFixed(1)} seconds. Waiting for everyone else.`;
  b.hidden = false;
}

const canClick = () => state && state.phase === 'playing' && my && !busy && !my.finished && !my.timeUp && performance.now() - t0 >= 0;

async function go(title, frag) {
  if (!canClick()) return;
  const round = localRound;
  busy = true; setLoading(true);
  my.clicks++;
  const finish = () => {
    my.finished = true;
    my.timeMs = performance.now() - t0;
    send({ t: 'finish', clicks: my.clicks, timeMs: my.timeMs, path: my.path });
    arrivedBanner(); confetti(80); sfx.arrive();
  };
  if (same(title, state.target)) { my.path.push(state.target); finish(); }
  else renderGame();
  try {
    const art = await fetchArticle(title);
    if (round !== localRound || state.phase !== 'playing') return;
    if (!my.finished) {
      my.path.push(art.title);
      if (same(art.title, state.target)) finish();
      else send({ t: 'progress', clicks: my.clicks, path: my.path });
    }
    showArticle(art, frag);
  } catch {
    if (round === localRound && !my.finished) {
      my.clicks--;
      renderGame();
      toast('That article would not load. Try the link again or pick another.');
    }
  } finally {
    if (round === localRound) { busy = false; setLoading(false); }
  }
}

// ---------- Wikipedia ----------
const cache = new Map();
async function fetchArticle(title) {
  const key = normTitle(title);
  if (cache.has(key)) return cache.get(key);
  const url = `${API}&action=parse&redirects=1&prop=text%7Cdisplaytitle&disableeditsection=1&page=${encodeURIComponent(title)}`;
  let res;
  for (let attempt = 0; ; attempt++) {   // Wikipedia throttles bursts from one network; wait and retry
    res = await fetch(url);
    if (res.ok || attempt >= 3) break;
    const wait = Math.min(Number(res.headers.get('Retry-After')) || 0, 5) * 1000 || 800 * (attempt + 1);
    await new Promise(r => setTimeout(r, wait));
  }
  if (!res.ok) throw new Error('Wikipedia returned ' + res.status);
  const j = await res.json();
  if (!j.parse) throw new Error(j.error ? j.error.info : 'No article');
  const art = { title: j.parse.title, display: j.parse.displaytitle || esc(j.parse.title), html: j.parse.text };
  cache.set(key, art); cache.set(normTitle(art.title), art);
  return art;
}
async function fetchBlurb(title) {
  try {
    const res = await fetch(`${API}&action=query&prop=description&redirects=1&titles=${encodeURIComponent(title)}`);
    const j = await res.json();
    return (j.query.pages[0] && j.query.pages[0].description) || '';
  } catch { return ''; }
}

const NOT_ARTICLE = /^(File|Image|Media|Category|Help|Wikipedia|WP|Special|Template|Talk|Portal|User|Draft|Module|MediaWiki|Book|TimedText|Education[ _]Program|Gadget|[A-Za-z]+[ _]talk):/i;
const ARTICLE_CSS = `
:host{display:block}
.wr-page{max-width:980px;margin:0 auto;padding:28px 36px 240px;font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#202122;overflow-wrap:break-word}
.wr-page.loading{opacity:.45;pointer-events:none}
h1.wr-title{font:400 2em/1.25 "Linux Libertine",Georgia,"Times New Roman",serif;margin:0;padding-bottom:.12em;border-bottom:1px solid #a2a9b1}
.wr-from{font-size:13px;color:#54595d;margin:.3em 0 1.2em}
.wr-body{overflow-x:auto}
.wr-body::after{content:"";display:block;clear:both}
.wr-license{font-size:12px;color:#72777d;margin-top:3em;border-top:1px solid #eaecf0;padding-top:1em;clear:both}
h2{font:400 1.6em/1.3 "Linux Libertine",Georgia,"Times New Roman",serif;border-bottom:1px solid #a2a9b1;margin:1.2em 0 .4em;padding-bottom:.1em}
h3{font-size:1.2em;margin:1em 0 .3em}
h4,h5,h6{font-size:1.02em;margin:.9em 0 .2em}
p{margin:.5em 0}
a{color:#3366cc;text-decoration:none;cursor:pointer}
a:hover{text-decoration:underline}
a:focus-visible{outline:2px solid #8b3fe0;outline-offset:1px}
img{max-width:100%;height:auto;vertical-align:middle}
ul,ol{margin:.3em 0 .3em 1.6em;padding:0}
li{margin-bottom:.1em}
dd{margin-left:1.6em}
dt{font-weight:bold}
blockquote{margin:1em 2em}
sup,sub{line-height:1}
sup.reference{font-size:80%}
code,pre{font-family:ui-monospace,Consolas,monospace;background:#f8f9fa}
figure{margin:0;max-width:100%}
.infobox,.sidebar{float:right;clear:right;width:22em;max-width:46%;margin:0 0 1em 1.4em;border:1px solid #a2a9b1;background:#f8f9fa;padding:.2em;font-size:88%;line-height:1.5;border-spacing:3px}
.infobox th,.infobox td{vertical-align:top;text-align:left;padding:.15em .3em}
.infobox .infobox-above,.infobox .infobox-title,.infobox .infobox-image,.infobox .infobox-header,.infobox .infobox-subheader,.infobox .infobox-full-data,.infobox caption{text-align:center}
.infobox caption{font-weight:bold;font-size:125%}
.wikitable{border-collapse:collapse;border:1px solid #a2a9b1;background:#f8f9fa;margin:1em 0}
.wikitable th,.wikitable td{border:1px solid #a2a9b1;padding:.2em .4em}
.wikitable th{background:#eaecf0;text-align:center}
.wikitable caption{font-weight:bold}
figure[typeof~="mw:File/Thumb"],figure[typeof~="mw:File/Frame"]{display:table;float:right;clear:right;margin:.4em 0 1.2em 1.4em;border:1px solid #c8ccd1;background:#f8f9fa;padding:3px}
figure.mw-halign-left{float:left;clear:left;margin:.4em 1.4em 1.2em 0}
figure.mw-halign-center,figure.mw-halign-none{float:none;clear:none;margin:.6em auto}
figure.mw-halign-none{margin-left:0}
figcaption{display:table-caption;caption-side:bottom;font-size:88%;line-height:1.4;padding:4px 3px;border:1px solid #c8ccd1;border-top:0;background:#f8f9fa}
figure[typeof~="mw:File"]:not([typeof~="mw:File/Thumb"]):not([typeof~="mw:File/Frame"]) figcaption{display:none}
.thumb{margin-bottom:1em}
.tright,.floatright{float:right;clear:right;margin:.4em 0 1em 1.4em}
.tleft,.floatleft{float:left;clear:left;margin:.4em 1.4em 1em 0}
.thumbinner{border:1px solid #c8ccd1;background:#f8f9fa;padding:3px;font-size:94%;max-width:100%}
.thumbcaption{font-size:88%;line-height:1.4;padding:3px}
.hatnote{font-style:italic;padding-left:1.6em;margin-bottom:.5em}
.reflist,.references,.refbegin{font-size:90%}
.gallery{list-style:none;margin:1em 0;padding:0}
.gallerybox{display:inline-block;vertical-align:top;margin:4px}
.gallerytext{font-size:88%}
.nowrap{white-space:nowrap}
.shortdescription,.mw-empty-elt,.mw-collapsible-toggle,.geo-nondefault,.geo-multi-punct,.mw-cite-backlink .cite-accessibility-label{display:none}
`;

const shadow = $('article').attachShadow({ mode: 'open' });
shadow.innerHTML = `<style>${ARTICLE_CSS}</style><div class="wr-page"><h1 class="wr-title"></h1><p class="wr-from">From Wikipedia, the free encyclopedia</p><div class="wr-body mw-parser-output"></div><p class="wr-license">Text from Wikipedia, available under the Creative Commons Attribution-ShareAlike 4.0 License.</p></div>`;
const pageEl = shadow.querySelector('.wr-page'), titleEl = shadow.querySelector('.wr-title'), bodyEl = shadow.querySelector('.wr-body');

function setLoading(on) { $('loadbar').hidden = !on; pageEl.classList.toggle('loading', on); }
function clearArticle() { titleEl.textContent = ''; bodyEl.textContent = ''; }

function showArticle(art, frag) {
  const doc = new DOMParser().parseFromString(art.html, 'text/html');
  doc.querySelectorAll('script,link,meta,form,input,button,iframe,object,embed,.mw-editsection,.navbox,.navbox-styles,.ambox,.side-box,.sistersitebox,.authority-control,.portal-bar,.mw-indicators').forEach(n => n.remove());
  doc.querySelectorAll('area').forEach(a => a.removeAttribute('href'));
  for (const el of doc.body.querySelectorAll('*')) {
    for (const at of [...el.attributes]) if (at.name.startsWith('on')) el.removeAttribute(at.name);
  }
  for (const a of doc.querySelectorAll('a')) {
    const href = a.getAttribute('href') || '';
    a.removeAttribute('target');
    if (href.startsWith('#')) {            // footnote or section jump on the same page: free
      try { a.dataset.frag = decodeURIComponent(href.slice(1)); } catch { a.dataset.frag = href.slice(1); }
      a.setAttribute('href', '#');
      continue;
    }
    const m = href.match(/^\/wiki\/([^#?]+)(?:#(.*))?$/);
    if (m) {
      let t = m[1], f = m[2] || '';
      try { t = decodeURIComponent(t); f = decodeURIComponent(f); } catch {}
      if (!NOT_ARTICLE.test(t) && t !== 'Main_Page') {
        a.dataset.title = t.replace(/_/g, ' ');
        if (f) a.dataset.frag = f;
        a.setAttribute('href', '#');
        continue;
      }
    }
    a.replaceWith(...a.childNodes);          // external, file, red and special links are not playable
  }
  const abs = v => v.replace(/(^|,\s*)\/\//g, '$1https://').replace(/(^|,\s*)\/(?!\/)/g, '$1https://en.wikipedia.org/');
  for (const el of doc.querySelectorAll('img,source,video,audio')) {
    for (const at of ['src', 'srcset', 'poster']) { const v = el.getAttribute(at); if (v) el.setAttribute(at, abs(v)); }
    if (el.tagName === 'IMG') el.setAttribute('loading', 'lazy');
  }
  titleEl.innerHTML = art.display;
  bodyEl.replaceChildren(...doc.body.childNodes);
  $('article').scrollTop = 0;
  if (frag) jump(frag);
}
function jump(id) { const el = shadow.getElementById(id) || shadow.getElementById(id.replace(/ /g, '_')); if (el) el.scrollIntoView(); }

function onLink(e) {
  const a = e.target.closest && e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  if (e.type !== 'click') return;
  if (a.dataset.title) go(a.dataset.title, a.dataset.frag);
  else if (a.dataset.frag) jump(a.dataset.frag);
}
shadow.addEventListener('click', onLink);
shadow.addEventListener('auxclick', onLink);

// ---------- round results ----------
function totals(s) {
  const m = new Map();
  for (const h of s.history) for (const r of h.results) {
    const t = m.get(r.pid) || { pid: r.pid, name: r.name, color: r.color, clicks: 0, secs: 0, score: 0, finishes: 0 };
    t.name = r.name; t.clicks += r.clicks; t.secs += r.secs; t.score += r.score; t.finishes += r.finished ? 1 : 0;
    m.set(r.pid, t);
  }
  return [...m.values()];
}
const stat = (value, label, cls = '') => `<div class="stat ${cls}"><b>${value}</b><small>${label}</small></div>`;
const whoLine = r => `<div class="nmline">${cursor(colorOf(r))}<span>${esc(r.name)}</span>${r.pid === me.pid ? '<span class="you">you</span>' : ''}</div>`;

function renderResults(entered) {
  const s = state, h = s.history[s.history.length - 1], n = s.history.length;
  const tot = new Map(totals(s).map(t => [t.pid, t]));
  const last = n >= s.settings.rounds;
  $('resTitle').textContent = `Round ${n} results`;
  $('resRoute').innerHTML = `<u>${esc(h.start)}</u><span aria-hidden="true">&rarr;</span><mark>${esc(h.target)}</mark>`;
  const body = $('resBody');
  body.classList.toggle('enter', entered);
  body.innerHTML = [...h.results].sort((a, b) => a.score - b.score).map((r, i) => {
    const path = r.path.map((t, k) => r.finished && k === r.path.length - 1 ? `<mark>${esc(t)}</mark>` : `<u>${esc(t)}</u>`).join('<i>&rarr;</i>');
    return `<li class="row" style="--c:${colorOf(r)};--i:${i}">
      <span class="rank">${i + 1}</span>
      <div class="who">${whoLine(r)}<div class="path">${path}</div></div>
      ${stat(r.clicks, r.clicks === 1 ? 'click' : 'clicks')}
      ${r.finished ? stat(r.secs.toFixed(1), 'seconds') : stat('<span class="dnf">DNF</span>', 'out of time')}
      ${stat(fmtScore(r.score), 'points', 'score')}
      ${stat(fmtScore(tot.get(r.pid).score), 'total so far', 'total')}
    </li>`;
  }).join('');
  $('resRule').textContent = ruleText();
  $('nextBtn').hidden = !isHost;
  $('nextBtn').textContent = last ? 'Show final results' : `Start round ${n + 1}`;
  $('resWait').textContent = isHost ? '' : `Waiting for ${hostName()} to ${last ? 'show the final results' : 'start the next round'}.`;
}
$('nextBtn').addEventListener('click', () => { if (isHost) hostNext(); });

// ---------- final results ----------
const BOLT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 1.5 4 14h6.5l-1.5 8.5L19 9.5h-6.5z" fill="#0d1233"/></svg>';
function renderFinal(entered) {
  const s = state, all = totals(s), n = s.history.length;
  const byScore = [...all].sort((a, b) => a.score - b.score);
  const best = key => [...all].sort((a, b) => b.finishes - a.finishes || a[key] - b[key])[0];
  const win = byScore[0], fast = best('secs'), few = best('clicks');
  $('finTitle').textContent = `${win.name} wins!`;
  $('finSub').textContent = `${fmtScore(win.score)} points over ${plural(n, 'round')}, the lowest total in the room`;
  $('finSupers').innerHTML = fast.finishes === 0
    ? `<div class="award none"><p class="name">Nobody reached a target</p><p class="how">Fastest and fewest clicks go unawarded this game.</p></div>`
    : `<div class="award"><span class="ico">${BOLT}</span><p class="what">Fastest</p><p class="name">${esc(fast.name)}</p><p class="how">${fast.secs.toFixed(1)} seconds over ${plural(n, 'round')}</p></div>
       <div class="award"><span class="ico">${cursor('#fff')}</span><p class="what">Fewest clicks</p><p class="name">${esc(few.name)}</p><p class="how">${plural(few.clicks, 'click')} over ${plural(n, 'round')}</p></div>`;
  const body = $('finBody');
  body.classList.toggle('enter', entered);
  body.innerHTML = byScore.map((t, i) => `<li class="row" style="--c:${colorOf(t)};--i:${i + 4}">
      <span class="rank">${i + 1}</span>
      <div class="who">${whoLine(t)}</div>
      ${stat(`${t.finishes}/${n}`, 'finished')}
      ${stat(t.clicks, t.clicks === 1 ? 'click' : 'clicks')}
      ${stat(t.secs.toFixed(1), 'seconds')}
      ${stat(fmtScore(t.score), 'points', 'score')}
    </li>`).join('');
  $('finRule').textContent = ruleText();
  $('againBtn').hidden = !isHost;
  $('finWait').textContent = isHost ? '' : `Waiting for ${hostName()} to start another game.`;
}
$('againBtn').addEventListener('click', () => { if (isHost) hostPlayAgain(); });
