'use strict';
// PCB: auto-placement, 2-layer grid autorouter (A*), rendering/editing, Gerber + Excellon export.
const Pcb = (() => {
  const G = 0.25, TRACE = 0.25, VIA_D = 0.6, VIA_DRILL = 0.3, EDGE = 0.5;
  let svg, world, grid, vp;
  const ui = { sel: null, drag: null, pan: null, show: { F: true, B: true, rats: true, silk: true }, onSelect: () => { } };

  // ---------- geometry ----------
  function padsOf(c, idx) {
    const fp = Lib.footprint(c.footprint); if (!fp || !c.pcb) return [];
    const r = c.pcb.rot || 0, sw = r === 90 || r === 270;
    return fp.pads.map(p => {
      const [x, y] = Lib.rot(p.x, p.y, r), key = c.ref + '.' + p.num;
      return { ...p, x: c.pcb.x + x, y: c.pcb.y + y, w: sw ? p.h : p.w, h: sw ? p.w : p.h, key, ref: c.ref, net: idx ? idx[key] : undefined };
    });
  }
  function fpBox(c, pad = 0) {
    const fp = Lib.footprint(c.footprint), b = Lib.rotBox(fp.box, c.pcb.rot || 0);
    return [c.pcb.x + b[0] - pad, c.pcb.y + b[1] - pad, c.pcb.x + b[2] + pad, c.pcb.y + b[3] + pad];
  }
  const placed = () => Model.S.components.filter(c => c.pcb && Lib.footprint(c.footprint));

  // ---------- auto placement ----------
  function autoPlace(opt = {}) {
    const S = Model.S, cs = S.components.filter(c => Lib.footprint(c.footprint));
    if (!cs.length) throw new Error('No components with footprints to place');
    const k = 0.085, gap = 1.0;
    for (const c of cs) c.pcb = { x: c.x * k, y: c.y * k, rot: c.rot || 0 };
    const half = c => { const b = Lib.rotBox(Lib.footprint(c.footprint).box, c.pcb.rot); return [(b[2] - b[0]) / 2, (b[3] - b[1]) / 2, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; };
    for (let it = 0; it < 400; it++) {
      let moved = false;
      for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
        const a = cs[i], b = cs[j], ha = half(a), hb = half(b);
        const dx = (b.pcb.x + hb[2]) - (a.pcb.x + ha[2]), dy = (b.pcb.y + hb[3]) - (a.pcb.y + ha[3]);
        const ox = ha[0] + hb[0] + gap - Math.abs(dx), oy = ha[1] + hb[1] + gap - Math.abs(dy);
        if (ox > 0 && oy > 0) {
          moved = true;
          if (ox < oy) { const s = (dx >= 0 ? 1 : -1) * ox / 2; a.pcb.x -= s; b.pcb.x += s; }
          else { const s = (dy >= 0 ? 1 : -1) * oy / 2; a.pcb.y -= s; b.pcb.y += s; }
        }
      }
      if (!moved) break;
    }
    let b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const c of cs) { const a = fpBox(c); b = [Math.min(b[0], a[0]), Math.min(b[1], a[1]), Math.max(b[2], a[2]), Math.max(b[3], a[3])]; }
    const m = opt.margin ?? 3;
    let W = Math.ceil(b[2] - b[0] + 2 * m), H = Math.ceil(b[3] - b[1] + 2 * m);
    let ox = m - b[0], oy = m - b[1];
    if (opt.w && opt.h) {
      if (opt.w >= W && opt.h >= H) { ox += (opt.w - W) / 2; oy += (opt.h - H) / 2; }
      W = Math.max(W, opt.w); H = Math.max(H, opt.h);
    }
    for (const c of cs) { c.pcb.x = Math.round((c.pcb.x + ox) / G) * G; c.pcb.y = Math.round((c.pcb.y + oy) / G) * G; }
    S.board = { w: W, h: H };
    S.pcb = { traces: [], vias: [], routed: {} };
    return { board: S.board, placed: cs.length };
  }

  // ---------- autorouter ----------
  class Heap {
    constructor() { this.f = []; this.s = []; }
    push(f, s) { const F = this.f, S = this.s; let i = F.length; F.push(f); S.push(s); while (i > 0) { const p = (i - 1) >> 1; if (F[p] <= f) break; F[i] = F[p]; S[i] = S[p]; i = p; } F[i] = f; S[i] = s; }
    pop() {
      const F = this.f, S = this.s, top = S[0], lf = F.pop(), ls = S.pop(), n = F.length;
      if (n) { let i = 0; for (; ;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && F[c + 1] < F[c]) c++; if (F[c] >= lf) break; F[i] = F[c]; S[i] = S[c]; i = c; } F[i] = lf; S[i] = ls; }
      return top;
    }
    get size() { return this.f.length; }
  }

  function route(opt = {}) {
    const S = Model.S, cs = placed();
    if (!cs.length || !S.board.w) throw new Error('Place the components first (generate_pcb / Auto-place)');
    const W = Math.floor(S.board.w / G) + 1, H = Math.floor(S.board.h / G) + 1, N = W * H;
    const idx = Model.pinIndex(), netNames = Object.keys(S.nets), netId = {};
    netNames.forEach((n, i) => netId[n] = i + 1);
    const base = new Int32Array(2 * N), padOf = new Int32Array(2 * N);
    const ek = Math.ceil(EDGE / G);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x < ek || y < ek || x >= W - ek || y >= H - ek) { base[y * W + x] = -1; base[N + y * W + x] = -1; }
    const allPads = [];
    for (const c of cs) for (const p of padsOf(c, idx)) {
      p.id = p.net ? netId[p.net] : -2; p.layers = p.drill ? [0, 1] : [0]; p.cells = [];
      const x0 = Math.ceil((p.x - p.w / 2) / G), x1 = Math.floor((p.x + p.w / 2) / G), y0 = Math.ceil((p.y - p.h / 2) / G), y1 = Math.floor((p.y + p.h / 2) / G);
      const cells = [];
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (x >= 0 && y >= 0 && x < W && y < H) cells.push(y * W + x);
      const cxg = Math.round(p.x / G), cyg = Math.round(p.y / G);
      if (!cells.length && cxg >= 0 && cyg >= 0 && cxg < W && cyg < H) cells.push(cyg * W + cxg);
      for (const l of p.layers) for (const cell of cells) { base[l * N + cell] = p.id; padOf[l * N + cell] = allPads.length + 1; p.cells.push(l * N + cell); }
      allPads.push(p);
    }
    const jobs = netNames.map(n => {
      const pads = allPads.filter(p => p.net === n);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of pads) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
      return { net: n, id: netId[n], pads, hpwl: (x1 - x0) + (y1 - y0) };
    }).filter(j => j.pads.length >= 2);
    if (!jobs.length) { S.pcb = { traces: [], vias: [], routed: {} }; return { routed: 0, total: 0, failed: [] }; }

    const g = new Float32Array(2 * N), came = new Int32Array(2 * N), closed = new Uint8Array(2 * N), tmask = new Uint8Array(2 * N);
    const DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1], DC = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

    function runAttempt(order) {
      const occ = base.slice(), traces = [], vias = [], routed = {}, failed = [];
      const free = (l, x, y, id, r) => {
        for (let dy = -r; dy <= r; dy++) { const yy = y + dy; if (yy < 0 || yy >= H) return false; for (let dx = -r; dx <= r; dx++) { const xx = x + dx; if (xx < 0 || xx >= W) return false; const v = occ[l * N + yy * W + xx]; if (v !== 0 && v !== id) return false; } }
        return true;
      };
      function astar(sources, target, id) {
        g.fill(Infinity); closed.fill(0); tmask.fill(0);
        for (const t of target.cells) tmask[t] = 1;
        const tx = target.x / G, ty = target.y / G, heap = new Heap();
        const hfn = s => { const i = s % N, x = i % W, y = (i / W) | 0, dx = Math.abs(x - tx), dy = Math.abs(y - ty); return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy); };
        for (const s of sources) { g[s] = 0; came[s] = -1; heap.push(hfn(s), s); }
        let expanded = 0;
        while (heap.size) {
          const s = heap.pop(); if (closed[s]) continue; closed[s] = 1;
          if (tmask[s]) { const path = []; for (let c = s; c !== -1; c = came[c]) path.push(c); return path.reverse(); }
          if (++expanded > 600000) return null;
          const l = s >= N ? 1 : 0, i = s - l * N, x = i % W, y = (i / W) | 0, gs = g[s];
          for (let d = 0; d < 8; d++) {
            const nx = x + DX[d], ny = y + DY[d]; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const ns = l * N + ny * W + nx; if (closed[ns]) continue;
            if (!free(l, nx, ny, id, 1)) continue;
            const ng = gs + DC[d] + (l ? 0.15 : 0);
            if (ng < g[ns]) { g[ns] = ng; came[ns] = s; heap.push(ng + hfn(ns), ns); }
          }
          const os = (1 - l) * N + i;
          if (!closed[os] && free(0, x, y, id, 2) && free(1, x, y, id, 2)) {
            const ng = gs + 12; if (ng < g[os]) { g[os] = ng; came[os] = s; heap.push(ng + hfn(os), os); }
          }
        }
        return null;
      }
      for (const job of order) {
        const { id, pads } = job;
        const tree = new Set(pads[0].cells), done = [pads[0]], rest = pads.slice(1), segs = [], vs = [];
        let ok = true;
        while (rest.length) {
          let bi = 0, bd = Infinity;
          rest.forEach((p, i) => { for (const q of done) { const d = Math.hypot(p.x - q.x, p.y - q.y); if (d < bd) { bd = d; bi = i; } } });
          const target = rest.splice(bi, 1)[0];
          if (target.cells.some(c => tree.has(c))) { done.push(target); continue; }
          const path = astar([...tree], target, id);
          if (!path) { ok = false; continue; }
          // commit path
          let run = [], runL = path[0] >= N ? 1 : 0;
          const pt = s => { const i = s % N; return [(i % W) * G, ((i / W) | 0) * G]; };
          const flush = (endPad) => {
            if (run.length) {
              let pts = run.map(pt);
              const sp = padOf[run[0]]; if (sp) { const p = allPads[sp - 1]; pts.unshift([p.x, p.y]); }
              if (endPad) pts.push([endPad.x, endPad.y]);
              const out = [pts[0]];
              for (let k = 1; k < pts.length; k++) {
                const a = out.length > 1 ? out[out.length - 2] : null, b = out[out.length - 1], c = pts[k];
                if (a && Math.abs((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) < 1e-9) out[out.length - 1] = c; else out.push(c);
              }
              if (out.length >= 2) segs.push({ net: job.net, layer: runL ? 'B' : 'F', w: TRACE, pts: out.map(q => [+q[0].toFixed(3), +q[1].toFixed(3)]) });
            }
            run = [];
          };
          for (let k = 0; k < path.length; k++) {
            const s = path[k], l = s >= N ? 1 : 0;
            if (l !== runL) {
              flush(null); const i = s % N, x = i % W, y = (i / W) | 0;
              vs.push({ net: job.net, x: x * G, y: y * G, d: VIA_D, drill: VIA_DRILL });
              for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const c = (y + dy) * W + x + dx; occ[c] = id; occ[N + c] = id; tree.add(c); tree.add(N + c); }
              runL = l; run.push(s);
            } else run.push(s);
            occ[s] = id; tree.add(s);
          }
          flush(target);
          for (const c of target.cells) tree.add(c);
          done.push(target);
        }
        traces.push(...segs); vias.push(...vs);
        if (ok) routed[job.net] = true; else failed.push(job.net);
      }
      return { traces, vias, routed, failed };
    }

    let order = jobs.slice().sort((a, b) => a.hpwl - b.hpwl), best = null;
    const tries = opt.tries || 4;
    for (let t = 0; t < tries; t++) {
      const r = runAttempt(order);
      if (!best || r.failed.length < best.failed.length) best = r;
      if (!r.failed.length) break;
      const f = new Set(r.failed);
      order = [...order.filter(j => f.has(j.net)), ...order.filter(j => !f.has(j.net))];
    }
    S.pcb = { traces: best.traces, vias: best.vias, routed: best.routed };
    return { routed: Object.keys(best.routed).length, total: jobs.length, failed: best.failed, vias: best.vias.length, board: S.board };
  }

  function status() {
    const S = Model.S, idx = Model.pinIndex(), cs = placed();
    const nets = Object.keys(S.nets).filter(n => cs.flatMap(c => padsOf(c, idx)).filter(p => p.net === n).length >= 2);
    const routed = nets.filter(n => S.pcb.routed[n]);
    let len = 0; for (const t of S.pcb.traces) for (let i = 1; i < t.pts.length; i++) len += Math.hypot(t.pts[i][0] - t.pts[i - 1][0], t.pts[i][1] - t.pts[i - 1][1]);
    return { placed: cs.length, components: S.components.length, board: S.board, nets: nets.length, routed: routed.length, unrouted: nets.filter(n => !S.pcb.routed[n]), vias: S.pcb.vias.length, trace_length_mm: +len.toFixed(1) };
  }

  // ---------- view ----------
  function init(el) {
    svg = el;
    svg.innerHTML = `<defs><pattern id="pgrid" width="1.27" height="1.27" patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r="0.06" class="griddot"/></pattern></defs><rect id="pgridr" fill="url(#pgrid)"/><g id="pworld"></g>`;
    world = svg.querySelector('#pworld'); grid = svg.querySelector('#pgridr');
    vp = new Viewport(svg, { min: 2, max: 200, scale: 10, onChange: vb => { grid.setAttribute('x', vb[0]); grid.setAttribute('y', vb[1]); grid.setAttribute('width', vb[2]); grid.setAttribute('height', vb[3]); } });
    svg.addEventListener('mousedown', down); window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  }
  const padSvg = (p, cls) => {
    let s;
    if (p.shape === 'round') s = `<circle class="${cls}" cx="${p.x}" cy="${p.y}" r="${p.w / 2}"/>`;
    else s = `<rect class="${cls}" x="${p.x - p.w / 2}" y="${p.y - p.h / 2}" width="${p.w}" height="${p.h}" rx="${p.shape === 'rect' ? 0.05 : Math.min(p.w, p.h) / 2}"/>`;
    if (p.drill) s += `<circle class="drill" cx="${p.x}" cy="${p.y}" r="${p.drill / 2}"/>`;
    return s;
  };
  function ratsnest() {
    const S = Model.S, idx = Model.pinIndex(), lines = [], pads = placed().flatMap(c => padsOf(c, idx));
    for (const n of Object.keys(S.nets)) {
      if (S.pcb.routed[n]) continue;
      const ps = pads.filter(p => p.net === n); if (ps.length < 2) continue;
      const inT = [ps[0]], rest = ps.slice(1);
      while (rest.length) {
        let bi = 0, bj = 0, bd = Infinity;
        rest.forEach((p, i) => inT.forEach((q, j) => { const d = Math.hypot(p.x - q.x, p.y - q.y); if (d < bd) { bd = d; bi = i; bj = j; } }));
        lines.push([inT[bj], rest[bi]]); inT.push(rest.splice(bi, 1)[0]);
      }
    }
    return lines;
  }
  function render() {
    const S = Model.S, out = [], idx = Model.pinIndex(), cs = placed();
    if (!cs.length || !S.board.w) { world.innerHTML = '<text class="empty" x="0" y="0" text-anchor="middle" style="font-size:2.4px">No PCB yet — click “Generate PCB” or ask the Copilot to make the board</text>'; return; }
    out.push(`<rect class="board" x="0" y="0" width="${S.board.w}" height="${S.board.h}" rx="0.5"/>`);
    const tr = l => S.pcb.traces.filter(t => t.layer === l).map(t => `<polyline class="trace ${l}" stroke-width="${t.w}" points="${t.pts.map(p => p.join(',')).join(' ')}"><title>${esc(t.net)}</title></polyline>`).join('');
    if (ui.show.B) out.push(`<g class="layerB">${tr('B')}</g>`);
    if (ui.show.F) out.push(`<g class="layerF">${tr('F')}</g>`);
    for (const c of cs) {
      out.push(`<g class="fp${ui.sel === c.ref ? ' sel' : ''}" data-ref="${esc(c.ref)}">`);
      const b = fpBox(c);
      out.push(`<rect class="fphit" x="${b[0]}" y="${b[1]}" width="${b[2] - b[0]}" height="${b[3] - b[1]}"/>`);
      if (ui.show.silk) {
        out.push(`<rect class="silk" x="${b[0]}" y="${b[1]}" width="${b[2] - b[0]}" height="${b[3] - b[1]}"/>`);
        out.push(`<text class="silktxt" x="${(b[0] + b[2]) / 2}" y="${b[1] - 0.35}" text-anchor="middle">${esc(c.ref)}</text>`);
      }
      for (const p of padsOf(c, idx)) {
        if (!p.drill && !ui.show.F) continue;
        out.push(padSvg(p, p.drill ? 'pad tht' : 'pad smd').replace('/>', `><title>${esc(p.key)}${p.net ? ' · ' + esc(p.net) : ''}</title></${p.shape === 'round' ? 'circle' : 'rect'}>`));
      }
      out.push('</g>');
    }
    for (const v of S.pcb.vias) out.push(`<circle class="via" cx="${v.x}" cy="${v.y}" r="${v.d / 2}"/><circle class="drill" cx="${v.x}" cy="${v.y}" r="${v.drill / 2}"/>`);
    if (ui.show.rats) for (const [a, b] of ratsnest()) out.push(`<line class="rats" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`);
    world.innerHTML = out.join('');
  }
  const fit = () => { const S = Model.S; vp.fit(S.board.w ? [0, 0, S.board.w, S.board.h] : [-30, -20, 30, 20], 4); };
  function down(e) {
    const pt = vp.toWorld(e.clientX, e.clientY);
    if (e.button !== 0) { ui.pan = { x: e.clientX, y: e.clientY }; e.preventDefault(); return; }
    const el = e.target.closest('[data-ref]');
    if (el) { const c = Model.comp(el.dataset.ref); ui.sel = c.ref; ui.onSelect(c.ref); ui.drag = { ref: c.ref, ox: pt.x - c.pcb.x, oy: pt.y - c.pcb.y, moved: false }; render(); }
    else { ui.sel = null; ui.onSelect(null); ui.pan = { x: e.clientX, y: e.clientY }; render(); }
  }
  function move(e) {
    if (!svg || svg.classList.contains('hidden')) return;
    if (ui.pan) { vp.panBy(e.clientX - ui.pan.x, e.clientY - ui.pan.y); ui.pan = { x: e.clientX, y: e.clientY }; return; }
    if (!ui.drag) return;
    const pt = vp.toWorld(e.clientX, e.clientY), c = Model.comp(ui.drag.ref); if (!c) return;
    const nx = Math.round((pt.x - ui.drag.ox) / G) * G, ny = Math.round((pt.y - ui.drag.oy) / G) * G;
    if (nx !== c.pcb.x || ny !== c.pcb.y) {
      if (!ui.drag.moved) { Model.begin(); ui.drag.moved = true; Model.invalidate(Model.netsOfComp(c.ref)); }
      c.pcb.x = nx; c.pcb.y = ny; Model.emit('move');
    }
  }
  function up() { if (ui.drag && ui.drag.moved) Model.emit('change'); ui.drag = null; ui.pan = null; }
  function key(e) {
    const c = ui.sel && Model.comp(ui.sel);
    if ((e.key === 'r' || e.key === 'R') && c && c.pcb) { Model.mutate(() => { c.pcb.rot = ((c.pcb.rot || 0) + 90) % 360; Model.invalidate(Model.netsOfComp(c.ref)); }); return true; }
    if (e.key === 'Escape') { ui.sel = null; render(); return true; }
    return false;
  }

  // ---------- fabrication outputs ----------
  function gerbers() {
    const S = Model.S, idx = Model.pinIndex(), cs = placed(), Hb = S.board.h;
    if (!cs.length || !S.board.w) throw new Error('No PCB to export');
    const pads = cs.flatMap(c => padsOf(c, idx));
    const C = v => Math.round(v * 1e6), X = (x, y) => `X${C(x)}Y${C(Hb - y)}`;
    function file(func, draw) {
      const ap = new Map(); let next = 10;
      const A = def => { if (!ap.has(def)) ap.set(def, next++); return 'D' + ap.get(def); };
      const body = []; draw(A, body);
      const head = [`G04 CircuitPilot*`, `%TF.FileFunction,${func}*%`, '%FSLAX46Y46*%', '%MOMM*%', '%LPD*%'];
      for (const [d, n] of ap) head.push(`%ADD${n}${d}*%`);
      return head.concat(body, ['M02*']).join('\n') + '\n';
    }
    const f6 = v => v.toFixed(6);
    const padAp = (p, grow = 0) => p.shape === 'round' ? `C,${f6(p.w + grow)}` : p.shape === 'oval' ? `O,${f6(p.w + grow)}X${f6(p.h + grow)}` : `R,${f6(p.w + grow)}X${f6(p.h + grow)}`;
    const copper = (layer, func) => file(func, (A, b) => {
      for (const t of S.pcb.traces.filter(t => t.layer === layer)) {
        b.push(A(`C,${f6(t.w)}`) + '*'); b.push(X(...t.pts[0]) + 'D02*'); for (const p of t.pts.slice(1)) b.push(X(...p) + 'D01*');
      }
      for (const p of pads) if (p.drill || layer === 'F') { b.push(A(padAp(p)) + '*'); b.push(X(p.x, p.y) + 'D03*'); }
      for (const v of S.pcb.vias) { b.push(A(`C,${f6(v.d)}`) + '*'); b.push(X(v.x, v.y) + 'D03*'); }
    });
    const mask = (layer, func) => file(func, (A, b) => { for (const p of pads) if (p.drill || layer === 'F') { b.push(A(padAp(p, 0.1)) + '*'); b.push(X(p.x, p.y) + 'D03*'); } });
    const rectPath = (b, x0, y0, x1, y1) => { b.push(X(x0, y0) + 'D02*'); b.push(X(x1, y0) + 'D01*'); b.push(X(x1, y1) + 'D01*'); b.push(X(x0, y1) + 'D01*'); b.push(X(x0, y0) + 'D01*'); };
    const files = {
      'board-F_Cu.gtl': copper('F', 'Copper,L1,Top'),
      'board-B_Cu.gbl': copper('B', 'Copper,L2,Bot'),
      'board-F_Mask.gts': mask('F', 'Soldermask,Top'),
      'board-B_Mask.gbs': mask('B', 'Soldermask,Bot'),
      'board-F_Silkscreen.gto': file('Legend,Top', (A, b) => { b.push(A('C,0.150000') + '*'); for (const c of cs) { const bb = fpBox(c); rectPath(b, bb[0], bb[1], bb[2], bb[3]); } }),
      'board-Edge_Cuts.gm1': file('Profile,NP', (A, b) => { b.push(A('C,0.100000') + '*'); rectPath(b, 0, 0, S.board.w, S.board.h); }),
    };
    const holes = [...pads.filter(p => p.drill).map(p => ({ x: p.x, y: p.y, d: p.drill })), ...S.pcb.vias.map(v => ({ x: v.x, y: v.y, d: v.drill }))];
    const tools = [...new Set(holes.map(h => h.d.toFixed(3)))];
    let drl = 'M48\n; CircuitPilot drill file\nMETRIC,TZ\n' + tools.map((d, i) => `T${i + 1}C${d}`).join('\n') + '\n%\nG90\nG05\n';
    tools.forEach((d, i) => { drl += `T${i + 1}\n`; for (const h of holes.filter(h => h.d.toFixed(3) === d)) drl += `X${h.x.toFixed(3)}Y${(Hb - h.y).toFixed(3)}\n`; });
    files['board-PTH.drl'] = drl + 'M30\n';
    return files;
  }
  function exportSVG() {
    const S = Model.S, css = `.board{fill:#0b3d1e}.trace{fill:none;stroke-linecap:round;stroke-linejoin:round}.trace.F{stroke:#c83434}.trace.B{stroke:#3a6fd8;opacity:.8}.pad{fill:#d4a72c}.via{fill:#b0b0b0}.drill{fill:#111}.silk{fill:none;stroke:#eee;stroke-width:.12}.silktxt{fill:#eee;font:1px sans-serif}.fphit,.rats{display:none}`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${S.board.w + 4} ${S.board.h + 4}" width="${(S.board.w + 4) * 10}" height="${(S.board.h + 4) * 10}"><style>${css}</style>${world.innerHTML}</svg>`;
  }
  return { init, render, fit, key, autoPlace, route, status, gerbers, exportSVG, ui, padsOf, get vp() { return vp; } };
})();

// Minimal ZIP (store, no compression) writer.
function makeZip(files) {
  const enc = new TextEncoder(), table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  const crc = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = table[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const parts = [], cd = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const nb = enc.encode(name), db = enc.encode(text), cr = crc(db);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(10, 0, true); h.setUint16(12, 33, true);
    h.setUint32(14, cr, true); h.setUint32(18, db.length, true); h.setUint32(22, db.length, true); h.setUint16(26, nb.length, true);
    parts.push(new Uint8Array(h.buffer), nb, db);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(14, 33, true);
    c.setUint32(16, cr, true); c.setUint32(20, db.length, true); c.setUint32(24, db.length, true); c.setUint16(28, nb.length, true); c.setUint32(42, off, true);
    cd.push(new Uint8Array(c.buffer), nb);
    off += 30 + nb.length + db.length;
  }
  const cdSize = cd.reduce((s, a) => s + a.length, 0), e = new DataView(new ArrayBuffer(22)), n = Object.keys(files).length;
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, n, true); e.setUint16(10, n, true); e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...cd, new Uint8Array(e.buffer)], { type: 'application/zip' });
}
