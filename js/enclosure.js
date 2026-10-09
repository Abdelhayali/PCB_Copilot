'use strict';
// Parametric 3D-printable enclosure fitted to the PCB: CSG geometry (BSP, after csg.js by Evan Wallace, MIT),
// STL export and an equivalent OpenSCAD source. No DOM — also runs in Node (MCP server).
const Enclosure = (() => {
  // ---------------- CSG (BSP trees) ----------------
  const EPS = 1e-5;
  class V {
    constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
    plus(a) { return new V(this.x + a.x, this.y + a.y, this.z + a.z); }
    minus(a) { return new V(this.x - a.x, this.y - a.y, this.z - a.z); }
    times(k) { return new V(this.x * k, this.y * k, this.z * k); }
    dot(a) { return this.x * a.x + this.y * a.y + this.z * a.z; }
    cross(a) { return new V(this.y * a.z - this.z * a.y, this.z * a.x - this.x * a.z, this.x * a.y - this.y * a.x); }
    len() { return Math.sqrt(this.dot(this)); }
    unit() { return this.times(1 / this.len()); }
    lerp(a, t) { return this.plus(a.minus(this).times(t)); }
    neg() { return new V(-this.x, -this.y, -this.z); }
  }
  class Plane {
    constructor(n, w) { this.n = n; this.w = w; }
    static from(a, b, c) { const n = b.minus(a).cross(c.minus(a)); const l = n.len(); if (l < 1e-12) return null; const u = n.times(1 / l); return new Plane(u, u.dot(a)); }
    clone() { return new Plane(this.n, this.w); }
    flip() { this.n = this.n.neg(); this.w = -this.w; }
    split(poly, cf, cb, f, b) {
      let pt = 0; const types = [];
      for (const v of poly.v) { const t = this.n.dot(v) - this.w, ty = t < -EPS ? 2 : t > EPS ? 1 : 0; pt |= ty; types.push(ty); }
      if (pt === 0) (this.n.dot(poly.plane.n) > 0 ? cf : cb).push(poly);
      else if (pt === 1) f.push(poly);
      else if (pt === 2) b.push(poly);
      else {
        const F = [], B = [], n = poly.v.length;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n, ti = types[i], tj = types[j], vi = poly.v[i], vj = poly.v[j];
          if (ti !== 2) F.push(vi); if (ti !== 1) B.push(vi);
          if ((ti | tj) === 3) { const t = (this.w - this.n.dot(vi)) / this.n.dot(vj.minus(vi)), v = vi.lerp(vj, t); F.push(v); B.push(v); }
        }
        if (F.length >= 3) { const p = Poly.make(F); if (p) f.push(p); }
        if (B.length >= 3) { const p = Poly.make(B); if (p) b.push(p); }
      }
    }
  }
  class Poly {
    constructor(v, plane) { this.v = v; this.plane = plane; }
    static make(v) { const pl = Plane.from(v[0], v[1], v[2]) || (v.length > 3 && Plane.from(v[0], v[2], v[3])); return pl ? new Poly(v, pl) : null; }
    flip() { this.v = this.v.slice().reverse(); this.plane = new Plane(this.plane.n.neg(), -this.plane.w); return this; }
    clone() { return new Poly(this.v.slice(), this.plane.clone()); }
  }
  class Node {
    constructor(polys) { this.plane = null; this.front = null; this.back = null; this.polys = []; if (polys) this.build(polys); }
    invert() { for (const p of this.polys) p.flip(); if (this.plane) this.plane.flip(); if (this.front) this.front.invert(); if (this.back) this.back.invert(); const t = this.front; this.front = this.back; this.back = t; }
    clip(polys) {
      if (!this.plane) return polys.slice();
      let f = [], b = [];
      for (const p of polys) this.plane.split(p, f, b, f, b);
      if (this.front) f = this.front.clip(f);
      b = this.back ? this.back.clip(b) : [];
      return f.concat(b);
    }
    clipTo(bsp) { this.polys = bsp.clip(this.polys); if (this.front) this.front.clipTo(bsp); if (this.back) this.back.clipTo(bsp); }
    all() { let p = this.polys.slice(); if (this.front) p = p.concat(this.front.all()); if (this.back) p = p.concat(this.back.all()); return p; }
    build(polys) {
      if (!polys.length) return;
      if (!this.plane) this.plane = polys[0].plane.clone();
      const f = [], b = [];
      for (const p of polys) this.plane.split(p, this.polys, this.polys, f, b);
      if (f.length) { if (!this.front) this.front = new Node(); this.front.build(f); }
      if (b.length) { if (!this.back) this.back = new Node(); this.back.build(b); }
    }
  }
  const cl = ps => ps.map(p => p.clone());
  function union(A, B) { if (!A.length) return cl(B); if (!B.length) return cl(A); const a = new Node(cl(A)), b = new Node(cl(B)); a.clipTo(b); b.clipTo(a); b.invert(); b.clipTo(a); b.invert(); a.build(b.all()); return a.all(); }
  function subtract(A, B) { if (!B.length) return cl(A); const a = new Node(cl(A)), b = new Node(cl(B)); a.invert(); a.clipTo(b); b.clipTo(a); b.invert(); b.clipTo(a); b.invert(); a.build(b.all()); a.invert(); return a.all(); }

  // ---------------- 2D helpers ----------------
  const area = P => { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
  const ccw = P => area(P) < 0 ? P.slice().reverse() : P.slice();
  function dedupe(P) { const out = []; for (const p of P) { const q = out[out.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-4) out.push(p); } if (out.length > 2 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-4) out.pop(); return out; }
  // offset a CCW polygon by d (outward > 0) with round joins on convex corners
  const isConvex = P => P.every((B, i) => { const A = P[(i - 1 + P.length) % P.length], C = P[(i + 1) % P.length]; return (B[0] - A[0]) * (C[1] - B[1]) - (B[1] - A[1]) * (C[0] - B[0]) >= -1e-9; });
  // shrink a convex CCW polygon exactly: clip it by every edge moved inward (Sutherland–Hodgman)
  function shrinkConvex(P, d) {
    let out = P.slice();
    for (let i = 0; i < P.length && out.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy); if (l < 1e-9) continue;
      const nx = -dy / l, ny = dx / l, c = nx * a[0] + ny * a[1] + d;          // inward normal (left of a CCW edge)
      const side = q => nx * q[0] + ny * q[1] - c, res = [];
      for (let k = 0; k < out.length; k++) {
        const p = out[k], q = out[(k + 1) % out.length], sp = side(p), sq = side(q);
        if (sp >= 0) res.push(p);
        if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); res.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
      }
      out = res;
    }
    return dedupe(out);
  }
  function offset(P, d) {
    P = ccw(dedupe(P)); if (Math.abs(d) < 1e-9) return P;
    if (d < 0 && isConvex(P)) return shrinkConvex(P, -d);
    const n = P.length, out = [];
    const nrm = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [dy / l, -dx / l]; };
    for (let i = 0; i < n; i++) {
      const A = P[(i - 1 + n) % n], B = P[i], C = P[(i + 1) % n], n1 = nrm(A, B), n2 = nrm(B, C);
      const cr = (B[0] - A[0]) * (C[1] - B[1]) - (B[1] - A[1]) * (C[0] - B[0]); // > 0: convex (CCW)
      if ((cr > 1e-9) === (d > 0)) {
        // arc around the corner
        let a1 = Math.atan2(n1[1], n1[0]), a2 = Math.atan2(n2[1], n2[0]);
        if (d > 0) { while (a2 < a1) a2 += 2 * Math.PI; } else { while (a2 > a1) a2 -= 2 * Math.PI; }
        const steps = Math.max(1, Math.ceil(Math.abs(a2 - a1) / (Math.PI / 16)));
        for (let k = 0; k <= steps; k++) { const a = a1 + (a2 - a1) * k / steps; out.push([B[0] + Math.cos(a) * Math.abs(d) * Math.sign(d), B[1] + Math.sin(a) * Math.abs(d) * Math.sign(d)]); }
      } else {
        // mitre (limited)
        const bx = n1[0] + n2[0], by = n1[1] + n2[1], bl = Math.hypot(bx, by) || 1, cosh = (n1[0] * n2[0] + n1[1] * n2[1] + 1) / 2;
        const m = d / Math.sqrt(Math.max(cosh, 0.15));
        out.push([B[0] + bx / bl * m, B[1] + by / bl * m]);
      }
    }
    return dedupe(out);
  }
  const circle = (cx, cy, r, n = 28) => Array.from({ length: n }, (_, k) => [cx + r * Math.cos(k / n * 2 * Math.PI), cy + r * Math.sin(k / n * 2 * Math.PI)]);
  const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  function earcut(P) { // ear clipping for a simple CCW polygon → triangles (index triples)
    const idx = P.map((_, i) => i), tris = [];
    const crs = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const inside = (p, a, b, c) => crs(a, b, p) >= -1e-12 && crs(b, c, p) >= -1e-12 && crs(c, a, p) >= -1e-12;
    let guard = 0;
    while (idx.length > 3 && guard++ < 10000) {
      let cut = false;
      for (let i = 0; i < idx.length; i++) {
        const ia = idx[(i - 1 + idx.length) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length], a = P[ia], b = P[ib], c = P[ic];
        if (crs(a, b, c) <= 1e-12) continue;
        if (idx.some(j => j !== ia && j !== ib && j !== ic && inside(P[j], a, b, c))) continue;
        tris.push([ia, ib, ic]); idx.splice(i, 1); cut = true; break;
      }
      if (!cut) break;
    }
    if (idx.length === 3) tris.push(idx.slice());
    return tris;
  }
  // prism: extrude a 2D polygon between z0 and z1
  function prism(P2, z0, z1) {
    const P = ccw(dedupe(P2)), out = [], n = P.length;
    for (let i = 0; i < n; i++) {
      const a = P[i], b = P[(i + 1) % n];
      const q = Poly.make([new V(a[0], a[1], z0), new V(b[0], b[1], z0), new V(b[0], b[1], z1), new V(a[0], a[1], z1)]); if (q) out.push(q);
    }
    for (const [i, j, k] of earcut(P)) {
      const top = Poly.make([new V(P[i][0], P[i][1], z1), new V(P[j][0], P[j][1], z1), new V(P[k][0], P[k][1], z1)]); if (top) out.push(top);
      const bot = Poly.make([new V(P[k][0], P[k][1], z0), new V(P[j][0], P[j][1], z0), new V(P[i][0], P[i][1], z0)]); if (bot) out.push(bot);
    }
    return out;
  }
  // box oriented through a side wall: centre (x,y,z), size along the wall u, through-wall depth, height h
  function wallBox(cx, cy, cz, u, depth, h, side, round) {
    const horiz = side === 'top' || side === 'bottom';   // board top/bottom edge → wall runs along x
    const w2 = horiz ? u / 2 : depth / 2, d2 = horiz ? depth / 2 : u / 2;
    if (round) {
      // circular hole through the wall: build a cylinder along the wall normal
      const pts = circle(0, 0, Math.min(u, h) / 2, 28), polys = [], n = pts.length;
      const map = (s, t, k) => horiz ? new V(cx + s, cy + k, cz + t) : new V(cx + k, cy + s, cz + t);
      const ring = k => pts.map(p => map(p[0], p[1], k));
      const A = ring(-depth / 2), B = ring(depth / 2);
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; const q = Poly.make([A[i], A[j], B[j], B[i]]); if (q) polys.push(q); }
      const ca = Poly.make(A.slice().reverse()), cb = Poly.make(B.slice());
      // orient caps / sides outward by checking against the centre
      const fix = (p, c) => { if (p && p.plane.n.dot(p.v[0].minus(c)) < 0) p.flip(); return p; };
      const ctr = new V(cx, cy, cz);
      polys.forEach(p => fix(p, ctr)); if (ca) polys.push(fix(ca, ctr)); if (cb) polys.push(fix(cb, ctr));
      return polys;
    }
    return prism(rect(cx - w2, cy - d2, cx + w2, cy + d2), cz - h / 2, cz + h / 2);
  }

  // ---------------- part heights (mm above the board) ----------------
  function partHeight(c, params) {
    if (params.partHeights && params.partHeights[c.ref] != null) return +params.partHeights[c.ref];
    const lib = c.lcsc && Model.S.lib && Model.S.lib[c.lcsc];
    const t = [c.footprint, c.value, c.type, lib && lib.name, lib && lib.package, lib && lib.footprint && lib.footprint.name].filter(Boolean).join(' ').toUpperCase();
    const tests = [[/TO-?220/, 18], [/DC-?0|BARREL|JACK/, 11], [/RJ-?45/, 13.5], [/BUZZER/, 9.5], [/POT/, 10], [/PINHEADER|HEADER|CONN/, 8.5],
      [/CAPACITOR_POLARIZED|ELECTROLYTIC|CP_RADIAL/, 11], [/TYPE-?C|USB-?C/, 3.3], [/MICRO-?USB|MICRO-?B/, 2.9], [/USB/, 7], [/ESP32|WROOM|MINI-1|MODULE|WIFIM/, 3.3],
      [/TO-?92/, 5], [/DIP-/, 4.5], [/SW_|SWITCH|TACT/, 5], [/CRYSTAL|HC49/, 4], [/SOT-?223/, 1.8], [/THT_P2\.54/, 8.6], [/THT_P/, 6],
      [/QFN|SOIC|SOP|TSSOP|SSOP|QFP|SOT|SOD|0402|0603|0805|1206|SMA|SMB/, 1.6]];
    for (const [re, h] of tests) if (re.test(t)) return h;
    const fp = Lib.footprint(c.footprint);
    return fp && fp.pads.some(p => p.drill) ? 6 : 1.6;
  }

  // ---------------- parameters ----------------
  const DEFAULTS = {
    wall: 2.0, floor: 2.0, lidThickness: 2.0, clearance: 1.0, pcbThickness: 1.6, topClearance: 3.0, extraHeight: 0,
    standoffHeight: 5.0, standoffDiameter: 6.0, screwHole: 2.5, lidFit: 0.25, lipHeight: 3.0, lipWidth: 1.2,
    vents: true, ventWidth: 1.6, ventLength: 18, ventSpacing: 3.5, autoConnectorCutouts: true, autoLidHoles: true,
    cutouts: [], partHeights: {}, explode: 12,
  };
  const params = () => Object.assign({}, DEFAULTS, Model.S.enclosure || {}, { cutouts: ((Model.S.enclosure || {}).cutouts || []).slice(), partHeights: Object.assign({}, (Model.S.enclosure || {}).partHeights || {}) });
  function setParams(u = {}) {
    const S = Model.S, cur = Object.assign({}, S.enclosure || {});
    for (const [k, v] of Object.entries(u)) {
      if (!(k in DEFAULTS)) throw new Error(`Unknown enclosure parameter "${k}". Known: ${Object.keys(DEFAULTS).join(', ')}`);
      if (k === 'partHeights') { cur.partHeights = Object.assign({}, cur.partHeights || {}); for (const [r, h] of Object.entries(v || {})) { if (h == null || h === '') delete cur.partHeights[r]; else cur.partHeights[r] = +h; } }
      else if (k === 'cutouts') cur.cutouts = v;
      else if (typeof DEFAULTS[k] === 'boolean') cur[k] = !!v;
      else { const n = +v; if (!(n >= 0 && n < 500)) throw new Error(`${k} must be a number in mm`); cur[k] = n; }
    }
    S.enclosure = cur;
    return describe();
  }
  function addCutout(c) {
    const S = Model.S, cur = Object.assign({}, S.enclosure || {});
    const side = String(c.side || '').toLowerCase();
    if (!['left', 'right', 'front', 'back', 'lid', 'floor'].includes(side)) throw new Error('side must be left, right, front, back, lid or floor');
    const cut = { side, shape: c.shape === 'circle' ? 'circle' : 'rect', w: +c.width || +c.w || 5, h: +c.height || +c.h || +c.width || 5, label: c.label || '' };
    if (side === 'lid' || side === 'floor') { cut.x = +c.x || 0; cut.y = +c.y || 0; } else { cut.u = +c.u || +c.position || 0; cut.z = c.z != null ? +c.z : null; }
    cur.cutouts = (cur.cutouts || []).concat([cut]); S.enclosure = cur;
    return { index: cur.cutouts.length - 1, cutout: cut };
  }

  // ---------------- model ----------------
  // board coords (x right, y down) → enclosure coords (x right, y up)
  function layout() {
    const S = Model.S, P = params();
    if (!S.board.w || !Pcb.placed().length) throw new Error('Generate the PCB first — the enclosure is fitted to it');
    const bpoly = Pcb.boardPoly().map(q => [q[0], -q[1]]);
    const cs = Pcb.placed();
    let topH = 0, botH = 0;
    const parts = cs.map(c => {
      const b = Pcb.fpBox(c), h = partHeight(c, P), bottom = Pcb.isBottom(c);
      if (bottom) botH = Math.max(botH, h); else topH = Math.max(topH, h);
      const tht = Pcb.padsOf(c).some(p => p.drill); if (tht && !bottom) botH = Math.max(botH, 1.8); // leads under the board
      return { ref: c.ref, value: c.value, type: c.type, x0: b[0], x1: b[2], y0: -b[3], y1: -b[1], h, bottom, edge: Pcb.edgeInfo(c), c };
    });
    const standoff = Math.max(P.standoffHeight, botH + 1.0);
    const pcbZ = P.floor + standoff, pcbTop = pcbZ + P.pcbThickness;
    const H = +(pcbTop + topH + P.topClearance + P.extraHeight).toFixed(2);
    const inner = offset(bpoly, P.clearance), outer = offset(bpoly, P.clearance + P.wall);
    const xs = outer.map(q => q[0]), ys = outer.map(q => q[1]);
    const holes = (S.pcb.holes || []).map(h => ({ x: h.x, y: -h.y, d: h.d }));
    return { P, bpoly, inner, outer, parts, standoff, pcbZ, pcbTop, H, topH, botH, holes, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
  }
  // where each side wall is (in enclosure coords) and which board coordinate runs along it
  function sideInfo(L, side) {
    const [x0, y0, x1, y1] = L.bbox, t = L.P.wall + L.P.clearance;
    if (side === 'left') return { wx: x0 + L.P.wall / 2, axis: 'y', mid: (y0 + y1) / 2, bside: 'left' };
    if (side === 'right') return { wx: x1 - L.P.wall / 2, axis: 'y', mid: (y0 + y1) / 2, bside: 'right' };
    if (side === 'back') return { wy: y1 - L.P.wall / 2, axis: 'x', mid: (x0 + x1) / 2, bside: 'top' };    // board top edge (y = 0)
    return { wy: y0 + L.P.wall / 2, axis: 'x', mid: (x0 + x1) / 2, bside: 'bottom' };                     // front = board bottom edge
  }
  function cutoutList(L) {
    const P = L.P, out = [];
    if (P.autoConnectorCutouts) for (const p of L.parts) {
      if (!p.edge || !p.edge.plug || p.bottom) continue;
      const c = p.c, b = Pcb.fpBox(c), S = Model.S;
      const d = { left: b[0], right: S.board.w - b[2], back: b[1], front: S.board.h - b[3] };
      const side = Object.entries(d).sort((a, q) => a[1] - q[1])[0][0];
      const horiz = side === 'front' || side === 'back';
      const along = horiz ? (b[0] + b[2]) / 2 : -(b[1] + b[3]) / 2, size = horiz ? b[2] - b[0] : b[3] - b[1];
      out.push({ auto: true, ref: p.ref, side, shape: 'rect', centre: along, w: size + 1.2, h: p.h + 1.2, z: L.pcbTop + p.h / 2, label: `${p.ref} ${p.value || ''}`.trim() });
    }
    if (P.autoLidHoles) for (const p of L.parts) {
      if (p.bottom) continue;
      const cx = (p.x0 + p.x1) / 2, cy = (p.y0 + p.y1) / 2;
      if (p.type === 'led') out.push({ auto: true, ref: p.ref, side: 'lid', shape: 'circle', x: cx, y: cy, w: 3.4, h: 3.4, label: `${p.ref} LED` });
      if (p.type === 'switch') out.push({ auto: true, ref: p.ref, side: 'lid', shape: 'circle', x: cx, y: cy, w: 4.0, h: 4.0, label: `${p.ref} button` });
    }
    for (const c of P.cutouts) {
      if (c.side === 'lid' || c.side === 'floor') out.push(Object.assign({}, c, { x: c.x, y: c.y }));
      else { const si = sideInfo(L, c.side); out.push(Object.assign({}, c, { centre: si.mid + (c.u || 0), z: c.z != null ? c.z : L.pcbTop + 4 })); }
    }
    return out;
  }
  function build(opts = {}) {
    const L = layout(), P = L.P, H = L.H;
    // base: outer shell minus cavity
    let base = subtract(prism(L.outer, 0, H), prism(L.inner, P.floor, H + 1));
    // standoffs at mounting holes, or corner supports when the board has none
    const sup = L.holes.length ? L.holes : supportPoints(L);
    let posts = [];
    for (const h of sup) posts = posts.concat(prism(circle(h.x, h.y, P.standoffDiameter / 2, 24), P.floor - 0.01, P.floor + L.standoff));
    if (posts.length) base = union(base, posts);
    if (L.holes.length) { let sc = []; for (const h of L.holes) sc = sc.concat(prism(circle(h.x, h.y, P.screwHole / 2, 20), P.floor + 0.8, P.floor + L.standoff + 0.5)); base = subtract(base, sc); }
    // wall / floor cutouts
    const cuts = cutoutList(L);
    for (const c of cuts) {
      if (c.side === 'lid') continue;
      if (c.side === 'floor') { const g = c.shape === 'circle' ? circle(c.x, c.y, c.w / 2) : rect(c.x - c.w / 2, c.y - c.h / 2, c.x + c.w / 2, c.y + c.h / 2); base = subtract(base, prism(g, -1, P.floor + 0.5)); continue; }
      const si = sideInfo(L, c.side), depth = P.wall * 2 + P.clearance + 4;
      const cx = si.axis === 'x' ? c.centre : si.wx, cy = si.axis === 'y' ? c.centre : si.wy;
      // wall cutouts open at the top when they would reach the rim (easier to print, lets the board drop in)
      const zTop = Math.min(c.z + c.h / 2, H + 1), zBot = c.z - c.h / 2, hh = zTop - zBot;
      base = subtract(base, wallBox(cx, cy, zBot + hh / 2, c.w, depth, hh, si.axis === 'x' ? 'top' : 'left', c.shape === 'circle'));
    }
    // lid (assembled orientation: plate on top of the walls, lip hanging into the cavity)
    const lipOut = offset(L.bpoly, P.clearance - P.lidFit), lipIn = offset(L.bpoly, P.clearance - P.lidFit - P.lipWidth);
    let lid = union(prism(L.outer, H, H + P.lidThickness), subtract(prism(lipOut, H - P.lipHeight, H + 0.01), prism(lipIn, H - P.lipHeight - 1, H + 1)));
    let holesLid = [];
    for (const c of cuts) if (c.side === 'lid') holesLid = holesLid.concat(prism(c.shape === 'circle' ? circle(c.x, c.y, c.w / 2) : rect(c.x - c.w / 2, c.y - c.h / 2, c.x + c.w / 2, c.y + c.h / 2), H - P.lipHeight - 1, H + P.lidThickness + 1));
    if (P.vents) holesLid = holesLid.concat(ventSlots(L, cuts));
    if (holesLid.length) lid = subtract(lid, holesLid);
    return { L, base: repair(base), lid: repair(lid), cuts };
  }
  function supportPoints(L) {
    // small posts under the board corners (inset) when the PCB has no mounting holes
    const bx = L.bpoly.map(q => q[0]), by = L.bpoly.map(q => q[1]), i = Math.min(3, L.P.standoffDiameter / 2 + 0.5);
    const pts = [[Math.min(...bx) + i, Math.min(...by) + i], [Math.max(...bx) - i, Math.min(...by) + i], [Math.max(...bx) - i, Math.max(...by) - i], [Math.min(...bx) + i, Math.max(...by) - i]];
    return pts.filter(([x, y]) => inPoly2(x, y, L.bpoly)).map(([x, y]) => ({ x, y }));
  }
  function inPoly2(x, y, poly) { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; }
  function ventSlots(L, cuts) {
    const P = L.P, inner = offset(L.bpoly, P.clearance - (P.lidFit + P.lipWidth + 2.5)), xs = inner.map(q => q[0]), ys = inner.map(q => q[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, len = Math.min(P.ventLength, (Math.max(...xs) - Math.min(...xs)) * 0.6);
    const out = [], H = L.H, keep = cuts.filter(c => c.side === 'lid');
    for (let y = Math.min(...ys) + P.ventSpacing; y < Math.max(...ys) - P.ventSpacing / 2; y += P.ventSpacing) {
      const x0 = cx - len / 2, x1 = cx + len / 2;
      if (![[x0, y], [x1, y]].every(([x, yy]) => inPoly2(x, yy, inner))) continue;
      if (keep.some(c => Math.abs(c.y - y) < c.w / 2 + P.ventWidth && c.x > x0 - c.w && c.x < x1 + c.w)) continue;
      out.push(...prism(rect(x0, y - P.ventWidth / 2, x1, y + P.ventWidth / 2), H - 0.5, H + P.lidThickness + 1));
    }
    return out;
  }

  // ---------------- mesh repair ----------------
  // Weld vertices and split edges that have another vertex lying on them (T-junctions left by the BSP booleans),
  // so the exported mesh is watertight: every edge is shared by exactly two faces.
  function repair(polys) {
    const q = v => `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
    const verts = new Map();
    for (const p of polys) p.v = p.v.map(v => { const k = q(v); if (!verts.has(k)) verts.set(k, v); return verts.get(k); });
    const cell = 2, grid = new Map(), gk = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    for (const v of verts.values()) { const k = gk(v.x, v.y, v.z); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(v); }
    const near = (a, b) => {
      const out = [], x0 = Math.floor(Math.min(a.x, b.x) / cell), x1 = Math.floor(Math.max(a.x, b.x) / cell), y0 = Math.floor(Math.min(a.y, b.y) / cell), y1 = Math.floor(Math.max(a.y, b.y) / cell), z0 = Math.floor(Math.min(a.z, b.z) / cell), z1 = Math.floor(Math.max(a.z, b.z) / cell);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 4000) return [...verts.values()];
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) { const g = grid.get(`${x},${y},${z}`); if (g) out.push(...g); }
      return out;
    };
    const out = [];
    for (const p of polys) {
      const nv = [];
      for (let i = 0; i < p.v.length; i++) {
        const a = p.v[i], b = p.v[(i + 1) % p.v.length], ab = b.minus(a), L2 = ab.dot(ab);
        nv.push(a);
        if (L2 < 1e-12) continue;
        const on = [];
        for (const v of near(a, b)) {
          if (v === a || v === b) continue;
          const t = v.minus(a).dot(ab) / L2; if (t <= 1e-6 || t >= 1 - 1e-6) continue;
          const d = a.plus(ab.times(t)).minus(v); if (d.dot(d) < 1e-8) on.push([t, v]);
        }
        on.sort((x, y) => x[0] - y[0]); for (const [, v] of on) nv.push(v);
      }
      const clean = nv.filter((v, i) => v !== nv[(i + 1) % nv.length]);
      if (clean.length >= 3) out.push(new Poly(clean, p.plane));
    }
    return out;
  }

  // ---------------- outputs ----------------
  function triangles(polys, tf) {
    const t = [];
    for (const p of polys) {
      const v = tf ? p.v.map(tf) : p.v, n = v.length;
      // start the fan at a true corner so no zero-area triangles appear along split edges
      let s0 = 0;
      for (let i = 0; i < n; i++) { const a = v[(i - 1 + n) % n], b = v[i], c = v[(i + 1) % n]; if (b.minus(a).cross(c.minus(b)).len() > 1e-9) { s0 = i; break; } }
      const r = v.slice(s0).concat(v.slice(0, s0));
      for (let i = 1; i < n - 1; i++) { const area = r[i].minus(r[0]).cross(r[i + 1].minus(r[0])).len(); if (area > 1e-12) t.push([r[0], r[i], r[i + 1]]); else t.push([r[0], r[i], r[i + 1]]); }
    }
    return t;
  }
  function stl(polys, name, tf) {
    const tris = triangles(polys, tf), buf = new ArrayBuffer(84 + tris.length * 50), dv = new DataView(buf);
    const hdr = ('CircuitPilot ' + name).slice(0, 79); for (let i = 0; i < hdr.length; i++) dv.setUint8(i, hdr.charCodeAt(i));
    dv.setUint32(80, tris.length, true);
    let o = 84;
    for (const [a, b, c] of tris) {
      let n = b.minus(a).cross(c.minus(a)); const l = n.len(); n = l > 0 ? n.times(1 / l) : n;
      for (const v of [n, a, b, c]) { dv.setFloat32(o, v.x, true); dv.setFloat32(o + 4, v.y, true); dv.setFloat32(o + 8, v.z, true); o += 12; }
      dv.setUint16(o, 0, true); o += 2;
    }
    return new Uint8Array(buf);
  }
  // lid printed upside down: flip about X and sit it on the bed
  const lidPrintTf = (L) => v => new V(v.x, -v.y, (L.H + L.P.lidThickness) - v.z);
  function exportFiles(opts = {}) {
    const r = build(), name = (Model.S.name || 'board').replace(/[^\w.-]+/g, '_');
    const files = {};
    files[name + '-enclosure-base.stl'] = stl(r.base, 'enclosure base');
    files[name + '-enclosure-lid.stl'] = stl(r.lid, 'enclosure lid', lidPrintTf(r.L));
    files[name + '-enclosure.scad'] = scad(r);
    files[name + '-enclosure-README.txt'] = readme(r);
    return { files, info: describe(r) };
  }
  const f3 = v => (+v).toFixed(3);
  function scad(r) {
    const L = r.L, P = L.P, pts = s => '[' + s.map(q => `[${f3(q[0])},${f3(q[1])}]`).join(',') + ']';
    const lines = [];
    lines.push(`// CircuitPilot enclosure for "${Model.S.name || 'board'}" — parametric OpenSCAD source (mm)`, `// Edit the parameters below and render (F6), then export STL.`, '');
    for (const k of ['wall', 'floor', 'lidThickness', 'clearance', 'pcbThickness', 'topClearance', 'standoffDiameter', 'screwHole', 'lidFit', 'lipHeight', 'lipWidth'])
      lines.push(`${k} = ${f3(P[k])};`);
    lines.push(`standoff = ${f3(L.standoff)};        // raised to clear parts under the board`, `height = ${f3(L.H)};          // base height (tallest part ${f3(L.topH)} mm + topClearance)`, `$fn = 48;`, '');
    lines.push(`pcb = ${pts(L.bpoly)};  // board outline (y up)`);
    lines.push(`holes = [${L.holes.map(h => `[${f3(h.x)},${f3(h.y)}]`).join(',')}];`);
    lines.push(`supports = [${(L.holes.length ? [] : supportPoints(L)).map(h => `[${f3(h.x)},${f3(h.y)}]`).join(',')}];`, '');
    lines.push(`module inner(d=0) offset(r=clearance+d) polygon(pcb);`, `module outer() offset(r=clearance+wall) polygon(pcb);`, '');
    lines.push(`module base() difference() {`, `  union() {`, `    difference() { linear_extrude(height) outer(); translate([0,0,floor]) linear_extrude(height) inner(); }`,
      `    for (h = concat(holes, supports)) translate([h[0],h[1],floor-0.01]) cylinder(d=standoffDiameter, h=standoff+0.01);`, `  }`,
      `  for (h = holes) translate([h[0],h[1],floor+0.8]) cylinder(d=screwHole, h=standoff);`);
    for (const c of r.cuts) {
      if (c.side === 'lid') continue;
      if (c.side === 'floor') { lines.push(`  // ${c.label || 'floor cutout'}`, c.shape === 'circle' ? `  translate([${f3(c.x)},${f3(c.y)},-1]) cylinder(d=${f3(c.w)}, h=floor+2);` : `  translate([${f3(c.x - c.w / 2)},${f3(c.y - c.h / 2)},-1]) cube([${f3(c.w)},${f3(c.h)},floor+2]);`); continue; }
      const si = sideInfo(L, c.side), depth = P.wall * 2 + P.clearance + 4, zTop = Math.min(c.z + c.h / 2, L.H + 1), zBot = c.z - c.h / 2;
      const cx = si.axis === 'x' ? c.centre : si.wx, cy = si.axis === 'y' ? c.centre : si.wy;
      const sx = si.axis === 'x' ? c.w : depth, sy = si.axis === 'x' ? depth : c.w;
      lines.push(`  // ${c.label || c.side + ' cutout'}`, c.shape === 'circle'
        ? `  translate([${f3(cx)},${f3(cy)},${f3((zTop + zBot) / 2)}]) rotate(${si.axis === 'x' ? '[90,0,0]' : '[0,90,0]'}) cylinder(d=${f3(Math.min(c.w, c.h))}, h=${f3(depth)}, center=true);`
        : `  translate([${f3(cx - sx / 2)},${f3(cy - sy / 2)},${f3(zBot)}]) cube([${f3(sx)},${f3(sy)},${f3(zTop - zBot)}]);`);
    }
    lines.push(`}`, '');
    lines.push(`module lid() difference() {`, `  union() {`, `    translate([0,0,height]) linear_extrude(lidThickness) outer();`,
      `    translate([0,0,height-lipHeight]) linear_extrude(lipHeight+0.01) difference() { offset(delta=-lidFit) inner(); offset(delta=-lidFit-lipWidth) inner(); }`, `  }`);
    for (const c of r.cuts) if (c.side === 'lid') lines.push(`  // ${c.label || 'lid hole'}`, c.shape === 'circle' ? `  translate([${f3(c.x)},${f3(c.y)},height-lipHeight-1]) cylinder(d=${f3(c.w)}, h=lipHeight+lidThickness+2);` : `  translate([${f3(c.x - c.w / 2)},${f3(c.y - c.h / 2)},height-lipHeight-1]) cube([${f3(c.w)},${f3(c.h)},lipHeight+lidThickness+2]);`);
    if (P.vents) lines.push(`  // vents: see the STL (generated slots); add your own here`);
    lines.push(`}`, '', `base();`, `translate([0,0,${f3(P.explode || 12)}]) lid();   // exploded view — print the lid upside down`, '');
    return lines.join('\n');
  }
  function readme(r) {
    const d = describe(r);
    return [`CircuitPilot enclosure — ${Model.S.name || 'board'}`, '', `Outer size: ${d.outer_mm.join(' x ')} mm (base ${d.base_height} mm + lid ${d.lid_thickness} mm)`,
      `PCB sits ${d.pcb_bottom_z} mm above the bed on ${d.supports} ${d.mounting_holes ? 'standoffs (M3 screws, pilot hole ' + r.L.P.screwHole + ' mm)' : 'corner supports'}.`,
      `Cutouts: ${d.cutouts.map(c => c.label || c.side).join(', ') || 'none'}`, '',
      'Print: base as is; lid upside down (already oriented in the STL). 0.2 mm layers, 3 walls, 15-20 % infill; no supports needed for most cutouts.',
      'Fit: the lid lip is lidFit smaller than the cavity — increase lidFit in CircuitPilot if it is too tight.', '',
      'The .scad file is parametric OpenSCAD source of the same design.'].join('\n');
  }
  function describe(r) {
    const L = r ? r.L : layout(), cuts = r ? r.cuts : cutoutList(L), P = L.P;
    return {
      params: P, outer_mm: [+(L.bbox[2] - L.bbox[0]).toFixed(1), +(L.bbox[3] - L.bbox[1]).toFixed(1), +(L.H + P.lidThickness).toFixed(1)],
      base_height: L.H, lid_thickness: P.lidThickness, tallest_part_mm: L.topH, under_board_mm: L.botH, standoff_mm: L.standoff, pcb_bottom_z: +L.pcbZ.toFixed(2),
      mounting_holes: L.holes.length, supports: L.holes.length || supportPoints(L).length,
      cutouts: cuts.map((c, i) => ({ side: c.side, shape: c.shape, w: +(+c.w).toFixed(2), h: +(+c.h).toFixed(2), label: c.label, auto: !!c.auto, index: c.auto ? undefined : P.cutouts.indexOf(P.cutouts.find(q => q.label === c.label && q.side === c.side)) })),
      part_heights: Object.fromEntries(L.parts.map(p => [p.ref, p.h])),
    };
  }
  // three.js-friendly flat arrays for the preview
  function meshArrays(polys, tf) {
    const tris = triangles(polys, tf), pos = new Float32Array(tris.length * 9), nor = new Float32Array(tris.length * 9);
    tris.forEach(([a, b, c], i) => {
      let n = b.minus(a).cross(c.minus(a)); const l = n.len(); n = l > 0 ? n.times(1 / l) : n;
      [a, b, c].forEach((v, k) => { pos.set([v.x, v.y, v.z], i * 9 + k * 3); nor.set([n.x, n.y, n.z], i * 9 + k * 3); });
    });
    return { pos, nor, triangles: tris.length };
  }
  return { DEFAULTS, params, setParams, addCutout, layout, build, exportFiles, describe, meshArrays, partHeight, stl, offset };
})();
if (typeof module !== 'undefined') module.exports = Enclosure;
