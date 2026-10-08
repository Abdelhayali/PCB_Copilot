'use strict';
// Component library: schematic symbols (grid units, 1 grid = 10) and PCB footprints (mm).
const Lib = (() => {
  const T = {};
  const pin = (num, name, x, y, dx, dy, len = 0, show = false) =>
    ({ num: String(num), name: String(name), x, y, dx, dy, len, show });
  const two = (h, n1 = '1', n2 = '2') => () => [pin(1, n1, -h, 0, -1, 0), pin(2, n2, h, 0, 1, 0)];
  const def = (type, o) => { T[type] = Object.assign({ type }, o); };

  // ---------- passives ----------
  def('resistor', {
    name: 'Resistor', cat: 'Passive', prefix: 'R', value: '10k', fps: ['0805', '1206', 'THT_P10.16'],
    pins: two(30), box: () => [-30, -8, 30, 8],
    draw: () => '<path d="M-30 0H-15M15 0H30"/><rect class="body" x="-15" y="-6" width="30" height="12"/>'
  });
  def('capacitor', {
    name: 'Capacitor', cat: 'Passive', prefix: 'C', value: '100n', fps: ['0805', '1206', 'THT_P5.08'],
    pins: two(20), box: () => [-20, -10, 20, 10],
    draw: () => '<path d="M-20 0H-3M3 0H20"/><path class="thick" d="M-3 -10V10M3 -10V10"/>'
  });
  def('capacitor_polarized', {
    name: 'Electrolytic cap', cat: 'Passive', prefix: 'C', value: '10u', fps: ['THT_P2.54', '1206'],
    pins: two(20, '+', '-'), box: () => [-20, -10, 20, 10],
    draw: () => '<path d="M-20 0H-3M5 0H20M-12 -9V-3M-15 -6H-9"/><path class="thick" d="M-3 -10V10"/><path class="thick" d="M6 -10Q2 0 6 10"/>'
  });
  def('inductor', {
    name: 'Inductor', cat: 'Passive', prefix: 'L', value: '10u', fps: ['1206', '0805', 'THT_P10.16'],
    pins: two(30), box: () => [-30, -8, 30, 4],
    draw: () => '<path d="M-30 0H-20a5 5 0 0 1 10 0a5 5 0 0 1 10 0a5 5 0 0 1 10 0a5 5 0 0 1 10 0H30"/>'
  });
  def('potentiometer', {
    name: 'Potentiometer', cat: 'Passive', prefix: 'RV', value: '10k', fps: ['Pot_THT'],
    pins: () => [pin(1, '1', -30, 0, -1, 0), pin(2, 'W', 0, -30, 0, -1), pin(3, '3', 30, 0, 1, 0)],
    box: () => [-30, -30, 30, 8],
    draw: () => '<path d="M-30 0H-15M15 0H30M0 -30V-11"/><rect class="body" x="-15" y="-6" width="30" height="12"/><path class="fill" d="M0 -6L-3 -11H3Z"/>'
  });
  def('fuse', {
    name: 'Fuse', cat: 'Passive', prefix: 'F', value: '500mA', fps: ['1206', 'THT_P10.16'],
    pins: two(30), box: () => [-30, -6, 30, 6],
    draw: () => '<rect class="body" x="-15" y="-5" width="30" height="10"/><path d="M-30 0H30"/>'
  });
  def('crystal', {
    name: 'Crystal', cat: 'Passive', prefix: 'Y', value: '16MHz', fps: ['THT_P5.08'],
    pins: two(30), box: () => [-30, -12, 30, 12],
    draw: () => '<path d="M-30 0H-10M10 0H30"/><path class="thick" d="M-10 -10V10M10 -10V10"/><rect class="body" x="-6" y="-12" width="12" height="24"/>'
  });

  // ---------- semiconductors ----------
  const diodeBase = '<path d="M-20 0H-7M7 0H20"/><path class="fill" d="M-7 -8L7 0L-7 8Z"/>';
  const diodePins = () => [pin(1, 'K', 20, 0, 1, 0), pin(2, 'A', -20, 0, -1, 0)];
  def('diode', {
    name: 'Diode', cat: 'Semiconductor', prefix: 'D', value: '1N4148', fps: ['SOD123', 'THT_P7.62'],
    pins: diodePins, box: () => [-20, -9, 20, 9], draw: () => diodeBase + '<path class="thick" d="M7 -8V8"/>'
  });
  def('schottky', {
    name: 'Schottky diode', cat: 'Semiconductor', prefix: 'D', value: 'SS14', fps: ['SOD123', 'THT_P7.62'],
    pins: diodePins, box: () => [-20, -9, 20, 9], draw: () => diodeBase + '<path class="thick" d="M4 -5V-8H7V8H10V5"/>'
  });
  def('zener', {
    name: 'Zener diode', cat: 'Semiconductor', prefix: 'D', value: '5V1', fps: ['SOD123', 'THT_P7.62'],
    pins: diodePins, box: () => [-20, -9, 20, 9], draw: () => diodeBase + '<path class="thick" d="M4 -8H7V8H10"/>'
  });
  def('led', {
    name: 'LED', cat: 'Semiconductor', prefix: 'D', value: 'Red', fps: ['0805', 'THT_P2.54'],
    pins: diodePins, box: () => [-20, -17, 20, 9],
    draw: () => diodeBase + '<path class="thick" d="M7 -8V8"/><path d="M-1 -10L5 -16M2 -16H5V-13M6 -8L12 -14M9 -14H12V-11"/>'
  });
  const bjt = (pnp) => '<circle class="body" cx="3" cy="0" r="16"/><path d="M-30 0H-5M-5 -4L10 -14V-30M-5 4L10 14V30"/><path class="thick" d="M-5 -10V10"/>' +
    (pnp ? '<path class="fill" d="M-0.5 7L2.35 12.5L5.65 7.5Z"/>' : '<path class="fill" d="M9.25 13.5L2.35 12.5L5.65 7.5Z"/>');
  const bjtPins = () => [pin(1, 'B', -30, 0, -1, 0), pin(2, 'E', 10, 30, 0, 1), pin(3, 'C', 10, -30, 0, -1)];
  def('npn', { name: 'NPN transistor', cat: 'Semiconductor', prefix: 'Q', value: 'MMBT3904', fps: ['SOT23', 'TO92'], pins: bjtPins, box: () => [-30, -30, 19, 30], draw: () => bjt(false) });
  def('pnp', { name: 'PNP transistor', cat: 'Semiconductor', prefix: 'Q', value: 'MMBT3906', fps: ['SOT23', 'TO92'], pins: bjtPins, box: () => [-30, -30, 19, 30], draw: () => bjt(true) });
  const fet = (p) => '<circle class="body" cx="3" cy="0" r="16"/><path d="M-30 0H-8M-3 -9H10V-30M-3 9H10V30M-3 0H10V9"/><path class="thick" d="M-8 -10V10M-3 -12V-6M-3 -3V3M-3 6V12"/>' +
    (p ? '<path class="fill" d="M9 0L4 -3V3Z"/>' : '<path class="fill" d="M-2 0L3 -3V3Z"/>');
  const fetPins = () => [pin(1, 'G', -30, 0, -1, 0), pin(2, 'S', 10, 30, 0, 1), pin(3, 'D', 10, -30, 0, -1)];
  def('nmos', { name: 'N-MOSFET', cat: 'Semiconductor', prefix: 'Q', value: '2N7002', fps: ['SOT23', 'TO220'], pins: fetPins, box: () => [-30, -30, 19, 30], draw: () => fet(false) });
  def('pmos', { name: 'P-MOSFET', cat: 'Semiconductor', prefix: 'Q', value: 'AO3401', fps: ['SOT23', 'TO220'], pins: fetPins, box: () => [-30, -30, 19, 30], draw: () => fet(true) });

  // ---------- ICs ----------
  def('opamp', {
    name: 'Op-amp', cat: 'IC', prefix: 'U', value: 'TL071', fps: ['SOIC-8', 'DIP-8'],
    pins: () => [pin(2, 'IN-', -40, -10, -1, 0), pin(3, 'IN+', -40, 10, -1, 0), pin(6, 'OUT', 40, 0, 1, 0), pin(7, 'V+', 0, -30, 0, -1), pin(4, 'V-', 0, 30, 0, 1)],
    box: () => [-40, -30, 40, 30],
    draw: () => '<path class="body" d="M-25 -25V25L25 0Z"/><path d="M-40 -10H-25M-40 10H-25M25 0H40M0 -12.5V-30M0 12.5V30M-21 -10H-15M-21 10H-15M-18 7V13"/>'
  });
  def('regulator', {
    name: 'Voltage regulator', cat: 'IC', prefix: 'U', value: 'LM7805', fps: ['TO220', 'TO92', 'SOT23'],
    pins: () => [pin(1, 'IN', -40, 0, -1, 0, 10, true), pin(2, 'GND', 0, 25, 0, 1, 10, true), pin(3, 'OUT', 40, 0, 1, 0, 10, true)],
    box: () => [-40, -15, 40, 25],
    draw: () => '<rect class="body" x="-30" y="-15" width="60" height="30"/><path d="M-40 0H-30M30 0H40M0 15V25"/>'
  });
  function icNames(c) { return (c.pins && c.pins.length) ? c.pins.map(String) : ['1', '2', '3', '4', '5', '6', '7', '8']; }
  function icGeo(c) {
    const names = icNames(c), n = names.length, L = Math.ceil(n / 2), R = n - L, rows = Math.max(L, 1);
    const ml = Math.max(1, ...names.map(s => s.length));
    const hw = Math.max(30, Math.ceil((ml * 5.5 + 10) / 10) * 10), hh = rows * 10;
    const pins = [];
    for (let i = 0; i < L; i++) pins.push(pin(i + 1, names[i], -hw - 20, -(rows - 1) * 10 + i * 20, -1, 0, 20, true));
    for (let j = 0; j < R; j++) pins.push(pin(L + j + 1, names[L + j], hw + 20, (rows - 1) * 10 - j * 20, 1, 0, 20, true));
    return { n, hw, hh, pins };
  }
  const evenUp = n => n + (n % 2);
  def('ic', {
    name: 'Generic IC', cat: 'IC', prefix: 'U', value: 'IC', generic: true,
    fps: c => { const n = Math.max(4, evenUp(icNames(c).length)); return ['SOIC-' + n, 'DIP-' + n]; },
    pins: c => icGeo(c).pins,
    box: c => { const g = icGeo(c); return [-g.hw - 20, -g.hh, g.hw + 20, g.hh]; },
    draw: c => {
      const g = icGeo(c);
      return `<rect class="body" x="${-g.hw}" y="${-g.hh}" width="${2 * g.hw}" height="${2 * g.hh}"/><circle cx="${-g.hw + 5}" cy="${-g.hh + 5}" r="1.5" class="fill"/>` +
        '<path d="' + g.pins.map(p => `M${p.x} ${p.y}H${p.x - p.dx * p.len}`).join('') + '"/>';
    }
  });
  function connGeo(c) {
    const names = (c.pins && c.pins.length) ? c.pins.map(String) : ['1', '2'];
    const n = names.length, ml = Math.max(1, ...names.map(s => s.length));
    const w = Math.max(20, Math.ceil((ml * 5.5 + 10) / 10) * 10), hh = n * 10;
    return { n, w, hh, pins: names.map((nm, i) => pin(i + 1, nm, -30, -(n - 1) * 10 + i * 20, -1, 0, 20, true)) };
  }
  def('connector', {
    name: 'Connector / header', cat: 'Electromech', prefix: 'J', value: 'Conn', generic: true,
    fps: c => ['PinHeader_1x' + connGeo(c).n],
    pins: c => connGeo(c).pins,
    box: c => { const g = connGeo(c); return [-30, -g.hh, -10 + g.w, g.hh]; },
    draw: c => {
      const g = connGeo(c);
      return `<rect class="body" x="-10" y="${-g.hh}" width="${g.w}" height="${2 * g.hh}"/><path d="` + g.pins.map(p => `M-30 ${p.y}H-10`).join('') + '"/>';
    }
  });
  def('switch', {
    name: 'Push button', cat: 'Electromech', prefix: 'SW', value: 'SW_Push', fps: ['THT_P5.08'],
    pins: two(30), box: () => [-30, -14, 30, 4],
    draw: () => '<path d="M-30 0H-12M12 0H30M-14 -7H14M0 -7V-14M-6 -14H6"/><circle cx="-10" cy="0" r="2"/><circle cx="10" cy="0" r="2"/>'
  });
  def('battery', {
    name: 'Battery', cat: 'Electromech', prefix: 'BT', value: '9V', fps: ['PinHeader_1x2'],
    pins: () => [pin(1, '+', 0, -30, 0, -1), pin(2, '-', 0, 30, 0, 1)], box: () => [-12, -30, 14, 30],
    draw: () => '<path d="M0 -30V-4M0 4V30M8 -14H14M11 -17V-11"/><path class="thick" d="M-12 -4H12"/><path class="thick" d="M-6 4H6" style="stroke-width:3"/>'
  });
  def('buzzer', {
    name: 'Buzzer', cat: 'Electromech', prefix: 'BZ', value: 'Buzzer', fps: ['THT_P7.62'],
    pins: two(30, '+', '-'), box: () => [-30, -14, 30, 14],
    draw: () => '<path d="M-30 0H-14M14 0H30M-22 -8V-2M-25 -5H-19"/><circle class="body" cx="0" cy="0" r="14"/><path d="M-6 -6V6M0 -9V9M6 -6V6"/>'
  });

  // ---------- database parts (JLCPCB/LCSC + EasyEDA), definitions live in the design's lib ----------
  const partDef = c => (typeof Model !== 'undefined' && Model.S.lib && Model.S.lib[c.lcsc]) || null;
  function partGeo(c) {
    const d = partDef(c), all = d ? d.pins : [];
    let L = all.filter(p => p.side === 'L' || p.side === 'T'), R = all.filter(p => p.side === 'R' || p.side === 'B');
    if (all.length > 3 && (!L.length || !R.length)) { const s = L.length ? L : R, h = Math.ceil(s.length / 2); L = s.slice(0, h); R = s.slice(h); }
    const rows = Math.max(L.length, R.length, 1), ml = Math.max(1, ...all.map(p => String(p.name).length));
    const hw = all.length <= 2 ? 20 : Math.max(30, Math.ceil((ml * 5.5 + 10) / 10) * 10), hh = all.length <= 2 ? 10 : rows * 10;
    const pins = [];
    L.forEach((p, i) => pins.push(pin(p.num, p.name, -hw - 20, -(rows - 1) * 10 + i * 20, -1, 0, 20, all.length > 2)));
    R.forEach((p, i) => pins.push(pin(p.num, p.name, hw + 20, -(rows - 1) * 10 + i * 20, 1, 0, 20, all.length > 2)));
    return { hw, hh, pins };
  }
  def('part', {
    name: 'Database part', cat: 'Database', prefix: 'U', value: '', generic: false, hidden: true,
    fps: c => ['LCSC:' + c.lcsc],
    pins: c => partGeo(c).pins,
    box: c => { const g = partGeo(c); return [-g.hw - 20, -g.hh, g.hw + 20, g.hh]; },
    draw: c => {
      const g = partGeo(c);
      return `<rect class="body" x="${-g.hw}" y="${-g.hh}" width="${2 * g.hw}" height="${2 * g.hh}" rx="2"/>` +
        '<path d="' + g.pins.map(p => `M${p.x} ${p.y}H${p.x - p.dx * p.len}`).join('') + '"/>';
    }
  });

  // ---------- footprints (mm, centered) ----------
  const smd2 = (d, w, h) => [{ num: '1', x: -d, y: 0, w, h, shape: 'rect' }, { num: '2', x: d, y: 0, w, h, shape: 'rect' }];
  const tht = (num, x, y, s, drill) => ({ num: String(num), x, y, w: s, h: s, shape: String(num) === '1' ? 'rect' : 'round', drill });
  const tht2 = (d, s = 1.6, dr = 0.8) => [tht(1, -d, 0, s, dr), tht(2, d, 0, s, dr)];
  const inline3 = (s, dr) => [tht(1, -2.54, 0, s, dr), tht(2, 0, 0, s, dr), tht(3, 2.54, 0, s, dr)];
  const cache = {};
  function footprint(name) {
    if (cache[name]) return cache[name];
    let pads = null, m;
    if ((m = /^LCSC:(C\d+)$/.exec(name))) {
      const d = typeof Model !== 'undefined' && Model.S.lib && Model.S.lib[m[1]];
      if (!d || !d.footprint) return null;
      const f = d.footprint, b = f.body;
      return (cache[name] = { name, pads: f.pads, box: [b[0] - 0.3, b[1] - 0.3, b[2] + 0.3, b[3] + 0.3], body: null, lcsc: m[1] });
    }
    switch (name) {
      case '0805': pads = smd2(0.95, 1.0, 1.3); break;
      case '1206': pads = smd2(1.5, 1.15, 1.8); break;
      case 'SOD123': pads = smd2(1.65, 0.9, 1.2); break;
      case 'THT_P2.54': pads = tht2(1.27); break;
      case 'THT_P5.08': pads = tht2(2.54); break;
      case 'THT_P7.62': pads = tht2(3.81); break;
      case 'THT_P10.16': pads = tht2(5.08); break;
      case 'SOT23': pads = [{ num: '1', x: -0.95, y: 1.0, w: 0.8, h: 0.9, shape: 'rect' }, { num: '2', x: 0.95, y: 1.0, w: 0.8, h: 0.9, shape: 'rect' }, { num: '3', x: 0, y: -1.0, w: 0.8, h: 0.9, shape: 'rect' }]; break;
      case 'TO92': pads = inline3(1.5, 0.8); break;
      case 'TO220': pads = inline3(1.9, 1.1); break;
      case 'Pot_THT': pads = inline3(1.7, 1.0); break;
    }
    if (!pads && (m = /^DIP-(\d+)$/.exec(name))) {
      const n = +m[1], r = n / 2; pads = [];
      for (let i = 0; i < r; i++) pads.push(tht(i + 1, -3.81, -(r - 1) * 1.27 + i * 2.54, 1.6, 0.8));
      for (let j = 0; j < r; j++) pads.push(tht(r + j + 1, 3.81, (r - 1) * 1.27 - j * 2.54, 1.6, 0.8));
    }
    if (!pads && (m = /^SOIC-(\d+)$/.exec(name))) {
      const n = +m[1], r = n / 2; pads = [];
      for (let i = 0; i < r; i++) pads.push({ num: String(i + 1), x: -2.7, y: -(r - 1) * 0.635 + i * 1.27, w: 1.55, h: 0.6, shape: 'rect' });
      for (let j = 0; j < r; j++) pads.push({ num: String(r + j + 1), x: 2.7, y: (r - 1) * 0.635 - j * 1.27, w: 1.55, h: 0.6, shape: 'rect' });
    }
    if (!pads && (m = /^PinHeader_1x(\d+)$/.exec(name))) {
      const n = +m[1]; pads = [];
      for (let i = 0; i < n; i++) pads.push(tht(i + 1, 0, -(n - 1) * 1.27 + i * 2.54, 1.7, 1.0));
    }
    if (!pads) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pads) { x0 = Math.min(x0, p.x - p.w / 2); x1 = Math.max(x1, p.x + p.w / 2); y0 = Math.min(y0, p.y - p.h / 2); y1 = Math.max(y1, p.y + p.h / 2); }
    const body = name.startsWith('SOIC') ? [-1.95, y0 - 0.3, 1.95, y1 + 0.3] : name.startsWith('DIP') ? [-2.8, y0 - 0.6, 2.8, y1 + 0.6] : null;
    const fp = { name, pads, box: [Math.min(x0, body ? body[0] : x0) - 0.4, Math.min(y0, body ? body[1] : y0) - 0.4, Math.max(x1, body ? body[2] : x1) + 0.4, Math.max(y1, body ? body[3] : y1) + 0.4], body };
    return (cache[name] = fp);
  }
  const FOOTPRINT_PATTERNS = ['0805', '1206', 'SOD123', 'SOT23', 'TO92', 'TO220', 'Pot_THT', 'THT_P2.54', 'THT_P5.08', 'THT_P7.62', 'THT_P10.16', 'DIP-<n>', 'SOIC-<n>', 'PinHeader_1x<n>'];

  const type = t => T[t];
  const fpsFor = c => { const d = T[c.type]; return typeof d.fps === 'function' ? d.fps(c) : d.fps; };
  function rot(x, y, r) {
    switch (((r % 360) + 360) % 360) { case 90: return [-y, x]; case 180: return [-x, -y]; case 270: return [y, -x]; default: return [x, y]; }
  }
  function rotBox(b, r) {
    const a = rot(b[0], b[1], r), c = rot(b[2], b[3], r);
    return [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[0], c[0]), Math.max(a[1], c[1])];
  }
  return { T, type, types: () => Object.keys(T).filter(t => !T[t].hidden), footprint, fpsFor, rot, rotBox, FOOTPRINT_PATTERNS };
})();
