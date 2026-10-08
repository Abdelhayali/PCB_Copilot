'use strict';
// Schematic renderer + editor (select, drag, rotate, click pin-to-pin to wire).
const Sch = (() => {
  let svg, world, grid, vp;
  const ui = { sel: null, selNet: null, pending: null, mouse: { x: 0, y: 0 }, drag: null, pan: null, onSelect: () => { } };

  function init(el) {
    svg = el;
    svg.innerHTML = `<defs><pattern id="sgrid" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r="0.7" class="griddot"/></pattern></defs>
      <rect id="sgridr" fill="url(#sgrid)"/><g id="sworld"></g>`;
    world = svg.querySelector('#sworld'); grid = svg.querySelector('#sgridr');
    vp = new Viewport(svg, { min: 0.3, max: 12, scale: 2, onChange: vb => { grid.setAttribute('x', vb[0]); grid.setAttribute('y', vb[1]); grid.setAttribute('width', vb[2]); grid.setAttribute('height', vb[3]); } });
    svg.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  // ---------- geometry helpers ----------
  const mdist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  function mst(pts) {
    const n = pts.length, inT = new Array(n).fill(false), best = new Array(n).fill(Infinity), par = new Array(n).fill(-1), E = [];
    if (!n) return E; best[0] = 0;
    for (let it = 0; it < n; it++) {
      let u = -1; for (let i = 0; i < n; i++) if (!inT[i] && (u < 0 || best[i] < best[u])) u = i;
      inT[u] = true; if (par[u] >= 0) E.push([par[u], u]);
      for (let v = 0; v < n; v++) if (!inT[v]) { const d = mdist(pts[u], pts[v]); if (d < best[v]) { best[v] = d; par[v] = u; } }
    }
    return E;
  }
  function segHits(x1, y1, x2, y2, boxes) {
    let h = 0; const sx0 = Math.min(x1, x2), sx1 = Math.max(x1, x2), sy0 = Math.min(y1, y2), sy1 = Math.max(y1, y2);
    for (const b of boxes) if (sx1 > b[0] + 1 && sx0 < b[2] - 1 && sy1 > b[1] + 1 && sy0 < b[3] - 1) h++;
    return h;
  }
  function route(a, b, boxes) {
    if (a.x === b.x || a.y === b.y) return [a, b];
    const e1 = { x: b.x, y: a.y }, e2 = { x: a.x, y: b.y };
    const s1 = segHits(a.x, a.y, e1.x, e1.y, boxes) + segHits(e1.x, e1.y, b.x, b.y, boxes);
    const s2 = segHits(a.x, a.y, e2.x, e2.y, boxes) + segHits(e2.x, e2.y, b.x, b.y, boxes);
    if (s1 !== s2) return [a, s1 < s2 ? e1 : e2, b];
    return [a, a.dx ? e1 : e2, b];
  }
  const angFor = (d, upIsAway) => { // rotation so that local -y (power) or +y (ground) points along d
    const k = `${d.dx},${d.dy}`;
    if (upIsAway) return { '0,-1': 0, '1,0': 90, '0,1': 180, '-1,0': 270 }[k] ?? 0;
    return { '0,1': 0, '-1,0': 90, '0,-1': 180, '1,0': 270 }[k] ?? 0;
  };

  // ---------- render ----------
  function render() {
    const S = Model.S, out = [], pinPos = {}, boxes = [];
    const idx = Model.pinIndex();
    for (const c of S.components) {
      boxes.push(Model.bbox(c));
      for (const p of Model.pinsWorld(c)) pinPos[p.key] = p;
    }
    // nets
    const junction = {};
    const bump = (p) => { const k = p.x + ',' + p.y; junction[k] = (junction[k] || 0) + 1; };
    for (const [net, keys] of Object.entries(S.nets)) {
      const pts = keys.map(k => pinPos[k]).filter(Boolean);
      const selC = ui.selNet === net ? ' sel' : '';
      if (Model.isPower(net)) {
        const gnd = Model.isGround(net);
        for (const p of pts) {
          const ex = p.x + p.dx * 10, ey = p.y + p.dy * 10;
          out.push(`<g class="pwr${selC}" data-net="${esc(net)}"><path class="wire" d="M${p.x} ${p.y}L${ex} ${ey}"/>`);
          if (gnd) out.push(`<path class="wire" transform="translate(${ex} ${ey}) rotate(${angFor(p, false)})" d="M-9 0H9M-6 4H6M-3 8H3"/>`);
          else {
            out.push(`<path class="wire" transform="translate(${ex} ${ey}) rotate(${angFor(p, true)})" d="M-7 0H7"/>`);
            const tx = ex + p.dx * 6, ty = ey + p.dy * 6 + (p.dy < 0 ? -2 : p.dy > 0 ? 8 : 3);
            out.push(`<text class="pwrtxt" x="${tx}" y="${ty}" text-anchor="${p.dx > 0 ? 'start' : p.dx < 0 ? 'end' : 'middle'}">${esc(net)}</text>`);
          }
          out.push('</g>');
        }
        continue;
      }
      if (pts.length < 2) { for (const p of pts) out.push(`<circle class="dangle" cx="${p.x}" cy="${p.y}" r="2.5"/>`); continue; }
      const E = mst(pts);
      const useLabels = S.connStyle === 'labels' || (S.connStyle === 'auto' && E.some(([a, b]) => mdist(pts[a], pts[b]) > 320));
      if (useLabels) {
        for (const p of pts) {
          const ex = p.x + p.dx * 10, ey = p.y + p.dy * 10;
          const anchor = p.dx > 0 ? 'start' : p.dx < 0 ? 'end' : 'middle';
          out.push(`<g class="netl${selC}" data-net="${esc(net)}"><path class="wire" d="M${p.x} ${p.y}L${ex} ${ey}"/><path class="hitw" d="M${p.x} ${p.y}L${ex} ${ey}"/>` +
            `<text class="netlabel" x="${ex + p.dx * 2}" y="${ey + (p.dy < 0 ? -3 : p.dy > 0 ? 9 : 3)}" text-anchor="${anchor}">${esc(net)}</text></g>`);
        }
        continue;
      }
      let d = '';
      for (const [a, b] of E) {
        const r = route(pts[a], pts[b], boxes);
        d += 'M' + r.map(q => q.x + ' ' + q.y).join('L');
        bump(pts[a]); bump(pts[b]);
      }
      for (const p of pts) bump(p);
      out.push(`<g class="netw${selC}" data-net="${esc(net)}"><path class="wire" d="${d}"/><path class="hitw" d="${d}"/>`);
      if (!/^N\$/.test(net)) {
        const p = pts[E[0][0]];
        out.push(`<text class="netname" x="${p.x + p.dx * 4}" y="${p.y - 3}" text-anchor="${p.dx < 0 ? 'end' : 'start'}">${esc(net)}</text>`);
      }
      out.push('</g>');
    }
    for (const [k, n] of Object.entries(junction)) if (n >= 3) { const [x, y] = k.split(','); out.push(`<circle class="junc" cx="${x}" cy="${y}" r="2.6"/>`); }

    // components
    for (const c of S.components) {
      const d = Lib.type(c.type), b = Model.bbox(c), lb = d.box(c);
      out.push(`<g class="comp${ui.sel === c.ref ? ' sel' : ''}" data-ref="${esc(c.ref)}"><g transform="translate(${c.x} ${c.y}) rotate(${c.rot || 0})">` +
        `<rect class="hit" x="${lb[0]}" y="${lb[1]}" width="${lb[2] - lb[0]}" height="${lb[3] - lb[1]}"/>${d.draw(c)}</g>`);
      const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
      if ((c.rot === 90 || c.rot === 270) && !d.generic && b[3] - b[1] > b[2] - b[0])
        out.push(`<text class="ref" x="${b[2] + 4}" y="${cy - 2}">${esc(c.ref)}</text><text class="val" x="${b[2] + 4}" y="${cy + 8}">${esc(c.value)}</text>`);
      else
        out.push(`<text class="ref" x="${cx}" y="${b[1] - 5}" text-anchor="middle">${esc(c.ref)}</text><text class="val" x="${cx}" y="${b[3] + 12}" text-anchor="middle">${esc(c.value)}</text>`);
      for (const p of Model.pinsWorld(c)) {
        if (p.show) {
          const tx = p.ax - p.dx * 4, ty = p.ay - p.dy * 4;
          const anchor = p.dx < 0 ? 'start' : p.dx > 0 ? 'end' : 'middle';
          out.push(`<text class="pinname" x="${tx}" y="${ty + (p.dy < 0 ? 8 : p.dy > 0 ? -2 : 3)}" text-anchor="${anchor}">${esc(p.name)}</text>`);
          if (p.len >= 20) out.push(`<text class="pinnum" x="${(p.x + p.ax) / 2}" y="${(p.y + p.ay) / 2 - 2}" text-anchor="middle">${esc(p.num)}</text>`);
        }
        out.push(`<circle class="pinhit${ui.pending === p.key ? ' pend' : ''}${idx[p.key] ? '' : ' open'}" data-pin="${esc(p.key)}" cx="${p.x}" cy="${p.y}" r="3.5"><title>${esc(p.key)} ${esc(p.name)}${idx[p.key] ? ' → ' + esc(idx[p.key]) : ''}</title></circle>`);
      }
      out.push('</g>');
    }
    if (ui.pending && pinPos[ui.pending]) {
      const p = pinPos[ui.pending];
      out.push(`<path class="rubber" d="M${p.x} ${p.y}L${ui.mouse.x} ${p.y}L${ui.mouse.x} ${ui.mouse.y}"/>`);
    }
    if (!S.components.length) out.push('<text class="empty" x="0" y="0" text-anchor="middle">Add parts from the left panel — or ask the AI Copilot to design a circuit</text>');
    world.innerHTML = out.join('');
  }

  function extents() {
    const S = Model.S; if (!S.components.length) return [-200, -120, 200, 120];
    let b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const c of S.components) { const a = Model.bbox(c); b = [Math.min(b[0], a[0]), Math.min(b[1], a[1]), Math.max(b[2], a[2]), Math.max(b[3], a[3])]; }
    return b;
  }
  const fit = () => vp.fit(extents(), 40);

  // ---------- interaction ----------
  function select(ref, net) { ui.sel = ref || null; ui.selNet = net || null; ui.onSelect(ui.sel, ui.selNet); render(); }
  function down(e) {
    const pt = vp.toWorld(e.clientX, e.clientY);
    if (e.button === 1 || e.button === 2) { ui.pan = { x: e.clientX, y: e.clientY }; e.preventDefault(); return; }
    const pinEl = e.target.closest('[data-pin]'), compEl = e.target.closest('[data-ref]'), netEl = e.target.closest('[data-net]');
    if (pinEl) {
      const k = pinEl.dataset.pin;
      if (ui.pending && ui.pending !== k) {
        const a = ui.pending; ui.pending = null;
        try { const n = Model.mutate(() => Model.connect(null, [a, k])); select(null, n); } catch (err) { App.toast(err.message); }
      } else { ui.pending = ui.pending === k ? null : k; render(); }
      return;
    }
    if (ui.pending) { ui.pending = null; render(); }
    if (compEl) {
      const c = Model.comp(compEl.dataset.ref);
      select(c.ref);
      ui.drag = { ref: c.ref, ox: pt.x - c.x, oy: pt.y - c.y, moved: false };
    } else if (netEl) select(null, netEl.dataset.net);
    else { select(null); ui.pan = { x: e.clientX, y: e.clientY }; }
  }
  function move(e) {
    if (!svg || svg.classList.contains('hidden')) return;
    if (ui.pan) { vp.panBy(e.clientX - ui.pan.x, e.clientY - ui.pan.y); ui.pan = { x: e.clientX, y: e.clientY }; return; }
    const pt = vp.toWorld(e.clientX, e.clientY); ui.mouse = pt;
    if (ui.drag) {
      const c = Model.comp(ui.drag.ref); if (!c) return;
      const nx = Math.round((pt.x - ui.drag.ox) / 10) * 10, ny = Math.round((pt.y - ui.drag.oy) / 10) * 10;
      if (nx !== c.x || ny !== c.y) { if (!ui.drag.moved) { Model.begin(); ui.drag.moved = true; } c.x = nx; c.y = ny; Model.emit('move'); }
    } else if (ui.pending) render();
  }
  function up() { if (ui.drag && ui.drag.moved) Model.emit('change'); ui.drag = null; ui.pan = null; }

  function key(e) {
    if (e.key === 'Escape') { ui.pending = null; select(null); return true; }
    if ((e.key === 'r' || e.key === 'R') && ui.sel) { Model.mutate(() => { const c = Model.comp(ui.sel); c.rot = ((c.rot || 0) + 90) % 360; }); return true; }
    if ((e.key === 'Delete' || e.key === 'Backspace')) {
      if (ui.sel) { const r = ui.sel; select(null); Model.mutate(() => Model.removeComponent(r)); return true; }
      if (ui.selNet) { const n = ui.selNet; select(null); Model.mutate(() => Model.removeNet(n)); return true; }
    }
    return false;
  }
  function placeNew(type) {
    const vb = vp.vb || [0, 0, 0, 0];
    const c = Model.mutate(() => Model.addComponent({ type, x: vb[0] + vb[2] / 2, y: vb[1] + vb[3] / 2 }));
    select(c.ref);
  }
  function exportSVG() {
    const b = extents(), pad = 30, w = b[2] - b[0] + 2 * pad, h = b[3] - b[1] + 2 * pad;
    const css = `.wire{stroke:#0a7a3a;stroke-width:1.5;fill:none}.hitw,.hit,.pinhit{display:none}.comp path,.comp rect,.comp circle{stroke:#9b1b1b;stroke-width:1.5;fill:none}.comp .body{fill:#fff8e6}.comp .fill{fill:#9b1b1b}.comp .thick{stroke-width:2.5}text{font:8px sans-serif;fill:#333}.ref{fill:#1c4a8a;font-weight:600}.val{fill:#555}.pinname,.pinnum{font-size:6px}.netlabel,.netname,.pwrtxt{fill:#0a7a3a;font-weight:600}.junc{fill:#0a7a3a}.dangle,.rubber,.empty{display:none}`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b[0] - pad} ${b[1] - pad} ${w} ${h}" width="${w * 2}" height="${h * 2}"><style>${css}</style><rect x="${b[0] - pad}" y="${b[1] - pad}" width="${w}" height="${h}" fill="#fff"/>${world.innerHTML}</svg>`;
  }
  return { init, render, fit, key, select, placeNew, exportSVG, ui, get vp() { return vp; } };
})();
