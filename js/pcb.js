'use strict';
// PCB: auto-placement, design rules (JLCPCB defaults), rule-driven 2-layer autorouter (A*), DRC, rendering, Gerber + Excellon export.
const Pcb = (() => {
  const G = 0.25; // placement snap (mm); routing grid comes from the design rules
  let svg, world, grid, vp;
  const ui = { sel: null, drag: null, pan: null, drc: null, show: { F: true, B: true, rats: true, silk: true }, onSelect: () => { } };

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

  // ---------- design rules ----------
  // Defaults follow JLCPCB's standard 2-layer (1 oz) capabilities; verify current limits at jlcpcb.com/capabilities.
  const JLC_MIN = { minTraceWidth: 0.127, minClearance: 0.127, minViaDrill: 0.3, minViaDiameter: 0.5, minAnnularRing: 0.13, minHoleToHole: 0.5, minEdgeClearance: 0.3, minHoleSize: 0.3 };
  const RULE_PRESETS = {
    jlcpcb: { label: 'JLCPCB 2-layer — recommended', values: { traceWidth: 0.25, powerTraceWidth: 0.5, clearance: 0.2, viaDiameter: 0.6, viaDrill: 0.3, edgeClearance: 0.3, layers: 2, neckDown: true, ...JLC_MIN } },
    jlcpcb_min: { label: 'JLCPCB 2-layer — minimum (5/5 mil)', values: { traceWidth: 0.127, powerTraceWidth: 0.3, clearance: 0.127, viaDiameter: 0.56, viaDrill: 0.3, edgeClearance: 0.3, layers: 2, neckDown: true, ...JLC_MIN } },
    jlcpcb_power: { label: 'JLCPCB 2-layer — power / robust', values: { traceWidth: 0.3, powerTraceWidth: 0.8, clearance: 0.25, viaDiameter: 0.8, viaDrill: 0.4, edgeClearance: 0.5, layers: 2, neckDown: true, ...JLC_MIN } },
    home: { label: 'Home etching / CNC milling (1 layer)', values: { traceWidth: 0.4, powerTraceWidth: 0.8, clearance: 0.4, viaDiameter: 1.2, viaDrill: 0.6, edgeClearance: 1.0, layers: 1, neckDown: true, minTraceWidth: 0.3, minClearance: 0.3, minViaDrill: 0.5, minViaDiameter: 1.0, minAnnularRing: 0.25, minHoleToHole: 0.8, minEdgeClearance: 0.8, minHoleSize: 0.6 } },
  };
  function rules() {
    const r = Model.S.rules || {}, p = RULE_PRESETS[r.preset] || RULE_PRESETS.jlcpcb;
    return Object.assign({ preset: 'jlcpcb', netWidths: {} }, p.values, r, { netWidths: Object.assign({}, r.netWidths || {}) });
  }
  const netWidth = (R, net) => +(R.netWidths[net] || (Model.isPower(net) ? R.powerTraceWidth : R.traceWidth));
  // Rules that violate the fab minimums (returned as warnings by setRules / DRC).
  function ruleWarnings(R) {
    const w = [];
    if (R.traceWidth < R.minTraceWidth) w.push(`Trace width ${R.traceWidth} < fab minimum ${R.minTraceWidth} mm`);
    if (R.powerTraceWidth < R.minTraceWidth) w.push(`Power trace width ${R.powerTraceWidth} < fab minimum ${R.minTraceWidth} mm`);
    if (R.clearance < R.minClearance) w.push(`Clearance ${R.clearance} < fab minimum ${R.minClearance} mm`);
    if (R.viaDrill < R.minViaDrill) w.push(`Via drill ${R.viaDrill} < fab minimum ${R.minViaDrill} mm`);
    if (R.viaDiameter < R.minViaDiameter) w.push(`Via diameter ${R.viaDiameter} < fab minimum ${R.minViaDiameter} mm`);
    if ((R.viaDiameter - R.viaDrill) / 2 < R.minAnnularRing - 1e-9) w.push(`Via annular ring ${((R.viaDiameter - R.viaDrill) / 2).toFixed(3)} < fab minimum ${R.minAnnularRing} mm`);
    if (R.edgeClearance < R.minEdgeClearance) w.push(`Edge clearance ${R.edgeClearance} < fab minimum ${R.minEdgeClearance} mm`);
    for (const [n, v] of Object.entries(R.netWidths)) if (+v < R.minTraceWidth) w.push(`Net ${n} width ${v} < fab minimum ${R.minTraceWidth} mm`);
    return w;
  }
  const NUM_KEYS = ['traceWidth', 'powerTraceWidth', 'clearance', 'viaDiameter', 'viaDrill', 'edgeClearance', 'minTraceWidth', 'minClearance', 'minViaDrill', 'minViaDiameter', 'minAnnularRing', 'minHoleToHole', 'minEdgeClearance', 'minHoleSize'];
  // Merge a partial rule update into the project (preset first, then overrides).
  function setRules(u = {}) {
    let base = Model.S.rules || {};
    if (u.preset) { if (!RULE_PRESETS[u.preset]) throw new Error(`Unknown preset "${u.preset}". Presets: ${Object.keys(RULE_PRESETS).join(', ')}`); base = { preset: u.preset, netWidths: base.netWidths || {} }; }
    const next = Object.assign({}, base);
    for (const k of NUM_KEYS) if (u[k] != null && u[k] !== '') { const v = +u[k]; if (!(v > 0 && v < 20)) throw new Error(`${k} must be a positive number in mm`); next[k] = v; }
    if (u.layers != null) { if (![1, 2].includes(+u.layers)) throw new Error('layers must be 1 or 2'); next.layers = +u.layers; }
    if (u.neckDown != null) next.neckDown = !!u.neckDown;
    if (u.netWidths) {
      next.netWidths = Object.assign({}, base.netWidths || {});
      for (const [n, v] of Object.entries(u.netWidths)) { if (v == null || v === '' || +v === 0) delete next.netWidths[n]; else next.netWidths[n] = +v; }
    }
    Model.S.rules = next;
    const R = rules(); return { rules: R, warnings: ruleWarnings(R) };
  }

  // ---------- autorouter (rule-driven, 2-layer grid A*) ----------
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
  // Distance from point to pad copper (rect / round / oval-as-capsule).
  function padDist(p, x, y) {
    if (p.shape === 'round') return Math.hypot(x - p.x, y - p.y) - p.w / 2;
    if (p.shape === 'oval') {
      const r = Math.min(p.w, p.h) / 2, hx = Math.max(0, p.w / 2 - r), hy = Math.max(0, p.h / 2 - r);
      const dx = Math.max(0, Math.abs(x - p.x) - hx), dy = Math.max(0, Math.abs(y - p.y) - hy); return Math.hypot(dx, dy) - r;
    }
    const dx = Math.max(0, Math.abs(x - p.x) - p.w / 2), dy = Math.max(0, Math.abs(y - p.y) - p.h / 2);
    return Math.hypot(dx, dy);
  }

  function route(opt = {}) {
    const S = Model.S, cs = placed(), R = rules();
    if (!cs.length || !S.board.w) throw new Error('Place the components first (generate_pcb / Auto-place)');
    const L = R.layers === 1 ? 1 : 2;
    const minFeature = Math.min(R.traceWidth, R.clearance, ...Object.values(R.netWidths).map(Number).filter(v => v > 0));
    let g = Math.min(0.25, Math.max(0.05, Math.floor(minFeature / 2 / 0.025) * 0.025));
    let W = Math.floor(S.board.w / g) + 1, H = Math.floor(S.board.h / g) + 1;
    while (W * H > 1500000) { g += 0.025; W = Math.floor(S.board.w / g) + 1; H = Math.floor(S.board.h / g) + 1; }
    const N = W * H;
    const idx = Model.pinIndex(), netNames = Object.keys(S.nets), netId = {};
    netNames.forEach((n, i) => netId[n] = i + 1);

    // edge distance per cell (mm)
    const edge = new Float32Array(N);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) edge[y * W + x] = Math.min(x * g, y * g, S.board.w - x * g, S.board.h - y * g);

    // pads: raster cells whose centre lies in the pad (+ nearest cell for tiny pads)
    const allPads = [], padOf = new Int32Array(L * N);
    let orphan = -2;
    for (const c of cs) for (const p of padsOf(c, idx)) {
      p.id = p.net ? netId[p.net] : orphan--;
      p.layers = L === 1 ? [0] : (p.drill ? [0, 1] : [0]);
      p.cells = [];
      const x0 = Math.max(0, Math.floor((p.x - p.w / 2) / g)), x1 = Math.min(W - 1, Math.ceil((p.x + p.w / 2) / g));
      const y0 = Math.max(0, Math.floor((p.y - p.h / 2) / g)), y1 = Math.min(H - 1, Math.ceil((p.y + p.h / 2) / g));
      const cells = [];
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (padDist(p, x * g, y * g) <= 1e-9) cells.push(y * W + x);
      if (!cells.length) { const cx = Math.min(W - 1, Math.max(0, Math.round(p.x / g))), cy = Math.min(H - 1, Math.max(0, Math.round(p.y / g))); cells.push(cy * W + cx); }
      for (const l of p.layers) for (const cell of cells) { p.cells.push(l * N + cell); padOf[l * N + cell] = allPads.length + 1; }
      allPads.push(p);
    }
    const jobs = netNames.map(n => {
      const pads = allPads.filter(p => p.net === n);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of pads) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
      return { net: n, id: netId[n], pads, hpwl: (x1 - x0) + (y1 - y0), w: netWidth(R, n) };
    }).filter(j => j.pads.length >= 2);
    if (!jobs.length) { S.pcb = { traces: [], vias: [], routed: {} }; return { routed: 0, total: 0, failed: [], rules: R.preset }; }

    const maxW = Math.max(R.traceWidth, ...jobs.map(j => j.w));
    const padReach = Math.max(maxW / 2, R.viaDiameter / 2) + R.clearance + R.viaDrill / 2 + R.minHoleToHole;
    for (const p of allPads) {
      const near = [], x0 = Math.max(0, Math.floor((p.x - p.w / 2 - padReach) / g)), x1 = Math.min(W - 1, Math.ceil((p.x + p.w / 2 + padReach) / g));
      const y0 = Math.max(0, Math.floor((p.y - p.h / 2 - padReach) / g)), y1 = Math.min(H - 1, Math.ceil((p.y + p.h / 2 + padReach) / g));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const d = padDist(p, x * g, y * g); if (d >= padReach) continue;
        near.push(y * W + x, d, p.drill ? Math.hypot(x * g - p.x, y * g - p.y) - p.drill / 2 : 99);
      }
      p.near = near;
    }
    const diskCache = {};
    const disk = r => {
      const k = r.toFixed(4); if (diskCache[k]) return diskCache[k];
      const n = Math.ceil(r / g), out = [];
      for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) if ((dx * g) ** 2 + (dy * g) ** 2 < r * r) out.push(dx, dy);
      return (diskCache[k] = out);
    };
    const g2 = new Float64Array(L * N), came = new Int32Array(L * N), closed = new Uint8Array(L * N), tmask = new Uint8Array(L * N);
    const blockT = new Uint8Array(L * N), blockV = new Uint8Array(N), own = new Float32Array(L * N), stamp = new Int32Array(L * N);
    let searchId = 0; const stats = { searches: 0, failed: 0, expanded: 0, maxed: 0 };
    const DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1], DC = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];
    const vr = R.viaDiameter / 2, slack = 0.3 * g;

    function runAttempt(order) {
      const tcells = [], gvias = [], viasOut = [], traces = [], routed = {}, failed = [], necked = new Set();
      const markDisk = (map, layerOff, cx, cy, r, val = 1) => {
        const d = disk(r);
        for (let i = 0; i < d.length; i += 2) { const x = cx + d[i], y = cy + d[i + 1]; if (x >= 0 && y >= 0 && x < W && y < H) { const k = layerOff + y * W + x; if (map[k] < val) map[k] = val; } }
      };
      // Build "where may this net's centreline / vias go" maps for width w.
      function buildMaps(id, w) {
        blockT.fill(0); blockV.fill(0); own.fill(0);
        const eT = R.edgeClearance + w / 2, eV = R.edgeClearance + vr;
        for (let i = 0; i < N; i++) { if (edge[i] < eT) { blockT[i] = 1; if (L > 1) blockT[N + i] = 1; } if (edge[i] < eV) blockV[i] = 1; }
        const rT = w / 2 + R.clearance, rV = vr + R.clearance;
        for (const p of allPads) {
          if (p.id === id) {
            for (const c of p.cells) {
              const i = c % N, px = (i % W) * g, py = ((i / W) | 0) * g;
              const depth = p.shape === 'round' ? p.w / 2 - Math.hypot(px - p.x, py - p.y) : Math.min(p.w / 2 - Math.abs(px - p.x), p.h / 2 - Math.abs(py - p.y));
              const fit = Math.max(0, 2 * depth); if (own[c] < fit) own[c] = fit;
            }
            continue;
          }
          const nr = p.near, hole = R.viaDrill / 2 + R.minHoleToHole;
          for (let k = 0; k < nr.length; k += 3) {
            const i = nr[k], d = nr[k + 1];
            if (d < rT) for (const l of p.layers) blockT[l * N + i] = 1;
            if (d < rV || nr[k + 2] < hole) blockV[i] = 1;
          }
        }
        for (const t of tcells) {
          if (t.id === id) { for (const c of t.cells) if (own[t.l * N + c] < t.w) own[t.l * N + c] = t.w; continue; }
          const r1 = w / 2 + t.w / 2 + R.clearance + slack, r2 = vr + t.w / 2 + R.clearance + slack;
          for (const c of t.cells) { const x = c % W, y = (c / W) | 0; markDisk(blockT, t.l * N, x, y, r1); markDisk(blockV, 0, x, y, r2); }
        }
        for (const v of gvias) {
          if (v.id === id) { for (let l = 0; l < L; l++) markDisk(own, l * N, v.x, v.y, vr, v.d); continue; }
          for (let l = 0; l < L; l++) markDisk(blockT, l * N, v.x, v.y, w / 2 + vr + R.clearance);
          markDisk(blockV, 0, v.x, v.y, Math.max(2 * vr + R.clearance, R.viaDrill + R.minHoleToHole));
        }
      }
      // A* over (layer, cell). own[] = widest trace that fits inside our own copper at that cell.
      function astar(sources, target, w, win) {
        const sid = ++searchId, wt = w - 1e-9; stats.searches++;
        let anyT = false;
        for (const t of target.cells) { stamp[t] = sid; g2[t] = Infinity; closed[t] = 0; tmask[t] = 0; if (own[t] >= wt || !blockT[t]) { tmask[t] = 1; anyT = true; } }
        if (!anyT) return null;
        const [wx0, wy0, wx1, wy1] = win;
        const tx = target.x / g, ty = target.y / g, heap = new Heap(), K = Math.SQRT2 - 1, HW = 1.15;
        let started = 0;
        for (const s0 of sources) {
          if (blockT[s0] && own[s0] < wt) continue;
          if (stamp[s0] !== sid) { stamp[s0] = sid; closed[s0] = 0; tmask[s0] = 0; }
          g2[s0] = 0; came[s0] = -1; started++;
          const i = s0 % N, dx = Math.abs(i % W - tx), dy = Math.abs(((i / W) | 0) - ty);
          heap.push(HW * (Math.max(dx, dy) + K * Math.min(dx, dy)), s0);
        }
        if (!started) return null;
        let expanded = 0; const limit = Math.min(900000, L * N);
        const viaCost = Math.max(8, 2.5 / g), dv = R.viaDiameter - 1e-9;
        while (heap.size) {
          const s = heap.pop(); if (closed[s]) continue; closed[s] = 1;
          if (tmask[s]) { stats.expanded += expanded; const path = []; for (let c = s; c !== -1; c = came[c]) path.push(c); return path.reverse(); }
          if (++expanded > limit) { stats.expanded += expanded; stats.failed++; stats.maxed++; return null; }
          const l = s >= N ? 1 : 0, lo = l * N, i = s - lo, x = i % W, y = (i / W) | 0, gs = g2[s] + (l ? 0.15 : 0);
          for (let d = 0; d < 8; d++) {
            const nx = x + DX[d], ny = y + DY[d]; if (nx < wx0 || ny < wy0 || nx > wx1 || ny > wy1) continue;
            const ns = lo + ny * W + nx;
            if (stamp[ns] !== sid) { stamp[ns] = sid; g2[ns] = Infinity; closed[ns] = 0; tmask[ns] = 0; }
            else if (closed[ns]) continue;
            if (blockT[ns] && own[ns] < wt && !tmask[ns]) continue;
            const ng = gs + DC[d];
            if (ng < g2[ns]) {
              g2[ns] = ng; came[ns] = s;
              const ddx = Math.abs(nx - tx), ddy = Math.abs(ny - ty);
              heap.push(ng + HW * (ddx > ddy ? ddx + K * ddy : ddy + K * ddx), ns);
            }
          }
          if (L > 1 && !blockV[i]) {
            const pad = padOf[i] ? allPads[padOf[i] - 1] : null; // via-in-pad only inside our own pad, where the via fits
            if (!pad || pad.drill || own[i] >= dv) {
              const os = (1 - l) * N + i;
              if (stamp[os] !== sid) { stamp[os] = sid; g2[os] = Infinity; closed[os] = 0; tmask[os] = 0; }
              if (!closed[os]) {
                const ng = g2[s] + viaCost;
                if (ng < g2[os]) { g2[os] = ng; came[os] = s; const ddx = Math.abs(x - tx), ddy = Math.abs(y - ty); heap.push(ng + HW * (ddx > ddy ? ddx + K * ddy : ddy + K * ddx), os); }
              }
            }
          }
        }
        stats.expanded += expanded; stats.failed++;
        return null;
      }
      let jobNo = 0;
      for (const job of order) {
        if (opt.onProgress) opt.onProgress({ net: job.net, done: jobNo, total: order.length, attempt: attemptNo });
        jobNo++;
        const { id, pads } = job;
        const tree = new Set(pads[0].cells), done = [pads[0]], rest = pads.slice(1), segs = [], vs = [];
        let ok = true, mapW = null;
        const widths = [job.w];
        if (R.neckDown) for (const w2 of [R.traceWidth, R.minTraceWidth]) if (w2 < widths[widths.length - 1] - 1e-9) widths.push(w2);
        while (rest.length) {
          let bi = 0, bd = Infinity;
          rest.forEach((p, i) => { for (const q of done) { const d = Math.hypot(p.x - q.x, p.y - q.y); if (d < bd) { bd = d; bi = i; } } });
          const target = rest.splice(bi, 1)[0];
          if (target.cells.some(c => tree.has(c))) { done.push(target); continue; }
          let path = null, w = job.w;
          const src = [...tree];
          let bx0 = target.x / g, by0 = target.y / g, bx1 = bx0, by1 = by0;
          for (const s of src) { const i = s % N, x = i % W, y = (i / W) | 0; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
          const m = Math.ceil(8 / g);
          const small = [Math.max(0, Math.floor(bx0) - m), Math.max(0, Math.floor(by0) - m), Math.min(W - 1, Math.ceil(bx1) + m), Math.min(H - 1, Math.ceil(by1) + m)];
          const full = [0, 0, W - 1, H - 1];
          for (const w2 of widths) {
            if (mapW !== w2) { buildMaps(id, w2); mapW = w2; }
            path = astar(src, target, w2, small);
            if (!path && (small[0] > 0 || small[1] > 0 || small[2] < W - 1 || small[3] < H - 1) && w2 === widths[widths.length - 1]) path = astar(src, target, w2, full);
            if (path) { w = w2; break; }
          }
          if (!path) { ok = false; continue; }
          if (w < job.w - 1e-9) necked.add(job.net);
          // commit
          let run = [], runL = path[0] >= N ? 1 : 0;
          const pt = s => { const i = s % N; return [(i % W) * g, ((i / W) | 0) * g]; };
          const flush = endPad => {
            if (run.length) {
              const pts = run.map(pt);
              const fits = p => Math.min(p.w, p.h) >= w - 1e-9; // only run to the pad centre if the trace fits inside the pad
              const sp = padOf[run[0]]; if (sp && fits(allPads[sp - 1])) { const p = allPads[sp - 1]; pts.unshift([p.x, p.y]); }
              if (endPad && fits(endPad)) pts.push([endPad.x, endPad.y]);
              const out = [pts[0]];
              for (let k = 1; k < pts.length; k++) {
                const a = out.length > 1 ? out[out.length - 2] : null, b = out[out.length - 1], c = pts[k];
                if (a && Math.abs((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) < 1e-9) out[out.length - 1] = c; else out.push(c);
              }
              if (out.length >= 2) segs.push({ net: job.net, layer: runL ? 'B' : 'F', w: +w.toFixed(4), pts: out.map(q => [+q[0].toFixed(4), +q[1].toFixed(4)]) });
              tcells.push({ id, l: runL, w, cells: run.map(s => s % N) });
              for (const s of run) if (own[s] < w) own[s] = w;
            }
            run = [];
          };
          for (let k = 0; k < path.length; k++) {
            const s = path[k], l = s >= N ? 1 : 0;
            if (l !== runL) {
              flush(null); const i = s % N, x = i % W, y = (i / W) | 0;
              vs.push({ net: job.net, x: +(x * g).toFixed(4), y: +(y * g).toFixed(4), d: R.viaDiameter, drill: R.viaDrill });
              gvias.push({ id, x, y, d: R.viaDiameter });
              for (let l2 = 0; l2 < L; l2++) markDisk(own, l2 * N, x, y, vr, R.viaDiameter);
              const dd = disk(vr); for (let q = 0; q < dd.length; q += 2) { const xx = x + dd[q], yy = y + dd[q + 1]; if (xx >= 0 && yy >= 0 && xx < W && yy < H) for (let l2 = 0; l2 < L; l2++) tree.add(l2 * N + yy * W + xx); }
              runL = l;
            }
            run.push(s); tree.add(s);
          }
          flush(target);
          for (const c of target.cells) tree.add(c);
          done.push(target);
        }
        traces.push(...segs); viasOut.push(...vs);
        if (ok) routed[job.net] = true; else failed.push(job.net);
      }
      return { traces, vias: viasOut, routed, failed, necked: [...necked] };
    }

    let order = jobs.slice().sort((a, b) => a.hpwl - b.hpwl), best = null;
    const tries = opt.tries || 2;
    let attemptNo = 0;
    for (let t = 0; t < tries; t++) {
      attemptNo = t + 1;
      const r = runAttempt(order);
      if (!best || r.failed.length < best.failed.length) best = r;
      if (!r.failed.length) break;
      const f = new Set(r.failed);
      order = [...order.filter(j => f.has(j.net)), ...order.filter(j => !f.has(j.net))];
    }
    S.pcb = { traces: best.traces, vias: best.vias, routed: best.routed };
    return { routed: Object.keys(best.routed).length, total: jobs.length, failed: best.failed, necked_down: best.necked, vias: best.vias.length, board: S.board, grid_mm: +g.toFixed(3), search: stats, rules: { preset: R.preset, trace: R.traceWidth, power: R.powerTraceWidth, clearance: R.clearance, via: `${R.viaDiameter}/${R.viaDrill}`, layers: L } };
  }

  // ---------- DRC (exact geometry) ----------
  function segSegDist(a, b, c, d) {
    const inter = (() => {
      const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
      const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
      return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
    })();
    if (inter) return 0;
    return Math.min(ptSeg(a, c, d), ptSeg(b, c, d), ptSeg(c, a, b), ptSeg(d, a, b));
  }
  function ptSeg(p, a, b) {
    const vx = b[0] - a[0], vy = b[1] - a[1], l2 = vx * vx + vy * vy;
    let t = l2 ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2 : 0; t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - a[0] - t * vx, p[1] - a[1] - t * vy);
  }
  const ptRect = (p, r) => Math.hypot(Math.max(0, Math.abs(p[0] - r.cx) - r.hw), Math.max(0, Math.abs(p[1] - r.cy) - r.hh));
  function segRect(a, b, r) {
    const inside = p => Math.abs(p[0] - r.cx) <= r.hw && Math.abs(p[1] - r.cy) <= r.hh;
    if (inside(a) || inside(b)) return 0;
    const C = [[r.cx - r.hw, r.cy - r.hh], [r.cx + r.hw, r.cy - r.hh], [r.cx + r.hw, r.cy + r.hh], [r.cx - r.hw, r.cy + r.hh]];
    let m = Math.min(ptRect(a, r), ptRect(b, r));
    for (let i = 0; i < 4; i++) m = Math.min(m, segSegDist(a, b, C[i], C[(i + 1) % 4]));
    return m;
  }
  // Shapes: {k:'seg',a,b,r} | {k:'circ',c,r} | {k:'rect',cx,cy,hw,hh}
  function shapeDist(A, B) {
    if (A.k === 'rect' && B.k !== 'rect') return shapeDist(B, A);
    if (A.k === 'seg') {
      if (B.k === 'seg') return segSegDist(A.a, A.b, B.a, B.b) - A.r - B.r;
      if (B.k === 'circ') return ptSeg(B.c, A.a, A.b) - A.r - B.r;
      return segRect(A.a, A.b, B) - A.r;
    }
    if (A.k === 'circ') {
      if (B.k === 'seg') return shapeDist(B, A);
      if (B.k === 'circ') return Math.hypot(A.c[0] - B.c[0], A.c[1] - B.c[1]) - A.r - B.r;
      return ptRect(A.c, B) - A.r;
    }
    return Math.hypot(Math.max(0, Math.abs(A.cx - B.cx) - A.hw - B.hw), Math.max(0, Math.abs(A.cy - B.cy) - A.hh - B.hh));
  }
  function padShape(p) {
    if (p.shape === 'round') return { k: 'circ', c: [p.x, p.y], r: p.w / 2 };
    if (p.shape === 'oval') { const r = Math.min(p.w, p.h) / 2, hx = p.w / 2 - r, hy = p.h / 2 - r; return { k: 'seg', a: [p.x - hx, p.y - hy], b: [p.x + hx, p.y + hy], r }; }
    return { k: 'rect', cx: p.x, cy: p.y, hw: p.w / 2, hh: p.h / 2 };
  }
  const bboxOf = s => s.k === 'seg' ? [Math.min(s.a[0], s.b[0]) - s.r, Math.min(s.a[1], s.b[1]) - s.r, Math.max(s.a[0], s.b[0]) + s.r, Math.max(s.a[1], s.b[1]) + s.r]
    : s.k === 'circ' ? [s.c[0] - s.r, s.c[1] - s.r, s.c[0] + s.r, s.c[1] + s.r] : [s.cx - s.hw, s.cy - s.hh, s.cx + s.hw, s.cy + s.hh];

  function drc() {
    const S = Model.S, R = rules(), idx = Model.pinIndex(), cs = placed(), out = [];
    const add = (type, msg, x, y, severity = 'error') => out.push({ type, severity, msg, x: +(+x).toFixed(2), y: +(+y).toFixed(2) });
    for (const w of ruleWarnings(R)) out.push({ type: 'rules', severity: 'warning', msg: w });
    if (!cs.length || !S.board.w) return { violations: out, summary: 'No PCB' };
    const L = R.layers === 1 ? 1 : 2, objs = [];
    let orphan = 0;
    for (const c of cs) for (const p of padsOf(c, idx)) objs.push({ s: padShape(p), net: p.net || '~' + (orphan++), layers: L === 1 ? ['F'] : (p.drill ? ['F', 'B'] : ['F']), what: `pad ${p.key}`, drill: p.drill, x: p.x, y: p.y });
    for (const t of S.pcb.traces) {
      if (t.w < R.minTraceWidth - 1e-6) add('trace-width', `Trace on ${t.net} is ${t.w} mm (fab minimum ${R.minTraceWidth})`, t.pts[0][0], t.pts[0][1]);
      for (let i = 1; i < t.pts.length; i++) objs.push({ s: { k: 'seg', a: t.pts[i - 1], b: t.pts[i], r: t.w / 2 }, net: t.net, layers: [t.layer], what: `trace ${t.net}`, x: (t.pts[i - 1][0] + t.pts[i][0]) / 2, y: (t.pts[i - 1][1] + t.pts[i][1]) / 2 });
    }
    for (const v of S.pcb.vias) {
      objs.push({ s: { k: 'circ', c: [v.x, v.y], r: v.d / 2 }, net: v.net, layers: ['F', 'B'], what: `via ${v.net}`, drill: v.drill, x: v.x, y: v.y });
      if (v.drill < R.minViaDrill - 1e-6) add('via', `Via drill ${v.drill} < ${R.minViaDrill} mm`, v.x, v.y);
      if ((v.d - v.drill) / 2 < R.minAnnularRing - 1e-6) add('via', `Via annular ring ${((v.d - v.drill) / 2).toFixed(3)} < ${R.minAnnularRing} mm`, v.x, v.y);
    }
    const boxes = objs.map(o => bboxOf(o.s));
    // Trace copper that lies inside a pad of the same net adds no copper: measure only the part outside own pads.
    const padsByNet = {};
    for (const o of objs) if (o.what.startsWith('pad')) (padsByNet[o.net] = padsByNet[o.net] || []).push(o.s);
    const inside = (net, c, r) => (padsByNet[net] || []).some(p => p.k === 'rect' ? Math.abs(c[0] - p.cx) <= p.hw - r + 1e-6 && Math.abs(c[1] - p.cy) <= p.hh - r + 1e-6
      : p.k === 'circ' ? Math.hypot(c[0] - p.c[0], c[1] - p.c[1]) <= p.r - r + 1e-6 : ptSeg(c, p.a, p.b) <= p.r - r + 1e-6);
    function refine(A, B, d0) {
      const [T, O] = A.s.k === 'seg' && A.what.startsWith('trace') ? [A, B] : [B, A];
      const { a, b, r } = T.s, len = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(len / 0.02));
      let m = Infinity;
      for (let k = 0; k <= n; k++) {
        const c = [a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n];
        if (inside(T.net, c, r)) continue;
        m = Math.min(m, shapeDist({ k: 'circ', c, r }, O.s));
      }
      return m === Infinity ? Infinity : Math.max(m, d0);
    }
    // board edge
    objs.forEach((o, i) => {
      const b = boxes[i], d = Math.min(b[0], b[1], S.board.w - b[2], S.board.h - b[3]);
      if (d < R.edgeClearance - 1e-3) add('edge', `${o.what} is ${Math.max(0, d).toFixed(3)} mm from the board edge (rule ${R.edgeClearance})`, o.x, o.y, d < R.minEdgeClearance ? 'error' : 'warning');
    });
    // copper clearance + hole spacing
    const seen = new Set(), cl = R.clearance;
    const order = objs.map((o, i) => i).sort((a, b) => boxes[a][0] - boxes[b][0]);
    for (let ii = 0; ii < order.length; ii++) {
      const i = order[ii], A = objs[i], ba = boxes[i];
      for (let jj = ii + 1; jj < order.length; jj++) {
        const j = order[jj], bb = boxes[j];
        if (bb[0] > ba[2] + Math.max(cl, R.minHoleToHole) + 2) break;
        if (bb[1] > ba[3] + cl + 2 || bb[3] < ba[1] - cl - 2) continue;
        const B = objs[j];
        if (A.drill && B.drill && A.what !== B.what) {
          const hd = Math.hypot(A.x - B.x, A.y - B.y) - A.drill / 2 - B.drill / 2;
          if (hd < R.minHoleToHole - 1e-3 && hd > -1e-6 && !(A.what.startsWith('pad') && B.what.startsWith('pad') && A.what.split('.')[0] === B.what.split('.')[0]))
            add('hole', `Holes ${A.what} / ${B.what} are ${hd.toFixed(3)} mm apart (minimum ${R.minHoleToHole})`, (A.x + B.x) / 2, (A.y + B.y) / 2, 'warning');
        }
        if (A.net === B.net || !A.layers.some(l => B.layers.includes(l))) continue;
        let d = shapeDist(A.s, B.s);
        if (d < cl - 1e-3 && (A.s.k === 'seg' && A.what.startsWith('trace') || B.s.k === 'seg' && B.what.startsWith('trace'))) d = refine(A, B, d);
        if (d < cl - 1e-3) {
          const key = [A.what, B.what].sort().join('|'); if (seen.has(key)) continue; seen.add(key);
          const both = A.what.startsWith('pad') && B.what.startsWith('pad');
          add(d <= 0 ? 'short' : 'clearance', `${d <= 0 ? 'Short' : 'Clearance ' + d.toFixed(3) + ' mm'} between ${A.what} and ${B.what} (rule ${cl})`, (A.x + B.x) / 2, (A.y + B.y) / 2,
            both ? 'warning' : (d < R.minClearance || d <= 0 ? 'error' : 'warning'));
        }
      }
    }
    const st = status();
    for (const n of st.unrouted) out.push({ type: 'unrouted', severity: 'warning', msg: `Net ${n} is not routed` });
    const errors = out.filter(v => v.severity === 'error').length, warnings = out.length - errors;
    return { violations: out, errors, warnings, summary: errors ? `${errors} errors, ${warnings} warnings` : warnings ? `0 errors, ${warnings} warnings` : 'DRC passed' };
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
    if (ui.drc) for (const v of ui.drc.violations) if (v.x != null) out.push(`<g class="drcmark ${v.severity}" transform="translate(${v.x} ${v.y})"><circle r="0.9"/><path d="M-0.45 -0.45L0.45 0.45M0.45 -0.45L-0.45 0.45"/><title>${esc(v.msg)}</title></g>`);
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
  return { init, render, fit, key, autoPlace, route, status, gerbers, exportSVG, ui, padsOf, rules, setRules, ruleWarnings, drc, RULE_PRESETS, get vp() { return vp; } };
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
