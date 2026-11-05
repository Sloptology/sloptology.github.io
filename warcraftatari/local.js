/* Browser-only build: replaces the network with a Web Worker running the game's Python engine (Pyodide).
   Loaded before game.js. The page then behaves exactly like the online version, but nothing leaves your browser. */
(function () {
  if (window.NAXX_MODE !== 'local') return;
  const realFetch = window.fetch.bind(window);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode: progress lasts this session only */ } },
  };
  document.addEventListener('DOMContentLoaded', () => {
    document.body.classList.add('local');
    if (!store.get('naxx.name')) store.set('naxx.name', 'HERO');
    const lb = document.getElementById('l-local'); if (lb) lb.textContent = 'PLAY (SOLO OR 2 PLAYERS ON ONE KEYBOARD)';
  });
  const boot = document.createElement('div');
  boot.id = 'bootmsg';
  boot.innerHTML = '<div><b>WARCRAFT: ATARI</b><p id="bootmsg-t">STARTING...</p><p class="dim">THE FIRST LOAD DOWNLOADS ABOUT 10 MB. AFTER THAT IT IS CACHED.</p></div>';
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(boot));

  const worker = new Worker('local/worker.js');
  let nextId = 1, readyRes, failed = '';
  const pending = new Map();
  const ready = new Promise(res => { readyRes = res; });
  let stream = null;

  worker.onmessage = ev => {
    const m = ev.data;
    if (m.type === 'res') { const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } }
    else if (m.type === 'frames') { if (stream) stream._frames(m.text); }
    else if (m.type === 'persist') {
      if (m.files['saves.json'] != null) store.set('wa.saves', m.files['saves.json']);
      if (m.files['scores.json'] != null) store.set('wa.scores', m.files['scores.json']);
    } else if (m.type === 'progress') { const t = document.getElementById('bootmsg-t'); if (t) t.textContent = m.text; }
    else if (m.type === 'ready') { readyRes(); boot.remove(); }
    else if (m.type === 'error') {
      failed = m.text;
      const t = document.getElementById('bootmsg-t'); if (t && !document.querySelector('body.booted')) t.textContent = 'COULD NOT START: ' + m.text;
      console.error('engine:', m.text);
    }
  };
  worker.postMessage({ type: 'init', saves: store.get('wa.saves'), scores: store.get('wa.scores') });

  function call(method, url, body, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      ready.then(() => {
        const id = nextId++;
        const done = m => resolve(new Response(JSON.stringify(m.body), { status: m.status, headers: { 'Content-Type': 'application/json' } }));
        pending.set(id, done);
        if (signal) signal.addEventListener('abort', () => { pending.delete(id); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
        worker.postMessage({ id, method, url, body });
      });
    });
  }
  const isApi = u => typeof u === 'string' && u.startsWith('/api/');
  window.fetch = function (url, opts) {
    if (!isApi(url)) return realFetch(url, opts);
    opts = opts || {};
    return call((opts.method || 'GET').toUpperCase(), url, opts.body || '', opts.signal);
  };
  if (navigator.sendBeacon) { const sb = navigator.sendBeacon.bind(navigator); navigator.sendBeacon = (u, d) => isApi(u) ? true : sb(u, d); }

  class LocalEventSource {
    constructor(url) {
      this.readyState = 0; this._l = {}; this.onopen = this.onmessage = this.onerror = null;
      stream = this;
      call('GET', url, '').then(r => {
        if (stream !== this) return;
        if (r.status === 200) { this.readyState = 1; if (this.onopen) this.onopen({}); }
        else { this.readyState = 2; if (this.onerror) this.onerror({}); }
      });
    }
    addEventListener(n, f) { (this._l[n] = this._l[n] || []).push(f); }
    close() {
      this.readyState = 2;
      if (stream === this) { stream = null; }
      worker.postMessage({ type: 'close_stream', sid: window.__naxx && window.__naxx.sid });
    }
    _frames(text) {
      for (const block of text.split('\n\n')) {
        if (!block || block[0] === ':') continue;
        let ev = '', data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) ev = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trimStart();
        }
        if (!data) continue;
        if (ev === 'chat' && data.indexOf('CREATED THE GAME') >= 0) continue;   // room codes mean nothing offline
        const e = { data };
        if (!ev) { if (this.onmessage) this.onmessage(e); }
        else (this._l[ev] || []).forEach(f => f(e));
      }
    }
  }
  window.EventSource = LocalEventSource;
})();
