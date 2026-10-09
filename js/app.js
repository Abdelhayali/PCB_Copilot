'use strict';
// UI glue: panels, toolbar, properties, copilot chat, settings, files & exports.
const App = (() => {
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  let view = 'sch', mode = 'agent', running = false, lastError = null;

  function toast(msg, ms = 3200) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), ms);
  }
  function download(name, data, type = 'text/plain') {
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const fname = ext => (Model.S.name || 'design').replace(/[^\w.-]+/g, '_') + ext;

  // ---------- views ----------
  function showView(v) {
    view = v;
    $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.view === v));
    $('#schSvg').classList.toggle('hidden', v !== 'sch'); $('#pcbSvg').classList.toggle('hidden', v !== 'pcb'); $('#encView').classList.toggle('hidden', v !== 'enc');
    $('#schTools').classList.toggle('hidden', v !== 'sch'); $('#pcbTools').classList.toggle('hidden', v !== 'pcb'); $('#encTools').classList.toggle('hidden', v !== 'enc');
    PcbView.setVisible(v === 'pcb' && !Pcb3D.ui.on);
    $('#pcb3dView').classList.toggle('hidden', !(v === 'pcb' && Pcb3D.ui.on));
    if (v === 'enc') EncView.show(); else EncView.hide();
    renderAll();
    if (v === 'pcb') { Pcb.vp.apply(); if (!showView._pcbFit) { Pcb.fit(); showView._pcbFit = true; } } else if (v === 'sch') Sch.vp.apply();
  }
  function renderAll() {
    if (view === 'sch') Sch.render(); else if (view === 'pcb') Pcb.render();
    renderStatus(); renderProps();
    $('#btnUndo').disabled = !Model.canUndo(); $('#btnRedo').disabled = !Model.canRedo();
    if (document.activeElement !== $('#projName')) $('#projName').value = Model.S.name || 'Untitled';
    $('#boardW').value = Model.S.board.w || ''; $('#boardH').value = Model.S.board.h || '';
  }
  function renderStatus() {
    const S = Model.S, erc = Model.erc(), e = erc.filter(i => i.level === 'error').length, w = erc.filter(i => i.level === 'warn').length;
    let s = `${S.components.length} parts · ${Object.keys(S.nets).length} nets · <span class="${e ? 'bad' : w ? 'warn' : 'good'}" id="ercLink" title="Click for ERC details">ERC: ${e} errors, ${w} warnings</span>`;
    const st = Pcb.status();
    if (st.placed && S.board.w) s += ` · PCB ${S.board.w}×${S.board.h} mm · <span class="${st.unrouted.length ? 'warn' : 'good'}">${st.routed}/${st.nets} routed</span> · ${st.vias} vias · ${st.trace_length_mm} mm copper`;
    if (Pcb.ui.drc) s += ` · <span class="${Pcb.ui.drc.errors ? 'bad' : Pcb.ui.drc.warnings ? 'warn' : 'good'}">DRC: ${esc(Pcb.ui.drc.summary)}</span>`;
    $('#status').innerHTML = s;
    $('#ercLink').onclick = () => {
      $('#props').innerHTML = '<div class="ph">ERC report</div>' + (erc.length ? '<ul class="erc">' + erc.map(i => `<li class="${i.level}">${esc(i.msg)}</li>`).join('') + '</ul>' : '<div class="muted">No issues 🎉</div>');
    };
  }

  // ---------- parts palette ----------
  const db = { q: '', loading: false, results: [], error: null, source: '' };
  let dbTimer = null, dbSeq = 0;
  function searchDb(q) {
    clearTimeout(dbTimer);
    if (q.trim().length < 2) { db.q = ''; db.results = []; db.error = null; renderParts(); return; }
    dbTimer = setTimeout(async () => {
      const seq = ++dbSeq; db.q = q; db.loading = true; db.error = null; renderParts();
      try { const j = await AI.partsApi('search?q=' + encodeURIComponent(q) + '&limit=25'); if (seq !== dbSeq) return; db.results = j.results; db.source = j.source; db.error = j.source === 'local' && j.error ? 'Offline — showing cached parts' : null; }
      catch (e) { if (seq !== dbSeq) return; db.results = []; db.error = e.message; }
      db.loading = false; renderParts();
    }, 600);
  }
  async function placeDbPart(code) {
    toast('Loading ' + code + '…', 8000);
    try {
      const m = await AI.loadPart(code);
      if (view !== 'sch') showView('sch');
      const vb = Sch.vp.vb || [0, 0, 0, 0];
      const key = m.key || m.lcsc;
      const c = Model.mutate(() => { if (!Model.S.lib[key]) Model.setLibPart(key, m); return Model.addComponent({ part: key, x: vb[0] + vb[2] / 2, y: vb[1] + vb[3] / 2 }); });
      Sch.select(c.ref); toast(`Added ${c.ref} · ${m.name} (${m.pins.length} pins, ${m.footprint ? m.footprint.pads.length + ' pads' : 'no footprint'})`);
    } catch (e) { toast('Could not load ' + code + ': ' + e.message, 6000); }
  }
  // palette parts come with the real JLCPCB part behind the symbol (falls back to a generated footprint offline)
  async function placeBuiltin(type) {
    const d = Lib.dbDefault(type, null);
    let part = null;
    if (d) { try { part = await AI.loadPart(d.lcsc); } catch (e) { toast('Parts database unavailable — using a generated footprint', 4000); } }
    const vb = Sch.vp.vb || [0, 0, 0, 0];
    const c = Model.mutate(() => Model.addComponent({ type, x: vb[0] + vb[2] / 2, y: vb[1] + vb[3] / 2, dbPart: part }));
    Sch.select(c.ref);
    if (c.pinMap) toast(`${c.ref}: ${part.name} · ${c.lcscPart} · ${part.footprint.name}`, 4000);
  }
  function placeLibPart(key) {
    const m = Projects.myLib.find(p => p.key === key) || Model.S.lib[key];
    if (!m) { toast('Part not found: ' + key); return; }
    if (view !== 'sch') showView('sch');
    const vb = Sch.vp.vb || [0, 0, 0, 0];
    try {
      const c = Model.mutate(() => { if (!Model.S.lib[key]) Model.setLibPart(key, m); return Model.addComponent({ part: key, x: vb[0] + vb[2] / 2, y: vb[1] + vb[3] / 2 }); });
      Sch.select(c.ref); toast(`Added ${c.ref} · ${m.name}`);
    } catch (e) { toast(e.message); }
  }
  function renderMyLib(q) {
    const ps = Projects.myLib.filter(p => !q || `${p.name} ${p.value} ${p.key} ${p.mfr_part || ''}`.toLowerCase().includes(q));
    if (!ps.length) return q ? '' : '<div class="pcat">My Library</div><div class="muted small">No custom parts yet. Click “＋ New part”, or edit any placed part and save it.</div>';
    return '<div class="pcat">My Library</div>' + ps.map(p => `<div class="libpart"><button class="dbpart mylib" data-key="${esc(p.key)}" title="Place ${esc(p.name)}">
      <div class="dbt"><b>${esc(p.name)}</b><span class="badge">${p.custom ? 'custom' : 'edited'}</span></div>
      <div class="dbs">${(p.pins || []).length} pins · ${esc((p.footprint && p.footprint.name) || 'no footprint')}</div></button>
      <button class="mini-btn" data-edit="${esc(p.key)}" title="Edit">✎</button><button class="mini-btn danger" data-del="${esc(p.key)}" title="Remove from My Library">✕</button></div>`).join('');
  }
  function renderDb() {
    if (!db.q && !db.loading) return '';
    let h = `<div class="pcat">Database · JLCPCB / LCSC${db.loading ? ' <span class="spin"></span>' : ''}</div>`;
    if (db.error) h += `<div class="dberr">${esc(db.error)}</div>`;
    if (!db.loading && !db.results.length && !db.error) h += '<div class="muted small">No parts found</div>';
    h += db.results.map(r => `<button class="dbpart" data-lcsc="${esc(r.lcsc)}" title="${esc(r.description || '')}">
      <div class="dbt"><b>${esc(r.mfr_part || r.lcsc)}</b>${r.basic ? '<span class="badge basic">Basic</span>' : ''}</div>
      <div class="dbs">${esc(r.package || '')} · ${esc(r.brand || '')}</div>
      <div class="dbs">${esc(r.lcsc)} · <span class="${r.stock > 0 ? 'good' : 'bad'}">${(r.stock || 0).toLocaleString()} in stock</span>${r.price != null ? ' · $' + (+r.price).toFixed(r.price < 0.1 ? 4 : 2) : ''}</div></button>`).join('');
    return h;
  }
  function renderParts() {
    const q = $('#partSearch').value.toLowerCase(), cats = {};
    for (const t of Lib.types()) {
      const d = Lib.type(t); if (q && !(d.name + ' ' + t).toLowerCase().includes(q)) continue;
      (cats[d.cat] = cats[d.cat] || []).push(t);
    }
    $('#partList').innerHTML = Object.entries(cats).map(([c, ts]) => `<div class="pcat">${c}</div>` + ts.map(t => {
      const d = Lib.type(t), b = d.box({ type: t }), pad = 6;
      const db = Lib.dbDefault(t, null);
      return `<button class="part" data-type="${t}" title="Add ${esc(d.name)}${db ? ` — JLCPCB ${db.lcsc} (${esc(db.value)}, ${esc(db.pkg)})` : ' — standard footprint'}"><svg viewBox="${b[0] - pad} ${b[1] - pad} ${b[2] - b[0] + 2 * pad} ${b[3] - b[1] + 2 * pad}"><g class="comp mini">${d.draw({ type: t })}</g></svg><span>${esc(d.name)}</span>${db ? `<i class="jlc">${db.lcsc}</i>` : ''}</button>`;
    }).join('')).join('') + renderMyLib(q) + renderDb();
  }

  // ---------- properties ----------
  function renderProps() {
    const el = $('#props');
    if (el.contains(document.activeElement) && document.activeElement.tagName !== 'BUTTON') return;
    if (view === 'pcb' && PcbView.props(el)) return;
    if (view === 'enc' && EncView.props(el)) return;
    const ref = view === 'sch' ? Sch.ui.sel : Pcb.ui.sel, net = view === 'sch' ? Sch.ui.selNet : null;
    const c = ref && Model.comp(ref);
    if (c) {
      const d = Lib.type(c.type), idx = Model.pinIndex();
      const fps = [...new Set([...Lib.fpsFor(c), c.footprint])];
      el.innerHTML = `<div class="ph">${esc(c.ref)} <span class="muted">${esc(d.name)}</span></div>
        <label>Reference<input id="pRef" value="${esc(c.ref)}"></label>
        <label>Value<input id="pVal" value="${esc(c.value)}"></label>
        ${c.lcsc && Model.S.lib[c.lcsc] ? `<div class="lcscinfo"><b>${esc(Model.S.lib[c.lcsc].name)}</b><br>${Model.S.lib[c.lcsc].custom ? '<span class="muted">Custom part · ' + esc(c.lcsc) + '</span>' : `${esc(Model.S.lib[c.lcsc].manufacturer || '')} · <span class="muted">${esc(c.lcsc)}</span>`}${Model.S.lib[c.lcsc].datasheet ? ` · <a href="${esc(Model.S.lib[c.lcsc].datasheet)}" target="_blank" rel="noopener">datasheet</a>` : ''}</div>` : ''}
        <label>Footprint<select id="pFp">${fps.map(f => `<option ${f === c.footprint ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></label>
        ${d.generic ? `<label>Pins (comma separated, pin 1 first)<textarea id="pPins" rows="3">${esc((c.pins || Lib.type(c.type).pins(c).map(p => p.name)).join(', '))}</textarea></label>` : ''}
        <div class="row"><button id="pRot">⟳ Rotate (R)</button><button id="pDel" class="danger">Delete</button></div>
        ${view === 'pcb' && c.pcb ? `<div class="ph small">Board side</div><div class="row edgebtns"><button data-side="top" class="${Pcb.isBottom(c) ? '' : 'on'}">▲ Top</button><button data-side="bottom" class="${Pcb.isBottom(c) ? 'on' : ''}">▼ Bottom</button></div>` : ''}
        ${view === 'pcb' && c.pcb ? `<div class="ph small">Place on board edge${c.pcbEdge ? ' · <span class="muted">' + c.pcbEdge + '</span>' : ''}</div><div class="row edgebtns"><button data-edge="left" title="Left edge">⇤ Left</button><button data-edge="top" title="Top edge">⤒ Top</button><button data-edge="bottom" title="Bottom edge">⤓ Bottom</button><button data-edge="right" title="Right edge">Right ⇥</button></div>` : ''}
        <div class="row"><button id="pEdit" style="flex:1">✎ ${c.type === 'part' ? 'Edit symbol &amp; footprint' : 'Make editable part'}</button></div>
        <div class="ph small">Pins</div><table class="pins">${Lib.type(c.type).pins(c).map(p => `<tr><td>${esc(p.num)}</td><td>${esc(p.name)}</td><td class="${idx[c.ref + '.' + p.num] ? '' : 'muted'}">${esc(idx[c.ref + '.' + p.num] || '—')}</td></tr>`).join('')}</table>`;
      const apply = (u) => { try { Model.mutate(() => Model.updateComponent(Object.assign({ ref: c.ref }, u))); if (u.new_ref) { Sch.ui.sel = u.new_ref; Pcb.ui.sel = u.new_ref; } } catch (e) { toast(e.message); } };
      $('#pRef').onchange = e => apply({ new_ref: e.target.value.trim() });
      $('#pVal').onchange = e => apply({ value: e.target.value });
      $('#pFp').onchange = e => apply({ footprint: e.target.value });
      if ($('#pPins')) $('#pPins').onchange = e => apply({ pins: e.target.value.split(',').map(s => s.trim()).filter(Boolean) });
      $('#pRot').onclick = () => (view === 'sch' ? Sch : Pcb).key({ key: 'r' });
      $('#pDel').onclick = () => { Sch.select(null); Pcb.ui.sel = null; Model.mutate(() => Model.removeComponent(c.ref)); };
      $('#pEdit').onclick = () => editComponent(c.ref);
      el.querySelectorAll('[data-side]').forEach(b => b.onclick = () => { try { Model.mutate(() => Pcb.placeFootprint(c.ref, { side: b.dataset.side })); toast(`${c.ref} on the ${b.dataset.side} side — press Route to reconnect`); } catch (e) { toast(e.message); } });
      el.querySelectorAll('[data-edge]').forEach(b => b.onclick = () => { try { const r = Model.mutate(() => Pcb.placeFootprint(c.ref, { edge: b.dataset.edge })); toast(`${c.ref} on the ${b.dataset.edge} edge${r.outside_board ? ' — outside the board, enlarge it or move it' : ''} · press Route to reconnect`); } catch (e) { toast(e.message); } });
    } else if (net && Model.S.nets[net]) {
      el.innerHTML = `<div class="ph">Net</div><label>Name<input id="pNet" value="${esc(net)}"></label>
        <div class="ph small">Pins (${Model.S.nets[net].length})</div><div class="netpins">${Model.S.nets[net].map(esc).join(', ')}</div>
        <div class="row"><button id="pNetDel" class="danger">Delete net</button></div>`;
      $('#pNet').onchange = e => { try { const to = e.target.value.trim(); Model.mutate(() => Model.renameNet(net, to)); Sch.select(null, to); } catch (err) { toast(err.message); } };
      $('#pNetDel').onclick = () => { Sch.select(null); Model.mutate(() => Model.removeNet(net)); };
    } else {
      el.innerHTML = `<div class="muted help">${view === 'sch'
        ? '<b>Click</b> a part to select · <b>drag</b> to move · <b>R</b> rotate · <b>Del</b> delete<br><b>Click a pin, then another pin</b> to wire them<br><b>Drag empty space</b> to pan · <b>wheel</b> to zoom'
        : '<b>Drag</b> footprints to move · <b>R</b> rotate<br>Moving a part un-routes its nets — press <b>Route</b> again<br>Red = top copper · Blue = bottom · Yellow = ratsnest'}</div>`;
    }
  }

  // Edit a placed part (or convert a built-in one into an editable custom part).
  function editComponent(ref) {
    const c = Model.comp(ref); if (!c) return;
    if (c.type === 'part' && Model.S.lib[c.lcsc]) { PartEditor.open(Model.S.lib[c.lcsc], { key: c.lcsc, saveLib: true }); return; }
    const d = PartEditor.fromBuiltin(c), key = PartEditor.newKey(d.name);
    PartEditor.open(d, {
      key, isNew: true, saveLib: true, onDone: k => {
        Model.mutate(() => { const cc = Model.comp(ref); if (!cc) return; cc.type = 'part'; cc.lcsc = k; delete cc.pins; cc.footprint = Model.fpNameFor(k); Model.invalidate(Model.netsOfComp(ref)); });
        Sch.select(ref);
      }
    });
  }

  // ---------- light / dark / system theme ----------
  const THEMES = { system: ['🖥', 'Theme: follows the system — click for Light'], light: ['☀', 'Theme: Light — click for Dark'], dark: ['🌙', 'Theme: Dark — click to follow the system'] };
  function applyTheme(mode) {
    const sys = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    const d = mode === 'system' ? sys : mode, root = document.documentElement;
    root.setAttribute('data-theme', d); root.setAttribute('data-theme-mode', mode);
    try { localStorage.setItem('cp.theme', mode); } catch (e) { }
    $('#btnTheme').textContent = THEMES[mode][0]; $('#btnTheme').title = THEMES[mode][1];
    window.dispatchEvent(new Event('themechange'));
  }
  function initTheme() {
    let mode = 'system'; try { mode = localStorage.getItem('cp.theme') || 'system'; } catch (e) { }
    applyTheme(THEMES[mode] ? mode : 'system');
    $('#btnTheme').onclick = () => { const order = ['system', 'light', 'dark'], cur = document.documentElement.getAttribute('data-theme-mode') || 'system'; applyTheme(order[(order.indexOf(cur) + 1) % 3]); toast(THEMES[document.documentElement.getAttribute('data-theme-mode')][1].split(' — ')[0]); };
    if (window.matchMedia) matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if ((document.documentElement.getAttribute('data-theme-mode') || 'system') === 'system') applyTheme('system'); });
  }

  // ---------- autorouter in a Web Worker ----------
  let worker = null, routeReject = null, routeBest = null, routeResolve = null;
  function runRouter({ place = null, opt = {}, optimize = null } = {}) {
    if (worker) worker.terminate();
    return new Promise((resolve, reject) => {
      routeReject = reject; routeResolve = resolve; routeBest = null;
      worker = new Worker('js/route-worker.js');
      $('#routeBusy').classList.remove('hidden'); $('#routeMsg').textContent = place ? 'Placing…' : 'Routing…';
      worker.onmessage = e => {
        const m = e.data;
        if (m.type === 'best') { routeBest = m; return; }
        if (m.type === 'progress') {
          const opt = m.optimizing ? `Optimizing placement ${m.iteration}/${m.of} · ` : '';
          const time = m.budget ? ` · ${Math.round(m.elapsed)}/${Math.round(m.budget)} s` : '';
          $('#routeMsg').textContent = m.phase === 'ripup'
            ? `${opt}Rip-up & reroute · ${m.unrouted} unrouted · try ${m.iteration}${m.attempt > 1 ? ' · pass ' + m.attempt : ''}${time}`
            : `${opt}Routing ${m.net} (${(m.done ?? 0) + 1}/${m.total ?? '?'})${m.attempt > 1 ? ' · pass ' + m.attempt : ''}${time}`;
          return;
        }
        worker.terminate(); worker = null; $('#routeBusy').classList.add('hidden');
        if (m.type === 'error') { reject(new Error(m.message)); return; }
        Model.mutate(() => {
          const S = Model.S;
          for (const [ref, pcb] of m.positions) { const c = Model.comp(ref); if (c) c.pcb = pcb; }
          S.board = m.board; S.pcb = m.pcb;
        });
        Pcb.ui.drc = null;
        resolve({ placement: m.placement, routing: m.routing, optimized: m.optimized });
      };
      worker.onerror = e => { worker.terminate(); worker = null; $('#routeBusy').classList.add('hidden'); reject(new Error(e.message || 'Router crashed')); };
      worker.postMessage({ state: JSON.parse(Model.snapshot()), place, opt, optimize });
      if (optimize) $('#routeMsg').textContent = 'Optimizing placement…';
    });
  }

  async function jlcBom() {
    toast('Matching JLCPCB parts for every value…', 20000);
    const r = await Engine.matchJlcpcb(false), S = Model.S;
    const g = {};
    for (const c of S.components) {
      const lib = (c.lcsc && S.lib[c.lcsc]) || (c.dbfp && S.lib[c.dbfp]), fpn = (lib && lib.footprint && lib.footprint.name) || c.footprint;
      const code = c.type === 'part' ? c.lcsc : c.lcscPart || '';
      const k = [c.value, fpn, code].join('|'); (g[k] = g[k] || []).push(c.ref);
    }
    const q = s => '"' + String(s).replace(/"/g, '""') + '"';
    const csv = 'Comment,Designator,Footprint,LCSC Part #\n' + Object.entries(g).map(([k, refs]) => { const [v, f, code] = k.split('|'); return [q(v), q(refs.join(',')), q(f), q(code)].join(','); }).join('\n');
    download(fname('-BOM-JLCPCB.csv'), csv, 'text/csv');
    toast(`JLCPCB BOM: ${r.matched}/${r.total} parts have LCSC numbers${r.matched < r.total ? ' — the rest need a part chosen (connectors / custom ICs)' : ''}`, 7000);
  }

  // ---------- placement optimiser ----------
  async function runOptimize(o = {}) {
    try {
      showView('pcb');
      const before = `${Model.S.board.w}×${Model.S.board.h}`;
      const r = await runRouter({ optimize: Object.assign({ time_limit_s: o.shrink ? 180 : 150, allow_grow: false, allow_bottom: false }, o) });
      const p = r.optimized; Pcb.fit();
      if (!p) { showDrc(); return; }   // stopped: best kept
      const size = `${p.board.w}×${p.board.h}`;
      toast(p.unrouted.length ? `Optimized (${p.iterations} rounds) — ${p.routed}/${p.total} routed, still unrouted: ${p.unrouted.join(', ')}. Try a GND pour, a bigger board or AI place.` : `✓ All ${p.total} nets routed${size !== before ? ` · board ${before} → ${size} mm` : ''} (${p.seconds}s)`, 9000);
      showDrc(); return p;
    } catch (e) { toast(e.message); }
  }
  // AI placement: the copilot plans the floor plan with place_footprints, then routes and fixes what is left
  function aiPlace() {
    const S = Model.S;
    if (!S.components.length) { toast('Add parts first'); return; }
    if (!AI.settings.anthropicKey && !AI.settings.oaiModels) { toast('AI place needs a model (⚙ Settings) — using quick place instead'); runPcb(boardWH(), false); return; }
    showView('pcb'); setMode('agent');
    const hasBoard = S.board.w > 0 && Pcb.placed().length;
    send((hasBoard ? '' : 'First call generate_pcb with route: false to create the board and footprints. ') +
      'Then auto-place the PCB for the easiest routing and a compact layout: read get_pcb_layout, plan the floor plan (follow the PCB PLACEMENT guidance: connectors on edges, decoupling caps next to the power pins they serve, crystal at the MCU, USB pair short and straight, room around fine-pitch ICs, functional groups along the signal flow), apply it with ONE place_footprints call for all parts, then route_pcb. If nets stay unrouted, move the parts around them and route again, or call optimize_pcb. Finish with run_drc and a two-line summary.');
  }

  // ---------- Gerber export: DRC first, then download or fix ----------
  function gerberDownload() {
    download(fname('-gerbers.zip'), makeZip(Pcb.gerbers()));
    $('#gerberModal').classList.add('hidden');
    toast('Gerbers, drill, paste & silkscreen exported — upload the zip to your PCB fab');
  }
  function gerberCheck() {
    const S = Model.S;
    if (!S.board.w || !Pcb.placed().length) { toast('No PCB yet — Generate PCB first'); return; }
    const d = showDrc(), v = d.violations;
    if (!v.length) { gerberDownload(); toast('✓ DRC passed — Gerbers exported'); return; }
    $('#gbSummary').innerHTML = `<p><b class="${d.errors ? 'bad' : 'warn'}">${esc(d.summary)}</b> — ${d.errors ? 'the board has errors that a fab may reject or that would make it not work.' : 'only warnings; the board can be manufactured.'}</p><p class="muted small">Click an item to see it on the board.</p>`;
    $('#gbList').innerHTML = v.map((x, i) => `<li class="${x.severity === 'error' ? 'error' : 'warn'}" data-v="${i}">${esc(x.msg)}</li>`).join('');
    $('#gbList').querySelectorAll('[data-v]').forEach(li => li.onclick = () => { const x = v[+li.dataset.v]; $('#gerberModal').classList.add('hidden'); showView('pcb'); showDrc(); if (x.x != null) Pcb.vp.fit([x.x - 3, x.y - 3, x.x + 3, x.y + 3], 1); });
    $('#gbOpt').classList.toggle('hidden', !Pcb.status().unrouted.length);
    $('#gbDownload').textContent = d.errors ? 'Download anyway' : 'Download';
    $('#gerberModal').classList.remove('hidden');
  }
  function initGerberCheck() {
    $('#gbClose').onclick = () => $('#gerberModal').classList.add('hidden');
    $('#gbDownload').onclick = gerberDownload;
    $('#gbFix').onclick = () => { $('#gerberModal').classList.add('hidden'); showView('pcb'); showDrc(true); };
    $('#gbRoute').onclick = async () => { $('#gerberModal').classList.add('hidden'); try { await runRouter({ opt: {} }); } catch (e) { toast(e.message); } gerberCheck(); };
    $('#gbOpt').onclick = async () => { $('#gerberModal').classList.add('hidden'); await runOptimize(); gerberCheck(); };
  }

  // ---------- design rules + DRC ----------
  let rDraft = null;
  function openRules() {
    rDraft = JSON.parse(JSON.stringify(Pcb.rules()));
    $('#rPreset').innerHTML = Object.entries(Pcb.RULE_PRESETS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
    fillRules(); $('#rulesModal').classList.remove('hidden');
  }
  function fillRules() {
    $('#rPreset').value = rDraft.preset;
    $$('#rulesModal [data-r]').forEach(el => { const v = rDraft[el.dataset.r]; if (el.type === 'checkbox') el.checked = !!v; else el.value = v; });
    $('#rNets').innerHTML = Object.entries(rDraft.netWidths).map(([n, w]) => `<div class="nr"><b>${esc(n)}</b><span>${w} mm</span><button data-rm="${esc(n)}" class="danger">✕</button></div>`).join('') || '<div class="muted small">No per-net widths — power/GND nets use the power width.</div>';
    $('#rNetSel').innerHTML = Object.keys(Model.S.nets).sort().map(n => `<option>${esc(n)}</option>`).join('');
    const w = Pcb.ruleWarnings(rDraft); $('#rWarn').innerHTML = w.map(x => '⚠ ' + esc(x)).join('<br>');
  }
  function readRules() {
    $$('#rulesModal [data-r]').forEach(el => { const k = el.dataset.r; rDraft[k] = el.type === 'checkbox' ? el.checked : +el.value; });
  }
  async function saveRules(route) {
    readRules();
    const u = Object.assign({}, rDraft), cur = Pcb.rules();
    const removed = Object.keys(cur.netWidths).filter(n => !(n in rDraft.netWidths));
    u.netWidths = Object.assign({}, rDraft.netWidths); removed.forEach(n => u.netWidths[n] = 0);
    try {
      const r = Model.mutate(() => { Model.S.rules = { preset: rDraft.preset, netWidths: Model.S.rules && Model.S.rules.netWidths || {} }; return Pcb.setRules(u); });
      $('#rulesModal').classList.add('hidden');
      toast(r.warnings.length ? '⚠ ' + r.warnings[0] : 'Design rules saved');
      if (route) { showView('pcb'); $('#btnRoute').click(); }
    } catch (e) { $('#rWarn').textContent = e.message; }
  }
  function initRules() {
    $('#rulesClose').onclick = $('#rulesCancel').onclick = () => $('#rulesModal').classList.add('hidden');
    $('#rPreset').onchange = e => { const nw = rDraft.netWidths; rDraft = Object.assign({ preset: e.target.value, netWidths: nw }, Pcb.RULE_PRESETS[e.target.value].values); fillRules(); };
    $('#rulesModal').addEventListener('input', e => { if (e.target.dataset.r) { readRules(); $('#rWarn').innerHTML = Pcb.ruleWarnings(rDraft).map(x => '⚠ ' + esc(x)).join('<br>'); } });
    $('#rNets').onclick = e => { const b = e.target.closest('[data-rm]'); if (b) { readRules(); delete rDraft.netWidths[b.dataset.rm]; fillRules(); } };
    $('#rNetAdd').onclick = () => { readRules(); const n = $('#rNetSel').value, w = +$('#rNetW').value; if (n && w > 0) { rDraft.netWidths[n] = w; $('#rNetW').value = ''; fillRules(); } };
    $('#rulesSave').onclick = () => saveRules(false); $('#rulesRoute').onclick = () => saveRules(true);
  }
  function showDrc(goto) {
    const d = Pcb.drc(); Pcb.ui.drc = d;
    if (goto && view !== 'pcb') showView('pcb'); else Pcb.render();
    renderStatus();
    const items = d.violations;
    $('#props').innerHTML = `<div class="ph">Design rule check · <span class="${d.errors ? 'bad' : d.warnings ? 'warn' : 'good'}">${esc(d.summary || '')}</span></div>
      <div class="muted small">Rules: ${esc(Pcb.RULE_PRESETS[Pcb.rules().preset] ? Pcb.RULE_PRESETS[Pcb.rules().preset].label : 'custom')}</div>` +
      (items.length ? '<ul class="erc drc">' + items.map((v, i) => `<li class="${v.severity === 'error' ? 'error' : 'warn'}" data-v="${i}">${esc(v.msg)}</li>`).join('') + '</ul>' : '<div class="good">✓ No violations</div>');
    $('#props').querySelectorAll('[data-v]').forEach(li => li.onclick = () => { const v = items[+li.dataset.v]; if (v.x != null) Pcb.vp.fit([v.x - 3, v.y - 3, v.x + 3, v.y + 3], 1); });
    return d;
  }

  // ---------- project knowledge folder ----------
  function knowState() {
    const k = Model.S.knowledge; $('#btnKnow').classList.toggle('on', !!(k && k.path));
    $('#btnKnow').title = k && k.path ? 'Knowledge folder: ' + k.path : 'Project knowledge folder: docs & guides the AI follows';
  }
  async function showKnowFiles() {
    const k = Model.S.knowledge; $('#knowPath').value = (k && k.path) || '';
    if (!k || !k.path) { $('#knowInfo').textContent = 'No folder set for this project.'; $('#knowFiles').innerHTML = ''; return; }
    $('#knowInfo').textContent = 'Reading folder…';
    try {
      const j = await Engine.api('/api/knowledge/list?' + new URLSearchParams({ path: k.path }));
      const d = await Engine.knowledgeDigest(true);
      $('#knowInfo').innerHTML = `${j.files.length} documents in <b>${esc(j.folder)}</b> · ${(d.included_chars || 0).toLocaleString()} chars go straight into the AI context, the rest is searchable.`;
      $('#knowFiles').innerHTML = j.files.map(f => `<div class="kf"><span>${esc(f.file)}</span><span class="muted">${f.chars.toLocaleString()} chars</span></div>`).join('') || '<div class="muted">No readable documents found.</div>';
    } catch (e) { $('#knowInfo').innerHTML = `<span class="bad">${esc(e.message)}</span>`; $('#knowFiles').innerHTML = ''; }
  }
  function initKnowledge() {
    $('#btnKnow').onclick = () => { $('#knowModal').classList.remove('hidden'); showKnowFiles(); };
    $('#knowClose').onclick = () => $('#knowModal').classList.add('hidden');
    $('#knowSet').onclick = async () => {
      try { await Engine.exec('set_knowledge_folder', { path: $('#knowPath').value }); knowState(); showKnowFiles(); }
      catch (e) { $('#knowInfo').innerHTML = `<span class="bad">${esc(e.message)}</span>`; }
    };
    $('#knowClear').onclick = async () => { await Engine.exec('set_knowledge_folder', { path: '' }); knowState(); showKnowFiles(); };
    Model.subscribe(knowState); knowState();
  }

  // ---------- chat ----------
  function md(src) {
    const lines = String(src || '').split('\n'), out = [];
    const inline = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
    const cells = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    let i = 0;
    while (i < lines.length) {
      const l = lines[i]; let m;
      if (/^```/.test(l)) { const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>'); continue; }
      if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const head = cells(l); i += 2; const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
        out.push('<div class="tw"><table><tr>' + head.map(h => '<th>' + inline(h) + '</th>').join('') + '</tr>' + rows.map(r => '<tr>' + r.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</table></div>');
        continue;
      }
      if ((m = /^(#{1,4})\s+(.*)/.exec(l))) { out.push(`<h${Math.min(6, m[1].length + 2)}>${inline(m[2])}</h${Math.min(6, m[1].length + 2)}>`); i++; continue; }
      if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
        const ord = /^\s*\d+\./.test(l), items = [];
        while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''));
        out.push(`<${ord ? 'ol' : 'ul'}>` + items.map(x => '<li>' + inline(x) + '</li>').join('') + `</${ord ? 'ol' : 'ul'}>`); continue;
      }
      if (!l.trim()) { i++; continue; }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s+|\s*\|)/.test(lines[i])) para.push(lines[i++]);
      if (!para.length) para.push(lines[i++]);
      out.push('<p>' + para.map(inline).join('<br>') + '</p>');
    }
    return out.join('');
  }
  const SUGGEST = [
    'Design a 555 astable LED blinker at ~1 Hz powered from a 9V battery, then make the PCB',
    'Build a 5V regulated supply from a 12V input with an LM7805, input/output caps and a power LED',
    'Create a non-inverting op-amp amplifier with gain 10 using a TL071 on ±12V',
    'NPN transistor switch driving a 12V relay coil from a 3.3V GPIO, with flyback diode',
  ];
  function renderChat() {
    const H = AI.history, out = [];
    if (!H.length) {
      out.push(`<div class="welcome"><div class="wt">What should we build?</div><div class="muted">The copilot places parts, wires the schematic, checks ERC and routes the PCB. Pick a model above, choose a mode, and describe your circuit.</div>` +
        SUGGEST.map(s => `<button class="sugg">${esc(s)}</button>`).join('') + '</div>');
    }
    const results = {};
    for (const m of H) if (m.role === 'tool') for (const r of m.results) results[r.id] = r;
    H.forEach((m, i) => {
      if (m.summary) { out.push(`<div class="msg summary"><details><summary>🗜 Earlier conversation compressed${m.compressed ? ` (${m.compressed} message${m.compressed > 1 ? 's' : ''})` : ''}${m.saved ? ` — about ${fmtTok(m.saved)} tokens freed` : ''}. Show summary</summary><div class="md">${md(m.text)}</div></details></div>`); return; }
      if (m.summaryAck) return;
      const atts = (m.files || []).map(f => f.kind === 'image' && f.data ? `<img src="data:${f.mime};base64,${f.data}" alt="${esc(f.name)}" title="${esc(f.name)} (click to enlarge)" class="thumb">` : `<span class="att">${fileIcon(f)} <span class="an">${esc(f.name)}</span></span>`).join('');
      if (m.role === 'user') out.push(`<div class="msg user">${m.text ? `<div class="bub">${esc(m.text).replace(/\n/g, '<br>')}</div>` : ''}${atts ? `<div class="atts">${atts}</div>` : ''}<div class="meta">${m.mode ? `<span class="mtag ${m.mode}">${m.mode}</span>` : ''}${m.checkpoint ? `<button class="restore" data-i="${i}" title="Restore the design to how it was before this message">↺ restore checkpoint</button>` : ''}</div></div>`);
      else if (m.role === 'assistant') {
        let h = '';
        if (m.text) h += `<div class="md">${md(m.text)}</div>`;
        for (const t of m.toolCalls || []) {
          const r = results[t.id];
          h += `<details class="tool ${r ? (r.error ? 'err' : 'ok') : 'run'}"><summary><span class="dot"></span>${esc(t.name)} <span class="muted">${esc(toolHint(t))}</span></summary><pre>${esc(JSON.stringify(t.input, null, 1))}</pre>${r ? `<pre class="res">${esc(r.content.slice(0, 4000))}</pre>` : ''}</details>`;
        }
        const next = H[i + 1];
        if (m.mode === 'plan' && !(m.toolCalls || []).length && (!next || next.role === 'user') && !running) h += '<button class="exec">▶ Execute plan</button>';
        out.push(`<div class="msg ai">${h}<div class="meta">${esc(m.model || '')}</div></div>`);
      }
    });
    if (infoMsg) out.push(`<div class="msg info"><span class="spin"></span> ${esc(infoMsg)}</div>`);
    else if (running) out.push('<div class="msg ai"><div class="typing"><span></span><span></span><span></span></div></div>');
    if (lastError) out.push(`<div class="msg err">${esc(lastError)}</div>`);
    const chat = $('#chat'); chat.innerHTML = out.join(''); chat.scrollTop = chat.scrollHeight;
    updateCtx();
  }

  // ---------- chat extras: attachments, web toggle, folder, context meter ----------
  let pendingFiles = [], infoMsg = null;
  const fmtTok = n => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);
  const fileIcon = f => f.kind === 'image' ? '🖼' : f.kind === 'pdf' ? '📄' : '📝';
  function updateCtx() {
    const c = AI.contextInfo(), fill = $('#ctxFill'); if (!fill) return;
    fill.style.width = c.pct + '%'; fill.className = 'ctx-fill' + (c.pct >= 80 ? ' high' : c.pct >= 60 ? ' mid' : '');
    $('#ctxText').textContent = `${fmtTok(c.used)} / ${fmtTok(c.window)} · ${100 - c.pct}% left`;
    $('#autoCompress').checked = c.auto;
    $('#btnCompress').disabled = running || AI.history.filter(m => m.role === 'user' && !m.summary).length < 1 || AI.history.length < 2;
    $('#btnWeb').classList.toggle('on', AI.settings.webAccess !== false);
    $('#btnWeb').title = AI.settings.webAccess !== false ? 'Web search is ON — the AI can search the internet and read pages (click to turn off)' : 'Web search is OFF (click to turn on)';
    const k = Model.S.knowledge, on = !!(k && k.path);
    $('#btnFolder').classList.toggle('on', on);
    $('#btnFolder').textContent = on ? '📁 ' + k.path.split(/[\\/]/).filter(Boolean).pop() : '📁 Folder';
    $('#btnFolder').title = on ? 'AI folder: ' + k.path + ' (click to change)' : 'Point the AI to a folder of docs, guides and datasheets';
  }
  function renderAttach() {
    $('#attachList').innerHTML = pendingFiles.map((f, i) => `<span class="att${f.error ? ' err' : ''}" title="${esc(f.error || f.warn || f.name)}">${f.busy ? '<span class="spin"></span>' : f.kind === 'image' && f.data ? `<img src="data:${f.mime};base64,${f.data}">` : fileIcon(f)}<span class="an">${esc(f.name)}</span>${f.pages ? `<span class="muted">${f.pages}p</span>` : ''}${f.error ? ' ⚠' : f.warn ? ' <span class="muted">⚠</span>' : ''}<button class="x" data-i="${i}" title="Remove">✕</button></span>`).join('');
  }
  const toB64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
  async function readImage(f) {
    const ok = /^image\/(png|jpeg|webp|gif)$/.test(f.type);
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('unsupported image format')); i.src = URL.createObjectURL(f); });
    const max = 1568, s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    if (ok && s === 1 && f.size < 1.5e6) return { kind: 'image', mime: f.type, data: await toB64(f) };
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(img.src);
    return { kind: 'image', mime: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.85).split(',')[1] };
  }
  async function addFiles(list) {
    for (const f of [...list]) {
      if (f.size > 40e6) { toast(`${f.name} is too large (max 40 MB)`); continue; }
      const item = { name: f.name || 'pasted-image.png', size: f.size, busy: true };
      pendingFiles.push(item); renderAttach();
      try {
        if (/^image\//.test(f.type)) Object.assign(item, await readImage(f));
        else {
          const pdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
          let r;
          if (Projects.online) {
            const res = await fetch('/api/extract?name=' + encodeURIComponent(f.name), { method: 'POST', body: f });
            r = await res.json(); if (!res.ok) throw new Error(r.error || res.statusText);
          } else r = pdf ? { text: '', error: 'PDF text needs the app server' } : { text: await f.text() };
          if (r.binary) throw new Error('binary file — no readable text (attach a PDF, image, text or Word file)');
          Object.assign(item, { kind: pdf ? 'pdf' : 'text', text: r.text || '', pages: r.pages || undefined });
          // Claude reads PDFs natively (text + figures); other models get the extracted text
          if (pdf && f.size < 20e6 && (r.pages || 0) <= 100) item.data = await toB64(f);
          if (r.error) item.warn = r.error; else if (r.truncated) item.warn = 'long file: only the first part of the text is included';
          else if (pdf && !(r.text || '').trim()) item.warn = 'no text layer (scanned PDF?) — only Claude models can read it';
        }
      } catch (e) { item.error = e.message; }
      item.busy = false; renderAttach();
    }
  }
  function toolHint(t) {
    const i = t.input || {};
    if (t.name === 'add_components') return (i.components || []).map(c => c.ref || c.type).join(', ');
    if (t.name === 'connect') return (i.connections || []).map(c => c.net).join(', ');
    if (t.name === 'update_component') return i.ref || '';
    if (t.name === 'remove_components') return (i.refs || []).join(', ');
    return '';
  }
  async function send(text) {
    const typed = text === undefined;
    text = (text ?? $('#prompt').value).trim();
    if (running) return;
    if (typed && pendingFiles.some(f => f.busy)) { toast('Still reading the attached files…'); return; }
    const files = typed ? pendingFiles.filter(f => !f.error).map(({ busy, size, warn, error, ...f }) => f) : [];
    if (!text && !files.length) return;
    if (!text) text = 'Please look at the attached file' + (files.length > 1 ? 's.' : '.');
    if (typed) { pendingFiles = []; renderAttach(); }
    $('#prompt').value = ''; lastError = null; running = true; setRunning(true);
    const checkpoint = mode === 'agent' ? Model.snapshot() : null;
    renderChat();
    await AI.run(text, mode, {
      checkpoint, files,
      onAssistant: () => renderChat(),
      onTool: () => renderChat(),
      onInfo: msg => { infoMsg = msg; renderChat(); },
      onError: msg => { lastError = msg; }
    });
    infoMsg = null;
    running = false; setRunning(false); renderChat();
  }
  function setRunning(on) { $('#btnSend').textContent = on ? '■ Stop' : 'Send'; $('#btnSend').classList.toggle('stop', on); }
  function setMode(m) {
    mode = m; $$('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
    $('#modeHint').textContent = { agent: 'Agent: edits your design (checkpointed)', ask: 'Ask: read-only questions & review', plan: 'Plan: proposes a plan before building' }[m];
  }
  function renderModels() {
    const ms = AI.allModels(), cur = AI.settings.model;
    const grp = (p, label) => { const xs = ms.filter(m => m.provider === p); return xs.length ? `<optgroup label="${label}">` + xs.map(m => `<option value="${esc(m.id)}" ${m.id === cur ? 'selected' : ''}>${esc(m.label)}</option>`).join('') + '</optgroup>' : ''; };
    $('#modelSel').innerHTML = grp('anthropic', 'Anthropic') + grp('openai', 'OpenAI-compatible · ' + AI.settings.oaiBase.replace(/^https?:\/\//, '').split('/')[0]);
  }

  // ---------- settings ----------
  function openSettings() {
    const s = AI.settings;
    $('#sAnth').value = s.anthropicKey; $('#sBase').value = s.oaiBase; $('#sOKey').value = s.oaiKey; $('#sOModels').value = s.oaiModels;
    $('#sMax').value = s.maxTokens; $('#sCtxWin').value = +s.contextWindow > 0 ? s.contextWindow : ''; $('#sCtx').checked = !!s.includeContext; $('#sWeb').checked = s.webAccess !== false; $('#sBrave').value = s.braveKey || '';
    $('#presets').innerHTML = Object.entries(AI.PRESETS).map(([n, u]) => `<button data-u="${esc(u)}">${esc(n)}</button>`).join('');
    $('#modal').classList.remove('hidden');
  }
  let fetchSeq = 0;
  async function fetchModelsUI() {
    const base = $('#sBase').value.trim(), st = $('#sFetchStatus'), seq = ++fetchSeq;
    if (!base) { st.textContent = ''; return; }
    st.className = 'muted'; st.textContent = 'Fetching models…';
    try {
      const ids = await AI.fetchModels(base, $('#sOKey').value.trim());
      if (seq !== fetchSeq) return;
      $('#sOModels').value = ids.join(', ');
      st.className = 'good'; st.textContent = `✓ ${ids.length} model${ids.length > 1 ? 's' : ''} found`;
    } catch (e) {
      if (seq !== fetchSeq) return;
      st.className = 'bad'; st.textContent = '✗ ' + (e.name === 'TimeoutError' ? 'Timed out' : e.message);
    }
  }
  async function autoFetchModels() { // on startup, refresh the list from the configured server
    const s = AI.settings; if (!s.oaiBase) return;
    try {
      const ids = await AI.fetchModels(s.oaiBase, s.oaiKey);
      const upd = { oaiModels: ids.join(', ') };
      if (!AI.allModels().some(m => m.id === s.model) || (!s.anthropicKey && !ids.includes(s.model))) upd.model = ids[0];
      AI.saveSettings(upd); renderModels();
    } catch (e) { }
  }
  function saveSettings() {
    const ids = $('#sOModels').value.split(',').map(x => x.trim()).filter(Boolean);
    if (ids.length && !$('#sAnth').value.trim() && !ids.includes(AI.settings.model)) AI.saveSettings({ model: ids[0] });
    AI.saveSettings({ anthropicKey: $('#sAnth').value.trim(), oaiBase: $('#sBase').value.trim() || 'https://api.openai.com/v1', oaiKey: $('#sOKey').value.trim(), oaiModels: $('#sOModels').value, maxTokens: +$('#sMax').value || 8192, contextWindow: +$('#sCtxWin').value || 0, includeContext: $('#sCtx').checked, webAccess: $('#sWeb').checked, braveKey: $('#sBrave').value.trim() });
    $('#modal').classList.add('hidden'); renderModels(); AI.probeContext().then(updateCtx); toast('Settings saved (stored only in this browser)');
  }

  // ---------- exports ----------
  function exportAs(kind) {
    const S = Model.S;
    try {
      if (kind === 'json') download(fname('.circuit.json'), JSON.stringify(S, null, 1), 'application/json');
      if (kind === 'gerber') { gerberCheck(); return; }
      if (kind === 'svg') download(fname('-schematic.svg'), Sch.exportSVG(), 'image/svg+xml');
      if (kind === 'easyeda') {
        if (!S.components.length) throw new Error('The schematic is empty');
        download(fname('-schematic.easyeda.json'), EasyEDA.exportSchematic(), 'application/json');
        toast('EasyEDA schematic saved — EasyEDA Standard: File → Open → EasyEDA Source · EasyEDA Pro: File → Import → EasyEDA (Standard)', 8000);
      }
      if (kind === 'pcbsvg') { if (!S.board.w) throw new Error('No PCB yet'); if (view !== 'pcb') Pcb.render(); download(fname('-pcb.svg'), Pcb.exportSVG(), 'image/svg+xml'); }
      if (kind === 'bomjlc') { jlcBom(); return; }
      if (kind === 'bom') {
        const g = {};
        for (const c of S.components) { const k = [c.type, c.value, c.footprint].join('|'); (g[k] = g[k] || []).push(c.ref); }
        const csv = 'Qty,References,Type,Value,Footprint\n' + Object.entries(g).map(([k, refs]) => { const [t, v, f] = k.split('|'); return `${refs.length},"${refs.join(' ')}",${t},"${v.replace(/"/g, '""')}",${f}`; }).join('\n');
        download(fname('-bom.csv'), csv, 'text/csv');
      }
      if (kind === 'net') {
        let s = '(export (version "E")\n  (design (source "CircuitPilot"))\n  (components\n';
        for (const c of S.components) s += `    (comp (ref "${c.ref}") (value "${c.value}") (footprint "${c.footprint}"))\n`;
        s += '  )\n  (nets\n';
        Object.entries(S.nets).forEach(([n, keys], i) => { s += `    (net (code "${i + 1}") (name "${n}")\n` + keys.map(k => { const [r, p] = [k.slice(0, k.indexOf('.')), k.slice(k.indexOf('.') + 1)]; return `      (node (ref "${r}") (pin "${p}"))`; }).join('\n') + ')\n'; });
        download(fname('.net'), s + '  )\n)\n');
      }
    } catch (e) { toast(e.message); }
  }

  // ---------- init ----------
  function init() {
    Sch.init($('#schSvg')); Pcb.init($('#pcbSvg')); PcbView.bindBar();
    Sch.ui.onSelect = () => renderProps(); Pcb.ui.onSelect = () => renderProps();
    let saved = null; try { saved = localStorage.getItem('cp.design'); } catch (e) { }
    if (saved) try { Model.load(saved); } catch (e) { }
    Model.subscribe(kind => { if (kind !== 'move') Pcb.ui.drc = null; if (kind === 'move') { if (view === 'sch') Sch.render(); else if (view === 'pcb') Pcb.render(); } else renderAll(); });
    initTheme();
    PartEditor.init();
    // tell open tabs (phone, other PCs) when the app has been updated
    (async () => {
      const ver = async () => { try { return (await (await fetch('/api/version')).json()).version; } catch (e) { return null; } };
      const mine = await ver(); if (!mine) return;
      setInterval(async () => {
        const v = await ver(); if (!v || v === mine || $('#updBar')) return;
        const b = document.createElement('div'); b.id = 'updBar';
        b.innerHTML = 'CircuitPilot was updated. <button>Reload now</button>'; b.querySelector('button').onclick = () => location.reload();
        document.body.appendChild(b);
      }, 30000);
    })();
    Engine.env.myLib = () => Projects.myLib;
    Engine.env.savePart = def => Projects.savePart(def).then(() => renderParts());
    Engine.env.route = runRouter;
    Engine.env.shape = code => EncView.runScript(code);
    Engine.env.searchKey = () => AI.settings.braveKey;
    Engine.env.ui = what => { if (what === 'fit-sch') Sch.fit(); if (what === 'show-pcb') { showView('pcb'); Pcb.fit(); } if (what === 'show-enc') { showView('enc'); EncView.rebuild(); } };
    EncView.init(); Pcb3D.init();
    $('#btn3d').onclick = () => { const on = !Pcb3D.ui.on; PcbView.setVisible(!on); Pcb3D.setOn(on); };
    initKnowledge();
    Projects.init().then(renderParts);

    renderParts(); renderModels(); setMode('agent'); renderChat(); renderAll(); AI.probeContext().then(updateCtx).catch(() => { });
    requestAnimationFrame(() => Sch.fit());

    $('#partSearch').oninput = () => { renderParts(); searchDb($('#partSearch').value); };
    $('#partSearch').onkeydown = e => { if (e.key === 'Enter') { clearTimeout(dbTimer); searchDb($('#partSearch').value); } };
    $('#partList').onclick = e => {
      const ed = e.target.closest('[data-edit]'); if (ed) { const m = Projects.myLib.find(p => p.key === ed.dataset.edit); if (m) PartEditor.open(m, { key: m.key, saveLib: true, allowPlace: true }); return; }
      const dl = e.target.closest('[data-del]'); if (dl) { if (confirm('Remove this part from My Library? (Designs that use it keep their copy.)')) Projects.deletePart(dl.dataset.del).then(renderParts).catch(err => toast(err.message)); return; }
      const ml = e.target.closest('.mylib'); if (ml) { placeLibPart(ml.dataset.key); return; }
      const d = e.target.closest('.dbpart'); if (d) { placeDbPart(d.dataset.lcsc); return; }
      const b = e.target.closest('.part'); if (b) { if (view !== 'sch') showView('sch'); placeBuiltin(b.dataset.type); }
    };
    $$('.tab').forEach(b => b.onclick = () => showView(b.dataset.view));
    $('#btnLayout').onclick = () => { Model.mutate(() => Model.autoLayout()); Sch.fit(); };
    $('#btnDbParts').onclick = async () => { toast('Loading JLCPCB parts…', 15000); const r = await Engine.useDatabaseParts(); toast(r.converted.length ? `${r.converted.length} parts now use real JLCPCB footprints${r.failed.length ? ' · ' + r.failed.length + ' failed' : ''}` : 'Every part already uses a database footprint', 6000); };
    $('#btnFitS').onclick = () => Sch.fit(); $('#btnFitP').onclick = () => Pcb.fit();
    $('#connStyle').value = Model.S.connStyle || 'auto';
    $('#connStyle').onchange = e => Model.mutate(() => { Model.S.connStyle = e.target.value; });
    $('#btnErc').onclick = () => { renderStatus(); $('#ercLink').click(); };
    const routeMsg = r => r && r.routing && r.routing.stopped ? `Stopped — kept the best routing found (${r.routing.unrouted ? r.routing.unrouted + ' nets unrouted' : 'all nets routed'})` : r && r.routing ? `Routed ${r.routing.routed}/${r.routing.total} nets${r.routing.failed.length ? ' — unrouted: ' + r.routing.failed.join(', ') : ''}${r.routing.necked_down && r.routing.necked_down.length ? ' · necked down: ' + r.routing.necked_down.join(', ') : ''}${r.routing.seconds ? ` · ${r.routing.seconds}s` : ''}${r.routing.failed.length ? ' — try ✨ Optimize (moves parts) or ⬛ Pour GND' : ''}` : 'Placed — press Route';
    const runPcb = async (place, noRoute) => { try { const r = await runRouter({ place, opt: { noRoute } }); Pcb.fit(); const pl = r && r.placement, bad = pl && pl.fits === false; toast(routeMsg(r) + (bad ? ' · ⚠ ' + pl.hint : ''), bad ? 12000 : 6000); if (!noRoute) showDrc(); } catch (e) { toast(e.message); } };
    // empty Board W×H boxes = size the board to the parts; otherwise the outline is kept and the parts are fitted inside
    const boardWH = () => { const w = +$('#boardW').value || 0, h = +$('#boardH').value || 0; return w > 0 && h > 0 ? { w, h } : { fit: true }; };
    $('#btnGen').onclick = () => runPcb(boardWH(), false);
    $('#btnPlace').onclick = () => {};   // menu: AI place / quick place
    $$('[data-place]').forEach(b => b.onclick = () => { document.activeElement && document.activeElement.blur(); if (b.dataset.place === 'ai') aiPlace(); else runPcb(boardWH(), true); });
    $('#btnRoute').onclick = () => runPcb(null, false);
    $('#btnRules').onclick = openRules; $('#btnDrc').onclick = () => showDrc(true);
    $('#btnOptimize').onclick = () => {};
    $$('[data-opt]').forEach(b => b.onclick = () => { document.activeElement && document.activeElement.blur(); runOptimize({ shrink: b.dataset.opt !== 'route', allow_bottom: b.dataset.opt === 'bottom' }); });
    $('#btnPourGnd').onclick = () => {
      const S = Model.S, net = S.nets.GND ? 'GND' : prompt('Net for the copper pour', Object.keys(S.nets)[0] || 'GND');
      if (!net) return;
      try { Model.mutate(() => Pcb.addPour({ net, layer: 'both' })); showView('pcb'); toast(`${net} poured on both layers`); } catch (e) { toast(e.message); }
    };
    $('#btnShape').onclick = () => { const b = Model.S.board, sh = b.shape || { type: 'rect' }; $('#shType').value = sh.type; $('#shW').value = b.w || ''; $('#shH').value = b.h || ''; $('#shR').value = sh.r || (sh.type === 'rounded' ? 3 : 0); $('#shapeModal').classList.remove('hidden'); };
    $('#shapeClose').onclick = () => $('#shapeModal').classList.add('hidden');
    $('#shApply').onclick = () => {
      const type = $('#shType').value;
      if (type === 'polygon' && !(Model.S.board.shape && Model.S.board.shape.pts)) { $('#shDraw').click(); return; }
      try {
        const r = Model.mutate(() => Pcb.setBoardShape({ shape: type, width: +$('#shW').value, height: +$('#shH').value, corner_radius: +$('#shR').value, points: Model.S.board.shape && Model.S.board.shape.pts }));
        $('#shapeModal').classList.add('hidden'); showView('pcb'); Pcb.fit();
        toast(r.outside.length ? `⚠ Outside the outline: ${r.outside.join(', ')} — Generate PCB or move them` : 'Board outline updated');
      } catch (e) { toast(e.message); }
    };
    $('#shDraw').onclick = () => { $('#shapeModal').classList.add('hidden'); showView('pcb'); PcbView.drawOutline(+$('#shR').value); };
    initGerberCheck();
    $('#routeCancel').onclick = () => {
      if (!worker) return;
      worker.terminate(); worker = null; $('#routeBusy').classList.add('hidden');
      if (routeBest) {   // stop = keep the best routing found so far
        const b = routeBest; routeBest = null;
        Model.mutate(() => {
          if (b.positions) for (const [ref, pcb] of b.positions) { const c = Model.comp(ref); if (c) c.pcb = pcb; }
          if (b.board) Model.S.board = b.board;
          Model.S.pcb = b.pcb;
        });
        Pcb.ui.drc = null;
        toast(`Stopped — kept the best result so far (${b.unrouted ? b.unrouted + ' nets unrouted' : 'all nets routed'})`, 5000);
        if (routeResolve) routeResolve({ routing: { stopped: true, unrouted: b.unrouted } });
      } else if (routeReject) routeReject(new Error('Routing cancelled'));
    };
    initRules();
    $('#btnUnroute').onclick = () => Model.mutate(() => { Model.S.pcb = { traces: [], vias: [], routed: {} }; });
    const setBoard = () => Model.mutate(() => { const w = +$('#boardW').value, h = +$('#boardH').value; if (w > 0 && h > 0) { Model.S.board = { w, h }; Model.S.pcb = { traces: [], vias: [], routed: {} }; } });
    $('#boardW').onchange = setBoard; $('#boardH').onchange = setBoard;
    $$('[data-layer]').forEach(cb => cb.onchange = () => { Pcb.ui.show[cb.dataset.layer] = cb.checked; Pcb.render(); });
    $('#btnGerber').onclick = () => exportAs('gerber');

    $('#btnUndo').onclick = () => Model.undo(); $('#btnRedo').onclick = () => Model.redo();
    $('#btnProjects').onclick = () => Projects.show();
    $('#btnNew').onclick = () => {
      if (!Projects.online) { if (confirm('Start a new empty design? (You can undo.)')) { Model.mutate(() => Model.clear()); Sch.select(null); } return; }
      const n = prompt('New project name', 'New project'); if (n !== null) Projects.create(n.trim() || 'Untitled');
    };
    $('#btnSave').onclick = async () => {
      if (!Projects.online) { exportAs('json'); return; }
      toast((await Projects.saveNow()) ? 'Project saved' : 'Save failed — see the status next to the name');
    };
    $('#btnSaveAs').onclick = async () => {
      if (!Projects.online) { exportAs('json'); return; }
      const n = prompt('Save project as', (Model.S.name || 'Untitled') + ' (copy)'); if (n === null) return;
      try { await Projects.saveAs(n.trim() || 'Untitled'); } catch (e) { toast('Save as failed: ' + e.message); }
    };
    $('#btnNewPart').onclick = () => PartEditor.open(PartEditor.blankDef(), { isNew: true, saveLib: true, allowPlace: true });
    $('#fileIn').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const d = JSON.parse(await f.text()), name = f.name.replace(/\.circuit\.json$|\.json$/i, '');
        const ee = EasyEDA.isEasyEDA(d);
        if (ee === 'schematic') throw new Error('this is an EasyEDA schematic — export the PCB document from EasyEDA (File → Export → EasyEDA Source) and import that');
        if (ee) {   // EasyEDA PCB → new project with parts, footprints, nets, tracks and a generated schematic
          const nd = Model.blank(); nd.name = name; Model.load(nd);
          const r = Model.mutate(() => EasyEDA.importPcb(d));
          Projects.markLoaded(); await Projects.saveNow(); Projects.close(); showView('pcb'); Pcb.fit();
          toast(`Imported EasyEDA PCB: ${r.components} parts, ${r.nets} nets, ${r.tracks} tracks, ${r.vias} vias${r.notes.length ? ' — ' + r.notes.join('; ') : ''}`, 9000);
          e.target.value = ''; return;
        }
        delete d.id; if (!d.name) d.name = name;
        Model.load(d); Projects.markLoaded(); await Projects.saveNow(); Projects.close(); Sch.fit(); toast('Imported ' + f.name + ' as a new project');
      } catch (err) { toast('Could not open: ' + err.message); }
      e.target.value = '';
    };
    $('#projName').onchange = e => Model.mutate(() => { Model.S.name = e.target.value.trim() || 'Untitled'; });
    $$('[data-exp]').forEach(b => b.onclick = () => exportAs(b.dataset.exp));

    // copilot
    $$('#modeSeg button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
    $('#modelSel').onchange = e => AI.saveSettings({ model: e.target.value });
    $('#btnSend').onclick = () => running ? AI.stop() : send();
    $('#prompt').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
    $('#btnNewChat').onclick = () => { if (running) return; AI.reset(); lastError = null; renderChat(); };
    // attachments: 📎 button, paste, drag & drop
    $('#btnAttach').onclick = () => $('#chatFiles').click();
    $('#chatFiles').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
    $('#attachList').onclick = e => { const x = e.target.closest('.x'); if (x) { pendingFiles.splice(+x.dataset.i, 1); renderAttach(); } };
    $('#prompt').addEventListener('paste', e => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); addFiles(fs); } });
    const ci = $('.cp-input');
    ci.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); ci.classList.add('drop'); } });
    ci.addEventListener('dragleave', () => ci.classList.remove('drop'));
    ci.addEventListener('drop', e => { ci.classList.remove('drop'); if (e.dataTransfer.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } });
    $('#btnWeb').onclick = () => { AI.saveSettings({ webAccess: AI.settings.webAccess === false }); updateCtx(); toast(AI.settings.webAccess ? '🌐 Web search on' : 'Web search off'); };
    $('#btnFolder').onclick = () => $('#btnKnow').click();
    $('#autoCompress').onchange = e => { AI.saveSettings({ autoCompress: e.target.checked }); updateCtx(); };
    $('#btnCompress').onclick = async () => {
      if (running) return;
      running = true; setRunning(true); infoMsg = 'Compressing the conversation…'; lastError = null; renderChat();
      try { toast((await AI.compress()) ? 'Conversation compressed' : 'Nothing to compress yet'); }
      catch (e) { lastError = 'Compress failed: ' + (e.name === 'AbortError' ? 'stopped' : e.message); }
      running = false; infoMsg = null; setRunning(false); renderChat();
    };
    $('#modelSel').addEventListener('change', () => AI.probeContext().then(updateCtx));
    Model.subscribe(k => { if (k !== 'move') updateCtx(); });
    $('#chat').onclick = e => {
      const s = e.target.closest('.sugg'); if (s) { send(s.textContent); return; }
      const im = e.target.closest('img.thumb'); if (im) { im.classList.toggle('big'); return; }
      if (e.target.closest('.exec')) { setMode('agent'); send('Execute the plan above step by step.'); return; }
      const r = e.target.closest('.restore');
      if (r) { const m = AI.history[+r.dataset.i]; if (m && m.checkpoint && confirm('Restore the design to the checkpoint taken before this message? (Undo is available.)')) { Model.load(m.checkpoint, true); Sch.fit(); toast('Checkpoint restored'); } }
    };

    // settings
    $('#btnSettings').onclick = openSettings;
    $('#sCancel').onclick = () => $('#modal').classList.add('hidden');
    $('#sSave').onclick = saveSettings;
    $('#presets').onclick = e => { const b = e.target.closest('button'); if (b) { $('#sBase').value = b.dataset.u; fetchModelsUI(); } };
    $('#sFetch').onclick = fetchModelsUI;
    let ft; $('#sBase').oninput = $('#sOKey').oninput = () => { clearTimeout(ft); ft = setTimeout(fetchModelsUI, 600); };
    autoFetchModels();
    if (!AI.settings.anthropicKey && !AI.settings.oaiModels) setTimeout(() => toast('Tip: add an API key in ⚙ Settings to enable the AI Copilot', 5000), 800);

    document.addEventListener('keydown', e => {
      if (!$('#edModal').classList.contains('hidden')) { if (PartEditor.key(e)) e.preventDefault(); return; }
      if (!$('#projModal').classList.contains('hidden')) { if (e.key === 'Escape') Projects.close(); return; }
      if (!$('#knowModal').classList.contains('hidden')) { if (e.key === 'Escape') $('#knowModal').classList.add('hidden'); return; }
      for (const id of ['#gerberModal', '#shapeModal', '#rulesModal']) if (!$(id).classList.contains('hidden')) { if (e.key === 'Escape') $(id).classList.add('hidden'); return; }
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? Model.redo() : Model.undo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); Model.redo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); $('#btnSaveAs').click(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); $('#btnSave').click(); return; }
      if (view === 'enc') return;
      if (e.key === 'f' || e.key === 'F') { view === 'sch' ? Sch.fit() : Pcb.fit(); return; }
      if ((view === 'sch' ? Sch : Pcb).key(e)) e.preventDefault();
    });
    $('#schSvg').oncontextmenu = $('#pcbSvg').oncontextmenu = e => e.preventDefault();
  }
  return { init, toast, showView, renderAll, placeLibPart, refreshParts: () => renderParts(), download };
})();
window.addEventListener('DOMContentLoaded', App.init);
