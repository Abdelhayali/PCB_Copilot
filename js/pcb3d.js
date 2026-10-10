'use strict';
// 3D view of the PCB: solder mask / copper / pads / silkscreen textures on both sides and simple 3D part models.
const Pcb3D = (() => {
  const $ = s => document.querySelector(s);
  const ui = { on: false, parts: true, finish: 'enig' };
  let renderer, scene, camera, root, wrap, cam = { th: -1.2, ph: 0.85, r: 120, tx: 0, ty: 0, tz: 0 }, dirty = true, timer = null, busy = false;

  function loadThree() {
    if (window.THREE) return Promise.resolve(window.THREE);
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
      s.onload = () => res(window.THREE); s.onerror = () => rej(new Error('Could not load three.js (needs internet)'));
      document.head.appendChild(s);
    });
  }
  function init() {
    wrap = $('#pcb3dView');
    wrap.innerHTML = `<div class="encmsg" id="p3msg"></div>
      <div class="p3bar"><button data-cam="top">Top</button><button data-cam="bottom">Bottom</button><button data-cam="iso">Iso</button><button id="p3parts" class="on">Parts</button>
      <select id="p3finish" title="Pad finish"><option value="enig">ENIG (gold)</option><option value="hasl">HASL (silver)</option></select><select id="p3mask" title="Solder mask colour"><option value="#1d6b38">Green</option><option value="#1a1a1a">Black</option><option value="#1c3f8f">Blue</option><option value="#8f1c1c">Red</option><option value="#e8e8e8">White</option><option value="#5a2a8a">Purple</option></select></div>
      <div class="encinfo" id="p3info">Drag to orbit · right-drag / Shift-drag to pan · wheel to zoom</div>`;
    wrap.querySelectorAll('[data-cam]').forEach(b => b.onclick = () => preset(b.dataset.cam));
    $('#p3parts').onclick = () => { ui.parts = !ui.parts; $('#p3parts').classList.toggle('on', ui.parts); if (root && root.userData.parts) root.userData.parts.visible = ui.parts; draw(); };
    $('#p3finish').onchange = e => { ui.finish = e.target.value; dirty = true; rebuild(false); };
    $('#p3mask').onchange = () => { dirty = true; rebuild(false); };
    Model.subscribe(kind => { if (kind === 'move') return; dirty = true; if (ui.on) { clearTimeout(timer); timer = setTimeout(() => rebuild(false), 400); } });
  }
  async function setOn(on) {
    ui.on = on;
    $('#pcb3dView').classList.toggle('hidden', !on);
    $('#btn3d').textContent = on ? '▦ 2D' : '◈ 3D';
    $('#btn3d').classList.toggle('on', on);
    if (!on) return;
    try { await loadThree(); } catch (e) { $('#p3msg').textContent = e.message; $('#p3msg').style.display = 'block'; return; }
    if (!renderer) setup();
    if (dirty) rebuild(true); else { resize(); draw(); }
  }

  // ---------- three.js ----------
  function setup() {
    const T = window.THREE;
    renderer = new T.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1)); const bg = () => renderer.setClearColor(getComputedStyle(document.documentElement).getPropertyValue('--view3d-pcb').trim() || '#0d1015'); bg(); window.addEventListener('themechange', () => { bg(); draw(); });
    wrap.prepend(renderer.domElement);
    scene = new T.Scene(); camera = new T.PerspectiveCamera(32, 1, 0.5, 5000); camera.up.set(0, 0, 1);
    scene.add(new T.HemisphereLight(0xffffff, 0x445566, 0.65));
    const d1 = new T.DirectionalLight(0xffffff, 0.8); d1.position.set(60, -90, 160); scene.add(d1);
    const d2 = new T.DirectionalLight(0xffffff, 0.35); d2.position.set(-120, 80, -120); scene.add(d2);
    const el = renderer.domElement; let drag = null;
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('mousedown', e => { drag = { x: e.clientX, y: e.clientY, pan: e.button !== 0 || e.shiftKey }; });
    window.addEventListener('mouseup', () => drag = null);
    window.addEventListener('mousemove', e => {
      if (!drag || !ui.on) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
      if (drag.pan) { const k = cam.r / 600, s = Math.sin(cam.th), c = Math.cos(cam.th); cam.tx -= (dx * c + dy * s * Math.cos(cam.ph)) * k; cam.ty -= (dx * s - dy * c * Math.cos(cam.ph)) * k; cam.tz += dy * Math.sin(cam.ph) * k; }
      else { cam.th -= dx * 0.008; cam.ph = Math.max(0.02, Math.min(Math.PI - 0.02, cam.ph - dy * 0.008)); }
      draw();
    });
    el.addEventListener('wheel', e => { e.preventDefault(); cam.r = Math.max(10, Math.min(2000, cam.r * Math.exp(e.deltaY * 0.001))); draw(); }, { passive: false });
    new ResizeObserver(() => { if (ui.on) { resize(); draw(); } }).observe(wrap);
  }
  function resize() { if (!renderer) return; const r = wrap.getBoundingClientRect(); if (!r.width) return; renderer.setSize(r.width, r.height); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); }
  function draw() {
    if (!renderer) return;
    camera.position.set(cam.tx + cam.r * Math.sin(cam.ph) * Math.cos(cam.th), cam.ty + cam.r * Math.sin(cam.ph) * Math.sin(cam.th), cam.tz + cam.r * Math.cos(cam.ph));
    camera.lookAt(cam.tx, cam.ty, cam.tz); renderer.render(scene, camera);
  }
  function preset(p) {
    const S = Model.S;
    if (p === 'top') { cam.th = -Math.PI / 2; cam.ph = 0.02; } else if (p === 'bottom') { cam.th = -Math.PI / 2; cam.ph = Math.PI - 0.02; } else { cam.th = -1.2; cam.ph = 0.85; }
    cam.tx = S.board.w / 2; cam.ty = -S.board.h / 2; cam.tz = 0; cam.r = Math.max(S.board.w, S.board.h) * 2.1; draw();
  }

  // ---------- board textures (drawn as SVG in board coordinates, then rasterised) ----------
  function sideSVG(side, px) {
    const S = Model.S, idx = Model.pinIndex(), R = Pcb.rules(), w = S.board.w, h = S.board.h, L = side;
    const mask = $('#p3mask').value, cu = shade(mask, 0.25), pad = ui.finish === 'enig' ? '#d8b04a' : '#c9cdd2', silk = mask === '#e8e8e8' ? '#111' : '#f4f4f4';
    const poly = Pcb.boardPoly(), d = 'M' + poly.map(q => q.join(' ')).join('L') + 'Z', o = [];
    o.push(`<path d="${d}" fill="${mask}"/>`);
    // copper under the mask: pours, tracks, (tented) vias
    for (const pr of S.pcb.pours || []) if (pr.layer === L) { const pp = Pcb.pourPoly(pr); o.push(`<path d="M${pp.map(q => q.join(' ')).join('L')}Z" fill="${cu}" clip-path="url(#b)"/>`); }
    for (const t of S.pcb.traces) if (t.layer === L) o.push(`<polyline points="${t.pts.map(q => q.join(',')).join(' ')}" fill="none" stroke="${cu}" stroke-width="${t.w}" stroke-linecap="round" stroke-linejoin="round"/>`);
    for (const v of S.pcb.vias) o.push(`<circle cx="${v.x}" cy="${v.y}" r="${v.d / 2}" fill="${cu}"/>`);
    // exposed pads (mask openings)
    for (const c of Pcb.placed()) for (const p of Pcb.padsOf(c, idx)) {
      if (!p.drill && (p.layer || 'F') !== L) continue;
      o.push(p.shape === 'round' ? `<circle cx="${p.x}" cy="${p.y}" r="${p.w / 2}" fill="${pad}"/>` : `<rect x="${p.x - p.w / 2}" y="${p.y - p.h / 2}" width="${p.w}" height="${p.h}" rx="${p.shape === 'oval' ? Math.min(p.w, p.h) / 2 : 0.05}" fill="${pad}"/>`);
      if (p.drill) o.push(`<circle cx="${p.x}" cy="${p.y}" r="${p.drill / 2}" fill="#050505"/>`);
    }
    for (const v of S.pcb.vias) o.push(`<circle cx="${v.x}" cy="${v.y}" r="${v.drill / 2}" fill="#050505"/>`);
    // silkscreen
    for (const c of Pcb.placed()) {
      if ((Pcb.isBottom(c) ? 'B' : 'F') !== L) continue;
      const b = Pcb.fpBox(c);
      o.push(`<rect x="${b[0]}" y="${b[1]}" width="${b[2] - b[0]}" height="${b[3] - b[1]}" fill="none" stroke="${silk}" stroke-width="0.15"/>`);
      const tx = (b[0] + b[2]) / 2, ty = b[1] - 0.4;
      o.push(`<text x="${tx}" y="${ty}" text-anchor="middle" fill="${silk}" font-family="Arial, sans-serif" font-weight="700" font-size="1.1"${L === 'B' ? ` transform="translate(${2 * tx} 0) scale(-1 1)"` : ''}>${esc(c.ref)}</text>`);
    }
    if (L === 'F') o.push(`<text x="${w - 1.2}" y="${h - 1.2}" text-anchor="end" fill="${silk}" font-family="Arial, sans-serif" font-size="1.2" opacity="0.9">${esc(Model.S.name || '')}</text>`);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w * px)}" height="${Math.round(h * px)}" viewBox="0 0 ${w} ${h}"><defs><clipPath id="b"><path d="${d}"/></clipPath></defs><g clip-path="url(#b)">${o.join('')}</g></svg>`;
  }
  function shade(hex, k) { const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255, f = v => Math.max(0, Math.min(255, Math.round(v + (255 - v) * k))); return `rgb(${f(r)},${f(g)},${f(b)})`; }
  function texture(side) {
    const T = window.THREE, S = Model.S, px = Math.min(24, 4096 / Math.max(S.board.w, S.board.h));
    return new Promise(res => {
      const img = new Image(), cv = document.createElement('canvas');
      cv.width = Math.round(S.board.w * px); cv.height = Math.round(S.board.h * px);
      img.onload = () => { const g = cv.getContext('2d'); g.drawImage(img, 0, 0, cv.width, cv.height); const t = new T.CanvasTexture(cv); t.anisotropy = 8; res(t); };
      img.onerror = () => res(null);
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sideSVG(side, px));
    });
  }

  // ---------- 3D part models ----------
  function partModel(c, T) {
    const b = Pcb.fpBox(c), lib = c.lcsc && Model.S.lib[c.lcsc];
    const text = [c.footprint, c.value, c.type, lib && lib.name, lib && lib.package].filter(Boolean).join(' ').toUpperCase();
    const h = Enclosure.partHeight(c, Enclosure.params()), w = b[2] - b[0], d = b[3] - b[1], g = new T.Group();
    // no environment map → keep metalness low so metal parts read as bright metal instead of black
    const mat = (color, metal = 0.1, rough = 0.6) => new T.MeshStandardMaterial({ color, metalness: Math.min(metal, 0.3), roughness: metal > 0.5 ? Math.max(rough, 0.35) : rough, emissive: metal > 0.5 ? 0x202020 : 0x000000 });
    const box = (sx, sy, sz, color, z0 = 0, metal, rough) => { const m = new T.Mesh(new T.BoxGeometry(sx, sy, sz), mat(color, metal, rough)); m.position.z = z0 + sz / 2; return m; };
    const fp = Lib.footprint(c.footprint), pads = Pcb.padsOf(c), cx = (b[0] + b[2]) / 2, cy = -(b[1] + b[3]) / 2;
    const smdBody = (col) => { const bw = Math.max(0.5, w * 0.62), bd = Math.max(0.4, d * 0.78); return box(Math.max(bw, w * (w > d ? 0.62 : 0.85)), Math.max(bd, d * (d > w ? 0.62 : 0.85)), h, col); };
    if (/CAPACITOR_POLARIZED|ELECTROLYTIC|CP_RADIAL/.test(text) || c.type === 'capacitor_polarized') {
      const r = Math.max(1.5, Math.min(w, d) / 2 * 0.95), cyl = new T.Mesh(new T.CylinderGeometry(r, r, h, 32), mat(0x1c2f73, 0.2, 0.4)); cyl.rotation.x = Math.PI / 2; cyl.position.z = h / 2; g.add(cyl);
      const top = new T.Mesh(new T.CylinderGeometry(r * 0.98, r * 0.98, 0.2, 32), mat(0xcfd4da, 0.7, 0.3)); top.rotation.x = Math.PI / 2; top.position.z = h; g.add(top);
    } else if (c.type === 'led' && fp && fp.pads.some(p => p.drill)) {
      const col = /RED/.test(text) ? 0xff3030 : /BLUE/.test(text) ? 0x3060ff : /YELLOW/.test(text) ? 0xffd000 : /WHITE/.test(text) ? 0xf0f0ff : 0x30e060;
      const m = new T.MeshStandardMaterial({ color: col, transparent: true, opacity: 0.8, roughness: 0.2 });
      const cyl = new T.Mesh(new T.CylinderGeometry(2.5, 2.5, h - 2.5, 24), m); cyl.rotation.x = Math.PI / 2; cyl.position.z = (h - 2.5) / 2; g.add(cyl);
      const dome = new T.Mesh(new T.SphereGeometry(2.5, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), m); dome.rotation.x = Math.PI / 2; dome.position.z = h - 2.5; g.add(dome);
    } else if (c.type === 'led') {
      const col = /RED/.test(text) ? 0xff4040 : /BLUE/.test(text) ? 0x4070ff : /YELLOW/.test(text) ? 0xffd000 : 0x40f070;
      g.add(smdBody(0xeeeeee)); const lens = box(w * 0.5, d * 0.5, 0.15, col, h); lens.material.transparent = true; lens.material.opacity = 0.9; g.add(lens);
    } else if (/TYPE-?C|USB|MICRO-?B/.test(text)) g.add(box(w * 0.92, d * 0.92, h, 0xc8ccd0, 0, 0.85, 0.25));
    else if (/ESP32|WROOM|MINI-1|MODULE|WIFIM/.test(text)) { g.add(box(w * 0.98, d * 0.98, 0.8, 0x1d4d8a)); g.add(box(w * 0.86, d * 0.66, h - 0.8, 0xc0c4c8, 0.8, 0.8, 0.3)); }
    else if (/PINHEADER|HEADER/.test(text) || c.type === 'connector' || c.type === 'battery') {
      g.add(box(w * 0.98, d * 0.98, 2.5, 0x161616));
      for (const p of pads) { const pin = new T.Mesh(new T.BoxGeometry(0.64, 0.64, h + 3), mat(0xd8b04a, 0.8, 0.3)); pin.position.set(p.x - cx - b[0] + b[0], -p.y - cy, (h + 3) / 2 - 3); g.add(pin); }
    } else if (/TO-?220/.test(text)) { g.add(box(w * 0.95, 4.5, h - 6, 0x161616)); g.add(box(w * 0.95, 1.3, h, 0xc0c4c8, 0, 0.8, 0.3)); }
    else if (c.type === 'switch') { g.add(box(Math.min(w, d) * 1.0, Math.min(w, d) * 1.0, 3.5, 0x2a2a2a)); const cap = new T.Mesh(new T.CylinderGeometry(1.75, 1.75, h - 3.5, 24), mat(0x111111)); cap.rotation.x = Math.PI / 2; cap.position.z = 3.5 + (h - 3.5) / 2; g.add(cap); }
    else if (c.type === 'crystal' || /CRYSTAL|HC49/.test(text)) g.add(box(w * 0.95, d * 0.8, h, 0xc8ccd0, 0, 0.85, 0.25));
    else if (c.type === 'resistor') { g.add(smdBody(0x151515)); }
    else if (c.type === 'capacitor') g.add(smdBody(0xb98a52));
    else if (c.type === 'inductor') g.add(smdBody(0x3a3a3a));
    else if (c.type === 'diode' || c.type === 'zener' || c.type === 'schottky') g.add(smdBody(0x222222));
    else { const body = box(Math.max(0.6, w * 0.82), Math.max(0.6, d * 0.82), h, 0x1a1a1a); g.add(body); const dot = new T.Mesh(new T.CylinderGeometry(0.3, 0.3, 0.05, 12), mat(0x777777)); dot.rotation.x = Math.PI / 2; dot.position.set(-w * 0.3, d * 0.3, h + 0.03); if (w > 2 && d > 2) g.add(dot); }
    g.position.set(cx, cy, 0);
    return g;
  }

  // ---------- build ----------
  async function rebuild(fit) {
    if (busy) { dirty = true; return; }
    const S = Model.S, T = window.THREE; if (!T || !renderer) return;
    dirty = false;
    if (root) scene.remove(root);
    if (!S.board.w || !Pcb.placed().length) { $('#p3msg').textContent = 'No PCB yet — click “Generate PCB”'; $('#p3msg').style.display = 'block'; draw(); return; }
    $('#p3msg').style.display = 'none';
    busy = true;
    const [top, bot] = await Promise.all([texture('F'), texture('B')]);
    busy = false;
    root = new T.Group(); scene.add(root);
    const th = Pcb.rules().layers ? 1.6 : 1.6, poly = Pcb.boardPoly();
    const shape = new T.Shape(poly.map(q => new T.Vector2(q[0], -q[1])));
    for (const hh of S.pcb.holes || []) { const p = new T.Path(); p.absarc(hh.x, -hh.y, hh.d / 2, 0, Math.PI * 2, true); shape.holes.push(p); }
    const fit2 = t => { if (!t) return; t.repeat.set(1 / S.board.w, 1 / S.board.h); t.offset.set(0, 1); };
    fit2(top); fit2(bot);
    // board edge (FR4) + textured top and bottom faces
    const side = new T.Mesh(new T.ExtrudeGeometry(shape, { depth: th, bevelEnabled: false }), [new T.MeshBasicMaterial({ visible: false }), new T.MeshStandardMaterial({ color: 0xc9b98a, roughness: 0.8 })]);
    root.add(side);
    const faceT = new T.Mesh(new T.ShapeGeometry(shape), new T.MeshStandardMaterial({ map: top, roughness: 0.55, metalness: 0.05 })); faceT.position.z = th + 0.001; root.add(faceT);
    const faceB = new T.Mesh(new T.ShapeGeometry(shape), new T.MeshStandardMaterial({ map: bot, roughness: 0.55, metalness: 0.05, side: T.BackSide })); faceB.position.z = -0.001; root.add(faceB);
    const parts = new T.Group(); parts.visible = ui.parts; root.add(parts); root.userData.parts = parts;
    for (const c of Pcb.placed()) {
      const m = partModel(c, T);
      if (Pcb.isBottom(c)) { m.scale.z = -1; m.position.z = 0; } else m.position.z = th;
      parts.add(m);
    }
    resize(); if (fit) preset('iso'); else draw();
    $('#p3info').innerHTML = `<b>${S.board.w} × ${S.board.h} × ${th} mm</b> · ${Pcb.placed().length} parts · ${S.pcb.traces.length} tracks · ${S.pcb.vias.length} vias<br><span class="muted">Drag to orbit · right-drag / Shift-drag to pan · wheel to zoom</span>`;
  }
  // PNG of the 3D board for documents (rendered off-screen at a fixed size on a light background)
  async function snapshot(view = 'iso', w = 1400, h = 950, bg = '#ffffff') {
    await loadThree(); const T = window.THREE;
    if (!renderer) setup();
    if (dirty || !root) { dirty = true; await rebuild(false); }
    if (!root) return null;
    const old = Object.assign({}, cam), size = renderer.getSize(new T.Vector2()), pr = renderer.getPixelRatio(), oc = renderer.getClearColor(new T.Color()).getHex(), oa = renderer.getClearAlpha();
    const partsVis = root.userData.parts ? root.userData.parts.visible : true;
    if (root.userData.parts) root.userData.parts.visible = true;
    renderer.setPixelRatio(1); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setClearColor(bg, 1);
    const S = Model.S;
    if (view === 'top') { cam.th = -Math.PI / 2; cam.ph = 0.0001; } else if (view === 'bottom') { cam.th = -Math.PI / 2; cam.ph = Math.PI - 0.0001; } else { cam.th = -1.15; cam.ph = 0.95; }
    cam.tx = S.board.w / 2; cam.ty = -S.board.h / 2; cam.tz = 0;
    const fov = camera.fov * Math.PI / 180, span = Math.max(S.board.w / camera.aspect, S.board.h) * (view === 'iso' ? 1.25 : 1.1);
    cam.r = span / 2 / Math.tan(fov / 2) + 2;
    draw();
    const url = renderer.domElement.toDataURL('image/png');
    Object.assign(cam, old); if (root.userData.parts) root.userData.parts.visible = partsVis;
    renderer.setPixelRatio(pr); renderer.setSize(size.x, size.y); renderer.setClearColor(oc, oa); resize(); draw();
    return { url, w, h };
  }
  return { init, setOn, ui, rebuild: () => rebuild(true), snapshot };
})();
