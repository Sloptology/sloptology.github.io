/* WARCRAFT: ATARI (unofficial fan game) browser client.
   The Python server owns all game logic. This file sends input, receives state frames
   and draws them on a 320x192 canvas, plus the DOM HUD and menus. */
(function () {
  'use strict';
  // Where the game server lives. Empty = same origin as this page; set it in config.js when the page is hosted elsewhere (GitHub Pages).
  const API = String(window.NAXX_SERVER || '').replace(/\/+$/, '');
  const $ = (s, r) => (r || document).querySelector(s);
  const A = window.NAXX_AUDIO, SPR = window.NAXX_SPR;
  const W = 320, H = 192, TICK_MS = 1000 / 30;
  const FONT = "'Press Start 2P', 'Courier New', monospace";
  const cv = $('#cv'), ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  let META = null, cur = null, prev = null, tCur = 0, lastMsg = 0, tPrevFrame = performance.now();
  let texts = [], fxs = [], lastState = '', lastEncIdx = -1;
  const touchMode = (window.matchMedia && matchMedia('(pointer: coarse)').matches) || 'ontouchstart' in window || navigator.maxTouchPoints > 1;
  if (touchMode) document.body.classList.add('touch');
  // A phone is one player (you can't share a touchscreen); the partner joins from another device.
  // Every page load is its own session. The room decides which seat(s) this browser controls.
  const sid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('s' + Math.random().toString(36).slice(2) + Date.now().toString(36));
  let room = null;           // { code, seats:[0] | [1] | [0,1] }
  let mode = 'p1';           // 'p1' / 'p2' (one seat, either key set) or 'both' (local co-op)
  let view = 'lobby';
  let myName = '';
  function setSeats(seats) {
    if (!room) return;
    room.seats = seats.slice();
    mode = seats.length > 1 ? 'both' : (seats[0] === 1 ? 'p2' : 'p1');
    uiKey.pl0 = uiKey.pl1 = null; uiKey.tips = null;
    if (cur) updateUI(cur);
  }
  const mySeat = () => (room && room.seats.length ? room.seats[0] : 0);
  const isLocal = () => mode === 'both';
  const nameOf = i => ((cur && cur.room && cur.room.names[i]) || ('P' + (i + 1))).toUpperCase();

  /* ------------------------------------------------------------------ input */
  const MAP0 = { KeyW: 'up', KeyA: 'left', KeyS: 'down', KeyD: 'right', Digit1: 's1', Digit2: 's2', Digit3: 's3', Digit4: 's4', KeyQ: 'c1', KeyE: 'c2', KeyF: 'use', Space: 'ready' };
  const MAP1 = { ArrowUp: 'up', ArrowLeft: 'left', ArrowDown: 'down', ArrowRight: 'right', Digit7: 's1', Digit8: 's2', Digit9: 's3', Digit0: 's4', Minus: 'c1', Equal: 'c2', Slash: 'use', Enter: 'ready', NumpadEnter: 'ready' };
  const DIRS = ['up', 'down', 'left', 'right'];
  const down = new Set();
  const padHeld = [new Set(), new Set()];
  const presses = [[], []];
  let inflight = false, again = false;

  function controlled() { return mode === 'both' ? [0, 1] : mode === 'p1' ? [0] : [1]; }
  function pidOf(cluster) { return mode === 'both' ? cluster : mode === 'p1' ? 0 : 1; }

  function heldFor(pid) {
    const s = new Set();
    down.forEach(code => {
      if (MAP0[code] && DIRS.includes(MAP0[code]) && pidOf(0) === pid) s.add(MAP0[code]);
      if (MAP1[code] && DIRS.includes(MAP1[code]) && pidOf(1) === pid) s.add(MAP1[code]);
    });
    padHeld[pid] && padHeld[pid].forEach(d => s.add(d));
    touchHeld[pid] && touchHeld[pid].forEach(d => s.add(d));
    return Array.from(s);
  }

  // Touch controls and on-screen buttons feed the same held/press paths.
  const touchHeld = [new Set(), new Set()];
  let inflightAt = 0;

  function flush() {
    if (!room) return;
    // A request that never settles (phone sleeping, dropped wifi) must not block input forever.
    if (inflight && performance.now() - inflightAt > 1500) { inflight = false; }
    if (inflight) { again = true; return; }
    const inputs = controlled().map(pid => ({ p: pid, held: heldFor(pid), press: presses[pid].splice(0) }));
    inflight = true; inflightAt = performance.now();
    const ac = window.AbortController ? new AbortController() : null;
    const to = ac ? setTimeout(() => ac.abort(), 1500) : 0;
    // No `keepalive` here: Chrome caps in-flight keepalive requests per page, and once that quota is used up every
    // later fetch is rejected instantly (~700 requests in, i.e. a couple of minutes in) while the page itself keeps
    // working. That silent rejection was the "input just stops" bug. The response body is read so it is released.
    fetch(API + '/api/input', { method: 'POST', body: JSON.stringify({ sid, inputs }), signal: ac ? ac.signal : undefined })
      .then(r => r.text())
      .catch(() => { })
      .finally(() => { clearTimeout(to); inflight = false; if (again) { again = false; flush(); } });
  }

  // Release everything: used whenever the browser might swallow a key-up.
  function releaseAll() {
    down.clear();
    padHeld[0].clear(); padHeld[1].clear();
    touchHeld[0].clear(); touchHeld[1].clear();
    if (window.__joyReset) window.__joyReset();
    flush();
  }
  // Heartbeat: the server drops held directions it has not heard about for ~1s, so a lost
  // key-up or a dropped request can never leave a player running forever.
  setInterval(() => { flush(); }, 350);

  function cmd(name, data) {
    if (!room) return;
    const body = { sid, cmd: { name, data: data || {} } };
    if (name === 'char') body.pk = profileKey();
    fetch(API + '/api/input', { method: 'POST', body: JSON.stringify(body) }).then(r => r.text()).catch(() => { });
  }

  function pressAct(pid, act) {
    if (!controlled().includes(pid)) return;
    if (presses[pid].length < 10) presses[pid].push(act);
    flush();
  }

  const GAMEKEYS = new Set([...Object.keys(MAP0), ...Object.keys(MAP1)]);
  window.addEventListener('keydown', e => {
    if (A) A.init();
    if (e.ctrlKey || e.metaKey || e.altKey) { if (down.size) releaseAll(); return; }
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') {
      if (e.code === 'Escape' && e.target.id === 'chatin') { e.target.blur(); closeChatTouch(); }
      return;
    }
    if (view !== 'room') return;
    if (e.code === 'KeyT' && !e.repeat) { e.preventDefault(); openChat(); return; }
    if (e.code === 'Escape') { cmd('pause'); e.preventDefault(); return; }
    if (e.code === 'KeyM' && !e.repeat) { toggleSound(); return; }
    if (!GAMEKEYS.has(e.code)) return;
    if ((e.code === 'Space' || e.code === 'Enter') && tag === 'BUTTON') return; // let a focused button activate normally
    e.preventDefault();
    if (e.repeat) return;
    down.add(e.code);
    if (MAP0[e.code]) pressAct(pidOf(0), MAP0[e.code]);
    if (MAP1[e.code]) pressAct(pidOf(1), MAP1[e.code]);
    flush();
  });
  window.addEventListener('keyup', e => {
    if (down.delete(e.code)) flush();
    // Releasing a modifier or Meta (Cmd-key combos on Mac never send the key-up) clears the rest.
    if (e.code.startsWith('Meta') || e.code.startsWith('OS')) releaseAll();
  });
  // Keyboard/gamepad state is dropped on anything that could swallow a key-up. A finger on the touch
  // joystick is NOT touched by these (a long press fires 'contextmenu', tapping a button fires 'focusout'),
  // which is what used to leave a phone player idle with a finger still held down.
  function releaseKeys() { down.clear(); padHeld[0].clear(); padHeld[1].clear(); flush(); }
  window.addEventListener('blur', releaseAll);
  window.addEventListener('pagehide', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
  document.addEventListener('fullscreenchange', releaseKeys);
  window.addEventListener('contextmenu', releaseKeys);
  document.addEventListener('focusout', e => { if (!e.relatedTarget) releaseKeys(); });

  // gamepads (standard mapping)
  const padLast = {};
  function pollPads() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let changed = false;
    for (let i = 0; i < Math.min(2, pads.length); i++) {
      const g = pads[i];
      const pid = mode === 'both' ? i : (i === 0 ? pidOf(0) : -1);
      if (!g || pid < 0) { if (padHeld[i] && padHeld[i].size) { padHeld[i].clear(); changed = true; } continue; }
      const d = new Set();
      const ax = g.axes[0] || 0, ay = g.axes[1] || 0;
      if (ax < -0.4 || (g.buttons[14] && g.buttons[14].pressed)) d.add('left');
      if (ax > 0.4 || (g.buttons[15] && g.buttons[15].pressed)) d.add('right');
      if (ay < -0.4 || (g.buttons[12] && g.buttons[12].pressed)) d.add('up');
      if (ay > 0.4 || (g.buttons[13] && g.buttons[13].pressed)) d.add('down');
      const old = padHeld[pid];
      const prevSet = padLast['d' + i] || new Set();
      d.forEach(k => { if (!prevSet.has(k)) presses[pid].push(k); });
      if (d.size !== old.size || Array.from(d).some(k => !old.has(k))) { padHeld[pid] = d; changed = true; }
      padLast['d' + i] = d;
      const bl = padLast['b' + i] || [];
      const acts = { 0: 's1', 1: 's2', 2: 's3', 3: 's4', 4: 'c1', 5: 'c2', 6: 'use', 7: 'use', 9: 'ready' };
      Object.keys(acts).forEach(b => {
        const on = !!(g.buttons[b] && g.buttons[b].pressed);
        if (on && !bl[b]) { presses[pid].push(acts[b]); changed = true; }
        bl[b] = on;
      });
      padLast['b' + i] = bl;
      if (A && (d.size || Object.keys(acts).some(b => bl[b]))) A.init();
    }
    if (changed || presses[0].length || presses[1].length) flush();
  }

  /* ----------------------------------------------------------------- network */
  let es = null;
  function connect() {
    if (es) { es.close(); es = null; }
    const src = new EventSource(API + '/api/stream?sid=' + encodeURIComponent(sid) + '&room=' + encodeURIComponent(room.code));
    es = src;
    src.onmessage = ev => {
      let s;
      try { s = JSON.parse(ev.data); } catch (e) { return; }
      lastMsg = performance.now();
      prev = cur; cur = s; tCur = lastMsg;
      onSnapshot(s);
    };
    src.addEventListener('seat', ev => { try { setSeats(JSON.parse(ev.data).seats); } catch (e) { /* ignore */ } });
    src.addEventListener('chat', ev => { try { addChat(JSON.parse(ev.data)); } catch (e) { /* ignore */ } });
    src.addEventListener('kicked', () => leaveToLobby(''));
    src.onerror = () => {
      if (src.readyState === 2) { if (room) leaveToLobby('THAT GAME CLOSED. START OR JOIN ANOTHER.'); }   // server says it is gone: no retry
      else $('#conn').hidden = false;
    };
    src.onopen = () => { $('#conn').hidden = true; };
  }

  /* ------------------------------------------------------------ audio / ui */
  function toggleSound() {
    if (!A) return;
    A.init();
    A.setOn(!A.on);
    $('#btn-mute').textContent = A.on ? 'SOUND ON' : 'SOUND OFF';
    $('#btn-mute').classList.toggle('on', !A.on);
  }
  $('#btn-mute').addEventListener('click', toggleSound);
  $('#btn-pause').addEventListener('click', () => { if (A) A.init(); cmd('pause'); });
  $('#btn-crt').addEventListener('click', () => {
    document.body.classList.toggle('crt');
    $('#btn-crt').textContent = document.body.classList.contains('crt') ? 'CRT ON' : 'CRT OFF';
    try { localStorage.setItem('naxx.crt', document.body.classList.contains('crt') ? '1' : '0'); } catch (e) { /* ignore */ }
  });
  function toggleFull() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      try { screen.orientation && screen.orientation.unlock && screen.orientation.unlock(); } catch (e) { /* ignore */ }
      return;
    }
    const el = touchMode ? document.documentElement : $('#screen');
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) { toast('ON IPHONE: SHARE > ADD TO HOME SCREEN, THEN OPEN IT FROM THERE FOR FULL SCREEN'); return; }
    const p = req.call(el);
    const lock = () => { try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => { }); } catch (e) { /* not supported */ } };
    if (p && p.then) p.then(lock).catch(() => { }); else lock();
  }
  $('#btn-full').addEventListener('click', toggleFull);
  let toastT = 0;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3500);
  }
  $('#hud').addEventListener('pointerdown', e => {
    const pl = e.target.closest('.pl'); if (!pl) return;
    const pid = pl.id === 'pl1' ? 1 : 0;
    const sp = e.target.closest('.sp'), cons = e.target.closest('.slot.cons');
    if (sp) { e.preventDefault(); pressAct(pid, 's' + (Array.prototype.indexOf.call(pl.querySelectorAll('.sp'), sp) + 1)); }
    else if (cons) { e.preventDefault(); pressAct(pid, 'c' + (Array.prototype.indexOf.call(pl.querySelectorAll('.slot.cons'), cons) + 1)); }
  });
  /* ---- equipment tooltips: hover (mouse) or tap (touch) a gear / potion slot */
  const gtip = document.createElement('div');
  gtip.id = 'gtip'; gtip.hidden = true; document.body.appendChild(gtip);
  let gtipFor = null;
  function slotInfo(slotEl) {
    const pl = slotEl.closest('.pl'); if (!pl || !cur) return null;
    const i = pl.id === 'pl1' ? 1 : 0, p = cur.players[i];
    if (!p) return null;
    if (slotEl.classList.contains('eq')) {
      const it = p.equip[slotEl.dataset.slot];
      return { cls: it && it.leg ? 'leg' : '', html: it ? gearCardHTML(it, slotEl.dataset.slot, p) : '<div class="tn dim">EMPTY ' + esc(slotEl.dataset.slot.toUpperCase()) + ' SLOT</div><div class="tc">LOOT OR BUY ONE FROM THE MERCHANT.</div>' };
    }
    const k = Array.prototype.indexOf.call(pl.querySelectorAll('.slot.cons'), slotEl), c = p.cons[k];
    if (!c) return { cls: '', html: '<div class="tn dim">EMPTY POTION SLOT</div>' };
    const cd = META.consumables[c[0]] || {};
    return { cls: '', html: '<div class="tn" style="color:' + c[2] + '">' + esc(c[1]) + '</div><div class="ts">CONSUMABLE</div><div class="tc">' + esc(cd.desc || '') + '</div>' };
  }
  function showGtip(slotEl) {
    const info = slotInfo(slotEl);
    if (!info) return hideGtip();
    gtipFor = slotEl;
    gtip.className = 'tip ' + info.cls; gtip.innerHTML = info.html; gtip.hidden = false;
    const r = slotEl.getBoundingClientRect(), w = gtip.offsetWidth, h = gtip.offsetHeight;
    let x = clamp(r.left + r.width / 2 - w / 2, 6, window.innerWidth - w - 6);
    let y = r.top - h - 8; if (y < 6) y = Math.min(window.innerHeight - h - 6, r.bottom + 8);
    gtip.style.left = x + 'px'; gtip.style.top = y + 'px';
  }
  function hideGtip() { gtip.hidden = true; gtipFor = null; }
  const gearSlot = e => e.target.closest && e.target.closest('.slot.eq, .slot.cons');
  $('#hud').addEventListener('pointerover', e => { if (e.pointerType === 'mouse') { const s = gearSlot(e); if (s) showGtip(s); } });
  $('#hud').addEventListener('pointerout', e => { if (e.pointerType === 'mouse' && gearSlot(e)) hideGtip(); });
  $('#hud').addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return;
    const s = gearSlot(e);
    if (s && s.classList.contains('eq')) { e.stopPropagation(); if (gtipFor === s) hideGtip(); else showGtip(s); }
  }, true);
  document.addEventListener('pointerdown', e => { if (e.pointerType !== 'mouse' && !gearSlot(e)) hideGtip(); });
  setInterval(() => { if (gtipFor && !gtip.hidden) showGtip(gtipFor); }, 400);   // keep souls / cooldown text live

  // gear panel for the touch layout (the HUD is hidden while playing on a phone)
  function toggleGear(open) {
    const g = $('#gear');
    const show = open != null ? open : g.hidden;
    g.hidden = !show;
    if (!show || !cur || !room) return;
    const p = cur.players[mySeat()]; if (!p) return;
    let h = '<div class="gh"><b>' + esc(nameOf(mySeat())) + ' &middot; EQUIPMENT</b><button type="button" id="gear-x">CLOSE</button></div><div class="gl">';
    ['weapon', 'neck', 'ring', 'trinket'].forEach(sl => {
      const it = p.equip[sl];
      h += '<div class="tip static ' + (it && it.leg ? 'leg' : '') + '">' + (it ? gearCardHTML(it, sl, p) : '<div class="tn dim">EMPTY ' + sl.toUpperCase() + '</div>') + '</div>';
    });
    h += '</div>';
    g.innerHTML = h;
    $('#gear-x').addEventListener('pointerdown', e => { e.preventDefault(); toggleGear(false); });
  }
  let quitArm = 0;
  $('#btn-quit').addEventListener('click', () => {
    const b = $('#btn-quit');
    if (performance.now() < quitArm) { cmd('quit'); quitArm = 0; b.textContent = 'MENU'; return; }
    quitArm = performance.now() + 2500; b.textContent = 'SURE?';
    setTimeout(() => { if (performance.now() >= quitArm) b.textContent = 'MENU'; }, 2600);
  });
  $('#end-btn').addEventListener('click', () => cmd('quit'));
  try { if (localStorage.getItem('naxx.crt') === '0') { /* off */ } else document.body.classList.add('crt'); } catch (e) { document.body.classList.add('crt'); }
  $('#btn-crt').textContent = document.body.classList.contains('crt') ? 'CRT ON' : 'CRT OFF';
  window.addEventListener('pointerdown', () => { if (A) A.init(); }, { once: true });
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('#top button, #end-btn, .tbtn');
    if (b) b.blur();
  });

  function fitScreen() {
    const scr = $('#screen');
    if (document.body.classList.contains('tplay')) { scr.style.width = ''; return; }
    const avail = Math.min(1100, $('#stage').clientWidth);
    const scale = Math.floor(avail / W);
    scr.style.width = scale >= 2 ? (W * scale + 6) + 'px' : '100%';
  }
  window.addEventListener('resize', fitScreen);

  /* ------------------------------------------------------------ touch controls */
  // Floating-free joystick on the left, spell/potion/use buttons on the right. Everything feeds the
  // same held/press path as the keyboard, and the server expires held input if the finger is lost.
  const tp = () => controlled()[0];
  const touchUI = {};
  function setupTouch() {
    const root = $('#touch');
    const joy = $('#joy'), knob = $('#knob');
    let joyId = null;
    function joyMove(e) {
      const r = joy.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2, R = r.width / 2;
      let dx = e.clientX - cx, dy = e.clientY - cy;
      const d = Math.hypot(dx, dy);
      const k = d > R ? R / d : 1;
      knob.style.transform = 'translate(' + (dx * k) + 'px,' + (dy * k) + 'px)';
      const h = touchHeld[tp()]; h.clear();
      if (d > R * 0.28) {
        if (dx / d > 0.38) h.add('right'); else if (dx / d < -0.38) h.add('left');
        if (dy / d > 0.38) h.add('down'); else if (dy / d < -0.38) h.add('up');
      }
      flush();
    }
    function joyEnd() {
      joyId = null; knob.style.transform = '';
      touchHeld[0].clear(); touchHeld[1].clear(); flush();
    }
    window.__joyReset = () => { joyId = null; knob.style.transform = ''; };
    // fallbacks in case the browser does not deliver the capture events to the joystick element
    window.addEventListener('pointerup', e => { if (e.pointerId === joyId) joyEnd(); });
    window.addEventListener('pointercancel', e => { if (e.pointerId === joyId) joyEnd(); });
    // a second finger landing on a button must never end the joystick; also re-assert held state
    // every beat while the finger is down so a one-off lost request can never leave it idle
    setInterval(() => { if (joyId !== null) flush(); }, 200);
    joy.addEventListener('pointerdown', e => { e.preventDefault(); if (A) A.init(); joyId = e.pointerId; try { joy.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } joyMove(e); });
    joy.addEventListener('pointermove', e => { if (e.pointerId === joyId) { e.preventDefault(); joyMove(e); } });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(n => joy.addEventListener(n, e => { if (e.pointerId === joyId) joyEnd(); }));
    root.addEventListener('contextmenu', e => e.preventDefault());

    root.querySelectorAll('[data-act]').forEach(b => {
      b.addEventListener('pointerdown', e => {
        e.preventDefault(); if (A) A.init();
        b.classList.add('prs');
        pressAct(tp(), b.dataset.act);
      });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(n => b.addEventListener(n, () => b.classList.remove('prs')));
    });
    $('#t-gear').addEventListener('pointerdown', e => { e.preventDefault(); toggleGear(); });
    $('#t-pause').addEventListener('pointerdown', e => { e.preventDefault(); cmd('pause'); });
    $('#t-full').addEventListener('pointerdown', e => { e.preventDefault(); toggleFull(); });
    $('#t-sound').addEventListener('pointerdown', e => { e.preventDefault(); toggleSound(); });
    $('#t-menu').addEventListener('pointerdown', e => {
      e.preventDefault();
      if (performance.now() < quitArm) { cmd('quit'); quitArm = 0; $('#t-menu').textContent = 'MENU'; return; }
      quitArm = performance.now() + 2500; $('#t-menu').textContent = 'SURE?';
      setTimeout(() => { $('#t-menu').textContent = 'MENU'; }, 2600);
    });
  }
  function updateTouch(s) {
    const play = touchMode && s.state !== 'menu' && s.state !== 'gameover' && s.state !== 'victory';
    document.body.classList.toggle('tplay', touchMode && s.state !== 'menu');
    $('#touch').hidden = !touchMode || s.state === 'menu';
    $('#touch').classList.toggle('over', !play);
    if (!touchMode || s.state === 'menu') return;
    const me = s.players[tp()];
    if (!me) return;
    const names = me.spells.map(sp => sp.name).join('|') + me.cls;
    if (touchUI.names !== names) {
      touchUI.names = names;
      $('#touch').style.setProperty('--pc', tp() ? '#ff55ff' : '#55ffff');
      $('#touch').querySelectorAll('.tsp').forEach((b, k) => { const sp = me.spells[k]; b.querySelector('b').textContent = sp ? sp.name : ''; });
    }
    $('#touch').querySelectorAll('.tsp').forEach((b, k) => {
      const sp = me.spells[k]; if (!sp) return;
      b.classList.toggle('cd', sp.cd > 0.05);
      b.classList.toggle('nores', !sp.ok && sp.cd <= 0.05);
      b.classList.toggle('active', !!sp.active);
      b.querySelector('u').style.height = (sp.cdmax > 0 ? clamp(sp.cd / sp.cdmax, 0, 1) * 100 : 0) + '%';
      b.querySelector('s').textContent = sp.cd > 0.05 ? sp.cd.toFixed(1) : '';
    });
    $('#touch').querySelectorAll('.tcn').forEach((b, k) => {
      const c = me.cons[k]; b.querySelector('b').textContent = c ? c[1] : '-'; b.style.color = c ? c[2] : ''; b.style.opacity = c && me.potcd <= 0 ? 1 : 0.5;
    });
    // mini status: my bars, plus partner HP
    const rs = META.resources[me.rtype];
    const st = $('#tstat');
    const partner = s.players[1 - tp()];
    const html = '<div class="tb hp"><i style="width:' + clamp(me.hp / me.maxhp * 100, 0, 100) + '%"></i><b>HP ' + Math.ceil(me.hp) + '</b></div>' +
      '<div class="tb rs"><i style="width:' + clamp(me.res / me.resmax * 100, 0, 100) + '%;background:' + rs.color + '"></i><b>' + rs.label + ' ' + Math.floor(me.res) + '</b></div>' +
      '<div class="tg">' + me.gold + 'G' + (partner && partner.joined ? ' &middot; P' + (2 - tp()) + ' ' + (partner.alive ? Math.ceil(partner.hp / partner.maxhp * 100) + '%' : 'DOWN') : '') + '</div>';
    if (touchUI.stat !== html) { touchUI.stat = html; st.innerHTML = html; }
    const near = !!nearestPickup(s, me);
    $('#t-use').classList.toggle('hot', near);
    $('#t-pause').textContent = s.paused ? 'PLAY' : 'PAUSE';
    $('#t-sound').textContent = A && !A.on ? 'SND OFF' : 'SND';
  }
  // landscape-only play: show a rotate hint in portrait
  function checkOrient() {
    const portrait = window.innerHeight > window.innerWidth;
    $('#rotate').hidden = !(touchMode && portrait && document.body.classList.contains('tplay'));
    fitScreen();
  }
  window.addEventListener('resize', checkOrient);
  window.addEventListener('orientationchange', () => setTimeout(checkOrient, 150));

  /* -------------------------------------------------------------- helpers */
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const rnd = Math.round;
  function box(x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(rnd(x), rnd(y), w, h); }
  function text(s, x, y, c, align, size) {
    ctx.font = (size || 8) + 'px ' + FONT;
    ctx.textBaseline = 'top';
    ctx.textAlign = align || 'left';
    ctx.fillStyle = '#000'; ctx.fillText(s, rnd(x) + 1, rnd(y) + 1);
    ctx.fillStyle = c || '#fff'; ctx.fillText(s, rnd(x), rnd(y));
  }
  function circ(cx, cy, r, c) {
    ctx.fillStyle = c;
    cx = rnd(cx); cy = rnd(cy); r = Math.max(1, rnd(r));
    let x = r, y = 0, err = 1 - r;
    while (x >= y) {
      ctx.fillRect(cx + x, cy + y, 1, 1); ctx.fillRect(cx - x, cy + y, 1, 1);
      ctx.fillRect(cx + x, cy - y, 1, 1); ctx.fillRect(cx - x, cy - y, 1, 1);
      ctx.fillRect(cx + y, cy + x, 1, 1); ctx.fillRect(cx - y, cy + x, 1, 1);
      ctx.fillRect(cx + y, cy - x, 1, 1); ctx.fillRect(cx - y, cy - x, 1, 1);
      y++;
      if (err < 0) err += 2 * y + 1; else { x--; err += 2 * (y - x) + 1; }
    }
  }
  function line(x0, y0, x1, y1, c) {
    ctx.fillStyle = c;
    x0 = rnd(x0); y0 = rnd(y0); x1 = rnd(x1); y1 = rnd(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy, n = 0;
    for (;;) {
      ctx.fillRect(x0, y0, 1, 1);
      if ((x0 === x1 && y0 === y1) || n++ > 600) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  const patCache = {};
  function dither(color, phase) {
    const key = color + (phase ? 1 : 0);
    if (patCache[key]) return patCache[key];
    const c = document.createElement('canvas'); c.width = 2; c.height = 2;
    const g = c.getContext('2d'); g.fillStyle = color;
    g.fillRect(phase ? 1 : 0, 0, 1, 1); g.fillRect(phase ? 0 : 1, 1, 1, 1);
    return (patCache[key] = ctx.createPattern(c, 'repeat'));
  }
  function fillDiscDither(x, y, r, color, phase) {
    ctx.fillStyle = dither(color, phase);
    ctx.beginPath(); ctx.arc(x, y, Math.max(0.5, r), 0, 6.2832); ctx.fill();
  }
  function fillPolyDither(pts, color, phase) {
    ctx.fillStyle = dither(color, phase);
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath(); ctx.fill();
  }
  function polyOutline(pts, c) {
    for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; line(a[0], a[1], b[0], b[1], c); }
  }
  const blinkOn = (ms) => Math.floor(performance.now() / ms) % 2 === 0;

  /* ----------------------------------------------------------- background */
  const WING = {
    arachnid: { f: '#0a140b', l: '#122413', w: '#1c3a1e', g: '#55ff55' },
    plague: { f: '#14140a', l: '#222210', w: '#3a3a18', g: '#aaaa00' },
    military: { f: '#160b0c', l: '#2a1416', w: '#4a1e22', g: '#ff5555' },
    construct: { f: '#130b18', l: '#25132e', w: '#3d2050', g: '#ff55ff' },
    frost: { f: '#08121a', l: '#112733', w: '#1e4258', g: '#55ffff' },
    molten: { f: '#190a05', l: '#2e1409', w: '#5a2410', g: '#ff8800' },
    temple: { f: '#0a1210', l: '#12261f', w: '#1f4a3c', g: '#55ff33' },
    sanctum: { f: '#120a1a', l: '#241335', w: '#46266a', g: '#aa55ff' },
    lair: { f: '#1c0803', l: '#3a1006', w: '#6e1c0a', g: '#ff3300' },
    shop: { f: '#150f08', l: '#2b2010', w: '#4d3a18', g: '#ffcc55' },
  };
  const bgCache = {};
  function bgFor(wing) {
    if (bgCache[wing]) return bgCache[wing];
    const p = WING[wing] || WING.arachnid;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    // floor
    g.fillStyle = p.f; g.fillRect(8, 16, 304, 176);
    g.fillStyle = p.l;
    for (let y = 16; y < 192; y += 8) {
      g.fillRect(8, y, 304, 1);
      const off = ((y - 16) / 8) % 2 ? 8 : 0;
      for (let x = 8 + off; x < 312; x += 16) g.fillRect(x, y, 1, 8);
    }
    // sparse cracks
    let seed = wing.length * 977;
    const rn = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    g.fillStyle = p.w;
    for (let i = 0; i < 40; i++) g.fillRect(8 + rn() * 300 | 0, 16 + rn() * 170 | 0, 2, 1);
    // walls
    g.fillStyle = p.w; g.fillRect(0, 14, W, 2); g.fillRect(0, 14, 8, 178); g.fillRect(312, 14, 8, 178);
    g.fillStyle = p.l;
    for (let y = 14; y < 192; y += 6) { g.fillRect(0, y, 8, 1); g.fillRect(312, y, 8, 1); }
    g.fillStyle = '#000'; g.fillRect(7, 16, 1, 176); g.fillRect(312, 16, 1, 176);
    bgCache[wing] = c;
    return c;
  }
  function drawTorches(wing) {
    const p = WING[wing] || WING.arachnid;
    const t = performance.now() / 120;
    [[3, 50], [3, 120], [315, 50], [315, 120]].forEach(([x, y], i) => {
      box(x - 1, y + 3, 3, 4, '#6a4a20');
      const f = Math.floor(t + i * 3) % 3;
      box(x, y - f, 1, 3 + f, p.g);
      box(x - 1, y + 1 - (f > 1 ? 1 : 0), 3, 2, '#ffffff');
    });
  }

  /* --------------------------------------------------------- interpolation */
  function lerpPos(a, b, id) {
    const al = clamp((performance.now() - tCur) / TICK_MS, 0, 1);
    return { x: a + (b - a) * al, id: id };
  }
  function interp(prevList, curObj, keyFn) {
    if (!prevList) return { x: curObj.x, y: curObj.y };
    const p = prevList.get(keyFn(curObj));
    if (!p) return { x: curObj.x, y: curObj.y };
    const dx = curObj.x - p.x, dy = curObj.y - p.y;
    if (dx * dx + dy * dy > 1600) return { x: curObj.x, y: curObj.y };
    const al = clamp((performance.now() - tCur) / TICK_MS, 0, 1);
    return { x: p.x + dx * al, y: p.y + dy * al };
  }
  let prevEnemyMap = null, prevPlayerMap = null;

  /* -------------------------------------------------------------- snapshot */
  function onSnapshot(s) {
    prevEnemyMap = prev && prev.enemies ? new Map(prev.enemies.map(e => [e.id, e])) : null;
    prevPlayerMap = prev && prev.players ? new Map(prev.players.map(p => [p.id, p])) : null;
    const now = performance.now();
    (s.ev || []).forEach(ev => {
      if (ev.t === 'sfx') { if (A) A.sfx(ev.n); }
      else if (ev.t === 'dmg') { if (texts.length < 70) texts.push({ x: ev.x, y: ev.y, s: String(ev.v), c: ev.c, big: ev.crit, t0: now, dur: ev.crit ? 1000 : 800, pl: ev.pl }); }
      else if (ev.t === 'txt') { if (texts.length < 70) texts.push({ x: ev.x, y: ev.y, s: ev.s, c: ev.c, big: false, t0: now, dur: 1100 }); }
      else if (ev.t === 'fx') { fxs.push({ k: ev.k, x: ev.x, y: ev.y, r: ev.r, c: ev.c, t0: now, dur: ev.k === 'slash' ? 160 : 320 }); }
      else if (ev.t === 'beam') { fxs.push({ k: 'beam', pts: ev.pts, c: ev.c, t0: now, dur: 220 }); }
    });
    if (s.state !== lastState) {
      if (s.state === 'menu' && room) charApi('list');
      if (s.state !== 'menu' && talChar) closeTal();
      raidKeyLast = '';
      lastState = s.state;
      if (A && (s.state === 'intro')) A.sfx('ui');
    }
    updateUI(s);
  }

  /* ----------------------------------------------------------------- render */
  function drawObstacles(enc) {
    if (!enc) return;
    const ice = enc.wing === 'frost';
    enc.obstacles.forEach(o => {
      const [x, y, w, h] = o;
      box(x, y, w, h, ice ? '#2c5f78' : '#2c2942');
      box(x, y, w, 2, ice ? '#a8f0ff' : '#5a5680');
      box(x, y, 2, h, ice ? '#7fe0ff' : '#4a4670');
      box(x, y + h - 2, w, 2, ice ? '#1b3f52' : '#14122a');
      box(x + w - 2, y, 2, h, ice ? '#1b3f52' : '#14122a');
      if (ice) { box(x + 4, y + 4, 2, 2, '#ffffff'); }
    });
  }

  function drawZones(s) {
    const ph = Math.floor(performance.now() / 160) % 2;
    s.zones.forEach(z => {
      const frac = z.t / z.T;
      const col = z.c || '#ffffff';
      if (z.team === 'player') {
        fillDiscDither(z.x, z.y, z.r, col, ph);
        circ(z.x, z.y, z.r, col);
      } else {
        fillDiscDither(z.x, z.y, z.r, col, ph);
        if (frac > 0.2 || blinkOn(120)) circ(z.x, z.y, z.r, col);
      }
    });
    s.traps.forEach(t => {
      const c = t.k === 'explosive' ? '#ff8800' : '#55ffff';
      if (!t.armed && !blinkOn(120)) return;
      box(t.x - 1, t.y - 4, 3, 9, c); box(t.x - 4, t.y - 1, 9, 3, c);
      box(t.x - 1, t.y - 1, 3, 3, '#000');
    });
  }

  function drawPickups(s) {
    const t = performance.now() / 1000;
    s.pickups.forEach((p, i) => {
      const bob = Math.sin(t * 3 + i) > 0 ? 0 : 1;
      if (p.k === 'gold') {
        const w = [3, 2, 1, 2][Math.floor(t * 8 + i) % 4];
        box(p.x - w, p.y - 2 - bob, w * 2, 5, '#ffff55');
        box(p.x - w, p.y - 2 - bob, w * 2, 1, '#ffffff');
      } else if (p.k === 'cons') {
        box(p.x - 1, p.y - 4 - bob, 3, 2, '#aaaaaa');
        box(p.x - 3, p.y - 2 - bob, 7, 6, p.c);
        box(p.x - 2, p.y - 1 - bob, 2, 2, '#ffffff');
      } else {
        const c = p.c;
        box(p.x - 4, p.y - 4 - bob, 9, 9, '#000');
        box(p.x - 4, p.y - 4 - bob, 9, 1, c); box(p.x - 4, p.y + 4 - bob, 9, 1, c);
        box(p.x - 4, p.y - 4 - bob, 1, 9, c); box(p.x + 4, p.y - 4 - bob, 1, 9, c);
        const y0 = p.y - bob;
        if (p.slot === 'weapon') { box(p.x, y0 - 3, 1, 6, '#fff'); box(p.x - 2, y0 + 1, 5, 1, c); }
        else if (p.slot === 'neck') { box(p.x - 2, y0 - 2, 1, 2, c); box(p.x + 2, y0 - 2, 1, 2, c); box(p.x - 1, y0, 3, 2, c); }
        else if (p.slot === 'ring') { box(p.x - 2, y0 - 2, 5, 1, c); box(p.x - 2, y0 + 2, 5, 1, c); box(p.x - 2, y0 - 1, 1, 3, c); box(p.x + 2, y0 - 1, 1, 3, c); }
        else { box(p.x, y0 - 3, 1, 1, c); box(p.x - 1, y0 - 2, 3, 1, c); box(p.x - 2, y0 - 1, 5, 3, c); box(p.x - 1, y0 + 2, 3, 1, c); box(p.x, y0 + 3, 1, 1, c); }
      }
    });
    // pedestal prices, then corner brackets round the item each player is about to use
    s.pickups.forEach(p => {
      if (p.price) {
        box(p.x - 7, p.y + 6, 15, 2, '#6a5426');
        text(p.price + 'G', p.x, p.y + 9, '#ffff55', 'center');
      }
    });
    if (!blinkOn(260)) return;
    s.players.forEach(pl => {
      const p = nearestPickup(s, pl);
      if (!p) return;
      const c = pl.id ? '#ff55ff' : '#55ffff', x0 = p.x - 8 + (pl.id ? 1 : 0), x1 = p.x + 8 - (pl.id ? 1 : 0), y0 = p.y - 8, y1 = p.y + 8;
      [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]].forEach(([x, y, dx, dy]) => {
        box(dx > 0 ? x : x - 2, y, 3, 1, c); box(x, dy > 0 ? y : y - 2, 1, 3, c);
      });
    });
  }

  function nearestPickup(s, pl) {
    if (!pl.joined || !pl.alive) return null;
    let best = null, bd = 18;
    s.pickups.forEach(p => {
      if (p.k === 'gold') return;
      const d = Math.hypot(pl.x - p.x, pl.y - p.y);
      if (d < bd) { best = p; bd = d; }
    });
    return best;
  }

  /* ----- item tooltip: a small DOM card anchored to the item (crisp text, stat comparison) */
  const STATN = { dmg: 'DAMAGE', hp: 'HEALTH', crit: 'CRIT', cdr: 'COOLDOWN', regen: 'REGEN', ls: 'LIFESTEAL', spd: 'SPEED', dr: 'ARMOR', gold: 'GOLD' };
  const fmtStat = (k, v) => k === 'hp' ? String(Math.round(v)) : Math.round(v * 100) + '%';
  function modsHTML(mods) {
    const ks = Object.keys(mods || {});
    if (!ks.length) return '';
    return '<ul class="tm">' + ks.map(k => '<li><span>' + (STATN[k] || k.toUpperCase()) + '</span><b>+' + fmtStat(k, mods[k]) + '</b></li>').join('') + '</ul>';
  }
  function fxHTML(o) {
    return (o.fx ? '<div class="tfx">' + esc(o.fx) + '</div>' : '') + (o.flavor ? '<div class="tfl">"' + esc(o.flavor) + '"</div>' : '');
  }
  // card for an item the player has equipped
  function gearCardHTML(it, slot, pl) {
    let h = '<div class="tn" style="color:' + it.rcolor + '">' + esc(it.name) + '</div>';
    h += '<div class="ts"><span style="color:' + it.rcolor + '">' + esc(it.rname) + '</span> ' + esc(slot.toUpperCase()) + '</div>' + modsHTML(it.mods) + fxHTML(it);
    if (pl && it.fx && pl.souls != null && /soul/i.test(it.fx)) h += '<div class="tc ok">SOULS ' + pl.souls + '/10' + (pl.reap > 0 ? '  REAPING ' + pl.reap.toFixed(1) + 's' : '') + '</div>';
    return h;
  }
  function tipHTML(p, pl) {
    const keyName = touchMode ? 'USE' : (isLocal() ? ['F', '/'][pl.id] : 'F');
    let h = '<div class="tn" style="color:' + p.c + '">' + esc(p.name) + '</div>';
    let act = 'TAKE';
    if (p.k === 'item') {
      const cur = pl.equip[p.slot];
      act = p.price ? 'BUY' : (cur ? 'SWAP' : 'EQUIP');
      h += '<div class="ts"><span style="color:' + p.c + '">' + esc(p.rname || '') + '</span> ' + esc(p.slot.toUpperCase()) + '</div><ul class="tm">';
      const mods = p.mods || {}, old = (cur && cur.mods) || {};
      Object.keys(Object.assign({}, old, mods)).forEach(k => {
        const nv = mods[k] || 0, ov = old[k] || 0, d = nv - ov;
        let delta = '';
        if (cur && Math.abs(d) > 1e-9) delta = '<i class="' + (d > 0 ? 'up' : 'dn') + '">' + (d > 0 ? '\u25B2' : '\u25BC') + fmtStat(k, Math.abs(d)) + '</i>';
        h += '<li class="' + (nv ? '' : 'gone') + '"><span>' + (STATN[k] || k.toUpperCase()) + '</span><b>' + (nv ? '+' + fmtStat(k, nv) : '--') + '</b>' + delta + '</li>';
      });
      h += '</ul>' + fxHTML(p);
      h += cur ? '<div class="tc">REPLACES <span style="color:' + cur.rcolor + '">' + esc(cur.name) + '</span></div>' : '<div class="tc ok">SLOT EMPTY</div>';
    } else {
      act = p.price ? 'BUY' : 'TAKE';
      h += '<div class="ts">CONSUMABLE</div>' + (p.desc ? '<div class="tc">' + esc(p.desc) + '</div>' : '');
    }
    h += '<div class="ta"><kbd>' + keyName + '</kbd> ' + act + (p.price ? ' <u>' + p.price + 'G</u>' : '') + '</div>';
    return h;
  }
  function updateTips(s) {
    const box_ = $('#tips');
    const want = [];
    if (s.state !== 'menu' && !s.paused) s.players.forEach(pl => { const p = nearestPickup(s, pl); if (p) want.push([pl, p]); });
    box_.classList.toggle('hasleg', want.some(([pl, p]) => p.leg));
    const key = want.map(([pl, p]) => pl.id + p.name + p.desc + p.price + (pl.equip[p.slot] ? pl.equip[p.slot].name : '') + touchMode).join('|');
    if (uiKey.tips !== key) {
      uiKey.tips = key;
      box_.innerHTML = want.map(([pl, p]) => '<div class="tip p' + pl.id + (p.leg ? ' leg' : '') + '" data-pid="' + pl.id + '">' + tipHTML(p, pl) + '</div>').join('');
    }
    box_.querySelectorAll('.tip').forEach((el, i) => {
      const p = want[i] && want[i][1]; if (!p) return;
      const fx = clamp(p.x / W * 100, 14, 86);
      el.style.left = fx + '%';
      const below = p.y < 92;
      el.classList.toggle('below', below);
      el.style.top = ((below ? p.y + 12 : p.y - 12) / H * 100) + '%';
    });
  }

  function drawGate(s) {
    const enc = s.enc;
    if (!enc || !enc.gate_on) return;
    const [x0, y0, x1, y1] = enc.gate;
    const ph = Math.floor(performance.now() / 140) % 2;
    ctx.fillStyle = dither('#55ffff', ph); ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.fillStyle = dither('#ff55ff', 1 - ph); ctx.fillRect(x0 + 4, y0, x1 - x0 - 8, y1 - y0 - 6);
    box(x0 - 3, y0, 3, y1 - y0 + 2, '#8a86b0'); box(x1, y0, 3, y1 - y0 + 2, '#8a86b0');
    box(x0 - 3, y1, x1 - x0 + 6, 2, '#8a86b0');
    const need = s.players.filter(p => p.joined && p.alive).length;
    const inn = enc.gate_in.length;
    if (blinkOn(450)) text('NEXT', (x0 + x1) / 2, y0 + 3, '#000', 'center');
    text('^ WALK UP ^', (x0 + x1) / 2, y1 + 4, '#55ffff', 'center');
    if (need > 1) text('READY ' + inn + '/' + need, (x0 + x1) / 2, y1 + 13, inn === need ? '#55ff55' : '#ffff55', 'center');
    if (enc.gate_t > 0) { box(x0, y1 + 22, (x1 - x0) * clamp(enc.gate_t / 1.2, 0, 1), 3, '#55ff55'); }
  }

  function drawNpc(s) {
    const n = s.enc && s.enc.npc;
    if (!n) return;
    const spr = SPR.enemySprite('ghost', '#ffcc55', false);
    const bob = Math.sin(performance.now() / 300) > 0 ? 0 : 1;
    ctx.drawImage(spr, rnd(n.x - 8), rnd(n.y - 8 - bob), 16, 16);
    box(n.x - 5, n.y - 10 - bob, 11, 2, '#ffffff');
    text(n.name, n.x, n.y + 10, '#ffcc55', 'center');
  }

  function drawTelegraphs(s) {
    const ph = Math.floor(performance.now() / 110) % 2;
    s.tels.forEach(t => {
      const prog = clamp(1 - t.t / t.T, 0, 1);
      const c = t.c || '#ff5555';
      if (t.s === 'circle') {
        fillDiscDither(t.x, t.y, t.r * prog, c, ph);
        circ(t.x, t.y, t.r, blinkOn(100) ? c : '#ffffff');
      } else if (t.s === 'line') {
        const hw = t.w / 2, cs = Math.cos(t.a), sn = Math.sin(t.a), nx = -sn, ny = cs;
        const full = [[t.x + nx * hw, t.y + ny * hw], [t.x + cs * t.len + nx * hw, t.y + sn * t.len + ny * hw],
          [t.x + cs * t.len - nx * hw, t.y + sn * t.len - ny * hw], [t.x - nx * hw, t.y - ny * hw]];
        const L = t.len * prog;
        const part = [[t.x + nx * hw, t.y + ny * hw], [t.x + cs * L + nx * hw, t.y + sn * L + ny * hw],
          [t.x + cs * L - nx * hw, t.y + sn * L - ny * hw], [t.x - nx * hw, t.y - ny * hw]];
        fillPolyDither(part, c, ph);
        polyOutline(full, blinkOn(100) ? c : '#ffffff');
      } else if (t.s === 'cone') {
        const half = (t.arc / 2) * Math.PI / 180, pts = [[t.x, t.y]];
        for (let i = 0; i <= 8; i++) { const a = t.a - half + (half * 2) * i / 8; pts.push([t.x + Math.cos(a) * t.len, t.y + Math.sin(a) * t.len]); }
        const ip = [[t.x, t.y]];
        for (let i = 0; i <= 8; i++) { const a = t.a - half + (half * 2) * i / 8; ip.push([t.x + Math.cos(a) * t.len * prog, t.y + Math.sin(a) * t.len * prog]); }
        fillPolyDither(ip, c, ph);
        polyOutline(pts, blinkOn(100) ? c : '#ffffff');
      } else if (t.s === 'cols') {
        const cw = 304 / t.cols;
        for (let i = 0; i < t.cols; i++) {
          const x0 = 8 + i * cw;
          if (i === t.safe) {
            for (let y = 16; y < 192; y += 6) { box(x0 + 2, y, 1, 3, '#55ff55'); box(x0 + cw - 3, y, 1, 3, '#55ff55'); }
            text('SAFE', x0 + cw / 2, 100, '#55ff55', 'center');
          } else {
            ctx.fillStyle = dither(c, ph); ctx.fillRect(rnd(x0), 16, rnd(cw), 176 * prog | 0 || 1);
            box(x0, 16, 1, 176, c);
          }
        }
      } else if (t.s === 'flash') {
        ctx.fillStyle = dither(c, ph); ctx.globalAlpha = 0.25 + 0.5 * prog;
        ctx.fillRect(8, 16, 304, 176); ctx.globalAlpha = 1;
      }
    });
  }

  function statusIcons(st, x, y) {
    let ox = 0;
    const draw = (ch, c) => { text(ch, x + ox, y, c, 'left'); ox += 8; };
    if (st.includes('stun')) draw('*', '#ffff55');
    if (st.includes('freeze')) draw('#', '#55ffff');
    if (st.includes('fear')) draw('?', '#ff55ff');
    if (st.includes('root')) draw('=', '#aa5500');
  }

  function drawEntities(s) {
    const items = [];
    s.enemies.forEach(e => items.push({ y: e.y, t: 'e', o: e }));
    s.players.forEach(p => { if (p.joined) items.push({ y: p.y, t: 'p', o: p }); });
    items.sort((a, b) => a.y - b.y);
    const ft = Math.floor(performance.now() / 160) % 2;
    items.forEach(it => {
      if (it.t === 'e') drawEnemy(it.o, ft); else drawPlayer(it.o, ft);
    });
  }

  function drawEnemy(e, ft) {
    const pos = interp(prevEnemyMap, e, o => o.id);
    const size = e.r * 2, sc = Math.max(1, rnd(size / 8));
    const spr = SPR.enemySprite(e.shape, e.color, e.flash);
    const dx = rnd(pos.x - 4 * sc), dy = rnd(pos.y - 4 * sc - (e.boss && ft ? 0 : 0));
    ctx.save();
    if (e.gated) ctx.globalAlpha = 0.35;
    if (e.fx < -0.2 && e.shape !== 'spider') { ctx.translate(dx + 8 * sc, dy); ctx.scale(-1, 1); ctx.drawImage(spr, 0, 0, 8 * sc, 8 * sc); }
    else ctx.drawImage(spr, dx, dy, 8 * sc, 8 * sc);
    ctx.restore();
    if (e.st.includes('freeze')) { ctx.fillStyle = dither('#55ffff', 0); ctx.fillRect(dx, dy, 8 * sc, 8 * sc); circ(pos.x, pos.y, e.r + 2, '#55ffff'); }
    if (e.enr && blinkOn(120)) circ(pos.x, pos.y, e.r + 2, '#ff5555');
    if (e.cast && blinkOn(140)) circ(pos.x, pos.y, e.r + 4, '#ffffff');
    statusIcons(e.st, pos.x - 4, pos.y - e.r - 12);
    if (!e.boss && e.hp < e.maxhp) {
      const w = Math.max(8, e.r * 2 + 2);
      box(pos.x - w / 2, pos.y - e.r - 4, w, 2, '#400');
      box(pos.x - w / 2, pos.y - e.r - 4, Math.max(1, w * e.hp / e.maxhp), 2, '#ff5555');
    }
    if (e.boss && e.aff && e.aff.length === 0) { /* none */ }
  }

  function drawPlayer(p, ft) {
    const pos = interp(prevPlayerMap, p, o => o.id);
    const cdef = META && META.classes[p.cls];
    if (!cdef) return;
    if (!p.alive) {
      box(pos.x - 1, pos.y - 5, 3, 10, '#aaaaaa'); box(pos.x - 4, pos.y - 2, 9, 3, '#aaaaaa');
      text('P' + (p.id + 1), pos.x, pos.y + 6, p.id ? '#ff55ff' : '#55ffff', 'center');
      return;
    }
    const prevP = prevPlayerMap && prevPlayerMap.get(p.id);
    const moving = prevP && (Math.abs(prevP.x - p.x) + Math.abs(prevP.y - p.y) > 0.2);
    const bear = p.form === 'bear';
    const spr = bear ? SPR.enemySprite('brute', '#aa5500', false) : SPR.playerSprite(p.cls, cdef.color, cdef.accent, moving ? ft : 0, false);
    const sc = bear ? 2 : 1, off = 4 * sc;
    ctx.save();
    if (p.form === 'stealth' || p.st.includes('stealth')) ctx.globalAlpha = 0.4;
    const dx = rnd(pos.x - off), dy = rnd(pos.y - off - (moving && ft ? 1 : 0));
    if (p.fx < -0.2) { ctx.translate(dx + 8 * sc, dy); ctx.scale(-1, 1); ctx.drawImage(spr, 0, 0, 8 * sc, 8 * sc); }
    else ctx.drawImage(spr, dx, dy, 8 * sc, 8 * sc);
    ctx.restore();
    const tag = p.id ? '#ff55ff' : '#55ffff';
    box(pos.x - 1, pos.y - off - 5, 3, 1, tag); box(pos.x, pos.y - off - 4, 1, 1, tag);
    // small hp bar
    box(pos.x - 6, pos.y + off + 1, 12, 2, '#400');
    box(pos.x - 6, pos.y + off + 1, Math.max(0, 12 * p.hp / p.maxhp), 2, '#55ff55');
    if (p.shield > 0) circ(pos.x, pos.y, 8, '#ffffff');
    if (p.st.includes('divine')) { circ(pos.x, pos.y, 9, blinkOn(80) ? '#ffff55' : '#ffffff'); circ(pos.x, pos.y, 10, '#ffff55'); }
    if (p.st.includes('evade') && blinkOn(90)) circ(pos.x, pos.y, 8, '#ffff55');
    if (p.st.includes('whirl')) { const a = performance.now() / 60; for (let i = 0; i < 4; i++) box(pos.x + Math.cos(a + i * 1.57) * 12, pos.y + Math.sin(a + i * 1.57) * 12, 2, 2, '#ffffff'); }
    if (p.st.includes('enrage')) circ(pos.x, pos.y, 7, '#ff5555');
    if (p.st.includes('freeze')) { ctx.fillStyle = dither('#55ffff', 0); ctx.fillRect(dx, dy, 8 * sc, 8 * sc); }
    if (p.st.includes('wrapped')) { ctx.fillStyle = dither('#ffffff', 0); ctx.fillRect(dx - 1, dy - 1, 8 * sc + 2, 8 * sc + 2); }
    if (p.charge) text(p.charge, pos.x, pos.y - off - 14, p.charge === '+' ? '#ff5555' : '#5555ff', 'center', 8);
    statusIcons(p.st, pos.x - 4, pos.y - off - 13);
    if (p.pet) {
      const f = Math.floor(performance.now() / 90) % 2, fx = p.pet.x, fy = p.pet.y;
      const c = p.pet.dive ? '#ffcc66' : '#aa5500';
      box(fx - 1, fy, 3, 2, c); box(fx + (p.fx < 0 ? -2 : 2), fy - 1, 1, 1, '#ffffff');
      box(fx - 3, fy - (f ? 2 : 0), 2, 1, c); box(fx + 2, fy - (f ? 2 : 0), 2, 1, c);
      if (p.pet.dive) { box(fx - 1, fy + 2, 1, 2, '#ffffff'); }
    }
  }

  function drawProjs(s) {
    s.projs.forEach(p => {
      const c = p.c;
      if (p.k === 'arrow') {
        const l = Math.hypot(p.vx, p.vy) || 1;
        line(p.x, p.y, p.x - p.vx / l * 6, p.y - p.vy / l * 6, c);
        box(p.x - 1, p.y - 1, 2, 2, '#fff');
      } else if (p.k === 'knife') { box(p.x - 1, p.y - 1, 2, 2, '#ffffff'); }
      else if (p.team === 'enemy') { box(p.x - 2, p.y - 2, 4, 4, c); box(p.x - 1, p.y - 1, 2, 2, '#fff'); }
      else if (p.k === 'core') { box(p.x - 3, p.y - 3, 6, 6, c); box(p.x - 1, p.y - 1, 2, 2, '#fff'); }
      else { box(p.x - 2, p.y - 2, 4, 4, c); box(p.x - 1, p.y - 1, 2, 2, '#ffffff'); }
    });
  }

  function drawFx(now) {
    fxs = fxs.filter(f => now - f.t0 < f.dur);
    fxs.forEach(f => {
      const k = (now - f.t0) / f.dur;
      if (f.k === 'nova') {
        circ(f.x, f.y, f.r * (0.3 + 0.7 * k), f.c);
        if (k < 0.6) circ(f.x, f.y, f.r * (0.2 + 0.7 * k), '#ffffff');
        fillDiscDither(f.x, f.y, f.r * (0.3 + 0.7 * k), f.c, Math.floor(k * 8) % 2);
      } else if (f.k === 'burst') {
        fillDiscDither(f.x, f.y, f.r * (1 - k * 0.5), f.c, Math.floor(k * 10) % 2);
        circ(f.x, f.y, f.r * (0.4 + k * 0.6), '#ffffff');
      } else if (f.k === 'slash') {
        for (let i = -3; i <= 3; i++) box(f.x + i, f.y + i * (k < 0.5 ? 1 : -1), 2, 2, f.c);
      } else if (f.k === 'beam') {
        for (let i = 0; i < f.pts.length - 1; i++) {
          const a = f.pts[i], b = f.pts[i + 1];
          const mx = (a[0] + b[0]) / 2 + (Math.random() - 0.5) * 8, my = (a[1] + b[1]) / 2 + (Math.random() - 0.5) * 8;
          line(a[0], a[1], mx, my, f.c); line(mx, my, b[0], b[1], '#ffffff');
        }
      }
    });
    texts = texts.filter(t => now - t.t0 < t.dur);
    texts.forEach(t => {
      const k = (now - t.t0) / t.dur;
      text(t.s, clamp(t.x, 12, 308), t.y - k * 14 - 6, t.c, 'center', t.big ? 8 : 8);
    });
  }

  function drawTopBar(s) {
    const enc = s.enc;
    if (!enc || s.state === 'menu') return;
    if (enc.shop) { topLabels(enc.name, enc.info || '', '#ffcc55', '#ffff55'); box(8, 8, 304, 1, '#ffcc55'); box(8, 14, 304, 1, '#ffcc55'); return; }
    const frac = clamp(enc.boss_hp / enc.boss_max, 0, 1);
    const wcol = (WING[enc.wing] || WING.arachnid).g;
    box(8, 9, 304, 5, '#222');
    box(8, 9, 304 * frac, 5, '#aa0000'); box(8, 9, 304 * frac, 2, '#ff5555');
    box(8, 8, 304, 1, wcol); box(8, 14, 304, 1, wcol);
    let right = enc.info || '';
    if (enc.doom != null) right = 'DOOM ' + enc.doom.toFixed(1) + (right ? '  ' + right : '');
    if (enc.necro) right = 'NO HEALING  ' + right;
    topLabels(enc.name.toUpperCase(), right.trim(), wcol, enc.doom != null || enc.necro ? '#ff5555' : '#ffff55');
  }
  // Boss name on the left, status on the right. If both do not fit on one line the status drops
  // to its own strip just under the bar instead of printing on top of the name.
  function topLabels(left, right, lc, rc) {
    ctx.font = '8px ' + FONT;
    const lw = ctx.measureText(left).width, rw = ctx.measureText(right).width;
    text(left, 8, 0, lc, 'left');
    if (!right) return;
    if (lw + rw + 14 <= 304) text(right, 312, 0, rc, 'right');
    else { box(8, 16, 304, 10, 'rgba(0,0,0,0.65)'); text(right, 312, 17, rc, 'right'); }
  }

  function drawBanner(s) {
    if (s.paused) { box(0, 70, W, 40, '#000'); text('PAUSED', W / 2, 84, '#ffff55', 'center', 16); return; }
    if (s.msg && s.state !== 'menu') {
      const lines = s.msg.split('\n');
      const y = s.state === 'gameover' || s.state === 'victory' ? 60 : 78;
      box(0, y - 6, W, lines.length > 1 ? 40 : 30, 'rgba(0,0,0,0.72)');
      text(lines[0], W / 2, y, s.state === 'gameover' ? '#ff5555' : '#ffffff', 'center', lines[0].length > 22 ? 8 : 16);
      if (lines[1]) text(lines[1], W / 2, y + 20, '#55ffff', 'center', 8);
    }
    if ((s.state === 'loot' || s.state === 'shop') && s.enc) {
      const joined = s.players.filter(p => p.joined && p.alive);
      box(8, 177, 304, 15, 'rgba(0,0,0,0.7)');
      let msg = s.state === 'shop' ? 'SHOP: [F] [/] BUY.  WALK UP TO LEAVE' : 'LOOT THE ROOM, THEN WALK UP THE GATE';
      text(msg, W / 2, 179, '#ffff55', 'center');
      if (joined.length > 1) {
        const rdy = joined.map(p => 'P' + (p.id + 1) + (s.enc.gate_in.includes(p.id) ? ' READY' : ' ...')).join('   ');
        text(rdy, W / 2, 185, '#55ff55', 'center');
      }
    }
  }

  let lastDraw = 0;
  function draw(now) {
    requestAnimationFrame(draw);
    pollPads();
    if (now - lastMsg > 2500 && lastMsg) $('#conn').hidden = false;
    if (!cur || !META) { box(0, 0, W, H, '#000'); return; }
    const s = cur;
    const wing = s.enc ? s.enc.wing : 'arachnid';
    ctx.globalAlpha = 1;
    ctx.drawImage(bgFor(wing), 0, 0);
    drawTorches(wing);
    if (s.state !== 'menu') {
      drawObstacles(s.enc);
      drawZones(s);
      drawGate(s);
      drawNpc(s);
      drawPickups(s);
      drawTelegraphs(s);
      drawEntities(s);
      drawProjs(s);
      drawFx(now);
      drawTopBar(s);
      drawBanner(s);
    } else {
      // attract mode backdrop
      text('', 0, 0);
    }
  }

  /* ------------------------------------------------------------------- UI */
  const uiKey = {};
  function setHTML(el, html, key) {
    if (uiKey[key] === html) return;
    uiKey[key] = html;
    el.innerHTML = html;
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function buildMenu() {
    const grid = $('#grid');
    grid.innerHTML = '';
    META.order.forEach((id, i) => {
      const c = META.classes[id];
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'cell'; b.dataset.cls = id; b.setAttribute('role', 'option');
      const cvs = document.createElement('canvas'); cvs.width = 32; cvs.height = 32;
      const g = cvs.getContext('2d'); g.imageSmoothingEnabled = false;
      g.drawImage(SPR.playerSprite(id, c.color, c.accent, 0, false), 0, 0, 32, 32);
      b.appendChild(cvs);
      b.insertAdjacentHTML('beforeend', '<span>' + esc(c.name.toUpperCase()) + '</span><em>' + esc(META.resources[c.res].label) + '</em><i class="t0" hidden></i><i class="t1" hidden></i>');
      b.addEventListener('click', ev => {
        if (A) A.init();
        const pid = isLocal() ? ((ev.shiftKey || ev.ctrlKey) ? 1 : 0) : mySeat();
        cmd('pick', { p: pid, cls: id });
      });
      b.addEventListener('contextmenu', ev => { if (isLocal()) { ev.preventDefault(); cmd('pick', { p: 1, cls: id }); } });
      grid.appendChild(b);
    });
    $('#m-ready0').addEventListener('click', () => { if (A) A.init(); cmd('ready', { p: isLocal() ? 0 : mySeat() }); });
    $('#m-ready1').addEventListener('click', () => { if (A) A.init(); cmd('ready', { p: 1 }); });
    $('#m-join').addEventListener('click', () => {
      if (!cur) return;
      if (cur.joined[1]) cmd('leave'); else cmd('pick', { p: 1, cls: cur.players[1].cls || META.order[0] });
    });
  }

  /* ------------------------------------------- v1.4: profile, characters, raids, talents */
  let pk = '', myChars = [], charMax = 8, raidKeyLast = '';
  const PK_RE = /^[A-Za-z0-9_-]{16,64}$/;
  function profileKey() {
    if (pk) return pk;
    try { pk = localStorage.getItem('naxx.pk') || ''; } catch (e) { pk = ''; }
    if (!PK_RE.test(pk)) {
      const a = new Uint8Array(24);
      (window.crypto || window.msCrypto).getRandomValues(a);
      pk = Array.from(a, b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
      try { localStorage.setItem('naxx.pk', pk); } catch (e) { /* in-memory only this session */ }
    }
    return pk;
  }
  async function charApi(op, extra) {
    const r = await api('/api/chars', Object.assign({ pk: profileKey(), op }, extra || {}));
    if (r.chars) { myChars = r.chars; if (r.max) charMax = r.max; uiKey.clist = null; if (cur && cur.state === 'menu') renderChars(cur); }
    return r;
  }
  const raidOf = id => (META.raids || []).find(r => r.id === id) || META.raids[0];
  const seatedIds = s => s.players.map(p => (p.joined && p.char) ? p.char.id : '');

  function renderRaids(s) {
    const host = isLocal() || mySeat() === 0;
    const key = s.raid + '|' + host;
    if (key === raidKeyLast) return;
    raidKeyLast = key;
    $('#raidsel').innerHTML = META.raids.map(r => '<button type="button" class="raid' + (r.id === s.raid ? ' on' : '') + '" data-id="' + r.id + '" style="--rc:' + r.color + '"' + (host ? '' : ' disabled') + '>' +
      '<b style="color:' + r.color + '">' + esc(r.name.toUpperCase()) + '</b><small>' + esc(r.blurb) + '</small>' +
      '<small>' + r.bosses.length + ' BOSSES &middot; ' + esc(r.length) + ' &middot; ' + esc(r.rec.toUpperCase()) + '</small><small>CLEAR XP ' + r.xp + '</small></button>').join('');
    $('#raid-note').textContent = host ? '' : 'THE HOST CHOOSES THE RAID';
  }

  function renderChars(s) {
    const seated = seatedIds(s);
    const key = JSON.stringify(myChars) + seated.join(',') + isLocal() + (s.players[1].joined ? 1 : 0);
    if (uiKey.clist === key) return;
    uiKey.clist = key;
    let h = '';
    myChars.forEach(c => {
      const cd = META.classes[c.cls];
      const sl = seated.indexOf(c.id);
      const xpTxt = c.need ? (c.into + ' / ' + c.need + ' XP') : 'MAX LEVEL';
      const pct = c.need ? Math.round(100 * c.into / c.need) : 100;
      h += '<div class="ch' + (sl >= 0 ? ' s' + sl : '') + '" data-id="' + c.id + '"><canvas width="32" height="32" data-cls="' + c.cls + '"></canvas>' +
        '<b>' + esc(c.name.toUpperCase()) + '</b><span class="lv">LV ' + c.level + ' ' + esc(cd.name.toUpperCase()) + '</span>' +
        '<div class="xpbar"><i style="width:' + pct + '%"></i></div><div class="xt">' + xpTxt + ' &middot; ' + c.bosses + ' BOSSES &middot; ' + c.clears + ' CLEARS</div><div class="cb">';
      if (isLocal()) {
        h += '<button type="button" data-act="play" data-p="0">P1</button>';
        if (s.players[1].joined) h += '<button type="button" data-act="play" data-p="1">P2</button>';
      } else h += '<button type="button" data-act="play" data-p="' + mySeat() + '">' + (sl >= 0 ? 'SELECTED' : 'PLAY') + '</button>';
      h += '<button type="button" data-act="tal" class="' + (c.points > 0 ? 'pts' : '') + '">TALENTS' + (c.points > 0 ? ' (' + c.points + ')' : '') + '</button><button type="button" data-act="del" class="del">DEL</button></div></div>';
    });
    if (!myChars.length) h = '<div class="none">NO CHARACTERS YET. NAME ONE BELOW AND PRESS CREATE, OR PLAY AS A GUEST.</div>';
    $('#clist').innerHTML = h;
    $('#clist').querySelectorAll('canvas').forEach(cv => {
      const c = META.classes[cv.dataset.cls];
      const g = cv.getContext('2d'); g.imageSmoothingEnabled = false;
      g.drawImage(SPR.playerSprite(cv.dataset.cls, c.color, c.accent, 0, false), 0, 0, 32, 32);
    });
    $('#ccls').hidden = false;
    $('#cnew').disabled = myChars.length >= charMax;
  }

  function setupChars() {
    $('#ccls').innerHTML = META.order.map(id => '<option value="' + id + '">' + esc(META.classes[id].name.toUpperCase()) + '</option>').join('');
    $('#raidsel').addEventListener('click', ev => {
      const b = ev.target.closest('.raid'); if (!b || b.disabled) return;
      if (A) A.init();
      cmd('raid', { id: b.dataset.id });
    });
    $('#clist').addEventListener('click', async ev => {
      const b = ev.target.closest('button'); if (!b) return;
      const id = b.closest('.ch').dataset.id;
      const c = myChars.find(x => x.id === id); if (!c) return;
      if (A) A.init();
      if (b.dataset.act === 'play') cmd('char', { p: +b.dataset.p, id });
      else if (b.dataset.act === 'tal') openTal(id);
      else if (b.dataset.act === 'del') {
        if (!confirm('Delete ' + c.name + ' (level ' + c.level + ') forever?')) return;
        const r = await charApi('delete', { id });
        $('#cmsg').textContent = r.ok ? '' : (r.error || '');
      }
    });
    $('#cform').addEventListener('submit', async ev => {
      ev.preventDefault();
      const r = await charApi('create', { name: $('#cname').value, cls: $('#ccls').value });
      $('#cmsg').textContent = r.ok ? '' : (r.error || 'COULD NOT CREATE');
      if (r.ok) {
        $('#cname').value = '';
        const made = r.chars[r.chars.length - 1];
        if (made && cur && cur.state === 'menu') cmd('char', { p: isLocal() ? 0 : mySeat(), id: made.id });
      }
    });
    $('#pkey').value = profileKey();
    $('#pkset').addEventListener('click', async () => {
      const v = $('#pkey').value.trim();
      if (!PK_RE.test(v)) { $('#cmsg').textContent = 'KEY MUST BE 16-64 LETTERS, DIGITS, - OR _'; return; }
      pk = v; try { localStorage.setItem('naxx.pk', pk); } catch (e) { /* ignore */ }
      $('#cmsg').textContent = 'PROFILE KEY CHANGED';
      await charApi('list');
    });
    $('#tal').addEventListener('click', ev => { if (ev.target === $('#tal')) closeTal(); });
  }

  let talChar = null;
  function openTal(id) { talChar = id; $('#tal').hidden = false; renderTal(''); }
  function closeTal() { talChar = null; $('#tal').hidden = true; }
  function renderTal(msg) {
    const c = myChars.find(x => x.id === talChar);
    if (!c) return closeTal();
    const spentIn = tr => tr.talents.reduce((n, t) => n + (c.talents[t.id] || 0), 0);
    const trees = META.trees[c.cls];
    let h = '<div class="tal-head"><h2>' + esc(c.name.toUpperCase()) + ' &middot; LV ' + c.level + ' ' + esc(META.classes[c.cls].name.toUpperCase()) + '</h2><span class="pts">' + c.points + ' TALENT POINT' + (c.points === 1 ? '' : 'S') + ' LEFT</span>' +
      '<span class="sp"><button type="button" id="tal-respec">FREE RESPEC</button><button type="button" id="tal-close">CLOSE</button></span></div><div class="trees">';
    trees.forEach(tr => {
      const sp = spentIn(tr);
      h += '<div class="tree"><h4><span>' + esc(tr.name.toUpperCase()) + '</span><span>' + sp + '</span></h4>';
      tr.talents.forEach(t => {
        const r = c.talents[t.id] || 0;
        const open = sp >= 2 * t.row;
        const cls = r >= t.max ? 'max' : (open && c.points > 0 ? 'can' : (open ? '' : 'lock'));
        h += '<button type="button" class="tn ' + cls + '" data-t="' + t.id + '"><b><span>' + esc(t.name) + '</span><span>' + r + '/' + t.max + '</span></b><small>' + esc(t.desc) + (open ? '' : ' (NEEDS ' + (2 * t.row) + ' POINTS IN ' + esc(tr.name.toUpperCase()) + ')') + '</small></button>';
      });
      h += '</div>';
    });
    h += '</div><div class="tal-msg">' + esc(msg || '') + '</div><p class="dim" style="font-size:7px">1 POINT PER LEVEL FROM LEVEL 2. EACH ROW UNLOCKS AFTER 2 POINTS PER ROW ABOVE IT IN THE SAME TREE. TALENTS CHANGE ONLY BETWEEN RUNS.</p>';
    $('#tal-inner').innerHTML = h;
  }
  document.addEventListener('click', async ev => {
    if (!talChar) return;
    if (ev.target.closest('#tal-close')) return closeTal();
    if (ev.target.closest('#tal-respec')) { const r = await charApi('respec', { id: talChar }); return renderTal(r.ok ? 'TALENTS RESET. SPEND THEM AGAIN.' : r.error); }
    const b = ev.target.closest('.tn');
    if (b && !b.classList.contains('lock')) { const r = await charApi('learn', { id: talChar, talent: b.dataset.t }); renderTal(r.ok ? '' : r.error); }
  });
  window.addEventListener('keydown', e => { if (talChar && e.code === 'Escape') closeTal(); }, true);

  function pickPanel(i, p) {
    const el = $('#pick' + i);
    el.className = 'pick c' + i;
    if (!p.joined) {
      const wait = isLocal() ? 'NOT PLAYING' : 'WAITING FOR A PLAYER...<br><br>SHARE GAME CODE <b>' + esc(room ? room.code : '') + '</b><br>OR PLAY SOLO';
      return setHTML(el, '<h3><span class="c' + i + '">' + (i ? 'PLAYER 2' : 'PLAYER 1') + '</span></h3><div class="off">' + wait + '</div>', 'pick' + i + wait);
    }
    const c = META.classes[p.cls];
    const res = META.resources[c.res];
    const li = (sp, form) => '<li title="' + esc(sp.desc) + '"><b>' + esc(sp.name) + '</b> <small>' + (sp.cost ? sp.cost + ' ' + res.label.slice(0, 4) + ' / ' : '') + sp.cd + 's</small><br>' + esc(sp.desc) + '</li>';
    let html = '<h3><span class="c' + i + '">' + esc(nameOf(i)) + ' &middot; ' + (p.char ? esc(p.char.name.toUpperCase()) + ' LV' + p.lv + ' ' : '') + esc(c.name.toUpperCase()) + (!isLocal() && room && room.seats[0] === i ? ' (YOU)' : '') + '</span><span class="' + (p.ready ? 'ready' : 'dim') + '">' + (p.ready ? 'READY!' : 'CHOOSING') + '</span></h3>';
    html += '<p>' + esc(c.blurb) + ' HP ' + Math.round(c.hp * 1.4 * (1 + 0.05 * (p.lv - 1))) + ' &middot; ' + esc(res.label) + '</p><ul>' + c.spells.map(sp => li(sp)).join('') + '</ul>';
    const forms = Object.keys(c.forms || {});
    forms.forEach(f => {
      html += '<p style="margin-top:6px">' + esc(f.toUpperCase()) + ' ABILITIES:</p><ul>' + c.forms[f].filter(sp => sp.id !== 'bearform' && sp.id !== 'stealth').map(sp => li(sp)).join('') + '</ul>';
    });
    setHTML(el, html, 'pick' + i);
  }

  function updateMenu(s) {
    const sel = s.players.map(p => p.cls);
    $('#grid').querySelectorAll('.cell').forEach(cell => {
      const id = cell.dataset.cls;
      const a = s.players[0].joined && !s.players[0].char && sel[0] === id, b = s.players[1].joined && !s.players[1].char && sel[1] === id;
      cell.classList.toggle('s0', a); cell.classList.toggle('s1', b);
      $('.t0', cell).hidden = !a; $('.t1', cell).hidden = !b;
      $('.t0', cell).textContent = nameOf(0).slice(0, 7); $('.t1', cell).textContent = nameOf(1).slice(0, 7);
    });
    renderRaids(s);
    renderChars(s);
    pickPanel(0, s.players[0]);
    pickPanel(1, s.players[1]);
    const r0 = $('#m-ready0'), r1 = $('#m-ready1');
    const mine = isLocal() ? 0 : mySeat();
    r0.classList.toggle('ready', s.players[mine].ready);
    r0.textContent = isLocal() ? (nameOf(0) + (s.players[0].ready ? ' READY!' : ' READY')) : (s.players[mine].ready ? 'READY! (TAP TO CANCEL)' : 'READY');
    r1.hidden = !isLocal() || !s.players[1].joined;
    $('#m-join').hidden = !isLocal();
    $('#m-join').textContent = s.players[1].joined ? 'DROP PLAYER 2 (SOLO)' : 'ADD PLAYER 2';
    r1.classList.toggle('ready', s.players[1].ready);
    r1.textContent = nameOf(1) + (s.players[1].ready ? ' READY!' : ' READY');
    $('#rb-code').textContent = room ? room.code : '----';
    $('#rb-who').textContent = isLocal() ? 'LOCAL CO-OP' : (s.room ? s.room.names.filter(Boolean).map((n, k) => n.toUpperCase()).join(' + ') : '');
    const j = s.players.filter(p => p.joined), r = j.filter(p => p.ready).length;
    $('#menu-hint').textContent = r ? ('WAITING FOR ' + (j.length - r) + ' MORE PLAYER' + (j.length - r > 1 ? 'S' : '') + ' TO READY UP') : (isLocal() || s.players[1 - mine].joined ? 'PICK A CLASS, THEN PRESS READY. THE GAME STARTS WHEN EVERYONE IS READY.' + (isLocal() ? ' SOLO: JUST PRESS READY.' : '') : 'PICK A CLASS AND PRESS READY TO PLAY SOLO, OR WAIT FOR A FRIEND TO JOIN WITH CODE ' + (room ? room.code : '') + '.');
  }

  function refreshKeyLabels() { uiKey.pl0 = uiKey.pl1 = null; if (cur) updateHUD(cur); }

  const KEYLBL = [['1', '2', '3', '4', 'Q', 'E'], ['7', '8', '9', '0', '-', '=']];
  const SLOTLBL = { neck: 'NECK', ring: 'RING', trinket: 'TRINKET', weapon: 'WEAPON' };
  const STLBL = { stun: 'STUN', freeze: 'FROZEN', fear: 'FEAR', slow: 'SLOW', root: 'ROOT', necro: 'NECROTIC', vuln: 'MARKED', charm: 'CHARMED',
    wrapped: 'WRAPPED', giant: 'GIANT', innerfire: 'INNER FIRE', unholy: 'UNHOLY AURA', windfury: 'WINDFURY', unholyls: 'LEECH', stone: 'STONESHIELD', evade: 'EVASION', meta: 'METAMORPHOSIS',
    divine: 'DIVINE SHIELD', shield: 'SHIELD', stealth: 'STEALTH', fbloom: 'FUNGAL BLOOM', mortal: 'MORTAL WOUND', whirl: 'WHIRLWIND', enrage: 'ENRAGE' };

  function updateHUD(s) {
    s.players.forEach((p, i) => {
      const el = $('#pl' + i);
      el.className = 'pl p' + i + (p.joined ? '' : ' off') + (p.joined && !p.alive ? ' dead' : '');
      if (!p.joined) { setHTML(el, '<header><span><b class="t">' + (i + 1) + '</b>NOT PLAYING</span></header><div class="dim">NO SECOND PLAYER IN THIS RUN</div>', 'pl' + i + 'off'); return; }
      const cdef = META.classes[p.cls];
      const res = META.resources[p.rtype];
      const kl = isLocal() ? KEYLBL[i] : KEYLBL[0];
      const ids = p.spells.map(sp => sp.id).join(',');
      const structure = ids + '|' + p.rtype + '|' + p.cls + '|' + mode + '|' + nameOf(i);
      if (uiKey['pl' + i + 's'] !== structure) {
        uiKey['pl' + i + 's'] = structure;
        uiKey['pl' + i] = null;
        const allSpells = (cdef.spells || []).concat(...Object.values(cdef.forms || {}));
        const byId = {}; allSpells.forEach(sp => { byId[sp.id] = sp; });
        let h = '<header><span><b class="t">' + esc(nameOf(i)) + '</b><span class="cls">' + esc(cdef.name.toUpperCase()) + (!isLocal() && mySeat() === i ? ' (YOU)' : '') + '</span></span><span class="gold"></span></header>';
        h += '<div class="bar hp"><i></i><b></b></div><div class="bar sh"><i></i></div><div class="bar res"><i></i><b></b></div><div class="spells">';
        p.spells.forEach((sp, k) => {
          const d = byId[sp.id] || {};
          h += '<button type="button" class="sp" tabindex="-1" title="' + esc((d.name || sp.name) + ': ' + (d.desc || '')) + '"><kbd>' + kl[k] + '</kbd><b>' + esc(sp.name) + '</b><small>' + (sp.cost ? sp.cost : 'FREE') + '</small><u></u><s></s></button>';
        });
        h += '</div><div class="gear">';
        for (let c = 0; c < 2; c++) h += '<div class="slot cons"><em>' + kl[4 + c] + '</em><span>-</span></div>';
        ['neck', 'ring', 'trinket', 'weapon'].forEach(sl => { h += '<div class="slot eq" data-slot="' + sl + '"><em>' + SLOTLBL[sl] + '</em><span>-</span></div>'; });
        h += '</div><div class="stat"></div>';
        el.innerHTML = h;
      }
      // dynamic values
      el.querySelector('header .gold').textContent = (p.char ? 'LV ' + p.lv + '  ' : '') + p.gold + ' GOLD';
      const hp = el.querySelector('.bar.hp');
      hp.classList.toggle('low', p.hp < p.maxhp * 0.3);
      hp.firstElementChild.style.width = clamp(p.hp / p.maxhp * 100, 0, 100) + '%';
      hp.lastElementChild.textContent = 'HP ' + Math.ceil(p.hp) + '/' + Math.round(p.maxhp);
      const sh = el.querySelector('.bar.sh');
      sh.style.visibility = p.shield > 0 ? 'visible' : 'hidden';
      sh.firstElementChild.style.width = clamp(p.shield / 35 * 100, 0, 100) + '%';
      const rb = el.querySelector('.bar.res');
      rb.firstElementChild.style.width = clamp(p.res / p.resmax * 100, 0, 100) + '%';
      rb.firstElementChild.style.background = res.color;
      rb.lastElementChild.textContent = res.label + ' ' + Math.floor(p.res);
      const btns = el.querySelectorAll('.sp');
      p.spells.forEach((sp, k) => {
        const b = btns[k]; if (!b) return;
        const frac = sp.cdmax > 0 ? clamp(sp.cd / sp.cdmax, 0, 1) : 0;
        b.firstElementChild; // kbd
        b.querySelector('u').style.height = (frac * 100) + '%';
        b.querySelector('s').textContent = sp.cd > 0.05 ? sp.cd.toFixed(1) : '';
        b.classList.toggle('nores', !sp.ok && sp.cd <= 0.05);
        b.classList.toggle('active', !!sp.active);
        b.classList.toggle('cd', sp.cd > 0.05);
      });
      const cons = el.querySelectorAll('.slot.cons');
      p.cons.forEach((c, k) => {
        const sl = cons[k]; const span = sl.querySelector('span');
        span.textContent = c ? c[1] : '-'; span.style.color = c ? c[2] : '';
        sl.style.opacity = c && p.potcd > 0 ? 0.5 : 1;
      });
      el.querySelectorAll('.slot.eq').forEach(sl => {
        const it = p.equip[sl.dataset.slot]; const span = sl.querySelector('span');
        span.textContent = it ? it.name : '-'; span.style.color = it ? it.rcolor : '';
        sl.classList.toggle('leg', !!(it && it.leg));
        sl.dataset.has = it ? '1' : '';
      });
      const stl = p.st.filter(n => STLBL[n]).map(n => STLBL[n]);
      if (p.form === 'bear') stl.unshift('BEAR');
      if (p.souls > 0 || p.reap > 0) stl.push(p.reap > 0 ? 'SOUL REAPER ' + p.reap.toFixed(0) + 's' : 'SOULS ' + p.souls + '/10');
      if (p.pet_t > 0) { const m = Math.floor(p.pet_t / 60), sc = Math.floor(p.pet_t % 60); stl.push('FALCON ' + m + ':' + String(sc).padStart(2, '0')); }
      el.querySelector('.stat').textContent = p.alive ? stl.join(' / ') : 'DEAD. REVIVES AT THE NEXT BOSS IF YOUR PARTNER LIVES.';
    });
  }

  const interactKeys = () => touchMode ? 'USE' : isLocal() ? 'P1 F, P2 /' : 'F OR /';
  function updateDrops(s) {
    const items = s.pickups.filter(p => p.k !== 'gold');
    const key = items.map(p => p.name + p.desc + p.price).join('|') + s.state + mode;
    if (uiKey.drops === key) return;
    uiKey.drops = key;
    const el = $('#drops');
    if (!items.length) { el.innerHTML = ''; return; }
    const shop = s.state === 'shop';
    let h = '<div class="head">' + (shop ? 'FOR SALE. STAND NEXT TO AN ITEM AND PRESS INTERACT (' + interactKeys() + '). TRADE-IN: YOUR OLD ITEM IS SOLD.' : 'LOOT. WALK OVER IT. PRESS INTERACT (' + interactKeys() + ') TO EQUIP OR SWAP.') + '</div>';
    items.forEach(p => {
      h += '<div class="chip"><b style="color:' + p.c + '">' + esc(p.name) + '</b><em>' + esc(p.k === 'item' ? p.slot.toUpperCase() + ' ' + p.desc : 'CONSUMABLE') + '</em>' + (p.price ? '<span style="color:#ffff55">' + p.price + 'G</span>' : '') + '</div>';
    });
    el.innerHTML = h;
  }

  let logSeq = -1;
  function updateLog(s) {
    const last = s.log.length ? s.log[s.log.length - 1][0] : 0;
    if (last === logSeq) return;
    logSeq = last;
    const el = $('#log');
    el.innerHTML = s.log.slice(-6).map(l => '<div style="color:' + l[2] + '">&gt; ' + esc(l[1]) + '</div>').join('');
  }

  function updateEnd(s) {
    const over = s.state === 'gameover' || s.state === 'victory';
    $('#end').hidden = !over;
    if (!over || !s.result) return;
    const r = s.result;
    const inner = $('#end .end-inner');
    inner.className = 'end-inner ' + (r.won ? 'win' : 'lose');
    const rd = raidOf(s.raid);
    $('#end-title').textContent = r.won ? rd.win : rd.lose;
    const xp = s.players.filter(p => p.joined && p.char).map(p => p.char.name.toUpperCase() + ' +' + p.xpg + ' XP (LV ' + p.lv + (p.char.points > 0 ? ', ' + p.char.points + ' TALENT POINT' + (p.char.points > 1 ? 'S' : '') + ' TO SPEND' : '') + ')');
    $('#end-sub').textContent = 'GOLD ' + r.gold + '  /  BOSSES SLAIN ' + r.bosses + ' OF ' + rd.bosses.length + (xp.length ? '  /  ' + xp.join('  /  ') : '') + '. YOUR CHARACTER IS SAVED.';
    let t = '<table><tr><th>#</th><th>TEAM</th><th>GOLD</th><th>BOSSES</th></tr>';
    let marked = false;
    (s.scores || []).forEach((sc, i) => {
      const me = !marked && sc.gold === r.gold && sc.bosses === r.bosses;
      if (me) marked = true;
      t += '<tr' + (me ? ' class="me"' : '') + '><td>' + (i + 1) + '</td><td>' + teamName(sc) + '</td><td>' + sc.gold + '</td><td>' + sc.bosses + (sc.won ? ' WIN' : '') + '</td></tr>';
    });
    $('#end-scores').innerHTML = t + '</table>';
  }

  function updateProgress(s) {
    const el = $('#progress');
    const n = raidOf(s.raid).bosses.length;
    if (el.children.length !== n) { el.innerHTML = ''; for (let i = 0; i < n; i++) el.appendChild(document.createElement('i')); }
    const idx = s.state === 'menu' ? -1 : (s.enc ? s.enc.idx : -1);
    for (let i = 0; i < n; i++) {
      const c = el.children[i];
      const done = idx >= 0 && (i < idx || (i === idx && (s.state === 'loot' || s.state === 'shop' || s.state === 'victory')));
      c.className = done ? 'done' : (i === idx ? 'now' : '');
    }
  }

  function updateUI(s) {
    if (!META || !room) return;
    $('#menu').hidden = s.state !== 'menu';
    $('#screen').hidden = s.state === 'menu';
    $('#hud').hidden = s.state === 'menu';
    $('#btn-pause').textContent = s.paused ? 'RESUME' : 'PAUSE';
    $('#conn').hidden = true;
    if (s.state === 'menu') updateMenu(s); else updateHUD(s);
    updateTouch(s);
    updateDrops(s);
    updateTips(s);
    updateLog(s);
    updateEnd(s);
    updateProgress(s);
  }

  /* ------------------------------------------------------------------- boot */
  /* ------------------------------------------------- lobby, matchmaking, board */
  async function api(path, body) {
    try {
      const r = await fetch(API + path, { method: 'POST', body: JSON.stringify(Object.assign({ sid }, body || {})) });
      return await r.json();
    } catch (e) { return { ok: false, error: 'NO CONNECTION TO THE SERVER' }; }
  }
  function setView(v) {
    view = v;
    document.body.dataset.view = v;
    $('#lobby').hidden = v !== 'lobby';
    $('#board').hidden = v !== 'board';
    $('#room').hidden = v !== 'room';
    if (v !== 'room') document.body.classList.remove('tplay', 'chatopen');
    $('#touch').hidden = v !== 'room' || !touchMode;
    if (v === 'lobby') { refreshStats(); }
    fitScreen();
  }
  function saveName() {
    myName = ($('#name').value || '').replace(/[<>&"'`]/g, '').trim().slice(0, 12);
    try { localStorage.setItem('naxx.name', myName); } catch (e) { /* ignore */ }
    return myName;
  }
  const lobbyMsg = t => { $('#lobby-msg').textContent = t || ''; };
  function enterRoom(res) {
    stopMatch();
    room = { code: res.code, seats: res.seats };
    cur = prev = null; lastMsg = 0; lastState = ''; chatMsgs.length = 0; chatSeen = 0; uiKey.drops = uiKey.tips = null;
    $('#chatlog').innerHTML = ''; $('#feed').innerHTML = '';
    setSeats(res.seats);
    raidKeyLast = ''; uiKey.clist = null; charApi('list');
    $('#roomcode').textContent = res.code;
    setView('room');
    connect();
    try { history.replaceState(null, '', location.pathname + '?room=' + res.code); } catch (e) { /* ignore */ }
  }
  function leaveToLobby(msg) {
    if (es) { es.close(); es = null; }
    const had = room; room = null; cur = prev = null; lastMsg = 0; $('#gear').hidden = true;
    if (had) api('/api/leave');
    releaseAll();
    $('#conn').hidden = true; $('#end').hidden = true;
    setView('lobby');
    lobbyMsg(msg || '');
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
  }
  async function createGame(local) {
    if (!saveName()) { lobbyMsg('ENTER A NAME FIRST'); $('#name').focus(); return; }
    lobbyMsg('');
    const r = await api('/api/create', { name: myName, local: !!local });
    if (!r.ok) return lobbyMsg(r.error || 'COULD NOT CREATE A GAME');
    enterRoom(r);
  }
  async function joinGame(code) {
    if (!saveName()) { lobbyMsg('ENTER A NAME FIRST'); $('#name').focus(); return; }
    code = (code || '').trim().toUpperCase();
    if (code.length !== 4) { lobbyMsg('ENTER THE 4 LETTER GAME CODE'); $('#code').focus(); return; }
    lobbyMsg('');
    const r = await api('/api/join', { name: myName, code });
    if (!r.ok) return lobbyMsg(r.error || 'COULD NOT JOIN');
    enterRoom(r);
  }
  let mmTimer = 0, mmStart = 0;
  async function quickMatch() {
    if (!saveName()) { lobbyMsg('ENTER A NAME FIRST'); $('#name').focus(); return; }
    lobbyMsg('');
    const r = await api('/api/match', { name: myName });
    if (!r.ok) return lobbyMsg(r.error || 'MATCHMAKING FAILED');
    if (r.status === 'matched') return enterRoom(r);
    mmStart = performance.now();
    $('#mm').hidden = false; $('#mm-solo').hidden = true;
    ['l-match', 'l-create', 'l-join', 'l-local'].forEach(i => { $('#' + i).disabled = true; });
    mmTimer = setInterval(async () => {
      let st;
      try { st = await (await fetch(API + '/api/match/status?sid=' + encodeURIComponent(sid))).json(); } catch (e) { return; }
      if (st.status === 'matched') { enterRoom(st); return; }
      if (st.status === 'idle') { stopMatch(); lobbyMsg('MATCH EXPIRED. TRY AGAIN.'); return; }
      const secs = Math.floor((performance.now() - mmStart) / 1000);
      $('#mm-sub').textContent = 'WAITING ' + secs + 's. ' + (st.waiting > 1 ? st.waiting + ' IN QUEUE.' : 'YOU ARE THE ONLY ONE IN THE QUEUE.');
      $('#mm-solo').hidden = secs < 15;
    }, 1000);
  }
  function stopMatch() {
    if (mmTimer) { clearInterval(mmTimer); mmTimer = 0; api('/api/match/cancel'); }
    $('#mm').hidden = true;
    ['l-match', 'l-create', 'l-join', 'l-local'].forEach(i => { $('#' + i).disabled = false; });
  }
  async function refreshStats() {
    try {
      const st = await (await fetch(API + '/api/lobby')).json();
      $('#lobby-stats').textContent = st.online + ' PLAYER' + (st.online === 1 ? '' : 'S') + ' ONLINE  /  ' + st.rooms + ' GAME' + (st.rooms === 1 ? '' : 'S') + '  /  ' + st.waiting + ' LOOKING FOR A MATCH';
    } catch (e) { /* ignore */ }
  }
  setInterval(() => { if (view === 'lobby' && !document.hidden) refreshStats(); }, 5000);

  let boardFrom = 'lobby', boardFilter = 'all', boardData = [];
  const teamName = sc => ((sc.names && sc.names.length) ? sc.names.map(n => esc(n)).join(' + ') : '-');
  function renderBoard() {
    let rows = boardData.slice();
    if (boardFilter === 'win') rows = rows.filter(r => r.won);
    if (boardFilter === 'duo') rows = rows.filter(r => (r.classes || []).length > 1);
    if (boardFilter === 'solo') rows = rows.filter(r => (r.classes || []).length === 1);
    rows = rows.slice(0, 50);
    let t = '<table class="lb"><tr><th>#</th><th>TEAM</th><th>GOLD</th><th>BOSSES</th><th>CLASSES</th><th>DATE</th></tr>';
    rows.forEach((r, i) => {
      t += '<tr class="' + (i < 3 ? 'top' + (i + 1) : '') + '"><td>' + (i + 1) + '</td><td>' + teamName(r) + '</td><td class="g">' + r.gold + '</td><td>' + r.bosses + (r.won ? ' <em>WIN</em>' : '') + '</td><td class="dim">' + esc((r.classes || []).join(' + ')) + '</td><td class="dim">' + esc(r.date || '') + '</td></tr>';
    });
    if (!rows.length) t += '<tr><td colspan="6" class="dim" style="text-align:center;padding:18px">NO RUNS YET. BE THE FIRST.</td></tr>';
    $('#board-table').innerHTML = t + '</table>';
    $('#board-filters').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.f === boardFilter));
  }
  async function openBoard(from) {
    boardFrom = from || 'lobby';
    setView('board');
    $('#board-table').innerHTML = '<p class="dim" style="padding:16px">LOADING...</p>';
    try { boardData = await (await fetch(API + '/api/leaderboard')).json(); } catch (e) { boardData = []; }
    renderBoard();
  }
  $('#board-filters').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { boardFilter = b.dataset.f; renderBoard(); } });
  $('#board-back').addEventListener('click', () => setView(boardFrom === 'room' && room ? 'room' : 'lobby'));
  $('#end-board').addEventListener('click', () => openBoard('room'));
  $('#l-board').addEventListener('click', () => openBoard('lobby'));
  $('#l-match').addEventListener('click', quickMatch);
  $('#mm-cancel').addEventListener('click', () => { stopMatch(); });
  $('#mm-solo').addEventListener('click', () => { stopMatch(); createGame(false); });
  $('#l-create').addEventListener('click', () => createGame(false));
  $('#l-local').addEventListener('click', () => createGame(true));
  $('#l-join').addEventListener('click', () => joinGame($('#code').value));
  $('#code').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  $('#code').addEventListener('keydown', e => { if (e.key === 'Enter') joinGame($('#code').value); });
  $('#name').addEventListener('keydown', e => { if (e.key === 'Enter') { if ($('#code').value.length === 4) joinGame($('#code').value); else $('#l-match').click(); } });
  $('#btn-leave').addEventListener('click', () => leaveToLobby(''));
  function copyInvite() {
    if (!room) return;
    const url = location.origin + location.pathname + '?room=' + room.code;
    const done = () => toast('INVITE LINK COPIED. CODE ' + room.code);
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, () => toast('GAME CODE ' + room.code + '  ' + url));
    else toast('GAME CODE ' + room.code + '  ' + url);
  }
  $('#roomchip').addEventListener('click', copyInvite);
  $('#rb-copy').addEventListener('click', copyInvite);
  window.addEventListener('beforeunload', () => {
    if (room && navigator.sendBeacon) navigator.sendBeacon(API + '/api/leave', JSON.stringify({ sid }));
  });

  /* ------------------------------------------------------------------- chat */
  const chatMsgs = [];
  let chatSeen = 0;
  const seatColor = seat => seat === 0 ? '#55ffff' : seat === 1 ? '#ff55ff' : '#8a86b0';
  function addChat(m) {
    if (m.n <= chatSeen) return;
    chatSeen = m.n;
    chatMsgs.push(Object.assign({ at: performance.now() }, m)); if (chatMsgs.length > 60) chatMsgs.shift();
    const line = m.sys ? '<div class="m sys">* ' + esc(m.text) + '</div>' : '<div class="m"><b style="color:' + seatColor(m.seat) + '">' + esc(m.name.toUpperCase()) + '</b> ' + esc(m.text) + '</div>';
    const box_ = $('#chatlog'); const atEnd = box_.scrollTop + box_.clientHeight >= box_.scrollHeight - 8;
    box_.insertAdjacentHTML('beforeend', line);
    while (box_.children.length > 60) box_.removeChild(box_.firstChild);
    if (atEnd) box_.scrollTop = box_.scrollHeight;
    if (!m.sys && A && m.seat !== mySeat()) A.sfx && A.sfx('coin');
    renderFeed();
  }
  function renderFeed() {
    const now = performance.now();
    const recent = chatMsgs.filter(m => now - m.at < 9000).slice(-4);
    const html = recent.map(m => m.sys ? '<div class="sys">* ' + esc(m.text) + '</div>' : '<div><b style="color:' + seatColor(m.seat) + '">' + esc(m.name.toUpperCase()) + '</b> ' + esc(m.text) + '</div>').join('');
    if (uiKey.feed !== html) { uiKey.feed = html; $('#feed').innerHTML = html; }
  }
  setInterval(renderFeed, 1000);
  function openChat() {
    if (touchMode && document.body.classList.contains('tplay')) document.body.classList.add('chatopen');
    const i = $('#chatin'); i.focus({ preventScroll: false });
  }
  function closeChatTouch() { document.body.classList.remove('chatopen'); }
  $('#chatform').addEventListener('submit', async e => {
    e.preventDefault();
    const i = $('#chatin'), text = i.value.trim();
    i.value = '';
    if (text) await api('/api/chat', { text });
    i.blur(); closeChatTouch();      // back to the game after sending
  });
  $('#chatclose').addEventListener('click', () => { $('#chatin').blur(); closeChatTouch(); });
  $('#t-chat').addEventListener('pointerdown', e => { e.preventDefault(); openChat(); });

  /* ------------------------------------------------------------------- boot */
  async function boot() {
    fitScreen(); checkOrient();
    try { await document.fonts.load('8px "Press Start 2P"'); } catch (e) { /* offline: fallback font */ }
    try {
      const r = await fetch(API + '/api/meta');
      META = await r.json();
    } catch (e) { $('#conn').hidden = false; setTimeout(boot, 1500); return; }
    $('#conn').hidden = true;
    buildMenu();
    setupChars();
    if (touchMode) setupTouch();
    try { $('#name').value = localStorage.getItem('naxx.name') || ''; } catch (e) { /* ignore */ }
    const q = new URLSearchParams(location.search).get('room');
    if (q) $('#code').value = q.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    setView('lobby');
    if (q) lobbyMsg('ENTER YOUR NAME, THEN PRESS JOIN');
    if (!window.__bootDone) { window.__bootDone = true; requestAnimationFrame(draw); }
  }
  boot();
  window.__naxx = { get snap() { return cur; }, cmd, get meta() { return META; }, get sid() { return sid; }, get room() { return room; } };
})();
