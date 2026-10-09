'use strict';
// Enclosure tab: parameters, 3D preview (three.js from cdnjs), STL / OpenSCAD export.
const EncView = (() => {
  const $ = s => document.querySelector(s);
  const ui = { explode: false, lid: true, pcb: true, xray: false, built: null, err: null };
  let three = null, scene, camera, renderer, root, wrap, cam = { th: -0.9, ph: 1.0, r: 160, tx: 0, ty: 0, tz: 10 }, dirty = true, timer = null, active = false;

  function loadThree() {
    if (window.THREE) return Promise.resolve(window.THREE);
    if (three) return three;
    three = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
      s.onload = () => res(window.THREE); s.onerror = () => rej(new Error('Could not load three.js (needs internet) — STL export still works'));
      document.head.appendChild(s);
    });
    return three;
  }
  function init() {
    wrap = $('#encView');
    wrap.innerHTML = '<div id="encMsg" class="encmsg"></div><div id="encInfo" class="encinfo"></div>';
    $('#encRegen').onclick = () => { dirty = true; rebuild(true); };
    $('#encExplode').onclick = () => { ui.explode = !ui.explode; $('#encExplode').classList.toggle('on', ui.explode); place(); };
    $('#encLid').onclick = () => { ui.lid = !ui.lid; $('#encLid').classList.toggle('on', ui.lid); place(); };
    $('#encPcb').onclick = () => { ui.pcb = !ui.pcb; $('#encPcb').classList.toggle('on', ui.pcb); place(); };
    $('#encXray').onclick = () => { ui.xray = !ui.xray; $('#encXray').classList.toggle('on', ui.xray); place(); };
    $('#encStl').onclick = () => exportAll('stl'); $('#encScad').onclick = () => exportAll('scad'); $('#encZip').onclick = () => exportAll('zip');
    ['encLid', 'encPcb'].forEach(id => $('#' + id).classList.add('on'));
    Model.subscribe(kind => { if (kind === 'move') return; dirty = true; if (active) { clearTimeout(timer); timer = setTimeout(() => rebuild(false), 500); } });
  }
  async function show() {
    active = true;
    try { await loadThree(); } catch (e) { msg(e.message); }
    if (window.THREE && !renderer) setupScene();
    if (dirty) rebuild(false); else { resize(); draw(); }
  }
  function hide() { active = false; }
  const msg = t => { const m = $('#encMsg'); if (m) { m.textContent = t || ''; m.style.display = t ? 'block' : 'none'; } };

  // ---------- three.js scene ----------
  function setupScene() {
    const T = window.THREE;
    renderer = new T.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setClearColor(0x12161c);
    wrap.prepend(renderer.domElement);
    scene = new T.Scene();
    camera = new T.PerspectiveCamera(35, 1, 0.5, 5000); camera.up.set(0, 0, 1);
    scene.add(new T.HemisphereLight(0xffffff, 0x334455, 0.75));
    const d1 = new T.DirectionalLight(0xffffff, 0.75); d1.position.set(80, -120, 200); scene.add(d1);
    const d2 = new T.DirectionalLight(0xffffff, 0.35); d2.position.set(-150, 100, 80); scene.add(d2);
    root = new T.Group(); scene.add(root);
    // orbit / pan / zoom
    const el = renderer.domElement; let drag = null;
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('mousedown', e => { drag = { x: e.clientX, y: e.clientY, pan: e.button !== 0 || e.shiftKey }; });
    window.addEventListener('mouseup', () => drag = null);
    window.addEventListener('mousemove', e => {
      if (!drag || !active) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
      if (drag.pan) { const k = cam.r / 600, s = Math.sin(cam.th), c = Math.cos(cam.th); cam.tx -= (dx * c + dy * s * Math.cos(cam.ph)) * k; cam.ty -= (dx * s - dy * c * Math.cos(cam.ph)) * k; cam.tz += dy * Math.sin(cam.ph) * k; }
      else { cam.th -= dx * 0.008; cam.ph = Math.max(0.05, Math.min(Math.PI - 0.05, cam.ph - dy * 0.008)); }
      draw();
    });
    el.addEventListener('wheel', e => { e.preventDefault(); cam.r = Math.max(20, Math.min(2000, cam.r * Math.exp(e.deltaY * 0.001))); draw(); }, { passive: false });
    new ResizeObserver(() => { if (active) { resize(); draw(); } }).observe(wrap);
    resize();
  }
  function resize() { if (!renderer) return; const r = wrap.getBoundingClientRect(); if (!r.width) return; renderer.setSize(r.width, r.height); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); }
  function draw() {
    if (!renderer) return;
    camera.position.set(cam.tx + cam.r * Math.sin(cam.ph) * Math.cos(cam.th), cam.ty + cam.r * Math.sin(cam.ph) * Math.sin(cam.th), cam.tz + cam.r * Math.cos(cam.ph));
    camera.lookAt(cam.tx, cam.ty, cam.tz); renderer.render(scene, camera);
  }
  const meshes = {};
  function meshFrom(polys, color, opts = {}) {
    const T = window.THREE, a = Enclosure.meshArrays(polys, opts.tf), g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(a.pos, 3)); g.setAttribute('normal', new T.BufferAttribute(a.nor, 3));
    const m = new T.MeshStandardMaterial({ color, roughness: 0.65, metalness: 0.05, transparent: true, opacity: opts.opacity || 1, side: T.DoubleSide });
    return new T.Mesh(g, m);
  }
  function pcbGroup(L) {
    const T = window.THREE, g = new T.Group();
    const sh = new T.Shape(L.bpoly.map(q => new T.Vector2(q[0], q[1])));
    for (const h of L.holes) { const p = new T.Path(); p.absarc(h.x, h.y, h.d / 2, 0, Math.PI * 2, true); sh.holes.push(p); }
    const board = new T.Mesh(new T.ExtrudeGeometry(sh, { depth: L.P.pcbThickness, bevelEnabled: false }), new T.MeshStandardMaterial({ color: 0x1f7a3a, roughness: 0.8 }));
    board.position.z = L.pcbZ; g.add(board);
    const colors = { part: 0x2b2b2b, ic: 0x2b2b2b, connector: 0xc9c9c9, resistor: 0x2a6cc0, capacitor: 0xb08850, capacitor_polarized: 0x2d3fa0, led: 0x37d67a, switch: 0x555555, regulator: 0x333333, battery: 0x222222 };
    for (const p of L.parts) {
      const w = Math.max(0.6, p.x1 - p.x0), d = Math.max(0.6, p.y1 - p.y0), h = Math.max(0.4, p.h);
      const col = p.edge && p.edge.plug ? 0xd8d8d8 : (colors[p.type] ?? 0x3a3a3a);
      const b = new T.Mesh(new T.BoxGeometry(w * 0.92, d * 0.92, h), new T.MeshStandardMaterial({ color: col, roughness: 0.5, metalness: p.edge && p.edge.plug ? 0.6 : 0.1 }));
      b.position.set((p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2, p.bottom ? L.pcbZ - h / 2 : L.pcbZ + L.P.pcbThickness + h / 2);
      g.add(b);
    }
    return g;
  }
  function place() {
    if (!root || !ui.built) return;
    const L = ui.built.L, ex = ui.explode ? (L.P.explode || 12) + L.P.lipHeight : 0;
    if (meshes.base) { meshes.base.material.opacity = ui.xray ? 0.35 : 1; meshes.base.material.depthWrite = !ui.xray; }
    if (meshes.lid) { meshes.lid.visible = ui.lid; meshes.lid.position.z = ex; meshes.lid.material.opacity = ui.xray ? 0.35 : 1; meshes.lid.material.depthWrite = !ui.xray; }
    if (meshes.pcb) meshes.pcb.visible = ui.pcb;
    draw();
  }
  function rebuild(fit) {
    dirty = false;
    let r;
    try { r = Enclosure.build(); ui.err = null; msg(''); } catch (e) { ui.err = e.message; msg(e.message); ui.built = null; if (root) { while (root.children.length) root.remove(root.children[0]); draw(); } App.renderAll(); return; }
    const first = !ui.built; ui.built = r;
    info(r);
    if (!root) return;
    while (root.children.length) root.remove(root.children[0]);
    meshes.base = meshFrom(r.base, 0x4f8fd9); meshes.lid = meshFrom(r.lid, 0x9fd27a); meshes.pcb = pcbGroup(r.L);
    root.add(meshes.base, meshes.lid, meshes.pcb);
    if (first || fit) { const b = r.L.bbox; cam.tx = (b[0] + b[2]) / 2; cam.ty = (b[1] + b[3]) / 2; cam.tz = r.L.H / 2; cam.r = Math.max(b[2] - b[0], b[3] - b[1], r.L.H) * 2.4; }
    resize(); place();
    if (active) App.renderAll();
  }
  function info(r) {
    const d = Enclosure.describe(r);
    $('#encInfo').innerHTML = `<b>${d.outer_mm.join(' × ')} mm</b> · base ${d.base_height} mm + lid ${d.lid_thickness} mm · tallest part ${d.tallest_part_mm} mm · ${d.mounting_holes ? d.mounting_holes + ' screw standoffs' : d.supports + ' corner supports'} · ${d.cutouts.length} cutouts<br><span class="muted">Drag to orbit · right-drag / Shift-drag to pan · wheel to zoom</span>`;
  }

  // ---------- parameter panel (left Properties area) ----------
  const FIELDS = [
    ['Shell', [['wall', 'Wall'], ['floor', 'Floor'], ['clearance', 'PCB ↔ wall gap'], ['topClearance', 'Space above tallest part'], ['extraHeight', 'Extra height']]],
    ['Board support', [['standoffHeight', 'Standoff height'], ['standoffDiameter', 'Standoff Ø'], ['screwHole', 'Screw pilot hole Ø'], ['pcbThickness', 'PCB thickness']]],
    ['Lid', [['lidThickness', 'Lid thickness'], ['lidFit', 'Lid fit tolerance'], ['lipHeight', 'Lip height'], ['lipWidth', 'Lip width']]],
    ['Vents', [['ventWidth', 'Slot width'], ['ventLength', 'Slot length'], ['ventSpacing', 'Slot pitch']]],
  ];
  function props(el) {
    const P = Enclosure.params(), S = Model.S;
    let d = null; try { d = Enclosure.describe(); } catch (e) { }
    let h = `<div class="ph">Enclosure</div>`;
    if (!d) { el.innerHTML = h + `<div class="muted">${esc(ui.err || 'Generate the PCB first — the enclosure is fitted to it.')}</div>`; return true; }
    h += `<div class="lcscinfo"><b>${d.outer_mm.join(' × ')} mm</b><br>PCB ${S.board.w}×${S.board.h} mm · ${(S.board.shape || { type: 'rect' }).type} outline</div>`;
    for (const [title, fs] of FIELDS) {
      h += `<div class="ph small">${title}</div><div class="encgrid">` + fs.map(([k, l]) => `<label>${l}<input data-ep="${k}" type="number" step="0.1" min="0" value="${P[k]}"></label>`).join('') + '</div>';
      if (title === 'Board support') h += `<div class="row"><button id="encHoles">${(S.pcb.holes || []).length ? '↻ Re-place' : '＋ Add'} M3 mounting holes</button>${(S.pcb.holes || []).length ? '<button id="encNoHoles" class="danger">Remove holes</button>' : ''}</div><div class="muted small">${(S.pcb.holes || []).length ? (S.pcb.holes.length + ' holes on the PCB → screw standoffs') : 'No PCB holes: the board rests on corner supports'}</div>`;
      if (title === 'Vents') h += `<label class="chk"><input type="checkbox" data-ep="vents" ${P.vents ? 'checked' : ''}> Vent slots in the lid</label>`;
    }
    h += `<div class="ph small">Cutouts</div>
      <label class="chk"><input type="checkbox" data-ep="autoConnectorCutouts" ${P.autoConnectorCutouts ? 'checked' : ''}> Openings for edge connectors (USB, jacks…)</label>
      <label class="chk"><input type="checkbox" data-ep="autoLidHoles" ${P.autoLidHoles ? 'checked' : ''}> Lid holes above LEDs and buttons</label>
      <ul class="cutl">${d.cutouts.map(c => `<li>${c.auto ? '⚙' : '✎'} ${esc(c.side)} · ${c.shape} ${c.w}×${c.h}${c.label ? ' · ' + esc(c.label) : ''}${c.auto ? '' : ` <button class="mini-btn danger" data-rmcut="${c.index}">✕</button>`}</li>`).join('')}</ul>
      <div class="encgrid">
        <label>Side<select id="ecSide"><option>left</option><option>right</option><option>front</option><option>back</option><option>lid</option><option>floor</option></select></label>
        <label>Shape<select id="ecShape"><option value="rect">rectangle</option><option value="circle">circle</option></select></label>
        <label>Width<input id="ecW" type="number" step="0.5" value="8"></label><label>Height<input id="ecH" type="number" step="0.5" value="5"></label>
        <label>Along wall / X<input id="ecU" type="number" step="0.5" value="0"></label><label>Z / Y<input id="ecZ" type="number" step="0.5" placeholder="auto"></label>
      </div><div class="row"><button id="ecAdd">＋ Add cutout</button></div>
      <div class="muted small">Wall cutouts: position along the wall from its centre, Z from the bed (empty = 4 mm above the PCB). Lid / floor: X, Y in enclosure coordinates.</div>
      <div class="ph small">Part heights (mm)</div><table class="pins">${Object.entries(d.part_heights).map(([ref, v]) => `<tr><td>${esc(ref)}</td><td><input data-ph="${esc(ref)}" type="number" step="0.5" value="${v}" style="width:70px"></td></tr>`).join('')}</table>
      <div class="muted small">Heights are estimated from the package; change any to fit real parts.</div>`;
    el.innerHTML = h;
    el.querySelectorAll('[data-ep]').forEach(i => i.onchange = () => { try { Model.mutate(() => Enclosure.setParams({ [i.dataset.ep]: i.type === 'checkbox' ? i.checked : +i.value })); } catch (e) { App.toast(e.message); } });
    el.querySelectorAll('[data-ph]').forEach(i => i.onchange = () => Model.mutate(() => Enclosure.setParams({ partHeights: { [i.dataset.ph]: i.value === '' ? null : +i.value } })));
    el.querySelectorAll('[data-rmcut]').forEach(b => b.onclick = () => Model.mutate(() => { const c = (Model.S.enclosure.cutouts || []).slice(); c.splice(+b.dataset.rmcut, 1); Model.S.enclosure = Object.assign({}, Model.S.enclosure, { cutouts: c }); }));
    $('#ecAdd').onclick = () => { try { const side = $('#ecSide').value, lidish = side === 'lid' || side === 'floor'; Model.mutate(() => Enclosure.addCutout({ side, shape: $('#ecShape').value, width: +$('#ecW').value, height: +$('#ecH').value, u: +$('#ecU').value, x: +$('#ecU').value, y: $('#ecZ').value === '' ? 0 : +$('#ecZ').value, z: lidish || $('#ecZ').value === '' ? null : +$('#ecZ').value })); } catch (e) { App.toast(e.message); } };
    $('#encHoles').onclick = () => { try { const r = Model.mutate(() => Pcb.addMountingHoles({})); App.toast(`${r.holes.length} M3 mounting holes added to the PCB${r.skipped ? ` (${r.skipped} corners too crowded)` : ''} — Route the PCB again so tracks avoid them`, 6000); } catch (e) { App.toast(e.message); } };
    if ($('#encNoHoles')) $('#encNoHoles').onclick = () => Model.mutate(() => { Model.S.pcb.holes = []; });
    return true;
  }

  // ---------- exports ----------
  function exportAll(kind) {
    try {
      const { files, info } = Enclosure.exportFiles();
      const names = Object.keys(files);
      if (kind === 'stl') { for (const n of names.filter(n => n.endsWith('.stl'))) App.download(n, new Blob([files[n]], { type: 'model/stl' })); }
      else if (kind === 'scad') { const n = names.find(n => n.endsWith('.scad')); App.download(n, files[n], 'text/plain'); }
      else App.download((Model.S.name || 'board').replace(/[^\w.-]+/g, '_') + '-enclosure.zip', makeZip(files));
      App.toast(`Enclosure ${info.outer_mm.join(' × ')} mm exported`);
    } catch (e) { App.toast(e.message); }
  }
  return { init, show, hide, props, ui, rebuild: () => rebuild(true) };
})();
