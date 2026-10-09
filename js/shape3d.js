'use strict';
// Script-driven 3D modelling for custom enclosures (wearables, chest patches, organic cases, clips…).
// A small CSG language for the AI and the user: primitives, hulls, extrusions, revolves, booleans, transforms.
// One script evaluates to meshes (STL, preview) and to equivalent OpenSCAD source.
// Uses the CSG kernel of enclosure.js. No DOM — runs in a Web Worker and in Node (MCP server).
const Shape3D = (() => {
  const K = () => Enclosure.csg;
  let FN = 0; // global resolution override (segments per full circle); 0 = adaptive
  const fnFor = (r, fn) => Math.max(3, Math.round(fn || FN || Math.max(12, Math.min(48, Math.ceil(2 * Math.PI * r / 1.2)))));
  const num = (v, name) => { const n = +v; if (!isFinite(n)) throw new Error(`${name} must be a number (got ${JSON.stringify(v)})`); return n; };
  const vec3 = (v, name = 'vector', def = 0) => {
    if (typeof v === 'number') return [v, v, v];
    if (!Array.isArray(v)) throw new Error(`${name} must be [x, y, z]`);
    return [0, 1, 2].map(i => v[i] == null ? def : num(v[i], name));
  };
  const f = v => { const s = (+v).toFixed(4).replace(/\.?0+$/, ''); return s === '-0' ? '0' : s; };
  const fv = v => '[' + v.map(f).join(', ') + ']';

  // ---------- mesh helpers ----------
  function mk(vs) { // dedupe consecutive vertices, build a polygon
    const { Poly } = K(), out = [];
    for (const v of vs) { const q = out[out.length - 1]; if (!q || Math.abs(q.x - v.x) + Math.abs(q.y - v.y) + Math.abs(q.z - v.z) > 1e-9) out.push(v); }
    while (out.length > 1 && Math.abs(out[0].x - out[out.length - 1].x) + Math.abs(out[0].y - out[out.length - 1].y) + Math.abs(out[0].z - out[out.length - 1].z) <= 1e-9) out.pop();
    return out.length >= 3 ? Poly.make(out) : null;
  }
  function volumeOf(polys) {
    let v = 0;
    for (const p of polys) for (let i = 1; i < p.v.length - 1; i++) { const a = p.v[0], b = p.v[i], c = p.v[i + 1]; v += a.dot(b.cross(c)) / 6; }
    return v;
  }
  function outward(polys) { // make a closed mesh face outward
    if (volumeOf(polys) < 0) for (const p of polys) p.flip();
    return polys;
  }
  function fromFaces(verts, faces) {
    const { V } = K(), P = verts.map(q => new V(q[0], q[1], q[2])), out = [];
    for (const fc of faces) { const p = mk(fc.map(i => P[i])); if (p) out.push(p); }
    return outward(out);
  }
  function bboxOf(polys) {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const p of polys) for (const v of p.v) { if (v.x < b[0]) b[0] = v.x; if (v.y < b[1]) b[1] = v.y; if (v.z < b[2]) b[2] = v.z; if (v.x > b[3]) b[3] = v.x; if (v.y > b[4]) b[4] = v.y; if (v.z > b[5]) b[5] = v.z; }
    return b;
  }
  const overlap = (a, b, m = 0) => a[0] < b[3] + m && b[0] < a[3] + m && a[1] < b[4] + m && b[1] < a[4] + m && a[2] < b[5] + m && b[2] < a[5] + m;

  // ---------- 3D convex hull (quickhull: farthest point first, visible region grown through face adjacency) ----------
  function hull3(pts) {
    const { V, Poly, Plane } = K();
    const seen = new Map();
    for (const p of pts) { const k = `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)},${Math.round(p.z * 1e4)}`; if (!seen.has(k)) seen.set(k, p); }
    const P = [...seen.values()];
    if (P.length < 4) throw new Error('hull() needs a 3D shape (at least 4 distinct points)');
    const b = bboxOf([{ v: P }]), scale = Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]) || 1, eps = 1e-9 * scale * 64 + 1e-9;
    // initial tetrahedron from extreme points
    let i0 = 0, i1 = 0;
    for (let i = 0; i < P.length; i++) { if (P[i].x < P[i0].x) i0 = i; if (P[i].x > P[i1].x) i1 = i; }
    if (i0 === i1) i1 = P.findIndex((p, i) => i !== i0);
    const d01 = P[i1].minus(P[i0]);
    let i2 = -1, best = eps;
    for (let i = 0; i < P.length; i++) { const d = P[i].minus(P[i0]).cross(d01).len(); if (d > best) { best = d; i2 = i; } }
    if (i2 < 0) throw new Error('hull(): points are collinear');
    const n012 = P[i1].minus(P[i0]).cross(P[i2].minus(P[i0])).unit();
    let i3 = -1; best = eps;
    for (let i = 0; i < P.length; i++) { const d = Math.abs(P[i].minus(P[i0]).dot(n012)); if (d > best) { best = d; i3 = i; } }
    if (i3 < 0) throw new Error('hull(): points are flat — give the shapes some thickness');
    const edges = new Map(); // "a,b" → face owning the directed edge a→b
    const faces = [];
    const dist = (fc, p) => fc.n.dot(p) - fc.d;
    const newFace = (a, b, c) => {
      const n = P[b].minus(P[a]).cross(P[c].minus(P[a])), l = n.len();
      const fc = { v: [a, b, c], n: l > 0 ? n.times(1 / l) : n, d: 0, out: [], alive: true };
      fc.d = fc.n.dot(P[a]); faces.push(fc);
      edges.set(a + ',' + b, fc); edges.set(b + ',' + c, fc); edges.set(c + ',' + a, fc);
      return fc;
    };
    const ctr = P[i0].plus(P[i1]).plus(P[i2]).plus(P[i3]).times(0.25);
    for (const [a, b, c] of [[i0, i1, i2], [i0, i3, i1], [i0, i2, i3], [i1, i3, i2]]) {
      const n = P[b].minus(P[a]).cross(P[c].minus(P[a]));
      if (n.dot(ctr.minus(P[a])) > 0) newFace(a, c, b); else newFace(a, b, c);
    }
    const assign = (idxs, cands) => {
      for (const i of idxs) {
        let bf = null, bd = eps;
        for (const fc of cands) if (fc.alive) { const d = dist(fc, P[i]); if (d > bd) { bd = d; bf = fc; } }
        if (bf) bf.out.push(i);
      }
    };
    assign(P.map((_, i) => i).filter(i => i !== i0 && i !== i1 && i !== i2 && i !== i3), faces);
    for (let iter = 0; iter < 200000; iter++) {
      const f0 = faces.find(fc => fc.alive && fc.out.length);
      if (!f0) break;
      let eye = f0.out[0], ed = -1;
      for (const i of f0.out) { const d = dist(f0, P[i]); if (d > ed) { ed = d; eye = i; } }
      const E = P[eye];
      // visible region: flood from f0 across edges while the eye is strictly above the face
      const vis = new Set([f0]), stack = [f0], horizon = [];
      while (stack.length) {
        const fc = stack.pop();
        for (let k = 0; k < 3; k++) {
          const a = fc.v[k], b2 = fc.v[(k + 1) % 3], nb = edges.get(b2 + ',' + a);
          if (!nb || vis.has(nb)) continue;
          if (dist(nb, E) > eps) { vis.add(nb); stack.push(nb); } else horizon.push([a, b2]);
        }
      }
      const orphans = [];
      for (const fc of vis) {
        fc.alive = false;
        for (let k = 0; k < 3; k++) { const key = fc.v[k] + ',' + fc.v[(k + 1) % 3]; if (edges.get(key) === fc) edges.delete(key); }
        for (const i of fc.out) if (i !== eye) orphans.push(i);
        fc.out = [];
      }
      const made = horizon.map(([a, b2]) => newFace(a, b2, eye));
      assign(orphans, made);
      if ((iter & 255) === 255) for (let i = faces.length - 1; i >= 0; i--) if (!faces[i].alive) faces.splice(i, 1);
    }
    // merge coplanar neighbours into flat convex polygons (fewer, cleaner faces for the booleans)
    const live = faces.filter(fc => fc.alive), group = new Map();
    for (const fc of live) {
      if (group.has(fc)) continue;
      const g = [fc]; group.set(fc, g);
      for (let s = 0; s < g.length; s++) for (let k = 0; k < 3; k++) {
        const a = g[s].v[k], b2 = g[s].v[(k + 1) % 3], nb = edges.get(b2 + ',' + a);
        if (nb && nb.alive && !group.has(nb) && nb.n.dot(fc.n) > 1 - 1e-10 && Math.abs(nb.d - fc.d) < eps * 4) { group.set(nb, g); g.push(nb); }
      }
    }
    const out = [];
    for (const g of new Set(group.values())) {
      if (g.length === 1) { const p = mk(g[0].v.map(i => P[i])); if (p) out.push(p); continue; }
      // boundary of the merged region, walked in order
      const inner = new Set(); for (const fc of g) for (let k = 0; k < 3; k++) inner.add(fc.v[k] + ',' + fc.v[(k + 1) % 3]);
      const next = new Map();
      for (const fc of g) for (let k = 0; k < 3; k++) { const a = fc.v[k], b2 = fc.v[(k + 1) % 3]; if (!inner.has(b2 + ',' + a)) next.set(a, b2); }
      const start = next.keys().next().value, loop = [start];
      for (let c = next.get(start), guard = 0; c !== start && c != null && guard < 100000; c = next.get(c), guard++) loop.push(c);
      const n = g[0].n, pl = new Plane(new V(n.x, n.y, n.z), g[0].d);
      if (loop.length >= 3 && next.get(loop[loop.length - 1]) === start) out.push(new Poly(loop.map(i => P[i]), pl));
      else for (const fc of g) { const p = mk(fc.v.map(i => P[i])); if (p) out.push(p); }
    }
    return out;
  }

  // ---------- 2D shapes ----------
  class Shape2D {
    constructor(pts, src) { this.pts = K().ccw(K().dedupe(pts)); this.src = src || 'polygon'; if (this.pts.length < 3) throw new Error('2D shape needs at least 3 distinct points'); }
    _map(fn, flip) { const p = this.pts.map(fn); return new Shape2D(flip ? p.reverse() : p); }
    translate(v) { const x = num(v[0] || 0, 'x'), y = num(v[1] || 0, 'y'); return this._map(q => [q[0] + x, q[1] + y]); }
    rotate(deg) { const a = num(deg, 'angle') * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return this._map(q => [q[0] * c - q[1] * s, q[0] * s + q[1] * c]); }
    scale(v) { const [sx, sy] = typeof v === 'number' ? [v, v] : [num(v[0], 'sx'), num(v[1] ?? v[0], 'sy')]; return this._map(q => [q[0] * sx, q[1] * sy], sx * sy < 0); }
    mirror(v) { const [mx, my] = [v[0] || 0, v[1] || 0], l = Math.hypot(mx, my) || 1, nx = mx / l, ny = my / l; return this._map(q => { const d = 2 * (q[0] * nx + q[1] * ny); return [q[0] - d * nx, q[1] - d * ny]; }, true); }
    offset(r) { return new Shape2D(K().offset(this.pts, num(r, 'offset'))); }
    get bounds() { const xs = this.pts.map(q => q[0]), ys = this.pts.map(q => q[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; }
    get area() { return Math.abs(K().area(this.pts)); }
    extrude(h, o) { return extrude(this, h, o); }
    revolve(o) { return revolve(this, o); }
    scad() { return `polygon(${'[' + this.pts.map(q => `[${f(q[0])}, ${f(q[1])}]`).join(', ') + ']'})`; }
  }
  const is2 = s => s instanceof Shape2D;
  const need2 = (s, fn) => { if (!is2(s)) throw new Error(`${fn}() needs a 2D shape (square, rect, circle, ellipse, roundedRect, polygon, pcbOutline …)`); return s; };
  function circlePts(rx, ry, n) { return Array.from({ length: n }, (_, k) => [rx * Math.cos(k / n * 2 * Math.PI), ry * Math.sin(k / n * 2 * Math.PI)]); }
  const api2 = {
    square(size, o = {}) { const [w, h] = typeof size === 'number' ? [size, size] : [num(size[0], 'width'), num(size[1] ?? size[0], 'height')]; const x0 = o.center ? -w / 2 : 0, y0 = o.center ? -h / 2 : 0; return new Shape2D([[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]]); },
    rect(w, h, o = {}) { return api2.square([w, h], Object.assign({ center: true }, o)); },
    circle(r, o = {}) { if (typeof r === 'object') { o = r; r = o.r ?? o.d / 2; } r = num(r, 'r'); return new Shape2D(circlePts(r, r, fnFor(r, o.fn))); },
    ellipse(rx, ry, o = {}) { rx = num(rx, 'rx'); ry = num(ry ?? rx, 'ry'); return new Shape2D(circlePts(rx, ry, fnFor(Math.max(rx, ry), o.fn))); },
    roundedRect(w, h, r, o = {}) {
      w = num(w, 'width'); h = num(h, 'height'); r = Math.max(0, Math.min(num(r || 0, 'radius'), w / 2 - 1e-6, h / 2 - 1e-6));
      if (r <= 1e-6) return api2.rect(w, h, o);
      const n = Math.max(2, Math.ceil(fnFor(r, o.fn) / 4)), pts = [];
      for (const [cx, cy, a0] of [[w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, 90], [-w / 2 + r, -h / 2 + r, 180], [w / 2 - r, -h / 2 + r, 270]])
        for (let k = 0; k <= n; k++) { const a = (a0 + 90 * k / n) * Math.PI / 180; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
      const s = new Shape2D(pts); return o.center === false ? s.translate([w / 2, h / 2]) : s;
    },
    polygon(pts) { if (!Array.isArray(pts)) throw new Error('polygon() needs [[x,y], …]'); return new Shape2D(pts.map(q => [num(q[0], 'x'), num(q[1], 'y')])); },
    hull2d(...shapes) {
      const P = shapes.flat().flatMap(s => need2(s, 'hull2d').pts).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]), lo = [], up = [];
      for (const p of P) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
      for (const p of P.slice().reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
      return new Shape2D(lo.slice(0, -1).concat(up.slice(0, -1)));
    },
  };

  // ---------- 3D shapes (lazy node tree → polygons + OpenSCAD) ----------
  class Shape {
    constructor(node) { this.node = node; }
    get polys() { return evalNode(this.node); }
    translate(v) { return new Shape({ op: 'translate', v: vec3(v, 'translate'), c: [this.node] }); }
    rotate(a, axis) {
      if (axis) return new Shape({ op: 'rotate', a: num(a, 'angle'), axis: vec3(axis, 'axis'), c: [this.node] });
      return new Shape({ op: 'rotate', v: typeof a === 'number' ? [0, 0, a] : vec3(a, 'rotate'), c: [this.node] });
    }
    scale(v) { return new Shape({ op: 'scale', v: vec3(v, 'scale', 1), c: [this.node] }); }
    mirror(v) { return new Shape({ op: 'mirror', v: vec3(v, 'mirror'), c: [this.node] }); }
    color(c) { return new Shape({ op: 'color', col: String(c), c: [this.node] }); }
    union(...o) { return union(this, ...o); }
    subtract(...o) { return difference(this, ...o); }
    difference(...o) { return difference(this, ...o); }
    intersect(...o) { return intersection(this, ...o); }
    get bounds() { const b = bboxOf(this.polys); return { min: b.slice(0, 3), max: b.slice(3), size: [b[3] - b[0], b[4] - b[1], b[5] - b[2]] }; }
  }
  const need3 = (s, fn) => { if (s instanceof Shape) return s.node; if (is2(s)) throw new Error(`${fn}(): got a 2D shape — extrude() or revolve() it first`); throw new Error(`${fn}(): expected a 3D shape, got ${s === undefined ? 'undefined' : typeof s}`); };
  const list = (args, fn) => args.flat(Infinity).filter(s => s != null && s !== false).map(s => need3(s, fn));

  function matrixOf(n) {
    const I = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];
    if (n.op === 'translate') return [[1, 0, 0, n.v[0]], [0, 1, 0, n.v[1]], [0, 0, 1, n.v[2]]];
    if (n.op === 'scale') return [[n.v[0], 0, 0, 0], [0, n.v[1], 0, 0], [0, 0, n.v[2], 0]];
    if (n.op === 'mirror') { const l = Math.hypot(...n.v) || 1, [a, b, c] = n.v.map(x => x / l); return [[1 - 2 * a * a, -2 * a * b, -2 * a * c, 0], [-2 * a * b, 1 - 2 * b * b, -2 * b * c, 0], [-2 * a * c, -2 * b * c, 1 - 2 * c * c, 0]]; }
    if (n.op === 'rotate') {
      if (n.axis) {
        const l = Math.hypot(...n.axis) || 1, [x, y, z] = n.axis.map(q => q / l), t = n.a * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), C = 1 - c;
        return [[c + x * x * C, x * y * C - z * s, x * z * C + y * s, 0], [y * x * C + z * s, c + y * y * C, y * z * C - x * s, 0], [z * x * C - y * s, z * y * C + x * s, c + z * z * C, 0]];
      }
      const [ax, ay, az] = n.v.map(d => d * Math.PI / 180);
      const Rx = [[1, 0, 0], [0, Math.cos(ax), -Math.sin(ax)], [0, Math.sin(ax), Math.cos(ax)]];
      const Ry = [[Math.cos(ay), 0, Math.sin(ay)], [0, 1, 0], [-Math.sin(ay), 0, Math.cos(ay)]];
      const Rz = [[Math.cos(az), -Math.sin(az), 0], [Math.sin(az), Math.cos(az), 0], [0, 0, 1]];
      const mul = (A, B) => A.map((r, i) => [0, 1, 2].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
      const R = mul(Rz, mul(Ry, Rx)); // OpenSCAD order: X, then Y, then Z
      return R.map(r => r.concat(0));
    }
    return I;
  }
  function transform(polys, M) {
    const { V } = K();
    const det = M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
    const out = [];
    for (const p of polys) {
      let vs = p.v.map(v => new V(M[0][0] * v.x + M[0][1] * v.y + M[0][2] * v.z + M[0][3], M[1][0] * v.x + M[1][1] * v.y + M[1][2] * v.z + M[1][3], M[2][0] * v.x + M[2][1] * v.y + M[2][2] * v.z + M[2][3]));
      if (det < 0) vs = vs.reverse();
      const q = mk(vs); if (q) out.push(q);
    }
    return out;
  }
  let budget = null; // time guard for heavy booleans
  function evalNode(n) {
    if (n._p) return n._p;
    const C = K();
    let P;
    switch (n.op) {
      case 'cube': {
        const [x, y, z] = n.size, o = n.center ? [-x / 2, -y / 2, -z / 2] : [0, 0, 0];
        const v = [[0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0], [0, 0, z], [x, 0, z], [x, y, z], [0, y, z]].map(q => [q[0] + o[0], q[1] + o[1], q[2] + o[2]]);
        P = fromFaces(v, [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]); break;
      }
      case 'cylinder': {
        const fn = fnFor(Math.max(n.r1, n.r2), n.fn), z0 = n.center ? -n.h / 2 : 0, z1 = z0 + n.h, v = [], faces = [];
        for (let k = 0; k < fn; k++) { const a = k / fn * 2 * Math.PI; v.push([n.r1 * Math.cos(a), n.r1 * Math.sin(a), z0]); }
        for (let k = 0; k < fn; k++) { const a = k / fn * 2 * Math.PI; v.push([n.r2 * Math.cos(a), n.r2 * Math.sin(a), z1]); }
        for (let k = 0; k < fn; k++) { const j = (k + 1) % fn; faces.push([k, j, fn + j, fn + k]); }
        faces.push(Array.from({ length: fn }, (_, k) => fn - 1 - k), Array.from({ length: fn }, (_, k) => fn + k));
        P = fromFaces(v, faces.map(fc => fc)).filter(Boolean); break;
      }
      case 'sphere': {
        const fn = fnFor(n.r, n.fn), rings = Math.max(2, Math.round(fn / 2)), v = [], faces = [];
        for (let i = 0; i <= rings; i++) { const ph = Math.PI * i / rings; for (let k = 0; k < fn; k++) { const th = 2 * Math.PI * k / fn; v.push([n.r * Math.sin(ph) * Math.cos(th), n.r * Math.sin(ph) * Math.sin(th), n.r * Math.cos(ph)]); } }
        for (let i = 0; i < rings; i++) for (let k = 0; k < fn; k++) { const a = i * fn + k, b = i * fn + (k + 1) % fn, c = (i + 1) * fn + (k + 1) % fn, d = (i + 1) * fn + k; faces.push([a, d, c, b]); }
        P = fromFaces(v, faces); break;
      }
      case 'torus': {
        const fn = fnFor(n.R + n.r, n.fn), fn2 = fnFor(n.r, n.fn2), v = [], faces = [];
        for (let i = 0; i < fn; i++) { const th = 2 * Math.PI * i / fn; for (let k = 0; k < fn2; k++) { const ph = 2 * Math.PI * k / fn2, rr = n.R + n.r * Math.cos(ph); v.push([rr * Math.cos(th), rr * Math.sin(th), n.r * Math.sin(ph)]); } }
        for (let i = 0; i < fn; i++) for (let k = 0; k < fn2; k++) { const i2 = (i + 1) % fn, k2 = (k + 1) % fn2; faces.push([i * fn2 + k, i2 * fn2 + k, i2 * fn2 + k2, i * fn2 + k2]); }
        P = fromFaces(v, faces); break;
      }
      case 'extrude': {
        const pts = n.shape.pts, m = pts.length, z0 = n.center ? -n.h / 2 : 0, z1 = z0 + n.h, s = n.scale, v = [], faces = [];
        for (const q of pts) v.push([q[0], q[1], z0]);
        for (const q of pts) v.push([q[0] * s[0], q[1] * s[1], z1]);
        for (let k = 0; k < m; k++) { const j = (k + 1) % m; faces.push([k, j, m + j, m + k]); }
        for (const [a, b, c] of C.earcut(pts)) { faces.push([c, b, a]); faces.push([m + a, m + b, m + c]); }
        P = fromFaces(v, faces); break;
      }
      case 'revolve': {
        const pts = n.shape.pts, m = pts.length, full = n.angle >= 360 - 1e-9;
        if (pts.some(q => q[0] < -1e-9)) throw new Error('revolve(): the profile must lie at x ≥ 0 (x = distance from the Z axis, y = height)');
        const fn = fnFor(Math.max(...pts.map(q => q[0])), n.fn), steps = full ? fn : Math.max(1, Math.ceil(fn * n.angle / 360)), rings = full ? steps : steps + 1, v = [], faces = [];
        for (let i = 0; i < rings; i++) { const a = n.angle * Math.PI / 180 * i / steps; for (const q of pts) v.push([q[0] * Math.cos(a), q[0] * Math.sin(a), q[1]]); }
        for (let i = 0; i < steps; i++) { const i2 = full ? (i + 1) % steps : i + 1; for (let k = 0; k < m; k++) { const k2 = (k + 1) % m; faces.push([i * m + k, i * m + k2, i2 * m + k2, i2 * m + k]); } }
        if (!full) for (const [a, b, c] of C.earcut(pts)) { faces.push([a, b, c]); faces.push([steps * m + c, steps * m + b, steps * m + a]); }
        P = fromFaces(v, faces); break;
      }
      case 'roundedBox': {
        const [x, y, z] = n.size, r = n.r, o = n.center ? [0, 0, 0] : [x / 2, y / 2, z / 2], pts = [];
        const sp = evalNode({ op: 'sphere', r, fn: n.fn });
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) for (const p of sp) for (const v of p.v) pts.push(v.plus(new C.V(o[0] + sx * (x / 2 - r), o[1] + sy * (y / 2 - r), o[2] + sz * (z / 2 - r))));
        P = hull3(pts); break;
      }
      case 'hull': P = hull3(n.c.flatMap(c => evalNode(c).flatMap(p => p.v))); break;
      case 'union': P = n.c.map(evalNode).reduce((a, b) => { tick(); return C.union(a, b); }); break;
      case 'difference': { P = evalNode(n.c[0]); const rest = n.c.slice(1).map(evalNode); const ba = bboxOf(P); for (const b of rest) { tick(); if (b.length && overlap(ba, bboxOf(b))) P = C.subtract(P, b); } break; }
      case 'intersection': P = n.c.map(evalNode).reduce((a, b) => { tick(); return C.intersect(a, b); }); break;
      case 'color': P = evalNode(n.c[0]); break;
      default: P = transform(evalNode(n.c[0]), matrixOf(n));
    }
    n._p = P;
    return P;
  }
  function tick() { if (budget && Date.now() > budget) throw new Error('Model too complex: took longer than the time limit. Use fewer segments (fn), fewer/lower-resolution spheres in hulls, or fewer boolean operations.'); }

  // OpenSCAD source of a node tree
  function scadOf(n, ind = '') {
    const i2 = ind + '  ', kids = () => n.c.map(c => scadOf(c, i2)).join('\n'), fnS = fn => fn || FN ? `, $fn=${fn || FN}` : '';
    switch (n.op) {
      case 'cube': return `${ind}cube(${fv(n.size)}${n.center ? ', center=true' : ''});`;
      case 'cylinder': return `${ind}cylinder(h=${f(n.h)}, r1=${f(n.r1)}, r2=${f(n.r2)}${n.center ? ', center=true' : ''}, $fn=${fnFor(Math.max(n.r1, n.r2), n.fn)});`;
      case 'sphere': return `${ind}sphere(r=${f(n.r)}, $fn=${fnFor(n.r, n.fn)});`;
      case 'torus': return `${ind}rotate_extrude($fn=${fnFor(n.R + n.r, n.fn)}) translate([${f(n.R)}, 0]) circle(r=${f(n.r)}, $fn=${fnFor(n.r, n.fn2)});`;
      case 'extrude': return `${ind}linear_extrude(height=${f(n.h)}${n.center ? ', center=true' : ''}${n.scale[0] !== 1 || n.scale[1] !== 1 ? `, scale=[${f(n.scale[0])}, ${f(n.scale[1])}]` : ''}) ${n.shape.scad()};`;
      case 'revolve': return `${ind}rotate_extrude(angle=${f(n.angle)}, $fn=${fnFor(Math.max(...n.shape.pts.map(q => q[0])), n.fn)}) ${n.shape.scad()};`;
      case 'roundedBox': { const [x, y, z] = n.size, r = n.r, o = n.center ? [0, 0, 0] : [x / 2, y / 2, z / 2]; return `${ind}hull() for (sx = [-1, 1], sy = [-1, 1], sz = [-1, 1]) translate([${f(o[0])} + sx * ${f(x / 2 - r)}, ${f(o[1])} + sy * ${f(y / 2 - r)}, ${f(o[2])} + sz * ${f(z / 2 - r)}]) sphere(r=${f(r)}, $fn=${fnFor(r, n.fn)});`; }
      case 'hull': case 'union': case 'difference': case 'intersection': return `${ind}${n.op}() {\n${kids()}\n${ind}}`;
      case 'color': return `${ind}color("${n.col.replace(/"/g, '')}")\n${kids()}`;
      case 'translate': return `${ind}translate(${fv(n.v)})\n${kids()}`;
      case 'scale': return `${ind}scale(${fv(n.v)})\n${kids()}`;
      case 'mirror': return `${ind}mirror(${fv(n.v)})\n${kids()}`;
      case 'rotate': return n.axis ? `${ind}rotate(a=${f(n.a)}, v=${fv(n.axis)})\n${kids()}` : `${ind}rotate(${fv(n.v)})\n${kids()}`;
    }
    return `${ind}// (unsupported node ${n.op})`;
  }

  // ---------- public builder API ----------
  const S = node => new Shape(node);
  function cube(size, o = {}) { const s = vec3(size, 'cube size'); if (s.some(v => v <= 0)) throw new Error('cube size must be > 0'); return S({ op: 'cube', size: s, center: !!o.center }); }
  function cylinder(o = {}) {
    if (typeof o !== 'object') throw new Error('cylinder({h, r | d, r1, r2, center, fn})');
    const r = o.r ?? (o.d != null ? o.d / 2 : 1), r1 = num(o.r1 ?? (o.d1 != null ? o.d1 / 2 : r), 'r1'), r2 = num(o.r2 ?? (o.d2 != null ? o.d2 / 2 : r), 'r2'), h = num(o.h ?? 1, 'h');
    if (h <= 0 || r1 < 0 || r2 < 0 || r1 + r2 <= 0) throw new Error('cylinder: h > 0 and a radius > 0 are required');
    return S({ op: 'cylinder', h, r1, r2, center: !!o.center, fn: o.fn });
  }
  function sphere(o = {}) { const r = typeof o === 'number' ? o : (o.r ?? (o.d != null ? o.d / 2 : 1)); return S({ op: 'sphere', r: num(r, 'r'), fn: typeof o === 'object' ? o.fn : undefined }); }
  function torus(o = {}) { return S({ op: 'torus', R: num(o.R ?? 10, 'R'), r: num(o.r ?? 2, 'r'), fn: o.fn, fn2: o.fn2 }); }
  function roundedBox(size, r = 2, o = {}) {
    const s = vec3(size, 'roundedBox size'); r = Math.min(num(r, 'radius'), ...s.map(v => v / 2 - 1e-3));
    if (r <= 0.01) return cube(s, o);
    return S({ op: 'roundedBox', size: s, r, center: o.center !== false, fn: o.fn });
  }
  function extrude(shape, h, o = {}) {
    if (typeof h === 'object') { o = h; h = o.h ?? o.height; }
    need2(shape, 'extrude'); h = num(h, 'height'); if (h <= 0) throw new Error('extrude height must be > 0');
    const sc = o.scale == null ? [1, 1] : typeof o.scale === 'number' ? [o.scale, o.scale] : [num(o.scale[0], 'scale'), num(o.scale[1] ?? o.scale[0], 'scale')];
    return S({ op: 'extrude', shape, h, center: !!o.center, scale: sc });
  }
  function revolve(shape, o = {}) { need2(shape, 'revolve'); const angle = Math.max(1, Math.min(360, num(o.angle ?? 360, 'angle'))); return S({ op: 'revolve', shape, angle, fn: o.fn }); }
  const hull = (...s) => S({ op: 'hull', c: list(s, 'hull') });
  function union(...s) { const c = list(s, 'union'); if (!c.length) throw new Error('union() of nothing'); return c.length === 1 ? S(c[0]) : S({ op: 'union', c }); }
  function difference(a, ...s) { const c = list([a, ...s], 'difference'); return c.length === 1 ? S(c[0]) : S({ op: 'difference', c }); }
  function intersection(...s) { const c = list(s, 'intersection'); return c.length === 1 ? S(c[0]) : S({ op: 'intersection', c }); }

  // ---------- running a script ----------
  const HELP = `3D SCRIPT API (JavaScript; units mm; Z up). Build shapes, then register printable parts with part(name, shape, options).
COORDINATES: origin = centre of the PCB outline, X right, Y up (board "top" edge = +Y), Z = 0 at the PCB bottom face; PCB top at z = pcb.thickness.
CONTEXT: pcb = {w, h, thickness, outline:[[x,y],…], holes:[{x,y,d}], parts:[{ref,type,value,x0,y0,x1,y1,cx,cy,h,side:'top'|'bottom',edge:'left'|'right'|'front'|'back'|null,plug}]} or null when there is no PCB.
  Component boxes: x0..x1, y0..y1; top parts span z = pcb.thickness … pcb.thickness + h, bottom parts z = -h … 0. edge = board edge a connector opens to (front = -Y, back = +Y).
2D: square([w,h],{center}), rect(w,h) (centred), circle(r|{d,fn}), ellipse(rx,ry), roundedRect(w,h,r) (centred), polygon([[x,y],…]), hull2d(...shapes), pcbOutline(offset=0)
    2D methods: .translate([x,y]) .rotate(deg) .scale(s|[sx,sy]) .mirror([x,y]) .offset(r) (outward > 0) .bounds .area .extrude(h,{center,scale}) .revolve({angle,fn})
3D: cube([x,y,z],{center}), roundedBox([x,y,z], r, {center:true}) (all edges rounded — great for pods), cylinder({h, r|d, r1, r2, center, fn}),
    sphere(r|{r|d, fn}), torus({R, r}), extrude(shape2d, h, {center, scale}) (linear extrude, scale tapers the top),
    revolve(shape2d, {angle=360, fn}) (profile in X=radius / Y=height plane swept around Z — bands, rings, domes, curved straps),
    hull(...shapes) (convex hull — smooth organic pods from spheres/cylinders), union(...), difference(a, ...b), intersection(...)
    methods: .translate([x,y,z]) .rotate([ax,ay,az]) (degrees, X then Y then Z) or .rotate(deg, [axis]) .scale(s|[x,y,z]) .mirror([x,y,z]) .color('name') .union() .subtract() .intersect() .bounds {min,max,size}
HELPERS: board(extra=0) → PCB slab (outline offset by extra, z 0…thickness); partBoxes({clearance=0.5, side}) → union of component boxes (for cavities);
    resolution(fn) sets segments per circle (default adaptive 12–48; lower = faster); range(a,b,step); log(...); Math.*, PI.
OUTPUT: part(name, shape, {color, explode:[x,y,z] (offset in the exploded preview), print:{rotate:[ax,ay,az]} (orientation for the STL, dropped onto the bed)}).
    Each part is one STL. If no part() is called, the returned shape becomes part "model".
TIPS: hollow shells = difference(outer, inner) where inner is the same shape smaller by the wall; split into a "bottom" and a "top"/"lid" part along a Z plane with intersection(shell, cube) — add a lip so they snap/press-fit (0.15–0.25 mm clearance);
    leave 0.3–0.5 mm clearance around the PCB and 0.5 mm above the tallest part; minimum printable wall 1.2 mm (1.6–2 mm recommended); avoid overhangs > 45° or add print rotation.
    Wearables: wrist pods are curved underneath (intersect with a big cylinder of radius 30–40 mm along X), with strap slots/lugs (e.g. 22 mm strap → 23 × 2.5 mm slots); ECG/biopotential patches: snap-electrode studs are 3.9–4 mm, use holes of 4.2 mm on 30–60 mm spacing, keep electrodes on the skin side; leave charging/USB openings.`;

  const EXAMPLES = {
    wristband: `// Whoop-style wrist pod: concave underside that follows the wrist, rounded body, 22 mm strap lugs,
// press-fit lid with a lip, posts under the PCB, opening for the edge connector (USB-C).
resolution(28);
const t = 1.8, gap = 0.5, fit = 0.2;               // wall, PCB clearance, lid fit clearance
const strap = 22, wrist = 34;                      // strap width, wrist radius
const top = pcb ? Math.max(pcb.thickness, ...pcb.parts.filter(p => p.side === 'top').map(p => pcb.thickness + p.h)) : 6;
const under = pcb ? Math.max(0, ...pcb.parts.filter(p => p.side === 'bottom').map(p => p.h)) : 0;
const cw = (pcb ? pcb.w : 32) + 2 * gap, cl = (pcb ? pcb.h : 24) + 2 * gap;   // cavity
const W = cw + 2 * t, L = cl + 2 * t;
const sag = wrist - Math.sqrt(wrist * wrist - (L / 2) * (L / 2));            // depth of the wrist curve
const floorTop = -(under + 1.0);                   // PCB rests on posts 1 mm above the floor
const zb = floorTop - t - sag;                     // lowest point (pod ends)
const zt = top + 0.8 + t;                          // top of the lid
const H = zt - zb;
const body = roundedBox([W, L, H], Math.min(5, H / 2 - 0.1)).translate([0, 0, zb + H / 2]);
const curve = cylinder({ r: wrist, h: W + 20, center: true, fn: 120 }).rotate([0, 90, 0]).translate([0, 0, zb + sag - wrist]);
const lugs = [-1, 1].map(s => difference(
  roundedBox([strap + 6, 7, 5], 2).translate([0, s * (L / 2 + 2.5), zb + sag + 2.5]),
  cube([strap + 1, 2.6, 12], { center: true }).translate([0, s * (L / 2 + 3.2), zb + sag + 2.5])));
const cavity = roundedBox([cw, cl, zt - t - floorTop], 2).translate([0, 0, (floorTop + zt - t) / 2]);
let pod = difference(union(body, ...lugs), curve, cavity);
if (pcb) {                                          // posts under the board corners
  const posts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => cylinder({ d: 3, h: -floorTop + 0.01 }).translate([sx * (pcb.w / 2 - 2), sy * (pcb.h / 2 - 2), floorTop - 0.01]));
  pod = union(pod, ...posts);
  for (const c of pcb.parts.filter(p => p.edge && p.plug)) {   // connector openings through the wall
    const along = c.edge === 'left' || c.edge === 'right';
    const hole = roundedBox([along ? 20 : c.x1 - c.x0 + 1.6, along ? c.y1 - c.y0 + 1.6 : 20, Math.max(3.6, c.h + 1)], 1).translate([along ? (c.edge === 'left' ? -W / 2 : W / 2) : c.cx, along ? c.cy : (c.edge === 'front' ? -L / 2 : L / 2), pcb.thickness + c.h / 2]);
    pod = difference(pod, hole);
  }
}
const split = zt - t;                              // lid = top wall + a lip that drops into the cavity
const lip = difference(
  roundedBox([cw - 2 * fit, cl - 2 * fit, 2], 1.8).translate([0, 0, split - 1]),
  roundedBox([cw - 2 * fit - 2.4, cl - 2 * fit - 2.4, 4], 1.2).translate([0, 0, split - 1]));
part('pod', intersection(pod, cube([300, 300, 200]).translate([-150, -150, split - 200])), { color: 'dimgray' });
part('lid', union(intersection(pod, cube([300, 300, 200]).translate([-150, -150, split])), lip), { color: 'gainsboro', explode: [0, 0, 14], print: { rotate: [180, 0, 0] } });`,
    ecg: `// ECG chest node: low-profile oval pod with 3 snap-electrode holes on the skin side (RA, LA, RL),
// thick bosses around the studs, windows above LEDs and buttons, press-fit cover with a lip.
resolution(36);
const t = 1.6, gap = 0.6, fit = 0.2, stud = 4.2;  // wall, PCB clearance, cover fit, snap-stud hole (Ø3.9-4 mm studs)
const top = pcb ? Math.max(pcb.thickness, ...pcb.parts.filter(p => p.side === 'top').map(p => pcb.thickness + p.h)) : 5;
const under = pcb ? Math.max(0, ...pcb.parts.filter(p => p.side === 'bottom').map(p => p.h)) : 0;
const W = Math.max(70, (pcb ? pcb.w : 0) + 2 * (t + gap) + 24), L = Math.max(40, (pcb ? pcb.h : 0) + 2 * (t + gap) + 6);
const floorTop = -(under + 1.0), zb = floorTop - t - 1.5;   // 1.5 mm extra floor so the snap studs sit firmly
const zt = top + 0.8 + t, H = zt - zb;
const oval = (rx, ry, z0, z1) => hull(extrude(ellipse(rx, ry), 0.01).translate([0, 0, z0]), extrude(ellipse(rx - 2.5, ry - 2.5), 0.01).translate([0, 0, z1 - 0.01]));
const body = oval(W / 2, L / 2, zb, zt);
const cavity = oval(W / 2 - t, L / 2 - t, floorTop, zt - t);
const electrodes = [[-W / 2 + 9, 0], [W / 2 - 9, 0], [0, -L / 2 + 8]];   // RA, LA, RL — 50+ mm apart
const studs = electrodes.map(([x, y]) => cylinder({ d: stud, h: 20, center: true }).translate([x, y, zb]));
const bosses = electrodes.map(([x, y]) => cylinder({ d: 10, h: floorTop - zb + 0.01 }).translate([x, y, zb]));
let shell = difference(union(difference(body, cavity), ...bosses), ...studs);
if (pcb) {
  const posts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => cylinder({ d: 3, h: -floorTop + 0.01 }).translate([sx * (pcb.w / 2 - 2), sy * (pcb.h / 2 - 2), floorTop - 0.01]));
  shell = union(shell, ...posts);
  for (const p of pcb.parts.filter(p => p.side === 'top' && /led|switch/i.test(p.type)))
    shell = difference(shell, cylinder({ d: /led/i.test(p.type) ? 2.5 : 4.5, h: 20 }).translate([p.cx, p.cy, zt - 10]));
}
const split = zt - t;
const lip = difference(oval(W / 2 - t - fit, L / 2 - t - fit, split - 2, split), oval(W / 2 - t - fit - 1.2, L / 2 - t - fit - 1.2, split - 3, split + 1));
part('base', intersection(shell, cube([300, 300, 200]).translate([-150, -150, split - 200])), { color: 'white' });
part('cover', union(intersection(shell, cube([300, 300, 200]).translate([-150, -150, split])), lip), { color: 'lightskyblue', explode: [0, 0, 12], print: { rotate: [180, 0, 0] } });`,
    box: `// Rounded box around the PCB: board on corner posts, connector openings, press-fit lid with a lip.
resolution(24);
const t = 2, gap = 0.5, fit = 0.2;
const top = Math.max(pcb.thickness, ...pcb.parts.filter(p => p.side === 'top').map(p => pcb.thickness + p.h));
const under = Math.max(0, ...pcb.parts.filter(p => p.side === 'bottom').map(p => p.h));
const cw = pcb.w + 2 * gap, cl = pcb.h + 2 * gap, W = cw + 2 * t, L = cl + 2 * t;
const floorTop = -(under + 3), zb = floorTop - t, zt = top + 1.5 + t, H = zt - zb;
let shell = difference(roundedBox([W, L, H], 3).translate([0, 0, zb + H / 2]), roundedBox([cw, cl, zt - t - floorTop], 1).translate([0, 0, (floorTop + zt - t) / 2]));
shell = union(shell, ...[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => cylinder({ d: 4, h: -floorTop + 0.01 }).translate([sx * (pcb.w / 2 - 2.5), sy * (pcb.h / 2 - 2.5), floorTop - 0.01])));
for (const c of pcb.parts.filter(p => p.edge && p.plug)) {
  const along = c.edge === 'left' || c.edge === 'right';
  shell = difference(shell, cube([along ? 20 : c.x1 - c.x0 + 1.5, along ? c.y1 - c.y0 + 1.5 : 20, Math.max(3.6, c.h + 1)], { center: true }).translate([along ? (c.edge === 'left' ? -W / 2 : W / 2) : c.cx, along ? c.cy : (c.edge === 'front' ? -L / 2 : L / 2), pcb.thickness + c.h / 2]));
}
const split = zt - t;
const lip = difference(roundedBox([cw - 2 * fit, cl - 2 * fit, 2], 0.8).translate([0, 0, split - 1]), cube([cw - 2 * fit - 2.4, cl - 2 * fit - 2.4, 4], { center: true }).translate([0, 0, split - 1]));
part('base', intersection(shell, cube([400, 400, 200]).translate([-200, -200, split - 200])), { color: 'steelblue' });
part('lid', union(intersection(shell, cube([400, 400, 200]).translate([-200, -200, split])), lip), { color: 'yellowgreen', explode: [0, 0, 12], print: { rotate: [180, 0, 0] } });`,
  };

  // context: board data in script coordinates (origin = outline centre, y up, z = 0 at the board bottom)
  function context(L) {
    if (!L) return { pcb: null };
    const xs = L.bpoly.map(q => q[0]), ys = L.bpoly.map(q => q[1]);
    const ox = (Math.min(...xs) + Math.max(...xs)) / 2, oy = (Math.min(...ys) + Math.max(...ys)) / 2, r = v => +v.toFixed(3);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    const parts = L.parts.map(p => {
      const x0 = p.x0 - ox, x1 = p.x1 - ox, y0 = p.y0 - oy, y1 = p.y1 - oy;
      let edge = null;
      if (p.edge) { const d = [['left', x0 + w / 2], ['right', w / 2 - x1], ['front', y0 + h / 2], ['back', h / 2 - y1]].sort((a, b) => a[1] - b[1]); edge = d[0][0]; }
      return { ref: p.ref, type: p.type, value: p.value, x0: r(x0), y0: r(y0), x1: r(x1), y1: r(y1), cx: r((x0 + x1) / 2), cy: r((y0 + y1) / 2), h: p.h, side: p.bottom ? 'bottom' : 'top', edge, plug: !!(p.edge && p.edge.plug) };
    });
    return { pcb: { w: r(w), h: r(h), thickness: L.P.pcbThickness, outline: L.bpoly.map(q => [r(q[0] - ox), r(q[1] - oy)]), holes: L.holes.map(q => ({ x: r(q.x - ox), y: r(q.y - oy), d: q.d })), parts }, origin: [ox, oy, L.pcbZ] };
  }

  function run(code, ctx = {}, opts = {}) {
    const t0 = Date.now(), parts = [], logs = [];
    budget = t0 + (opts.timeLimitMs || 90000); K().guard.deadline = budget;
    FN = 0;
    const pcb = ctx.pcb || null;
    const lib = {
      square: api2.square, rect: api2.rect, circle: api2.circle, ellipse: api2.ellipse, roundedRect: api2.roundedRect, polygon: api2.polygon, hull2d: api2.hull2d,
      cube, box: cube, roundedBox, cylinder, sphere, torus, extrude, linearExtrude: extrude, revolve, rotateExtrude: revolve, hull, union, difference, intersection,
      pcbOutline: (off = 0) => { if (!pcb) throw new Error('pcbOutline(): this project has no PCB yet'); const s = new Shape2D(pcb.outline); return off ? s.offset(off) : s; },
      board: (extra = 0) => { if (!pcb) throw new Error('board(): this project has no PCB yet'); return extrude(lib.pcbOutline(extra), pcb.thickness); },
      partBoxes: (o = {}) => {
        if (!pcb) throw new Error('partBoxes(): this project has no PCB yet');
        const c = o.clearance ?? 0.5, ps = pcb.parts.filter(p => !o.side || p.side === o.side);
        return union(ps.map(p => cube([p.x1 - p.x0 + 2 * c, p.y1 - p.y0 + 2 * c, p.h + c]).translate([p.x0 - c, p.y0 - c, p.side === 'top' ? pcb.thickness : -p.h - c])));
      },
      part: (name, shape, o = {}) => { need3(shape, 'part'); parts.push({ name: String(name || 'part' + (parts.length + 1)).replace(/[^\w.-]+/g, '_'), shape, color: o.color, explode: o.explode ? vec3(o.explode, 'explode') : null, print: o.print || null }); return shape; },
      resolution: n => { FN = Math.max(0, Math.min(256, Math.round(+n || 0))); },
      range: (a, b, s = 1) => { const out = []; for (let x = a; s > 0 ? x <= b + 1e-9 : x >= b - 1e-9; x += s) { out.push(+x.toFixed(9)); if (out.length > 10000) break; } return out; },
      log: (...a) => { logs.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); },
      PI: Math.PI, pcb,
    };
    const names = Object.keys(lib);
    let ret;
    try {
      const fn = new Function(...names, 'console', '"use strict";\n' + code);
      ret = fn(...names.map(k => lib[k]), { log: lib.log, warn: lib.log, error: lib.log });
      if (!parts.length && ret instanceof Shape) lib.part('model', ret);
      if (!parts.length) throw new Error('The script made no parts — call part("name", shape) (or return a shape).');
      for (const p of parts) { p.polys = K().fillHoles(K().zipSeams(K().repair(p.shape.polys.map(q => q.clone())))); if (!p.polys.length) throw new Error(`part "${p.name}" is empty (check the boolean operations / positions)`); }
    } catch (e) {
      const m = String(e && e.stack || '').match(/<anonymous>:(\d+):(\d+)/);
      const err = new Error((e && e.message || String(e)) + (m ? ` (script line ${+m[1] - 3})` : ''));
      err.line = m ? +m[1] - 3 : null; err.logs = logs; budget = null; K().guard.deadline = 0; throw err;
    }
    // fit report: shells must not cut into the board or the components
    const report = { collisions: [], warnings: [] };
    if (pcb && opts.check !== false) {
      // sample points inside the board and each component box; count those that fall inside a printed part
      const inPoly = (x, y, P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
      const targets = [];
      { const xs = pcb.outline.map(q => q[0]), ys = pcb.outline.map(q => q[1]), st = Math.max(0.8, Math.sqrt(pcb.w * pcb.h / 600)), pts = [];
        for (let x = Math.min(...xs) + st / 2; x < Math.max(...xs); x += st) for (let y = Math.min(...ys) + st / 2; y < Math.max(...ys); y += st) if (inPoly(x, y, pcb.outline)) pts.push([x, y, pcb.thickness / 2]);
        targets.push({ with: 'PCB', pts, cell: st * st * pcb.thickness }); }
      for (const p of pcb.parts.slice(0, 120)) {
        const nx = 5, ny = 5, nz = 3, w = p.x1 - p.x0, d = p.y1 - p.y0, z0 = p.side === 'top' ? pcb.thickness : -p.h, pts = [];
        for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) pts.push([p.x0 + w * (i + 0.5) / nx, p.y0 + d * (j + 0.5) / ny, z0 + p.h * (k + 0.5) / nz]);
        targets.push({ with: p.ref, pts, cell: w * d * p.h / (nx * ny * nz) });
      }
      for (const p of parts) {
        const pb = bboxOf(p.polys), T = K().triangles(p.polys).map(([a, b, c]) => [a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z]);
        // bucket triangles on a Y-Z grid: a ray along X only meets the triangles of its own cell
        const cs = Math.max(0.5, Math.max(pb[4] - pb[1], pb[5] - pb[2]) / 64), grid = new Map();
        T.forEach((t, i) => {
          const y0 = Math.floor((Math.min(t[1], t[4], t[7]) - pb[1]) / cs), y1 = Math.floor((Math.max(t[1], t[4], t[7]) - pb[1]) / cs), z0 = Math.floor((Math.min(t[2], t[5], t[8]) - pb[2]) / cs), z1 = Math.floor((Math.max(t[2], t[5], t[8]) - pb[2]) / cs);
          for (let a = y0; a <= y1; a++) for (let b = z0; b <= z1; b++) { const k = a * 4096 + b; let g = grid.get(k); if (!g) grid.set(k, g = []); g.push(t); }
        });
        const inside = (x, y, z) => { // ray along +X (slightly tilted) — odd number of crossings = inside
          if (x < pb[0] || x > pb[3] || y < pb[1] || y > pb[4] || z < pb[2] || z > pb[5]) return false;
          const dx = 1, dy = 1.3e-4, dz = 2.7e-4; let n = 0;
          for (const t of grid.get(Math.floor((y - pb[1]) / cs) * 4096 + Math.floor((z - pb[2]) / cs)) || []) {
            if (Math.max(t[0], t[3], t[6]) < x) continue;
            const e1x = t[3] - t[0], e1y = t[4] - t[1], e1z = t[5] - t[2], e2x = t[6] - t[0], e2y = t[7] - t[1], e2z = t[8] - t[2];
            const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x, det = e1x * px + e1y * py + e1z * pz;
            if (Math.abs(det) < 1e-12) continue;
            const inv = 1 / det, sx = x - t[0], sy = y - t[1], sz = z - t[2], u = (sx * px + sy * py + sz * pz) * inv; if (u < 0 || u > 1) continue;
            const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x, v = (dx * qx + dy * qy + dz * qz) * inv; if (v < 0 || u + v > 1) continue;
            if ((e2x * qx + e2y * qy + e2z * qz) * inv > 0) n++;
          }
          return (n & 1) === 1;
        };
        for (const tg of targets) {
          let hit = 0; for (const q of tg.pts) if (inside(q[0], q[1], q[2])) hit++;
          const v = hit * tg.cell;
          if (hit && v > 0.5) report.collisions.push({ part: p.name, with: tg.with, overlap_mm3: +v.toFixed(1) });
        }
        if (Date.now() > budget) { report.warnings.push('fit check stopped early (time limit)'); break; }
      }
    }
    budget = null; K().guard.deadline = 0;
    // outputs
    const { V } = K();
    const out = parts.map(p => {
      const b = bboxOf(p.polys), tris = K().triangles(p.polys);
      const edges = new Map(), q = v => `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
      for (const [a, bb, c] of tris) for (const [u, w] of [[a, bb], [bb, c], [c, a]]) { const ku = q(u), kw = q(w); if (ku === kw) continue; const k = ku < kw ? ku + '|' + kw : kw + '|' + ku; edges.set(k, (edges.get(k) || 0) + 1); }
      let open = 0; for (const n of edges.values()) if (n !== 2) open++;
      // print orientation: rotate, then sit on the bed (z min = 0), centred on x/y
      let tf = null;
      if (p.print && p.print.rotate) {
        const M = matrixOf({ op: 'rotate', v: vec3(p.print.rotate, 'print.rotate') });
        const rot = v => new V(M[0][0] * v.x + M[0][1] * v.y + M[0][2] * v.z, M[1][0] * v.x + M[1][1] * v.y + M[1][2] * v.z, M[2][0] * v.x + M[2][1] * v.y + M[2][2] * v.z);
        let zmin = Infinity; for (const pl of p.polys) for (const v of pl.v) zmin = Math.min(zmin, rot(v).z);
        tf = v => { const r = rot(v); return new V(r.x, r.y, r.z - zmin); };
      } else tf = v => new V(v.x, v.y, v.z - b[2]);
      const r = { name: p.name, color: p.color || null, explode: p.explode, bbox: b.map(v => +v.toFixed(2)), size_mm: [b[3] - b[0], b[4] - b[1], b[5] - b[2]].map(v => +v.toFixed(2)), volume_cm3: +(volumeOf(p.polys) / 1000).toFixed(2), triangles: tris.length, open_edges: open };
      if (opts.keepPolys) r.polys = p.polys;
      if (opts.mesh !== false) Object.assign(r, K().meshArrays(p.polys));
      if (opts.stl !== false) r.stl = K().stl(p.polys, p.name, tf);
      return r;
    });
    if (out.some(p => p.open_edges)) report.warnings.push('some parts are not perfectly watertight (open_edges > 0) — most slicers repair this automatically');
    const scad = ['// CircuitPilot custom enclosure — OpenSCAD source generated from the 3D script (mm).', '// Coordinates: origin = PCB outline centre, Z = 0 at the PCB bottom.', '// Render one part: put ! in front of its call at the bottom, F6, then export STL.', '']
      .concat(parts.map(p => `module ${p.name.replace(/[^\w]/g, '_')}() {\n${scadOf(p.shape.node, '  ')}\n}\n`))
      .concat(parts.map(p => `${p.color ? `color("${p.color}") ` : ''}${p.explode ? `translate(${fv(p.explode)}) ` : ''}${p.name.replace(/[^\w]/g, '_')}();`)).join('\n') + '\n';
    return { parts: out, scad, logs, report, ms: Date.now() - t0 };
  }
  return { run, context, HELP, EXAMPLES, Shape, Shape2D };
})();
if (typeof module !== 'undefined') module.exports = Shape3D;
