'use strict';
// Design tool engine shared by the in-app AI copilot, the MCP server (Claude Code) and the REST API.
// Runs in the browser and in Node (see mcp/circuitpilot-mcp.mjs). UI side effects go through Engine.env hooks.
const Engine = (() => {
  const env = {
    base: '',                  // API base URL ('' = same origin)
    headers: {},               // e.g. { authorization: 'Bearer <password>' } for external clients
    fetch: (...a) => fetch(...a),
    myLib: () => [],           // user's saved parts
    savePart: async () => { }, // persist a part to My Library
    ui: () => { },             // ui('fit-sch') | ui('show-pcb')
    route: null,               // optional async router (browser: Web Worker): ({ place, opt }) => { placement, routing }
  };

  async function api(path, opts = {}) {
    const r = await env.fetch(env.base + path, Object.assign({}, opts, { headers: Object.assign({}, env.headers, opts.headers || {}) }));
    const j = await r.json().catch(() => ({ error: `Server returned ${r.status} — is server.py running?` }));
    if (!r.ok || (j && j.error && !j.results)) throw new Error((j && j.error) || r.statusText);
    return j;
  }
  const partsApi = path => api('/api/parts/' + path);

  // ---------- tool definitions ----------
  const types = Lib.types();
  const pinList = { type: 'array', items: { type: 'string' }, description: 'Pin references "REF.PIN" — PIN is a pin number or pin name, e.g. "R1.1", "Q1.B", "U1.VCC"' };
  const pinDefs = { type: 'array', items: { type: 'object', required: ['num', 'name'], properties: { num: { type: 'string' }, name: { type: 'string' }, side: { type: 'string', enum: ['L', 'R', 'T', 'B'], description: 'Symbol side (default alternates L/R)' } } } };
  const fpSpec = { description: 'Footprint: a generator name (' + Lib.FOOTPRINT_PATTERNS.join(', ') + ') or {"pads":[{"num","x","y","w","h","shape":"rect|round|oval","drill"?}]} in mm, centred on the part.', anyOf: [{ type: 'string' }, { type: 'object', properties: { name: { type: 'string' }, pads: { type: 'array', items: { type: 'object' } } } }] };
  const TOOLS = [
    { name: 'search_parts', ro: true, description: 'Search the JLCPCB/LCSC component database (600k+ real parts with stock and price) by part number or keywords, e.g. "ESP32-C3", "AMS1117 3.3", "USB-C 16pin", "10k 0603". Also searches My Library. Returns LCSC codes (Cxxxx) / library keys. Prefer in-stock and Basic parts.', input_schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'number', description: 'default 10, max 30' } } } },
    { name: 'get_part', ro: true, description: 'Load a database part (LCSC code) or a My Library part (key): returns its exact pin list (number:name) and PCB footprint. Call before adding it with add_components {lcsc}.', input_schema: { type: 'object', required: ['lcsc'], properties: { lcsc: { type: 'string', description: 'LCSC code (e.g. C2838502) or library key (LIB_...)' } } } },
    { name: 'get_design', ro: true, description: 'Return the full current design: every component (type, value, position, footprint, pins as num:name=net) and all nets.', input_schema: { type: 'object', properties: {} } },
    { name: 'list_parts', ro: true, description: 'List the built-in component types with their pins (number:name), default value and footprints.', input_schema: { type: 'object', properties: {} } },
    {
      name: 'add_components', description: 'Add one or more components to the schematic. Returns the assigned refs. Overlapping placements are nudged automatically.',
      input_schema: {
        type: 'object', required: ['components'], properties: {
          components: {
            type: 'array', items: {
              type: 'object', properties: {
                type: { type: 'string', enum: types, description: 'Built-in type. Omit when using lcsc.' },
                lcsc: { type: 'string', description: 'LCSC code of a database part, or key of a My Library / custom part. Gives the real pinout and footprint.' },
                ref: { type: 'string', description: 'Optional reference designator, e.g. R1. Auto-assigned if omitted.' },
                value: { type: 'string', description: 'Part value or part number, e.g. 10k, 100n, NE555' },
                x: { type: 'number', description: 'Schematic X (grid 10). Typical spacing between parts 80-160.' },
                y: { type: 'number', description: 'Schematic Y (down is positive).' },
                rot: { type: 'number', enum: [0, 90, 180, 270] },
                pins: { type: 'array', items: { type: 'string' }, description: 'ONLY for type "ic" or "connector": pin names in pin-number order (index 0 = pin 1).' },
                footprint: { type: 'string', description: 'Optional footprint: ' + Lib.FOOTPRINT_PATTERNS.join(', ') }
              }
            }
          }
        }
      }
    },
    { name: 'update_component', description: 'Change a component in the SCHEMATIC: value, schematic position/rotation, footprint, pins (ic/connector) or rename it. For PCB placement use place_footprint.', input_schema: { type: 'object', required: ['ref'], properties: { ref: { type: 'string' }, value: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, rot: { type: 'number', enum: [0, 90, 180, 270] }, footprint: { type: 'string' }, pins: { type: 'array', items: { type: 'string' } }, new_ref: { type: 'string' } } } },
    { name: 'remove_components', description: 'Delete components (and their connections).', input_schema: { type: 'object', required: ['refs'], properties: { refs: { type: 'array', items: { type: 'string' } } } } },
    { name: 'connect', description: 'Create connections. Each entry puts the listed pins on the named net (created if needed). If a pin is already on another net, that net is merged in. Name ground "GND" and supply rails like "VCC", "+5V", "+3V3", "+12V", "VBAT" — these are drawn as power symbols.', input_schema: { type: 'object', required: ['connections'], properties: { connections: { type: 'array', items: { type: 'object', required: ['net', 'pins'], properties: { net: { type: 'string' }, pins: pinList } } } } } },
    { name: 'disconnect', description: 'Remove pins from whatever net they are on.', input_schema: { type: 'object', required: ['pins'], properties: { pins: pinList } } },
    { name: 'rename_net', description: 'Rename a net (merges if the new name exists).', input_schema: { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string' }, to: { type: 'string' } } } },
    { name: 'auto_layout', description: 'Automatically arrange all schematic components based on connectivity.', input_schema: { type: 'object', properties: {} } },
    { name: 'run_erc', ro: true, description: 'Run the electrical rule check: unconnected pins, single-pin nets, missing ground, overlapping symbols.', input_schema: { type: 'object', properties: {} } },
    { name: 'clear_design', description: 'Delete everything in the current project and start an empty design.', input_schema: { type: 'object', properties: {} } },
    { name: 'generate_pcb', description: 'Create the PCB: place all footprints on a board (based on schematic positions) and autoroute with a 2-layer router. Returns routing statistics.', input_schema: { type: 'object', properties: { board_width: { type: 'number', description: 'mm, optional (auto-sized if omitted)' }, board_height: { type: 'number', description: 'mm, optional' }, route: { type: 'boolean', description: 'default true' } } } },
    { name: 'place_footprint', description: 'Move / rotate a footprint on the PCB, or put it on a board edge. edge = left | right | top | bottom puts connectors on that edge (USB / jacks / RF / SD: opening facing outward, flush with the edge; headers just inside) and is remembered for future generate_pcb runs. generate_pcb already puts connectors on the nearest edge automatically. Re-run route_pcb afterwards.', input_schema: { type: 'object', required: ['ref'], properties: { ref: { type: 'string' }, edge: { type: 'string', enum: ['left', 'right', 'top', 'bottom'] }, along: { type: 'number', description: 'mm along the edge (optional, with edge)' }, x: { type: 'number', description: 'mm' }, y: { type: 'number', description: 'mm' }, rot: { type: 'number', enum: [0, 90, 180, 270] } } } },
    { name: 'route_pcb', description: 'Re-run the autorouter on the current placement (follows the design rules).', input_schema: { type: 'object', properties: {} } },
    { name: 'get_design_rules', ro: true, description: 'Current PCB design rules (trace widths, clearance, vias, edge clearance, layers, per-net widths) and the fab minimums they are checked against. Defaults follow JLCPCB 2-layer capabilities. Lists available presets.', input_schema: { type: 'object', properties: {} } },
    { name: 'set_design_rules', description: 'Change PCB design rules (mm). The autorouter follows them and DRC checks them. Use preset to load a profile, net_widths for per-net trace widths (0 removes an override). Returns warnings for values below the fab minimums.', input_schema: { type: 'object', properties: { preset: { type: 'string', description: 'jlcpcb | jlcpcb_min | jlcpcb_power | home' }, traceWidth: { type: 'number' }, powerTraceWidth: { type: 'number', description: 'Width for power/ground nets' }, clearance: { type: 'number' }, viaDiameter: { type: 'number' }, viaDrill: { type: 'number' }, edgeClearance: { type: 'number' }, layers: { type: 'number', enum: [1, 2] }, neckDown: { type: 'boolean', description: 'Allow narrowing a trace when the full width does not fit' }, net_widths: { type: 'object', additionalProperties: { type: 'number' }, description: 'e.g. {"+5V": 0.8, "MOTOR": 1.2}' } } } },
    { name: 'run_drc', ro: true, description: 'Design rule check of the PCB with exact geometry: clearances/shorts, trace widths, via size/annular ring, hole spacing, board-edge clearance and unrouted nets.', input_schema: { type: 'object', properties: {} } },
    { name: 'pcb_status', ro: true, description: 'Board size, number of placed parts, routed / unrouted nets, via count, trace length.', input_schema: { type: 'object', properties: {} } },
    { name: 'create_part', description: 'Create a NEW custom part (symbol pins + PCB footprint) when nothing suitable exists in the database. Saved to the design and to My Library; returns its key for add_components {lcsc: key}.', input_schema: { type: 'object', required: ['name', 'pins', 'footprint'], properties: { name: { type: 'string' }, prefix: { type: 'string', description: 'Reference prefix, default U' }, value: { type: 'string' }, pins: pinDefs, footprint: fpSpec, save_to_library: { type: 'boolean', description: 'default true' } } } },
    { name: 'update_part', description: 'Modify an existing part definition used in the design (database or custom): pins, footprint, name, prefix, value. All placed instances follow.', input_schema: { type: 'object', required: ['key'], properties: { key: { type: 'string', description: 'LCSC code or library key' }, name: { type: 'string' }, prefix: { type: 'string' }, value: { type: 'string' }, pins: pinDefs, footprint: fpSpec, save_to_library: { type: 'boolean', description: 'default true' } } } },
    { name: 'list_my_parts', ro: true, description: 'List the parts in My Library (custom and edited parts).', input_schema: { type: 'object', properties: {} } },
    { name: 'knowledge_list', ro: true, description: "List the documents in this project's knowledge folder (design notes, guides, datasheets, requirements).", input_schema: { type: 'object', properties: {} } },
    { name: 'knowledge_read', ro: true, description: 'Read a document from the project knowledge folder (paged; use offset for long files).', input_schema: { type: 'object', required: ['file'], properties: { file: { type: 'string' }, offset: { type: 'number' } } } },
    { name: 'knowledge_search', ro: true, description: 'Full-text search across the project knowledge folder; returns matching snippets with file and offset.', input_schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'number' } } } },
    { name: 'set_knowledge_folder', description: 'Point this project at a knowledge folder (absolute path on the server PC) containing docs and guides to follow during design. Empty string clears it.', input_schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } },
  ];

  // ---------- parts ----------
  const partCache = {};
  async function loadPart(code) {
    const raw = String(code || '').trim(), up = raw.toUpperCase();
    for (const k of [raw, up]) if (Model.S.lib[k]) return Model.S.lib[k];
    const mine = env.myLib().find(p => p.key === raw || p.key === up);
    if (mine) return mine;
    if (!/^C\d+$/.test(up)) throw new Error(`Unknown part "${raw}" — use an LCSC code (C1234) or a My Library key`);
    if (!partCache[up]) partCache[up] = await partsApi('get/' + encodeURIComponent(up));
    return partCache[up];
  }
  const keyOf = m => m.key || m.lcsc;
  function partSummary(m) {
    return {
      key: keyOf(m), name: m.name, manufacturer: m.manufacturer, mfr_part: m.mfr_part, package: m.package, ref_prefix: m.prefix,
      pins: (m.pins || []).map(p => p.num + ':' + p.name).join(' '),
      footprint: m.footprint ? `${m.footprint.name} (${m.footprint.pads.length} pads)` : 'none', datasheet: m.datasheet || undefined
    };
  }
  function partsInfo() {
    return Lib.types().map(t => {
      const d = Lib.type(t), c = { type: t, pins: null };
      const pins = d.generic ? '(custom pin list via "pins")' : d.pins(c).map(p => p.num + ':' + p.name).join(' ');
      return `${t} [${d.prefix}] default=${d.value} pins: ${pins} footprints: ${d.generic ? (t === 'ic' ? 'SOIC-<n> | DIP-<n>' : 'PinHeader_1x<n>') : d.fps.join(' | ')}`;
    }).join('\n');
  }
  function buildFootprint(spec) {
    if (!spec) return { name: 'none', pads: [], body: null };
    if (typeof spec === 'string') {
      const fp = Lib.footprint(spec); if (!fp) throw new Error(`Unknown footprint "${spec}". Known: ${Lib.FOOTPRINT_PATTERNS.join(', ')}`);
      return { name: spec, pads: JSON.parse(JSON.stringify(fp.pads)), body: fp.body || null };
    }
    const pads = (spec.pads || []).map((p, i) => {
      const w = +p.w || +p.size || 1, h = +p.h || +p.size || w;
      const o = { num: String(p.num ?? i + 1), x: +p.x || 0, y: +p.y || 0, w, h, shape: ['rect', 'round', 'oval'].includes(p.shape) ? p.shape : 'rect' };
      if (+p.drill > 0) o.drill = +p.drill;
      return o;
    });
    if (!pads.length) throw new Error('footprint.pads is empty');
    let b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of pads) b = [Math.min(b[0], p.x - p.w / 2), Math.min(b[1], p.y - p.h / 2), Math.max(b[2], p.x + p.w / 2), Math.max(b[3], p.y + p.h / 2)];
    return { name: spec.name || 'custom', pads, body: b };
  }
  const normPins = pins => (pins || []).map((p, i) => ({ num: String(p.num ?? i + 1), name: String(p.name ?? p.num ?? i + 1), side: ['L', 'R', 'T', 'B'].includes(p.side) ? p.side : (i % 2 ? 'R' : 'L') }));
  const newKey = name => 'LIB_' + (String(name || 'PART').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'PART') + '_' + Math.random().toString(36).slice(2, 6).toUpperCase();
  function withBody(fp) {
    if (!fp.pads.length) return fp;
    let b = fp.body ? fp.body.slice() : [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of fp.pads) b = [Math.min(b[0], p.x - p.w / 2), Math.min(b[1], p.y - p.h / 2), Math.max(b[2], p.x + p.w / 2), Math.max(b[3], p.y + p.h / 2)];
    return Object.assign({}, fp, { body: b });
  }

  // ---------- knowledge folder ----------
  const kPath = () => { const p = Model.S.knowledge && Model.S.knowledge.path; if (!p) throw new Error('No knowledge folder set for this project (use set_knowledge_folder or the 📚 button)'); return p; };
  const kApi = (op, q) => api('/api/knowledge/' + op + '?' + new URLSearchParams(Object.assign({ path: kPath() }, q)).toString());

  // ---------- executor ----------
  async function exec(name, input, mode = 'agent') {
    const t = TOOLS.find(t => t.name === name);
    if (!t) throw new Error('Unknown tool ' + name);
    if (mode !== 'agent' && !t.ro) throw new Error(`"${name}" modifies the design and is not allowed in ${mode} mode`);
    input = input || {};
    switch (name) {
      case 'search_parts': {
        const q = String(input.query || '').toLowerCase();
        const mine = env.myLib().filter(p => q.split(/\s+/).every(w => `${p.name} ${p.value} ${p.key} ${p.mfr_part || ''}`.toLowerCase().includes(w))).slice(0, 5)
          .map(p => ({ lcsc: p.key, part: p.name, package: p.footprint && p.footprint.name, source: 'my-library' }));
        let j = { results: [], source: 'none' };
        try { j = await partsApi('search?q=' + encodeURIComponent(input.query || '') + '&limit=' + Math.min(30, +input.limit || 10)); }
        catch (e) { if (!mine.length) throw e; }
        const db = j.results.slice().sort((a, b) => (b.stock > 0) - (a.stock > 0)).map(r => ({ lcsc: r.lcsc, part: r.mfr_part, brand: r.brand, package: r.package, stock: r.stock, basic: !!r.basic, price_usd: r.price, desc: (r.description || '').slice(0, 140) }));
        if (!mine.length && !db.length) return `No parts found for "${input.query}"` + (j.error ? ` (online search failed: ${j.error})` : '');
        return { source: j.source, results: [...mine, ...db] };
      }
      case 'get_part': return partSummary(await loadPart(input.lcsc || input.key));
      case 'get_design': return Model.summary();
      case 'list_parts': return partsInfo();
      case 'list_my_parts': return env.myLib().map(partSummary);
      case 'run_erc': { const r = Model.erc(); return r.length ? r : 'ERC passed: no issues'; }
      case 'pcb_status': return Pcb.status();
      case 'add_components': {
        const list = Array.isArray(input.components) ? input.components : [input];
        const libs = {};
        for (const s of list) if (s.lcsc || s.part) { const m = await loadPart(s.lcsc || s.part); libs[keyOf(m)] = m; s.part = keyOf(m); delete s.lcsc; }
        return Model.mutate(() => {
          for (const [k, m] of Object.entries(libs)) if (!Model.S.lib[k]) Model.setLibPart(k, m);
          return list.map(s => { const c = Model.addComponent(s); return { ref: c.ref, type: c.type, value: c.value, x: c.x, y: c.y, footprint: c.footprint, pins: Lib.type(c.type).pins(c).map(p => p.num + ':' + p.name).join(' ') }; });
        });
      }
      case 'update_component': return Model.mutate(() => { const c = Model.updateComponent(input); return { ok: true, ref: c.ref }; });
      case 'remove_components': return Model.mutate(() => { (input.refs || []).forEach(Model.removeComponent); return { ok: true }; });
      case 'connect': {
        const list = Array.isArray(input.connections) ? input.connections : [input];
        return Model.mutate(() => list.map(cn => ({ net: Model.connect(cn.net, cn.pins || []), pins: (cn.pins || []).length })));
      }
      case 'disconnect': return Model.mutate(() => { Model.disconnect(input.pins || []); return { ok: true }; });
      case 'rename_net': return Model.mutate(() => { Model.renameNet(input.from, input.to); return { ok: true }; });
      case 'auto_layout': Model.mutate(() => Model.autoLayout()); env.ui('fit-sch'); return { ok: true };
      case 'clear_design': Model.mutate(() => Model.clear()); return { ok: true };
      case 'generate_pcb': case 'route_pcb': {
        const place = name === 'generate_pcb' ? { w: input.board_width, h: input.board_height } : null, noRoute = input.route === false;
        let r;
        if (env.route) r = await env.route({ place, opt: { noRoute } });
        else r = Model.mutate(() => ({ placement: place ? Pcb.autoPlace(place) : undefined, routing: noRoute ? null : Pcb.route() }));
        env.ui('show-pcb');
        const d = Pcb.drc();
        return Object.assign({}, r, { drc: { summary: d.summary, top: d.violations.filter(v => v.severity === 'error').slice(0, 8).map(v => v.msg) } });
      }
      case 'place_footprint': { const r = Model.mutate(() => Pcb.placeFootprint(input.ref, input)); env.ui('show-pcb'); return Object.assign(r, { note: 'Tracks are kept; run route_pcb to connect anything left unrouted.' }); }
      case 'get_design_rules': {
        const R = Pcb.rules();
        return { rules: R, warnings: Pcb.ruleWarnings(R), presets: Object.fromEntries(Object.entries(Pcb.RULE_PRESETS).map(([k, v]) => [k, v.label])), note: 'JLCPCB defaults; check jlcpcb.com/capabilities for current limits' };
      }
      case 'set_design_rules': {
        const u = Object.assign({}, input); if (u.net_widths) { u.netWidths = u.net_widths; delete u.net_widths; }
        return Model.mutate(() => Pcb.setRules(u));
      }
      case 'run_drc': { const d = Pcb.drc(); return { summary: d.summary, errors: d.errors, warnings: d.warnings, violations: d.violations.slice(0, 60) }; }
      case 'create_part':
      case 'update_part': {
        const old = name === 'update_part' ? (Model.S.lib[input.key] || env.myLib().find(p => p.key === input.key)) : null;
        if (name === 'update_part' && !old) throw new Error(`No part "${input.key}" in this design or My Library`);
        const def = Object.assign({}, old || {}, {
          key: old ? old.key || input.key : newKey(input.name),
          name: input.name || (old && old.name) || 'Part',
          prefix: String(input.prefix || (old && old.prefix) || 'U').replace(/[^A-Za-z]/g, '') || 'U',
          value: input.value || (old && old.value) || input.name,
          pins: input.pins ? normPins(input.pins) : old.pins,
          footprint: input.footprint ? withBody(buildFootprint(input.footprint)) : old.footprint,
        });
        if (!old) def.custom = true;
        const dup = def.pins.map(p => p.num).find((n, i, a) => a.indexOf(n) !== i); if (dup) throw new Error(`Pin number ${dup} is used twice`);
        const used = Model.mutate(() => Model.setLibPart(def.key, def));
        let saved = false;
        if (input.save_to_library !== false) { try { await env.savePart(def); saved = true; } catch (e) { } }
        const padNums = new Set((def.footprint.pads || []).map(p => p.num));
        return { key: def.key, pins: def.pins.length, pads: def.footprint.pads.length, placed_instances_updated: used, saved_to_library: saved, pins_without_pad: def.pins.filter(p => !padNums.has(p.num)).map(p => p.num) };
      }
      case 'set_knowledge_folder': {
        const path = String(input.path || '').trim();
        if (path) { const j = await api('/api/knowledge/list?' + new URLSearchParams({ path })); Model.mutate(() => { Model.S.knowledge = { path: j.folder }; }); return { folder: j.folder, files: j.files.map(f => f.file) }; }
        Model.mutate(() => { delete Model.S.knowledge; }); return { ok: true, cleared: true };
      }
      case 'knowledge_list': { const j = await kApi('list'); return { folder: j.folder, files: j.files }; }
      case 'knowledge_read': return kApi('read', { file: input.file, offset: input.offset || 0 });
      case 'knowledge_search': return kApi('search', { q: input.query, limit: input.limit || 12 });
    }
  }

  // Knowledge digest for the AI system prompt (cached per folder).
  const digests = {};
  async function knowledgeDigest(force) {
    const p = Model.S.knowledge && Model.S.knowledge.path; if (!p) return null;
    if (!digests[p] || force) digests[p] = await api('/api/knowledge/digest?' + new URLSearchParams({ path: p, budget: 24000 }));
    return digests[p];
  }

  function designContext() {
    const S = Model.S;
    if (!S.components.length) return 'CURRENT DESIGN: empty.';
    const sum = Model.summary();
    let txt = 'CURRENT DESIGN:\n' + sum.components.map(c => `${c.ref} ${c.lcsc ? 'part ' + c.lcsc : c.type} "${c.value}" @(${c.x},${c.y}) rot${c.rot} fp=${c.footprint} | ${c.pins}`).join('\n');
    const st = Pcb.status();
    txt += `\nPCB: ${st.placed ? `board ${st.board.w}x${st.board.h}mm, ${st.routed}/${st.nets} nets routed` : 'not generated'}`;
    if (txt.length > 12000) txt = txt.slice(0, 12000) + '\n…(truncated — call get_design for the rest)';
    return txt;
  }

  return { env, TOOLS, exec, loadPart, partsApi, api, designContext, knowledgeDigest, newKey };
})();
if (typeof module !== 'undefined') module.exports = Engine;
