'use strict';
// PCB: auto-placement, design rules (JLCPCB defaults), rule-driven 2-layer autorouter (A*), DRC, rendering, Gerber + Excellon export.
const Pcb = (() => {
  const G = 0.25; // placement snap (mm); routing grid comes from the design rules

  // ---------- geometry ----------
  // Bottom-side parts are mirrored (x → -x, seen from the top) and their SMD pads sit on BottomLayer.
  const isBottom = c => c.pcb && c.pcb.side === 'B';
  function padsOf(c, idx) {
    const fp = Lib.footprint(c.footprint); if (!fp || !c.pcb) return [];
    const r = c.pcb.rot || 0, sw = r === 90 || r === 270, bot = isBottom(c);
    return fp.pads.map((p, i) => {
      const [x, y] = Lib.rot(bot ? -p.x : p.x, p.y, r), key = c.ref + '.' + p.num;
      return { ...p, x: c.pcb.x + x, y: c.pcb.y + y, w: sw ? p.h : p.w, h: sw ? p.w : p.h, key, uid: c.ref + '#' + i, ref: c.ref, layer: p.drill ? null : (bot ? 'B' : 'F'), net: idx ? idx[key] : undefined };
    });
  }
  function fpBox(c, pad = 0) {
    const fp = Lib.footprint(c.footprint), b0 = fp.box, m = isBottom(c) ? [-b0[2], b0[1], -b0[0], b0[3]] : b0, b = Lib.rotBox(m, c.pcb.rot || 0);
    return [c.pcb.x + b[0] - pad, c.pcb.y + b[1] - pad, c.pcb.x + b[2] + pad, c.pcb.y + b[3] + pad];
  }
  const padCu = (p, L2) => p.drill ? L2 : [p.layer || 'F'];

  // ---------- board outline (rectangle, rounded rectangle, ellipse, custom polygon with rounded corners) ----------
  function filletPoly(pts, r, segs = 10) {
    if (!r || r <= 0 || pts.length < 3) return pts.slice();
    const out = [], n = pts.length;
    for (let i = 0; i < n; i++) {
      const P = pts[i], A = pts[(i - 1 + n) % n], B = pts[(i + 1) % n];
      const ua = [A[0] - P[0], A[1] - P[1]], ub = [B[0] - P[0], B[1] - P[1]], la = Math.hypot(...ua), lb = Math.hypot(...ub);
      if (la < 1e-9 || lb < 1e-9) { out.push(P); continue; }
      ua[0] /= la; ua[1] /= la; ub[0] /= lb; ub[1] /= lb;
      const ang = Math.acos(Math.max(-1, Math.min(1, ua[0] * ub[0] + ua[1] * ub[1])));
      if (ang > Math.PI - 1e-3) { out.push(P); continue; }
      let t = r / Math.tan(ang / 2); t = Math.min(t, la / 2, lb / 2); const rr = t * Math.tan(ang / 2);
      const T1 = [P[0] + ua[0] * t, P[1] + ua[1] * t], T2 = [P[0] + ub[0] * t, P[1] + ub[1] * t];
      const bis = [ua[0] + ub[0], ua[1] + ub[1]], bl = Math.hypot(...bis), dc = rr / Math.sin(ang / 2);
      const C = [P[0] + bis[0] / bl * dc, P[1] + bis[1] / bl * dc];
      let a1 = Math.atan2(T1[1] - C[1], T1[0] - C[0]), a2 = Math.atan2(T2[1] - C[1], T2[0] - C[0]), d = a2 - a1;
      while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      for (let k = 0; k <= segs; k++) { const a = a1 + d * k / segs; out.push([C[0] + rr * Math.cos(a), C[1] + rr * Math.sin(a)]); }
    }
    return out;
  }
  function boardPoly(board = Model.S.board) {
    const w = board.w, h = board.h, sh = board.shape || { type: 'rect' };
    if (sh.type === 'ellipse') { const out = []; for (let k = 0; k < 96; k++) { const a = k / 96 * 2 * Math.PI; out.push([w / 2 + w / 2 * Math.cos(a), h / 2 + h / 2 * Math.sin(a)]); } return out; }
    if (sh.type === 'polygon' && sh.pts && sh.pts.length >= 3) return filletPoly(sh.pts, +sh.r || 0);
    const rect = [[0, 0], [w, 0], [w, h], [0, h]];
    return sh.type === 'rounded' && sh.r > 0 ? filletPoly(rect, Math.min(+sh.r, w / 2, h / 2), 12) : rect;
  }
  const isRectBoard = (board = Model.S.board) => !board.shape || !board.shape.type || board.shape.type === 'rect';
  function inPoly(x, y, poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; }
    return c;
  }
  // signed distance from a shape to the board outline (negative = sticks out of the board)
  function edgeDist(sh, poly) {
    let d = Infinity;
    for (let i = 0; i < poly.length; i++) d = Math.min(d, shapeDist({ k: 'seg', a: poly[i], b: poly[(i + 1) % poly.length], r: 0 }, sh));
    const c = sh.k === 'seg' ? sh.a : sh.k === 'circ' ? sh.c : [sh.cx, sh.cy];
    return inPoly(c[0], c[1], poly) ? d : -d;
  }
  function setBoardShape(o = {}) {
    const S = Model.S, b = S.board;
    const type = o.shape || o.type || 'rect';
    if (!['rect', 'rounded', 'ellipse', 'polygon'].includes(type)) throw new Error('shape must be rect, rounded, ellipse or polygon');
    if (o.width > 0) b.w = +o.width; if (o.height > 0) b.h = +o.height;
    const sh = { type };
    if (type === 'rounded') sh.r = Math.max(0.5, +(o.corner_radius ?? o.r ?? 3));
    if (type === 'polygon') {
      const pts = (o.points || o.pts || []).map(q => [+q[0], +q[1]]);
      if (pts.length < 3) throw new Error('polygon needs at least 3 points');
      const minx = Math.min(...pts.map(q => q[0])), miny = Math.min(...pts.map(q => q[1]));
      if (o.normalize !== false && (minx !== 0 || miny !== 0)) { for (const q of pts) { q[0] -= minx; q[1] -= miny; } for (const c of placed()) { c.pcb.x -= minx; c.pcb.y -= miny; } shiftCopper(-minx, -miny); }
      sh.pts = pts.map(q => [+q[0].toFixed(3), +q[1].toFixed(3)]); sh.r = +(o.corner_radius ?? o.r ?? 0);
      b.w = +Math.max(...sh.pts.map(q => q[0])).toFixed(3); b.h = +Math.max(...sh.pts.map(q => q[1])).toFixed(3);
    }
    b.shape = sh;
    return { board: { w: b.w, h: b.h, shape: sh.type, corner_radius: sh.r }, outside: placed().filter(c => !fpInside(c)).map(c => c.ref) };
  }
  function shiftCopper(dx, dy) {
    const P = Model.S.pcb;
    for (const t of P.traces) t.pts = t.pts.map(q => [q[0] + dx, q[1] + dy]);
    for (const v of P.vias) { v.x += dx; v.y += dy; }
    for (const pr of P.pours || []) if (pr.pts) pr.pts = pr.pts.map(q => [q[0] + dx, q[1] + dy]);
  }
  function fpInside(c) { const b = fpBox(c, -0.1), poly = boardPoly(); return [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].every(q => inPoly(q[0], q[1], poly)); }

  // ---------- copper pours ----------
  const pourPoly = pr => pr.whole || !pr.pts ? boardPoly() : pr.pts;
  // Raster of one pour: cells inside the pour and the board, away from other nets' copper. Labels = connected islands.
  function pourRaster(pr, gStep = 0.2) {
    const S = Model.S, R = rules(), cl = pr.clearance || R.clearance, poly = pourPoly(pr), bpoly = boardPoly(), idx = Model.pinIndex();
    const W = Math.ceil(S.board.w / gStep) + 1, H = Math.ceil(S.board.h / gStep) + 1, N = W * H, ok = new Uint8Array(N);
    const fill = (pl, val) => { for (let y = 0; y < H; y++) { const py = y * gStep, xs = []; for (let i = 0, j = pl.length - 1; i < pl.length; j = i++) { const [xi, yi] = pl[i], [xj, yj] = pl[j]; if ((yi > py) !== (yj > py)) xs.push((xj - xi) * (py - yi) / (yj - yi) + xi); } xs.sort((a, b) => a - b); for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.ceil(xs[k] / gStep)); x <= Math.min(W - 1, Math.floor(xs[k + 1] / gStep)); x++) ok[y * W + x] += val; } };
    fill(poly, 1); fill(bpoly, 1); for (let i = 0; i < N; i++) ok[i] = ok[i] === 2 ? 1 : 0;
    const diskOf = {}, disk = r => { const k = r.toFixed(3); if (diskOf[k]) return diskOf[k]; const n = Math.ceil(r / gStep), o = []; for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) if ((dx * gStep) ** 2 + (dy * gStep) ** 2 < r * r) o.push(dx, dy); return (diskOf[k] = o); };
    const blockSeg = (a, b, r) => { // mark a capsule by stamping disks along it
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (gStep / 2))), d = disk(r + gStep * 0.35);
      for (let k = 0; k <= n; k++) { const cx = Math.round((a[0] + (b[0] - a[0]) * k / n) / gStep), cy = Math.round((a[1] + (b[1] - a[1]) * k / n) / gStep); for (let q = 0; q < d.length; q += 2) { const x = cx + d[q], y = cy + d[q + 1]; if (x >= 0 && y >= 0 && x < W && y < H) ok[y * W + x] = 0; } }
    };
    const block = (sh, r) => {
      if (sh.k === 'seg') return blockSeg(sh.a, sh.b, sh.r + r);
      const b = bboxOf(sh), x0 = Math.max(0, Math.floor((b[0] - r) / gStep)), x1 = Math.min(W - 1, Math.ceil((b[2] + r) / gStep)), y0 = Math.max(0, Math.floor((b[1] - r) / gStep)), y1 = Math.min(H - 1, Math.ceil((b[3] + r) / gStep));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * W + x; if (ok[i] && shapeDist({ k: 'circ', c: [x * gStep, y * gStep], r: 0 }, sh) < r) ok[i] = 0; }
    };
    const L2 = R.layers === 1 ? ['F'] : ['F', 'B'];
    for (const c of placed()) for (const q of padsOf(c, idx)) if (q.net !== pr.net && padCu(q, L2).includes(pr.layer)) block(padShape(q), cl);
    for (const t of S.pcb.traces) if (t.net !== pr.net && t.layer === pr.layer) for (let i = 1; i < t.pts.length; i++) block({ k: 'seg', a: t.pts[i - 1], b: t.pts[i], r: t.w / 2 }, cl);
    for (const v of S.pcb.vias) if (v.net !== pr.net) block({ k: 'circ', c: [v.x, v.y], r: v.d / 2 }, cl);
    // board edge clearance
    for (let i = 0; i < bpoly.length; i++) block({ k: 'seg', a: bpoly[i], b: bpoly[(i + 1) % bpoly.length], r: 0 }, R.edgeClearance);
    const label = new Int32Array(N); let n = 0;
    for (let i = 0; i < N; i++) if (ok[i] && !label[i]) {
      n++; const st = [i]; label[i] = n;
      while (st.length) { const k = st.pop(), x = k % W, y = (k / W) | 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const j = ny * W + nx; if (ok[j] && !label[j]) { label[j] = n; st.push(j); } } }
    }
    return { W, H, g: gStep, label, islands: n, at: (x, y) => { const cx = Math.round(x / gStep), cy = Math.round(y / gStep); return cx < 0 || cy < 0 || cx >= W || cy >= H ? 0 : label[cy * W + cx]; } };
  }
  function addPour(o = {}) {
    const S = Model.S; if (!S.board.w) throw new Error('Generate the PCB first');
    const net = o.net || 'GND'; if (!S.nets[net]) throw new Error(`No net "${net}"`);
    const layers = o.layer === 'both' ? ['F', 'B'] : [o.layer === 'B' || o.layer === 'bottom' ? 'B' : 'F'];
    S.pcb.pours = S.pcb.pours || [];
    const added = [];
    for (const layer of layers) {
      const pr = { net, layer };
      if (o.points && o.points.length >= 3) pr.pts = o.points.map(q => [+q[0], +q[1]]); else pr.whole = true;
      if (o.clearance > 0) pr.clearance = +o.clearance;
      S.pcb.pours.push(pr); added.push(S.pcb.pours.length - 1);
    }
    return { added, pours: S.pcb.pours.length };
  }

  const placed = () => Model.S.components.filter(c => c.pcb && Lib.footprint(c.footprint));

  // ---------- auto placement ----------
  // Connectors go on the board edge. Parts with an opening (USB, jacks, RF, card slots) face outward, flush with the edge.
  const PLUG_RE = /USB|TYPE-?C|MICRO-?B|MINI-?B|JACK|BARREL|DC-?0\d|RJ-?45|RJ-?11|SMA\b|U\.FL|IPEX|SD-?CARD|MICRO-?SD|TF-?CARD|SIM/i;
  const CONN_RE = /CONN|HEADER|TERMINAL|SCREW|PINHEADER|JST|XH-|PH-|MOLEX|WAGO/i;
  function edgeInfo(c) {
    const lib = c.lcsc && Model.S.lib && Model.S.lib[c.lcsc];
    const text = [c.value, c.footprint, lib && lib.name, lib && lib.package, lib && lib.footprint && lib.footprint.name].filter(Boolean).join(' ');
    const plug = PLUG_RE.test(text);
    if (!plug && !(c.type === 'connector' || CONN_RE.test(text) || /^(J|CN|USB|P)\d+$/i.test(c.ref))) return null;
    let front = null;
    if (plug) {
      // the contacts (SMD row, or all pads) sit at the back; the body/opening extends toward the front
      const fp = Lib.footprint(c.footprint), smd = fp.pads.filter(q => !q.drill), use = smd.length ? smd : fp.pads;
      const px = use.reduce((t, q) => t + q.x, 0) / use.length, py = use.reduce((t, q) => t + q.y, 0) / use.length;
      const vx = (fp.box[0] + fp.box[2]) / 2 - px, vy = (fp.box[1] + fp.box[3]) / 2 - py;
      front = Math.abs(vx) > Math.abs(vy) ? [Math.sign(vx) || 1, 0] : [0, Math.sign(vy) || 1];
      if (isBottom(c)) front[0] = -front[0];
    }
    return { plug, front };
  }
  const NORMAL = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
  // rotation that makes the connector face the given edge (plugs: opening outward; headers: long side along the edge)
  function edgeRot(c, side, info) {
    if (info.front) {
      for (const r of [0, 90, 180, 270]) { const [x, y] = Lib.rot(info.front[0], info.front[1], r); if (Math.round(x) === NORMAL[side][0] && Math.round(y) === NORMAL[side][1]) return r; }
    }
    const b = Lib.footprint(c.footprint).box, wide = (b[2] - b[0]) >= (b[3] - b[1]), horiz = side === 'top' || side === 'bottom';
    return wide === horiz ? 0 : 90;
  }
  function separate(cs, gap, lock = new Map()) {
    const half = c => { const b = fpBox(c), x = c.pcb.x, y = c.pcb.y; return [(b[2] - b[0]) / 2, (b[3] - b[1]) / 2, (b[0] + b[2]) / 2 - x, (b[1] + b[3]) / 2 - y]; };
    for (let it = 0; it < 500; it++) {
      let moved = false;
      for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
        const a = cs[i], b = cs[j], ha = half(a), hb = half(b);
        const dx = (b.pcb.x + hb[2]) - (a.pcb.x + ha[2]), dy = (b.pcb.y + hb[3]) - (a.pcb.y + ha[3]);
        const ox = ha[0] + hb[0] + gap - Math.abs(dx), oy = ha[1] + hb[1] + gap - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        const la = lock.get(a) || '', lb = lock.get(b) || '';
        let axis = ox < oy ? 'x' : 'y';
        if (la.includes(axis) && lb.includes(axis)) axis = axis === 'x' ? 'y' : 'x';
        if (la.includes(axis) && lb.includes(axis)) continue;
        const ov = axis === 'x' ? ox : oy, sg = (axis === 'x' ? dx : dy) >= 0 ? 1 : -1;
        const ka = la.includes(axis) ? 0 : lb.includes(axis) ? 1 : 0.5, kb = lb.includes(axis) ? 0 : la.includes(axis) ? 1 : 0.5;
        a.pcb[axis] -= sg * ov * ka; b.pcb[axis] += sg * ov * kb; moved = true;
      }
      if (!moved) break;
    }
  }
  const unionBox = list => { let b = [Infinity, Infinity, -Infinity, -Infinity]; for (const c of list) { const a = fpBox(c); b = [Math.min(b[0], a[0]), Math.min(b[1], a[1]), Math.max(b[2], a[2]), Math.max(b[3], a[3])]; } return b; };

  function autoPlace(opt = {}) {
    const S = Model.S, cs = S.components.filter(c => Lib.footprint(c.footprint));
    if (!cs.length) throw new Error('No components with footprints to place');
    const k = 0.085, gap = 1.0, m = opt.margin ?? 3;
    for (const c of cs) { const side = c.pcb && c.pcb.side; c.pcb = { x: c.x * k, y: c.y * k, rot: c.rot || 0 }; if (side === 'B') c.pcb.side = 'B'; }
    separate(cs, gap);
    // connectors → nearest edge (or the edge chosen earlier with place_footprint)
    const cb = unionBox(cs), cx = (cb[0] + cb[2]) / 2, cy = (cb[1] + cb[3]) / 2;
    const edgeParts = [], lock = new Map(), sideOf = new Map();
    for (const c of cs) {
      const info = edgeInfo(c); if (!info && !c.pcbEdge) continue;
      const fb = fpBox(c), px = (fb[0] + fb[2]) / 2, py = (fb[1] + fb[3]) / 2;
      const side = c.pcbEdge || [['left', px - cb[0]], ['right', cb[2] - px], ['top', py - cb[1]], ['bottom', cb[3] - py]].sort((a, b) => a[1] - b[1])[0][0];
      c.pcb.rot = edgeRot(c, side, info || { front: null });
      const b2 = fpBox(c);
      if (side === 'left') c.pcb.x += cb[0] - b2[0]; if (side === 'right') c.pcb.x += cb[2] - b2[2];
      if (side === 'top') c.pcb.y += cb[1] - b2[1]; if (side === 'bottom') c.pcb.y += cb[3] - b2[3];
      edgeParts.push({ c, side, plug: !!(info && info.plug) }); sideOf.set(c, side);
      lock.set(c, side === 'left' || side === 'right' ? 'x' : 'y');
    }
    separate(cs, gap, lock);
    // board outline: flush with plug openings, a little margin behind headers, normal margin elsewhere
    const others = cs.filter(c => !sideOf.has(c)), ob = others.length ? unionBox(others) : unionBox(cs), all = unionBox(cs);
    const bound = { left: all[0] - m, right: all[2] + m, top: all[1] - m, bottom: all[3] + m };
    for (const side of ['left', 'right', 'top', 'bottom']) {
      const here = edgeParts.filter(e => e.side === side); if (!here.length) continue;
      const out = side === 'left' || side === 'top' ? -1 : 1, idx = { left: 0, top: 1, right: 2, bottom: 3 }[side];
      const ext = v => out < 0 ? Math.min(...v) : Math.max(...v);
      const plugs = here.filter(e => e.plug), heads = here.filter(e => !e.plug);
      let edge = ext(here.map(e => fpBox(e.c)[idx]).concat(others.length ? [ob[idx] + out * 1.5] : []));
      if (!plugs.length) edge += out * 1.5;
      bound[side] = edge;
      // plugs flush with the edge, headers 1.5 mm in
      for (const e of plugs) { const d = edge - fpBox(e.c)[idx]; if (side === 'left' || side === 'right') e.c.pcb.x += d; else e.c.pcb.y += d; }
      for (const e of heads) { const d = edge - out * 1.5 - fpBox(e.c)[idx]; if (side === 'left' || side === 'right') e.c.pcb.x += d; else e.c.pcb.y += d; }
    }
    let W = bound.right - bound.left, H = bound.bottom - bound.top, ox = -bound.left, oy = -bound.top;
    if (opt.w && opt.h && opt.w >= W && opt.h >= H) {
      // a fixed board size: keep the edge parts on their edges, centre the rest
      const ex = opt.w - W, ey = opt.h - H;
      for (const c of cs) { const sd = sideOf.get(c); c.pcb.x += sd === 'right' ? ex : sd === 'left' ? 0 : ex / 2; c.pcb.y += sd === 'bottom' ? ey : sd === 'top' ? 0 : ey / 2; }
      W = opt.w; H = opt.h;
    }
    const shp = S.board.shape;
    if (shp && shp.type === 'ellipse') { const ex = W * 0.21, ey = H * 0.21; W += 2 * ex; H += 2 * ey; ox += ex; oy += ey; }
    if (shp && shp.type === 'rounded') { const e = (shp.r || 0) * 0.3; W += 2 * e; H += 2 * e; ox += e; oy += e; }
    if (shp && shp.type === 'polygon') { const cx2 = (S.board.w - W) / 2, cy2 = (S.board.h - H) / 2; ox += cx2; oy += cy2; W = S.board.w; H = S.board.h; }
    W = Math.ceil(W * 10) / 10; H = Math.ceil(H * 10) / 10;
    for (const c of cs) { c.pcb.x = +(Math.round((c.pcb.x + ox) / 0.05) * 0.05).toFixed(3); c.pcb.y = +(Math.round((c.pcb.y + oy) / 0.05) * 0.05).toFixed(3); }
    S.board = Object.assign({}, S.board, { w: +W.toFixed(1), h: +H.toFixed(1) });
    S.pcb = { traces: [], vias: [], routed: {}, pours: (S.pcb.pours || []).filter(pr => pr.whole) };
    return { board: S.board, placed: cs.length, on_edge: edgeParts.map(e => `${e.c.ref}:${e.side}${e.plug ? ' (opening outward)' : ''}`) };
  }

  // Move / rotate one footprint, or put it on a board edge (plugs face outward, flush with the edge).
  function placeFootprint(ref, o = {}) {
    const S = Model.S, c = Model.comp(ref);
    if (!c || !Lib.footprint(c.footprint)) throw new Error(`No footprint for "${ref}"`);
    if (!c.pcb || !S.board.w) throw new Error('Generate the PCB first');
    if (o.side) { const sd = /^b/i.test(o.side) ? 'B' : 'F'; if (sd === 'B') c.pcb.side = 'B'; else delete c.pcb.side; }
    if (o.lock != null) c.pcb.locked = !!o.lock;
    if (o.edge) {
      if (!NORMAL[o.edge]) throw new Error('edge must be left, right, top or bottom');
      const info = edgeInfo(c) || { plug: false, front: null };
      c.pcbEdge = o.edge; c.pcb.rot = edgeRot(c, o.edge, info);
      const b = fpBox(c), inset = info.plug ? 0 : 1.5;
      if (o.edge === 'left') c.pcb.x += inset - b[0]; if (o.edge === 'right') c.pcb.x += S.board.w - inset - b[2];
      if (o.edge === 'top') c.pcb.y += inset - b[1]; if (o.edge === 'bottom') c.pcb.y += S.board.h - inset - b[3];
      if (o.along != null) { if (o.edge === 'left' || o.edge === 'right') c.pcb.y = +o.along; else c.pcb.x = +o.along; }
    }
    if (o.rot != null) c.pcb.rot = ((Math.round(+o.rot / 90) * 90) % 360 + 360) % 360;
    if (o.x != null) c.pcb.x = +o.x; if (o.y != null) c.pcb.y = +o.y;
    c.pcb.x = +(+c.pcb.x).toFixed(3); c.pcb.y = +(+c.pcb.y).toFixed(3);
    const b = fpBox(c);
    return { ref: c.ref, x: c.pcb.x, y: c.pcb.y, rot: c.pcb.rot, side: isBottom(c) ? 'bottom' : 'top', edge: c.pcbEdge || null, outside_board: b[0] < -0.01 || b[1] < -0.01 || b[2] > S.board.w + 0.01 || b[3] > S.board.h + 0.01 };
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
    if (isRectBoard()) { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) edge[y * W + x] = Math.min(x * g, y * g, S.board.w - x * g, S.board.h - y * g); }
    else {
      // curved / custom outline: scanline fill for "inside", exact distance near the outline
      const poly = boardPoly(), reach = R.edgeClearance + Math.max(R.viaDiameter, R.powerTraceWidth, ...Object.values(R.netWidths).map(Number)) + 2 * g;
      edge.fill(-1);
      for (let y = 0; y < H; y++) {
        const py = y * g, xs = [];
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > py) !== (yj > py)) xs.push((xj - xi) * (py - yi) / (yj - yi) + xi); }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.ceil(xs[k] / g)); x <= Math.min(W - 1, Math.floor(xs[k + 1] / g)); x++) edge[y * W + x] = 1e9;
      }
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const x0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - reach) / g)), x1 = Math.min(W - 1, Math.ceil((Math.max(a[0], b[0]) + reach) / g));
        const y0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - reach) / g)), y1 = Math.min(H - 1, Math.ceil((Math.max(a[1], b[1]) + reach) / g));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const k = y * W + x; if (edge[k] >= 0) { const d = ptSeg([x * g, y * g], a, b); if (d < edge[k]) edge[k] = d; } }
      }
    }

    // pads: raster cells whose centre lies in the pad (+ nearest cell for tiny pads)
    const allPads = [], padOf = new Int32Array(L * N);
    let orphan = -2;
    for (const c of cs) for (const p of padsOf(c, idx)) {
      p.id = p.net ? netId[p.net] : orphan--;
      p.layers = L === 1 ? [0] : (p.drill ? [0, 1] : [p.layer === 'B' ? 1 : 0]);
      p.cells = [];
      const x0 = Math.max(0, Math.floor((p.x - p.w / 2) / g)), x1 = Math.min(W - 1, Math.ceil((p.x + p.w / 2) / g));
      const y0 = Math.max(0, Math.floor((p.y - p.h / 2) / g)), y1 = Math.min(H - 1, Math.ceil((p.y + p.h / 2) / g));
      const cells = [];
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (padDist(p, x * g, y * g) <= 1e-9) cells.push(y * W + x);
      if (!cells.length) { const cx = Math.min(W - 1, Math.max(0, Math.round(p.x / g))), cy = Math.min(H - 1, Math.max(0, Math.round(p.y / g))); cells.push(cy * W + cx); }
      for (const l of p.layers) for (const cell of cells) { p.cells.push(l * N + cell); padOf[l * N + cell] = allPads.length + 1; }
      allPads.push(p);
    }
    // Existing copper is kept (opt.keep !== false): it becomes an obstacle for other nets and part of its own net.
    const keep = opt.keep !== false;
    const oldTraces = keep ? S.pcb.traces.slice() : [], oldVias = keep ? S.pcb.vias.slice() : [];
    if (!keep) S.pcb = { traces: [], vias: [], routed: {}, pours: S.pcb.pours || [] };
    const conn = connectivity();
    const preT = [], preV = [];
    let orphanT = -100000;
    for (const t of oldTraces) {
      const id = t.net && netId[t.net] ? netId[t.net] : orphanT--, l = t.layer === 'B' ? 1 : 0;
      if (l >= L) continue;
      const cells = new Set();
      for (let i = 1; i < t.pts.length; i++) {
        const [ax, ay] = t.pts[i - 1], [bx, by] = t.pts[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (g / 2)));
        for (let k = 0; k <= n; k++) { const x = Math.round((ax + (bx - ax) * k / n) / g), y = Math.round((ay + (by - ay) * k / n) / g); if (x >= 0 && y >= 0 && x < W && y < H) cells.add(y * W + x); }
      }
      preT.push({ id, l, w: t.w, cells: [...cells], net: t.net });
    }
    for (const v of oldVias) preV.push({ id: v.net && netId[v.net] ? netId[v.net] : orphanT--, x: Math.round(v.x / g), y: Math.round(v.y / g), d: v.d, net: v.net });
    const jobs = netNames.map(n => {
      const pads = allPads.filter(p => p.net === n);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of pads) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
      // group pads already joined by existing copper into islands ("super pads")
      const c = conn[n], islands = [];
      if (c) for (const grp of c.groups) { const ids = new Set(grp.map(q => q.uid)); islands.push(pads.filter(q => ids.has(q.uid))); }
      else pads.forEach(q => islands.push([q]));
      return { net: n, id: netId[n], pads, islands: islands.filter(i => i.length), hpwl: (x1 - x0) + (y1 - y0), w: netWidth(R, n) };
    }).filter(j => j.pads.length >= 2);
    const already = jobs.filter(j => j.islands.length <= 1).map(j => j.net);
    const todo = jobs.filter(j => j.islands.length > 1);
    if (!todo.length) { S.pcb = { traces: oldTraces, vias: oldVias, pours: S.pcb.pours || [], routed: Object.fromEntries(already.map(n => [n, true])) }; return { routed: jobs.length, total: jobs.length, failed: [], necked_down: [], vias: oldVias.length, kept_tracks: oldTraces.length, rules: R.preset }; }

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
      const tcells = preT.map(t => Object.assign({}, t)), gvias = preV.map(v => Object.assign({}, v)), viasOut = [], traces = [], routed = {}, failed = [], necked = new Set();
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
        // aim at the nearest pad of the target terminal
        let tp = target.pads ? target.pads[0] : target;
        if (!anyT) return null;
        const [wx0, wy0, wx1, wy1] = win;
        const tx = tp.x / g, ty = tp.y / g, heap = new Heap(), K = Math.SQRT2 - 1, HW = 1.15;
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
            const pi = padOf[i] || (L > 1 ? padOf[N + i] : 0), pad = pi ? allPads[pi - 1] : null; // via-in-pad only inside our own pad, where the via fits
            if (!pad || pad.drill || Math.max(own[i], L > 1 ? own[N + i] : 0) >= dv) {
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
        const { id } = job;
        // each island (pads already joined by kept copper) acts as one terminal; its copper is part of the tree
        const islandCells = isl => new Set(isl.flatMap(q => q.cells));
        const terms = job.islands.map(isl => ({ pads: isl, x: isl.reduce((a, q) => a + q.x, 0) / isl.length, y: isl.reduce((a, q) => a + q.y, 0) / isl.length, w: Math.max(...isl.map(q => q.w)), h: Math.max(...isl.map(q => q.h)), cells: [...islandCells(isl)] }));
        // kept tracks/vias of this net extend the terminal they touch
        for (const t of tcells) if (t.id === id) { const tc = t.cells.map(c => t.l * N + c), hit = terms.find(T => tc.some(c => T.cells.includes(c))); if (hit) hit.cells.push(...tc); }
        const tree = new Set(terms[0].cells), done = [terms[0]], rest = terms.slice(1), segs = [], vs = [];
        let ok = true, mapW = null;
        const widths = [job.w];
        if (R.neckDown) for (const w2 of [R.traceWidth, R.minTraceWidth]) if (w2 < widths[widths.length - 1] - 1e-9) widths.push(w2);
        while (rest.length) {
          let bi = 0, bd = Infinity;
          rest.forEach((T, i) => { for (const D of done) for (const p of T.pads) for (const q of D.pads) { const d = Math.hypot(p.x - q.x, p.y - q.y); if (d < bd) { bd = d; bi = i; } } });
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
          const lastPad = padOf[path[path.length - 1]] ? allPads[padOf[path[path.length - 1]] - 1] : null;
          flush(lastPad);
          for (const c of target.cells) tree.add(c);
          done.push(target);
        }
        traces.push(...segs); viasOut.push(...vs);
        if (ok) routed[job.net] = true; else failed.push(job.net);
      }
      return { traces, vias: viasOut, routed, failed, necked: [...necked] };
    }

    let order = todo.slice().sort((a, b) => a.hpwl - b.hpwl), best = null;
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
    for (const n of already) best.routed[n] = true;
    S.pcb = { traces: oldTraces.concat(best.traces), vias: oldVias.concat(best.vias), pours: S.pcb.pours || [], routed: best.routed };
    return { routed: Object.keys(best.routed).length, total: jobs.length, kept_tracks: oldTraces.length, failed: best.failed, necked_down: best.necked, vias: best.vias.length, board: S.board, grid_mm: +g.toFixed(3), search: stats, rules: { preset: R.preset, trace: R.traceWidth, power: R.powerTraceWidth, clearance: R.clearance, via: `${R.viaDiameter}/${R.viaDrill}`, layers: L } };
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
    for (const c of cs) for (const p of padsOf(c, idx)) objs.push({ s: padShape(p), net: p.net || '~' + (orphan++), layers: L === 1 ? ['F'] : padCu(p, ['F', 'B']), what: `pad ${p.key}`, drill: p.drill, x: p.x, y: p.y });
    for (const c of cs) if (!fpInside(c)) add('outline', `${c.ref} is outside the board outline`, c.pcb.x, c.pcb.y);
    const pours = S.pcb.pours || [];
    for (let i = 0; i < pours.length; i++) for (let j = i + 1; j < pours.length; j++) {
      const A = pours[i], B = pours[j]; if (A.layer !== B.layer || A.net === B.net) continue;
      const pa = pourPoly(A), pb = pourPoly(B);
      if (pa.some(q => inPoly(q[0], q[1], pb)) || pb.some(q => inPoly(q[0], q[1], pa))) add('pour', `Copper pours ${A.net} and ${B.net} overlap on ${A.layer === 'F' ? 'TopLayer' : 'BottomLayer'} (short)`, pa[0][0], pa[0][1]);
    }
    for (const t of S.pcb.traces) {
      if (t.w < R.minTraceWidth - 1e-6) add('trace-width', `Trace on ${t.net} is ${t.w} mm (fab minimum ${R.minTraceWidth})`, t.pts[0][0], t.pts[0][1]);
      for (let i = 1; i < t.pts.length; i++) objs.push({ s: { k: 'seg', a: t.pts[i - 1], b: t.pts[i], r: t.w / 2 }, net: t.net || '~t' + S.pcb.traces.indexOf(t), layers: [t.layer], what: `trace ${t.net || '(no net)'}`, x: (t.pts[i - 1][0] + t.pts[i][0]) / 2, y: (t.pts[i - 1][1] + t.pts[i][1]) / 2 });
    }
    for (const v of S.pcb.vias) {
      objs.push({ s: { k: 'circ', c: [v.x, v.y], r: v.d / 2 }, net: v.net || '~v' + S.pcb.vias.indexOf(v), layers: ['F', 'B'], what: `via ${v.net || '(no net)'}`, drill: v.drill, x: v.x, y: v.y });
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
    const bpoly = boardPoly(), rectB = isRectBoard();
    objs.forEach((o, i) => {
      const b = boxes[i], d = rectB ? Math.min(b[0], b[1], S.board.w - b[2], S.board.h - b[3]) : edgeDist(o.s, bpoly);
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
    for (const n of st.unrouted) out.push({ type: 'unrouted', severity: 'error', msg: `Net ${n} is not routed (connection error — the board would not work)` });
    const errors = out.filter(v => v.severity === 'error').length, warnings = out.length - errors;
    return { violations: out, errors, warnings, summary: errors ? `${errors} errors, ${warnings} warnings` : warnings ? `0 errors, ${warnings} warnings` : 'DRC passed' };
  }

  // Which pads of each net are joined by copper (pads, tracks, vias that touch on a shared layer).
  let connMemo = { key: null, val: null };
  function connectivity() {
    const S = Model.S;
    const key = JSON.stringify([S.pcb, S.board, S.nets, S.rules, S.components.map(c => [c.ref, c.pcb, c.footprint, c.lcsc])]);
    if (connMemo.key === key) return connMemo.val;
    const idx = Model.pinIndex(), L2 = (rules().layers === 1) ? ['F'] : ['F', 'B'];
    const nodes = [];
    for (const c of placed()) for (const p of padsOf(c, idx)) if (p.net) nodes.push({ k: 'pad', p, net: p.net, layers: padCu(p, L2), shapes: [padShape(p)] });
    S.pcb.traces.forEach((t, i) => { if (t.net) nodes.push({ k: 'trace', i, net: t.net, layers: [t.layer], shapes: t.pts.slice(1).map((q, j) => ({ k: 'seg', a: t.pts[j], b: q, r: t.w / 2 })) }); });
    S.pcb.vias.forEach((v, i) => { if (v.net) nodes.push({ k: 'via', i, net: v.net, layers: L2, shapes: [{ k: 'circ', c: [v.x, v.y], r: v.d / 2 }] }); });
    // copper pours: each connected island of a pour is a node; same-net copper touching the island joins it
    const pourNodes = [];
    (S.pcb.pours || []).forEach((pr, pi) => {
      if (!S.nets[pr.net] || !L2.includes(pr.layer)) return;
      const ras = pourRaster(pr), first = nodes.length;
      for (let k = 1; k <= ras.islands; k++) nodes.push({ k: 'pour', net: pr.net, layers: [pr.layer], shapes: [], pour: pi, island: k });
      pourNodes.push({ pr, ras, first });
    });
    const par = nodes.map((_, i) => i), find = i => { while (par[i] !== i) i = par[i] = par[par[i]]; return i; };
    const samples = sh => {
      const out = [];
      if (sh.k === 'circ') out.push(sh.c);
      else if (sh.k === 'rect') { for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) out.push([sh.cx + x * sh.hw * 0.8, sh.cy + y * sh.hh * 0.8]); }
      else { const n = Math.max(1, Math.ceil(Math.hypot(sh.b[0] - sh.a[0], sh.b[1] - sh.a[1]) / 0.2)); for (let k = 0; k <= n; k++) out.push([sh.a[0] + (sh.b[0] - sh.a[0]) * k / n, sh.a[1] + (sh.b[1] - sh.a[1]) * k / n]); }
      return out;
    };
    for (const { pr, ras, first } of pourNodes) nodes.forEach((n, i) => {
      if (n.k === 'pour' || n.net !== pr.net || !n.layers.includes(pr.layer)) return;
      for (const sh of n.shapes) for (const q of samples(sh)) { const lab = ras.at(q[0], q[1]); if (lab) { const a = find(i), b = find(first + lab - 1); if (a !== b) par[a] = b; } }
    });
    const byNet = {};
    nodes.forEach((n, i) => (byNet[n.net] = byNet[n.net] || []).push(i));
    for (const ids of Object.values(byNet)) {
      const boxes = ids.map(i => { let b = [Infinity, Infinity, -Infinity, -Infinity]; for (const sh of nodes[i].shapes) { const q = bboxOf(sh); b = [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])]; } return b; });
      for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
        const A = nodes[ids[a]], B = nodes[ids[b]], ba = boxes[a], bb = boxes[b];
        if (!A.shapes.length || !B.shapes.length) continue;
        if (ba[0] > bb[2] + 0.01 || bb[0] > ba[2] + 0.01 || ba[1] > bb[3] + 0.01 || bb[1] > ba[3] + 0.01) continue;
        if (!A.layers.some(l => B.layers.includes(l)) || find(ids[a]) === find(ids[b])) continue;
        if (A.shapes.some(sa => B.shapes.some(sb => shapeDist(sa, sb) <= 0.002))) par[find(ids[a])] = find(ids[b]);
      }
    }
    const out = {};
    for (const [net, ids] of Object.entries(byNet)) {
      const pads = ids.filter(i => nodes[i].k === 'pad').map(i => nodes[i].p); if (pads.length < 2) continue;
      const groups = {};
      ids.forEach(i => { if (nodes[i].k === 'pad') (groups[find(i)] = groups[find(i)] || []).push(nodes[i].p); });
      const g = Object.values(groups);
      out[net] = { pads, groups: g, complete: g.length === 1 };
    }
    connMemo = { key, val: out };
    return out;
  }
  // Ratsnest: shortest lines that would join the still-separate copper islands of each net.
  function ratsnest(conn = connectivity()) {
    const lines = [];
    for (const [net, c] of Object.entries(conn)) {
      if (c.complete) continue;
      const islands = c.groups.map(g => g.slice()), joined = [islands.shift()];
      while (islands.length) {
        let best = null;
        islands.forEach((isl, i) => { for (const a of isl) for (const J of joined) for (const b of J) { const d = Math.hypot(a.x - b.x, a.y - b.y); if (!best || d < best.d) best = { d, i, a, b }; } });
        lines.push({ net, a: best.a, b: best.b }); joined.push(islands.splice(best.i, 1)[0]);
      }
    }
    return lines;
  }
  function status(conn = connectivity()) {
    const S = Model.S, nets = Object.keys(conn), routed = nets.filter(n => conn[n].complete);
    let len = 0; for (const t of S.pcb.traces) for (let i = 1; i < t.pts.length; i++) len += Math.hypot(t.pts[i][0] - t.pts[i - 1][0], t.pts[i][1] - t.pts[i - 1][1]);
    return { placed: placed().length, components: S.components.length, board: S.board, nets: nets.length, routed: routed.length, unrouted: nets.filter(n => !conn[n].complete), vias: S.pcb.vias.length, trace_length_mm: +len.toFixed(1) };
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
    const R = rules(), onLayer = (p, layer) => p.drill || (p.layer || 'F') === layer;
    const drawCopper = (A, b, layer, grow, net) => {
      for (const t of S.pcb.traces) if (t.layer === layer && (net === undefined || t.net !== net)) { b.push(A(`C,${f6(t.w + grow)}`) + '*'); b.push(X(...t.pts[0]) + 'D02*'); for (const q of t.pts.slice(1)) b.push(X(...q) + 'D01*'); }
      for (const p of pads) if (onLayer(p, layer) && (net === undefined || p.net !== net)) { b.push(A(padAp(p, grow)) + '*'); b.push(X(p.x, p.y) + 'D03*'); }
      for (const v of S.pcb.vias) if (net === undefined || v.net !== net) { b.push(A(`C,${f6(v.d + grow)}`) + '*'); b.push(X(v.x, v.y) + 'D03*'); }
    };
    const outline = boardPoly();
    const copper = (layer, func) => file(func, (A, b) => {
      // copper pours: dark region, then clear (LPC) other nets' copper + the board-edge band, then all copper on top
      const pours = (S.pcb.pours || []).filter(pr => pr.layer === layer && S.nets[pr.net]);
      if (pours.length) {
        b.push('G01*');
        for (const pr of pours) {
          const poly = pourPoly(pr), cl = pr.clearance || R.clearance;
          b.push('%LPD*%', 'G36*', X(...poly[0]) + 'D02*'); for (const q of poly.slice(1)) b.push(X(...q) + 'D01*'); b.push(X(...poly[0]) + 'D01*', 'G37*');
          b.push('%LPC*%'); drawCopper(A, b, layer, 2 * cl, pr.net);
          b.push(A(`C,${f6(2 * R.edgeClearance)}`) + '*', X(...outline[0]) + 'D02*'); for (const q of outline.slice(1)) b.push(X(...q) + 'D01*'); b.push(X(...outline[0]) + 'D01*');
        }
        b.push('%LPD*%');
      }
      drawCopper(A, b, layer, 0);
    });
    const mask = (layer, func) => file(func, (A, b) => { for (const p of pads) if (onLayer(p, layer)) { b.push(A(padAp(p, 0.1)) + '*'); b.push(X(p.x, p.y) + 'D03*'); } });
    const paste = (layer, func) => file(func, (A, b) => { for (const p of pads) if (!p.drill && (p.layer || 'F') === layer) { b.push(A(padAp(p)) + '*'); b.push(X(p.x, p.y) + 'D03*'); } });
    const rectPath = (b, x0, y0, x1, y1) => { b.push(X(x0, y0) + 'D02*'); b.push(X(x1, y0) + 'D01*'); b.push(X(x1, y1) + 'D01*'); b.push(X(x0, y1) + 'D01*'); b.push(X(x0, y0) + 'D01*'); };
    const silk = side => (A, b) => { b.push(A('C,0.150000') + '*'); for (const c of cs) if ((isBottom(c) ? 'B' : 'F') === side) { const bb = fpBox(c); rectPath(b, bb[0], bb[1], bb[2], bb[3]); } };
    const files = {
      'board-F_Cu.gtl': copper('F', 'Copper,L1,Top'),
      'board-B_Cu.gbl': copper('B', 'Copper,L2,Bot'),
      'board-F_Mask.gts': mask('F', 'Soldermask,Top'),
      'board-B_Mask.gbs': mask('B', 'Soldermask,Bot'),
      'board-F_Paste.gtp': paste('F', 'Paste,Top'),
      'board-B_Paste.gbp': paste('B', 'Paste,Bot'),
      'board-F_Silkscreen.gto': file('Legend,Top', silk('F')),
      'board-B_Silkscreen.gbo': file('Legend,Bot', silk('B')),
      'board-Edge_Cuts.gm1': file('Profile,NP', (A, b) => { b.push(A('C,0.100000') + '*'); b.push(X(...outline[0]) + 'D02*'); for (const q of outline.slice(1)) b.push(X(...q) + 'D01*'); b.push(X(...outline[0]) + 'D01*'); }),
    };
    const holes = [...pads.filter(p => p.drill).map(p => ({ x: p.x, y: p.y, d: p.drill })), ...S.pcb.vias.map(v => ({ x: v.x, y: v.y, d: v.drill }))];
    const tools = [...new Set(holes.map(h => h.d.toFixed(3)))];
    let drl = 'M48\n; CircuitPilot drill file\nMETRIC,TZ\n' + tools.map((d, i) => `T${i + 1}C${d}`).join('\n') + '\n%\nG90\nG05\n';
    tools.forEach((d, i) => { drl += `T${i + 1}\n`; for (const h of holes.filter(h => h.d.toFixed(3) === d)) drl += `X${h.x.toFixed(3)}Y${(Hb - h.y).toFixed(3)}\n`; });
    files['board-PTH.drl'] = drl + 'M30\n';
    return files;
  }
  function optimize(opt = {}) {
    const S = Model.S, t0 = Date.now(), limit = (opt.time_limit_s || 60) * 1000, maxIt = opt.iterations || 12, grow = opt.allow_grow !== false, flip = !!opt.allow_bottom;
    if (!placed().length || !S.board.w) throw new Error('Generate the PCB first');
    const manual = { traces: S.pcb.traces.filter(t => t.manual), vias: S.pcb.vias.filter(v => v.manual) };
    const clone = o => JSON.parse(JSON.stringify(o));
    const snapPlace = () => placed().map(c => [c.ref, clone(c.pcb)]);
    const applyPlace = arr => arr.forEach(([ref, q]) => { const c = Model.comp(ref); if (c) c.pcb = clone(q); });
    let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let it = 0;
    const evaluate = () => {
      S.pcb = { traces: manual.traces.slice(), vias: manual.vias.slice(), pours: S.pcb.pours || [], routed: {} };
      route({ tries: 1, onProgress: opt.onProgress ? p => opt.onProgress(Object.assign({ iteration: it, of: maxIt }, p)) : null });
      const st = status(); return { failed: st.unrouted.length, len: st.trace_length_mm, unrouted: st.unrouted };
    };
    const better = (a, b) => a.failed < b.failed || (a.failed === b.failed && a.len < b.len - 0.5);
    let cur = evaluate();
    let best = { score: cur, place: snapPlace(), pcb: clone(S.pcb), board: clone(S.board) };
    const history = [{ iteration: 0, unrouted: cur.failed, length_mm: cur.len, move: 'start' }];
    const idx = Model.pinIndex();
    const movable = () => placed().filter(c => !c.pcbEdge && !c.pcb.locked && !edgeInfo(c));
    while (it < maxIt && best.score.failed > 0 && Date.now() - t0 < limit) {
      it++;
      applyPlace(best.place); S.board = clone(best.board); S.pcb = clone(best.pcb);
      const failed = best.score.unrouted, pads = placed().flatMap(c => padsOf(c, idx));
      const involved = movable().filter(c => pads.some(p => p.ref === c.ref && failed.includes(p.net)));
      const pool = involved.length ? involved : movable();
      const pick = () => pool[Math.floor(rnd() * pool.length)];
      const kind = ['toward', 'rotate', 'swap', 'toward', grow ? 'grow' : 'rotate', flip ? 'flip' : 'toward'][(it - 1) % 6];
      let desc = kind;
      if (kind === 'toward' && pool.length) {
        const c = pick(), own = new Set(padsOf(c, idx).map(p => p.net).filter(n => failed.includes(n) || rnd() < 0.3));
        const tgt = pads.filter(p => p.ref !== c.ref && own.has(p.net));
        if (tgt.length) { const tx = tgt.reduce((a, p) => a + p.x, 0) / tgt.length, ty = tgt.reduce((a, p) => a + p.y, 0) / tgt.length, f = 0.35 + 0.3 * rnd(); c.pcb.x += (tx - c.pcb.x) * f; c.pcb.y += (ty - c.pcb.y) * f; desc = `move ${c.ref} toward its connections`; }
      } else if (kind === 'rotate' && pool.length) { const c = pick(); c.pcb.rot = ((c.pcb.rot || 0) + (rnd() < 0.5 ? 90 : 180)) % 360; desc = `rotate ${c.ref}`; }
      else if (kind === 'swap' && pool.length > 1) {
        const a = pick(); let b = pick(); for (let k = 0; k < 6 && b === a; k++) b = pick();
        if (a !== b) { const ax = a.pcb.x, ay = a.pcb.y; a.pcb.x = b.pcb.x; a.pcb.y = b.pcb.y; b.pcb.x = ax; b.pcb.y = ay; desc = `swap ${a.ref} ↔ ${b.ref}`; }
      } else if (kind === 'flip' && pool.length) { const c = pick(); if (c.pcb.side === 'B') delete c.pcb.side; else c.pcb.side = 'B'; desc = `move ${c.ref} to the ${c.pcb.side === 'B' ? 'bottom' : 'top'} side`; }
      else if (kind === 'grow') {
        const f = 1.1, cx = S.board.w / 2, cy = S.board.h / 2;
        for (const c of placed()) { c.pcb.x = cx * f + (c.pcb.x - cx) * f; c.pcb.y = cy * f + (c.pcb.y - cy) * f; }
        S.board.w = +(S.board.w * f).toFixed(1); S.board.h = +(S.board.h * f).toFixed(1);
        if (S.board.shape && S.board.shape.pts) S.board.shape.pts = S.board.shape.pts.map(q => [q[0] * f, q[1] * f]);
        desc = `enlarge board to ${S.board.w}×${S.board.h} mm`;
      }
      // keep connectors on their edges, remove overlaps, stay on the board
      const lock = new Map();
      for (const c of placed()) if (c.pcbEdge || edgeInfo(c) || c.pcb.locked) lock.set(c, 'xy');
      separate(placed(), 1.0, lock);
      for (const c of placed()) if (c.pcbEdge || edgeInfo(c)) {
        const b = fpBox(c), side = c.pcbEdge || [['left', b[0]], ['right', S.board.w - b[2]], ['top', b[1]], ['bottom', S.board.h - b[3]]].sort((p, q) => p[1] - q[1])[0][0];
        const had = c.pcbEdge; placeFootprint(c.ref, { edge: side }); if (!had) delete c.pcbEdge;
      } else {
        const b = fpBox(c), m = 1;
        if (b[0] < m) c.pcb.x += m - b[0]; if (b[1] < m) c.pcb.y += m - b[1];
        if (b[2] > S.board.w - m) c.pcb.x -= b[2] - (S.board.w - m); if (b[3] > S.board.h - m) c.pcb.y -= b[3] - (S.board.h - m);
      }
      for (const c of placed()) { c.pcb.x = +(Math.round(c.pcb.x / 0.05) * 0.05).toFixed(3); c.pcb.y = +(Math.round(c.pcb.y / 0.05) * 0.05).toFixed(3); }
      const sc = evaluate();
      const kept = better(sc, best.score);
      history.push({ iteration: it, move: desc, unrouted: sc.failed, length_mm: sc.len, kept });
      if (kept) best = { score: sc, place: snapPlace(), pcb: clone(S.pcb), board: clone(S.board) };
    }
    applyPlace(best.place); S.board = clone(best.board); S.pcb = clone(best.pcb);
    const st = status();
    return { iterations: it, routed: st.routed, total: st.nets, unrouted: st.unrouted, trace_length_mm: st.trace_length_mm, board: S.board, seconds: +((Date.now() - t0) / 1000).toFixed(1), history };
  }

  return { autoPlace, placeFootprint, optimize, setBoardShape, boardPoly, isRectBoard, addPour, pourPoly, pourRaster, isBottom, padCu, inPoly, edgeInfo, route, status, gerbers, padsOf, fpBox, placed, rules, setRules, ruleWarnings, drc, RULE_PRESETS, connectivity, ratsnest, netWidth: n => netWidth(rules(), n), geom: { shapeDist, padShape, ptSeg, padDist, segSegDist } };
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
