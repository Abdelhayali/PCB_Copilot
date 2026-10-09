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
    searchKey: null,           // optional Brave Search API key (else DuckDuckGo)
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
    { name: 'generate_pcb', description: 'Create the PCB: place all footprints on a board (based on schematic positions) and autoroute with a 2-layer router. Returns routing statistics.', input_schema: { type: 'object', properties: { board_width: { type: 'number', description: 'mm, optional (auto-sized if omitted)' }, board_height: { type: 'number', description: 'mm, optional' }, auto_size: { type: 'boolean', description: 'size the board to the parts; by default an existing board outline is kept and parts are fitted inside it' }, route: { type: 'boolean', description: 'default true' } } } },
    { name: 'web_search', ro: true, web: true, description: 'Search the internet (datasheets, application notes, reference designs, prices, availability, how-tos, anything else you need). Returns titles, URLs and snippets; read pages with web_fetch.', input_schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, max_results: { type: 'number', description: 'default 8, max 20' } } } },
    { name: 'web_fetch', ro: true, web: true, description: 'Read a web page or PDF (e.g. a datasheet) as text. Long documents are paged: call again with offset = previous offset + returned length while "more" is true.', input_schema: { type: 'object', required: ['url'], properties: { url: { type: 'string' }, offset: { type: 'number' }, max_chars: { type: 'number', description: 'default 12000, max 40000' } } } },
    { name: 'use_database_parts', description: 'Give built-in schematic symbols (resistor, LED, transistor, regulator, ...) the footprint and pinout of a real JLCPCB part (Basic parts where possible). Without refs: every built-in part that still uses a generated footprint.', input_schema: { type: 'object', properties: { refs: { type: 'array', items: { type: 'string' } } } } },
    { name: 'match_jlcpcb_parts', description: 'Find JLCPCB/LCSC part numbers for every component value (e.g. 4.7k 0603, 22uF 0805) for an assembly BOM; prefers in-stock Basic parts with the same package.', input_schema: { type: 'object', properties: { overwrite: { type: 'boolean' } } } },
    { name: 'get_enclosure', ro: true, description: 'The 3D-printable enclosure fitted to the PCB: outer size, heights, standoffs, every cutout (automatic ones for edge connectors / LEDs / buttons and custom ones), estimated part heights and all parameters.', input_schema: { type: 'object', properties: {} } },
    { name: 'set_enclosure', description: 'Change enclosure parameters (mm): wall, floor, lidThickness, clearance, pcbThickness, topClearance, extraHeight, standoffHeight, standoffDiameter, screwHole, lidFit, lipHeight, lipWidth, vents, ventWidth, ventLength, ventSpacing, autoConnectorCutouts, autoLidHoles, partHeights ({ref: mm}). Opens the Enclosure tab.', input_schema: { type: 'object', properties: { wall: { type: 'number' }, floor: { type: 'number' }, lidThickness: { type: 'number' }, clearance: { type: 'number' }, pcbThickness: { type: 'number' }, topClearance: { type: 'number' }, extraHeight: { type: 'number' }, standoffHeight: { type: 'number' }, standoffDiameter: { type: 'number' }, screwHole: { type: 'number' }, lidFit: { type: 'number' }, lipHeight: { type: 'number' }, lipWidth: { type: 'number' }, vents: { type: 'boolean' }, ventWidth: { type: 'number' }, ventLength: { type: 'number' }, ventSpacing: { type: 'number' }, autoConnectorCutouts: { type: 'boolean' }, autoLidHoles: { type: 'boolean' }, partHeights: { type: 'object', additionalProperties: { type: 'number' } } } } },
    { name: 'add_enclosure_cutout', description: 'Add an opening to the enclosure. side = left | right | front | back (walls; u = mm along the wall from its centre, z = mm above the bed, default 4 mm above the PCB) or lid | floor (x, y in enclosure coordinates = board x, minus board y). shape rect or circle.', input_schema: { type: 'object', required: ['side', 'width'], properties: { side: { type: 'string', enum: ['left', 'right', 'front', 'back', 'lid', 'floor'] }, shape: { type: 'string', enum: ['rect', 'circle'] }, width: { type: 'number' }, height: { type: 'number' }, u: { type: 'number' }, z: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' }, label: { type: 'string' } } } },
    { name: 'remove_enclosure_cutout', description: 'Remove a custom enclosure cutout by index (see get_enclosure), or all custom cutouts when index is omitted.', input_schema: { type: 'object', properties: { index: { type: 'number' } } } },
    { name: 'add_mounting_holes', description: 'Add non-plated mounting holes to the PCB (default 4 × M3 Ø3.2 mm at the corners, nudged clear of parts) — the enclosure then gets screw standoffs. Re-run route_pcb afterwards.', input_schema: { type: 'object', properties: { diameter: { type: 'number' }, inset: { type: 'number' }, points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'explicit [[x,y],...] in board mm' } } } },
    { name: 'get_pcb_layout', ro: true, description: 'PCB layout for reasoning about placement: board size/shape, every footprint (ref, x, y, rotation, side, bounding box, edge lock, nets), unrouted nets with the pads that still need connecting, copper pours.', input_schema: { type: 'object', properties: {} } },
    { name: 'optimize_pcb', description: 'Automatically move / rotate / swap parts (optionally enlarge the board or use the bottom side) and re-route until every net is connected, keeping the best result. Connectors on edges and locked parts stay put. Use when route_pcb leaves nets unrouted.', input_schema: { type: 'object', properties: { time_limit_s: { type: 'number', description: 'default 60' }, iterations: { type: 'number', description: 'default 12' }, allow_grow: { type: 'boolean', description: 'may enlarge the board (default false — the board size is kept)' }, allow_bottom: { type: 'boolean', description: 'may move parts to the bottom side (default false)' } } } },
    { name: 'add_copper_pour', description: 'Add a copper pour (copper area) for a net, usually GND, on top, bottom or both layers. Without points it covers the whole board and follows the outline. Other nets keep their clearance; same-net pads connect to it.', input_schema: { type: 'object', properties: { net: { type: 'string', description: 'default GND' }, layer: { type: 'string', enum: ['top', 'bottom', 'both'] }, points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'optional polygon [[x,y],...] in mm' }, clearance: { type: 'number' } } } },
    { name: 'remove_copper_pour', description: 'Remove copper pours (all, or by index / net).', input_schema: { type: 'object', properties: { index: { type: 'number' }, net: { type: 'string' } } } },
    { name: 'set_board_shape', description: 'Board outline: rect, rounded (corner_radius), ellipse (a circle when width = height) or polygon (points [[x,y],...] in mm, corner_radius rounds every corner).', input_schema: { type: 'object', required: ['shape'], properties: { shape: { type: 'string', enum: ['rect', 'rounded', 'ellipse', 'polygon'] }, width: { type: 'number' }, height: { type: 'number' }, corner_radius: { type: 'number' }, points: { type: 'array', items: { type: 'array', items: { type: 'number' } } } } } },
    { name: 'place_footprint', description: 'Move / rotate a footprint on the PCB, flip it to the bottom side (side = bottom), or put it on a board edge. edge = left | right | top | bottom puts connectors on that edge (USB / jacks / RF / SD: opening facing outward, flush with the edge; headers just inside) and is remembered for future generate_pcb runs. generate_pcb already puts connectors on the nearest edge automatically. Re-run route_pcb afterwards.', input_schema: { type: 'object', required: ['ref'], properties: { ref: { type: 'string' }, side: { type: 'string', enum: ['top', 'bottom'], description: 'board side; bottom mirrors the part and puts its SMD pads on BottomLayer' }, lock: { type: 'boolean', description: 'keep optimize_pcb from moving it' }, edge: { type: 'string', enum: ['left', 'right', 'top', 'bottom'] }, along: { type: 'number', description: 'mm along the edge (optional, with edge)' }, x: { type: 'number', description: 'mm' }, y: { type: 'number', description: 'mm' }, rot: { type: 'number', enum: [0, 90, 180, 270] } } } },
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
        // built-in symbols get the real JLCPCB part behind them (unless a footprint was given)
        for (const s of list) if (s.type && !s.lcsc && !s.part && !s.footprint && Lib.dbDefault(s.type, s.value)) {
          try { s.dbPart = await loadPart(Lib.dbDefault(s.type, s.value).lcsc); } catch (e) { /* database unavailable → generated footprint */ }
        }
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
      case 'web_search': return api('/api/web/search?' + new URLSearchParams({ q: input.query || '', n: input.max_results || 8 }), { headers: env.searchKey && env.searchKey() ? { 'X-Brave-Key': env.searchKey() } : {} });
      case 'web_fetch': { const r = await api('/api/web/fetch?' + new URLSearchParams({ url: input.url || '', offset: input.offset || 0, length: input.max_chars || 12000 })); return r; }
      case 'use_database_parts': return useDatabaseParts(input.refs);
      case 'match_jlcpcb_parts': return matchJlcpcb(!!input.overwrite);
      case 'get_enclosure': { const d = Enclosure.describe(); env.ui('show-enc'); return d; }
      case 'set_enclosure': { const r = Model.mutate(() => Enclosure.setParams(input)); env.ui('show-enc'); return { outer_mm: r.outer_mm, base_height: r.base_height, cutouts: r.cutouts.length, params: r.params }; }
      case 'add_enclosure_cutout': { const r = Model.mutate(() => Enclosure.addCutout(input)); env.ui('show-enc'); return r; }
      case 'remove_enclosure_cutout': return Model.mutate(() => { const E = Object.assign({}, Model.S.enclosure || {}), c = (E.cutouts || []).slice(); const n = c.length; if (input.index != null) c.splice(+input.index, 1); else c.length = 0; E.cutouts = c; Model.S.enclosure = E; env.ui('show-enc'); return { removed: n - c.length }; });
      case 'add_mounting_holes': { const r = Model.mutate(() => Pcb.addMountingHoles(input)); return r; }
      case 'get_pcb_layout': {
        const S = Model.S, idx = Model.pinIndex(), conn = Pcb.connectivity();
        return {
          board: { w: S.board.w, h: S.board.h, shape: (S.board.shape || { type: 'rect' }).type },
          footprints: Pcb.placed().map(c => ({ ref: c.ref, value: c.value, x: c.pcb.x, y: c.pcb.y, rot: c.pcb.rot || 0, side: Pcb.isBottom(c) ? 'bottom' : 'top', box: Pcb.fpBox(c).map(v => +v.toFixed(2)), edge: c.pcbEdge || null, locked: !!c.pcb.locked, nets: [...new Set(Pcb.padsOf(c, idx).map(p => p.net).filter(Boolean))] })),
          unrouted: Object.entries(conn).filter(([, v]) => !v.complete).map(([net, v]) => ({ net, islands: v.groups.map(g => g.map(p => `${p.key}@(${p.x.toFixed(1)},${p.y.toFixed(1)})`)) })),
          pours: (S.pcb.pours || []).map((p, i) => ({ index: i, net: p.net, layer: p.layer, whole: !!p.whole })),
          status: Pcb.status(conn),
        };
      }
      case 'optimize_pcb': {
        const o = { time_limit_s: input.time_limit_s || 60, iterations: input.iterations || 12, allow_grow: input.allow_grow !== false, allow_bottom: !!input.allow_bottom };
        let r; if (env.route) r = (await env.route({ optimize: o })).optimized; else r = Model.mutate(() => Pcb.optimize(o));
        env.ui('show-pcb');
        return Object.assign({}, r, { history: (r.history || []).slice(-15), drc: Pcb.drc().summary });
      }
      case 'add_copper_pour': return Model.mutate(() => Pcb.addPour({ net: input.net, layer: input.layer === 'bottom' ? 'B' : input.layer === 'both' ? 'both' : 'F', points: input.points, clearance: input.clearance }));
      case 'remove_copper_pour': return Model.mutate(() => { const P = Model.S.pcb.pours || []; const before = P.length; Model.S.pcb.pours = P.filter((p, i) => !(input.index != null ? i === +input.index : input.net ? p.net === input.net : true)); return { removed: before - Model.S.pcb.pours.length }; });
      case 'set_board_shape': return Model.mutate(() => Pcb.setBoardShape(input));
      case 'generate_pcb': case 'route_pcb': {
        const place = name === 'generate_pcb' ? { w: input.board_width, h: input.board_height, fit: !!input.auto_size } : null, noRoute = input.route === false;
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

  // ---------- database parts behind built-in symbols ----------
  async function useDatabaseParts(refs) {
    const S = Model.S, todo = S.components.filter(c => c.type !== 'part' && !c.pinMap && (!refs || refs.includes(c.ref)) && Lib.dbDefault(c.type, c.value));
    const done = [], failed = [];
    for (const c of todo) {
      try { const part = await loadPart(Lib.dbDefault(c.type, c.value).lcsc); const ok = Model.mutate(() => Model.attachDb(Model.comp(c.ref), part)); (ok ? done : failed).push(c.ref + (ok ? ' → ' + part.lcsc + ' ' + (part.footprint && part.footprint.name) : ' (pins did not match)')); }
      catch (e) { failed.push(c.ref + ': ' + e.message); }
    }
    return { converted: done, failed, skipped: S.components.filter(c => c.type !== 'part' && !c.pinMap && !Lib.dbDefault(c.type, c.value)).map(c => c.ref + ' (' + c.type + ', keeps its standard footprint)') };
  }
  // value → JLCPCB part number for the BOM (keeps the footprint; prefers in-stock Basic parts in the same package)
  async function matchJlcpcb(overwrite) {
    const S = Model.S, out = [];
    const pkgOf = c => { const l = c.dbfp && S.lib[c.dbfp]; const t = [(l && l.package) || '', (l && l.footprint && l.footprint.name) || '', c.footprint].join(' ').toUpperCase(); const m = t.match(/\b(0201|0402|0603|0805|1206|1210|2512|SOD-?123F?|SOD-?323|SMA|SMB|SOT-?23(-\d)?|SOT-?223|SOIC-?\d+|SOP-?\d+|TSSOP-?\d+|QFN-?\d+)\b/); return m ? m[1] : ''; };
    const norm = (t, v) => { v = String(v).trim(); if (t === 'resistor' && /^[\d.]+[kKmMR]?$/.test(v)) return v.replace(/R$/, '') + (/[kKmM]$/.test(v) ? 'Ω' : 'Ω'); if (/capacitor/.test(t) && /^[\d.]+[pnuμ]$/.test(v)) return v.replace('u', 'µ') + 'F'; if (t === 'inductor' && /^[\d.]+[nuμ]$/.test(v)) return v.replace('u', 'µ') + 'H'; return v; };
    for (const c of S.components) {
      if (c.type === 'part') { out.push({ ref: c.ref, lcsc: c.lcsc, source: 'database part' }); continue; }
      if (c.lcscPart && !overwrite) {
        const d = Lib.dbDefault(c.type, c.value);
        const same = d && d.lcsc === c.lcscPart && (d.byValue || String(c.value).toLowerCase() === String(d.value).toLowerCase());
        if (!d || d.lcsc !== c.lcscPart || same) { out.push({ ref: c.ref, value: c.value, lcsc: c.lcscPart, source: 'kept' }); continue; }
      }
      if (['connector', 'battery', 'ic'].includes(c.type)) { out.push({ ref: c.ref, lcsc: null, source: 'skipped (choose the exact part)' }); continue; }
      const pkg = pkgOf(c), q = `${norm(c.type, c.value)} ${pkg}`.trim();
      try {
        const j = await partsApi('search?q=' + encodeURIComponent(q) + '&limit=20');
        const ok = j.results.filter(r => r.stock > 0 && (!pkg || String(r.package || '').toUpperCase().replace(/[^A-Z0-9]/g, '').includes(pkg.toUpperCase().replace(/[^A-Z0-9]/g, ''))));
        const best = ok.sort((a, b) => (b.basic - a.basic) || (b.stock - a.stock))[0];
        if (best) { Model.mutate(() => { Model.comp(c.ref).lcscPart = best.lcsc; }); out.push({ ref: c.ref, value: c.value, lcsc: best.lcsc, part: best.mfr_part, package: best.package, basic: !!best.basic, stock: best.stock }); }
        else out.push({ ref: c.ref, value: c.value, lcsc: null, source: `no in-stock match for "${q}"` });
      } catch (e) { out.push({ ref: c.ref, lcsc: null, source: e.message }); }
    }
    return { matched: out.filter(o => o.lcsc).length, total: out.length, parts: out };
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

  return { env, TOOLS, exec, useDatabaseParts, matchJlcpcb, loadPart, partsApi, api, designContext, knowledgeDigest, newKey };
})();
if (typeof module !== 'undefined') module.exports = Engine;
