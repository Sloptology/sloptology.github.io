/* Web Worker: runs Pyodide (Python in WebAssembly) and the game's own Python engine. */
let py = null, host = null, booting = false;
const queue = [];

function post(m) { self.postMessage(m); }

async function boot(init) {
  if (booting) return;
  booting = true;
  try {
    post({ type: 'progress', text: 'LOADING PYTHON...' });
    importScripts('../pyodide/pyodide.js');
    py = await loadPyodide({ indexURL: new URL('../pyodide/', self.location.href).href });
    post({ type: 'progress', text: 'LOADING GAME ENGINE...' });
    const bundle = await (await fetch('../py/bundle.json')).json();
    py.FS.mkdirTree('/app');
    for (const [name, src] of Object.entries(bundle)) py.FS.writeFile('/app/' + name, src);
    if (init.saves) py.FS.writeFile('/app/saves.json', init.saves);
    if (init.scores) py.FS.writeFile('/app/scores.json', init.scores);
    py.runPython("import sys; sys.path.insert(0, '/app'); import host");
    host = py.pyimport('host');
    host.changed_files();   // remember the starting state of saves/scores
    post({ type: 'ready' });
    for (const m of queue.splice(0)) handle(m);
    loop();
  } catch (e) {
    post({ type: 'error', text: String(e && e.message || e) });
  }
}

function handle(m) {
  if (m.type === 'close_stream') { host.close_stream(m.sid); return; }
  let res;
  try { res = JSON.parse(host.handle(m.method, m.url, m.body || '')); }
  catch (e) { res = { status: 500, body: { ok: false, error: 'ENGINE ERROR: ' + e } }; }
  post({ type: 'res', id: m.id, status: res.status, body: res.body });
}

let nextAt = 0, n = 0;
function loop() {
  const dt = 1000 / 30;
  const t0 = performance.now();
  if (!nextAt) nextAt = t0;
  try {
    const frames = host.tick();
    if (frames) post({ type: 'frames', text: frames });
    const ch = host.changed_files();
    if (ch) post({ type: 'persist', files: JSON.parse(ch) });
    if (++n % 60 === 0) host.maintain();
  } catch (e) { post({ type: 'error', text: 'TICK: ' + e }); }
  nextAt += dt;
  const now = performance.now();
  if (nextAt < now - 200) nextAt = now;       // fell far behind: skip, do not spiral
  setTimeout(loop, Math.max(0, nextAt - now));
}

self.onmessage = ev => {
  const m = ev.data;
  if (m.type === 'init') { boot(m); return; }
  if (!host) { queue.push(m); return; }
  handle(m);
};
