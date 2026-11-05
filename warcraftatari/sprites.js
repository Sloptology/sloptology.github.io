/* 8x8 pixel sprites. Characters: a = main colour, d = dark shade, b = accent, s = skin,
   w = white, k = black, e = red eye, '.' = transparent. */
(function () {
  'use strict';

  const ENEMY = {
    skull: [
      '..aaaa..', '.aaaaaa.', '.akaaka.', '.aaaaaa.', '..akka..', '..a..a..', '.aaaaaa.', '..a..a..'],
    spider: [
      'a..aa..a', '.a.aa.a.', '..aaaa..', 'aaaeeaaa', '..aaaa..', '.a.aa.a.', 'a..aa..a', '........'],
    ghost: [
      '..aaaa..', '.aaaaaa.', 'aakaakaa', 'aaaaaaaa', 'aaaaaaaa', 'aaaaaaaa', 'aa.aa.aa', 'a..a..a.'],
    brute: [
      '..aaaa..', '.aaaaaa.', '.akaaka.', 'aaaaaaaa', 'aaaddaaa', 'aaaaaaaa', '.aa..aa.', '.aa..aa.'],
    knight: [
      '..dddd..', '.dddddd.', '.dkkkkd.', 'aaaaaaaa', 'a.aaaa.a', 'a.aaaa.a', '..a..a..', '.dd..dd.'],
    blob: [
      '........', '..aaaa..', '.aaaaaa.', 'aakaakaa', 'aaaaaaaa', 'aaaaaaaa', '.aaaaaa.', '..a..a..'],
    lich: [
      '..dddd..', '.dkddkd.', '.dddddd.', '..aaaa..', '.aaaaaa.', 'a.aaaa.a', '..aaaa..', '.aa..aa.'],
    dragon: [
      'a......a', 'aa.aa.aa', 'aaaaaaaa', 'aakaakaa', '.aaaaaa.', '..aaaa..', '..a..a..', '.aa..aa.'],
    cocoon: [
      '..wwww..', '.wwwwww.', 'wwdwwdww', 'wwwwwwww', 'wwdwwdww', 'wwwwwwww', '.wwwwww.', '..wwww..'],
  };

  const PLAYER = [
    '..bbbb..', '.bbbbbb.', '..ssss..', '..sese..', '.aaaaaa.', 'saaaaaas', '.aaaaaa.', '.aa..aa.'];
  const PLAYER_B = [
    '..bbbb..', '.bbbbbb.', '..ssss..', '..sese..', '.aaaaaa.', 'saaaaaas', '.aaaaaa.', '..aaaa..'];

  // Per-class head rows (rows 0..1) plus optional extra rows.
  const HEAD = {
    warlock:     { 0: 'b......b', 1: '.bbbbbb.' },
    warrior:     { 0: '...bb...', 1: 'bbbbbbbb' },
    druid:       { 0: 'b.b..b.b', 1: '.bbbbbb.' },
    rogue:       { 0: '..aaaa..', 1: '.aaaaaa.' },
    mage:        { 0: '...bb...', 1: '..bbbb..' },
    deathknight: { 0: '..dddd..', 1: '.dddddd.', 2: '..wwww..', 3: '..wkwk..' },
    priest:      { 0: '..bbbb..', 1: '.s....s.' },
    shaman:      { 0: '.b.bb.b.', 1: '.bbbbbb.' },
    paladin:     { 0: '..bbbb..', 1: '.bwwwwb.' },
    hunter:      { 0: '..bbb..b', 1: '.bbbbbb.' },
    monk:        { 0: '...bb...', 1: '..bbbb..', 2: '..ssss..', 3: '..sese..' },
    demonhunter: { 0: 'b.dddd.b', 1: '.dddddd.', 2: '..kkkk..', 3: '..bkbk..' },
  };

  function hexToRgb(h) {
    h = h.replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function rgb(r, g, b) { return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''); }
  function shade(hex, f) { const [r, g, b] = hexToRgb(hex); return rgb(r * f, g * f, b * f); }
  function lift(hex) {
    const [r, g, b] = hexToRgb(hex);
    const lum = (0.3 * r + 0.59 * g + 0.11 * b) / 255;
    if (lum >= 0.32) return hex;
    const k = 0.5;
    return rgb(r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k);
  }

  const cache = new Map();
  function build(rows, pal, flash) {
    const c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    const x = c.getContext('2d');
    for (let y = 0; y < 8; y++) {
      for (let i = 0; i < 8; i++) {
        const ch = rows[y][i];
        if (ch === '.') continue;
        x.fillStyle = flash ? '#ffffff' : (pal[ch] || '#ff00ff');
        x.fillRect(i, y, 1, 1);
      }
    }
    return c;
  }

  function enemySprite(shape, color, flash) {
    const key = 'e|' + shape + color + (flash ? 'F' : '');
    let c = cache.get(key);
    if (!c) {
      const pal = { a: color, d: shade(color, 0.55), w: '#ffffff', k: '#000000', e: '#ff5555', b: color, s: '#ffd0a0' };
      c = build(ENEMY[shape] || ENEMY.skull, pal, flash);
      cache.set(key, c);
    }
    return c;
  }

  function playerRows(cls, frame) {
    const rows = (frame ? PLAYER_B : PLAYER).slice();
    const h = HEAD[cls] || {};
    Object.keys(h).forEach(k => { rows[+k] = h[k]; });
    return rows;
  }

  function playerSprite(cls, color, accent, frame, flash) {
    const key = 'p|' + cls + color + accent + frame + (flash ? 'F' : '');
    let c = cache.get(key);
    if (!c) {
      const a = lift(color), b = lift(accent);
      const pal = { a: a, b: b, d: shade(a, 0.6), s: '#ffd0a0', w: '#ffffff', k: '#000000', e: '#000000' };
      c = build(playerRows(cls, frame), pal, flash);
      cache.set(key, c);
    }
    return c;
  }

  window.NAXX_SPR = { enemySprite, playerSprite, shade, lift, hexToRgb };
})();
