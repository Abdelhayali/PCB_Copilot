'use strict';
// EasyEDA-style PCB editor: Layers panel, PCB Tools (select / track / via / measure),
// interactive routing with layer switching, live clearance check, track & via editing.
const PcbView = (() => {
  // EasyEDA default layer colours
  const LAYERS = [
    { id: 'F', name: 'TopLayer', color: '#FF0000', copper: true },
    { id: 'B', name: 'BottomLayer', color: '#0000FF', copper: true },
    { id: 'FS', name: 'TopSilkLayer', color: '#FFCC00' },
    { id: 'FM', name: 'TopSolderMaskLayer', color: '#800080', off: true },
    { id: 'BM', name: 'BottomSolderMaskLayer', color: '#AA00FF', off: true },
    { id: 'MU', name: 'Multi-Layer', color: '#C0C0C0' },
    { id: 'HO', name: 'HoleLayer', color: '#222222' },
    { id: 'OL', name: 'BoardOutline', color: '#FF00FF' },
    { id: 'RA', name: 'RatlineLayer', color: '#6464FF' },
    { id: 'DRC', name: 'DRCErrorLayer', color: '#FAD609' },
  ];
  const TOOLS = [
    { id: 'select', key: 'S', name: 'Select / move', icon: '<path d="M5 3l12 9-5 1 3 6-2 1-3-6-4 4z"/>' },
    { id: 'track', key: 'W', name: 'Track', icon: '<path d="M3 18h6l6-12h6" fill="none" stroke-width="2.4"/>' },
    { id: 'via', key: 'V', name: 'Via', icon: '<circle cx="12" cy="12" r="7" fill="none" stroke-width="2.6"/><circle cx="12" cy="12" r="2.4"/>' },
    { id: 'measure', key: 'M', name: 'Measure', icon: '<path d="M3 16l13-13 5 5-13 13z" fill="none" stroke-width="1.8"/><path d="M7 12l2 2M10 9l2 2M13 6l2 2" stroke-width="1.6"/>' },
  ];
  const GRIDS = [0.05, 0.1, 0.127, 0.254, 0.5, 1.27];
  const ui = {
    sel: null, item: null, hlNet: null, drc: null, tool: 'select', active: 'F', angle: '45', flip: false, grid: 0.254, width: null, dim: true,
    route: null, measure: null, cursor: null, layers: {}, onSelect: () => { },
  };
  LAYERS.forEach(l => ui.layers[l.id] = { on: !l.off, color: l.color });
  try { const s = JSON.parse(localStorage.getItem('cp.pcbView') || '{}'); if (s.layers) for (const k in s.layers) if (ui.layers[k]) Object.assign(ui.layers[k], s.layers[k]); ['grid', 'angle', 'dim'].forEach(k => { if (s[k] != null) ui[k] = s[k]; }); } catch (e) { }
  const persist = () => { try { localStorage.setItem('cp.pcbView', JSON.stringify({ layers: ui.layers, grid: ui.grid, angle: ui.angle, dim: ui.dim })); } catch (e) { } };
  const vis = id => ui.layers[id].on, col = id => ui.layers[id].color;
  const LNAME = { F: 'TopLayer', B: 'BottomLayer' };

  let svg, world, grid, vp, overlay, cache = { pads: [] };
  const $ = s => document.querySelector(s);
  const G = Pcb.geom;

  // ---------- setup ----------
  function init(el) {
    svg = el;
    svg.innerHTML = `<defs><pattern id="pgrid" width="2.54" height="2.54" patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r="0.07" fill="#3a3a3a"/></pattern></defs><rect id="pgridr" fill="url(#pgrid)"/><g id="pworld"></g>`;
    world = svg.querySelector('#pworld'); grid = svg.querySelector('#pgridr');
    vp = new Viewport(svg, { min: 2, max: 400, scale: 10, onChange: vb => { grid.setAttribute('x', vb[0]); grid.setAttribute('y', vb[1]); grid.setAttribute('width', vb[2]); grid.setAttribute('height', vb[3]); } });
    svg.addEventListener('mousedown', down); svg.addEventListener('dblclick', dbl);
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    svg.addEventListener('contextmenu', e => e.preventDefault());
    // floating palettes (EasyEDA "PCB Tools" and "Layers")
    overlay = document.createElement('div'); overlay.id = 'pcbOverlay'; overlay.className = 'hidden';
    overlay.innerHTML = `
      <div id="pcbPalette" class="fpanel"><div class="fph">PCB Tools</div>
        ${TOOLS.map(t => `<button class="tbtn" data-tool="${t.id}" title="${t.name} (${t.key})"><svg viewBox="0 0 24 24">${t.icon}</svg><span>${t.key}</span></button>`).join('')}
      </div>
      <div id="layerPanel" class="fpanel"><div class="fph"><span class="ltitle" title="Collapse / expand">▾ Layers</span> <span class="lq"><button data-q="all" title="Show all">All</button><button data-q="none" title="Hide all">None</button><button data-q="F" title="Top side only">Top</button><button data-q="B" title="Bottom side only">Bot</button></span></div>
        <div id="layerRows"></div>
        <label class="ldim"><input type="checkbox" id="ldim"> Dim inactive copper</label>
      </div>
      <div id="pcbCoord"></div>`;
    svg.parentElement.appendChild(overlay);
    overlay.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
    overlay.querySelector('.lq').onclick = e => {
      const q = e.target.dataset.q; if (!q) return;
      for (const l of LAYERS) ui.layers[l.id].on = q === 'all' ? true : q === 'none' ? false :
        (q === 'F' ? !['B', 'BM'].includes(l.id) : !['F', 'FS', 'FM'].includes(l.id));
      if (q === 'F' || q === 'B') ui.active = q;
      persist(); renderLayers(); render(); syncBar();
    };
    $('#layerRows').onclick = e => {
      const row = e.target.closest('[data-l]'); if (!row) return; const id = row.dataset.l;
      if (e.target.closest('.leye')) { ui.layers[id].on = !ui.layers[id].on; persist(); }
      else if (e.target.closest('.lsw')) return; // colour picker
      else if (LAYERS.find(l => l.id === id).copper) { ui.active = id; ui.layers[id].on = true; if (ui.route) switchLayer(id); }
      renderLayers(); render(); syncBar();
    };
    $('#layerRows').oninput = e => { const row = e.target.closest('[data-l]'); if (row && e.target.type === 'color') { ui.layers[row.dataset.l].color = e.target.value; persist(); renderLayers(); render(); } };
    $('#ldim').onchange = e => { ui.dim = e.target.checked; persist(); render(); };
    overlay.querySelector('.ltitle').onclick = () => { const p = $('#layerPanel'); p.classList.toggle('collapsed'); overlay.querySelector('.ltitle').textContent = (p.classList.contains('collapsed') ? '▸' : '▾') + ' Layers'; };
    renderLayers(); setTool('select');
    if (svg.getBoundingClientRect().width < 900 || window.innerWidth < 1200) { $('#layerPanel').classList.add('collapsed'); overlay.querySelector('.ltitle').textContent = '▸ Layers'; }
  }
  function renderLayers() {
    $('#layerRows').innerHTML = LAYERS.map(l => `<div class="lrow${ui.active === l.id ? ' act' : ''}${ui.layers[l.id].on ? '' : ' off'}" data-l="${l.id}" title="${l.copper ? 'Click to make active (T / B)' : ''}">
      <span class="lact">${ui.active === l.id ? '✎' : ''}</span>
      <label class="lsw" style="background:${ui.layers[l.id].color}"><input type="color" value="${ui.layers[l.id].color}"></label>
      <span class="lname">${l.name}</span><span class="leye" title="Show / hide">${ui.layers[l.id].on ? '👁' : '—'}</span></div>`).join('');
    $('#ldim').checked = ui.dim;
  }
  function setVisible(on) { overlay && overlay.classList.toggle('hidden', !on); }
  function setTool(t) {
    if (ui.route && t !== 'track') finishRoute();
    ui.tool = t; ui.measure = null;
    overlay && overlay.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
    if (svg) svg.style.cursor = t === 'select' ? 'default' : 'crosshair';
    render(); coord();
  }
  // toolbar fields (active layer, width, angle, grid)
  function syncBar() {
    const L = $('#pLayer'); if (!L) return;
    L.value = ui.active; $('#pAngle').value = ui.angle; $('#pGrid').value = String(ui.grid);
    $('#pWidth').placeholder = 'auto ' + Pcb.rules().traceWidth;
  }
  function bindBar() {
    $('#pGrid').innerHTML = GRIDS.map(g => `<option value="${g}">${g} mm${g === 0.254 ? ' (10 mil)' : g === 0.127 ? ' (5 mil)' : g === 1.27 ? ' (50 mil)' : ''}</option>`).join('');
    $('#pLayer').onchange = e => { ui.active = e.target.value; ui.layers[ui.active].on = true; if (ui.route) switchLayer(ui.active); renderLayers(); render(); };
    $('#pAngle').onchange = e => { ui.angle = e.target.value; persist(); render(); };
    $('#pGrid').onchange = e => { ui.grid = +e.target.value; persist(); };
    $('#pWidth').oninput = e => { ui.width = +e.target.value > 0 ? +e.target.value : null; if (ui.route) { ui.route.w = curWidth(ui.route.net); render(); } };
    syncBar();
  }
  const curWidth = net => ui.width || (net ? Pcb.netWidth(net) : Pcb.rules().traceWidth);

  // ---------- geometry helpers ----------
  const snapG = v => Math.round(v / ui.grid) * ui.grid;
  const L2 = () => Pcb.rules().layers === 1 ? ['F'] : ['F', 'B'];
  function allPads() {
    const idx = Model.pinIndex(); return Pcb.placed().flatMap(c => Pcb.padsOf(c, idx));
  }
  const padLayers = p => p.drill ? L2() : ['F'];
  // object under a point on the given layer (or any visible layer): pad, via or track
  function hitObj(pt, layer) {
    for (const p of cache.pads) if ((!layer || padLayers(p).includes(layer)) && G.padDist(p, pt.x, pt.y) <= 0) return { k: 'pad', net: p.net, x: p.x, y: p.y, p, layer: p.drill ? null : 'F' };
    const S = Model.S;
    for (let i = 0; i < S.pcb.vias.length; i++) { const v = S.pcb.vias[i]; if (Math.hypot(pt.x - v.x, pt.y - v.y) <= v.d / 2) return { k: 'via', net: v.net, x: v.x, y: v.y, i }; }
    for (let i = S.pcb.traces.length - 1; i >= 0; i--) {
      const t = S.pcb.traces[i]; if (layer && t.layer !== layer) continue; if (!vis(t.layer)) continue;
      for (let s = 1; s < t.pts.length; s++) {
        const a = t.pts[s - 1], b = t.pts[s];
        if (G.ptSeg([pt.x, pt.y], a, b) <= t.w / 2) {
          const vx = b[0] - a[0], vy = b[1] - a[1], l2 = vx * vx + vy * vy, u = l2 ? Math.max(0, Math.min(1, ((pt.x - a[0]) * vx + (pt.y - a[1]) * vy) / l2)) : 0;
          return { k: 'track', net: t.net, x: a[0] + u * vx, y: a[1] + u * vy, i, s, layer: t.layer };
        }
      }
    }
    return null;
  }
  function snapPoint(pt, layer) {
    const o = hitObj(pt, layer);
    if (o) return { x: +o.x.toFixed(4), y: +o.y.toFixed(4), obj: o };
    return { x: +snapG(pt.x).toFixed(4), y: +snapG(pt.y).toFixed(4), obj: null };
  }
  // EasyEDA-like bend: straight + 45° (or 90°, or any angle); '/' flips the order
  function bend(a, b) {
    if (ui.angle === 'any') return [b];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    let c;
    if (ui.angle === '90') c = ui.flip ? [a[0], b[1]] : [b[0], a[1]];
    else {
      const adx = Math.abs(dx), ady = Math.abs(dy), d = Math.min(adx, ady), sx = Math.sign(dx), sy = Math.sign(dy);
      c = ui.flip ? [a[0] + sx * d, a[1] + sy * d] : (adx > ady ? [a[0] + sx * (adx - d), a[1]] : [a[0], a[1] + sy * (ady - d)]);
    }
    c = [+c[0].toFixed(4), +c[1].toFixed(4)];
    return (Math.hypot(c[0] - a[0], c[1] - a[1]) < 1e-6 || Math.hypot(c[0] - b[0], c[1] - b[1]) < 1e-6) ? [b] : [c, b];
  }
  // foreign copper on a layer, for the live clearance check
  function obstacles(layer, net) {
    const out = [], S = Model.S;
    for (const p of cache.pads) if (padLayers(p).includes(layer) && (!net || p.net !== net)) out.push({ s: G.padShape(p), what: 'pad ' + p.key, net: p.net });
    for (const v of S.pcb.vias) if (!net || v.net !== net) out.push({ s: { k: 'circ', c: [v.x, v.y], r: v.d / 2 }, what: 'via', net: v.net });
    for (const t of S.pcb.traces) if (t.layer === layer && (!net || t.net !== net)) for (let i = 1; i < t.pts.length; i++) out.push({ s: { k: 'seg', a: t.pts[i - 1], b: t.pts[i], r: t.w / 2 }, what: 'track ' + (t.net || ''), net: t.net });
    return out;
  }
  function checkClear(pts, w, route) {
    if (!route || pts.length < 2) return null;
    const cl = Pcb.rules().clearance; let worst = null;
    for (let i = 1; i < pts.length; i++) {
      const seg = { k: 'seg', a: pts[i - 1], b: pts[i], r: w / 2 };
      for (const o of route.obs) {
        if (route.startObj && o.what === 'pad ' + (route.startObj.p && route.startObj.p.key)) continue;
        if (route.net && o.net === route.net) continue;
        const d = G.shapeDist(seg, o.s);
        if (d < cl - 1e-3 && (!worst || d < worst.d)) worst = { d, what: o.what };
      }
    }
    return worst;
  }

  // ---------- interactive routing ----------
  function startRoute(sp) {
    let layer = ui.active;
    if (sp.obj && sp.obj.k === 'pad' && !sp.obj.p.drill && layer !== 'F') { layer = 'F'; ui.active = 'F'; App.toast('SMD pad is on TopLayer — routing on TopLayer'); renderLayers(); syncBar(); }
    if (sp.obj && sp.obj.k === 'track') { layer = sp.obj.layer; ui.active = layer; renderLayers(); syncBar(); }
    const net = sp.obj ? sp.obj.net || null : null;
    ui.route = { net, layer, w: curWidth(net), pts: [[sp.x, sp.y]], done: [], vias: [], startObj: sp.obj, obs: obstacles(layer, net) };
    ui.hlNet = net;
  }
  function addPoints(sp) {
    const R = ui.route, last = R.pts[R.pts.length - 1];
    const o = sp.obj;
    if (o && o.net && R.net && o.net !== R.net) { App.toast(`Can't connect: this ${o.k} is on net ${o.net}, the track is on ${R.net}`); return false; }
    if (o && o.net && !R.net) { R.net = o.net; R.w = curWidth(o.net); R.obs = obstacles(R.layer, R.net); ui.hlNet = o.net; }
    if (o && o.k === 'pad' && !o.p.drill && R.layer !== 'F') { App.toast('That SMD pad is on TopLayer — press T to switch layer (adds a via)'); return false; }
    for (const q of bend(last, [sp.x, sp.y])) R.pts.push(q);
    const same = Math.hypot(sp.x - last[0], sp.y - last[1]) < 1e-6;
    // ending on copper (pad / via / track) finishes the track, like EasyEDA
    if (o && !(R.startObj && o.k === R.startObj.k && (o.p ? o.p === R.startObj.p : o.i === R.startObj.i) && R.pts.length <= 2)) return finishRoute();
    if (same && R.pts.length > 2) { R.pts.pop(); return finishRoute(); }
    return true;
  }
  function switchLayer(to) {
    const R = ui.route; if (!R) { ui.active = to; return; }
    to = to || (R.layer === 'F' ? 'B' : 'F');
    if (to === R.layer || Pcb.rules().layers === 1) return;
    const p = R.pts[R.pts.length - 1];
    if (R.pts.length >= 2) R.done.push({ layer: R.layer, w: R.w, pts: R.pts });
    R.vias.push({ x: p[0], y: p[1] });
    const R0 = Pcb.rules(), vs = { k: 'circ', c: p, r: R0.viaDiameter / 2 };
    let worst = null;
    for (const L of ['F', 'B']) for (const o of obstacles(L, R.net)) { const d = G.shapeDist(vs, o.s); if (d < R0.clearance - 1e-3 && (!worst || d < worst.d)) worst = { d, what: o.what }; }
    if (worst) App.toast(`⚠ Via ${worst.d <= 0 ? 'shorts' : 'is ' + worst.d.toFixed(3) + ' mm'} to ${worst.what} (rule ${R0.clearance}) — Backspace to undo`, 5000);
    R.layer = to; R.pts = [p]; ui.active = to; ui.layers[to].on = true;
    R.obs = obstacles(to, R.net);
    renderLayers(); syncBar(); render();
  }
  function simplify(pts) {
    const out = [pts[0]];
    for (let k = 1; k < pts.length; k++) {
      const a = out.length > 1 ? out[out.length - 2] : null, b = out[out.length - 1], c = pts[k];
      if (Math.hypot(c[0] - b[0], c[1] - b[1]) < 1e-6) continue;
      if (a && Math.abs((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) < 1e-9) out[out.length - 1] = c; else out.push(c);
    }
    return out;
  }
  function finishRoute() {
    const R = ui.route; ui.route = null;
    if (!R) return true;
    const parts = R.done.concat(R.pts.length >= 2 ? [{ layer: R.layer, w: R.w, pts: R.pts }] : []);
    if (parts.length || R.vias.length) {
      const R0 = Pcb.rules();
      Model.mutate(() => {
        for (const p of parts) { const pts = simplify(p.pts); if (pts.length >= 2) Model.S.pcb.traces.push({ net: R.net, layer: p.layer, w: +p.w.toFixed(4), pts, manual: true }); }
        for (const v of R.vias) Model.S.pcb.vias.push({ net: R.net, x: v.x, y: v.y, d: R0.viaDiameter, drill: R0.viaDrill, manual: true });
      });
    } else render();
    return true;
  }
  function backspace() {
    const R = ui.route; if (!R) return false;
    if (R.pts.length > 1) R.pts.pop();
    else if (R.done.length) { const d = R.done.pop(); R.vias.pop(); R.layer = d.layer; R.pts = d.pts; ui.active = d.layer; R.obs = obstacles(R.layer, R.net); renderLayers(); syncBar(); }
    else ui.route = null;
    render(); return true;
  }

  // ---------- mouse ----------
  let drag = null, pan = null, rdown = null;
  function down(e) {
    const pt = vp.toWorld(e.clientX, e.clientY);
    if (e.button === 2) { rdown = { x: e.clientX, y: e.clientY }; pan = { x: e.clientX, y: e.clientY }; e.preventDefault(); return; }
    if (e.button === 1) { pan = { x: e.clientX, y: e.clientY }; e.preventDefault(); return; }
    if (ui.tool === 'track') {
      const sp = snapPoint(pt, ui.route ? ui.route.layer : null);
      if (!ui.route) startRoute(sp); else addPoints(sp);
      render(); coord(); return;
    }
    if (ui.tool === 'via') {
      const sp = snapPoint(pt, null), R0 = Pcb.rules();
      if (Pcb.rules().layers === 1) { App.toast('Single-layer rules: vias are disabled'); return; }
      Model.mutate(() => Model.S.pcb.vias.push({ net: sp.obj ? sp.obj.net || null : null, x: sp.x, y: sp.y, d: R0.viaDiameter, drill: R0.viaDrill, manual: true }));
      return;
    }
    if (ui.tool === 'measure') {
      const sp = snapPoint(pt, null);
      if (!ui.measure || ui.measure.done) ui.measure = { a: [sp.x, sp.y], b: [sp.x, sp.y], done: false };
      else { ui.measure.b = [sp.x, sp.y]; ui.measure.done = true; }
      render(); return;
    }
    // select
    const el = e.target.closest('[data-k],[data-ref]');
    if (el && el.dataset.k === 't') { selectItem({ k: 't', i: +el.dataset.i, s: +el.dataset.s }); return; }
    if (el && el.dataset.k === 'v') { const v = Model.S.pcb.vias[+el.dataset.i]; selectItem({ k: 'v', i: +el.dataset.i }); drag = { kind: 'via', i: +el.dataset.i, ox: pt.x - v.x, oy: pt.y - v.y, moved: false }; return; }
    const ref = el && (el.dataset.ref || el.dataset.pref);
    if (ref) {
      const c = Model.comp(ref); ui.item = null; ui.sel = c.ref; ui.hlNet = el.dataset.net || null; ui.onSelect(c.ref);
      drag = { kind: 'fp', ref: c.ref, ox: pt.x - c.pcb.x, oy: pt.y - c.pcb.y, moved: false }; render(); return;
    }
    ui.sel = null; ui.item = null; ui.hlNet = null; ui.onSelect(null); pan = { x: e.clientX, y: e.clientY }; render();
  }
  function selectItem(it) {
    ui.sel = null; ui.item = it;
    const S = Model.S; ui.hlNet = it.k === 'v' ? S.pcb.vias[it.i].net : S.pcb.traces[it.i].net;
    ui.onSelect(null); render();
  }
  function dbl(e) {
    if (ui.tool === 'select') { const el = e.target.closest('[data-k="t"]'); if (el) selectItem({ k: 'T', i: +el.dataset.i }); }
    else if (ui.tool === 'track' && ui.route) finishRoute();
  }
  function move(e) {
    if (!svg || svg.classList.contains('hidden')) return;
    if (pan) { vp.panBy(e.clientX - pan.x, e.clientY - pan.y); pan = { x: e.clientX, y: e.clientY }; return; }
    const pt = vp.toWorld(e.clientX, e.clientY);
    if (drag) {
      if (drag.kind === 'fp') {
        const c = Model.comp(drag.ref); if (!c) return;
        const g = Math.max(ui.grid, 0.05), nx = +(Math.round((pt.x - drag.ox) / g) * g).toFixed(4), ny = +(Math.round((pt.y - drag.oy) / g) * g).toFixed(4);
        if (nx !== c.pcb.x || ny !== c.pcb.y) { if (!drag.moved) { Model.begin(); drag.moved = true; } c.pcb.x = nx; c.pcb.y = ny; Model.emit('move'); }
      } else if (drag.kind === 'via') {
        const v = Model.S.pcb.vias[drag.i], nx = +snapG(pt.x - drag.ox).toFixed(4), ny = +snapG(pt.y - drag.oy).toFixed(4);
        if (nx !== v.x || ny !== v.y) { if (!drag.moved) { Model.begin(); drag.moved = true; } v.x = nx; v.y = ny; Model.emit('move'); }
      }
      return;
    }
    if (!svg.matches(':hover') && !ui.route) return;
    ui.cursor = (ui.tool === 'track' || ui.tool === 'via' || ui.tool === 'measure') ? snapPoint(pt, ui.route ? ui.route.layer : null) : { x: pt.x, y: pt.y };
    if (ui.measure && !ui.measure.done) ui.measure.b = [ui.cursor.x, ui.cursor.y];
    if (ui.tool !== 'select') renderLive();
    coord();
  }
  function up(e) {
    if (rdown && e.button === 2) {
      const moved = Math.hypot(e.clientX - rdown.x, e.clientY - rdown.y) > 4; rdown = null;
      if (!moved) { if (ui.route) finishRoute(); else if (ui.tool !== 'select') setTool('select'); }
    }
    if (drag && drag.moved) Model.emit('change');
    drag = null; pan = null;
  }

  // ---------- keyboard ----------
  function key(e) {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === 'w') { setTool('track'); return true; }
    if (k === 'v') { if (ui.route) switchLayer(); else setTool('via'); return true; }
    if (k === 'm') { setTool('measure'); return true; }
    if (k === 's') { setTool('select'); return true; }
    if (k === 't' || k === 'b') { const to = k === 't' ? 'F' : 'B'; if (ui.route) switchLayer(to); else { ui.active = to; ui.layers[to].on = true; renderLayers(); syncBar(); render(); } return true; }
    if (k === 'l') { const to = ui.active === 'F' ? 'B' : 'F'; if (ui.route) switchLayer(to); else { ui.active = to; renderLayers(); syncBar(); render(); } return true; }
    if (k === ' ') { ui.angle = ui.angle === '45' ? '90' : ui.angle === '90' ? 'any' : '45'; persist(); syncBar(); renderLive(); App.toast('Routing angle: ' + (ui.angle === 'any' ? 'any' : ui.angle + '°')); return true; }
    if (k === '/') { ui.flip = !ui.flip; renderLive(); return true; }
    if (k === 'Backspace' && ui.route) return backspace();
    if (k === 'Escape') { if (ui.route) finishRoute(); else if (ui.measure) { ui.measure = null; render(); } else if (ui.tool !== 'select') setTool('select'); else { ui.sel = null; ui.item = null; ui.hlNet = null; ui.onSelect(null); render(); } return true; }
    if ((k === 'Delete' || k === 'Backspace') && ui.item) { deleteItem(); return true; }
    if (k === 'r' && ui.sel) { const c = Model.comp(ui.sel); if (c && c.pcb) Model.mutate(() => { c.pcb.rot = ((c.pcb.rot || 0) + 90) % 360; }); return true; }
    if ((k === '+' || k === '=' || k === '-') && ui.tool === 'track') { const w = Math.max(0.05, +((ui.width || curWidth(ui.route && ui.route.net)) + (k === '-' ? -0.05 : 0.05)).toFixed(3)); ui.width = w; $('#pWidth').value = w; if (ui.route) ui.route.w = w; renderLive(); coord(); return true; }
    return false;
  }
  function deleteItem() {
    const it = ui.item; if (!it) return; ui.item = null; ui.hlNet = null;
    Model.mutate(() => {
      const S = Model.S;
      if (it.k === 'v') S.pcb.vias.splice(it.i, 1);
      else if (it.k === 'T') S.pcb.traces.splice(it.i, 1);
      else if (it.k === 't') {
        const t = S.pcb.traces[it.i], a = t.pts.slice(0, it.s), b = t.pts.slice(it.s);
        const keep = []; if (a.length >= 2) keep.push(Object.assign({}, t, { pts: a })); if (b.length >= 2) keep.push(Object.assign({}, t, { pts: b }));
        S.pcb.traces.splice(it.i, 1, ...keep);
      }
    });
  }

  // ---------- rendering ----------
  const padEl = (p, fill, extra = '', grow = 0) => p.shape === 'round'
    ? `<circle cx="${p.x}" cy="${p.y}" r="${p.w / 2 + grow}" fill="${fill}" ${extra}/>`
    : `<rect x="${p.x - p.w / 2 - grow}" y="${p.y - p.h / 2 - grow}" width="${p.w + 2 * grow}" height="${p.h + 2 * grow}" rx="${p.shape === 'oval' ? Math.min(p.w, p.h) / 2 + grow : 0}" fill="${fill}" ${extra}/>`;
  function render() {
    if (!world) return;
    const S = Model.S, cs = Pcb.placed();
    cache.pads = allPads();
    if (!cs.length || !S.board.w) { world.innerHTML = '<text x="0" y="0" text-anchor="middle" fill="#888" style="font-size:2.4px">No PCB yet — click “Generate PCB”, or ask the Copilot to make the board</text>'; renderLiveLayer(); return; }
    const out = [], hl = ui.hlNet;
    // footprint hit areas (bottom), so copper on top stays clickable
    for (const c of cs) { const b = Pcb.fpBox(c); out.push(`<rect class="fphit" data-ref="${esc(c.ref)}" x="${b[0]}" y="${b[1]}" width="${b[2] - b[0]}" height="${b[3] - b[1]}"/>`); }
    const order = ui.active === 'F' ? ['B', 'F'] : ['F', 'B'];
    for (const L of order) {
      if (!vis(L)) continue;
      const op = ui.dim && L !== ui.active ? 0.45 : 0.9, c = col(L);
      out.push(`<g class="cu" opacity="${op}">`);
      S.pcb.traces.forEach((t, i) => {
        if (t.layer !== L) return;
        for (let s = 1; s < t.pts.length; s++) out.push(`<line data-k="t" data-i="${i}" data-s="${s}" class="trk${hl && t.net === hl ? ' hl' : ''}" x1="${t.pts[s - 1][0]}" y1="${t.pts[s - 1][1]}" x2="${t.pts[s][0]}" y2="${t.pts[s][1]}" stroke="${c}" stroke-width="${t.w}"><title>${esc(t.net || '(no net)')} · ${t.w} mm · ${LNAME[t.layer]}</title></line>`);
      });
      if (L === 'F') for (const p of cache.pads) if (!p.drill) out.push(padEl(p, c, `class="pad${hl && p.net === hl ? ' hl' : ''}" data-pref="${esc(p.ref)}" data-net="${esc(p.net || '')}"><title>${esc(p.key)}${p.net ? ' · ' + esc(p.net) : ''}</title></${p.shape === 'round' ? 'circle' : 'rect'}`).replace(/\/><\/(circle|rect)$/, ''));
      out.push('</g>');
    }
    if (vis('MU')) {
      for (const p of cache.pads) if (p.drill) out.push(padEl(p, col('MU'), `class="pad${hl && p.net === hl ? ' hl' : ''}" data-pref="${esc(p.ref)}" data-net="${esc(p.net || '')}"`).replace('/>', `><title>${esc(p.key)}${p.net ? ' · ' + esc(p.net) : ''}</title></${p.shape === 'round' ? 'circle' : 'rect'}>`));
      S.pcb.vias.forEach((v, i) => out.push(`<circle data-k="v" data-i="${i}" class="via${hl && v.net === hl ? ' hl' : ''}" cx="${v.x}" cy="${v.y}" r="${v.d / 2}" fill="${col('MU')}"><title>via ${esc(v.net || '(no net)')} · ${v.d}/${v.drill} mm</title></circle>`));
    }
    if (vis('HO')) {
      for (const p of cache.pads) if (p.drill) out.push(`<circle cx="${p.x}" cy="${p.y}" r="${p.drill / 2}" fill="${col('HO')}" pointer-events="none"/>`);
      for (const v of S.pcb.vias) out.push(`<circle cx="${v.x}" cy="${v.y}" r="${v.drill / 2}" fill="${col('HO')}" pointer-events="none"/>`);
    }
    if (vis('FM')) for (const p of cache.pads) if (!p.drill || true) out.push(padEl(p, 'none', `stroke="${col('FM')}" stroke-width="0.05" pointer-events="none"`, 0.05));
    if (vis('BM')) for (const p of cache.pads) if (p.drill) out.push(padEl(p, 'none', `stroke="${col('BM')}" stroke-width="0.05" stroke-dasharray="0.2 0.1" pointer-events="none"`, 0.05));
    if (vis('FS')) for (const c of cs) {
      const b = Pcb.fpBox(c);
      out.push(`<rect x="${b[0]}" y="${b[1]}" width="${b[2] - b[0]}" height="${b[3] - b[1]}" fill="none" stroke="${col('FS')}" stroke-width="0.15" pointer-events="none"/>`);
      out.push(`<text x="${(b[0] + b[2]) / 2}" y="${b[1] - 0.35}" text-anchor="middle" fill="${col('FS')}" style="font-size:1.1px;font-weight:700" pointer-events="none">${esc(c.ref)}</text>`);
    }
    if (vis('OL')) out.push(`<rect x="0" y="0" width="${S.board.w}" height="${S.board.h}" fill="none" stroke="${col('OL')}" stroke-width="0.15" pointer-events="none"/>`);
    if (vis('RA')) for (const r of Pcb.ratsnest()) out.push(`<line x1="${r.a.x}" y1="${r.a.y}" x2="${r.b.x}" y2="${r.b.y}" stroke="${col('RA')}" stroke-width="0.08" pointer-events="none"><title>${esc(r.net)}</title></line>`);
    if (vis('DRC') && ui.drc) for (const v of ui.drc.violations) if (v.x != null) out.push(`<g class="drcmark" transform="translate(${v.x} ${v.y})" stroke="${v.severity === 'error' ? col('DRC') : '#f0b429'}"><circle r="0.9" fill="none" stroke-width="0.12"/><path d="M-0.45 -0.45L0.45 0.45M0.45 -0.45L-0.45 0.45" stroke-width="0.14"/><title>${esc(v.msg)}</title></g>`);
    // selection outlines
    if (ui.sel) { const c = Model.comp(ui.sel); if (c && c.pcb) { const b = Pcb.fpBox(c, 0.2); out.push(`<rect class="selbox" x="${b[0]}" y="${b[1]}" width="${b[2] - b[0]}" height="${b[3] - b[1]}"/>`); } }
    if (ui.item) {
      if (ui.item.k === 'v') { const v = S.pcb.vias[ui.item.i]; if (v) out.push(`<circle class="selbox" cx="${v.x}" cy="${v.y}" r="${v.d / 2 + 0.15}"/>`); }
      else { const t = S.pcb.traces[ui.item.i]; if (t) { const pts = ui.item.k === 'T' ? t.pts : [t.pts[ui.item.s - 1], t.pts[ui.item.s]]; out.push(`<polyline class="selline" points="${pts.map(p => p.join(',')).join(' ')}" stroke-width="${t.w + 0.2}"/>`); } }
    }
    out.push('<g id="pcbLive"></g>');
    world.innerHTML = out.join('');
    renderLiveLayer();
  }
  // routing preview / cursor / measure are redrawn on mouse move without touching the board
  function renderLive() { if (world && world.querySelector('#pcbLive')) renderLiveLayer(); }
  function renderLiveLayer() {
    const live = world && world.querySelector('#pcbLive'); if (!live) return;
    const out = [], R = ui.route, c = ui.cursor;
    if (R) {
      for (const d of R.done) out.push(`<polyline points="${d.pts.map(p => p.join(',')).join(' ')}" stroke="${col(d.layer)}" stroke-width="${d.w}" class="rprev"/>`);
      for (const v of R.vias) out.push(`<circle cx="${v.x}" cy="${v.y}" r="${Pcb.rules().viaDiameter / 2}" fill="${col('MU')}"/><circle cx="${v.x}" cy="${v.y}" r="${Pcb.rules().viaDrill / 2}" fill="#111"/>`);
      const last = R.pts[R.pts.length - 1], prev = c ? bend(last, [c.x, c.y]) : [];
      const pts = R.pts.concat(prev), bad = checkClear([last].concat(prev), R.w, R);
      out.push(`<polyline points="${pts.map(p => p.join(',')).join(' ')}" stroke="${col(R.layer)}" stroke-width="${R.w}" class="rprev${bad ? ' bad' : ''}"/>`);
      if (bad) out.push(`<polyline points="${[last].concat(prev).map(p => p.join(',')).join(' ')}" stroke="#ffffff" stroke-width="${R.w}" stroke-dasharray="0.2 0.2" fill="none" opacity="0.8"/>`);
      R.bad = bad;
    }
    if (c && ui.tool !== 'select') {
      const s = 0.8;
      out.push(`<path d="M${c.x - s} ${c.y}H${c.x + s}M${c.x} ${c.y - s}V${c.y + s}" stroke="${c.obj ? '#00ff9c' : '#ffffff'}" stroke-width="0.05"/>`);
      if (c.obj) out.push(`<circle cx="${c.x}" cy="${c.y}" r="0.3" fill="none" stroke="#00ff9c" stroke-width="0.06"/>`);
      if (ui.tool === 'via') out.push(`<circle cx="${c.x}" cy="${c.y}" r="${Pcb.rules().viaDiameter / 2}" fill="${col('MU')}" opacity="0.6"/>`);
    }
    if (ui.measure) {
      const { a, b } = ui.measure, d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      out.push(`<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#00e5ff" stroke-width="0.06"/><circle cx="${a[0]}" cy="${a[1]}" r="0.15" fill="#00e5ff"/><circle cx="${b[0]}" cy="${b[1]}" r="0.15" fill="#00e5ff"/>`);
      out.push(`<text x="${(a[0] + b[0]) / 2 + 0.3}" y="${(a[1] + b[1]) / 2 - 0.3}" fill="#00e5ff" style="font-size:0.9px;font-weight:700">${d.toFixed(3)} mm · ${(d / 0.0254).toFixed(1)} mil (Δx ${(b[0] - a[0]).toFixed(2)}, Δy ${(b[1] - a[1]).toFixed(2)})</text>`);
    }
    live.innerHTML = out.join('');
    coord();
  }
  function coord() {
    const el = $('#pcbCoord'); if (!el) return;
    const c = ui.cursor, R = ui.route;
    let s = c ? `X ${c.x.toFixed(3)}  Y ${c.y.toFixed(3)} mm` : '';
    s += ` · <b style="color:${col(ui.active)}">${LNAME[ui.active]}</b> · ${(TOOLS.find(t => t.id === ui.tool) || {}).name}`;
    if (ui.tool === 'track') s += ` · width ${R ? R.w : curWidth(null)} mm · ${ui.angle === 'any' ? 'any angle' : ui.angle + '°'}`;
    if (R) s += ` · net <b>${esc(R.net || '(none)')}</b>`;
    if (R && R.bad) s += ` · <span class="bad">⚠ ${R.bad.d <= 0 ? 'short' : 'clearance ' + R.bad.d.toFixed(3) + ' mm'} to ${esc(R.bad.what)} (rule ${Pcb.rules().clearance})</span>`;
    if (ui.tool === 'track') s += ` <span class="muted">· T/B/V switch layer + via · Space angle · / bend · Backspace undo · Esc / right-click finish</span>`;
    el.innerHTML = s;
  }

  // ---------- properties (track / via) ----------
  function props(el) {
    const it = ui.item; if (!it) return false;
    const S = Model.S, nets = Object.keys(S.nets).sort();
    const netSel = cur => `<select id="ppNet"><option value="">(no net)</option>${nets.map(n => `<option ${n === cur ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
    if (it.k === 'v') {
      const v = S.pcb.vias[it.i]; if (!v) return false;
      el.innerHTML = `<div class="ph">Via</div><label>Net${netSel(v.net)}</label>
        <label>Diameter (mm)<input id="ppD" type="number" step="0.05" value="${v.d}"></label><label>Drill (mm)<input id="ppDr" type="number" step="0.05" value="${v.drill}"></label>
        <label>X (mm)<input id="ppX" type="number" step="${ui.grid}" value="${v.x}"></label><label>Y (mm)<input id="ppY" type="number" step="${ui.grid}" value="${v.y}"></label>
        <div class="row"><button id="ppDel" class="danger">Delete (Del)</button></div>`;
      const upd = f => Model.mutate(() => f(Model.S.pcb.vias[it.i]));
      $('#ppNet').onchange = e => upd(v => v.net = e.target.value || null);
      $('#ppD').onchange = e => upd(v => v.d = +e.target.value); $('#ppDr').onchange = e => upd(v => v.drill = +e.target.value);
      $('#ppX').onchange = e => upd(v => v.x = +e.target.value); $('#ppY').onchange = e => upd(v => v.y = +e.target.value);
    } else {
      const t = S.pcb.traces[it.i]; if (!t) return false;
      let len = 0; for (let i = 1; i < t.pts.length; i++) len += Math.hypot(t.pts[i][0] - t.pts[i - 1][0], t.pts[i][1] - t.pts[i - 1][1]);
      el.innerHTML = `<div class="ph">Track ${it.k === 'T' ? '' : `<span class="muted">segment ${it.s}</span>`}</div><label>Net${netSel(t.net)}</label>
        <label>Layer<select id="ppL"><option value="F" ${t.layer === 'F' ? 'selected' : ''}>TopLayer</option><option value="B" ${t.layer === 'B' ? 'selected' : ''}>BottomLayer</option></select></label>
        <label>Width (mm)<input id="ppW" type="number" step="0.05" value="${t.w}"></label>
        <div class="muted small">Length ${len.toFixed(2)} mm · ${t.pts.length - 1} segments${t.manual ? ' · hand-routed' : ' · autorouted'}</div>
        <div class="row"><button id="ppDel" class="danger">Delete ${it.k === 'T' ? 'track' : 'segment'} (Del)</button></div>
        <div class="muted small">Double-click a track to select all of it.</div>`;
      const upd = f => Model.mutate(() => f(Model.S.pcb.traces[it.i]));
      $('#ppNet').onchange = e => upd(t => t.net = e.target.value || null);
      $('#ppL').onchange = e => upd(t => t.layer = e.target.value);
      $('#ppW').onchange = e => upd(t => t.w = Math.max(0.05, +e.target.value));
    }
    $('#ppDel').onclick = deleteItem;
    return true;
  }

  const fit = () => { const S = Model.S; vp && vp.fit(S.board.w ? [0, 0, S.board.w, S.board.h] : [-30, -20, 30, 20], 4); };
  function exportSVG() {
    const S = Model.S;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${S.board.w + 4} ${S.board.h + 4}" width="${(S.board.w + 4) * 10}" height="${(S.board.h + 4) * 10}" style="background:#000"><style>.fphit{fill:none}.trk{stroke-linecap:round}.selbox,.selline{display:none}</style><rect x="-2" y="-2" width="${S.board.w + 4}" height="${S.board.h + 4}" fill="#000"/>${world.innerHTML.replace(/<g id="pcbLive">.*?<\/g>$/, '')}</svg>`;
  }
  // keep the item selection valid after undo/redo or external edits
  function validate() {
    const S = Model.S;
    if (ui.item && ((ui.item.k === 'v' && !S.pcb.vias[ui.item.i]) || (ui.item.k !== 'v' && !S.pcb.traces[ui.item.i]))) ui.item = null;
    if (ui.sel && !Model.comp(ui.sel)) ui.sel = null;
  }
  return { init, render: () => { validate(); render(); coord(); }, fit, key, ui, exportSVG, setVisible, bindBar, props, setTool, LAYERS, get vp() { return vp; } };
})();
// Expose the editor through the Pcb namespace used by the rest of the app.
Object.assign(Pcb, { init: PcbView.init, render: PcbView.render, fit: PcbView.fit, key: PcbView.key, exportSVG: PcbView.exportSVG, ui: PcbView.ui });
Object.defineProperty(Pcb, 'vp', { get: () => PcbView.vp });
