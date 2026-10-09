'use strict';
// Design state, connectivity, undo/redo, ERC and schematic auto-layout.
const Model = (() => {
  const blank = () => ({ name: 'Untitled', components: [], nets: {}, board: { w: 0, h: 0 }, pcb: { traces: [], vias: [], routed: {} }, connStyle: 'auto', lib: {} });
  let S = blank();
  const undoStack = [], redoStack = [], subs = [];
  let netCounter = 1;

  const isGround = n => /^(GND|AGND|DGND|PGND|GNDA|GNDD|VSS|0V)$/i.test(n);
  const isPower = n => isGround(n) || /^[+-]?\d+(\.\d+)?V\d*$/i.test(n) || /^\+/.test(n) ||
    /^(VCC|VDD|VEE|VBAT|VBUS|VIN|VSYS|VMOT|VREF|AVCC|AVDD|DVDD|V\+|V-|3V3|5V)$/i.test(n);

  function emit(kind) {
    try { localStorage.setItem('cp.design', JSON.stringify(S)); } catch (e) { }
    subs.forEach(f => f(kind));
  }
  function snapshot() { return JSON.stringify(S); }
  function begin() {
    undoStack.push(snapshot()); if (undoStack.length > 200) undoStack.shift(); redoStack.length = 0;
  }
  function mutate(fn, kind = 'change') {
    const before = snapshot();
    try { const r = fn(); undoStack.push(before); if (undoStack.length > 200) undoStack.shift(); redoStack.length = 0; emit(kind); return r; }
    catch (e) { S = JSON.parse(before); throw e; }
  }
  function load(obj, keepHistory) {
    if (keepHistory) begin(); else { undoStack.length = 0; redoStack.length = 0; }
    S = Object.assign(blank(), typeof obj === 'string' ? JSON.parse(obj) : JSON.parse(JSON.stringify(obj)));
    emit('load');
  }
  function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); S = JSON.parse(undoStack.pop()); emit('load'); }
  function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); S = JSON.parse(redoStack.pop()); emit('load'); }

  // ---------- components & pins ----------
  const comp = ref => S.components.find(c => c.ref === ref) || S.components.find(c => c.ref.toLowerCase() === String(ref).toLowerCase());
  function pinsWorld(c) {
    const d = Lib.type(c.type); if (!d) return [];
    return d.pins(c).map(p => {
      const [rx, ry] = Lib.rot(p.x, p.y, c.rot || 0), [dx, dy] = Lib.rot(p.dx, p.dy, c.rot || 0);
      return { key: c.ref + '.' + p.num, ref: c.ref, num: p.num, name: p.name, x: c.x + rx, y: c.y + ry, dx: Math.round(dx), dy: Math.round(dy), len: p.len, show: p.show, ax: c.x + rx - dx * p.len, ay: c.y + ry - dy * p.len };
    });
  }
  function bbox(c, pad = 0) {
    const b = Lib.rotBox(Lib.type(c.type).box(c), c.rot || 0);
    return [c.x + b[0] - pad, c.y + b[1] - pad, c.x + b[2] + pad, c.y + b[3] + pad];
  }
  function pinIndex() {
    const idx = {};
    for (const [n, keys] of Object.entries(S.nets)) for (const k of keys) idx[k] = n;
    return idx;
  }
  const netOf = key => pinIndex()[key];
  function nextRef(prefix) {
    let max = 0; const re = new RegExp('^' + prefix + '(\\d+)$');
    for (const c of S.components) { const m = re.exec(c.ref); if (m) max = Math.max(max, +m[1]); }
    return prefix + (max + 1);
  }
  function resolvePins(str) {
    const s = String(str).trim(), i = s.indexOf('.');
    if (i < 0) throw new Error(`Bad pin reference "${s}" — use REF.PIN, e.g. R1.1 or U1.VCC`);
    const c = comp(s.slice(0, i)); if (!c) throw new Error(`No component "${s.slice(0, i)}"`);
    const want = s.slice(i + 1), pins = Lib.type(c.type).pins(c);
    let hit = pins.filter(p => p.num === want);
    if (!hit.length) hit = pins.filter(p => p.name === want);
    if (!hit.length) hit = pins.filter(p => p.name.toLowerCase() === want.toLowerCase().replace(/^[~/]/, ''));
    if (!hit.length) throw new Error(`${c.ref} has no pin "${want}". Pins: ${pins.map(p => p.num + ':' + p.name).join(', ')}`);
    return hit.map(p => c.ref + '.' + p.num);
  }
  function overlaps(c, others) {
    const b = bbox(c, 10);
    return others.some(o => { if (o === c) return false; const a = bbox(o, 10); return !(b[2] < a[0] || b[0] > a[2] || b[3] < a[1] || b[1] > a[3]); });
  }
  function nudgeFree(c) {
    if (!overlaps(c, S.components)) return;
    const x0 = c.x, y0 = c.y;
    for (let r = 1; r < 60; r++) for (let k = 0; k < 8 * r; k++) {
      const a = (k / (8 * r)) * Math.PI * 2;
      c.x = x0 + Math.round(Math.cos(a) * r * 2) * 10; c.y = y0 + Math.round(Math.sin(a) * r * 2) * 10;
      if (!overlaps(c, S.components)) return;
    }
    c.x = x0; c.y = y0;
  }
  function addComponent(spec) {
    let lp = null;
    if (spec.lcsc || spec.part) {
      const raw = String(spec.part || spec.lcsc).trim(), code = S.lib[raw] ? raw : raw.toUpperCase();
      lp = S.lib[code];
      if (!lp) throw new Error(`Part ${code} is not loaded — call get_part (database) or create_part first`);
      spec = Object.assign({}, spec, { type: 'part', lcsc: code, footprint: fpNameFor(code) });
    }
    const d = Lib.type(spec.type);
    if (!d) throw new Error(`Unknown type "${spec.type}". Types: ${Lib.types().join(', ')}`);
    const prefix = lp ? (lp.prefix || 'U').replace(/[^A-Z]/gi, '') || 'U' : d.prefix;
    let ref = spec.ref || nextRef(prefix);
    if (comp(ref)) { if (spec.ref) throw new Error(`Ref ${ref} already exists`); ref = nextRef(prefix); }
    const c = { ref, type: spec.type, value: spec.value != null ? String(spec.value) : (lp ? lp.value || lp.name : d.value), x: 0, y: 0, rot: [0, 90, 180, 270].includes(+spec.rot) ? +spec.rot : 0 };
    if (lp) c.lcsc = lp.lcsc;
    if (d.generic && Array.isArray(spec.pins) && spec.pins.length) c.pins = spec.pins.map(String);
    if (d.generic && !c.pins && typeof spec.pins === 'number') c.pins = Array.from({ length: spec.pins }, (_, i) => String(i + 1));
    const fps = Lib.fpsFor(c);
    c.footprint = spec.footprint && Lib.footprint(spec.footprint) ? spec.footprint : fps[0];
    if (spec.dbPart && !d.generic && !spec.footprint && attachDb(c, spec.dbPart) && spec.value == null) {
      const dd = Lib.DB_DEFAULTS[c.type]; if (dd && !dd.byValue) c.value = dd.value;   // e.g. regulator → AMS1117-3.3 (the part actually used)
    }
    if (spec.x != null && spec.y != null) { c.x = Math.round(+spec.x / 10) * 10; c.y = Math.round(+spec.y / 10) * 10; }
    else {
      let maxX = -Infinity; for (const o of S.components) maxX = Math.max(maxX, bbox(o)[2]);
      c.x = S.components.length ? Math.ceil((maxX + 70) / 10) * 10 : 0; c.y = 0;
    }
    S.components.push(c); nudgeFree(c);
    return c;
  }
  function invalidate(nets) {
    const set = new Set(nets);
    for (const n of set) delete S.pcb.routed[n];
    S.pcb.traces = S.pcb.traces.filter(t => !set.has(t.net));
    S.pcb.vias = S.pcb.vias.filter(v => !set.has(v.net));
  }
  function removeComponent(ref) {
    const c = comp(ref); if (!c) throw new Error(`No component "${ref}"`);
    const touched = [];
    for (const [n, keys] of Object.entries(S.nets)) {
      const k2 = keys.filter(k => !k.startsWith(c.ref + '.'));
      if (k2.length !== keys.length) { touched.push(n); if (k2.length) S.nets[n] = k2; else delete S.nets[n]; }
    }
    invalidate(touched);
    S.components = S.components.filter(o => o !== c);
  }
  function updateComponent(u) {
    const c = comp(u.ref); if (!c) throw new Error(`No component "${u.ref}"`);
    const d = Lib.type(c.type);
    if (u.value != null) c.value = String(u.value);
    if (u.x != null) c.x = Math.round(+u.x / 10) * 10;
    if (u.y != null) c.y = Math.round(+u.y / 10) * 10;
    if (u.rot != null) c.rot = ((Math.round(+u.rot / 90) * 90) % 360 + 360) % 360;
    if (d.generic && Array.isArray(u.pins)) {
      c.pins = u.pins.map(String); const n = c.pins.length;
      for (const [nn, keys] of Object.entries(S.nets)) {
        S.nets[nn] = keys.filter(k => !(k.startsWith(c.ref + '.') && +k.slice(c.ref.length + 1) > n));
        if (!S.nets[nn].length) delete S.nets[nn];
      }
      if (!Lib.fpsFor(c).includes(c.footprint)) c.footprint = Lib.fpsFor(c)[0];
    }
    if (u.footprint != null) {
      if (!Lib.footprint(u.footprint)) throw new Error(`Unknown footprint "${u.footprint}". Known: ${Lib.FOOTPRINT_PATTERNS.join(', ')}`);
      if (c.type !== 'part' && c.pinMap && !/^(LCSC|LIB):/.test(u.footprint)) detachDb(c, u.footprint);
      else if (c.type !== 'part' && c.dbfp && u.footprint === 'LCSC:' + c.dbfp && !c.pinMap && S.lib[c.dbfp]) attachDb(c, S.lib[c.dbfp]);
      else c.footprint = u.footprint;
      invalidate(netsOfComp(c.ref));
    }
    if (u.new_ref && u.new_ref !== c.ref) {
      if (comp(u.new_ref)) throw new Error(`Ref ${u.new_ref} already exists`);
      const old = c.ref + '.';
      for (const n in S.nets) S.nets[n] = S.nets[n].map(k => k.startsWith(old) ? u.new_ref + '.' + k.slice(old.length) : k);
      c.ref = u.new_ref;
    }
    return c;
  }
  // Use a real database part's footprint for a built-in symbol (pins matched by name). Returns false if it does not fit.
  function attachDb(c, part) {
    const key = part.key || part.lcsc, d0 = Lib.DB_DEFAULTS[c.type] || {};
    const m = Lib.matchPins(c.type, part.pins || [], d0.lcsc === key || (d0.byValue && Object.values(d0.byValue).includes(key)) ? d0.map : null);
    if (!m || !part.footprint) return false;
    const old = c.pinMap || null;
    if (!S.lib[key]) S.lib[key] = Object.assign({}, part, { key });
    Lib.clearCache && Lib.clearCache('LCSC:' + key);
    renumber(c, old, m.map);
    c.pinMap = m.map; if (Object.keys(m.alias).length) c.pinAlias = m.alias; else delete c.pinAlias;
    c.dbfp = key; c.footprint = 'LCSC:' + key; c.lcscPart = key;
    invalidate(netsOfComp(c.ref));
    return true;
  }
  function detachDb(c, footprint) {
    const old = c.pinMap || null; renumber(c, old, null);
    delete c.pinMap; delete c.pinAlias; delete c.lcscPart; c.footprint = footprint;
  }
  // move net entries from one pin numbering to another (symbol pin → old pad number → new pad number)
  function renumber(c, oldMap, newMap) {
    const sym = Lib.type(c.type).pins(Object.assign({}, c, { pinMap: null })).map(p => p.num);
    const from = n => (oldMap && oldMap[n]) || n, to = n => (newMap && newMap[n]) || n, ren = {};
    for (const n of sym) if (from(n) !== to(n)) ren[c.ref + '.' + from(n)] = c.ref + '.' + to(n);
    if (!Object.keys(ren).length) return;
    for (const net in S.nets) S.nets[net] = S.nets[net].map(k => ren[k] || k);
  }
  const fpNameFor = key => (/^C\d+$/.test(key) ? 'LCSC:' : 'LIB:') + key;
  // Add or replace a library part definition; every placed instance follows the new definition.
  function setLibPart(key, def) {
    S.lib[key] = Object.assign({}, def, { key });
    Lib.clearCache(fpNameFor(key));
    const users = S.components.filter(c => c.type === 'part' && c.lcsc === key), touched = [];
    for (const c of users) {
      const nums = new Set((def.pins || []).map(p => String(p.num)));
      for (const [n, keys] of Object.entries(S.nets)) {
        const k2 = keys.filter(k => !(k.startsWith(c.ref + '.') && !nums.has(k.slice(c.ref.length + 1))));
        if (k2.length !== keys.length || keys.some(k => k.startsWith(c.ref + '.'))) touched.push(n);
        if (k2.length) S.nets[n] = k2; else delete S.nets[n];
      }
      c.footprint = fpNameFor(key);
    }
    invalidate(touched);
    return users.length;
  }
  const netsOfComp = ref => Object.keys(S.nets).filter(n => S.nets[n].some(k => k.startsWith(ref + '.')));
  function autoNetName() { while (S.nets['N$' + netCounter]) netCounter++; return 'N$' + netCounter++; }

  function connect(net, pinRefs) {
    const keys = [...new Set(pinRefs.flatMap(resolvePins))];
    const idx = pinIndex();
    if (!net) net = keys.map(k => idx[k]).find(Boolean) || autoNetName();
    net = String(net).trim();
    if (!S.nets[net]) S.nets[net] = [];
    const touched = [net];
    for (const k of keys) {
      const cur = idx[k];
      if (cur && cur !== net) { // merge whole net
        if (!S.nets[cur]) continue;
        S.nets[net].push(...S.nets[cur]); delete S.nets[cur]; touched.push(cur);
      } else if (!cur) S.nets[net].push(k);
    }
    S.nets[net] = [...new Set(S.nets[net])];
    invalidate(touched);
    return net;
  }
  function disconnect(pinRefs) {
    const keys = new Set(pinRefs.flatMap(resolvePins)), touched = [];
    for (const [n, ks] of Object.entries(S.nets)) {
      const k2 = ks.filter(k => !keys.has(k));
      if (k2.length !== ks.length) { touched.push(n); if (k2.length) S.nets[n] = k2; else delete S.nets[n]; }
    }
    invalidate(touched);
  }
  function renameNet(from, to) {
    if (!S.nets[from]) throw new Error(`No net "${from}"`);
    to = String(to).trim(); if (!to || to === from) return;
    S.nets[to] = [...new Set([...(S.nets[to] || []), ...S.nets[from]])]; delete S.nets[from];
    invalidate([from, to]);
  }
  function removeNet(n) { delete S.nets[n]; invalidate([n]); }
  function clear() { const name = S.name, id = S.id; S = blank(); S.name = name; if (id) S.id = id; }

  // ---------- ERC ----------
  function erc() {
    const issues = [], idx = pinIndex();
    for (const c of S.components) {
      if (!c.value) issues.push({ level: 'warn', msg: `${c.ref} has no value` });
      for (const p of pinsWorld(c)) if (!idx[p.key] && !/^(NC|N\.C\.|DNC)$/i.test(p.name))
        issues.push({ level: 'warn', msg: `${p.key} (${p.name}) is unconnected` });
    }
    for (const [n, keys] of Object.entries(S.nets)) if (keys.length < 2 && !isPower(n)) issues.push({ level: 'error', msg: `Net ${n} has only one pin (${keys[0]})` });
    if (S.components.length && !Object.keys(S.nets).some(isGround)) issues.push({ level: 'warn', msg: 'No ground net (GND) in the design' });
    for (let i = 0; i < S.components.length; i++) for (let j = i + 1; j < S.components.length; j++) {
      const a = bbox(S.components[i], -2), b = bbox(S.components[j], -2);
      if (!(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3])) issues.push({ level: 'info', msg: `${S.components[i].ref} overlaps ${S.components[j].ref} on the schematic` });
    }
    return issues;
  }

  // ---------- schematic auto layout (force-directed + legalize) ----------
  function autoLayout() {
    const cs = S.components, n = cs.length; if (!n) return;
    const id = new Map(cs.map((c, i) => [c.ref, i]));
    const edges = [];
    for (const [net, keys] of Object.entries(S.nets)) {
      if (isPower(net)) continue;
      const refs = [...new Set(keys.map(k => k.split('.')[0]))].map(r => id.get(r)).filter(v => v != null);
      const w = 1 / Math.max(1, refs.length - 1);
      for (let a = 0; a < refs.length; a++) for (let b = a + 1; b < refs.length; b++) edges.push([refs[a], refs[b], w]);
    }
    const cols = Math.ceil(Math.sqrt(n));
    const P = cs.map((c, i) => ({ x: (i % cols) * 160, y: Math.floor(i / cols) * 160, vx: 0, vy: 0 }));
    const K = 150;
    for (let it = 0; it < 500; it++) {
      const t = 30 * (1 - it / 500) + 1;
      for (const p of P) { p.vx = 0; p.vy = 0; }
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        let dx = P[i].x - P[j].x, dy = P[i].y - P[j].y, d = Math.hypot(dx, dy) || 0.1;
        const f = K * K / d / d; P[i].vx += dx * f; P[i].vy += dy * f; P[j].vx -= dx * f; P[j].vy -= dy * f;
      }
      for (const [a, b, w] of edges) {
        const dx = P[a].x - P[b].x, dy = P[a].y - P[b].y, d = Math.hypot(dx, dy) || 0.1, f = d / K * w;
        P[a].vx -= dx * f; P[a].vy -= dy * f; P[b].vx += dx * f; P[b].vy += dy * f;
      }
      for (const p of P) { const v = Math.hypot(p.vx, p.vy) || 1, s = Math.min(v, t) / v; p.x += p.vx * s; p.y += p.vy * s; }
    }
    // left-to-right order hint: connectors/batteries first
    const order = cs.map((c, i) => i).sort((a, b) => P[a].x - P[b].x);
    const placed = [];
    for (const i of order) {
      const c = cs[i]; c.x = Math.round(P[i].x / 10) * 10; c.y = Math.round(P[i].y / 10) * 10;
      const x0 = c.x, y0 = c.y; let ok = !overlaps(c, placed);
      for (let r = 1; !ok && r < 80; r++) for (let k = 0; k < 8 * r && !ok; k++) {
        const a = (k / (8 * r)) * Math.PI * 2;
        c.x = x0 + Math.round(Math.cos(a) * r * 2) * 10; c.y = y0 + Math.round(Math.sin(a) * r * 2) * 10;
        ok = !overlaps(c, placed);
      }
      placed.push(c);
    }
    let mx = 0, my = 0; for (const c of cs) { mx += c.x; my += c.y; }
    mx = Math.round(mx / n / 10) * 10; my = Math.round(my / n / 10) * 10;
    for (const c of cs) { c.x -= mx; c.y -= my; }
  }

  function summary() {
    const idx = pinIndex();
    return {
      components: S.components.map(c => ({
        ref: c.ref, type: c.type, ...(c.lcsc ? { lcsc: c.lcsc } : {}), value: c.value, x: c.x, y: c.y, rot: c.rot || 0, footprint: c.footprint,
        pins: Lib.type(c.type).pins(c).map(p => `${p.num}:${p.name}${idx[c.ref + '.' + p.num] ? '=' + idx[c.ref + '.' + p.num] : ''}`).join(' ')
      })),
      nets: S.nets
    };
  }

  return {
    get S() { return S; }, blank, subscribe: f => subs.push(f), emit, begin, mutate, load, undo, redo, snapshot,
    canUndo: () => undoStack.length > 0, canRedo: () => redoStack.length > 0,
    comp, pinsWorld, bbox, pinIndex, netOf, resolvePins, addComponent, removeComponent, updateComponent, connect, disconnect,
    renameNet, removeNet, clear, setLibPart, fpNameFor, attachDb, erc, autoLayout, summary, isPower, isGround, invalidate, netsOfComp
  };
})();
