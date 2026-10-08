'use strict';
// AI Copilot: multi-provider model calls, tool definitions, agent loop (Agent / Ask / Plan modes).
const AI = (() => {
  const MODELS = [
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', provider: 'anthropic' },
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', provider: 'anthropic' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', provider: 'anthropic' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', provider: 'anthropic' },
  ];
  const PRESETS = {
    'OpenAI': 'https://api.openai.com/v1',
    'Google Gemini': 'https://generativelanguage.googleapis.com/v1beta/openai',
    'xAI Grok': 'https://api.x.ai/v1',
    'OpenRouter': 'https://openrouter.ai/api/v1',
    'Local :8080': 'http://localhost:8080/v1',
    'Ollama (local)': 'http://localhost:11434/v1',
    'LM Studio (local)': 'http://localhost:1234/v1',
  };
  const defaults = { anthropicKey: '', oaiBase: 'https://api.openai.com/v1', oaiKey: '', oaiModels: '', model: 'claude-sonnet-5-5', maxTokens: 8192, includeContext: true };
  let settings = Object.assign({}, defaults);
  try { Object.assign(settings, JSON.parse(localStorage.getItem('cp.settings') || '{}')); } catch (e) { }
  const saveSettings = s => { settings = Object.assign(settings, s); try { localStorage.setItem('cp.settings', JSON.stringify(settings)); } catch (e) { } };
  // Local model servers (localhost / this PC) are reached through server.py's /llm-proxy/<port>/,
  // which works from phones on the LAN and sidesteps missing CORS headers.
  let proxyOk = null;
  async function hasProxy() {
    if (proxyOk !== null) return proxyOk;
    try { const r = await fetch('/llm-proxy/_ping'); proxyOk = r.ok && (await r.json()).ok === true; } catch (e) { proxyOk = false; }
    return proxyOk;
  }
  async function resolveBase(base) {
    base = String(base || '').trim().replace(/\/+$/, '');
    let u; try { u = new URL(base); } catch (e) { throw new Error('Invalid base URL: ' + base); }
    const local = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', location.hostname].includes(u.hostname);
    if (local && u.protocol === 'http:' && await hasProxy()) return `${location.origin}/llm-proxy/${u.port || 80}${u.pathname.replace(/\/+$/, '')}`;
    return base;
  }
  async function fetchModels(base, key) {
    const headers = {}; if (key) headers.authorization = 'Bearer ' + key;
    const res = await fetch(await resolveBase(base) + '/models', { headers, signal: AbortSignal.timeout(8000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${res.status}: ${j.error?.message || res.statusText}`);
    const ids = (j.data || j.models || []).map(m => m.id || m.name).filter(Boolean);
    if (!ids.length) throw new Error('Server returned no models');
    return ids;
  }
  const allModels = () => [...MODELS, ...settings.oaiModels.split(',').map(s => s.trim()).filter(Boolean).map(id => ({ id, label: id, provider: 'openai' }))];

  // ---------- tools ----------
  const types = Lib.types();
  const pinList = { type: 'array', items: { type: 'string' }, description: 'Pin references "REF.PIN" — PIN is a pin number or pin name, e.g. "R1.1", "Q1.B", "U1.VCC"' };
  const TOOLS = [
    {
      name: 'search_parts', ro: true, description: 'Search the JLCPCB/LCSC component database (600k+ real parts with stock and price) by part number or keywords, e.g. "ESP32-C3", "AMS1117 3.3", "USB-C 16pin", "10k 0603". Returns LCSC codes (Cxxxx). Prefer in-stock and Basic parts.',
      input_schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'number', description: 'default 10, max 30' } } }
    },
    {
      name: 'get_part', ro: true, description: 'Load a database part by LCSC code: returns its exact pin list (number:name) and real PCB footprint. Call before adding it with add_components {lcsc}.',
      input_schema: { type: 'object', required: ['lcsc'], properties: { lcsc: { type: 'string', description: 'LCSC code, e.g. C2838502' } } }
    },
    { name: 'get_design', ro: true, description: 'Return the full current design: every component (type, value, position, footprint, pins as num:name=net) and all nets.', input_schema: { type: 'object', properties: {} } },
    { name: 'list_parts', ro: true, description: 'List the component types in the library with their pins (number:name), default value and footprints.', input_schema: { type: 'object', properties: {} } },
    {
      name: 'add_components', description: 'Add one or more components to the schematic. Returns the assigned refs. Overlapping placements are nudged automatically.',
      input_schema: {
        type: 'object', required: ['components'], properties: {
          components: {
            type: 'array', items: {
              type: 'object', properties: {
                type: { type: 'string', enum: types, description: 'Library type. Omit when using lcsc.' },
                lcsc: { type: 'string', description: 'LCSC code of a database part (load it with get_part first). Gives the real pinout and footprint.' },
                ref: { type: 'string', description: 'Optional reference designator, e.g. R1. Auto-assigned if omitted.' },
                value: { type: 'string', description: 'Part value or part number, e.g. 10k, 100n, NE555, ATmega328P' },
                x: { type: 'number', description: 'Schematic X (grid 10). Typical spacing between parts 80-160.' },
                y: { type: 'number', description: 'Schematic Y (down is positive).' },
                rot: { type: 'number', enum: [0, 90, 180, 270] },
                pins: { type: 'array', items: { type: 'string' }, description: 'ONLY for type "ic" or "connector": pin names in pin-number order (index 0 = pin 1), matching the real datasheet pinout.' },
                footprint: { type: 'string', description: 'Optional footprint: ' + Lib.FOOTPRINT_PATTERNS.join(', ') }
              }
            }
          }
        }
      }
    },
    {
      name: 'update_component', description: 'Change a component: value, position, rotation, footprint, pins (ic/connector) or rename it.',
      input_schema: { type: 'object', required: ['ref'], properties: { ref: { type: 'string' }, value: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, rot: { type: 'number', enum: [0, 90, 180, 270] }, footprint: { type: 'string' }, pins: { type: 'array', items: { type: 'string' } }, new_ref: { type: 'string' } } }
    },
    { name: 'remove_components', description: 'Delete components (and their connections).', input_schema: { type: 'object', required: ['refs'], properties: { refs: { type: 'array', items: { type: 'string' } } } } },
    {
      name: 'connect', description: 'Create connections. Each entry puts the listed pins on the named net (created if needed). If a pin is already on another net, that net is merged in. Name ground "GND" and supply rails like "VCC", "+5V", "+3V3", "+12V", "VBAT" — these are drawn as power symbols.',
      input_schema: { type: 'object', required: ['connections'], properties: { connections: { type: 'array', items: { type: 'object', required: ['net', 'pins'], properties: { net: { type: 'string' }, pins: pinList } } } } }
    },
    { name: 'disconnect', description: 'Remove pins from whatever net they are on.', input_schema: { type: 'object', required: ['pins'], properties: { pins: pinList } } },
    { name: 'rename_net', description: 'Rename a net (merges if the new name exists).', input_schema: { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string' }, to: { type: 'string' } } } },
    { name: 'auto_layout', description: 'Automatically arrange all schematic components based on connectivity. Use after building a circuit if you did not give coordinates.', input_schema: { type: 'object', properties: {} } },
    { name: 'run_erc', ro: true, description: 'Run the electrical rule check: unconnected pins, single-pin nets, missing ground, overlapping symbols.', input_schema: { type: 'object', properties: {} } },
    { name: 'clear_design', description: 'Delete everything and start an empty design.', input_schema: { type: 'object', properties: {} } },
    {
      name: 'generate_pcb', description: 'Create the PCB: place all footprints on a board (based on schematic positions) and autoroute with a 2-layer router. Returns routing statistics.',
      input_schema: { type: 'object', properties: { board_width: { type: 'number', description: 'mm, optional (auto-sized if omitted)' }, board_height: { type: 'number', description: 'mm, optional' }, route: { type: 'boolean', description: 'default true' } } }
    },
    { name: 'route_pcb', description: 'Re-run the autorouter on the current placement.', input_schema: { type: 'object', properties: {} } },
    { name: 'pcb_status', ro: true, description: 'Board size, number of placed parts, routed / unrouted nets, via count, trace length.', input_schema: { type: 'object', properties: {} } },
  ];

  const partCache = {};
  async function partsApi(path) {
    const r = await fetch('/api/parts/' + path);
    const j = await r.json().catch(() => ({ error: 'Parts database not available — run the app with server.py' }));
    if (!r.ok || j.error && !j.results) throw new Error(j.error || r.statusText);
    return j;
  }
  async function loadPart(code) {
    code = String(code || '').trim().toUpperCase();
    if (Model.S.lib[code]) return Model.S.lib[code];
    if (!partCache[code]) partCache[code] = await partsApi('get/' + encodeURIComponent(code));
    return partCache[code];
  }
  function partSummary(m) {
    return {
      lcsc: m.lcsc, name: m.name, manufacturer: m.manufacturer, mfr_part: m.mfr_part, package: m.package, ref_prefix: m.prefix,
      pins: m.pins.map(p => p.num + ':' + p.name).join(' '),
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

  async function execTool(name, input, mode) {
    const t = TOOLS.find(t => t.name === name);
    if (!t) throw new Error('Unknown tool ' + name);
    if (mode !== 'agent' && !t.ro) throw new Error(`"${name}" modifies the design and is not allowed in ${mode} mode`);
    input = input || {};
    switch (name) {
      case 'search_parts': {
        const j = await partsApi('search?q=' + encodeURIComponent(input.query || '') + '&limit=' + Math.min(30, +input.limit || 10));
        if (!j.results.length) return `No parts found for "${input.query}"` + (j.error ? ` (online search failed: ${j.error})` : '');
        return { source: j.source, results: j.results.slice().sort((a, b) => (b.stock > 0) - (a.stock > 0)).map(r => ({ lcsc: r.lcsc, part: r.mfr_part, brand: r.brand, package: r.package, stock: r.stock, basic: !!r.basic, price_usd: r.price, desc: (r.description || '').slice(0, 140) })) };
      }
      case 'get_part': return partSummary(await loadPart(input.lcsc));
      case 'get_design': return Model.summary();
      case 'list_parts': return partsInfo();
      case 'run_erc': { const r = Model.erc(); return r.length ? r : 'ERC passed: no issues'; }
      case 'pcb_status': return Pcb.status();
      case 'add_components': {
        const list = Array.isArray(input.components) ? input.components : [input];
        const libs = {};
        for (const s of list) if (s.lcsc) { const m = await loadPart(s.lcsc); libs[m.lcsc] = m; }
        return Model.mutate(() => list.map(s => {
          for (const [k, m] of Object.entries(libs)) if (!Model.S.lib[k]) Model.S.lib[k] = m; const c = Model.addComponent(s); return { ref: c.ref, type: c.type, value: c.value, x: c.x, y: c.y, footprint: c.footprint, pins: Lib.type(c.type).pins(c).map(p => p.num + ':' + p.name).join(' ') }; }));
      }
      case 'update_component': return Model.mutate(() => { const c = Model.updateComponent(input); return { ok: true, ref: c.ref }; });
      case 'remove_components': return Model.mutate(() => { (input.refs || []).forEach(Model.removeComponent); return { ok: true }; });
      case 'connect': {
        const list = Array.isArray(input.connections) ? input.connections : [input];
        return Model.mutate(() => list.map(cn => ({ net: Model.connect(cn.net, cn.pins || []), pins: (cn.pins || []).length })));
      }
      case 'disconnect': return Model.mutate(() => { Model.disconnect(input.pins || []); return { ok: true }; });
      case 'rename_net': return Model.mutate(() => { Model.renameNet(input.from, input.to); return { ok: true }; });
      case 'auto_layout': Model.mutate(() => Model.autoLayout()); Sch.fit(); return { ok: true };
      case 'clear_design': Model.mutate(() => Model.clear()); return { ok: true };
      case 'generate_pcb': {
        const r = Model.mutate(() => {
          const p = Pcb.autoPlace({ w: input.board_width, h: input.board_height });
          const rr = input.route === false ? null : Pcb.route();
          return { placement: p, routing: rr };
        });
        App.showView('pcb'); Pcb.fit();
        return r;
      }
      case 'route_pcb': { const r = Model.mutate(() => Pcb.route()); App.showView('pcb'); return r; }
    }
  }

  // ---------- prompts ----------
  const BASE = `You are CircuitPilot, an expert electronics engineer embedded in a schematic + PCB design app. You design circuits by calling tools that edit the live schematic, then lay out the PCB.

DESIGN MODEL
- Components: ref (R1, C1, U1, Q1, D1, J1 ...), library type, value, schematic x/y (grid 10; a resistor is 60 wide; leave 80-160 between parts; signal flows left→right, supply at top, ground at bottom), rotation 0/90/180/270, and footprint.
- Connectivity is by named nets. Pins are referenced "REF.PIN" with the pin number or name ("R1.1", "Q1.B", "U1.VCC"). A name shared by several pins (e.g. "U1.GND") connects all of them.
- Nets named GND or supply names (VCC, VDD, +5V, +3V3, +12V, VBAT, VIN ...) render as power symbols. Give meaningful names to important signals (OUT, LED_K, SDA, TRIG ...); otherwise any name is fine.
- Pin numbering: resistor/capacitor/inductor 1,2; electrolytic 1=+ 2=-; diode/LED/zener/schottky 1=K(cathode) 2=A(anode); npn/pnp 1=B 2=E 3=C; nmos/pmos 1=G 2=S 3=D; regulator 1=IN 2=GND 3=OUT; opamp 2=IN- 3=IN+ 4=V- 6=OUT 7=V+; potentiometer 1, 2=W(wiper), 3; battery 1=+ 2=-.
- COMPONENT DATABASE: for real ICs, modules, regulators, connectors (ESP32, STM32, AMS1117, CH340, USB-C, etc.) use search_parts → pick an in-stock part (prefer Basic parts) → get_part → add_components with {"lcsc": "Cxxxx"}. This gives the exact pinout and real footprint; connect using the pin names returned by get_part. Simple passives (R, C, LED, diodes) can use the built-in types.
- If the database is unavailable, use type "ic" with "pins" = the exact datasheet pin names in pin-number order (e.g. NE555: ["GND","TRIG","OUT","RESET","CTRL","THR","DIS","VCC"]) and an appropriate footprint (DIP-8, SOIC-8, ...). Use "connector" for headers/terminals with descriptive pin names.

Use real, purchasable part values and show key calculations briefly (e.g. LED resistor = (Vs - Vf)/I). Keep replies concise and well formatted (markdown).`;

  const MODE = {
    agent: `MODE: AGENT — you can edit the design.
Workflow: 1) one or two sentences on the approach + key values; 2) add_components in ONE batch with sensible x/y; 3) connect ALL nets in ONE batch (every pin connected unless intentionally unused); 4) run_erc and fix real problems; 5) if the user wants a board/PCB, call generate_pcb and report routed/unrouted nets; 6) finish with a short summary (BOM highlights, things to double-check). If the design already has parts, modify it rather than starting over unless asked.`,
    ask: `MODE: ASK — read-only. You may inspect the design with get_design / run_erc / pcb_status / list_parts, but you cannot modify anything. Answer questions, review the design, explain circuit theory, suggest components and point out bugs.`,
    plan: `MODE: PLAN — do NOT modify the design. Produce a clear implementation plan in markdown:
