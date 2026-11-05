/* Tiny chiptune engine: square/triangle/noise sound effects and a looping minor-key tune.
   Everything is synthesised with WebAudio, so there are no audio files. */
(function () {
  'use strict';
  const A = { ctx: null, master: null, on: true, musicOn: true, last: {}, timer: null, step: 0, noiseBuf: null };

  A.init = function () {
    if (A.ctx) { if (A.ctx.state === 'suspended') A.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    A.ctx = new AC();
    A.master = A.ctx.createGain();
    A.master.gain.value = A.on ? 0.5 : 0;
    A.master.connect(A.ctx.destination);
    const len = A.ctx.sampleRate;
    A.noiseBuf = A.ctx.createBuffer(1, len, A.ctx.sampleRate);
    const d = A.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    A.startMusic();
  };

  A.setOn = function (on) {
    A.on = on;
    if (A.master) A.master.gain.setTargetAtTime(on ? 0.5 : 0, A.ctx.currentTime, 0.02);
  };

  function tone(type, f0, f1, dur, vol, delay) {
    const c = A.ctx, t = c.currentTime + (delay || 0);
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g); g.connect(A.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  function noise(dur, vol, lp, delay) {
    const c = A.ctx, t = c.currentTime + (delay || 0);
    const s = c.createBufferSource(), g = c.createGain(), f = c.createBiquadFilter();
    s.buffer = A.noiseBuf; f.type = 'lowpass'; f.frequency.value = lp || 3000;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    s.connect(f); f.connect(g); g.connect(A.master);
    s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.02);
  }

  const FX = {
    cast:    () => { tone('square', 420, 900, 0.09, 0.10); },
    hit:     () => { noise(0.05, 0.16, 2600); },
    kill:    () => { tone('square', 300, 80, 0.14, 0.12); },
    boom:    () => { noise(0.35, 0.34, 700); tone('sawtooth', 130, 40, 0.3, 0.14); },
    hurt:    () => { tone('sawtooth', 220, 90, 0.12, 0.12); },
    death:   () => { tone('sawtooth', 300, 40, 0.7, 0.16); },
    coin:    () => { tone('square', 988, 988, 0.05, 0.08); tone('square', 1319, 1319, 0.12, 0.08, 0.05); },
    pick:    () => { [523, 659, 784].forEach((f, i) => tone('square', f, f, 0.07, 0.09, i * 0.06)); },
    potion:  () => { tone('triangle', 300, 900, 0.22, 0.16); },
    zap:     () => { noise(0.12, 0.14, 5000); tone('square', 1400, 300, 0.1, 0.07); },
    freeze:  () => { tone('triangle', 1600, 800, 0.25, 0.12); },
    victory: () => { [392, 523, 659, 784, 1046].forEach((f, i) => tone('square', f, f, 0.16, 0.11, i * 0.11)); },
    ui:      () => { tone('square', 700, 700, 0.04, 0.07); },
  };

  A.sfx = function (name) {
    if (!A.ctx || !A.on) return;
    const now = performance.now();
    if (A.last[name] && now - A.last[name] < (name === 'hit' ? 45 : 70)) return;
    A.last[name] = now;
    const f = FX[name];
    if (f) { try { f(); } catch (e) { /* ignore */ } }
  };

  // Bass + arpeggio in A minor / F major, 8 steps per bar.
  const BASS = [110, 110, 110, 110, 87.3, 87.3, 98, 98];
  const ARP = [[220, 262, 330], [220, 262, 330], [174.6, 220, 262], [196, 247, 294]];
  A.startMusic = function () {
    if (A.timer || !A.ctx) return;
    A.timer = setInterval(() => {
      if (!A.on || !A.musicOn || A.ctx.state !== 'running') return;
      const s = A.step++;
      const bar = Math.floor(s / 8) % 4, i = s % 8;
      const bassF = BASS[(bar * 2 + (i >> 2)) % BASS.length] * (bar === 3 ? 1.12 : 1);
      if (i % 2 === 0) tone('triangle', bassF, bassF, 0.22, 0.10);
      const arp = ARP[bar];
      tone('square', arp[i % 3] * 2, arp[i % 3] * 2, 0.10, 0.025);
    }, 170);
  };
  window.NAXX_AUDIO = A;
})();
