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
    $('#schSvg').classList.toggle('hidden', v !== 'sch'); $('#pcbSvg').classList.toggle('hidden', v !== 'pcb');
    $('#schTools').classList.toggle('hidden', v !== 'sch'); $('#pcbTools').classList.toggle('hidden', v !== 'pcb');
    renderAll();
    if (v === 'pcb') { Pcb.vp.apply(); if (!showView._pcbFit) { Pcb.fit(); showView._pcbFit = true; } } else Sch.vp.apply();
  }
  function renderAll() {
    if (view === 'sch') Sch.render(); else Pcb.render();
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
      return `<button class="part" data-type="${t}" title="Add ${esc(d.name)}"><svg viewBox="${b[0] - pad} ${b[1] - pad} ${b[2] - b[0] + 2 * pad} ${b[3] - b[1] + 2 * pad}"><g class="comp mini">${d.draw({ type: t })}</g></svg><span>${esc(d.name)}</span></button>`;
    }).join('')).join('') + renderMyLib(q) + renderDb();
  }

  // ---------- properties ----------
  function renderProps() {
    const el = $('#props');
    if (el.contains(document.activeElement) && document.activeElement.tagName !== 'BUTTON') return;
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

  // ---------- autorouter in a Web Worker ----------
  let worker = null, routeReject = null;
  function runRouter({ place = null, opt = {} } = {}) {
    if (worker) worker.terminate();
    return new Promise((resolve, reject) => {
      routeReject = reject;
      worker = new Worker('js/route-worker.js');
      $('#routeBusy').classList.remove('hidden'); $('#routeMsg').textContent = place ? 'Placing…' : 'Routing…';
      worker.onmessage = e => {
        const m = e.data;
        if (m.type === 'progress') { $('#routeMsg').textContent = `Routing ${m.net} (${m.done + 1}/${m.total})${m.attempt > 1 ? ' · pass ' + m.attempt : ''}`; return; }
        worker.terminate(); worker = null; $('#routeBusy').classList.add('hidden');
        if (m.type === 'error') { reject(new Error(m.message)); return; }
        Model.mutate(() => {
          const S = Model.S;
          for (const [ref, pcb] of m.positions) { const c = Model.comp(ref); if (c) c.pcb = pcb; }
          S.board = m.board; S.pcb = m.pcb;
        });
        Pcb.ui.drc = null;
        resolve({ placement: m.placement, routing: m.routing });
      };
      worker.onerror = e => { worker.terminate(); worker = null; $('#routeBusy').classList.add('hidden'); reject(new Error(e.message || 'Router crashed')); };
      worker.postMessage({ state: JSON.parse(Model.snapshot()), place, opt });
    });
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
      if (m.role === 'user') out.push(`<div class="msg user"><div class="bub">${esc(m.text).replace(/\n/g, '<br>')}</div><div class="meta">${m.mode ? `<span class="mtag ${m.mode}">${m.mode}</span>` : ''}${m.checkpoint ? `<button class="restore" data-i="${i}" title="Restore the design to how it was before this message">↺ restore checkpoint</button>` : ''}</div></div>`);
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
    if (running) out.push('<div class="msg ai"><div class="typing"><span></span><span></span><span></span></div></div>');
    if (lastError) out.push(`<div class="msg err">${esc(lastError)}</div>`);
    const chat = $('#chat'); chat.innerHTML = out.join(''); chat.scrollTop = chat.scrollHeight;
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
    text = (text ?? $('#prompt').value).trim();
    if (!text || running) return;
    $('#prompt').value = ''; lastError = null; running = true; setRunning(true);
    const checkpoint = mode === 'agent' ? Model.snapshot() : null;
    renderChat();
    await AI.run(text, mode, {
      checkpoint,
      onAssistant: () => renderChat(),
      onTool: () => renderChat(),
      onError: msg => { lastError = msg; }
    });
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
    $('#sMax').value = s.maxTokens; $('#sCtx').checked = !!s.includeContext;
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
    AI.saveSettings({ anthropicKey: $('#sAnth').value.trim(), oaiBase: $('#sBase').value.trim() || 'https://api.openai.com/v1', oaiKey: $('#sOKey').value.trim(), oaiModels: $('#sOModels').value, maxTokens: +$('#sMax').value || 8192, includeContext: $('#sCtx').checked });
    $('#modal').classList.add('hidden'); renderModels(); toast('Settings saved (stored only in this browser)');
  }

  // ---------- exports ----------
  function exportAs(kind) {
    const S = Model.S;
    try {
      if (kind === 'json') download(fname('.circuit.json'), JSON.stringify(S, null, 1), 'application/json');
      if (kind === 'gerber') { download(fname('-gerbers.zip'), makeZip(Pcb.gerbers())); toast('Gerbers + drill exported — upload the zip to your PCB fab'); }
      if (kind === 'svg') download(fname('-schematic.svg'), Sch.exportSVG(), 'image/svg+xml');
      if (kind === 'pcbsvg') { if (!S.board.w) throw new Error('No PCB yet'); if (view !== 'pcb') Pcb.render(); download(fname('-pcb.svg'), Pcb.exportSVG(), 'image/svg+xml'); }
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
    Sch.init($('#schSvg')); Pcb.init($('#pcbSvg'));
    Sch.ui.onSelect = () => renderProps(); Pcb.ui.onSelect = () => renderProps();
    let saved = null; try { saved = localStorage.getItem('cp.design'); } catch (e) { }
    if (saved) try { Model.load(saved); } catch (e) { }
    Model.subscribe(kind => { if (kind !== 'move') Pcb.ui.drc = null; if (kind === 'move') { view === 'sch' ? Sch.render() : Pcb.render(); } else renderAll(); });
    PartEditor.init();
    Engine.env.myLib = () => Projects.myLib;
    Engine.env.savePart = def => Projects.savePart(def).then(() => renderParts());
    Engine.env.route = runRouter;
    Engine.env.ui = what => { if (what === 'fit-sch') Sch.fit(); if (what === 'show-pcb') { showView('pcb'); Pcb.fit(); } };
    initKnowledge();
    Projects.init().then(renderParts);

    renderParts(); renderModels(); setMode('agent'); renderChat(); renderAll();
    requestAnimationFrame(() => Sch.fit());

    $('#partSearch').oninput = () => { renderParts(); searchDb($('#partSearch').value); };
    $('#partSearch').onkeydown = e => { if (e.key === 'Enter') { clearTimeout(dbTimer); searchDb($('#partSearch').value); } };
    $('#partList').onclick = e => {
      const ed = e.target.closest('[data-edit]'); if (ed) { const m = Projects.myLib.find(p => p.key === ed.dataset.edit); if (m) PartEditor.open(m, { key: m.key, saveLib: true, allowPlace: true }); return; }
      const dl = e.target.closest('[data-del]'); if (dl) { if (confirm('Remove this part from My Library? (Designs that use it keep their copy.)')) Projects.deletePart(dl.dataset.del).then(renderParts).catch(err => toast(err.message)); return; }
      const ml = e.target.closest('.mylib'); if (ml) { placeLibPart(ml.dataset.key); return; }
      const d = e.target.closest('.dbpart'); if (d) { placeDbPart(d.dataset.lcsc); return; }
      const b = e.target.closest('.part'); if (b) { if (view !== 'sch') showView('sch'); Sch.placeNew(b.dataset.type); }
    };
    $$('.tab').forEach(b => b.onclick = () => showView(b.dataset.view));
    $('#btnLayout').onclick = () => { Model.mutate(() => Model.autoLayout()); Sch.fit(); };
    $('#btnFitS').onclick = () => Sch.fit(); $('#btnFitP').onclick = () => Pcb.fit();
    $('#connStyle').value = Model.S.connStyle || 'auto';
    $('#connStyle').onchange = e => Model.mutate(() => { Model.S.connStyle = e.target.value; });
    $('#btnErc').onclick = () => { renderStatus(); $('#ercLink').click(); };
    const routeMsg = r => r && r.routing ? `Routed ${r.routing.routed}/${r.routing.total} nets${r.routing.failed.length ? ' — unrouted: ' + r.routing.failed.join(', ') : ''}${r.routing.necked_down && r.routing.necked_down.length ? ' · necked down: ' + r.routing.necked_down.join(', ') : ''}` : 'Placed — press Route';
    const runPcb = async (place, noRoute) => { try { const r = await runRouter({ place, opt: { noRoute } }); Pcb.fit(); toast(routeMsg(r), 6000); if (!noRoute) showDrc(); } catch (e) { toast(e.message); } };
    const boardWH = () => ({ w: +$('#boardW').value || 0, h: +$('#boardH').value || 0 });
    $('#btnGen').onclick = () => runPcb(boardWH(), false);
    $('#btnPlace').onclick = () => runPcb(boardWH(), true);
    $('#btnRoute').onclick = () => runPcb(null, false);
    $('#btnRules').onclick = openRules; $('#btnDrc').onclick = () => showDrc(true);
    $('#routeCancel').onclick = () => { if (worker) { worker.terminate(); worker = null; $('#routeBusy').classList.add('hidden'); if (routeReject) routeReject(new Error('Routing cancelled')); } };
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
    $('#btnNewPart').onclick = () => PartEditor.open(PartEditor.blankDef(), { isNew: true, saveLib: true, allowPlace: true });
    $('#fileIn').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const d = JSON.parse(await f.text()); delete d.id; if (!d.name) d.name = f.name.replace(/\.circuit\.json$|\.json$/i, '');
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
    $('#chat').onclick = e => {
      const s = e.target.closest('.sugg'); if (s) { send(s.textContent); return; }
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
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? Model.redo() : Model.undo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); Model.redo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); $('#btnSave').click(); return; }
      if (e.key === 'f' || e.key === 'F') { view === 'sch' ? Sch.fit() : Pcb.fit(); return; }
      if ((view === 'sch' ? Sch : Pcb).key(e)) e.preventDefault();
    });
    $('#schSvg').oncontextmenu = $('#pcbSvg').oncontextmenu = e => e.preventDefault();
  }
  return { init, toast, showView, renderAll, placeLibPart, refreshParts: () => renderParts() };
})();
window.addEventListener('DOMContentLoaded', App.init);
