'use strict';
// Interchange with EasyEDA (Standard edition "EasyEDA Source" JSON, also importable into EasyEDA Pro):
//  - exportSchematic(): the current schematic as an EasyEDA schematic document (docType 1)
//  - importPcb(json):   an EasyEDA PCB document (docType 3) → parts, footprints, placement, nets, tracks, vias, pours, outline
// Format reference: EasyEDA "Document Format" documentation. 1 EasyEDA unit = 10 mil = 0.254 mm, Y points down.
const EasyEDA = (() => {
  const U = 0.254;
  const n4 = v => +(+v).toFixed(4), n2 = v => +(+v).toFixed(2);

  // ---------- SVG geometry → polylines (used for symbol graphics and PCB arcs / areas) ----------
  function pathToPolys(d, steps = 8) {
    const toks = String(d).match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) || [];
    const out = []; let cur = null, x = 0, y = 0, sx = 0, sy = 0, cmd = '', i = 0;
    const num = () => +toks[i++];
    const add = (px, py) => { if (!cur) { cur = [[x, y]]; out.push(cur); } cur.push([px, py]); x = px; y = py; };
    while (i < toks.length) {
      if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
      const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
      if (C === 'Z') { if (cur) { cur.push([sx, sy]); x = sx; y = sy; } cur = null; continue; }
      if (i >= toks.length) break;
      if (C === 'M') { x = num() + (rel ? x : 0); y = num() + (rel ? y : 0); sx = x; sy = y; cur = [[x, y]]; out.push(cur); cmd = rel ? 'l' : 'L'; }
      else if (C === 'L') { const px = num() + (rel ? x : 0), py = num() + (rel ? y : 0); add(px, py); }
      else if (C === 'H') add(num() + (rel ? x : 0), y);
      else if (C === 'V') add(x, num() + (rel ? y : 0));
      else if (C === 'Q') { const x1 = num() + (rel ? x : 0), y1 = num() + (rel ? y : 0), x2 = num() + (rel ? x : 0), y2 = num() + (rel ? y : 0), x0 = x, y0 = y; for (let k = 1; k <= steps; k++) { const t = k / steps, a = (1 - t) * (1 - t), b = 2 * t * (1 - t), c = t * t; add(a * x0 + b * x1 + c * x2, a * y0 + b * y1 + c * y2); } }
      else if (C === 'C') { const x1 = num() + (rel ? x : 0), y1 = num() + (rel ? y : 0), x2 = num() + (rel ? x : 0), y2 = num() + (rel ? y : 0), x3 = num() + (rel ? x : 0), y3 = num() + (rel ? y : 0), x0 = x, y0 = y; for (let k = 1; k <= steps; k++) { const t = k / steps, u = 1 - t; add(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3); } }
      else if (C === 'A') { const rx = num(), ry = num(), ph = num(), la = num(), sw = num(), ex = num() + (rel ? x : 0), ey = num() + (rel ? y : 0); for (const p of arcPts(x, y, rx, ry, ph, la, sw, ex, ey, steps * 2)) add(p[0], p[1]); }
      else i++; // unsupported command: skip a token
    }
    return out.filter(p => p.length >= 2);
  }
  // SVG endpoint arc → points (excluding the start point)
  function arcPts(x1, y1, rx, ry, phi, fa, fs, x2, y2, n) {
    if (!rx || !ry) return [[x2, y2]];
    const p = phi * Math.PI / 180, cp = Math.cos(p), sp = Math.sin(p);
    const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2, x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
    rx = Math.abs(rx); ry = Math.abs(ry);
    const lam = x1p * x1p / (rx * rx) + y1p * y1p / (ry * ry); if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
    let s = Math.sqrt(Math.max(0, (rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p) / (rx * rx * y1p * y1p + ry * ry * x1p * x1p)));
    if (+fa === +fs) s = -s;
    const cxp = s * rx * y1p / ry, cyp = -s * ry * x1p / rx, cx = cp * cxp - sp * cyp + (x1 + x2) / 2, cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
    const ang = (ux, uy, vx, vy) => { const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy); return a; };
    const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry); let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!+fs && dt > 0) dt -= 2 * Math.PI; else if (+fs && dt < 0) dt += 2 * Math.PI;
    const k = Math.max(2, Math.ceil(n * Math.abs(dt) / Math.PI)), out = [];
    for (let i = 1; i <= k; i++) { const t = t1 + dt * i / k, ex = rx * Math.cos(t), ey = ry * Math.sin(t); out.push([cp * ex - sp * ey + cx, sp * ex + cp * ey + cy]); }
    return out;
  }
  // our symbol SVG fragment (local coordinates) → polylines / circles
  function svgFragment(svg) {
    const items = [], attr = (s, k) => { const m = new RegExp('\\s' + k + '="([^"]*)"').exec(s); return m ? m[1] : null; };
    for (const m of String(svg).matchAll(/<(path|rect|circle|line|polyline|polygon|ellipse)\b([^>]*)\/?>/g)) {
      const [, tag, a] = m, cls = attr(a, 'class') || '', fill = /\bfill\b/.test(cls);
      if (tag === 'path') for (const pl of pathToPolys(attr(a, 'd') || '')) items.push({ k: 'pl', pts: pl, fill });
      else if (tag === 'rect') { const x = +attr(a, 'x') || 0, y = +attr(a, 'y') || 0, w = +attr(a, 'width') || 0, h = +attr(a, 'height') || 0; items.push({ k: 'pl', pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]], fill }); }
      else if (tag === 'circle') items.push({ k: 'c', cx: +attr(a, 'cx') || 0, cy: +attr(a, 'cy') || 0, r: +attr(a, 'r') || 1, fill });
      else if (tag === 'ellipse') items.push({ k: 'c', cx: +attr(a, 'cx') || 0, cy: +attr(a, 'cy') || 0, r: (+attr(a, 'rx') + +attr(a, 'ry')) / 2 || 1, fill });
      else if (tag === 'line') items.push({ k: 'pl', pts: [[+attr(a, 'x1'), +attr(a, 'y1')], [+attr(a, 'x2'), +attr(a, 'y2')]] });
      else { const v = (attr(a, 'points') || '').trim().split(/[\s,]+/).map(Number), pts = []; for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i], v[i + 1]]); if (tag === 'polygon' && pts.length) pts.push(pts[0]); items.push({ k: 'pl', pts, fill }); }
    }
    return items;
  }

  // ---------- schematic export ----------
  // multi-sheet designs: each sheet gets its own area (3000 units apart) so parts never overlap in the export
  function exportSchematic() {
    const shifts = Model.S.components.map(c => [c, (Model.sheetOf ? Model.sheetOf(c) : 0) * 3000]);
    for (const [c, d] of shifts) c.x += d;
    try { return exportSchematicRaw(); } finally { for (const [c, d] of shifts) c.x -= d; }
  }
  function exportSchematicRaw() {
    const S = Model.S, shapes = [];
    let gid = 0; const id = () => 'gge' + (++gid).toString(36) + 'cp';
    const bb = [Infinity, Infinity, -Infinity, -Infinity], grow = (x, y) => { bb[0] = Math.min(bb[0], x); bb[1] = Math.min(bb[1], y); bb[2] = Math.max(bb[2], x); bb[3] = Math.max(bb[3], y); };
    const idx = Model.pinIndex();
    for (const c of S.components) {
      const d = Lib.type(c.type); if (!d) continue;
      const tf = (x, y) => { const [rx, ry] = Lib.rot(x, y, c.rot || 0); return [n2(c.x + rx), n2(c.y + ry)]; };
      const lib = c.lcsc && S.lib[c.lcsc];
      const fp = (lib && lib.footprint && lib.footprint.name) || c.footprint || '';
      const lcsc = c.type === 'part' ? (/^C\d+$/.test(c.lcsc || '') ? c.lcsc : '') : (c.lcscPart || '');
      const para = ['package', fp, 'pre', (c.ref.replace(/\d+$/, '') || d.prefix || 'U') + '?', 'Contributor', 'CircuitPilot', 'Supplier', lcsc ? 'LCSC' : '', 'Supplier Part', lcsc, 'Manufacturer Part', (lib && lib.mfr_part) || c.value || '', 'Manufacturer', (lib && lib.manufacturer) || ''];
      const sub = [];
      // graphics
      let svg = '';
      try { svg = c.type === 'part' && lib ? Lib.drawPart(lib).svg : d.draw(c); } catch (e) { svg = ''; }
      if (!svg && d.box) { const b = d.box(c); svg = `<rect x="${b[0]}" y="${b[1]}" width="${b[2] - b[0]}" height="${b[3] - b[1]}"/>`; }
      for (const it of svgFragment(svg)) {
        if (it.k === 'c') { const [cx, cy] = tf(it.cx, it.cy); sub.push(`E~${cx}~${cy}~${n2(it.r)}~${n2(it.r)}~#A00000~1~0~${it.fill ? '#A00000' : 'none'}~${id()}~0`); grow(cx, cy); }
        else { const pts = it.pts.map(p => tf(p[0], p[1])); pts.forEach(p => grow(p[0], p[1])); sub.push(`${it.fill ? 'PG' : 'PL'}~${pts.map(p => p.join(' ')).join(' ')}~#A00000~1~0~${it.fill ? '#A00000' : 'none'}~${id()}~0`); }
      }
      // pins: connection point at the pin tip, line toward the body
      const pins = Model.pinsWorld(c);
      for (const p of pins) {
        const tip = [n2(p.x), n2(p.y)], body = [n2(p.ax), n2(p.ay)];
        const ang = p.dx > 0 ? 0 : p.dx < 0 ? 180 : p.dy > 0 ? 90 : 270;
        const showName = p.show !== false && c.type !== 'resistor' ? 1 : 0;
        const nameX = n2(body[0] - p.dx * 3), nameY = n2(body[1] - p.dy * 3 + 3), numX = n2((tip[0] + body[0]) / 2), numY = n2((tip[1] + body[1]) / 2 - 2);
        sub.push(`P~show~0~${p.num}~${tip[0]}~${tip[1]}~${ang}~${id()}~0^^${tip[0]}~${tip[1]}^^M ${tip[0]} ${tip[1]} L ${body[0]} ${body[1]}~#880000^^${showName}~${nameX}~${nameY}~0~${String(p.name || p.num).replace(/[~^`#@$]/g, '_')}~${p.dx > 0 ? 'end' : 'start'}~~~#0000FF^^1~${numX}~${numY}~0~${p.num}~middle~~~#0000FF^^0~${tip[0]}~${tip[1]}^^0~M 0 0`);
        grow(tip[0], tip[1]);
      }
      const b = Model.bbox(c);
      sub.unshift(`T~N~${n2(b[0])}~${n2(b[3] + 10)}~0~#000080~Arial~~~~~comment~${String(c.value || '').replace(/~/g, '-')}~1~start~${id()}~0~`);
      sub.unshift(`T~P~${n2(b[0])}~${n2(b[1] - 4)}~0~#000080~Arial~~~~~comment~${c.ref}~1~start~${id()}~0~`);
      shapes.push([`LIB~${n2(c.x)}~${n2(c.y)}~${para.join('`')}\`~${c.rot || 0}~0~${id()}~~~0~~yes~yes`, ...sub].join('#@$'));
      // nets: a short stub wire and a net label at every connected pin (labels with the same name are connected)
      for (const p of pins) {
        const net = idx[p.key]; if (!net) continue;
        const ex = n2(p.x + p.dx * 10), ey = n2(p.y + p.dy * 10);
        shapes.push(`W~${n2(p.x)} ${n2(p.y)} ${ex} ${ey}~#008800~1~0~none~${id()}~0`);
        const anchor = p.dx < 0 ? 'end' : 'start';
        shapes.push(`N~${ex}~${ey}~${p.dy ? 270 : 0}~#000080~${net.replace(/~/g, '_')}~${id()}~${anchor}~${n2(ex + (p.dx < 0 ? -2 : 2))}~${n2(ey - 2)}~Times New Roman~7pt~0`);
        grow(ex, ey);
      }
    }
    if (!isFinite(bb[0])) { bb[0] = bb[1] = 0; bb[2] = bb[3] = 100; }
    const doc = {
      head: { docType: '1', editorVersion: '6.5.22', newgId: true, c_para: { 'Prefix Start': '1' }, c_spiceCmd: null, hasIdFlag: true, title: S.name || 'Sheet_1' },
      canvas: `CA~1000~1000~#FFFFFF~yes~#CCCCCC~5~1000~1000~line~5~pixel~5~0~0`,
      shape: shapes, BBox: { x: bb[0] - 20, y: bb[1] - 20, width: bb[2] - bb[0] + 40, height: bb[3] - bb[1] + 40 }, colors: {},
    };
    return JSON.stringify(doc);
  }

  // ---------- PCB import ----------
  function unwrap(j) {
    if (typeof j === 'string') j = JSON.parse(j);
    for (let guard = 0; guard < 5; guard++) {
      if (j && j.result && (j.result.dataStr || j.result.shape)) { j = j.result.dataStr || j.result; continue; }
      if (j && j.pcbs && j.pcbs.length) { j = j.pcbs[0]; continue; }
      if (j && j.dataStr && !j.shape) { j = typeof j.dataStr === 'string' ? JSON.parse(j.dataStr) : j.dataStr; continue; }
      break;
    }
    if (!j || !Array.isArray(j.shape)) throw new Error('Not an EasyEDA document (expected the JSON from EasyEDA Standard: File → Export → EasyEDA Source)');
    const t = String((j.head && j.head.docType) || j.docType || '');
    if (t && t !== '3') throw new Error(t === '1' ? 'This is an EasyEDA schematic — open the PCB document (docType 3) instead' : `Unsupported EasyEDA document type ${t} (need a PCB, docType 3)`);
    return j;
  }
  const para = s => { const o = {}, a = String(s || '').split('`'); for (let i = 0; i + 1 < a.length; i += 2) if (a[i]) o[a[i]] = a[i + 1]; return o; };

  function importPcb(json) {
    const j = unwrap(json), log = [], P = v => +v * U;
    const pads = [], libs = [], tracks = [], vias = [], holes = [], outline = [], areas = [];
    const copper = l => l === '1' ? 'F' : l === '2' ? 'B' : null;
    const arcPoly = (path, w) => pathToPolys(path, 6).map(pl => pl.map(q => [P(q[0]), P(q[1])]));
    function padRec(f) {
      // PAD~shape~x~y~w~h~layer~net~number~holeR~points~rotation~id~holeLength~slotPoints~plated~...
      const shape = f[1], x = P(f[2]), y = P(f[3]); let w = P(f[4]), h = P(f[5]);
      const rot = ((+f[11] || 0) % 180 + 180) % 180, holeR = +f[9] || 0;
      const pts = String(f[10] || '').trim().split(/\s+/).map(Number).filter(v => !isNaN(v));
      if ((shape === 'RECT' || shape === 'POLYGON') && pts.length >= 6) { const xs = pts.filter((_, i) => !(i & 1)).map(P), ys = pts.filter((_, i) => i & 1).map(P); w = Math.max(...xs) - Math.min(...xs); h = Math.max(...ys) - Math.min(...ys); }
      else if (Math.abs(rot - 90) < 1) [w, h] = [h, w];
      else if (rot > 1 && rot < 179 && shape !== 'ELLIPSE') { const a = rot * Math.PI / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a)); [w, h] = [w * c + h * s, w * s + h * c]; }
      return { x, y, w: Math.max(0.05, w), h: Math.max(0.05, h), shape: shape === 'ELLIPSE' ? 'round' : shape === 'OVAL' ? 'oval' : 'rect', drill: holeR > 0 ? 2 * holeR * U : 0, plated: f[15] !== 'N', layer: f[6], net: f[7] || '', num: String(f[8] || '').trim() };
    }
    for (const s of j.shape) {
      if (typeof s !== 'string') continue;
      const f = s.split('~'), k = f[0];
      if (k === 'LIB') {
        const parts = s.split('#@$'), h = parts[0].split('~'), lib = { x: P(h[1]), y: P(h[2]), para: para(h[3]), rot: +h[4] || 0, side: h[7] === '2' ? 'B' : 'F', pads: [], silk: [], ref: '', value: '' };
        for (const sub of parts.slice(1)) {
          const g = sub.split('~');
          if (g[0] === 'PAD') lib.pads.push(padRec(g));
          else if (g[0] === 'TEXT' && g[1] === 'P') lib.ref = g[10] || '';
          else if (g[0] === 'TEXT' && g[1] === 'N') lib.value = g[10] || '';
          else if (g[0] === 'TRACK' && ['3', '4', '13', '14', '99'].includes(g[2])) { const v = String(g[4] || '').trim().split(/\s+/).map(Number); for (let i = 0; i + 1 < v.length; i += 2) lib.silk.push([P(v[i]), P(v[i + 1])]); }
          else if (g[0] === 'CIRCLE' && ['3', '4', '13', '14', '99'].includes(g[5])) { const cx = P(g[1]), cy = P(g[2]), r = P(g[3]); lib.silk.push([cx - r, cy - r], [cx + r, cy + r]); }
        }
        libs.push(lib);
      } else if (k === 'PAD') pads.push(padRec(f));
      else if (k === 'TRACK') {
        const v = String(f[4] || '').trim().split(/\s+/).map(Number), pts = []; for (let i = 0; i + 1 < v.length; i += 2) pts.push([P(v[i]), P(v[i + 1])]);
        if (f[2] === '10') outline.push(pts); else if (copper(f[2]) && pts.length >= 2) tracks.push({ net: f[3] || '', layer: copper(f[2]), w: P(f[1]), pts });
      } else if (k === 'ARC') {
        for (const pl of arcPoly(f[4])) { if (f[2] === '10') outline.push(pl); else if (copper(f[2])) tracks.push({ net: f[3] || '', layer: copper(f[2]), w: P(f[1]), pts: pl }); }
      } else if (k === 'CIRCLE' && f[5] === '10') {
        const cx = P(f[1]), cy = P(f[2]), r = P(f[3]); outline.push(Array.from({ length: 65 }, (_, i) => [cx + r * Math.cos(i / 64 * 2 * Math.PI), cy + r * Math.sin(i / 64 * 2 * Math.PI)]));
      } else if (k === 'RECT' && f[5] === '10') {
        const x = P(f[1]), y = P(f[2]), w = P(f[3]), h = P(f[4]); outline.push([[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]);
      } else if (k === 'VIA') vias.push({ x: P(f[1]), y: P(f[2]), d: P(f[3]), net: f[4] || '', drill: 2 * (+f[5] || 0) * U });
      else if (k === 'HOLE') holes.push({ x: P(f[1]), y: P(f[2]), d: 2 * (+f[3] || 0) * U });
      else if (k === 'COPPERAREA' && copper(f[2])) { const pl = pathToPolys(f[4], 6)[0]; if (pl && pl.length >= 3) areas.push({ net: f[3] || '', layer: copper(f[2]), pts: pl.map(q => [P(q[0]), P(q[1])]), clearance: P(f[5] || 0) }); }
    }
    if (!libs.length) throw new Error('No footprints found in this EasyEDA PCB');
    for (const p of pads) if (p.drill && !p.plated) holes.push({ x: p.x, y: p.y, d: p.drill });
    if (pads.some(p => p.drill && p.plated)) log.push(`${pads.filter(p => p.drill && p.plated).length} free-standing plated pads were skipped`);

    // ---- board outline: chain the edge segments into the largest closed loop
    let loop = null;
    if (outline.length) {
      const segs = outline.map(pl => pl.slice()), loops = [], near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.02;
      while (segs.length) {
        let cur = segs.shift();
        for (let grew = true; grew && !near(cur[0], cur[cur.length - 1]);) {
          grew = false;
          for (let i = 0; i < segs.length; i++) {
            const s = segs[i], e = cur[cur.length - 1];
            if (near(s[0], e)) { cur = cur.concat(s.slice(1)); segs.splice(i, 1); grew = true; break; }
            if (near(s[s.length - 1], e)) { cur = cur.concat(s.slice(0, -1).reverse()); segs.splice(i, 1); grew = true; break; }
          }
        }
        loops.push(cur);
      }
      const area = L => { let a = 0; for (let i = 0; i < L.length - 1; i++) a += L[i][0] * L[i + 1][1] - L[i + 1][0] * L[i][1]; return Math.abs(a / 2); };
      loop = loops.filter(L => L.length >= 4).sort((a, b) => area(b) - area(a))[0] || null;
      if (loop && near(loop[0], loop[loop.length - 1])) loop = loop.slice(0, -1);
    }
    // everything relative to the outline's top-left corner
    const allX = loop ? loop.map(q => q[0]) : libs.flatMap(l => l.pads.map(p => p.x)), allY = loop ? loop.map(q => q[1]) : libs.flatMap(l => l.pads.map(p => p.y));
    const margin = loop ? 0 : 3, ox = Math.min(...allX) - margin, oy = Math.min(...allY) - margin;
    const bw = n4(Math.max(...allX) + margin - ox), bh = n4(Math.max(...allY) + margin - oy);
    const mv = q => [n4(q[0] - ox), n4(q[1] - oy)];

    // ---- library parts: one definition per distinct footprint (and LCSC part)
    const S = Model.S, defs = new Map(), used = new Set(S.components.map(c => c.ref));
    const nearest90 = r => ((Math.round(r / 90) * 90) % 360 + 360) % 360;
    let made = 0, skewed = 0;
    for (const L of libs) {
      if (!L.pads.length) continue;
      const exact = Math.abs(L.rot - Math.round(L.rot / 90) * 90) < 0.5;
      const r = exact ? nearest90(L.rot) : 0; if (!exact) skewed++;
      const bot = L.side === 'B', sw = r === 90 || r === 270;
      const local = (x, y) => { let [u, v] = Lib.rot(x - L.x, y - L.y, (360 - r) % 360); if (bot) u = -u; return [n4(u), n4(v)]; };
      const fpPads = L.pads.map(p => { const [x, y] = local(p.x, p.y); const q = { num: p.num || '?', x, y, w: n4(sw ? p.h : p.w), h: n4(sw ? p.w : p.h), shape: p.shape }; if (p.drill) q.drill = n4(p.drill); return q; });
      const xs = fpPads.flatMap(p => [p.x - p.w / 2, p.x + p.w / 2]), ys = fpPads.flatMap(p => [p.y - p.h / 2, p.y + p.h / 2]);
      for (const q of L.silk) { const [x, y] = local(q[0], q[1]); xs.push(x); ys.push(y); }
      const body = [n4(Math.min(...xs)), n4(Math.min(...ys)), n4(Math.max(...xs)), n4(Math.max(...ys))];
      const pkg = L.para.package || 'FOOTPRINT', lcsc = /^C\d+$/.test(L.para['Supplier Part'] || '') ? L.para['Supplier Part'] : '';
      const sig = JSON.stringify(fpPads.map(p => [p.num, p.x, p.y, p.w, p.h, p.shape, p.drill || 0]));
      let key = null;
      for (const [k, d] of defs) if (d.sig === sig && d.lcsc === lcsc) { key = k; break; }
      if (!key) {
        key = lcsc || ('EE_' + pkg.replace(/[^\w.-]+/g, '_')).slice(0, 48);
        for (let n = 2; defs.has(key) || (S.lib[key] && !defs.has(key)); n++) key = (lcsc || ('EE_' + pkg.replace(/[^\w.-]+/g, '_')).slice(0, 44)) + '_' + n;
        const nums = [...new Set(fpPads.map(p => p.num))];
        const pins = nums.map((num, i) => ({ num, name: num, side: i < Math.ceil(nums.length / 2) ? 'L' : 'R' }));
        const prefix = (L.para.pre || L.ref || 'U').replace(/[^A-Za-z]/g, '') || 'U';
        const def = { name: L.para['Manufacturer Part'] || pkg, value: L.value || pkg, prefix, pins, footprint: { name: pkg, pads: fpPads, body }, custom: !lcsc, lcsc: lcsc || key, source: 'EasyEDA import' };
        if (lcsc) Object.assign(def, { lcsc, mfr_part: L.para['Manufacturer Part'] || '', manufacturer: L.para.Manufacturer || '' });
        Model.setLibPart(key, def); defs.set(key, { sig, lcsc }); made++;
      }
      // the component
      let ref = (L.ref || '').trim().replace(/\s+/g, '');
      if (!ref || used.has(ref)) ref = undefined;
      const c = Model.addComponent({ part: key, ref, value: L.value || undefined });
      used.add(c.ref);
      const [cx, cy] = mv([L.x, L.y]);
      c.pcb = { x: cx, y: cy, rot: r }; if (bot) c.pcb.side = 'B';
      L.c = c;
    }
    // ---- nets from pad net names
    const nets = {};
    for (const L of libs) if (L.c) for (const p of L.pads) if (p.net) (nets[p.net] = nets[p.net] || new Set()).add(L.c.ref + '.' + (p.num || '?'));
    for (const [n, keys] of Object.entries(nets)) if (keys.size) Model.connect(n.replace(/\s+/g, '_'), [...keys]);
    // ---- board, copper
    S.board.w = bw; S.board.h = bh;
    const isRect = loop && loop.length === 4 && loop.every(q => (Math.abs(q[0] - ox) < 0.01 || Math.abs(q[0] - (ox + bw)) < 0.01) && (Math.abs(q[1] - oy) < 0.01 || Math.abs(q[1] - (oy + bh)) < 0.01));
    if (loop && !isRect) S.board.shape = { type: 'polygon', pts: loop.map(mv), r: 0 }; else delete S.board.shape;
    const netName = n => n ? n.replace(/\s+/g, '_') : '';
    S.pcb = {
      traces: tracks.map(t => ({ net: netName(t.net), layer: t.layer, w: n4(t.w), pts: t.pts.map(mv) })),
      vias: vias.map(v => ({ net: netName(v.net), x: mv([v.x, v.y])[0], y: mv([v.x, v.y])[1], d: n4(v.d), drill: n4(v.drill || 0.3) })),
      holes: holes.map(h => ({ x: mv([h.x, h.y])[0], y: mv([h.x, h.y])[1], d: n4(h.d) })),
      pours: areas.filter(a => !a.net || S.nets[netName(a.net)]).map(a => Object.assign({ net: netName(a.net) || 'GND', layer: a.layer, pts: a.pts.map(mv) }, a.clearance > 0 ? { clearance: n4(a.clearance) } : {})),
      routed: {},
    };
    try { Model.autoLayout(); } catch (e) { log.push('schematic auto-layout: ' + e.message); }
    if (skewed) log.push(`${skewed} footprints were placed at a non-90° angle — their pads are kept in place but the footprint outline is axis-aligned`);
    return { components: libs.filter(l => l.c).length, footprints: made, nets: Object.keys(nets).length, tracks: tracks.length, vias: vias.length, pours: S.pcb.pours.length, board_mm: [bw, bh], outline: loop ? (isRect ? 'rectangle' : 'polygon') : 'none (sized to the parts)', notes: log };
  }
  const isEasyEDA = j => { try { return !!unwrap(j); } catch (e) { return /EasyEDA schematic/.test(e.message) ? 'schematic' : false; } };
  return { exportSchematic, importPcb, isEasyEDA, pathToPolys };
})();
if (typeof module !== 'undefined') module.exports = EasyEDA;