## Goal  ## Key decisions & calculations  ## Bill of materials (table: Ref | Type | Value | Footprint | Purpose)  ## Connections (table: Net | Pins)  ## Steps
Use refs and pin names exactly as they will be used with the tools. End by telling the user to press **Execute plan** to build it.`
  };

  function designContext() {
    const S = Model.S;
    if (!S.components.length) return 'CURRENT DESIGN: empty.';
    const sum = Model.summary();
    let txt = 'CURRENT DESIGN:\n' + sum.components.map(c => `${c.ref} ${c.type} "${c.value}" @(${c.x},${c.y}) rot${c.rot} fp=${c.footprint} | ${c.pins}`).join('\n');
    const st = Pcb.status();
    txt += `\nPCB: ${st.placed ? `board ${st.board.w}x${st.board.h}mm, ${st.routed}/${st.nets} nets routed` : 'not generated'}`;
    if (txt.length > 12000) txt = txt.slice(0, 12000) + '\n…(truncated — call get_design for the rest)';
    return txt;
  }

  // ---------- provider adapters (neutral history -> provider format) ----------
  function toAnthropic(hist) {
    const out = [];
    const push = (role, blocks) => { const last = out[out.length - 1]; if (last && last.role === role) last.content.push(...blocks); else out.push({ role, content: blocks }); };
    for (const m of hist) {
      if (m.role === 'user') push('user', [{ type: 'text', text: m.text }]);
      else if (m.role === 'assistant') {
        const b = []; if (m.text) b.push({ type: 'text', text: m.text });
        for (const t of m.toolCalls || []) b.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input || {} });
        if (b.length) push('assistant', b);
      } else if (m.role === 'tool') push('user', m.results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, is_error: !!r.error })));
    }
    return out;
  }
  function toOpenAI(hist, system) {
    const out = [{ role: 'system', content: system }];
    for (const m of hist) {
      if (m.role === 'user') out.push({ role: 'user', content: m.text });
      else if (m.role === 'assistant') {
        const o = { role: 'assistant', content: m.text || '' };
        if (m.toolCalls && m.toolCalls.length) o.tool_calls = m.toolCalls.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input || {}) } }));
        out.push(o);
      } else if (m.role === 'tool') for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    }
    return out;
  }
  async function callModel(model, system, hist, tools, signal) {
    if (model.provider === 'anthropic') {
      if (!settings.anthropicKey) throw new Error('No Anthropic API key — open ⚙ Settings to add one.');
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', 'x-api-key': settings.anthropicKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: model.id, max_tokens: +settings.maxTokens || 8192, system, tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })), messages: toAnthropic(hist) })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${j.error?.message || res.statusText}`);
      return {
        text: j.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim(),
        toolCalls: j.content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input })),
        usage: j.usage ? { in: j.usage.input_tokens, out: j.usage.output_tokens } : null
      };
    }
    const base = await resolveBase(settings.oaiBase);
    const headers = { 'content-type': 'application/json' };
    if (settings.oaiKey) headers.authorization = 'Bearer ' + settings.oaiKey;
    const res = await fetch(base + '/chat/completions', {
      method: 'POST', signal, headers,
      body: JSON.stringify({ model: model.id, messages: toOpenAI(hist, system), tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`API ${res.status}: ${j.error?.message || JSON.stringify(j).slice(0, 300) || res.statusText}`);
    const m = j.choices?.[0]?.message || {};
    return {
      text: (m.content || '').trim(),
      toolCalls: (m.tool_calls || []).map((t, i) => {
        let input = {}; try { input = JSON.parse(t.function.arguments || '{}'); } catch (e) { input = { __parse_error: t.function.arguments }; }
        return { id: t.id || 'call_' + Date.now() + '_' + i, name: t.function.name, input };
      }),
      usage: j.usage ? { in: j.usage.prompt_tokens, out: j.usage.completion_tokens } : null
    };
  }

  // ---------- agent loop ----------
  let history = [], controller = null;
  try { history = JSON.parse(localStorage.getItem('cp.chat') || '[]'); } catch (e) { }
  const persist = () => { try { localStorage.setItem('cp.chat', JSON.stringify(history.slice(-200))); } catch (e) { } };

  async function run(text, mode, hooks) {
    const model = allModels().find(m => m.id === settings.model) || MODELS[2];
    const tools = TOOLS.filter(t => mode === 'agent' || t.ro);
    history.push({ role: 'user', text, mode, checkpoint: hooks.checkpoint });
    persist();
    controller = new AbortController();
    try {
      for (let step = 0; step < 40; step++) {
        const system = BASE + '\n\n' + MODE[mode] + (settings.includeContext ? '\n\n' + designContext() : '');
        const r = await callModel(model, system, history.map(({ role, text, toolCalls, results }) => ({ role, text, toolCalls, results })), tools, controller.signal);
        const msg = { role: 'assistant', text: r.text, toolCalls: r.toolCalls, model: model.label, mode };
        history.push(msg); persist(); hooks.onAssistant(msg, r.usage);
        if (!r.toolCalls.length) break;
        const results = [];
        for (const tc of r.toolCalls) {
          let content, error = false;
          try {
            if (tc.input && tc.input.__parse_error) throw new Error('Could not parse tool arguments as JSON');
            const out = await execTool(tc.name, tc.input, mode);
            content = typeof out === 'string' ? out : JSON.stringify(out);
          } catch (e) { content = 'Error: ' + e.message; error = true; }
          results.push({ id: tc.id, name: tc.name, content, error });
          hooks.onTool(tc, content, error);
          if (controller.signal.aborted) break;
        }
        for (const tc of r.toolCalls) if (!results.find(x => x.id === tc.id)) results.push({ id: tc.id, name: tc.name, content: 'Cancelled by user', error: true });
        history.push({ role: 'tool', results }); persist();
        if (controller.signal.aborted) break;
      }
    } catch (e) {
      if (e.name === 'AbortError') hooks.onError('Stopped.');
      else hooks.onError(e.message);
    } finally { controller = null; }
  }
  const stop = () => controller && controller.abort();
  const busy = () => !!controller;
  const reset = () => { history = []; persist(); };

  return { MODELS, PRESETS, allModels, fetchModels, partsApi, loadPart, get settings() { return settings; }, saveSettings, run, stop, busy, reset, get history() { return history; }, execTool, TOOLS };
})();
